import { loadConnection } from '../mcp/config.mjs';

// Codex filters the environment of plugin MCP subprocesses. PLUGIN_DATA is
// host-provided and private to the installed plugin, so settings live there.
export async function pluginEnvironment(env = process.env) {
  const connection = await loadConnection(env);
  if (env.AGENTHUB_CONNECTION_MODE === 'file') {
    delete env.HUB_MCP_URL;
    env.AGENTHUB_URL = connection.url;
    env.HUB_TOKEN = connection.token;
    return env;
  }
  if (!env.AGENTHUB_URL && !env.HUB_MCP_URL) env.AGENTHUB_URL = connection.url;
  if (env.HUB_TOKEN === undefined) env.HUB_TOKEN = connection.token;
  return env;
}
