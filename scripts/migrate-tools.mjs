#!/usr/bin/env node
// 工具配置迁移：把「隐式默认」变成「显式列表」。
//
// 背景：旧模型里 tools 字段缺失 = registry 全部工具（含 report_* / codemode / MCP）。
// 新模型里缺失 = 零工具。升级前必须把老配置的实际生效集写进文件，否则全线失能。
//
// 用法：
//   node scripts/migrate-tools.mjs --dry-run   # 只打印 diff（默认行为）
//   node scripts/migrate-tools.mjs --write     # 落盘，自动备份 .bak-YYYYMMDD
//
// 迁移规则（保守，只补不减）：
//   1. tools 缺失 → 显式写入内置 4 个（read/write/edit/bash）
//   2. reports 非空但没 report_* → 补 report_publish / report_list / report_read
//      （report_delete 不给，删报告不该是常态能力）
//   3. tools 已显式存在 → 只做第 2 条补齐，不改动已有项
//   4. 不写 subagent：助理由后端强制注入，写进文件反而会污染配置
import { readdir, readFile, writeFile, copyFile, stat } from "node:fs/promises";
import { join } from "node:path";

const {
  WORKSPACE,
  PROJECTS_DIR,
  GLOBAL_AGENTS_DIR,
  META_AGENTS_DIR,
  META_DIR,
} = await import("../pi-boxd/src/paths.mjs");
const { parseAgentDef, serializeAgentDef } = await import("../pi-boxd/src/agents.mjs");

const WRITE = process.argv.includes("--write");
const BUILTIN = ["read", "write", "edit", "bash"];
const REPORT_TOOLS = ["report_publish", "report_list", "report_read"];

const stamp = new Date().toISOString().slice(0, 10).replace(/-/g, "");

async function readIfExists(path) {
  try {
    return await readFile(path, "utf-8");
  } catch {
    return null;
  }
}

async function listMd(dir) {
  try {
    const entries = await readdir(dir);
    return entries.filter((f) => f.endsWith(".md")).map((f) => join(dir, f));
  } catch {
    return [];
  }
}

async function listProjects() {
  const out = [];
  try {
    for (const entry of await readdir(PROJECTS_DIR, { withFileTypes: true })) {
      if (entry.isDirectory() && !entry.name.startsWith(".")) out.push(entry.name);
    }
  } catch {
    /* 目录不存在 */
  }
  return out;
}

/** 计算迁移后的 tools 列表。返回 null 表示不需要改。 */
function migrateTools(def) {
  const existing = Array.isArray(def.tools) ? [...def.tools] : null;
  const reports = Array.isArray(def.reports) ? def.reports : [];
  const next = new Set(existing ?? BUILTIN);
  const wasImplicit = existing === null;
  const missingReports = reports.length > 0 && !next.has("report_publish");
  if (missingReports) for (const tool of REPORT_TOOLS) next.add(tool);
  if (!wasImplicit && !missingReports) return null;
  return { tools: [...next], wasImplicit, addedReports: missingReports };
}

function renderBefore(def) {
  const lines = [];
  if (def.tools === null || def.tools === undefined) lines.push("  tools: （缺失 = 旧语义「全部工具」）");
  else lines.push(`  tools: [${def.tools.join(", ")}]`);
  if (def.reports?.length) lines.push(`  reports: [${def.reports.join(", ")}]`);
  return lines.join("\n");
}

function renderAfter(result, def) {
  const lines = [`  tools: [${result.tools.join(", ")}]`];
  if (def.reports?.length) lines.push(`  reports: [${def.reports.join(", ")}]`);
  return lines.join("\n");
}

const targets = [];
for (const project of await listProjects()) {
  for (const file of await listMd(join(PROJECTS_DIR, project, ".pi", "agents"))) {
    targets.push({ file, kind: `项目 agent（${project}）`, scopeRole: "agent" });
  }
  const assistantFile = join(PROJECTS_DIR, project, ".pi", "assistant.md");
  if ((await readIfExists(assistantFile)) !== null) {
    targets.push({ file: assistantFile, kind: `项目助理（${project}）`, scopeRole: "assistant" });
  }
}
for (const file of await listMd(GLOBAL_AGENTS_DIR)) targets.push({ file, kind: "全局 agent", scopeRole: "assistant" });
for (const file of await listMd(META_AGENTS_DIR)) targets.push({ file, kind: "元项目 agent", scopeRole: "agent" });
const metaAssistant = join(META_DIR, "assistant.md");
if ((await readIfExists(metaAssistant)) !== null) targets.push({ file: metaAssistant, kind: "元项目助理", scopeRole: "assistant" });

console.log(`工作区：${WORKSPACE}`);
console.log(`待检查文件：${targets.length} 个${WRITE ? "（将落盘）" : "（dry-run，不落盘）"}\n`);

let changed = 0;
for (const target of targets) {
  const md = await readIfExists(target.file);
  if (md === null) continue;
  const def = parseAgentDef(md);
  const result = migrateTools(def);
  if (!result) continue;
  changed++;
  console.log(`── ${target.kind}  ${target.file}`);
  console.log("  迁移前：");
  console.log(renderBefore(def));
  console.log("  迁移后：");
  console.log(renderAfter(result, def));
  console.log(`  原因：${result.wasImplicit ? "tools 缺失，旧语义为「全部工具」" : ""}${result.addedReports ? "（补齐报告工具）" : ""}`);
  console.log();
  if (!WRITE) continue;
  const backup = `${target.file}.bak-${stamp}`;
  if ((await stat(backup).catch(() => null)) === null) await copyFile(target.file, backup);
  await writeFile(target.file, serializeAgentDef({ ...def, tools: result.tools }), "utf-8");
  console.log(`  已写入（备份 ${backup}）\n`);
}

console.log(WRITE ? `完成：${changed} 个文件已更新。` : `完成：${changed} 个文件需要更新。加 --write 落盘。`);
if (changed > 0) console.log("落盘后请重启 pi-box，让已存在的会话按新配置重算工具集。");