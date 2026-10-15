// HTTP 路由（6 个 extraRoutes）
import { mkdir, rename, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { AgentDoc, configure } from "@earendil-works/pi-durable";
import { readBody, loadConfig, saveConfig, loadMcpConfig, saveMcpConfig, listSkills, setSkillEnabled, loadPrefs, savePrefs } from "./io.mjs";
import { PROJECTS_DIR, DATA_DIR, META_PROJECT, META_DIR } from "./paths.mjs";
import { refreshProvider, currentModel, testProviderConnection } from "./model.mjs";
import { PROVIDER_LIST, getAllProviderModels } from "./providers.mjs";
import { listProjects, listAgents, listAgentCatalog, listGlobalAgents, loadAssistant, saveAgentFile, renameAgentFile, deleteAgentFile, saveAssistantFile, assistantInstructions, resolveAgentModel, resolveAgentTools, agentFilePath } from "./agents.mjs";
import { renameSubagentRecords, syncAfterConfigChange, syncAllConfig } from "./harness.mjs";
import { validatePublicMcpConfig } from "./mcp-bridge.mjs";
import { deleteSchedule, listSchedules, loadScheduleStore, triggerSchedule, upsertSchedule } from "./schedules.mjs";

const NAME_RE = /^[a-zA-Z0-9_-]+$/;
const AGENT_NAME_RE = /^[\p{L}\p{N}_-]+$/u;

export function buildExtraRoutes(harness, context, mcpBridge) {
  return {
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
            agent: { model: resolveAgentModel(assistant.model), instructions: assistantInstructions(name, assistant, agents), cwd },
          },
          context,
        );
        console.log(`[project] 新建项目 ${name} → 会话 #${conv.id}`);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true, project: name, conversationId: conv.id }));
      },
    },
    // 项目重命名：目录与所有相关会话 cwd 一起更新
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
              modelId: value.modelId ?? "",
              baseUrl: value.baseUrl ?? "",
              hasKey: !!value.apiKey,
            }]),
          );
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ activeProvider: cfg.activeProvider, providers }));
          return;
        }
        let { provider, modelId, apiKey, baseUrl } = await readBody(req);
        if (!provider) provider = "openai";
        const meta = PROVIDER_LIST.find((p) => p.id === provider);
        if (!modelId) modelId = meta?.defaultModel || "gpt-4o";
        if (baseUrl === undefined) baseUrl = meta?.defaultBaseUrl || "";
        const modelsByProvider = await getAllProviderModels();
        const available = modelsByProvider[provider] ?? [];
        if (available.length > 0 && modelId && !available.includes(modelId)) {
          res.writeHead(400);
          res.end(JSON.stringify({ error: `模型 "${modelId}" 不在 ${provider} 的可用列表中`, available: available.slice(0, 30) }));
          return;
        }
        const old = await loadConfig();
        const previous = old.providers?.[provider] ?? {};
        // 兼容前端掩码：星号绝不能被当作真实密钥保存。
        if (apiKey === undefined || apiKey === null || apiKey === "" || /^\*+$/.test(apiKey)) apiKey = previous.apiKey || "";
        const next = {
          version: 2,
          activeProvider: provider,
          providers: { ...(old.providers ?? {}), [provider]: { modelId, apiKey, baseUrl } },
        };
        await saveConfig(next);
        const newHasKey = await refreshProvider();
        // 按各项目/agent 定义重新解析，而不是把所有会话粗暴覆盖成全局模型。
        await syncAllConfig(harness);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true, hasKey: newHasKey, provider, modelId, baseUrl, effectiveProvider: currentModel.provider }));
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
        const { project, name, oldName, scope = "project", model: m, tools, mcps, instructions } = await readBody(req);
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
          if (oldName && oldName !== name) {
            await renameAgentFile(project, oldName, name, scope);
            await renameSubagentRecords(harness, { scope, projectName: project, oldName, newName: name });
          }
          const file = await saveAgentFile(project, name, scope, { model: m, tools, mcps: Array.isArray(mcps) ? mcps : [], instructions });
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
        const { project, model: m, agents, instructions } = await readBody(req);
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
          const file = await saveAssistantFile(project, { model: m, agents: selectedGlobals, instructions });
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
    // ── Skill 列表与启停 ─────────────────────────────────────────────────
    "/api/skills": {
      method: "GET",
      async handler(req, res) {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ skills: await listSkills() }));
      },
    },
    "/api/skills/toggle": {
      method: "POST",
      async handler(req, res) {
        const { name, enabled } = await readBody(req);
        if (!name) { res.writeHead(400); return res.end(JSON.stringify({ error: "缺少 name" })); }
        await setSkillEnabled(name, !!enabled);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true, name, enabled: !!enabled }));
      },
    },
    // ── UI 偏好 ─────────────────────────────────────────────────────────
    "/api/prefs": {
      methods: ["GET", "POST"],
      async handler(req, res) {
        if (req.method === "GET") {
          res.writeHead(200, { "Content-Type": "application/json" });
          return res.end(JSON.stringify(await loadPrefs()));
        }
        const incoming = await readBody(req);
        const current = await loadPrefs();
        const merged = { ...current, ...incoming };
        await savePrefs(merged);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(merged));
      },
    },
    // ── 系统信息（容器 / workspace / 凭据总览） ───────────────────────────────
    "/api/system": {
      method: "GET",
      async handler(req, res) {
        const cfg = await loadConfig();
        const providers = PROVIDER_LIST.map((p) => ({
          id: p.id,
          label: p.label,
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
            userSkills: "/home/agent/.pi/agent/skills",
            mcp: "/home/agent/.pi/agent/mcp.json",
          },
          providers,
        }));
      },
    },
  };
}
