// 集成测试：装了 photon 处理器的 read 工具，读大图时会按模型尺寸上限缩放（而不是原样塞进上下文）。
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createCodingTools } from "@earendil-works/pi-durable/tools";
import { createNodePhotonImages } from "@earendil-works/pi-durable/images/node";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { initSync, PhotonImage } from "@silvia-odwyer/photon/photon_rs.js";

const require = createRequire(import.meta.url);
initSync({ module: await readFile(require.resolve("@silvia-odwyer/photon/photon_rs_bg.wasm")) });

/** 造一张 width×height 的 PNG（噪声内容，避免编码后过小看不出缩放）。 */
function makePng(width, height) {
  const pixels = new Uint8Array(width * height * 4);
  for (let index = 0; index < pixels.length; index += 4) {
    const value = (index * 2654435761) % 255;
    pixels[index] = value;
    pixels[index + 1] = 255 - value;
    pixels[index + 2] = (value * 7) % 255;
    pixels[index + 3] = 255;
  }
  const image = new PhotonImage(pixels, width, height);
  try {
    return image.get_bytes();
  } finally {
    image.free();
  }
}

const LIMITS = { maxWidth: 1024, maxHeight: 1024, maxBytes: 1024 * 1024 };

function apiFor(env, { vision = true } = {}) {
  const model = {
    input: vision ? ["text", "image"] : ["text"],
    inputLimits: { images: { resize: LIMITS } },
  };
  return {
    env,
    output: () => {},
    models: { getModel: () => model },
    agent: async () => ({ model: { provider: "test", modelId: "test" } }),
  };
}

test("read 读大图时按模型上限缩小，并给出坐标换算提示", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-read-image-"));
  await writeFile(join(dir, "big.png"), makePng(2400, 1600));
  const tools = createCodingTools({ images: await createNodePhotonImages({ idleMs: 1 }) });
  const read = tools.tools.find((tool) => tool.name === "read");
  assert.ok(read, "read 工具应该存在");

  const result = await read.execute({ path: "big.png" }, apiFor(new NodeExecutionEnv({ cwd: dir })), BACKGROUND_CONTEXT);
  const image = result.output.find((block) => block.type === "image");
  assert.ok(image, "应该返回图片块");
  const text = result.diagnostics.map((entry) => entry.message).join(" ");
  assert.match(text, /Resized from 2400x1600 to 1024x683/);
  // 缩放后 base64 必须明显小于原图（原图 2400x1600 的 PNG 是几 MB）。
  assert.ok(image.data.length < 1024 * 1024, `base64 应该小于 1MB，实际 ${image.data.length}`);
});

test("图片预算扩展挂在生成任务的 beforeRequest 上，并且真的裁剪历史图", async () => {
  const { createImageBudgetExtension } = await import("../src/image-budget.mjs");
  const extension = createImageBudgetExtension({ triggerBytes: 4 * 1024 * 1024, targetBytes: 4 * 1024 * 1024 });
  assert.equal(extension.name, "image-budget");
  assert.equal(extension.hooks.length, 1);
  assert.equal(extension.hooks[0].task, "pi.generation");
  assert.equal(typeof extension.hooks[0].handlers.beforeRequest, "function");

  const message = (id, mib) => ({
    role: "toolResult",
    toolCallId: id,
    toolName: "read",
    content: [{ type: "image", data: "a".repeat(mib * 1024 * 1024), mimeType: "image/png" }],
  });
  const messages = [message("c1", 3), message("c2", 3)];
  const replaced = extension.hooks[0].handlers.beforeRequest({ messages });
  assert.ok(replaced, "超过 trigger 时应该返回替换后的消息");
  assert.equal(replaced.messages[0].content[0].type, "text");
  assert.equal(replaced.messages[1].content[0].type, "image");
});
