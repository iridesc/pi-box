// 大图处理：read 一张「大」的图时，别按方框缩小（那样宽度只剩一两百像素，文字必然糊）。
// 两条路，只看宽高比选：
//   - 宽高比 > 1.85（长条图：整页截图、聊天记录长图）→ 切成正方形块，相邻重叠 15%；
//   - 宽高比 ≤ 1.85（形状正常的图）          → 不切，等比缩放到长边 = 边长阈值。
// 两道最后的缩放都只有一个原则：等比缩放到长边 = 边长阈值（默认 1568）。
//
// 为什么需要：上游的图片处理器只会在 maxWidth×maxHeight 的方框里等比缩放。
// 一张 1280×9533 的整页截图进 2000×2000 的方框后变成 268×2000（宽度只剩 21%），
// 正文从 16px 掉到 3px，视觉模型读不出来——实测有会话因此转去切片、跑 OCR，又白烧一轮。
// Claude Code / Codex 也有同一个毛病（1568 长边、2048 方框），这不是我们独有的。
//
// 边长阈值 1568 的来历：Anthropic 协议的图片接口会把长边缩到 1568。我们提前缩到同一尺寸，
// 交付即最终，服务端不会再缩一次，也就没有二次重采样。MiniMax 走 anthropic-messages 兼容层。
//
// 两个参数（重叠率、边长阈值）可在系统设置 → 偏好 → 图片切块里改。
//
// 实现方式：用 wrapTool 包住 read，在它之前用 photon（WASM）解码、裁剪、重编码。
// 不该切的图、非图片、模型不支持视觉，一律原样交给上游 read，行为不变。

import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { defineExtension, wrapTool } from "@earendil-works/pi-durable";
import { createReadTool } from "@earendil-works/pi-durable/tools";
import { getOrThrow } from "@earendil-works/pi-durable/env";
import { loadPrefs, DEFAULT_PREFS } from "./io.mjs";

/**
 * 切片策略。默认值来自 prefs（prefs.json 是配置的唯一真相）。
 * tileEdge / overlapRatio 用户可改，其余是内部常量。
 */
export const SLICE_POLICY = Object.freeze({
  /** 边长阈值：缩放后图片的长边就是它；也是切块时正方形块的边长（源像素）。 */
  tileEdge: DEFAULT_PREFS.imageTiles.tileEdge,
  /** 相邻块的重叠比例（按块边长算）。15% 足以让跨界的文字在两块里都完整。 */
  overlapRatio: DEFAULT_PREFS.imageTiles.overlapRatio,
  /** 宽高比超过它才切。比例越大越「长条」，越该切成方块。 */
  minAspectRatio: 1.85,
  /** 块数兜底上限。只在极端长图上生效（超了就放大块边长，拿分辨率换块数，不砍边缘）。 */
  maxSlices: 40,
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
    tileEdge: tiles.tileEdge ?? SLICE_POLICY.tileEdge,
    overlapRatio: tiles.overlapRatio ?? SLICE_POLICY.overlapRatio,
  };
}

/** 当前宽高比（长边 / 短边）。1 = 正方形，越大越「长条」。 */
export function aspectRatioOf(width, height) {
  const long = Math.max(width, height);
  const short = Math.min(width, height);
  return short > 0 ? long / short : Infinity;
}

/**
 * 真正生效的边长：策略里的阈值，再受模型自己的尺寸上限约束。
 *
 * 模型上限比阈值更小时听模型的：交付一张超出模型上限的图，上游会再缩一次，等于白算。
 */
export function effectiveEdge(limits = DEFAULT_LIMITS, policy = SLICE_POLICY) {
  return Math.max(
    1,
    Math.round(
      Math.min(policy.tileEdge, limits.maxWidth ?? Infinity, limits.maxHeight ?? Infinity),
    ),
  );
}

/** 编码时用的尺寸上限：长边 = 生效边长，体积上限沿用模型声明。 */
export function effectiveLimits(limits = DEFAULT_LIMITS, policy = SLICE_POLICY) {
  const edge = effectiveEdge(limits, policy);
  return { maxWidth: edge, maxHeight: edge, maxBytes: limits.maxBytes };
}

/**
 * 等比缩放到「长边 = 边长阈值」。只缩不放：放大不会增加信息量，只会让 token 翻倍。
 */
export function fitToEdge(width, height, edge) {
  const long = Math.max(width, height);
  if (!(long > edge)) return { width, height, scale: 1 };
  const scale = edge / long;
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
    scale,
  };
}

/** 一个方向上要切几块：块边长 block、起点步长 step，覆盖 total 像素。 */
function axisCount(total, block, step) {
  if (total <= block) return 1;
  return Math.ceil((total - block) / step) + 1;
}

/**
 * 切分计划（纯函数，便于单测）。
 *
 * 判据只有宽高比：> minAspectRatio 就切，否则不切（交给缩放）。
 *
 * 几何规则：块是正方形，边长 block（源像素）；相邻块起点步长 = block × (1 − overlapRatio)，
 * 所以重叠正好是 overlapRatio。末行末列贴原图边缘裁剪，因此边缘块会小于 block。
 *
 * block 一般就等于边长阈值 —— 这样切出来的块不需要再缩放（交付即 1568×1568）。
 * 只在块数越过兜底上限时放大 block（拿分辨率换块数），绝不砍掉原图的边缘。
 */
export function planTiles(width, height, limits = DEFAULT_LIMITS, policy = SLICE_POLICY) {
  if (!(width > 0) || !(height > 0)) return { needed: false, tiles: [], aspectRatio: 0 };
  const aspectRatio = aspectRatioOf(width, height);
  if (aspectRatio <= policy.minAspectRatio) return { needed: false, tiles: [], aspectRatio };
  const edge = effectiveEdge(limits, policy);
  const stepOf = (block) => Math.max(1, Math.round(block * (1 - policy.overlapRatio)));
  let block = edge;
  let cols = 1;
  let rows = 1;
  let step = stepOf(block);
  // 兜底：块数超上限就放大块（拿分辨率换块数），绝不砍掉原图的边缘。
  // 每次放大 12%：块数大致随块面积反比下降，12% 一步最多几轮就收敛，不会空转。
  for (let guard = 0; guard < 64; guard++) {
    cols = axisCount(width, block, step);
    rows = axisCount(height, block, step);
    if (cols * rows <= policy.maxSlices) break;
    block = Math.ceil(block * 1.12);
    step = stepOf(block);
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
  if (tiles.length <= 1) return { needed: false, tiles: [], aspectRatio };
  return { needed: true, tiles, cols, rows, blockSize: block, step, edge, aspectRatio };
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

/** 切片说明。说清网格、重叠、阅读顺序，以及每块实际交付的尺寸（别再宣称「原始分辨率」）。 */
function tileNotice(path, width, height, plan, policy) {
  const overlapPercent = Math.round(policy.overlapRatio * 100);
  const lines = [
    `${SLICE_NOTICE_PREFIX}${width}×${height}，宽高比 ${plan.aspectRatio.toFixed(2)} > ${policy.minAspectRatio}），`,
    `已切成 ${plan.cols} 列 × ${plan.rows} 行共 ${plan.tiles.length} 块返回：每块约 ${plan.blockSize}×${plan.blockSize}px（末行末列贴边裁剪会更小），`,
    `相邻块重叠 ${overlapPercent}%（块起点步长 ${plan.step}px：第 r 行第 c 列的块起点为 x=c×${plan.step}, y=r×${plan.step}）。`,
    `块的顺序：从左到右、从上到下（先行后列）。`,
    `每块长边 = 边长阈值 ${plan.edge}px，`,
  ];
  if (plan.blockSize > plan.edge) {
    lines.push(
      `但为把块数控制在 ${policy.maxSlices} 以内，块边长被放大到 ${plan.blockSize}px，单块缩放比 ${(plan.edge / plan.blockSize).toFixed(2)}，看小字请用 bash 裁出区域再 read。`,
    );
  } else {
    lines.push(`块边长也是 ${plan.blockSize}px，所以切完不需要再缩放（不损失分辨率）。`);
  }
  lines.push(
    `原文件 ${path}。整图缩成一张会糊到读不出字，所以不要再为了"看全"去缩小整图；只需要局部时，用 bash 裁出区域再 read。`,
  );
  return lines.join("");
}

/**
 * 所有视觉输入的**唯一**入口：给一份图片字节，返回「进上下文时该长什么样」。
 *
 * 返回 undefined 表示不归它管（不是图片、不需要处理、没有 photon），调用方按普通图处理。
 *
 * 现在只有 read 工具在调；将来用户在输入框贴图 / 上传附件，也必须调这一个函数，
 * 而不是自己再写一套缩放——否则两条路径切出来的字节不同，内容哈希对不上，去重就失效了。
 */
export async function prepareImageBlocks({ bytes, mimeType, limits = DEFAULT_LIMITS, path, policy }) {
  const activePolicy = policy ?? (await currentTilePolicy());
  const dimensions = imageHeaderSize(bytes, mimeType);
  if (dimensions === undefined) return undefined;
  const edge = effectiveEdge(limits, activePolicy);
  const plan = planTiles(dimensions.width, dimensions.height, limits, activePolicy);
  const encodeLimits = effectiveLimits(limits, activePolicy);

  if (!plan.needed) {
    // 形状正常的图不切，只等比缩放。已经在阈值内、体积也不超的，原样交给调用方内联。
    const fit = fitToEdge(dimensions.width, dimensions.height, edge);
    const fits = fit.scale === 1;
    if (fits && base64Length(bytes.byteLength) <= limits.maxBytes) return undefined;
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
      { type: "text", text: tileNotice(path, dimensions.width, dimensions.height, plan, activePolicy) },
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
 *
 * 注意：不切的图（宽高比 ≤ 1.85）也要走 prepareImageBlocks 的缩放路径——上游 read 只按
 * inputLimits 的方框缩，不认我们的边长阈值（1568 < 2000）。所以这里只要「图比阈值大」
 * 就接管，判据比 planTiles 宽一档。
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
    const edge = effectiveEdge(model.limits, policy);
    const plan = planTiles(dimensions.width, dimensions.height, model.limits, policy);
    // 不需要切、且长边已经在阈值内：交给上游，行为与以前一致。
    if (!plan.needed && Math.max(dimensions.width, dimensions.height) <= edge) return undefined;

    bytes = getOrThrow(await info.read(0, size, context));
    const prepared = await prepareImageBlocks({ bytes, mimeType, limits: model.limits, path, policy });
    if (prepared === undefined) return undefined; // 没有 photon / 编码失败：交给上游
    const summary = plan.needed
      ? `${plan.cols}x${plan.rows}=${plan.tiles.length} tiles of ~${plan.blockSize}px (overlap ${Math.round(policy.overlapRatio * 100)}%)`
      : `single image scaled to ${prepared.width}x${prepared.height}`;
    return {
      output: prepared.blocks,
      diagnostics: [
        {
          severity: "info",
          code: "image_slices",
          message: `Read image file [${mimeType}] as ${summary}, edge ${edge}px.${
            prepared.notes.length > 0 ? ` ${prepared.notes.join("; ")}.` : ""
          }`,
        },
      ],
    };
  } finally {
    await info.close(context);
  }
}

/** 包住 read：大图切片/缩放，其它情况原样委托。 */
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
              console.error(`[image-slices] 处理失败，退回整图：${error instanceof Error ? error.message : error}`);
            }
          }
          return tool.execute(args, api, context);
        },
      })),
    ],
  });
}
