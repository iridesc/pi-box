// 静态资源优化中间件测试：gzip / ETag / 304 / Cache-Control / 目录穿越防护
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { installStaticOptimizer } from "../src/static.mjs";

const _srcDir = dirname(fileURLToPath(import.meta.url));
const WEB_DIR = join(dirname(_srcDir), "web");

/** 启动一个只带静态优化层的测试服务器。 */
async function startServer() {
  const server = createServer((req, res) => {
    res.writeHead(200, { "Content-Type": "text/plain" });
    res.end("fallback");
  });
  installStaticOptimizer(server, { webDir: WEB_DIR });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  return { server, base };
}

test("app.js 支持 gzip 且体积显著变小", async () => {
  const { server, base } = await startServer();
  try {
    const res = await fetch(`${base}/app.js`, { headers: { "Accept-Encoding": "gzip" } });
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("content-encoding"), "gzip");
    assert.ok(res.headers.get("etag"), "应带 ETag");
    assert.match(res.headers.get("cache-control") ?? "", /max-age=300/);
    assert.match(res.headers.get("vary") ?? "", /Accept-Encoding/);
    const raw = await fetch(`${base}/app.js`, { headers: { "Accept-Encoding": "identity" } });
    const rawLen = Number(raw.headers.get("content-length"));
    const gzLen = Number(res.headers.get("content-length"));
    assert.ok(gzLen < rawLen / 2, `gzip 后应明显更小：${gzLen} vs ${rawLen}`);
    assert.ok(rawLen > 100_000, `app.js 原始体积应大于 100KB，实际 ${rawLen}`);
  } finally {
    server.close();
  }
});

test("客户端不支持 gzip 时返回原始内容", async () => {
  const { server, base } = await startServer();
  try {
    const res = await fetch(`${base}/app.js`, { headers: { "Accept-Encoding": "identity" } });
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("content-encoding"), null);
    const text = await res.text();
    assert.ok(text.includes("pi-boxd 前端"), "应返回未压缩的源码");
  } finally {
    server.close();
  }
});

test("If-None-Match 命中返回 304 且无 body", async () => {
  const { server, base } = await startServer();
  try {
    const first = await fetch(`${base}/style.css`);
    const etag = first.headers.get("etag");
    assert.ok(etag);
    const second = await fetch(`${base}/style.css`, { headers: { "If-None-Match": etag } });
    assert.equal(second.status, 304);
    assert.equal(second.headers.get("content-length"), "0");
    assert.equal(await second.text(), "");
  } finally {
    server.close();
  }
});

test("vendor 资源走长缓存且不可变", async () => {
  const { server, base } = await startServer();
  try {
    const res = await fetch(`${base}/vendor/hljs.js`, { headers: { "Accept-Encoding": "gzip" } });
    assert.equal(res.status, 200);
    assert.match(res.headers.get("cache-control") ?? "", /max-age=604800/);
    assert.match(res.headers.get("cache-control") ?? "", /immutable/);
  } finally {
    server.close();
  }
});

test("未知路径回落到原 handler", async () => {
  const { server, base } = await startServer();
  try {
    const res = await fetch(`${base}/api/state`);
    assert.equal(res.status, 200);
    assert.equal(await res.text(), "fallback");
  } finally {
    server.close();
  }
});

test("目录穿越被拒绝并回落", async () => {
  const { server, base } = await startServer();
  try {
    for (const p of ["/vendor/../src/index.mjs", "/vendor/%2e%2e/src/index.mjs"]) {
      const res = await fetch(`${base}${p}`);
      assert.equal(res.status, 200, `${p} 不应命中静态层`);
      assert.equal(await res.text(), "fallback");
    }
  } finally {
    server.close();
  }
});
