// SSE 加固单测：心跳 / 变化才推 / 快照报错降级为注释 / 连续失败自断 / 其它请求原样转交
import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { installSseHeartbeat } from "../src/sse.mjs";

function listen(server) {
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server.address().port)));
}

/** 读若干毫秒的原始响应体，然后主动断开。 */
async function readFor(port, ms) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  let body = "";
  try {
    const response = await fetch(`http://127.0.0.1:${port}/api/events`, { signal: controller.signal });
    assert.equal(response.status, 200);
    assert.match(String(response.headers.get("content-type")), /text\/event-stream/);
    assert.equal(response.headers.get("x-accel-buffering"), "no");
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      body += decoder.decode(value, { stream: true });
    }
  } catch (error) {
    if (error.name !== "AbortError") throw error;
  } finally {
    clearTimeout(timer);
    controller.abort();
  }
  return body;
}

async function withServer(options, fn) {
  const server = createServer((req, res) => {
    res.writeHead(200, { "Content-Type": "text/plain" });
    res.end(`fallthrough:${req.url}`);
  });
  installSseHeartbeat(server, options);
  const port = await listen(server);
  try {
    await fn(port);
  } finally {
    server.closeAllConnections?.();
    await new Promise((resolve) => server.close(resolve));
  }
}

test("非 /api/events 请求原样转交给原处理器", async () => {
  await withServer({ getSnapshot: async () => ({ ok: 1 }) }, async (port) => {
    const response = await fetch(`http://127.0.0.1:${port}/api/state`);
    assert.equal(await response.text(), "fallthrough:/api/state");
  });
});

test("建立即写 : connected 并带上抗缓冲响应头", async () => {
  await withServer({ getSnapshot: async () => ({ n: 1 }), tickMs: 5000, heartbeatMs: 5000 }, async (port) => {
    const body = await readFor(port, 250);
    assert.match(body, /^: connected\n\n/);
  });
});

test("快照变化推 data，不变不重复推", async () => {
  let n = 0;
  await withServer(
    { getSnapshot: async () => ({ n: ++n > 2 ? 2 : n }), tickMs: 30, heartbeatMs: 60_000 },
    async (port) => {
      const body = await readFor(port, 400);
      const events = body.split("\n\n").filter((part) => part.startsWith("data: "));
      // n 依次是 1 / 2 / 2 / 2 …，只该推两条
      assert.equal(events.length, 2);
      assert.deepEqual(events.map((e) => JSON.parse(e.slice(6))), [{ n: 1 }, { n: 2 }]);
    },
  );
});

test("心跳按间隔写入（连接不空闲）", async () => {
  await withServer({ getSnapshot: async () => ({ n: 1 }), tickMs: 5000, heartbeatMs: 40 }, async (port) => {
    const body = await readFor(port, 300);
    const pings = body.match(/: ping\n\n/g) ?? [];
    assert.ok(pings.length >= 3, `应至少 3 次心跳，实际 ${pings.length}`);
  });
});

test("快照报错写成注释，绝不发 event: error（那会让前端误判断线）", async () => {
  await withServer(
    {
      getSnapshot: async () => {
        throw new Error("db locked");
      },
      tickMs: 20,
      heartbeatMs: 60_000,
      errorNoticeGapMs: 10_000,
      maxFailStreak: 100,
    },
    async (port) => {
      const body = await readFor(port, 300);
      assert.doesNotMatch(body, /event: ?error/);
      assert.match(body, /: snapshot-error db locked/);
      // 限频：300ms 内最多一条
      assert.equal((body.match(/snapshot-error/g) ?? []).length, 1);
    },
  );
});

test("连续取快照失败达到阈值就断开连接，让客户端重连", async () => {
  await withServer(
    {
      getSnapshot: async () => {
        throw new Error("always");
      },
      tickMs: 20,
      heartbeatMs: 60_000,
      errorNoticeGapMs: 10_000,
      maxFailStreak: 3,
    },
    async (port) => {
      // 服务端主动 end 之后 readFor 会自然结束（不会等到超时）
      const started = Date.now();
      await readFor(port, 2000);
      assert.ok(Date.now() - started < 1800, "应在连续失败后主动关闭，而不是一直挂着");
    },
  );
});

test("恢复后继续推送：一次失败不会毒化连接", async () => {
  let calls = 0;
  await withServer(
    {
      getSnapshot: async () => {
        calls += 1;
        if (calls === 2) throw new Error("transient");
        return { calls };
      },
      tickMs: 20,
      heartbeatMs: 60_000,
      errorNoticeGapMs: 10_000,
      maxFailStreak: 100,
    },
    async (port) => {
      const body = await readFor(port, 350);
      assert.match(body, /: snapshot-error transient/);
      assert.ok((body.match(/^data: /gm) ?? []).length >= 2, "报错之后应继续推快照");
    },
  );
});
