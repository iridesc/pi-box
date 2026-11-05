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
  return JSON.parse(body || "{}");
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

/** 补齐默认值并做字段校验（写入与读取都走这里，保证 prefs.json 结构稳定） */
function normalizePrefs(raw) {
  const merged = { ...DEFAULT_PREFS, ...(raw && typeof raw === "object" ? raw : {}) };
  const title = typeof merged.appTitle === "string" ? merged.appTitle.trim() : "";
  merged.appTitle = title ? title.slice(0, APP_TITLE_MAX) : DEFAULT_PREFS.appTitle;
  merged.appIcon = normalizeAppIcon(merged.appIcon);
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
