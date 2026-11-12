// 实体图标（项目 / 助理 / 子 Agent）单测：
// - emoji 存在各自实体的文件里，不落全局配置
// - 只改图标不能丢其它配置
// - 元项目图标不可改；长度与换行注入要挡住
import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

const root = await mkdtemp(join(tmpdir(), "pibox-icon-"));
process.env.PI_BOX_WORKSPACE = join(root, "workspace");
process.env.PI_BOX_PROJECTS_DIR = join(root, "workspace");
process.env.PI_BOX_META_DIR = join(root, "meta");
process.env.PI_BOXD_DATA_DIR = join(root, "data");
await mkdir(join(root, "workspace", "demo", ".pi", "agents"), { recursive: true });
await mkdir(join(root, "meta"), { recursive: true });

const {
  parseAgentDef,
  serializeAgentDef,
  normalizeIcon,
  loadProjectIcon,
  saveProjectIcon,
  setAssistantIcon,
  setAgentIcon,
} = await import("../src/agents.mjs");

test.after(async () => {
  await rm(root, { recursive: true, force: true });
});

test("icon 能往返 frontmatter，且不影响其它字段", () => {
  const md = serializeAgentDef({
    icon: "🔬",
    model: "x/y",
    tools: ["read"],
    mcps: [],
    skills: null,
    agents: ["a"],
    instructions: "干活",
  });
  assert.match(md, /^---\nicon: 🔬\n/);
  const def = parseAgentDef(md);
  assert.equal(def.icon, "🔬");
  assert.equal(def.model, "x/y");
  assert.deepEqual(def.tools, ["read"]);
  assert.deepEqual(def.agents, ["a"]);
  assert.equal(def.instructions, "干活");
  // 没有 icon 时不应该写空行，避免把已有图标冲掉。
  assert.doesNotMatch(serializeAgentDef({ model: null, tools: null, instructions: "x" }), /icon:/);
});

test("normalizeIcon 校验长度并剥离换行（防 frontmatter 注入）", () => {
  assert.equal(normalizeIcon("🎯"), "🎯");
  assert.equal(normalizeIcon("  🎯  "), "🎯");
  assert.equal(normalizeIcon(""), null);
  assert.equal(normalizeIcon(null), null);
  assert.equal(normalizeIcon(undefined), null);
  // 换行被剥离后不会产生新的 frontmatter 行（短注入能过长度校验但换行已消失）
  assert.equal(normalizeIcon("🎯\nm"), "🎯m");
  assert.throws(() => normalizeIcon("🎯\nmodel: evil"), /最多 8 个字符/);
  assert.throws(() => normalizeIcon("abcdefghij"), /最多 8 个字符/);
});

test("项目图标存 .pi/project.json；恢复默认时删除文件", async () => {
  assert.equal(await loadProjectIcon("demo"), null);
  await saveProjectIcon("demo", "🗂️");
  assert.equal(await loadProjectIcon("demo"), "🗂️");
  const file = join(root, "workspace", "demo", ".pi", "project.json");
  assert.match(await readFile(file, "utf8"), /"icon": "🗂️"/);
  // 保留文件里其它字段（后续可能扩展 description 等）
  await writeFile(file, '{"icon":"🗂️","description":"x"}', "utf8");
  await saveProjectIcon("demo", "📦");
  const meta = JSON.parse(await readFile(file, "utf8"));
  assert.equal(meta.icon, "📦");
  assert.equal(meta.description, "x");
  // 恢复默认
  assert.equal(await saveProjectIcon("demo", null), null);
  await assert.rejects(stat(file));
  assert.equal(await loadProjectIcon("demo"), null);
});

test("只改图标不会丢助理/Agent 的其它配置", async () => {
  const assistantFile = join(root, "workspace", "demo", ".pi", "assistant.md");
  await writeFile(
    assistantFile,
    serializeAgentDef({ model: "m1", tools: ["read"], agents: ["x"], instructions: "助理提示词" }),
    "utf8",
  );
  await setAssistantIcon("demo", "✨");
  const assistant = parseAgentDef(await readFile(assistantFile, "utf8"));
  assert.equal(assistant.icon, "✨");
  assert.equal(assistant.model, "m1");
  assert.deepEqual(assistant.tools, ["read"]);
  assert.deepEqual(assistant.agents, ["x"]);
  assert.equal(assistant.instructions, "助理提示词");

  const agentFile = join(root, "workspace", "demo", ".pi", "agents", "研究员.md");
  await writeFile(agentFile, serializeAgentDef({ model: "m2", instructions: "研究" }), "utf8");
  await setAgentIcon("demo", "研究员", "project", "🧪");
  const agent = parseAgentDef(await readFile(agentFile, "utf8"));
  assert.equal(agent.icon, "🧪");
  assert.equal(agent.model, "m2");
  assert.equal(agent.instructions, "研究");
});

test("元项目图标固定，不可修改", async () => {
  await assert.rejects(saveProjectIcon("meta", "🎯"), /元项目/);
  await assert.rejects(setAssistantIcon("meta", "🎯"), /元项目/);
  await assert.rejects(setAgentIcon("meta", "x", "meta", "🎯"), /元项目/);
  assert.equal(await loadProjectIcon("meta"), null);
});