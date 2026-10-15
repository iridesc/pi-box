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
import { models, currentModel } from "./model.mjs";
import { CodingTools } from "@earendil-works/pi-durable/tools";

const TOOL_BY_NAME = new Map((CodingTools.tools ?? []).map((tool) => [tool.name, tool]));
let mcpToolsByServer = new Map();
let mcpSupportTools = [];

/** MCP bridge 热更新后替换工具目录；Agent 文件只持久化 MCP server 名。 */
export function setMcpToolsByServer(next, supportTools = mcpSupportTools) {
  mcpToolsByServer = new Map(next);
  mcpSupportTools = [...supportTools];
}

/** Agent 文件里的工具名转换成 registry 中真实的工具定义；null 表示继承默认工具集。 */
export function resolveAgentTools(toolNames, mcpNames = []) {
  if (toolNames === null || toolNames === undefined) return undefined;
  if (!Array.isArray(toolNames)) throw new Error("tools 必须是工具名数组");
  const unknown = toolNames.filter((name) => !TOOL_BY_NAME.has(name));
  if (unknown.length > 0) {
    throw new Error(`未知工具：${unknown.join(", ")}；可用工具：${[...TOOL_BY_NAME.keys()].join(", ")}`);
  }
  if (mcpNames === null || mcpNames === undefined) mcpNames = [];
  if (!Array.isArray(mcpNames)) throw new Error("mcps 必须是 MCP 名称数组");
  const missingMcps = mcpNames.filter((name) => !mcpToolsByServer.has(name));
  if (missingMcps.length > 0) throw new Error(`MCP 未连接或不存在：${missingMcps.join(", ")}`);
  const mcpTools = mcpNames.flatMap((name) => mcpToolsByServer.get(name) ?? []);
  const needsCodemode = mcpTools.some((tool) => tool.callers?.includes("tools"));
  const needsSearch = mcpTools.some((tool) => tool.deferred === true);
  const support = mcpSupportTools.filter((tool) =>
    (needsCodemode && tool.name === "codemode") || (needsSearch && tool.name === "tool_search"));
  return [...toolNames.map((name) => TOOL_BY_NAME.get(name)), ...mcpTools, ...support];
}

export const AVAILABLE_TOOL_NAMES = [...TOOL_BY_NAME.keys()];

/** 解析 .md 的 frontmatter + 正文。frontmatter：model / tools / mcps / agents */
export function parseAgentDef(md) {
  const m = md.match(/^---\r?\n([\s\S]*?)(?:\r?\n)?---(?:\r?\n)?([\s\S]*)$/);
  if (!m) return { model: null, tools: null, mcps: null, agents: null, instructions: md.trim() };
  const fm = {};
  for (const line of m[1].split("\n")) {
    const kv = line.match(/^(\w+):\s*(.+)$/);
    if (kv) fm[kv[1].trim()] = kv[2].trim();
  }
  const arr = (s) => {
    const a = s?.match(/\[([^\]]*)\]/);
    return a ? a[1].split(",").map((x) => x.trim()).filter(Boolean) : null;
  };
  return { model: fm.model || null, tools: arr(fm.tools), mcps: arr(fm.mcps), agents: arr(fm.agents), locked: /^true$/i.test(fm.locked ?? ""), instructions: m[2].trim() };
}

/** 序列化回 .md（保存到文件） */
export function serializeAgentDef({ model: m, tools, mcps, agents, locked, instructions }) {
  const fm = [];
  if (m) fm.push(`model: ${m}`);
  // 空数组也要落盘，否则会被解释成 null（继承全部默认工具）。
  if (tools !== null && tools !== undefined) fm.push(`tools: [${tools.join(", ")}]`);
  if (mcps !== null && mcps !== undefined) fm.push(`mcps: [${mcps.join(", ")}]`);
  if (agents?.length) fm.push(`agents: [${agents.join(", ")}]`);
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
      locked: !!def.locked,
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
    return { model: def.model, agents: def.agents ?? [], instructions: def.instructions };
  } catch {
    return { model: null, agents: [], instructions: "" };
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
 *   model: gpt-4o            （纯 modelId，provider 跟当前配置）
 *   model: openai/gpt-4o     （provider/modelId）
 * 解析不到可用模型，回退到全局 model。 */
export function resolveAgentModel(defModel) {
  const fallback = currentModel;
  if (!defModel) return fallback;
  if (defModel.includes("/")) {
    const [provider, modelId] = defModel.split("/");
    if (models.getModel(provider, modelId)) return { provider, modelId };
  }
  if (models.getModel(fallback.provider, defModel)) return { provider: fallback.provider, modelId: defModel };
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

/** 保存 agent 定义到文件 */
export async function saveAgentFile(projectName, name, scope, def) {
  const file = agentFilePath(projectName, name, scope);
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, serializeAgentDef(def), "utf-8");
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
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, serializeAgentDef(def), "utf-8");
  return file;
}
