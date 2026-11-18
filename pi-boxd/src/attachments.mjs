// 会话附件：用户在输入框里贴的图 / 拖进来的文件。
//
// 存放位置固定在 <项目根>/.pi-box/uploads/。选这里的理由：
// - 在 agent 的工作目录内，模型用 read / bash 直接够得着，不用额外的路径映射；
// - `.pi-box` 已在 files.mjs 的 PROTECTED_HEADS 里，删不掉（附件是会话的证据）；
// - 又不在文件树里显示，不会把用户的项目目录搞乱。
//
// 两个刻意的设计：
// 1. 文件名由后端生成（时间戳 + 随机 + 原名），前端只提供原始文件名。前端拿不到
//    任意路径的写权限。
// 2. 图片和文件走**同一个**上传端点、同一套落盘逻辑。区别只在 /api/send 组装消息时：
//    图片读回来内联成 image block（模型立刻能看），文件只在文本里留路径（让模型自己 read）。
import { createHash, randomUUID } from "node:crypto";
import { createWriteStream } from "node:fs";
import { mkdir, readFile, rename, stat, unlink } from "node:fs/promises";
import { basename, extname, join } from "node:path";
import { pipeline } from "node:stream/promises";
import { detectImageMime } from "./image-slices.mjs";

/** 单附件上限：复用原来的上传口径，200MB。 */
export const ATTACHMENT_MAX_BYTES = Number(process.env.PI_BOX_ATTACHMENT_MAX_BYTES ?? 200 * 1024 * 1024);
/** 一条消息里最多几个附件。 */
export const ATTACHMENT_MAX_COUNT = Number(process.env.PI_BOX_ATTACHMENT_MAX_COUNT ?? 10);
/** 图片单独限数量：一张图就是一份 base64，比普通文件贵得多。 */
export const ATTACHMENT_MAX_IMAGES = Number(process.env.PI_BOX_ATTACHMENT_MAX_IMAGES ?? 6);
/** 附件目录（相对项目根的路径）。 */
export const ATTACHMENT_DIR = ".pi-box/uploads";

/** 这些扩展名一律当图片处理（即使文件头识别失败也按图片报错，避免静默变成普通文件）。 */
const IMAGE_EXTS = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp"]);

function attachError(status, message) {
  const error = new Error(message);
  error.status = status;
  return error;
}

/** 附件目录的绝对路径；不存在就建。
 *  用 cwd（会话的工作目录）而不是项目名：元项目、临时会话都能落在自己的目录里。 */
async function attachmentRoot(root) {
  if (typeof root !== "string" || !root) throw attachError(400, "缺少工作目录");
  const dir = join(root, ...ATTACHMENT_DIR.split("/"));
  await mkdir(dir, { recursive: true, mode: 0o755 });
  return dir;
}

/** 浏览器给的文件名可能带路径、控制字符；只留最后一段并清掉危险字符。 */
export function sanitizeAttachmentName(name) {
  const raw = basename(String(name ?? "").replace(/\\/g, "/"));
  const cleaned = raw.replace(/[\u0000-\u001f\u007f/]/g, "").replace(/^\.+/, "").trim();
  return cleaned.slice(0, 120) || "attachment";
}

/** 生成不撞车的文件名：20261117-120000-<8位随机>-原名.png */
function uniqueName(name) {
  const stamp = new Date().toISOString().replace(/[-:T]/g, "").slice(0, 14).replace(/(\d{8})(\d{6})/, "$1-$2");
  return `${stamp}-${randomUUID().slice(0, 8)}-${name}`;
}

/**
 * 把请求体（文件裸流）写成附件。
 *
 * 返回的 path 是**相对项目根**的路径，直接可以给模型（它在项目根的 cwd 里）。
 */
export async function saveAttachment(req, { root, name }) {
  const dir = await attachmentRoot(root);
  const fileName = uniqueName(sanitizeAttachmentName(name));
  const abs = join(dir, fileName);
  const rel = `${ATTACHMENT_DIR}/${fileName}`;

  const declared = Number(req.headers["content-length"] ?? 0);
  if (declared > ATTACHMENT_MAX_BYTES) {
    throw attachError(413, `超过单附件上限 ${Math.round(ATTACHMENT_MAX_BYTES / 1024 / 1024)}MB`);
  }

  // 边写边算 sha256：图片去重按内容哈希，落盘时就有一个可以比对的键。
  const hash = createHash("sha256");
  const temp = join(dir, `.${fileName}.part-${randomUUID()}`);
  let size = 0;
  try {
    await pipeline(
      req,
      async function* limit(source) {
        for await (const chunk of source) {
          size += chunk.length;
          if (size > ATTACHMENT_MAX_BYTES) {
            throw attachError(413, `超过单附件上限 ${Math.round(ATTACHMENT_MAX_BYTES / 1024 / 1024)}MB`);
          }
          hash.update(chunk);
          yield chunk;
        }
      },
      createWriteStream(temp, { flags: "wx", mode: 0o644 }),
    );
    if (size === 0) throw attachError(400, "空文件");
    await rename(temp, abs);
  } catch (error) {
    await unlink(temp).catch(() => {});
    throw error;
  }

  // 用文件头判定真实类型，不信 Content-Type（浏览器对 .md/.csv 常给空或 octet-stream）。
  const head = await readAttachmentBytes(root, rel, Math.min(size, 64));
  const sniffed = head === undefined ? undefined : detectImageMime(head);
  const ext = extname(fileName).toLowerCase();
  const isImage = sniffed !== undefined || IMAGE_EXTS.has(ext);

  return {
    path: rel,
    name: fileName,
    originalName: sanitizeAttachmentName(name),
    size,
    sha256: hash.digest("hex").slice(0, 16),
    mimeType: sniffed,
    isImage,
  };
}

/** 读附件前 limit 个字节（判定文件头用），不整份读。 */
async function readAttachmentBytes(root, rel, limit) {
  try {
    const abs = await attachmentAbsolute(root, rel);
    const handle = await readFile(abs);
    return handle.subarray(0, limit);
  } catch {
    return undefined;
  }
}

/** 附件相对路径 → 绝对路径，并挡住跳出 uploads 的写法。 */
export async function attachmentAbsolute(root, rel) {
  const normalized = String(rel ?? "").replace(/\\/g, "/").replace(/^\/+/, "");
  if (!normalized.startsWith(`${ATTACHMENT_DIR}/`)) {
    throw attachError(400, `只能读取 ${ATTACHMENT_DIR}/ 下的附件`);
  }
  if (normalized.split("/").some((part) => part === ".." || part === "")) {
    throw attachError(400, "附件路径非法");
  }
  return join(root, ...normalized.split("/"));
}

/** 整份读回附件（图片要拿去内联，必须全量）。 */
export async function readAttachment(root, rel) {
  const abs = await attachmentAbsolute(root, rel);
  const info = await stat(abs).catch(() => null);
  if (!info || !info.isFile()) throw attachError(404, `附件不存在：${rel}`);
  if (info.size > ATTACHMENT_MAX_BYTES) throw attachError(413, "附件过大");
  return { bytes: await readFile(abs), size: info.size };
}

/** 删附件（发送失败 / 用户移除 chip 时前端会调）。 */
export async function deleteAttachment(root, rel) {
  const abs = await attachmentAbsolute(root, rel);
  await unlink(abs).catch(() => {});
  return { ok: true };
}

/**
 * 把一次发送的附件清单组装成消息内容。
 *
 * - 图片：读回来 → prepareImageBlocks 缩放/切片 → 内联成 image block，模型无需 read。
 * - 其他文件：只在文本里列路径，让模型自己决定 read 还是 bash。
 *
 * 返回 { content, attachments }，attachments 进 entry.data 供前端渲染缩略图 —— 库里
 * 只留路径，不留 base64。
 */
export async function buildAttachmentContent({ root, text, attachments, prepare }) {
  const files = [];
  const images = [];
  for (const item of attachments ?? []) {
    const rel = typeof item === "string" ? item : item?.path;
    if (typeof rel !== "string" || !rel) continue;
    const abs = await attachmentAbsolute(root, rel).catch(() => undefined);
    if (abs === undefined) throw attachError(400, `附件路径非法：${rel}`);
    const info = await stat(abs).catch(() => null);
    if (!info || !info.isFile()) throw attachError(404, `附件不存在：${rel}`);
    files.push({
      path: rel,
      name: basename(rel),
      size: info.size,
      kind: item?.kind === "image" ? "image" : undefined,
    });
  }

  if (files.length > ATTACHMENT_MAX_COUNT) {
    throw attachError(400, `一次最多 ${ATTACHMENT_MAX_COUNT} 个附件`);
  }

  const blocks = [];
  // 按 path 收集，最后按 files 的原顺序输出：图片和文件是分两趟处理的，
  // 直接 push 会把顺序搅乱（用户先贴的图会排到文件后面）。
  const recordedByPath = new Map();
  const record = (item) => recordedByPath.set(item.path, item);
  for (const file of files) {
    const { bytes } = await readAttachment(root, file.path);
    const mimeType = detectImageMime(bytes);
    const treatAsImage = file.kind === "image" || mimeType !== undefined;
    if (!treatAsImage) {
      record({ ...file, mimeType: undefined, inline: false });
      continue;
    }
    if (mimeType === undefined) {
      // 前端说是图片但文件头不认识（heic / bmp 之类）：当普通文件给路径，别硬塞。
      record({ ...file, mimeType: undefined, inline: false });
      continue;
    }
    images.push({ ...file, mimeType, bytes });
  }

  if (images.length > ATTACHMENT_MAX_IMAGES) {
    throw attachError(400, `一次最多 ${ATTACHMENT_MAX_IMAGES} 张图片`);
  }

  for (const image of images) {
    const prepared = await prepare({ bytes: image.bytes, mimeType: image.mimeType, path: image.path });
    if (prepared?.blocks) {
      blocks.push(...prepared.blocks);
      record({
        ...image,
        inline: true,
        width: prepared.width,
        height: prepared.height,
        slices: prepared.slices ?? 1,
      });
      continue;
    }
    blocks.push({ type: "image", data: Buffer.from(image.bytes).toString("base64"), mimeType: image.mimeType });
    record({ ...image, inline: true, slices: 1 });
  }

  const recorded = files.map((file) => recordedByPath.get(file.path)).filter(Boolean);

  // 文本块放在最前：模型先看到用户的意图，再看到图。
  const header = [];
  if (text) header.push(text);
  const plainFiles = recorded.filter((item) => !item.inline);
  if (plainFiles.length > 0) {
    header.push(
      ["", ...plainFiles.map((item) => `附件：${item.path}（${formatSize(item.size)}）`)].join("\n"),
    );
  }
  const finalBlocks = header.length > 0 ? [{ type: "text", text: header.join("\n") }, ...blocks] : blocks;

  return {
    content: finalBlocks.length === 1 && finalBlocks[0].type === "text" ? finalBlocks[0].text : finalBlocks,
    attachments: recorded.map(({ bytes: _bytes, ...rest }) => rest),
  };
}

function formatSize(bytes) {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)}MB`;
}