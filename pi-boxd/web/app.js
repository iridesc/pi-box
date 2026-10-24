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
const conversationDetailRequests = new Map();
let cfgProviders = [];
let cfgSettings = { activeProvider: "openai", providers: {} };
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
  const existingProjects = new Set(state.projects);
  const restoredProjects = new Set([...expandedProjects].filter((name) => existingProjects.has(name)));
  if (restoredProjects.size !== expandedProjects.size) {
    expandedProjects = restoredProjects;
    saveExpandedProjects();
  }
  render();
}

function render() {
  renderStatus();
  renderTree();
  renderSessions();
  renderView();
  renderTaskGraph();
}

function renderStatus() {
  const m = state.model;
  const noKey = !state.hasKey;
  document.getElementById("status-bar").innerHTML =
    `模型 <b style="color:#58a6ff">${m.provider}/${m.modelId}</b> · 项目 ${state.projects.length}` +
    (noKey ? ' · <span style="color:#d29922">⚠ 未配置 API Key</span>' : "");
  document.getElementById("new-project").disabled = noKey;
}

// ─── 左：项目树 ─────────────────────────────────────────────────────────────
function renderTree() {
  const root = document.getElementById("tree");
  root.innerHTML = "";
  if (state.projects.length === 0) {
    root.appendChild(el("div", "tree-empty", "（还没有项目，点右上角 +新建项目）"));
    return;
  }
  for (const proj of state.projects) {
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
    const selectedConversation = selected?.type === "conversation" ? state.conversations.find((item) => item.id === selected.id) : null;
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
      selected = { type: "assistant", project: proj };
      setMobilePanel("view");
      render();
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

function renderSessions() {
  const body = document.getElementById("session-list");
  const createButton = document.getElementById("new-conversation");
  body.replaceChildren();
  const actor = actorFromSelection();
  createButton.disabled = !actor;
  createButton.title = actor
    ? `为${actor.actorType === "assistant" ? "助理" : ` Agent ${actor.actorName}`}新建独立会话`
    : "请先选择助理或 Agent";
  if (!actor) {
    body.appendChild(el("div", "session-empty", "请在第一栏选择一个助理或 Agent，这里会显示它的全部会话。"));
    return;
  }
  const heading = el("div", "session-context");
  heading.appendChild(el("strong", "", actor.actorType === "assistant" ? "🤖 助理" : `🤖 ${actor.actorName}`));
  heading.appendChild(el("span", "", actor.project));
  body.appendChild(heading);
  const conversations = state.conversations
    .filter((item) => item.project === actor.project && item.actorType === actor.actorType
      && (actor.actorType !== "agent" || item.actorName === actor.actorName))
    .sort((a, b) => {
      const active = (value) => value.status === "running" || value.status === "waiting-tool" ? 1 : 0;
      return active(b) - active(a) || String(b.createdAt ?? b.id).localeCompare(String(a.createdAt ?? a.id));
    });
  if (conversations.length === 0) {
    body.appendChild(el("div", "session-empty", actor.actorType === "agent" ? "这个 Agent 还没有会话；助理首次派发任务后会自动创建。" : "暂无会话。"));
    return;
  }
  const renderConversationItem = (conversation, container) => {
    const item = el("div", `session-item${selected?.type === "conversation" && selected.id === conversation.id ? " selected" : ""}`);
    const dot = el("span", `session-dot session-dot-${conversation.status ?? "idle"}`);
    dot.title = agentStatusLabel(conversation.status ?? "idle");
    item.appendChild(dot);
    item.appendChild(el("div", "session-title", conversation.title || (conversation.actorType === "assistant" ? "助理会话" : conversation.actorName) || `会话 #${conversation.id}`));
    item.appendChild(el("div", "session-meta", `${sessionSourceLabel(conversation)} · #${conversation.id}${conversation.createdAt ? ` · ${formatDateTime(conversation.createdAt)}` : ""}`));
    item.onclick = () => {
      selected = { type: "conversation", project: conversation.project, id: conversation.id };
      setMobilePanel("view");
      render();
    };
    container.appendChild(item);
  };
  const buckets = { recent: [], threeDays: [], sevenDays: [], older: [] };
  for (const conversation of conversations) buckets[conversationAgeBucket(conversation)].push(conversation);
  for (const conversation of buckets.recent) renderConversationItem(conversation, body);
  for (const [key, label] of [["threeDays", "3 天以前"], ["sevenDays", "7 天以前"], ["older", "一个月以前"]]) {
    const items = buckets[key];
    if (items.length === 0) continue;
    const folded = el("details", "session-history-group");
    folded.open = items.some((conversation) => selected?.type === "conversation" && selected.id === conversation.id);
    folded.appendChild(el("summary", "session-history-summary", `${label} · ${items.length} 个会话`));
    const list = el("div", "session-history-list");
    for (const conversation of items) renderConversationItem(conversation, list);
    folded.appendChild(list);
    body.appendChild(folded);
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
  view.innerHTML = "";
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
  if (selected.type === "assistant") return renderAssistantForm(view);
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
    title.appendChild(el("strong", "", schedule.name));
    card.appendChild(title);
    card.appendChild(el("div", "schedule-cron", schedule.description || "自定义时间规则"));
    card.appendChild(el("div", "muted schedule-timezone", `时区：${timezoneLabel(schedule.timezone)}（${schedule.timezone}）`));
    card.appendChild(el("div", "muted schedule-session-mode", schedule.sessionMode === "isolated" ? "会话：每次创建独立会话" : "会话：继续使用项目助理会话"));
    card.appendChild(el("div", "schedule-prompt", schedule.prompt));
    card.appendChild(el("div", "muted", `上次触发：${formatDateTime(schedule.lastRunAt)}　下次执行：${formatDateTime(schedule.nextRunAt)}`));
    const latestRun = (scheduleRunsCache[project] ?? []).find((item) => item.scheduleId === schedule.id);
    if (latestRun?.conversationId) {
      card.appendChild(el("div", "muted schedule-last-run", `最近运行会话：#${latestRun.conversationId}${latestRun.sessionMode === "isolated" ? "（独立）" : "（项目助理）"}`));
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
    actions.append(run, edit);
    if (latestRun?.conversationId) {
      const viewRun = el("button", "btn-secondary", "查看最近会话");
      viewRun.onclick = async () => {
        if (!state.conversations.some((item) => item.id === String(latestRun.conversationId))) await refresh();
        selected = { type: "conversation", project, id: String(latestRun.conversationId) };
        setMobilePanel("view");
        render();
      };
      actions.appendChild(viewRun);
    }
    card.appendChild(actions);
    body.appendChild(card);
  }
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

  const sessionMode = document.createElement("select");
  for (const [value, label] of [["isolated", "每次创建独立会话（推荐）"], ["assistant", "继续使用项目助理会话"]]) {
    const option = document.createElement("option");
    option.value = value;
    option.textContent = label;
    sessionMode.appendChild(option);
  }
  sessionMode.value = existing?.sessionMode ?? (existing ? "assistant" : "isolated");
  modal.appendChild(formRow("会话方式", sessionMode));
  const sessionHelp = el("div", "muted schedule-session-help");
  const updateSessionHelp = () => {
    sessionHelp.textContent = sessionMode.value === "isolated"
      ? "使用相同的项目助理配置，但不读取或污染主会话历史；结果保存在本次独立会话中。"
      : "可以读取之前的项目助理对话，执行过程和结果会进入项目助理主会话。";
  };
  sessionMode.onchange = updateSessionHelp;
  updateSessionHelp();
  modal.appendChild(sessionHelp);

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

  const enabledWrap = el("label", "checkbox-item schedule-enabled");
  const enabled = document.createElement("input");
  enabled.type = "checkbox";
  enabled.checked = existing?.enabled !== false;
  enabledWrap.append(enabled, el("span", "", "启用这个定时任务"));
  modal.appendChild(enabledWrap);

  modal.appendChild(el("div", "form-label", "给项目助理的任务说明"));
  const prompt = document.createElement("textarea");
  prompt.className = "cfg-textarea";
  prompt.rows = 7;
  prompt.value = existing?.prompt ?? "请检查当前项目的状态，完成需要处理的工作，并汇报结果。";
  modal.appendChild(prompt);
  modal.appendChild(el("div", "muted", "无论选择哪种会话方式，助理都可以派发当前项目中已启用的子 Agent。"));
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
      body: JSON.stringify({ project, id: existing?.id, name: name.value, rule: readRule(), timezone: timezone.value, sessionMode: sessionMode.value, enabled: enabled.checked, prompt: prompt.value }),
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
  scheduleSection.appendChild(el("div", "muted schedule-intro", "到点后由项目助理处理任务；可选择继续主会话或为每次运行创建独立会话，助理可以调用项目中全部已启用的子 Agent。"));
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

function markdownBlock(text) {
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
      current = { users: userMessages, items: [] };
      turns.push(current);
    }
    if (!current) {
      current = { users: [], items: [] };
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

function renderConversation(view) {
  const conv = state.conversations.find((c) => c.id === selected.id);
  if (!conv) {
    view.textContent = "（会话已不存在）";
    return;
  }
  const isAgentView = conv.actorType === "agent";
  const title = isAgentView
    ? `🤖 子 Agent · ${conv.actorName || "未命名"}（会话 #${conv.id}）`
    : `🤖 ${conv.title || "助理会话"}（#${conv.id}）`;
  const sub = `${conv.project} · ${sessionSourceLabel(conv)}`;
  const head = el("div", "view-head");
  head.appendChild(el("span", "view-title", title));
  head.appendChild(el("span", "view-sub", sub));
  view.appendChild(head);

  const detail = conversationDetailCache.get(String(conv.id));
  if (!detail) {
    view.appendChild(el("div", "conversation-loading", "正在加载会话记录…"));
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

  const body = el("div", "view-body");
  for (const turn of conversationTurns(detail.entries ?? [])) body.appendChild(renderConversationTurn(turn));
  view.appendChild(body);
  body.scrollTop = body.scrollHeight;

  const form = document.createElement("form");
  form.className = "view-input";
  const input = document.createElement("input");
  input.placeholder = isAgentView ? `和子 Agent ${conv.actorName || ""} 对话…` : "和项目助理对话…";
  input.autocomplete = "off";
  input.disabled = !state.hasKey;
  const btn = el("button", "", "发送");
  btn.type = "submit";
  btn.disabled = !state.hasKey;
  form.appendChild(input);
  form.appendChild(btn);
  form.onsubmit = async (ev) => {
    ev.preventDefault();
    const content = input.value.trim();
    if (!content) return;
    input.value = "";
    await fetch("/api/submit", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ conversationId: conv.id, content }),
    });
  };
  view.appendChild(form);
}

function formRow(label, control) {
  const row = el("div", "form-row");
  row.appendChild(el("label", "", label));
  row.appendChild(control);
  return row;
}

function renderAssistantForm(view) {
  const proj = selected.project;
  const asst = state.assistantByProject?.[proj] ?? { agents: [], instructions: "", model: null };
  const catalog = state.agentCatalogByProject?.[proj] ?? { project: [], global: [] };

  const head = el("div", "view-head");
  head.appendChild(el("span", "view-title", `🤖 ${proj} · 项目助理`));
  view.appendChild(head);

  const form = el("div", "view-form");

  // 提示词
  const ta = document.createElement("textarea");
  ta.className = "cfg-textarea";
  ta.rows = 8;
  ta.value = asst.instructions || "";
  ta.placeholder = "项目助理的提示词（system prompt）";
  form.appendChild(el("div", "form-label", "提示词"));
  form.appendChild(ta);

  // 项目 Agent 创建后始终启用；全局 Agent 由助理显式授权。
  form.appendChild(el("div", "form-label", "可派发的子 agent"));
  const box = el("div", "checkbox-box");
  if (catalog.project.length === 0 && catalog.global.length === 0) {
    box.appendChild(el("div", "muted", "（还没有 Agent；可在项目中新建，或在系统设置中创建全局 Agent）"));
  }
  if (catalog.project.length > 0) box.appendChild(el("div", "agent-choice-heading", "项目 Agent（始终启用）"));
  for (const a of catalog.project) {
    const lab = el("label", "checkbox-item");
    const cb = document.createElement("input");
    cb.type = "checkbox";
    cb.value = a.name;
    cb.checked = true;
    cb.disabled = true;
    cb.dataset.scope = "project";
    lab.appendChild(cb);
    lab.appendChild(el("span", "", `${a.name}（项目内置，不可关闭）`));
    box.appendChild(lab);
  }
  if (catalog.global.length > 0) box.appendChild(el("div", "agent-choice-heading", "全局 Agent（按需启用）"));
  for (const a of catalog.global) {
    const lab = el("label", "checkbox-item global-agent-choice");
    const cb = document.createElement("input");
    cb.type = "checkbox";
    cb.value = a.name;
    cb.dataset.scope = "global";
    cb.checked = asst.agents?.includes(a.name) ?? false;
    lab.appendChild(cb);
    lab.appendChild(el("span", "agent-avatar agent-avatar-global", "🤖"));
    lab.appendChild(el("span", "", `${a.name}（全局）`));
    box.appendChild(lab);
  }
  form.appendChild(box);

  const status = el("div", "form-status", "");
  const save = el("button", "btn-primary", "保存助理配置");
  save.onclick = async () => {
    const checked = [...box.querySelectorAll('input[data-scope="global"]:checked')].map((c) => c.value);
    const res = await fetch("/api/assistant", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ project: proj, instructions: ta.value, agents: checked }),
    });
    status.className = "form-status ok";
    status.textContent = res.ok ? "✅ 已保存（下次对话生效）" : "❌ 保存失败";
  };
  const bar = el("div", "form-actions");
  bar.appendChild(save);
  bar.appendChild(status);
  form.appendChild(bar);
  view.appendChild(form);
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
    const provider = settings.activeProvider;
    const providersData = await (await fetch("/api/providers")).json();
    const meta = providersData.providers.find((p) => p.id === provider);
    const result = await (await fetch("/api/models", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ provider }),
    })).json();
    const models = result.models ?? [];
    select.innerHTML = "";
    const inherit = document.createElement("option");
    inherit.value = "";
    inherit.textContent = `跟随全局模型（${state.model.provider}/${state.model.modelId}）`;
    select.appendChild(inherit);
    const values = selectedValue && !models.includes(selectedValue) ? [selectedValue, ...models] : models;
    for (const modelId of values) {
      const option = document.createElement("option");
      option.value = modelId;
      option.textContent = `${meta?.name ?? provider} / ${modelId}`;
      select.appendChild(option);
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
  const allTasks = Object.values(state.taskGraph.tasks);
  const elx = document.getElementById("task-graph");
  elx.innerHTML = "";
  if (selected?.type !== "conversation") {
    elx.textContent = "（请选择一个会话）";
    return;
  }
  const conversationIds = new Set([String(selected.id)]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const conversation of state.conversations) {
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

// ─── 设置弹窗（模型）────────────────────────────────────────────────────────
function fillModelList(meta, sel2) {
  const sel = document.getElementById("cfg-model");
  sel.innerHTML = "";
  const ms = meta.models || [];
  const list = sel2 && !ms.includes(sel2) ? [sel2, ...ms] : ms;
  for (const m of list) {
    const o = document.createElement("option");
    o.value = m;
    o.textContent = m;
    sel.appendChild(o);
  }
  if (sel2) sel.value = sel2;
}

function selectedProviderPayload() {
  const keyInput = document.getElementById("cfg-key");
  return {
    provider: document.getElementById("cfg-provider").value,
    modelId: document.getElementById("cfg-model").value,
    apiKey: keyInput.dataset.masked === "true" ? undefined : keyInput.value || undefined,
    baseUrl: document.getElementById("cfg-baseurl").value,
  };
}

function showStoredKey(key, hasKey) {
  key.dataset.hasStoredKey = hasKey ? "true" : "false";
  key.dataset.masked = hasKey ? "true" : "false";
  key.value = hasKey ? MASKED_API_KEY : "";
  key.placeholder = hasKey ? "已保存；输入新值可替换" : "填入你的 API Key";
}

function loadProviderForm(provider) {
  const meta = cfgProviders.find((p) => p.id === provider);
  const saved = cfgSettings.providers?.[provider] ?? {};
  if (!meta) return;
  fillModelList(meta, saved.modelId || meta.defaultModel);
  document.getElementById("cfg-baseurl").value = saved.baseUrl || meta.defaultBaseUrl || "";
  const key = document.getElementById("cfg-key");
  showStoredKey(key, saved.hasKey);
  document.getElementById("cfg-status").textContent = provider === cfgSettings.activeProvider ? "当前启用" : "";
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
    const sel = document.getElementById("cfg-provider");
    sel.innerHTML = "";
    for (const p of cfgProviders) {
      const o = document.createElement("option");
      o.value = p.id;
      o.textContent = p.name;
      sel.appendChild(o);
    }
    sel.onchange = () => loadProviderForm(sel.value);
  }
  cfgSettings = await (await fetch("/api/settings")).json();
  for (const option of document.getElementById("cfg-provider").options) {
    const meta = cfgProviders.find((p) => p.id === option.value);
    option.textContent = `${meta.name}${cfgSettings.providers?.[option.value]?.hasKey ? " ✓" : ""}`;
  }
  document.getElementById("cfg-provider").value = cfgSettings.activeProvider || cfgProviders[0]?.id;
  loadProviderForm(document.getElementById("cfg-provider").value);
}
document.addEventListener("keydown", (ev) => {
  if (ev.key === "Escape" && !document.getElementById("settings-modal").classList.contains("hidden")) closeSettings();
});

async function switchSettingsTab(tab) {
  for (const btn of document.querySelectorAll(".drawer-nav-item")) {
    btn.classList.toggle("active", btn.dataset.tab === tab);
  }
  for (const id of ["tab-models", "tab-agents", "tab-skills", "tab-mcp", "tab-system"]) {
    document.getElementById(id).classList.toggle("hidden", id !== `tab-${tab}`);
  }
  if (tab === "models") return;
  const panel = document.getElementById(`tab-${tab}`);
  if (!settingsLoadedTabs.has(tab)) {
    settingsLoadedTabs.add(tab);
    if (tab === "agents") await renderDrawerAgents(panel);
    if (tab === "skills") await renderDrawerSkills(panel);
    if (tab === "mcp") await renderDrawerMcp(panel);
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
  const addCheckboxGroup = (title, description, choices, selectedValues, disabledWhen = () => false) => {
    const section = el("section", "agent-editor-section");
    section.appendChild(el("div", "agent-editor-section-title", title));
    section.appendChild(el("div", "muted agent-editor-section-desc", description));
    const grid = el("div", "agent-option-grid");
    if (choices.length === 0) grid.appendChild(el("div", "muted", "（暂无可选项）"));
    for (const choice of choices) {
      const label = el("label", "agent-option");
      const checkbox = document.createElement("input");
      checkbox.type = "checkbox";
      checkbox.value = choice.value;
      checkbox.checked = selectedValues.has(choice.value);
      checkbox.disabled = disabledWhen(choice);
      checkbox.onchange = () => checkbox.checked ? selectedValues.add(choice.value) : selectedValues.delete(choice.value);
      if (checkbox.disabled) label.classList.add("agent-option-disabled");
      label.appendChild(checkbox);
      label.appendChild(el("span", "", choice.label));
      grid.appendChild(label);
    }
    section.appendChild(grid);
    modal.appendChild(section);
  };
  addCheckboxGroup(
    "工具",
    "选择该 Agent 可以直接调用的内置工具。",
    (state.availableTools ?? ["read", "write", "edit", "bash"]).map((tool) => ({ value: tool, label: tool })),
    selectedTools,
  );
  addCheckboxGroup(
    "MCP",
    "选择该 Agent 可以使用的 MCP 服务；已停用的服务不可选择。",
    mcpServers.map(([name, config]) => ({ value: name, label: config.enabled === false ? `${name}（已停用）` : name, config })),
    selectedMcps,
    (choice) => choice.config.enabled === false,
  );
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
async function renderDrawerSkills(panel) {
  panel.innerHTML = `<div class="drawer-loading">加载中…</div>`;
  const render = async () => {
    const { skills } = await (await fetch("/api/skills")).json();
    panel.innerHTML = "";
    const head = el("div", "drawer-section-head");
    head.appendChild(el("h3", "", "📚 Skills"));
    head.appendChild(el("div", "muted", `${skills.length} 个（内置只读，用户可启停）`));
    panel.appendChild(head);
    for (const s of skills) {
      const row = el("div", "drawer-row");
      const left = el("div", "drawer-row-main");
      const title = el("div", "drawer-row-title");
      title.textContent = `${s.source === "builtin" ? "🔒 " : ""}${s.name}`;
      left.appendChild(title);
      const desc = el("div", "muted drawer-row-desc");
      desc.textContent = s.description || "（无描述）";
      left.appendChild(desc);
      const tag = el("span", `tree-tag drawer-tag-${s.source}`);
      tag.textContent = s.source === "builtin" ? "内置" : "用户";
      left.appendChild(tag);
      row.appendChild(left);
      const toggle = document.createElement("input");
      toggle.type = "checkbox";
      toggle.checked = s.enabled;
      toggle.disabled = s.source === "builtin" && !s.wasBuiltin; // 内置且未被用户覆盖 → 只读
      toggle.onchange = async () => {
        await fetch("/api/skills/toggle", {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ name: s.name, enabled: toggle.checked }),
        });
        settingsLoadedTabs.delete("skills"); render();
      };
      row.appendChild(toggle);
      panel.appendChild(row);
    }
  };
  await render();
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
  // 应用偏好
  document.body.classList.toggle("density-compact", prefs.density === "compact");
  document.body.classList.toggle("theme-light", prefs.theme === "light");
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
document.getElementById("fetch-models").onclick = async () => {
  const status = document.getElementById("cfg-status");
  status.className = "form-status";
  status.textContent = "正在获取模型列表…";
  const payload = selectedProviderPayload();
  const r = await fetch("/api/models", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });
  const data = await r.json();
  if (!r.ok) {
    status.className = "form-status err";
    status.textContent = `❌ ${data.error || "获取失败"}`;
    return;
  }
  const meta = cfgProviders.find((p) => p.id === payload.provider);
  meta.models = data.models;
  fillModelList(meta, data.models.includes(payload.modelId) ? payload.modelId : data.models[0] || meta.defaultModel);
  status.className = "form-status ok";
  status.textContent = `✅ 获取到 ${data.models.length} 个模型`;
};
document.getElementById("test-settings").onclick = async () => {
  const status = document.getElementById("cfg-status");
  status.className = "form-status";
  status.textContent = "正在发起真实模型请求…";
  const r = await fetch("/api/settings/test", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(selectedProviderPayload()) });
  const data = await r.json();
  status.className = `form-status ${r.ok ? "ok" : "err"}`;
  status.textContent = r.ok ? `✅ 连接成功 · ${data.provider}/${data.modelId} · ${data.latencyMs}ms` : `❌ ${data.error || "连接失败"}`;
};
document.getElementById("save-settings").onclick = async () => {
  const status = document.getElementById("cfg-status");
  status.className = "form-status";
  status.textContent = "保存中…";
  const payload = selectedProviderPayload();
  const r = await fetch("/api/settings", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  const data = await r.json();
  if (r.ok) {
    status.className = "form-status ok";
    status.textContent = `✅ 已保存 · ${data.effectiveProvider}/${data.modelId}`;
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
const es = new EventSource("/api/events");
es.onmessage = (ev) => {
  state = JSON.parse(ev.data);
  agentsCache = state.agentsByProject ?? {};
  render();
  if (selected?.type === "conversation") {
    const selectedId = selected.id;
    loadConversationDetail(selectedId, { force: true }).then(() => {
      if (selected?.type === "conversation" && selected.id === selectedId) renderView();
    }).catch(() => {});
  }
  updateSseIndicator("ok");
};
es.onerror = () => {
  // EventSource 自带重连；只更新指示器状态
  updateSseIndicator("reconnecting");
};
es.onopen = () => updateSseIndicator("ok");

refresh();
