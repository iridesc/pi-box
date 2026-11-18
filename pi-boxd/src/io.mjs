// 配置 IO + HTTP body 工具
import { readFile, writeFile, mkdir, chmod } from "node:fs/promises";
import { DATA_DIR } from "./paths.mjs";
import { join, dirname } from "node:path";
import { homedir } from "node:os";

const configPath = join(DATA_DIR, "config.json");
// MCP server 配置保存在应用 HOME 下，随 agent-home 持久化。
const mcpPath = join(homedir(), ".pi", "agent", "mcp.json");
// UI 偏好
const prefsPath = join(DATA_DIR, "prefs.json");

const DEFAULT_CONFIG = { version: 3, activeProvider: "openai", providers: {} };

/** 把每个厂商的模型统一成 `models: string[]`（version 3）。旧版本只有单个 modelId。 */
function normalizeProviderEntry(entry) {
  if (!entry || typeof entry !== "object") return { apiKey: "", baseUrl: "", models: [] };
  const models = Array.isArray(entry.models) && entry.models.length > 0
    ? [...new Set(entry.models.map(String).filter(Boolean))]
    : (entry.modelId ? [String(entry.modelId)] : []);
  return { apiKey: entry.apiKey ?? "", baseUrl: entry.baseUrl ?? "", models };
}

function normalizeConfig(raw) {
  if (raw?.version === 3 && raw.providers && typeof raw.providers === "object") {
    return {
      version: 3,
      activeProvider: raw.activeProvider ?? "openai",
      providers: Object.fromEntries(
        Object.entries(raw.providers).map(([id, entry]) => [id, normalizeProviderEntry(entry)]),
      ),
    };
  }
  // version 2：每个厂商只有单个 modelId；version 1：只有 activeProvider + 单个 modelId。
  if (raw?.provider) {
    return {
      version: 3,
      activeProvider: raw.provider,
      providers: { [raw.provider]: normalizeProviderEntry({ modelId: raw.modelId, apiKey: raw.apiKey, baseUrl: raw.baseUrl }) },
    };
  }
  if (raw?.providers && typeof raw.providers === "object") {
    return {
      version: 3,
      activeProvider: raw.activeProvider ?? "openai",
      providers: Object.fromEntries(
        Object.entries(raw.providers).map(([id, entry]) => [id, normalizeProviderEntry(entry)]),
      ),
    };
  }
  return structuredClone(DEFAULT_CONFIG);
}

export async function loadConfig() {
  try {
    return normalizeConfig(JSON.parse(await readFile(configPath, "utf-8")));
  } catch {
    return structuredClone(DEFAULT_CONFIG);
  }
}

export async function saveConfig(cfg) {
  await mkdir(DATA_DIR, { recursive: true });
  await writeFile(configPath, JSON.stringify(cfg, null, 2), "utf-8");
  await chmod(configPath, 0o600);
}

/** 某个厂商的完整配置：provider + apiKey/baseUrl/models + 兼容的 modelId（首个模型）。 */
export function providerConfig(cfg, providerId) {
  const entry = cfg?.providers?.[providerId] ?? {};
  const models = Array.isArray(entry.models) ? entry.models.filter(Boolean) : [];
  return { provider: providerId, apiKey: entry.apiKey ?? "", baseUrl: entry.baseUrl ?? "", models, modelId: models[0] ?? "" };
}

/** 当前默认厂商的配置（全局模型的回退来源）。 */
export function activeProviderConfig(cfg) {
  return providerConfig(cfg, cfg.activeProvider ?? "openai");
}

/** 所有已配置 API Key 的厂商（按 key 是否非空过滤）。 */
export function configuredProviders(cfg) {
  return Object.keys(cfg?.providers ?? {}).filter((id) => !!cfg.providers[id]?.apiKey);
}

/** 读取 HTTP 请求体并 JSON 解析；可选 maxBytes 限制（超出时抛 code=PAYLOAD_TOO_LARGE） */
export async function readBody(req, maxBytes = 0) {
  let body = "";
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (maxBytes > 0 && size > maxBytes) {
      const error = new Error(`请求体超过 ${maxBytes} 字节`);
      error.code = "PAYLOAD_TOO_LARGE";
      throw error;
    }
    body += chunk;
  }
  if (!body.trim()) return {};
  try {
    const value = JSON.parse(body);
    return value && typeof value === "object" ? value : {};
  } catch {
    // 非法 JSON 不应打死整个进程：当成空对象，由各 handler 的必填校验返回 400。
    console.warn("[io] 请求体不是合法 JSON，已忽略：", body.slice(0, 200));
    return {};
  }
}

// ── MCP server 配置 ──────────────────────────────────────────────────────
export async function loadMcpConfig() {
  try {
    const raw = JSON.parse(await readFile(mcpPath, "utf-8"));
    if (raw && typeof raw === "object" && raw.mcpServers && typeof raw.mcpServers === "object") return raw;
    return { mcpServers: {} };
  } catch {
    return { mcpServers: {} };
  }
}

export async function saveMcpConfig(cfg) {
  await mkdir(dirname(mcpPath), { recursive: true });
  await writeFile(mcpPath, JSON.stringify(cfg, null, 2), "utf-8");
  await chmod(mcpPath, 0o600);
}

// ── UI 偏好 ─────────────────────────────────────────────────────────────
export const DEFAULT_PREFS = {
  theme: "dark",
  density: "comfortable",
  // 浏览器标签页标题
  appTitle: "pi-box · 多 Agent 平台",
  // 标签页图标：default（内置 svg）| emoji | upload（用户上传到 DATA_DIR/branding/）
  appIcon: { type: "default" },
  // agent 回复完成后是否弹浏览器通知（"off" | "hidden" | "always"）。
  // "hidden"：只在页面切到后台时提醒；"always"：不管在不在前台都提醒。
  browserNotify: "hidden",
  // 大图切块策略：targetPixels = 每块送进上下文的像素数（√它就是块的长边上限），
  // overlapRatio = 相邻块重叠比例，maxSlices = 块数上限（超了拿分辨率换块数）。
  imageTiles: { targetPixels: 2_458_624, overlapRatio: 0.15, maxSlices: 20 },
};
export const APP_TITLE_MAX = 120;
export const APP_ICON_EXTS = ["png", "jpg", "webp", "svg", "ico"];

/** 图标合法扩展名 → MIME */
export const APP_ICON_MIME = {
  png: "image/png",
  jpg: "image/jpeg",
  webp: "image/webp",
  svg: "image/svg+xml",
  ico: "image/x-icon",
};

function normalizeAppIcon(icon) {
  if (icon && typeof icon === "object") {
    if (icon.type === "emoji" && typeof icon.emoji === "string" && icon.emoji.trim()) {
      // 只取前若干个字符，避免超长文本塞进 favicon
      return { type: "emoji", emoji: [...icon.emoji.trim()].slice(0, 8).join("") };
    }
    if (icon.type === "upload" && APP_ICON_EXTS.includes(icon.ext) && Number.isFinite(icon.version)) {
      return { type: "upload", ext: icon.ext, version: Number(icon.version) };
    }
  }
  return { type: "default" };
}

/** 大图切块参数的取值范围。越界的一律夹回区间，不让手改的 prefs.json 写坏切片逻辑。 */
const IMAGE_TILE_LIMITS = Object.freeze({
  targetPixels: { min: 200_000, max: 16_000_000 },
  overlapRatio: { min: 0, max: 0.5 },
  maxSlices: { min: 1, max: 64 },
});

/** 切块参数：补齐默认值 + 夹范围 + 取整。 */
function normalizeImageTiles(raw) {
  const defaults = DEFAULT_PREFS.imageTiles;
  const merged = { ...defaults, ...(raw && typeof raw === "object" ? raw : {}) };
  const clamp = (value, key) => {
    const range = IMAGE_TILE_LIMITS[key];
    const number = Number(value);
    if (!Number.isFinite(number)) return defaults[key];
    return Math.min(range.max, Math.max(range.min, number));
  };
  return {
    targetPixels: Math.round(clamp(merged.targetPixels, "targetPixels")),
    overlapRatio: Math.round(clamp(merged.overlapRatio, "overlapRatio") * 1000) / 1000,
    maxSlices: Math.round(clamp(merged.maxSlices, "maxSlices")),
  };
}

/** 补齐默认值并做字段校验（写入与读取都走这里，保证 prefs.json 结构稳定） */
function normalizePrefs(raw) {
  const merged = { ...DEFAULT_PREFS, ...(raw && typeof raw === "object" ? raw : {}) };
  const title = typeof merged.appTitle === "string" ? merged.appTitle.trim() : "";
  merged.appTitle = title ? title.slice(0, APP_TITLE_MAX) : DEFAULT_PREFS.appTitle;
  merged.appIcon = normalizeAppIcon(merged.appIcon);
  if (!["off", "hidden", "always"].includes(merged.browserNotify)) merged.browserNotify = DEFAULT_PREFS.browserNotify;
  merged.imageTiles = normalizeImageTiles(merged.imageTiles);
  return merged;
}

export async function loadPrefs() {
  try {
    return normalizePrefs(JSON.parse(await readFile(prefsPath, "utf-8")));
  } catch {
    return normalizePrefs({});
  }
}
export async function savePrefs(p) {
  const normalized = normalizePrefs(p);
  await mkdir(DATA_DIR, { recursive: true });
  await writeFile(prefsPath, JSON.stringify(normalized, null, 2), "utf-8");
  return normalized;
}
