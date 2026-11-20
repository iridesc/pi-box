// 大图处理：切分计划、文件头尺寸识别，以及 read 包装后的真实行为。
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { createCodingTools } from "@earendil-works/pi-durable/tools";
import { createNodePhotonImages } from "@earendil-works/pi-durable/images/node";
import { initSync, PhotonImage } from "@silvia-odwyer/photon/photon_rs.js";
import {
  aspectRatioOf,
  createImageSliceExtension,
  DEFAULT_IMAGE_LIMITS,
  detectImageMime,
  effectiveEdge,
  fitToEdge,
  imageHeaderSize,
  planTiles,
  prepareImageBlocks,
  SLICE_POLICY,
} from "../src/image-slices.mjs";

const require = createRequire(import.meta.url);
initSync({ module: await readFile(require.resolve("@silvia-odwyer/photon/photon_rs_bg.wasm")) });
/** 生产环境里 read 带图片处理器；这里也带上，行为和线上一致。 */
const photonImages = await createNodePhotonImages({ idleMs: 1 });
const codingTools = createCodingTools({ images: photonImages });
const readTool = codingTools.tools.find((tool) => tool.name === "read");

/** 造一张 width×height、带横向条纹的图（条纹让每块的字节数接近真实截图）。 */
function makeImage(width, height, format = "png") {
  const pixels = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++) {
    const band = y % 40 < 2 ? 30 : 255; // 每 40 行一条深色横线，模拟文字行
    for (let x = 0; x < width; x++) {
      const index = (y * width + x) * 4;
      pixels[index] = band;
      pixels[index + 1] = band === 255 ? 250 : 30;
      pixels[index + 2] = band === 255 ? 245 : 30;
      pixels[index + 3] = 255;
    }
  }
  const image = new PhotonImage(pixels, width, height);
  try {
    return format === "jpeg" ? image.get_bytes_jpeg(85) : image.get_bytes();
  } finally {
    image.free();
  }
}

const LIMITS = { maxWidth: 2000, maxHeight: 2000, maxBytes: 4.5 * 1024 * 1024 };

function apiFor(env, { vision = true } = {}) {
  const model = { input: vision ? ["text", "image"] : ["text"], inputLimits: { images: { resize: LIMITS } } };
  return {
    env,
    output: () => {},
    models: { getModel: () => model },
    agent: async () => ({ model: { provider: "test", modelId: "test" } }),
  };
}

/** 生产环境里的 read 是带图片处理器的（createCodingTools({ images })），包装的就是它。 */
function wrappedRead() {
  const extension = createImageSliceExtension();
  assert.equal(extension.name, "image-slices");
  assert.equal(extension.wraps.length, 1);
  assert.ok(readTool, "coding tools 里应该有 read");
  return extension.wraps[0].wrap(readTool);
}

test("默认参数：边长阈值 1568、重叠 15%、比例门限 1.85", () => {
  assert.equal(SLICE_POLICY.tileEdge, 1568);
  assert.equal(SLICE_POLICY.overlapRatio, 0.15);
  assert.equal(SLICE_POLICY.minAspectRatio, 1.85);
  assert.equal(effectiveEdge(LIMITS, SLICE_POLICY), 1568);
  // 模型上限比阈值更小时听模型的
  assert.equal(effectiveEdge({ maxWidth: 800, maxHeight: 800, maxBytes: 1 }, SLICE_POLICY), 800);
});

test("宽高比：1 = 正方形，越大越细长", () => {
  assert.equal(aspectRatioOf(100, 100), 1);
  assert.equal(aspectRatioOf(1280, 9533), 9533 / 1280);
  // 长短边顺序无关
  assert.equal(aspectRatioOf(9533, 1280), aspectRatioOf(1280, 9533));
});

test("只按宽高比决定切不切：> 1.85 才切", () => {
  // 3916×7008 → 比例 1.79，不切（形状正常，交给缩放）
  const flat = planTiles(3916, 7008, LIMITS, SLICE_POLICY);
  assert.equal(flat.needed, false);
  assert.ok(flat.aspectRatio < 1.85);

  // 1280×9533 → 比例 7.45，切
  const tall = planTiles(1280, 9533, LIMITS, SLICE_POLICY);
  assert.equal(tall.needed, true);
  assert.ok(tall.aspectRatio > 1.85);

  // 正好 1.85 不切（判据是「大于」）
  assert.equal(planTiles(1850, 1000, LIMITS, SLICE_POLICY).needed, false);
  assert.equal(planTiles(1851, 1000, LIMITS, SLICE_POLICY).needed, true);
});

test("切块：正方形、边长 = 阈值、15% 重叠、末行末列贴边", () => {
  const plan = planTiles(1280, 9533, LIMITS, SLICE_POLICY);
  assert.equal(plan.needed, true);
  assert.equal(plan.blockSize, 1568);
  assert.equal(plan.edge, 1568);
  // 宽 1280 < 块边长 → 一列；块宽就是图宽
  assert.equal(plan.cols, 1);
  assert.equal(plan.rows, 7);
  assert.equal(plan.step, Math.round(1568 * 0.85));
  for (const tile of plan.tiles) {
    assert.equal(tile.width, 1280, "块宽 = 图宽（宽不足时不硬凑正方形）");
    assert.ok(tile.height <= plan.blockSize);
  }
  // 覆盖到图片末尾，没有漏掉的边
  const last = plan.tiles.at(-1);
  assert.equal(last.y + last.height, 9533);
});

test("切块：宽图会横切成多列正方形", () => {
  const plan = planTiles(4000, 10000, LIMITS, SLICE_POLICY); // 比例 2.5
  assert.equal(plan.needed, true);
  assert.ok(plan.cols >= 2, `宽 4000 > 块边长 1568，应切成多列，实际 ${plan.cols} 列`);
  assert.ok(plan.tiles.length <= SLICE_POLICY.maxSlices);
  // 首块是完整正方形
  assert.equal(plan.tiles[0].width, 1568);
  assert.equal(plan.tiles[0].height, 1568);
});

test("块数兜底：极长图放大块边长，但不砍边缘", () => {
  const plan = planTiles(1280, 60000, LIMITS, SLICE_POLICY);
  assert.equal(plan.needed, true);
  assert.ok(plan.tiles.length <= SLICE_POLICY.maxSlices, `块数 ${plan.tiles.length} 应不超过上限`);
  assert.ok(plan.blockSize > plan.edge, "块数超限说明块被放大了");
  const last = plan.tiles.at(-1);
  assert.equal(last.y + last.height, 60000, "必须覆盖到图片末尾");
});

test("缩放：等比到长边 = 阈值，只缩不放", () => {
  const shrunk = fitToEdge(3916, 7008, 1568);
  assert.equal(Math.max(shrunk.width, shrunk.height), 1568);
  assert.ok(Math.abs(shrunk.width / shrunk.height - 3916 / 7008) < 0.01, "比例要保持");

  // 已经在阈值内：原样，不放大
  const same = fitToEdge(800, 600, 1568);
  assert.deepEqual(same, { width: 800, height: 600, scale: 1 });
});

test("文件头尺寸识别：PNG / JPEG", () => {
  const png = makeImage(120, 3400);
  assert.equal(detectImageMime(png), "image/png");
  assert.deepEqual(imageHeaderSize(png, "image/png"), { width: 120, height: 3400 });

  const jpeg = makeImage(120, 3400, "jpeg");
  assert.equal(detectImageMime(jpeg), "image/jpeg");
  assert.deepEqual(imageHeaderSize(jpeg, "image/jpeg"), { width: 120, height: 3400 });

  assert.equal(detectImageMime(Buffer.from("not an image")), undefined);
});

test("read 长条图时返回多块，并说明网格、重叠与阅读顺序", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-slices-"));
  await writeFile(join(dir, "tall.png"), makeImage(300, 5200));
  const read = wrappedRead();
  const result = await read.execute({ path: "tall.png" }, apiFor(new NodeExecutionEnv({ cwd: dir })), BACKGROUND_CONTEXT);

  const images = result.output.filter((block) => block.type === "image");
  const text = result.output.filter((block) => block.type === "text").map((block) => block.text).join("\n");
  const plan = planTiles(300, 5200, LIMITS, SLICE_POLICY);
  assert.equal(plan.needed, true);
  assert.equal(images.length, plan.tiles.length);
  assert.ok(images.length >= 3);
  for (const image of images) assert.ok(image.data.length <= LIMITS.maxBytes);
  assert.match(text, /已切成 \d+ 列 × \d+ 行/);
  assert.match(text, /重叠 15%/);
  assert.match(text, /从左到右、从上到下/);
  assert.match(text, /原文件 tall\.png/);
  assert.equal(result.isError, undefined);
  assert.match(result.diagnostics.map((item) => item.message).join(" "), /tiles of/);
});

test("read 形状正常但很大的图：不切，缩放到长边 = 阈值", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-slices-"));
  await writeFile(join(dir, "wide.png"), makeImage(2400, 1600)); // 比例 1.5，不切
  const read = wrappedRead();
  const result = await read.execute({ path: "wide.png" }, apiFor(new NodeExecutionEnv({ cwd: dir })), BACKGROUND_CONTEXT);

  const images = result.output.filter((block) => block.type === "image");
  assert.equal(images.length, 1, "不切的图只有一张");
  assert.doesNotMatch(JSON.stringify(result.output.filter((b) => b.type === "text")), /已切成/);
  const meta = await prepareImageBlocks({
    bytes: makeImage(2400, 1600),
    mimeType: "image/png",
    limits: LIMITS,
    path: "wide.png",
  });
  assert.equal(Math.max(meta.width, meta.height), 1568);
  assert.match(result.diagnostics.map((item) => item.message).join(" "), /single image scaled to/);
});

test("普通图片与非图片文件原样交给上游 read（不处理）", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-slices-"));
  await writeFile(join(dir, "small.png"), makeImage(200, 200));
  await writeFile(join(dir, "note.txt"), "hello\nworld\n");
  const read = wrappedRead();
  const api = apiFor(new NodeExecutionEnv({ cwd: dir }));

  const small = await read.execute({ path: "small.png" }, api, BACKGROUND_CONTEXT);
  const smallImages = small.output.filter((block) => block.type === "image");
  assert.equal(smallImages.length, 1);
  assert.match(small.diagnostics.map((item) => item.message).join(" "), /Read image file/);

  const textResult = await read.execute({ path: "note.txt" }, api, BACKGROUND_CONTEXT);
  const textBody = Array.isArray(textResult.output)
    ? textResult.output.map((block) => block.text ?? "").join("\n")
    : String(textResult.output);
  assert.match(textBody, /hello/);
});

test("纯文本模型不做切片（上游会换成占位符）", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-slices-"));
  await writeFile(join(dir, "tall.png"), makeImage(300, 5200));
  const read = wrappedRead();
  const result = await read.execute({ path: "tall.png" }, apiFor(new NodeExecutionEnv({ cwd: dir }), { vision: false }), BACKGROUND_CONTEXT);
  const images = result.output.filter((block) => block.type === "image");
  assert.equal(images.length, 1); // 上游行为：一张图 + 「模型不支持图片」提示
  assert.match(result.diagnostics.map((item) => item.message).join(" "), /does not support images/);
});

// 用户消息里的图不会被 read 的 inputLimits 自动缩放，所以 prepareImageBlocks 必须
// 自己处理超尺寸/超体积的图。漏掉这一条，一张 4000×3000 的手机照片就会整个塞进去。
test("prepareImageBlocks：超阈值的普通图会被缩放，长边 = 阈值", async () => {
  const flat = makeImage(2400, 1600); // 宽高比 1.5 ≤ 1.85：不切，只缩放
  const prepared = await prepareImageBlocks({ bytes: flat, mimeType: "image/png", limits: LIMITS, path: "shot.png" });
  assert.ok(prepared, "超阈值时应该返回处理结果");
  assert.equal(prepared.blocks.length, 1);
  assert.equal(prepared.blocks[0].type, "image");
  assert.equal(Math.max(prepared.width, prepared.height), 1568);
  assert.equal(prepared.slices, 1);
  // 比例保持不变
  assert.ok(Math.abs(prepared.width / prepared.height - 2400 / 1600) < 0.02);
});

test("prepareImageBlocks：已经在阈值内的图原样交给调用方（返回 undefined）", async () => {
  const bytes = makeImage(300, 200);
  assert.equal(await prepareImageBlocks({ bytes, mimeType: "image/png", limits: LIMITS, path: "small.png" }), undefined);
});

test("prepareImageBlocks：尺寸够小但字节超限也要压", async () => {
  // 800×800 的条纹图 PNG 超过 8KB，把字节上限压到 8KB 就走 maxBytes 分支。
  const limits = { maxWidth: 2000, maxHeight: 2000, maxBytes: 8 * 1024 };
  const bytes = makeImage(800, 800);
  assert.ok(bytes.byteLength > limits.maxBytes, "前提：原图必须确实超过上限");
  const prepared = await prepareImageBlocks({ bytes, mimeType: "image/png", limits, path: "noisy.png" });
  assert.ok(prepared, "字节超限时应该压缩");
  const total = prepared.blocks.reduce((sum, block) => sum + (block.data?.length ?? 0), 0);
  assert.ok(total <= limits.maxBytes, `base64 总长 ${total} 应不超过 ${limits.maxBytes}`);
});

test("DEFAULT_IMAGE_LIMITS 与 read 工具的默认上限一致", () => {
  assert.deepEqual(DEFAULT_IMAGE_LIMITS, { maxWidth: 2000, maxHeight: 2000, maxBytes: 4.5 * 1024 * 1024 });
});
