// 极简 MCP stdio server（PoC 用），协议对齐官方 fixture（protocolVersion 2025-06-18）
// newline-delimited JSON-RPC 2.0 over stdio
import { createInterface } from "node:readline";

const TOOLS = [
  {
    name: "echo",
    description: "Echo back the input text",
    inputSchema: {
      type: "object",
      properties: { text: { type: "string" } },
      required: ["text"],
    },
  },
  {
    name: "add",
    description: "Add two numbers",
    inputSchema: {
      type: "object",
      properties: { a: { type: "number" }, b: { type: "number" } },
      required: ["a", "b"],
    },
  },
];

const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });

for await (const line of lines) {
  let message;
  try {
    message = JSON.parse(line);
  } catch {
    continue;
  }
  if (!("id" in message)) continue;

  let result;
  if (message.method === "initialize") {
    result = {
      protocolVersion: "2025-06-18",
      capabilities: { tools: {} },
      serverInfo: { name: "poc-mcp", version: "0.0.1" },
    };
  } else if (message.method === "tools/list") {
    result = { tools: TOOLS };
  } else if (message.method === "tools/call") {
    const { name, arguments: args } = message.params;
    let text;
    if (name === "echo") text = String(args.text);
    else if (name === "add") text = String(Number(args.a) + Number(args.b));
    else text = `unknown tool: ${name}`;
    result = { content: [{ type: "text", text }], isError: false };
  } else if (message.method === "ping") {
    result = {};
  } else {
    process.stdout.write(
      `${JSON.stringify({ jsonrpc: "2.0", id: message.id, error: { code: -32601, message: "method not found" } })}\n`,
    );
    continue;
  }
  process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id: message.id, result })}\n`);
}
