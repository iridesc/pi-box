// 配置 IO + HTTP body 工具
import { readFile, writeFile, mkdir, chmod } from "node:fs/promises";
import { DATA_DIR } from "./paths.mjs";
import { join } from "node:path";

const configPath = join(DATA_DIR, "config.json");

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
