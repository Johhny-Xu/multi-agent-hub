import { fileURLToPath } from "node:url";

export const name = "agenthub-bridge";
export const inject = ["tools"];

// Build complete official mcp-client config; the package owns its entry path.
export function bridgeOptions(config = {}) {
  if (!config || typeof config !== "object" || Array.isArray(config)) throw new Error("AgentHub config must be an object");
  if (config.env !== undefined && (!config.env || typeof config.env !== "object" || Array.isArray(config.env))) throw new Error("AgentHub env must be an object");
  const env = { ...config.env };
  for (const value of Object.values(env)) if (typeof value !== "string") throw new Error("AgentHub env values must be strings");
  env.AGENTHUB_URL = config.url ?? env.AGENTHUB_URL ?? process.env.AGENTHUB_URL ?? "http://127.0.0.1:8765/mcp";
  env.HUB_TOKEN = config.token ?? env.HUB_TOKEN ?? process.env.HUB_TOKEN ?? "";
  if (typeof env.AGENTHUB_URL !== "string" || typeof env.HUB_TOKEN !== "string") throw new Error("AgentHub URL and token must be strings");
  const endpoint = new URL(env.AGENTHUB_URL);
  if (!["http:", "https:"].includes(endpoint.protocol) || endpoint.username || endpoint.password || endpoint.hash) throw new Error("Invalid AgentHub URL");
  const toolCallTimeoutMs = config.toolCallTimeoutMs ?? 310000;
  if (!Number.isInteger(toolCallTimeoutMs) || toolCallTimeoutMs < 1000 || toolCallTimeoutMs > 2147483647) throw new Error("Invalid toolCallTimeoutMs");
  if (config.command !== undefined && (typeof config.command !== "string" || !config.command.trim())) throw new Error("Invalid command");
  if (config.cwd !== undefined && typeof config.cwd !== "string") throw new Error("Invalid cwd");
  if (config.failOnStartupError !== undefined && typeof config.failOnStartupError !== "boolean") throw new Error("Invalid failOnStartupError");
  return {
    serverName: "agenthub", transport: "stdio", command: config.command ?? process.execPath,
    args: [fileURLToPath(new URL("./mcp/server.mjs", import.meta.url))], env,
    cwd: config.cwd ?? "", toolCallTimeoutMs, failOnStartupError: config.failOnStartupError ?? true,
    maxInstructionBytes: 32768,
    reconnect: { enabled: true, initialDelayMs: 500, maxDelayMs: 30000, maxAttempts: 10 },
  };
}

// Reuse the host's namespace plugin and its effect-scoped connection lifecycle.
export async function apply(ctx, config = {}) {
  const client = await import("@deepseek-ai/dsh-mcp-client");
  await client.apply(ctx, bridgeOptions(config));
}
