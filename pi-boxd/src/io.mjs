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

const DEFAULT_CONFIG = { version: 2, activeProvider: "openai", providers: {} };

function normalizeConfig(raw) {
  if (raw?.version === 2 && raw.providers) return raw;
  if (raw?.provider) {
    return {
      version: 2,
      activeProvider: raw.provider,
      providers: { [raw.provider]: { modelId: raw.modelId ?? "", apiKey: raw.apiKey ?? "", baseUrl: raw.baseUrl ?? "" } },
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

export function activeProviderConfig(cfg) {
  const provider = cfg.activeProvider ?? "openai";
  return { provider, ...(cfg.providers?.[provider] ?? {}) };
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
