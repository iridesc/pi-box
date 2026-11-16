// SSE 长连接加固：心跳 / 错误降级 / 失败自断。
//
// 背景：pi-durable-web 内建的 /api/events 只在快照变化时写数据，没有心跳，
// 快照抛错时写 `event: error`。这三种情况都会让连接「看起来还活着、其实已经死了」：
//   1) TCP 半开（NAT / 反向代理静默丢弃）—— 永远不再有字节，前端 readyState 仍是 OPEN；
//   2) getSnapshot 持续抛错 —— 只剩 event: error，再没有 data；
//   3) 解析失败 —— 浏览器 fail the connection，但前端不知道要重建。
// 用户看到的就是「页面不动了，刷新才有结果」。
//
// 这里用项目已有的「接管 request 处理器」模式（同 static.mjs / auth.mjs），
// 不改 node_modules：先摘掉原 handler，命中 /api/events 自己处理，其余原样转交。
const SNAPSHOT_TICK_MS = 300;
const HEARTBEAT_MS = 15000;
const ERROR_NOTICE_GAP_MS = 5000;
const MAX_FAIL_STREAK = 5;
/** 允许测试注入更快的心跳/快照节奏，生产用默认值。 */
function timingOf(options = {}) {
  return {
    tickMs: Number(options.tickMs ?? SNAPSHOT_TICK_MS),
    heartbeatMs: Number(options.heartbeatMs ?? HEARTBEAT_MS),
    errorNoticeGapMs: Number(options.errorNoticeGapMs ?? ERROR_NOTICE_GAP_MS),
    maxFailStreak: Number(options.maxFailStreak ?? MAX_FAIL_STREAK),
  };
}

/**
 * @param {import("node:http").Server} server
 * @param {{ getSnapshot: () => Promise<unknown> }} options
 */
export function installSseHeartbeat(server, { getSnapshot, ...rest }) {
  const timing = timingOf(rest);
  const handlers = server.listeners("request");
  server.removeAllListeners("request");
  server.on("request", (req, res) => {
    let pathname = "";
    try {
      pathname = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`).pathname;
    } catch {
      pathname = "";
    }
    if (req.method === "GET" && pathname === "/api/events") {
      openEventStream(req, res);
      return;
    }
    for (const handler of handlers) handler.call(server, req, res);
  });
  return server;

  function openEventStream(req, res) {
    res.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      // no-transform：别让中间层改编码，SSE 一旦被 gzip 缓冲就失去实时性
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      // nginx（DSM 反向代理）见到这个头就不做响应缓冲
      "X-Accel-Buffering": "no",
    });
    let closed = false;
    let lastJson = "";
    let failStreak = 0;
    let lastErrorNotice = 0;

    const stop = () => {
      if (closed) return;
      closed = true;
      clearInterval(tick);
      clearInterval(beat);
      try {
        res.end();
      } catch {
        // 连接已经没了，忽略
      }
    };
    const write = (chunk) => {
      if (closed) return false;
      try {
        res.write(chunk);
        return true;
      } catch {
        stop();
        return false;
      }
    };

    const tick = setInterval(async () => {
      if (closed) return;
      let snapshot;
      try {
        snapshot = await getSnapshot();
      } catch (error) {
        failStreak += 1;
        const now = Date.now();
        // 注释行不触发前端任何事件，只是留个痕迹 + 让连接不空闲
        if (now - lastErrorNotice > timing.errorNoticeGapMs) {
          lastErrorNotice = now;
          write(`: snapshot-error ${String(error?.message ?? error).slice(0, 200)}\n\n`);
        }
        // 一直拿不到快照：断开，让客户端重连一次拿干净状态；
        // 抱着一条永远推不出数据的连接对双方都是浪费。
        if (failStreak >= timing.maxFailStreak) stop();
        return;
      }
      if (closed) return;
      failStreak = 0;
      let json;
      try {
        json = JSON.stringify(snapshot);
      } catch {
        return;
      }
      if (json === lastJson) return;
      lastJson = json;
      write(`data: ${json}\n\n`);
    }, timing.tickMs);

    // 心跳：真实半开的连接会在写入时暴露出来，顺便让反代不判定空闲。
    const beat = setInterval(() => write(": ping\n\n"), timing.heartbeatMs);

    write(": connected\n\n");
    req.on("close", stop);
    req.on("aborted", stop);
    res.on("close", stop);
    res.on("error", stop);
  }
}
