// 长图切片：切分计划、文件头尺寸识别，以及 read 包装后的真实行为。
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
import { createImageSliceExtension, detectImageMime, imageHeaderSize, planSlices, SLICE_POLICY } from "../src/image-slices.mjs";

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


test("切分计划：1280×9533 切成 7 片，相邻重叠 120px", () => {
  const plan = planSlices(1280, 9533);
  assert.equal(plan.needed, true);
  assert.equal(plan.slices.length, 7);
  assert.deepEqual(plan.slices[0], { y: 0, height: 1600 });
  assert.deepEqual(plan.slices[1], { y: 1600 - SLICE_POLICY.overlap, height: 1600 });
  // 最后一片贴底，保证覆盖到图片末尾
  const last = plan.slices.at(-1);
  assert.equal(last.y + last.height, 9533);
});

test("切分计划：正常图片不切，超长图片标记 capped", () => {
  assert.equal(planSlices(800, 400).needed, false);
  assert.equal(planSlices(1280, 2000).needed, false); // 比例 1.56、长边 2000
  const capped = planSlices(1280, 20000);
  assert.equal(capped.needed, true);
  assert.equal(capped.capped, true);
  assert.equal(capped.slices.length, 0);
  assert.ok(capped.count > SLICE_POLICY.maxSlices);
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

test("read 长图时返回多片，并说明重叠与纵向范围", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-slices-"));
  await writeFile(join(dir, "tall.png"), makeImage(300, 5200));
  const read = wrappedRead();
  const result = await read.execute({ path: "tall.png" }, apiFor(new NodeExecutionEnv({ cwd: dir })), BACKGROUND_CONTEXT);

  const images = result.output.filter((block) => block.type === "image");
  const text = result.output.filter((block) => block.type === "text").map((block) => block.text).join("\n");
  const plan = planSlices(300, 5200);
  assert.equal(images.length, plan.slices.length);
  assert.ok(images.length >= 3);
  // 每片都按模型上限以内
  for (const image of images) assert.ok(image.data.length <= LIMITS.maxBytes);
  assert.match(text, /切成 \d+ 片/);
  assert.match(text, /相邻重叠 120px/);
  assert.match(text, /原文件 tall\.png/);
  assert.equal(result.isError, undefined);
  assert.match(result.diagnostics.map((item) => item.message).join(" "), /as \d+ slices/);
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
