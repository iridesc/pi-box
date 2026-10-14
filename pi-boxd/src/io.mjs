// 配置 IO + HTTP body 工具
import { readFile, writeFile, mkdir, chmod, readdir, rename, unlink } from "node:fs/promises";
import { DATA_DIR } from "./paths.mjs";
import { join, dirname, basename } from "node:path";
import { homedir } from "node:os";

const configPath = join(DATA_DIR, "config.json");
// MCP server 配置保存在应用 HOME 下，随 agent-home 持久化。
const mcpPath = join(homedir(), ".pi", "agent", "mcp.json");
// Skill 目录：内置位于 /opt/pi-box/skills，用户位于 ~/.pi/agent/skills/。
const userSkillsDir = join(homedir(), ".pi", "agent", "skills");
const builtinSkillsDir = "/opt/pi-box/skills";
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

// ── Skill 扫描 ──────────────────────────────────────────────────────────
async function listSkillsIn(dir, source) {
  try {
    const entries = await readdir(dir, { withFileTypes: true });
    const out = [];
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      const skillMd = join(dir, e.name, "SKILL.md");
      let enabled = true;
      let description = "";
      let body = "";
      try {
        const raw = await readFile(skillMd, "utf-8");
        body = raw;
        // 解析 frontmatter 里的 description + enabled
        const m = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
        if (m) {
          for (const line of m[1].split("\n")) {
            const kv = line.match(/^(\w+):\s*(.*)$/);
            if (!kv) continue;
            if (kv[1] === "description") description = kv[2].trim();
            if (kv[1] === "enabled" && kv[2].trim() === "false") enabled = false;
          }
        }
      } catch {
        // 没有 SKILL.md 也列出，只标 disabled
      }
      // 启禁用：读同名 .disabled 标记文件
      try {
        await readFile(join(dir, e.name, ".disabled"), "utf-8");
        enabled = false;
      } catch {}
      out.push({ name: e.name, source, enabled, description, hasSkillMd: body !== "" });
    }
    return out;
  } catch {
    return [];
  }
}

export async function listSkills() {
  const builtin = await listSkillsIn(builtinSkillsDir, "builtin");
  const user = await listSkillsIn(userSkillsDir, "user");
  // 用户 skill 覆盖内置的启禁用状态。
  const map = new Map();
  for (const s of builtin) map.set(s.name, s);
  for (const s of user) {
    const old = map.get(s.name);
    map.set(s.name, { ...s, description: s.description || old?.description || "", wasBuiltin: !!old });
  }
  return [...map.values()].sort((a, b) => a.name.localeCompare(b.name));
}

export async function setSkillEnabled(name, enabled) {
  const marker = join(userSkillsDir, name, ".disabled");
  if (enabled) {
    try { await unlink(marker); } catch {}
  } else {
    await mkdir(join(userSkillsDir, name), { recursive: true });
    await writeFile(marker, "disabled by pi-box UI\n", "utf-8");
  }
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
