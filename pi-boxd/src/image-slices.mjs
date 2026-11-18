// 大图切片：read 一张「大」的图时，别按方框缩小（那样宽度只剩一两百像素，文字必然糊），
// 而是拆成两步走：先按几何切成网格状的多块，再把每块缩放到「送达模型的分辨率上限」。
//
// 为什么需要：上游的图片处理器只会在 maxWidth×maxHeight 的方框里等比缩放。
// 一张 1280×9533 的整页截图进 2000×2000 的方框后变成 268×2000（宽度只剩 21%），
// 正文从 16px 掉到 3px，视觉模型读不出来——实测有会话因此转去切片、跑 OCR，又白烧一轮。
// Claude Code / Codex 也有同一个毛病（1568 长边、2048 方框），这不是我们独有的。
//
// 算法（两步刻意解耦）：
//   第一步 · 切分：只看几何。把图切成「边长接近正方形」的网格块，相邻块重叠 15%，
//     横向纵向都切。宽大图必须横切——只纵向切的话每块仍然超宽，只能靠缩放压扁，
//     实测一张 3916×7008 的图按满宽切成 5 条，每条都被压到 51%（见 docs/CHANGELOG）。
//   第二步 · 缩放：每块缩到「长边 ≤ 目标边长」。目标边长 = √像素阈值，
//     默认 2.4M 像素（≈1568²），与 Anthropic 协议的服务端长边上限一致——
//     送过去正好不被服务端再缩一次，交付即最终，不做二次重采样。
//
// 两步分开是故意的：**块数只取决于图的大小和块数上限，清晰度只取决于像素阈值**。
// 想更清晰就调小阈值（代价是块数变多），想省 token 就调大（代价是字变小）。
//
// 触发：高宽比 > 2.5 或长边 > 3000。块数上限默认 20；超了就放大块（拿分辨率换块数），
// 而不是砍掉图的边缘——少给内容比给糊的内容更糟。
//
// 实现方式：用 wrapTool 包住 read，在它之前用 photon（WASM）解码、裁剪、重编码。
// 非大图、非图片、模型不支持视觉，一律原样交给上游 read，行为不变。

import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { defineExtension, wrapTool } from "@earendil-works/pi-durable";
import { createReadTool } from "@earendil-works/pi-durable/tools";
import { getOrThrow } from "@earendil-works/pi-durable/env";
import { loadPrefs, DEFAULT_PREFS } from "./io.mjs";

/**
 * 切片策略。默认值来自 prefs（prefs.json 是配置的唯一真相），设置里改的就是这三个值。
 * targetPixels 是「每块送进上下文的像素数」，可在系统设置里调。
 */
export const SLICE_POLICY = Object.freeze({
  /** 每块的目标像素数（面积）。2_458_624 = 1568²，正好是服务端长边上限。 */
  targetPixels: DEFAULT_PREFS.imageTiles.targetPixels,
  /** 相邻块的重叠比例（按块边长算）。15% 足以让跨界的文字在两块里都完整。 */
  overlapRatio: DEFAULT_PREFS.imageTiles.overlapRatio,
  /** 块数上限。超了就放大块来压块数，不砍内容。 */
  maxSlices: DEFAULT_PREFS.imageTiles.maxSlices,
  /** 高宽比超过它算「长条图」（整页截图这类），一律要切。 */
  minAspect: 2.5,
  /** 长边超过它也算「大图」，一样要切（宽大图必须横切，见文件头注释）。 */
  maxEdge: 3000,
});

/** 切片说明文字的前缀。占位替换、文图绑定都靠它认出「这条消息是一组切片」。 */
export const SLICE_NOTICE_PREFIX = "这是一张大图（";

const HEADER_BYTES = 64 * 1024;
const JPEG_QUALITIES = [80, 70, 55, 40];
export const DEFAULT_IMAGE_LIMITS = { maxWidth: 2000, maxHeight: 2000, maxBytes: 4.5 * 1024 * 1024 };
const DEFAULT_LIMITS = DEFAULT_IMAGE_LIMITS;

/** 把 Uint8Array 当 DataView 用（环境可能给 Buffer，也可能给纯 Uint8Array）。 */
function viewOf(bytes) {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}

function asciiAt(bytes, offset, length) {
  let text = "";
  for (let index = 0; index < length; index++) text += String.fromCharCode(bytes[offset + index] ?? 0);
  return text;
}

/** 图片文件头的 mime 识别（只认 read 支持的内联格式）。 */
export function detectImageMime(bytes) {
  if (bytes.length >= 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return "image/png";
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
  if (bytes.length >= 6 && bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46) return "image/gif";
  if (bytes.length >= 12 && asciiAt(bytes, 0, 4) === "RIFF" && asciiAt(bytes, 8, 4) === "WEBP") return "image/webp";
  return undefined;
}

/** 不解码整图，只从文件头读出宽高（PNG 的 IHDR、GIF 的屏幕、JPEG 的 SOF、WebP 的 VP8/VP8L/VP8X）。 */
export function imageHeaderSize(bytes, mimeType) {
  try {
    const view = viewOf(bytes);
    if (mimeType === "image/png") {
      if (bytes.length < 24) return undefined;
      return { width: view.getUint32(16), height: view.getUint32(20) };
    }
    if (mimeType === "image/gif") {
      if (bytes.length < 10) return undefined;
      return { width: view.getUint16(6, true), height: view.getUint16(8, true) };
    }
    if (mimeType === "image/jpeg") {
      let offset = 2;
      while (offset + 9 < bytes.length) {
        if (bytes[offset] !== 0xff) {
          offset += 1;
          continue;
        }
        const marker = bytes[offset + 1];
        const length = view.getUint16(offset + 2);
        // SOF0..SOF15（排除 DHT 0xc4 / JPG 0xc8 / DAC 0xcc 这几个非 SOF 标记）
        if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
          return { width: view.getUint16(offset + 7), height: view.getUint16(offset + 5) };
        }
        offset += 2 + length;
      }
      return undefined;
    }
    if (mimeType === "image/webp") {
      const chunk = asciiAt(bytes, 12, 4);
      if (chunk === "VP8X" && bytes.length >= 30) {
        const width = 1 + ((bytes[24] | (bytes[25] << 8) | (bytes[26] << 16)) & 0xffffff);
        const height = 1 + ((bytes[27] | (bytes[28] << 8) | (bytes[29] << 16)) & 0xffffff);
        return { width, height };
      }
      if (chunk === "VP8 " && bytes.length >= 30) {
        return { width: view.getUint16(26, true) & 0x3fff, height: view.getUint16(28, true) & 0x3fff };
      }
      if (chunk === "VP8L" && bytes.length >= 25) {
        const bits = view.getUint32(21, true);
        return { width: (bits & 0x3fff) + 1, height: (bits >> 14 & 0x3fff) + 1 };
      }
      return undefined;
    }
  } catch {
    return undefined;
  }
  return undefined;
}

/**
 * 当前生效的策略：默认值 + 系统设置里改过的部分（prefs.imageTiles）。
 *
 * prefs 读出来时已经被 normalizeImageTiles 夹过范围、补过默认值，这里不再重复夹。
 */
export async function currentTilePolicy() {
  const tiles = (await loadPrefs()).imageTiles ?? {};
  return {
    ...SLICE_POLICY,
    targetPixels: tiles.targetPixels ?? SLICE_POLICY.targetPixels,
    overlapRatio: tiles.overlapRatio ?? SLICE_POLICY.overlapRatio,
    maxSlices: tiles.maxSlices ?? SLICE_POLICY.maxSlices,
  };
}

/** 目标边长：像素阈值的平方根，再受模型自己的尺寸上限约束。 */
export function targetEdgeOf(limits = DEFAULT_LIMITS, policy = SLICE_POLICY) {
  const edge = Math.sqrt(policy.targetPixels);
  return Math.max(1, Math.min(Math.round(edge), limits.maxWidth ?? Infinity, limits.maxHeight ?? Infinity));
}

/**
 * 编码时真正生效的尺寸上限：模型的 inputLimits 与「目标边长」取小的那个。
 *
 * 为什么要再压一道：服务端（Anthropic 协议）会把长边缩到 1568，我们提前缩到同一尺寸，
 * 交付即最终，不做二次重采样；也比 2000 的默认上限省字节。
 */
export function effectiveLimits(limits = DEFAULT_LIMITS, policy = SLICE_POLICY) {
  const edge = targetEdgeOf(limits, policy);
  return {
    maxWidth: Math.min(limits.maxWidth ?? edge, edge),
    maxHeight: Math.min(limits.maxHeight ?? edge, edge),
    maxBytes: limits.maxBytes,
  };
}

/**
 * 一个方向上要切几块：块边长 block、起点步长 step，覆盖 total 像素。
 *
 * 末块可能比整块小（贴边裁剪），但两个方向都不会超过 block —— 所以每块的缩放比一致，
 * 图上各处的清晰度相同。宁可多切一条窄边，也不要为了凑整块把某一行压糊。
 */
function axisCount(total, block, step) {
  if (total <= block) return 1;
  return Math.ceil((total - block) / step) + 1;
}

/**
 * 切分计划（纯函数，便于单测）。
 *
 * 几何规则：块边长 block（源像素），相邻块起点步长 = block × (1 − overlapRatio)，
 * 所以重叠正好是 overlapRatio。横向纵向都切，末行末列贴原图边缘裁剪。
 *
 * block 的取法：先取「目标边长」（= 不缩放、原样交付），块数超上限就放大 block
 * （拿分辨率换块数），绝不砍掉原图的边缘。
 */
export function planTiles(width, height, limits = DEFAULT_LIMITS, policy = SLICE_POLICY) {
  if (!(width > 0) || !(height > 0)) return { needed: false, tiles: [] };
  const aspect = Math.max(width, height) / Math.min(width, height);
  if (aspect <= policy.minAspect && Math.max(width, height) <= policy.maxEdge) {
    return { needed: false, tiles: [] };
  }
  const targetEdge = targetEdgeOf(limits, policy);
  const step0 = (block) => Math.max(1, Math.round(block * (1 - policy.overlapRatio)));
  let block = Math.min(targetEdge, Math.max(width, height));
  let cols = 1;
  let rows = 1;
  let step = step0(block);
  // 块数超上限就放大块（拿分辨率换块数），绝不砍掉原图的边缘。
  // 每次放大 12%：块数大致随块面积反比下降，12% 一步最多两三轮就收敛，不会空转。
  for (let guard = 0; guard < 64; guard++) {
    cols = axisCount(width, block, step);
    rows = axisCount(height, block, step);
    if (cols * rows <= policy.maxSlices) break;
    block = Math.ceil(block * 1.12);
    step = step0(block);
  }
  const tiles = [];
  for (let row = 0; row < rows; row++) {
    for (let col = 0; col < cols; col++) {
      const x = Math.min(width, col * step);
      const y = Math.min(height, row * step);
      const x2 = Math.min(width, col === cols - 1 ? width : x + block);
      const y2 = Math.min(height, row === rows - 1 ? height : y + block);
      if (x2 <= x || y2 <= y) continue;
      tiles.push({ x, y, width: x2 - x, height: y2 - y, row, col });
    }
  }
  if (tiles.length <= 1) return { needed: false, tiles: [] };
  return { needed: true, tiles, cols, rows, blockSize: block, step, targetEdge };
}

/** 一块缩放后的尺寸：长边不超过目标边长，且不放大。 */
export function tileOutputSize(tile, limits = DEFAULT_LIMITS, policy = SLICE_POLICY) {
  const edge = targetEdgeOf(limits, policy);
  const scale = Math.min(1, edge / Math.max(tile.width, tile.height));
  return {
    width: Math.max(1, Math.round(tile.width * scale)),
    height: Math.max(1, Math.round(tile.height * scale)),
    scale,
  };
}

let photon;

/** 懒加载 photon（WASM）。取不到就返回 undefined，调用方退化成上游的整图缩放。 */
async function loadPhoton() {
  if (photon !== undefined) return photon;
  try {
    const mod = await import("@silvia-odwyer/photon/photon_rs.js");
    const require = createRequire(import.meta.url);
    const wasm = await readFile(require.resolve("@silvia-odwyer/photon/photon_rs_bg.wasm"));
    mod.initSync({ module: wasm });
    photon = { mod };
  } catch (error) {
    console.error(`[image-slices] 无法加载 photon（${error instanceof Error ? error.message : error}），大图退回整图缩放`);
    photon = null;
  }
  return photon ?? undefined;
}

function base64Length(byteLength) {
  return Math.ceil(byteLength / 3) * 4;
}

/** 一片图按模型上限编码：先原尺寸，超体积再降质，仍超就按 3/4 递减尺寸（与上游处理器同思路）。 */
function encodeSlice(photonMod, image, mimeType, limits) {
  const { resize, SamplingFilter } = photonMod;
  const width = image.get_width();
  const height = image.get_height();
  const scale = Math.min(1, limits.maxWidth / width, limits.maxHeight / height);
  let target = {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
  };
  const jpegFirst = mimeType === "image/jpeg";
  for (;;) {
    const same = target.width === width && target.height === height;
    const scaled = same ? image : resize(image, target.width, target.height, SamplingFilter.Lanczos3);
    try {
      const candidates = [
        { mimeType: "image/png", encode: () => scaled.get_bytes() },
        ...JPEG_QUALITIES.map((quality) => ({ mimeType: "image/jpeg", encode: () => scaled.get_bytes_jpeg(quality) })),
      ];
      for (const candidate of jpegFirst ? [...candidates.slice(1), candidates[0]] : candidates) {
        const bytes = candidate.encode();
        if (base64Length(bytes.byteLength) <= limits.maxBytes) {
          return {
            data: Buffer.from(bytes).toString("base64"),
            mimeType: candidate.mimeType,
            width: target.width,
            height: target.height,
          };
        }
      }
    } finally {
      if (!same) scaled.free();
    }
    if (target.width === 1 || target.height === 1) return undefined;
    target = {
      width: Math.max(1, Math.round(target.width * 0.75)),
      height: Math.max(1, Math.round(target.height * 0.75)),
    };
  }
}

/** 当前会话模型的图片上限与是否支持视觉。 */
async function imageModelOf(api, context) {
  const ref = (await api.agent(context)).model;
  const model = ref === undefined ? undefined : api.models.getModel(ref.provider, ref.modelId);
  const resize = model?.inputLimits?.images?.resize;
  return {
    vision: model?.input?.includes("image") ?? true,
    limits: {
      maxWidth: resize?.maxWidth ?? DEFAULT_LIMITS.maxWidth,
      maxHeight: resize?.maxHeight ?? DEFAULT_LIMITS.maxHeight,
      maxBytes: resize?.maxBytes ?? DEFAULT_LIMITS.maxBytes,
    },
  };
}

/** 切片说明。写法有两条硬要求：① 老实说清分辨率，别再宣称「原始分辨率」；② 说清阅读顺序。 */
function tileNotice(path, width, height, plan, limits, policy) {
  const out = plan.tiles.map((tile) => tileOutputSize(tile, limits, policy));
  const maxOut = Math.max(...out.map((size) => Math.max(size.width, size.height)));
  const minScale = Math.min(...out.map((size) => size.scale));
  const overlapPercent = Math.round(policy.overlapRatio * 100);
  const lines = [
    `${SLICE_NOTICE_PREFIX}${width}×${height}），已切成 ${plan.cols} 列 × ${plan.rows} 行共 ${plan.tiles.length} 块返回：`,
    `每块长边 ≤ ${plan.targetEdge}px，相邻块重叠 ${overlapPercent}%（块起点步长 ${plan.step}px：第 r 行第 c 列的块起点为 x=c×${plan.step}, y=r×${plan.step}，末行末列贴原图边缘裁剪）。`,
    `块的顺序：从左到右、从上到下（先行后列）。`,
    `每块实际输出最长边 ${maxOut}px，相对原图的缩放比 ${minScale.toFixed(2)}${minScale >= 0.999 ? "（未损失分辨率）" : "（小字可能偏糊）"}。`,
  ];
  if (minScale < 0.999) {
    lines.push(
      `为把块数控制在 ${policy.maxSlices} 以内，块边长被放大到 ${plan.blockSize}px，清晰度低于原图；看小字请用 bash 裁出区域再 read。`,
    );
  }
  lines.push(
    `原文件 ${path}。整图缩成一张会糊到读不出字，所以不要再为了"看全"去缩小整图；只需要局部时，用 bash 裁出区域再 read。`,
  );
  return lines.join("");
}

/**
 * 所有视觉输入的**唯一**入口：给一份图片字节，返回「进上下文时该长什么样」。
 *
 * 返回 undefined 表示不归它管（不是图片、不需要切片、没有 photon），调用方按普通图处理。
 *
 * 现在只有 read 工具在调；将来用户在输入框贴图 / 上传附件，也必须调这一个函数，
 * 而不是自己再写一套缩放——否则两条路径切出来的字节不同，内容哈希对不上，去重就失效了。
 */
export async function prepareImageBlocks({ bytes, mimeType, limits = DEFAULT_LIMITS, path, policy }) {
  const activePolicy = policy ?? (await currentTilePolicy());
  const dimensions = imageHeaderSize(bytes, mimeType);
  if (dimensions === undefined) return undefined;
  const plan = planTiles(dimensions.width, dimensions.height, limits, activePolicy);
  const encodeLimits = effectiveLimits(limits, activePolicy);
  if (!plan.needed) {
    // 普通比例的大图不切，但可能在尺寸或体积上超限。模型只对 read 工具返回的图做
    // inputLimits 缩放，用户消息里直接内联的 image block 原样发给上游 —— 不在这里缩，
    // 一张 4000×3000 的手机照片就会整个塞进去。
    const withinSize = base64Length(bytes.byteLength) <= limits.maxBytes;
    if (
      dimensions.width <= encodeLimits.maxWidth &&
      dimensions.height <= encodeLimits.maxHeight &&
      withinSize
    ) {
      return undefined; // 已经在限内，调用方原样内联即可
    }
    const loaded = await loadPhoton();
    if (loaded === undefined) return undefined;
    const image = loaded.mod.PhotonImage.new_from_byteslice(bytes);
    try {
      // 复用切块的编码策略：同一套缩放算法才能保证字节稳定，内容哈希才不会飘。
      const encoded = encodeSlice(loaded.mod, image, mimeType, encodeLimits);
      if (encoded === undefined) return undefined;
      return {
        blocks: [{ type: "image", data: encoded.data, mimeType: encoded.mimeType }],
        mimeType: encoded.mimeType,
        width: encoded.width,
        height: encoded.height,
        slices: 1,
        notes: encoded.mimeType === mimeType ? [] : [`转为 ${encoded.mimeType}`],
      };
    } finally {
      image.free();
    }
  }

  const loaded = await loadPhoton();
  if (loaded === undefined) return undefined; // 没有 photon 就交给上游

  const { mod } = loaded;
  const image = mod.PhotonImage.new_from_byteslice(bytes);
  const outputs = [];
  const notes = [];
  try {
    for (const [index, tile] of plan.tiles.entries()) {
      const cropped = mod.crop(image, tile.x, tile.y, tile.x + tile.width, tile.y + tile.height);
      try {
        const encoded = encodeSlice(mod, cropped, mimeType, encodeLimits);
        if (encoded === undefined) return undefined; // 编码失败：退回上游，别给半张图
        outputs.push({ type: "image", data: encoded.data, mimeType: encoded.mimeType });
        if (encoded.mimeType !== mimeType) {
          notes.push(`第 ${index + 1} 块转为 ${encoded.mimeType}`);
        }
      } finally {
        cropped.free();
      }
    }
  } finally {
    image.free();
  }
  return {
    blocks: [
      ...outputs,
      { type: "text", text: tileNotice(path, dimensions.width, dimensions.height, plan, limits, activePolicy) },
    ],
    mimeType,
    width: dimensions.width,
    height: dimensions.height,
    slices: outputs.length,
    notes,
  };
}

/**
 * 大图走自己的管线；返回 undefined 表示「不归我管」，调用方原样交给上游 read。
 */
async function sliceRead(path, api, context, fallback) {
  const env = api.env;
  if (env === undefined || typeof path !== "string" || path.length === 0) return undefined;
  const absolute = getOrThrow(await env.absolutePath(path, context));
  const info = getOrThrow(await env.openBinaryReader(absolute, undefined, context));
  let bytes;
  let size;
  try {
    const meta = getOrThrow(await info.info(context));
    size = meta.size;
    const head = getOrThrow(await info.read(0, Math.min(HEADER_BYTES, size), context));
    const mimeType = detectImageMime(head);
    if (mimeType === undefined) return undefined;
    const dimensions = imageHeaderSize(head, mimeType);
    if (dimensions === undefined) return undefined;
    const policy = await currentTilePolicy();
    const model = await imageModelOf(api, context);
    if (!model.vision) return undefined; // 纯文本模型：上游会换成占位符，没必要解码
    const plan = planTiles(dimensions.width, dimensions.height, model.limits, policy);
    if (!plan.needed) return undefined;

    bytes = getOrThrow(await info.read(0, size, context));
    const prepared = await prepareImageBlocks({ bytes, mimeType, limits: model.limits, path, policy });
    if (prepared === undefined) return undefined; // 没有 photon / 编码失败：交给上游
    return {
      output: prepared.blocks,
      diagnostics: [
        {
          severity: "info",
          code: "image_slices",
          message: `Read image file [${mimeType}] as ${plan.cols}x${plan.rows}=${plan.tiles.length} tiles of ~${plan.blockSize}px (overlap ${Math.round(policy.overlapRatio * 100)}%, target edge ${plan.targetEdge}px).${
            prepared.notes.length > 0 ? ` ${prepared.notes.join("; ")}.` : ""
          }`,
        },
      ],
    };
  } finally {
    await info.close(context);
  }
}

/** 包住 read：大图切片，其它情况原样委托。 */
export function createImageSliceExtension() {
  const readTool = createReadTool();
  return defineExtension({
    name: "image-slices",
    wraps: [
      wrapTool(readTool, (tool) => ({
        ...tool,
        async execute(args, api, context) {
          if (typeof args?.path === "string") {
            try {
              const sliced = await sliceRead(args.path, api, context, () => tool.execute(args, api, context));
              if (sliced !== undefined) return sliced;
            } catch (error) {
              console.error(`[image-slices] 切片失败，退回整图：${error instanceof Error ? error.message : error}`);
            }
          }
          return tool.execute(args, api, context);
        },
      })),
    ],
  });
}
