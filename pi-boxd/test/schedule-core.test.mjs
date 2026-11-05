// 定时任务核心模块单测：exec / schedule-log / schedules 校验（不依赖 durable harness）
// 运行：cd pi-boxd && npm test   或   node --test test/schedule-core.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, rm, stat, utimes, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

const root = await mkdtemp(join(tmpdir(), "pibox-sched-"));
process.env.PI_BOX_WORKSPACE = root;
process.env.PI_BOX_PROJECTS_DIR = root;

const { runCommand } = await import("../src/exec.mjs");
const { openRunLog, logLine, acquireScheduleLock, markOccurrence, pruneScheduleLogs, readLogTail, scheduleLogDir } =
  await import("../src/schedule-log.mjs");
const { validateScheduleInput, normalizeExecution, scheduleKind } = await import("../src/schedules.mjs");

test.after(async () => {
  await rm(root, { recursive: true, force: true });
});

// ── 校验层 ─────────────────────────────────────────────────────────────

test("纯命令任务通过校验", () => {
  const out = validateScheduleInput({
    name: "backlog-monitor",
    command: { run: "echo hi", timeoutSec: 60 },
    rule: { type: "interval", every: 15, unit: "minute" },
  });
  assert.equal(out.command.run, "echo hi");
  assert.equal(out.llm, null);
  assert.equal(scheduleKind(out), "command");
  assert.equal(out.log.retentionDays, 7);
});

test("纯 LLM 任务通过校验（兼容旧 prompt 字段）", () => {
  const out = validateScheduleInput({
    name: "daily-report",
    prompt: "生成日报",
    rule: { type: "daily", time: "16:00" },
  });
  assert.equal(out.llm.prompt, "生成日报");
  assert.equal(out.llm.agent, "assistant");
  assert.equal(out.llm.session, "ephemeral");
  assert.equal(scheduleKind(out), "llm");
});

test("命令 + LLM 任务通过校验", () => {
  const out = validateScheduleInput({
    name: "cmd+llm",
    command: { run: "echo data" },
    llm: { prompt: "分析 {{stdout}}", agent: "assistant", reportTo: "none" },
    cron: "*/15 * * * *",
  });
  assert.equal(scheduleKind(out), "command+llm");
  assert.equal(out.llm.onCommandFailure, "run");
});

test("命令与提示词都没有时报错", () => {
  assert.throws(
    () => validateScheduleInput({ name: "x", rule: { type: "interval", every: 5, unit: "minute" } }),
    /至少配置/,
  );
});

test("指定 agent 时禁止 persistent 会话", () => {
  assert.throws(
    () => validateScheduleInput({ name: "x", llm: { prompt: "p", agent: "agent:foo", session: "persistent" }, cron: "*/15 * * * *" }),
    /ephemeral/,
  );
});

test("旧 sessionMode=assistant 映射为 persistent", () => {
  const out = normalizeExecution({ prompt: "p", sessionMode: "assistant" });
  assert.equal(out.llm.session, "persistent");
});

test("日志保留天数可按任务配置并夹紧到合法范围", () => {
  assert.equal(normalizeExecution({ command: { run: "true" }, log: { retentionDays: 3 } }).log.retentionDays, 3);
  assert.equal(normalizeExecution({ command: { run: "true" }, log: { retentionDays: 9999 } }).log.retentionDays, 365);
  assert.equal(normalizeExecution({ command: { run: "true" }, log: { retentionDays: -1 } }).log.retentionDays, 0);
});

// ── 命令执行 ───────────────────────────────────────────────────────────

test("命令正常退出并收集输出", async () => {
  const chunks = [];
  const result = await runCommand({ command: "echo out; echo err 1>&2; exit 3", cwd: root, write: (c) => chunks.push(c) });
  const text = Buffer.concat(chunks).toString();
  assert.equal(result.exitCode, 3);
  assert.match(text, /out/);
  assert.match(text, /err/);
  assert.equal(result.truncated, false);
  assert.match(result.tail, /out/);
});

// tail 是 {{stdout}} 的数据通道：只能含 stdout，stderr 的日志行不能混进去。
test("tail 只保留 stdout（stderr 只进日志）", async () => {
  const chunks = [];
  const result = await runCommand({
    command: "echo DATA-A; echo 'log-noise' >&2; echo DATA-B",
    cwd: root,
    write: (c) => chunks.push(c),
  });
  assert.equal(result.tail, "DATA-A\nDATA-B\n");
  assert.doesNotMatch(result.tail, /log-noise/);
  assert.match(Buffer.concat(chunks).toString(), /log-noise/);
});

test("超时杀进程并标记 timedOut", async () => {
  const result = await runCommand({ command: "sleep 30", cwd: root, timeoutSec: 1 });
  assert.equal(result.timedOut, true);
  assert.ok(result.durationMs < 5000, `duration=${result.durationMs}`);
});

test("AbortSignal 中断命令", async () => {
  const controller = new AbortController();
  setTimeout(() => controller.abort(), 300);
  const result = await runCommand({ command: "sleep 30", cwd: root, signal: controller.signal });
  assert.equal(result.aborted, true);
  assert.ok(result.durationMs < 5000);
});

test("输出超过上限时截断", async () => {
  const result = await runCommand({
    command: "head -c 200000 /dev/zero | tr '\\0' 'a'",
    cwd: root,
    maxBytes: 1000,
    write: () => {},
  });
  assert.equal(result.truncated, true);
  assert.ok(result.bytes <= 1000, `bytes=${result.bytes}`);
});

test("杀进程组：孙子进程不残留", async () => {
  const marker = join(root, "grandchild.pid");
  await runCommand({
    command: `bash -c 'sleep 30 & echo $! > ${marker}; wait'`,
    cwd: root,
    timeoutSec: 1,
  });
  const pid = Number((await readFile(marker, "utf8")).trim());
  assert.ok(pid > 0, "应记录到孙子进程 pid");
  await new Promise((r) => setTimeout(r, 300));
  let alive = true;
  try {
    process.kill(pid, 0);
  } catch {
    alive = false;
  }
  assert.equal(alive, false, `孙子进程 ${pid} 仍存活`);
});

// ── 日志 / 锁 / 幂等 ──────────────────────────────────────────────────

test("日志写入 + latest 软链 + 尾部读取", async () => {
  const log = await openRunLog({ project: "demo", scheduleId: "sched-1", stamp: "20260101-000000" });
  log.write(logLine("hello"));
  log.write("line2\n");
  await log.close();
  const tail = await readLogTail(log.path, 10);
  assert.ok(tail.lines.join("\n").includes("line2"));
  const files = await readdir(scheduleLogDir("demo", "sched-1"));
  assert.ok(files.includes("latest.log"));
});

test("并发锁：同一任务第二次拿不到", async () => {
  const first = await acquireScheduleLock({ project: "demo", scheduleId: "sched-lock" });
  assert.ok(first);
  const second = await acquireScheduleLock({ project: "demo", scheduleId: "sched-lock" });
  assert.equal(second, null);
  await first.release();
  const third = await acquireScheduleLock({ project: "demo", scheduleId: "sched-lock" });
  assert.ok(third, "释放后应能再次获取");
  await third.release();
});

test("幂等标记：同一 occurrence 只放行一次", async () => {
  const a = await markOccurrence({ project: "demo", scheduleId: "sched-mark", occurrenceId: "occ-1" });
  const b = await markOccurrence({ project: "demo", scheduleId: "sched-mark", occurrenceId: "occ-1" });
  assert.equal(a, true);
  assert.equal(b, false);
});

test("按天数清理过期日志", async () => {
  const dir = scheduleLogDir("demo", "sched-prune");
  await mkdir(dir, { recursive: true });
  const old = join(dir, "20200101-000000.log");
  await writeFile(old, "old\n");
  const past = new Date(Date.now() - 10 * 86_400_000);
  await utimes(old, past, past);
  const result = await pruneScheduleLogs({ project: "demo", scheduleId: "sched-prune", retentionDays: 7 });
  assert.equal(result.removed, 1);
  const exists = await stat(old).then(() => true).catch(() => false);
  assert.equal(exists, false);
});
