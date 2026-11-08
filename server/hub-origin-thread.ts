// The thread that asked for the work, carried into the hub's own MCP server.
//
// A dispatch only knows which conversation asked for it when the caller says so: the hub client
// (mcp/hub.mjs) sends `X-Hub-Origin-Thread` on every tools/call, and that thread id comes from
// here. A stdio hub bridge reads it from its environment; a URL hub server gets it as a request
// header. Without it the hub knows a task, never who asked, and cannot report back.
//
// Only the hub's own server is marked: a third-party MCP server never sees this thread's id.

import type { McpServerSpec } from "./contracts.ts";

/** The environment variable a stdio hub bridge reads. */
export const HUB_ORIGIN_ENV = "HUB_ORIGIN_THREAD";
/** The request header a URL hub server receives. */
export const HUB_ORIGIN_HEADER = "X-Hub-Origin-Thread";

/** The names a person gives the hub's MCP server in Apps → MCP servers. */
const HUB_NAMES = /^(hub|agenthub|multi[-_]?agent[-_]?hub)$/i;
/** The connection variables the hub client itself reads (mcp/config.mjs). */
const HUB_ENV = ["AGENTHUB_URL", "HUB_MCP_URL", "AGENTHUB_CONNECTION_MODE"];

/** True for the hub's own MCP server: by the name it is saved under, or by the connection it names. */
export function isHubMcpServer(name: string, spec: McpServerSpec): boolean {
  if (HUB_NAMES.test(name)) return true;
  const env = (spec as { env?: Record<string, string> }).env;
  if (env && HUB_ENV.some((key) => typeof env[key] === "string" && env[key]!.trim())) return true;
  const url = (spec as { url?: string }).url;
  if (typeof url === "string") {
    try {
      const parsed = new URL(url);
      // The hub serves MCP at /mcp on this machine; a remote server is never the hub.
      return parsed.pathname === "/mcp" && ["127.0.0.1", "localhost", "::1", "[::1]"].includes(parsed.hostname);
    } catch {
      return false;
    }
  }
  return false;
}

/**
 * Marks the hub's MCP server with the thread that asked for the work. The specs are copied
 * before they are changed, so the saved server never carries a thread id.
 */
export function markHubOriginThread(custom: Record<string, McpServerSpec>, threadId: string): void {
  if (!threadId) return;
  for (const [name, spec] of Object.entries(custom)) {
    if (!isHubMcpServer(name, spec)) continue;
    const env = (spec as { env?: Record<string, string> }).env;
    const headers = (spec as { headers?: Record<string, string> }).headers;
    if (env) {
      (custom as Record<string, McpServerSpec>)[name] = { ...spec, env: { ...env, [HUB_ORIGIN_ENV]: threadId } };
    } else if (headers) {
      (custom as Record<string, McpServerSpec>)[name] = { ...spec, headers: { ...headers, [HUB_ORIGIN_HEADER]: threadId } };
    }
  }
}
