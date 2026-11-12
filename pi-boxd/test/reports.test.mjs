// 报告组存储层单测：
// - slug / stamp 严格校验（路径穿越从这里堵死）
// - publish 到不存在的组必须报错，不能悄悄建垃圾组
// - html 报告必须自包含（外链 js/css/图片一律拒绝）
// - 跨 agent 不能互删；保留清理永不删最新一份
// - 可见性切换会维护公开索引，撤销后立即失效
import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

const root = await mkdtemp(join(tmpdir(), "pibox-reports-"));
process.env.PI_BOX_WORKSPACE = join(root, "workspace");
process.env.PI_BOX_PROJECTS_DIR = join(root, "workspace");
process.env.PI_BOX_META_DIR = join(root, "meta");
process.env.PI_BOXD_DATA_DIR = join(root, "data");
process.env.PI_BOX_REPORT_ALLOW_PUBLIC = "1";
await mkdir(join(root, "workspace", "demo"), { recursive: true });
await mkdir(join(root, "meta"), { recursive: true });
await mkdir(join(root, "data"), { recursive: true });

const {
  normalizeGroupSlug,
  normalizeReportStamp,
  findExternalResources,
  createGroup,
  listGroups,
  loadGroupMeta,
  updateGroup,
  deleteGroup,
  setGroupVisibility,
  publishReport,
  listReports,
  readReport,
  deleteReport,
  pruneGroup,
  scanSensitive,
  resolvePublicGroup,
  listPublicSlugs,
  rebuildPublicIndex,
  loadPublicIndex,
} = await import("../src/reports.mjs");

test.after(async () => {
  await rm(root, { recursive: true, force: true });
});

const PROJECT = "demo";

test("slug 校验挡住非法字符与路径穿越", () => {
  assert.equal(normalizeGroupSlug("daily-audit"), "daily-audit");
  assert.equal(normalizeGroupSlug("  Audit1  "), "audit1");
  for (const bad of ["../etc", "a/b", "", "-x", "大写", "with space", "a".repeat(60)]) {
    assert.throws(() => normalizeGroupSlug(bad), /报告组名/, `应拒绝：${bad}`);
  }
});

test("report stamp 必须是时间戳格式", () => {
  assert.equal(normalizeReportStamp("20261112-140000"), "20261112-140000");
  assert.equal(normalizeReportStamp("20261112-140000-2"), "20261112-140000-2");
  for (const bad of ["../../etc/passwd", "2026-11-12", "abc", ""]) {
    assert.throws(() => normalizeReportStamp(bad), /报告 ID/);
  }
});

test("html 自包含校验：资源外链拒绝，data/blob 与正文链接放行", () => {
  assert.deepEqual(findExternalResources('<p>见 https://example.com 官网</p>'), []);
  assert.deepEqual(findExternalResources('<a href="https://example.com">链接</a>'), []);
  assert.deepEqual(findExternalResources('<img src="data:image/png;base64,AAA">'), []);
  assert.ok(findExternalResources('<script src="https://cdn.jsdelivr.net/x.js"></script>').length > 0);
  assert.ok(findExternalResources('<link rel="stylesheet" href="//evil.com/a.css">').length > 0);
  assert.ok(findExternalResources('<img src="https://evil.com/x.png">').length > 0);
  assert.ok(findExternalResources('<div style="background:url(https://evil.com/a.png)">x</div>').length > 0);
  assert.ok(findExternalResources('<style>@import "https://evil.com/a.css";</style>').length > 0);
});

test("建组 / 重名 409 / 从名称推导 slug", async () => {
  const meta = await createGroup(PROJECT, { name: "Daily Audit" });
  assert.equal(meta.slug, "daily-audit");
  assert.equal(meta.visibility, "private");
  assert.equal(meta.reports.length, 0);
  await assert.rejects(() => createGroup(PROJECT, { name: "Daily Audit" }), /已存在/);
  // 纯中文名推导不出 slug，要求显式指定
  await assert.rejects(() => createGroup(PROJECT, { name: "每日审计" }), /英文 slug/);
  const groups = await listGroups(PROJECT);
  assert.equal(groups.length, 1);
  assert.equal(groups[0].slug, "daily-audit");
  assert.equal(groups[0].name, "Daily Audit");
});

test("publish 到不存在的组报错，不会自动建组", async () => {
  await assert.rejects(
    () => publishReport(PROJECT, "not-exist", { agent: "a1", content: "hello" }),
    /报告组不存在/,
  );
  const leftover = await loadGroupMeta(PROJECT, "not-exist");
  assert.equal(leftover, null);
});

test("publish：md/html 落盘、索引降序、同秒追加序号", async () => {
  const first = await publishReport(PROJECT, "daily-audit", { agent: "audit", title: "第一份", content: "# one" });
  const second = await publishReport(PROJECT, "daily-audit", { agent: "audit", content: "# two" });
  assert.equal(first.format, "md");
  assert.equal(first.title, "第一份");
  // 缺省标题自动用时间
  assert.match(second.title, /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/);
  // 同一秒两次发布：第二份自动带序号，不能覆盖第一份
  assert.notEqual(first.stamp, second.stamp);
  assert.ok(second.stamp.startsWith(first.stamp));

  const html = await publishReport(PROJECT, "daily-audit", {
    agent: "audit",
    format: "html",
    title: "html 报告",
    content: "<html><body><h1>hi</h1></body></html>",
  });
  assert.equal(html.format, "html");

  const { reports } = await listReports(PROJECT, "daily-audit");
  assert.equal(reports.length, 3);
  // 索引按 stamp 降序（最新在前）
  assert.equal(reports[0].stamp, html.stamp);

  // 内容真的写到磁盘上
  const dir = join(root, "workspace", "demo", ".pi", "reports", "daily-audit");
  assert.equal(await readFile(join(dir, `${first.stamp}.md`), "utf-8"), "# one");
  assert.equal(await readFile(join(dir, `${html.stamp}.html`), "utf-8"), "<html><body><h1>hi</h1></body></html>");
});

test("publish 拒绝外链 html、空内容、超限格式", async () => {
  await assert.rejects(
    () => publishReport(PROJECT, "daily-audit", { agent: "a", format: "html", content: '<script src="https://x/y.js"></script>' }),
    /自包含/,
  );
  await assert.rejects(() => publishReport(PROJECT, "daily-audit", { agent: "a", content: "   " }), /不能为空/);
  await assert.rejects(() => publishReport(PROJECT, "daily-audit", { agent: "a", format: "pdf", content: "x" }), /md 或 html/);
});

test("readReport 返回正文与前后导航", async () => {
  const group = "nav-demo";
  await createGroup(PROJECT, { name: group });
  const a = await publishReport(PROJECT, group, { agent: "x", title: "a", content: "AAA" });
  const b = await publishReport(PROJECT, group, { agent: "x", title: "b", content: "BBB" });
  const c = await publishReport(PROJECT, group, { agent: "x", title: "c", content: "CCC" });

  // 最新（c，下标 1/3）：没有更新的，只有更早的 b
  const newest = await readReport(PROJECT, group, c.stamp);
  assert.equal(newest.report.content, "CCC");
  assert.equal(newest.nav.index, 1);
  assert.equal(newest.nav.total, 3);
  assert.equal(newest.nav.newer, null);
  assert.equal(newest.nav.older.stamp, b.stamp);

  // 中间（b）：两侧都有
  const middle = await readReport(PROJECT, group, b.stamp);
  assert.equal(middle.nav.index, 2);
  assert.equal(middle.nav.newer.stamp, c.stamp);
  assert.equal(middle.nav.older.stamp, a.stamp);

  // 最旧（a）：没有更早的
  const oldest = await readReport(PROJECT, group, a.stamp);
  assert.equal(oldest.nav.index, 3);
  assert.equal(oldest.nav.older, null);
  assert.equal(oldest.nav.newer.stamp, b.stamp);

  await assert.rejects(() => readReport(PROJECT, group, "20260101-000000"), /报告不存在/);
});

test("删除：跨 agent 被拒，本人可删", async () => {
  const group = "del-demo";
  await createGroup(PROJECT, { name: group });
  const mine = await publishReport(PROJECT, group, { agent: "alice", content: "mine" });
  // 另一个 agent 删不掉
  await assert.rejects(() => deleteReport(PROJECT, group, mine.stamp, { agent: "bob" }), /不能由/);
  // 本人可以
  await deleteReport(PROJECT, group, mine.stamp, { agent: "alice" });
  const { reports } = await listReports(PROJECT, group);
  assert.equal(reports.length, 0);
});

test("可见性切换维护公开索引，撤销后立刻失效", async () => {
  const group = "pub-demo";
  await createGroup(PROJECT, { name: group });
  await publishReport(PROJECT, group, { agent: "a", content: "secret-ish" });

  const pub = await setGroupVisibility(PROJECT, group, "public");
  assert.equal(pub.visibility, "public");
  assert.match(pub.publicSlug, /^[0-9a-f]{22}$/);
  const resolved = await resolvePublicGroup(pub.publicSlug);
  assert.equal(resolved.project, PROJECT);
  assert.equal(resolved.group, group);

  const slugs = await listPublicSlugs();
  assert.ok(pub.publicSlug in slugs);

  // 撤销公开：索引里要干净，链接立刻 404
  const priv = await setGroupVisibility(PROJECT, group, "private");
  assert.equal(priv.visibility, "private");
  assert.equal(priv.publicSlug, null);
  assert.equal(await resolvePublicGroup(pub.publicSlug), null);
  assert.ok(!(pub.publicSlug in (await listPublicSlugs())));
});

test("公开索引可重建，且拒绝不符条件的条目", async () => {
  const group = "rebuild-demo";
  await createGroup(PROJECT, { name: group });
  const pub = await setGroupVisibility(PROJECT, group, "public");

  // 模拟索引文件丢失
  await writeFile(join(root, "data", "reports-public.json"), '{"version":1,"entries":{}}\n', "utf-8");
  assert.equal(await resolvePublicGroup(pub.publicSlug), null);
  await rebuildPublicIndex();
  const index = await loadPublicIndex();
  assert.equal(index[pub.publicSlug].group, group);

  // 组被删掉后，旧 slug 必须解析不到（即使索引还残留）
  await deleteGroup(PROJECT, group);
  assert.equal(await resolvePublicGroup(pub.publicSlug), null);
  assert.ok(!(pub.publicSlug in (await loadPublicIndex())));
});

test("保留清理：过期报告被删，最新一份永不删", async () => {
  const group = "prune-demo";
  await createGroup(PROJECT, { name: group, retentionDays: 30 });
  const a = await publishReport(PROJECT, group, { agent: "x", content: "old-a" });
  const b = await publishReport(PROJECT, group, { agent: "x", content: "old-b" });
  const c = await publishReport(PROJECT, group, { agent: "x", content: "newest" });

  // 直接把 meta 里的时间改旧，模拟 60 天前的报告
  const metaFile = join(root, "workspace", "demo", ".pi", "reports", group, ".meta.json");
  const meta = JSON.parse(await readFile(metaFile, "utf-8"));
  const old = new Date(Date.now() - 60 * 86_400_000).toISOString();
  for (const item of meta.reports) {
    // 除最新一份外全部设成过期
    if (item.stamp !== c.stamp) item.createdAt = old;
  }
  await writeFile(metaFile, JSON.stringify(meta, null, 2), "utf-8");

  const result = await pruneGroup(PROJECT, group);
  assert.equal(result.removed, 2);
  const { reports } = await listReports(PROJECT, group);
  assert.equal(reports.length, 1);
  assert.equal(reports[0].stamp, c.stamp);
  // 旧文件真的从磁盘消失了
  await assert.rejects(() => readFile(join(root, "workspace", "demo", ".pi", "reports", group, `${a.stamp}.md`)));
  await assert.rejects(() => readFile(join(root, "workspace", "demo", ".pi", "reports", group, `${b.stamp}.md`)));
});

test("敏感信息扫描：只在转公开时用于提示", async () => {
  const group = "scan-demo";
  await createGroup(PROJECT, { name: group });
  await publishReport(PROJECT, group, {
    agent: "x",
    content: "目标 192.168.1.10:8080 弱口令 admin123\npassword: hunter2hunter2",
  });
  const result = await scanSensitive(PROJECT, group);
  assert.ok(result.total > 0);
  const kinds = result.items.map((item) => item.kind);
  assert.ok(kinds.includes("内网 IP"));
  assert.ok(kinds.includes("疑似凭据"));
  // 示例片段不能太长
  for (const item of result.items) assert.ok(item.sample.length <= 80);
});

test("改名称与保留期；slug 不可改", async () => {
  const group = "edit-demo";
  await createGroup(PROJECT, { name: group });
  const updated = await updateGroup(PROJECT, group, { name: "新名字", retentionDays: 90 });
  assert.equal(updated.name, "新名字");
  assert.equal(updated.retentionDays, 90);
  await assert.rejects(() => updateGroup(PROJECT, group, { name: "  " }), /不能为空/);
  await assert.rejects(() => updateGroup(PROJECT, "nope", { name: "x" }), /不存在/);
});

test("删除组会连同报告目录一起清掉", async () => {
  const group = "rm-demo";
  await createGroup(PROJECT, { name: group });
  await publishReport(PROJECT, group, { agent: "x", content: "bye" });
  const dir = join(root, "workspace", "demo", ".pi", "reports", group);
  await readFile(join(dir, ".meta.json"));
  const result = await deleteGroup(PROJECT, group);
  assert.equal(result.reportCount, 1);
  await assert.rejects(() => readFile(join(dir, ".meta.json")));
  assert.equal(await loadGroupMeta(PROJECT, group), null);
  // 已删除的组再列出时不应出现
  const remaining = await listGroups(PROJECT);
  assert.ok(!remaining.some((item) => item.slug === group));
});

test("元项目也能建报告组（走 META_DIR）", async () => {
  await mkdir(join(root, "meta", ".pi"), { recursive: true });
  const meta = await createGroup("meta", { name: "Platform Report", slug: "platform" });
  assert.equal(meta.slug, "platform");
  const dir = join(root, "meta", ".pi", "reports", "platform", ".meta.json");
  await readFile(dir);
});
test("agent frontmatter 的 reports 绑定：round-trip 且只改图标时保留", async () => {
  const { parseAgentDef, serializeAgentDef, saveAgentFile } = await import("../src/agents.mjs");
  const md = "---\nicon: 🕵️\nreports: [daily-audit, weekly-audit]\ntools: []\n---\n\n你是审计 agent。\n";
  const def = parseAgentDef(md);
  assert.deepEqual(def.reports, ["daily-audit", "weekly-audit"]);
  assert.deepEqual(def.tools, []);
  // 序列化回去，reports 不能丢
  const again = parseAgentDef(serializeAgentDef(def));
  assert.deepEqual(again.reports, ["daily-audit", "weekly-audit"]);
  assert.equal(again.icon, "🕵️");

  // 保存时若不传 reports（例如只改图标），必须从旧文件读回保留
  const dir = join(root, "workspace", "demo", ".pi", "agents");
  await mkdir(dir, { recursive: true });
  const { writeFile } = await import("node:fs/promises");
  await writeFile(join(dir, "audit.md"), md, "utf-8");
  await saveAgentFile("demo", "audit", "project", { instructions: "新提示词" });
  const saved = parseAgentDef(await readFile(join(dir, "audit.md"), "utf-8"));
  assert.deepEqual(saved.reports, ["daily-audit", "weekly-audit"], "改别的字段不能把报告绑定冲掉");
  assert.equal(saved.icon, "🕵️");
  assert.equal(saved.instructions, "新提示词");
});

test("报告内容的响应头：html 必须带 sandbox 且禁用同源与联网", async () => {
  const { contentHeaders } = await import("../src/report-pages.mjs");

  const html = contentHeaders("html");
  assert.equal(html["Content-Type"], "text/html; charset=utf-8");
  const csp = html["Content-Security-Policy"];
  assert.match(csp, /sandbox allow-scripts/);
  assert.match(csp, /connect-src 'none'/, "必须掐断 fetch 外泄通道");
  assert.match(csp, /form-action 'none'/);
  assert.match(csp, /base-uri 'none'/);
  assert.match(csp, /script-src 'unsafe-inline'/, "单文件内联 js 要能跑");
  assert.ok(!/allow-same-origin/.test(csp), "加了 allow-same-origin 等于没沙箱，绝不允许");
  assert.equal(html["X-Content-Type-Options"], "nosniff");
  assert.match(html["X-Robots-Tag"], /noindex/);

  // md 走 text/plain：即使被人直接打开也不会执行
  const md = contentHeaders("md");
  assert.match(md["Content-Type"], /^text\/plain/);
  assert.match(md["Content-Security-Policy"], /connect-src 'none'/);
  assert.equal(md["X-Content-Type-Options"], "nosniff");
});
