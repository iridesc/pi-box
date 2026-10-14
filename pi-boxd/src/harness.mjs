// Harness 创建 + 项目主会话管理 + 配置同步 + 快照
import { mkdir } from "node:fs/promises";
import { basename, join } from "node:path";
import { createRegistry, defineExtension, Harness, configure, LiveDoc } from "@earendil-works/pi-durable";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { CodingTools } from "@earendil-works/pi-durable/tools";
import { createCodemodeExtension } from "@earendil-works/pi-durable/codemode";
import { createToolSearchExtension } from "@earendil-works/pi-durable/tool-search";
import { CodemodeSandbox } from "@earendil-works/pi-codemode";
import { snapshot } from "pi-durable-web/src/core.mjs";
import { AgentDoc } from "@earendil-works/pi-durable";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";

import { DATA_DIR, GLOBAL_AGENTS_DIR, PROJECTS_DIR } from "./paths.mjs";
import { models, currentModel, getUseFaux, getHasKey } from "./model.mjs";
import {
  listProjects,
  listAgents,
  listAgentCatalog,
  listGlobalAgents,
  loadAssistant,
  assistantInstructions,
  resolveAgentModel,
  loadAgentDef,
  resolveAgentTools,
  setMcpToolsByServer,
  AVAILABLE_TOOL_NAMES,
} from "./agents.mjs";
import { makeSubagentTool, PiBoxTasks, Subagents } from "./extension.mjs";
import { McpDurableBridge } from "./mcp-bridge.mjs";

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
  let piBoxExt = defineExtension({ name: "pi-box", tools: [], tasks: PiBoxTasks });
  const SubagentTool = makeSubagentTool(() => piBoxExt);
  piBoxExt = defineExtension({ name: "pi-box", tools: [SubagentTool], tasks: PiBoxTasks });
  registry.install(piBoxExt);

  // MCP 工具先注册为独立 extension；codemode/tool_search 使用 Durable 1.2 的嵌套工具机制调用它们。
  const mcpBridge = new McpDurableBridge(registry);
  await mcpBridge.reload();
  const namespaces = Object.keys(mcpBridge.snapshot()).map((name) => ({
    name: `mcp__${name}`,
    description: `MCP server ${name}`,
    prefix: `mcp__${name.replace(/[^A-Za-z0-9_]/g, "_")}__`,
  }));
  const codemodeExtension = createCodemodeExtension({ sandbox: new CodemodeSandbox(), namespaces });
  const toolSearchExtension = createToolSearchExtension();
  registry.install(codemodeExtension);
  registry.install(toolSearchExtension);
  setMcpToolsByServer(mcpBridge.toolsByServer, [codemodeExtension.tools[0], toolSearchExtension.tools[0]]);

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

  return { harness, context, PiBoxExtension: piBoxExt, mcpBridge };
}

/** 给定 harness，为项目目录里的每个项目确保有一个主会话（项目助理） */
export async function ensureProjectConversations(harness) {
  const projects = await listProjects();
  const { items: records } = await harness.commit((tx) => tx.scanConversations({}, 1000, undefined), context);
  const cwdToId = new Map();
  for (const rec of records) {
    if (rec.owner !== null && rec.owner !== undefined) continue;
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
  // 文件是配置源；每次启动都对账，修复上次写文件后、configure 前崩溃造成的漂移。
  await syncAllConfig(harness);
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
      (tx) => configure(tx, found.conversationId, {
        instructions: def.instructions,
        model: resolveAgentModel(def.model),
        tools: resolveAgentTools(def.tools, def.mcps),
      }),
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
    if (agentName) {
      try {
        await syncSubagentInstances(harness, p, agentName);
      } catch (error) {
        // 配置先落盘；暂时不可达的 MCP 恢复后会在 reload/startup 时重新同步。
        console.error(`[sync] 暂未刷新子 agent ${p}/${agentName}: ${error.message}`);
      }
    }
  }
}

/** 对账所有项目助理和已经创建的子 agent；启动及全局模型变更后调用。 */
export async function syncAllConfig(harness) {
  for (const projectName of await listProjects()) {
    await syncProjectAssistant(harness, projectName);
    for (const agent of await listAgents(projectName)) {
      try {
        await syncSubagentInstances(harness, projectName, agent.name);
      } catch (error) {
        // 单个历史配置有误不应阻止守护进程启动；下一次保存时 API 会拒绝非法工具名。
        console.error(`[sync] 跳过无效 agent 配置 ${projectName}/${agent.name}: ${error.message}`);
      }
    }
  }
}

/** 把 LiveState 折叠成前端可消费的 agent 状态字符串。 */
function deriveAgentStatus(live) {
  if (!live?.run) return "idle";
  const tools = live.tools ?? [];
  // 有工具正在跑（产生输出 / 等待 IO）→ running；其它工具都已结束但至少存在 → waiting-tool。
  if (tools.some((t) => t.status === "running")) return "running";
  if (tools.length > 0) return "waiting-tool";
  return "running";
}

/** 完整快照：会话 + cwd/project + agentsByProject + assistantByProject + agentsStatus + 全局 model */
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
  const agentCatalogByProject = {};
  const assistantByProject = {};
  const agentsStatus = {}; // { [project]: { [name]: { status, conversationId } } }
  for (const p of projects) {
    agentsByProject[p] = await listAgents(p);
    agentCatalogByProject[p] = await listAgentCatalog(p);
    assistantByProject[p] = await loadAssistant(p);
    agentsStatus[p] = {};
    // 主会话：找到该项目主会话（ownerless 且 cwd 是该项目）。
    const mainConv = conversations.find((c) => c.project === p && !c.owner);
    if (!mainConv) continue;
    // snapshot() 返回的 id 是字符串，但 durable API 需要 number。
    const subDoc = await harness.snapshot(Subagents, Number(mainConv.id), context);
    const spawned = subDoc?.agents ?? {};
    for (const name of Object.keys(spawned)) {
      const childId = Number(spawned[name].conversationId);
      let status = "idle";
      try {
        const live = await harness.snapshot(LiveDoc, childId, context);
        status = deriveAgentStatus(live);
      } catch {
        // 子会话可能还没持久化；保持 idle
      }
      agentsStatus[p][name] = { status, conversationId: String(childId) };
    }
  }
  return {
    ...snap,
    conversations,
    model: currentModel,
    hasKey: getHasKey(),
    projects,
    agentsByProject,
    agentCatalogByProject,
    globalAgents: await listGlobalAgents(),
    assistantByProject,
    agentsStatus,
    availableTools: AVAILABLE_TOOL_NAMES,
  };
}
