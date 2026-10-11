// 全局 model 状态：当前 provider/modelId，是否 faux 模式
// 暴露给需要"知道当前模型"的地方（如 agent 定义里写死 model 的 fallback）
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxProvider } from "@earendil-works/pi-ai/providers/faux";
import { loadConfig, activeProviderConfig } from "./io.mjs";
import { PROVIDERS, makeAuthContext } from "./providers.mjs";

const models = createModels({ authContext: makeAuthContext() });

let model = { provider: "openai", modelId: "gpt-4o" };
let useFaux = true;
let faux = null;
let hasKey = false;
// 实际 provider id（minimax-cn 用 minimaxProvider 时是 "minimax"）。configure 子会话时要用这个。
let currentModelProvider = "faux";

export { models, model as currentModel };

/** 初始化 provider（读 config.json）。有 key 用真实 provider，无 key 用 faux。返回是否配置了 key。 */
export async function initProvider() {
  const cfg = activeProviderConfig(await loadConfig());
  for (const p of models.getProviders()) models.deleteProvider(p.id);
  if (cfg.apiKey) {
    const def = PROVIDERS[cfg.provider] ?? PROVIDERS.openai;
    useFaux = false;
    const p = await def.load();
    if (cfg.baseUrl) {
      p.baseUrl = cfg.baseUrl;
      // pi-ai 用 model.baseUrl（不是 provider.baseUrl），所以改模型定义
      const all = typeof p.getAllModels === "function" ? p.getAllModels() : [];
      for (const m of all) m.baseUrl = cfg.baseUrl;
    }
    models.setProvider(p);
    currentModelProvider = p.id;
    let modelId = cfg.modelId;
    try {
      const available = (await p.getModels()).map((m) => m.id);
      if (available.length > 0 && modelId && !available.includes(modelId)) {
        console.warn(`[config] 模型 "${modelId}" 不在 ${cfg.provider} 列表中，自动改用 "${available[0]}"`);
        modelId = available[0];
      }
    } catch {
      /* ignore */
    }
    model = { provider: p.id, modelId };
    hasKey = true;
  } else {
    useFaux = true;
    faux = fauxProvider();
    currentModelProvider = "faux";
    model = { provider: "faux", modelId: "faux-1" };
    models.setProvider(faux.provider);
    hasKey = false;
  }
  return hasKey;
}

/** 用未保存或已保存的单个厂商配置发起最小真实请求。 */
export async function testProviderConnection({ provider, modelId, apiKey, baseUrl }) {
  const def = PROVIDERS[provider];
  if (!def) throw new Error(`未知 Provider：${provider}`);
  if (!apiKey) throw new Error("请先填写或保存 API Key");
  const testModels = createModels({
    authContext: {
      async env(name) {
        if (name === def.keyEnv || (def.keyEnv === "ANTHROPIC_API_KEY" && name === "ANTHROPIC_AUTH_TOKEN")) return apiKey;
        return undefined;
      },
      async fileExists() { return false; },
    },
  });
  const p = await def.load();
  if (baseUrl) {
    p.baseUrl = baseUrl;
    for (const m of typeof p.getAllModels === "function" ? p.getAllModels() : []) m.baseUrl = baseUrl;
  }
  testModels.setProvider(p);
  const available = (await p.getModels()).map((m) => m.id);
  const selected = modelId || available[0] || def.defaultModel;
  const candidate = testModels.getModel(p.id, selected);
  if (!candidate) throw new Error(`模型不存在：${selected}`);
  const started = Date.now();
  const reply = await testModels.completeSimple(candidate, {
    messages: [{ role: "user", content: "Reply with OK only.", timestamp: Date.now() }],
  });
  if (reply.stopReason === "error") throw new Error(reply.errorMessage || "模型请求失败");
  return { ok: true, provider: p.id, modelId: selected, latencyMs: Date.now() - started };
}

export async function refreshProvider() {
  hasKey = await initProvider();
  return hasKey;
}

export function getHasKey() {
  return hasKey;
}

export function getUseFaux() {
  return useFaux;
}

export function getFaux() {
  return faux;
}
