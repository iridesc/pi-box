// agent 定义 / 助理 / 项目扫描
// 配置形态（文件即真相）：
//   全局 agent 库   <WORKSPACE>/.pi-box/agents/<name>.md     —— 共享模板
//   项目覆盖        <PROJECTS_DIR>/<project>/.pi/agents/<name>.md
//   项目助理        <PROJECTS_DIR>/<project>/.pi/assistant.md   —— prompt + agents:[引用列表]
// 加载链：项目内同名优先 → 全局库兜底
import { readdir, readFile, writeFile, mkdir, unlink } from "node:fs/promises";
import { basename, join, dirname } from "node:path";
import { PROJECTS_DIR, GLOBAL_AGENTS_DIR } from "./paths.mjs";
import { models, currentModel } from "./model.mjs";

/** 解析 .md 的 frontmatter + 正文。frontmatter：model / tools / agents */
export function parseAgentDef(md) {
  const m = md.match(/^---\r?\n([\s\S]*?)(?:\r?\n)?---(?:\r?\n)?([\s\S]*)$/);
  if (!m) return { model: null, tools: null, agents: null, instructions: md.trim() };
  const fm = {};
  for (const line of m[1].split("\n")) {
    const kv = line.match(/^(\w+):\s*(.+)$/);
    if (kv) fm[kv[1].trim()] = kv[2].trim();
  }
  const arr = (s) => {
    const a = s?.match(/\[([^\]]*)\]/);
    return a ? a[1].split(",").map((x) => x.trim()).filter(Boolean) : null;
  };
  return { model: fm.model || null, tools: arr(fm.tools), agents: arr(fm.agents), instructions: m[2].trim() };
}

/** 序列化回 .md（保存到文件） */
export function serializeAgentDef({ model: m, tools, agents, instructions }) {
  const fm = [];
  if (m) fm.push(`model: ${m}`);
  if (tools?.length) fm.push(`tools: [${tools.join(", ")}]`);
  if (agents?.length) fm.push(`agents: [${agents.join(", ")}]`);
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

/** 列出项目可用 agent：全局库 + 项目覆盖（同名项目优先） */
export async function listAgents(projectName) {
  const names = new Map(); // name -> protoScope
  try {
    for (const f of await readdir(GLOBAL_AGENTS_DIR)) if (f.endsWith(".md")) names.set(f.replace(/\.md$/, ""), "global");
  } catch {
    /* 无全局库 */
  }
  try {
    for (const f of await readdir(join(PROJECTS_DIR, projectName, ".pi", "agents"))) if (f.endsWith(".md")) names.set(f.replace(/\.md$/, ""), "project");
  } catch {
    /* 无项目 agent */
  }
  const out = [];
  for (const [name, protoScope] of names) {
    const def = await loadAgentDef(projectName, name);
    out.push({
      name,
      scope: def?.scope ?? protoScope,
      model: def?.model ?? null,
      tools: def?.tools ?? null,
      instructions: (def?.instructions ?? "").slice(0, 200),
    });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

/** 读项目助理定义（.pi/assistant.md） */
export async function loadAssistant(projectName) {
  const p = join(PROJECTS_DIR, projectName, ".pi", "assistant.md");
  try {
    const def = parseAgentDef(await readFile(p, "utf-8"));
    return { model: def.model, agents: def.agents ?? [], instructions: def.instructions };
  } catch {
    return { model: null, agents: [], instructions: "" };
  }
}

/** 拼出主会话（助理）的 instructions：用户 prompt + 可派发子 agent 清单（用真实定义） */
export function assistantInstructions(projectName, assistant, agents) {
  const parts = [
    assistant.instructions?.trim() ||
      `你是项目「${projectName}」的助理。理解用户意图，必要时用 subagent 工具把任务派发给合适的子 agent，并汇总结果。`,
  ];
  const available = assistant.agents?.length
    ? assistant.agents.filter((n) => agents.some((a) => a.name === n))
    : agents.map((a) => a.name);
  if (available.length > 0) {
    const lines = available.map((n) => {
      const a = agents.find((x) => x.name === n);
      return `- ${n}：${(a?.instructions || "（无描述）").replace(/\n/g, " ").slice(0, 80)}`;
    });
    parts.push(`\n你可派发的子 agent：\n${lines.join("\n")}\n用 subagent 工具（spawn/send/stop/status）管理它们。`);
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

/** 扫描项目列表（PROJECTS_DIR 直接子目录，排除 . 开头的隐藏目录） */
export async function listProjects() {
  try {
    const entries = await readdir(PROJECTS_DIR, { withFileTypes: true });
    return entries
      .filter((e) => e.isDirectory() && !e.name.startsWith("."))
      .map((e) => e.name)
      .sort();
  } catch {
    return [];
  }
}

/** agent 定义文件路径（按 scope） */
export function agentFilePath(projectName, agentName, scope) {
  const dir = scope === "global" ? GLOBAL_AGENTS_DIR : join(PROJECTS_DIR, projectName, ".pi", "agents");
  return join(dir, `${agentName}.md`);
}

/** 保存 agent 定义到文件 */
export async function saveAgentFile(projectName, name, scope, def) {
  const file = agentFilePath(projectName, name, scope);
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, serializeAgentDef(def), "utf-8");
  return file;
}

/** 删除 agent 定义文件 */
export async function deleteAgentFile(projectName, name, scope) {
  try {
    await unlink(agentFilePath(projectName, name, scope));
  } catch {
    /* 不存在也算成功 */
  }
}

/** 保存助理定义到 .pi/assistant.md */
export async function saveAssistantFile(projectName, def) {
  const file = join(PROJECTS_DIR, projectName, ".pi", "assistant.md");
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, serializeAgentDef(def), "utf-8");
  return file;
}
