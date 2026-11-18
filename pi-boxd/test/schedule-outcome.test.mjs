// 定时任务成败判定：纯 LLM 任务没有命令段，不能因为 exitCode 是 undefined 就判失败。
import test from "node:test";
import assert from "node:assert/strict";
import { scheduleOutcome } from "../src/schedule-outcome.mjs";

test("纯 LLM 任务（没有命令段）LLM 成功 → completed", () => {
  // cp.command 是 undefined，这是线上「异常扫描器自动处置」被误判 failed 的场景
  assert.equal(scheduleOutcome({ command: undefined, llmStatus: "completed" }), "completed");
});

test("纯 LLM 任务 LLM 失败 → failed", () => {
  assert.equal(scheduleOutcome({ command: undefined, llmStatus: "failed" }), "failed");
  assert.equal(scheduleOutcome({ command: undefined, llmStatus: "aborted" }), "failed");
});

test("命令 + LLM：命令成功、LLM 成功 → completed", () => {
  assert.equal(
    scheduleOutcome({ command: { exitCode: 0, timedOut: false }, llmStatus: "completed" }),
    "completed",
  );
});

test("命令 + LLM：命令非零退出 → failed（即使 LLM 跑完了）", () => {
  assert.equal(
    scheduleOutcome({ command: { exitCode: 2, timedOut: false }, llmStatus: "completed" }),
    "failed",
  );
});

test("命令超时 → failed", () => {
  assert.equal(
    scheduleOutcome({ command: { exitCode: 0, timedOut: true }, llmStatus: "completed" }),
    "failed",
  );
});

test("纯命令任务（没有 LLM 段）按退出码判定", () => {
  assert.equal(scheduleOutcome({ command: { exitCode: 0, timedOut: false }, llmStatus: "none" }), "completed");
  assert.equal(scheduleOutcome({ command: { exitCode: 1, timedOut: false }, llmStatus: "none" }), "failed");
});

test("空输入不炸：当作没有命令段、LLM 未失败", () => {
  assert.equal(scheduleOutcome(), "completed");
  assert.equal(scheduleOutcome({}), "completed");
});
