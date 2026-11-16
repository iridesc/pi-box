// 左栏状态聚合：子 Agent 与助理两份状态，同名多会话取最活跃的那一个。
import test from "node:test";
import assert from "node:assert/strict";
import { aggregateActorStatus } from "../src/harness.mjs";

const conv = (id, actorType, actorName, status, source = "subagent") => ({ id, actorType, actorName, status, source });

test("助理状态单独聚合，包含主会话/手动会话/定时任务派生的会话", () => {
  const { agents, assistant } = aggregateActorStatus([
    conv("1", "assistant", "助理", "idle", "main"),
    conv("2", "assistant", "助理", "running", "manual"),
    conv("3", "assistant", "助理", "waiting-tool", "schedule"),
  ]);
  assert.deepEqual(agents, {});
  assert.equal(assistant.status, "running"); // 最活跃的赢
  assert.equal(assistant.conversationId, "2");
  assert.deepEqual(assistant.conversationIds, ["1", "2", "3"]);
});

test("子 Agent 按名字分组，助理不混进 agents", () => {
  const { agents, assistant } = aggregateActorStatus([
    conv("10", "agent", "分镜", "pending"),
    conv("11", "agent", "分镜", "running"),
    conv("12", "agent", "文案", "idle"),
    conv("13", "assistant", "助理", "idle"),
  ]);
  assert.deepEqual(Object.keys(agents).sort(), ["分镜", "文案"].sort());
  assert.equal(agents["分镜"].status, "running");
  assert.deepEqual(agents["分镜"].conversationIds, ["10", "11"]);
  assert.equal(agents["文案"].status, "idle");
  assert.deepEqual(assistant.conversationIds, ["13"]);
});

test("没有助理会话时给出空闲空壳（前端照常渲染 ⚙）", () => {
  const { agents, assistant } = aggregateActorStatus([conv("20", "agent", "A", "idle")]);
  assert.equal(assistant.status, "idle");
  assert.equal(assistant.conversationId, null);
  assert.deepEqual(assistant.conversationIds, []);
  assert.equal(agents.A.status, "idle");
});

test("未知状态当作最低优先级，不覆盖已有状态", () => {
  const { assistant } = aggregateActorStatus([
    conv("30", "assistant", "助理", "waiting-tool"),
    conv("31", "assistant", "助理", "error"),
  ]);
  assert.equal(assistant.status, "waiting-tool");
  assert.deepEqual(assistant.conversationIds, ["30", "31"]);
});
