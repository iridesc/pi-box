// 运行时可替换装配：Harness / Context / MCP 桥 / 定时任务调度器。
//
// 维护流程（数据清理）需要在**不重启容器**的前提下重建 Harness：
//   scheduler.close() → 中止运行中的任务 → harness.close()（含 Storage）
//   → 清理 SQLite + VACUUM（此时无连接）→ 重新 createHarness() → 恢复调度
//
// 为了让 routes / web 层不用改成 getter，这里导出 `harness` / `context` / `mcpBridge`
// 三个**转发 Proxy**：读取时总是取当前运行时的目标对象并绑定 this。
import { cleanDatabase, dueForAutoClean, loadCleanupConfig, pruneAllLogs } from "./cleanup.mjs";
import { ensureProjectConversations, createHarness } from "./harness.mjs";
import { listProjects } from "./agents.mjs";
import { startProjectScheduler } from "./schedules.mjs";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

let current = null;
let scheduler = null;
let maintenance = null;

export class MaintenanceError extends Error {
  constructor(message) {
    super(message);
    this.code = "MAINTENANCE";
  }
}

function target() {
  if (!current) throw new MaintenanceError("服务尚未就绪");
  return current;
}

function forwardProxy(getTarget) {
  return new Proxy(
    {},
    {
      get(_t, prop) {
        const value = getTarget()[prop];
        return typeof value === "function" ? value.bind(getTarget()) : value;
      },
      set(_t, prop, value) {
        getTarget()[prop] = value;
        return true;
      },
      has(_t, prop) {
        return prop in getTarget();
      },
      ownKeys() {
        return Reflect.ownKeys(getTarget());
      },
      getOwnPropertyDescriptor(_t, prop) {
        const descriptor = Object.getOwnPropertyDescriptor(getTarget(), prop);
        return descriptor ? { ...descriptor, configurable: true } : undefined;
      },
    },
  );
}

/** 转发到当前 Harness（维护期间指向重建后的新实例）。 */
export const harness = forwardProxy(() => target().harness);
/** 转发到 chorus Context（进程内固定，但走代理以便统一取值）。 */
export const context = forwardProxy(() => target().context);
/** 转发到当前 MCP 桥（跟随 Harness 一起重建）。 */
export const mcpBridge = forwardProxy(() => target().mcpBridge);

export function getRuntime() {
  return target();
}

export function getMaintenance() {
  return maintenance;
}

export function isMaintenance() {
  return maintenance !== null;
}

async function boot() {
  const rt = await createHarness();
  await ensureProjectConversations(rt.harness);
  rt.harness.resume();
  scheduler = startProjectScheduler({ harness: rt.harness, context: rt.context, listProjects });
  current = rt;
  return rt;
}

/** 首次启动。 */
export async function bootRuntime() {
  if (current) return current;
  return boot();
}

/**
 * 维护窗口：停调度 → 中止任务 → 关 Harness → 清理 + VACUUM → 重建 Harness。
 * 任何一步失败都保证服务被重新拉起（finally 里补齐 boot）。
 */
export async function restartRuntime({ reason = "manual", retentionDays, vacuum, onStep = () => {} } = {}) {
  if (maintenance) throw new MaintenanceError("已有维护任务在进行中");
  const startedAt = new Date();
  maintenance = { startedAt: startedAt.toISOString(), reason, step: "stopping-scheduler" };
  const step = (name) => {
    maintenance.step = name;
    onStep(name);
  };
  let cleaned = null;
  const previous = current;
  try {
    step("stopping-scheduler");
    scheduler?.close();
    scheduler = null;

    // 1) 中止运行中的任务；给它们一点时间收尾（命令进程会被 runtime.signal 杀掉）
    step("aborting-tasks");
    if (previous) {
      try {
        const inspection = await previous.harness.inspect(previous.context);
        const live = (inspection?.tasks ?? []).filter((task) => task.status !== "terminal");
        await Promise.allSettled(live.map((task) => previous.harness.abortTask(task.id, previous.context)));
        if (live.length > 0) {
          await Promise.race([previous.harness.waitForIdle(previous.context), sleep(8000)]);
        }
      } catch (error) {
        console.error("[maintenance] 中止运行中任务失败:", error?.message ?? error);
      }
    }

    // 2) 关闭 Harness（含 Storage；WAL 在此 TRUNCATE，之后才轮到 VACUUM 独占）
    step("closing-harness");
    if (previous) {
      const closed = await Promise.race([
        previous.harness.close(previous.context).then(() => true),
        sleep(15000).then(() => false),
      ]);
      if (!closed) console.error("[maintenance] 关闭 Harness 超时，仍继续清理（压缩可能失败）");
    }
    current = null;

    // 3) 清理 + 压缩
    step("cleaning-database");
    cleaned = await cleanDatabase({ retentionDays, vacuum });

    step("starting-harness");
  } finally {
    // 无论清理是否成功，都必须把服务拉起来
    try {
      await boot();
    } catch (error) {
      console.error("[maintenance] 重建 Harness 失败，重试一次:", error?.message ?? error);
      await sleep(1000);
      await boot();
    }
    maintenance = null;
  }

  return {
    reason,
    startedAt: startedAt.toISOString(),
    durationMs: Date.now() - startedAt.getTime(),
    result: cleaned,
  };
}

/** 定时清理：日志 + （可选）数据库。数据库清理要求当前没有任务在跑。 */
export function startCleanupScheduler({ intervalMs = 60_000 } = {}) {
  let running = false;
  let closed = false;
  const tick = async () => {
    if (running || closed || maintenance) return;
    running = true;
    try {
      const config = await loadCleanupConfig();

      // 日志：每 6 小时按规则清理一次（在线、无中断）
      const lastLogs = config.lastRuns.logs?.at ? new Date(config.lastRuns.logs.at).getTime() : 0;
      if (config.logs.autoPrune && Date.now() - lastLogs > 6 * 3_600_000) {
        const result = await pruneAllLogs({ config });
        if (result.removedFiles > 0) {
          console.log(`[cleanup] 自动清理日志：${result.removedFiles} 个文件，释放 ${(result.freedBytes / 1024 / 1024).toFixed(1)} MB`);
        }
      }

      // 数据库：每天到点一次，且必须空闲
      if (!dueForAutoClean(config, config.lastRuns.database)) return;
      const rt = current;
      if (!rt) return;
      const inspection = await rt.harness.inspect(rt.context);
      const liveTasks = (inspection?.tasks ?? []).filter((task) => task.status !== "terminal");
      const busySubmissions = (inspection?.submissions ?? []).filter((item) => item.status === "queued" || item.status === "placed");
      if (liveTasks.length > 0 || busySubmissions.length > 0) {
        return; // 有任务在跑，等下一轮
      }
      const out = await restartRuntime({
        reason: "auto",
        retentionDays: config.database.retentionDays,
        vacuum: config.database.vacuum,
      });
      console.log(
        `[cleanup] 自动清理数据库完成：删除 ${out.result?.tasks ?? 0} 个任务、${out.result?.conversations ?? 0} 个会话，` +
          `${((out.result?.sizeBefore ?? 0) / 1024 / 1024).toFixed(1)} MB → ${((out.result?.sizeAfter ?? 0) / 1024 / 1024).toFixed(1)} MB，耗时 ${out.durationMs} ms`,
      );
    } catch (error) {
      console.error("[cleanup] 自动清理失败:", error?.message ?? error);
    } finally {
      running = false;
    }
  };
  const timer = setInterval(() => tick().catch(console.error), intervalMs);
  timer.unref?.();
  return { close: () => { closed = true; clearInterval(timer); }, tick };
}

/** 进程退出前的收尾（只停调度器，Harness 由 index.mjs 关闭）。 */
export function closeScheduler() {
  scheduler?.close();
  scheduler = null;
}

export function clearRuntime() {
  current = null;
}
