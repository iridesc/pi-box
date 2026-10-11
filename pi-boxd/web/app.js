// pi-boxd 前端：项目 → 助理 / 子 agent
// - 左：项目树（唯一主会话入口、子 agent 池）
// - 中：对话 / 助理配置 / agent 编辑器
// - 右：任务图（live task）
let state = null;
// selected = { type: "conversation"|"assistant"|"agent", project, id?, name? }
let selected = null;
let expandedProjects = new Set();
let agentsCache = {}; // project -> agent 列表（来自快照 agentsByProject）
let cfgProviders = [];
let cfgSettings = { activeProvider: "openai", providers: {} };
const MASKED_API_KEY = "********";

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
      else {
        expandedProjects.add(proj);
        // 项目首次展开时，默认展开子 Agent 分组。
        expandedProjects.add(`agents-${proj}`);
      }
      render();
    };
    row.appendChild(arrow);
    row.appendChild(el("span", "tree-label", `📁 ${proj}`));
    const projectSettings = el("button", "tree-settings", "⚙");
    projectSettings.type = "button";
    projectSettings.title = "修改项目名称";
    projectSettings.setAttribute("aria-label", `设置项目 ${proj}`);
    projectSettings.onclick = (ev) => {
      ev.stopPropagation();
      selected = { type: "project", project: proj };
      render();
    };
    row.appendChild(projectSettings);
    if (selected?.type === "project" && selected.project === proj) row.classList.add("selected");
    root.appendChild(row);
    if (!open) continue;

    // 助理
    const mainConversation = state.conversations.find((c) => c.project === proj && !c.owner);
    const aNode = el("div", "tree-item tree-assistant");
    aNode.classList.add("tree-level-1");
    const aSel = selected?.type === "conversation" && selected.id === mainConversation?.id;
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
      render();
    };
    aNode.appendChild(assistantSettings);
    aNode.onclick = () => {
      if (!mainConversation) return;
      selected = { type: "conversation", project: proj, id: mainConversation.id };
      render();
    };
    root.appendChild(aNode);

    // 子 agent 组
    const agents = agentsCache[proj] ?? [];
    const agentsKey = `agents-${proj}`;
    const agentsOpen = expandedProjects.has(agentsKey);
    const agentsGroup = el("div", "tree-item tree-section tree-level-1");
    agentsGroup.appendChild(el("span", "tree-arrow", agentsOpen ? "▼" : "▶"));
    agentsGroup.appendChild(el("span", "tree-label", `📁 子 Agent（${agents.length}）`));
    agentsGroup.onclick = () => {
      if (agentsOpen) expandedProjects.delete(agentsKey);
      else expandedProjects.add(agentsKey);
      render();
    };
    root.appendChild(agentsGroup);
    if (agentsOpen) {
      for (const a of agents) {
        const n = el("div", "tree-item tree-level-2");
        const isSel = selected?.type === "agent" && selected.project === proj && selected.name === a.name;
        if (isSel) n.classList.add("selected");
        n.appendChild(el("span", "tree-arrow", ""));
        n.appendChild(el("span", "tree-label", `📄 ${a.name}`));
        const agentSettings = el("button", "tree-settings", "⚙");
        agentSettings.type = "button";
        agentSettings.title = "Agent 设置";
        agentSettings.setAttribute("aria-label", `设置 Agent ${a.name}`);
        agentSettings.onclick = (ev) => {
          ev.stopPropagation();
          selected = { type: "agent", project: proj, name: a.name };
          render();
        };
        n.appendChild(agentSettings);
        n.appendChild(el("span", "tree-tag", a.scope === "project" ? "项目" : "全局"));
        n.onclick = () => {
          selected = { type: "agent", project: proj, name: a.name };
          render();
        };
        root.appendChild(n);
      }
      const add = el("div", "tree-item tree-add tree-level-2");
      add.appendChild(el("span", "tree-arrow", ""));
      add.appendChild(el("span", "tree-label", "＋ 新建 Agent"));
      add.onclick = () => {
        selected = { type: "agent", project: proj, name: null, isNew: true };
        render();
      };
      root.appendChild(add);
    }

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
  if (selected.type === "project") return renderProjectForm(view);
  if (selected.type === "conversation") return renderConversation(view);
  if (selected.type === "assistant") return renderAssistantForm(view);
  if (selected.type === "agent") return renderAgentForm(view);
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
    const agentsWasOpen = expandedProjects.has(`agents-${oldName}`);
    expandedProjects.delete(oldName);
    expandedProjects.delete(`agents-${oldName}`);
    expandedProjects.add(newName);
    if (agentsWasOpen) expandedProjects.add(`agents-${newName}`);
    selected = { type: "project", project: newName };
    await refresh();
  };
  const bar = el("div", "form-actions");
  bar.appendChild(save);
  bar.appendChild(status);
  form.appendChild(bar);
  view.appendChild(form);
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

function openAgentToolsPicker(selectedTools, onConfirm) {
  const modal = document.getElementById("agent-tools-modal");
  const options = document.getElementById("agent-tools-options");
  options.innerHTML = "";
  for (const tool of state.availableTools ?? ["read", "write", "edit", "bash"]) {
    const label = el("label", "checkbox-item");
    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    checkbox.value = tool;
    checkbox.checked = selectedTools.has(tool);
    label.appendChild(checkbox);
    label.appendChild(el("span", "", tool));
    options.appendChild(label);
  }
  const close = () => modal.classList.add("hidden");
  document.getElementById("close-agent-tools").onclick = close;
  document.getElementById("cancel-agent-tools").onclick = close;
  document.getElementById("confirm-agent-tools").onclick = () => {
    onConfirm(new Set([...options.querySelectorAll("input:checked")].map((input) => input.value)));
    close();
  };
  modal.onclick = (event) => { if (event.target === modal) close(); };
  modal.classList.remove("hidden");
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
  nameInput.placeholder = "Agent 名（支持中文、字母、数字、-、_）";
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

  const modelSelect = document.createElement("select");
  populateAgentModelSelect(modelSelect, existing?.model ?? "");
  form.appendChild(formRow("模型", modelSelect));

  let selectedTools = new Set(existing ? (existing.tools ?? state.availableTools ?? []) : ["read", "bash"]);
  const toolsField = el("div", "field-with-button");
  const toolsSummary = document.createElement("input");
  toolsSummary.type = "text";
  toolsSummary.readOnly = true;
  const updateToolsSummary = () => {
    toolsSummary.value = [...selectedTools].join(", ");
    toolsSummary.placeholder = "未选择工具";
  };
  updateToolsSummary();
  const chooseTools = el("button", "btn-secondary", "选择…");
  chooseTools.type = "button";
  chooseTools.onclick = () => openAgentToolsPicker(selectedTools, (next) => {
    selectedTools = next;
    updateToolsSummary();
  });
  toolsField.appendChild(toolsSummary);
  toolsField.appendChild(chooseTools);
  form.appendChild(formRow("工具", toolsField));

  form.appendChild(el("div", "form-label", "提示词（instructions）"));
  const ta = document.createElement("textarea");
  ta.className = "cfg-textarea";
  ta.rows = 10;
  ta.value = existing?.instructions || (isNew ? "你是一个专注、可靠的子 Agent。请根据收到的任务完成工作，并返回简洁、准确的结果。" : "");
  ta.required = true;
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
    const instructions = ta.value.trim();
    if (!instructions) {
      status.className = "form-status err";
      status.textContent = "❌ 提示词不能为空";
      ta.focus();
      return;
    }
    const tools = [...selectedTools];
    const res = await fetch("/api/agents", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        project: proj,
        name,
        scope: scopeSel.value,
        model: modelSelect.value || null,
        tools,
        instructions,
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
  expandedProjects.add(`agents-${name}`);
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
};

refresh();
