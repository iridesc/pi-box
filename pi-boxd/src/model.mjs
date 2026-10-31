// 全局 model 状态：把所有已配置厂商（含各自模型）都加载进 pi-ai 的 Models 集合，
// 让 agent 可以按 provider/modelId 自由选择模型；无任何 key 时回退 faux。
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxProvider } from "@earendil-works/pi-ai/providers/faux";
import { loadConfig, providerConfig, configuredProviders } from "./io.mjs";
import { PROVIDERS, makeAuthContext } from "./providers.mjs";

const models = createModels({ authContext: makeAuthContext() });

let model = { provider: "openai", modelId: "gpt-4o" };
let useFaux = true;
let faux = null;
let hasKey = false;
// config 里存的厂商 id → 实际 provider 实例 id（minimax-cn 用 minimaxProvider 时是 "minimax"）。
const instanceByConfig = new Map();

export { models, model as currentModel };

/** 从厂商目录里挑一个确实存在的 modelId（找不到就回退第一个，再不行用默认）。 */
function pickAvailableModel(providerInstance, preferredIds, def) {
  let available = [];
  try {
    available = (providerInstance.getModels?.() ?? []).map((m) => m.id);
  } catch {
    available = [];
  }
  const candidates = (Array.isArray(preferredIds) ? preferredIds : [preferredIds]).map(String).filter(Boolean);
  for (const id of candidates) {
    if (available.length === 0 || available.includes(id)) return id;
  }
  if (available.length > 0) return available[0];
  return def.defaultModel;
}

/** 加载单个厂商：创建 provider 实例、应用 baseUrl 覆盖、注册进 models。 */
async function loadProvider(providerId, saved) {
  const def = PROVIDERS[providerId];
  if (!def) return null;
  const p = await def.load();
  if (saved.baseUrl) {
    p.baseUrl = saved.baseUrl;
    // pi-ai 用 model.baseUrl（不是 provider.baseUrl），所以改模型定义
    const all = typeof p.getAllModels === "function" ? p.getAllModels() : [];
    for (const m of all) m.baseUrl = saved.baseUrl;
  }
  models.setProvider(p);
  return { instance: p, def };
}

/** 把「config 厂商 id + modelId」解析成 durable 可用的模型引用（实际实例 id）。找不到返回 null。 */
export function resolveModelRef(providerId, modelId) {
  if (!providerId || !modelId) return null;
  const instanceId = instanceByConfig.get(providerId) ?? providerId;
  if (models.getModel(instanceId, modelId)) return { provider: instanceId, modelId };
  if (instanceId !== providerId && models.getModel(providerId, modelId)) return { provider: providerId, modelId };
  return null;
}

/** 初始化 providers（读 config.json）：加载所有有 key 的厂商；无任何 key 用 faux。返回是否配置了 key。 */
export async function initProvider() {
  const cfg = await loadConfig();
  for (const p of models.getProviders()) models.deleteProvider(p.id);
  instanceByConfig.clear();
  const loaded = new Map(); // providerId -> { instance, def }
  for (const id of configuredProviders(cfg)) {
    const saved = providerConfig(cfg, id);
    const result = await loadProvider(id, saved);
    if (result) {
      loaded.set(id, result);
      instanceByConfig.set(id, result.instance.id);
    }
  }
  hasKey = loaded.size > 0;

  if (hasKey) {
    // 全局默认模型：优先 activeProvider，其次第一个已配置厂商。
    let activeId = cfg.activeProvider;
    if (!loaded.has(activeId)) activeId = [...loaded.keys()][0];
    const saved = providerConfig(cfg, activeId);
    const { instance, def } = loaded.get(activeId);
    const modelId = pickAvailableModel(instance, saved.models, def);
    // durable 用 models.getModel(provider, modelId) 解析，provider 必须是实际实例 id。
    model = { provider: instance.id, modelId };
    useFaux = false;
  } else {
    useFaux = true;
    faux = fauxProvider();
    model = { provider: "faux", modelId: "faux-1" };
    models.setProvider(faux.provider);
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
