// 报告阅读页与公开访问路由。
//
// 为什么不用 extraRoutes：pi-durable-web 的 extraRoutes 是「精确路径 + query 传参」，
// 而公开链接必须是 /r/<slug>/<stamp> 这种路径形态（要能贴到群里、被抓取），
// 所以这里用和 static.mjs 相同的手法前置拦截请求。
//
// 认证布局（index.mjs 里的安装顺序）：
//   core → staticOptimizer → reportPages → basicAuth（最外层）
// 所以 basicAuth 必须在豁免 /r/* 之前判断，reportPages 才能收到请求。
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { listReports, readReport, resolvePublicGroup } from "./reports.mjs";

const STAMP_RE = /^\d{8}-\d{6}(?:-\d+)?$/;

/** 报告内容的响应头。
 *
 * sandbox 是核心：让报告文档进入 opaque origin（读不到 cookie / localStorage，
 * fetch 同源会因 CORS 失败），connect-src 'none' 再把外泄通道彻底关死。
 * 绝对不能加 allow-same-origin —— 加了等于没沙箱（文档可以自己把 sandbox 摘掉）。
 *
 * script-src 'unsafe-inline' 是故意的：报告是单文件自包含，js 必须内联；
 * 这同时天然禁掉外部 <script src>（供应链风险）。
 */
function contentHeaders(format) {
  const html = format === "html";
  return {
    "Content-Type": html ? "text/html; charset=utf-8" : "text/plain; charset=utf-8",
    "Content-Security-Policy": html
      ? "sandbox allow-scripts; default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; font-src data:; connect-src 'none'; form-action 'none'; base-uri 'none'; frame-ancestors 'self'"
      : "default-src 'none'; style-src 'unsafe-inline'; img-src data: blob:; connect-src 'none'; form-action 'none'; base-uri 'none'",
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "SAMEORIGIN",
    "Referrer-Policy": "no-referrer",
    // 公开报告不该被搜索引擎收录，否则等于把内部审计结论主动曝光出去。
    "X-Robots-Tag": "noindex, nofollow",
    "Cache-Control": "private, no-store",
  };
}

function pathnameOf(url) {
  try {
    return new URL(url ?? "/", "http://localhost").pathname;
  } catch {
    return "/";
  }
}

/** 免认证判定：只认 /r 前缀。注意不能用 startsWith("/r")，那会误伤 /reports。 */
export function isPublicReportRequest(req) {
  const pathname = pathnameOf(req.url);
  return pathname === "/r" || pathname.startsWith("/r/");
}

function sendJson(res, status, payload) {
  res.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store" });
  res.end(JSON.stringify(payload));
}

function notFound(res) {
  res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" });
  res.end("not found");
}

async function sendIndex(res, webDir, method) {
  let body;
  try {
    body = await readFile(join(webDir, "index.html"));
  } catch {
    res.writeHead(500, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("index.html 缺失");
    return;
  }
  res.writeHead(200, {
    "Content-Type": "text/html; charset=utf-8",
    "Content-Length": String(body.length),
    // 阅读页会随报告变化，不能长缓存；但也不需要 no-store（用户后退时体验更好）。
    "Cache-Control": "no-cache",
    "X-Content-Type-Options": "nosniff",
  });
  if (method === "HEAD") res.end();
  else res.end(body);
}

/**
 * /r/<slug>[/<stamp>][/data|/content]
 * 只支持这几种形态，其余一律 404 —— 公开入口越窄越安全。
 */
async function handlePublic(req, res, pathname, webDir) {
  // ["r", slug, ...rest]
  const parts = pathname.split("/").filter(Boolean);
  if (parts.length < 2) return notFound(res);
  const slug = parts[1];
  if (!/^[0-9a-f]{16,64}$/.test(slug)) return notFound(res);

  const resolved = await resolvePublicGroup(slug);
  if (!resolved) return notFound(res);

  const rest = parts.slice(2);
  let stamp = null;
  let action = "page";
  if (rest.length === 1) {
    if (STAMP_RE.test(rest[0])) stamp = rest[0];
    else if (rest[0] === "data" || rest[0] === "content" || rest[0] === "list") action = rest[0];
    else return notFound(res);
  } else if (rest.length === 2) {
    if (!STAMP_RE.test(rest[0])) return notFound(res);
    if (rest[1] !== "data" && rest[1] !== "content") return notFound(res);
    stamp = rest[0];
    action = rest[1];
  } else if (rest.length > 2) {
    return notFound(res);
  }

  const { project, group, meta } = resolved;

  if (action === "page") return sendIndex(res, webDir, req.method);

  // 公开页的完整报告列表（阅读页的 FAB 面板用）
  if (action === "list") {
    const listed = await listReports(project, group);
    return sendJson(res, 200, {
      group: { slug: meta.slug, name: meta.name, visibility: meta.visibility },
      reports: listed.reports.map(({ stamp: id, title, createdAt, format }) => ({ stamp: id, title, createdAt, format })),
    });
  }

  // 未指定 stamp 时取最新一份
  const target = stamp ?? meta.reports[0]?.stamp;
  if (!target) {
    const message = "这个报告组还没有任何报告。";
    res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" });
    return res.end(message);
  }

  const detail = await readReport(project, group, target).catch(() => null);
  if (!detail) return notFound(res);

  if (action === "data") {
    return sendJson(res, 200, {
      publicSlug: slug,
      group: { slug: meta.slug, name: meta.name, visibility: meta.visibility },
      report: { ...detail.report, content: undefined },
      nav: detail.nav,
      content: detail.report.content,
      // 公开页没有"设为公开/删除"等操作
      readOnly: true,
    });
  }

  const headers = contentHeaders(detail.report.format);
  const body = Buffer.from(detail.report.content, "utf-8");
  res.writeHead(200, { ...headers, "Content-Length": String(body.length) });
  if (req.method === "HEAD") res.end();
  else res.end(body);
}

/**
 * 安装报告页面路由。
 * @param {import("node:http").Server} server
 * @param {{ webDir: string }} options
 */
export function installReportPages(server, { webDir }) {
  const handlers = server.listeners("request");
  server.removeAllListeners("request");

  server.on("request", async (req, res) => {
    const pathname = pathnameOf(req.url);
    const isPage = pathname === "/reports" || pathname.startsWith("/reports/");
    const isPublic = pathname === "/r" || pathname.startsWith("/r/");
    if (!isPage && !isPublic) {
      for (const handler of handlers) handler.call(server, req, res);
      return;
    }
    if (req.method !== "GET" && req.method !== "HEAD") {
      res.writeHead(405, { "Content-Type": "text/plain; charset=utf-8", Allow: "GET, HEAD" });
      res.end("报告接口只支持 GET");
      return;
    }
    try {
      // 内侧阅读页：/reports?project=&group=&stamp=（由前端按 query 渲染）
      if (isPage) return await sendIndex(res, webDir, req.method);
      return await handlePublic(req, res, pathname, webDir);
    } catch (error) {
      console.error("[reports] 页面路由失败:", error?.message ?? error);
      res.writeHead(500, { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" });
      res.end("报告读取失败");
    }
  });
  return { installed: true };
}

/** 内侧内容直出（/api/reports/content 用），带同一套 CSP。 */
export async function sendReportContent(res, { project, group, stamp, method }) {
  const detail = await readReport(project, group, stamp);
  const headers = contentHeaders(detail.report.format);
  const body = Buffer.from(detail.report.content, "utf-8");
  res.writeHead(200, { ...headers, "Content-Length": String(body.length) });
  if (method === "HEAD") res.end();
  else res.end(body);
}

export { contentHeaders };