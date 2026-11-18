// 大图切片：切分计划、文件头尺寸识别，以及 read 包装后的真实行为。
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
  createImageSliceExtension,
  DEFAULT_IMAGE_LIMITS,
  detectImageMime,
  imageHeaderSize,
  planTiles,
  prepareImageBlocks,
  SLICE_POLICY,
  targetEdgeOf,
  tileOutputSize,
} from "../src/image-slices.mjs";

const require = createRequire(import.meta.url);
initSync({ module: await readFile(require.resolve("@silvia-odwyer/photon/photon_rs_bg.wasm")) });
/** 生产环境里 read 带图片处理器；这里也带上，行为和线上一致。 */
const photonImages = await createNodePhotonImages({ idleMs: 1 });
const codingTools = createCodingTools({ images: photonImages });
const readTool = codingTools.tools.find((tool) => tool.name === "read");

/** 造一张 width×height、带横向条纹的图（条纹让每片的字节数接近真实截图）。 */
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

test("目标边长：像素阈值的平方根，并受模型上限约束", () => {
  assert.equal(targetEdgeOf(LIMITS, SLICE_POLICY), Math.round(Math.sqrt(SLICE_POLICY.targetPixels)));
  // 模型上限更小时听模型的
  assert.equal(targetEdgeOf({ maxWidth: 800, maxHeight: 800, maxBytes: 1 }, SLICE_POLICY), 800);
});

test("切分计划：宽大图要横竖都切，且每块不缩放", () => {
  const plan = planTiles(3916, 7008, LIMITS, SLICE_POLICY);
  assert.equal(plan.needed, true);
  assert.equal(plan.cols, 3);
  assert.equal(plan.rows, 6);
  assert.equal(plan.tiles.length, plan.cols * plan.rows);
  // 块边长 = 目标边长 → 不缩放，无损
  assert.equal(plan.blockSize, targetEdgeOf(LIMITS, SLICE_POLICY));
  // 相邻块起点步长 = 块边长 × (1 − 重叠率)
  assert.equal(plan.step, Math.round(plan.blockSize * (1 - SLICE_POLICY.overlapRatio)));
  // 每块都不超过目标边长
  for (const tile of plan.tiles) {
    assert.ok(Math.max(tile.width, tile.height) <= plan.blockSize + 1);
  }
  // 覆盖整张图，没有漏掉的边
  const last = plan.tiles.at(-1);
  assert.equal(last.x + last.width, 3916);
  assert.equal(last.y + last.height, 7008);
});

test("切分计划：真长图只竖切，块数不增反减", () => {
  const plan = planTiles(1280, 9533, LIMITS, SLICE_POLICY);
  assert.equal(plan.needed, true);
  assert.equal(plan.cols, 1, "宽 1280 < 块边长，不该横切");
  assert.ok(plan.rows >= 5 && plan.rows <= 8);
  assert.ok(plan.tiles.length <= SLICE_POLICY.maxSlices);
});

test("切分计划：普通图不切", () => {
  assert.equal(planTiles(800, 400, LIMITS, SLICE_POLICY).needed, false);
  assert.equal(planTiles(1280, 2000, LIMITS, SLICE_POLICY).needed, false); // 比例 1.56、长边 2000
});

test("切分计划：块数超上限就放大块，不砍内容", () => {
  const plan = planTiles(8000, 8000, LIMITS, SLICE_POLICY);
  assert.equal(plan.needed, true);
  assert.ok(plan.tiles.length <= SLICE_POLICY.maxSlices, `块数 ${plan.tiles.length} 应不超过上限`);
  assert.ok(plan.blockSize > targetEdgeOf(LIMITS, SLICE_POLICY), "块数超限说明块被放大了");
  // 放大块 = 拿分辨率换块数：输出尺寸仍然不超过目标边长
  const size = tileOutputSize(plan.tiles[0], LIMITS, SLICE_POLICY);
  assert.ok(Math.max(size.width, size.height) <= targetEdgeOf(LIMITS, SLICE_POLICY));
  assert.ok(size.scale < 1);
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

test("read 大图时返回多块，并说明网格、重叠与阅读顺序", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-slices-"));
  await writeFile(join(dir, "tall.png"), makeImage(300, 5200));
  const read = wrappedRead();
  const result = await read.execute({ path: "tall.png" }, apiFor(new NodeExecutionEnv({ cwd: dir })), BACKGROUND_CONTEXT);

  const images = result.output.filter((block) => block.type === "image");
  const text = result.output.filter((block) => block.type === "text").map((block) => block.text).join("\n");
  const plan = planTiles(300, 5200, LIMITS, SLICE_POLICY);
  assert.equal(images.length, plan.tiles.length);
  assert.ok(images.length >= 3);
  for (const image of images) assert.ok(image.data.length <= LIMITS.maxBytes);
  assert.match(text, /已切成 \d+ 列 × \d+ 行/);
  assert.match(text, /重叠 15%/);
  assert.match(text, /从左到右、从上到下/);
  assert.match(text, /原文件 tall\.png/);
  assert.equal(result.isError, undefined);
  assert.match(result.diagnostics.map((item) => item.message).join(" "), /as \d+x\d+=\d+ tiles/);
});

test("普通图片与非图片文件原样交给上游 read（不切片）", async () => {
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
// 自己处理「不切片但超尺寸/超体积」的普通图。漏掉这一条，一张 4000×3000 的手机照片
// 就会原样进上下文。
test("prepareImageBlocks：超尺寸的普通图会被缩放，不切片", async () => {
  const limits = { maxWidth: 800, maxHeight: 800, maxBytes: 4 * 1024 * 1024 };
  const bytes = makeImage(2400, 1200); // 宽高比 2，不触发切片
  const prepared = await prepareImageBlocks({ bytes, mimeType: "image/png", limits, path: "shot.png" });
  assert.ok(prepared, "超尺寸时应该返回处理结果");
  assert.equal(prepared.capped, undefined, "普通图不该走 capped 分支");
  assert.equal(prepared.blocks.length, 1);
  assert.equal(prepared.blocks[0].type, "image");
  assert.ok(prepared.width <= limits.maxWidth, `宽应缩到 ${limits.maxWidth} 以内，实际 ${prepared.width}`);
  assert.ok(prepared.height <= limits.maxHeight, `高应缩到 ${limits.maxHeight} 以内，实际 ${prepared.height}`);
  assert.equal(prepared.slices, 1);
  // 比例保持不变
  assert.ok(Math.abs(prepared.width / prepared.height - 2) < 0.05);
});

test("prepareImageBlocks：已经在限内的普通图原样交给调用方（返回 undefined）", async () => {
  const limits = { maxWidth: 800, maxHeight: 800, maxBytes: 4 * 1024 * 1024 };
  const bytes = makeImage(300, 200);
  assert.equal(await prepareImageBlocks({ bytes, mimeType: "image/png", limits, path: "small.png" }), undefined);
});

test("prepareImageBlocks：尺寸够小但字节超限也要压", async () => {
  // 800×800 的条纹图 PNG 是 14.8KB，把上限压到 8KB 就走 maxBytes 分支而不是尺寸分支。
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
