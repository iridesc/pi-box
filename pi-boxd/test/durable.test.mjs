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
  renameAgentFile,
  saveAssistantFile,
  loadAssistant,
  listAgents,
  listAgentCatalog,
  loadEnabledAgentDef,
} = await import("../src/agents.mjs");
const { makeSubagentTool, PiBoxTasks } = await import("../src/extension.mjs");
const { createHarness, syncSubagentInstances } = await import("../src/harness.mjs");
const { createDurableMcpTools, validatePublicMcpConfig } = await import("../src/mcp-bridge.mjs");
const { compileScheduleRule, deleteSchedule, listSchedules, nextScheduleRun, scheduleDescription, triggerSchedule, upsertSchedule, validateScheduleInput } = await import("../src/schedules.mjs");
const { verifyBasicAuthorization } = await import("../src/auth.mjs");

test.after(async () => {
  await rm(root, { recursive: true, force: true });
});

test("custom durable tasks are registered by stable kind", () => {
  assert.deepEqual(
    PiBoxTasks.map((task) => task.definition.name),
    ["pibox.anchor", "pibox.reporter"],
  );
});

test("HTTP Basic Auth only accepts the new explicit credentials", () => {
  const credentials = { username: "pi", password: "new-secret" };
  const valid = `Basic ${Buffer.from("pi:new-secret").toString("base64")}`;
  const invalid = `Basic ${Buffer.from("pi:old-secret").toString("base64")}`;
  assert.equal(verifyBasicAuthorization(valid, credentials), true);
  assert.equal(verifyBasicAuthorization(invalid, credentials), false);
  assert.equal(verifyBasicAuthorization(undefined, credentials), false);
  assert.equal(verifyBasicAuthorization(undefined, { username: "pi", password: "" }), true);
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

test("agent definitions can be renamed and global assistant references follow", async () => {
  const project = "agent-rename-test";
  await mkdir(join(process.env.PI_BOX_WORKSPACE, project), { recursive: true });
  await saveAgentFile(project, "旧项目Agent", "project", { tools: ["read"], instructions: "project rename" });
  await renameAgentFile(project, "旧项目Agent", "新项目Agent", "project");
  assert.deepEqual((await listAgents(project)).map((agent) => agent.name), ["新项目Agent"]);

  await saveAgentFile(null, "旧全局Agent", "global", { tools: ["read"], instructions: "global rename" });
  await saveAssistantFile(project, { agents: ["旧全局Agent"], instructions: "main" });
  await renameAgentFile(null, "旧全局Agent", "新全局Agent", "global");
  assert.deepEqual((await loadAssistant(project)).agents, ["新全局Agent"]);
  assert.ok((await listAgents(project)).some((agent) => agent.name === "新全局Agent"));
});

test("spawn reuses a renamed persistent subagent and returns visible durable output", async () => {
  const project = "renamed-dispatch-test";
  const name = "生产计划制定助理";
  await mkdir(join(process.env.PI_BOX_WORKSPACE, project), { recursive: true });
  await saveAgentFile(project, name, "project", { tools: ["read"], instructions: "制定生产计划" });
  const state = { agents: { [name]: { conversationId: 58, reported: [] } }, reporters: {} };
  const created = [];
  const api = {
    conversationId: 44,
    env: { cwd: join(process.env.PI_BOX_WORKSPACE, project) },
    snapshot: async () => state,
    commit: async (change) => change({
      doc: async () => state,
      createTask: async (definition, input) => {
        created.push({ definition: definition.definition?.name, input });
        return 901;
      },
      createConversation: async () => { throw new Error("已有 Agent 不应重新创建会话"); },
    }),
  };
  const tool = makeSubagentTool(() => ({}));
  const result = await tool.execute({ action: "spawn", name, message: "执行今天的生产计划" }, api, {});
  assert.deepEqual(result.output, [{ type: "text", text: `已复用 ${name} 的会话并发送任务` }]);
  assert.deepEqual(result.details, { name, conversationId: 58 });
  assert.deepEqual(created, [{
    definition: "pibox.reporter",
    input: { name, conversationId: 58, message: "执行今天的生产计划", followUp: true },
  }]);
  assert.equal(state.reporters["901"], 901);
});

test("saving a subagent can reset active context without deleting its persistent conversation", async () => {
  const project = "agent-context-reset-test";
  const name = "新版提示词Agent";
  const cwd = join(process.env.PI_BOX_WORKSPACE, project);
  await mkdir(cwd, { recursive: true });
  await saveAgentFile(project, name, "project", { tools: ["read"], instructions: "只遵循新版提示词" });
  let commitCount = 0;
  let snapshotCount = 0;
  const resets = [];
  const harness = {
    commit: async () => {
      commitCount += 1;
      return commitCount === 1 ? { items: [{ id: 44, owner: null }] } : undefined;
    },
    snapshot: async () => {
      snapshotCount += 1;
      return snapshotCount === 1 ? { cwd } : { agents: { [name]: { conversationId: 58, reported: [] } } };
    },
    conversation: async (id) => ({ reset: async (handoff) => resets.push({ id, handoff }) }),
  };
  await syncSubagentInstances(harness, project, name, { resetContext: true });
  assert.equal(commitCount, 2, "先扫描主会话，再持久化新 Agent 配置");
  assert.deepEqual(resets, [{ id: 58, handoff: undefined }]);

  commitCount = 0;
  snapshotCount = 0;
  resets.length = 0;
  await syncSubagentInstances(harness, project, name);
  assert.deepEqual(resets, [], "启动对账只同步配置，不应重复重置上下文");
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

test("project schedules validate cron and persist under the project", async () => {
  const project = "schedule-test";
  await mkdir(join(process.env.PI_BOX_WORKSPACE, project), { recursive: true });
  assert.throws(() => validateScheduleInput({ name: "bad", prompt: "run", cron: "not cron", timezone: "Asia/Shanghai" }), /Cron/);
  const created = await upsertSchedule(project, {
    name: "每日巡检", prompt: "检查项目并汇报。", cron: "0 9 * * *", timezone: "Asia/Shanghai", enabled: true,
  });
  assert.ok(created.id);
  assert.ok(created.nextRunAt);
  assert.equal((await listSchedules(project)).schedules[0].name, "每日巡检");
  await deleteSchedule(project, created.id);
  assert.equal((await listSchedules(project)).schedules.length, 0);
});

test("human schedule rules compile, describe and preserve legacy schedules", async () => {
  assert.deepEqual(compileScheduleRule({ type: "daily", time: "09:30" }), {
    rule: { type: "daily", time: "09:30" }, cron: "30 9 * * *",
  });
  assert.deepEqual(compileScheduleRule({ type: "weekly", weekdays: [5, 1, 3], time: "08:00" }), {
    rule: { type: "weekly", weekdays: [1, 3, 5], time: "08:00" }, cron: "0 8 * * 1,3,5",
  });
  assert.throws(() => compileScheduleRule({ type: "interval", every: 1, unit: "minute" }), /5 到 59/);
  const interval = { enabled: true, createdAt: "2026-01-01T00:00:00.000Z", rule: { type: "interval", every: 3, unit: "day" } };
  assert.equal(nextScheduleRun(interval, new Date("2026-01-31T12:00:00.000Z")), "2026-02-03T00:00:00.000Z");
  assert.equal(scheduleDescription({ rule: { type: "monthly", day: 8, time: "10:15" } }), "每月 8 日 10:15");

  const project = "human-schedule-test";
  await mkdir(join(process.env.PI_BOX_WORKSPACE, project), { recursive: true });
  const created = await upsertSchedule(project, {
    name: "每周巡检", prompt: "巡检", rule: { type: "weekly", weekdays: [1, 3, 5], time: "09:00" },
    timezone: "Asia/Shanghai", enabled: true,
  });
  assert.equal(created.cron, "0 9 * * 1,3,5");
  const listed = (await listSchedules(project)).schedules[0];
  assert.equal(listed.description, "每周一、周三、周五 09:00");
  assert.deepEqual(listed.rule.weekdays, [1, 3, 5]);
});

test("one-time schedules use the selected timezone and disable after submission", async () => {
  const project = "once-schedule-test";
  await mkdir(join(process.env.PI_BOX_WORKSPACE, project), { recursive: true });
  const future = new Date(Date.now() + 86_400_000);
  const localDateTime = `${future.getUTCFullYear() + 1}-01-15T09:00`;
  const schedule = await upsertSchedule(project, {
    name: "单次任务", prompt: "执行一次", rule: { type: "once", localDateTime }, timezone: "Asia/Shanghai", enabled: true,
  });
  assert.match(schedule.rule.runAt, /T01:00:00\.000Z$/);
  const harness = {
    commit: async (read) => read({ scanConversations: async () => ({ items: [{ id: 84, owner: null }] }) }),
    snapshot: async () => ({ cwd: join(process.env.PI_BOX_WORKSPACE, project) }),
    conversation: async () => ({ submit: async () => ({ id: 8, wait: async () => ({ status: "done" }) }) }),
  };
  await triggerSchedule(harness, {}, project, schedule, { scheduledAt: schedule.rule.runAt });
  assert.equal((await listSchedules(project)).schedules[0].enabled, false);
});

test("a schedule occurrence is submitted to the project assistant as a durable app entry", async () => {
  const project = "schedule-submit-test";
  await mkdir(join(process.env.PI_BOX_WORKSPACE, project), { recursive: true });
  const schedule = await upsertSchedule(project, {
    name: "巡检", prompt: "检查项目。", cron: "0 9 * * *", timezone: "Asia/Shanghai", enabled: true,
  });
  let request;
  const harness = {
    commit: async (read) => read({ scanConversations: async () => ({ items: [{ id: 42, owner: null }] }) }),
    snapshot: async () => ({ cwd: join(process.env.PI_BOX_WORKSPACE, project) }),
    conversation: async () => ({
      submit: async (value) => {
        request = value;
        return { id: 7, wait: async () => ({ status: "done" }) };
      },
    }),
  };
  await triggerSchedule(harness, {}, project, schedule, { scheduledAt: "2026-10-15T01:00:00.000Z" });
  assert.equal(request.content, "检查项目。");
  assert.equal(request.whenBusy, "followUp");
  assert.equal(request.entry.kind, "pibox.schedule");
  assert.match(request.requestId, /^pibox-schedule:schedule-submit-test:/);
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
