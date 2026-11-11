// pi-boxd 前端：项目/角色 → 会话 → 对话 → 当前会话任务图
let state = null;
// selected = { type: "conversation"|"assistant"|"agent", project, id?, name? }
let selected = null;
const EXPANDED_PROJECTS_STORAGE_KEY = "pi-box.expanded-projects.v1";

function loadExpandedProjects() {
  try {
    const saved = JSON.parse(localStorage.getItem(EXPANDED_PROJECTS_STORAGE_KEY) || "[]");
    return new Set(Array.isArray(saved) ? saved.filter((name) => typeof name === "string") : []);
  } catch {
    return new Set();
  }
}

function saveExpandedProjects() {
  try {
    localStorage.setItem(EXPANDED_PROJECTS_STORAGE_KEY, JSON.stringify([...expandedProjects]));
  } catch {
    // localStorage 可能被浏览器策略禁用；此时仍保留当前页面内的展开状态。
  }
}

let expandedProjects = loadExpandedProjects();
let expandedProjectSchedules = new Set();
let agentsCache = {}; // project -> agent 列表（来自快照 agentsByProject）
let schedulesCache = {}; // project -> schedule 列表
let scheduleRunsCache = {}; // project -> 最近运行记录
const conversationDetailCache = new Map(); // conversation id -> 按需加载的完整 entries
// 每个会话独立的输入框节点与草稿：SSE 全局刷新时复用节点，避免清空输入、打断输入法。
const composerCache = new Map(); // conversation id -> { form, input, btn }
const draftCache = new Map(); // conversation id -> 未发送的输入文本
let viewScrollState = { top: 0, atBottom: true }; // 当前视图的滚动位置
let lastViewKey = "";
const conversationDetailRequests = new Map();

// ── 增量渲染基础设施 ────────────────────────────────────────────────────────
// SSE 每 300ms 推送一次快照，变更才推。此前每条消息都会把四栏全量重建，
// 长会话下单个 renderView 就要 200ms+，主线程被占满导致滚动/输入掉帧。
// 以下缓存让 SSE 刷新只做「差异 patch」，不再推倒重建。

// 会话区渲染缓存：conversation id -> { body, turns: [{ key, count, sig, node }] }
// turns 与 conversationTurns() 的输出一一对应；key 是该 turn 的首个 entry id，
// count 是条目数，sig 是内容指纹。内容未变的 turn 直接复用已有 DOM 节点。
const conversationRenderCache = new Map();
// 会话列表节点缓存：conversation id -> { node, dot, titleText, meta, conv }
// 会话状态点/标题变化时只改文本与 class，不重建节点。
const sessionItemNodes = new Map();
// 会话分组节点缓存：分组 key -> details 节点（折叠分组复用）。
const sessionBucketNodes = new Map();
// Markdown 渲染缓存：原始文本 -> DOM 模板（用 cloneNode 复用，避免重复解析）。
const markdownCache = new Map();
// 会话详情拉取节流状态：conversation id -> { lastFetch, status }
const detailRefreshState = new Map();

// 详情重拉节流窗口（毫秒）。运行中的会话需要跟上流式输出，空闲会话只做兜底。
const DETAIL_POLL_ACTIVE_MS = 500;
const DETAIL_POLL_IDLE_MS = 2000;
// Markdown 缓存上限（条目数 / 单条文本长度），避免长会话把内存吃满。
const MARKDOWN_CACHE_MAX_ENTRIES = 120;
const MARKDOWN_CACHE_MAX_CHARS = 200 * 1024;

let cfgProviders = [];
let cfgSettings = { activeProvider: "openai", providers: {}, currentModel: null };
let cfgSelectedModels = [];
let cfgModelsCatalog = [];
let cfgCurrentProvider = null; // 当前选中的提供商 id
let cfgProviderTabs = [];      // 左侧二级菜单显示的提供商 id 列表
const MASKED_API_KEY = "********";
const MOBILE_PANELS = new Set(["tree", "sessions", "view", "tasks"]);
let activeMobilePanel = "tree";

function setMobilePanel(panel) {
  if (!MOBILE_PANELS.has(panel)) return;
  activeMobilePanel = panel;
  for (const section of document.querySelectorAll("main > section")) {
    section.classList.toggle("mobile-active", section.id === `panel-${panel}`);
  }
  for (const button of document.querySelectorAll("[data-mobile-panel]")) {
    const active = button.dataset.mobilePanel === panel;
    button.classList.toggle("active", active);
    button.setAttribute("aria-current", active ? "page" : "false");
  }
}

function el(tag, className, text) {
  const e = document.createElement(tag);
  if (className) e.className = className;
  if (text !== undefined) e.textContent = text;
  return e;
}

// ─── 品牌（浏览器标签页标题 / 图标） ────────────────────────────────────────
const DEFAULT_APP_TITLE = "pi-box · 多 Agent 平台";
const APP_ICON_MODES = [
  ["default", "默认图标"],
  ["emoji", "Emoji"],
  ["upload", "上传图片"],
];

function escapeXml(value) {
  return String(value).replace(/[<>&"']/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;", "'": "&apos;" })[c]);
}

/** 由图标偏好算出 <link rel="icon"> 的 href。 */
function appIconHref(icon) {
  if (icon?.type === "emoji" && icon.emoji) {
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><text x="32" y="52" font-size="52" text-anchor="middle">${escapeXml(icon.emoji)}</text></svg>`;
    return `data:image/svg+xml,${encodeURIComponent(svg)}`;
  }
  if (icon?.type === "upload") return `/api/branding/icon?v=${icon.version ?? Date.now()}`;
  return "/favicon.svg";
}

/** 应用标题 / 图标 / 主题 / 密度（页面初次加载与保存后都走这里）。 */
function applyBranding(prefs) {
  document.title = prefs?.appTitle || DEFAULT_APP_TITLE;
  const link = document.getElementById("app-favicon");
  if (link) link.href = appIconHref(prefs?.appIcon);
  if (prefs?.density) document.body.classList.toggle("density-compact", prefs.density === "compact");
  if (prefs?.theme) document.body.classList.toggle("theme-light", prefs.theme === "light");
}

async function savePrefsPatch(patch) {
  const r = await fetch("/api/prefs", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(patch),
  });
  if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || "保存失败");
  return r.json();
}

/** 会话是否正在处理中（有正在运行或等待工具的任务）。 */
function conversationBusy(conversation) {
  return ["running", "waiting-tool", "pending"].includes(conversation?.status);
}

/** 会话显示名（重命名前的默认值）。 */
function conversationDisplayTitle(conversation) {
  return conversation.title || (conversation.actorType === "assistant" ? "助理会话" : conversation.actorName) || `会话 #${conversation.id}`;
}

/** 重命名会话：只改显示名。 */
async function renameConversation(conversation) {
  const current = conversationDisplayTitle(conversation);
  const title = prompt("会话名称：", current);
  if (title === null) return;
  const value = title.trim();
  if (!value) {
    alert("名称不能为空");
    return;
  }
  if (value === current) return;
  const response = await fetch("/api/conversation/rename", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ conversationId: conversation.id, title: value }),
  });
  const data = await response.json();
  if (!response.ok) {
    alert(data.error || "重命名失败");
    return;
  }
  await refresh();
}

/** agent 状态 → 中文提示词（用于圆点 tooltip / flash hint）。 */
function agentStatusLabel(status) {
  return {
    idle: "空闲",
    running: "运行中",
    "waiting-tool": "等待工具结果",
    pending: "待启动",
    error: "上次运行出错",
    unknown: "未启动",
  }[status] ?? status;
}

/** 未启动 agent 节点的轻量提示，不占用任何 modal。 */
function flashHint(node, msg) {
  const old = node.style.boxShadow;
  node.style.transition = "box-shadow 0.2s";
  node.style.boxShadow = "inset 3px 0 0 #d29922";
  node.title = msg;
  setTimeout(() => { node.style.boxShadow = old; }, 1200);
}

/** 更新右上角 SSE 连接指示器。 */
function updateSseIndicator(state) {
  const elx = document.getElementById("sse-indicator");
  if (!elx) return;
  if (state === "reconnecting") {
    elx.className = "sse-indicator sse-reconnecting";
    elx.textContent = "🟡 重连中…";
    elx.title = "SSE 正在重新连接";
  } else {
    elx.className = "sse-indicator sse-ok";
    elx.textContent = "🟢";
    elx.title = "SSE 已连接";
  }
}

async function refresh() {
  const res = await fetch("/api/state");
  state = await res.json();
  agentsCache = state.agentsByProject ?? {};
  schedulesCache = state.schedulesByProject ?? {};
  // 清掉已经删除或重命名的旧项目记录，避免本地状态无限累积。
  const existingProjects = new Set(state?.projects ?? []);
  const restoredProjects = new Set([...expandedProjects].filter((name) => existingProjects.has(name)));
  if (restoredProjects.size !== expandedProjects.size) {
    expandedProjects = restoredProjects;
    saveExpandedProjects();
  }
  render();
}

function render() {
  const filesMode = selected?.type === "files";
  setFilesChrome(filesMode);
  renderStatus();
  renderTree();
  if (filesMode) {
    // 文件模式：第二/第四栏由 renderFilePanels 接管，SSE 周期刷新不重绘，避免丢滚动位置和图片重载。
    ensureFileBrowser(selected.project);
    renderFilePanels();
    return;
  }
  renderSessions();
  renderView();
  renderTaskGraph();
}

function renderStatus() {
  const m = state?.model ?? {};
  const noKey = !state?.hasKey;
  const bar = document.getElementById("status-bar");
  // 内容没变就不动 DOM：SSE 推送频率高，避免每次重建状态栏节点。
  const signature = `${m.provider}/${m.modelId}|${state?.projects?.length ?? 0}|${noKey}`;
  if (bar.dataset.signature !== signature) {
    bar.dataset.signature = signature;
    bar.innerHTML =
      `模型 <b style="color:#58a6ff">${m.provider}/${m.modelId}</b> · 项目 ${state?.projects?.length ?? 0}` +
      (noKey ? ' · <span style="color:#d29922">⚠ 未配置 API Key</span>' : "");
  }
  document.getElementById("new-project").disabled = noKey;
}

// ─── 快照差异比对（P0-1）──────────────────────────────────────────────────────
// SSE 推送的是全量快照，但只有一小部分字段真正变化。这里算出差异，
// 让 SSE 刷新只 patch 受影响的部分，而不是四栏全量重建。
function sameJson(a, b) {
  if (a === b) return true;
  if (a === null || b === null || a === undefined || b === undefined) return false;
  return JSON.stringify(a) === JSON.stringify(b);
}

/** 比较前后两份快照，返回需要重建的部分。 */
function diffSnapshot(prev, next) {
  const diff = {
    projects: false,
    agents: false,
    tasks: false,
    status: false,
    conversations: new Set(), // 字段发生变化的会话 id
    conversationList: false, // 会话增删（会影响第二栏的列表结构）
  };
  if (!prev) {
    diff.projects = true;
    diff.agents = true;
    diff.tasks = true;
    diff.status = true;
    diff.conversationList = true;
    return diff;
  }
  const prevProjects = prev.projects ?? [];
  const nextProjects = next.projects ?? [];
  if (prevProjects.length !== nextProjects.length || prevProjects.some((p, i) => p !== nextProjects[i])) {
    diff.projects = true;
  }
  if (!sameJson(prev.agentsByProject, next.agentsByProject)) diff.agents = true;
  if (!sameJson(prev.taskGraph, next.taskGraph)) diff.tasks = true;
  if (!sameJson(prev.model, next.model) || prev.hasKey !== next.hasKey) diff.status = true;

  const prevMap = new Map((prev.conversations ?? []).map((c) => [String(c.id), c]));
  const nextMap = new Map((next.conversations ?? []).map((c) => [String(c.id), c]));
  for (const [id, conv] of nextMap) {
    const before = prevMap.get(id);
    if (!before) {
      diff.conversationList = true;
      continue;
    }
    if (before.status !== conv.status || before.title !== conv.title
      || before.actorType !== conv.actorType || before.actorName !== conv.actorName
      || before.source !== conv.source || before.project !== conv.project) {
      diff.conversations.add(id);
    }
  }
  for (const id of prevMap.keys()) {
    if (!nextMap.has(id)) diff.conversationList = true;
  }
  return diff;
}

/** 会话是否处于「正在干活」状态（这类会话的内容会持续变化）。 */
function isActiveConversationStatus(status) {
  return status === "running" || status === "waiting-tool" || status === "pending";
}

// ─── 左：项目树 ─────────────────────────────────────────────────────────────
function renderTree() {
  const root = document.getElementById("tree");
  root.innerHTML = "";
  const projects = state?.projects ?? [];
  if (projects.length === 0) {
    root.appendChild(el("div", "tree-empty", "（还没有项目，点右上角 +新建项目）"));
    return;
  }
  for (const proj of projects) {
    const open = expandedProjects.has(proj);
    const isMeta = proj === state.metaProject;
    // 项目行
    const row = el("div", isMeta ? "tree-project tree-project-meta" : "tree-project");
    const arrow = el("span", "tree-arrow", open ? "▼" : "▶");
    arrow.onclick = (ev) => {
      ev.stopPropagation();
      if (open) expandedProjects.delete(proj);
      else expandedProjects.add(proj);
      saveExpandedProjects();
      render();
    };
    row.appendChild(arrow);
    row.appendChild(el("span", "tree-label", isMeta ? `🔧 ${proj}（元项目）` : `📁 ${proj}`));
    if (!isMeta) {
      const projectSettings = el("button", "tree-settings", "⚙");
      projectSettings.type = "button";
      projectSettings.title = "修改项目名称";
      projectSettings.setAttribute("aria-label", `设置项目 ${proj}`);
      projectSettings.onclick = (ev) => {
        ev.stopPropagation();
        selected = { type: "project", project: proj };
        setMobilePanel("view");
        render();
      };
      row.appendChild(projectSettings);
    }
    if (selected?.type === "project" && selected.project === proj) row.classList.add("selected");
    root.appendChild(row);
    if (!open) continue;

    // 助理
    const aNode = el("div", "tree-item tree-assistant");
    aNode.classList.add("tree-level-1");
    const selectedConversation = selected?.type === "conversation" ? (state?.conversations ?? []).find((item) => item.id === selected.id) : null;
    const aSel = (selected?.type === "actor" && selected.project === proj && selected.actorType === "assistant")
      || (selectedConversation?.project === proj && selectedConversation.actorType === "assistant");
    if (aSel) aNode.classList.add("selected");
    aNode.appendChild(el("span", "tree-arrow", ""));
    aNode.appendChild(el("span", "tree-label", "🤖 助理"));
    const assistantSettings = el("button", "tree-settings", "⚙");
    assistantSettings.type = "button";
    assistantSettings.title = "助理设置";
    assistantSettings.setAttribute("aria-label", `设置 ${proj} 的助理`);
    assistantSettings.onclick = (ev) => {
      ev.stopPropagation();
      openAssistantEditor(proj);
    };
    if (isMeta) {
      assistantSettings.disabled = true;
      assistantSettings.title = "元项目助理文件受保护，不可编辑";
      assistantSettings.style.opacity = "0.4";
      assistantSettings.style.cursor = "not-allowed";
    }
    aNode.appendChild(assistantSettings);
    aNode.onclick = () => {
      selected = { type: "actor", project: proj, actorType: "assistant", actorName: "助理" };
      setMobilePanel("sessions");
      render();
    };
    root.appendChild(aNode);

    // 项目文件浏览入口（第二栏变文件树，第四栏变预览）
    const filesNode = el("div", "tree-item tree-files");
    filesNode.classList.add("tree-level-1");
    filesNode.appendChild(el("span", "tree-arrow", ""));
    filesNode.appendChild(el("span", "tree-label", "📄 文件"));
    if (selected?.type === "files" && selected.project === proj) filesNode.classList.add("selected");
    filesNode.onclick = () => openProjectFiles(proj);
    root.appendChild(filesNode);

    // 子 agent：直接挂在项目下，不再有折叠组（需求：随时看到圆点状态）
    const agents = agentsCache[proj] ?? [];
    // 子 Agent 区域与新建入口始终存在，空项目也必须能创建第一个 Agent。
    const sep = el("div", "tree-sep");
    sep.appendChild(el("span", "tree-sep-label", "子 Agent"));
    const addAgent = el("button", "tree-sep-add", "＋");
    addAgent.type = "button";
    addAgent.title = isMeta ? "元项目子 agent 不可通过 UI 新建，请在宿主机直接编辑 /home/agent/.pi/agent/meta/agents/" : "新建 Agent";
    addAgent.setAttribute("aria-label", `在 ${proj} 中新建 Agent`);
    if (isMeta) {
      addAgent.disabled = true;
      addAgent.style.opacity = "0.4";
      addAgent.style.cursor = "not-allowed";
    }
    addAgent.onclick = (event) => {
      event.stopPropagation();
      openAgentEditor({ scope: "project", project: proj });
    };
    sep.appendChild(addAgent);
    root.appendChild(sep);
    if (agents.length === 0) {
      root.appendChild(el("div", "tree-agent-empty tree-level-2", "暂无 Agent"));
    }
    for (const a of agents) {
      const n = el("div", "tree-item tree-level-2");
      const isSel = (selected?.type === "actor" && selected.project === proj && selected.actorType === "agent" && selected.actorName === a.name)
        || (selectedConversation?.project === proj && selectedConversation.actorType === "agent" && selectedConversation.actorName === a.name);
      if (isSel) n.classList.add("selected");
      n.appendChild(el("span", "tree-arrow", ""));
      const avatar = el("span", `agent-avatar agent-avatar-${a.scope}`, "🤖");
      avatar.title = a.scope === "global" ? "全局 Agent" : a.scope === "meta" ? "元项目 Agent" : "项目 Agent";
      n.appendChild(avatar);
      n.appendChild(el("span", "tree-label", a.name));

      // 配置入口：name 后的 ⚙ 小按钮
      const agentSettings = el("button", "tree-settings", a.locked || a.scope === "meta" ? "🔒" : "⚙");
      agentSettings.type = "button";
      agentSettings.title = a.locked
        ? "Agent 已锁定（locked=true），不可删除，可通过 tools:[] 软停用"
        : a.scope === "meta"
          ? "元项目子 agent 不可通过 UI 编辑；请在宿主机直接编辑 /home/agent/.pi/agent/meta/agents/"
          : "Agent 配置";
      agentSettings.setAttribute("aria-label", `配置 Agent ${a.name}`);
      if (!a.locked && a.scope !== "meta") {
        agentSettings.onclick = (ev) => {
          ev.stopPropagation();
          openAgentEditor({ scope: a.scope, project: a.scope === "project" ? proj : null, existing: a });
        };
      } else {
        agentSettings.disabled = true;
        agentSettings.style.opacity = "0.4";
        agentSettings.style.cursor = "not-allowed";
      }
      n.appendChild(agentSettings);
      const tag = a.scope === "meta" ? "元" : a.scope === "project" ? "项目" : "全局";
      n.appendChild(el("span", "tree-tag", tag));

      // 单击角色：第二栏展示该 Agent 的全部会话。
      n.onclick = () => {
        selected = { type: "actor", project: proj, actorType: "agent", actorName: a.name };
        setMobilePanel("sessions");
        render();
      };
      root.appendChild(n);
    }

  }
}

// ─── 项目文件浏览（第二栏：文件树 / 第四栏：预览） ─────────────────────────
// 方案 B：文件模式下第三栏（对话）让位，预览占据最右侧整块（原任务图位置）。
const FILE_ICONS = {
  md: "📝", markdown: "📝", mdx: "📝", txt: "📄", log: "📜", csv: "🧮", tsv: "🧮",
  json: "🧾", jsonc: "🧾", yaml: "🧾", yml: "🧾", toml: "🧾", ini: "🧾", conf: "🧾", cfg: "🧾",
  js: "🟨", mjs: "🟨", cjs: "🟨", jsx: "🟨", ts: "🟦", tsx: "🟦", vue: "🟩",
  py: "🐍", go: "🐹", rs: "🦀", java: "☕", kt: "🟣", rb: "💎", php: "🐘",
  c: "🔵", h: "🔵", cc: "🔵", cpp: "🔵", hpp: "🔵", cs: "🟪",
  sh: "🐚", bash: "🐚", zsh: "🐚", fish: "🐚", ps1: "🐚", sql: "🗄",
  html: "🌐", htm: "🌐", xml: "🌐", svg: "🖼", css: "🎨", scss: "🎨", less: "🎨",
  png: "🖼", jpg: "🖼", jpeg: "🖼", gif: "🖼", webp: "🖼", bmp: "🖼", ico: "🖼", avif: "🖼",
  pdf: "📕", zip: "🗜", gz: "🗜", tgz: "🗜", tar: "🗜", "7z": "🗜", rar: "🗜",
  mp3: "🎵", wav: "🎵", ogg: "🎵", m4a: "🎵", flac: "🎵",
  mp4: "🎬", webm: "🎬", mov: "🎬", mkv: "🎬",
  lock: "🔒", env: "🔑", wasm: "⚙", proto: "🧩", diff: "🧩", patch: "🧩",
};
const MARKDOWN_RE = /\.(md|markdown|mdx)$/i;
const HIGHLIGHT_MAX_CHARS = 400 * 1024;

// { project, dirs: Map<rel, {items, loaded, loading, error, truncated}>, expanded: Set,
//   currentDir, selected, preview, previewError, previewLoading, markdownSource, notice }
let fileBrowser = null;
// 文件面板当前是否「已经占着」第二/第四栏。退出文件模式时会被其它渲染函数覆盖，
// 再次进入必须强制重画一次，否则 dirty 标记为 false 会导致面板空白。
let filesModeMounted = false;

function fileIcon(item) {
  if (item.type === "dir") return item.link ? "🔗" : "📁";
  const name = item.name.toLowerCase();
  if (name === "dockerfile") return "🐳";
  if (name === "makefile") return "🔨";
  if (name === ".env" || name.startsWith(".env.")) return "🔑";
  const ext = name.includes(".") ? name.slice(name.lastIndexOf(".") + 1) : "";
  return FILE_ICONS[ext] ?? "📄";
}

function filesApi(name, params) {
  return `/api/files/${name}?${new URLSearchParams(params).toString()}`;
}

function rawFileUrl(project, path, download = false) {
  const params = { project, path };
  if (download) params.download = "1";
  return `/api/files/raw?${new URLSearchParams(params).toString()}`;
}

function parentDirOf(path) {
  const index = path.lastIndexOf("/");
  return index < 0 ? "" : path.slice(0, index);
}

/** 进入某个项目的文件浏览：第二栏展示文件树，第四栏展示预览。 */
function openProjectFiles(project) {
  selected = { type: "files", project };
  ensureFileBrowser(project);
  setMobilePanel("sessions");
  render();
}

function ensureFileBrowser(project) {
  if (fileBrowser?.project === project) return fileBrowser;
  fileBrowser = {
    project,
    dirs: new Map(),
    expanded: new Set([""]),
    currentDir: "",
    selected: null,
    preview: null,
    previewError: null,
    previewLoading: false,
    markdownSource: false,
    notice: null,
    noticeError: false,
    treeDirty: true,
    previewDirty: true,
  };
  loadFileDir("");
  return fileBrowser;
}

async function loadFileDir(rel, { force = false } = {}) {
  const fb = fileBrowser;
  if (!fb) return;
  const known = fb.dirs.get(rel);
  if (known?.loading) return;
  if (known?.loaded && !force) return;
  fb.dirs.set(rel, { ...(known ?? {}), loading: true, error: null });
  fb.treeDirty = true;
  renderFilePanels();
  try {
    const response = await fetch(filesApi("list", { project: fb.project, path: rel }));
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || "读取目录失败");
    if (fileBrowser !== fb) return;
    fb.dirs.set(rel, {
      items: data.entries ?? [],
      truncated: Boolean(data.truncated),
      loaded: true,
      loading: false,
      error: null,
    });
  } catch (error) {
    if (fileBrowser !== fb) return;
    fb.dirs.set(rel, { items: [], loaded: false, loading: false, error: error.message, truncated: false });
  }
  fb.treeDirty = true;
  renderFilePanels();
}

function toggleFileDir(fb, path) {
  fb.currentDir = path;
  if (fb.expanded.has(path)) {
    fb.expanded.delete(path);
  } else {
    fb.expanded.add(path);
    loadFileDir(path);
  }
  fb.treeDirty = true;
  renderFilePanels();
}

async function openFilePreview(fb, path) {
  setMobilePanel("tasks");
  fb.selected = path;
  fb.currentDir = parentDirOf(path);
  fb.preview = null;
  fb.previewError = null;
  fb.previewLoading = true;
  fb.markdownSource = false;
  fb.treeDirty = true;
  fb.previewDirty = true;
  renderFilePanels();
  try {
    const response = await fetch(filesApi("read", { project: fb.project, path }));
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || "读取文件失败");
    if (fileBrowser !== fb) return;
    fb.preview = data;
  } catch (error) {
    if (fileBrowser !== fb) return;
    fb.previewError = error.message;
  } finally {
    if (fileBrowser === fb) {
      fb.previewLoading = false;
      fb.previewDirty = true;
      renderFilePanels();
    }
  }
}

/** 文件模式下的面板头（标题 / 上传 / 下载 / 刷新）。幂等，可反复调用。 */
function setFilesChrome(on) {
  const sessionsTitle = document.getElementById("sessions-title");
  const tasksTitle = document.getElementById("tasks-title");
  const upload = document.getElementById("file-upload-btn");
  const download = document.getElementById("file-download-btn");
  const refresh = document.getElementById("file-refresh-btn");
  const tasksNavLabel = document.querySelector('[data-mobile-panel="tasks"] span');
  if (!sessionsTitle || !tasksTitle || !upload) return;
  document.body.classList.toggle("mode-files", on);
  // 模式切换：重新进入时面板 DOM 已不属于文件浏览器，强制整块重画。
  if (on !== filesModeMounted) {
    filesModeMounted = on;
    if (on && fileBrowser) {
      fileBrowser.treeDirty = true;
      fileBrowser.previewDirty = true;
    }
  }
  if (on) {
    if (sessionsTitle.textContent !== "文件") sessionsTitle.textContent = "文件";
    if (tasksTitle.textContent !== "文件预览") tasksTitle.textContent = "文件预览";
    upload.hidden = false;
    const hasFile = Boolean(fileBrowser?.selected);
    download.hidden = !hasFile;
    refresh.hidden = !hasFile;
    if (tasksNavLabel && tasksNavLabel.textContent !== "预览") tasksNavLabel.textContent = "预览";
  } else {
    if (sessionsTitle.textContent !== "会话") sessionsTitle.textContent = "会话";
    if (!tasksTitle.querySelector("small")) tasksTitle.innerHTML = "任务图 <small>当前会话</small>";
    upload.hidden = true;
    download.hidden = true;
    refresh.hidden = true;
    if (tasksNavLabel && tasksNavLabel.textContent !== "任务") tasksNavLabel.textContent = "任务";
  }
  if (upload.hidden) return;
  const dirLabel = fileBrowser?.currentDir ? fileBrowser.currentDir : "项目根目录";
  upload.title = `上传文件到 ${dirLabel}`;
  download.href = fileBrowser?.selected ? rawFileUrl(fileBrowser.project, fileBrowser.selected, true) : "#";
}

function renderFilePanels() {
  const fb = fileBrowser;
  if (!fb || selected?.type !== "files" || selected.project !== fb.project) return;
  if (fb.treeDirty) {
    renderFileTree(fb);
    fb.treeDirty = false;
  }
  if (fb.previewDirty) {
    renderFilePreview(fb);
    fb.previewDirty = false;
  }
  setFilesChrome(true);
}

function renderFileTree(fb) {
  const root = document.getElementById("session-list");
  root.innerHTML = "";
  if (fb.notice) root.appendChild(el("div", fb.noticeError ? "file-notice err" : "file-notice", fb.notice));
  const current = el("div", "file-current-dir", `上传目录：${fb.currentDir || "（项目根目录）"}`);
  root.appendChild(current);
  const tree = el("div", "file-tree");
  root.appendChild(tree);
  appendFileRows(tree, fb, "", 0);
}

function appendFileRows(container, fb, rel, depth) {
  const node = fb.dirs.get(rel);
  const indent = 4 + depth * 12;
  if (node?.error) {
    const row = el("div", "file-error", node.error);
    row.style.paddingLeft = `${indent}px`;
    container.appendChild(row);
    const retry = el("div", "file-loading", "点击重试");
    retry.style.paddingLeft = `${indent}px`;
    retry.onclick = () => loadFileDir(rel, { force: true });
    container.appendChild(retry);
    return;
  }
  if (!node?.loaded) {
    const row = el("div", "file-loading", node?.loading === false ? "（空目录）" : "加载中…");
    row.style.paddingLeft = `${indent}px`;
    container.appendChild(row);
    return;
  }
  if (node.items.length === 0) {
    const row = el("div", "file-empty", "（空目录）");
    row.style.paddingLeft = `${indent}px`;
    container.appendChild(row);
    return;
  }
  for (const item of node.items) {
    const isDir = item.type === "dir";
    const open = isDir && fb.expanded.has(item.path);
    const row = el("div", isDir ? "file-row file-row-dir" : "file-row file-row-file");
    row.style.paddingLeft = `${indent}px`;
    if (!isDir && fb.selected === item.path) row.classList.add("selected");
    if (isDir && fb.currentDir === item.path) row.classList.add("file-row-current");
    row.appendChild(el("span", "file-arrow", isDir ? (open ? "▼" : "▶") : ""));
    row.appendChild(el("span", "file-icon", fileIcon(item)));
    const name = el("span", "file-name", item.name);
    name.title = item.path;
    row.appendChild(name);
    if (!isDir) {
      if (item.size !== null && item.size !== undefined) row.appendChild(el("span", "file-size", formatBytes(item.size)));
      const download = el("a", "file-row-dl", "⬇");
      download.href = rawFileUrl(fb.project, item.path, true);
      download.title = `下载 ${item.path}`;
      download.download = item.name;
      download.onclick = (event) => event.stopPropagation();
      row.appendChild(download);
    }
    row.onclick = () => {
      if (isDir) toggleFileDir(fb, item.path);
      else openFilePreview(fb, item.path);
    };
    container.appendChild(row);
    if (isDir && open) appendFileRows(container, fb, item.path, depth + 1);
  }
  if (node.truncated) {
    const row = el("div", "file-loading", "目录条目过多，仅显示前一部分");
    row.style.paddingLeft = `${indent + 12}px`;
    container.appendChild(row);
  }
}

function renderFilePreview(fb) {
  const box = document.getElementById("task-graph");
  box.innerHTML = "";
  box.className = "scroll file-preview";
  if (!fb.selected) {
    box.appendChild(el("div", "file-preview-hint", "← 在左侧文件树里点文件预览，点文件夹展开/收起。"));
    return;
  }
  if (fb.previewLoading) {
    box.appendChild(el("div", "file-preview-hint", `读取 ${fb.selected} …`));
    return;
  }
  if (fb.previewError) {
    const wrap = el("div", "file-preview-body");
    wrap.appendChild(el("div", "file-preview-error", fb.previewError));
    const retry = el("button", "btn-secondary", "重试");
    retry.onclick = () => openFilePreview(fb, fb.selected);
    wrap.appendChild(retry);
    box.appendChild(wrap);
    return;
  }
  const preview = fb.preview;
  if (!preview) {
    box.appendChild(el("div", "file-preview-hint", "读取中…"));
    return;
  }

  const bar = el("div", "file-preview-bar");
  const title = el("strong", "", preview.path);
  bar.appendChild(title);
  bar.appendChild(el("span", "", `${formatBytes(preview.size)} · ${formatDateTime(preview.mtime)}`));
  if (preview.truncated) {
    bar.appendChild(el("span", "file-size", `已截断，仅显示前 ${formatBytes(preview.previewBytes ?? 0)}`));
  }
  if (preview.kind === "text" && MARKDOWN_RE.test(preview.path)) {
    const toggle = el("button", "btn-secondary", fb.markdownSource ? "渲染" : "源码");
    toggle.onclick = () => {
      fb.markdownSource = !fb.markdownSource;
      fb.previewDirty = true;
      renderFilePanels();
    };
    bar.appendChild(toggle);
  }
  // 只有媒体类型允许 inline，其它类型走 raw 会触发下载，所以不给「新标签打开」。
  if (preview.kind === "media") {
    const openRaw = el("a", "panel-link", "↗ 新标签打开");
    openRaw.href = rawFileUrl(fb.project, preview.path);
    openRaw.target = "_blank";
    openRaw.rel = "noopener noreferrer";
    bar.appendChild(openRaw);
  }
  box.appendChild(bar);

  const body = el("div", "file-preview-body");
  box.appendChild(body);
  if (preview.kind === "media") renderMediaPreview(body, fb, preview);
  else if (preview.kind === "binary") renderBinaryPreview(body, fb, preview);
  else if (fb.markdownSource === false && MARKDOWN_RE.test(preview.path)) {
    body.appendChild(markdownBlock(preview.content));
    body.firstChild?.classList.add("file-md");
  } else renderTextPreview(body, preview);
}

function renderMediaPreview(body, fb, preview) {
  const url = rawFileUrl(fb.project, preview.path);
  if (preview.mediaKind === "image") {
    const img = el("img", "file-image");
    img.src = url;
    img.alt = preview.path;
    img.title = "点击在新标签打开";
    img.onclick = () => window.open(url, "_blank", "noopener");
    body.appendChild(img);
    return;
  }
  if (preview.mediaKind === "pdf") {
    const frame = el("iframe", "file-pdf");
    frame.src = url;
    frame.title = preview.path;
    body.appendChild(frame);
    return;
  }
  const node = document.createElement(preview.mediaKind === "video" ? "video" : "audio");
  node.className = "file-media";
  node.controls = true;
  node.src = url;
  body.appendChild(node);
}

function renderBinaryPreview(body, fb, preview) {
  const wrap = el("div", "file-binary");
  wrap.appendChild(el("div", "", `${preview.name ?? preview.path} 是二进制文件，不能直接预览。`));
  wrap.appendChild(el("div", "muted", `${formatBytes(preview.size)} · ${preview.mime}`));
  const link = el("a", "panel-link", "⬇ 下载文件");
  link.href = rawFileUrl(fb.project, preview.path, true);
  link.download = preview.name ?? "";
  wrap.appendChild(link);
  body.appendChild(wrap);
}

function highlightToHtml(code, language) {
  const hljs = window.hljs;
  if (!hljs || code.length > HIGHLIGHT_MAX_CHARS) return null;
  try {
    if (language && hljs.getLanguage(language)) {
      return hljs.highlight(code, { language, ignoreIllegals: true }).value;
    }
    if (!language && code.length <= 100 * 1024) return hljs.highlightAuto(code).value;
    return null;
  } catch {
    return null;
  }
}

function renderTextPreview(body, preview) {
  const text = String(preview.content ?? "").replace(/\r\n/g, "\n").replace(/\n$/, "");
  const lineCount = text.split("\n").length;
  const wrap = el("div", "file-code-wrap");
  const gutter = el("pre", "file-gutter");
  gutter.textContent = Array.from({ length: lineCount }, (_, index) => index + 1).join("\n");
  const code = el("pre", "file-code");
  const codeEl = el("code", "hljs");
  const html = highlightToHtml(text, preview.language);
  if (html === null) codeEl.textContent = text;
  else codeEl.innerHTML = html;
  code.appendChild(codeEl);
  wrap.appendChild(gutter);
  wrap.appendChild(code);
  body.appendChild(wrap);
}

async function uploadFiles(files) {
  const fb = fileBrowser;
  if (!fb || files.length === 0) return;
  const dir = fb.currentDir;
  const failures = [];
  let done = 0;
  for (const file of files) {
    fb.notice = `正在上传 ${file.name}（${done + 1}/${files.length}）…`;
    fb.noticeError = false;
    fb.treeDirty = true;
    renderFilePanels();
    const params = { project: fb.project, dir, name: file.name };
    const send = (extra = {}) => fetch(`/api/files/upload?${new URLSearchParams({ ...params, ...extra }).toString()}`, {
      method: "POST",
      headers: { "Content-Type": "application/octet-stream" },
      body: file,
    });
    let response = await send().catch((error) => ({ ok: false, status: 0, json: async () => ({ error: error.message }) }));
    if (response.status === 409) {
      if (!confirm(`${file.name} 已存在，覆盖？`)) {
        failures.push(`${file.name}：已跳过`);
        continue;
      }
      response = await send({ overwrite: "1" });
    }
    if (!response.ok) {
      const data = await response.json().catch(() => ({}));
      failures.push(`${file.name}：${data.error || `HTTP ${response.status}`}`);
      continue;
    }
    done += 1;
  }
  // 上传过程中用户可能切到别的项目，旧 fb 不能再动新状态。
  if (fileBrowser !== fb) return;
  fb.expanded.add(dir);
  const notice = failures.length
    ? `已上传 ${done} 个，失败 ${failures.length} 个：${failures.join("；")}`
    : `✅ 已上传 ${done} 个文件到 ${dir || "项目根目录"}`;
  fb.notice = notice;
  fb.noticeError = failures.length > 0;
  await loadFileDir(dir, { force: true });
  // 成功提示几秒后自动消失，失败信息保留给用户看清楚。
  if (failures.length === 0) {
    setTimeout(() => {
      if (fileBrowser === fb && fb.notice === notice) {
        fb.notice = null;
        fb.treeDirty = true;
        renderFilePanels();
      }
    }, 4000);
  }
}

function sessionSourceLabel(conversation) {
  if (conversation.source === "main") return "项目主会话";
  if (conversation.source === "schedule") return "定时任务";
  if (conversation.source === "subagent") return `由助理会话 #${conversation.parentConversationId ?? "—"} 派发`;
  if (conversation.source === "manual") return "手动创建";
  return conversation.owner ? "后台会话" : "项目会话";
}

function actorFromSelection() {
  if (selected?.type === "actor") return selected;
  if (selected?.type !== "conversation") return null;
  const conversation = state.conversations.find((item) => item.id === selected.id);
  if (!conversation?.actorType) return null;
  return { project: conversation.project, actorType: conversation.actorType, actorName: conversation.actorName };
}

async function loadConversationDetail(id, { force = false } = {}) {
  const key = String(id);
  if (!force && conversationDetailCache.has(key)) return conversationDetailCache.get(key);
  if (conversationDetailRequests.has(key)) return conversationDetailRequests.get(key);
  const request = fetch(`/api/conversation?id=${encodeURIComponent(key)}`)
    .then(async (response) => {
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || "加载会话失败");
      conversationDetailCache.set(key, result);
      return result;
    })
    .finally(() => conversationDetailRequests.delete(key));
  conversationDetailRequests.set(key, request);
  return request;
}

function conversationAgeBucket(conversation) {
  if (["running", "waiting-tool", "pending"].includes(conversation.status)) return "recent";
  const createdAt = new Date(conversation.createdAt ?? 0).getTime();
  if (!createdAt) return "older";
  const age = Date.now() - createdAt;
  if (age < 3 * 86400000) return "recent";
  if (age < 7 * 86400000) return "threeDays";
  if (age < 30 * 86400000) return "sevenDays";
  return "older";
}

/** 创建一个会话列表条目节点（结构固定，后续只 patch 文本与 class）。 */
function createSessionItemNode(conversation) {
  const item = el("div", "session-item");
  item.dataset.convId = String(conversation.id);
  const dot = el("span", "session-dot");
  const titleDiv = el("div", "session-title");
  const titleText = el("span", "session-title-text");
  const renameBtn = el("button", "session-rename", "✎");
  renameBtn.type = "button";
  renameBtn.title = "重命名会话";
  titleDiv.appendChild(titleText);
  titleDiv.appendChild(renameBtn);
  item.appendChild(dot);
  item.appendChild(titleDiv);
  const meta = el("div", "session-meta");
  item.appendChild(meta);
  const entry = { node: item, dot, titleText, meta, conv: conversation };
  renameBtn.onclick = (ev) => {
    ev.stopPropagation();
    renameConversation(entry.conv);
  };
  item.onclick = () => {
    selected = { type: "conversation", project: entry.conv.project, id: entry.conv.id };
    setMobilePanel("view");
    render();
  };
  return entry;
}

/** 只更新变化的字段：状态点 class/提示、标题、meta 文本、选中态。 */
function patchSessionItemNode(entry, conversation) {
  entry.conv = conversation;
  const status = conversation.status ?? "idle";
  const dotClass = `session-dot session-dot-${status}`;
  if (entry.dot.className !== dotClass) {
    entry.dot.className = dotClass;
    entry.dot.title = agentStatusLabel(status);
  }
  const title = conversationDisplayTitle(conversation);
  if (entry.titleText.textContent !== title) entry.titleText.textContent = title;
  const metaText = `${sessionSourceLabel(conversation)} · #${conversation.id}${conversation.createdAt ? ` · ${formatDateTime(conversation.createdAt)}` : ""}`;
  if (entry.meta.textContent !== metaText) entry.meta.textContent = metaText;
  const itemClass = selected?.type === "conversation" && selected.id === conversation.id ? "session-item selected" : "session-item";
  if (entry.node.className !== itemClass) entry.node.className = itemClass;
}

/** 把一组会话渲染到容器：复用已有节点，按需插入/移除，避免整列表重建。 */
function renderSessionItemsInto(container, conversations) {
  const present = new Set();
  let previous = null;
  for (const conversation of conversations) {
    const id = String(conversation.id);
    present.add(id);
    let entry = sessionItemNodes.get(id);
    if (!entry) {
      entry = createSessionItemNode(conversation);
      sessionItemNodes.set(id, entry);
    }
    patchSessionItemNode(entry, conversation);
    // 顺序不对时只做一次 insertBefore（移动已有节点不重建子树）。
    const expected = previous ? previous.nextSibling : container.firstChild;
    if (entry.node !== expected) container.insertBefore(entry.node, expected);
    previous = entry.node;
  }
  for (const child of [...container.children]) {
    const id = child.dataset.convId;
    if (id === undefined || present.has(id)) continue;
    child.remove();
    sessionItemNodes.delete(id);
  }
}

function renderSessions() {
  const body = document.getElementById("session-list");
  const createButton = document.getElementById("new-conversation");
  const actor = actorFromSelection();
  createButton.disabled = !actor;
  createButton.title = actor
    ? `为${actor.actorType === "assistant" ? "助理" : ` Agent ${actor.actorName}`}新建独立会话`
    : "请先选择助理或 Agent";
  if (!actor) {
    body.replaceChildren(el("div", "session-empty", "请在第一栏选择一个助理或 Agent，这里会显示它的全部会话。"));
    sessionItemNodes.clear();
    sessionBucketNodes.clear();
    return;
  }
  const heading = el("div", "session-context");
  heading.appendChild(el("strong", "", actor.actorType === "assistant" ? "🤖 助理" : `🤖 ${actor.actorName}`));
  heading.appendChild(el("span", "", actor.project));
  body.replaceChildren(heading);
  const conversations = (state?.conversations ?? [])
    .filter((item) => item.project === actor.project && item.actorType === actor.actorType
      && (actor.actorType !== "agent" || item.actorName === actor.actorName))
    .sort((a, b) => {
      const active = (value) => value.status === "running" || value.status === "waiting-tool" ? 1 : 0;
      return active(b) - active(a) || String(b.createdAt ?? b.id).localeCompare(String(a.createdAt ?? b.id));
    });
  if (conversations.length === 0) {
    body.appendChild(el("div", "session-empty", actor.actorType === "agent" ? "这个 Agent 还没有会话；助理首次派发任务后会自动创建。" : "暂无会话。"));
    sessionItemNodes.clear();
    sessionBucketNodes.clear();
    return;
  }
  const buckets = { recent: [], threeDays: [], sevenDays: [], older: [] };
  for (const conversation of conversations) buckets[conversationAgeBucket(conversation)].push(conversation);
  renderSessionItemsInto(body, buckets.recent);
  for (const [key, label] of [["threeDays", "3 天以前"], ["sevenDays", "7 天以前"], ["older", "一个月以前"]]) {
    const items = buckets[key];
    if (items.length === 0) continue;
    let folded = sessionBucketNodes.get(key);
    if (!folded) {
      folded = el("details", "session-history-group");
      folded.appendChild(el("summary", "session-history-summary", ""));
      folded.appendChild(el("div", "session-history-list"));
      sessionBucketNodes.set(key, folded);
    }
    const summary = folded.querySelector(".session-history-summary");
    const summaryText = `${label} · ${items.length} 个会话`;
    if (summary.textContent !== summaryText) summary.textContent = summaryText;
    folded.open = items.some((conversation) => selected?.type === "conversation" && selected.id === conversation.id);
    renderSessionItemsInto(folded.querySelector(".session-history-list"), items);
    // 分组节点位置可能变化（新建分组时需要挂到列表末尾）。
    if (folded.parentElement !== body) body.appendChild(folded);
  }
  // 清掉本次不再出现的折叠分组。
  const liveGroups = new Set(["threeDays", "sevenDays", "older"].filter((key) => buckets[key].length > 0));
  for (const [key, node] of [...sessionBucketNodes]) {
    if (liveGroups.has(key)) continue;
    node.remove();
    sessionBucketNodes.delete(key);
  }
  // 当前角色不可见的会话条目节点一并回收，避免缓存无限增长。
  const visible = new Set(conversations.map((c) => String(c.id)));
  for (const [id, entry] of [...sessionItemNodes]) {
    if (visible.has(id)) continue;
    entry.node.remove();
    sessionItemNodes.delete(id);
  }
}

document.getElementById("new-conversation").onclick = async () => {
  const actor = actorFromSelection();
  if (!actor) return;
  const button = document.getElementById("new-conversation");
  const oldText = button.textContent;
  button.disabled = true;
  button.textContent = "创建中…";
  try {
    const response = await fetch("/api/role-conversations", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(actor),
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || "创建会话失败");
    selected = { type: "conversation", project: actor.project, id: String(result.conversationId) };
    setMobilePanel("view");
    await refresh();
  } catch (error) {
    alert(error.message);
  } finally {
    button.textContent = oldText;
    button.disabled = !actorFromSelection();
  }
};

// ─── 第三栏：对话 / 配置视图 ────────────────────────────────────────────────
function renderView() {
  const view = document.getElementById("view");
  // 切换到不同视图时重置滚动状态；同一视图内刷新则保留原滚动位置。
  const key = selected ? `${selected.type}:${selected.id ?? selected.project ?? ""}` : "";
  const sameView = key !== "" && key === lastViewKey;
  lastViewKey = key;
  const oldBody = view.querySelector(".view-body");
  if (sameView && oldBody) {
    const atBottom = oldBody.scrollHeight - oldBody.scrollTop - oldBody.clientHeight < 40;
    viewScrollState = { top: oldBody.scrollTop, atBottom };
  } else {
    viewScrollState = { top: 0, atBottom: true };
  }
  // 同一会话内刷新时保留输入框节点：直接 innerHTML="" 会把聚焦的输入框从 DOM 摘掉，
  // 导致焦点、光标位置和输入法组合状态丢失。
  const convKey = selected?.type === "conversation" ? String(selected.id) : "";
  const keep = convKey ? composerCache.get(convKey)?.form : undefined;
  // 增量渲染：属于当前会话的正文节点保留在 DOM 里，不摘除再挂回——
  // 摘除/挂回会丢失滚动位置，并且额外触发一次布局。
  const preserve = convKey && oldBody && oldBody.dataset.convId === convKey ? oldBody : null;
  for (const child of [...view.children]) {
    if (child !== keep && child !== preserve) child.remove();
  }
  if (!selected) {
    view.className = "view-empty";
    view.textContent = "pi-box";
    return;
  }
  view.className = "";
  if (selected.type === "project") return renderProjectForm(view);
  if (selected.type === "actor") {
    view.className = "view-empty";
    view.textContent = "选择一个会话";
    return;
  }
  if (selected.type === "conversation") return renderConversation(view);
}

function formatDateTime(value) {
  if (!value) return "—";
  try { return new Date(value).toLocaleString("zh-CN", { hour12: false }); } catch { return value; }
}

function formatMessageTime(value) {
  if (value === undefined || value === null) return "";
  try {
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return "";
    const today = new Date();
    const sameDay = date.getFullYear() === today.getFullYear()
      && date.getMonth() === today.getMonth()
      && date.getDate() === today.getDate();
    return date.toLocaleString("zh-CN", sameDay
      ? { hour: "2-digit", minute: "2-digit", hour12: false }
      : { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false });
  } catch {
    return "";
  }
}

function timezoneLabel(value) {
  return ({ "Asia/Shanghai": "北京时间", "Asia/Tokyo": "东京时间", "Europe/London": "伦敦时间", "America/New_York": "纽约时间", UTC: "协调世界时" })[value] || value;
}

async function reloadSchedules(project) {
  const response = await fetch(`/api/schedules?project=${encodeURIComponent(project)}`);
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || "读取定时任务失败");
  schedulesCache[project] = data.schedules ?? [];
  scheduleRunsCache[project] = data.runs ?? [];
  if (state) state.schedulesByProject = schedulesCache;
  return data;
}

const SCHEDULE_KIND_LABEL = {
  command: "命令",
  llm: "LLM",
  "command+llm": "命令 + LLM",
};

function scheduleKindLabel(schedule) {
  const kind = schedule.kind ?? (schedule.command ? (schedule.llm ? "command+llm" : "command") : "llm");
  return SCHEDULE_KIND_LABEL[kind] ?? kind;
}

function runStatusLabel(run) {
  if (!run) return null;
  if (run.status === "skipped-running") return "跳过（上一轮仍在运行）";
  if (run.status === "submitted") return "已提交";
  const parts = [run.status === "completed" ? "完成" : run.status === "aborted" ? "中断" : "失败"];
  if (run.exitCode !== undefined && run.exitCode !== null) parts.push(`exit ${run.exitCode}`);
  if (typeof run.durationMs === "number") parts.push(`${(run.durationMs / 1000).toFixed(1)}s`);
  if (run.llmStatus && run.llmStatus !== "none") parts.push(`LLM ${run.llmStatus}`);
  return parts.join(" · ");
}

function fillScheduleList(body, project, schedules) {
  body.replaceChildren();
  if (schedules.length === 0) {
    body.appendChild(el("div", "schedule-empty", "还没有定时任务。点击“新建定时任务”开始配置。"));
    return;
  }
  for (const schedule of schedules) {
    const card = el("div", "schedule-card");
    if (selected?.scheduleId === schedule.id) card.classList.add("selected");
    const title = el("div", "schedule-card-title");
    title.appendChild(el("span", schedule.enabled ? "schedule-badge enabled" : "schedule-badge", schedule.enabled ? "已启用" : "已停用"));
    title.appendChild(el("span", "schedule-kind", scheduleKindLabel(schedule)));
    title.appendChild(el("strong", "", schedule.name));
    card.appendChild(title);
    card.appendChild(el("div", "schedule-cron", schedule.description || "自定义时间规则"));
    card.appendChild(el("div", "muted schedule-timezone", `时区：${timezoneLabel(schedule.timezone)}（${schedule.timezone}）`));

    if (schedule.command?.run) {
      card.appendChild(el("div", "schedule-prompt schedule-command", `命令：${schedule.command.run}`));
    }
    if (schedule.llm?.prompt) {
      const agentLabel = schedule.llm.agent && schedule.llm.agent !== "assistant"
        ? String(schedule.llm.agent).replace(/^agent:/, "")
        : "项目助理";
      const sessionLabel = schedule.llm.session === "persistent" ? "沿用助理会话" : "每次新建会话";
      card.appendChild(el("div", "muted schedule-session-mode", `LLM：${agentLabel} · ${sessionLabel}`));
      card.appendChild(el("div", "schedule-prompt", schedule.llm.prompt));
    } else if (!schedule.command?.run) {
      card.appendChild(el("div", "schedule-prompt", schedule.prompt || ""));
    }
    if (schedule.log?.retentionDays !== undefined) {
      card.appendChild(el("div", "muted", `日志保留：${schedule.log.retentionDays} 天`));
    }
    card.appendChild(el("div", "muted", `上次触发：${formatDateTime(schedule.lastRunAt)}　下次执行：${formatDateTime(schedule.nextRunAt)}`));

    const runs = (scheduleRunsCache[project] ?? []).filter((item) => item.scheduleId === schedule.id);
    const latestRun = runs[0];
    if (latestRun) {
      const line = el("div", "muted schedule-last-run", `最近运行：${runStatusLabel(latestRun) ?? latestRun.status}`);
      if (latestRun.finishedAt) line.textContent += `　${formatDateTime(latestRun.finishedAt)}`;
      card.appendChild(line);
    }
    if (latestRun?.llmConversationId) {
      card.appendChild(el("div", "muted schedule-last-run", `最近运行会话：#${latestRun.llmConversationId}`));
    }

    const actions = el("div", "schedule-actions");
    const run = el("button", "btn-secondary", "立即运行");
    run.onclick = async () => {
      run.disabled = true;
      run.textContent = "提交中…";
      const response = await fetch("/api/schedules/run", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ project, id: schedule.id }) });
      const result = await response.json();
      run.disabled = false;
      run.textContent = response.ok ? "已提交" : `失败：${result.error || "未知错误"}`;
      if (response.ok) {
        await Promise.all([refresh(), reloadSchedules(project)]);
        render();
      }
    };
    const edit = el("button", "btn-secondary", "编辑");
    edit.onclick = () => openScheduleEditor(project, schedule);
    const logs = el("button", "btn-secondary", "日志");
    logs.onclick = () => openScheduleLog(project, schedule);
    actions.append(run, edit, logs);
    if (latestRun?.llmConversationId) {
      const viewRun = el("button", "btn-secondary", "查看最近会话");
      viewRun.onclick = async () => {
        if (!state.conversations.some((item) => item.id === String(latestRun.llmConversationId))) await refresh();
        selected = { type: "conversation", project, id: String(latestRun.llmConversationId) };
        setMobilePanel("view");
        render();
      };
      actions.appendChild(viewRun);
    }
    card.appendChild(actions);
    body.appendChild(card);
  }
}

/** 定时任务运行日志抽屉：可按最近运行记录切换。 */
async function openScheduleLog(project, schedule) {
  const overlay = el("div", "drawer-submodal-backdrop");
  const modal = el("div", "drawer-submodal schedule-log-modal");
  modal.setAttribute("role", "dialog");
  modal.setAttribute("aria-modal", "true");
  modal.appendChild(el("h3", "", `运行日志 · ${schedule.name}`));

  const runs = (scheduleRunsCache[project] ?? []).filter((item) => item.scheduleId === schedule.id).slice(0, 20);
  const picker = document.createElement("select");
  const latestOption = document.createElement("option");
  latestOption.value = "";
  latestOption.textContent = "最近一次运行（latest.log）";
  picker.appendChild(latestOption);
  for (const item of runs) {
    const option = document.createElement("option");
    option.value = item.id;
    option.textContent = `${formatDateTime(item.triggeredAt)} · ${runStatusLabel(item) ?? item.status}`;
    picker.appendChild(option);
  }
  modal.appendChild(formRow("运行记录", picker));

  const meta = el("div", "muted schedule-log-meta", "加载中…");
  const pre = el("pre", "schedule-log-body", "");
  modal.append(meta, pre);

  const load = async (runId) => {
    meta.textContent = "加载中…";
    pre.textContent = "";
    const query = new URLSearchParams({ project, scheduleId: schedule.id, tail: "500" });
    if (runId) query.set("runId", runId);
    const response = await fetch(`/api/schedules/logs?${query}`);
    const result = await response.json();
    if (!response.ok) {
      meta.textContent = `❌ ${result.error || "读取日志失败"}`;
      return;
    }
    // 去掉 ANSI 控制序列，避免终端颜色码污染页面
    const text = (result.lines ?? []).join("\n").replace(/\u001b\[[0-9;]*[a-zA-Z]/g, "").replace(/\r/g, "");
    pre.textContent = text || "（日志为空）";
    meta.textContent = `${(result.bytes / 1024).toFixed(1)} KB${result.truncatedFromStart ? "（只显示末尾 512 KB）" : ""}　${result.path}`;
    pre.scrollTop = pre.scrollHeight;
  };
  picker.onchange = () => load(picker.value);

  const actions = el("div", "form-actions");
  const reload = el("button", "btn-secondary", "刷新");
  reload.onclick = () => load(picker.value);
  const close = el("button", "btn-primary", "关闭");
  close.onclick = () => overlay.remove();
  actions.append(reload, close);
  modal.appendChild(actions);
  overlay.appendChild(modal);
  overlay.onclick = (event) => {
    if (event.target === overlay) overlay.remove();
  };
  document.body.appendChild(overlay);
  await load("");
}

function openScheduleEditor(project, existing = null) {
  const overlay = el("div", "drawer-submodal-backdrop");
  const modal = el("div", "drawer-submodal schedule-editor-modal");
  modal.setAttribute("role", "dialog");
  modal.setAttribute("aria-modal", "true");
  modal.appendChild(el("h3", "", existing ? `编辑定时任务 · ${existing.name}` : "新建定时任务"));

  const name = document.createElement("input");
  name.value = existing?.name ?? "";
  name.placeholder = "例如：每日项目巡检";
  modal.appendChild(formRow("名称", name));

  const initialRule = existing?.rule ?? { type: "daily", time: "09:00" };
  const frequency = document.createElement("select");
  for (const [value, label] of [["interval", "每隔一段时间"], ["daily", "每天"], ["weekdays", "工作日"], ["weekly", "每周"], ["monthly", "每月"], ["once", "仅执行一次"]]) {
    const option = document.createElement("option");
    option.value = value;
    option.textContent = label;
    frequency.appendChild(option);
  }
  frequency.value = initialRule.type || "daily";
  modal.appendChild(formRow("执行频率", frequency));

  const ruleFields = el("div", "schedule-rule-fields");
  modal.appendChild(ruleFields);

  const timezone = document.createElement("select");
  const browserTimezone = Intl.DateTimeFormat().resolvedOptions().timeZone || "Asia/Shanghai";
  const timezoneValues = [...new Set([existing?.timezone, browserTimezone, "Asia/Shanghai", "Asia/Tokyo", "Europe/London", "America/New_York", "UTC"].filter(Boolean))];
  for (const value of timezoneValues) {
    const option = document.createElement("option");
    option.value = value;
    option.textContent = `${timezoneLabel(value)}（${value}${value === browserTimezone ? "，本地" : ""}）`;
    timezone.appendChild(option);
  }
  timezone.value = existing?.timezone ?? browserTimezone;
  modal.appendChild(formRow("时区", timezone));

  let readRule = () => initialRule;
  const renderRuleFields = () => {
    ruleFields.replaceChildren();
    const type = frequency.value;
    if (type === "interval") {
      const line = el("div", "schedule-inline-rule");
      line.appendChild(el("span", "", "每隔"));
      const every = document.createElement("input");
      every.type = "number";
      every.min = "1";
      every.value = initialRule.type === type ? String(initialRule.every ?? 30) : "30";
      const unit = document.createElement("select");
      for (const [value, label] of [["minute", "分钟"], ["hour", "小时"], ["day", "天"]]) {
        const option = document.createElement("option"); option.value = value; option.textContent = label; unit.appendChild(option);
      }
      unit.value = initialRule.type === type ? initialRule.unit ?? "minute" : "minute";
      line.append(every, unit, el("span", "", "执行一次"));
      ruleFields.appendChild(line);
      readRule = () => ({ type, every: Number(every.value), unit: unit.value });
      return;
    }
    if (type === "once") {
      const runAt = document.createElement("input");
      runAt.type = "datetime-local";
      const fallback = new Date(Date.now() + 3_600_000);
      fallback.setSeconds(0, 0);
      const date = initialRule.type === type ? new Date(initialRule.runAt) : fallback;
      const local = new Date(date.getTime() - date.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
      runAt.value = local;
      ruleFields.appendChild(formRow("执行时间", runAt));
      readRule = () => ({ type, localDateTime: runAt.value });
      return;
    }
    const time = document.createElement("input");
    time.type = "time";
    time.value = initialRule.type === type ? initialRule.time ?? "09:00" : "09:00";
    if (type === "weekly") {
      const weekdayWrap = el("div", "schedule-weekdays");
      const selectedDays = new Set(initialRule.type === type ? initialRule.weekdays ?? [1] : [1]);
      for (const [day, label] of [[1, "一"], [2, "二"], [3, "三"], [4, "四"], [5, "五"], [6, "六"], [0, "日"]]) {
        const item = el("label", "schedule-weekday");
        const checkbox = document.createElement("input"); checkbox.type = "checkbox"; checkbox.value = String(day); checkbox.checked = selectedDays.has(day);
        item.append(checkbox, el("span", "", label)); weekdayWrap.appendChild(item);
      }
      ruleFields.appendChild(formRow("星期", weekdayWrap));
      ruleFields.appendChild(formRow("执行时间", time));
      readRule = () => ({ type, weekdays: [...weekdayWrap.querySelectorAll("input:checked")].map((item) => Number(item.value)), time: time.value });
      return;
    }
    if (type === "monthly") {
      const day = document.createElement("select");
      for (let value = 1; value <= 28; value += 1) {
        const option = document.createElement("option"); option.value = String(value); option.textContent = `${value} 日`; day.appendChild(option);
      }
      day.value = String(initialRule.type === type ? initialRule.day ?? 1 : 1);
      ruleFields.appendChild(formRow("每月", day));
      ruleFields.appendChild(formRow("执行时间", time));
      readRule = () => ({ type, day: Number(day.value), time: time.value });
      return;
    }
    ruleFields.appendChild(formRow("执行时间", time));
    readRule = () => ({ type, time: time.value });
  };
  frequency.onchange = renderRuleFields;
  renderRuleFields();

  // ── 执行方式：命令 / LLM / 命令 + LLM ──────────────────────────────
  const hasCommand = Boolean(existing?.command?.run);
  const hasLlm = Boolean(existing?.llm?.prompt);
  const initialKind = hasCommand && hasLlm ? "command+llm" : hasCommand ? "command" : "llm";

  const kindSelect = document.createElement("select");
  for (const [value, label, help] of [
    ["command", "只执行命令（不调用模型）", "定时直接跑命令，不创建会话，不消耗 token。"],
    ["llm", "只调用模型（LLM 任务）", "把提示词交给模型执行，会产生会话。"],
    ["command+llm", "执行命令，再交给模型处理", "先跑命令，再把输出作为上下文交给模型出结论/报告。"],
  ]) {
    const option = document.createElement("option");
    option.value = value;
    option.textContent = label;
    option.dataset.help = help;
    kindSelect.appendChild(option);
  }
  kindSelect.className = "schedule-kind-select";
  kindSelect.value = initialKind;
  modal.appendChild(formRow("执行方式", kindSelect));
  const kindHelp = el("div", "muted schedule-session-help", "");
  modal.appendChild(kindHelp);

  // 命令段
  const commandWrap = el("div", "schedule-section");
  const commandText = document.createElement("textarea");
  commandText.className = "cfg-textarea code-textarea schedule-command-input";
  commandText.rows = 4;
  commandText.placeholder = "例如：/workspace/demo/run.sh /workspace/.venv/bin/python script.py";
  commandText.value = existing?.command?.run ?? "";
  commandWrap.appendChild(el("div", "form-label", "执行命令（由 bash -c 执行，工作目录默认是项目目录）"));
  commandWrap.appendChild(commandText);

  const commandOptions = el("div", "schedule-inline-rule");
  const timeout = document.createElement("input");
  timeout.type = "number";
  timeout.min = "1";
  timeout.max = "86400";
  timeout.value = String(existing?.command?.timeoutSec ?? 900);
  const concurrency = document.createElement("select");
  for (const [value, label] of [["skip", "跳过本次"], ["queue", "允许并行"]]) {
    const option = document.createElement("option");
    option.value = value;
    option.textContent = label;
    concurrency.appendChild(option);
  }
  concurrency.value = existing?.command?.concurrency ?? "skip";
  commandOptions.append(el("span", "", "超时"), timeout, el("span", "", "秒；同一任务重叠时"), concurrency);
  commandWrap.appendChild(commandOptions);
  commandWrap.appendChild(el("div", "muted", "输出写入项目 .pi/schedule-logs/，单次上限 20MB。环境变量沿用容器全局配置。"));
  modal.appendChild(commandWrap);

  // LLM 段
  const llmWrap = el("div", "schedule-section");
  llmWrap.appendChild(el("div", "form-label", "交给哪个角色执行"));

  const agentSelect = document.createElement("select");
  agentSelect.className = "schedule-agent-select";
  const assistantOption = document.createElement("option");
  assistantOption.value = "assistant";
  assistantOption.textContent = "项目助理";
  agentSelect.appendChild(assistantOption);
  agentSelect.value = existing?.llm?.agent && existing.llm.agent !== "assistant" ? String(existing.llm.agent) : "assistant";
  llmWrap.appendChild(agentSelect);
  fetch(`/api/agents?project=${encodeURIComponent(project)}`)
    .then((response) => (response.ok ? response.json() : { agents: [] }))
    .then((data) => {
      for (const agent of data.agents ?? []) {
        const option = document.createElement("option");
        option.value = `agent:${agent.name}`;
        option.textContent = `${agent.name}（项目子 Agent）`;
        agentSelect.appendChild(option);
      }
      agentSelect.value = existing?.llm?.agent && existing.llm.agent !== "assistant" ? String(existing.llm.agent) : "assistant";
    })
    .catch(() => {});

  const sessionMode = document.createElement("select");
  for (const [value, label] of [["ephemeral", "每次新建会话（推荐）"], ["persistent", "沿用该角色的持久会话"]]) {
    const option = document.createElement("option");
    option.value = value;
    option.textContent = label;
    sessionMode.appendChild(option);
  }
  sessionMode.value = existing?.llm?.session ?? (existing?.sessionMode === "assistant" ? "persistent" : "ephemeral");
  llmWrap.appendChild(formRow("会话方式", sessionMode));

  const onCommandFailure = document.createElement("select");
  for (const [value, label] of [["run", "继续交给模型处理"], ["skip", "跳过 LLM 段"]]) {
    const option = document.createElement("option");
    option.value = value;
    option.textContent = label;
    onCommandFailure.appendChild(option);
  }
  onCommandFailure.value = existing?.llm?.onCommandFailure ?? "run";
  llmWrap.appendChild(formRow("命令失败时", onCommandFailure));

  llmWrap.appendChild(el("div", "form-label", "提示词（可用 {{stdout}} / {{exitCode}} / {{logPath}} / {{durationMs}} 引用命令结果）"));
  const prompt = document.createElement("textarea");
  prompt.className = "cfg-textarea schedule-prompt-input";
  prompt.rows = 7;
  prompt.value = existing?.llm?.prompt ?? existing?.prompt ?? "请检查当前项目的状态，完成需要处理的工作，并汇报结果。";
  llmWrap.appendChild(prompt);
  llmWrap.appendChild(el("div", "muted", "模型可以派发当前项目中已启用的子 Agent；结果写入运行日志，需要回流主会话时可在任务里配置 reportTo。"));
  modal.appendChild(llmWrap);

  const logRetention = document.createElement("input");
  logRetention.type = "number";
  logRetention.min = "0";
  logRetention.max = "365";
  logRetention.value = String(existing?.log?.retentionDays ?? 7);
  modal.appendChild(formRow("日志保留（天）", logRetention));

  const updateKindVisibility = () => {
    const kind = kindSelect.value;
    const help = kindSelect.selectedOptions[0]?.dataset.help ?? "";
    kindHelp.textContent = help;
    commandWrap.style.display = kind === "llm" ? "none" : "";
    llmWrap.style.display = kind === "command" ? "none" : "";
  };
  kindSelect.onchange = updateKindVisibility;
  updateKindVisibility();

  const readExecution = () => {
    const kind = kindSelect.value;
    const command = kind === "llm"
      ? null
      : {
          run: commandText.value.trim(),
          timeoutSec: Number(timeout.value) || 900,
          concurrency: concurrency.value,
        };
    let llm = null;
    if (kind !== "command") {
      llm = {
        prompt: prompt.value.trim(),
        agent: agentSelect.value,
        session: sessionMode.value,
        onCommandFailure: onCommandFailure.value,
        reportTo: existing?.llm?.reportTo ?? "none",
      };
    }
    return { command, llm };
  };
  const enabledWrap = el("label", "checkbox-item schedule-enabled");
  const enabled = document.createElement("input");
  enabled.type = "checkbox";
  enabled.checked = existing?.enabled !== false;
  enabledWrap.append(enabled, el("span", "", "启用这个定时任务"));
  modal.appendChild(enabledWrap);

  const status = el("div", "form-status");
  modal.appendChild(status);

  const actions = el("div", "form-actions");
  if (existing) {
    const remove = el("button", "btn-danger", "删除");
    remove.onclick = async () => {
      if (!confirm(`确认删除定时任务“${existing.name}”？`)) return;
      const response = await fetch("/api/schedules/delete", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ project, id: existing.id }) });
      if (!response.ok) return status.textContent = `❌ ${(await response.json()).error}`;
      overlay.remove();
      selected = { type: "project", project };
      expandedProjectSchedules.add(project);
      await reloadSchedules(project);
      render();
    };
    actions.appendChild(remove);
  }
  const cancel = el("button", "btn-secondary", "取消");
  cancel.onclick = () => overlay.remove();
  const save = el("button", "btn-primary", "保存");
  save.onclick = async () => {
    save.disabled = true;
    status.className = "form-status";
    status.textContent = "正在保存…";
    const response = await fetch("/api/schedules", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        project,
        id: existing?.id,
        name: name.value,
        rule: readRule(),
        timezone: timezone.value,
        enabled: enabled.checked,
        ...readExecution(),
        log: { retentionDays: Number(logRetention.value) || 0 },
      }),
    });
    const result = await response.json();
    save.disabled = false;
    if (!response.ok) {
      status.className = "form-status err";
      status.textContent = `❌ ${result.error || "保存失败"}`;
      return;
    }
    overlay.remove();
    selected = { type: "project", project, scheduleId: result.schedule.id };
    expandedProjectSchedules.add(project);
    await reloadSchedules(project);
    render();
  };
  actions.append(cancel, save);
  modal.appendChild(actions);
  overlay.appendChild(modal);
  overlay.onclick = (event) => { if (event.target === overlay) overlay.remove(); };
  document.body.appendChild(overlay);
  name.focus();
}

function renderProjectForm(view) {
  const oldName = selected.project;
  if (!state.projects.includes(oldName)) {
    view.textContent = "（项目已不存在）";
    return;
  }
  const head = el("div", "view-head");
  head.appendChild(el("span", "view-title", `📁 项目设置 · ${oldName}`));
  view.appendChild(head);

  const form = el("div", "view-form");
  const nameInput = document.createElement("input");
  nameInput.type = "text";
  nameInput.value = oldName;
  nameInput.placeholder = "项目名（字母/数字/-/_）";
  form.appendChild(formRow("项目名称", nameInput));
  form.appendChild(el("div", "muted", "保存后会同时重命名工作区目录，并更新该项目所有会话的工作目录。"));

  const status = el("div", "form-status", "");
  const save = el("button", "btn-primary", "保存项目名称");
  save.onclick = async () => {
    const newName = nameInput.value.trim();
    if (!newName) {
      status.className = "form-status err";
      status.textContent = "❌ 项目名称不能为空";
      return;
    }
    save.disabled = true;
    status.className = "form-status";
    status.textContent = "正在重命名…";
    const response = await fetch("/api/projects/rename", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ oldName, newName }),
    });
    const data = await response.json();
    save.disabled = false;
    if (!response.ok) {
      status.className = "form-status err";
      status.textContent = `❌ ${data.error || "重命名失败"}`;
      return;
    }
    // agents-* 标记已废弃（子 Agent 始终展开），仅迁移项目本身。
    expandedProjects.delete(oldName);
    expandedProjects.delete(`agents-${oldName}`);
    expandedProjects.add(newName);
    saveExpandedProjects();
    selected = { type: "project", project: newName };
    await refresh();
  };
  const bar = el("div", "form-actions");
  bar.appendChild(save);
  const remove = el("button", "btn-danger", "删除项目");
  remove.type = "button";
  remove.onclick = () => openProjectDeleteDialog(oldName);
  bar.appendChild(remove);
  bar.appendChild(status);
  form.appendChild(bar);

  const scheduleSection = el("details", "project-schedules");
  scheduleSection.open = expandedProjectSchedules.has(oldName);
  scheduleSection.ontoggle = () => {
    if (scheduleSection.open) expandedProjectSchedules.add(oldName);
    else expandedProjectSchedules.delete(oldName);
  };
  const summary = el("summary", "project-schedules-summary");
  const summaryTitle = el("span", "project-schedules-title", "定时任务");
  const count = el("span", "project-schedules-count", String((schedulesCache[oldName] ?? []).length));
  const addSchedule = el("button", "btn-primary project-schedules-add", "＋ 新建定时任务");
  addSchedule.type = "button";
  addSchedule.onclick = (event) => {
    event.preventDefault();
    event.stopPropagation();
    expandedProjectSchedules.add(oldName);
    scheduleSection.open = true;
    openScheduleEditor(oldName);
  };
  summary.append(summaryTitle, count, addSchedule);
  scheduleSection.appendChild(summary);
  scheduleSection.appendChild(el("div", "muted schedule-intro", "任务分三类：只执行命令（不调用模型）、只调用模型、先执行命令再把输出交给模型。运行日志与退出码可在卡片上的「日志」里查看。"));
  const scheduleList = el("div", "schedule-list project-schedule-list");
  fillScheduleList(scheduleList, oldName, schedulesCache[oldName] ?? []);
  scheduleSection.appendChild(scheduleList);
  form.appendChild(scheduleSection);
  view.appendChild(form);

  reloadSchedules(oldName).then((data) => {
    if (selected?.type !== "project" || selected.project !== oldName || !scheduleList.isConnected) return;
    count.textContent = String(data.schedules.length);
    fillScheduleList(scheduleList, oldName, data.schedules);
  }).catch((error) => {
    if (!scheduleList.isConnected) return;
    scheduleList.replaceChildren(el("div", "form-status err", `❌ ${error.message}`));
  });
}

function openProjectDeleteDialog(project) {
  const overlay = el("div", "drawer-submodal-backdrop");
  const modal = el("div", "drawer-submodal project-delete-modal");
  modal.setAttribute("role", "dialog");
  modal.setAttribute("aria-modal", "true");
  modal.appendChild(el("h3", "", `删除项目 · ${project}`));
  modal.appendChild(el("div", "delete-warning", "项目将从列表移除，项目目录会移动到 .pi-box-trash，之后仍可由管理员恢复。"));
  modal.appendChild(el("div", "muted", `请输入项目名称“${project}”确认删除：`));
  const input = document.createElement("input");
  input.className = "confirm-name-input";
  input.placeholder = project;
  modal.appendChild(input);
  const status = el("div", "form-status");
  modal.appendChild(status);
  const actions = el("div", "form-actions");
  const cancel = el("button", "btn-secondary", "取消");
  cancel.onclick = () => overlay.remove();
  const confirmDelete = el("button", "btn-danger", "确认删除项目");
  confirmDelete.disabled = true;
  input.oninput = () => { confirmDelete.disabled = input.value !== project; };
  confirmDelete.onclick = async () => {
    confirmDelete.disabled = true;
    status.textContent = "正在删除…";
    const response = await fetch("/api/projects/delete", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: project, confirmation: input.value }),
    });
    const result = await response.json();
    if (!response.ok) {
      status.className = "form-status err";
      status.textContent = `❌ ${result.error || "删除失败"}`;
      confirmDelete.disabled = false;
      return;
    }
    overlay.remove();
    expandedProjects.delete(project);
    saveExpandedProjects();
    selected = null;
    await refresh();
  };
  actions.append(cancel, confirmDelete);
  modal.appendChild(actions);
  overlay.appendChild(modal);
  overlay.onclick = (event) => { if (event.target === overlay) overlay.remove(); };
  document.body.appendChild(overlay);
  input.focus();
}

function messageText(msg) {
  if (!msg) return "";
  if (msg.errorMessage) return `❌ ${msg.errorMessage}`;
  const c = msg.content;
  if (typeof c === "string") return c;
  if (c === undefined || c === null || (Array.isArray(c) && c.length === 0)) {
    if (msg.stopReason && !["endTurn", "stop", "toolUse"].includes(msg.stopReason)) return `[${msg.stopReason}]`;
    return "";
  }
  if (Array.isArray(c)) {
    return c
      .map((p) => {
        if (p == null) return "";
        if (p.type === "text") return p.text ?? "";
        if (p.type === "thinking") return `[thinking] ${p.thinking ?? ""}`.slice(0, 500);
        if (p.type === "toolCall") return `🛠 ${p.name}(${JSON.stringify(p.arguments ?? {})})`;
        if (p.type === "toolResult") return `[result] ${JSON.stringify(p.content ?? p).slice(0, 500)}`;
        return `[${p.type}]`;
      })
      .join("\n");
  }
  return String(c);
}

function appendInlineMarkdown(parent, source) {
  const pattern = /(`[^`]+`|\*\*[^*]+\*\*|__[^_]+__|\*[^*]+\*|_([^_]+)_|\[[^\]]+\]\([^)]+\))/g;
  let cursor = 0;
  for (const match of source.matchAll(pattern)) {
    parent.appendChild(document.createTextNode(source.slice(cursor, match.index)));
    const token = match[0];
    if (token.startsWith("`")) parent.appendChild(el("code", "", token.slice(1, -1)));
    else if (token.startsWith("**") || token.startsWith("__")) parent.appendChild(el("strong", "", token.slice(2, -2)));
    else if (token.startsWith("[") && token.includes("](")) {
      const parts = /^\[([^\]]+)\]\(([^)]+)\)$/.exec(token);
      const link = el("a", "", parts?.[1] ?? token);
      const href = parts?.[2] ?? "";
      if (/^https?:\/\//i.test(href)) {
        link.href = href;
        link.target = "_blank";
        link.rel = "noopener noreferrer";
      }
      parent.appendChild(link);
    } else parent.appendChild(el("em", "", token.slice(1, -1)));
    cursor = (match.index ?? 0) + token.length;
  }
  parent.appendChild(document.createTextNode(source.slice(cursor)));
}

/** 构建 Markdown DOM（不包含缓存逻辑）。 */
function buildMarkdownBlock(text) {
  const root = el("div", "markdown-body");
  const lines = String(text ?? "").replace(/\r\n/g, "\n").split("\n");
  let index = 0;
  while (index < lines.length) {
    const line = lines[index];
    if (!line.trim()) { index += 1; continue; }
    if (line.startsWith("```")) {
      const language = line.slice(3).trim();
      const code = [];
      index += 1;
      while (index < lines.length && !lines[index].startsWith("```")) code.push(lines[index++]);
      if (index < lines.length) index += 1;
      const pre = el("pre", "");
      const codeNode = el("code", language ? `language-${language}` : "", code.join("\n"));
      pre.appendChild(codeNode); root.appendChild(pre); continue;
    }
    const heading = /^(#{1,6})\s+(.+)$/.exec(line);
    if (heading) {
      const node = document.createElement(`h${heading[1].length}`);
      appendInlineMarkdown(node, heading[2]); root.appendChild(node); index += 1; continue;
    }
    if (/^\s*([-*_])(?:\s*\1){2,}\s*$/.test(line)) { root.appendChild(document.createElement("hr")); index += 1; continue; }
    if (line.includes("|") && index + 1 < lines.length && /^\s*\|?\s*:?-{3,}/.test(lines[index + 1])) {
      const rows = [];
      const splitRow = (value) => value.trim().replace(/^\||\|$/g, "").split("|").map((cell) => cell.trim());
      rows.push(splitRow(line)); index += 2;
      while (index < lines.length && lines[index].includes("|") && lines[index].trim()) rows.push(splitRow(lines[index++]));
      const table = document.createElement("table");
      rows.forEach((cells, rowIndex) => {
        const tr = document.createElement("tr");
        cells.forEach((cell) => { const node = document.createElement(rowIndex === 0 ? "th" : "td"); appendInlineMarkdown(node, cell); tr.appendChild(node); });
        (rowIndex === 0 ? table.createTHead() : table.tBodies[0] ?? table.createTBody()).appendChild(tr);
      });
      root.appendChild(table); continue;
    }
    const listMatch = /^\s*([-*+] |\d+\. )(.+)$/.exec(line);
    if (listMatch) {
      const ordered = /\d/.test(listMatch[1][0]);
      const list = document.createElement(ordered ? "ol" : "ul");
      while (index < lines.length) {
        const item = /^\s*([-*+] |\d+\. )(.+)$/.exec(lines[index]);
        if (!item || /\d/.test(item[1][0]) !== ordered) break;
        const li = document.createElement("li"); appendInlineMarkdown(li, item[2]); list.appendChild(li); index += 1;
      }
      root.appendChild(list); continue;
    }
    if (line.startsWith(">")) {
      const quote = [];
      while (index < lines.length && lines[index].startsWith(">")) quote.push(lines[index++].replace(/^>\s?/, ""));
      const node = document.createElement("blockquote"); appendInlineMarkdown(node, quote.join("\n")); root.appendChild(node); continue;
    }
    const paragraph = [line]; index += 1;
    while (index < lines.length && lines[index].trim() && !/^(#{1,6})\s|^```|^\s*([-*+] |\d+\. )|^>/.test(lines[index])) paragraph.push(lines[index++]);
    const node = document.createElement("p"); appendInlineMarkdown(node, paragraph.join("\n")); root.appendChild(node);
  }
  return root;
}

/**
 * Markdown 渲染带缓存（P1-2）。
 * 相同文本的段落反复出现（Agent 重述、模板回复），重复解析纯浪费 CPU。
 * 缓存存的是 DOM 模板，每次用 cloneNode 复制，避免调用方改动影响缓存。
 */
function markdownBlock(text) {
  const key = String(text ?? "");
  const cached = markdownCache.get(key);
  if (cached !== undefined) {
    // LRU：命中后移到队尾。
    markdownCache.delete(key);
    markdownCache.set(key, cached);
    return cached.cloneNode(true);
  }
  const root = buildMarkdownBlock(key);
  // 超长文本不入缓存，避免单条消息把内存吃满。
  if (key.length <= MARKDOWN_CACHE_MAX_CHARS) {
    markdownCache.set(key, root);
    while (markdownCache.size > MARKDOWN_CACHE_MAX_ENTRIES) {
      const oldest = markdownCache.keys().next().value;
      if (oldest === undefined) break;
      markdownCache.delete(oldest);
    }
  }
  return root.cloneNode(true);
}

function messageRoleLabel(msg, entry) {
  if (msg.role === "toolResult") return `工具结果${msg.toolName ? ` · ${msg.toolName}` : ""}`;
  if (msg.role === "assistant") {
    const call = Array.isArray(msg.content) && msg.content.find((part) => part?.type === "toolCall");
    if (call) return `工具调用 · ${call.name}`;
    const thinking = Array.isArray(msg.content) && msg.content.some((part) => part?.type === "thinking");
    return thinking ? "思考与阶段回复" : "阶段回复";
  }
  if (msg.role === "user" && String(entry.kind).startsWith("pibox.")) return "子 Agent 回传";
  return entry.kind;
}

function isFinalAssistant(msg) {
  return msg.role === "assistant" && ["stop", "endTurn"].includes(msg.stopReason) && assistantText(msg).trim();
}

function assistantText(msg) {
  if (typeof msg?.content === "string") return msg.content;
  if (!Array.isArray(msg?.content)) return messageText(msg);
  return msg.content.filter((part) => part?.type === "text").map((part) => part.text ?? "").join("\n");
}

function conversationTurns(entries) {
  const turns = [];
  let current = null;
  for (const entry of entries) {
    const messages = entry.model ?? [];
    const userMessages = messages.filter((msg) => msg.role === "user");
    const synthetic = userMessages.length > 0 && userMessages.every((msg) => /^\[子 agent .+ 回复\]/.test(messageText(msg).trim()));
    if (userMessages.length > 0 && !synthetic) {
      current = { users: userMessages, items: [], entryId: String(entry.id) };
      turns.push(current);
    }
    if (!current) {
      current = { users: [], items: [], entryId: String(entry.id) };
      turns.push(current);
    }
    for (const msg of messages) {
      if (userMessages.includes(msg) && !synthetic) continue;
      if (msg.role === "system" || !messageText(msg).trim()) continue;
      current.items.push({ entry, msg });
    }
  }
  return turns;
}

/**
 * 计算 turn 的身份与内容指纹，用于增量渲染时判断是否可以复用已有 DOM。
 * key  : 该 turn 首个 entry 的 id（entry 是 append-only，id 不变即前缀不变）。
 * count: 条目数（条目被增删时立刻失配）。
 * sig : 内容指纹（消息条数 + 每条消息长度 + stopReason）。
 */
function turnIdentity(turn) {
  let sig = `${turn.users.length}/${turn.items.length}`;
  for (const msg of turn.users) sig += `|u${messageText(msg).length}`;
  for (const { entry, msg } of turn.items) {
    sig += `|${entry.id}:${msg.role}:${messageText(msg).length}:${msg.stopReason ?? ""}`;
  }
  return { key: turn.entryId ?? "", count: turn.items.length, sig };
}

function renderConversationTurn(turn) {
  const fragment = document.createDocumentFragment();
  for (const msg of turn.users) {
    const wrap = el("div", "conversation-user-wrap");
    const bubble = el("div", "conversation-user");
    bubble.appendChild(markdownBlock(messageText(msg)));
    wrap.appendChild(bubble);
    const timestamp = formatMessageTime(msg.timestamp);
    if (timestamp) wrap.appendChild(el("div", "conversation-message-time conversation-message-time-user", timestamp));
    fragment.appendChild(wrap);
  }
  if (turn.items.length === 0) return fragment;
  let finalIndex = -1;
  turn.items.forEach(({ msg }, index) => { if (isFinalAssistant(msg)) finalIndex = index; });
  const processItems = turn.items.flatMap((item, index) => {
    if (index !== finalIndex) return [item];
    const thinking = Array.isArray(item.msg.content) ? item.msg.content.filter((part) => part?.type === "thinking") : [];
    return thinking.length > 0 ? [{ entry: item.entry, msg: { ...item.msg, content: thinking, stopReason: "toolUse" } }] : [];
  });
  const responseWrap = el("div", "agent-response-wrap");
  const group = el("section", `agent-response${finalIndex < 0 ? " agent-response-running" : ""}`);
  const groupTitle = el("div", "agent-response-title", finalIndex < 0 ? "Agent 正在处理…" : "Agent 回复");
  group.appendChild(groupTitle);
  if (processItems.length > 0) {
    const process = el("details", "agent-process");
    process.open = finalIndex < 0;
    const summary = el("summary", "agent-process-summary", `处理过程 · ${processItems.length} 个步骤`);
    process.appendChild(summary);
    const list = el("div", "agent-process-list");
    processItems.forEach(({ entry, msg }) => {
      const step = el("details", `agent-step agent-step-${msg.role}`);
      step.appendChild(el("summary", "agent-step-summary", messageRoleLabel(msg, entry)));
      const content = el("div", "agent-step-content");
      content.appendChild(markdownBlock(messageText(msg)));
      step.appendChild(content); list.appendChild(step);
    });
    process.appendChild(list); group.appendChild(process);
  }
  if (finalIndex >= 0) {
    const final = el("div", "agent-final");
    final.appendChild(markdownBlock(assistantText(turn.items[finalIndex].msg)));
    group.appendChild(final);
  }
  responseWrap.appendChild(group);
  const latestMessage = finalIndex >= 0 ? turn.items[finalIndex].msg : turn.items.at(-1)?.msg;
  const timestamp = formatMessageTime(latestMessage?.timestamp);
  if (timestamp) responseWrap.appendChild(el("div", "conversation-message-time conversation-message-time-agent", timestamp));
  fragment.appendChild(responseWrap);
  return fragment;
}

/**
 * 构建/增量更新会话正文（P0-3）。
 * 返回 { body, rebuilt }：rebuilt=true 表示整体重建，需要恢复滚动位置；
 * rebuilt=false 表示在已有 DOM 上做了增量 patch，滚动位置天然保持。
 */
function renderConversationBody(convKey, detail) {
  const turns = conversationTurns(detail.entries ?? []);
  const view = document.getElementById("view");
  const mounted = view.querySelector(".view-body");
  const cache = conversationRenderCache.get(convKey);

  // 首次渲染 / 切换会话：整体重建。
  if (!cache || mounted !== cache.body || mounted.dataset.convId !== convKey) {
    const body = el("div", "view-body");
    body.dataset.convId = convKey;
    const rendered = [];
    for (const turn of turns) {
      const id = turnIdentity(turn);
      const node = renderConversationTurn(turn);
      // 必须在 appendChild 之前取 childNodes：fragment 被追加后就被清空了。
      const nodes = [...node.childNodes];
      body.appendChild(node);
      rendered.push({ key: id.key, count: id.count, sig: id.sig, nodes });
    }
    conversationRenderCache.set(convKey, { body, turns: rendered });
    pruneConversationRenderCache(convKey);
    return { body, rebuilt: true };
  }

  const { body, turns: cached } = cache;
  // 前缀失配（entry 变化 / 条目减少）→ 整体重建。
  let mismatch = cached.length > turns.length;
  if (!mismatch) {
    for (let i = 0; i < cached.length; i++) {
      // entry id 变了说明结构变了，必须整体重建。
      if (cached[i].key !== turns[i].entryId) {
        mismatch = true;
        break;
      }
      // 条目数变化只允许出现在最后一个 turn：entry 是 append-only，
      // 已完成的历史 turn 不会变；正在写入的最后一个 turn 变了走下面的指纹替换。
      if (i < cached.length - 1 && cached[i].count !== turns[i].items.length) {
        mismatch = true;
        break;
      }
    }
  }
  if (mismatch) {
    body.replaceChildren();
    cached.length = 0;
    for (const turn of turns) {
      const id = turnIdentity(turn);
      const node = renderConversationTurn(turn);
      const nodes = [...node.childNodes];
      body.appendChild(node);
      cached.push({ key: id.key, count: id.count, sig: id.sig, nodes });
    }
    return { body, rebuilt: true };
  }

  // entry 是 append-only，已完成的 turn 不会变，只有最后一个 turn 仍在写入，
  // 因此只需比对最后一个已缓存 turn 的内容指纹。
  const cachedLast = cached.length - 1;
  if (cachedLast >= 0) {
    const id = turnIdentity(turns[cachedLast]);
    if (cached[cachedLast].sig !== id.sig) {
      // 一个 turn 可能产出多个兄弟节点（用户气泡 + 回复区），
      // replaceChild 不能直接传 DocumentFragment，否则会错位。
      const oldNodes = cached[cachedLast].nodes;
      const fragment = renderConversationTurn(turns[cachedLast]);
      const newNodes = [...fragment.childNodes];
      const parent = oldNodes[0]?.parentNode;
      if (parent) {
        const anchor = oldNodes[0];
        for (const node of newNodes) parent.insertBefore(node, anchor);
        for (const node of oldNodes) node.remove();
      }
      cached[cachedLast].nodes = newNodes;
      cached[cachedLast].sig = id.sig;
    }
  }
  // 追加新增的 turn。
  for (let i = cached.length; i < turns.length; i++) {
    const id = turnIdentity(turns[i]);
    const node = renderConversationTurn(turns[i]);
    const nodes = [...node.childNodes];
    body.appendChild(node);
    cached.push({ key: id.key, count: id.count, sig: id.sig, nodes });
  }
  return { body, rebuilt: false };
}

/** 会话渲染缓存只保留最近打开的若干个会话，避免长时间使用后内存无限增长。 */
function pruneConversationRenderCache(currentKey) {
  const limit = 12;
  if (conversationRenderCache.size <= limit) return;
  for (const [key, value] of [...conversationRenderCache]) {
    if (conversationRenderCache.size <= limit) break;
    if (key === currentKey) continue;
    if (value.body.parentElement) continue; // 仍在视图里，不能回收
    conversationRenderCache.delete(key);
  }
}

function renderConversation(view) {
  const conv = state.conversations.find((c) => c.id === selected.id);
  if (!conv) {
    // 会话已被删除：清掉对应的渲染/详情缓存，避免陈旧数据占内存。
    const key = String(selected.id);
    conversationRenderCache.delete(key);
    detailRefreshState.delete(key);
    view.textContent = "（会话已不存在）";
    return;
  }
  const isAgentView = conv.actorType === "agent";
  const displayTitle = conversationDisplayTitle(conv);
  const title = isAgentView
    ? `🤖 子 Agent · ${displayTitle}（#${conv.id}）`
    : `🤖 ${displayTitle}（#${conv.id}）`;
  const sub = `${conv.project} · ${sessionSourceLabel(conv)}`;
  // 输入框若已挂在视图里，新内容插到它前面，避免 append 移动节点导致失焦。
  const cachedComposer = composerCache.get(String(conv.id));
  const anchor = cachedComposer && cachedComposer.form.parentElement === view ? cachedComposer.form : null;
  // 正文节点已经挂在视图里时，标题要插到正文之前，保持 head → body → composer 的顺序。
  const mountedBody = view.querySelector(".view-body");
  const mount = (node) => {
    if (mountedBody && mountedBody.parentElement === view) return view.insertBefore(node, mountedBody);
    if (anchor) return view.insertBefore(node, anchor);
    return view.appendChild(node);
  };
  const head = el("div", "view-head");
  const titleSpan = el("span", "view-title", title);
  const renameBtn = el("button", "view-rename", "✎");
  renameBtn.type = "button";
  renameBtn.title = "重命名会话";
  renameBtn.onclick = () => renameConversation(conv);
  titleSpan.appendChild(renameBtn);
  head.appendChild(titleSpan);
  head.appendChild(el("span", "view-sub", sub));
  const stopBtn = el("button", "btn-danger view-stop", "终止会话");
  stopBtn.type = "button";
  stopBtn.title = "终止当前会话正在进行的任务";
  stopBtn.disabled = !conversationBusy(conv);
  stopBtn.onclick = async () => {
    stopBtn.disabled = true;
    try {
      const res = await fetch("/api/abort", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ conversationId: conv.id }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        alert(data.error || "终止失败");
        stopBtn.disabled = false;
      }
      // 成功后保持禁用，SSE 会按新状态重渲染并刷新按钮。
    } catch (error) {
      alert(error.message);
      stopBtn.disabled = false;
    }
  };
  head.appendChild(stopBtn);
  mount(head);

  const detail = conversationDetailCache.get(String(conv.id));
  if (!detail) {
    mount(el("div", "conversation-loading", "正在加载会话记录…"));
    loadConversationDetail(conv.id).then(() => {
      if (selected?.type === "conversation" && selected.id === conv.id) renderView();
    }).catch((error) => {
      if (selected?.type === "conversation" && selected.id === conv.id) {
        const loading = view.querySelector?.(".conversation-loading");
        if (loading) loading.textContent = `加载失败：${error.message}`;
      }
    });
    return;
  }

  const { body, rebuilt } = renderConversationBody(String(conv.id), detail);
  // 增量路径下 body 已经在视图里，不要再挂载（摘下再挂回会丢滚动位置）。
  if (body.parentElement !== view) mount(body);
  // 用户已经往上翻时不要被后台推送拉回底部。
  if (rebuilt) body.scrollTop = viewScrollState.atBottom ? body.scrollHeight : viewScrollState.top;
  else if (viewScrollState.atBottom) body.scrollTop = body.scrollHeight;

  const composer = getComposer(String(conv.id), conv);
  // 已经在视图里就保持原位（不重新 append），否则挂到末尾。
  if (composer.form.parentElement !== view) view.appendChild(composer.form);
}

// 输入框按会话复用同一个 DOM 节点：切换会话 / SSE 刷新都不重建，
// 因此焦点、光标位置、输入法组合状态都不会丢，草稿另行按会话缓存。
// 发送按钮在会话处理中会切换为「发送（排队）+ 引导（插话）」组合。
function getComposer(convKey, conv) {
  let composer = composerCache.get(convKey);
  if (!composer) {
    const form = document.createElement("form");
    form.className = "view-input";
    const input = document.createElement("input");
    input.autocomplete = "off";
    const sendBtn = el("button", "", "发送");
    sendBtn.type = "submit";
    const steerBtn = el("button", "view-steer", "引导");
    steerBtn.type = "button";
    steerBtn.hidden = true;
    form.appendChild(input);
    form.appendChild(sendBtn);
    form.appendChild(steerBtn);

    const updateButtons = () => {
      const busy = conversationBusy(composer.conv);
      const hasContent = input.value.trim().length > 0;
      steerBtn.hidden = !(busy && hasContent);
      sendBtn.title = busy && hasContent ? "发送：当前回答结束后处理" : "发送";
      steerBtn.title = "引导：立即插话，让 Agent 据此调整当前回复";
    };

    input.addEventListener("input", () => {
      draftCache.set(convKey, input.value);
      updateButtons();
    });

    const send = async (whenBusy) => {
      const content = input.value.trim();
      if (!content) return;
      input.value = "";
      draftCache.delete(convKey);
      updateButtons();
      try {
        const res = await fetch("/api/send", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ conversationId: convKey, content, whenBusy }),
        });
        if (!res.ok) {
          const data = await res.json().catch(() => ({}));
          throw new Error(data.error || "发送失败");
        }
      } catch (error) {
        draftCache.set(convKey, content);
        if (input.isConnected) input.value = content;
        updateButtons();
        alert(error.message);
      }
    };

    form.onsubmit = (ev) => { ev.preventDefault(); send("followUp"); };
    steerBtn.onclick = () => send("steer");

    composer = { form, input, btn: sendBtn, steerBtn, updateButtons };
    composerCache.set(convKey, composer);
  }
  composer.conv = conv;
  composer.input.placeholder = conv.actorType === "agent"
    ? `和子 Agent ${conv.actorName || ""} 对话…`
    : "和项目助理对话…";
  composer.input.disabled = !state.hasKey;
  composer.btn.disabled = !state.hasKey;
  composer.steerBtn.disabled = !state.hasKey;
  const draft = draftCache.get(convKey) ?? "";
  // 仅在内容不一致时写回，避免打断正在进行的输入法组合输入。
  if (composer.input.value !== draft) composer.input.value = draft;
  composer.updateButtons();
  return composer;
}

function formRow(label, control) {
  const row = el("div", "form-row");
  row.appendChild(el("label", "", label));
  row.appendChild(control);
  return row;
}

async function openAssistantEditor(proj) {
  const asst = state.assistantByProject?.[proj] ?? { agents: [], instructions: "", model: null };
  const catalog = state.agentCatalogByProject?.[proj] ?? { project: [], global: [] };
  const mcpResponse = await fetch("/api/mcp");
  const mcpConfig = mcpResponse.ok ? await mcpResponse.json() : { mcpServers: {} };
  const mcpServers = Object.entries(mcpConfig.mcpServers ?? {});
  const overlay = el("div", "drawer-submodal-backdrop");
  const modal = el("div", "drawer-submodal agent-editor-modal");
  modal.setAttribute("role", "dialog");
  modal.setAttribute("aria-modal", "true");
  modal.appendChild(el("h3", "", `编辑项目助理 · ${proj}`));
  modal.appendChild(formRow("名称", el("div", "fixed-field", "助理（系统默认角色，不可修改）")));
  modal.appendChild(formRow("存放位置", el("div", "fixed-field", `项目专属（${proj}，不可移动或删除）`)));
  const modelSelect = document.createElement("select");
  populateAgentModelSelect(modelSelect, asst.model ?? "");
  modal.appendChild(formRow("模型", modelSelect));

  const selectedTools = new Set(asst.tools ?? state.availableTools ?? []);
  const enabledMcpNames = new Set(mcpServers.filter(([, config]) => config.enabled !== false).map(([name]) => name));
  const selectedMcps = new Set((asst.mcps ?? []).filter((name) => enabledMcpNames.has(name)));
  const skillLibrary = (await fetchSkillLibrary(proj)).skills ?? [];
  const selectedSkills = new Set(asst.skills ?? []);
  const linkage = skillReadLinkage(selectedSkills, selectedTools);
  linkage.sync(); // 已有 skill 引用时，把 read 补进将要提交的工具集，与界面展示保持一致
  const toolsGroup = appendAgentCheckboxGroup(modal, {
    title: "工具",
    description: "选择助理可以直接调用的内置工具；任务派发工具由系统固定启用。启用 skill 时必须保留 read。",
    choices: [
      { value: "subagent", label: "subagent（系统必需，不可关闭）", required: true },
      ...(state.availableTools ?? ["read", "write", "edit", "bash"]).map((tool) => ({ value: tool, label: tool })),
    ],
    selectedValues: selectedTools,
    disabledWhen: linkage.toolDisabled,
    checkedWhen: linkage.toolChecked,
  });
  appendAgentCheckboxGroup(modal, {
    title: "Skills",
    description: "从全局技能库启用；勾选后自动附带 read（Skill 正文由模型读取）。未勾选则不注入任何 skill。",
    choices: skillChoicesFor(skillLibrary, asst.skills ?? []),
    selectedValues: selectedSkills,
    onChange: () => { linkage.sync(); toolsGroup.refresh(); },
  });
  appendAgentCheckboxGroup(modal, {
    title: "MCP",
    description: "选择助理可以使用的 MCP 服务；已停用的服务不可选择。",
    choices: mcpServers.map(([name, config]) => ({ value: name, label: config.enabled === false ? `${name}（已停用）` : name, config })),
    selectedValues: selectedMcps,
    disabledWhen: (choice) => choice.config.enabled === false,
  });
  const selectedGlobals = new Set(asst.agents ?? []);
  appendAgentCheckboxGroup(modal, {
    title: "可派发的子 Agent",
    description: "项目 Agent 创建后始终启用；全局 Agent 可按需授权给当前助理。",
    choices: [
      ...catalog.project.map((agent) => ({ value: `project:${agent.name}`, label: `${agent.name}（项目内置，不可关闭）`, required: true })),
      ...catalog.global.map((agent) => ({ value: agent.name, label: `${agent.name}（全局）` })),
    ],
    selectedValues: selectedGlobals,
    disabledWhen: (choice) => choice.required === true,
    checkedWhen: (choice) => choice.required === true || selectedGlobals.has(choice.value),
  });
  modal.appendChild(el("div", "form-label", "提示词（instructions）"));
  const instructions = document.createElement("textarea");
  instructions.className = "cfg-textarea";
  instructions.rows = 8;
  instructions.value = asst.instructions || `你是项目「${proj}」的助理。理解用户意图，必要时将任务派发给合适的子 Agent，并汇总结果。`;
  modal.appendChild(instructions);
  const status = el("div", "form-status", "");
  modal.appendChild(status);
  const actions = el("div", "form-actions");
  const cancel = el("button", "btn-secondary", "取消");
  cancel.type = "button";
  const save = el("button", "btn-primary", "保存");
  save.type = "button";
  actions.appendChild(cancel);
  actions.appendChild(save);
  modal.appendChild(actions);
  overlay.appendChild(modal);
  document.body.appendChild(overlay);
  const close = () => overlay.remove();
  cancel.onclick = close;
  overlay.onclick = (event) => { if (event.target === overlay) close(); };
  save.onclick = async () => {
    const prompt = instructions.value.trim();
    if (!prompt) {
      status.className = "form-status err";
      status.textContent = "❌ 提示词不能为空";
      return;
    }
    save.disabled = true;
    const res = await fetch("/api/assistant", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        project: proj,
        model: modelSelect.value || null,
        tools: [...selectedTools],
        mcps: [...selectedMcps],
        skills: [...selectedSkills],
        agents: [...selectedGlobals],
        instructions: prompt,
      }),
    });
    save.disabled = false;
    if (!res.ok) {
      status.className = "form-status err";
      status.textContent = `❌ ${(await res.json()).error || "保存失败"}`;
      return;
    }
    close();
    await refresh();
  };
}

async function populateAgentModelSelect(select, selectedValue) {
  select.innerHTML = "";
  const loading = document.createElement("option");
  loading.textContent = "正在加载模型…";
  loading.value = selectedValue || "";
  select.appendChild(loading);
  select.disabled = true;
  try {
    const settings = await (await fetch("/api/settings")).json();
    const providersData = await (await fetch("/api/providers")).json();
    const metaById = Object.fromEntries((providersData.providers ?? []).map((p) => [p.id, p]));
    select.innerHTML = "";
    const inherit = document.createElement("option");
    inherit.value = "";
    const fallbackLabel = settings.currentModel
      ? `${settings.currentModel.provider}/${settings.currentModel.modelId}`
      : "（未配置）";
    inherit.textContent = `跟随全局模型（${fallbackLabel}）`;
    select.appendChild(inherit);
    const groups = Object.entries(settings.providers ?? {}).filter(([, v]) => v.hasKey);
    if (groups.length === 0) {
      const empty = document.createElement("option");
      empty.value = "";
      empty.textContent = "（尚未配置任何厂商，请先在 ⚙ 设置 → 模型中配置）";
      empty.disabled = true;
      select.appendChild(empty);
    }
    for (const [provider, saved] of groups) {
      const name = metaById[provider]?.name ?? provider;
      const models = Array.isArray(saved.models) && saved.models.length > 0 ? saved.models : [];
      for (const modelId of models) {
        const option = document.createElement("option");
        option.value = `${provider}/${modelId}`;
        option.textContent = `${name} / ${modelId}`;
        select.appendChild(option);
      }
    }
    // 保留当前已保存但可能不再在列表里的值（例如厂商被删或模型被移出）
    if (selectedValue && ![...select.options].some((o) => o.value === selectedValue)) {
      const keep = document.createElement("option");
      keep.value = selectedValue;
      keep.textContent = selectedValue;
      select.appendChild(keep);
    }
    select.value = selectedValue || "";
  } catch {
    loading.textContent = selectedValue || "模型列表加载失败";
  } finally {
    select.disabled = false;
  }
}

// ─── 第四栏：当前会话任务图 ──────────────────────────────────────────────────
function renderTaskGraph() {
  const allTasks = Object.values(state?.taskGraph?.tasks ?? {});
  const elx = document.getElementById("task-graph");
  elx.className = "scroll";
  elx.innerHTML = "";
  if (selected?.type !== "conversation") {
    elx.textContent = "（请选择一个会话）";
    return;
  }
  const conversationIds = new Set([String(selected.id)]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const conversation of state?.conversations ?? []) {
      if (conversation.parentConversationId && conversationIds.has(String(conversation.parentConversationId)) && !conversationIds.has(conversation.id)) {
        conversationIds.add(conversation.id);
        changed = true;
      }
    }
    for (const task of allTasks) {
      if (!conversationIds.has(String(task.conversationId))) continue;
      for (const childConversationId of task.conversations ?? []) {
        if (!conversationIds.has(String(childConversationId))) {
          conversationIds.add(String(childConversationId));
          changed = true;
        }
      }
    }
  }
  const tasks = allTasks.filter((task) => conversationIds.has(String(task.conversationId)));
  const taskIds = new Set(tasks.map((task) => String(task.id)));
  const renderNode = (node, depth) => {
    const div = el("div", "task-node");
    div.style.paddingLeft = depth * 16 + 8 + "px";
    const st = node.state;
    const status = st.status === "waiting" ? `waiting on ${st.on.join(",")}` : st.status;
    div.innerHTML = `<span class="task-kind">${node.kind}</span> #${node.id} <span class="task-status">[${status}${node.background ? " · bg" : ""}]</span>`;
    elx.appendChild(div);
    for (const child of tasks.filter((t) => String(t.owner) === String(node.id))) renderNode(child, depth + 1);
  };
  for (const node of tasks.filter((t) => t.owner === undefined || t.owner === null || !taskIds.has(String(t.owner)))) renderNode(node, 0);
  if (tasks.length === 0) elx.textContent = "（当前会话没有运行中任务）";
}

// ─── 交互 ───────────────────────────────────────────────────────────────────
document.getElementById("new-project").onclick = async () => {
  const name = prompt("项目名称（字母 / 数字 / - / _）：");
  if (!name) return;
  const res = await fetch("/api/projects", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name }),
  });
  const data = await res.json();
  if (!res.ok) {
    alert(data.error || "创建失败");
    return;
  }
  expandedProjects.add(name);
  saveExpandedProjects();
  // 子 Agent 永远展开，无需 agents-${name} 标记。
  selected = { type: "conversation", project: name, id: String(data.conversationId) };
  setMobilePanel("view");
  refresh();
};

for (const button of document.querySelectorAll("[data-mobile-panel]")) {
  button.onclick = () => setMobilePanel(button.dataset.mobilePanel);
}
setMobilePanel(activeMobilePanel);

// 文件浏览：上传 / 预览刷新
const fileUploadBtn = document.getElementById("file-upload-btn");
const fileUploadInput = document.getElementById("file-upload-input");
if (fileUploadBtn && fileUploadInput) {
  fileUploadBtn.onclick = () => fileUploadInput.click();
  fileUploadInput.onchange = async () => {
    const files = [...fileUploadInput.files];
    fileUploadInput.value = "";
    if (files.length > 0) await uploadFiles(files);
  };
}
const fileRefreshBtn = document.getElementById("file-refresh-btn");
if (fileRefreshBtn) {
  fileRefreshBtn.onclick = () => {
    if (!fileBrowser?.selected) return;
    openFilePreview(fileBrowser, fileBrowser.selected);
  };
}

// ─── 设置弹窗（模型）────────────────────────────────────────────────────────
function renderModelChips() {
  const box = document.getElementById("cfg-models-chips");
  box.innerHTML = "";
  if (cfgSelectedModels.length === 0) {
    box.appendChild(el("div", "muted", "（还没有配置模型；至少添加一个）"));
    return;
  }
  cfgSelectedModels.forEach((modelId, index) => {
    const chip = el("span", "cfg-chip");
    const label = el("span", "", index === 0 ? `${modelId}（默认）` : modelId);
    chip.appendChild(label);
    const rm = el("button", "cfg-chip-remove", "×");
    rm.type = "button";
    rm.title = "移除";
    rm.onclick = () => {
      cfgSelectedModels = cfgSelectedModels.filter((m) => m !== modelId);
      renderModelChips();
    };
    chip.appendChild(rm);
    box.appendChild(chip);
  });
}

function fillModelCatalog() {
  const sel = document.getElementById("cfg-model-select");
  sel.innerHTML = "";
  const available = cfgModelsCatalog.filter((m) => !cfgSelectedModels.includes(m));
  for (const m of available) {
    const o = document.createElement("option");
    o.value = m;
    o.textContent = m;
    sel.appendChild(o);
  }
}

function addModel(modelId) {
  const id = (modelId || "").trim();
  if (!id) return;
  if (!cfgSelectedModels.includes(id)) {
    cfgSelectedModels.push(id);
    renderModelChips();
    fillModelCatalog();
  }
}

function selectedProviderPayload() {
  const keyInput = document.getElementById("cfg-key");
  return {
    provider: cfgCurrentProvider,
    models: [...cfgSelectedModels],
    apiKey: keyInput.dataset.masked === "true" ? undefined : keyInput.value || undefined,
    baseUrl: document.getElementById("cfg-baseurl").value,
    setActive: document.getElementById("cfg-active").checked,
  };
}

function showStoredKey(key, hasKey) {
  key.dataset.hasStoredKey = hasKey ? "true" : "false";
  key.dataset.masked = hasKey ? "true" : "false";
  key.value = hasKey ? MASKED_API_KEY : "";
  key.placeholder = hasKey ? "已保存；输入新值可替换" : "填入你的 API Key";
}

// 左侧二级菜单：一个提供商一个 tab
function renderProviderNav() {
  const nav = document.getElementById("provider-tabs");
  nav.innerHTML = "";
  for (const pid of cfgProviderTabs) {
    const meta = cfgProviders.find((p) => p.id === pid);
    const saved = cfgSettings.providers?.[pid];
    const hasKey = !!saved?.hasKey;
    const isDefault = cfgSettings.activeProvider === pid
      || (cfgSettings.currentModel && cfgSettings.currentModel.provider === pid);
    const tab = el("button", "provider-tab" + (pid === cfgCurrentProvider ? " active" : ""));
    tab.type = "button";
    tab.appendChild(el("span", "provider-tab-name", meta?.name ?? pid));
    if (hasKey) tab.appendChild(el("span", "provider-tab-badge", "✓"));
    if (isDefault) tab.appendChild(el("span", "provider-tab-badge default", "默认"));
    tab.onclick = () => selectProvider(pid);
    nav.appendChild(tab);
  }
}

function selectProvider(pid) {
  cfgCurrentProvider = pid;
  renderProviderNav();
  loadProviderForm(pid);
}

function loadProviderForm(provider) {
  const meta = cfgProviders.find((p) => p.id === provider);
  const saved = cfgSettings.providers?.[provider] ?? {};
  if (!meta) return;
  document.getElementById("provider-form").classList.remove("hidden");
  document.getElementById("provider-empty").classList.add("hidden");
  document.getElementById("provider-form-title").textContent = meta.name;
  cfgSelectedModels = Array.isArray(saved.models) && saved.models.length > 0
    ? [...saved.models]
    : [meta.defaultModel || ""];
  renderModelChips();
  document.getElementById("cfg-baseurl").value = saved.baseUrl || meta.defaultBaseUrl || "";
  const key = document.getElementById("cfg-key");
  showStoredKey(key, saved.hasKey);
  document.getElementById("cfg-active").checked = provider === cfgSettings.activeProvider;
  const isDefault = cfgSettings.currentModel && cfgSettings.currentModel.provider === provider;
  document.getElementById("cfg-status").textContent = isDefault ? "当前默认" : "";
  cfgModelsCatalog = []; // 目录与 provider 相关，切换时清空
  fillModelCatalog();
}

async function openSettings() {
  await openSettingsModal("models");
}
function closeSettings() {
  document.getElementById("settings-modal").classList.add("hidden");
}
document.getElementById("open-settings").onclick = openSettings;
document.getElementById("close-settings").onclick = closeSettings;
document.getElementById("settings-modal").onclick = (ev) => {
  if (ev.target.id === "settings-modal") closeSettings();
};

// ─── 系统设置弹窗（两栏：左侧导航 + 右侧内容） ────────────────────────────────────────
let settingsLoadedTabs = new Set();

async function openSettingsModal(tab) {
  document.getElementById("settings-modal").classList.remove("hidden");
  await switchSettingsTab(tab);
  // 模型 Tab 预热数据
  if (cfgProviders.length === 0) {
    const d = await (await fetch("/api/providers")).json();
    cfgProviders = d.providers;
  }
  cfgSettings = await (await fetch("/api/settings")).json();
  // 左侧 tab = 已保存过的提供商；至少包含默认厂商
  cfgProviderTabs = Object.keys(cfgSettings.providers ?? {});
  if (!cfgProviderTabs.includes(cfgSettings.activeProvider)) cfgProviderTabs.push(cfgSettings.activeProvider);
  if (cfgProviderTabs.length === 0 && cfgProviders.length > 0) cfgProviderTabs.push(cfgProviders[0].id);
  cfgCurrentProvider = cfgSettings.activeProvider || cfgProviderTabs[0] || cfgProviders[0]?.id;
  renderProviderNav();
  selectProvider(cfgCurrentProvider);
}
document.addEventListener("keydown", (ev) => {
  if (ev.key === "Escape" && !document.getElementById("settings-modal").classList.contains("hidden")) closeSettings();
});

async function switchSettingsTab(tab) {
  for (const btn of document.querySelectorAll(".drawer-nav-item")) {
    btn.classList.toggle("active", btn.dataset.tab === tab);
  }
  for (const id of ["tab-models", "tab-agents", "tab-skills", "tab-mcp", "tab-cleanup", "tab-system"]) {
    document.getElementById(id).classList.toggle("hidden", id !== `tab-${tab}`);
  }
  if (tab === "models") return;
  const panel = document.getElementById(`tab-${tab}`);
  if (!settingsLoadedTabs.has(tab)) {
    settingsLoadedTabs.add(tab);
    if (tab === "agents") await renderDrawerAgents(panel);
    if (tab === "skills") await renderDrawerSkills(panel);
    if (tab === "mcp") await renderDrawerMcp(panel);
    if (tab === "cleanup") await renderDrawerCleanup(panel);
    if (tab === "system") await renderDrawerSystem(panel);
  }
}
for (const btn of document.querySelectorAll(".drawer-nav-item")) {
  btn.addEventListener("click", () => switchSettingsTab(btn.dataset.tab));
}

// ── 全局 Agents Tab ──
async function renderDrawerAgents(panel) {
  panel.innerHTML = `<div class="drawer-loading">加载中…</div>`;
  const [{ agents }, stateRes] = await Promise.all([
    fetch("/api/global-agents").then((r) => r.json()),
    fetch("/api/state").then((r) => r.json()),
  ]);
  const metaAgents = stateRes.metaAgents ?? [];
  const metaName = stateRes.metaProject ?? "meta";
  panel.innerHTML = "";
  const head = el("div", "drawer-section-head");
  const titleBox = el("div");
  titleBox.appendChild(el("h3", "", "🌐 全局 Agents"));
  titleBox.appendChild(el("div", "muted", "全局 Agent 是可复用模板，只有被项目助理勾选后才会启用。"));
  head.appendChild(titleBox);
  const add = el("button", "btn-secondary", "＋ 新建全局 Agent");
  add.type = "button";
  add.onclick = () => openAgentEditor({ scope: "global", onSaved: () => renderDrawerAgents(panel) });
  head.appendChild(add);
  panel.appendChild(head);
  if (agents.length === 0) {
    panel.appendChild(el("div", "muted drawer-empty", "（还没有全局 Agent）"));
    return;
  }
  for (const agent of agents) {
    const row = el("div", "drawer-row");
    const left = el("div", "drawer-row-main");
    const rowTitle = el("div", "drawer-row-title");
    rowTitle.appendChild(el("span", "agent-avatar agent-avatar-global", "🤖"));
    rowTitle.appendChild(el("span", "", agent.name));
    left.appendChild(rowTitle);
    left.appendChild(el("div", "muted drawer-row-desc", agent.instructions || "（无描述）"));
    row.appendChild(left);
    const actions = el("div", "drawer-row-actions");
    const edit = el("button", "tree-settings", "✎");
    edit.type = "button";
    edit.title = `编辑全局 Agent ${agent.name}`;
    edit.onclick = () => openAgentEditor({ scope: "global", existing: agent, onSaved: () => renderDrawerAgents(panel) });
    actions.appendChild(edit);
    const del = el("button", "tree-settings drawer-danger", "🗑");
    del.type = "button";
    del.title = `删除全局 Agent ${agent.name}`;
    del.onclick = async () => {
      if (!confirm(`确认删除全局 Agent "${agent.name}"？`)) return;
      const response = await fetch("/api/agents/delete", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: agent.name, scope: "global" }),
      });
      if (!response.ok) return alert((await response.json()).error || "删除失败");
      await refresh();
      await renderDrawerAgents(panel);
    };
    actions.appendChild(del);
    row.appendChild(actions);
    panel.appendChild(row);
  }
  // 元项目子 Agent（只读，由宿主机直接管理 .md 文件）
  if (metaAgents.length > 0) {
    const metaHead = el("div", "drawer-section-head");
    const metaTitle = el("div");
    metaTitle.appendChild(el("h3", "", "🔧 元项目子 Agents"));
    metaTitle.appendChild(el("div", "muted", `属于元项目「${metaName}」，业务项目助理看不到这里的子 Agent。文件受保护，仅在宿主机管理。`));
    metaHead.appendChild(metaTitle);
    panel.appendChild(metaHead);
    for (const agent of metaAgents) {
      const row = el("div", "drawer-row");
      const left = el("div", "drawer-row-main");
      const rowTitle = el("div", "drawer-row-title");
      rowTitle.appendChild(el("span", "agent-avatar agent-avatar-meta", "🤖"));
      rowTitle.appendChild(el("span", "", agent.name));
      if (agent.locked) rowTitle.appendChild(el("span", "tree-tag", "🔒锁"));
      left.appendChild(rowTitle);
      left.appendChild(el("div", "muted drawer-row-desc", agent.instructions || "（无描述）"));
      row.appendChild(left);
      const actions = el("div", "drawer-row-actions");
      const lock = el("span", "muted", agent.locked ? "locked" : "");
      actions.appendChild(lock);
      row.appendChild(actions);
      panel.appendChild(row);
    }
  }
}

function appendAgentCheckboxGroup(modal, {
  title,
  description,
  choices,
  selectedValues,
  disabledWhen = () => false,
  checkedWhen = (choice) => selectedValues.has(choice.value),
  onChange = () => {},
}) {
  const section = el("section", "agent-editor-section");
  section.appendChild(el("div", "agent-editor-section-title", title));
  section.appendChild(el("div", "muted agent-editor-section-desc", description));
  const grid = el("div", "agent-option-grid");
  if (choices.length === 0) grid.appendChild(el("div", "muted", "（暂无可选项）"));
  const items = [];
  for (const choice of choices) {
    const label = el("label", "agent-option");
    if (choice.note) label.title = choice.note;
    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    checkbox.value = choice.value;
    checkbox.onchange = () => {
      if (checkbox.checked) selectedValues.add(choice.value);
      else selectedValues.delete(choice.value);
      onChange(choice);
      refresh();
    };
    label.appendChild(checkbox);
    const text = el("span", "agent-option-text", choice.label);
    label.appendChild(text);
    if (choice.note) label.appendChild(el("span", "agent-option-note", choice.note));
    grid.appendChild(label);
    items.push({ choice, label, checkbox });
  }
  // disabledWhen / checkedWhen 都是纯函数，统一在这里应用，便于联动（如启用 skill 后锁住 read）。
  function refresh() {
    for (const { choice, label, checkbox } of items) {
      const disabled = disabledWhen(choice);
      checkbox.disabled = disabled;
      checkbox.checked = checkedWhen(choice);
      label.classList.toggle("agent-option-disabled", disabled);
    }
  }
  refresh();
  section.appendChild(grid);
  modal.appendChild(section);
  return { refresh };
}

/** 拉取技能库（项目参数决定是否包含项目私有 skill）。 */
async function fetchSkillLibrary(project) {
  const url = project ? `/api/skills?project=${encodeURIComponent(project)}` : "/api/skills";
  try {
    const response = await fetch(url);
    if (!response.ok) return { skills: [] };
    return await response.json();
  } catch {
    return { skills: [] };
  }
}

/** 把技能库 + 当前角色已有引用整理成勾选项（失效引用也要列出来，否则用户无法取消）。 */
function skillChoicesFor(library, referenced) {
  const known = new Set(library.map((skill) => skill.name));
  const missing = (referenced ?? []).filter((name) => !known.has(name));
  return [
    ...missing.map((name) => ({ value: name, label: `${name}（已不存在）`, note: "请取消勾选，或重新上传同名 skill" })),
    ...library.map((skill) => ({
      value: skill.name,
      label: skill.enabled ? skill.name : `${skill.name}（已全局停用）`,
      note: skill.error ? `⚠ ${skill.error}` : (skill.description || "（无描述）"),
      config: skill,
    })),
  ];
}

/** 启用了 skill 就必须有 read：返回联动函数，供 tools / skills 两个分组共用。 */
function skillReadLinkage(selectedSkills, selectedTools) {
  const forced = () => selectedSkills.size > 0;
  return {
    toolDisabled: (choice) => choice.required === true || (choice.value === "read" && forced()),
    toolChecked: (choice) => choice.required === true || (choice.value === "read" && forced()) || selectedTools.has(choice.value),
    sync: () => { if (forced()) selectedTools.add("read"); },
  };
}

async function openAgentEditor({ scope, project = null, existing = null, onSaved = null }) {
  if (scope === "meta" || existing?.locked) {
    alert(scope === "meta"
      ? "元项目子 agent 不可通过 UI 编辑；请在宿主机直接编辑 /home/agent/.pi/agent/meta/agents/ 下的 .md 文件。"
      : "该 Agent 已锁定（locked=true），不可编辑。可通过 tools:[] 软停用。");
    return;
  }
  const isNew = !existing;
  const isProject = scope === "project";
  const mcpResponse = await fetch("/api/mcp");
  const mcpConfig = mcpResponse.ok ? await mcpResponse.json() : { mcpServers: {} };
  const mcpServers = Object.entries(mcpConfig.mcpServers ?? {});
  const overlay = el("div", "drawer-submodal-backdrop");
  const modal = el("div", "drawer-submodal agent-editor-modal");
  modal.setAttribute("role", "dialog");
  modal.setAttribute("aria-modal", "true");
  const kind = isProject ? "项目 Agent" : "全局 Agent";
  modal.appendChild(el("h3", "", isNew ? `新建${kind}` : `编辑${kind} · ${existing.name}`));
  const nameInput = document.createElement("input");
  nameInput.type = "text";
  nameInput.placeholder = "Agent 名（支持中文、字母、数字、-、_）";
  nameInput.value = existing?.name ?? "";
  modal.appendChild(formRow("名称", nameInput));
  modal.appendChild(formRow("存放位置", el(
    "div",
    "fixed-field",
    isProject ? `项目专属（${project}，创建后始终启用）` : "全局库（由项目助理选择启用）",
  )));
  const modelSelect = document.createElement("select");
  populateAgentModelSelect(modelSelect, existing?.model ?? "");
  modal.appendChild(formRow("模型", modelSelect));

  const selectedTools = new Set(existing ? (existing.tools ?? state.availableTools ?? []) : ["read", "bash"]);
  const enabledMcpNames = new Set(mcpServers.filter(([, config]) => config.enabled !== false).map(([name]) => name));
  const selectedMcps = new Set((existing?.mcps ?? []).filter((name) => enabledMcpNames.has(name)));
  const skillLibrary = (await fetchSkillLibrary(project)).skills ?? [];
  const selectedSkills = new Set(existing?.skills ?? []);
  const linkage = skillReadLinkage(selectedSkills, selectedTools);
  linkage.sync(); // 已有 skill 引用时，把 read 补进将要提交的工具集，与界面展示保持一致
  const toolsGroup = appendAgentCheckboxGroup(modal, {
    title: "工具",
    description: "选择该 Agent 可以直接调用的内置工具。启用 skill 时必须保留 read。",
    choices: (state.availableTools ?? ["read", "write", "edit", "bash"]).map((tool) => ({ value: tool, label: tool })),
    selectedValues: selectedTools,
    disabledWhen: linkage.toolDisabled,
    checkedWhen: linkage.toolChecked,
  });
  appendAgentCheckboxGroup(modal, {
    title: "Skills",
    description: "从全局技能库启用；勾选后自动附带 read（Skill 正文由模型读取）。未勾选则不注入任何 skill。",
    choices: skillChoicesFor(skillLibrary, existing?.skills ?? []),
    selectedValues: selectedSkills,
    onChange: () => { linkage.sync(); toolsGroup.refresh(); },
  });
  appendAgentCheckboxGroup(modal, {
    title: "MCP",
    description: "选择该 Agent 可以使用的 MCP 服务；已停用的服务不可选择。",
    choices: mcpServers.map(([name, config]) => ({ value: name, label: config.enabled === false ? `${name}（已停用）` : name, config })),
    selectedValues: selectedMcps,
    disabledWhen: (choice) => choice.config.enabled === false,
  });
  modal.appendChild(el("div", "form-label", "提示词（instructions）"));
  const instructions = document.createElement("textarea");
  instructions.className = "cfg-textarea";
  instructions.rows = 8;
  instructions.value = existing?.instructions || `你是一个专注、可靠的${kind}。请根据收到的任务完成工作，并返回简洁、准确的结果。`;
  modal.appendChild(instructions);
  const status = el("div", "form-status");
  modal.appendChild(status);
  const actions = el("div", "form-actions");
  const cancel = el("button", "btn-secondary", "取消");
  cancel.type = "button";
  const save = el("button", "btn-primary", "保存");
  save.type = "button";
  actions.appendChild(cancel);
  if (!isNew) {
    const remove = el("button", "btn-danger", "删除");
    remove.type = "button";
    remove.onclick = async () => {
      if (!confirm(`确认删除 ${kind} "${existing.name}"？`)) return;
      const response = await fetch("/api/agents/delete", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ project, name: existing.name, scope }),
      });
      if (!response.ok) {
        status.className = "form-status err";
        status.textContent = `❌ ${(await response.json()).error || "删除失败"}`;
        return;
      }
      close();
      await refresh();
      if (onSaved) await onSaved();
    };
    actions.appendChild(remove);
  }
  actions.appendChild(save);
  modal.appendChild(actions);
  overlay.appendChild(modal);
  document.body.appendChild(overlay);
  const close = () => overlay.remove();
  cancel.onclick = close;
  overlay.onclick = (event) => { if (event.target === overlay) close(); };
  save.onclick = async () => {
    const name = nameInput.value.trim();
    const prompt = instructions.value.trim();
    if (!name) {
      status.className = "form-status err";
      status.textContent = "❌ 需要名称";
      return;
    }
    if (!prompt) {
      status.className = "form-status err";
      status.textContent = "❌ 提示词不能为空";
      return;
    }
    save.disabled = true;
    const response = await fetch("/api/agents", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        project,
        name,
        oldName: existing?.name,
        scope,
        model: modelSelect.value || null,
        tools: [...selectedTools],
        mcps: [...selectedMcps],
        skills: [...selectedSkills],
        instructions: prompt,
      }),
    });
    save.disabled = false;
    if (!response.ok) {
      status.className = "form-status err";
      status.textContent = `❌ ${(await response.json()).error || "保存失败"}`;
      return;
    }
    close();
    await refresh();
    if (onSaved) await onSaved();
  };
}

// ── Skills Tab ──
// 技能库全局共享（文件只有一份）；角色在各自的配置页里勾选启用哪几个。
const SKILL_SOURCE_LABEL = { builtin: "内置", user: "用户", project: "项目" };

async function renderDrawerSkills(panel) {
  panel.innerHTML = `<div class="drawer-loading">加载中…</div>`;
  const render = async () => {
    const data = await fetchSkillLibrary();
    const skills = data.skills ?? [];
    panel.innerHTML = "";
    const head = el("div", "drawer-section-head");
    head.appendChild(el("h3", "", "📚 Skills"));
    head.appendChild(el("div", "muted", `${skills.length} 个（启停是全局开关）`));
    panel.appendChild(head);
    const bar = el("div", "drawer-row-actions");
    const upload = el("button", "btn-primary", "＋ 上传 Skill");
    upload.type = "button";
    upload.onclick = () => openSkillUpload(() => render());
    bar.appendChild(upload);
    panel.appendChild(bar);
    panel.appendChild(el("div", "muted drawer-hint", "启用哪个 Skill 由各 Agent / 助理在自己的配置页里决定；这里的开关是整个库的全局闸门，关掉后任何角色都无法使用。"));
    if (data.dirs) {
      panel.appendChild(el("div", "muted drawer-hint", `用户库：${data.dirs.user}`));
    }
    if (skills.length === 0) {
      panel.appendChild(el("div", "drawer-empty muted", "技能库为空，点上方按钮上传 SKILL.md"));
      return;
    }
    for (const s of skills) {
      const row = el("div", "drawer-row");
      const left = el("div", "drawer-row-main");
      const title = el("div", "drawer-row-title");
      title.appendChild(el("span", "", s.name));
      const tag = el("span", `tree-tag drawer-tag-${s.source}`);
      tag.textContent = SKILL_SOURCE_LABEL[s.source] ?? s.source;
      title.appendChild(tag);
      if (!s.enabled) title.appendChild(el("span", "tree-tag drawer-danger", "已停用"));
      left.appendChild(title);
      const desc = el("div", "muted drawer-row-desc");
      desc.textContent = s.error ? `⚠ ${s.error}` : (s.description || "（无描述）");
      if (s.error) desc.classList.add("drawer-danger");
      left.appendChild(desc);
      const meta = el("div", "muted drawer-row-desc");
      const parts = [];
      if (s.bytes) parts.push(`${(s.bytes / 1024).toFixed(1)}KB`);
      if (s.updatedAt) parts.push(`更新于 ${s.updatedAt.slice(0, 10)}`);
      if (s.usedBy?.length) parts.push(`被 ${s.usedBy.map((item) => item.name).join("、")} 使用`);
      else parts.push("暂无角色使用");
      meta.textContent = parts.join(" · ");
      left.appendChild(meta);
      row.appendChild(left);

      const actions = el("div", "drawer-row-actions");
      const toggle = document.createElement("input");
      toggle.type = "checkbox";
      toggle.title = "全局启用/停用";
      toggle.checked = s.enabled;
      toggle.onchange = async () => {
        const response = await fetch("/api/skills/toggle", {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ name: s.name, enabled: toggle.checked }),
        });
        if (!response.ok) alert((await response.json()).error || "操作失败");
        await render();
      };
      actions.appendChild(toggle);
      if (s.source === "user") {
        const remove = el("button", "btn-danger mcp-test-button", "删除");
        remove.type = "button";
        remove.onclick = async () => {
          const used = s.usedBy?.length ? `\n\n以下角色还在引用它：\n${s.usedBy.map((item) => `· ${item.name}`).join("\n")}` : "";
          if (!confirm(`确认从技能库删除 “${s.name}”？${used}`)) return;
          const response = await fetch("/api/skills/delete", {
            method: "POST", headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ name: s.name }),
          });
          if (!response.ok) alert((await response.json()).error || "删除失败");
          await render();
        };
        actions.appendChild(remove);
      }
      row.appendChild(actions);
      panel.appendChild(row);
    }
  };
  await render();
}

/** 上传 SKILL.md（可选附带整目录的 scripts / references）。 */
function openSkillUpload(onDone) {
  const overlay = el("div", "drawer-submodal-backdrop");
  const modal = el("div", "drawer-submodal agent-editor-modal");
  modal.setAttribute("role", "dialog");
  modal.setAttribute("aria-modal", "true");
  modal.appendChild(el("h3", "", "上传 Skill"));

  const nameInput = document.createElement("input");
  nameInput.type = "text";
  nameInput.placeholder = "pdf-tools（小写字母、数字、连字符）";
  modal.appendChild(formRow("名称", nameInput));

  const picker = document.createElement("input");
  picker.type = "file";
  picker.accept = ".md";
  modal.appendChild(formRow("选择文件", picker));

  modal.appendChild(el("div", "form-label", "SKILL.md 内容（含 frontmatter）"));
  const content = document.createElement("textarea");
  content.className = "cfg-textarea";
  content.rows = 12;
  content.placeholder = "---\nname: pdf-tools\ndescription: 从 PDF 提取文本与表格。读取、转换或检查 PDF 时使用。\n---\n\n# PDF tools\n……";
  modal.appendChild(content);

  const dirPicker = document.createElement("input");
  dirPicker.type = "file";
  dirPicker.multiple = true;
  dirPicker.setAttribute("webkitdirectory", "");
  modal.appendChild(formRow("附带目录", dirPicker));
  const dirHint = el("div", "muted drawer-row-desc", "可选：选中 skill 目录整个上传 scripts/、references/ 等附属文件（仅支持文本文件；SKILL.md 以左侧内容为准）。");
  modal.appendChild(dirHint);

  const overwriteRow = el("label", "agent-option");
  const overwrite = document.createElement("input");
  overwrite.type = "checkbox";
  overwriteRow.appendChild(overwrite);
  overwriteRow.appendChild(el("span", "agent-option-text", "同名用户 Skill 已存在时覆盖"));
  modal.appendChild(overwriteRow);

  const status = el("div", "form-status", "");
  modal.appendChild(status);
  const actions = el("div", "form-actions");
  const cancel = el("button", "btn-secondary", "取消");
  cancel.type = "button";
  const submit = el("button", "btn-primary", "上传");
  submit.type = "button";
  actions.appendChild(cancel);
  actions.appendChild(submit);
  modal.appendChild(actions);
  overlay.appendChild(modal);
  document.body.appendChild(overlay);
  const close = () => overlay.remove();
  cancel.onclick = close;
  overlay.onclick = (event) => { if (event.target === overlay) close(); };

  // 选了 SKILL.md 就填进 textarea；frontmatter 的 name 自动回填到名称框。
  picker.onchange = async () => {
    const file = picker.files?.[0];
    if (!file) return;
    content.value = await file.text();
    autoFillName();
  };
  const autoFillName = () => {
    if (nameInput.value.trim()) return;
    const declared = content.value.match(/^---\r?\n[\s\S]*?^name:\s*([^\n]+)/m);
    if (declared) nameInput.value = declared[1].trim();
  };
  content.onblur = autoFillName;

  let attached = [];
  dirPicker.onchange = async () => {
    const files = [...(dirPicker.files ?? [])];
    attached = [];
    let skippedSkillMd = 0;
    for (const file of files) {
      // webkitRelativePath 形如 pdf-tools/scripts/a.sh → 去掉顶层目录名
      const relative = (file.webkitRelativePath || file.name).split("/").slice(1).join("/") || file.name;
      const base = relative.split("/").pop();
      if (base === "SKILL.md") {
        // 目录里可能包含多个 skill；第一个充当正文，其余忽略（避免把别人的 SKILL.md 当附属文件上传）。
        if (!content.value.trim()) content.value = await file.text();
        else skippedSkillMd += 1;
        autoFillName();
        continue;
      }
      attached.push({ path: relative, content: await file.text() });
    }
    const notes = [];
    if (attached.length) notes.push(`将一并上传 ${attached.length} 个附属文件：${attached.map((file) => file.path).join("、")}`);
    if (skippedSkillMd) notes.push(`忽略 ${skippedSkillMd} 个额外的 SKILL.md`);
    dirHint.textContent = notes.length ? notes.join("；") : "未选择附属文件。";
  };

  submit.onclick = async () => {
    status.className = "form-status";
    status.textContent = "上传中…";
    submit.disabled = true;
    const response = await fetch("/api/skills/upload", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: nameInput.value.trim() || undefined,
        content: content.value,
        files: attached,
        overwrite: overwrite.checked,
      }),
    });
    submit.disabled = false;
    if (!response.ok) {
      status.className = "form-status err";
      status.textContent = `❌ ${(await response.json()).error || "上传失败"}`;
      return;
    }
    close();
    if (onDone) await onDone();
  };
}


// ── MCP Tab ──
async function renderDrawerMcp(panel) {
  panel.innerHTML = `<div class="drawer-loading">加载中…</div>`;
  const render = async () => {
    const cfg = await (await fetch("/api/mcp")).json();
    const servers = Object.entries(cfg.mcpServers ?? {});
    panel.innerHTML = "";
    const head = el("div", "drawer-section-head");
    head.appendChild(el("h3", "", "🔌 MCP Servers"));
    const addBtn = el("button", "btn-secondary", "＋ 新增");
    addBtn.onclick = () => openMcpForm(null, render);
    head.appendChild(addBtn);
    panel.appendChild(head);
    if (servers.length === 0) {
      panel.appendChild(el("div", "muted drawer-empty", "（还没有配置 MCP server）"));
      return;
    }
    for (const [name, config] of servers) {
      const row = el("div", "drawer-row");
      const left = el("div", "drawer-row-main");
      const title = el("div", "drawer-row-title");
      const type = config.url ? "http" : (config.command ? "stdio" : "?");
      title.textContent = `${name}  ·  ${type}${config.enabled === false ? " · 已禁用" : ""}`;
      left.appendChild(title);
      const desc = el("div", "muted drawer-row-desc");
      desc.textContent = config.description || (type === "stdio" ? config.command : config.url) || "（无描述）";
      left.appendChild(desc);
      row.appendChild(left);
      const acts = el("div", "drawer-row-actions");
      const toggle = document.createElement("input");
      toggle.type = "checkbox";
      toggle.checked = config.enabled !== false;
      toggle.title = "启停";
      toggle.onchange = async () => {
        await fetch("/api/mcp", {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ name, config: { ...config, enabled: toggle.checked } }),
        });
        settingsLoadedTabs.delete("mcp"); render();
      };
      acts.appendChild(toggle);
      const edit = el("button", "tree-settings", "✎");
      edit.title = "编辑";
      edit.onclick = () => openMcpForm({ name, config }, render);
      acts.appendChild(edit);
      const test = el("button", "btn-secondary mcp-test-button", "测试连接");
      test.type = "button";
      test.title = `测试 ${name} 并列出工具`;
      acts.appendChild(test);
      const del = el("button", "tree-settings drawer-danger", "🗑");
      del.title = "删除";
      del.onclick = async () => {
        if (!confirm(`确认删除 MCP server "${name}"？`)) return;
        await fetch("/api/mcp", {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ name, delete: true }),
        });
        settingsLoadedTabs.delete("mcp"); render();
      };
      acts.appendChild(del);
      row.appendChild(acts);
      panel.appendChild(row);
      const testResult = el("div", "mcp-test-result hidden");
      panel.appendChild(testResult);
      test.onclick = async () => {
        test.disabled = true;
        test.textContent = "测试中…";
        testResult.className = "mcp-test-result testing";
        testResult.textContent = "正在连接 MCP 并获取工具列表…";
        try {
          const response = await fetch("/api/mcp/test", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ name }),
          });
          const data = await response.json();
          testResult.innerHTML = "";
          if (!response.ok || !data.ok) {
            testResult.className = "mcp-test-result error";
            testResult.appendChild(el("div", "mcp-test-title", `❌ MCP 不可用：${data.error || "连接失败"}`));
            return;
          }
          testResult.className = "mcp-test-result success";
          testResult.appendChild(el("div", "mcp-test-title", `✅ MCP 可用 · ${data.tools.length} 个工具`));
          if (data.tools.length === 0) {
            testResult.appendChild(el("div", "muted", "该 MCP 没有声明可调用工具。"));
          } else {
            const list = el("div", "mcp-tool-list");
            for (const tool of data.tools) {
              const item = el("div", "mcp-tool-item");
              item.appendChild(el("code", "mcp-tool-name", tool.name));
              if (tool.description) item.appendChild(el("span", "mcp-tool-description", tool.description));
              list.appendChild(item);
            }
            testResult.appendChild(list);
          }
        } catch (error) {
          testResult.className = "mcp-test-result error";
          testResult.textContent = `❌ 测试失败：${error.message}`;
        } finally {
          test.disabled = false;
          test.textContent = "测试连接";
        }
      };
    }
  };
  await render();
}

function openMcpForm(existing, onSaved) {
  const isNew = !existing;
  const initName = existing?.name ?? "";
  const initCfg = existing?.config ?? { command: "", args: [], env: {}, enabled: true, exposure: "codemode" };
  const overlay = el("div", "drawer-submodal-backdrop");
  const form = el("div", "drawer-submodal");
  form.innerHTML = `
    <h3>${isNew ? "新增" : "编辑"} MCP server</h3>
    <div class="form-row"><label>name</label><input id="mcf-name" type="text" value="${initName}" ${isNew ? "" : "disabled"} placeholder="字母 / 数字 / _ / -"></div>
    <div class="form-row"><label>type</label>
      <select id="mcf-type">
        <option value="stdio" ${!initCfg.url ? "selected" : ""}>stdio</option>
        <option value="http" ${initCfg.url ? "selected" : ""}>http</option>
      </select>
    </div>
    <div id="mcf-stdio">
      <div class="form-row"><label>command</label><input id="mcf-cmd" type="text" value="${initCfg.command ?? ""}" placeholder="例如 npx -y @modelcontextprotocol/server-filesystem"></div>
      <div class="form-row form-row-stack"><label>args</label><textarea id="mcf-args" rows="2" placeholder="每行一个参数">${(initCfg.args ?? []).join("\n")}</textarea></div>
      <div class="form-row form-row-stack"><label>env (K=V 每行一组)</label><textarea id="mcf-env" rows="3" placeholder="API_KEY=xxx\nLOG_LEVEL=info">${Object.entries(initCfg.env ?? {}).map(([k,v]) => `${k}=${v}`).join("\n")}</textarea></div>
    </div>
    <div id="mcf-http" class="hidden">
      <div class="form-row"><label>url</label><input id="mcf-url" type="text" value="${initCfg.url ?? ""}" placeholder="https://..."></div>
      <div class="form-row form-row-stack"><label>headers (K=V 每行一组)</label><textarea id="mcf-headers" rows="3" placeholder="Authorization=Bearer xxx\nX-Custom=value">${Object.entries(initCfg.headers ?? {}).map(([k,v]) => `${k}=${v}`).join("\n")}</textarea></div>
    </div>
    <div class="form-row form-row-stack"><label>description</label><textarea id="mcf-desc" rows="2" placeholder="一句话说明这个 server 的作用">${initCfg.description ?? ""}</textarea></div>
    <div class="form-row"><label>exposure</label>
      <select id="mcf-exposure">
        <option value="codemode" ${initCfg.exposure === "codemode" || !initCfg.exposure ? "selected" : ""}>codemode</option>
        <option value="deferred" ${initCfg.exposure === "deferred" ? "selected" : ""}>deferred</option>
        <option value="direct" ${initCfg.exposure === "direct" ? "selected" : ""}>direct</option>
        <option value="hidden" ${initCfg.exposure === "hidden" ? "selected" : ""}>hidden</option>
      </select>
    </div>
    <div class="form-row"><label>timeout (秒)</label><input id="mcf-timeout" type="number" value="${initCfg.timeout ?? ""}" placeholder="默认 60"></div>
    <div class="form-row"><label>enabled</label><input id="mcf-enabled" type="checkbox" ${initCfg.enabled !== false ? "checked" : ""}></div>
    <div id="mcf-status" class="form-status"></div>
    <div class="form-actions">
      <button id="mcf-cancel" class="btn-secondary" type="button">取消</button>
      <button id="mcf-save" class="btn-primary" type="button">保存</button>
    </div>
  `;
  overlay.appendChild(form);
  document.body.appendChild(overlay);
  const close = () => overlay.remove();
  form.querySelector("#mcf-cancel").onclick = close;
  overlay.onclick = (ev) => { if (ev.target === overlay) close(); };
  const typeSel = form.querySelector("#mcf-type");
  const sync = () => {
    form.querySelector("#mcf-stdio").classList.toggle("hidden", typeSel.value !== "stdio");
    form.querySelector("#mcf-http").classList.toggle("hidden", typeSel.value !== "http");
  };
  typeSel.onchange = sync; sync();
  const parseKV = (s) => {
    const out = {};
    for (const line of (s ?? "").split("\n")) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const i = trimmed.indexOf("=");
      if (i > 0) out[trimmed.slice(0, i).trim()] = trimmed.slice(i + 1);
    }
    return out;
  };
  form.querySelector("#mcf-save").onclick = async () => {
    const status = form.querySelector("#mcf-status");
    status.className = "form-status"; status.textContent = "保存中…";
    const name = form.querySelector("#mcf-name").value.trim();
    const type = typeSel.value;
    const cfg = {
      enabled: form.querySelector("#mcf-enabled").checked,
      description: form.querySelector("#mcf-desc").value || undefined,
      exposure: form.querySelector("#mcf-exposure").value,
      timeout: Number(form.querySelector("#mcf-timeout").value) || undefined,
    };
    if (type === "stdio") {
      cfg.command = form.querySelector("#mcf-cmd").value.trim();
      const args = form.querySelector("#mcf-args").value
        .split("\n").map((s) => s.trim()).filter(Boolean);
      if (args.length) cfg.args = args;
      const env = parseKV(form.querySelector("#mcf-env").value);
      if (Object.keys(env).length) cfg.env = env;
    } else {
      cfg.url = form.querySelector("#mcf-url").value.trim();
      const headers = parseKV(form.querySelector("#mcf-headers").value);
      if (Object.keys(headers).length) cfg.headers = headers;
    }
    const r = await fetch("/api/mcp", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name, config: cfg }),
    });
    const data = await r.json();
    if (!r.ok) { status.className = "form-status err"; status.textContent = `❌ ${data.error || "保存失败"}`; return; }
    close();
    settingsLoadedTabs.delete("mcp"); await onSaved();
  };
}

// ── 数据清理 Tab ──
function formatBytes(bytes) {
  const value = Number(bytes);
  if (!Number.isFinite(value) || value <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let size = value;
  let index = 0;
  while (size >= 1024 && index < units.length - 1) {
    size /= 1024;
    index += 1;
  }
  return `${size >= 100 || index === 0 ? Math.round(size) : size.toFixed(1)} ${units[index]}`;
}

function cleanupStepLabel(step) {
  return (
    {
      "stopping-scheduler": "停止定时任务调度",
      "aborting-tasks": "中断运行中的任务",
      "closing-harness": "关闭后台 Harness",
      "cleaning-database": "清理并压缩数据库",
      "starting-harness": "重新启动 Harness",
    }[step] ?? step
  );
}

async function renderDrawerCleanup(panel, flash) {
  panel.innerHTML = `<div class="drawer-loading">加载中…</div>`;
  let status;
  try {
    status = await (await fetch("/api/cleanup/status")).json();
  } catch (error) {
    panel.innerHTML = `<div class="drawer-section">读取失败：${error.message}</div>`;
    return;
  }
  const { config, database, logs, maintenance } = status;
  panel.innerHTML = "";
  if (flash) panel.appendChild(el("div", "cleanup-flash", flash));

  // ① 占用概览
  const sec1 = el("div", "drawer-section");
  sec1.appendChild(el("h3", "", "📊 占用概览"));
  const table = el("table", "kv-table");
  const rows = [
    ["数据库文件", formatBytes(database.sqlite)],
    ["WAL / SHM", formatBytes(database.wal + database.shm)],
    ["数据库合计", formatBytes(database.total)],
    ["运行日志", `${formatBytes(logs.total)}（${logs.files} 个文件）`],
  ];
  for (const [k, v] of rows) {
    const tr = el("tr");
    tr.appendChild(el("td", "k", k));
    tr.appendChild(el("td", "v", v));
    table.appendChild(tr);
  }
  sec1.appendChild(table);
  sec1.appendChild(el("div", "muted", "运行中的数据主要在 WAL 里，服务正常关闭时会合并进主库；「清理并压缩」后才会真正缩小文件。"));
  const refresh = el("button", "btn-secondary", "刷新");
  refresh.onclick = () => renderDrawerCleanup(panel);
  sec1.appendChild(refresh);
  if (maintenance) {
    sec1.appendChild(el("div", "cleanup-busy", `维护进行中：${cleanupStepLabel(maintenance.step)}…`));
  }
  panel.appendChild(sec1);

  const save = async (patch, hint) => {
    const response = await fetch("/api/cleanup/config", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(patch),
    });
    const result = await response.json();
    if (!response.ok) {
      alert(`保存失败：${result.error || "未知错误"}`);
      return;
    }
    if (hint) hint(result.config);
  };

  // ② 日志文件清理
  const sec2 = el("div", "drawer-section");
  sec2.appendChild(el("h3", "", "🗂 日志文件清理"));
  const logDays = document.createElement("input");
  logDays.type = "number";
  logDays.min = "0";
  logDays.max = "365";
  logDays.value = String(config.logs.retentionDays);
  logDays.onchange = () => save({ logs: { retentionDays: Number(logDays.value) } });
  sec2.appendChild(formRow("默认保留天数", logDays));
  sec2.appendChild(el("div", "muted", "0 = 不自动删除。单个定时任务可在任务里单独设置保留天数，优先生效。"));

  const maxMb = document.createElement("input");
  maxMb.type = "number";
  maxMb.min = "1";
  maxMb.max = "1024";
  maxMb.value = String(Math.round(config.logs.maxRunBytes / 1024 / 1024));
  maxMb.onchange = () => save({ logs: { maxRunBytes: Number(maxMb.value) * 1024 * 1024 } });
  sec2.appendChild(formRow("单次输出上限", maxMb));
  sec2.appendChild(el("div", "muted", "单位 MB。命令输出超过该值后截断，避免单个任务撑爆磁盘。"));

  const autoPrune = document.createElement("input");
  autoPrune.type = "checkbox";
  autoPrune.checked = config.logs.autoPrune !== false;
  autoPrune.onchange = () => save({ logs: { autoPrune: autoPrune.checked } });
  const autoPruneWrap = el("label", "checkbox-item");
  autoPruneWrap.append(autoPrune, el("span", "", "按规则自动清理日志（每 6 小时检查一次，不中断服务）"));
  sec2.appendChild(autoPruneWrap);

  const pruneBtn = el("button", "btn-secondary", "立即清理日志");
  const logResult = el("div", "form-status");
  pruneBtn.onclick = async () => {
    pruneBtn.disabled = true;
    logResult.className = "form-status";
    logResult.textContent = "正在清理…";
    const response = await fetch("/api/cleanup/logs", { method: "POST" });
    const result = await response.json();
    pruneBtn.disabled = false;
    if (!response.ok) {
      logResult.className = "form-status err";
      logResult.textContent = `❌ ${result.error || "清理失败"}`;
      return;
    }
    await renderDrawerCleanup(
      panel,
      `✅ 日志清理完成：删除 ${result.result.removedFiles} 个文件，释放 ${formatBytes(result.result.freedBytes)}`,
    );
  };
  sec2.append(pruneBtn, logResult);
  panel.appendChild(sec2);

  // ③ 数据库清理
  const sec3 = el("div", "drawer-section");
  sec3.appendChild(el("h3", "", "🗄 数据库清理"));
  const dbDays = document.createElement("input");
  dbDays.type = "number";
  dbDays.min = "0";
  dbDays.max = "3650";
  dbDays.value = String(config.database.retentionDays);
  dbDays.onchange = () => save({ database: { retentionDays: Number(dbDays.value) } });
  sec3.appendChild(formRow("保留天数", dbDays));
  sec3.appendChild(el("div", "muted", "删除早于该天数的已结束任务，以及它们拥有的独立会话（日志里的一次运行一个会话）。0 = 不删除。"));

  const vacuum = document.createElement("input");
  vacuum.type = "checkbox";
  vacuum.checked = config.database.vacuum !== false;
  vacuum.onchange = () => save({ database: { vacuum: vacuum.checked } });
  const vacuumWrap = el("label", "checkbox-item");
  vacuumWrap.append(vacuum, el("span", "", "清理后压缩数据库（VACUUM，需要约等于库大小的临时磁盘空间）"));
  sec3.appendChild(vacuumWrap);

  const autoClean = document.createElement("input");
  autoClean.type = "checkbox";
  autoClean.checked = config.database.autoClean !== false;
  autoClean.onchange = () => save({ database: { autoClean: autoClean.checked } });
  const autoCleanWrap = el("label", "checkbox-item");
  autoCleanWrap.append(autoClean, el("span", "", "每天自动清理（仅在确认没有任务运行时执行）"));
  sec3.appendChild(autoCleanWrap);

  const autoAt = document.createElement("input");
  autoAt.type = "time";
  autoAt.value = config.database.autoCleanAt;
  autoAt.onchange = () => save({ database: { autoCleanAt: autoAt.value } });
  sec3.appendChild(formRow("自动清理时间", autoAt));

  const compactBtn = el("button", "btn-primary", "立即清理并压缩");
  const dbResult = el("div", "form-status");
  compactBtn.onclick = async () => {
    if (!confirm("执行期间会短暂停止后台任务（运行中的命令与模型生成会被中断），并在清理后自动恢复。继续？")) return;
    compactBtn.disabled = true;
    dbResult.className = "form-status";
    dbResult.textContent = "正在清理：停止调度 → 中断任务 → 关闭 Harness → 清理压缩 → 重启…";
    try {
      const response = await fetch("/api/cleanup/database", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ retentionDays: Number(dbDays.value), vacuum: vacuum.checked }),
      });
      const result = await response.json();
      if (!response.ok) {
        dbResult.className = "form-status err";
        dbResult.textContent = `❌ ${result.error || "清理失败"}`;
        return;
      }
      const r = result.result ?? {};
      await renderDrawerCleanup(
        panel,
        `✅ 数据库清理完成（${result.durationMs} ms）：删除任务 ${r.tasks ?? 0}、会话 ${r.conversations ?? 0}、` +
          `消息 ${r.entries ?? 0}、提交 ${r.submissions ?? 0}、文档 ${r.documents ?? 0}；` +
          `${formatBytes(r.sizeBefore)} → ${formatBytes(r.sizeAfter)}` +
          (r.error ? `（${r.error}）` : ""),
      );
    } catch (error) {
      dbResult.className = "form-status err";
      dbResult.textContent = `❌ ${error.message}`;
    } finally {
      compactBtn.disabled = false;
    }
  };
  sec3.append(compactBtn, dbResult);
  panel.appendChild(sec3);

  // ④ 运行记录保留
  const sec4 = el("div", "drawer-section");
  sec4.appendChild(el("h3", "", "📜 运行记录"));
  const maxRuns = document.createElement("input");
  maxRuns.type = "number";
  maxRuns.min = "20";
  maxRuns.max = "5000";
  maxRuns.value = String(config.runs.maxEntries);
  maxRuns.onchange = () => save({ runs: { maxEntries: Number(maxRuns.value) } });
  sec4.appendChild(formRow("运行记录条数", maxRuns));
  sec4.appendChild(el("div", "muted", "每个定时任务在 schedules.json 里保留的最近运行记录数量。"));
  panel.appendChild(sec4);

  // ⑤ 上次执行
  const sec5 = el("div", "drawer-section");
  sec5.appendChild(el("h3", "", "🕒 上次执行"));
  const lastLogs = config.lastRuns?.logs;
  const lastDb = config.lastRuns?.database;
  sec5.appendChild(
    el(
      "div",
      "muted",
      lastLogs
        ? `日志：${formatDateTime(lastLogs.at)} 删除 ${lastLogs.removedFiles} 个文件，释放 ${formatBytes(lastLogs.freedBytes)}`
        : "日志：尚未执行",
    ),
  );
  sec5.appendChild(
    el(
      "div",
      "muted",
      lastDb
        ? `数据库：${formatDateTime(lastDb.at)} 删除任务 ${lastDb.tasks ?? 0} / 会话 ${lastDb.conversations ?? 0}，${formatBytes(lastDb.sizeBefore)} → ${formatBytes(lastDb.sizeAfter)}${lastDb.error ? `（${lastDb.error}）` : ""}`
        : "数据库：尚未执行",
    ),
  );
  panel.appendChild(sec5);
}

// ── 系统 Tab ──
async function renderDrawerSystem(panel) {
  const sys = await (await fetch("/api/system")).json();
  const prefs = await (await fetch("/api/prefs")).json();
  panel.innerHTML = "";
  // 容器信息
  const sec1 = el("div", "drawer-section");
  sec1.appendChild(el("h3", "", "📦 容器"));
  const info = el("table", "kv-table");
  for (const [k, v] of Object.entries(sys.container)) {
    const tr = el("tr");
    tr.appendChild(el("td", "k", k));
    tr.appendChild(el("td", "v", String(v)));
    info.appendChild(tr);
  }
  sec1.appendChild(info);
  panel.appendChild(sec1);
  // 路径
  const sec2 = el("div", "drawer-section");
  sec2.appendChild(el("h3", "", "📁 路径"));
  const paths = el("table", "kv-table");
  for (const [k, v] of Object.entries(sys.paths)) {
    const tr = el("tr");
    tr.appendChild(el("td", "k", k));
    tr.appendChild(el("td", "v", v));
    paths.appendChild(tr);
  }
  sec2.appendChild(paths);
  panel.appendChild(sec2);
  // 凭据总览
  const sec3 = el("div", "drawer-section");
  sec3.appendChild(el("h3", "", "🔐 凭据总览"));
  for (const p of sys.providers) {
    const row = el("div", "kv-row");
    row.appendChild(el("span", "", `${p.label} (${p.id})`));
    const tag = el("span", p.configured ? "tag tag-ok" : "tag tag-warn");
    tag.textContent = p.configured ? "已配置" : "未配置";
    row.appendChild(tag);
    sec3.appendChild(row);
  }
  panel.appendChild(sec3);
  // 偏好
  const sec4 = el("div", "drawer-section");
  sec4.appendChild(el("h3", "", "🎨 偏好"));
  const densityRow = el("div", "form-row");
  densityRow.appendChild(el("label", "", "密度"));
  const densitySel = document.createElement("select");
  for (const v of ["comfortable", "compact"]) {
    const o = document.createElement("option");
    o.value = v; o.textContent = v === "comfortable" ? "舒适" : "紧凑";
    if (v === prefs.density) o.selected = true;
    densitySel.appendChild(o);
  }
  densitySel.onchange = async () => {
    await fetch("/api/prefs", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ density: densitySel.value }) });
    document.body.classList.toggle("density-compact", densitySel.value === "compact");
  };
  densityRow.appendChild(densitySel);
  sec4.appendChild(densityRow);
  const themeRow = el("div", "form-row");
  themeRow.appendChild(el("label", "", "主题"));
  const themeSel = document.createElement("select");
  for (const v of ["dark", "light"]) {
    const o = document.createElement("option");
    o.value = v; o.textContent = v === "dark" ? "深色" : "浅色";
    if (v === prefs.theme) o.selected = true;
    themeSel.appendChild(o);
  }
  themeSel.onchange = async () => {
    await fetch("/api/prefs", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ theme: themeSel.value }) });
    document.body.classList.toggle("theme-light", themeSel.value === "light");
  };
  themeRow.appendChild(themeSel);
  sec4.appendChild(themeRow);
  panel.appendChild(sec4);

  // 品牌：浏览器标签页标题 + 图标（品牌名 h1 不可修改）
  const sec5 = el("div", "drawer-section");
  sec5.appendChild(el("h3", "", "🏷 品牌"));
  sec5.appendChild(el("div", "muted", "只影响浏览器标签页的标题与图标；页面左上角品牌名固定为 pi-box。"));

  const titleRow = el("div", "form-row");
  titleRow.appendChild(el("label", "", "页面标题"));
  const titleInput = document.createElement("input");
  titleInput.type = "text";
  titleInput.maxLength = 120;
  titleInput.placeholder = DEFAULT_APP_TITLE;
  titleInput.value = prefs.appTitle ?? "";
  titleRow.appendChild(titleInput);
  sec5.appendChild(titleRow);

  const iconRow = el("div", "form-row");
  iconRow.appendChild(el("label", "", "图标"));
  const iconBox = el("div", "brand-icon");
  const preview = document.createElement("img");
  preview.className = "brand-icon-preview";
  preview.alt = "图标预览";
  iconBox.appendChild(preview);

  const iconSel = document.createElement("select");
  for (const [value, label] of APP_ICON_MODES) {
    const o = document.createElement("option");
    o.value = value;
    o.textContent = label;
    iconSel.appendChild(o);
  }
  iconBox.appendChild(iconSel);

  const emojiInput = document.createElement("input");
  emojiInput.type = "text";
  emojiInput.className = "brand-emoji";
  emojiInput.maxLength = 8;
  emojiInput.placeholder = "🚀";
  iconBox.appendChild(emojiInput);

  const fileInput = document.createElement("input");
  fileInput.type = "file";
  fileInput.className = "brand-file";
  fileInput.accept = ".png,.jpg,.jpeg,.webp,.svg,.ico,image/png,image/jpeg,image/webp,image/svg+xml,image/x-icon";
  iconBox.appendChild(fileInput);
  iconRow.appendChild(iconBox);
  sec5.appendChild(iconRow);

  // 待保存的图标草稿：{ kind: "emoji", emoji } | { kind: "upload", dataUrl, href } | null
  let iconDraft = null;
  const currentIcon = () => prefs.appIcon ?? { type: "default" };

  function renderIconPreview() {
    let icon = currentIcon();
    if (iconSel.value === "emoji") icon = { type: "emoji", emoji: emojiInput.value.trim() };
    else if (iconSel.value === "upload") icon = iconDraft?.kind === "upload" ? { type: "upload", version: 0 } : currentIcon();
    preview.src = iconDraft?.kind === "upload" && iconSel.value === "upload" ? iconDraft.href : appIconHref(icon);
  }
  function syncIconMode() {
    const mode = iconSel.value;
    emojiInput.classList.toggle("hidden", mode !== "emoji");
    fileInput.classList.toggle("hidden", mode !== "upload");
    if (mode === "emoji" && !emojiInput.value) {
      emojiInput.value = currentIcon().type === "emoji" ? currentIcon().emoji : "";
    }
    if (mode === "upload" && currentIcon().type === "upload") iconDraft = null;
    renderIconPreview();
  }

  iconSel.value = ["default", "emoji", "upload"].includes(currentIcon().type) ? currentIcon().type : "default";
  iconSel.onchange = syncIconMode;
  emojiInput.oninput = renderIconPreview;
  fileInput.onchange = () => {
    const file = fileInput.files?.[0];
    if (!file) return;
    if (file.size > 512 * 1024) {
      status.className = "form-status err";
      status.textContent = "❌ 图标不能超过 512KB";
      fileInput.value = "";
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      iconDraft = { kind: "upload", dataUrl: String(reader.result), href: String(reader.result) };
      renderIconPreview();
      status.className = "form-status";
      status.textContent = `已选择 ${file.name}，点「保存」后生效`;
    };
    reader.readAsDataURL(file);
  };

  const brandActions = el("div", "form-actions");
  const status = el("div", "form-status");
  brandActions.appendChild(status);
  const resetIcon = el("button", "btn-secondary", "恢复默认图标");
  resetIcon.type = "button";
  resetIcon.onclick = async () => {
    try {
      const r = await fetch("/api/branding/icon", { method: "DELETE" });
      const data = await r.json();
      if (!r.ok) throw new Error(data.error || "恢复失败");
      prefs.appIcon = data.appIcon;
      iconDraft = null;
      fileInput.value = "";
      iconSel.value = "default";
      syncIconMode();
      applyBranding(prefs);
      status.className = "form-status ok";
      status.textContent = "✅ 已恢复默认图标";
    } catch (error) {
      status.className = "form-status err";
      status.textContent = `❌ ${error.message}`;
    }
  };
  brandActions.appendChild(resetIcon);
  const saveBrand = el("button", "", "保存");
  saveBrand.type = "button";
  saveBrand.onclick = async () => {
    status.className = "form-status";
    status.textContent = "保存中…";
    try {
      let appIcon = currentIcon();
      const mode = iconSel.value;
      if (mode === "upload") {
        if (iconDraft?.kind === "upload") {
          const r = await fetch("/api/branding/icon", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ dataUrl: iconDraft.dataUrl }),
          });
          const data = await r.json();
          if (!r.ok) throw new Error(data.error || "图标上传失败");
          appIcon = data.appIcon;
        } else if (appIcon.type !== "upload") {
          throw new Error("请先选择图标文件");
        }
      } else if (mode === "emoji") {
        const emoji = emojiInput.value.trim();
        if (!emoji) throw new Error("请填写 Emoji");
        appIcon = { type: "emoji", emoji };
      } else {
        if (appIcon.type === "upload") await fetch("/api/branding/icon", { method: "DELETE" });
        appIcon = { type: "default" };
      }
      const saved = await savePrefsPatch({ appTitle: titleInput.value.trim(), appIcon });
      prefs.appTitle = saved.appTitle;
      prefs.appIcon = saved.appIcon;
      iconDraft = null;
      syncIconMode();
      applyBranding(prefs);
      status.className = "form-status ok";
      status.textContent = "✅ 已保存";
    } catch (error) {
      status.className = "form-status err";
      status.textContent = `❌ ${error.message}`;
    }
  };
  brandActions.appendChild(saveBrand);
  sec5.appendChild(brandActions);
  panel.appendChild(sec5);

  syncIconMode();
  // 应用偏好（标题 / 图标 / 主题 / 密度）
  applyBranding(prefs);
}
const cfgKeyInput = document.getElementById("cfg-key");
cfgKeyInput.onfocus = () => {
  if (cfgKeyInput.dataset.masked === "true") {
    cfgKeyInput.value = "";
    cfgKeyInput.dataset.masked = "false";
  }
};
cfgKeyInput.onblur = () => {
  if (!cfgKeyInput.value && cfgKeyInput.dataset.hasStoredKey === "true") showStoredKey(cfgKeyInput, true);
};
cfgKeyInput.oninput = () => {
  cfgKeyInput.dataset.masked = "false";
};
async function fetchModelCatalog() {
  const status = document.getElementById("cfg-status");
  status.className = "form-status";
  status.textContent = "正在获取模型目录…";
  const provider = cfgCurrentProvider;
  const r = await fetch("/api/models", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ provider }) });
  const data = await r.json();
  if (!r.ok) {
    status.className = "form-status err";
    status.textContent = `❌ ${data.error || "获取失败"}`;
    return false;
  }
  cfgModelsCatalog = data.models ?? [];
  fillModelCatalog();
  status.className = "form-status ok";
  status.textContent = `✅ 目录包含 ${cfgModelsCatalog.length} 个模型`;
  return true;
}
document.getElementById("cfg-model-add-btn").onclick = () => addModel(document.getElementById("cfg-model-add").value);
document.getElementById("cfg-model-add").onkeydown = (ev) => {
  if (ev.key === "Enter") { ev.preventDefault(); addModel(ev.target.value); }
};
document.getElementById("cfg-model-pick").onclick = () => {
  const sel = document.getElementById("cfg-model-select");
  addModel(sel.value);
};
document.getElementById("fetch-models").onclick = fetchModelCatalog;
// 左侧二级菜单：添加提供商
function renderAddProviderPanel() {
  const panel = document.getElementById("add-provider-panel");
  panel.innerHTML = "";
  const candidates = cfgProviders.filter((p) => !cfgProviderTabs.includes(p.id));
  if (candidates.length === 0) {
    panel.appendChild(el("div", "muted", "所有提供商都已添加"));
    return;
  }
  for (const p of candidates) {
    const b = el("button", "provider-add-item", p.name);
    b.type = "button";
    b.onclick = () => {
      cfgProviderTabs.push(p.id);
      panel.classList.add("hidden");
      selectProvider(p.id);
    };
    panel.appendChild(b);
  }
}
document.getElementById("add-provider").onclick = () => {
  const panel = document.getElementById("add-provider-panel");
  renderAddProviderPanel();
  panel.classList.toggle("hidden");
};
document.getElementById("test-settings").onclick = async () => {
  const status = document.getElementById("cfg-status");
  status.className = "form-status";
  status.textContent = "正在发起真实模型请求…";
  const payload = selectedProviderPayload();
  const testModel = payload.models[0];
  const r = await fetch("/api/settings/test", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ...payload, modelId: testModel }),
  });
  const data = await r.json();
  status.className = `form-status ${r.ok ? "ok" : "err"}`;
  status.textContent = r.ok ? `✅ 连接成功 · ${data.provider}/${data.modelId} · ${data.latencyMs}ms` : `❌ ${data.error || "连接失败"}`;
};
document.getElementById("cfg-delete").onclick = async () => {
  const provider = cfgCurrentProvider;
  const meta = cfgProviders.find((p) => p.id === provider);
  if (!confirm(`删除 ${meta?.name ?? provider} 的已保存配置（API Key 等）？`)) return;
  const r = await fetch("/api/settings/delete", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ provider }),
  });
  const data = await r.json();
  if (!r.ok) {
    alert(data.error || "删除失败");
    return;
  }
  cfgProviderTabs = cfgProviderTabs.filter((id) => id !== provider);
  cfgSettings = await (await fetch("/api/settings")).json();
  if (cfgProviderTabs.length === 0) cfgProviderTabs.push(cfgSettings.activeProvider);
  renderProviderNav();
  selectProvider(cfgProviderTabs[0] ?? cfgSettings.activeProvider);
  refresh();
};
document.getElementById("save-settings").onclick = async () => {
  const status = document.getElementById("cfg-status");
  status.className = "form-status";
  status.textContent = "保存中…";
  const payload = selectedProviderPayload();
  if (!payload.models.length) {
    status.className = "form-status err";
    status.textContent = "❌ 至少需要配置一个模型";
    return;
  }
  const r = await fetch("/api/settings", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  const data = await r.json();
  if (r.ok) {
    status.className = "form-status ok";
    status.textContent = `✅ 已保存 · ${payload.models.length} 个模型${payload.setActive ? " · 已设为默认" : ""}`;
    setTimeout(() => {
      closeSettings();
      refresh();
    }, 600);
  } else {
    status.className = "form-status err";
    status.textContent = `❌ ${data.error || "保存失败"}`;
  }
};

// ─── SSE ────────────────────────────────────────────────────────────────────
/**
 * 按需重拉选中会话的详情（P0-2）。
 * 之前每条 SSE 都会 force 重拉完整会话（400 轮 ≈ 299KB），即使内容毫无变化。
 * 现在：状态发生跃迁（空闲 ↔ 运行中）时立即拉；运行中按 DETAIL_POLL_ACTIVE_MS
 * 节流；空闲会话不做任何轮询（内容不会变）。
 */
function maybeRefreshConversationDetail(conv) {
  const key = String(conv.id);
  // 详情还没加载过：交给 renderConversation 的首次加载分支处理。
  if (!conversationDetailCache.has(key)) return;
  const record = detailRefreshState.get(key) ?? { lastFetch: 0, status: conv.status };
  const active = isActiveConversationStatus(conv.status);
  const wasActive = isActiveConversationStatus(record.status);
  const now = Date.now();
  // 状态跃迁：会话刚开始干活或刚干完活，内容一定变了，立即拉。
  if (active !== wasActive) {
    refreshConversationDetail(conv, now);
    return;
  }
  if (!active) return; // 空闲会话内容不变，不做无效轮询。
  if (now - record.lastFetch < DETAIL_POLL_ACTIVE_MS) return;
  refreshConversationDetail(conv, now);
}

function refreshConversationDetail(conv, now) {
  const key = String(conv.id);
  detailRefreshState.set(key, { lastFetch: now, status: conv.status });
  loadConversationDetail(conv.id, { force: true }).then(() => {
    if (selected?.type === "conversation" && String(selected.id) === key) renderView();
  }).catch(() => {});
}

/**
 * 把快照差异应用到界面（P0-1）。
 * 只重建真正受影响的部分：项目树 / 会话列表 / 任务图 / 会话头部。
 */
function applySnapshotDiff(prev, diff) {
  if (diff.status) renderStatus();
  if (diff.projects || diff.agents) renderTree();
  if (diff.conversations.size > 0 || diff.conversationList) renderSessions();
  if (diff.tasks) renderTaskGraph();
  if (selected?.type !== "conversation") return;
  const key = String(selected.id);
  const conv = state.conversations.find((c) => String(c.id) === key);
  if (!conv) {
    // 会话已被删除：重建视图显示占位文案。
    renderView();
    return;
  }
  // 标题 / 状态变化需要更新头部（终止按钮可用性等）。
  if (diff.conversations.has(key) || diff.conversationList) renderView();
  maybeRefreshConversationDetail(conv);
}

const es = new EventSource("/api/events");
es.onmessage = (ev) => {
  const next = JSON.parse(ev.data);
  const prev = state;
  const diff = diffSnapshot(prev, next);
  state = next;
  agentsCache = state.agentsByProject ?? {};
  schedulesCache = state.schedulesByProject ?? {};
  applySnapshotDiff(prev, diff);
  updateSseIndicator("ok");
};
es.onerror = () => {
  // EventSource 自带重连；只更新指示器状态
  updateSseIndicator("reconnecting");
};
es.onopen = () => updateSseIndicator("ok");

// 启动时先拉一次偏好，应用标题 / 图标 / 主题 / 密度（失败则保持默认外观）
async function initPrefs() {
  try {
    applyBranding(await (await fetch("/api/prefs")).json());
  } catch {
    // 偏好读取失败不影响主流程
  }
}

initPrefs();
refresh();
