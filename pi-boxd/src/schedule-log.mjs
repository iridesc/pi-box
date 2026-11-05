// 定时任务运行日志：落盘、保留清理、并发锁、幂等标记。
//
// 目录布局（每个项目一份，随项目 workspace 一起备份）：
//   <项目>/.pi/schedule-logs/<scheduleId>/
//     ├── 20261105-141501.log      每次运行一个文件
//     ├── latest.log -> 最近一次
//     ├── .lock                    并发锁（含 pid，用于 stale 检测）
//     └── .marks/<sha1(occurrenceId)>   幂等标记（同一 occurrence 只执行一次）
import { createWriteStream } from "node:fs";
import { mkdir, open, readFile, readdir, rm, stat, symlink, unlink } from "node:fs/promises";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { META_DIR, META_PROJECT, PROJECTS_DIR } from "./paths.mjs";

const DEFAULT_RETENTION_DAYS = 7;
const TAIL_READ_BYTES = 512 * 1024;

/** 项目工作目录（与 schedules.mjs 的 projectCwd 保持一致）。 */
export function scheduleProjectCwd(project) {
  return project === META_PROJECT ? META_DIR : join(PROJECTS_DIR, project);
}

export function scheduleLogRoot(project) {
  return join(scheduleProjectCwd(project), ".pi", "schedule-logs");
}

export function scheduleLogDir(project, scheduleId) {
  return join(scheduleLogRoot(project), String(scheduleId));
}

/** 日志文件名用的时间戳（本地时区）：20261105-141501 */
export function runStamp(date = new Date()) {
  const pad = (n) => String(n).padStart(2, "0");
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
}

function isoNow(date = new Date()) {
  const offset = -date.getTimezoneOffset();
  const sign = offset >= 0 ? "+" : "-";
  const pad = (n) => String(n).padStart(2, "0");
  const local = `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
  return `${local}${sign}${pad(Math.floor(Math.abs(offset) / 60))}:${pad(Math.abs(offset) % 60)}`;
}

/**
 * 打开一次运行的日志文件。
 * @returns {Promise<{path:string, write:(chunk:Buffer|string)=>void, close:()=>Promise<void>, stamp:string}>}
 */
export async function openRunLog({ project, scheduleId, stamp = runStamp() }) {
  const dir = scheduleLogDir(project, scheduleId);
  await mkdir(dir, { recursive: true });
  const path = join(dir, `${stamp}.log`);
  const stream = createWriteStream(path, { flags: "a", mode: 0o644 });
  let closed = false;
  const write = (chunk) => {
    if (closed) return;
    stream.write(chunk);
  };
  const close = async () => {
    if (closed) return;
    closed = true;
    await new Promise((resolve) => stream.end(resolve));
    await linkLatest(dir, `${stamp}.log`);
  };
  return { path, write, close, stamp };
}

async function linkLatest(dir, filename) {
  const link = join(dir, "latest.log");
  try {
    await unlink(link);
  } catch {
    /* 不存在 */
  }
  try {
    await symlink(filename, link);
  } catch {
    /* 某些文件系统不支持软链，忽略 */
  }
}

/** 日志里的一行带时间戳前缀。 */
export function logLine(text, date = new Date()) {
  return `[${isoNow(date)}] ${text}\n`;
}

/** 读取日志尾部若干行（供 API/UI 用）。 */
export async function readLogTail(logPath, lines = 300) {
  const info = await stat(logPath);
  const start = Math.max(0, info.size - TAIL_READ_BYTES);
  const handle = await open(logPath, "r");
  try {
    const length = info.size - start;
    const buffer = Buffer.alloc(length);
    await handle.read(buffer, 0, length, start);
    const all = buffer.toString("utf8").split("\n");
    const tail = all.slice(Math.max(0, all.length - (lines + 1)));
    return { lines: tail, bytes: info.size, truncatedFromStart: start > 0 };
  } finally {
    await handle.close();
  }
}

/**
 * 并发锁：同一任务重叠时返回 null（调用方跳过本次）。
 * @returns {Promise<null | {release: () => Promise<void>}>}
 */
export async function acquireScheduleLock({ project, scheduleId }) {
  const dir = scheduleLogDir(project, scheduleId);
  await mkdir(dir, { recursive: true });
  const lockPath = join(dir, ".lock");
  const me = `${process.pid} ${Date.now()}\n`;

  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const handle = await open(lockPath, "wx");
      await handle.writeFile(me, "utf8");
      await handle.close();
      return {
        release: async () => {
          try {
            await unlink(lockPath);
          } catch {
            /* 已删除 */
          }
        },
      };
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
      const stale = await isLockStale(lockPath);
      if (!stale) return null;
      // 持有者已死：清掉再抢一次
      try {
        await unlink(lockPath);
      } catch {
        /* 竞争中被别人删了 */
      }
    }
  }
  return null;
}

async function isLockStale(lockPath) {
  let raw = "";
  try {
    raw = (await readFile(lockPath, "utf8")).trim();
  } catch {
    return true;
  }
  const pid = Number(raw.split(/\s+/)[0]);
  if (!Number.isInteger(pid) || pid <= 0) return true;
  try {
    process.kill(pid, 0);
    return false; // 进程还活着
  } catch (error) {
    return error?.code === "ESRCH";
  }
}

/**
 * 幂等标记：同一 occurrenceId 首次返回 true，重复返回 false。
 * （durable 的 abandonOnRestart 已经能避免大多数重跑，这里是第二道保险。）
 */
export async function markOccurrence({ project, scheduleId, occurrenceId }) {
  const dir = join(scheduleLogDir(project, scheduleId), ".marks");
  await mkdir(dir, { recursive: true });
  const name = createHash("sha1").update(String(occurrenceId)).digest("hex").slice(0, 16);
  const path = join(dir, name);
  try {
    const handle = await open(path, "wx");
    await handle.writeFile(`${occurrenceId}\n${new Date().toISOString()}\n`, "utf8");
    await handle.close();
    return true;
  } catch (error) {
    if (error?.code === "EEXIST") return false;
    throw error;
  }
}

/**
 * 清理过期日志与幂等标记。
 * @param {number} retentionDays 保留天数（<=0 表示不清理）
 */
export async function pruneScheduleLogs({ project, scheduleId, retentionDays = DEFAULT_RETENTION_DAYS }) {
  if (!retentionDays || retentionDays <= 0) return { removed: 0 };
  const dir = scheduleLogDir(project, scheduleId);
  const cutoff = Date.now() - retentionDays * 86_400_000;
  let removed = 0;
  for (const name of await safeReaddir(dir)) {
    if (!name.endsWith(".log")) continue;
    const path = join(dir, name);
    try {
      const info = await stat(path);
      if (info.mtimeMs < cutoff) {
        await rm(path, { force: true });
        removed += 1;
      }
    } catch {
      /* ignore */
    }
  }
  const marksDir = join(dir, ".marks");
  for (const name of await safeReaddir(marksDir)) {
    const path = join(marksDir, name);
    try {
      const info = await stat(path);
      if (info.mtimeMs < cutoff) {
        await rm(path, { force: true });
        removed += 1;
      }
    } catch {
      /* ignore */
    }
  }
  return { removed };
}

async function safeReaddir(dir) {
  try {
    return await readdir(dir);
  } catch {
    return [];
  }
}

/** 启动清理：遍历所有项目下所有任务的日志目录（供 pi-boxd 每日清理用）。 */
export async function pruneAllScheduleLogs({ projects, schedulesByProject, retentionDays }) {
  let removed = 0;
  for (const project of projects) {
    for (const schedule of schedulesByProject[project] ?? []) {
      const days = schedule?.log?.retentionDays ?? retentionDays ?? DEFAULT_RETENTION_DAYS;
      const result = await pruneScheduleLogs({ project, scheduleId: schedule.id, retentionDays: days });
      removed += result.removed;
    }
  }
  return { removed };
}

/** 写一个启动用的占位日志（例如并发跳过时，也要留痕）。 */
export async function writeSkippedLog({ project, scheduleId, occurrenceId, reason }) {
  const { path, write, close } = await openRunLog({ project, scheduleId });
  write(logLine(`跳过本次运行：${reason}`));
  write(logLine(`occurrence=${occurrenceId}`));
  await close();
  return path;
}

/** 简单节流：同一项目的清理不必每次 tick 都跑。 */
const lastPruneAt = new Map();
export function shouldPrune(project, scheduleId, everyMs = 6 * 3600_000) {
  const key = `${project}/${scheduleId}`;
  const last = lastPruneAt.get(key) ?? 0;
  if (Date.now() - last < everyMs) return false;
  lastPruneAt.set(key, Date.now());
  return true;
}
