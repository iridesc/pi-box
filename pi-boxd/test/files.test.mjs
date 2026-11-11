// 项目文件浏览单测：路径越界防护 / 目录列表 / 文本与二进制预览 / 上传 / Range 下载
import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Readable } from "node:stream";

const root = await mkdtemp(join(tmpdir(), "pibox-files-"));
process.env.PI_BOX_WORKSPACE = join(root, "workspace");
process.env.PI_BOX_PROJECTS_DIR = join(root, "workspace");
process.env.PI_BOX_META_DIR = join(root, "meta");
await mkdir(join(root, "workspace", "demo", "src", "nested"), { recursive: true });
await mkdir(join(root, "outside"), { recursive: true });
await mkdir(join(root, "meta"), { recursive: true });

const {
  LIST_MAX_ENTRIES,
  normalizeRelPath,
  projectRoot,
  resolveProjectPath,
  listDirectory,
  readFilePreview,
  sendProjectFile,
  uploadProjectFile,
  sanitizeFileName,
  languageFor,
  mimeFor,
} = await import("../src/files.mjs");

await writeFile(join(root, "workspace", "demo", "README.md"), "# demo\n\nhello\n");
await writeFile(join(root, "workspace", "demo", "src", "app.js"), "export const answer = 42;\n");
await writeFile(join(root, "workspace", "demo", "bin.dat"), Buffer.from([0x00, 0x01, 0x02, 0xff]));
await writeFile(join(root, "outside", "secret.txt"), "secret\n");
await symlink(join(root, "outside"), join(root, "workspace", "demo", "escape"));

test.after(async () => {
  await rm(root, { recursive: true, force: true });
});

// ── 路径校验 ────────────────────────────────────────────────────────────

test("相对路径规范化：忽略空段与 .，拒绝绝对路径与 ..", () => {
  assert.equal(normalizeRelPath(""), "");
  assert.equal(normalizeRelPath("./src//app.js"), "src/app.js");
  assert.equal(normalizeRelPath("src\\app.js"), "src/app.js");
  assert.throws(() => normalizeRelPath("/etc/passwd"), /只支持项目内相对路径/);
  assert.throws(() => normalizeRelPath("src/../../etc/passwd"), /不能包含 \.\./);
});

test("项目名不能越出 PROJECTS_DIR", async () => {
  await assert.rejects(() => projectRoot("../outside"), /非法项目名/);
  await assert.rejects(() => projectRoot("demo/../demo"), /非法项目名/);
  await assert.rejects(() => projectRoot("nope"), /项目不存在/);
  assert.equal(await projectRoot("demo"), join(root, "workspace", "demo"));
  assert.equal(await projectRoot("meta"), join(root, "meta"));
});

test("符号链接指向项目外时拒绝访问", async () => {
  await assert.rejects(() => resolveProjectPath("demo", "escape/secret.txt"), /路径越界/);
});

// ── 目录列表 ────────────────────────────────────────────────────────────

test("目录列表：目录优先，文件带大小与时间", async () => {
  const data = await listDirectory("demo", "");
  assert.equal(data.path, "");
  assert.equal(data.parent, null);
  const names = data.entries.map((entry) => entry.name);
  assert.deepEqual(names.slice(0, 2), ["escape", "src"]);
  assert.ok(names.includes("README.md"));
  const readme = data.entries.find((entry) => entry.name === "README.md");
  assert.equal(readme.type, "file");
  assert.equal(readme.size, 14);
  assert.equal(readme.link, false);
  assert.ok(Date.parse(readme.mtime) > 0);
  assert.equal(data.truncated, false);
});

test("子目录的 parent 指回上级", async () => {
  const data = await listDirectory("demo", "src");
  assert.equal(data.path, "src");
  assert.equal(data.parent, "");
  const nested = data.entries.find((entry) => entry.name === "nested");
  assert.equal(nested.type, "dir");
  assert.equal(nested.path, "src/nested");
});

test("文件当目录用时报错", async () => {
  await assert.rejects(() => listDirectory("demo", "README.md"), /不是目录/);
});

// ── 预览 ────────────────────────────────────────────────────────────────

test("文本预览带语言标记", async () => {
  const data = await readFilePreview("demo", "src/app.js");
  assert.equal(data.kind, "text");
  assert.equal(data.language, "javascript");
  assert.equal(data.content, "export const answer = 42;\n");
  assert.equal(data.truncated, false);
});

test("Markdown 预览按文本返回", async () => {
  const data = await readFilePreview("demo", "README.md");
  assert.equal(data.kind, "text");
  assert.equal(data.language, "markdown");
});

test("二进制文件不返回内容", async () => {
  const data = await readFilePreview("demo", "bin.dat");
  assert.equal(data.kind, "binary");
  assert.equal(data.content, undefined);
  assert.equal(data.size, 4);
});

test("图片按媒体类型返回，不需读取内容", async () => {
  await writeFile(join(root, "workspace", "demo", "logo.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  const data = await readFilePreview("demo", "logo.png");
  assert.equal(data.kind, "media");
  assert.equal(data.mediaKind, "image");
  assert.equal(data.mime, "image/png");
});

test("超大文本只返回前 1MB 并标记截断", async () => {
  await writeFile(join(root, "workspace", "demo", "big.log"), "a".repeat(1024 * 1024 + 100));
  const data = await readFilePreview("demo", "big.log");
  assert.equal(data.kind, "text");
  assert.equal(data.truncated, true);
  assert.equal(data.previewBytes, 1024 * 1024);
  assert.equal(data.content.length, 1024 * 1024);
});

test("路径不存在返回 404 语义", async () => {
  await assert.rejects(() => readFilePreview("demo", "nope.txt"), (error) => error.status === 404);
});

// ── 上传 ────────────────────────────────────────────────────────────────

function fakeRequest(body, headers = {}) {
  const stream = Readable.from([Buffer.from(body)]);
  stream.headers = headers;
  return stream;
}

test("上传写入裸流，冲突时 409，overwrite 覆盖", async () => {
  const data = await uploadProjectFile(fakeRequest("hello", { "content-length": "5" }), {
    project: "demo", dir: "src", name: "upload.txt",
  });
  assert.equal(data.path, "src/upload.txt");
  assert.equal(data.size, 5);
  assert.equal((await readFilePreview("demo", "src/upload.txt")).content, "hello");

  await assert.rejects(
    () => uploadProjectFile(fakeRequest("next"), { project: "demo", dir: "src", name: "upload.txt" }),
    (error) => error.status === 409,
  );

  const overwritten = await uploadProjectFile(fakeRequest("next"), {
    project: "demo", dir: "src", name: "upload.txt", overwrite: true,
  });
  assert.equal(overwritten.size, 4);
  assert.equal((await readFilePreview("demo", "src/upload.txt")).content, "next");
});

test("上传文件名净化：去掉目录部分，拒绝非法名", async () => {
  assert.equal(sanitizeFileName("../../evil.sh"), "evil.sh");
  assert.equal(sanitizeFileName("a/b/c.txt"), "c.txt");
  assert.throws(() => sanitizeFileName(".."), /文件名不合法/);
  assert.throws(() => sanitizeFileName(""), /文件名不合法/);
});

test("上传到符号链接目录被拒绝", async () => {
  await assert.rejects(
    () => uploadProjectFile(fakeRequest("x"), { project: "demo", dir: "escape", name: "x.txt" }),
    /路径越界/,
  );
});

// ── 下载 / Range ────────────────────────────────────────────────────────

test("原文件下载支持 Range，默认附件", async () => {
  const target = await resolveProjectPath("demo", "README.md");
  const server = createServer((req, res) => {
    sendProjectFile(req, res, target, { download: req.url.includes("download=1") }).catch((error) => {
      res.writeHead(error.status ?? 500);
      res.end(error.message);
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  try {
    const full = await fetch(`http://127.0.0.1:${port}/file?download=1`);
    assert.equal(full.status, 200);
    assert.match(full.headers.get("content-disposition"), /^attachment; filename\*=UTF-8''README\.md$/);
    assert.equal(full.headers.get("accept-ranges"), "bytes");
    assert.equal(await full.text(), "# demo\n\nhello\n");

    const partial = await fetch(`http://127.0.0.1:${port}/file`, { headers: { Range: "bytes=0-3" } });
    assert.equal(partial.status, 206);
    assert.equal(partial.headers.get("content-range"), "bytes 0-3/14");
    assert.equal(await partial.text(), "# de");

    const bad = await fetch(`http://127.0.0.1:${port}/file`, { headers: { Range: "bytes=100-200" } });
    assert.equal(bad.status, 416);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test("MIME 与语言映射", () => {
  assert.equal(mimeFor("a.ts"), "text/typescript; charset=utf-8");
  assert.equal(mimeFor("Dockerfile"), "application/octet-stream");
  assert.equal(mimeFor("x.png"), "image/png");
  assert.equal(languageFor("src/app.tsx"), "typescript");
  assert.equal(languageFor("Dockerfile"), "dockerfile");
  assert.equal(languageFor("unknown.zzz"), null);
  assert.ok(LIST_MAX_ENTRIES > 0);
});
