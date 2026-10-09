// pi-durable-web 前端：连 /api/state 拿快照、/api/events 走 SSE 实时刷新，
// 把 conversation（会话树）/ task（任务图）/ ownership（缩进层级）原始渲染出来。
let state = null;
let selectedId = null;

async function refresh() {
  const res = await fetch("/api/state");
  state = await res.json();
  if (!selectedId && state.conversations.length > 0) selectedId = state.conversations[0].id;
  render();
}

function render() {
  renderStatus();
  renderConversationTree();
  renderEntries();
  renderTaskGraph();
  renderDispatchForm();
}

function renderStatus() {
  const m = state.model;
  const noKey = !state.hasKey;
  const noKeyText = noKey ? " · ⚠ 未配置 API Key" : "";
  document.getElementById("status-bar").innerHTML =
    `模型 <b style="color:#58a6ff">${m.provider}/${m.modelId}</b> · 会话 ${state.conversations.length} · live 任务 ${Object.keys(state.taskGraph.tasks).length}${noKeyText}`;
  lockIfNoKey();
}

function lockIfNoKey() {
  const noKey = !state.hasKey;
  // 新会话按钮
  document.getElementById("new-conv").disabled = noKey;
  // submit 表单
  const submitForm = document.getElementById("submit-form");
  const submitInput = document.getElementById("submit-input");
  submitInput.disabled = noKey;
  submitForm.querySelector("button").disabled = noKey;
  // 派发表单
  const dTask = document.getElementById("dispatch-task");
  const dGo = document.getElementById("dispatch-go");
  if (dTask) dTask.disabled = noKey;
  if (dGo) dGo.disabled = noKey || !document.getElementById("dispatch-agent").value;
}

// ─── 会话树（ownership 层级）───────────────────────────────────────────────
function renderConversationTree() {
  const el = document.getElementById("conversation-tree");
  el.innerHTML = "";
  const renderNode = (n, depth, nodes) => {
    const div = document.createElement("div");
    div.className = "conv-node" + (n.id === selectedId ? " selected" : "");
    div.style.paddingLeft = depth * 16 + 8 + "px";
    div.textContent = `#${n.id} · ${n.entries.length} entries`;
    const tag = document.createElement("span");
    tag.className = "conv-tag";
    tag.textContent = n.owner ? `owned (task #${n.owner.taskId})` : "top-level";
    div.appendChild(tag);
    div.onclick = () => {
      selectedId = n.id;
      render();
    };
    el.appendChild(div);
    n.children.forEach((c) => renderNode(c, depth + 1, nodes));
  };
  // 组内按 ownership 建树
  const buildTree = (convs) => {
    const nodes = new Map(convs.map((c) => [c.id, { ...c, children: [] }]));
    const roots = [];
    for (const n of nodes.values()) {
      const pid = n.owner ? String(n.owner.conversationId) : null;
      if (pid && nodes.has(pid)) nodes.get(pid).children.push(n);
      else roots.push(n);
    }
    return { roots, nodes };
  };

  const conversations = state.conversations;
  const hasProjects = conversations.some((c) => c.project);
  if (!hasProjects) {
    // 无 project 概念（纯 durable 页）→ 平铺
    const { roots, nodes } = buildTree(conversations);
    roots.forEach((r) => renderNode(r, 0, nodes));
    return;
  }
  // 按 project 分组（项目作为第一层）
  const groups = new Map();
  for (const c of conversations) {
    const key = c.project || "（无项目）";
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(c);
  }
  for (const [proj, convs] of groups) {
    const head = document.createElement("div");
    head.className = "project-group";
    head.textContent = `📁 ${proj}`;
    el.appendChild(head);
    const { roots, nodes } = buildTree(convs);
    roots.forEach((r) => renderNode(r, 1, nodes));
  }
}

// ─── 转录（entries）────────────────────────────────────────────────────────
function messageText(msg) {
  if (!msg) return "";
  // 模型错误（如额度用尽、认证失败）——直接展示 errorMessage
  if (msg.errorMessage) return `❌ ${msg.errorMessage}`;
  const c = msg.content;
  // user message 的 content 是字符串
  if (typeof c === "string") return c;
  // 空/缺失 content：非正常结束时提示 stopReason
  if (c === undefined || c === null || (Array.isArray(c) && c.length === 0)) {
    if (msg.stopReason && !["endTurn", "stop", "toolUse"].includes(msg.stopReason)) {
      return `[${msg.stopReason}]`;
    }
    return "";
  }
  // assistant/tool 的 content 是数组
  if (Array.isArray(c)) {
    return c
      .map((part) => {
        if (part == null) return "";
        if (part.type === "text") return part.text ?? "";
        if (part.type === "thinking") return `[thinking] ${part.thinking ?? ""}`.slice(0, 500);
        if (part.type === "toolCall") return `🛠 ${part.name}(${JSON.stringify(part.arguments ?? {})})`;
        if (part.type === "toolResult") return `[result] ${JSON.stringify(part.content ?? part).slice(0, 500)}`;
        return `[${part.type}]`;
      })
      .join("\n");
  }
  return String(c);
}

function renderEntries() {
  const conv = state.conversations.find((c) => c.id === selectedId);
  const el = document.getElementById("entries");
  el.innerHTML = "";
  if (!conv) { el.textContent = "（无会话）"; return; }
  const title = document.createElement("div");
  title.className = "entries-title";
  title.textContent = `会话 #${conv.id} 的消息（${conv.entries.length} 条）`;
  el.appendChild(title);
  for (const e of conv.entries) {
    const div = document.createElement("div");
    div.className = "entry entry-" + e.kind.replace(/\./g, "-");
    const kind = document.createElement("div");
    kind.className = "entry-kind";
    kind.textContent = e.kind;
    div.appendChild(kind);
    for (const msg of e.model ?? []) {
      const p = document.createElement("div");
      p.className = "entry-msg entry-role-" + msg.role;
      p.textContent = messageText(msg);
      div.appendChild(p);
    }
    el.appendChild(div);
  }
  el.scrollTop = el.scrollHeight;
}

// ─── 任务图（task 状态机）──────────────────────────────────────────────────
function renderTaskGraph() {
  const tasks = Object.values(state.taskGraph.tasks);
  const el = document.getElementById("task-graph");
  el.innerHTML = "";
  const renderNode = (node, depth) => {
    const div = document.createElement("div");
    div.className = "task-node";
    div.style.paddingLeft = (depth * 16 + 8) + "px";
    const st = node.state;
    const status = st.status === "waiting" ? `waiting on ${st.on.join(",")}` : st.status;
    div.innerHTML =
      `<span class="task-kind">${node.kind}</span> #${node.id} ` +
      `<span class="task-status">[${status}${node.background ? " · background" : ""}]</span>`;
    el.appendChild(div);
    for (const child of tasks.filter((t) => String(t.owner) === String(node.id))) renderNode(child, depth + 1);
  };
  for (const node of tasks.filter((t) => t.owner === undefined || t.owner === null)) renderNode(node, 0);
  if (tasks.length === 0) el.textContent = "（无 live 任务）";
}

// ─── 交互 ──────────────────────────────────────────────────────────────────
document.getElementById("submit-form").onsubmit = async (ev) => {
  ev.preventDefault();
  const input = document.getElementById("submit-input");
  const content = input.value.trim();
  if (!content || !selectedId) return;
  input.value = "";
  await fetch("/api/submit", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ conversationId: selectedId, content }),
  });
};

document.getElementById("new-conv").onclick = async () => {
  const res = await fetch("/api/conversations", { method: "POST" });
  const { id } = await res.json();
  selectedId = String(id);
  refresh();
};

document.getElementById("demo-task").onclick = async () => {
  await fetch("/api/demo-task", { method: "POST" });
};

// ─── Agent 派发表单 ───────────────────────────────────────────────────────────
// dispatchState 存当前已加载的 agent 列表
let dispatchAgents = [];
let cfgProviders = []; // provider 列表（从 /api/providers 加载，弹窗打开时填）

function renderDispatchForm() {
  const projectSel = document.getElementById("dispatch-project");
  const agentSel = document.getElementById("dispatch-agent");
  const taskInput = document.getElementById("dispatch-task");
  const goBtn = document.getElementById("dispatch-go");
  // 只在 projects 变化时重填（避免每次 render 都重置选择）
  if (projectSel.options.length <= 1) {
    for (const p of state.projects) {
      const opt = document.createElement("option");
      opt.value = p;
      opt.textContent = p;
      projectSel.appendChild(opt);
    }
  }
  agentSel.onchange = () => {
    taskInput.disabled = !agentSel.value;
    goBtn.disabled = !agentSel.value;
  };
  projectSel.onchange = async () => {
    agentSel.innerHTML = '<option value="">加载中…</option>';
    agentSel.disabled = true;
    taskInput.disabled = true;
    goBtn.disabled = true;
    if (!projectSel.value) {
      agentSel.innerHTML = '<option value="">— 先选项目 —</option>';
      return;
    }
    const res = await fetch(`/api/agents?project=${encodeURIComponent(projectSel.value)}`);
    const { agents } = await res.json();
    dispatchAgents = agents;
    agentSel.innerHTML = '<option value="">— 选择 agent —</option>';
    for (const a of agents) {
      const opt = document.createElement("option");
      opt.value = a.name;
      const hint = a.model ? ` (${a.model})` : "";
      opt.textContent = `${a.name}${hint}`;
      agentSel.appendChild(opt);
    }
    agentSel.disabled = false;
  };
  goBtn.onclick = async () => {
    const project = projectSel.value;
    const agent = agentSel.value;
    const task = taskInput.value.trim();
    if (!project || !agent || !task) return;
    const status = document.getElementById("dispatch-status");
    goBtn.disabled = true;
    status.textContent = " 派发中…";
    try {
      const res = await fetch("/api/delegate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ project, agent, task }),
      });
      const data = await res.json();
      if (res.ok) {
        status.textContent = ` ✅ 已派发 → 会话 #${data.conversationId}`;
        taskInput.value = "";
        selectedId = String(data.conversationId);
        refresh();
      } else {
        status.textContent = ` ❌ ${data.error}`;
      }
    } finally {
      goBtn.disabled = false;
    }
  };
}

// ─── 设置弹窗 ───────────────────────────────────────────────────────────────────────
function fillModelList(meta, selected) {
  const sel = document.getElementById("cfg-model");
  sel.innerHTML = "";
  const models = meta.models || [];
  // 当前值不在列表时也加进去（避免被覆盖）
  const list = selected && !models.includes(selected) ? [selected, ...models] : models;
  for (const m of list) {
    const o = document.createElement("option");
    o.value = m;
    o.textContent = m;
    sel.appendChild(o);
  }
  if (selected) sel.value = selected;
}

async function openSettings() {
  // 加载 provider 列表
  if (cfgProviders.length === 0) {
    const r = await fetch("/api/providers");
    const d = await r.json();
    cfgProviders = d.providers;
    const sel = document.getElementById("cfg-provider");
    sel.innerHTML = "";
    for (const p of cfgProviders) {
      const o = document.createElement("option");
      o.value = p.id;
      o.textContent = p.name;
      sel.appendChild(o);
    }
    sel.onchange = () => {
      const meta = cfgProviders.find((p) => p.id === sel.value);
      if (meta) {
        fillModelList(meta, meta.defaultModel);
        document.getElementById("cfg-baseurl").value = meta.defaultBaseUrl || "";
      }
    };
  }
  // 加载当前配置
  const r = await fetch("/api/settings");
  const cfg = await r.json();
  document.getElementById("cfg-provider").value = cfg.provider;
  // 当前 provider 的模型列表 + 选中当前模型
  const current = cfgProviders.find((p) => p.id === cfg.provider);
  if (current) fillModelList(current, cfg.modelId);
  document.getElementById("cfg-baseurl").value = cfg.baseUrl || "";
  document.getElementById("cfg-key").value = "";
  document.getElementById("cfg-key").placeholder = cfg.hasKey ? "未改动时留空保留原 key" : "填入你的 API Key";
  document.getElementById("cfg-status").textContent = "";
  document.getElementById("settings-modal").classList.remove("hidden");
}

function closeSettings() {
  document.getElementById("settings-modal").classList.add("hidden");
}

document.getElementById("open-settings").onclick = openSettings;
document.getElementById("close-settings").onclick = closeSettings;
document.getElementById("settings-modal").onclick = (ev) => {
  if (ev.target.id === "settings-modal") closeSettings();
};
document.getElementById("save-settings").onclick = async () => {
  const status = document.getElementById("cfg-status");
  status.className = "form-status";
  status.textContent = "保存中…";
  const payload = {
    provider: document.getElementById("cfg-provider").value,
    modelId: document.getElementById("cfg-model").value,
    apiKey: document.getElementById("cfg-key").value || undefined,
    baseUrl: document.getElementById("cfg-baseurl").value,
  };
  const r = await fetch("/api/settings", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  const data = await r.json();
  if (r.ok) {
    status.className = "form-status success";
    status.textContent = `✅ 已保存 · ${data.provider}/${data.modelId} · hasKey=${data.hasKey}`;
    setTimeout(() => {
      closeSettings();
      refresh();
    }, 600);
  } else {
    status.className = "form-status error";
    status.textContent = `❌ ${data.error || "保存失败"}`;
  }
};

// ─── SSE 实时刷新 ──────────────────────────────────────────────────────────
const es = new EventSource("/api/events");
es.onmessage = (ev) => {
  state = JSON.parse(ev.data);
  render();
};

refresh();
