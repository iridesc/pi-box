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
  document.getElementById("status-bar").textContent =
    `模型 ${m.provider}/${m.modelId} · 会话 ${state.conversations.length} · live 任务 ${Object.keys(state.taskGraph.tasks).length} · 落盘 data/session.sqlite`;
}

// ─── 会话树（ownership 层级）───────────────────────────────────────────────
function renderConversationTree() {
  const nodes = new Map(state.conversations.map((c) => [c.id, { ...c, children: [] }]));
  const roots = [];
  for (const n of nodes.values()) {
    const pid = n.owner ? String(n.owner.conversationId) : null;
    if (pid && nodes.has(pid)) nodes.get(pid).children.push(n);
    else roots.push(n);
  }
  const el = document.getElementById("conversation-tree");
  el.innerHTML = "";
  const renderNode = (n, depth) => {
    const div = document.createElement("div");
    div.className = "conv-node" + (n.id === selectedId ? " selected" : "");
    div.style.paddingLeft = (depth * 16 + 8) + "px";
    div.textContent = `#${n.id} · ${n.entries.length} entries`;
    const tag = document.createElement("span");
    tag.className = "conv-tag";
    const parts = [];
    if (n.project) parts.push(`📁 ${n.project}`);
    parts.push(n.owner ? `owned (task #${n.owner.taskId})` : "top-level");
    tag.textContent = parts.join(" · ");
    div.appendChild(tag);
    div.onclick = () => { selectedId = n.id; render(); };
    el.appendChild(div);
    n.children.forEach((c) => renderNode(c, depth + 1));
  };
  roots.forEach((r) => renderNode(r, 0));
}

// ─── 转录（entries）────────────────────────────────────────────────────────
function messageText(msg) {
  if (!msg || !msg.content) return "";
  return msg.content
    .map((c) => {
      if (c.type === "text") return c.text;
      if (c.type === "toolCall") return `🛠 ${c.name}(${JSON.stringify(c.arguments ?? {})})`;
      return `[${c.type}]`;
    })
    .join("\n");
}

function renderEntries() {
  const conv = state.conversations.find((c) => c.id === selectedId);
  const el = document.getElementById("entries");
  el.innerHTML = "";
  if (!conv) { el.textContent = "（无会话）"; return; }
  const title = document.createElement("div");
  title.className = "entries-title";
  title.textContent = `会话 #${conv.id} 的转录（${conv.entries.length} 条）`;
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

// ─── SSE 实时刷新 ──────────────────────────────────────────────────────────
const es = new EventSource("/api/events");
es.onmessage = (ev) => {
  state = JSON.parse(ev.data);
  render();
};

refresh();
