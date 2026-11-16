// 工具装配单测：显式模型（没有就是没有）、MCP 收窄、fail fast 校验、前端目录。
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

const root = await mkdtemp(join(tmpdir(), "pibox-tools-"));
process.env.PI_BOX_WORKSPACE = join(root, "workspace");
process.env.PI_BOX_PROJECTS_DIR = join(root, "workspace");
process.env.PI_BOX_META_DIR = join(root, "meta");
process.env.PI_BOXD_DATA_DIR = join(root, "data");
await mkdir(join(root, "workspace", "demo", ".pi", "agents"), { recursive: true });
await mkdir(join(root, "meta"), { recursive: true });

const {
  resolveAgentTools,
  resolveAssistantTools,
  validateAgentConfig,
  setToolCatalog,
  setMcpToolsByServer,
  setAssistantRequiredTools,
  toolCatalog,
  mcpCatalog,
  parseAgentDef,
  serializeAgentDef,
  loadAssistant,
} = await import("../src/agents.mjs");

test.after(async () => {
  await rm(root, { recursive: true, force: true });
});

// ── 造一份假 registry：内置 4 个 + 报告 4 个 + subagent + codemode/tool_search ──
const tool = (name, extra = {}) => ({ name, ...extra });

setToolCatalog([
  { extension: { name: "coding" }, tool: tool("read") },
  { extension: { name: "coding" }, tool: tool("write") },
  { extension: { name: "coding" }, tool: tool("edit") },
  { extension: { name: "coding" }, tool: tool("bash") },
  { extension: { name: "pi-box" }, tool: tool("subagent") },
  { extension: { name: "pi-box-reports" }, tool: tool("report_publish") },
  { extension: { name: "pi-box-reports" }, tool: tool("report_list") },
  { extension: { name: "pi-box-reports" }, tool: tool("report_read") },
  { extension: { name: "pi-box-reports" }, tool: tool("report_delete") },
  { extension: { name: "codemode" }, tool: tool("codemode") },
  { extension: { name: "tool-search" }, tool: tool("tool_search") },
]);

setAssistantRequiredTools([tool("subagent")]);

const names = (tools) => tools.map((t) => t.name).sort();

test("tools 缺失 → 零工具（不再继承全部）", () => {
  assert.deepEqual(resolveAgentTools(null), []);
  assert.deepEqual(resolveAgentTools(undefined), []);
  assert.deepEqual(resolveAgentTools([]), []);
});

test("tools 显式列表 → 精确匹配", () => {
  assert.deepEqual(names(resolveAgentTools(["read", "bash"])), ["bash", "read"]);
});

test("tools 里的扩展工具（report_*）可被选中", () => {
  assert.deepEqual(names(resolveAgentTools(["report_publish"])), ["report_publish"]);
});

test("tools 写未知名 → 直接报错", () => {
  assert.throws(() => resolveAgentTools(["read", "nonexist"]), /未知工具：nonexist/);
});

test("tools 写不存在的 MCP 工具名 → 跳过但不报错（server 可能掉线）", () => {
  assert.deepEqual(names(resolveAgentTools(["read", "mcp__gone__x"])), ["read"]);
});

// ── MCP ──
const mcpTools = new Map([
  ["hub", [tool("mcp__hub__send"), tool("mcp__hub__list")]],
  ["web", [tool("mcp__web__scan"), tool("mcp__web__report")]],
]);
setMcpToolsByServer(mcpTools, []);

test("mcps 列出的 server → 该 server 全部工具", () => {
  assert.deepEqual(names(resolveAgentTools(["read"], ["hub"])), ["mcp__hub__list", "mcp__hub__send", "read"]);
});

test("mcpTools 收窄：某 server 有列出的 → 只给列出的", () => {
  assert.deepEqual(names(resolveAgentTools([], ["web"], ["mcp__web__scan"])), ["mcp__web__scan"]);
});

test("mcpTools 收窄：某 server 一个都没列出 → 该 server 全部给（整组 + 单勾混合）", () => {
  const got = names(resolveAgentTools([], ["hub", "web"], ["mcp__web__scan"]));
  assert.deepEqual(got, ["mcp__hub__list", "mcp__hub__send", "mcp__web__scan"]);
});

test("mcps 里有未连接的 server → 运行时降级（跳过该 server，不阻断配置）", () => {
  assert.deepEqual(names(resolveAgentTools(["read"], ["hub", "nope"])), ["mcp__hub__list", "mcp__hub__send", "read"]);
});

test("codemode / tool_search 按需注入（有 codemode 类 / deferred 类 MCP 工具时）", () => {
  const withCodemode = new Map([["cm", [tool("mcp__cm__run", { callers: ["tools"] })]]]);
  setMcpToolsByServer(withCodemode, [tool("codemode"), tool("tool_search")]);
  assert.deepEqual(names(resolveAgentTools([], ["cm"])), ["codemode", "mcp__cm__run"]);

  const withDeferred = new Map([["df", [tool("mcp__df__x", { deferred: true })]]]);
  setMcpToolsByServer(withDeferred, [tool("codemode"), tool("tool_search")]);
  assert.deepEqual(names(resolveAgentTools([], ["df"])), ["mcp__df__x", "tool_search"]);

  // 普通 MCP 工具不触发任何 support
  setMcpToolsByServer(mcpTools, [tool("codemode"), tool("tool_search")]);
  assert.deepEqual(names(resolveAgentTools([], ["hub"])), ["mcp__hub__list", "mcp__hub__send"]);
});

// ── 角色差异 ──
test("助理强制注入 subagent（即使 tools 里没写）", () => {
  assert.deepEqual(names(resolveAssistantTools(["read"])), ["read", "subagent"]);
});

test("子 agent 不会被注入 subagent", () => {
  assert.deepEqual(names(resolveAgentTools(["read"], [], null, { role: "agent" })), ["read"]);
});

test("助理 tools 为空也必须拿到 subagent（平台机制）", () => {
  assert.deepEqual(names(resolveAssistantTools([])), ["subagent"]);
});

// ── fail fast 校验 ──
test("validate: 绑了报告组但没勾 report_publish → 拒绝", () => {
  assert.throws(
    () => validateAgentConfig({ tools: ["read"], reports: ["demo"] }),
    /绑定了报告组但没有勾选 report_publish/,
  );
  assert.doesNotThrow(() => validateAgentConfig({ tools: ["read", "report_publish"], reports: ["demo"] }));
});

test("validate: 启用 skill 但没 read/bash → 拒绝", () => {
  assert.throws(() => validateAgentConfig({ tools: ["write"], skills: ["x"] }), /没有 read\/bash 工具/);
  assert.doesNotThrow(() => validateAgentConfig({ tools: ["read"], skills: ["x"] }));
});

test("validate: 子 agent 勾 subagent → 拒绝", () => {
  assert.throws(() => validateAgentConfig({ tools: ["subagent"], role: "agent" }), /子 Agent 不能勾选 subagent/);
  assert.doesNotThrow(() => validateAgentConfig({ tools: ["subagent"], role: "assistant" }));
});

test("validate: mcps 有未连接的 server → 拒绝", () => {
  assert.throws(() => validateAgentConfig({ tools: [], mcps: ["gone"] }), /MCP 未连接或不存在/);
});

// ── 序列化往返 ──
test("mcpTools 往返：只在非空时落盘", () => {
  const md = serializeAgentDef({
    tools: ["read"],
    mcps: ["hub"],
    mcpTools: ["mcp__hub__send"],
    instructions: "x",
  });
  assert.match(md, /mcpTools: \[mcp__hub__send\]/);
  const parsed = parseAgentDef(md);
  assert.deepEqual(parsed.mcpTools, ["mcp__hub__send"]);
  assert.deepEqual(parsed.tools, ["read"]);

  const empty = serializeAgentDef({ tools: ["read"], mcps: ["hub"], mcpTools: null, instructions: "x" });
  assert.doesNotMatch(empty, /mcpTools/);
  assert.equal(parseAgentDef(empty).mcpTools, null);
});

test("tools: [] 落盘后仍是空列表（不等于缺失语义）", () => {
  const md = serializeAgentDef({ tools: [], instructions: "x" });
  assert.match(md, /tools: \[\]/);
  assert.deepEqual(parseAgentDef(md).tools, []);
});

// ── 前端目录 ──
test("toolCatalog: 子 agent 角色下 subagent 不可用且有原因", () => {
  const groups = toolCatalog({ role: "agent" });
  const all = groups.flatMap((g) => g.tools);
  const sub = all.find((t) => t.name === "subagent");
  assert.equal(sub.available, false);
  assert.match(sub.reason, /不能派发子 Agent/);
  assert.equal(all.find((t) => t.name === "read").available, true);
});

test("toolCatalog: 助理角色下 subagent 可用且锁定", () => {
  const all = toolCatalog({ role: "assistant" }).flatMap((g) => g.tools);
  const sub = all.find((t) => t.name === "subagent");
  assert.equal(sub.available, true);
  assert.equal(sub.locked, true);
});

test("toolCatalog: 分组名按扩展归类", () => {
  const groups = toolCatalog({ role: "agent" });
  // 内置单独成组；pi-box→系统、pi-box-reports→报告、codemode+tool-search→高级
  assert.deepEqual(groups.map((g) => g.name), ["内置", "系统", "报告", "高级"]);
});

test("mcpCatalog: 按 server 分组，label 去掉前缀", () => {
  const catalog = mcpCatalog();
  const hub = catalog.find((entry) => entry.server === "hub");
  assert.deepEqual(hub.tools.map((t) => t.label), ["send", "list"]);
});
// ── 助理文件不存在 vs 字段缺失 ──
test("loadAssistant: 文件不存在 → 默认内置 4 个（新项目不该是哑巴）", async () => {
  const asst = await loadAssistant("no-such-project");
  assert.deepEqual(asst.tools, ["read", "write", "edit", "bash"]);
});

test("loadAssistant: 文件存在但没写 tools → 零工具（显式）", async () => {
  const { writeFile } = await import("node:fs/promises");
  const dir = join(root, "workspace", "hasfile", ".pi");
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "assistant.md"), "---\n---\n\n助理\n", "utf-8");
  const asst = await loadAssistant("hasfile");
  assert.equal(asst.tools, null);
});
