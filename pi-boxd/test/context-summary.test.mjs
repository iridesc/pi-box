// 上下文占用摘要：实测优先、没有实测才全估算；图片按字节单列。
import test from "node:test";
import assert from "node:assert/strict";
import { summarizeContext } from "../src/harness.mjs";

const user = (text) => ({ role: "user", content: text });
const assistant = (text, usage) => ({ role: "assistant", content: [{ type: "text", text }], usage });

test("有实测 usage 时以它为准，只估算它之后的消息", () => {
  const messages = [
    user("x".repeat(3500)), // 1000 tokens 估算
    assistant("ok", { input: 50000, output: 100, cacheRead: 0, cacheWrite: 0, totalTokens: 50100 }),
    user("y".repeat(700)), // 200 tokens 估算
  ];
  const summary = summarizeContext({ messages, contextWindow: 200000 });
  assert.equal(summary.tokens.measured, 50100);
  assert.equal(summary.tokens.estimated, 50300); // 50100 + 200
  assert.ok(Math.abs(summary.ratio - 50300 / 200000) < 1e-9);
  assert.equal(summary.messages, 3);
});

test("没有 usage 时全部估算，measured 为 null", () => {
  const summary = summarizeContext({ messages: [user("z".repeat(3500))], contextWindow: 1000 });
  assert.equal(summary.tokens.measured, null);
  assert.equal(summary.tokens.estimated, 1000);
  assert.equal(summary.ratio, 1);
});

test("图片按字节单列（token 估算里每张图恒为 4800 chars）", () => {
  const image = { role: "toolResult", toolCallId: "c1", content: [{ type: "image", data: "a".repeat(2048), mimeType: "image/png" }] };
  const summary = summarizeContext({ messages: [image], contextWindow: 100000 });
  assert.equal(summary.images.count, 1);
  assert.equal(summary.images.bytes, 2048);
  assert.equal(summary.images.sending.bytes, 2048); // 没超预算，原样发
  assert.ok(summary.tokens.estimated > 0);
});

test("超过图片预算时，sending 按裁剪后的算，stored 保留存量", () => {
  const image = (id, bytes) => ({ role: "toolResult", toolCallId: id, content: [{ type: "image", data: "a".repeat(bytes), mimeType: "image/png" }] });
  const messages = [image("c1", 4096), image("c2", 4096), image("c3", 4096)];
  const summary = summarizeContext({
    messages,
    contextWindow: 100000,
    limits: { triggerBytes: 9000, targetBytes: 5000 },
  });
  assert.equal(summary.images.count, 3);
  assert.equal(summary.images.bytes, 12288);
  // 超了 trigger：从最老的裁到 ≤ target，只剩最新一张真的发出去。
  assert.equal(summary.images.sending.count, 1);
  assert.equal(summary.images.sending.bytes, 4096);
  assert.deepEqual(summary.budget, { triggerBytes: 9000, targetBytes: 5000 });
});

test("上限未知时 ratio 为 null，压缩状态原样透出", () => {
  const summary = summarizeContext({
    messages: [user("hi")],
    contextWindow: undefined,
    compactions: [{ taskId: 3, reason: "manual", blocking: false, attempt: 1 }],
    failure: { taskId: 2, reason: "manual", error: "模型报错" },
  });
  assert.equal(summary.contextWindow, null);
  assert.equal(summary.ratio, null);
  assert.equal(summary.compactions.length, 1);
  assert.equal(summary.failure.error, "模型报错");
});

test("空会话不会算出 NaN", () => {
  const summary = summarizeContext({ messages: [], contextWindow: 128000 });
  assert.equal(summary.messages, 0);
  assert.equal(summary.tokens.measured, null);
  assert.equal(summary.tokens.estimated, 0);
  assert.equal(summary.ratio, 0);
  assert.deepEqual(summary.images, { count: 0, bytes: 0, sending: { count: 0, bytes: 0 } });
});
