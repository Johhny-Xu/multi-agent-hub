import { loadConnection } from '../mcp/config.mjs';

// Codex filters the environment of plugin MCP subprocesses. PLUGIN_DATA is
// host-provided and private to the installed plugin, so settings live there.
export async function pluginEnvironment(env = process.env) {
  let connection;
  try { connection = await loadConnection(env); }
  catch {
    // The MCP server keeps discovery available without a valid connection.
    // It independently validates the same source and refuses dispatch; never
    // manufacture a localhost connection or expose invalid private settings.
    if (env.AGENTHUB_CONNECTION_MODE === 'file') {
      delete env.AGENTHUB_URL;
      delete env.HUB_MCP_URL;
      delete env.HUB_TOKEN;
    }
    return env;
  }
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
