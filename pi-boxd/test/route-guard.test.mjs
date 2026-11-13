// guardErrors：任何 handler 异常都不能杀死进程。
// 背景：pi-durable-web 是 `return extra.handler(req, res)`，没有 try/catch。
// 未捕获异常 → unhandledRejection → Node 终止进程（线上真发生过：改会话名把服务打崩）。
import test from "node:test";
import assert from "node:assert/strict";
import { guardErrors } from "../src/routes.mjs";

function mockRes() {
  const res = {
    status: null, headers: null, body: "", ended: false, headersSent: false, writableEnded: false,
    writeHead(code, headers) {
      this.status = code; this.headers = headers; this.headersSent = true;
      return this;
    },
    end(chunk) {
      if (chunk !== undefined) this.body += chunk;
      this.ended = true; this.writableEnded = true;
      return this;
    },
  };
  return res;
}

test("handler 抛错 → 500 + JSON，不向外抛", async () => {
  const routes = guardErrors({
    "/boom": { method: "POST", async handler() { throw new Error("故意炸"); } },
  });
  const res = mockRes();
  await assert.doesNotReject(() => routes["/boom"].handler({}, res));
  assert.equal(res.status, 500);
  assert.equal(res.ended, true);
  assert.match(res.body, /故意炸/);
});

test("handler 正常返回 → 原样透传，不干预", async () => {
  const routes = guardErrors({
    "/ok": { method: "GET", async handler(_req, res) { res.writeHead(200); res.end("{}"); } },
  });
  const res = mockRes();
  await routes["/ok"].handler({}, res);
  assert.equal(res.status, 200);
  assert.equal(res.body, "{}");
});

test("响应已发送后再抛错 → 不重复写头、不二次 end", async () => {
  const routes = guardErrors({
    "/late": {
      method: "GET",
      async handler(_req, res) { res.writeHead(200); res.end("partial"); throw new Error("写完才炸"); },
    },
  });
  const res = mockRes();
  await assert.doesNotReject(() => routes["/late"].handler({}, res));
  assert.equal(res.status, 200, "不应改成 500");
  assert.equal(res.body, "partial", "不应二次写 body");
});

test("非函数 handler 的条目原样保留", () => {
  const routes = guardErrors({ "/plain": { method: "GET", note: "无 handler" } });
  assert.equal(routes["/plain"].handler, undefined);
  assert.equal(routes["/plain"].note, "无 handler");
});

test("多个路由都被包装（回归：漏包就等于没兜底）", async () => {
  const routes = guardErrors({
    "/a": { method: "GET", async handler() { throw new Error("a"); } },
    "/b": { method: "GET", async handler() { throw new Error("b"); } },
  });
  for (const path of ["/a", "/b"]) {
    const res = mockRes();
    await assert.doesNotReject(() => routes[path].handler({}, res));
    assert.equal(res.status, 500, `${path} 应被兜住`);
  }
});
