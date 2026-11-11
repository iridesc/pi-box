// 静态资源优化中间件（P2-1）
// 之前 app.js / style.css / highlight.js 都是未压缩直出，也没有缓存头：
//   - 首屏要下载约 339KB（弱网下很慢）
//   - 每次刷新都要重新下载整包
// 这里统一处理：
//   - gzip 压缩（text/* 与 svg），app.js 160KB → 约 35KB
//   - ETag + If-None-Match → 未变更返回 304，不再传 body
//   - Cache-Control：vendor/favicon 用长缓存，页面代码用短缓存 + 必须校验
//     （页面文件名不带 hash，用 immutable 会导致发版后用户拿不到新版本）
import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { gzipSync } from "node:zlib";
import { join, extname, sep } from "node:path";

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
};
// 只压缩文本类资源；图片/字体已经压缩过，再压只会浪费 CPU。
const COMPRESSIBLE = new Set([
  "text/html; charset=utf-8",
  "text/javascript; charset=utf-8",
  "text/css; charset=utf-8",
  "image/svg+xml",
  "application/json; charset=utf-8",
]);
// 小于该体积不压缩：gzip 头 + CPU 开销不划算。
const MIN_COMPRESS_BYTES = 1024;

// 路径 → web 目录下的文件。vendor/ 前缀允许子目录，但禁止跳出 web 目录。
const STATIC_FILES = {
  "/": "index.html",
  "/index.html": "index.html",
  "/app.js": "app.js",
  "/style.css": "style.css",
  "/favicon.svg": "favicon.svg",
  // 与 routes.mjs 里的 vendor 路由保持一致的别名。
  "/vendor/hljs.js": "vendor/hljs/highlight.min.js",
  "/vendor/hljs.css": "vendor/hljs/github-dark.min.css",
};

/** 解析请求路径对应的静态文件绝对路径；不是静态资源则返回 null。 */
function resolveStaticFile(webDir, pathname) {
  if (STATIC_FILES[pathname]) return join(webDir, STATIC_FILES[pathname]);
  if (!pathname.startsWith("/vendor/")) return null;
  const relative = decodeURIComponent(pathname.slice("/vendor/".length));
  // 目录穿越防护：不允许 .. 与绝对路径。
  if (!relative || relative.includes("..") || relative.includes("\0")) return null;
  const vendorRoot = join(webDir, "vendor");
  const absolute = join(vendorRoot, relative);
  if (absolute !== vendorRoot && !absolute.startsWith(vendorRoot + sep)) return null;
  return absolute;
}

/** 缓存策略：第三方 vendor 与图标内容稳定，用长缓存；页面代码需要及时更新。 */
function cacheControlFor(pathname) {
  if (pathname.startsWith("/vendor/") || pathname === "/favicon.svg") {
    return "public, max-age=604800, immutable";
  }
  return "public, max-age=300, must-revalidate";
}

/**
 * 在现有 Node HTTP server 上安装静态资源优化层。
 * 静态资源命中时直接响应并结束请求；其余请求交给原有 handler。
 */
export function installStaticOptimizer(server, { webDir }) {
  const handlers = server.listeners("request");
  server.removeAllListeners("request");
  // path -> { body, gzip, etag, mime, cacheControl }；文件内容变更后由 mtime 判定失效。
  const fileCache = new Map();

  const loadFile = async (absolute, pathname) => {
    const entry = fileCache.get(absolute);
    const body = await readFile(absolute);
    const etag = `"${createHash("sha1").update(body).digest("base64url")}"`;
    if (entry && entry.etag === etag) return entry;
    const mime = MIME[extname(absolute).toLowerCase()] ?? "application/octet-stream";
    const compressible = COMPRESSIBLE.has(mime) && body.length >= MIN_COMPRESS_BYTES;
    const next = {
      body,
      mime,
      etag,
      gzip: compressible ? gzipSync(body, { level: 6 }) : null,
      cacheControl: cacheControlFor(pathname),
    };
    fileCache.set(absolute, next);
    return next;
  };

  server.on("request", async (req, res) => {
    if (req.method !== "GET" && req.method !== "HEAD") {
      for (const handler of handlers) handler.call(server, req, res);
      return;
    }
    const pathname = new URL(req.url ?? "/", "http://localhost").pathname;
    const absolute = resolveStaticFile(webDir, pathname);
    if (!absolute) {
      for (const handler of handlers) handler.call(server, req, res);
      return;
    }
    try {
      const file = await loadFile(absolute, pathname);
      const acceptsGzip = /\bgzip\b/.test(req.headers["accept-encoding"] ?? "");
      // 未变更：直接 304，不传 body。
      if (req.headers["if-none-match"] === file.etag) {
        res.writeHead(304, {
          ETag: file.etag,
          "Cache-Control": file.cacheControl,
          "Content-Length": "0",
        });
        res.end();
        return;
      }
      const useGzip = acceptsGzip && file.gzip !== null;
      const payload = useGzip ? file.gzip : file.body;
      const headers = {
        "Content-Type": file.mime,
        "Content-Length": String(payload.length),
        ETag: file.etag,
        "Cache-Control": file.cacheControl,
        Vary: "Accept-Encoding",
      };
      if (useGzip) headers["Content-Encoding"] = "gzip";
      res.writeHead(200, headers);
      if (req.method === "HEAD") res.end();
      else res.end(payload);
    } catch {
      // 文件不存在或读取失败：交给原有 handler（可能返回 404 或其它响应）。
      for (const handler of handlers) handler.call(server, req, res);
    }
  });
  return { installed: true };
}
