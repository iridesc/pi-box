// pi-boxd：pi-box 的 durable 守护进程。
//
// 架构（对应 durable 官方 22/23/28 示例）：
//   全局 agent 库   <workspace>/.pi-box/agents/*.md     —— AgentState 模板（共享）
//   项目覆盖        <project>/.pi/agents/*.md           —— 同名优先
//   项目助理        <project>/.pi/assistant.md          —— 主 agent（prompt + 引用哪些子 agent）
//   运行态          主会话 conversation（项目助理）
//                     └ subagent 工具 spawn 出命名子 agent（owned conversation, Anchor task owner）
//                        └ Reporter task 把子 agent 的答案回流给主会话
//
// durable 管运行态（会话/任务/ownership/checkpoint），文件管配置，加载器负责把配置变成 AgentState。
import { mkdir, readdir, readFile, writeFile, stat } from "node:fs/promises";
import { basename, join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxProvider } from "@earendil-works/pi-ai/providers/faux";
import { Type } from "@earendil-works/pi-ai";
import {
  AgentDoc,
  AssistantEntry,
  LiveDoc,
  configure,
  createRegistry,
  defineDoc,
  defineExtension,
  defineTask,
  defineTool,
  Harness,
} from "@earendil-works/pi-durable";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { CodingTools } from "@earendil-works/pi-durable/tools";

import { createWebServer, snapshot } from "pi-durable-web/src/core.mjs";

const context = BACKGROUND_CONTEXT;
const WORKSPACE = process.env.PI_BOX_WORKSPACE ?? "/workspace";
const PROJECTS_DIR = join(WORKSPACE, "projects");
const GLOBAL_AGENTS_DIR = join(WORKSPACE, ".pi-box", "agents"); // 全局 agent 库
const DATA_DIR = process.env.PI_BOX_DATA_DIR ?? join(WORKSPACE, ".pi-boxd");
const PORT = Number(process.env.PORT ?? 8787);
const _srcDir = dirname(fileURLToPath(import.meta.url));
const _piBoxdDir = basename(_srcDir) === "src" ? dirname(_srcDir) : _srcDir;
const WEB_DIR = process.env.PI_BOXD_WEB_DIR ? resolve(process.env.PI_BOXD_WEB_DIR) : join(_piBoxdDir, "web");

// ─── 模型：有 key 用对应 provider，无 key 用 faux（离线） ──────────────────
let model = { provider: "openai", modelId: "gpt-4o" };
let useFaux = true;
let faux = null;
const configPath = join(DATA_DIR, "config.json");

async function loadConfig() {
  try {
    return JSON.parse(await readFile(configPath, "utf-8"));
  } catch {
    return { provider: "openai", modelId: "gpt-4o", apiKey: "", baseUrl: "" };
  }
}
async function saveConfig(cfg) {
  await writeFile(configPath, JSON.stringify(cfg, null, 2), "utf-8");
}

const PROVIDERS = {
  openai: { name: "OpenAI", defaultModel: "gpt-4o", defaultBaseUrl: "https://api.openai.com/v1", keyEnv: "OPENAI_API_KEY", load: () => import("@earendil-works/pi-ai/providers/openai").then((m) => m.openaiProvider()) },
  deepseek: { name: "DeepSeek", defaultModel: "deepseek-flash", defaultBaseUrl: "https://api.deepseek.com/v1", keyEnv: "DEEPSEEK_API_KEY", load: () => import("@earendil-works/pi-ai/providers/deepseek").then((m) => m.deepseekProvider()) },
  moonshotai: { name: "Moonshot (Kimi)", defaultModel: "kimi-k2.6", defaultBaseUrl: "https://api.moonshot.cn/v1", keyEnv: "MOONSHOT_API_KEY", load: () => import("@earendil-works/pi-ai/providers/moonshotai").then((m) => m.moonshotaiProvider()) },
  google: { name: "Google Gemini", defaultModel: "gemini-2.5-flash", defaultBaseUrl: "", keyEnv: "GEMINI_API_KEY", load: () => import("@earendil-works/pi-ai/providers/google").then((m) => m.googleProvider()) },
  groq: { name: "Groq", defaultModel: "llama-3.3-70b-versatile", defaultBaseUrl: "https://api.groq.com/openai/v1", keyEnv: "GROQ_API_KEY", load: () => import("@earendil-works/pi-ai/providers/groq").then((m) => m.groqProvider()) },
  openrouter: { name: "OpenRouter", defaultModel: "openai/gpt-4o", defaultBaseUrl: "https://openrouter.ai/api/v1", keyEnv: "OPENROUTER_API_KEY", load: () => import("@earendil-works/pi-ai/providers/openrouter").then((m) => m.openrouterProvider()) },
  mistral: { name: "Mistral", defaultModel: "codestral-latest", defaultBaseUrl: "https://api.mistral.ai/v1", keyEnv: "MISTRAL_API_KEY", load: () => import("@earendil-works/pi-ai/providers/mistral").then((m) => m.mistralProvider()) },
  xai: { name: "xAI (Grok)", defaultModel: "grok-4.3", defaultBaseUrl: "https://api.x.ai/v1", keyEnv: "XAI_API_KEY", load: () => import("@earendil-works/pi-ai/providers/xai").then((m) => m.xaiProvider()) },
  anthropic: { name: "Anthropic Claude", defaultModel: "claude-fable-5", defaultBaseUrl: "https://api.anthropic.com", keyEnv: "ANTHROPIC_API_KEY", load: () => import("@earendil-works/pi-ai/providers/anthropic").then((m) => m.anthropicProvider()) },
  minimax: { name: "MiniMax (国际)", defaultModel: "MiniMax-M2.7", defaultBaseUrl: "https://api.minimax.io/anthropic", keyEnv: "MINIMAX_API_KEY", load: () => import("@earendil-works/pi-ai/providers/minimax").then((m) => m.minimaxProvider()) },
  "minimax-cn": { name: "MiniMax (中国)", defaultModel: "MiniMax-M2.7", defaultBaseUrl: "https://api.minimaxi.com/anthropic", keyEnv: "MINIMAX_API_KEY", load: () => import("@earendil-works/pi-ai/providers/minimax").then((m) => m.minimaxProvider()) },
};

const PROVIDER_LIST = Object.entries(PROVIDERS).map(([id, p]) => ({
  id,
  name: p.name,
  defaultModel: p.defaultModel,
  defaultBaseUrl: p.defaultBaseUrl,
}));

let providerModelsCache = null;
async function getAllProviderModels() {
  if (providerModelsCache) return providerModelsCache;
  const result = {};
  for (const [id, def] of Object.entries(PROVIDERS)) {
    try {
      const p = await def.load();
      result[id] = (await p.getModels()).map((m) => m.id);
    } catch {
      result[id] = [];
    }
  }
  providerModelsCache = result;
  return result;
}

const authContext = {
  async env(name) {
    const cfg = await loadConfig();
    if (cfg?.apiKey) {
      const def = PROVIDERS[cfg.provider];
      if (def && name === def.keyEnv) return cfg.apiKey;
      if (def && def.keyEnv === "ANTHROPIC_API_KEY" && name === "ANTHROPIC_AUTH_TOKEN") return cfg.apiKey;
    }
    return process.env[name];
  },
  async fileExists(path) {
    try {
      await stat(path.replace(/^~/, process.env.HOME ?? ""));
      return true;
    } catch {
      return false;
    }
  },
};

const models = createModels({ authContext });

let currentModelProvider = "faux";
async function initProvider() {
  const cfg = await loadConfig();
  for (const p of models.getProviders()) models.deleteProvider(p.id);
  if (cfg.apiKey) {
    const def = PROVIDERS[cfg.provider] ?? PROVIDERS.openai;
    useFaux = false;
    const p = await def.load();
    if (cfg.baseUrl) {
      p.baseUrl = cfg.baseUrl;
      const all = typeof p.getAllModels === "function" ? p.getAllModels() : [];
      for (const m of all) m.baseUrl = cfg.baseUrl;
    }
    models.setProvider(p);
    currentModelProvider = p.id;
    let modelId = cfg.modelId;
    try {
      const available = (await p.getModels()).map((m) => m.id);
      if (available.length > 0 && modelId && !available.includes(modelId)) {
        console.warn(`[config] 模型 "${modelId}" 不在 ${cfg.provider} 列表中，自动改用 "${available[0]}"`);
        modelId = available[0];
      }
    } catch {
      /* ignore */
    }
    model = { provider: p.id, modelId };
  } else {
    useFaux = true;
    faux = fauxProvider();
    currentModelProvider = "faux";
    model = { provider: "faux", modelId: "faux-1" };
    models.setProvider(faux.provider);
  }
  return !!cfg.apiKey;
}
let hasKey = false;
async function refreshProvider() {
  hasKey = await initProvider();
  return hasKey;
}
await refreshProvider();

// ─── 配置加载：agent 定义 / 助理 ────────────────────────────────────────────
/** 解析 .md 的 frontmatter + 正文。frontmatter：model / tools / agents */
function parseAgentDef(md) {
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

/** agent 定义按"项目优先、全局兜底"查找 */
function agentDefCandidates(projectName, agentName) {
  const list = [];
  if (projectName) list.push(join(PROJECTS_DIR, projectName, ".pi", "agents", `${agentName}.md`));
  list.push(join(GLOBAL_AGENTS_DIR, `${agentName}.md`));
  return list;
}
async function loadAgentDef(projectName, agentName) {
  for (const p of agentDefCandidates(projectName, agentName)) {
    try {
      return { name: agentName, source: p, scope: p.startsWith(GLOBAL_AGENTS_DIR) ? "global" : "project", ...parseAgentDef(await readFile(p, "utf-8")) };
    } catch {
      /* try next */
    }
  }
  return null;
}

/** 列出项目可用 agent：全局库 + 项目覆盖（同名项目优先） */
async function listAgents(projectName) {
  const names = new Map();
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

async function loadAssistant(projectName) {
  const p = join(PROJECTS_DIR, projectName, ".pi", "assistant.md");
  try {
    const def = parseAgentDef(await readFile(p, "utf-8"));
    return { model: def.model, agents: def.agents ?? [], instructions: def.instructions };
  } catch {
    return { model: null, agents: [], instructions: "" };
  }
}

function assistantInstructions(projectName, assistant, agents) {
  const parts = [
    assistant.instructions?.trim() ||
      `你是项目「${projectName}」的助理。理解用户意图，必要时用 subagent 工具把任务派发给合适的子 agent，并汇总结果。`,
  ];
  const available = assistant.agents?.length ? assistant.agents.filter((n) => agents.some((a) => a.name === n)) : agents.map((a) => a.name);
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

function resolveAgentModel(defModel, fallback) {
  if (!defModel) return fallback;
  if (defModel.includes("/")) {
    const [provider, modelId] = defModel.split("/");
    if (models.getModel(provider, modelId)) return { provider, modelId };
  }
  if (models.getModel(fallback.provider, defModel)) return { provider: fallback.provider, modelId: defModel };
  return fallback;
}

function answerText(message) {
  if (!message?.content) return "";
  return message.content.flatMap((p) => (p.type === "text" ? [p.text] : [])).join("");
}

// ─── 项目扫描 ──────────────────────────────────────────────────────────────
async function listProjects() {
  try {
    const entries = await readdir(PROJECTS_DIR, { withFileTypes: true });
    return entries.filter((e) => e.isDirectory()).map((e) => e.name).sort();
  } catch {
    return [];
  }
}

// ─── durable 运行态：subagents document + anchor + reporter + subagent 工具 ──
// 主会话用一个 document 记录"子 agent 名 → 会话 id"
const Subagents = defineDoc({
  kind: "pibox.subagents",
  version: 1,
  scope: "conversation",
  history: "latest",
  fork: "initial",
  initial: () => ({ agents: {}, reporters: {} }),
});

// anchor：背景 task，立即 terminal；子 agent 归它所有，从而不阻塞主会话的 idle/Esc
const AnchorTask = defineTask({
  name: "pibox.anchor",
  version: 1,
  initial: () => ({ phase: "done" }),
  phases: {
    done: (_t, runtime, ctx) =>
      runtime.commit(() => ({ status: "terminal", outcome: { status: "completed", result: null } }), ctx),
  },
  abort: (_t, runtime, ctx) => runtime.commit(() => ({ status: "terminal", outcome: { status: "aborted" } }), ctx),
});

// reporter：投递一条消息给子 agent，等答案，把答案回流给主会话
const Reporter = defineTask({
  name: "pibox.reporter",
  version: 1,
  initial: () => ({ phase: "deliver" }),
  phases: {
    deliver: async (reporter, runtime, ctx) => {
      const { name, conversationId, message, followUp } = reporter.input;
      const subagent = await runtime.conversation(conversationId, ctx);
      const request = { type: "input", content: message, whenBusy: followUp ? "followUp" : "steer" };
      const submission = await subagent.submit({ ...request, requestId: `pibox-reporter:${reporter.id}` }, ctx);
      const settled = await submission.wait(ctx);
      await runtime.commit(async (tx) => {
        const next = (report) => ({ status: "running", checkpoint: { phase: "report", report } });
        if (settled.status === "unanswered") {
          return next(settled.reason === "aborted" ? undefined : `[子 agent ${name} 失败: ${settled.reason}]`);
        }
        if (settled.type !== "input") return next();
        const st = await tx.doc(Subagents, runtime.conversationId);
        const agent = st.agents[name];
        if (!agent || agent.reported.includes(settled.answer)) return next();
        agent.reported.push(settled.answer);
        const answer = (await tx.entry(AssistantEntry, settled.answer))?.model?.[0];
        return next(`[子 agent ${name} 回复] ${answerText(answer)}`);
      }, ctx);
    },
    report: async (reporter, runtime, ctx) => {
      const report = reporter.state.checkpoint.report;
      if (report !== undefined) {
        const main = await runtime.conversation(runtime.conversationId, ctx);
        await main.submit({ type: "input", content: report, whenBusy: "followUp", requestId: `pibox-report:${reporter.id}` }, ctx);
      }
      await runtime.commit(() => ({ status: "terminal", outcome: { status: "completed", result: null } }), ctx);
    },
  },
  abort: (_t, runtime, ctx) => runtime.commit(() => ({ status: "terminal", outcome: { status: "aborted" } }), ctx),
});

const SubagentTool = defineTool({
  name: "subagent",
  description:
    "管理持久后台子 agent。action：spawn（创建并派首条消息）/ send（发消息，followUp=true 排在当前回答后）/ stop（中止当前工作）/ status（查状态）。子 agent 干完的答案会自动回到你这里。",
  parameters: Type.Object({
    action: Type.Union([Type.Literal("spawn"), Type.Literal("send"), Type.Literal("stop"), Type.Literal("status")]),
    name: Type.Optional(Type.String({ description: "子 agent 名（对应 .pi/agents/<name>.md）" })),
    message: Type.Optional(Type.String({ description: "消息内容" })),
    followUp: Type.Optional(Type.Boolean({ description: "true=排在当前回答后；false=插话" })),
  }),
  replay: "unsafe",
  execute: async (args, api, ctx) => {
    const { action, name, message, followUp } = args;
    const reply = (text, conversationId) => ({
      content: [{ type: "text", text }],
      ...(conversationId === undefined || name === undefined ? {} : { details: { name, conversationId } }),
    });
    const state = (await api.snapshot(Subagents, api.conversationId, ctx)) ?? { agents: {} };
    const cwd = api.env?.cwd;
    const projectName = cwd ? basename(cwd) : null;

    if (action === "status") {
      const names = name === undefined ? Object.keys(state.agents) : [name];
      const lines = [];
      for (const each of names) {
        const found = state.agents[each];
        if (!found) continue;
        const live = await api.snapshot(LiveDoc, found.conversationId, ctx);
        lines.push(`${each}: ${live?.run !== undefined ? "工作中" : "空闲"}（会话 #${found.conversationId}）`);
      }
      return reply(lines.length === 0 ? "（没有子 agent）" : lines.join("\n"));
    }
    if (!name) return reply(`${action} 需要 name`);
    const agent = Object.hasOwn(state.agents, name) ? state.agents[name] : undefined;
    if (action !== "spawn" && agent === undefined) return reply(`没有名为 ${name} 的子 agent`);

    if (action === "stop") {
      const handle = await api.conversation(agent.conversationId, ctx);
      await handle.abort(ctx);
      return reply(`已停止 ${name}`, agent.conversationId);
    }
    if (!message) return reply(`${action} 需要 message`);

    const result = await api.commit(async (tx) => {
      const s = await tx.doc(Subagents, api.conversationId);
      const background = { ownership: { kind: "conversation" }, background: true };
      if (action === "spawn") {
        if (Object.hasOwn(s.agents, name)) return `${name} 已存在，用 send`;
        const def = await loadAgentDef(projectName, name);
        if (!def) return `未找到 agent 定义 "${name}"（查过项目 .pi/agents/ 与全局库）`;
        const anchor = await tx.createTask(AnchorTask, null, background);
        const child = await tx.createConversation({ ownership: { kind: "task", taskId: anchor } });
        // 子 agent 从主 agent 复制，再 configure 成该 agent 的角色；移除 pi-box 扩展防递归
        await configure(tx, child.id, {
          model: resolveAgentModel(def.model, model),
          instructions: def.instructions,
          extensions: { remove: [PiBoxExtension] },
          cwd,
        });
        s.agents[name] = { conversationId: child.id, reported: [] };
      }
      const conversationId = s.agents[name].conversationId;
      const input = { name, conversationId, message, followUp: action === "send" && followUp === true };
      s.reporters = s.reporters ?? {};
      s.reporters[api.taskId] = await tx.createTask(Reporter, input, background);
      return action === "send" ? `已发送给 ${name}` : `已启动 ${name}`;
    }, ctx);
    const current = (await api.snapshot(Subagents, api.conversationId, ctx))?.agents[name];
    return reply(result, current?.conversationId);
  },
});

const PiBoxExtension = defineExtension({ name: "pi-box", tools: [SubagentTool], tasks: [AnchorTask, Reporter] });

// ─── Harness ───────────────────────────────────────────────────────────────
const registry = createRegistry();
registry.install(CodingTools);
registry.install(PiBoxExtension);

await mkdir(DATA_DIR, { recursive: true });
await mkdir(GLOBAL_AGENTS_DIR, { recursive: true });
const storage = await openNodeSqliteStorage(join(DATA_DIR, "session.sqlite"));
const harness = await Harness.open(
  storage,
  { models, registry, env: (target) => new NodeExecutionEnv({ cwd: target.cwd ?? process.cwd() }), onReport: (e) => console.error("[harness report]", String(e?.stack ?? e)) },
  context,
);

// ─── 项目主会话 = 项目助理 ──────────────────────────────────────────────────
async function ensureProjectConversations() {
  const projects = await listProjects();
  const { items: records } = await harness.commit((tx) => tx.scanConversations({}, 1000, undefined), context);
  const cwdToId = new Map();
  for (const rec of records) {
    const agent = await harness.snapshot(AgentDoc, rec.id, context);
    if (agent?.cwd) cwdToId.set(agent.cwd, rec.id);
  }
  for (const name of projects) {
    const cwd = join(PROJECTS_DIR, name);
    if (cwdToId.has(cwd)) continue;
    await mkdir(cwd, { recursive: true });
    const assistant = await loadAssistant(name);
    const agents = await listAgents(name);
    const conv = await harness.createConversation(
      {
        ownership: { kind: "ownerless" },
        agent: { model: resolveAgentModel(assistant.model, model), instructions: assistantInstructions(name, assistant, agents), cwd },
      },
      context,
    );
    cwdToId.set(cwd, conv.id);
    console.log(`[project] 新建项目会话 #${conv.id} → ${name}`);
  }
}

// ─── 配置变更 → 同步到运行态 ────────────────────────────────────────────
// durable 的 instructions/model 是持久化在会话上的，改文件不会自动更新已存在的会话。
// 保存 agent/assistant 后调用这些函数重新 configure。

/** 刷新某项目的主会话（助理）：instructions + model */
async function syncProjectAssistant(projectName) {
  const cwd = join(PROJECTS_DIR, projectName);
  const assistant = await loadAssistant(projectName);
  const agents = await listAgents(projectName);
  const instructions = assistantInstructions(projectName, assistant, agents);
  const assistantModel = resolveAgentModel(assistant.model, model);
  const { items: records } = await harness.commit((tx) => tx.scanConversations({}, 1000, undefined), context);
  let n = 0;
  for (const rec of records) {
    if (rec.owner !== null && rec.owner !== undefined) continue; // 只看主会话
    const a = await harness.snapshot(AgentDoc, rec.id, context);
    if (a?.cwd !== cwd) continue;
    await harness.commit((tx) => configure(tx, rec.id, { instructions, model: assistantModel }), context);
    n++;
  }
  if (n > 0) console.log(`[sync] 刷新项目助理会话（${projectName}）：${n} 个`);
}

/** 刷新某项目里已存在的、名为 agentName 的子 agent 会话（instructions + model） */
async function syncSubagentInstances(projectName, agentName) {
  const def = await loadAgentDef(projectName, agentName);
  if (!def) return;
  const cwd = join(PROJECTS_DIR, projectName);
  const { items: records } = await harness.commit((tx) => tx.scanConversations({}, 1000, undefined), context);
  for (const rec of records) {
    if (rec.owner !== null && rec.owner !== undefined) continue; // 只看主会话
    const a = await harness.snapshot(AgentDoc, rec.id, context);
    if (a?.cwd !== cwd) continue;
    const st = await harness.snapshot(Subagents, rec.id, context);
    const found = st?.agents?.[agentName];
    if (!found) continue;
    await harness.commit(
      (tx) => configure(tx, found.conversationId, { instructions: def.instructions, model: resolveAgentModel(def.model, model) }),
      context,
    );
    console.log(`[sync] 刷新子 agent ${agentName} 会话 #${found.conversationId}`);
  }
}

// ─── 快照扩展 ─────────────────────────────────────────────────────────────
async function boxSnapshot() {
  const snap = await snapshot(harness, context);
  const { items: records } = await harness.commit((tx) => tx.scanConversations({}, 1000, undefined), context);
  const infoById = new Map();
  for (const rec of records) {
    const agent = await harness.snapshot(AgentDoc, rec.id, context);
    if (agent) infoById.set(String(rec.id), { cwd: agent.cwd, instructions: agent.instructions });
  }
  const conversations = snap.conversations.map((c) => {
    const info = infoById.get(c.id) ?? {};
    const cwd = info.cwd ?? null;
    const project = cwd && cwd.startsWith(PROJECTS_DIR + "/") ? basename(cwd) : null;
    return { ...c, cwd, project, instructions: info.instructions ?? null };
  });
  const projects = await listProjects();
  const agentsByProject = {};
  const assistantByProject = {};
  for (const p of projects) {
    agentsByProject[p] = await listAgents(p);
    assistantByProject[p] = await loadAssistant(p);
  }
  return { ...snap, conversations, model, hasKey, projects, agentsByProject, assistantByProject };
}

// ─── 写回 agent / assistant 定义（文件即真相）──────────────────────────────
function serializeAgentDef({ model: m, tools, agents, instructions }) {
  const fm = [];
  if (m) fm.push(`model: ${m}`);
  if (tools?.length) fm.push(`tools: [${tools.join(", ")}]`);
  if (agents?.length) fm.push(`agents: [${agents.join(", ")}]`);
  const body = (instructions ?? "").trim();
  return fm.length ? `---\n${fm.join("\n")}\n---\n\n${body}\n` : `${body}\n`;
}

function agentFilePath(projectName, agentName, scope) {
  const dir = scope === "global" ? GLOBAL_AGENTS_DIR : join(PROJECTS_DIR, projectName, ".pi", "agents");
  return join(dir, `${agentName}.md`);
}

async function readBody(req) {
  let body = "";
  for await (const chunk of req) body += chunk;
  return JSON.parse(body || "{}");
}

// ─── 启动服务 ─────────────────────────────────────────────────────────────
await ensureProjectConversations();
const server = createWebServer({
  harness,
  context,
  getSnapshot: boxSnapshot,
  createConversation: () =>
    harness.createConversation({ ownership: { kind: "ownerless" }, agent: { model, cwd: PROJECTS_DIR } }, context),
  extraRoutes: {
    // 项目：GET 列表 / POST 新建（建目录 + 助理会话）
    "/api/projects": {
      methods: ["GET", "POST"],
      async handler(req, res) {
        if (req.method === "GET") {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ projects: await listProjects() }));
          return;
        }
        let { name } = await readBody(req);
        if (!name || !/^[a-zA-Z0-9_-]+$/.test(name)) {
          res.writeHead(400);
          res.end(JSON.stringify({ error: "项目名只能含字母、数字、-、_" }));
          return;
        }
        if ((await listProjects()).includes(name)) {
          res.writeHead(409);
          res.end(JSON.stringify({ error: `项目 "${name}" 已存在` }));
          return;
        }
        const cwd = join(PROJECTS_DIR, name);
        await mkdir(cwd, { recursive: true });
        const assistant = await loadAssistant(name);
        const agents = await listAgents(name);
        const conv = await harness.createConversation(
          {
            ownership: { kind: "ownerless" },
            agent: { model: resolveAgentModel(assistant.model, model), instructions: assistantInstructions(name, assistant, agents), cwd },
          },
          context,
        );
        console.log(`[project] 新建项目 ${name} → 会话 #${conv.id}`);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true, project: name, conversationId: conv.id }));
      },
    },
    // provider 列表
    "/api/providers": {
      method: "GET",
      async handler(req, res) {
        const modelsByProvider = await getAllProviderModels();
        const providers = PROVIDER_LIST.map((p) => {
          const ms = modelsByProvider[p.id] ?? [];
          return { ...p, models: ms, defaultModel: ms[0] ?? p.defaultModel };
        });
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ providers }));
      },
    },
    // 模型设置
    "/api/settings": {
      methods: ["GET", "POST"],
      async handler(req, res) {
        if (req.method === "GET") {
          const cfg = await loadConfig();
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ provider: cfg.provider, modelId: cfg.modelId, baseUrl: cfg.baseUrl, hasKey: !!cfg.apiKey }));
          return;
        }
        let { provider, modelId, apiKey, baseUrl } = await readBody(req);
        if (!provider) provider = "openai";
        const meta = PROVIDER_LIST.find((p) => p.id === provider);
        if (!modelId) modelId = meta?.defaultModel || "gpt-4o";
        if (baseUrl === undefined) baseUrl = meta?.defaultBaseUrl || "";
        const modelsByProvider = await getAllProviderModels();
        const available = modelsByProvider[provider] ?? [];
        if (available.length > 0 && modelId && !available.includes(modelId)) {
          res.writeHead(400);
          res.end(JSON.stringify({ error: `模型 "${modelId}" 不在 ${provider} 的可用列表中`, available: available.slice(0, 30) }));
          return;
        }
        const old = await loadConfig();
        if (apiKey === undefined || apiKey === null) apiKey = old.apiKey || "";
        await saveConfig({ provider, modelId, apiKey, baseUrl });
        const newHasKey = await refreshProvider();
        // 重配所有会话的 model
        const { items: records } = await harness.commit((tx) => tx.scanConversations({}, 1000, undefined), context);
        for (const rec of records) {
          const a = await harness.snapshot(AgentDoc, rec.id, context);
          if (a && a.model?.provider !== model.provider) {
            await harness.commit((tx) => configure(tx, rec.id, { model: { provider: model.provider, modelId: model.modelId } }), context);
          }
        }
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true, hasKey: newHasKey, provider, modelId, baseUrl, effectiveProvider: model.provider }));
      },
    },
    // agent 列表 / 保存 / 删除
    "/api/agents": {
      methods: ["GET", "POST"],
      async handler(req, res) {
        if (req.method === "GET") {
          const url = new URL(req.url, `http://${req.headers.host}`);
          const project = url.searchParams.get("project");
          if (!project) {
            res.writeHead(400);
            res.end(JSON.stringify({ error: "缺少 project 参数" }));
            return;
          }
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ project, agents: await listAgents(project) }));
          return;
        }
        // POST 保存 agent 定义
        const { project, name, scope = "global", model: m, tools, instructions } = await readBody(req);
        if (!name || !/^[a-zA-Z0-9_-]+$/.test(name)) {
          res.writeHead(400);
          res.end(JSON.stringify({ error: "agent 名只能含字母、数字、-、_" }));
          return;
        }
        if (scope === "project" && !project) {
          res.writeHead(400);
          res.end(JSON.stringify({ error: "项目级 agent 需要 project 参数" }));
          return;
        }
        const file = agentFilePath(project, name, scope);
        await mkdir(dirname(file), { recursive: true });
        await writeFile(file, serializeAgentDef({ model: m, tools, instructions }), "utf-8");
        // 同步到运行态（已存在的主会话/子会话）
        const targets = scope === "global" ? await listProjects() : [project];
        for (const p of targets) {
          await syncProjectAssistant(p);
          await syncSubagentInstances(p, name);
        }
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true, name, scope, file }));
      },
    },
    "/api/agents/delete": {
      method: "POST",
      async handler(req, res) {
        const { project, name, scope = "global" } = await readBody(req);
        if (!name) {
          res.writeHead(400);
          res.end(JSON.stringify({ error: "缺少 name" }));
          return;
        }
        const { unlink } = await import("node:fs/promises");
        try {
          await unlink(agentFilePath(project, name, scope));
        } catch {
          /* 不存在也算成功 */
        }
        const targets = scope === "global" ? await listProjects() : [project];
        for (const p of targets) await syncProjectAssistant(p);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true }));
      },
    },
    // 助理：GET 读 / POST 保存
    "/api/assistant": {
      methods: ["GET", "POST"],
      async handler(req, res) {
        if (req.method === "GET") {
          const url = new URL(req.url, `http://${req.headers.host}`);
          const project = url.searchParams.get("project");
          if (!project) {
            res.writeHead(400);
            res.end(JSON.stringify({ error: "缺少 project 参数" }));
            return;
          }
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ project, assistant: await loadAssistant(project) }));
          return;
        }
        const { project, model: m, agents, instructions } = await readBody(req);
        if (!project) {
          res.writeHead(400);
          res.end(JSON.stringify({ error: "缺少 project" }));
          return;
        }
        const file = join(PROJECTS_DIR, project, ".pi", "assistant.md");
        await mkdir(dirname(file), { recursive: true });
        await writeFile(file, serializeAgentDef({ model: m, agents, instructions }), "utf-8");
        await syncProjectAssistant(project);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true, file }));
      },
    },
  },
  webDir: WEB_DIR,
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`pi-boxd 已启动: http://localhost:${PORT}`);
  console.log(`项目目录: ${PROJECTS_DIR}`);
  console.log(`全局 agent 库: ${GLOBAL_AGENTS_DIR}`);
  console.log(`存储: ${join(DATA_DIR, "session.sqlite")}`);
  console.log(`模型: ${useFaux ? "faux（离线）" : `${model.provider}/${model.modelId}`}`);
});
