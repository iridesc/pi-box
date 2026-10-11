import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

const root = await mkdtemp(join(tmpdir(), "pi-boxd-test-"));
process.env.PI_BOX_WORKSPACE = join(root, "workspace");
process.env.PI_BOXD_DATA_DIR = join(root, "data");
await mkdir(process.env.PI_BOX_WORKSPACE, { recursive: true });

const { initProvider } = await import("../src/model.mjs");
const { loadConfig, saveConfig } = await import("../src/io.mjs");
const { resolveAgentTools, parseAgentDef, serializeAgentDef } = await import("../src/agents.mjs");
const { PiBoxTasks } = await import("../src/extension.mjs");
const { createHarness } = await import("../src/harness.mjs");

test.after(async () => {
  await rm(root, { recursive: true, force: true });
});

test("custom durable tasks are registered by stable kind", () => {
  assert.deepEqual(
    PiBoxTasks.map((task) => task.definition.name),
    ["pibox.anchor", "pibox.reporter"],
  );
});

test("agent tool names resolve to registered tool definitions", () => {
  assert.deepEqual(resolveAgentTools(["read", "bash"]).map((tool) => tool.name), ["read", "bash"]);
  assert.equal(resolveAgentTools(null), undefined);
  assert.throws(() => resolveAgentTools(["missing"]), /未知工具/);
});

test("an explicitly empty agent tool selection survives serialization", () => {
  const markdown = serializeAgentDef({ model: null, tools: [], instructions: "Do the work." });
  assert.deepEqual(parseAgentDef(markdown).tools, []);
});

test("legacy model config migrates and multiple providers persist without exposing a shared slot", async () => {
  await mkdir(process.env.PI_BOXD_DATA_DIR, { recursive: true });
  await writeFile(join(process.env.PI_BOXD_DATA_DIR, "config.json"), JSON.stringify({
    provider: "minimax-cn", modelId: "MiniMax-M2.7", apiKey: "legacy-key", baseUrl: "https://example.test",
  }));
  const migrated = await loadConfig();
  assert.equal(migrated.activeProvider, "minimax-cn");
  assert.equal(migrated.providers["minimax-cn"].apiKey, "legacy-key");

  await saveConfig({
    version: 2,
    activeProvider: "openai",
    providers: {
      "minimax-cn": migrated.providers["minimax-cn"],
      openai: { modelId: "gpt-4o", apiKey: "openai-key", baseUrl: "https://api.openai.com/v1" },
    },
  });
  const persisted = await loadConfig();
  assert.deepEqual(Object.keys(persisted.providers).sort(), ["minimax-cn", "openai"]);
  assert.equal((await stat(join(process.env.PI_BOXD_DATA_DIR, "config.json"))).mode & 0o777, 0o600);

  // 后续 harness 测试保持离线，避免测试套件发真实请求。
  await saveConfig({ version: 2, activeProvider: "openai", providers: {} });
});

test("harness installs custom tasks and can start its recovery scheduler", async () => {
  await initProvider();
  const { harness, context, PiBoxExtension } = await createHarness();
  assert.deepEqual(
    PiBoxExtension.tasks.map((task) => task.definition.name),
    ["pibox.anchor", "pibox.reporter"],
  );
  harness.resume();
  await harness.close(context);
});
