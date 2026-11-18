// 定时任务的最终判定。故意独立成一个模块：
//   schedules.mjs 已经 import extension.mjs（拿 ScheduleCommandTask），
//   如果 extension.mjs 再静态 import schedules.mjs 就成环。这个纯函数两边都要用，
//   放这里谁都能引，不制造循环依赖，也方便单测。

/**
 * 命令段退出码 + LLM 段状态 → "completed" / "failed"。
 *
 * 纯 LLM 任务（kind=llm）没有命令段，`command` 是 undefined。若直接拿
 * `command.exitCode === 0` 判，undefined !== 0 会让判定恒为失败 ——
 * LLM 明明跑完了也记成 failed。只有真的跑过命令才比退出码。
 */
export function scheduleOutcome({ command, llmStatus } = {}) {
  const cmd = command ?? {};
  const hasCommand = cmd.exitCode !== undefined || cmd.timedOut !== undefined;
  const commandOk = !hasCommand || (cmd.exitCode === 0 && !cmd.timedOut);
  const llmOk = llmStatus !== "failed" && llmStatus !== "aborted";
  return commandOk && llmOk ? "completed" : "failed";
}
