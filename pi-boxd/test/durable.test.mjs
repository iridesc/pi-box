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
const {
  resolveAgentTools,
  setMcpToolsByServer,
  parseAgentDef,
  serializeAgentDef,
  saveAgentFile,
  saveAssistantFile,
  listAgents,
  listAgentCatalog,
  loadEnabledAgentDef,
} = await import("../src/agents.mjs");
const { PiBoxTasks } = await import("../src/extension.mjs");
const { createHarness } = await import("../src/harness.mjs");
const { createDurableMcpTools, validatePublicMcpConfig } = await import("../src/mcp-bridge.mjs");

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

test("selected MCP servers add their durable tools and official support tools", () => {
  const direct = { name: "mcp__demo__read", parameters: {}, execute: async () => ({}) };
  const codemodeOnly = { name: "mcp__demo__search", parameters: {}, callers: ["tools"], execute: async () => ({}) };
  const codemode = { name: "codemode", parameters: {}, execute: async () => ({}) };
  const toolSearch = { name: "tool_search", parameters: {}, execute: async () => ({}) };
  setMcpToolsByServer(new Map([["demo", [direct, codemodeOnly]]]), [codemode, toolSearch]);
  assert.deepEqual(
    resolveAgentTools(["read"], ["demo"]).map((tool) => tool.name),
    ["read", "mcp__demo__read", "mcp__demo__search", "codemode"],
  );
  assert.throws(() => resolveAgentTools(["read"], ["missing"]), /MCP 未连接/);
  setMcpToolsByServer(new Map(), []);
});

test("official MCP definitions become namespaced durable tools with exposure", async () => {
  const calls = [];
  const client = {
    async callTool(name, args) {
      calls.push({ name, args });
      return { content: [{ type: "text", text: "ok" }], structuredContent: { ok: true } };
    },
  };
  const config = validatePublicMcpConfig("product-db", {
    url: "https://example.test/mcp",
    exposure: "codemode",
    toolExposure: { lookup: "direct", "delete_*": "hidden" },
  });
  const tools = createDurableMcpTools("product-db", config, client, [
    { name: "lookup", description: "Lookup", inputSchema: { type: "object", properties: {} } },
    { name: "search", description: "Search", inputSchema: { type: "object", properties: {} } },
    { name: "delete_item", description: "Delete", inputSchema: { type: "object", properties: {} } },
  ]);
  assert.deepEqual(tools.map((tool) => tool.name), ["mcp__product_db__lookup", "mcp__product_db__search"]);
  assert.equal(tools[0].callers, undefined);
  assert.deepEqual(tools[1].callers, ["tools"]);
  const result = await tools[0].execute({}, { output() {} });
  assert.deepEqual(result.output, [{ type: "text", text: "ok" }]);
  assert.deepEqual(calls, [{ name: "lookup", args: {} }]);
});

test("an explicitly empty agent tool selection survives serialization", () => {
  const markdown = serializeAgentDef({ model: null, tools: [], mcps: [], instructions: "Do the work." });
  assert.deepEqual(parseAgentDef(markdown).tools, []);
  assert.deepEqual(parseAgentDef(markdown).mcps, []);
});

test("project agents are always enabled while global agents require assistant selection", async () => {
  const project = "catalog-test";
  await mkdir(join(process.env.PI_BOX_WORKSPACE, project), { recursive: true });
  await saveAgentFile(project, "项目助手", "project", { tools: ["read"], instructions: "project" });
  await saveAgentFile(null, "全局助手", "global", { tools: ["read"], instructions: "global" });
  await saveAssistantFile(project, { agents: [], instructions: "main" });

  const catalog = await listAgentCatalog(project);
  assert.deepEqual(catalog.project.map((agent) => agent.name), ["项目助手"]);
  assert.deepEqual(catalog.global.map((agent) => agent.name), ["全局助手"]);
  assert.deepEqual((await listAgents(project)).map((agent) => agent.name), ["项目助手"]);
  assert.equal(await loadEnabledAgentDef(project, "全局助手"), null);

  await saveAssistantFile(project, { agents: ["全局助手"], instructions: "main" });
  assert.deepEqual((await listAgents(project)).map((agent) => agent.name), ["全局助手", "项目助手"]);
  assert.equal((await loadEnabledAgentDef(project, "全局助手")).scope, "global");
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
