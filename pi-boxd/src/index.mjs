// pi-boxd：pi-box 的 durable 守护进程。
// 打开一个 Harness（SQLite 落盘），每个「项目目录」对应一个 conversation（cwd 指向项目根），
// 文件工具（read/write/edit/bash）通过 env(cwd) 在各自项目目录里执行 —— 项目隔离的软边界。
// 复用 pi-durable-web 的 core（snapshot + HTTP/SSE），用自己的 web 目录（含 agent 派发 UI）。
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { basename, join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxProvider, fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { openaiProvider } from "@earendil-works/pi-ai/providers/openai";
import { Type } from "@earendil-works/pi-ai";
import { AgentDoc, configure, createRegistry, defineExtension, defineTool, Harness } from "@earendil-works/pi-durable";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { CodingTools } from "@earendil-works/pi-durable/tools";

import { createWebServer, snapshot } from "pi-durable-web/src/core.mjs";

const context = BACKGROUND_CONTEXT;
const WORKSPACE = process.env.PI_BOX_WORKSPACE ?? "/workspace";
const PROJECTS_DIR = join(WORKSPACE, "projects");
const DATA_DIR = process.env.PI_BOX_DATA_DIR ?? join(WORKSPACE, ".pi-boxd");
const PORT = Number(process.env.PORT ?? 8787);
// 静态页面目录（pi-boxd 自有 web，含 agent 派发 UI）
// 优先用 PI_BOXD_WEB_DIR 环境变量（推荐传绝对路径）；未设则从脚本位置推算。
const _srcDir = dirname(fileURLToPath(import.meta.url)); // .../pi-boxd/src/
const _piBoxdDir = basename(_srcDir) === "src" ? dirname(_srcDir) : _srcDir;
const WEB_DIR = process.env.PI_BOXD_WEB_DIR
  ? resolve(process.env.PI_BOXD_WEB_DIR)
  : join(_piBoxdDir, "web"); // .../pi-boxd/web/

// ─── 模型：有 key 用 openai（兼容 OpenAI 协议，含可配 baseUrl 走其他 provider），无 key 用 faux（离线） ──
const models = createModels();
let model = { provider: "openai", modelId: "gpt-4o" };
let useFaux = true;
let faux = null;
const configPath = join(DATA_DIR, "config.json");

// 读取配置（默认空）
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

// Provider 列表（仅元数据，供前端下拉）
const PROVIDER_LIST = [
  { id: "openai", name: "OpenAI", defaultModel: "gpt-4o", defaultBaseUrl: "https://api.openai.com/v1" },
  { id: "deepseek", name: "DeepSeek", defaultModel: "deepseek-chat", defaultBaseUrl: "https://api.deepseek.com/v1" },
  { id: "anthropic", name: "Anthropic", defaultModel: "claude-3-5-sonnet-latest", defaultBaseUrl: "https://api.anthropic.com" },
  { id: "moonshotai", name: "Moonshot (Kimi)", defaultModel: "moonshot-v1-8k", defaultBaseUrl: "https://api.moonshot.cn/v1" },
  { id: "google", name: "Google Gemini", defaultModel: "gemini-2.0-flash-exp", defaultBaseUrl: "" },
  { id: "groq", name: "Groq", defaultModel: "llama-3.1-70b-versatile", defaultBaseUrl: "https://api.groq.com/openai/v1" },
  { id: "openrouter", name: "OpenRouter", defaultModel: "openai/gpt-4o", defaultBaseUrl: "https://openrouter.ai/api/v1" },
  { id: "mistral", name: "Mistral", defaultModel: "mistral-large-latest", defaultBaseUrl: "https://api.mistral.ai/v1" },
  { id: "xai", name: "xAI (Grok)", defaultModel: "grok-2-latest", defaultBaseUrl: "https://api.x.ai/v1" },
];

// 根据 config 初始化 provider：有 key 则用 openai（或兼容协议），无 key 则 faux
async function initProvider() {
  const cfg = await loadConfig();
  // 清理现有
  for (const p of models.getProviders()) models.deleteProvider(p.id);
  if (cfg.apiKey) {
    useFaux = false;
    model = { provider: cfg.provider, modelId: cfg.modelId };
    // openai-compatible：统一用 openaiProvider
    const p = openaiProvider();
    if (cfg.baseUrl) {
      p.baseUrl = cfg.baseUrl;
    }
    models.setProvider(p);
  } else {
    useFaux = true;
    faux = fauxProvider();
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

// ─── Harness：文件工具 + env(cwd) 项目隔离 ──────────────────────────────────
const registry = createRegistry();
registry.install(CodingTools);

// ─── pi-box 扩展：delegate_agent 工具（owned conversation，保留 ownership 层级）──
const DelegateAgent = defineTool({
  name: "delegate_agent",
  description: "派发任务给项目内配置的 agent。读 <父 cwd>/.pi/agents/<name>.md，创建 owned 子会话（归当前 task 所有），子会话的 instructions/cwd 用 agent 定义。返回子会话 ID。",
  parameters: Type.Object({
    agent: Type.String({ description: "agent 名（.pi/agents/<name>.md 去 .md）" }),
    task: Type.String({ description: "子 agent 要完成的任务描述" }),
  }),
  replay: "safe",
  execute: async (args, api, ctx) => {
    // 1. 父会话的 cwd（env 由 HarnessOptions.env 构造时填入）
    const cwd = api.env?.cwd;
    if (!cwd) throw new Error("父会话没有 cwd，无法定位 .pi/agents/ 目录");
    // 2. 读 agent 定义
    const defPath = join(cwd, ".pi", "agents", `${args.agent}.md`);
    let def;
    try {
      def = parseAgentDef(await readFile(defPath, "utf-8"));
    } catch {
      throw new Error(`Agent "${args.agent}" 不存在（未找到 ${defPath}）`);
    }
    // 3. 创建 owned 子会话（归当前工具调用的 task 所有，崩溃重放幂等）
    const childId = await api.commit(async (tx) => {
      const existing = (await tx.scanConversations({ ownerTaskId: api.taskId }, 1)).items[0];
      if (existing !== undefined) return existing.id;
      const created = await tx.createConversation({ ownership: { kind: "task", taskId: api.taskId } });
      return created.id;
    }, ctx);
    // 4. 配置子 agent（model/instructions/cwd）
    await api.commit((tx) => configure(tx, childId, {
      model: def.model ? { provider: "openai", modelId: def.model } : undefined,
      instructions: def.instructions,
      cwd,
    }), ctx);
    // 5. submit 任务给子会话（不 wait —— 子 agent 后台跑）
    const handle = await api.conversation(childId, ctx);
    if (!handle) throw new Error("无法获取子会话 handle");
    await handle.submit({ type: "input", content: args.task }, ctx);
    return {
      content: [{ type: "text", text: `已派发到 agent "${args.agent}" → 会话 #${childId}（归 task #${api.taskId}）` }],
      details: { conversationId: childId, agent: args.agent },
    };
  },
});
const PiBoxExtension = defineExtension({ name: "pi-box", tools: [DelegateAgent] });
registry.install(PiBoxExtension);

await mkdir(DATA_DIR, { recursive: true });
const storage = await openNodeSqliteStorage(join(DATA_DIR, "session.sqlite"));
const harness = await Harness.open(
  storage,
  { models, registry, env: (target) => new NodeExecutionEnv({ cwd: target.cwd ?? process.cwd() }) },
  context,
);

// ─── 项目扫描 ──────────────────────────────────────────────────────────────
async function listProjects() {
  try {
    const entries = await readdir(PROJECTS_DIR, { withFileTypes: true });
    return entries.filter((e) => e.isDirectory()).map((e) => e.name).sort();
  } catch {
    return [];
  }
}

// ─── Agent 定义解析 ────────────────────────────────────────────────────────
/**
 * 解析 .md 文件的 frontmatter + 正文。
 * frontmatter 示例：
 *   model: openai/gpt-6-sol
 *   tools: [read, write, bash]
 * ---
 * 正文是 instructions。
 */
function parseAgentDef(md) {
  const m = md.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (!m) return { model: null, tools: null, instructions: md.trim() };
  const fm = {};
  for (const line of m[1].split("\n")) {
    const kv = line.match(/^(\w+):\s*(.+)$/);
    if (kv) fm[kv[1].trim()] = kv[2].trim();
  }
  // tools: [read, write] → ["read", "write"]
  let tools = null;
  if (fm.tools) {
    const arr = fm.tools.match(/\[([^\]]+)\]/);
    tools = arr ? arr[1].split(",").map((t) => t.trim()) : null;
  }
  return {
    model: fm.model || null,
    tools,
    instructions: m[2].trim(),
  };
}

/** 列出项目内的 agent 定义 */
async function listAgents(projectName) {
  const agentDir = join(PROJECTS_DIR, projectName, ".pi", "agents");
  try {
    const files = await readdir(agentDir);
    const mdFiles = files.filter((f) => f.endsWith(".md"));
    const agents = await Promise.all(
      mdFiles.map(async (f) => {
        const name = f.replace(/\.md$/, "");
        const content = await readFile(join(agentDir, f), "utf-8");
        const { model: agentModel, tools, instructions } = parseAgentDef(content);
        return { name, model: agentModel, tools, instructions: instructions.slice(0, 100) };
      }),
    );
    return agents;
  } catch {
    return [];
  }
}

// ─── 每个项目确保一个 conversation（cwd 指向项目目录）──────────────────────
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
    const conv = await harness.createConversation({ ownership: { kind: "ownerless" }, agent: { model, cwd } }, context);
    cwdToId.set(cwd, conv.id);
    console.log(`[project] 新建会话 #${conv.id} → ${name}（cwd=${cwd}）`);
  }
}

// ─── 快照扩展：给会话加 cwd/project ───────────────────────────────────────
async function boxSnapshot() {
  const snap = await snapshot(harness, context);
  const { items: records } = await harness.commit((tx) => tx.scanConversations({}, 1000, undefined), context);
  const cwdById = new Map();
  for (const rec of records) {
    const agent = await harness.snapshot(AgentDoc, rec.id, context);
    if (agent?.cwd) cwdById.set(String(rec.id), agent.cwd);
  }
  const conversations = snap.conversations.map((c) => {
    const cwd = cwdById.get(c.id) ?? null;
    const project = cwd && cwd.startsWith(PROJECTS_DIR + "/") ? basename(cwd) : null;
    return { ...c, cwd, project };
  });
  return { ...snap, conversations, model, hasKey, projects: await listProjects() };
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
    // 列出可配置的 provider 列表
    "/api/providers": {
      method: "GET",
      async handler(req, res) {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ providers: PROVIDER_LIST }));
      },
    },
    // 配置读/写（GET 读，POST 写）—— extraRoutes 支持单 method 或方法列表
    "/api/settings": {
      methods: ["GET", "POST"],
      async handler(req, res) {
        if (req.method === "GET") {
          const cfg = await loadConfig();
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({
            provider: cfg.provider,
            modelId: cfg.modelId,
            baseUrl: cfg.baseUrl,
            hasKey: !!cfg.apiKey,
          }));
          return;
        }
        // POST
        let body = "";
        for await (const chunk of req) body += chunk;
        let { provider, modelId, apiKey, baseUrl } = JSON.parse(body || "{}");
        if (!provider) provider = "openai";
        if (!modelId) {
          const meta = PROVIDER_LIST.find((p) => p.id === provider);
          modelId = meta?.defaultModel || "gpt-4o";
        }
        if (baseUrl === undefined) {
          const meta = PROVIDER_LIST.find((p) => p.id === provider);
          baseUrl = meta?.defaultBaseUrl || "";
        }
        const old = await loadConfig();
        if (apiKey === undefined || apiKey === null) apiKey = old.apiKey || "";
        await saveConfig({ provider, modelId, apiKey, baseUrl });
        const newHasKey = await refreshProvider();
        // 重新 configure 现有会话的 model
        const { items: records } = await harness.commit((tx) => tx.scanConversations({}, 1000, undefined), context);
        for (const rec of records) {
          const a = await harness.snapshot(AgentDoc, rec.id, context);
          if (a && (a.model?.provider !== provider || a.model?.modelId !== modelId)) {
            await harness.commit((tx) => configure(tx, rec.id, { model: { provider, modelId } }), context);
          }
        }
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true, hasKey: newHasKey, provider, modelId, baseUrl }));
      },
    },
    // 列出项目内的 agent 定义
    "/api/agents": {
      method: "GET",
      async handler(req, res) {
        const url = new URL(req.url, `http://${req.headers.host}`);
        const project = url.searchParams.get("project");
        if (!project) {
          res.writeHead(400);
          res.end(JSON.stringify({ error: "缺少 project 参数" }));
          return;
        }
        const agents = await listAgents(project);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ project, agents }));
      },
    },
    // 派发 agent 任务
    "/api/delegate": {
      method: "POST",
      async handler(req, res) {
        let body = "";
        for await (const chunk of req) body += chunk;
        let { project, agent, task } = JSON.parse(body || "{}");
        if (!project || !agent || !task) {
          res.writeHead(400);
          res.end(JSON.stringify({ error: "缺少 project/agent/task 参数" }));
          return;
        }
        if (!hasKey) {
          res.writeHead(403);
          res.end(JSON.stringify({ error: "未配置模型 API Key，请点页面右上角⚙设置" }));
          return;
        }
        const cwd = join(PROJECTS_DIR, project);
        const agentDefPath = join(cwd, ".pi", "agents", `${agent}.md`);
        let agentDef;
        try {
          agentDef = parseAgentDef(await readFile(agentDefPath, "utf-8"));
        } catch {
          res.writeHead(404);
          res.end(JSON.stringify({ error: `Agent "${agent}" 不存在（未找到 ${agentDefPath}）` }));
          return;
        }
        // 创建子会话（cwd 指向项目，instructions = agent 定义正文）
        const conv = await harness.createConversation(
          {
            ownership: { kind: "ownerless" }, // P2 先用 ownerless，按 cwd 关联项目
            agent: {
              model: agentDef.model ? { provider: "openai", modelId: agentDef.model } : model,
              instructions: agentDef.instructions,
              cwd,
            },
          },
          context,
        );
        // Conversation.createConversation 返回 Conversation，直接 submit
        await conv.submit({ type: "input", content: task }, context);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ conversationId: conv.id, project, agent, task, cwd }));
      },
    },
    // 演示 delegate_agent 工具（仅 faux 模式）：设 4 轮脚本，提交输入进项目会话
    // 轮 1：父 agent 调 delegate_agent（创建 owned 子会话）
    // 轮 2：父 agent 回复“已派发”
    // 轮 3：子 agent 回复“审查完成”
    // 轮 4：子 agent 回复“任务结束”
    "/api/demo-delegate": {
      method: "POST",
      async handler(req, res) {
        if (!faux) {
          res.writeHead(400);
          res.end(JSON.stringify({ error: "/api/demo-delegate 仅在 faux 模式下可用" }));
          return;
        }
        // 重置 faux 脚本
        faux.setResponses([
          fauxAssistantMessage([fauxToolCall("delegate_agent", { agent: "reviewer", task: "审查项目根目录的文件" }, { id: "demo-1" })], { stopReason: "toolUse" }),
          fauxAssistantMessage([fauxText("已派发 reviewer 去审查项目")], { stopReason: "endTurn" }),
          fauxAssistantMessage([fauxText("审查完成：未发现明显问题")], { stopReason: "endTurn" }),
          fauxAssistantMessage([fauxText("任务结束")], { stopReason: "endTurn" }),
        ]);
        // 找 proj-alpha 会话
        const { items: records } = await harness.commit((tx) => tx.scanConversations({}, 1000, undefined), context);
        let projAlphaConvId = null;
        for (const rec of records) {
          const a = await harness.snapshot(AgentDoc, rec.id, context);
          if (a?.cwd === join(PROJECTS_DIR, "proj-alpha")) {
            projAlphaConvId = rec.id;
            break;
          }
        }
        if (!projAlphaConvId) {
          res.writeHead(404);
          res.end(JSON.stringify({ error: "未找到 proj-alpha 会话" }));
          return;
        }
        const conv = await harness.conversation(projAlphaConvId, context);
        if (!conv) {
          res.writeHead(404);
          res.end(JSON.stringify({ error: "会话 handle 未找到" }));
          return;
        }
        await conv.submit({ type: "input", content: "请审查这个项目" }, context);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true, parentConversationId: projAlphaConvId, note: "看会话树：parent → delegate task → child agent 会话" }));
      },
    },
  },
  webDir: WEB_DIR,
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`pi-boxd 已启动: http://localhost:${PORT}`);
  console.log(`项目目录: ${PROJECTS_DIR}`);
  console.log(`存储: ${join(DATA_DIR, "session.sqlite")}`);
  console.log(`模型: ${useFaux ? "faux（离线）" : "openai（真实）"}`);
});
