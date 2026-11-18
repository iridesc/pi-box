// 会话附件落盘与消息组装：
// - 文件名由后端生成，前端拿不到任意路径写权限
// - 附件只能读 .pi-box/uploads/ 下，跳出这个前缀一律拒绝
// - 图片内联成 image block（模型立刻能看），普通文件只留路径
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Readable } from "node:stream";

let mod;

let PROJECT;

async function env() {
  const root = await mkdtemp(join(tmpdir(), "pi-attach-"));
  PROJECT = join(root, "demo");
  await mkdir(PROJECT, { recursive: true });
  return { root };
}

/** 最小 PNG：1×1，够 detectImageMime 认出来。 */
const PNG_1X1 = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);

/** 把 Buffer 包成可当请求体用的流，带上 content-length。 */
function asRequest(bytes, headers = {}) {
  const stream = Readable.from([bytes]);
  stream.headers = { "content-length": String(bytes.length), ...headers };
  return stream;
}

test("saveAttachment 落盘到 .pi-box/uploads 并返回相对路径", async () => {
  const { project } = await env();
  const { saveAttachment, ATTACHMENT_DIR } = await import("../src/attachments.mjs");
  const saved = await saveAttachment(asRequest(PNG_1X1), { root: PROJECT, name: "shot.png" });
  assert.match(saved.path, new RegExp(`^${ATTACHMENT_DIR}/\\d{8}-\\d{6}-[0-9a-f]{8}-shot\\.png$`));
  assert.equal(saved.size, PNG_1X1.length);
  assert.equal(saved.isImage, true);
  assert.equal(saved.mimeType, "image/png");
  const back = await readFile(join(PROJECT, ...saved.path.split("/")));
  assert.deepEqual(back, PNG_1X1);
});

test("文件名会被清洗：路径分隔符和控制字符都去掉，且不覆盖已有文件", async () => {
  const { project } = await env();
  const { saveAttachment } = await import("../src/attachments.mjs");
  const a = await saveAttachment(asRequest(PNG_1X1), { root: PROJECT, name: "../../etc/passwd.png" });
  assert.equal(a.name.endsWith("passwd.png"), true);
  assert.equal(a.path.includes(".."), false);
  // 同名两次不能互相覆盖
  const b = await saveAttachment(asRequest(PNG_1X1), { root: PROJECT, name: "same.png" });
  const c = await saveAttachment(asRequest(PNG_1X1), { root: PROJECT, name: "same.png" });
  assert.notEqual(b.path, c.path);
});

test("空文件要报错，且不留下半截临时文件", async () => {
  const { project } = await env();
  const { saveAttachment, ATTACHMENT_DIR } = await import("../src/attachments.mjs");
  await assert.rejects(
    () => saveAttachment(asRequest(Buffer.alloc(0)), { root: PROJECT, name: "empty.txt" }),
    /空文件/,
  );
  const { readdir } = await import("node:fs/promises");
  const left = await readdir(join(PROJECT, ...ATTACHMENT_DIR.split("/"))).catch(() => []);
  assert.deepEqual(left, []);
});

test("attachmentAbsolute 挡住跳出 uploads 的路径", async () => {
  await env();
  const { attachmentAbsolute } = await import("../src/attachments.mjs");
  for (const bad of ["../secret", ".pi-box/../../etc/passwd", "/etc/passwd", "other/x.png", ".pi-box/uploads/../x"]) {
    await assert.rejects(() => attachmentAbsolute(PROJECT, bad), /只能读取|非法/);
  }
});

test("buildAttachmentContent：图片内联成 image block，普通文件只留路径", async () => {
  const { project } = await env();
  const { saveAttachment, buildAttachmentContent, ATTACHMENT_DIR } = await import("../src/attachments.mjs");
  const image = await saveAttachment(asRequest(PNG_1X1), { root: PROJECT, name: "a.png" });
  const text = await saveAttachment(asRequest(Buffer.from("hello")), { root: PROJECT, name: "notes.txt" });

  const built = await buildAttachmentContent({
    root: PROJECT,
    text: "看看这两个",
    attachments: [{ path: image.path, kind: "image" }, { path: text.path }],
    // 测试里不碰 photon：模拟「图在限内，原样内联」
    prepare: async () => undefined,
  });

  assert.ok(Array.isArray(built.content), "有图时必须返回 content blocks");
  assert.equal(built.content[0].type, "text");
  assert.match(built.content[0].text, /看看这两个/);
  assert.match(built.content[0].text, new RegExp(`附件：${ATTACHMENT_DIR}/.*notes\\.txt`));
  const imageBlocks = built.content.filter((block) => block.type === "image");
  assert.equal(imageBlocks.length, 1);
  assert.equal(imageBlocks[0].mimeType, "image/png");
  assert.equal(imageBlocks[0].data, PNG_1X1.toString("base64"));

  // entry.data 里只记路径，不塞 base64
  const recorded = built.attachments;
  assert.equal(recorded.length, 2);
  assert.equal(recorded.find((item) => item.name.endsWith("a.png")).inline, true);
  assert.equal(recorded.find((item) => item.name.endsWith("notes.txt")).inline, false);
  assert.equal(JSON.stringify(recorded).includes(PNG_1X1.toString("base64").slice(0, 20)), false);
});

test("buildAttachmentContent：只有文件没有图时退化成纯文本", async () => {
  const { project } = await env();
  const { saveAttachment, buildAttachmentContent } = await import("../src/attachments.mjs");
  const text = await saveAttachment(asRequest(Buffer.from("csv,data")), { root: PROJECT, name: "rows.csv" });
  const built = await buildAttachmentContent({
    root: PROJECT,
    text: "处理一下",
    attachments: [{ path: text.path }],
    prepare: async () => undefined,
  });
  assert.equal(typeof built.content, "string");
  assert.match(built.content, /处理一下/);
  assert.match(built.content, /附件：.pi-box\/uploads\/.*rows\.csv（8B）/);
});

test("buildAttachmentContent：纯附件（没有文字）也能组装出内容", async () => {
  const { project } = await env();
  const { saveAttachment, buildAttachmentContent } = await import("../src/attachments.mjs");
  const image = await saveAttachment(asRequest(PNG_1X1), { root: PROJECT, name: "only.png" });
  const built = await buildAttachmentContent({
    root: PROJECT,
    text: "",
    attachments: [{ path: image.path, kind: "image" }],
    prepare: async () => undefined,
  });
  // 没有文字时不该硬塞一个空 text block
  assert.equal(Array.isArray(built.content), true);
  assert.equal(built.content.length, 1);
  assert.equal(built.content[0].type, "image");
});

test("buildAttachmentContent：附件不存在要报 404，不能静默丢掉", async () => {
  await env();
  const { buildAttachmentContent } = await import("../src/attachments.mjs");
  await assert.rejects(
    () => buildAttachmentContent({ root: PROJECT, text: "x", attachments: [{ path: ".pi-box/uploads/nope.png" }], prepare: async () => undefined }),
    /附件不存在/,
  );
});

test("批量清理：deleteAttachment 只删 uploads 里的文件", async () => {
  const { project } = await env();
  const { saveAttachment, deleteAttachment } = await import("../src/attachments.mjs");
  const saved = await saveAttachment(asRequest(PNG_1X1), { root: PROJECT, name: "gone.png" });
  await deleteAttachment(PROJECT, saved.path);
  const back = await readFile(join(PROJECT, ...saved.path.split("/"))).catch(() => null);
  assert.equal(back, null);
  // 重复删不报错（前端可能重试）
  await deleteAttachment(PROJECT, saved.path);
});