// pi-box 的 durable 扩展：subagent 工具 + Anchor + Reporter（对应 23-subagent-background）
// 主 agent 用 subagent 工具 spawn 出命名的子 agent conversation，Reporter 把答案自动回流主会话。
import { Type } from "@earendil-works/pi-ai";
import { AssistantEntry, LiveDoc, configure, defineDoc, defineExtension, defineTask, defineTool } from "@earendil-works/pi-durable";
import { basename } from "node:path";
import {
  assistantInstructions,
  answerText,
  listAgents,
  loadAssistant,
  loadEnabledAgentDef,
  resolveAgentModel,
  resolveAgentTools,
  resolveAssistantTools,
} from "./agents.mjs";
import { runCommand } from "./exec.mjs";
import { acquireScheduleLock, logLine, markOccurrence, openRunLog, writeSkippedLog } from "./schedule-log.mjs";

// 主会话用 document 记录"子 agent 名 → 会话 id"
export const Subagents = defineDoc({
  kind: "pibox.subagents",
  version: 1,
  scope: "conversation",
  history: "latest",
  fork: "initial",
  initial: () => ({ agents: {}, reporters: {} }),
});

// 会话属于哪个逻辑角色。UI 用它把“角色配置”和“一次会话实例”分开。
export const ConversationMeta = defineDoc({
  kind: "pibox.conversation-meta",
  version: 1,
  scope: "conversation",
  history: "latest",
  fork: "initial",
  initial: () => ({
    project: null,
    actorType: null,
    actorName: null,
    source: null,
    title: null,
    parentConversationId: null,
    scheduleId: null,
    scheduleRunId: null,
    createdAt: null,
  }),
});

export async function setConversationMeta(tx, conversationId, value) {
  const meta = await tx.doc(ConversationMeta, conversationId);
  Object.assign(meta, value);
}

// Anchor：背景 task，立即 terminal；子 agent 归它所有，从而不阻塞主会话的 idle/Esc
export const AnchorTask = defineTask({
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
export const ReporterTask = defineTask({
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
      await runtime.commit(async (tx) => {
        const state = await tx.doc(Subagents, runtime.conversationId);
        delete state.reporters?.[String(reporter.id)];
        return { status: "terminal", outcome: { status: "completed", result: null } };
      }, ctx);
    },
  },
  abort: (reporter, runtime, ctx) =>
    runtime.commit(async (tx) => {
      const state = await tx.doc(Subagents, runtime.conversationId);
      delete state.reporters?.[String(reporter.id)];
      return { status: "terminal", outcome: { status: "aborted" } };
    }, ctx),
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
        output: [{ type: "text", text }],
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
      const enabledDef = action === "spawn" || action === "send"
        ? await loadEnabledAgentDef(projectName, name)
        : null;
      if ((action === "spawn" || action === "send") && !enabledDef) {
        return reply(`Agent "${name}" 未在当前项目启用`);
      }
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
        let reused = false;
        if (action === "spawn") {
          if (Object.hasOwn(s.agents, name)) {
            // Agent 是持久会话；重复 spawn（包括改名后的第一次派发）应复用并排队，而不是静默丢弃任务。
            reused = true;
          } else {
            const def = enabledDef;
            const anchor = await tx.createTask(AnchorTask, null, background);
            const child = await tx.createConversation({ ownership: { kind: "task", taskId: anchor } });
            // 子 agent 从主 agent 复制，再 configure 成该 agent 的角色；移除 pi-box 扩展防递归
            await configure(tx, child.id, {
              model: resolveAgentModel(def.model),
              instructions: def.instructions,
              tools: resolveAgentTools(def.tools, def.mcps),
              extensions: { remove: [getPiBoxExtension()] },
              cwd,
            });
            await setConversationMeta(tx, child.id, {
              project: projectName,
              actorType: "agent",
              actorName: name,
              source: "subagent",
              title: name,
              parentConversationId: String(api.conversationId),
              createdAt: new Date().toISOString(),
            });
            s.agents[name] = { conversationId: child.id, reported: [] };
          }
        }
        const conversationId = s.agents[name].conversationId;
        const input = { name, conversationId, message, followUp: reused || (action === "send" && followUp === true) };
        s.reporters = s.reporters ?? {};
        const reporterId = await tx.createTask(ReporterTask, input, background);
        s.reporters[String(reporterId)] = reporterId;
        return action === "send" ? `已发送给 ${name}` : reused ? `已复用 ${name} 的会话并发送任务` : `已启动 ${name}`;
      }, ctx);
      const current = (await api.snapshot(Subagents, api.conversationId, ctx))?.agents[name];
      return reply(result, current?.conversationId);
    },
  });
}

// ── 定时任务：命令段 + 可选的 LLM 段 ──────────────────────────────────────
//
// 一个定时任务 = 一个 ScheduleCommandTask（durable），按需跑两个阶段：
//   command → spawn 命令，输出流式落日志
//   llm     → 建/复用会话，投喂（渲染后的）提示词，其结果由子任务 ScheduleLlmTask 承载
//   finish  → 汇总子任务 outcome，落日志，按需回流主会话
// 命令任务高频，不把 stdout 放进 checkpoint/outcome（那是 SQLite），只放摘要与日志路径。

const PROMPT_SOURCE_CHARS = 4000;
const LLM_ANSWER_CHARS = 4000;

export const ScheduleLlmTask = defineTask({
  name: "pibox.schedule.llm",
  version: 1,
  initial: () => ({ phase: "submit" }),
  phases: {
    submit: async (task, runtime, ctx) => {
      const { conversationId, prompt, occurrenceId, project, scheduleId, logStamp } = task.input;
      const conversation = await runtime.conversation(conversationId, ctx);
      if (!conversation) throw new Error(`找不到定时任务的 LLM 会话 #${conversationId}`);
      try {
        // requestId 保证重启重投不会双发（durable 的 submissions_by_request 去重）。
        const submission = await conversation.submit(
          { type: "input", content: prompt, requestId: `pibox-schedule-llm:${occurrenceId}` },
          ctx,
        );
        const settled = await submission.wait(ctx);
        let answer = "";
        if (settled.status === "done" && settled.type === "input") {
          const entry = await runtime.entry(AssistantEntry, settled.answer, ctx);
          answer = answerText(entry?.model?.[0]) ?? "";
        } else if (settled.status === "unanswered") {
          // 模型报错/被中断：不能算成功，否则定时任务会把“没得到回答”当正常结果。
          const reason = String(settled.reason ?? "unknown");
          await runtime.commit(
            () =>
              ({
                status: "terminal",
                outcome:
                  reason === "aborted"
                    ? { status: "aborted", reason }
                    : { status: "failed", error: { message: `LLM 未给出回答：${reason}` } },
              }),
            ctx,
          );
          return;
        }
        await runtime.commit(
          () => ({
            status: "terminal",
            outcome: {
              status: "completed",
              result: { answer: String(answer).slice(0, LLM_ANSWER_CHARS), answerChars: String(answer).length },
            },
          }),
          ctx,
        );
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.error(`[schedule] LLM 段失败 conversation#${conversationId}:`, message, error instanceof Error ? error.stack : "");
        if (project && scheduleId && logStamp) {
          try {
            const log = await openRunLog({ project, scheduleId, stamp: logStamp });
            log.write(logLine(`LLM 段失败：${message}`));
            await log.close();
          } catch {
            /* 日志失败不影响任务 */
          }
        }
        if (runtime.signal.aborted) {
          await runtime.commit(
            () => ({ status: "terminal", outcome: { status: "aborted", reason: "schedule aborted" } }),
            ctx,
          );
          return;
        }
        await runtime.commit(
          () => ({ status: "terminal", outcome: { status: "failed", error: { message } } }),
          ctx,
        );
      }
    },
  },
  abort: async (task, runtime, ctx) =>
    runtime.commit(() => ({ status: "terminal", outcome: { status: "aborted", reason: "schedule aborted" } }), ctx),
});

/** 把最终状态回写到项目 schedules.json 的 runs（失败不影响任务）。 */
async function updateRunRecord(input, patch) {
  try {
    const { finalizeRun } = await import("./schedules.mjs");
    await finalizeRun(input.project, input.runId, patch);
  } catch {
    /* 运行记录只是观测数据，不能影响任务结果 */
  }
}

/** 渲染 {{var}} 模板；未知变量原样保留，便于排查。 */
function renderPrompt(template, vars) {
  return String(template ?? "").replace(/\{\{(\w+)\}\}/g, (whole, key) =>
    Object.prototype.hasOwnProperty.call(vars, key) ? String(vars[key] ?? "") : whole,
  );
}

/** 按 llm.agent 解析出会话配置：assistant（项目助理）或 agent:<name>（项目子 agent）。 */
async function resolveScheduleRole(project, agentRef) {
  if (!agentRef || agentRef === "assistant") {
    const assistant = await loadAssistant(project);
    const agents = await listAgents(project);
    return {
      actorType: "assistant",
      actorName: "助理",
      config: {
        model: resolveAgentModel(assistant.model),
        instructions: assistantInstructions(project, assistant, agents),
        tools: resolveAssistantTools(assistant.tools, assistant.mcps),
      },
    };
  }
  const name = String(agentRef).replace(/^agent:/, "");
  const def = await loadEnabledAgentDef(project, name);
  if (!def) throw new Error(`定时任务指定的 Agent“${name}”不存在或未在当前项目启用`);
  return {
    actorType: "agent",
    actorName: def.name,
    config: { model: resolveAgentModel(def.model), instructions: def.instructions, tools: resolveAgentTools(def.tools, def.mcps) },
  };
}

export const ScheduleCommandTask = defineTask({
  name: "pibox.schedule.command",
  version: 1,
  initial: (input) => ({
    phase: input.command ? "command" : input.llm ? "llm" : "finish",
    logStamp: null,
    logPath: null,
    startedAt: new Date().toISOString(),
    command: null,
    commandTail: null,
    llmTaskId: null,
    llmConversationId: null,
    llmAnswer: null,
  }),
  phases: {
    // 阶段 1：执行命令（无 command 则直接进入 llm/finish）。
    command: async (task, runtime, ctx) => {
      const input = task.input;
      const cp = task.state.checkpoint;
      const { project, scheduleId, occurrenceId, logRetentionDays } = input;

      // 幂等：同一 occurrence 只执行一次（durable 的 abandonOnRestart 之外的第二道保险）。
      const fresh = await markOccurrence({ project, scheduleId, occurrenceId });
      if (!fresh) {
        await updateRunRecord(input, { status: "completed", result: "duplicate-skip", logPath: cp.logPath ?? null });
        await runtime.commit(
          () => ({
            status: "terminal",
            outcome: { status: "completed", result: { status: "duplicate-skip", logPath: cp.logPath ?? null } },
          }),
          ctx,
        );
        return;
      }

      // 并发：同一任务上一轮还在跑就跳过本次（等价老 pi-job 的 flock）。
      const lock = input.command?.concurrency === "queue" ? { release: async () => {} } : await acquireScheduleLock({ project, scheduleId });
      if (lock === null) {
        const path = await writeSkippedLog({
          project,
          scheduleId,
          occurrenceId,
          reason: "上一轮仍在运行（并发策略 skip）",
        }).catch(() => null);
        await updateRunRecord(input, { status: "skipped-running", logPath: path });
        await runtime.commit(
          () => ({
            status: "terminal",
            outcome: { status: "completed", result: { status: "skipped-running", logPath: path } },
          }),
          ctx,
        );
        return;
      }

      const log = await openRunLog({ project, scheduleId });
      const hasLlm = Boolean(input.llm);
      let result;
      try {
        log.write(logLine(`start: ${input.scheduleName} (${input.kind})`));
        log.write(logLine(`occurrence=${occurrenceId}${input.manual ? " manual" : ""}`));
        log.write(logLine(`command=${input.command.run}`));
        log.write(`--- command ---\n`);
        const { loadCleanupConfig } = await import("./cleanup.mjs");
        const cleanupConfig = await loadCleanupConfig().catch(() => null);
        result = await runCommand({
          command: input.command.run,
          cwd: input.command.cwd || input.projectCwd,
          timeoutSec: input.command.timeoutSec,
          maxBytes: cleanupConfig?.logs?.maxRunBytes,
          signal: runtime.signal,
          write: (chunk) => log.write(chunk),
        });
        log.write(`\n--- command end: exit=${result.exitCode ?? "null"} duration=${Math.round(result.durationMs / 1000)}s${
          result.timedOut ? " timeout" : ""
        }${result.aborted ? " aborted" : ""}${result.truncated ? " truncated" : ""}\n`);
      } catch (error) {
        log.write(logLine(`命令执行失败：${error instanceof Error ? error.message : String(error)}`));
        result = {
          exitCode: 1,
          durationMs: 0,
          timedOut: false,
          aborted: false,
          truncated: false,
          bytes: 0,
          tail: "",
          signal: null,
        };
      } finally {
        await log.close();
        await lock.release();
      }

      const commandSummary = {
        exitCode: result.exitCode,
        signal: result.signal ?? null,
        durationMs: result.durationMs,
        timedOut: result.timedOut,
        aborted: result.aborted,
        truncated: result.truncated,
        bytes: result.bytes,
      };
      const nextCheckpoint = {
        ...cp,
        logStamp: log.stamp,
        logPath: log.path,
        command: commandSummary,
        // 只有还需要 LLM 的任务才留一份输出尾巴（放 SQLite，必须小）。
        commandTail: hasLlm ? String(result.tail ?? "").slice(-PROMPT_SOURCE_CHARS * 4) : null,
      };

      if (result.aborted || result.exitCode === null || runtime.signal.aborted) {
        await openRunLog({ project, scheduleId, stamp: log.stamp })
          .then(async (l) => {
            l.write(logLine("命令被中断（进程退出/任务 abort）"));
            await l.close();
          })
          .catch(() => {});
        await updateRunRecord(input, { status: "aborted", ...commandSummary, logPath: log.path });
        await runtime.commit(
          () => ({
            status: "terminal",
            outcome: { status: "aborted", reason: "schedule aborted", result: { logPath: log.path } },
          }),
          ctx,
        );
        return;
      }

      const exitOk = result.exitCode === 0 && !result.timedOut;
      const runLlm = hasLlm && (exitOk || input.llm.onCommandFailure !== "skip");
      if (!runLlm) {
        const log2 = await openRunLog({ project, scheduleId, stamp: log.stamp });
        log2.write(logLine(hasLlm ? "命令失败且 onCommandFailure=skip，跳过 LLM 段" : "无 LLM 段，任务结束"));
        await log2.close();
        await updateRunRecord(input, {
          status: exitOk ? "completed" : "failed",
          ...commandSummary,
          logPath: log.path,
        });
        await runtime.commit(
          () => ({
            status: "terminal",
            outcome: {
              status: exitOk ? "completed" : "failed",
              ...(exitOk
                ? { result: { status: "completed", ...commandSummary, logPath: log.path } }
                : { error: { message: `命令退出码 ${result.exitCode ?? "null"}`, detail: { ...commandSummary, logPath: log.path } } }),
            },
          }),
          ctx,
        );
        return;
      }

      await runtime.commit(
        () => ({ status: "running", checkpoint: { ...nextCheckpoint, phase: "llm" } }),
        ctx,
      );
      void logRetentionDays;
    },

    // 阶段 2：把命令输出交给 LLM（新建/复用会话），结果由子任务承载。
    llm: async (task, runtime, ctx) => {
      const input = task.input;
      let cp = task.state.checkpoint;
      const llm = input.llm;
      if (!llm) {
        await runtime.commit(() => ({ status: "running", checkpoint: { ...cp, phase: "finish" } }), ctx);
        return;
      }

      // 纯 LLM 任务（无 command 阶段）还没有日志文件，这里补建并记入 checkpoint。
      if (!cp.logStamp) {
        const created = await openRunLog({ project: input.project, scheduleId: input.scheduleId });
        cp = { ...cp, logStamp: created.stamp, logPath: created.path };
        await runtime.commit(() => ({ status: "running", checkpoint: cp }), ctx);
        await created.close();
      }

      const log = await openRunLog({ project: input.project, scheduleId: input.scheduleId, stamp: cp.logStamp });
      if (!cp.command) {
        log.write(logLine(`start: ${input.scheduleName} (${input.kind})`));
        log.write(logLine(`occurrence=${input.occurrenceId}${input.manual ? " manual" : ""}`));
      }
      try {
        const role = await resolveScheduleRole(input.project, llm.agent);
        const sessionMode = llm.session === "persistent" ? "persistent" : "ephemeral";
        let conversationId = input.mainConversationId;
        if (sessionMode === "ephemeral") {
          const cwd = input.projectCwd;
          let createdId = null;
          await runtime.commit(async (tx) => {
            const child = await tx.createConversation({ ownership: { kind: "task", taskId: task.id } });
            await configure(tx, child.id, { ...role.config, cwd });
            await setConversationMeta(tx, child.id, {
              project: input.project,
              actorType: role.actorType,
              actorName: role.actorName,
              source: "schedule",
              title: input.scheduleName,
              parentConversationId: String(input.mainConversationId),
              scheduleId: input.scheduleId,
              scheduleRunId: input.occurrenceId,
              createdAt: new Date().toISOString(),
            });
            createdId = child.id;
            return { status: "running", checkpoint: { ...cp, llmConversationId: createdId } };
          }, ctx);
          conversationId = createdId ?? conversationId;
        }

        const command = cp.command ?? {};
        const prompt = renderPrompt(llm.prompt || input.prompt || "", {
          stdout: cp.commandTail ?? "",
          logPath: cp.logPath ?? "",
          exitCode: command.exitCode ?? "",
          durationMs: command.durationMs ?? "",
          scheduleName: input.scheduleName,
          scheduledAt: input.scheduledAt,
        });
        log.write(`--- llm ---\n`);
        log.write(logLine(`agent=${llm.agent || "assistant"} session=${sessionMode} conversation=#${conversationId}`));
        log.write(`--- prompt ---\n${prompt}\n--- end prompt ---\n`);
        await log.close();

        {
          let childTaskId = null;
          await runtime.commit(async (tx) => {
            childTaskId = await tx.createTask(
              ScheduleLlmTask,
              {
                conversationId,
                prompt,
                occurrenceId: input.occurrenceId,
                project: input.project,
                scheduleId: input.scheduleId,
                logStamp: cp.logStamp,
              },
              { ownership: { kind: "task", taskId: task.id } },
            );
            return {
              status: "waiting",
              checkpoint: { ...cp, phase: "finish", llmTaskId: childTaskId, llmConversationId: conversationId },
              on: [childTaskId],
              policy: "failFast",
            };
          }, ctx);
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        log.write(logLine(`LLM 段启动失败：${message}`));
        await log.close();
        await runtime.commit(
          () => ({ status: "terminal", outcome: { status: "failed", error: { message }, result: { logPath: cp.logPath } } }),
          ctx,
        );
      }
    },

    // 阶段 3：汇总（子任务 outcome → 日志 → 可选回流主会话）→ terminal。
    finish: async (task, runtime, ctx) => {
      const input = task.input;
      const cp = task.state.checkpoint;
      const command = cp.command ?? {};
      const exitOk = command.exitCode === 0 && !command.timedOut;
      let answer = "";
      let llmStatus = "none";

      if (cp.llmTaskId != null) {
        try {
          const [outcome] = await runtime.outcomes([cp.llmTaskId], ctx);
          if (outcome?.status === "completed") {
            llmStatus = "completed";
            answer = String(outcome.result?.answer ?? "");
          } else if (outcome?.status === "aborted") {
            llmStatus = "aborted";
          } else {
            llmStatus = outcome?.status ?? "unknown";
            if (outcome?.error?.message) answer = `[LLM 段失败：${outcome.error.message}]`;
          }
        } catch (error) {
          llmStatus = "unavailable";
          answer = `[读取 LLM 段结果失败：${error instanceof Error ? error.message : String(error)}]`;
        }
      }

      const log = await openRunLog({ project: input.project, scheduleId: input.scheduleId, stamp: cp.logStamp });
      try {
        if (answer) log.write(`--- llm answer ---\n${answer}\n--- end answer ---\n`);
        log.write(logLine(`llm status=${llmStatus}`));

        const reportTo = input.llm?.reportTo ?? "none";
        if (reportTo === "main" && answer) {
          try {
            const main = await runtime.conversation(input.mainConversationId, ctx);
            if (main) {
              await main.submit(
                { type: "input", content: `[定时任务 ${input.scheduleName}]\n${answer}`, whenBusy: "followUp" },
                ctx,
              );
              log.write(logLine("已回流项目主会话"));
            }
          } catch (error) {
            log.write(logLine(`回流主会话失败：${error instanceof Error ? error.message : String(error)}`));
          }
        } else if (reportTo.startsWith("channel:")) {
          log.write(logLine(`reportTo=${reportTo}：渠道推送将在二期实现，本次只落日志`));
        }

        const ok = exitOk && llmStatus !== "failed" && llmStatus !== "aborted";
        log.write(logLine(`end: ${ok ? "completed" : "failed"}${answer ? ` answerChars=${answer.length}` : ""}`));
        await log.close();

        const summary = {
          status: ok ? "completed" : "failed",
          exitCode: command.exitCode ?? null,
          durationMs: command.durationMs ?? null,
          timedOut: Boolean(command.timedOut),
          truncated: Boolean(command.truncated),
          llmStatus,
          logPath: cp.logPath ?? null,
        };
        await updateRunRecord(input, summary);
        await runtime.commit(
          () =>
            ok
              ? { status: "terminal", outcome: { status: "completed", result: summary } }
              : { status: "terminal", outcome: { status: "failed", error: { message: "定时任务失败", detail: summary }, result: summary } },
          ctx,
        );
      } catch (error) {
        await log.close().catch(() => {});
        throw error;
      }
    },
  },
  abort: async (task, runtime, ctx) => {
    // 命令进程由 runCommand 通过 runtime.signal 终止；这里只落最终状态。
    const cp = task.state.checkpoint;
    if (cp?.logStamp && task.input?.project && task.input?.scheduleId) {
      try {
        const log = await openRunLog({ project: task.input.project, scheduleId: task.input.scheduleId, stamp: cp.logStamp });
        log.write(logLine("任务被中断（abort）"));
        await log.close();
      } catch {
        /* 日志失败不影响中断 */
      }
    }
    await runtime.commit(
      () => ({ status: "terminal", outcome: { status: "aborted", reason: "schedule aborted" } }),
      ctx,
    );
  },
});

/** 必须注册，重启时 scheduler 才能按持久化 kind 恢复任务。 */
export const PiBoxTasks = [AnchorTask, ReporterTask, ScheduleCommandTask, ScheduleLlmTask];
