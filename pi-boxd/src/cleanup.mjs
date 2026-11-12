// 数据清理：配置、体积统计、日志清理、数据库清理。
//
// 两种清理的风险等级完全不同：
// - 日志清理：纯文件删除，pi-boxd 运行中随时可做（在线）。
// - 数据库清理：必须先把 Harness（及其 SQLite 连接）关掉，否则清理与 pi-boxd 的
//   内存缓存/引用脱钩，且 VACUUM 拿不到独占写锁。由 runtime.mjs 编排停机-清理-重启。
import { mkdir, readdir, readFile, rename, stat, statfs, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { DATA_DIR, META_DIR, META_PROJECT, PROJECTS_DIR } from "./paths.mjs";
import { listProjects } from "./agents.mjs";
import { pruneScheduleLogs, scheduleLogDir } from "./schedule-log.mjs";
import { pruneProjectReports } from "./reports.mjs";

const CONFIG_PATH = join(DATA_DIR, "cleanup.json");
const DAY_MS = 86_400_000;

export const DEFAULT_CLEANUP_CONFIG = {
  version: 1,
  logs: {
    retentionDays: 7,
    maxRunBytes: 20 * 1024 * 1024,
    autoPrune: true,
  },
  database: {
    retentionDays: 90,
    vacuum: true,
    autoClean: true,
    autoCleanAt: "03:30",
  },
  runs: {
    maxEntries: 300,
  },
  lastRuns: {
    logs: null,
    database: null,
  },
};

const LIMITS = {
  logRetentionDays: [0, 365],
  maxRunBytes: [1024 * 1024, 1024 * 1024 * 1024],
  dbRetentionDays: [0, 3650],
  maxRunEntries: [20, 5000],
};

function clampInt(value, [min, max], fallback) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(max, Math.max(min, Math.round(number)));
}

function normalizeTime(value, fallback) {
  const match = /^(\d{1,2}):(\d{2})$/.exec(String(value ?? ""));
  if (!match) return fallback;
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (hour > 23 || minute > 59) return fallback;
  return `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
}

/** 归一化：夹紧数值范围、校验 autoCleanAt，保留 lastRuns。 */
export function normalizeCleanupConfig(raw) {
  const source = raw && typeof raw === "object" ? raw : {};
  const logs = source.logs ?? {};
  const database = source.database ?? {};
  const runs = source.runs ?? {};
  return {
    version: 1,
    logs: {
      retentionDays: clampInt(logs.retentionDays, LIMITS.logRetentionDays, DEFAULT_CLEANUP_CONFIG.logs.retentionDays),
      maxRunBytes: clampInt(logs.maxRunBytes, LIMITS.maxRunBytes, DEFAULT_CLEANUP_CONFIG.logs.maxRunBytes),
      autoPrune: logs.autoPrune !== false,
    },
    database: {
      retentionDays: clampInt(database.retentionDays, LIMITS.dbRetentionDays, DEFAULT_CLEANUP_CONFIG.database.retentionDays),
      vacuum: database.vacuum !== false,
      autoClean: database.autoClean !== false,
      autoCleanAt: normalizeTime(database.autoCleanAt, DEFAULT_CLEANUP_CONFIG.database.autoCleanAt),
    },
    runs: {
      maxEntries: clampInt(runs.maxEntries, LIMITS.maxRunEntries, DEFAULT_CLEANUP_CONFIG.runs.maxEntries),
    },
    lastRuns: {
      logs: source.lastRuns?.logs ?? null,
      database: source.lastRuns?.database ?? null,
    },
  };
}

export async function loadCleanupConfig() {
  try {
    return normalizeCleanupConfig(JSON.parse(await readFile(CONFIG_PATH, "utf-8")));
  } catch {
    return normalizeCleanupConfig({});
  }
}

/** 深合并补丁后保存（0600）。 */
export async function saveCleanupConfig(patch) {
  const current = await loadCleanupConfig();
  const next = normalizeCleanupConfig({
    ...current,
    ...patch,
    logs: { ...current.logs, ...(patch?.logs ?? {}) },
    database: { ...current.database, ...(patch?.database ?? {}) },
    runs: { ...current.runs, ...(patch?.runs ?? {}) },
    lastRuns: { ...current.lastRuns, ...(patch?.lastRuns ?? {}) },
  });
  await mkdir(DATA_DIR, { recursive: true });
  const temporary = `${CONFIG_PATH}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(next, null, 2)}\n`, { encoding: "utf-8", mode: 0o600 });
  await rename(temporary, CONFIG_PATH);
  return next;
}

export async function recordCleanupRun(kind, result) {
  const current = await loadCleanupConfig();
  await saveCleanupConfig({ lastRuns: { ...current.lastRuns, [kind]: result } });
}

function projectCwd(project) {
  return project === META_PROJECT ? META_DIR : join(PROJECTS_DIR, project);
}

/** 读项目的 schedules.json（只取任务定义，避免和 schedules.mjs 互相 import）。 */
async function loadSchedules(project) {
  try {
    const raw = JSON.parse(await readFile(join(projectCwd(project), ".pi", "schedules.json"), "utf-8"));
    return Array.isArray(raw?.schedules) ? raw.schedules : [];
  } catch {
    return [];
  }
}

// ── 体积统计 ───────────────────────────────────────────────────────────

async function fileSize(path) {
  try {
    const info = await stat(path);
    return info.isFile() ? info.size : 0;
  } catch {
    return 0;
  }
}

/** 数据库文件 + WAL/SHM 的实际占用。 */
export async function statDatabase() {
  const base = join(DATA_DIR, "session.sqlite");
  const sqlite = await fileSize(base);
  const wal = await fileSize(`${base}-wal`);
  const shm = await fileSize(`${base}-shm`);
  return { path: base, sqlite, wal, shm, total: sqlite + wal + shm };
}

/** 所有项目定时任务日志的合计（按项目 + 按任务分项）。 */
export async function statLogs(projects) {
  const list = projects ?? (await listProjects());
  const perProject = [];
  let total = 0;
  let files = 0;
  for (const project of list) {
    const root = join(projectCwd(project), ".pi", "schedule-logs");
    let entries = [];
    try {
      entries = await readdir(root, { withFileTypes: true });
    } catch {
      continue;
    }
    let projectBytes = 0;
    let projectFiles = 0;
    const tasks = [];
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      let names = [];
      try {
        names = await readdir(join(root, entry.name));
      } catch {
        continue;
      }
      let bytes = 0;
      let count = 0;
      for (const name of names) {
        if (!name.endsWith(".log")) continue;
        bytes += await fileSize(join(root, entry.name, name));
        count += 1;
      }
      if (count > 0) tasks.push({ scheduleId: entry.name, files: count, bytes });
      projectBytes += bytes;
      projectFiles += count;
    }
    if (projectFiles > 0) perProject.push({ project, files: projectFiles, bytes: projectBytes, tasks });
    total += projectBytes;
    files += projectFiles;
  }
  return { total, files, projects: perProject };
}

export async function cleanupStatus() {
  const [config, database, logs] = await Promise.all([loadCleanupConfig(), statDatabase(), statLogs()]);
  return { config, database, logs };
}

// ── 日志清理（在线安全） ────────────────────────────────────────────────

/**
 * 按规则删除所有项目的定时任务日志。
 * 保留天数优先级：任务自身 log.retentionDays → 全局 logs.retentionDays。
 * 同时清理「任务已被删除但目录还在」的孤儿日志目录。
 */
export async function pruneAllLogs({ config, projects } = {}) {
  const cfg = config ?? (await loadCleanupConfig());
  const list = projects ?? (await listProjects());
  const startedAt = new Date();
  let removed = 0;
  let freedBytes = 0;
  const details = [];

  for (const project of list) {
    const root = join(projectCwd(project), ".pi", "schedule-logs");
    let entries = [];
    try {
      entries = await readdir(root, { withFileTypes: true });
    } catch {
      continue;
    }
    const schedules = await loadSchedules(project);
    const daysBySchedule = new Map(schedules.map((schedule) => [schedule.id, schedule?.log?.retentionDays]));
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const own = daysBySchedule.get(entry.name);
      const retentionDays = Number.isFinite(Number(own)) ? Number(own) : cfg.logs.retentionDays;
      if (retentionDays <= 0) continue; // 0 = 保留不删
      // 先量体积再删，才能报出释放量（删除只按天数，所以用同样的规则预扫）
      const before = await measureExpired(scheduleLogDir(project, entry.name), retentionDays);
      const result = await pruneScheduleLogs({ project, scheduleId: entry.name, retentionDays });
      removed += result.removed;
      freedBytes += before.bytes;
      if (result.removed > 0) {
        details.push({ project, scheduleId: entry.name, removed: result.removed, freedBytes: before.bytes });
      }
    }
  }

  // 报告清理：跟着日志同一个周期跑（保留期由每个报告组自己的 meta 决定，
  // 默认 30 天、上限 365 天；每组最新一份永不删）。
  let removedReports = 0;
  for (const project of list) {
    try {
      const outcome = await pruneProjectReports(project);
      removedReports += outcome.removed;
      if (outcome.removed > 0) details.push({ project, kind: "reports", removed: outcome.removed });
    } catch (error) {
      console.warn(`[cleanup] 清理报告失败（${project}）：${error?.message ?? error}`);
    }
  }

  const summary = {
    at: startedAt.toISOString(),
    removedFiles: removed,
    freedBytes,
    removedReports,
    details: details.slice(0, 50),
  };
  await recordCleanupRun("logs", summary);
  return summary;
}

async function measureExpired(dir, retentionDays) {
  const cutoff = Date.now() - retentionDays * DAY_MS;
  let bytes = 0;
  let files = 0;
  for (const sub of ["", ".marks"]) {
    let names = [];
    try {
      names = await readdir(sub ? join(dir, sub) : dir);
    } catch {
      continue;
    }
    for (const name of names) {
      if (sub === "" && !name.endsWith(".log")) continue;
      const path = sub ? join(dir, sub, name) : join(dir, name);
      try {
        const info = await stat(path);
        if (info.mtimeMs < cutoff) {
          bytes += info.size;
          files += 1;
        }
      } catch {
        /* ignore */
      }
    }
  }
  return { bytes, files };
}

// ── 数据库清理（必须先停 Harness） ──────────────────────────────────────

export async function diskFreeBytes(path = DATA_DIR) {
  try {
    const info = await statfs(path);
    return Number(info.bavail) * Number(info.bsize);
  } catch {
    return null;
  }
}

function placeholders(count) {
  return new Array(count).fill("?").join(",");
}

function countRows(db, table, where, params) {
  return db.prepare(`SELECT count(*) AS c FROM ${table}${where ? ` WHERE ${where}` : ""}`).get(...params).c;
}

/**
 * 删除 N 天前已结束（terminal）的定时任务，以及它们拥有的独立会话与相关数据，然后可选 VACUUM。
 * 只应在 Harness 关闭后调用（此时没有其它连接，也没有内存缓存引用这些记录）。
 */
export async function cleanDatabase({ retentionDays, vacuum = true } = {}) {
  const config = await loadCleanupConfig();
  const days = Number.isFinite(Number(retentionDays)) ? Number(retentionDays) : config.database.retentionDays;
  const doVacuum = vacuum ?? config.database.vacuum;
  const dbPath = join(DATA_DIR, "session.sqlite");
  const startedAt = new Date();
  const sizeBefore = await fileSize(dbPath);
  const result = {
    at: startedAt.toISOString(),
    retentionDays: days,
    tasks: 0,
    conversations: 0,
    entries: 0,
    submissions: 0,
    documents: 0,
    sizeBefore,
    sizeAfter: sizeBefore,
    vacuum: false,
    skipped: null,
    error: null,
  };

  if (!(days > 0)) {
    result.skipped = "保留天数 <= 0，未删除任何数据";
    await recordCleanupRun("database", result);
    return result;
  }

  const cutoffMs = Date.now() - days * DAY_MS;
  let db;
  try {
    db = new DatabaseSync(dbPath);
    db.exec("PRAGMA busy_timeout = 8000");

    // 1) 过期的 terminal 任务（只认有 endedAt 的记录；没有时间的保守保留）
    const expired = db
      .prepare(
        `SELECT id FROM tasks
         WHERE status = 'terminal'
           AND json_extract(record, '$.endedAt') IS NOT NULL
           AND json_extract(record, '$.endedAt') < ?`,
      )
      .all(cutoffMs)
      .map((row) => row.id);

    if (expired.length > 0) {
      // 2) 这些任务的子任务（owner 指向它们）一起删，避免悬挂
      const childClause = placeholders(expired.length);
      const children = db
        .prepare(`SELECT id FROM tasks WHERE json_extract(record, '$.owner') IN (${childClause})`)
        .all(...expired)
        .map((row) => row.id);
      const taskIds = [...new Set([...expired, ...children])];
      const taskClause = placeholders(taskIds.length);

      // 3) 这些任务拥有的独立会话（主会话的 owner_task_id 为 NULL，不会被选中）
      const conversationIds = db
        .prepare(`SELECT id FROM conversations WHERE owner_task_id IN (${taskClause})`)
        .all(...taskIds)
        .map((row) => row.id);
      const convIds = [...new Set(conversationIds)];

      // 4) 相关文档（conversation scope / task scope）
      const docFilter = [];
      const docParams = [];
      if (convIds.length > 0) {
        docFilter.push(`(scope_kind = 'conversation' AND owner_id IN (${placeholders(convIds.length)}))`);
        docParams.push(...convIds);
      }
      docFilter.push(`(scope_kind = 'task' AND owner_id IN (${taskClause}))`);
      docParams.push(...taskIds);
      const documentIds = db
        .prepare(`SELECT id FROM documents WHERE ${docFilter.join(" OR ")}`)
        .all(...docParams)
        .map((row) => row.id);

      db.exec("BEGIN");
      try {
        if (documentIds.length > 0) {
          db.prepare(`DELETE FROM document_revisions WHERE document_id IN (${placeholders(documentIds.length)})`).run(...documentIds);
          db.prepare(`DELETE FROM documents WHERE id IN (${placeholders(documentIds.length)})`).run(...documentIds);
        }
        let entriesDeleted = 0;
        let submissionsDeleted = 0;
        if (convIds.length > 0) {
          entriesDeleted = Number(
            db.prepare(`DELETE FROM entries WHERE conversation_id IN (${placeholders(convIds.length)})`).run(...convIds).changes ?? 0,
          );
          submissionsDeleted = Number(
            db.prepare(`DELETE FROM submissions WHERE conversation_id IN (${placeholders(convIds.length)})`).run(...convIds).changes ?? 0,
          );
          db.prepare(`DELETE FROM conversations WHERE id IN (${placeholders(convIds.length)})`).run(...convIds);
        }
        db.prepare(`DELETE FROM tasks WHERE id IN (${placeholders(taskIds.length)})`).run(...taskIds);
        db.exec("COMMIT");
        result.entries = entriesDeleted;
        result.submissions = submissionsDeleted;
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }

      result.tasks = taskIds.length;
      result.conversations = convIds.length;
      result.documents = documentIds.length;
    }
  } catch (error) {
    result.error = error instanceof Error ? error.message : String(error);
    try {
      db?.close();
    } catch {
      /* ignore */
    }
    await recordCleanupRun("database", result);
    return result;
  } finally {
    try {
      db?.close();
    } catch {
      /* ignore */
    }
  }

  // 5) VACUUM（需要独占 + 约等于库大小的临时空间；不够就跳过并如实报告）
  if (doVacuum && result.sizeBefore > 0) {
    const free = await diskFreeBytes();
    if (free !== null && free < result.sizeBefore * 1.2) {
      result.error = `磁盘余量不足，跳过压缩（需要约 ${Math.ceil((result.sizeBefore * 1.2) / 1024 / 1024)} MB，可用 ${Math.floor(free / 1024 / 1024)} MB）`;
    } else {
      try {
        const vdb = new DatabaseSync(dbPath);
        vdb.exec("VACUUM");
        vdb.close();
        result.vacuum = true;
      } catch (error) {
        result.error = `压缩失败：${error instanceof Error ? error.message : String(error)}`;
      }
    }
  }

  result.sizeAfter = await fileSize(dbPath);
  await recordCleanupRun("database", result);
  return result;
}

// ── 自动清理判定 ──────────────────────────────────────────────────────

/**
 * 是否该在此时自动执行数据库清理（每天一次，到点后执行；需要空闲，由调用方判断任务是否在跑）。
 */
export function dueForAutoClean(config, lastRun, now = new Date()) {
  if (!config?.database?.autoClean) return false;
  const [hour, minute] = String(config.database.autoCleanAt ?? "03:30").split(":").map(Number);
  const target = new Date(now);
  target.setHours(hour || 0, minute || 0, 0, 0);
  if (now < target) return false;
  const last = lastRun?.at ? new Date(lastRun.at) : null;
  if (last && !Number.isNaN(last.getTime()) && last >= target) return false;
  return true;
}
