// 报告工具单测：绑定解析、组名推导、拒绝路径。
// 工具是 agent 唯一的写入通道，所以这里测的是「它能不能被绕过」。
import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

const root = await mkdtemp(join(tmpdir(), "pibox-report-tools-"));
process.env.PI_BOX_WORKSPACE = join(root, "workspace");
process.env.PI_BOX_PROJECTS_DIR = join(root, "workspace");
process.env.PI_BOX_META_DIR = join(root, "meta");
process.env.PI_BOXD_DATA_DIR = join(root, "data");
process.env.PI_BOX_REPORT_ALLOW_PUBLIC = "1";
const PROJECT = "demo";
const projectDir = join(root, "workspace", PROJECT);
await mkdir(join(projectDir, ".pi", "agents"), { recursive: true });
await mkdir(join(root, "meta"), { recursive: true });
await mkdir(join(root, "data"), { recursive: true });

const { ReportExtension } = await import("../src/report-tools.mjs");
const { createGroup } = await import("../src/reports.mjs");

test.after(async () => {
  await rm(root, { recursive: true, force: true });
});

const tool = (name) => ReportExtension.tools.find((item) => item.name === name);

/** 模拟一次工具调用：api.snapshot 返回该会话的角色身份。 */
function apiFor(actorName, actorType = "agent") {
  return {
    conversationId: "conv-1",
    env: { cwd: projectDir },
    snapshot: async () => ({
      project: PROJECT,
      actorType,
      actorName,
    }),
  };
}

const textOf = (result) => (result?.output ?? []).map((part) => part.text ?? "").join("");

async function writeAgent(name, frontmatter) {
  const body = `---\n${frontmatter}\n---\n\n你是测试 agent。\n`;
  await writeFile(join(projectDir, ".pi", "agents", `${name}.md`), body, "utf-8");
}

test("没绑定报告组时明确拒绝，并告诉怎么绑", async () => {
  await writeAgent("no-binding", "tools: []");
  const result = await tool("report_publish").execute({ content: "# x" }, apiFor("no-binding"), {});
  const text = textOf(result);
  assert.match(text, /还没有绑定报告组/);
  assert.match(text, /reports/);
});

test("绑定一个组：不用传 group 也能发布，报告落到该组", async () => {
  await createGroup(PROJECT, { name: "每日审计", slug: "daily-audit" });
  await writeAgent("auditor", "reports: [daily-audit]\ntools: []");
  const result = await tool("report_publish").execute(
    { content: "# 今天的审计\n\n一切正常。", title: "11-12 审计" },
    apiFor("auditor"),
    {},
  );
  const text = textOf(result);
  assert.match(text, /已发布到报告组「每日审计」/);
  assert.match(text, /11-12 审计/);
  assert.match(text, /仅登录可见/, "默认必须是私有");

  const list = await tool("report_list").execute({}, apiFor("auditor"), {});
  assert.match(textOf(list), /每日审计.*1 份/s);
});

test("绑定多个组时必须显式传 group，且不能超出白名单", async () => {
  await createGroup(PROJECT, { name: "周报", slug: "weekly-audit" });
  await writeAgent("multi", "reports: [daily-audit, weekly-audit]\ntools: []");

  const noGroup = await tool("report_publish").execute({ content: "# x" }, apiFor("multi"), {});
  assert.match(textOf(noGroup), /绑定了多个报告组/);

  const bad = await tool("report_publish").execute({ content: "# x", group: "other" }, apiFor("multi"), {});
  assert.match(textOf(bad), /不在当前角色的白名单里/);

  const ok = await tool("report_publish").execute({ content: "# 周报内容", group: "weekly-audit" }, apiFor("multi"), {});
  assert.match(textOf(ok), /已发布到报告组「周报」/);
});

test("写到不存在的组会报错（不自动建组）", async () => {
  await writeAgent("ghost", "reports: [ghost-group]\ntools: []");
  const result = await tool("report_publish").execute({ content: "# x" }, apiFor("ghost"), {});
  assert.match(textOf(result), /报告组不存在/);
});

test("html 报告外链会被工具层拒绝", async () => {
  const result = await tool("report_publish").execute(
    { format: "html", content: '<script src="https://evil.example.com/x.js"></script>' },
    apiFor("auditor"),
    {},
  );
  assert.match(textOf(result), /自包含/);
});

test("report_read 返回正文与位置；report_delete 只能删自己的", async () => {
  // 格式非法的编号直接被拒
  const malformed = await tool("report_read").execute({ stamp: "nope" }, apiFor("auditor"), {});
  assert.match(textOf(malformed), /报告 ID 非法/);
  // 格式合法但不存在的编号报「不存在」
  const missing = await tool("report_read").execute({ stamp: "20200101-000000" }, apiFor("auditor"), {});
  assert.match(textOf(missing), /报告不存在/);

  const listed = await tool("report_list").execute({ group: "daily-audit" }, apiFor("auditor"), {});
  const stamp = /(\d{8}-\d{6}(?:-\d+)?)/.exec(textOf(listed))?.[1];
  assert.ok(stamp, "列表里应该能解析出报告编号");

  const detail = await tool("report_read").execute({ stamp }, apiFor("auditor"), {});
  assert.match(textOf(detail), /今天的审计/);

  // 另一个 agent 删不掉 auditor 的报告
  await writeAgent("intruder", "reports: [daily-audit]\ntools: []");
  const denied = await tool("report_delete").execute({ stamp }, apiFor("intruder"), {});
  assert.match(textOf(denied), /不能由/);

  // 本人可以删
  const removed = await tool("report_delete").execute({ stamp }, apiFor("auditor"), {});
  assert.match(textOf(removed), /已删除报告/);
});

test("助理会话走 assistant 分支（读 assistant.md 的 reports）", async () => {
  await writeFile(
    join(projectDir, ".pi", "assistant.md"),
    "---\nreports: [daily-audit]\n---\n\n你是项目助理。\n",
    "utf-8",
  );
  const api = {
    conversationId: "conv-main",
    env: { cwd: projectDir },
    snapshot: async () => ({ project: PROJECT, actorType: "assistant", actorName: "助理" }),
  };
  const result = await tool("report_publish").execute({ content: "# 助理写的报告" }, api, {});
  assert.match(textOf(result), /已发布到报告组/);
});

test("缺少项目上下文时给出可读错误（不抛异常）", async () => {
  const api = { conversationId: "c", env: {}, snapshot: async () => ({}) };
  const result = await tool("report_publish").execute({ content: "# x" }, api, {});
  assert.match(textOf(result), /无法确定当前项目/);
});