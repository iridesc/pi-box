import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { Type } from "@earendil-works/pi-ai";
import { defineExtension, defineTool } from "@earendil-works/pi-durable";
import { McpClient, StdioTransport, StreamableHttpTransport, toLlmContent } from "@earendil-works/pi-mcp";

import { loadMcpConfig } from "./io.mjs";
import { PROJECTS_DIR } from "./paths.mjs";
import { setMcpToolsByServer } from "./agents.mjs";

const NAME_RE = /^[A-Za-z0-9_-]+$/;
const EXPOSURES = new Set(["codemode", "codemode-deferred", "deferred", "direct", "hidden"]);

function expandValue(value) {
  if (typeof value !== "string") return value;
  return value.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (_, name) => process.env[name] ?? "");
}

function resolvedRecord(record = {}) {
  return Object.fromEntries(Object.entries(record).map(([key, value]) => [key, expandValue(value)]));
}

export function validatePublicMcpConfig(name, config) {
  if (!NAME_RE.test(name)) throw new Error(`MCP 名称只能含字母、数字、-、_：${name}`);
  if (!config || typeof config !== "object" || Array.isArray(config)) throw new Error(`MCP "${name}" 配置无效`);
  const hasUrl = typeof config.url === "string" && config.url.length > 0;
  const hasCommand = typeof config.command === "string" && config.command.length > 0;
  if (hasUrl === hasCommand) throw new Error(`MCP "${name}" 必须且只能配置 url 或 command`);
  const exposure = config.exposure ?? "codemode";
  if (!EXPOSURES.has(exposure)) throw new Error(`MCP "${name}" 的 exposure 无效：${exposure}`);
  for (const [pattern, toolExposure] of Object.entries(config.toolExposure ?? {})) {
    if (!EXPOSURES.has(toolExposure)) throw new Error(`MCP "${name}" 的工具规则 ${pattern} exposure 无效：${toolExposure}`);
  }
  return { ...config, exposure };
}

function transportFor(name, config) {
  if (config.url) {
    return new StreamableHttpTransport({
      url: expandValue(config.url),
      headers: resolvedRecord(config.headers),
      openGetStream: true,
    });
  }
  return new StdioTransport({
    command: expandValue(config.command),
    args: (config.args ?? []).map(expandValue),
    cwd: resolve(PROJECTS_DIR, expandValue(config.cwd ?? ".")),
    env: resolvedRecord(config.env),
    inheritEnv: true,
    stderr: "pipe",
  });
}

function normalizePart(value) {
  return value.replace(/[^A-Za-z0-9_]/g, "_");
}

function toolName(server, tool, used) {
  const base = `mcp__${normalizePart(server)}__${normalizePart(tool)}`;
  let candidate = base.slice(0, 64);
  if (!used.has(candidate)) return candidate;
  const suffix = `_${createHash("sha256").update(`${server}\0${tool}`).digest("hex").slice(0, 8)}`;
  candidate = `${base.slice(0, 64 - suffix.length)}${suffix}`;
  return candidate;
}

function globMatches(pattern, value) {
  const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replaceAll("*", ".*");
  return new RegExp(`^${escaped}$`).test(value);
}

function exposureFor(config, toolName) {
  const overrides = config.toolExposure ?? {};
  if (Object.hasOwn(overrides, toolName)) return overrides[toolName];
  for (const [pattern, exposure] of Object.entries(overrides)) {
    if (pattern.includes("*") && globMatches(pattern, toolName)) return exposure;
  }
  return config.exposure === "codemode-deferred" ? "codemode" : config.exposure;
}

function durableTool(serverName, config, client, mcpTool, used) {
  const exposure = exposureFor(config, mcpTool.name);
  if (exposure === "hidden") return null;
  const name = toolName(serverName, mcpTool.name, used);
  used.add(name);
  return defineTool({
    name,
    description: mcpTool.description || mcpTool.title || `${serverName}: ${mcpTool.name}`,
    parameters: Type.Unsafe({
      ...mcpTool.inputSchema,
      type: "object",
      properties: mcpTool.inputSchema?.properties ?? {},
    }),
    annotations: mcpTool.annotations,
    replay: "unsafe",
    ...(exposure === "codemode" ? { callers: ["tools"] } : {}),
    ...(exposure === "deferred" ? { deferred: true } : {}),
    async execute(args, api) {
      const result = await client.callTool(mcpTool.name, args, {
        timeoutMs: (config.timeout ?? 60) * 1000,
        onProgress: (progress) => api.output(`MCP ${serverName}/${mcpTool.name}: ${progress.progress}${progress.total ? `/${progress.total}` : ""}\n`),
      });
      return {
        output: toLlmContent(result),
        isError: result.isError === true,
        details: { server: serverName, tool: mcpTool.name },
      };
    },
  });
}

export function createDurableMcpTools(serverName, config, client, listedTools, used = new Set()) {
  return listedTools.map((tool) => durableTool(serverName, config, client, tool, used)).filter(Boolean);
}

export class McpDurableBridge {
  constructor(registry) {
    this.registry = registry;
    this.connections = new Map();
    this.extensions = new Map();
    this.toolsByServer = new Map();
    this.status = new Map();
  }

  async reload() {
    await this.close();
    const { mcpServers = {} } = await loadMcpConfig();
    const used = new Set();
    const normalizedServers = new Set();
    for (const [name, rawConfig] of Object.entries(mcpServers)) {
      if (rawConfig.enabled === false) continue;
      try {
        const config = validatePublicMcpConfig(name, rawConfig);
        const normalizedServer = normalizePart(name);
        if (normalizedServers.has(normalizedServer)) throw new Error(`MCP 名称与另一服务规范化后冲突：${name}`);
        normalizedServers.add(normalizedServer);
        const client = new McpClient({ name: "pi-box", version: "0.1.0", requestTimeoutMs: (config.timeout ?? 60) * 1000 });
        await client.connect(transportFor(name, config));
        const listed = await client.listTools();
        const tools = createDurableMcpTools(name, config, client, listed, used);
        const extension = defineExtension({ name: `mcp:${name}`, tools });
        this.registry.install(extension);
        this.connections.set(name, client);
        this.extensions.set(name, extension);
        this.toolsByServer.set(name, tools);
        this.status.set(name, { connected: true, tools: tools.map((tool) => tool.name), error: null });
      } catch (error) {
        this.status.set(name, { connected: false, tools: [], error: error instanceof Error ? error.message : String(error) });
        console.error(`[mcp] ${name} 连接失败：${this.status.get(name).error}`);
      }
    }
    setMcpToolsByServer(this.toolsByServer);
    return this.snapshot();
  }

  snapshot() {
    return Object.fromEntries(this.status);
  }

  async test(name) {
    const { mcpServers = {} } = await loadMcpConfig();
    const rawConfig = mcpServers[name];
    if (!rawConfig) throw new Error(`不存在 MCP server "${name}"`);
    const config = validatePublicMcpConfig(name, rawConfig);
    const client = new McpClient({ name: "pi-box", version: "0.1.0", requestTimeoutMs: (config.timeout ?? 60) * 1000 });
    try {
      await client.connect(transportFor(name, config));
      return (await client.listTools()).map((tool) => ({ name: tool.name, description: tool.description ?? "" }));
    } finally {
      await client.close();
    }
  }

  async close() {
    for (const extension of this.extensions.values()) this.registry.uninstall(extension);
    await Promise.allSettled([...this.connections.values()].map((client) => client.close()));
    this.connections.clear();
    this.extensions.clear();
    this.toolsByServer.clear();
    this.status.clear();
    setMcpToolsByServer(this.toolsByServer);
  }
}
