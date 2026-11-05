// 命令执行：spawn + 流式输出 + 超时/中断时杀整个进程组。
//
// 设计要点（对应 schedule 的 command 阶段）：
// - detached: true → 子进程成为独立进程组 leader，kill(-pid) 能连带杀掉它的所有子孙
//   （python 脚本再 fork 的子进程也会一起死，避免残留）。
// - 输出按块交给调用方（写日志文件），本模块不落盘。
// - 单次输出超过 maxBytes 后只继续排空管道、不再写出，避免撑爆磁盘。
// - 尾部保留 tailLimit 字节，用于塞进 task outcome / UI 摘要。
// - 超时与 AbortSignal 都走同一个终止路径：SIGTERM → graceMs 后 SIGKILL。
import { spawn } from "node:child_process";

export const DEFAULT_TIMEOUT_SEC = 900;
export const MAX_OUTPUT_BYTES = 20 * 1024 * 1024;
const TAIL_LIMIT_BYTES = 8 * 1024;
const KILL_GRACE_MS = 5000;

/** 正在运行的子进程（pid → 终止函数）；pi-boxd 退出时兜底清理。 */
const running = new Map();

/** 杀掉所有仍在运行的命令进程组（进程退出兜底）。 */
export function killAllRunningCommands() {
  for (const kill of running.values()) {
    try {
      kill("SIGKILL");
    } catch {
      /* 进程可能已退出 */
    }
  }
  running.clear();
}

/**
 * 执行一条 shell 命令。
 * @param {object} options
 * @param {string} options.command        交给 `bash -c` 的命令串
 * @param {string} options.cwd            工作目录
 * @param {number} [options.timeoutSec]   超时秒数（默认 900）
 * @param {AbortSignal} [options.signal]  中断信号（task abort / harness 关闭）
 * @param {(chunk: Buffer) => void} [options.write]  输出回调（stdout+stderr 合并，按到达顺序）
 * @param {number} [options.maxBytes]     单次输出上限（默认 20MB）
 * @returns {Promise<{exitCode:number|null, signal:string|null, durationMs:number,
 *   timedOut:boolean, aborted:boolean, truncated:boolean, bytes:number, tail:string}>}
 */
export function runCommand({
  command,
  cwd,
  timeoutSec = DEFAULT_TIMEOUT_SEC,
  signal,
  write,
  maxBytes = MAX_OUTPUT_BYTES,
}) {
  return new Promise((resolve) => {
    const startedAt = Date.now();
    const child = spawn("/bin/bash", ["-c", command], {
      cwd,
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
      env: process.env,
    });

    const pid = child.pid;
    let tailBuf = Buffer.alloc(0);
    let bytes = 0;
    let truncated = false;
    let timedOut = false;
    let aborted = false;
    let killTimer = null;
    let timeoutTimer = null;
    let settled = false;

    /** 杀掉整个进程组（含子孙）。 */
    const killTree = (sig) => {
      if (!pid) return;
      try {
        process.kill(-pid, sig);
      } catch {
        try {
          child.kill(sig);
        } catch {
          /* 已退出 */
        }
      }
    };
    running.set(pid, killTree);

    const beginKill = (reason) => {
      if (settled) return;
      if (reason === "timeout") timedOut = true;
      if (reason === "abort") aborted = true;
      killTree("SIGTERM");
      if (killTimer === null) {
        killTimer = setTimeout(() => killTree("SIGKILL"), KILL_GRACE_MS);
        killTimer.unref?.();
      }
    };

    if (timeoutSec > 0) {
      timeoutTimer = setTimeout(() => beginKill("timeout"), timeoutSec * 1000);
      timeoutTimer.unref?.();
    }
    const onAbort = () => beginKill("abort");
    if (signal) {
      if (signal.aborted) onAbort();
      else signal.addEventListener("abort", onAbort, { once: true });
    }

    const handleChunk = (chunk) => {
      if (!truncated) {
        if (bytes + chunk.length > maxBytes) {
          truncated = true;
          const room = Math.max(0, maxBytes - bytes);
          if (room > 0) {
            const head = chunk.subarray(0, room);
            bytes += head.length;
            tailBuf = concatTail(tailBuf, head);
            try {
              write?.(head);
            } catch {
              /* 日志写入失败不应中断命令 */
            }
          }
          try {
            write?.(Buffer.from(`\n[... output truncated at ${maxBytes} bytes ...]\n`, "utf8"));
          } catch {
            /* ignore */
          }
        } else {
          bytes += chunk.length;
          tailBuf = concatTail(tailBuf, chunk);
          try {
            write?.(chunk);
          } catch {
            /* ignore */
          }
        }
      }
    };

    child.stdout?.on("data", handleChunk);
    child.stderr?.on("data", handleChunk);

    const finish = (code, closeSignal, spawnError) => {
      if (settled) return;
      settled = true;
      running.delete(pid);
      if (timeoutTimer) clearTimeout(timeoutTimer);
      if (killTimer) clearTimeout(killTimer);
      if (signal) signal.removeEventListener("abort", onAbort);
      let exitCode = code;
      if (spawnError) exitCode = 127;
      resolve({
        exitCode,
        signal: closeSignal ?? null,
        durationMs: Date.now() - startedAt,
        timedOut,
        aborted,
        truncated,
        bytes,
        tail: tailBuf.toString("utf8"),
        spawnError: spawnError ? String(spawnError.message ?? spawnError) : null,
      });
    };

    child.on("error", (error) => finish(null, null, error));
    child.on("close", (code, closeSignal) => finish(code, closeSignal, null));
  });
}

/** 只保留最后 TAIL_LIMIT_BYTES 字节。 */
function concatTail(previous, chunk) {
  const merged = previous.length === 0 ? chunk : Buffer.concat([previous, chunk]);
  return merged.length > TAIL_LIMIT_BYTES ? merged.subarray(merged.length - TAIL_LIMIT_BYTES) : merged;
}

// pi-boxd 收到 SIGTERM/SIGINT 或进程退时，别把子进程留在后台。
// 延迟 4s 再强杀：优先让 harness.close() 触发的 task abort 走正常路径（状态记为 aborted），
// 这里只是进程卡住时的兜底。
for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) {
  process.on(signal, () => {
    setTimeout(() => killAllRunningCommands(), 4000);
  });
}
process.on("exit", () => {
  killAllRunningCommands();
});
