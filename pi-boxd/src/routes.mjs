// HTTP 路由（6 个 extraRoutes）
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { join, resolve, sep } from "node:path";
import { AgentDoc, configure } from "@earendil-works/pi-durable";
import { readBody, loadConfig, saveConfig, providerConfig, loadMcpConfig, saveMcpConfig, loadPrefs, savePrefs, APP_ICON_EXTS, APP_ICON_MIME } from "./io.mjs";
import { scanSkills, setSkillEnabled, installSkill, removeSkill, skillUsage, resolveSkills, projectSkillsDir, USER_SKILLS_DIR, BUILTIN_SKILLS_DIR } from "./skills.mjs";
import { PROJECTS_DIR, DATA_DIR, META_PROJECT, META_DIR, WEB_DIR } from "./paths.mjs";
import { refreshProvider, currentModel, testProviderConnection } from "./model.mjs";
import { PROVIDER_LIST, getAllProviderModels } from "./providers.mjs";
import { listProjects, listAgents, listAgentCatalog, listGlobalAgents, loadAssistant, saveAgentFile, renameAgentFile, deleteAgentFile, saveAssistantFile, assistantInstructions, resolveAgentModel, resolveAgentTools, resolveAssistantTools, agentFilePath, ensureSkillReadTool, loadProjectIcon, saveProjectIcon, setAssistantIcon, setAgentIcon, normalizeIcon } from "./agents.mjs";
import { createRoleConversation, renameSubagentRecords, syncAfterConfigChange, syncAllConfig } from "./harness.mjs";
import { setConversationMeta } from "./extension.mjs";
import { validatePublicMcpConfig } from "./mcp-bridge.mjs";
import { deleteSchedule, listSchedules, loadScheduleStore, triggerSchedule, upsertSchedule } from "./schedules.mjs";
import { readLogTail, scheduleLogDir, scheduleLogRoot } from "./schedule-log.mjs";
import { harness as runtimeHarness, context as runtimeContext, mcpBridge as runtimeMcpBridge, getMaintenance, isMaintenance, restartRuntime } from "./runtime.mjs";
import { cleanupStatus, pruneAllLogs, saveCleanupConfig } from "./cleanup.mjs";
import { listDirectory, readFilePreview, resolveProjectPath, sendProjectFile, uploadProjectFile } from "./files.mjs";
import {
  createGroup as createReportGroup,
  deleteGroup as deleteReportGroup,
  deleteReport as deleteReportItem,
  listGroups as listReportGroups,
  listReports as listReportItems,
  loadGroupMeta as loadReportGroup,
  readReport as readReportItem,
  scanSensitive as scanReportSensitive,
  setGroupVisibility as setReportVisibility,
  updateGroup as updateReportGroup,
} from "./reports.mjs";
import { sendReportContent } from "./report-pages.mjs";

const NAME_RE = /^[a-zA-Z0-9_-]+$/;
const AGENT_NAME_RE = /^[\p{L}\p{N}_-]+$/u;

// ── 自定义品牌图标（浏览器标签页 icon）存储 ───────────────────────────────
const BRANDING_DIR = join(DATA_DIR, "branding");
const ICON_MAX_BYTES = 512 * 1024;
// dataURL 的 MIME → 落盘扩展名（只允许位图与 SVG）
const ICON_MIME_EXT = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/jpg": "jpg",
  "image/webp": "webp",
  "image/svg+xml": "svg",
  "image/x-icon": "ico",
  "image/vnd.microsoft.icon": "ico",
};

function sendJson(res, status, payload) {
  res.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store" });
  res.end(JSON.stringify(payload));
}

/** 解析 query string（extraRoutes 是精确路径匹配，参数只能走 query）。 */
function queryOf(req) {
  return new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`).searchParams;
}

/** 文件接口统一错误出口：fileError 带 status，其余按 500 处理。 */
function sendFileError(res, error) {
  if (res.headersSent || res.writableEnded || res.destroyed) {
    res.destroy();
    return;
  }
  const byCode = { EACCES: 403, EPERM: 403, ENOENT: 404, ENOTDIR: 404, EISDIR: 400, ENOSPC: 507 };
  const status = Number(error?.status) || byCode[error?.code] || 500;
  sendJson(res, status, { error: error?.message ?? String(error) });
}

/** 静态资源（vendor 目录）直出，带长缓存。 */
async function sendVendor(res, file, contentType) {
  try {
    const body = await readFile(join(WEB_DIR, "vendor", file));
    res.writeHead(200, { "Content-Type": contentType, "Cache-Control": "public, max-age=604800" });
    res.end(body);
  } catch {
    res.writeHead(404, { "Content-Type": "text/plain" });
    res.end("not found");
  }
}

/** 删除 branding 目录下除 keep 之外的所有图标文件 */
async function clearBrandingIcons(keep) {
  for (const ext of APP_ICON_EXTS) {
    if (ext === keep) continue;
    await unlink(join(BRANDING_DIR, `icon.${ext}`)).catch(() => {});
  }
}

/** 基于 dataURL 保存自定义图标，返回新的 appIcon 偏好。 */
async function saveBrandingIcon(dataUrl) {
  const match = /^data:([^;,]+);base64,([A-Za-z0-9+/=\s]+)$/.exec(String(dataUrl ?? "").trim());
  if (!match) throw Object.assign(new Error("图标格式不正确，需要 base64 编码的 dataURL"), { status: 400 });
  const ext = ICON_MIME_EXT[match[1].toLowerCase()];
  if (!ext) throw Object.assign(new Error(`不支持的图标类型：${match[1]}（支持 png / jpeg / webp / svg / ico）`), { status: 400 });
  const data = Buffer.from(match[2], "base64");
  if (data.length === 0) throw Object.assign(new Error("图标内容为空"), { status: 400 });
  if (data.length > ICON_MAX_BYTES) throw Object.assign(new Error("图标不能超过 512KB"), { status: 413 });
  await mkdir(BRANDING_DIR, { recursive: true });
  await clearBrandingIcons(ext);
  await writeFile(join(BRANDING_DIR, `icon.${ext}`), data);
  const prefs = await loadPrefs();
  const saved = await savePrefs({ ...prefs, appIcon: { type: "upload", ext, version: Date.now() } });
  return saved.appIcon;
}

export function buildExtraRoutes(_harnessArg, _contextArg, _mcpBridgeArg) {
  // 用运行时代理：数据清理会在同进程内重建 Harness，这些路由必须跟随新实例。
  const harness = runtimeHarness;
  const context = runtimeContext;
  const mcpBridge = runtimeMcpBridge;
  return guardMaintenance({
    // 浏览器标签页图标（index.html 里的 <link rel="icon"> 指向这里）。
    "/favicon.svg": {
      method: "GET",
      async handler(req, res) {
        try {
          const body = await readFile(join(WEB_DIR, "favicon.svg"));
          res.writeHead(200, { "Content-Type": "image/svg+xml", "Cache-Control": "public, max-age=86400" });
          res.end(body);
        } catch {
          res.writeHead(404);
          res.end("not found");
        }
      },
    },
    // 会话历史按需加载，避免 SSE 周期性传输所有旧消息。
    "/api/conversation": {
      method: "GET",
      async handler(req, res) {
        const url = new URL(req.url, `http://${req.headers.host}`);
        const id = url.searchParams.get("id");
        const conversation = id ? await harness.conversation(id, context) : undefined;
        if (!conversation) {
          res.writeHead(404, { "Content-Type": "application/json" });
          return res.end(JSON.stringify({ error: "会话不存在" }));
        }
        const view = await conversation.viewState(context);
        const entries = view.value.entries.map((entry) => ({
          id: String(entry.id),
          kind: entry.kind,
          model: entry.model ?? null,
        }));
        res.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store" });
        res.end(JSON.stringify({ id: String(id), entries }));
      },
    },
    // 发送消息：whenBusy 决定会话忙碌时是排队（followUp）还是插话引导（steer）。
    "/api/send": {
      method: "POST",
      async handler(req, res) {
        const { conversationId, content, whenBusy } = await readBody(req);
        const conversation = conversationId ? await harness.conversation(String(conversationId), context) : undefined;
        if (!conversation) {
          res.writeHead(404, { "Content-Type": "application/json" });
          return res.end(JSON.stringify({ error: "会话不存在" }));
        }
        const submission = await conversation.submit(
          { type: "input", content: String(content ?? ""), whenBusy: whenBusy === "steer" ? "steer" : "followUp" },
          context,
        );
        submission.wait(context).catch(() => {});
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true, submissionId: String(submission.id) }));
      },
    },
    // 终止会话：中止当前运行（跨后台边界，撤回排队中的输入）。
    "/api/abort": {
      method: "POST",
      async handler(req, res) {
        const { conversationId } = await readBody(req);
        const conversation = conversationId ? await harness.conversation(String(conversationId), context) : undefined;
        if (!conversation) {
          res.writeHead(404, { "Content-Type": "application/json" });
          return res.end(JSON.stringify({ error: "会话不存在" }));
        }
        await conversation.abort(context, { background: true }).catch(() => {});
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true }));
      },
    },
    // 重命名会话（只改显示名，不动角色/项目归属）。
    "/api/conversation/rename": {
      method: "POST",
      async handler(req, res) {
        const { conversationId, title } = await readBody(req);
        const id = conversationId ? String(conversationId) : undefined;
        const value = String(title ?? "").trim();
        if (!id || !value) {
          res.writeHead(400, { "Content-Type": "application/json" });
          return res.end(JSON.stringify({ error: "缺少 conversationId 或名称" }));
        }
        if (value.length > 120) {
          res.writeHead(400, { "Content-Type": "application/json" });
          return res.end(JSON.stringify({ error: "名称过长（最多 120 字符）" }));
        }
        const conversation = await harness.conversation(id, context);
        if (!conversation) {
          res.writeHead(404, { "Content-Type": "application/json" });
          return res.end(JSON.stringify({ error: "会话不存在" }));
        }
        await harness.commit((tx) => setConversationMeta(tx, id, { title: value }), context);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true, title: value }));
      },
    },
    // 页面为当前助理或 Agent 新建独立持久会话。
    "/api/role-conversations": {
      method: "POST",
      async handler(req, res) {
        const { project, actorType, actorName } = await readBody(req);
        if (!project || !(await listProjects()).includes(project)) {
          res.writeHead(404, { "Content-Type": "application/json" });
          return res.end(JSON.stringify({ error: "项目不存在" }));
        }
        try {
          const conversationId = await createRoleConversation(harness, project, actorType, actorName);
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ ok: true, conversationId }));
        } catch (error) {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: error.message }));
        }
      },
    },
    // 项目级定时任务：定义保存在项目 .pi/schedules.json，到点后提交给项目助理。
    "/api/schedules": {
      methods: ["GET", "POST"],
      async handler(req, res) {
        const url = new URL(req.url, `http://${req.headers.host}`);
        const input = req.method === "GET" ? { project: url.searchParams.get("project") } : await readBody(req);
        if (!input.project || !(await listProjects()).includes(input.project)) {
          res.writeHead(404, { "Content-Type": "application/json" });
          return res.end(JSON.stringify({ error: "项目不存在" }));
        }
        try {
          const result = req.method === "GET"
            ? await listSchedules(input.project)
            : { schedule: await upsertSchedule(input.project, input) };
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify(result));
        } catch (error) {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: error.message }));
        }
      },
    },
    "/api/schedules/delete": {
      method: "POST",
      async handler(req, res) {
        const { project, id } = await readBody(req);
        try {
          await deleteSchedule(project, id);
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ ok: true }));
        } catch (error) {
          res.writeHead(404, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: error.message }));
        }
      },
    },
    // 定时任务运行日志：按 runId（历史日志）或 latest（最近一次）读尾部。
    "/api/schedules/logs": {
      method: "GET",
      async handler(req, res) {
        const url = new URL(req.url, `http://${req.headers.host}`);
        const project = url.searchParams.get("project");
        const scheduleId = url.searchParams.get("scheduleId");
        const runId = url.searchParams.get("runId");
        const lines = Math.min(2000, Math.max(20, Number(url.searchParams.get("tail") ?? 300)));
        if (!project || !scheduleId) {
          res.writeHead(400, { "Content-Type": "application/json" });
          return res.end(JSON.stringify({ error: "缺少 project 或 scheduleId" }));
        }
        if (!(await listProjects()).includes(project)) {
          res.writeHead(404, { "Content-Type": "application/json" });
          return res.end(JSON.stringify({ error: "项目不存在" }));
        }
        try {
          // 只允许读该项目 schedule-logs 目录下的文件（runId → runs.logPath 也要做归属校验）。
          const root = resolve(scheduleLogRoot(project));
          const inside = (candidate) => {
            const full = resolve(candidate);
            return full === root || full.startsWith(`${root}${sep}`);
          };
          let target = null;
          if (runId) {
            const store = await loadScheduleStore(project);
            const run = store.runs.find((item) => item.id === runId);
            const candidate = run?.logPath ? String(run.logPath) : null;
            if (candidate && inside(candidate) && !candidate.includes("..")) target = candidate;
          }
          if (!target) {
            const dir = scheduleLogDir(project, scheduleId);
            if (!inside(dir)) {
              res.writeHead(400, { "Content-Type": "application/json" });
              return res.end(JSON.stringify({ error: "scheduleId 不合法" }));
            }
            target = join(dir, "latest.log");
          }
          const result = await readLogTail(target, lines);
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ project, scheduleId, runId: runId ?? null, path: target, ...result }));
        } catch (error) {
          const missing = error?.code === "ENOENT";
          res.writeHead(missing ? 404 : 500, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: missing ? "还没有运行日志" : error.message }));
        }
      },
    },
    "/api/schedules/run": {
      method: "POST",
      async handler(req, res) {
        const { project, id } = await readBody(req);
        const schedule = (await loadScheduleStore(project)).schedules.find((item) => item.id === id);
        if (!schedule) {
          res.writeHead(404, { "Content-Type": "application/json" });
          return res.end(JSON.stringify({ error: "定时任务不存在" }));
        }
        try {
          const run = await triggerSchedule(harness, context, project, schedule, {
            manual: true,
            occurrenceId: `manual:${randomUUID()}`,
          });
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ ok: true, run }));
        } catch (error) {
          res.writeHead(500, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: error.message }));
        }
      },
    },
    // 项目：GET 列表 / POST 新建
    "/api/projects": {
      methods: ["GET", "POST"],
      async handler(req, res) {
        if (req.method === "GET") {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ projects: await listProjects() }));
          return;
        }
        let { name } = await readBody(req);
        if (!name || !NAME_RE.test(name)) {
          res.writeHead(400);
          res.end(JSON.stringify({ error: "项目名只能含字母、数字、-、_" }));
          return;
        }
        if (name === META_PROJECT) {
          res.writeHead(400, { "Content-Type": "application/json" });
          return res.end(JSON.stringify({ error: `项目名 "${META_PROJECT}" 是保留字（系统元项目）` }));
        }
        if ((await listProjects()).includes(name)) {
          res.writeHead(409);
          res.end(JSON.stringify({ error: `项目 "${name}" 已存在` }));
          return;
        }
        const cwd = join(PROJECTS_DIR, name);
        await mkdir(cwd, { recursive: true });
        const assistant = await loadAssistant(name);
        const agents = await listAgents(name);
        const conv = await harness.createConversation(
          {
            ownership: { kind: "ownerless" },
            agent: {
              model: resolveAgentModel(assistant.model),
              instructions: assistantInstructions(name, assistant, agents),
              tools: resolveAssistantTools(assistant.tools, assistant.mcps),
              cwd,
            },
            init: (tx, conversationId) => setConversationMeta(tx, conversationId, {
              project: name, actorType: "assistant", actorName: "助理", source: "main",
              title: "项目主会话", createdAt: new Date().toISOString(),
            }),
          },
          context,
        );
        console.log(`[project] 新建项目 ${name} → 会话 #${conv.id}`);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true, project: name, conversationId: conv.id }));
      },
    },
    // 项目重命名：目录与所有相关会话 cwd 一起更新
    // 统一实体图标接口：kind=project|assistant|agent，icon=null 表示恢复默认。
    // 只改图标字段，不回传其余配置，避开完整保存链路的校验与旧快照覆盖风险。
    "/api/entities/icon": {
      method: "POST",
      async handler(req, res) {
        const { kind, project, name, scope = "project", icon } = await readBody(req);
        try {
          let saved;
          if (kind === "project") {
            if (!project || !(await listProjects()).includes(project)) {
              res.writeHead(404, { "Content-Type": "application/json" });
              return res.end(JSON.stringify({ error: `项目 "${project}" 不存在` }));
            }
            saved = await saveProjectIcon(project, icon ?? null);
          } else if (kind === "assistant") {
            if (!project) {
              res.writeHead(400, { "Content-Type": "application/json" });
              return res.end(JSON.stringify({ error: "缺少 project 参数" }));
            }
            saved = await setAssistantIcon(project, icon ?? null);
          } else if (kind === "agent") {
            if (!name) {
              res.writeHead(400, { "Content-Type": "application/json" });
              return res.end(JSON.stringify({ error: "缺少 name 参数" }));
            }
            saved = await setAgentIcon(project, name, scope, icon ?? null);
          } else {
            res.writeHead(400, { "Content-Type": "application/json" });
            return res.end(JSON.stringify({ error: "kind 只能是 project / assistant / agent" }));
          }
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ ok: true, kind, project: project ?? null, name: name ?? null, icon: saved }));
        } catch (error) {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: error.message }));
        }
      },
    },
    // 项目自定义图标（emoji）；icon=null 表示恢复默认 📁
    "/api/projects/icon": {
      methods: ["GET", "POST"],
      async handler(req, res) {
        if (req.method === "GET") {
          const project = queryOf(req).get("project");
          if (!project) {
            res.writeHead(400, { "Content-Type": "application/json" });
            return res.end(JSON.stringify({ error: "缺少 project 参数" }));
          }
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ project, icon: await loadProjectIcon(project) }));
          return;
        }
        const { project, icon } = await readBody(req);
        if (!project) {
          res.writeHead(400, { "Content-Type": "application/json" });
          return res.end(JSON.stringify({ error: "缺少 project 参数" }));
        }
        if (!(await listProjects()).includes(project)) {
          res.writeHead(404, { "Content-Type": "application/json" });
          return res.end(JSON.stringify({ error: `项目 "${project}" 不存在` }));
        }
        try {
          const saved = await saveProjectIcon(project, icon ?? null);
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ ok: true, project, icon: saved }));
        } catch (error) {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: error.message }));
        }
      },
    },
    "/api/projects/rename": {
      method: "POST",
      async handler(req, res) {
        const { oldName, newName } = await readBody(req);
        if (!oldName || !newName || !NAME_RE.test(newName)) {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "项目名只能含字母、数字、-、_" }));
          return;
        }
        const projects = await listProjects();
        if (!projects.includes(oldName)) {
          res.writeHead(404, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: `项目 \"${oldName}\" 不存在` }));
          return;
        }
        if (oldName !== newName && projects.includes(newName)) {
          res.writeHead(409, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: `项目 \"${newName}\" 已存在` }));
          return;
        }
        if (oldName === newName) {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ ok: true, project: newName, updatedConversations: 0 }));
          return;
        }
        const oldCwd = join(PROJECTS_DIR, oldName);
        const newCwd = join(PROJECTS_DIR, newName);
        await rename(oldCwd, newCwd);
        try {
          const { items: records } = await harness.commit((tx) => tx.scanConversations({}, 1000, undefined), context);
          const affected = [];
          for (const record of records) {
            const agent = await harness.snapshot(AgentDoc, record.id, context);
            if (agent?.cwd === oldCwd) affected.push(record.id);
          }
          await harness.commit(async (tx) => {
            for (const id of affected) await configure(tx, id, { cwd: newCwd });
          }, context);
          await syncAfterConfigChange(harness, { scope: "project", projectName: newName, agentName: null });
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ ok: true, project: newName, updatedConversations: affected.length }));
        } catch (error) {
          await rename(newCwd, oldCwd).catch(() => {});
          throw error;
        }
      },
    },
    // 项目删除采用工作区内软删除，目录可从 .pi-box-trash 恢复。
    "/api/projects/delete": {
      method: "POST",
      async handler(req, res) {
        const { name, confirmation } = await readBody(req);
        if (!name || confirmation !== name || !(await listProjects()).includes(name)) {
          res.writeHead(400, { "Content-Type": "application/json" });
          return res.end(JSON.stringify({ error: "项目不存在或确认名称不匹配" }));
        }
        const cwd = join(PROJECTS_DIR, name);
        const trashDir = join(PROJECTS_DIR, ".pi-box-trash");
        const trashName = `${name}-${new Date().toISOString().replace(/[:.]/g, "-")}`;
        await mkdir(trashDir, { recursive: true });
        const { items } = await harness.commit((tx) => tx.scanConversations({}, 1000, undefined), context);
        for (const record of items) {
          const agent = await harness.snapshot(AgentDoc, record.id, context);
          if (agent?.cwd !== cwd) continue;
          const conversation = await harness.conversation(record.id, context);
          await conversation?.abort(context, { background: true }).catch(() => {});
        }
        await rename(cwd, join(trashDir, trashName));
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true, project: name, recoverable: true, trashName }));
      },
    },
    // ── 项目文件：浏览 / 预览 / 下载 / 上传 ────────────────────────────────
    // 全部走 query string（路径参数无法用精确匹配路由）；路径解析与越界校验在 files.mjs。
    "/api/files/list": {
      method: "GET",
      async handler(req, res) {
        const params = queryOf(req);
        try {
          const data = await listDirectory(params.get("project"), params.get("path") ?? "");
          sendJson(res, 200, data);
        } catch (error) {
          sendFileError(res, error);
        }
      },
    },
    "/api/files/read": {
      method: "GET",
      async handler(req, res) {
        const params = queryOf(req);
        try {
          const data = await readFilePreview(params.get("project"), params.get("path") ?? "");
          sendJson(res, 200, data);
        } catch (error) {
          sendFileError(res, error);
        }
      },
    },
    "/api/files/raw": {
      methods: ["GET", "HEAD"],
      async handler(req, res) {
        const params = queryOf(req);
        try {
          const target = await resolveProjectPath(params.get("project"), params.get("path") ?? "");
          await sendProjectFile(req, res, target, { download: params.get("download") === "1" });
        } catch (error) {
          sendFileError(res, error);
        }
      },
    },
    // 上传：请求体就是文件裸流（不用 base64 / multipart），先写隐藏临时文件再 rename。
    "/api/files/upload": {
      method: "POST",
      async handler(req, res) {
        const params = queryOf(req);
        try {
          const data = await uploadProjectFile(req, {
            project: params.get("project"),
            dir: params.get("dir") ?? "",
            name: params.get("name"),
            overwrite: params.get("overwrite") === "1",
          });
          sendJson(res, 200, { ok: true, ...data });
        } catch (error) {
          sendFileError(res, error);
        }
      },
    },
    // 代码高亮（vendor）：highlight.js common 构建 + github-dark 主题。
    "/vendor/hljs.js": {
      method: "GET",
      async handler(_req, res) {
        await sendVendor(res, "hljs/highlight.min.js", "text/javascript; charset=utf-8");
      },
    },
    "/vendor/hljs.css": {
      method: "GET",
      async handler(_req, res) {
        await sendVendor(res, "hljs/github-dark.min.css", "text/css; charset=utf-8");
      },
    },
    // provider 元数据
    "/api/providers": {
      method: "GET",
      async handler(req, res) {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ providers: PROVIDER_LIST }));
      },
    },
    // 按需获取单个厂商的模型目录
    "/api/models": {
      method: "POST",
      async handler(req, res) {
        const { provider } = await readBody(req);
        const meta = PROVIDER_LIST.find((p) => p.id === provider);
        if (!meta) {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: `未知 Provider：${provider}` }));
          return;
        }
        const all = await getAllProviderModels();
        const modelIds = all[provider] ?? [];
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ provider, models: modelIds, source: "provider-catalog" }));
      },
    },
    // 用当前表单或已保存密钥发一个最小真实请求
    "/api/settings/test": {
      method: "POST",
      async handler(req, res) {
        const input = await readBody(req);
        const cfg = await loadConfig();
        const saved = cfg.providers?.[input.provider] ?? {};
        try {
          const result = await testProviderConnection({ ...saved, ...input, apiKey: input.apiKey || saved.apiKey });
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify(result));
        } catch (error) {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ ok: false, error: error.message }));
        }
      },
    },
    // 模型设置
    "/api/settings": {
      methods: ["GET", "POST"],
      async handler(req, res) {
        if (req.method === "GET") {
          const cfg = await loadConfig();
          const providers = Object.fromEntries(
            Object.entries(cfg.providers ?? {}).map(([id, value]) => [id, {
              models: Array.isArray(value.models) ? value.models : [],
              baseUrl: value.baseUrl ?? "",
              hasKey: !!value.apiKey,
            }]),
          );
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ activeProvider: cfg.activeProvider, providers, currentModel }));
          return;
        }
        const input = await readBody(req);
        const provider = input.provider;
        const meta = PROVIDER_LIST.find((p) => p.id === provider);
        if (!meta) {
          res.writeHead(400, { "Content-Type": "application/json" });
          return res.end(JSON.stringify({ error: `未知 Provider：${provider}` }));
        }
        const old = await loadConfig();
        const previous = providerConfig(old, provider);
        // 兼容前端掩码：星号绝不能被当作真实密钥保存。
        let apiKey = input.apiKey;
        if (apiKey === undefined || apiKey === null || apiKey === "" || /^\*+$/.test(apiKey)) apiKey = previous.apiKey || "";
        const baseUrl = input.baseUrl === undefined ? (previous.baseUrl || meta.defaultBaseUrl || "") : input.baseUrl;
        // 模型列表：支持批量配置；空则回退默认模型。保留用户手写的自定义 modelId（自建/兼容端点）。
        let models = Array.isArray(input.models)
          ? [...new Set(input.models.map((m) => String(m).trim()).filter(Boolean))]
          : (input.modelId ? [String(input.modelId)] : []);
        if (models.length === 0) models = previous.models?.length ? previous.models : [meta.defaultModel || "gpt-4o"];
        // 默认厂商：显式勾选「设为默认」，或当前默认厂商尚未配置 key（首个可用厂商自动成为默认）。
        const oldActiveHasKey = !!old.providers?.[old.activeProvider]?.apiKey;
        const activeProvider = input.setActive || !oldActiveHasKey ? provider : old.activeProvider;
        const next = {
          version: 3,
          activeProvider,
          providers: { ...(old.providers ?? {}), [provider]: { apiKey, baseUrl, models } },
        };
        await saveConfig(next);
        const newHasKey = await refreshProvider();
        // 按各项目/agent 定义重新解析，而不是把所有会话粗暴覆盖成全局模型。
        await syncAllConfig(harness);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({
          ok: true, hasKey: newHasKey, provider, models, baseUrl,
          activeProvider: next.activeProvider, effectiveProvider: currentModel.provider,
        }));
      },
    },
    // 删除某个厂商的已保存配置（API Key 等），不影响其他厂商。
    "/api/settings/delete": {
      method: "POST",
      async handler(req, res) {
        const { provider } = await readBody(req);
        const old = await loadConfig();
        if (!old.providers?.[provider]) {
          res.writeHead(404, { "Content-Type": "application/json" });
          return res.end(JSON.stringify({ error: `未配置过 Provider：${provider}` }));
        }
        const next = { ...old, providers: { ...(old.providers ?? {}) } };
        delete next.providers[provider];
        if (next.activeProvider === provider) {
          next.activeProvider = Object.keys(next.providers)[0] ?? "openai";
        }
        await saveConfig(next);
        await refreshProvider();
        await syncAllConfig(harness);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true, provider, activeProvider: next.activeProvider }));
      },
    },
    // agent 列表 / 保存
    "/api/agents": {
      methods: ["GET", "POST"],
      async handler(req, res) {
        if (req.method === "GET") {
          const url = new URL(req.url, `http://${req.headers.host}`);
          const project = url.searchParams.get("project");
          if (!project) {
            res.writeHead(400);
            res.end(JSON.stringify({ error: "缺少 project 参数" }));
            return;
          }
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ project, agents: await listAgents(project) }));
          return;
        }
        const { project, name, oldName, scope = "project", model: m, tools, mcps, skills, reports, instructions, icon } = await readBody(req);
        if (!name || !AGENT_NAME_RE.test(name)) {
          res.writeHead(400);
          res.end(JSON.stringify({ error: "Agent 名只能含中文或其他语言的字母、数字、-、_" }));
          return;
        }
        if (scope === "project" && !project) {
          res.writeHead(400);
          res.end(JSON.stringify({ error: "项目级 agent 需要 project 参数" }));
          return;
        }
        if (scope === "meta") {
          res.writeHead(400, { "Content-Type": "application/json" });
          return res.end(JSON.stringify({ error: "元项目子 agent 不可通过 API 创建/修改。请在宿主机直接编辑 /home/agent/.pi/agent/meta/agents/ 下的 .md 文件。" }));
        }
        if (!instructions?.trim()) {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "提示词不能为空" }));
          return;
        }
        try {
          resolveAgentTools(tools);
        } catch (error) {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: error.message }));
          return;
        }
        const mcpConfig = await loadMcpConfig();
        const availableMcps = new Set(
          Object.entries(mcpConfig.mcpServers ?? {})
            .filter(([, config]) => config.enabled !== false)
            .map(([mcpName]) => mcpName),
        );
        const invalidMcps = Array.isArray(mcps) ? mcps.filter((mcp) => !availableMcps.has(mcp)) : [];
        if (invalidMcps.length > 0) {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: `MCP 不存在或已停用：${invalidMcps.join(", ")}` }));
          return;
        }
        try {
          // skill 必须先解析成功；引用了不存在的定义直接拒绝，避免角色静默失效。
          const { skills: resolvedSkills, missing, invalid } = await resolveSkills(skills, project);
          if (missing.length > 0) {
            throw new Error(`未知 Skill：${missing.join(", ")}（请先在系统设置 → Skills 中上传）`);
          }
          if (invalid.length > 0) {
            throw new Error(`Skill 定义非法：${invalid.map((item) => `${item.name}（${item.error}）`).join("; ")}`);
          }
          ensureSkillReadTool(resolveAgentTools(tools, Array.isArray(mcps) ? mcps : []), resolvedSkills.length);
          if (oldName && oldName !== name) {
            await renameAgentFile(project, oldName, name, scope);
            await renameSubagentRecords(harness, { scope, projectName: project, oldName, newName: name });
          }
          // 报告组绑定：必须是已存在的组，避免 agent 写了拼错的 slug 才发现。
          let resolvedReports = null;
          if (Array.isArray(reports)) {
            const known = new Set((await listReportGroups(project)).map((group) => group.slug));
            const unknown = reports.filter((slug) => !known.has(slug));
            if (unknown.length > 0) {
              throw new Error(`报告组不存在：${unknown.join(", ")}（请先在左栏「报告」里创建）`);
            }
            resolvedReports = reports;
          } else if (reports === null) {
            resolvedReports = null;
          }
          const file = await saveAgentFile(project, name, scope, {
            model: m,
            tools,
            mcps: Array.isArray(mcps) ? mcps : [],
            skills: Array.isArray(skills) ? skills : null,
            reports: resolvedReports,
            icon: icon === undefined ? undefined : normalizeIcon(icon),
            instructions,
          });
          await syncAfterConfigChange(harness, { scope, projectName: project, agentName: name });
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ ok: true, name, scope, file }));
        } catch (error) {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: error.message }));
        }
      },
    },
    // 全局 Agent 独立目录（系统设置中的管理页使用）。
    "/api/global-agents": {
      method: "GET",
      async handler(req, res) {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ agents: await listGlobalAgents() }));
      },
    },
    // 项目 Agent 与全局候选分层返回，供助理授权页使用。
    "/api/agents/catalog": {
      method: "GET",
      async handler(req, res) {
        const url = new URL(req.url, `http://${req.headers.host}`);
        const project = url.searchParams.get("project");
        if (!project) {
          res.writeHead(400, { "Content-Type": "application/json" });
          return res.end(JSON.stringify({ error: "缺少 project 参数" }));
        }
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(await listAgentCatalog(project)));
      },
    },
    // agent 删除
    "/api/agents/delete": {
      method: "POST",
      async handler(req, res) {
        const { project, name, scope = "project" } = await readBody(req);
        if (!name) {
          res.writeHead(400);
          res.end(JSON.stringify({ error: "缺少 name" }));
          return;
        }
        if (scope === "meta") {
          res.writeHead(400, { "Content-Type": "application/json" });
          return res.end(JSON.stringify({ error: "元项目子 agent 不可通过 API 删除。请在宿主机直接编辑 /home/agent/.pi/agent/meta/agents/ 下的 .md 文件。" }));
        }
        try {
          // 先实际查文件在哪里：拒绝刪除不在请求指定 scope 目录下的 Agent
          const { stat, realpath } = await import("node:fs/promises");
          const targetPath = agentFilePath(project, name, scope);
          let realTarget;
          try {
            realTarget = await realpath(targetPath);
          } catch {
            res.writeHead(404, { "Content-Type": "application/json" });
            return res.end(JSON.stringify({ error: `Agent "${name}" 不在 ${scope} 范围内` }));
          }
          if (realTarget.startsWith(META_DIR + "/")) {
            res.writeHead(400, { "Content-Type": "application/json" });
            return res.end(JSON.stringify({ error: "该 Agent 位于元项目目录，不能通过 API 删除。" }));
          }
          await deleteAgentFile(project, name, scope);
        } catch (error) {
          res.writeHead(400, { "Content-Type": "application/json" });
          return res.end(JSON.stringify({ error: error.message }));
        }
        await syncAfterConfigChange(harness, { scope, projectName: project, agentName: null });
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true }));
      },
    },
    // 助理：GET 读 / POST 保存
    "/api/assistant": {
      methods: ["GET", "POST"],
      async handler(req, res) {
        if (req.method === "GET") {
          const url = new URL(req.url, `http://${req.headers.host}`);
          const project = url.searchParams.get("project");
          if (!project) {
            res.writeHead(400);
            res.end(JSON.stringify({ error: "缺少 project 参数" }));
            return;
          }
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ project, assistant: await loadAssistant(project) }));
          return;
        }
        const { project, model: m, tools, mcps, skills, agents, reports, instructions, icon } = await readBody(req);
        if (!project) {
          res.writeHead(400);
          res.end(JSON.stringify({ error: "缺少 project" }));
          return;
        }
        if (project === META_PROJECT) {
          res.writeHead(400, { "Content-Type": "application/json" });
          return res.end(JSON.stringify({ error: `元项目助理文件受保护，不能通过 API 改写。请在宿主机直接编辑 ${META_DIR}/assistant.md。` }));
        }
        const globalNames = new Set((await listGlobalAgents()).map((agent) => agent.name));
        const selectedGlobals = Array.isArray(agents) ? agents.filter((name) => globalNames.has(name)) : [];
        try {
          // 同时完成内置工具名与 MCP 可用性的校验；subagent 由后端强制附加，不落入用户配置。
          resolveAssistantTools(tools, mcps);
          const { skills: resolvedSkills, missing, invalid } = await resolveSkills(skills, project);
          if (missing.length > 0) {
            throw new Error(`未知 Skill：${missing.join(", ")}（请先在系统设置 → Skills 中上传）`);
          }
          if (invalid.length > 0) {
            throw new Error(`Skill 定义非法：${invalid.map((item) => `${item.name}（${item.error}）`).join("; ")}`);
          }
          ensureSkillReadTool(resolveAssistantTools(tools, mcps), resolvedSkills.length);
          // 报告组绑定：助理也能写报告；必须是已存在的组。
          let resolvedReports = null;
          if (Array.isArray(reports)) {
            const known = new Set((await listReportGroups(project)).map((group) => group.slug));
            const unknown = reports.filter((slug) => !known.has(slug));
            if (unknown.length > 0) {
              throw new Error(`报告组不存在：${unknown.join(", ")}（请先在左栏「报告」里创建）`);
            }
            resolvedReports = reports;
          }
          const file = await saveAssistantFile(project, {
            model: m,
            tools,
            mcps,
            skills: Array.isArray(skills) ? skills : null,
            agents: selectedGlobals,
            reports: resolvedReports,
            icon: icon === undefined ? undefined : normalizeIcon(icon),
            instructions,
          });
          await syncAfterConfigChange(harness, { scope: "project", projectName: project, agentName: null });
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ ok: true, file }));
        } catch (error) {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: error.message }));
        }
      },
    },
    // ── MCP server 配置（读取 / 增改 / 删除 / 启停） ────────────────────────
    "/api/mcp": {
      methods: ["GET", "POST"],
      async handler(req, res) {
        if (req.method === "GET") {
          res.writeHead(200, { "Content-Type": "application/json" });
          return res.end(JSON.stringify(await loadMcpConfig()));
        }
        const { name, config, delete: del } = await readBody(req);
        const all = await loadMcpConfig();
        if (del) {
          if (!name) {
            res.writeHead(400); return res.end(JSON.stringify({ error: "缺少 name" }));
          }
          if (!all.mcpServers[name]) {
            res.writeHead(404); return res.end(JSON.stringify({ error: `不存在 MCP server "${name}"` }));
          }
          delete all.mcpServers[name];
          await saveMcpConfig(all);
          await mcpBridge.reload();
          await syncAllConfig(harness);
          return res.end(JSON.stringify({ ok: true, deleted: name }));
        }
        if (!name || !config) {
          res.writeHead(400); return res.end(JSON.stringify({ error: "缺少 name 或 config" }));
        }
        let validated;
        try {
          validated = validatePublicMcpConfig(name, config);
        } catch (error) {
          res.writeHead(400); return res.end(JSON.stringify({ error: error.message }));
        }
        all.mcpServers[name] = validated;
        await saveMcpConfig(all);
        await mcpBridge.reload();
        await syncAllConfig(harness);
        return res.end(JSON.stringify({ ok: true, name, config: validated }));
      },
    },
    // MCP 连接测试：使用正式 transport 完成握手并列出工具。
    "/api/mcp/test": {
      method: "POST",
      async handler(req, res) {
        const { name } = await readBody(req);
        if (!name) {
          res.writeHead(404, { "Content-Type": "application/json" });
          return res.end(JSON.stringify({ ok: false, error: "缺少 MCP 名称" }));
        }
        try {
          const tools = await mcpBridge.test(name);
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ ok: true, name, tools }));
        } catch (error) {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ ok: false, error: error instanceof Error ? error.message : String(error) }));
        }
      },
    },
    // ── Skill 库：列表 / 上传 / 删除 / 全局启停 ─────────────────────────────
    "/api/skills": {
      method: "GET",
      async handler(req, res) {
        const url = new URL(req.url, `http://${req.headers.host}`);
        const project = url.searchParams.get("project");
        const skills = await scanSkills({ project, fresh: true });
        const usage = project ? await skillUsage(project) : {};
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({
          skills: skills.map((skill) => ({ ...skill, usedBy: usage[skill.name] ?? [] })),
          dirs: {
            builtin: BUILTIN_SKILLS_DIR,
            user: USER_SKILLS_DIR,
            project: projectSkillsDir(project),
          },
        }));
      },
    },
    // 上传：{ name?, content, files?: [{path, content}], overwrite? } → 落到用户库
    "/api/skills/upload": {
      method: "POST",
      async handler(req, res) {
        try {
          const skill = await installSkill(await readBody(req));
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ ok: true, skill }));
        } catch (error) {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: error.message }));
        }
      },
    },
    "/api/skills/delete": {
      method: "POST",
      async handler(req, res) {
        const { name } = await readBody(req);
        try {
          await removeSkill(name);
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ ok: true, name }));
        } catch (error) {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: error.message }));
        }
      },
    },
    "/api/skills/toggle": {
      method: "POST",
      async handler(req, res) {
        const { name, enabled } = await readBody(req);
        if (!name) {
          res.writeHead(400, { "Content-Type": "application/json" });
          return res.end(JSON.stringify({ error: "缺少 name" }));
        }
        try {
          await setSkillEnabled(name, !!enabled);
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ ok: true, name, enabled: !!enabled }));
        } catch (error) {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: error.message }));
        }
      },
    },
    // ── UI 偏好 ─────────────────────────────────────────────────────────
    "/api/prefs": {
      methods: ["GET", "POST"],
      async handler(req, res) {
        if (req.method === "GET") {
          res.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store" });
          return res.end(JSON.stringify(await loadPrefs()));
        }
        const incoming = await readBody(req);
        const current = await loadPrefs();
        const saved = await savePrefs({ ...current, ...incoming });
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(saved));
      },
    },
    // ── 自定义品牌图标（浏览器标签页 icon） ─────────────────────────────────
    "/api/branding/icon": {
      methods: ["GET", "POST", "DELETE"],
      async handler(req, res) {
        try {
          if (req.method === "GET") {
            const prefs = await loadPrefs();
            const icon = prefs.appIcon;
            if (icon.type === "upload") {
              try {
                const body = await readFile(join(BRANDING_DIR, `icon.${icon.ext}`));
                res.writeHead(200, {
                  "Content-Type": APP_ICON_MIME[icon.ext] ?? "application/octet-stream",
                  "Cache-Control": "public, max-age=31536000, immutable",
                  // 用户上传的 SVG 可能带脚本；以 sandbox CSP 限制，避免被直接打开时执行
                  "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; sandbox",
                  "X-Content-Type-Options": "nosniff",
                });
                return res.end(body);
              } catch {
                // 文件缺失时回退到内置图标
              }
            }
            try {
              const body = await readFile(join(WEB_DIR, "favicon.svg"));
              res.writeHead(200, { "Content-Type": "image/svg+xml", "Cache-Control": "no-store" });
              return res.end(body);
            } catch {
              res.writeHead(404);
              return res.end("not found");
            }
          }
          if (req.method === "DELETE") {
            await clearBrandingIcons(null);
            const prefs = await loadPrefs();
            const saved = await savePrefs({ ...prefs, appIcon: { type: "default" } });
            return sendJson(res, 200, { appIcon: saved.appIcon });
          }
          // POST：上传图标（dataURL），容量按 base64 膨胀预留余量
          const body = await readBody(req, Math.ceil(ICON_MAX_BYTES * 1.4) + 4096);
          const appIcon = await saveBrandingIcon(body.dataUrl);
          return sendJson(res, 200, { appIcon });
        } catch (error) {
          if (error?.code === "PAYLOAD_TOO_LARGE") return sendJson(res, 413, { error: "图标不能超过 512KB" });
          return sendJson(res, error?.status ?? 400, { error: String(error?.message ?? error) });
        }
      },
    },
    // ── 报告组 / 报告 ──────────────────────────────────────────────────
    // 路径固定 + query 传参（extraRoutes 是精确匹配）。所有写操作都只改文件，
    // 可见性切换额外要求先调 /api/reports/sensitive 让人确认（前端负责）。
    "/api/reports/groups": {
      methods: ["GET", "POST"],
      async handler(req, res) {
        try {
          if (req.method === "GET") {
            const project = queryOf(req).get("project");
            return sendJson(res, 200, { groups: await listReportGroups(project) });
          }
          const body = await readBody(req);
          const group = await createReportGroup(body.project, {
            name: body.name,
            slug: body.slug,
            retentionDays: body.retentionDays,
          });
          return sendJson(res, 200, { group });
        } catch (error) {
          return sendJson(res, error?.status ?? 500, { error: String(error?.message ?? error) });
        }
      },
    },
    "/api/reports/group": {
      methods: ["GET", "PATCH", "DELETE"],
      async handler(req, res) {
        try {
          const query = queryOf(req);
          const project = query.get("project");
          const group = query.get("group");
          if (req.method === "GET") {
            const meta = await loadReportGroup(project, group);
            if (!meta) return sendJson(res, 404, { error: `报告组不存在：${group}` });
            return sendJson(res, 200, { group: meta });
          }
          if (req.method === "PATCH") {
            const body = await readBody(req);
            const updated = await updateReportGroup(project, group, {
              name: body.name,
              retentionDays: body.retentionDays,
            });
            return sendJson(res, 200, { group: updated });
          }
          const result = await deleteReportGroup(project, group);
          return sendJson(res, 200, { ok: true, ...result });
        } catch (error) {
          return sendJson(res, error?.status ?? 500, { error: String(error?.message ?? error) });
        }
      },
    },
    "/api/reports/visibility": {
      method: "POST",
      async handler(req, res) {
        try {
          const body = await readBody(req);
          const group = await setReportVisibility(body.project, body.group, body.visibility);
          return sendJson(res, 200, { group });
        } catch (error) {
          return sendJson(res, error?.status ?? 500, { error: String(error?.message ?? error) });
        }
      },
    },
    "/api/reports/sensitive": {
      method: "GET",
      async handler(req, res) {
        try {
          const query = queryOf(req);
          const report = await scanReportSensitive(query.get("project"), query.get("group"));
          return sendJson(res, 200, report);
        } catch (error) {
          return sendJson(res, error?.status ?? 500, { error: String(error?.message ?? error) });
        }
      },
    },
    "/api/reports/items": {
      method: "GET",
      async handler(req, res) {
        try {
          const query = queryOf(req);
          const payload = await listReportItems(query.get("project"), query.get("group"));
          return sendJson(res, 200, payload);
        } catch (error) {
          return sendJson(res, error?.status ?? 500, { error: String(error?.message ?? error) });
        }
      },
    },
    "/api/reports/item": {
      methods: ["GET", "DELETE"],
      async handler(req, res) {
        try {
          const query = queryOf(req);
          const project = query.get("project");
          const group = query.get("group");
          const stamp = query.get("stamp");
          if (req.method === "GET") {
            // 不传 stamp 时取最新一份，阅读页只需要一次请求。
            let target = stamp;
            if (!target) {
              const listed = await listReportItems(project, group);
              target = listed.reports[0]?.stamp ?? null;
              if (!target) throw Object.assign(new Error("这个报告组还没有任何报告"), { status: 404 });
            }
            return sendJson(res, 200, await readReportItem(project, group, target));
          }
          return sendJson(res, 200, await deleteReportItem(project, group, stamp));
        } catch (error) {
          return sendJson(res, error?.status ?? 500, { error: String(error?.message ?? error) });
        }
      },
    },
    "/api/reports/content": {
      method: "GET",
      async handler(req, res) {
        try {
          const query = queryOf(req);
          await sendReportContent(res, {
            project: query.get("project"),
            group: query.get("group"),
            stamp: query.get("stamp"),
            method: req.method,
          });
        } catch (error) {
          return sendJson(res, error?.status ?? 500, { error: String(error?.message ?? error) });
        }
      },
    },
    // ── 系统信息（容器 / workspace / 凭据总览） ───────────────────────────────
    // ── 数据清理 ────────────────────────────────────────────────────────
    // 体积 / 配置 / 上次执行结果；维护进行中也能查（前端据此显示进度）。
    "/api/cleanup/status": {
      method: "GET",
      async handler(req, res) {
        try {
          const status = await cleanupStatus();
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ ...status, maintenance: getMaintenance() }));
        } catch (error) {
          res.writeHead(500, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: error.message }));
        }
      },
    },
    "/api/cleanup/config": {
      method: "POST",
      async handler(req, res) {
        const input = await readBody(req);
        try {
          const config = await saveCleanupConfig(input);
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ ok: true, config }));
        } catch (error) {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: error.message }));
        }
      },
    },
    // 在线清理定时任务日志文件（不中断服务）。
    "/api/cleanup/logs": {
      method: "POST",
      async handler(req, res) {
        try {
          const result = await pruneAllLogs();
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ ok: true, result }));
        } catch (error) {
          res.writeHead(500, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: error.message }));
        }
      },
    },
    // 清理数据库并压缩：会短暂停止后台任务（清理 + VACUUM 需要独占 Storage）。
    "/api/cleanup/database": {
      method: "POST",
      async handler(req, res) {
        const input = await readBody(req);
        try {
          const outcome = await restartRuntime({
            reason: "manual",
            retentionDays: input.retentionDays,
            vacuum: input.vacuum,
          });
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ ok: true, ...outcome }));
        } catch (error) {
          res.writeHead(500, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: error.message }));
        }
      },
    },
    "/api/system": {
      method: "GET",
      async handler(req, res) {
        const cfg = await loadConfig();
        const providers = PROVIDER_LIST.map((p) => ({
          id: p.id,
          label: p.name,
          configured: !!cfg.providers?.[p.id]?.apiKey,
        }));
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({
          container: {
            image: process.env.PI_BOX_IMAGE ?? "localhost/pi-box_pi:latest",
            hostname: process.env.HOSTNAME ?? "—",
            node: process.version,
            platform: `${process.platform}/${process.arch}`,
            uptimeSec: Math.floor(process.uptime()),
            tz: process.env.TZ ?? "UTC",
          },
          paths: {
            workspace: PROJECTS_DIR,
            dataDir: DATA_DIR,
            globalAgents: join(PROJECTS_DIR, ".pi-box", "agents"),
            userSkills: USER_SKILLS_DIR,
            mcp: "/home/agent/.pi/agent/mcp.json",
          },
          providers,
        }));
      },
    },
  });
}

/** 维护窗口内（重建 Harness 期间）拒绝其它写/读请求，避免撞上正在关闭的存储。 */
function guardMaintenance(routes) {
  const allow = new Set(["/api/cleanup/status", "/api/cleanup/database"]);
  for (const [path, route] of Object.entries(routes)) {
    if (allow.has(path) || typeof route?.handler !== "function") continue;
    const original = route.handler;
    route.handler = async (req, res) => {
      if (isMaintenance()) {
        res.writeHead(503, { "Content-Type": "application/json" });
        return res.end(JSON.stringify({ error: "服务维护中（数据清理中），请稍后重试", maintenance: getMaintenance() }));
      }
      return original(req, res);
    };
  }
  return routes;
}
