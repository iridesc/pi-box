// 支持的 LLM provider 列表（按需动态 import factory）。
// 每个 entry 含：name（展示）、defaultModel/defaultBaseUrl（前端默认）、keyEnv（pi-ai auth 查的 env 名）、load（动态 import factory）。
export const PROVIDERS = {
  openai: { name: "OpenAI", defaultModel: "gpt-4o", defaultBaseUrl: "https://api.openai.com/v1", keyEnv: "OPENAI_API_KEY", load: () => import("@earendil-works/pi-ai/providers/openai").then((m) => m.openaiProvider()) },
  deepseek: { name: "DeepSeek", defaultModel: "deepseek-flash", defaultBaseUrl: "https://api.deepseek.com/v1", keyEnv: "DEEPSEEK_API_KEY", load: () => import("@earendil-works/pi-ai/providers/deepseek").then((m) => m.deepseekProvider()) },
  moonshotai: { name: "Moonshot (Kimi)", defaultModel: "kimi-k2.6", defaultBaseUrl: "https://api.moonshot.cn/v1", keyEnv: "MOONSHOT_API_KEY", load: () => import("@earendil-works/pi-ai/providers/moonshotai").then((m) => m.moonshotaiProvider()) },
  google: { name: "Google Gemini", defaultModel: "gemini-2.5-flash", defaultBaseUrl: "", keyEnv: "GEMINI_API_KEY", load: () => import("@earendil-works/pi-ai/providers/google").then((m) => m.googleProvider()) },
  groq: { name: "Groq", defaultModel: "llama-3.3-70b-versatile", defaultBaseUrl: "https://api.groq.com/openai/v1", keyEnv: "GROQ_API_KEY", load: () => import("@earendil-works/pi-ai/providers/groq").then((m) => m.groqProvider()) },
  openrouter: { name: "OpenRouter", defaultModel: "openai/gpt-4o", defaultBaseUrl: "https://openrouter.ai/api/v1", keyEnv: "OPENROUTER_API_KEY", load: () => import("@earendil-works/pi-ai/providers/openrouter").then((m) => m.openrouterProvider()) },
  mistral: { name: "Mistral", defaultModel: "codestral-latest", defaultBaseUrl: "https://api.mistral.ai/v1", keyEnv: "MISTRAL_API_KEY", load: () => import("@earendil-works/pi-ai/providers/mistral").then((m) => m.mistralProvider()) },
  xai: { name: "xAI (Grok)", defaultModel: "grok-4.3", defaultBaseUrl: "https://api.x.ai/v1", keyEnv: "XAI_API_KEY", load: () => import("@earendil-works/pi-ai/providers/xai").then((m) => m.xaiProvider()) },
  anthropic: { name: "Anthropic Claude", defaultModel: "claude-fable-5", defaultBaseUrl: "https://api.anthropic.com", keyEnv: "ANTHROPIC_API_KEY", load: () => import("@earendil-works/pi-ai/providers/anthropic").then((m) => m.anthropicProvider()) },
  minimax: { name: "MiniMax (国际)", defaultModel: "MiniMax-M2.7", defaultBaseUrl: "https://api.minimax.io/anthropic", keyEnv: "MINIMAX_API_KEY", load: () => import("@earendil-works/pi-ai/providers/minimax").then((m) => m.minimaxProvider()) },
  "minimax-cn": { name: "MiniMax (中国)", defaultModel: "MiniMax-M2.7", defaultBaseUrl: "https://api.minimaxi.com/anthropic", keyEnv: "MINIMAX_API_KEY", load: () => import("@earendil-works/pi-ai/providers/minimax").then((m) => m.minimaxProvider()) },
};

// 给前端用的元数据列表（不含 load 函数）
export const PROVIDER_LIST = Object.entries(PROVIDERS).map(([id, p]) => ({
  id,
  name: p.name,
  defaultModel: p.defaultModel,
  defaultBaseUrl: p.defaultBaseUrl,
}));

// 懒加载 + 缓存所有 provider 的真实模型列表
let providerModelsCache = null;
export async function getAllProviderModels() {
  if (providerModelsCache) return providerModelsCache;
  const result = {};
  for (const [id, def] of Object.entries(PROVIDERS)) {
    try {
      const p = await def.load();
      result[id] = (await p.getModels()).map((m) => m.id);
    } catch {
      result[id] = [];
    }
  }
  providerModelsCache = result;
  return result;
}

// 构造 pi-ai 的 authContext：让 auth resolve 从 config.json 读 key（回退到 process.env）
import { stat } from "node:fs/promises";
import { loadConfig } from "./io.mjs";

export function makeAuthContext() {
  return {
    async env(name) {
      const cfg = await loadConfig();
      if (cfg?.apiKey) {
        const def = PROVIDERS[cfg.provider];
        if (def && name === def.keyEnv) return cfg.apiKey;
        // anthropic 协议还可能查 ANTHROPIC_AUTH_TOKEN
        if (def && def.keyEnv === "ANTHROPIC_API_KEY" && name === "ANTHROPIC_AUTH_TOKEN") return cfg.apiKey;
      }
      return process.env[name];
    },
    async fileExists(path) {
      try {
        await stat(path.replace(/^~/, process.env.HOME ?? ""));
        return true;
      } catch {
        return false;
      }
    },
  };
}
