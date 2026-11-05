// 数据清理单测：配置归一化 / 自动清理判定 / 日志清理 / 数据库清理
import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, stat, utimes, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { DatabaseSync } from "node:sqlite";

const root = await mkdtemp(join(tmpdir(), "pibox-cleanup-"));
process.env.PI_BOX_WORKSPACE = join(root, "workspace");
process.env.PI_BOX_PROJECTS_DIR = join(root, "workspace");
process.env.PI_BOX_META_DIR = join(root, "meta");
process.env.PI_BOXD_DATA_DIR = join(root, "data");
await mkdir(process.env.PI_BOXD_DATA_DIR, { recursive: true });
await mkdir(join(root, "workspace", "demo", ".pi"), { recursive: true });
await mkdir(join(root, "meta"), { recursive: true });

const { DEFAULT_CLEANUP_CONFIG, dueForAutoClean, loadCleanupConfig, normalizeCleanupConfig, pruneAllLogs, saveCleanupConfig, cleanDatabase } =
  await import("../src/cleanup.mjs");

test.after(async () => {
  await rm(root, { recursive: true, force: true });
});

test("配置默认值与范围夹紧", () => {
  const defaults = normalizeCleanupConfig({});
  assert.equal(defaults.logs.retentionDays, 7);
  assert.equal(defaults.logs.maxRunBytes, 20 * 1024 * 1024);
  assert.equal(defaults.database.retentionDays, 90);
  assert.equal(defaults.database.autoCleanAt, "03:30");
  assert.equal(defaults.runs.maxEntries, 300);

  const clamped = normalizeCleanupConfig({
    logs: { retentionDays: 9999, maxRunBytes: 1 },
    database: { retentionDays: -5, autoCleanAt: "99:99" },
    runs: { maxEntries: 1 },
  });
  assert.equal(clamped.logs.retentionDays, 365);
  assert.equal(clamped.logs.maxRunBytes, 1024 * 1024);
  assert.equal(clamped.database.retentionDays, 0);
  assert.equal(clamped.database.autoCleanAt, DEFAULT_CLEANUP_CONFIG.database.autoCleanAt);
  assert.equal(clamped.runs.maxEntries, 20);
});

test("配置保存后可读回，且 lastRuns 保留", async () => {
  await saveCleanupConfig({ logs: { retentionDays: 3 }, lastRuns: { logs: { at: "2026-01-01T00:00:00.000Z", removedFiles: 2 } } });
  const loaded = await loadCleanupConfig();
  assert.equal(loaded.logs.retentionDays, 3);
  assert.equal(loaded.lastRuns.logs.removedFiles, 2);
  // 再次保存别的字段不应抹掉 lastRuns
  await saveCleanupConfig({ database: { retentionDays: 30 } });
  const again = await loadCleanupConfig();
  assert.equal(again.lastRuns.logs.removedFiles, 2);
  assert.equal(again.database.retentionDays, 30);
});

test("自动清理判定：到点才触发，且每天只触发一次", () => {
  const config = { database: { autoClean: true, autoCleanAt: "03:30" } };
  const before = new Date("2026-05-01T02:00:00");
  const after = new Date("2026-05-01T04:00:00");
  assert.equal(dueForAutoClean(config, null, before), false);
  assert.equal(dueForAutoClean(config, null, after), true);
  // 今天已经跑过（03:40）
  assert.equal(dueForAutoClean(config, { at: new Date("2026-05-01T03:40:00").toISOString() }, after), false);
  // 昨天跑过 → 今天该跑
  assert.equal(dueForAutoClean(config, { at: new Date("2026-04-30T03:40:00").toISOString() }, after), true);
  // 关掉自动清理
  assert.equal(dueForAutoClean({ database: { autoClean: false } }, null, after), false);
});

test("日志清理：按全局天数删除，任务级保留天数优先", async () => {
  const project = "demo";
  const logsRoot = join(root, "workspace", project, ".pi", "schedule-logs");
  const makeLog = async (scheduleId, name, daysAgo) => {
    const dir = join(logsRoot, scheduleId);
    await mkdir(dir, { recursive: true });
    const file = join(dir, name);
    await writeFile(file, "x".repeat(100), "utf8");
    const past = new Date(Date.now() - daysAgo * 86_400_000);
    await utimes(file, past, past);
    return file;
  };
  const oldGlobal = await makeLog("sched-keep7", "20200101-000000.log", 10);
  const newGlobal = await makeLog("sched-keep7", "20200102-000000.log", 1);
  const oldKeep30 = await makeLog("sched-keep30", "20200103-000000.log", 10);
  // 任务级保留 30 天的任务，10 天前的日志不该删
  await writeFile(
    join(root, "workspace", project, ".pi", "schedules.json"),
    JSON.stringify({ version: 1, schedules: [{ id: "sched-keep30", log: { retentionDays: 30 } }], runs: [] }),
  );

  await saveCleanupConfig({ logs: { retentionDays: 7 } });
  const result = await pruneAllLogs({ projects: [project] });
  assert.equal(result.removedFiles, 1, `应只删 1 个全局过期文件，实际 ${result.removedFiles}`);
  const exists = (p) => stat(p).then(() => true).catch(() => false);
  assert.equal(await exists(oldGlobal), false);
  assert.equal(await exists(newGlobal), true);
  assert.equal(await exists(oldKeep30), true, "任务级 30 天保留应生效");
});

test("保留天数为 0 时不删除日志", async () => {
  const project = "demo2";
  const dir = join(root, "workspace", project, ".pi", "schedule-logs", "s1");
  await mkdir(dir, { recursive: true });
  const file = join(dir, "20200101-000000.log");
  await writeFile(file, "x", "utf8");
  const past = new Date(Date.now() - 100 * 86_400_000);
  await utimes(file, past, past);
  await saveCleanupConfig({ logs: { retentionDays: 0 } });
  const result = await pruneAllLogs({ projects: [project] });
  assert.equal(result.removedFiles, 0);
  assert.equal(await stat(file).then(() => true).catch(() => false), true);
});

test("数据库清理：删过期任务及其会话，保留主会话", async () => {
  const dbPath = join(root, "data", "session.sqlite");
  const db = new DatabaseSync(dbPath);
  db.exec(`
    CREATE TABLE tasks (id INTEGER PRIMARY KEY, conversation_id INTEGER, kind TEXT, status TEXT, abort_requested INTEGER, background INTEGER, record TEXT);
    CREATE TABLE conversations (id INTEGER PRIMARY KEY, owner_conversation_id INTEGER, owner_task_id INTEGER, record TEXT);
    CREATE TABLE entries (id INTEGER PRIMARY KEY, conversation_id INTEGER, head INTEGER, commit_seq INTEGER, record TEXT);
    CREATE TABLE submissions (id INTEGER PRIMARY KEY, conversation_id INTEGER, request_id TEXT, status TEXT, record TEXT);
    CREATE TABLE documents (id INTEGER PRIMARY KEY, kind TEXT, family INTEGER, key_value TEXT, scope_kind TEXT, owner_id INTEGER, created_at INTEGER, retired_at INTEGER, record TEXT);
    CREATE TABLE document_revisions (document_id INTEGER, seq INTEGER, kind TEXT, version INTEGER, content TEXT);
  `);
  const oldEndedAt = Date.now() - 100 * 86_400_000;
  const nowEndedAt = Date.now() - 1000;
  const record = (extra) => JSON.stringify({ kind: "pibox.schedule.command", version: 1, background: true, abortRequested: false, ...extra });
  // 主会话（owner_task_id 为 NULL，必须保留）
  db.exec("INSERT INTO conversations (id, owner_conversation_id, owner_task_id, record) VALUES (2, NULL, NULL, '{}')");
  // 过期任务 + 它拥有的会话
  db.prepare("INSERT INTO tasks (id, conversation_id, kind, status, abort_requested, background, record) VALUES (?,?,?,?,0,1,?)").run(
    10, 2, "pibox.schedule.command", "terminal", record({ id: 10, endedAt: oldEndedAt }),
  );
  db.exec("INSERT INTO conversations (id, owner_conversation_id, owner_task_id, record) VALUES (20, 2, 10, '{}')");
  db.exec("INSERT INTO entries (id, conversation_id, commit_seq, record) VALUES (100, 20, 1, '{}'), (101, 20, 2, '{}')");
  db.exec("INSERT INTO entries (id, conversation_id, commit_seq, record) VALUES (200, 2, 3, '{}')");
  db.exec("INSERT INTO submissions (id, conversation_id, status, record) VALUES (300, 20, 'done', '{}')");
  db.exec("INSERT INTO documents (id, kind, family, scope_kind, owner_id, created_at, record) VALUES (400, 'pibox.conversation-meta', 0, 'conversation', 20, 1, '{}')");
  db.exec("INSERT INTO documents (id, kind, family, scope_kind, owner_id, created_at, record) VALUES (401, 'pibox.subagents', 0, 'conversation', 2, 1, '{}')");
  db.exec("INSERT INTO document_revisions (document_id, seq, kind, version, content) VALUES (400, 1, 'base', 1, '{}'), (401, 1, 'base', 1, '{}')");
  // 新任务（未过期，必须保留）
  db.prepare("INSERT INTO tasks (id, conversation_id, kind, status, abort_requested, background, record) VALUES (?,?,?,?,0,1,?)").run(
    11, 2, "pibox.schedule.command", "terminal", record({ id: 11, endedAt: nowEndedAt }),
  );
  db.close();

  const result = await cleanDatabase({ retentionDays: 30, vacuum: false });
  assert.equal(result.tasks, 1, `应删 1 个过期任务，实际 ${result.tasks}`);
  assert.equal(result.conversations, 1);
  assert.equal(result.entries, 2);
  assert.equal(result.submissions, 1);
  assert.equal(result.documents, 1);

  const check = new DatabaseSync(dbPath, { readOnly: true });
  const count = (table, where = "") => check.prepare(`SELECT count(*) AS c FROM ${table} ${where}`).get().c;
  assert.equal(count("tasks"), 1, "未过期任务应保留");
  assert.equal(count("conversations"), 1, "主会话应保留");
  assert.equal(count("entries"), 1, "主会话的条目应保留");
  assert.equal(count("documents"), 1, "主会话文档应保留");
  assert.equal(count("document_revisions"), 1);
  check.close();
});
