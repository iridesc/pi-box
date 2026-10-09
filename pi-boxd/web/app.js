// pi-boxd 前端：项目 → 助理 / 子 agent / 会话
// - 左：项目树（助理、子 agent 池、会话）
// - 中：对话 / 助理配置 / agent 编辑器
// - 右：任务图（live task）
let state = null;
// selected = { type: "conversation"|"assistant"|"agent", project, id?, name? }
let selected = null;
let expandedProjects = new Set();
let agentsCache = {}; // project -> agent 列表（来自快照 agentsByProject）
let cfgProviders = [];

function el(tag, className, text) {
  const e = document.createElement(tag);
  if (className) e.className = className;
  if (text !== undefined) e.textContent = text;
  return e;
}

async function refresh() {
  const res = await fetch("/api/state");
  state = await res.json();
  agentsCache = state.agentsByProject ?? {};
  render();
}

function render() {
  renderStatus();
  renderTree();
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
    // 项目行
    const row = el("div", "tree-project");
    const arrow = el("span", "tree-arrow", open ? "▼" : "▶");
    arrow.onclick = (ev) => {
      ev.stopPropagation();
      if (open) expandedProjects.delete(proj);
      else expandedProjects.add(proj);
      render();
    };
    row.appendChild(arrow);
    row.appendChild(el("span", "tree-label", `📁 ${proj}`));
    root.appendChild(row);
    if (!open) continue;

    // 助理
    const assistant = state.assistantByProject?.[proj] ?? { agents: [] };
    const aNode = el("div", "tree-item tree-assistant");
    aNode.style.paddingLeft = "28px";
    const aSel = selected?.type === "assistant" && selected.project === proj;
    if (aSel) aNode.classList.add("selected");
    aNode.appendChild(el("span", "tree-label", "🤖 助理"));
    aNode.onclick = () => {
      selected = { type: "assistant", project: proj };
      render();
    };
    root.appendChild(aNode);

    // 子 agent 组
    const agents = agentsCache[proj] ?? [];
    root.appendChild(el("div", "tree-group", `📁 子 agent（${agents.length}）`));
    for (const a of agents) {
      const n = el("div", "tree-item");
      n.style.paddingLeft = "36px";
      const isSel = selected?.type === "agent" && selected.project === proj && selected.name === a.name;
      if (isSel) n.classList.add("selected");
      n.appendChild(el("span", "tree-label", a.name));
      n.appendChild(el("span", "tree-tag", a.scope === "project" ? "项目" : "全局"));
      n.onclick = () => {
        selected = { type: "agent", project: proj, name: a.name };
        render();
      };
      root.appendChild(n);
    }
    const add = el("div", "tree-item tree-add");
    add.style.paddingLeft = "36px";
    add.appendChild(el("span", "tree-label", "＋ 新建 agent"));
    add.onclick = () => {
      selected = { type: "agent", project: proj, name: null, isNew: true };
      render();
    };
    root.appendChild(add);

    // 会话（主会话 + owned 子会话）
    const convs = state.conversations.filter((c) => c.project === proj);
    root.appendChild(el("div", "tree-group", `💬 会话（${convs.length}）`));
    // 建树
    const byId = new Map(convs.map((c) => [c.id, { ...c, children: [] }]));
    const roots = [];
    for (const c of byId.values()) {
      const pid = c.owner ? String(c.owner.conversationId) : null;
      if (pid && byId.has(pid)) byId.get(pid).children.push(c);
      else roots.push(c);
    }
    const renderConv = (c, depth) => {
      const n = el("div", "tree-item");
      n.style.paddingLeft = 28 + depth * 16 + "px";
      const isSel = selected?.type === "conversation" && selected.id === c.id;
      if (isSel) n.classList.add("selected");
      if (c.children.length > 0) {
        const ar = el("span", "tree-arrow", expandedProjects.has("conv-" + c.id) ? "▼" : "▶");
        ar.onclick = (ev) => {
          ev.stopPropagation();
          const k = "conv-" + c.id;
          if (expandedProjects.has(k)) expandedProjects.delete(k);
          else expandedProjects.add(k);
          render();
        };
        n.appendChild(ar);
      } else {
        n.appendChild(el("span", "tree-arrow", ""));
      }
      n.appendChild(el("span", "tree-label", c.owner ? `#${c.id}` : "主对话"));
      if (c.owner) n.appendChild(el("span", "tree-tag", `task #${c.owner.taskId}`));
      n.onclick = () => {
        selected = { type: "conversation", project: proj, id: c.id };
        render();
      };
      root.appendChild(n);
      if (expandedProjects.has("conv-" + c.id)) c.children.forEach((ch) => renderConv(ch, depth + 1));
    };
    roots.forEach((r) => renderConv(r, 0));
  }
}

// ─── 中：视图 ───────────────────────────────────────────────────────────────
function renderView() {
  const view = document.getElementById("view");
  view.innerHTML = "";
  if (!selected) {
    view.className = "view-empty";
    view.textContent = "pi-box";
    return;
  }
  view.className = "";
  if (selected.type === "conversation") return renderConversation(view);
  if (selected.type === "assistant") return renderAssistantForm(view);
  if (selected.type === "agent") return renderAgentForm(view);
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

function renderConversation(view) {
  const conv = state.conversations.find((c) => c.id === selected.id);
  if (!conv) {
    view.textContent = "（会话已不存在）";
    return;
  }
  const head = el("div", "view-head");
  head.appendChild(el("span", "view-title", conv.owner ? `子会话 #${conv.id}` : `${conv.project} · 主对话`));
  head.appendChild(el("span", "view-sub", conv.owner ? `owned by task #${conv.owner.taskId}` : "项目助理"));
  view.appendChild(head);

  const body = el("div", "view-body");
  for (const e of conv.entries) {
    const div = el("div", "entry entry-" + e.kind.replace(/\./g, "-"));
    div.appendChild(el("div", "entry-kind", e.kind));
    for (const msg of e.model ?? []) {
      const p = el("div", "entry-msg entry-role-" + msg.role);
      p.textContent = messageText(msg);
      div.appendChild(p);
    }
    body.appendChild(div);
  }
  view.appendChild(body);
  body.scrollTop = body.scrollHeight;

  const form = document.createElement("form");
  form.className = "view-input";
  const input = document.createElement("input");
  input.placeholder = "和项目助理对话…";
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
  const agents = agentsCache[proj] ?? [];
  const noKey = !state.hasKey;

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

  // 可派发的子 agent
  form.appendChild(el("div", "form-label", "可派发的子 agent"));
  const box = el("div", "checkbox-box");
  if (agents.length === 0) {
    box.appendChild(el("div", "muted", "（本项目还没有子 agent，先在左侧「子 agent」里新建）"));
  }
  for (const a of agents) {
    const lab = el("label", "checkbox-item");
    const cb = document.createElement("input");
    cb.type = "checkbox";
    cb.value = a.name;
    cb.checked = asst.agents?.includes(a.name) ?? false;
    lab.appendChild(cb);
    lab.appendChild(el("span", "", `${a.name}（${a.scope === "project" ? "项目" : "全局"}）`));
    box.appendChild(lab);
  }
  form.appendChild(box);

  const status = el("div", "form-status", "");
  const save = el("button", "btn-primary", "保存助理配置");
  save.onclick = async () => {
    const checked = [...box.querySelectorAll("input[type=checkbox]:checked")].map((c) => c.value);
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

function renderAgentForm(view) {
  const proj = selected.project;
  const isNew = selected.isNew;
  const existing = isNew ? null : (agentsCache[proj] ?? []).find((a) => a.name === selected.name);

  const head = el("div", "view-head");
  head.appendChild(el("span", "view-title", `📁 ${isNew ? "新建 agent" : selected.name}`));
  view.appendChild(head);

  const form = el("div", "view-form");

  const nameInput = document.createElement("input");
  nameInput.type = "text";
  nameInput.placeholder = "agent 名（字母/数字/-/_）";
  nameInput.value = isNew ? "" : selected.name;
  nameInput.disabled = !isNew;
  form.appendChild(formRow("名称", nameInput));

  const scopeSel = document.createElement("select");
  for (const [v, t] of [["global", "全局库（所有项目共享）"], ["project", `项目专属（${proj}）`]]) {
    const o = document.createElement("option");
    o.value = v;
    o.textContent = t;
    scopeSel.appendChild(o);
  }
  scopeSel.value = existing?.scope === "project" ? "project" : "global";
  scopeSel.disabled = !isNew;
  form.appendChild(formRow("存放位置", scopeSel));

  const modelInput = document.createElement("input");
  modelInput.type = "text";
  modelInput.placeholder = "可选，如 deepseek-flash 或 provider/modelId";
  modelInput.value = existing?.model ?? "";
  form.appendChild(formRow("模型", modelInput));

  const toolsInput = document.createElement("input");
  toolsInput.type = "text";
  toolsInput.placeholder = "可选，逗号分隔，如 read, bash";
  toolsInput.value = (existing?.tools ?? []).join(", ");
  form.appendChild(formRow("工具", toolsInput));

  form.appendChild(el("div", "form-label", "提示词（instructions）"));
  const ta = document.createElement("textarea");
  ta.className = "cfg-textarea";
  ta.rows = 10;
  ta.value = existing?.instructions ?? "";
  form.appendChild(ta);

  const status = el("div", "form-status", "");
  const bar = el("div", "form-actions");

  const save = el("button", "btn-primary", "保存");
  save.onclick = async () => {
    const name = isNew ? nameInput.value.trim() : selected.name;
    if (!name) {
      status.className = "form-status err";
      status.textContent = "❌ 需要名称";
      return;
    }
    const tools = toolsInput.value.trim() ? toolsInput.value.split(",").map((s) => s.trim()).filter(Boolean) : null;
    const res = await fetch("/api/agents", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        project: proj,
        name,
        scope: scopeSel.value,
        model: modelInput.value.trim() || null,
        tools,
        instructions: ta.value,
      }),
    });
    if (res.ok) {
      selected = { type: "agent", project: proj, name };
      await refresh();
      status.className = "form-status ok";
      status.textContent = "✅ 已保存";
    } else {
      status.className = "form-status err";
      status.textContent = "❌ " + ((await res.json()).error || "保存失败");
    }
  };
  bar.appendChild(save);

  if (!isNew) {
    const del = el("button", "btn-danger", "删除");
    del.onclick = async () => {
      if (!confirm(`删除 agent "${selected.name}"？`)) return;
      await fetch("/api/agents/delete", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ project: proj, name: selected.name, scope: scopeSel.value }),
      });
      selected = null;
      await refresh();
    };
    bar.appendChild(del);
  }
  bar.appendChild(status);
  form.appendChild(bar);
  view.appendChild(form);
}

// ─── 右：任务图 ─────────────────────────────────────────────────────────────
function renderTaskGraph() {
  const tasks = Object.values(state.taskGraph.tasks);
  const elx = document.getElementById("task-graph");
  elx.innerHTML = "";
  const renderNode = (node, depth) => {
    const div = el("div", "task-node");
    div.style.paddingLeft = depth * 16 + 8 + "px";
    const st = node.state;
    const status = st.status === "waiting" ? `waiting on ${st.on.join(",")}` : st.status;
    div.innerHTML = `<span class="task-kind">${node.kind}</span> #${node.id} <span class="task-status">[${status}${node.background ? " · bg" : ""}]</span>`;
    elx.appendChild(div);
    for (const child of tasks.filter((t) => String(t.owner) === String(node.id))) renderNode(child, depth + 1);
  };
  for (const node of tasks.filter((t) => t.owner === undefined || t.owner === null)) renderNode(node, 0);
  if (tasks.length === 0) elx.textContent = "（无运行中任务）";
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
  selected = { type: "conversation", project: name, id: String(data.conversationId) };
  refresh();
};

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

async function openSettings() {
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
    sel.onchange = () => {
      const meta = cfgProviders.find((p) => p.id === sel.value);
      if (meta) {
        fillModelList(meta, meta.defaultModel);
        document.getElementById("cfg-baseurl").value = meta.defaultBaseUrl || "";
      }
    };
  }
  const cfg = await (await fetch("/api/settings")).json();
  document.getElementById("cfg-provider").value = cfg.provider;
  const cur = cfgProviders.find((p) => p.id === cfg.provider);
  if (cur) fillModelList(cur, cfg.modelId);
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
};

refresh();
