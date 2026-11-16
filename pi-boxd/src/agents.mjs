// agent 定义 / 助理 / 项目扫描
// 配置形态（文件即真相）：
//   全局 agent 库   <WORKSPACE>/.pi-box/agents/<name>.md     —— 共享模板
//   项目覆盖        <PROJECTS_DIR>/<project>/.pi/agents/<name>.md
//   项目助理        <PROJECTS_DIR>/<project>/.pi/assistant.md   —— prompt + agents:[引用列表]
//   元项目（meta）   <META_DIR>/assistant.md + <META_DIR>/agents/<name>.md
//                   —— 平台管理员，身份特殊，业务项目助理看不到这里的子 agent
// 加载链：项目内同名优先 → 全局库兜底
import { readdir, readFile, writeFile, mkdir, unlink, rename, stat } from "node:fs/promises";
import { basename, join, dirname } from "node:path";
import { PROJECTS_DIR, GLOBAL_AGENTS_DIR, META_PROJECT, META_DIR, META_AGENTS_DIR } from "./paths.mjs";
import { models, currentModel, resolveModelRef } from "./model.mjs";
import { CodingTools } from "@earendil-works/pi-durable/tools";

/** 内置工具（CodingTools）：名字允许写进 tools，且严格校验，写错即报错。 */
const BUILTIN_TOOL_BY_NAME = new Map((CodingTools.tools ?? []).map((tool) => [tool.name, tool]));

/** 运行时扩展工具目录（报告 / 系统 / 高级 / MCP），由 harness 装好扩展后注入。
 *  为什么必须注入而不是从 CodingTools 读：registry 是运行时的，本模块是纯逻辑模块。 */
let extensionToolByName = new Map();   // name → { tool, group }
let extensionGroups = [];              // [{ name, tools: [name...] }]，保持稳定顺序
let mcpToolsByServer = new Map();
let mcpSupportTools = [];
let assistantRequiredTools = [];

/** MCP 工具名一定是这个前缀；用于区分「动态工具暂时不在」和「名字写错」。 */
const MCP_PREFIX = "mcp__";

/** 扩展名 → 前端分组名。未知扩展回落到扩展名本身。 */
const GROUP_LABELS = {
  "pi-box": "系统",
  "pi-box-reports": "报告",
  codemode: "高级",
  "tool-search": "高级",
};

function groupOf(extensionName) {
  if (extensionName.startsWith("mcp:")) return `MCP: ${extensionName.slice(4)}`;
  return GROUP_LABELS[extensionName] ?? extensionName;
}

/** harness 装完所有扩展后调用（含 MCP reload），把 registry 快照注入本模块。
 *  builtinOnly=false 时把内置工具也算进目录（用于前端展示与校验）。 */
export function setToolCatalog(entries) {
  const byName = new Map();
  const groups = new Map();
  for (const { extension, tool } of entries) {
    if (tool.name.startsWith("mcp__")) continue;   // MCP 单独按 server 管理，不进 tools 白名单
    if (BUILTIN_TOOL_BY_NAME.has(tool.name)) continue;  // 内置工具单独成组，避免重复
    const group = groupOf(extension.name);
    byName.set(tool.name, { tool, group, extension: extension.name });
    if (!groups.has(group)) groups.set(group, []);
    groups.get(group).push(tool.name);
  }
  extensionToolByName = byName;
  extensionGroups = [...groups].map(([name, tools]) => ({ name, tools }));
}

/** MCP bridge 热更新后替换工具目录；Agent 文件只持久化 MCP server 名。 */
export function setMcpToolsByServer(next, supportTools = mcpSupportTools) {
  mcpToolsByServer = new Map(next);
  mcpSupportTools = [...supportTools];
}

/** 项目助理必须保留的系统工具（当前为 subagent），不允许被页面配置关闭。 */
export function setAssistantRequiredTools(tools) {
  assistantRequiredTools = [...tools];
}

/** 可选工具名（内置 + 已注册的扩展工具）；用于报错信息与前端展示。 */
export function availableToolNames() {
  return [...BUILTIN_TOOL_BY_NAME.keys(), ...extensionToolByName.keys()];
}

/** 去重（保持首次出现的顺序）。 */
function dedupeTools(tools) {
  const seen = new Set();
  const out = [];
  for (const tool of tools) {
    if (!tool || seen.has(tool.name)) continue;
    seen.add(tool.name);
    out.push(tool);
  }
  return out;
}

function findMcpTool(name) {
  for (const tools of mcpToolsByServer.values()) {
    const hit = tools.find((tool) => tool.name === name);
    if (hit) return hit;
  }
  return null;
}

/** mcps + mcpTools → 具体 MCP 工具。
 *  收窄规则：某 server 的工具有出现在 mcpTools 里 → 只给列出的；没有出现 → 该 server 全部给。
 *  这样「整组勾 A + 单选 B 的一个工具」可以同时表达。 */
function resolveMcpTools(mcpNames, mcpToolNames) {
  const servers = Array.isArray(mcpNames) ? [...new Set(mcpNames)] : [];
  const missing = servers.filter((name) => !mcpToolsByServer.has(name));
  if (missing.length > 0) throw new Error(`MCP 未连接或不存在：${missing.join(", ")}`);
  const narrowed = Array.isArray(mcpToolNames) && mcpToolNames.length > 0
    ? new Set(mcpToolNames.map(String))
    : null;
  const out = [];
  for (const server of servers) {
    const all = mcpToolsByServer.get(server) ?? [];
    if (narrowed === null) {
      out.push(...all);
      continue;
    }
    const chosen = all.filter((tool) => narrowed.has(tool.name));
    out.push(...(chosen.length > 0 ? chosen : all));
  }
  return out;
}

/** tools / mcps / mcpTools → registry 中的真实工具定义。
 *
 *  显式模型，没有隐式默认：
 *    - tools 缺失或空数组 = 没有任何内置/扩展工具（不再「继承全部」）
 *    - mcps 列出的 server = 该 server 全部工具，mcpTools 非空时按 server 收窄
 *    - 助理额外强制注入 assistantRequiredTools（subagent），其他角色没有
 *    - codemode / tool_search 仅在 MCP 工具需要时追加（不写 tools 也不会白送）
 */
export function resolveAgentTools(toolNames, mcpNames = [], mcpToolNames = null, { role = "agent" } = {}) {
  if (toolNames !== null && toolNames !== undefined && !Array.isArray(toolNames)) {
    throw new Error("tools 必须是工具名数组");
  }
  const picked = Array.isArray(toolNames) ? [...new Set(toolNames.map(String))] : [];
  const resolved = [];
  const staleMcpNames = [];
  for (const name of picked) {
    const builtin = BUILTIN_TOOL_BY_NAME.get(name);
    if (builtin) {
      resolved.push(builtin);
      continue;
    }
    const ext = extensionToolByName.get(name);
    if (ext) {
      resolved.push(ext.tool);
      continue;
    }
    // MCP 工具名是动态的（server 可能临时掉线）。写错名字必须报错，掉线不能阻止启动。
    if (name.startsWith(MCP_PREFIX)) {
      staleMcpNames.push(name);
      continue;
    }
    throw new Error(`未知工具：${name}；可用工具：${availableToolNames().join("、")}`);
  }

  const mcpTools = resolveMcpTools(mcpNames, mcpToolNames);
  // 老配置兼容：MCP 工具名直接写在 tools 里
  for (const name of staleMcpNames) {
    const found = findMcpTool(name);
    if (found) {
      mcpTools.push(found);
      continue;
    }
    console.error(`[tools] MCP 工具当前不可用，已跳过：${name}`);
  }

  const needsCodemode = mcpTools.some((tool) => tool.callers?.includes("tools"));
  const needsSearch = mcpTools.some((tool) => tool.deferred === true);
  const support = mcpSupportTools.filter((tool) =>
    (needsCodemode && tool.name === "codemode") || (needsSearch && tool.name === "tool_search"));

  const required = role === "assistant" ? assistantRequiredTools : [];
  return dedupeTools([...resolved, ...mcpTools, ...support, ...required]);
}

/** 助理工具 = 显式选择 + 系统强制工具（subagent）。 */
export function resolveAssistantTools(toolNames, mcpNames = [], mcpToolNames = null) {
  return resolveAgentTools(toolNames, mcpNames, mcpToolNames, { role: "assistant" });
}

/** 保存前的配置一致性校验：配置错当场失败，不要留到运行时让模型发懵。
 *  这是 fail fast 的主落点 —— 运行时的模型不该为配置错误买单。 */
export function validateAgentConfig({ tools, mcps, mcpTools, reports, skills, role = "agent" } = {}) {
  const picked = Array.isArray(tools) ? tools.map(String) : [];
  const has = (name) => picked.includes(name);

  if (Array.isArray(reports) && reports.length > 0 && !has("report_publish")) {
    throw new Error("绑定了报告组但没有勾选 report_publish：请在工具里勾上报告工具，或解除报告组绑定");
  }
  if (Array.isArray(skills) && skills.length > 0 && !has("read") && !has("bash")) {
    throw new Error("启用了 Skill 但没有 read/bash 工具：Skill 正文只能靠 read 读取");
  }
  if (role === "agent" && has("subagent")) {
    throw new Error("子 Agent 不能勾选 subagent：它只属于项目助理（防止递归派发）");
  }
  if (Array.isArray(mcpTools) && mcpTools.length > 0) {
    const known = new Set([...mcpToolsByServer.values()].flat().map((tool) => tool.name));
    const unknown = mcpTools.filter((name) => !known.has(name));
    // server 掉线时名字会暂时查不到，这里只提示不阻断。
    if (unknown.length > 0) console.error(`[tools] mcpTools 里有当前不可用的工具：${unknown.join(", ")}`);
  }
  if (Array.isArray(mcps) && mcps.length > 0) {
    const missing = mcps.filter((name) => !mcpToolsByServer.has(name));
    if (missing.length > 0) throw new Error(`MCP 未连接或不存在：${missing.join(", ")}`);
  }
}

/** 前端工具目录：分组 + 可用性 + 锁定原因。
 *  role 决定哪些项可勾选（子 agent 不能拿 subagent）。 */
export function toolCatalog({ role = "agent" } = {}) {
  const isAssistant = role === "assistant";
  const groups = [];

  const builtin = [...BUILTIN_TOOL_BY_NAME.keys()].map((name) => ({
    name, label: name, available: true, locked: false, reason: null,
  }));
  if (builtin.length > 0) groups.push({ name: "内置", tools: builtin });

  for (const group of extensionGroups) {
    const tools = group.tools.map((name) => {
      const isSubagent = name === "subagent";
      return {
        name,
        label: name,
        available: isSubagent ? isAssistant : true,
        locked: isSubagent && isAssistant,
        reason: isSubagent && !isAssistant ? "子 Agent 不能派发子 Agent（防止递归）" : null,
      };
    });
    groups.push({ name: group.name, tools });
  }

  return groups;
}

/** 前端 MCP 目录：按 server 分组，供「整组勾 + 单勾」界面使用。 */
export function mcpCatalog() {
  return [...mcpToolsByServer].map(([server, tools]) => ({
    server,
    tools: tools.map((tool) => ({
      name: tool.name,
      label: tool.name.slice(`mcp__${server}__`.length) || tool.name,
      exposure: tool.deferred === true ? "deferred" : tool.callers?.includes("tools") ? "codemode" : "direct",
    })),
  }));
}

/** 启用 skill 时必须有读取手段：SKILL.md 正文只能靠 read 工具加载。
 *  注意 resolvedTools === undefined 表示"继承默认全部工具"，此时天然包含 read，不应报错。 */
export function ensureSkillReadTool(resolvedTools, skillCount) {
  if (!skillCount) return;
  if (resolvedTools === undefined) return;
  if (resolvedTools.some((tool) => tool.name === "read")) return;
  throw new Error("启用 Skill 必须同时启用 read 工具：Skill 正文由模型用 read 读取 SKILL.md。");
}

/** 解析 .md 的 frontmatter + 正文。frontmatter：model / tools / mcps / skills / agents / locked */
export function parseAgentDef(md) {
  const m = md.match(/^---\r?\n([\s\S]*?)(?:\r?\n)?---(?:\r?\n)?([\s\S]*)$/);
  if (!m) return { model: null, tools: null, mcps: null, mcpTools: null, skills: null, agents: null, reports: null, icon: null, instructions: md.trim() };
  const fm = {};
  for (const line of m[1].split("\n")) {
    const kv = line.match(/^(\w+):\s*(.+)$/);
    if (kv) fm[kv[1].trim()] = kv[2].trim();
  }
  const arr = (s) => {
    const a = s?.match(/\[([^\]]*)\]/);
    return a ? a[1].split(",").map((x) => x.trim()).filter(Boolean) : null;
  };
  return { model: fm.model || null, tools: arr(fm.tools), mcps: arr(fm.mcps), mcpTools: arr(fm.mcpTools), skills: arr(fm.skills), agents: arr(fm.agents), reports: arr(fm.reports), locked: /^true$/i.test(fm.locked ?? ""), icon: fm.icon || null, instructions: m[2].trim() };
}

/** 序列化回 .md（保存到文件）
 * icon 是纯展示用的 emoji，放在 frontmatter 首行便于人工阅读与修改。 */
export function serializeAgentDef({ model: m, tools, mcps, mcpTools, skills, agents, reports, locked, icon, instructions }) {
  const fm = [];
  if (icon) fm.push(`icon: ${icon}`);
  if (m) fm.push(`model: ${m}`);
  // 空数组也要落盘，否则会被解释成 null（继承全部默认工具）。
  if (tools !== null && tools !== undefined) fm.push(`tools: [${tools.join(", ")}]`);
  if (mcps !== null && mcps !== undefined) fm.push(`mcps: [${mcps.join(", ")}]`);
  // mcpTools 只在被收窄时落盘；空数组 = 不收窄（各 server 全部工具）。
  if (mcpTools?.length) fm.push(`mcpTools: [${mcpTools.join(", ")}]`);
  if (skills !== null && skills !== undefined) fm.push(`skills: [${skills.join(", ")}]`);
  if (agents?.length) fm.push(`agents: [${agents.join(", ")}]`);
  // 报告组白名单：空数组 / 未设置都不落盘（= 没有报告能力）。
  if (reports?.length) fm.push(`reports: [${reports.join(", ")}]`);
  if (locked) fm.push(`locked: true`);
  const body = (instructions ?? "").trim();
  return fm.length ? `---\n${fm.join("\n")}\n---\n\n${body}\n` : `${body}\n`;
}

/** agent 定义路径候选：项目优先、全局兜底 */
function agentDefCandidates(projectName, agentName) {
  const list = [];
  if (projectName) list.push(join(PROJECTS_DIR, projectName, ".pi", "agents", `${agentName}.md`));
  list.push(join(GLOBAL_AGENTS_DIR, `${agentName}.md`));
  return list;
}

/** 读 agent 定义（项目优先 → 全局兜底）。找不到返回 null。 */
export async function loadAgentDef(projectName, agentName) {
  for (const p of agentDefCandidates(projectName, agentName)) {
    try {
      return {
        name: agentName,
        source: p,
        scope: p.startsWith(GLOBAL_AGENTS_DIR) ? "global" : "project",
        ...parseAgentDef(await readFile(p, "utf-8")),
      };
    } catch {
      /* try next */
    }
  }
  return null;
}

async function listAgentsInDir(dir, scope, projectName) {
  const names = [];
  try {
    for (const f of await readdir(dir)) if (f.endsWith(".md")) names.push(f.replace(/\.md$/, ""));
  } catch {
    return [];
  }
  const out = [];
  for (const name of names) {
    const source = join(dir, `${name}.md`);
    const def = parseAgentDef(await readFile(source, "utf-8"));
    out.push({
      name,
      source,
      scope,
      model: def.model ?? null,
      tools: def.tools ?? null,
      mcps: def.mcps ?? null,
      mcpTools: def.mcpTools ?? null,
      skills: def.skills ?? null,
      reports: def.reports ?? null,
      locked: !!def.locked,
      icon: def.icon ?? null,
      instructions: def.instructions ?? "",
    });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

/** 全局 Agent 模板库；不会自动出现在任何项目中。 */
export async function listGlobalAgents() {
  return listAgentsInDir(GLOBAL_AGENTS_DIR, "global", null);
}

/** 项目自身的 Agent；创建后始终启用。 */
export async function listProjectAgents(projectName) {
  return listAgentsInDir(join(PROJECTS_DIR, projectName, ".pi", "agents"), "project", projectName);
}

/** 元项目（meta）自身的 Agent 库；业务项目助理看不到这里。 */
export async function listMetaAgents() {
  return listAgentsInDir(META_AGENTS_DIR, "meta", META_PROJECT);
}

/** 助理实际可派发的 Agent = 全部项目 Agent + 助理显式选择的全局 Agent。
 * 元项目：返回它自己目录下的全部子 agent（业务项目不会调用元项目助理，所以无需"授权"概念）。 */
export async function listAgents(projectName) {
  if (projectName === META_PROJECT) {
    return await listMetaAgents();
  }
  const projectAgents = await listProjectAgents(projectName);
  const projectNames = new Set(projectAgents.map((agent) => agent.name));
  const assistant = await loadAssistant(projectName);
  const enabledGlobals = new Set(assistant.agents ?? []);
  const globalAgents = (await listGlobalAgents()).filter(
    (agent) => enabledGlobals.has(agent.name) && !projectNames.has(agent.name),
  );
  return [...projectAgents, ...globalAgents].sort((a, b) => a.name.localeCompare(b.name));
}

/** 助理配置页所需的完整目录，区分项目内置与全局可选项。
 * 业务项目查不到 meta agent；元项目只看到自己的子 agent。 */
export async function listAgentCatalog(projectName) {
  if (projectName === META_PROJECT) {
    return { project: await listMetaAgents(), global: [] };
  }
  return {
    project: await listProjectAgents(projectName),
    global: await listGlobalAgents(),
  };
}

/** 后端派发时再次检查授权，避免仅靠前端隐藏全局 Agent。
 * 业务项目永远不能加载 meta 目录下的 agent；元项目只能加载自己目录下的子 agent。 */
export async function loadEnabledAgentDef(projectName, agentName) {
  if (projectName !== META_PROJECT) {
    const projectAgent = (await listProjectAgents(projectName)).find((agent) => agent.name === agentName);
    if (projectAgent) return projectAgent;
    const assistant = await loadAssistant(projectName);
    if (!(assistant.agents ?? []).includes(agentName)) return null;
    return (await listGlobalAgents()).find((agent) => agent.name === agentName) ?? null;
  }
  return (await listMetaAgents()).find((agent) => agent.name === agentName) ?? null;
}

/** 读助理定义。元项目读 <META_DIR>/assistant.md；业务项目读 .pi/assistant.md。 */
export async function loadAssistant(projectName) {
  const p = projectName === META_PROJECT
    ? join(META_DIR, "assistant.md")
    : join(PROJECTS_DIR, projectName, ".pi", "assistant.md");
  try {
    const def = parseAgentDef(await readFile(p, "utf-8"));
    return {
      model: def.model,
      tools: def.tools,
      mcps: def.mcps,
      mcpTools: def.mcpTools ?? null,
      skills: def.skills ?? null,
      agents: def.agents ?? [],
      reports: def.reports ?? null,
      icon: def.icon ?? null,
      instructions: def.instructions,
    };
  } catch {
    return { model: null, tools: null, mcps: null, mcpTools: null, skills: null, agents: [], reports: null, icon: null, instructions: "" };
  }
}

/** 拼出主会话（助理）的 instructions：用户 prompt + 可派发子 agent 清单（用真实定义） */
export function assistantInstructions(projectName, assistant, agents) {
  const isMeta = projectName === META_PROJECT;
  const parts = [
    assistant.instructions?.trim() ||
      (isMeta
        ? `你是 pi-box 元项目助理。管理所有业务项目、Agent、调度与配置；不允许修改业务项目会话，只能读写它们的文件。`
        : `你是项目「${projectName}」的助理。理解客户意图，必要时用 subagent 工具把任务派发给合适的子 agent，并汇总结果。`),
  ];
  const available = agents.map((a) => a.name);
  if (available.length > 0) {
    const lines = available.map((n) => {
      const a = agents.find((x) => x.name === n);
      const lock = a?.locked ? " 🔒(不可删)" : "";
      return `- ${n}${lock}：${(a?.instructions || "（无描述）").replace(/\n/g, " ").slice(0, 80)}`;
    });
    parts.push(`\n你可派发的子 agent：\n${lines.join("\n")}\n用 subagent 工具（spawn/send/stop/status）管理它们。`);
  } else if (isMeta) {
    parts.push(`\n当前还没有元项目私有子 agent。可在 /home/agent/.pi/agent/meta/agents/ 下添加定义。`);
  } else {
    parts.push(`\n当前项目还没有可派发的子 agent。可在 .pi/agents/ 下添加定义。`);
  }
  return parts.join("\n");
}

/** 解析 agent 定义里的 model 字段，跟当前全局 model 派生实际配置。
 * 支持两种写法：
 *   model: gpt-4o            （纯 modelId，先在全局默认厂商里找，再在所有已加载厂商里找唯一匹配）
 *   model: openai/gpt-4o     （provider/modelId）
 * 解析不到可用模型，回退到全局 model。 */
export function resolveAgentModel(defModel) {
  const fallback = currentModel;
  if (!defModel) return fallback;
  const raw = String(defModel).trim();
  if (!raw) return fallback;
  if (raw.includes("/")) {
    const slash = raw.indexOf("/");
    const provider = raw.slice(0, slash);
    const modelId = raw.slice(slash + 1);
    return resolveModelRef(provider, modelId) ?? fallback;
  }
  if (models.getModel(fallback.provider, raw)) return { provider: fallback.provider, modelId: raw };
  const matches = models.getProviders().filter((p) => models.getModel(p.id, raw));
  if (matches.length === 1) return { provider: matches[0].id, modelId: raw };
  return fallback;
}

/** 从 AssistantMessage 提取纯文本（给 Reporter 用） */
export function answerText(message) {
  if (!message?.content) return "";
  return message.content.flatMap((p) => (p.type === "text" ? [p.text] : [])).join("");
}

/** 扫描项目列表（PROJECTS_DIR 直接子目录，排除 . 开头的隐藏目录 + 元项目 meta 始终在内） */
export async function listProjects() {
  const projects = new Set();
  try {
    const entries = await readdir(PROJECTS_DIR, { withFileTypes: true });
    for (const e of entries) {
      if (e.isDirectory() && !e.name.startsWith(".")) projects.add(e.name);
    }
  } catch {
    /* PROJECTS_DIR 还不存在时也允许 */
  }
  // 元项目独立于 PROJECTS_DIR：当 META_DIR 存在时把 "meta" 加入项目列表
  try {
    const metaStat = await stat(META_DIR).catch(() => null);
    if (metaStat?.isDirectory()) projects.add(META_PROJECT);
  } catch {
    /* ignore */
  }
  return [...projects].sort((a, b) => {
    if (a === META_PROJECT) return -1;
    if (b === META_PROJECT) return 1;
    return a.localeCompare(b);
  });
}

/** agent 定义文件路径（按 scope）。scope=meta 永远指向 META_AGENTS_DIR。 */
export function agentFilePath(projectName, agentName, scope) {
  if (scope === "meta") return join(META_AGENTS_DIR, `${agentName}.md`);
  if (scope === "global") return join(GLOBAL_AGENTS_DIR, `${agentName}.md`);
  return join(PROJECTS_DIR, projectName, ".pi", "agents", `${agentName}.md`);
}

/** 保存 agent 定义到文件。未传 icon / reports 时保留文件里已有的值，避免在编辑器里改配置时把它们冲掉。 */
export async function saveAgentFile(projectName, name, scope, def) {
  const file = agentFilePath(projectName, name, scope);
  let icon = def.icon;
  let reports = def.reports;
  let mcpTools = def.mcpTools;
  if (icon === undefined || reports === undefined || mcpTools === undefined) {
    const existing = await readFile(file, "utf-8")
      .then((md) => parseAgentDef(md))
      .catch(() => null);
    if (icon === undefined) icon = existing?.icon ?? null;
    if (reports === undefined) reports = existing?.reports ?? null;
    if (mcpTools === undefined) mcpTools = existing?.mcpTools ?? null;
  }
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, serializeAgentDef({ ...def, icon, reports, mcpTools }), "utf-8");
  return file;
}

/** 重命名 Agent 定义；全局 Agent 同时迁移各项目助理中的授权引用。 */
export async function renameAgentFile(projectName, oldName, newName, scope) {
  if (oldName === newName) return agentFilePath(projectName, newName, scope);
  const oldFile = agentFilePath(projectName, oldName, scope);
  const newFile = agentFilePath(projectName, newName, scope);
  try {
    await readFile(newFile, "utf-8");
    throw new Error(`Agent “${newName}”已存在`);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  await mkdir(dirname(newFile), { recursive: true });
  await rename(oldFile, newFile);
  if (scope === "global") {
    for (const project of await listProjects()) {
      if (project === META_PROJECT) continue;
      const assistant = await loadAssistant(project);
      if (!(assistant.agents ?? []).includes(oldName)) continue;
      const agents = assistant.agents.map((name) => name === oldName ? newName : name);
      await saveAssistantFile(project, { ...assistant, agents: [...new Set(agents)] });
    }
  }
  return newFile;
}

/** 删除 agent 定义文件。locked=true 拒绝。 */
export async function deleteAgentFile(projectName, name, scope) {
  const file = agentFilePath(projectName, name, scope);
  let current;
  try {
    current = parseAgentDef(await readFile(file, "utf-8"));
  } catch (error) {
    if (error?.code === "ENOENT") return; // 不存在也算成功
    throw error;
  }
  if (current.locked) throw new Error(`Agent “${name}” 已锁定（locked=true），不可删除。可通过 tools:[] 软停用。`);
  try {
    await unlink(file);
  } catch {
    /* 不存在也算成功 */
  }
}

/** 保存助理定义到 .pi/assistant.md。
 * 元项目：只允许首启 force 写入；后续通过 API 改写会被拒（文件 chmod 444 + UI 隐藏）。 */
export async function saveAssistantFile(projectName, def, { force = false } = {}) {
  if (projectName === META_PROJECT && !force) {
    throw new Error(`元项目助理文件受保护，不能通过 API 改写。请在宿主机直接编辑 ${META_DIR}/assistant.md。`);
  }
  const file = projectName === META_PROJECT
    ? join(META_DIR, "assistant.md")
    : join(PROJECTS_DIR, projectName, ".pi", "assistant.md");
  // 未传 icon / reports / mcpTools 时保留现有值，避免改模型或工具时把它们冲掉。
  let icon = def.icon;
  let reports = def.reports;
  let mcpTools = def.mcpTools;
  if (icon === undefined || reports === undefined || mcpTools === undefined) {
    const existing = await readFile(file, "utf-8")
      .then((md) => parseAgentDef(md))
      .catch(() => null);
    if (icon === undefined) icon = existing?.icon ?? null;
    if (reports === undefined) reports = existing?.reports ?? null;
    if (mcpTools === undefined) mcpTools = existing?.mcpTools ?? null;
  }
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, serializeAgentDef({ ...def, icon, reports, mcpTools }), "utf-8");
  return file;
}

// ─── 实体图标（项目 / 助理 / 子 Agent） ──────────────────────────────
// 图标是纯展示用的 emoji：项目存 <project>/.pi/project.json，助理与子 Agent
// 存各自 .md 的 frontmatter。元项目图标固定，不提供读写入口。
const ICON_MAX_CODE_POINTS = 8;

/** 校验并规范化 emoji 图标。返回 null 表示“恢复默认”（删除自定义）。 */
export function normalizeIcon(value) {
  if (value === null || value === undefined) return null;
  const raw = String(value).replace(/[\r\n\t]/g, "").trim();
  if (!raw) return null;
  const points = Array.from(raw);
  if (points.length > ICON_MAX_CODE_POINTS) {
    throw new Error(`图标最多 ${ICON_MAX_CODE_POINTS} 个字符`);
  }
  return raw;
}

function projectMetaPath(projectName) {
  return join(PROJECTS_DIR, projectName, ".pi", "project.json");
}

/** 读项目图标；无自定义时返回 null（前端回落到 📁）。 */
export async function loadProjectIcon(projectName) {
  if (projectName === META_PROJECT) return null;
  try {
    const meta = JSON.parse(await readFile(projectMetaPath(projectName), "utf-8"));
    return normalizeIcon(meta?.icon) ?? null;
  } catch {
    return null;
  }
}

/** 保存项目图标；null 表示删除自定义图标。 */
export async function saveProjectIcon(projectName, icon) {
  if (projectName === META_PROJECT) {
    throw new Error("元项目图标固定，不可修改");
  }
  const file = projectMetaPath(projectName);
  const normalized = normalizeIcon(icon);
  if (normalized === null) {
    await unlink(file).catch(() => {});
    return null;
  }
  let meta = {};
  try {
    meta = JSON.parse(await readFile(file, "utf-8")) ?? {};
  } catch {
    meta = {};
  }
  meta.icon = normalized;
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, `${JSON.stringify(meta, null, 2)}\n`, "utf-8");
  return normalized;
}

/** 只改助理图标：原地重写 frontmatter，其余字段（模型/工具/提示词）原样保留。
 * 单独提供而不复用 saveAssistantFile，是为了避免「改个图标」也要经过
 * skills/tools 校验链，或因为前端拿着旧快照而把助理配置写回旧版本。 */
export async function setAssistantIcon(projectName, icon) {
  if (projectName === META_PROJECT) throw new Error("元项目图标固定，不可修改");
  const file = join(PROJECTS_DIR, projectName, ".pi", "assistant.md");
  const def = await readFile(file, "utf-8")
    .then((md) => parseAgentDef(md))
    .catch(() => ({ model: null, tools: null, mcps: null, skills: null, agents: null, instructions: "" }));
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, serializeAgentDef({ ...def, icon: normalizeIcon(icon) }), "utf-8");
  return normalizeIcon(icon);
}

/** 只改子 Agent 图标；同理保留其余 frontmatter 字段。 */
export async function setAgentIcon(projectName, name, scope, icon) {
  if (scope === "meta") throw new Error("元项目子 agent 图标固定，不可修改");
  const file = agentFilePath(projectName, name, scope);
  const def = await readFile(file, "utf-8").then((md) => parseAgentDef(md)).catch(() => null);
  if (!def) throw new Error(`Agent 定义不存在：${name}`);
  await writeFile(file, serializeAgentDef({ ...def, icon: normalizeIcon(icon) }), "utf-8");
  return normalizeIcon(icon);
}
