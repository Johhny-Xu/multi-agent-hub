// Client connection settings stay outside both the plugin and Hub packages.
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';

export function defaultClientConfig(env = process.env, platform = process.platform, home = homedir()) {
  return platform === 'win32'
    ? join(env.LOCALAPPDATA || join(env.USERPROFILE || home, 'AppData', 'Local'), 'AgentHub', 'client.json')
    : join(env.XDG_CONFIG_HOME || join(env.HOME || home, '.config'), 'agenthub', 'client.json');
}

export function connectionUrl(value, allowQuery = false) {
  if (typeof value !== 'string' || !value.trim()) throw new Error('AgentHub connection URL must be a nonempty string');
  let url;
  try { url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(value.trim()) ? value.trim() : 'http://' + value.trim()); }
  catch { throw new Error('AgentHub connection URL is invalid'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.hash || (!allowQuery && url.search)) {
    throw new Error('AgentHub connection requires HTTP(S) without embedded credentials');
  }
  if (url.pathname === '/') url.pathname = '/mcp';
  return url.href;
}

function endpoint(value) {
  const url = new URL(value);
  url.searchParams.delete('token');
  url.searchParams.sort();
  return url.href;
}

export async function loadConnection(env = process.env, { platform = process.platform, home = homedir() } = {}) {
  const explicitPath = env.AGENTHUB_CONFIG || env.AGENTHUB_CONFIG_FILE;
  if (env.AGENTHUB_CONNECTION_MODE !== undefined && env.AGENTHUB_CONNECTION_MODE !== 'file') throw new Error('Invalid AgentHub connection mode');
  const fileOnly = env.AGENTHUB_CONNECTION_MODE === 'file';
  if (fileOnly && !explicitPath) throw new Error('AgentHub file connection mode requires an explicit configuration path');
  const explicitUrl = fileOnly ? undefined : env.AGENTHUB_URL || env.HUB_MCP_URL;
  const explicitToken = fileOnly ? undefined : env.HUB_TOKEN;
  let settings = {}, source = 'defaults';
  // A complete explicit connection must not depend on another installation.
  if (!(explicitUrl && explicitToken !== undefined)) {
    const candidates = explicitPath ? [resolve(explicitPath)] : [
      ...(env.PLUGIN_DATA ? [join(env.PLUGIN_DATA, 'agenthub.json')] : []),
      defaultClientConfig(env, platform, home),
    ];
    for (const path of candidates) {
      if (!isAbsolute(path)) throw new Error('AgentHub client configuration path must be absolute');
      let raw;
      try { raw = await readFile(path, 'utf8'); }
      catch (error) {
        if (error.code === 'ENOENT' && !explicitPath) continue;
        throw new Error('AgentHub client configuration cannot be read');
      }
      try { settings = JSON.parse(raw.replace(/^\uFEFF/, '')); }
      catch { throw new Error('AgentHub client configuration is not valid JSON'); }
      if (!settings || typeof settings !== 'object' || Array.isArray(settings)) throw new Error('AgentHub client configuration must be an object');
      if (typeof settings.url !== 'string' || !settings.url.trim()) throw new Error('AgentHub client configuration requires an explicit Hub URL');
      source = path;
      break;
    }
  }
  const savedUrl = settings.url === undefined ? null : connectionUrl(settings.url);
  const url = explicitUrl ? connectionUrl(explicitUrl, true) : savedUrl || 'http://127.0.0.1:8765/mcp';
  if (settings.token !== undefined && (typeof settings.token !== 'string' || /[\r\n]/.test(settings.token))) throw new Error('AgentHub client token must be a single-line string');
  const savedTokenApplies = savedUrl ? endpoint(url) === endpoint(savedUrl) : !explicitUrl;
  const token = explicitToken !== undefined ? explicitToken : savedTokenApplies ? settings.token || '' : '';
  if (typeof token !== 'string' || /[\r\n]/.test(token)) throw new Error('AgentHub token must be a single-line string');
  return { url, token, source };
}
