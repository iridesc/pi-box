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

/** 读取 HTTP 请求体并 JSON 解析 */
export async function readBody(req) {
  let body = "";
  for await (const chunk of req) body += chunk;
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
const DEFAULT_PREFS = { theme: "dark", density: "comfortable" };
export async function loadPrefs() {
  try {
    return { ...DEFAULT_PREFS, ...JSON.parse(await readFile(prefsPath, "utf-8")) };
  } catch {
    return { ...DEFAULT_PREFS };
  }
}
export async function savePrefs(p) {
  await mkdir(DATA_DIR, { recursive: true });
  await writeFile(prefsPath, JSON.stringify(p, null, 2), "utf-8");
}
