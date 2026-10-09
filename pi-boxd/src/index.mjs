// pi-boxd：pi-box 的 durable 守护进程。
// 打开一个 Harness（SQLite 落盘），每个「项目目录」对应一个 conversation（cwd 指向项目根），
// 文件工具（read/write/edit/bash）通过 env(cwd) 在各自项目目录里执行 —— 项目隔离的软边界。
// 复用 pi-durable-web 的 core（snapshot + HTTP/SSE）与页面。
import { mkdir, readdir } from "node:fs/promises";
import { basename, join } from "node:path";

import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxProvider } from "@earendil-works/pi-ai/providers/faux";
import { openaiProvider } from "@earendil-works/pi-ai/providers/openai";
import { AgentDoc, createRegistry, Harness } from "@earendil-works/pi-durable";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { CodingTools } from "@earendil-works/pi-durable/tools";

import { createWebServer, snapshot } from "pi-durable-web/src/core.mjs";

const context = BACKGROUND_CONTEXT;
const WORKSPACE = process.env.PI_BOX_WORKSPACE ?? "/workspace";
const PROJECTS_DIR = join(WORKSPACE, "projects");
const DATA_DIR = process.env.PI_BOX_DATA_DIR ?? join(WORKSPACE, ".pi-boxd");
const PORT = Number(process.env.PORT ?? 8787);

// ─── 模型：无 key 用 faux（离线），有则 openai ──────────────────────────────
const models = createModels();
let model = { provider: "openai", modelId: "gpt-6-sol" };
const useFaux = process.env.OPENAI_API_KEY === undefined;
if (useFaux) {
  const faux = fauxProvider();
  models.setProvider(faux.provider);
  model = { provider: "faux", modelId: "faux-1" };
} else {
  models.setProvider(openaiProvider());
}

// ─── Harness：文件工具 + env(cwd) 项目隔离 ──────────────────────────────────
const registry = createRegistry();
registry.install(CodingTools);
await mkdir(DATA_DIR, { recursive: true });
const storage = await openNodeSqliteStorage(join(DATA_DIR, "session.sqlite"));
const harness = await Harness.open(
  storage,
  { models, registry, env: (target) => new NodeExecutionEnv({ cwd: target.cwd ?? process.cwd() }) },
  context,
);

// ─── 项目扫描：projects/<name>/ 目录 ────────────────────────────────────────
async function listProjects() {
  try {
    const entries = await readdir(PROJECTS_DIR, { withFileTypes: true });
    return entries.filter((e) => e.isDirectory()).map((e) => e.name).sort();
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

// ─── 快照扩展：给会话加 cwd/project 字段 ────────────────────────────────────
async function boxSnapshot() {
  const snap = await snapshot(harness, context);
  // AgentDoc 是 conversation 级 doc，需要原始 ConversationId（数字），
  // 而 snapshot() 里已把 id 转成了 String —— 这里重新枚举拿原始 id 读 cwd。
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
  return { ...snap, conversations, model, projects: await listProjects() };
}

// ─── 起服务 ────────────────────────────────────────────────────────────────
await ensureProjectConversations();
const server = createWebServer({
  harness,
  context,
  getSnapshot: boxSnapshot,
  createConversation: () =>
    harness.createConversation({ ownership: { kind: "ownerless" }, agent: { model, cwd: PROJECTS_DIR } }, context),
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`pi-boxd 已启动: http://localhost:${PORT}`);
  console.log(`项目目录: ${PROJECTS_DIR}`);
  console.log(`存储: ${join(DATA_DIR, "session.sqlite")}`);
  console.log(`模型: ${useFaux ? "faux（离线）" : "openai（真实）"}`);
});
