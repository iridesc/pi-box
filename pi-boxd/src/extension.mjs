// pi-box 的 durable 扩展：subagent 工具 + Anchor + Reporter（对应 23-subagent-background）
// 主 agent 用 subagent 工具 spawn 出命名的子 agent conversation，Reporter 把答案自动回流主会话。
import { Type } from "@earendil-works/pi-ai";
import { AssistantEntry, LiveDoc, configure, defineDoc, defineExtension, defineTask, defineTool } from "@earendil-works/pi-durable";
import { loadAgentDef, resolveAgentModel, answerText } from "./agents.mjs";
import { currentModel } from "./model.mjs";

// 主会话用 document 记录"子 agent 名 → 会话 id"
export const Subagents = defineDoc({
  kind: "pibox.subagents",
  version: 1,
  scope: "conversation",
  history: "latest",
  fork: "initial",
  initial: () => ({ agents: {}, reporters: {} }),
});

// Anchor：背景 task，立即 terminal；子 agent 归它所有，从而不阻塞主会话的 idle/Esc
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

// Reporter：投递一条消息给子 agent，等答案，把答案回流给主会话
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

/** 构造 subagent 工具（用 getter 解决与 PiBoxExtension 的循环引用）。调用时再拿 PiBoxExtension 引用。 */
export function makeSubagentTool(getPiBoxExtension) {
  return defineTool({
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
            model: resolveAgentModel(def.model),
            instructions: def.instructions,
            extensions: { remove: [getPiBoxExtension()] },
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
}
