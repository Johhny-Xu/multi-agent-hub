import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

// Codex filters the environment of plugin MCP subprocesses. PLUGIN_DATA is
// host-provided and private to the installed plugin, so settings live there.
export async function pluginEnvironment(env = process.env) {
  if (!env.PLUGIN_DATA) return env;
  let settings;
  try { settings = JSON.parse(await readFile(join(env.PLUGIN_DATA, 'agenthub.json'), 'utf8')); }
  catch (error) {
    if (error.code === 'ENOENT') return env;
    throw new Error('AgentHub plugin settings are not valid JSON');
  }
  if (!settings || typeof settings !== 'object' || Array.isArray(settings)) throw new Error('AgentHub plugin settings must be an object');
  if (settings.url !== undefined) {
    let url;
    try { url = new URL(settings.url); } catch { throw new Error('AgentHub plugin URL is invalid'); }
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.hash || url.search) throw new Error('AgentHub plugin URL must be HTTP(S) without embedded credentials');
    if (!env.AGENTHUB_URL && !env.HUB_MCP_URL) env.AGENTHUB_URL = url.href;
  }
  if (settings.token !== undefined) {
    if (typeof settings.token !== 'string') throw new Error('AgentHub plugin token must be a string');
    if (env.HUB_TOKEN === undefined) env.HUB_TOKEN = settings.token;
  }
  return env;
}
