// Pi Durable PoC
// 验证点：
//   1. 两层 subagent（root conversation → owned conversation），父子层级可观测
//   2. MCP server（本地 mock stdio）通过 pi-mcp 包装成 durable 工具，child 可调用
//   3. taskGraph + watchEvents 打印运行拓扑
// 模型：有 OPENAI_API_KEY 用真实 openai；否则用 faux 脚本化（离线可跑）
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { mkdir, rm } from "node:fs/promises";

import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { Context } from "@earendil-works/chord";
import { Type } from "@earendil-works/pi-ai";
import type { AssistantMessage, FauxResponseStep } from "@earendil-works/pi-ai";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { openaiProvider } from "@earendil-works/pi-ai/providers/openai";
import { McpClient, StdioTransport, toLlmContent } from "@earendil-works/pi-mcp";
import {
  type AgentEvent,
  AssistantEntry,
  configure,
  type ConversationId,
  createRegistry,
  defineExtension,
  defineTask,
  defineTool,
  type EntryId,
  Harness,
  type TaskGraph,
  type TaskGraphNode,
  type TaskId,
  type ToolExecutionApi,
  watchEvents,
} from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";

const context = BACKGROUND_CONTEXT;
const here = dirname(fileURLToPath(import.meta.url)); // poc/durable/src
const baseDir = join(here, ".."); // poc/durable
const mcpServerPath = join(baseDir, "mcp-server.mjs");
const dataDir = join(baseDir, "data");

// ─── 1. MCP：连接本地 mock MCP server，把它的工具包装成 durable 工具 ───
async function setupMcp(registry: ReturnType<typeof createRegistry>) {
  const client = new McpClient({ name: "pi-durable-poc", version: "0.0.1" });
  await client.connect(new StdioTransport({ command: "node", args: [mcpServerPath] }));
  const mcpTools = (await client.listTools()).map((tool) => ({
    name: `mcp_${tool.name}`.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 64),
    label: tool.title ?? tool.name,
    description: tool.description ?? tool.name,
    parameters: Type.Unsafe({ ...tool.inputSchema, type: "object", properties: tool.inputSchema.properties ?? {} }),
    replay: "unsafe" as const,
    execute: async (args: Record<string, unknown>, _api: ToolExecutionApi, ctx: Context) => {
      const result = await client.callTool(tool.name, args, { signal: ctx.abortSignal });
      // MCP 的工具失败在 result.isError 里，不是协议异常
      return { content: toLlmContent(result), isError: result.isError === true };
    },
  }));
  registry.install(defineExtension({ name: "mcp", tools: mcpTools }));
  console.log(`[mcp] 已连接 mock MCP，工具: ${mcpTools.map((t) => t.name).join(", ")}`);
  return client;
}

// ─── 2. subagent 工具（owned conversation）───
async function answerText(api: ToolExecutionApi, answer: EntryId, ctx: Context): Promise<string> {
  const entry = await api.commit((tx) => tx.entry(AssistantEntry, answer), ctx);
  const message = entry?.model?.[0] as AssistantMessage;
  return message.content.flatMap((c) => (c.type === "text" ? [c.text] : [])).join("");
}

const Subagent = defineExtension({
  name: "subagent",
  tools: [
    defineTool({
      name: "delegate",
      description: "把独立任务交给子 agent，返回它的答案",
      parameters: Type.Object({ task: Type.String({ description: "子 agent 要做的任务" }) }),
      replay: "safe",
      execute: async (args, api, ctx) => {
        // child 归本工具调用的 task 所有：abort 本调用会连带 abort child；调用完成前 child 必须跑完
        const child = await api.commit(async (tx) => {
          // 崩溃重放幂等：重跑时找到已创建的 child 而不是再建一个
          const existing = (await tx.scanConversations({ ownerTaskId: api.taskId }, 1)).items[0];
          if (existing !== undefined) return existing.id;
          // 默认继承父的 agent（model/thinking/cwd/extensions/tools）
          const created = await tx.createConversation({ ownership: { kind: "task", taskId: api.taskId } });
          // 移除本扩展，防止子 agent 再递归派 delegate
          await configure(tx, created.id, { extensions: { remove: [Subagent] } });
          return created.id;
        }, ctx);
        // 父会话的 UI 通过 details 能挂到 child
        await api.details({ conversationId: child }, ctx);

        const handle = (await api.conversation(child, ctx))!;
        const request = { type: "input", content: args.task, requestId: `delegate:${api.taskId}` } as const;
        const settled = await (await handle.submit(request, ctx)).wait(ctx);
        if (settled.status !== "done" || settled.type !== "input") {
          throw new Error(`子 agent 失败: ${settled.status}`);
        }
        const text = await answerText(api, settled.answer, ctx);
        return { content: [{ type: "text", text }], details: { conversationId: child } };
      },
    }),
  ],
});

// ─── 2b. child tasks 演示（任务运行中抓任务图）───
type PaymentResult = { card: string };
const Payment = defineTask<{ card: string }, { phase: "charge"; at: number }, PaymentResult>({
  name: "demo.payment",
  version: 1,
  initial: () => ({ phase: "charge", at: Date.now() + 500 }),
  phases: {
    charge: async (task, runtime, taskContext) => {
      await runtime.sleep(task.state.checkpoint.at, taskContext);
      await runtime.commit(
        () => ({ status: "terminal", outcome: { status: "completed", result: { card: task.input.card } } }),
        taskContext,
      );
    },
  },
});

type CheckoutState = { phase: "pay" } | { phase: "decide"; payments: TaskId<PaymentResult>[] };
const Checkout = defineTask<{ cards: string[] }, CheckoutState, string>({
  name: "demo.checkout",
  version: 1,
  initial: () => ({ phase: "pay" }),
  phases: {
    pay: async (task, runtime, taskContext) => {
      await runtime.commit(async (tx) => {
        const payments: TaskId<PaymentResult>[] = [];
        for (const card of task.input.cards) {
          payments.push(await tx.createTask(Payment, { card }, { ownership: { kind: "task", taskId: task.id } }));
        }
        return { status: "waiting", checkpoint: { phase: "decide", payments }, on: payments, policy: "allSettled" };
      }, taskContext);
    },
    decide: async (task, runtime, taskContext) => {
      const outcomes = await runtime.outcomes(task.state.checkpoint.payments, taskContext);
      const summary = outcomes.map((o) => o.status).join(",");
      await runtime.commit(
        () => ({ status: "terminal", outcome: { status: "completed", result: `payments=${summary}` } }),
        taskContext,
      );
    },
  },
});
const DemoTasks = defineExtension({ name: "demo-tasks", tasks: [Payment, Checkout] });

// ─── 3. 模型：有 key 用 openai，否则 faux 脚本化 ───
const models = createModels();
let model = { provider: "openai", modelId: "gpt-6-sol" };
const useFaux = process.env.OPENAI_API_KEY === undefined;
if (useFaux) {
  const faux = fauxProvider();
  models.setProvider(faux.provider);
  model = { provider: "faux", modelId: "faux-1" };
  // 脚本化 4 轮：root 派 delegate → child 调 mcp_add → child 回答 → root 总结
  faux.setResponses([
    fauxAssistantMessage(
      [fauxToolCall("delegate", { task: "用 add 工具算 2+3，然后告诉我结果" }, { id: "call-1" })],
      { stopReason: "toolUse" },
    ),
    fauxAssistantMessage([fauxToolCall("mcp_add", { a: 2, b: 3 }, { id: "call-2" })], { stopReason: "toolUse" }),
    fauxAssistantMessage([fauxText("5")]),
    fauxAssistantMessage([fauxText("子 agent 说结果是 5")]),
  ] satisfies FauxResponseStep[]);
  console.log("[model] 无 OPENAI_API_KEY，使用 faux 脚本化模型");
} else {
  models.setProvider(openaiProvider());
  console.log("[model] 使用真实 openai 模型");
}

// ─── 4. harness + SQLite 落盘 ───
await rm(dataDir, { recursive: true, force: true });
await mkdir(dataDir, { recursive: true });
const registry = createRegistry();
registry.install(Subagent);
registry.install(DemoTasks);
const mcpClient = await setupMcp(registry);
// storage 单进程独占；reopen 时重新 openNodeSqliteStorage（同一文件）
const openHarness = async () =>
  Harness.open(await openNodeSqliteStorage(join(dataDir, "session.sqlite")), { models, registry }, context);
let harness = await openHarness();
let root = await harness.root(context, { agent: { model } });

// ─── 5. 事件流：层级打印（child 事件缩进在 delegate 调用之下）───
const print = (indent: string, event: AgentEvent): void => {
  if (event.type === "message_end" && event.entry.kind === "pi.assistant") {
    const message = event.entry.model?.[0] as AssistantMessage;
    const text = message.content.flatMap((c) => (c.type === "text" ? [c.text] : [])).join("");
    if (text !== "") console.log(`${indent}assistant: ${text}`);
  } else if (event.type === "tool_execution_start") {
    console.log(`${indent}tool ${event.toolName}(${JSON.stringify(event.args)})`);
  }
};
const attached = new Set<ConversationId>();
const attach = async (id: ConversationId, indent: string): Promise<void> => {
  attached.add(id);
  const stream = await watchEvents(harness, id, context);
  stream.start(async (events) => {
    for (const event of events) {
      print(indent, event);
      if (event.type !== "tool_execution_update") continue;
      const child = (event.details as { conversationId?: ConversationId } | undefined)?.conversationId;
      if (child !== undefined && !attached.has(child)) await attach(child, `${indent}  `);
    }
  });
};
await attach(root.id, "");

// ─── 6. 跑 ───
console.log("\n── 运行 ──");
const submission = await root.submit(
  { type: "input", content: "用 delegate 工具，让子 agent 算 2+3，然后告诉我结果" },
  context,
);
await submission.wait(context);
await harness.waitForIdle(context);

// ─── 7. 任务图（运行拓扑）───
function printGraph(graph: TaskGraph): void {
  const nodes = Object.values(graph.tasks);
  const printNode = (node: TaskGraphNode, depth: number): void => {
    const state = node.state;
    const status = state.status === "waiting" ? `waiting on ${state.on.join(", ")}` : state.status;
    console.log(`  ${"  ".repeat(depth)}${node.kind} #${node.id}: ${status}`);
    for (const child of nodes.filter((candidate) => candidate.owner === node.id)) printNode(child, depth + 1);
  };
  for (const node of nodes.filter((candidate) => candidate.owner === undefined)) printNode(node, 0);
}
console.log("\n── child tasks：任务运行中抓任务图（live 任务树）──");
const checkoutId = await root.commit(
  (tx) => tx.createTask(Checkout, { cards: ["a", "b", "c"] }, { ownership: { kind: "conversation" } }),
  context,
);
await new Promise((resolve) => setTimeout(resolve, 150)); // 让 payment 跑起来（live 状态）
const graph = await harness.taskGraph(context);
printGraph(graph.value);
graph.dispose();
const checkoutOutcome = (await harness.waitForTask(checkoutId, context)).state.outcome;
console.log(`  checkout 结果: ${checkoutOutcome.status} -> ${JSON.stringify(checkoutOutcome.result)}`);

// 事件回调在 commit 之后才跑，让最后的打印落盘
console.log("\n── 崩溃恢复：进程中途 close，reopen 后继续 ──");
const crashId = await root.commit(
  (tx) => tx.createTask(Checkout, { cards: ["x", "y", "z"] }, { ownership: { kind: "conversation" } }),
  context,
);
await new Promise((resolve) => setTimeout(resolve, 20)); // payment 还在 running
await harness.close(context); // 模拟进程崩溃
console.log("  （harness 已 close，模拟崩溃）");
harness = await openHarness(); // 新进程重新打开同一 SQLite
root = await harness.root(context);
const crashOutcome = (await harness.waitForTask(crashId, context)).state.outcome;
console.log(`  reopen 后 checkout 结果: ${crashOutcome.status} -> ${JSON.stringify(crashOutcome.result)}`);

await new Promise((resolve) => setTimeout(resolve, 0));
await harness.close(context);
await mcpClient.close();
console.log("\n── 完成，会话已落盘到", join(dataDir, "session.sqlite"), "──");
