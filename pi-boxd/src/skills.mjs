// Skill 库：扫描 / 解析 / 校验 / 生效规则 / prompt 渲染 / 上传落盘
//
// 设计要点（与 agents.mjs 的加载链保持一致）：
//   内置库   /opt/pi-box/skills/<name>/SKILL.md          只读，镜像自带
//   用户库   ~/.pi/agent/skills/<name>/SKILL.md          上传落点，随 agent-home 持久化
//   项目库   <PROJECTS_DIR>/<project>/.pi/skills/<name>/  随项目走，同名覆盖用户/内置
//
// 文件只有一份，角色配置只存名字（frontmatter: skills: [a, b]）。
// system prompt 里只放 name / description / 绝对路径，正文由模型按需用 read 读取（懒加载）。
import { readdir, readFile, writeFile, mkdir, rm, stat, access } from "node:fs/promises";
import { basename, dirname, join, resolve, sep } from "node:path";
import { homedir } from "node:os";
import { PROJECTS_DIR, META_PROJECT } from "./paths.mjs";

/** Skill 正文只能通过 read / bash 加载；配置了 skill 却没有读取手段时，保存会被拒绝。 */
export const SKILL_READ_TOOL = "read";

export const BUILTIN_SKILLS_DIR =
  process.env.PI_BOX_BUILTIN_SKILLS_DIR ?? "/opt/pi-box/skills";
export const USER_SKILLS_DIR =
  process.env.PI_BOX_USER_SKILLS_DIR ?? join(homedir(), ".pi", "agent", "skills");

const MAX_NAME_LENGTH = 64;
const MAX_DESCRIPTION_LENGTH = 1024;
const MAX_SKILL_BYTES = 256 * 1024;
const MAX_TOTAL_BYTES = 1024 * 1024;
const MAX_FILES = 64;
const MAX_SCAN_DEPTH = 3;
/** 扫描结果短缓存：每个请求都会渲染 section，避免重复读盘；写入路径会主动失效。 */
const SCAN_TTL_MS = 1500;

const NAME_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const RELATIVE_PATH_RE = /^[A-Za-z0-9._/-]+$/;

/** 项目私有技能库目录（每个项目可自带 skill）。 */
export function projectSkillsDir(project) {
  if (!project || project === META_PROJECT) return null;
  return join(PROJECTS_DIR, project, ".pi", "skills");
}

// ── 解析 ────────────────────────────────────────────────────────────────

/** 解析 SKILL.md 的 frontmatter（name / description / enabled / disable-model-invocation）。 */
export function parseSkillFrontmatter(md) {
  const text = typeof md === "string" ? md : "";
  const m = text.match(/^---\r?\n([\s\S]*?)(?:\r?\n)?---(?:\r?\n)?([\s\S]*)$/);
  if (!m) return { name: null, description: null, enabled: null, disableModelInvocation: false, body: text.trim() };
  const fm = {};
  for (const line of m[1].split("\n")) {
    const kv = line.match(/^([\w-]+):\s*(.*)$/);
    if (kv) fm[kv[1].trim()] = kv[2].trim();
  }
  return {
    name: fm.name || null,
    description: fm.description || null,
    enabled: fm.enabled === undefined ? null : !/^false$/i.test(fm.enabled),
    disableModelInvocation: /^true$/i.test(fm["disable-model-invocation"] ?? ""),
    body: m[2].trim(),
  };
}

/** 校验 skill 名（Agent Skills 规范）：小写字母/数字/连字符，≤64 字符，无首尾或连续连字符。 */
export function validateSkillName(name) {
  if (typeof name !== "string" || name.length === 0) return "Skill 名不能为空";
  if (name.length > MAX_NAME_LENGTH) return `Skill 名超过 ${MAX_NAME_LENGTH} 字符`;
  if (!NAME_RE.test(name)) return "Skill 名只能含小写字母、数字、连字符，且不能以连字符开头/结尾或出现连续连字符";
  return null;
}

/** 校验 description：必填，≤1024 字符。 */
export function validateSkillDescription(description) {
  if (typeof description !== "string" || description.trim() === "") return "Skill 必须提供 description（模型靠它判断何时加载）";
  if (description.length > MAX_DESCRIPTION_LENGTH) return `description 超过 ${MAX_DESCRIPTION_LENGTH} 字符`;
  return null;
}

// ── 扫描 ────────────────────────────────────────────────────────────────

async function exists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

/** 递归收集含 SKILL.md 的目录；一个目录含 SKILL.md 即视为 skill 根，不再下钻。 */
async function findSkillDirs(dir, source, depth, out) {
  if (depth > MAX_SCAN_DEPTH) return;
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  if (entries.some((entry) => entry.isFile() && entry.name === "SKILL.md")) {
    out.push({ dir, source });
    return;
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    if (entry.name.startsWith(".") || entry.name === "node_modules") continue;
    await findSkillDirs(join(dir, entry.name), source, depth + 1, out);
  }
}

async function readSkillEntry({ dir, source }) {
  const name = basename(dir);
  const file = join(dir, "SKILL.md");
  const entry = {
    name,
    source,
    dir,
    file,
    declaredName: null,
    description: "",
    enabled: true,
    disableModelInvocation: false,
    error: null,
    bytes: 0,
    updatedAt: null,
  };
  let raw;
  try {
    raw = await readFile(file, "utf-8");
  } catch (error) {
    entry.error = error?.code === "ENOENT" ? "缺少 SKILL.md" : `无法读取 SKILL.md：${error.message}`;
    return entry;
  }
  entry.bytes = Buffer.byteLength(raw);
  try {
    const info = await stat(file);
    entry.updatedAt = new Date(info.mtimeMs).toISOString();
  } catch {
    /* 忽略 */
  }
  const meta = parseSkillFrontmatter(raw);
  entry.declaredName = meta.name;
  entry.description = meta.description ?? "";
  entry.disableModelInvocation = meta.disableModelInvocation;

  const nameError = validateSkillName(name);
  const descError = validateSkillDescription(entry.description);
  if (nameError) entry.error = nameError;
  else if (descError) entry.error = descError;
  if (meta.enabled === false) entry.enabled = false;
  return entry;
}

/** 全局闸门：用户库里的 .disabled 标记（UI 的"全局停用"）对任何来源都生效；skill 自身目录里的标记也认。 */
async function globallyDisabled(name, entry) {
  if (await exists(join(USER_SKILLS_DIR, name, ".disabled"))) return true;
  if (entry && (await exists(join(entry.dir, ".disabled")))) return true;
  return false;
}

let scanCache = { key: null, at: 0, value: null };

/** 清空扫描缓存（上传 / 删除 / 启停后调用，保证下一次请求立刻看到变化）。 */
export function invalidateSkillsCache() {
  scanCache = { key: null, at: 0, value: null };
}

/**
 * 扫描技能库：内置 → 用户 → 项目，同名后者覆盖前者。
 * 返回 [{ name, source, dir, file, description, enabled, error, ... }]
 */
export async function scanSkills({ project = null, fresh = false } = {}) {
  const key = project ?? "";
  const now = Date.now();
  if (!fresh && scanCache.key === key && now - scanCache.at < SCAN_TTL_MS) return scanCache.value;

  const roots = [{ dir: BUILTIN_SKILLS_DIR, source: "builtin" }, { dir: USER_SKILLS_DIR, source: "user" }];
  const projectDir = projectSkillsDir(project);
  if (projectDir) roots.push({ dir: projectDir, source: "project" });

  const byName = new Map();
  for (const root of roots) {
    const found = [];
    await findSkillDirs(root.dir, root.source, 0, found);
    for (const item of found) {
      const entry = await readSkillEntry(item);
      // 只有带 SKILL.md 的目录才算技能定义；纯标记目录（只有 .disabled）不覆盖已有定义。
      const previous = byName.get(entry.name);
      if (previous && entry.error === "缺少 SKILL.md") continue;
      byName.set(entry.name, entry);
    }
  }

  const value = [];
  for (const entry of byName.values()) {
    if (await globallyDisabled(entry.name, entry)) entry.enabled = false;
    value.push(entry);
  }
  value.sort((a, b) => a.name.localeCompare(b.name));
  scanCache = { key, at: now, value };
  return value;
}

/** 读取单个 skill（找不到返回 null）。 */
export async function loadSkill(name, project = null) {
  return (await scanSkills({ project })).find((entry) => entry.name === name) ?? null;
}

// ── 生效规则 ────────────────────────────────────────────────────────────

/**
 * 角色启用的 skill → 实际生效列表。
 * names 为 null / undefined / 空数组时：不启用任何 skill（上传一个 skill 不会自动对全部角色生效）。
 * 返回 { skills, missing, disabled, invalid }：
 *   missing  引用了不存在的 skill
 *   disabled 被全局停用
 *   invalid  定义非法（缺 description 等）
 */
export async function resolveSkills(names, project = null) {
  const list = Array.isArray(names) ? [...new Set(names.filter((name) => typeof name === "string" && name.trim()))] : [];
  if (list.length === 0) return { skills: [], missing: [], disabled: [], invalid: [] };
  const library = new Map((await scanSkills({ project })).map((entry) => [entry.name, entry]));
  const result = { skills: [], missing: [], disabled: [], invalid: [] };
  for (const name of list) {
    const entry = library.get(name);
    if (!entry) result.missing.push(name);
    else if (entry.error) result.invalid.push({ name, error: entry.error });
    else if (!entry.enabled) result.disabled.push(name);
    else result.skills.push(entry);
  }
  return result;
}

/** 一次请求里选中的读取工具：read 优先，其次 bash；都没有则 skill 无法加载。 */
export function skillReaderOf(tools) {
  const names = new Set((tools ?? []).map((tool) => tool.name ?? tool));
  if (names.has("read")) return "read";
  if (names.has("bash")) return "bash";
  return undefined;
}

/** 按 Agent Skills 规范渲染 `<available_skills>` 段；模型据此判断何时加载正文。 */
export function formatSkillsForPrompt(skills, fileReadTool = "read") {
  const visible = (skills ?? []).filter((skill) => !skill.disableModelInvocation);
  if (visible.length === 0) return "";
  const lines = [
    "\n\nThe following skills provide specialized instructions for specific tasks.",
    fileReadTool === "read"
      ? "Use the read tool to load a skill's file when the task matches its description."
      : fileReadTool === "bash"
        ? "Use bash to load a skill's file when the task matches its description."
        : "Load a skill's file when the task matches its description.",
    "When a skill file references a relative path, resolve it against the skill directory (parent of SKILL.md / dirname of the path) and use that absolute path in tool commands.",
    "",
    "<available_skills>",
  ];
  for (const skill of visible) {
    lines.push("  <skill>");
    lines.push(`    <name>${escapeXml(skill.name)}</name>`);
    lines.push(`    <description>${escapeXml(skill.description)}</description>`);
    lines.push(`    <location>${escapeXml(skill.file)}</location>`);
    lines.push("  </skill>");
  }
  lines.push("</available_skills>");
  return lines.join("\n");
}

function escapeXml(text) {
  return String(text ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

// ── 全局启停（对任何来源都生效的闸门） ──────────────────────────────────

export async function setSkillEnabled(name, enabled) {
  const nameError = validateSkillName(name);
  if (nameError) throw new Error(nameError);
  const marker = join(USER_SKILLS_DIR, name, ".disabled");
  if (enabled) {
    await rm(marker, { force: true });
  } else {
    await mkdir(join(USER_SKILLS_DIR, name), { recursive: true });
    await writeFile(marker, "disabled by pi-box UI\n", "utf-8");
  }
  invalidateSkillsCache();
}

// ── 上传 / 删除 ─────────────────────────────────────────────────────────

/** 上传时的相对路径校验：禁止绝对路径、`..`、空段和可疑字符。 */
export function normalizeSkillRelativePath(path) {
  const normalized = String(path ?? "").replace(/\\/g, "/").trim();
  if (!normalized) throw new Error("附加文件路径不能为空");
  if (normalized.startsWith("/")) throw new Error(`附加文件路径不能是绝对路径：${normalized}`);
  if (!RELATIVE_PATH_RE.test(normalized)) throw new Error(`附加文件路径含非法字符：${normalized}`);
  const segments = normalized.split("/");
  if (segments.some((segment) => segment === "" || segment === "." || segment === "..")) {
    throw new Error(`附加文件路径不能包含 . 或 ..：${normalized}`);
  }
  if (segments[0] === "SKILL.md") throw new Error("SKILL.md 请用 content 字段提交，不要放进 files");
  return segments.join("/");
}

/**
 * 安装 / 覆盖一个 skill 到用户库。
 * 入参：{ name?, content, files?: [{ path, content }], overwrite? }
 * 返回落盘后的 skill 条目。
 */
export async function installSkill({ name, content, files = [], overwrite = false } = {}) {
  if (typeof content !== "string" || content.trim() === "") throw new Error("SKILL.md 内容不能为空");
  if (Buffer.byteLength(content) > MAX_SKILL_BYTES) throw new Error(`SKILL.md 超过 ${MAX_SKILL_BYTES / 1024}KB`);

  const meta = parseSkillFrontmatter(content);
  const skillName = (name || meta.name || "").trim();
  const nameError = validateSkillName(skillName);
  if (nameError) throw new Error(nameError);
  if (meta.name && meta.name !== skillName) {
    throw new Error(`frontmatter 的 name（${meta.name}）与目录名（${skillName}）不一致，请统一后再上传`);
  }
  const descError = validateSkillDescription(meta.description);
  if (descError) throw new Error(descError);

  if (!Array.isArray(files)) throw new Error("files 必须是数组");
  if (files.length > MAX_FILES) throw new Error(`附加文件最多 ${MAX_FILES} 个`);
  const normalizedFiles = files.map((file) => ({
    path: normalizeSkillRelativePath(file?.path),
    content: String(file?.content ?? ""),
  }));
  const totalBytes = Buffer.byteLength(content) + normalizedFiles.reduce((sum, file) => sum + Buffer.byteLength(file.content), 0);
  if (totalBytes > MAX_TOTAL_BYTES) throw new Error(`整个 skill 超过 ${MAX_TOTAL_BYTES / 1024}KB`);
  for (const file of normalizedFiles) {
    if (Buffer.byteLength(file.content) > MAX_SKILL_BYTES) throw new Error(`${file.path} 超过 ${MAX_SKILL_BYTES / 1024}KB`);
  }

  const targetDir = join(USER_SKILLS_DIR, skillName);
  const existing = await loadSkill(skillName, null);
  if (existing && !overwrite) throw new Error(`Skill "${skillName}" 已存在（来源 ${existing.source}），如需替换请勾选覆盖`);
  if (existing && existing.source !== "user") {
    throw new Error(`Skill "${skillName}" 来自 ${existing.source}（只读），不能用同名用户 skill 覆盖；请换一个名字`);
  }

  await mkdir(targetDir, { recursive: true });
  for (const file of normalizedFiles) {
    const target = join(targetDir, ...file.path.split("/"));
    if (!resolve(target).startsWith(resolve(targetDir) + sep)) throw new Error(`附加文件路径越界：${file.path}`);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, file.content, "utf-8");
  }
  await writeFile(join(targetDir, "SKILL.md"), content, "utf-8");
  // 重新上传视为恢复启用：清掉旧的全局停用标记。
  await rm(join(targetDir, ".disabled"), { force: true });
  invalidateSkillsCache();

  const installed = await loadSkill(skillName, null);
  if (!installed) throw new Error("写入失败：重新扫描后找不到该 skill");
  return installed;
}

/** 删除用户库里的 skill（内置 / 项目来源不可通过 UI 删除）。 */
export async function removeSkill(name) {
  const nameError = validateSkillName(name);
  if (nameError) throw new Error(nameError);
  const entry = await loadSkill(name, null);
  if (!entry) throw new Error(`Skill "${name}" 不存在`);
  if (entry.source !== "user") throw new Error(`Skill "${name}" 来自 ${entry.source}，不能通过界面删除`);
  const targetDir = join(USER_SKILLS_DIR, name);
  if (!resolve(targetDir).startsWith(resolve(USER_SKILLS_DIR) + sep)) throw new Error("拒绝删除用户库之外的目录");
  await rm(targetDir, { recursive: true, force: true });
  invalidateSkillsCache();
}

// ── 引用关系 ────────────────────────────────────────────────────────────

/** 哪些角色引用了哪些 skill（删除前提示用）。返回 { [skillName]: [{ scope, name }] } */
export async function skillUsage(project) {
  const { listAgents, loadAssistant } = await import("./agents.mjs");
  const usage = {};
  const note = (names, actor) => {
    for (const name of names ?? []) (usage[name] ??= []).push(actor);
  };
  if (!project) return usage;
  try {
    note((await loadAssistant(project)).skills, { scope: "assistant", name: "助理" });
    for (const agent of await listAgents(project)) {
      note(agent.skills, { scope: agent.scope, name: agent.name });
    }
  } catch {
    /* 项目不可读时忽略 */
  }
  return usage;
}
