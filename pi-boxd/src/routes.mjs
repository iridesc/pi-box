// HTTP 路由（6 个 extraRoutes）
import { mkdir, rename } from "node:fs/promises";
import { join } from "node:path";
import { AgentDoc, configure } from "@earendil-works/pi-durable";
import { readBody, loadConfig, saveConfig } from "./io.mjs";
import { PROJECTS_DIR } from "./paths.mjs";
import { refreshProvider, currentModel, testProviderConnection } from "./model.mjs";
import { PROVIDER_LIST, getAllProviderModels } from "./providers.mjs";
import { listProjects, listAgents, loadAssistant, saveAgentFile, deleteAgentFile, saveAssistantFile, assistantInstructions, resolveAgentModel, resolveAgentTools } from "./agents.mjs";
import { syncAfterConfigChange, syncAllConfig } from "./harness.mjs";

const NAME_RE = /^[a-zA-Z0-9_-]+$/;
const AGENT_NAME_RE = /^[\p{L}\p{N}_-]+$/u;

export function buildExtraRoutes(harness, context) {
  return {
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
        const { project, name, scope = "global", model: m, tools, instructions } = await readBody(req);
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
        const file = await saveAgentFile(project, name, scope, { model: m, tools, instructions });
        await syncAfterConfigChange(harness, { scope, projectName: project, agentName: name });
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true, name, scope, file }));
      },
    },
    // agent 删除
    "/api/agents/delete": {
      method: "POST",
      async handler(req, res) {
        const { project, name, scope = "global" } = await readBody(req);
        if (!name) {
          res.writeHead(400);
          res.end(JSON.stringify({ error: "缺少 name" }));
          return;
        }
        await deleteAgentFile(project, name, scope);
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
        const file = await saveAssistantFile(project, { model: m, agents, instructions });
        await syncAfterConfigChange(harness, { scope: "project", projectName: project, agentName: null });
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true, file }));
      },
    },
  };
}
