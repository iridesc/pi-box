// 配置 IO + HTTP body 工具
import { readFile, writeFile } from "node:fs/promises";
import { DATA_DIR } from "./paths.mjs";
import { join } from "node:path";

const configPath = join(DATA_DIR, "config.json");

const DEFAULT_CONFIG = { provider: "openai", modelId: "gpt-4o", apiKey: "", baseUrl: "" };

export async function loadConfig() {
  try {
    return JSON.parse(await readFile(configPath, "utf-8"));
  } catch {
    return { ...DEFAULT_CONFIG };
  }
}

export async function saveConfig(cfg) {
  await writeFile(configPath, JSON.stringify(cfg, null, 2), "utf-8");
}

/** 读取 HTTP 请求体并 JSON 解析 */
export async function readBody(req) {
  let body = "";
  for await (const chunk of req) body += chunk;
  return JSON.parse(body || "{}");
}
