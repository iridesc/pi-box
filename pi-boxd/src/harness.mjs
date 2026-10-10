// Harness 创建 + 项目主会话管理 + 配置同步 + 快照
import { mkdir } from "node:fs/promises";
import { basename, join } from "node:path";
import { createRegistry, defineExtension, Harness, configure } from "@earendil-works/pi-durable";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { CodingTools } from "@earendil-works/pi-durable/tools";
import { snapshot } from "pi-durable-web/src/core.mjs";
import { AgentDoc } from "@earendil-works/pi-durable";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";

import { DATA_DIR, GLOBAL_AGENTS_DIR, PROJECTS_DIR } from "./paths.mjs";
import { models, currentModel, getUseFaux, getHasKey } from "./model.mjs";
import {
  listProjects,
  listAgents,
  loadAssistant,
  assistantInstructions,
  resolveAgentModel,
  loadAgentDef,
} from "./agents.mjs";
import { makeSubagentTool, Subagents } from "./extension.mjs";

const context = BACKGROUND_CONTEXT;
export { context };

/** 装好 pi-box 扩展的 Harness + 全局对象。返回时 PiBoxExtension 已注册。 */
export async function createHarness() {
  await mkdir(DATA_DIR, { recursive: true });
  await mkdir(GLOBAL_AGENTS_DIR, { recursive: true });
  const storage = await openNodeSqliteStorage(join(DATA_DIR, "session.sqlite"));

  const registry = createRegistry();
  registry.install(CodingTools);

  // 先建一个占位扩展，工具里通过 getter 拿到它（解决循环引用）
  let piBoxExt = defineExtension({ name: "pi-box", tools: [], tasks: [] });
  const SubagentTool = makeSubagentTool(() => piBoxExt);
  piBoxExt = defineExtension({ name: "pi-box", tools: [SubagentTool], tasks: [] });
  registry.install(piBoxExt);

  const harness = await Harness.open(
    storage,
    {
      models,
      registry,
      env: (target) => new NodeExecutionEnv({ cwd: target.cwd ?? process.cwd() }),
      onReport: (e) => console.error("[harness report]", String(e?.stack ?? e)),
    },
    context,
  );

  return { harness, context, PiBoxExtension: piBoxExt };
}

/** 给定 harness，为项目目录里的每个项目确保有一个主会话（项目助理） */
export async function ensureProjectConversations(harness) {
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
        agent: { model: resolveAgentModel(assistant.model), instructions: assistantInstructions(name, assistant, agents), cwd },
      },
      context,
    );
    cwdToId.set(cwd, conv.id);
    console.log(`[project] 新建项目会话 #${conv.id} → ${name}`);
  }
}

/** 同步：durable 的 instructions/model 持久化在会话上，改文件不会自动更新。保存配置后调用。 */
async function syncProjectAssistant(harness, projectName) {
  const cwd = join(PROJECTS_DIR, projectName);
  const assistant = await loadAssistant(projectName);
  const agents = await listAgents(projectName);
  const instructions = assistantInstructions(projectName, assistant, agents);
  const assistantModel = resolveAgentModel(assistant.model);
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

async function syncSubagentInstances(harness, projectName, agentName) {
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
      (tx) => configure(tx, found.conversationId, { instructions: def.instructions, model: resolveAgentModel(def.model) }),
      context,
    );
    console.log(`[sync] 刷新子 agent ${agentName} 会话 #${found.conversationId}`);
  }
}

/** 保存 agent/assistant 后调用：刷新相关主会话 + 已 spawn 的子 agent */
export async function syncAfterConfigChange(harness, { scope, projectName, agentName }) {
  const projects = scope === "global" ? await listProjects() : [projectName];
  for (const p of projects) {
    await syncProjectAssistant(harness, p);
    if (agentName) await syncSubagentInstances(harness, p, agentName);
  }
}

/** 完整快照：会话 + cwd/project + agentsByProject + assistantByProject + 全局 model */
export async function boxSnapshot(harness) {
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
  return { ...snap, conversations, model: currentModel, hasKey: getHasKey(), projects, agentsByProject, assistantByProject };
}
