// pi-boxd 前端：项目 → 助理 / 子 agent
// - 左：项目树（唯一主会话入口、子 agent 池）
// - 中：对话 / 助理配置 / agent 编辑器
// - 右：任务图（live task）
let state = null;
// selected = { type: "conversation"|"assistant"|"agent", project, id?, name? }
let selected = null;
let expandedProjects = new Set();
let agentsCache = {}; // project -> agent 列表（来自快照 agentsByProject）
let agentsStatus = {}; // project -> { name: { status, conversationId } }，实时
let schedulesCache = {}; // project -> schedule 列表
let cfgProviders = [];
let cfgSettings = { activeProvider: "openai", providers: {} };
const MASKED_API_KEY = "********";

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

    // 子 agent：直接挂在项目下，不再有折叠组（需求：随时看到圆点状态）
    const agents = agentsCache[proj] ?? [];
    const projStatus = agentsStatus[proj] ?? {};
    // 子 Agent 区域与新建入口始终存在，空项目也必须能创建第一个 Agent。
    const sep = el("div", "tree-sep");
    sep.appendChild(el("span", "tree-sep-label", "子 Agent"));
    const addAgent = el("button", "tree-sep-add", "＋");
    addAgent.type = "button";
    addAgent.title = "新建 Agent";
    addAgent.setAttribute("aria-label", `在 ${proj} 中新建 Agent`);
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
      const isSel = selected?.type === "conversation" && selected.id === projStatus[a.name]?.conversationId;
      if (isSel) n.classList.add("selected");

      // 圆点
      const status = projStatus[a.name]?.status ?? "unknown";
      const dot = el("span", `agent-dot agent-dot-${status}`);
      dot.title = `状态：${agentStatusLabel(status)}`;
      n.appendChild(dot);
      n.appendChild(el("span", "tree-arrow", ""));
      const avatar = el("span", `agent-avatar agent-avatar-${a.scope}`, "🤖");
      avatar.title = a.scope === "global" ? "全局 Agent" : "项目 Agent";
      n.appendChild(avatar);
      n.appendChild(el("span", "tree-label", a.name));

      // 配置入口：name 后的 ⚙ 小按钮
      const agentSettings = el("button", "tree-settings", "⚙");
      agentSettings.type = "button";
      agentSettings.title = "Agent 配置";
      agentSettings.setAttribute("aria-label", `配置 Agent ${a.name}`);
      agentSettings.onclick = (ev) => {
        ev.stopPropagation();
        openAgentEditor({ scope: a.scope, project: a.scope === "project" ? proj : null, existing: a });
      };
      n.appendChild(agentSettings);
      n.appendChild(el("span", "tree-tag", a.scope === "project" ? "项目" : "全局"));

      // 单击名字：切到子 agent 聊天框（未启动则提示）
      n.onclick = () => {
        const s = projStatus[a.name];
        if (!s || !s.conversationId) {
          flashHint(n, "该 agent 尚未启动，需主助理派任务时才会被创建");
          return;
        }
        selected = { type: "conversation", project: proj, id: s.conversationId, isAgent: a.name };
        render();
      };
      root.appendChild(n);
    }

    // 项目级定时任务：和助理、子 Agent 同属项目一级能力。
    const scheduleSep = el("div", "tree-sep tree-schedule-head");
    const scheduleLabel = el("span", "tree-sep-label", "定时任务");
    scheduleLabel.onclick = () => {
      selected = { type: "schedules", project: proj };
      render();
    };
    scheduleSep.appendChild(scheduleLabel);
    const addSchedule = el("button", "tree-sep-add", "＋");
    addSchedule.type = "button";
    addSchedule.title = "新建定时任务";
    addSchedule.onclick = (event) => {
      event.stopPropagation();
      openScheduleEditor(proj);
    };
    scheduleSep.appendChild(addSchedule);
    if (selected?.type === "schedules" && selected.project === proj) scheduleSep.classList.add("selected");
    root.appendChild(scheduleSep);
    const schedules = schedulesCache[proj] ?? [];
    if (schedules.length === 0) root.appendChild(el("div", "tree-agent-empty tree-level-2", "暂无定时任务"));
    for (const schedule of schedules) {
      const node = el("div", "tree-item tree-level-2");
      node.appendChild(el("span", schedule.enabled ? "schedule-dot schedule-dot-on" : "schedule-dot", ""));
      node.appendChild(el("span", "tree-label", `⏱ ${schedule.name}`));
      const settings = el("button", "tree-settings", "⚙");
      settings.type = "button";
      settings.title = "编辑定时任务";
      settings.onclick = (event) => {
        event.stopPropagation();
        openScheduleEditor(proj, schedule);
      };
      node.appendChild(settings);
      node.onclick = () => {
        selected = { type: "schedules", project: proj, scheduleId: schedule.id };
        render();
      };
      root.appendChild(node);
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
  if (selected.type === "schedules") return renderSchedules(view);
}

function formatDateTime(value) {
  if (!value) return "—";
  try { return new Date(value).toLocaleString("zh-CN", { hour12: false }); } catch { return value; }
}

function timezoneLabel(value) {
  return ({ "Asia/Shanghai": "北京时间", "Asia/Tokyo": "东京时间", "Europe/London": "伦敦时间", "America/New_York": "纽约时间", UTC: "协调世界时" })[value] || value;
}

async function reloadSchedules(project) {
  const response = await fetch(`/api/schedules?project=${encodeURIComponent(project)}`);
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || "读取定时任务失败");
  schedulesCache[project] = data.schedules ?? [];
  if (state) state.schedulesByProject = schedulesCache;
  return data;
}

async function renderSchedules(view) {
  const project = selected.project;
  const head = el("div", "view-head");
  head.appendChild(el("span", "view-title", `⏱ ${project} · 定时任务`));
  const add = el("button", "btn-primary schedule-head-action", "＋ 新建定时任务");
  add.onclick = () => openScheduleEditor(project);
  head.appendChild(add);
  view.appendChild(head);

  const body = el("div", "view-form schedule-list");
  body.appendChild(el("div", "muted schedule-intro", "到点后向项目助理提交一次任务；助理可以调用项目中全部已启用的子 Agent。"));
  view.appendChild(body);
  try {
    const data = await reloadSchedules(project);
    body.querySelectorAll(".schedule-card, .schedule-empty").forEach((node) => node.remove());
    if (data.schedules.length === 0) {
      body.appendChild(el("div", "schedule-empty", "还没有定时任务。点击“新建定时任务”开始配置。"));
      return;
    }
    for (const schedule of data.schedules) {
      const card = el("div", "schedule-card");
      if (selected.scheduleId === schedule.id) card.classList.add("selected");
      const title = el("div", "schedule-card-title");
      title.appendChild(el("span", schedule.enabled ? "schedule-badge enabled" : "schedule-badge", schedule.enabled ? "已启用" : "已停用"));
      title.appendChild(el("strong", "", schedule.name));
      card.appendChild(title);
      card.appendChild(el("div", "schedule-cron", schedule.description || "自定义时间规则"));
      card.appendChild(el("div", "muted schedule-timezone", `时区：${timezoneLabel(schedule.timezone)}（${schedule.timezone}）`));
      card.appendChild(el("div", "schedule-prompt", schedule.prompt));
      card.appendChild(el("div", "muted", `上次触发：${formatDateTime(schedule.lastRunAt)}　下次执行：${formatDateTime(schedule.nextRunAt)}`));
      const actions = el("div", "schedule-actions");
      const run = el("button", "btn-secondary", "立即运行");
      run.onclick = async () => {
        run.disabled = true;
        run.textContent = "提交中…";
        const response = await fetch("/api/schedules/run", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ project, id: schedule.id }) });
        const result = await response.json();
        run.disabled = false;
        run.textContent = response.ok ? "已提交给助理" : `失败：${result.error || "未知错误"}`;
        if (response.ok) setTimeout(() => render(), 800);
      };
      const edit = el("button", "btn-secondary", "编辑");
      edit.onclick = () => openScheduleEditor(project, schedule);
      actions.append(run, edit);
      card.appendChild(actions);
      body.appendChild(card);
    }
  } catch (error) {
    body.appendChild(el("div", "form-status err", `❌ ${error.message}`));
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
  modal.appendChild(el("div", "muted", "触发后进入项目主会话；助理可自行派发任意已启用的子 Agent。"));
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
      body: JSON.stringify({ project, id: existing?.id, name: name.value, rule: readRule(), timezone: timezone.value, enabled: enabled.checked, prompt: prompt.value }),
    });
    const result = await response.json();
    save.disabled = false;
    if (!response.ok) {
      status.className = "form-status err";
      status.textContent = `❌ ${result.error || "保存失败"}`;
      return;
    }
    overlay.remove();
    selected = { type: "schedules", project, scheduleId: result.schedule.id };
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
  view.appendChild(form);
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

function renderConversation(view) {
  const conv = state.conversations.find((c) => c.id === selected.id);
  if (!conv) {
    view.textContent = "（会话已不存在）";
    return;
  }
  const isAgentView = selected.isAgent !== undefined; // 从子 agent 节点点进来
  const title = isAgentView
    ? `🤖 子 Agent · ${selected.isAgent}（会话 #${conv.id}）`
    : conv.owner
      ? `子会话 #${conv.id}`
      : `${conv.project} · 主对话`;
  const sub = isAgentView
    ? `由项目 ${conv.project} 助理派发 · task #${conv.owner?.taskId ?? "—"}`
    : conv.owner
      ? `owned by task #${conv.owner.taskId}`
      : "项目助理";
  const head = el("div", "view-head");
  head.appendChild(el("span", "view-title", title));
  head.appendChild(el("span", "view-sub", sub));
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
  input.placeholder = isAgentView ? `和子 Agent ${selected.isAgent} 对话…` : "和项目助理对话…";
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
  // 子 Agent 永远展开，无需 agents-${name} 标记。
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
  const { agents } = await (await fetch("/api/global-agents")).json();
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
}

async function openAgentEditor({ scope, project = null, existing = null, onSaved = null }) {
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
  agentsStatus = state.agentsStatus ?? {};
  render();
  updateSseIndicator("ok");
};
es.onerror = () => {
  // EventSource 自带重连；只更新指示器状态
  updateSseIndicator("reconnecting");
};
es.onopen = () => updateSseIndicator("ok");

refresh();
