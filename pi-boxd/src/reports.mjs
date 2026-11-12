// 报告组存储层。
//
// 概念：报告组（group）= 一个审计任务/主题的容器，组内是「历次发布的报告」。
//      每次发布都是独立完整的文档，不是同一份文档的第 N 个版本。
//
// 目录布局（跟着项目 workspace 走，git / 备份 / 迁移都带走）：
//   <project>/.pi/reports/<group>/
//     .meta.json                 组元信息 + 报告索引
//     20261112-140000.md         每次发布一份（md 或 html）
//     20261112-140000.html
//
// 公开索引（DATA_DIR/reports-public.json）：
//   { "<publicSlug>": { "project": "p1", "group": "daily-audit" } }
//   /r/<slug> 是免认证入口，不知道 slug 属于哪个项目，靠这张表反查。
//   表丢了可以用 rebuildPublicIndex() 扫描重建（真相仍在各项目的 .meta.json 里）。
import { mkdir, readFile, readdir, rename, rm, stat, unlink, writeFile } from "node:fs/promises";
import { join, dirname, sep } from "node:path";
import { randomBytes } from "node:crypto";
import { DATA_DIR, PROJECTS_DIR, META_PROJECT } from "./paths.mjs";
import { fileError, projectRoot } from "./files.mjs";

const REPORTS_SUBDIR = ".pi/reports";
const PUBLIC_INDEX_FILE = "reports-public.json";

/** 单份报告上限。html 报告会把 js/css/图片全部内嵌，所以给得比 md 宽。 */
export const MAX_REPORT_BYTES = 20 * 1024 * 1024;
/** 单个报告组的报告份数上限（防止跑飞的定时任务把磁盘写满）。 */
export const MAX_REPORTS_PER_GROUP = 500;
/** 单个项目允许的报告组数量上限。 */
export const MAX_GROUPS_PER_PROJECT = 60;
/** 标题长度上限。 */
export const MAX_TITLE_CHARS = 200;
/** 保留期的全局上限。 */
export const MAX_RETENTION_DAYS = 365;
/** 保留期的全局默认值。报告比日志值钱，默认给 30 天。 */
export const DEFAULT_RETENTION_DAYS = clampRetentionDays(Number(process.env.PI_BOX_REPORT_RETENTION_DAYS ?? 30));

const GROUP_SLUG_RE = /^[a-z0-9][a-z0-9-]{0,40}$/;
const REPORT_STAMP_RE = /^\d{8}-\d{6}(?:-\d+)?$/;
const FORMATS = new Set(["md", "html"]);

/** 带 HTTP 状态码的错误，路由层直接映射成响应。 */
export function reportError(status, message) {
  return Object.assign(new Error(message), { status });
}

function clampRetentionDays(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 30;
  return Math.min(MAX_RETENTION_DAYS, Math.max(1, Math.round(n)));
}

/** 报告组 slug：小写字母/数字/短横线，2~41 字符。既做 URL 段也做目录名，必须严格。 */
export function normalizeGroupSlug(value) {
  const raw = String(value ?? "").trim().toLowerCase();
  if (!GROUP_SLUG_RE.test(raw)) {
    throw reportError(400, "报告组名只能用 2~41 个小写字母、数字或短横线（不能以短横线开头）");
  }
  return raw;
}

/** 报告 ID（时间戳，到秒；同秒重复发布时追加 -2 / -3 序号）。 */
export function normalizeReportStamp(value) {
  const raw = String(value ?? "").trim();
  if (!REPORT_STAMP_RE.test(raw)) throw reportError(400, "报告 ID 非法");
  return raw;
}

/** 生成报告 ID：本地时间 20261112-140000。 */
export function generateStamp(date = new Date()) {
  const pad = (n) => String(n).padStart(2, "0");
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
}

/** 公开链接用的不可猜测标识（22 个十六进制字符 ≈ 88bit）。 */
export function generatePublicSlug() {
  return randomBytes(11).toString("hex");
}

/** 全局策略：是否允许把任何报告设为公开。设 PI_BOX_REPORT_ALLOW_PUBLIC=0 可硬关闭。 */
export function publicAllowed() {
  return String(process.env.PI_BOX_REPORT_ALLOW_PUBLIC ?? "1") !== "0";
}

// ── 报告内容校验 ────────────────────────────────────────────────────────

/**
 * html 报告必须是「单文件自包含」：不允许引用外部 js/css/图片。
 * 不这样做的话，报告会变成同源页面的外部代码入口（CDN 被投毒即同源 RCE），
 * 而且外链图片会把访问者的 IP / Referer 泄漏给第三方。
 * 只检查「资源引用」类属性，正文里出现的普通 URL 文本不受影响。
 */
const EXTERNAL_RESOURCE = [
  // <script src> <link href> <img src|srcset> <iframe src> <video/audio/source> <object/embed> <use href>
  /<\s*(?:script|link|img|iframe|video|audio|source|object|embed|use|image)\b[^>]*\b(?:src|href|srcset|xlink:href)\s*=\s*["']?\s*(?:https?:)?\/\//gi,
  // <style> 或 style 属性里的 url(...)
  /\burl\(\s*["']?\s*(?:https?:)?\/\//gi,
  // @import "https://..."
  /@import\s+(?:url\()?["']?\s*(?:https?:)?\/\//gi,
];

/** 返回命中的外链片段（用于报错提示），空数组表示自包含。 */
export function findExternalResources(html) {
  const hits = [];
  for (const pattern of EXTERNAL_RESOURCE) {
    pattern.lastIndex = 0;
    for (const match of String(html).matchAll(pattern)) {
      hits.push(match[0].slice(0, 120).replace(/\s+/g, " "));
      if (hits.length >= 5) return hits;
    }
  }
  return hits;
}

// ── 敏感信息扫描（只在「转公开」时用，private 报告不拦） ────────────────

const SENSITIVE_RULES = [
  { kind: "私钥", pattern: /-----BEGIN (?:RSA |EC |OPENSSH |DSA |PGP )?PRIVATE KEY-----/g },
  {
    kind: "疑似凭据",
    pattern: /\b(?:password|passwd|pwd|secret|token|api[_-]?key|access[_-]?key|access[_-]?secret)\s*[:=]\s*\S{6,}/gi,
  },
  { kind: "内网 IP", pattern: /\b(?:10|172\.(?:1[6-9]|2\d|3[01])|192\.168)\.\d{1,3}\.\d{1,3}\b/g },
  { kind: "IP:端口", pattern: /\b\d{1,3}(?:\.\d{1,3}){3}:\d{2,5}\b/g },
];

/**
 * 扫描一组报告里的敏感内容。
 * 注意：private 报告本来就该含内网 IP（那是审计对象），所以这个函数只在
 * 「把组切换成 public」时调用，由人确认后才放行。
 * @returns {Promise<{total:number, items:{kind:string,count:number,sample:string,stamp:string}[]}>}
 */
export async function scanSensitive(project, slug) {
  const meta = await loadGroupMeta(project, slug);
  if (!meta) throw reportError(404, `报告组不存在：${slug}`);
  const items = [];
  let total = 0;
  await Promise.all(
    meta.reports.map(async (report) => {
      const content = await readReportContent(project, slug, report).catch(() => null);
      if (!content) return;
      for (const rule of SENSITIVE_RULES) {
        rule.pattern.lastIndex = 0;
        const matches = content.match(rule.pattern);
        if (!matches || matches.length === 0) continue;
        total += matches.length;
        items.push({
          kind: rule.kind,
          count: matches.length,
          sample: matches[0].slice(0, 80).replace(/\s+/g, " "),
          stamp: report.stamp,
        });
      }
    }),
  );
  // 同类合并：同一 kind 在多份报告里命中时合成一条，避免确认弹窗列几十行。
  const merged = new Map();
  for (const item of items) {
    const prev = merged.get(item.kind);
    if (prev) {
      prev.count += item.count;
      prev.stamps.push(item.stamp);
    } else {
      merged.set(item.kind, { kind: item.kind, count: item.count, sample: item.sample, stamps: [item.stamp] });
    }
  }
  return {
    total,
    items: [...merged.values()].map(({ kind, count, sample }) => ({ kind, count, sample })),
  };
}

// ── 路径 ────────────────────────────────────────────────────────────────

/** <project>/.pi/reports（项目根由 files.mjs 校验，含 meta 项目） */
export async function reportsRoot(project) {
  const root = await projectRoot(project);
  const dir = join(root, ".pi", "reports");
  // projectRoot 已经保证 root 合法；这里再兜一层，防止 slug 之外的意外穿越。
  if (dir !== join(root, ".pi", "reports")) throw reportError(400, "非法报告路径");
  return dir;
}

async function groupDir(project, slug) {
  const safe = normalizeGroupSlug(slug);
  const root = await reportsRoot(project);
  const dir = join(root, safe);
  if (dirname(dir) !== root || !dir.startsWith(root + sep)) throw reportError(400, "非法报告路径");
  return dir;
}

/** 报告内容文件路径（不含 .meta.json 索引）。 */
async function contentPath(project, slug, report) {
  const dir = await groupDir(project, slug);
  const stamp = normalizeReportStamp(report.stamp);
  const format = FORMATS.has(report.format) ? report.format : "md";
  return join(dir, `${stamp}.${format}`);
}

// ── 组元信息读写 ────────────────────────────────────────────────────────

function normalizeGroupMeta(raw, slug) {
  const reports = (Array.isArray(raw?.reports) ? raw.reports : [])
    .filter((item) => item && REPORT_STAMP_RE.test(String(item.stamp ?? "")))
    .map((item) => ({
      stamp: String(item.stamp),
      title: String(item.title ?? "").slice(0, MAX_TITLE_CHARS),
      agent: String(item.agent ?? "").slice(0, 80),
      format: FORMATS.has(item.format) ? item.format : "md",
      createdAt: String(item.createdAt ?? ""),
      bytes: Number.isFinite(item.bytes) ? item.bytes : 0,
    }))
    // 列表恒定按时间降序（最新在前），前端导航直接按下标算前后。
    .sort((a, b) => (a.stamp < b.stamp ? 1 : a.stamp > b.stamp ? -1 : 0));

  return {
    version: 1,
    slug,
    name: String(raw?.name ?? slug).slice(0, 120) || slug,
    visibility: raw?.visibility === "public" ? "public" : "private",
    publicSlug: typeof raw?.publicSlug === "string" && /^[0-9a-f]{16,64}$/.test(raw.publicSlug) ? raw.publicSlug : null,
    retentionDays: clampRetentionDays(raw?.retentionDays ?? DEFAULT_RETENTION_DAYS),
    createdAt: String(raw?.createdAt ?? ""),
    createdBy: String(raw?.createdBy ?? "human").slice(0, 80),
    reports,
  };
}

export async function loadGroupMeta(project, slug) {
  const dir = await groupDir(project, slug);
  try {
    const raw = JSON.parse(await readFile(join(dir, ".meta.json"), "utf-8"));
    return normalizeGroupMeta(raw, normalizeGroupSlug(slug));
  } catch (error) {
    if (error.code === "ENOENT" || error.code === "ENOTDIR") return null;
    if (error instanceof SyntaxError) return null;
    throw error;
  }
}

/** 原子写组元信息：临时文件 + rename，避免半截 JSON。 */
async function saveGroupMeta(project, slug, meta) {
  const dir = await groupDir(project, slug);
  await mkdir(dir, { recursive: true });
  const file = join(dir, ".meta.json");
  const temporary = `${file}.${process.pid}.tmp`;
  const body = `${JSON.stringify(normalizeGroupMeta(meta, normalizeGroupSlug(slug)), null, 2)}\n`;
  await writeFile(temporary, body, "utf-8");
  await rename(temporary, file);
}

// 组级写串行化：同一组的「读 meta → 改 → 写 meta」不能交叉，否则并发发布会丢索引。
const locks = new Map();
async function withGroupLock(key, fn) {
  const previous = locks.get(key) ?? Promise.resolve();
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  locks.set(key, previous.then(() => gate));
  await previous.catch(() => {});
  try {
    return await fn();
  } finally {
    release();
  }
}

// ── 公开索引 ────────────────────────────────────────────────────────────

function publicIndexPath() {
  return join(DATA_DIR, PUBLIC_INDEX_FILE);
}

export async function loadPublicIndex() {
  try {
    const raw = JSON.parse(await readFile(publicIndexPath(), "utf-8"));
    const entries = raw && typeof raw === "object" && raw.entries && typeof raw.entries === "object" ? raw.entries : {};
    const clean = {};
    for (const [slug, value] of Object.entries(entries)) {
      if (!/^[0-9a-f]{16,64}$/.test(slug)) continue;
      if (!value || typeof value !== "object") continue;
      if (typeof value.project !== "string" || typeof value.group !== "string") continue;
      clean[slug] = { project: value.project, group: value.group };
    }
    return clean;
  } catch {
    return {};
  }
}

async function savePublicIndex(entries) {
  await mkdir(DATA_DIR, { recursive: true });
  const file = publicIndexPath();
  const temporary = `${file}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify({ version: 1, entries }, null, 2)}\n`, "utf-8");
  await rename(temporary, file);
}

/** 公开 slug → { project, group }（不做存在性校验，调用方负责）。 */
export async function findPublicEntry(publicSlug) {
  if (typeof publicSlug !== "string" || !/^[0-9a-f]{16,64}$/.test(publicSlug)) return null;
  const index = await loadPublicIndex();
  return index[publicSlug] ?? null;
}

/**
 * 扫描所有项目的 .meta.json 重建公开索引。
 * 用于索引文件丢失 / 项目被外部改名后的修复。
 */
export async function rebuildPublicIndex() {
  const entries = {};
  const projects = await listAllProjects();
  for (const project of projects) {
    let metas = [];
    try {
      metas = await listGroups(project);
    } catch {
      continue;
    }
    for (const group of metas) {
      if (group.visibility === "public" && group.publicSlug) {
        entries[group.publicSlug] = { project, group: group.slug };
      }
    }
  }
  await savePublicIndex(entries);
  return entries;
}

async function listAllProjects() {
  try {
    const items = await readdir(PROJECTS_DIR, { withFileTypes: true });
    return items.filter((item) => item.isDirectory() && !item.name.startsWith(".")).map((item) => item.name);
  } catch {
    return [];
  }
}

/** 把某个 publicSlug 从索引里摘掉（删组 / 取消公开时调用）。 */
async function removePublicEntry(publicSlug) {
  if (!publicSlug) return;
  const index = await loadPublicIndex();
  if (!(publicSlug in index)) return;
  delete index[publicSlug];
  await savePublicIndex(index);
}

async function putPublicEntry(publicSlug, project, group) {
  const index = await loadPublicIndex();
  index[publicSlug] = { project, group };
  await savePublicIndex(index);
}

// ── 组 CRUD ─────────────────────────────────────────────────────────────

/** 列出项目下所有报告组（按最近发布降序，没发布过的按创建时间）。 */
export async function listGroups(project) {
  const root = await reportsRoot(project);
  let names = [];
  try {
    const items = await readdir(root, { withFileTypes: true });
    names = items.filter((item) => item.isDirectory() && GROUP_SLUG_RE.test(item.name)).map((item) => item.name);
  } catch (error) {
    if (error.code === "ENOENT") return [];
    throw error;
  }
  const groups = [];
  for (const slug of names) {
    const meta = await loadGroupMeta(project, slug).catch(() => null);
    if (!meta) continue;
    groups.push({
      slug: meta.slug,
      name: meta.name,
      visibility: meta.visibility,
      publicSlug: meta.publicSlug,
      retentionDays: meta.retentionDays,
      createdAt: meta.createdAt,
      reportCount: meta.reports.length,
      lastReportAt: meta.reports[0]?.createdAt ?? null,
      lastStamp: meta.reports[0]?.stamp ?? null,
    });
  }
  groups.sort((a, b) => String(b.lastReportAt ?? b.createdAt).localeCompare(String(a.lastReportAt ?? a.createdAt)));
  return groups;
}

/**
 * 建组。只能由人通过 UI 调用 —— agent 不能建组，
 * 这样 publish 到不存在的组会直接报错，而不是悄悄生成垃圾组。
 */
export async function createGroup(project, { name, slug, retentionDays, createdBy = "human" } = {}) {
  const root = await reportsRoot(project);
  const existing = await listGroups(project).catch(() => []);
  if (existing.length >= MAX_GROUPS_PER_PROJECT) {
    throw reportError(400, `单个项目最多 ${MAX_GROUPS_PER_PROJECT} 个报告组`);
  }
  // slug 缺省时从名称推导（中文名推导不出合法 slug 时会抛错，要求显式填）。
  const safeSlug = normalizeGroupSlug(slug ?? deriveSlug(name));
  const dir = await groupDir(project, safeSlug);
  const info = await stat(dir).catch(() => null);
  if (info) throw reportError(409, `报告组已存在：${safeSlug}`);
  const meta = normalizeGroupMeta(
    {
      name: name ?? safeSlug,
      retentionDays,
      createdAt: new Date().toISOString(),
      createdBy,
      reports: [],
    },
    safeSlug,
  );
  await mkdir(root, { recursive: true });
  await saveGroupMeta(project, safeSlug, meta);
  return meta;
}

/** 从中文名称尽量推导 slug；推不出来就要求调用方显式提供。 */
function deriveSlug(name) {
  const raw = String(name ?? "").trim().toLowerCase();
  const ascii = raw.replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  if (ascii) return ascii.slice(0, 41);
  throw reportError(400, "请为报告组指定一个英文 slug（字母/数字/短横线）");
}

/** 改名称或保留期。slug 不可改（它是目录名和 URL 段）。 */
export async function updateGroup(project, slug, patch = {}) {
  return withGroupLock(`${project}/${slug}`, async () => {
    const meta = await loadGroupMeta(project, slug);
    if (!meta) throw reportError(404, `报告组不存在：${slug}`);
    if (patch.name !== undefined) {
      const name = String(patch.name).trim().slice(0, 120);
      if (!name) throw reportError(400, "报告组名称不能为空");
      meta.name = name;
    }
    if (patch.retentionDays !== undefined) {
      const days = clampRetentionDays(patch.retentionDays);
      if (days > MAX_RETENTION_DAYS) throw reportError(400, `保留期最多 ${MAX_RETENTION_DAYS} 天`);
      meta.retentionDays = days;
    }
    await saveGroupMeta(project, slug, meta);
    return meta;
  });
}

/** 删除整组（含所有报告），并清理公开索引。 */
export async function deleteGroup(project, slug) {
  return withGroupLock(`${project}/${slug}`, async () => {
    const meta = await loadGroupMeta(project, slug);
    if (!meta) throw reportError(404, `报告组不存在：${slug}`);
    const dir = await groupDir(project, slug);
    await rm(dir, { recursive: true, force: true });
    await removePublicEntry(meta.publicSlug);
    return { slug, reportCount: meta.reports.length };
  });
}

/**
 * 切换组可见性。
 * public 时生成不可猜测的 publicSlug 并写入公开索引；private 时撤销。
 * 调用方（路由层）负责先跑 scanSensitive 并让人确认。
 */
export async function setGroupVisibility(project, slug, visibility) {
  const target = visibility === "public" ? "public" : "private";
  if (target === "public" && !publicAllowed()) {
    throw reportError(403, "当前部署已禁用报告公开（PI_BOX_REPORT_ALLOW_PUBLIC=0）");
  }
  return withGroupLock(`${project}/${slug}`, async () => {
    const meta = await loadGroupMeta(project, slug);
    if (!meta) throw reportError(404, `报告组不存在：${slug}`);
    if (target === "private") {
      await removePublicEntry(meta.publicSlug);
      meta.visibility = "private";
      meta.publicSlug = null;
    } else {
      meta.visibility = "public";
      if (!meta.publicSlug) meta.publicSlug = generatePublicSlug();
      await putPublicEntry(meta.publicSlug, project, slug);
    }
    await saveGroupMeta(project, slug, meta);
    return meta;
  });
}

// ── 报告 CRUD ───────────────────────────────────────────────────────────

/**
 * 发布一份报告。
 * @param {object} options
 * @param {string} options.agent   发布者（用于「只能删自己的」权限比对与审计）
 * @param {string} options.format  "md" | "html"
 * @param {string} options.content 报告正文
 * @param {string} [options.title] 标题，缺省用时间
 */
export async function publishReport(project, slug, { agent, title, format = "md", content } = {}) {
  const safeSlug = normalizeGroupSlug(slug);
  const body = String(content ?? "");
  if (!body.trim()) throw reportError(400, "报告内容不能为空");
  const safeFormat = String(format).toLowerCase();
  if (!FORMATS.has(safeFormat)) throw reportError(400, "报告格式只支持 md 或 html");
  const bytes = Buffer.byteLength(body, "utf-8");
  if (bytes > MAX_REPORT_BYTES) {
    throw reportError(413, `报告超过 ${Math.round(MAX_REPORT_BYTES / 1024 / 1024)}MB 上限，请拆分成多份`);
  }
  if (safeFormat === "html") {
    const external = findExternalResources(body);
    if (external.length > 0) {
      throw reportError(400, `html 报告必须单文件自包含（js/css/图片都要内嵌）。发现外部引用：${external.join(" ; ")}`);
    }
  }

  return withGroupLock(`${project}/${safeSlug}`, async () => {
    const meta = await loadGroupMeta(project, safeSlug);
    if (!meta) {
      // 故意不自动建组：拼错 slug 时要报错，而不是留下一堆空组。
      throw reportError(404, `报告组不存在：${safeSlug}（请先在界面上创建报告组）`);
    }
    if (meta.reports.length >= MAX_REPORTS_PER_GROUP) {
      throw reportError(400, `该报告组已有 ${MAX_REPORTS_PER_GROUP} 份报告，已超过上限，请先清理旧报告`);
    }
    const stamp = await uniqueStamp(project, safeSlug, meta);
    const dir = await groupDir(project, safeSlug);
    await mkdir(dir, { recursive: true });
    const file = join(dir, `${stamp}.${safeFormat}`);
    const temporary = `${file}.${process.pid}.tmp`;
    await writeFile(temporary, body, "utf-8");
    await rename(temporary, file);

    const now = new Date();
    const entry = {
      stamp,
      title: String(title ?? "").trim().slice(0, MAX_TITLE_CHARS) || defaultTitle(now),
      agent: String(agent ?? "").slice(0, 80),
      format: safeFormat,
      createdAt: now.toISOString(),
      bytes,
    };
    meta.reports.unshift(entry);
    meta.reports.sort((a, b) => (a.stamp < b.stamp ? 1 : a.stamp > b.stamp ? -1 : 0));
    await saveGroupMeta(project, safeSlug, meta);
    return { ...entry, group: meta.slug, visibility: meta.visibility, publicSlug: meta.publicSlug };
  });
}

function defaultTitle(date) {
  const pad = (n) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/** 同一秒重复发布时追加序号，保证不覆盖已有报告。 */
async function uniqueStamp(project, slug, meta) {
  const base = generateStamp();
  const used = new Set(meta.reports.map((item) => item.stamp));
  if (!used.has(base)) return base;
  for (let index = 2; index < 1000; index += 1) {
    const candidate = `${base}-${index}`;
    if (!used.has(candidate)) return candidate;
  }
  throw reportError(409, "同一秒内发布次数过多，请稍后重试");
}

/** 报告索引（不含正文）。 */
export async function listReports(project, slug) {
  const meta = await loadGroupMeta(project, slug);
  if (!meta) throw reportError(404, `报告组不存在：${slug}`);
  return { group: groupSummary(meta), reports: meta.reports };
}

function groupSummary(meta) {
  return {
    slug: meta.slug,
    name: meta.name,
    visibility: meta.visibility,
    publicSlug: meta.publicSlug,
    retentionDays: meta.retentionDays,
    reportCount: meta.reports.length,
  };
}

async function readReportContent(project, slug, report) {
  const file = await contentPath(project, slug, report);
  try {
    return await readFile(file, "utf-8");
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

/**
 * 读一份报告（含正文与前后导航）。
 * 导航语义：列表按时间降序，older = 更早一份（下标 +1），newer = 更新一份（下标 -1）。
 */
export async function readReport(project, slug, stamp) {
  const safeStamp = normalizeReportStamp(stamp);
  const meta = await loadGroupMeta(project, slug);
  if (!meta) throw reportError(404, `报告组不存在：${slug}`);
  const index = meta.reports.findIndex((item) => item.stamp === safeStamp);
  if (index < 0) throw reportError(404, `报告不存在：${safeStamp}`);
  const entry = meta.reports[index];
  const content = await readReportContent(project, slug, entry);
  if (content === null) {
    throw reportError(404, `报告内容文件缺失：${safeStamp}（可能被手工删除）`);
  }
  const older = meta.reports[index + 1];
  const newer = meta.reports[index - 1];
  const navItem = (item) => (item ? { stamp: item.stamp, title: item.title, createdAt: item.createdAt } : null);
  return {
    group: groupSummary(meta),
    report: { ...entry, content },
    nav: {
      index: index + 1,
      total: meta.reports.length,
      older: navItem(older),
      newer: navItem(newer),
    },
  };
}

/** 删除一份报告。agent 只能删自己发布的；人（agent 传空）可以删任意一份。 */
export async function deleteReport(project, slug, stamp, { agent } = {}) {
  const safeStamp = normalizeReportStamp(stamp);
  return withGroupLock(`${project}/${slug}`, async () => {
    const meta = await loadGroupMeta(project, slug);
    if (!meta) throw reportError(404, `报告组不存在：${slug}`);
    const index = meta.reports.findIndex((item) => item.stamp === safeStamp);
    if (index < 0) throw reportError(404, `报告不存在：${safeStamp}`);
    const entry = meta.reports[index];
    if (agent && entry.agent && entry.agent !== agent) {
      throw reportError(403, `这份报告由 ${entry.agent} 发布，不能由其她 agent 删除`);
    }
    const file = await contentPath(project, slug, entry);
    await unlink(file).catch((error) => {
      if (error.code !== "ENOENT") throw error;
    });
    meta.reports.splice(index, 1);
    await saveGroupMeta(project, slug, meta);
    return { stamp: safeStamp, title: entry.title };
  });
}

// ── 保留策略 ────────────────────────────────────────────────────────────

/**
 * 按保留期清理某组的历史报告。
 * 铁律：列表里最新的一份永不删除（否则阅读页的「最新」入口会悬空）。
 */
export async function pruneGroup(project, slug) {
  return withGroupLock(`${project}/${slug}`, async () => {
    const meta = await loadGroupMeta(project, slug);
    if (!meta) return { removed: 0, kept: 0 };
    const cutoff = Date.now() - meta.retentionDays * 86_400_000;
    const kept = [];
    const removed = [];
    meta.reports.forEach((entry, index) => {
      const at = Date.parse(entry.createdAt);
      const expired = Number.isFinite(at) && at < cutoff;
      if (index === 0 || !expired) kept.push(entry);
      else removed.push(entry);
    });
    if (removed.length === 0) return { removed: 0, kept: kept.length };
    for (const entry of removed) {
      const file = await contentPath(project, slug, entry);
      await unlink(file).catch((error) => {
        if (error.code !== "ENOENT") throw error;
      });
    }
    meta.reports = kept;
    await saveGroupMeta(project, slug, meta);
    return { removed: removed.length, kept: kept.length };
  });
}

/** 清理一个项目下所有报告组。 */
export async function pruneProjectReports(project) {
  const groups = await listGroups(project).catch(() => []);
  const result = { groups: 0, removed: 0 };
  for (const group of groups) {
    const outcome = await pruneGroup(project, group.slug).catch(() => null);
    if (!outcome) continue;
    result.groups += 1;
    result.removed += outcome.removed;
  }
  return result;
}

// ── 公开访问 ────────────────────────────────────────────────────────────

/**
 * 解析公开链接：slug → { project, group, meta }。
 * 索引里的条目会被校验：组必须仍存在、仍公开、publicSlug 必须仍然对得上。
 * 任何一项不符都当作 404（不泄露「这个链接曾经存在过」）。
 */
export async function resolvePublicGroup(publicSlug) {
  const entry = await findPublicEntry(publicSlug);
  if (!entry) return null;
  const meta = await loadGroupMeta(entry.project, entry.group).catch(() => null);
  if (!meta) return null;
  if (meta.visibility !== "public" || meta.publicSlug !== publicSlug) return null;
  return { project: entry.project, group: entry.group, meta };
}

/** 当前所有有效的 publicSlug（认证豁免判定用，服务端缓存后可避免每请求扫盘）。 */
export async function listPublicSlugs() {
  const index = await loadPublicIndex();
  const valid = {};
  for (const slug of Object.keys(index)) {
    const resolved = await resolvePublicGroup(slug).catch(() => null);
    if (resolved) valid[slug] = resolved;
  }
  return valid;
}

export { REPORTS_SUBDIR, META_PROJECT };