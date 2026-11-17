// 图片预算单测：请求级裁剪（boundImages）与存储级剥离（stripImagesFromRecords）。
import test from "node:test";
import assert from "node:assert/strict";
import { boundImages, createImageBudgetExtension, imagePlaceholder, stripImagesFromRecords, toolCallPaths } from "../src/image-budget.mjs";

const MIB = 1024 * 1024;

/** 造一个 toolResult 消息，带一张 `mib` 大小的内联图。
 *  `fill` 决定像素内容：默认按 path（没有就按 callId）走，保证「不同文件」内容真不一样，
 *  否则按 sha256 去重时会被当成同一张图——那正是这套新语义要区分的东西。 */
function imageResult(callId, mib, { path, fill } = {}) {
  const seed = fill ?? path ?? callId ?? "a";
  const size = mib * MIB;
  const data = seed.repeat(Math.ceil(size / seed.length)).slice(0, size);
  const message = {
    role: "toolResult",
    toolCallId: callId,
    toolName: "read",
    content: [{ type: "text", text: "Read image file [image/png]." }, { type: "image", data, mimeType: "image/png" }],
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

/** 两种占位：被预算裁掉的（[图片已移除…）与重复副本省掉的（[同一张图 …）。 */
const placeholders = (messages) =>
  messages.flatMap((message) =>
    (Array.isArray(message.content) ? message.content : []).filter(
      (block) => block.type === "text" && (block.text.startsWith("[图片已移除") || block.text.startsWith("[同一张图")),
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
  // 保底：最新一组（c2）留着，只淘汰旧的那组。
  assert.equal(result.dropped, 1);
  assert.ok(result.overLimitBytes > 0, "超限时要报出来，好让调用方提示");
  const texts = placeholders(result.messages).map((block) => block.text);
  assert.match(texts[0], /items\/x\/g1-frames\/s02-first\.png/);
  assert.match(texts[0], /不要凭记忆/);
  assert.equal(images(result.messages).length, 1); // 剩下的就是最新那张
});

test("最新一组比 target 还大时也留着，只把超限报出来", () => {
  const messages = imageResult("c1", 30);
  const result = boundImages(messages, { triggerBytes: 8 * MIB, targetBytes: 4 * MIB });
  assert.equal(result.dropped, 0); // 不能把自己裁光
  assert.equal(images(result.messages).length, 1);
  assert.equal(result.overLimitBytes, 30 * MIB);
});

test("原子淘汰：一条消息里的多张图要么全在、要么整组消失", () => {
  // 组 A：一条 toolResult 里 3 张图（模拟长图切片）；组 B：另一条消息 1 张图。
  const groupA = [
    {
      role: "toolResult",
      toolCallId: "long",
      toolName: "read",
      content: [
        { type: "image", data: "a".repeat(3 * MIB), mimeType: "image/png" },
        { type: "image", data: "b".repeat(3 * MIB), mimeType: "image/png" },
        { type: "image", data: "c".repeat(3 * MIB), mimeType: "image/png" },
        { type: "text", text: "这是一张长图（1280×9533），已按原始分辨率切成 3 片自上而下返回：片高 1600px，相邻重叠 120px" },
      ],
      isError: false,
    },
  ];
  const groupB = imageResult("later", 3);
  const result = boundImages([...groupA, ...groupB], { triggerBytes: 10 * MIB, targetBytes: 5 * MIB });
  // 组 A 共 9MB，加上组 B 才越线 → 整组 A 一起走，不留半张。
  assert.equal(result.dropped, 3);
  assert.equal(result.groups, 2);
  assert.equal(images(result.messages).length, 1);
  assert.equal(images(result.messages)[0].data.length, 3 * MIB); // 剩下的是组 B
  // 切片说明也要跟着换掉，否则「说有 3 片、实际 0 片」更容易错位。
  const texts = result.messages[0].content.filter((block) => block.type === "text").map((block) => block.text);
  assert.ok(texts.some((text) => /整体移除/.test(text)), "切片说明应换成整组移除占位");
  assert.ok(texts.some((text) => /原图 1280×9533/.test(text)), "占位里要带上原图尺寸");
  assert.ok(!texts.some((text) => /），，/.test(text)), "占位文案不能拼错");
  assert.ok(!texts.some((text) => /已按原始分辨率切成 3 片/.test(text)), "旧的切片说明不能留着");
});

test("组里还有活着的图时，切片说明保持原样", () => {
  const messages = [
    {
      role: "toolResult",
      toolCallId: "long",
      toolName: "read",
      content: [
        { type: "image", data: "x".repeat(2 * MIB), mimeType: "image/png" },
        { type: "text", text: "这是一张长图（1280×9533），已按原始分辨率切成 1 片自上而下返回：片高 1600px" },
      ],
      isError: false,
    },
  ];
  const result = boundImages(messages, { triggerBytes: 100 * MIB, targetBytes: 90 * MIB });
  assert.equal(result.dropped, 0);
  const texts = result.messages[0].content.filter((block) => block.type === "text").map((block) => block.text);
  assert.ok(texts.some((text) => /已按原始分辨率切成 1 片/.test(text)));
});

test("组内不去重：长图里的空白片（内容相同）也要整组保留", () => {
  // 7 片里有 3 片是完全空白的（内容一模一样），不能被合并成一片，
  // 否则 sliceNotice 里「第 3/4/5 片」的片号就和实际对不上了。
  const blank = "0".repeat(MIB);
  const content = [
    { type: "image", data: "x".repeat(MIB), mimeType: "image/png" },
    { type: "image", data: blank, mimeType: "image/png" },
    { type: "image", data: blank, mimeType: "image/png" },
    { type: "image", data: blank, mimeType: "image/png" },
    { type: "text", text: "这是一张长图（1280×9533），已按原始分辨率切成 4 片自上而下返回" },
  ];
  const messages = [{ role: "toolResult", toolCallId: "long", toolName: "read", content, isError: false }];
  const result = boundImages(messages, { triggerBytes: 100 * MIB, targetBytes: 90 * MIB });
  assert.equal(result.deduped, 0);
  assert.equal(images(result.messages).length, 4);
});

test("同一张长图读两次：8 片 hash 全同，整组旧副本被丢掉", () => {
  const slices = (prefix) =>
    Array.from({ length: 8 }, (_, i) => ({ type: "image", data: `${prefix}${i}`.repeat(MIB / 2), mimeType: "image/png" }));
  const shot = () => [
    ...slices("p"), // 每片内容相同 → 两组切片逐片 hash 相同
  ];
  const message = (id) => ({
    role: "toolResult",
    toolCallId: id,
    toolName: "read",
    content: [...shot(), { type: "text", text: "这是一张长图（1280×9533），已按原始分辨率切成 8 片自上而下返回" }],
    isError: false,
  });
  const result = boundImages([message("first"), message("second")], { triggerBytes: 100 * MIB, targetBytes: 90 * MIB });
  assert.equal(result.deduped, 8);
  assert.equal(images(result.messages).length, 8); // 只剩最新那 8 片
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

test("存储级按组裁剪：切片被整组剥离，不拆散；且不保底最新一组", () => {
  const sliced = (id) => ({
    id,
    record: {
      model: [
        {
          role: "toolResult",
          toolCallId: `long${id}`,
          toolName: "read",
          content: [
            { type: "image", data: String(id % 10).repeat(MIB / 2), mimeType: "image/png" },
            { type: "image", data: String((id + 5) % 10).repeat(MIB / 2), mimeType: "image/png" },
            { type: "text", text: "这是一张长图（1280×9533），已按原始分辨率切成 2 片" },
          ],
          isError: false,
        },
      ],
    },
  });
  // 每组 1MB，keepBytes 只够 1 组 → 保留最新那组的两片，旧的整组走。
  const result = stripImagesFromRecords([sliced(1), sliced(2)], { keepBytes: 1 * MIB });
  assert.equal(result.dropped, 2);
  assert.equal(images(result.records[0].record.model).length, 0); // 整组消失
  assert.equal(images(result.records[1].record.model).length, 2); // 整组留下
});

test("占位文本明确说明这一轮看不到图", () => {
  assert.match(imagePlaceholder(), /这一轮看不到它的任何像素/);
});

test("同一文件读多次（内容没变）：只保留最新那份图，旧副本换成「更新副本在后面」的占位", () => {
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

test("同一文件被改过（路径相同、内容不同）：两张都保留，不能当成重复副本", () => {
  const path = "items/x/改过的图.png";
  const messages = [
    ...imageResult("c1", 2, { path, fill: "old" }),
    ...imageResult("c2", 2, { path, fill: "new" }),
  ];
  const result = boundImages(messages, { triggerBytes: 100 * MIB, targetBytes: 90 * MIB });
  assert.equal(result.deduped, 0);
  assert.equal(images(result.messages).length, 2); // 旧版本和新版本都在
});

test("内容相同但文件名不同：合并成一份，只留最新的位置", () => {
  const messages = [
    ...imageResult("c1", 2, { path: "a.png", fill: "same" }),
    ...imageResult("c2", 2, { path: "b.png", fill: "same" }),
  ];
  const result = boundImages(messages, { triggerBytes: 100 * MIB, targetBytes: 90 * MIB });
  assert.equal(result.deduped, 1);
  assert.equal(images(result.messages).length, 1);
});

test("用户直接贴进来的图（没有工具调用、没有路径）也能按内容去重", () => {
  const userImage = () => ({
    role: "user",
    content: [
      { type: "text", text: "看看这张图" },
      { type: "image", data: "pasted".repeat(Math.ceil((1 * MIB) / 6)).slice(0, 1 * MIB), mimeType: "image/png" },
    ],
  });
  const messages = [userImage(), { role: "assistant", content: [{ type: "text", text: "看到了" }] }, userImage()];
  const result = boundImages(messages, { triggerBytes: 100 * MIB, targetBytes: 90 * MIB });
  assert.equal(result.deduped, 1);
  assert.equal(images(result.messages).length, 1);
});

test("长度不同的图不做 hash 计算（长度预分桶）", () => {
  const messages = [...imageResult("c1", 1, { fill: "a" }), ...imageResult("c2", 3, { fill: "b" })];
  const result = boundImages(messages, { triggerBytes: 100 * MIB, targetBytes: 90 * MIB });
  assert.equal(result.deduped, 0);
  assert.equal(images(result.messages).length, 2);
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
  assert.match(text, /判定看的是像素内容而不是文件名/);
});

test("存储去重：dedupeByHash 只删内容相同的旧副本，不同内容全部保留", () => {
  const path = "items/x/a.png";
  const records = [
    { id: 1, record: { model: imageResult("c1", 2, { path }) } },
    { id: 2, record: { model: imageResult("c2", 2, { path }) } },
    { id: 3, record: { model: imageResult("c3", 2, { path: "items/x/b.png" }) } },
  ];
  const result = stripImagesFromRecords(records, { keepBytes: Infinity, dedupeByHash: true });
  assert.equal(result.dropped, 1); // 只删 id=1 那份同内容旧副本
  assert.equal(images(result.records[0].record.model).length, 0);
  assert.equal(images(result.records[1].record.model).length, 1);
  assert.equal(images(result.records[2].record.model).length, 1);
});

test("存储去重：同路径但内容变过（文件被改）时，旧版本保留", () => {
  const path = "items/x/改过的图.png";
  const records = [
    { id: 1, record: { model: imageResult("c1", 2, { path, fill: "old" }) } },
    { id: 2, record: { model: imageResult("c2", 2, { path, fill: "new" }) } },
  ];
  const result = stripImagesFromRecords(records, { keepBytes: Infinity, dedupeByHash: true });
  assert.equal(result.dropped, 0);
  assert.equal(images(result.records[0].record.model).length, 1);
  assert.equal(images(result.records[1].record.model).length, 1);
});
