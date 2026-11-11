// 项目文件浏览：目录列表 / 文本预览 / 原文件流（含 Range）/ 上传。
// 设计约束：
// - 只允许访问「项目根目录」内部，path 一律是项目内相对路径（防 .. 与符号链接越界）；
// - 预览只读前 1MB，二进制按 NUL 字节 / 非法 UTF-8 判定；
// - 原文件默认下载，只有图片 / 音频 / 视频 / PDF 允许 inline（HTML/SVG 不给渲染机会）。
import { createReadStream, createWriteStream } from "node:fs";
import { open, readdir, realpath, rename, stat, unlink } from "node:fs/promises";
import { basename, dirname, extname, join, resolve, sep } from "node:path";
import { randomUUID } from "node:crypto";
import { pipeline } from "node:stream/promises";
import { PROJECTS_DIR, META_PROJECT, META_DIR } from "./paths.mjs";

/** 单次预览最多读取的文本字节数（超出部分标记 truncated）。 */
export const PREVIEW_TEXT_BYTES = 1024 * 1024;
/** 单个目录最多返回的条目数，避免 node_modules 这类巨型目录打爆前端。 */
export const LIST_MAX_ENTRIES = 3000;
/** 单文件上传上限，可用环境变量调整。 */
export const UPLOAD_MAX_BYTES = Number(process.env.PI_BOX_UPLOAD_MAX_BYTES ?? 200 * 1024 * 1024);

/** 带 HTTP 状态码的错误，路由层直接映射成响应。 */
export function fileError(status, message) {
  return Object.assign(new Error(message), { status });
}

// ── 路径校验 ────────────────────────────────────────────────────────────

/** 项目名 → 项目根目录（绝对路径，未 realpath）。 */
export async function projectRoot(project) {
  if (typeof project !== "string" || !project.trim()) throw fileError(400, "缺少 project 参数");
  if (project === META_PROJECT) {
    const info = await stat(META_DIR).catch(() => null);
    if (!info?.isDirectory()) throw fileError(404, "元项目目录不存在");
    return resolve(META_DIR);
  }
  if (project.includes("/") || project.includes("\\") || project === "." || project === "..") {
    throw fileError(400, "非法项目名");
  }
  const abs = resolve(PROJECTS_DIR, project);
  // 必须正好是 PROJECTS_DIR 的一级子目录（resolve 已消掉 .. / 多余分隔符）。
  if (dirname(abs) !== resolve(PROJECTS_DIR)) throw fileError(400, "非法项目名");
  const info = await stat(abs).catch(() => null);
  if (!info?.isDirectory()) throw fileError(404, `项目不存在：${project}`);
  return abs;
}

/** 规范化项目内相对路径：拒绝绝对路径与 ..，其余空段直接忽略。 */
export function normalizeRelPath(value) {
  const raw = String(value ?? "").replace(/\\/g, "/");
  if (raw.startsWith("/")) throw fileError(400, "只支持项目内相对路径");
  const parts = [];
  for (const part of raw.split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") throw fileError(400, "路径不能包含 ..");
    parts.push(part);
  }
  return parts.join("/");
}

/** 相对路径 → 真实绝对路径，并校验 realpath 仍在项目内（防符号链接逃逸）。 */
export async function resolveProjectPath(project, relInput) {
  const root = await projectRoot(project);
  const rel = normalizeRelPath(relInput);
  const abs = rel ? join(root, ...rel.split("/")) : root;
  const rootReal = await realpath(root);
  let real;
  try {
    real = await realpath(abs);
  } catch (error) {
    if (error.code === "ENOENT" || error.code === "ENOTDIR") throw fileError(404, `路径不存在：${rel || "."}`);
    throw error;
  }
  if (real !== rootReal && !real.startsWith(rootReal + sep)) {
    throw fileError(400, "路径越界：符号链接指向项目外部");
  }
  return { project, root: rootReal, rel, abs: real, info: await stat(real) };
}

// ── 目录列表 ────────────────────────────────────────────────────────────

function compareEntries(a, b) {
  const aDir = a.isDirectory() || a.isSymbolicLink();
  const bDir = b.isDirectory() || b.isSymbolicLink();
  if (aDir !== bDir) return aDir ? -1 : 1;
  return a.name.localeCompare(b.name, "zh-CN", { numeric: true, sensitivity: "base" });
}

function parentOf(rel) {
  if (!rel) return null;
  const index = rel.lastIndexOf("/");
  return index < 0 ? "" : rel.slice(0, index);
}

export async function listDirectory(project, relInput) {
  const target = await resolveProjectPath(project, relInput);
  if (!target.info.isDirectory()) throw fileError(400, "目标不是目录");
  let dirents;
  try {
    dirents = await readdir(target.abs, { withFileTypes: true });
  } catch (error) {
    if (error.code === "EACCES") throw fileError(403, "没有读取该目录的权限");
    throw error;
  }
  dirents.sort(compareEntries);
  const truncated = dirents.length > LIST_MAX_ENTRIES;
  const picked = truncated ? dirents.slice(0, LIST_MAX_ENTRIES) : dirents;
  const entries = [];
  // 分批 stat，避免一次打满文件句柄（跟随符号链接，坏链接退化成 file）。
  const batch = 64;
  for (let index = 0; index < picked.length; index += batch) {
    const slice = picked.slice(index, index + batch);
    const infos = await Promise.all(slice.map(async (dirent) => {
      const info = await stat(join(target.abs, dirent.name)).catch(() => null);
      return { dirent, info };
    }));
    for (const { dirent, info } of infos) {
      const rel = target.rel ? `${target.rel}/${dirent.name}` : dirent.name;
      entries.push({
        name: dirent.name,
        path: rel,
        type: info?.isDirectory() ? "dir" : "file",
        link: dirent.isSymbolicLink(),
        size: info?.isFile() ? info.size : null,
        mtime: info ? info.mtime.toISOString() : null,
      });
    }
  }
  return { project, path: target.rel, parent: parentOf(target.rel), entries, truncated };
}

// ── MIME / 语言 ─────────────────────────────────────────────────────────

const MIME_BY_EXT = {
  txt: "text/plain; charset=utf-8",
  log: "text/plain; charset=utf-8",
  md: "text/markdown; charset=utf-8",
  markdown: "text/markdown; charset=utf-8",
  mdx: "text/markdown; charset=utf-8",
  json: "application/json; charset=utf-8",
  jsonc: "application/json; charset=utf-8",
  json5: "application/json; charset=utf-8",
  yaml: "text/yaml; charset=utf-8",
  yml: "text/yaml; charset=utf-8",
  toml: "text/plain; charset=utf-8",
  ini: "text/plain; charset=utf-8",
  csv: "text/csv; charset=utf-8",
  tsv: "text/tab-separated-values; charset=utf-8",
  html: "text/html; charset=utf-8",
  htm: "text/html; charset=utf-8",
  css: "text/css; charset=utf-8",
  scss: "text/x-scss; charset=utf-8",
  less: "text/x-less; charset=utf-8",
  js: "text/javascript; charset=utf-8",
  mjs: "text/javascript; charset=utf-8",
  cjs: "text/javascript; charset=utf-8",
  jsx: "text/javascript; charset=utf-8",
  ts: "text/typescript; charset=utf-8",
  tsx: "text/typescript; charset=utf-8",
  vue: "text/plain; charset=utf-8",
  sh: "text/x-shellscript; charset=utf-8",
  bash: "text/x-shellscript; charset=utf-8",
  zsh: "text/x-shellscript; charset=utf-8",
  fish: "text/x-shellscript; charset=utf-8",
  py: "text/x-python; charset=utf-8",
  rb: "text/x-ruby; charset=utf-8",
  go: "text/x-go; charset=utf-8",
  rs: "text/x-rust; charset=utf-8",
  java: "text/x-java; charset=utf-8",
  kt: "text/x-kotlin; charset=utf-8",
  c: "text/x-c; charset=utf-8",
  h: "text/x-c; charset=utf-8",
  cc: "text/x-c++; charset=utf-8",
  cpp: "text/x-c++; charset=utf-8",
  hpp: "text/x-c++; charset=utf-8",
  cs: "text/x-csharp; charset=utf-8",
  php: "text/x-php; charset=utf-8",
  sql: "text/x-sql; charset=utf-8",
  lua: "text/x-lua; charset=utf-8",
  swift: "text/x-swift; charset=utf-8",
  proto: "text/plain; charset=utf-8",
  diff: "text/x-diff; charset=utf-8",
  patch: "text/x-diff; charset=utf-8",
  svg: "image/svg+xml",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  avif: "image/avif",
  bmp: "image/bmp",
  ico: "image/x-icon",
  pdf: "application/pdf",
  mp3: "audio/mpeg",
  wav: "audio/wav",
  ogg: "audio/ogg",
  m4a: "audio/mp4",
  flac: "audio/flac",
  mp4: "video/mp4",
  webm: "video/webm",
  mov: "video/quicktime",
  mkv: "video/x-matroska",
  zip: "application/zip",
  gz: "application/gzip",
  tgz: "application/gzip",
  tar: "application/x-tar",
  "7z": "application/x-7z-compressed",
  rar: "application/vnd.rar",
  wasm: "application/wasm",
};

/** 文件名 → 响应 MIME（未知扩展名按二进制流处理）。 */
export function mimeFor(rel) {
  const ext = extname(rel).slice(1).toLowerCase();
  return MIME_BY_EXT[ext] ?? "application/octet-stream";
}

/** 可 inline 预览的媒体类型。 */
export function mediaKindOf(mime) {
  if (mime === "application/pdf") return "pdf";
  if (mime.startsWith("image/")) return "image";
  if (mime.startsWith("audio/")) return "audio";
  if (mime.startsWith("video/")) return "video";
  return null;
}

// 前端高亮用的语言 id（highlight.js 的 language 名）；未知扩展名返回 null。
const LANGUAGE_BY_EXT = {
  js: "javascript", mjs: "javascript", cjs: "javascript", jsx: "javascript",
  ts: "typescript", tsx: "typescript",
  json: "json", jsonc: "json", json5: "json",
  yaml: "yaml", yml: "yaml", toml: "ini", ini: "ini", cfg: "ini",
  sh: "bash", bash: "bash", zsh: "bash", fish: "bash", env: "bash",
  py: "python", rb: "ruby", go: "go", rs: "rust", java: "java", kt: "kotlin", kts: "kotlin",
  c: "c", h: "c", cc: "cpp", cpp: "cpp", hpp: "cpp", cs: "csharp",
  php: "php", sql: "sql", lua: "lua", swift: "swift",
  html: "xml", htm: "xml", xml: "xml", svg: "xml", vue: "xml", plist: "xml",
  css: "css", scss: "scss", less: "less",
  md: "markdown", markdown: "markdown", mdx: "markdown",
  dockerfile: "dockerfile", makefile: "makefile", mk: "makefile", nginx: "nginx",
  diff: "diff", patch: "diff", proto: "protobuf", graphql: "graphql",
};

export function languageFor(rel) {
  const name = basename(rel).toLowerCase();
  if (name === "dockerfile") return "dockerfile";
  if (name === "makefile") return "makefile";
  const ext = extname(name).slice(1);
  return LANGUAGE_BY_EXT[ext] ?? null;
}

/** 粗略判定二进制：出现 NUL 或不是合法 UTF-8。 */
export function looksBinary(buffer) {
  if (buffer.length === 0) return false;
  if (buffer.includes(0)) return true;
  try {
    // stream: true 允许末尾被截断的多字节字符，不误判成二进制。
    new TextDecoder("utf-8", { fatal: true }).decode(buffer, { stream: true });
    return false;
  } catch {
    return true;
  }
}

// ── 预览 ────────────────────────────────────────────────────────────────

export async function readFilePreview(project, relInput) {
  const target = await resolveProjectPath(project, relInput);
  if (target.info.isDirectory()) throw fileError(400, "目标是目录，无法预览");
  const mime = mimeFor(target.rel);
  const base = {
    project,
    path: target.rel,
    name: basename(target.rel),
    size: target.info.size,
    mtime: target.info.mtime.toISOString(),
    mime,
  };
  const mediaKind = mediaKindOf(mime);
  if (mediaKind) return { ...base, kind: "media", mediaKind };

  const handle = await open(target.abs, "r");
  try {
    const headLength = Math.min(target.info.size, 8192);
    const head = Buffer.alloc(headLength);
    if (headLength > 0) await handle.read(head, 0, headLength, 0);
    if (looksBinary(head)) return { ...base, kind: "binary" };

    const limit = Math.min(target.info.size, PREVIEW_TEXT_BYTES);
    const buffer = Buffer.alloc(limit);
    const { bytesRead } = limit > 0 ? await handle.read(buffer, 0, limit, 0) : { bytesRead: 0 };
    let content = buffer.subarray(0, bytesRead).toString("utf8");
    if (content.charCodeAt(0) === 0xfeff) content = content.slice(1);
    return {
      ...base,
      kind: "text",
      content,
      previewBytes: bytesRead,
      truncated: target.info.size > limit,
      language: languageFor(target.rel),
    };
  } finally {
    await handle.close().catch(() => {});
  }
}

// ── 原文件（下载 / 媒体 inline） ─────────────────────────────────────────

/**
 * 把项目内的文件写进响应。
 * - download=true 或不可 inline 的类型：Content-Disposition: attachment
 * - 图片 / 音频 / 视频 / PDF：inline，并支持单段 Range（便于视频拖动）
 */
export async function sendProjectFile(req, res, target, { download = false } = {}) {
  if (target.info.isDirectory()) throw fileError(400, "目标是目录，无法下载");
  const mime = mimeFor(target.rel);
  const inline = !download && mediaKindOf(mime) !== null;
  const size = target.info.size;
  const headers = {
    "Content-Type": mime,
    "Content-Disposition": `${inline ? "inline" : "attachment"}; filename*=UTF-8''${encodeURIComponent(basename(target.rel))}`,
    "X-Content-Type-Options": "nosniff",
    "Cache-Control": "no-store",
  };
  // 直接打开 SVG 时不允许执行脚本（<img> 场景本来也不会执行，这里是兜底）。
  if (inline && mime === "image/svg+xml") headers["Content-Security-Policy"] = "sandbox";

  let start = 0;
  let end = size - 1;
  let status = 200;
  const range = String(req.headers.range ?? "").trim();
  if (range) {
    const match = /^bytes=(\d*)-(\d*)$/.exec(range);
    if (match && (match[1] !== "" || match[2] !== "")) {
      if (match[1] === "") {
        const suffix = Number(match[2]);
        start = Math.max(0, size - suffix);
      } else {
        start = Number(match[1]);
        end = match[2] === "" ? size - 1 : Math.min(Number(match[2]), size - 1);
      }
      if (!Number.isFinite(start) || !Number.isFinite(end) || start > end || start >= size) {
        res.writeHead(416, { "Content-Range": `bytes */${size}` });
        res.end();
        return;
      }
      status = 206;
      headers["Content-Range"] = `bytes ${start}-${end}/${size}`;
    }
  }
  headers["Accept-Ranges"] = "bytes";
  headers["Content-Length"] = String(size === 0 ? 0 : end - start + 1);
  res.writeHead(status, headers);
  if (req.method === "HEAD" || size === 0) {
    res.end();
    return;
  }
  const stream = createReadStream(target.abs, { start, end });
  stream.on("error", () => res.destroy());
  stream.pipe(res);
}

// ── 上传 ────────────────────────────────────────────────────────────────

/** 只保留 basename，去掉控制字符；拒绝空名 / . / .. */
export function sanitizeFileName(name) {
  const raw = String(name ?? "").replace(/\\/g, "/");
  const base = raw.split("/").pop() ?? "";
  const clean = base.replace(/[\u0000-\u001f\u007f]/g, "").trim();
  if (!clean || clean === "." || clean === "..") throw fileError(400, "文件名不合法");
  if (clean.length > 200) throw fileError(400, "文件名过长（最多 200 字符）");
  return clean;
}

/**
 * 裸流上传：请求体就是文件内容，避免 base64 膨胀 1/3。
 * 先写同目录隐藏临时文件再 rename，失败不会留下半截文件。
 */
export async function uploadProjectFile(req, { project, dir, name, overwrite = false }) {
  const targetDir = dir ? await resolveProjectPath(project, dir) : await resolveProjectPath(project, "");
  if (!targetDir.info.isDirectory()) throw fileError(400, "上传目标不是目录");
  const fileName = sanitizeFileName(name);
  const abs = join(targetDir.abs, fileName);
  const rel = targetDir.rel ? `${targetDir.rel}/${fileName}` : fileName;

  const existing = await stat(abs).catch(() => null);
  if (existing?.isDirectory()) throw fileError(409, `同名目录已存在：${fileName}`);
  if (existing && !overwrite) throw fileError(409, `文件已存在：${fileName}`);

  const declared = Number(req.headers["content-length"] ?? 0);
  if (declared > UPLOAD_MAX_BYTES) {
    throw fileError(413, `超过单文件上传上限 ${Math.round(UPLOAD_MAX_BYTES / 1024 / 1024)}MB`);
  }

  const temp = join(targetDir.abs, `.${fileName}.upload-${randomUUID()}`);
  const out = createWriteStream(temp, { flags: "wx", mode: 0o644 });
  let size = 0;
  try {
    await pipeline(
      req,
      async function* limit(source) {
        for await (const chunk of source) {
          size += chunk.length;
          if (size > UPLOAD_MAX_BYTES) {
            throw fileError(413, `超过单文件上传上限 ${Math.round(UPLOAD_MAX_BYTES / 1024 / 1024)}MB`);
          }
          yield chunk;
        }
      },
      out,
    );
    await rename(temp, abs);
  } catch (error) {
    await unlink(temp).catch(() => {});
    throw error;
  }
  const info = await stat(abs).catch(() => null);
  return { project, path: rel, name: fileName, size: info?.size ?? size, mtime: info?.mtime.toISOString() ?? null };
}
