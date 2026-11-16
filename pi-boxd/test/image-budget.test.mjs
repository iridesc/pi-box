// 图片预算单测：请求级裁剪（boundImages）与存储级剥离（stripImagesFromRecords）。
import test from "node:test";
import assert from "node:assert/strict";
import { boundImages, createImageBudgetExtension, imagePlaceholder, stripImagesFromRecords, toolCallPaths } from "../src/image-budget.mjs";

const MIB = 1024 * 1024;

/** 造一个 toolResult 消息，带一张 `mib` 大小的内联图。 */
function imageResult(callId, mib, { path } = {}) {
  const message = {
    role: "toolResult",
    toolCallId: callId,
    toolName: "read",
    content: [{ type: "text", text: "Read image file [image/png]." }, { type: "image", data: "a".repeat(mib * MIB), mimeType: "image/png" }],
    isError: false,
  };
  if (path !== undefined) {
    return [
      { role: "assistant", content: [{ type: "toolCall", id: callId, name: "read", arguments: { path } }] },
      message,
    ];
  }
  return [message];
}

const images = (messages) =>
  messages.flatMap((message) => (Array.isArray(message.content) ? message.content : []).filter((block) => block.type === "image"));

/** 两种占位：被预算裁掉的（[图片已移除…）与重复副本省掉的（[同一文件 …）。 */
const placeholders = (messages) =>
  messages.flatMap((message) =>
    (Array.isArray(message.content) ? message.content : []).filter(
      (block) => block.type === "text" && (block.text.startsWith("[图片已移除") || block.text.startsWith("[同一文件")),
    ),
  );

test("低于阈值时原样返回，且保持同一个数组引用", () => {
  const messages = imageResult("c1", 1);
  const result = boundImages(messages, { triggerBytes: 8 * MIB, targetBytes: 5 * MIB });
  assert.equal(result.messages, messages);
  assert.equal(result.dropped, 0);
});

test("超过阈值时从最老的开始换成占位，直到降到 target", () => {
  const messages = [1, 2, 3, 4, 5, 6].flatMap((n) => imageResult(`c${n}`, 3));
  const result = boundImages(messages, { triggerBytes: 8 * MIB, targetBytes: 5 * MIB });
  // 18MB 总量，每张 3MB：切断后保留最新两张（6MB，落在迟滞区间内）。
  assert.equal(result.dropped, 4);
  assert.equal(images(result.messages).length, 2);
  // 保留的必然是最新的两张（c5、c6）。
  const kept = result.messages.filter((m) => m.role === "toolResult" && images([m]).length > 0);
  assert.deepEqual(kept.map((m) => m.toolCallId), ["c5", "c6"]);
  assert.equal(placeholders(result.messages).length, 4);
});

test("迟滞：新图片进来时被替换的前缀保持稳定", () => {
  const base = [1, 2, 3].flatMap((n) => imageResult(`c${n}`, 3));
  const limits = { triggerBytes: 8 * MIB, targetBytes: 4 * MIB };
  const first = boundImages(base, limits);
  const firstDropped = first.dropped;
  // 再加一张，总量仍在迟滞区间内 → cut 不变，前缀不动（prompt cache 友好）。
  const second = boundImages([...base, ...imageResult("c4", 3)], limits);
  assert.equal(second.dropped, firstDropped);
  // 继续加到越过 trigger 才前进一次。
  const third = boundImages([...base, ...imageResult("c4", 3), ...imageResult("c5", 3)], limits);
  assert.ok(third.dropped > firstDropped);
});

test("占位文本带上原文件路径，让模型能重新 read", () => {
  const messages = [...imageResult("c1", 6, { path: "items/x/g1-frames/s02-first.png" }), ...imageResult("c2", 6)];
  const result = boundImages(messages, { triggerBytes: 8 * MIB, targetBytes: 2 * MIB });
  assert.equal(result.dropped, 2);
  const texts = placeholders(result.messages).map((block) => block.text);
  assert.match(texts[0], /items\/x\/g1-frames\/s02-first\.png/);
  assert.match(texts[0], /不要凭记忆/);
});

test("toolCallPaths 从工具调用参数里取路径", () => {
  const paths = toolCallPaths([
    [{ role: "assistant", content: [{ type: "toolCall", id: "c1", name: "read", arguments: { path: "/tmp/a.png" } }] }],
  ]);
  assert.equal(paths.get("c1"), "/tmp/a.png");
});

test("stripImagesFromRecords 保留最近 keepBytes 的图片，更老的剥离并把 record 换成新对象", () => {
  const records = [
    { id: 1, record: { model: imageResult("c1", 3, { path: "/tmp/old.png" }) } },
    { id: 2, record: { model: imageResult("c2", 3) } },
    { id: 3, record: { model: imageResult("c3", 3) } },
  ];
  const result = stripImagesFromRecords(records, { keepBytes: 4 * MIB });
  // 只保留最新的一张（3MB ≤ 4MB），前两张被剥离。
  assert.equal(result.dropped, 2);
  assert.equal(images(result.records[0].record.model).length, 0);
  assert.equal(images(result.records[1].record.model).length, 0);
  assert.equal(images(result.records[2].record.model).length, 1);
  assert.notEqual(result.records[0], records[0]);
  assert.match(placeholders(result.records[0].record.model)[0].text, /\/tmp\/old\.png/);
});

test("stripImagesFromRecords 也处理 edits 里的消息，且没有图片时原样返回", () => {
  const editable = [{ id: 5, record: { kind: "x", edits: [{ target: 1, action: "replace", messages: imageResult("c9", 5) }] } }];
  const stripped = stripImagesFromRecords(editable, { keepBytes: 1 * MIB });
  assert.equal(stripped.dropped, 1);
  assert.equal(images(stripped.records[0].record.edits[0].messages).length, 0);

  const plain = [{ id: 6, record: { model: [{ role: "user", content: "hi" }] } }];
  const untouched = stripImagesFromRecords(plain, { keepBytes: 1 * MIB });
  assert.equal(untouched.records, plain);
});

test("占位文本明确说明这一轮看不到图", () => {
  assert.match(imagePlaceholder(), /这一轮看不到它的任何像素/);
});

test("同一文件读多次：只保留最新那份图，旧副本换成「更新副本在后面」的占位", () => {
  const path = "items/x/参考图/屏幕截图 231948.png";
  const messages = [...imageResult("c1", 2, { path }), ...imageResult("c2", 2, { path })];
  const result = boundImages(messages, { triggerBytes: 100 * MIB, targetBytes: 90 * MIB });
  assert.equal(result.deduped, 1);
  assert.equal(images(result.messages).length, 1); // 只剩最新那份
  const texts = placeholders(result.messages).map((block) => block.text);
  assert.match(texts[0], /这条旧副本已省略/);
  assert.match(texts[0], /不要因此重复 read/);
  assert.match(texts[0], /231948\.png/);
});

test("去重先于字节预算：重复副本不会挤掉不同文件", () => {
  // 同一个文件读 6 次（每次 4MB），再加 2 个不同文件（各 4MB）。
  const same = Array.from({ length: 6 }, (_, i) => imageResult(`s${i}`, 4, { path: "a.png" }));
  const distinct = [imageResult("d1", 4, { path: "b.png" }), imageResult("d2", 4, { path: "c.png" })];
  const messages = [...same, ...distinct].flat();
  const result = boundImages(messages, { triggerBytes: 20 * MIB, targetBytes: 16 * MIB });
  assert.equal(result.deduped, 5);
  // 去重后剩 a/b/c 三张共 12MB，未超 trigger → 一张都不按预算裁。
  assert.equal(images(result.messages).length, 3);
});

test("图片提示词段落挂在扩展上，且讲清了两种占位", () => {
  const extension = createImageBudgetExtension();
  assert.deepEqual(extension.sections.map((item) => item.key), ["images"]);
  const text = extension.sections[0].render({}, {});
  assert.match(text, /不需要为了"确认看清了没有"再读一次/);
  assert.match(text, /图片已移除以缩小请求体/);
  assert.match(text, /这条旧副本已省略/);
});

test("存储去重：dedupeByPath 只删旧副本，不同文件全部保留", () => {
  const path = "items/x/a.png";
  const records = [
    { id: 1, record: { model: imageResult("c1", 2, { path }) } },
    { id: 2, record: { model: imageResult("c2", 2, { path }) } },
    { id: 3, record: { model: imageResult("c3", 2, { path: "items/x/b.png" }) } },
  ];
  const result = stripImagesFromRecords(records, { keepBytes: Infinity, dedupeByPath: true });
  assert.equal(result.dropped, 1); // 只删 id=1 那份旧副本
  assert.equal(images(result.records[0].record.model).length, 0);
  assert.equal(images(result.records[1].record.model).length, 1);
  assert.equal(images(result.records[2].record.model).length, 1);
});
