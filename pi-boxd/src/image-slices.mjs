// 长图切片：read 一张「又长又窄」的图时，别按方框缩小（那样宽度只剩一两百像素，文字必然糊），
// 而是按原始分辨率切成若干片，每片各自按模型尺寸上限缩放。模型拿到 N 张可读的图 + 一段说明。
//
// 为什么需要：上游的图片处理器只会在 maxWidth×maxHeight 的方框里等比缩放。
// 一张 1280×9533 的整页截图进 2000×2000 的方框后变成 269×2000（宽度只剩 21%），
// 正文从 16px 掉到 3px，视觉模型读不出来——实测有会话因此转去切片、跑 OCR，又白烧一轮。
// Claude Code / Codex 也有同一个毛病（1568 长边、2048 方框），这不是我们独有的。
//
// 触发：高宽比 > 2.5 或长边 > 3000；片高 1600、相邻重叠 120px；最多 12 片。
// 超过 12 片不硬塞：退化成上游的整图缩放，并明确告诉模型「已退化，读不清就先裁区域」。
//
// 实现方式：用 wrapTool 包住 read，在它之前用 photon（WASM）解码、裁剪、重编码。
// 非长图、非图片、模型不支持视觉，一律原样交给上游 read，行为不变。

import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { defineExtension, wrapTool } from "@earendil-works/pi-durable";
import { createReadTool } from "@earendil-works/pi-durable/tools";
import { getOrThrow } from "@earendil-works/pi-durable/env";

/** 切片策略。片高对齐模型原生上限（2000）的 80%，重叠保证跨界文字在两片里都完整。 */
/** 切片说明文字的前缀。占位替换、文图绑定都靠它认出「这条消息是一组切片」。 */
export const SLICE_NOTICE_PREFIX = "这是一张长图（";

export const SLICE_POLICY = Object.freeze({
  sliceHeight: 1600,
  overlap: 120,
  maxSlices: 12,
  minAspect: 2.5,
  maxEdge: 3000,
});

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
        return { width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1 };
      }
      return undefined;
    }
  } catch {
    return undefined;
  }
  return undefined;
}

/**
 * 切不切、怎么切（纯函数，便于单测）。`needed` 为 false 表示按普通图片处理。
 * 需要切但片数超过上限时返回 `capped: true` 且 `slices` 为空——调用方应退化成整图并提示模型。
 */
export function planSlices(width, height, policy = SLICE_POLICY) {
  if (!(width > 0) || !(height > 0)) return { needed: false, slices: [], capped: false };
  const aspect = height / width;
  if (aspect <= policy.minAspect && Math.max(width, height) <= policy.maxEdge) {
    return { needed: false, slices: [], capped: false };
  }
  const step = policy.sliceHeight - policy.overlap;
  const count = Math.max(1, Math.ceil((height - policy.overlap) / step));
  if (count <= 1) return { needed: false, slices: [], capped: false };
  if (count > policy.maxSlices) return { needed: true, slices: [], capped: true, count };
  const slices = [];
  for (let index = 0; index < count; index++) {
    const y = Math.min(index * step, Math.max(0, height - policy.sliceHeight));
    const sliceHeight = Math.min(policy.sliceHeight, height - y);
    slices.push({ y, height: sliceHeight });
  }
  return { needed: true, slices, capped: false, count };
}

/** 片数超上限时的说明。退化路径和 prepareImageBlocks 共用同一段文案。 */
export function sliceCappedNote(width, height, count) {
  return `这张图 ${width}×${height} 需要切成 ${count} 片才清晰，超过上限 ${SLICE_POLICY.maxSlices} 片，已按整图缩小返回：文字大概率读不清。要看细节请先用 bash 裁出关心的区域（如 ImageMagick 的 convert -crop）再 read，或转成文本。`;
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
    console.error(`[image-slices] 无法加载 photon（${error instanceof Error ? error.message : error}），长图退回整图缩放`);
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

function sliceNotice(path, width, height, slices, policy) {
  const range = slices.map((slice, index) => `${index + 1}:y=${slice.y}-${slice.y + slice.height}`).join(", ");
  return [
    `${SLICE_NOTICE_PREFIX}${width}×${height}），已按原始分辨率切成 ${slices.length} 片自上而下返回：片高 ${policy.sliceHeight}px，`,
    `相邻重叠 ${policy.overlap}px（跨界的文字会在两片里都出现，不要重复引用）。各片在原始图中的纵向范围：${range}。`,
    `原文件 ${path}。整图缩成一张会糊到读不出字，所以不要再为了"看全"去缩小整图；只需要局部时，用 bash 裁出区域再 read。`,
  ].join("");
}

/**
 * 所有视觉输入的**唯一**入口：给一份图片字节，返回「进上下文时该长什么样」。
 *
 * 返回 undefined 表示不归它管（不是图片、不需要切片、没有 photon），调用方按普通图处理。
 * 需要切片但片数超上限时返回 `{ capped: true, note }`，调用方退化成整图并把 note 交给模型。
 *
 * 现在只有 read 工具在调；将来用户在输入框贴图 / 上传附件，也必须调这一个函数，
 * 而不是自己再写一套缩放——否则两条路径切出来的字节不同，内容哈希对不上，去重就失效了。
 */
export async function prepareImageBlocks({ bytes, mimeType, limits, path }) {
  const dimensions = imageHeaderSize(bytes, mimeType);
  if (dimensions === undefined) return undefined;
  const plan = planSlices(dimensions.width, dimensions.height);
  if (!plan.needed) {
    // 普通比例的大图不切，但可能在尺寸或体积上超限。模型只对 read 工具返回的图做
    // inputLimits 缩放，用户消息里直接内联的 image block 原样发给上游 —— 不在这里缩，
    // 一张 4000×3000 的手机照片就会整个塞进去。
    const withinSize = base64Length(bytes.byteLength) <= limits.maxBytes;
    if (dimensions.width <= limits.maxWidth && dimensions.height <= limits.maxHeight && withinSize) {
      return undefined; // 已经在限内，调用方原样内联即可
    }
    const loaded = await loadPhoton();
    if (loaded === undefined) return undefined;
    const image = loaded.mod.PhotonImage.new_from_byteslice(bytes);
    try {
      // 复用切片的编码策略：同一套缩放算法才能保证字节稳定，内容哈希才不会飘。
      const encoded = encodeSlice(loaded.mod, image, mimeType, limits);
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
  if (plan.capped) {
    return {
      capped: true,
      count: plan.count,
      width: dimensions.width,
      height: dimensions.height,
      note: sliceCappedNote(dimensions.width, dimensions.height, plan.count),
    };
  }

  const loaded = await loadPhoton();
  if (loaded === undefined) return undefined; // 没有 photon 就交给上游

  const { mod } = loaded;
  const image = mod.PhotonImage.new_from_byteslice(bytes);
  const outputs = [];
  const notes = [];
  try {
    for (const slice of plan.slices) {
      const cropped = mod.crop(image, 0, slice.y, dimensions.width, slice.y + slice.height);
      try {
        const encoded = encodeSlice(mod, cropped, mimeType, limits);
        if (encoded === undefined) return undefined; // 编码失败：退回上游，别给半张图
        outputs.push({ type: "image", data: encoded.data, mimeType: encoded.mimeType });
        if (encoded.mimeType !== mimeType) {
          notes.push(`第 ${plan.slices.indexOf(slice) + 1} 片转为 ${encoded.mimeType}`);
        }
      } finally {
        cropped.free();
      }
    }
  } finally {
    image.free();
  }
  return {
    blocks: [...outputs, { type: "text", text: sliceNotice(path, dimensions.width, dimensions.height, plan.slices, SLICE_POLICY) }],
    mimeType,
    width: dimensions.width,
    height: dimensions.height,
    slices: outputs.length,
    notes,
  };
}

/**
 * 长图走自己的管线；返回 undefined 表示「不归我管」，调用方原样交给上游 read。
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
    const plan = planSlices(dimensions.width, dimensions.height);
    if (!plan.needed) return undefined;

    const model = await imageModelOf(api, context);
    if (!model.vision) return undefined; // 纯文本模型：上游会换成占位符，没必要解码
    if (plan.capped) {
      // 太长：不硬塞 12 片以上，退化成整图，但要让模型知道「这是退化结果」。
      const degraded = await fallback();
      return {
        output: degraded.output,
        diagnostics: [
          ...(degraded.diagnostics ?? []),
          { severity: "warning", code: "image_slices", message: sliceCappedNote(dimensions.width, dimensions.height, plan.count) },
        ],
      };
    }

    bytes = getOrThrow(await info.read(0, size, context));
    const prepared = await prepareImageBlocks({ bytes, mimeType, limits: model.limits, path });
    if (prepared === undefined) return undefined; // 没有 photon / 编码失败：交给上游
    return {
      output: prepared.blocks,
      diagnostics: [
        {
          severity: "info",
          code: "image_slices",
          message: `Read image file [${mimeType}] as ${prepared.slices} slices of ${dimensions.width}×${SLICE_POLICY.sliceHeight} (overlap ${SLICE_POLICY.overlap}px).${
            prepared.notes.length > 0 ? ` ${prepared.notes.join("; ")}.` : ""
          }`,
        },
      ],
    };
  } finally {
    await info.close(context);
  }
}

/** 包住 read：长图切片，其它情况原样委托。 */
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

