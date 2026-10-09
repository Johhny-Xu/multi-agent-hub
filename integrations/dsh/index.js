import { fileURLToPath } from "node:url";
import { connectionUrl } from "./mcp/config.mjs";

export const name = "agenthub-bridge";
export const inject = ["tools"];

function endpoint(value) {
  if (value === undefined) return undefined;
  const url = new URL(connectionUrl(value, true));
  url.searchParams.delete("token");
  url.searchParams.sort();
  return url.href;
}

function sameEndpoint(left, right) {
  try { return endpoint(left) === endpoint(right); }
  catch { return false; }
}

// Build complete official mcp-client config; the package owns its entry path.
export function bridgeOptions(config = {}) {
  if (!config || typeof config !== "object" || Array.isArray(config)) throw new Error("AgentHub config must be an object");
  if (config.env !== undefined && (!config.env || typeof config.env !== "object" || Array.isArray(config.env))) throw new Error("AgentHub env must be an object");
  const env = { ...config.env };
  for (const value of Object.values(env)) if (typeof value !== "string") throw new Error("AgentHub env values must be strings");
  const ownUrl = config.url ?? env.AGENTHUB_URL ?? env.HUB_MCP_URL;
  const ambientUrl = process.env.AGENTHUB_URL ?? process.env.HUB_MCP_URL;
  const filePath = env.AGENTHUB_CONFIG ?? env.AGENTHUB_CONFIG_FILE;
  if (env.AGENTHUB_CONNECTION_MODE === "file" && (config.url !== undefined || config.token !== undefined)) {
    throw new Error("Choose a connection file or explicit URL/token, not both");
  }
  if (filePath !== undefined && ownUrl === undefined && config.token === undefined && env.HUB_TOKEN === undefined) {
    env.AGENTHUB_CONNECTION_MODE = "file";
  }
  const fileMode = env.AGENTHUB_CONNECTION_MODE === "file";
  const url = fileMode ? undefined : ownUrl ?? ambientUrl;
  let token = fileMode ? undefined : config.token;
  if (!fileMode && token === undefined && env.HUB_TOKEN !== undefined) {
    const envUrl = env.AGENTHUB_URL ?? env.HUB_MCP_URL;
    if (config.url === undefined || envUrl === undefined || sameEndpoint(config.url, envUrl)) token = env.HUB_TOKEN;
  }
  if (!fileMode && token === undefined && url !== undefined && ambientUrl !== undefined && sameEndpoint(url, ambientUrl)) {
    token = process.env.HUB_TOKEN;
  }
  if (!fileMode && token === undefined && ownUrl !== undefined) token = "";
  if (url !== undefined) {
    if (typeof url !== 'string') throw new Error('AgentHub URL must be a string');
    const endpoint = new URL(url);
    if (!["http:", "https:"].includes(endpoint.protocol) || endpoint.username || endpoint.password || endpoint.hash) throw new Error("Invalid AgentHub URL");
    env.AGENTHUB_URL = endpoint.href;
  }
  if (token !== undefined) {
    if (typeof token !== 'string' || /[\r\n]/.test(token)) throw new Error('AgentHub token must be a single-line string');
    env.HUB_TOKEN = token;
  }
  const toolCallTimeoutMs = config.toolCallTimeoutMs ?? 310000;
  if (!Number.isInteger(toolCallTimeoutMs) || toolCallTimeoutMs < 1000 || toolCallTimeoutMs > 2147483647) throw new Error("Invalid toolCallTimeoutMs");
  if (config.command !== undefined && (typeof config.command !== "string" || !config.command.trim())) throw new Error("Invalid command");
  if (config.cwd !== undefined && typeof config.cwd !== "string") throw new Error("Invalid cwd");
  if (config.failOnStartupError !== undefined && typeof config.failOnStartupError !== "boolean") throw new Error("Invalid failOnStartupError");
  return {
    serverName: "agenthub", transport: "stdio", command: config.command ?? "node",
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
