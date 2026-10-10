// HTTP 路由（6 个 extraRoutes）
import { mkdir } from "node:fs/promises";
import { join, dirname } from "node:path";
import { AgentDoc, configure } from "@earendil-works/pi-durable";
import { readBody, loadConfig, saveConfig } from "./io.mjs";
import { PROJECTS_DIR } from "./paths.mjs";
import { refreshProvider, models, currentModel } from "./model.mjs";
import { PROVIDER_LIST, getAllProviderModels } from "./providers.mjs";
import { listProjects, listAgents, loadAgentDef, loadAssistant, saveAgentFile, deleteAgentFile, saveAssistantFile, assistantInstructions, resolveAgentModel } from "./agents.mjs";
import { syncAfterConfigChange } from "./harness.mjs";

const NAME_RE = /^[a-zA-Z0-9_-]+$/;

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
    // provider 列表（含真实模型）
    "/api/providers": {
      method: "GET",
      async handler(req, res) {
        const modelsByProvider = await getAllProviderModels();
        const providers = PROVIDER_LIST.map((p) => {
          const ms = modelsByProvider[p.id] ?? [];
          return { ...p, models: ms, defaultModel: ms[0] ?? p.defaultModel };
        });
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ providers }));
      },
    },
    // 模型设置
    "/api/settings": {
      methods: ["GET", "POST"],
      async handler(req, res) {
        if (req.method === "GET") {
          const cfg = await loadConfig();
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ provider: cfg.provider, modelId: cfg.modelId, baseUrl: cfg.baseUrl, hasKey: !!cfg.apiKey }));
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
        if (apiKey === undefined || apiKey === null) apiKey = old.apiKey || "";
        await saveConfig({ provider, modelId, apiKey, baseUrl });
        const newHasKey = await refreshProvider();
        // 重配所有会话的 model
        const { items: records } = await harness.commit((tx) => tx.scanConversations({}, 1000, undefined), context);
        for (const rec of records) {
          const a = await harness.snapshot(AgentDoc, rec.id, context);
          if (a && a.model?.provider !== currentModel.provider) {
            await harness.commit((tx) => configure(tx, rec.id, { model: { provider: currentModel.provider, modelId: currentModel.modelId } }), context);
          }
        }
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
        if (!name || !NAME_RE.test(name)) {
          res.writeHead(400);
          res.end(JSON.stringify({ error: "agent 名只能含字母、数字、-、_" }));
          return;
        }
        if (scope === "project" && !project) {
          res.writeHead(400);
          res.end(JSON.stringify({ error: "项目级 agent 需要 project 参数" }));
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
