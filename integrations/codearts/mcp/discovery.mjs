// Discovery is read-only: packets contain no credentials and never select a Hub.
import { createSocket } from 'node:dgram';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { isIP } from 'node:net';
import { networkInterfaces } from 'node:os';
import { randomBytes } from 'node:crypto';
import { resolve } from 'node:path';
import { defaultClientConfig, loadConnection } from './config.mjs';

const SERVICE = 'agenthub-discovery';
export const DISCOVERY_PORT = 18766;
const MAX_CANDIDATES = 16;

function safeUrl(value) {
  const url = new URL(value);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.hash) throw new Error('Invalid discovery endpoint');
  // Legacy configured query credentials must never accompany a health probe.
  url.search = '';
  if (url.pathname === '/') url.pathname = '/mcp';
  return url;
}

function displayName(value) {
  return typeof value === 'string' ? value.replace(/[^\p{L}\p{N} ._()-]/gu, '').slice(0, 64) : '';
}

export function defaultTargets() {
  const targets = new Set(['127.0.0.1', '255.255.255.255']);
  for (const entries of Object.values(networkInterfaces())) for (const entry of entries || []) {
    if (entry.internal || entry.family !== 'IPv4') continue;
    const ip = entry.address.split('.').map(Number), mask = entry.netmask.split('.').map(Number);
    if (ip.length === 4 && mask.length === 4 && mask.some(n => n !== 255)) {
      targets.add(ip.map((n, i) => (n | (~mask[i] & 255))).join('.'));
    }
  }
  return [...targets].slice(0, 16);
}

// Native http(s) avoids proxy environment, automatic redirects and auth headers.
export function probeHealth(value, timeoutMs = 700) {
  return new Promise(resolve => {
    let url;
    try { url = safeUrl(value); } catch { resolve(null); return; }
    const target = new URL(url);
    target.pathname = '/health';
    let request, done = false;
    const finish = result => {
      if (done) return;
      done = true; clearTimeout(timer); request?.destroy(); resolve(result);
    };
    const timer = setTimeout(() => finish(null), timeoutMs);
    try {
      request = (target.protocol === 'https:' ? httpsRequest : httpRequest)(target, { method: 'GET', agent: false, headers: { Accept: 'application/json' } }, response => {
        if (response.statusCode !== 200) { response.resume(); finish(null); return; }
        const chunks = []; let length = 0;
        response.on('data', chunk => {
          length += chunk.length;
          if (length > 8192) finish(null); else chunks.push(chunk);
        });
        response.on('error', () => finish(null));
        response.on('end', () => {
          if (done) return;
          try {
            const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
            if (body.service !== 'agent-hub' || body.status !== 'ok') { finish(null); return; }
            finish({ url: url.href, auth_required: body.auth_required !== false });
          } catch { finish(null); }
        });
      });
      request.on('error', () => finish(null));
      request.end();
    } catch { finish(null); }
  });
}

export async function discoverHubs({ timeoutMs = 1500, port = DISCOVERY_PORT, targets = defaultTargets(), knownUrls = [] } = {}) {
  if (!Number.isFinite(timeoutMs) || timeoutMs < 50 || timeoutMs > 5000 || !Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid discovery budget or port');
  if (!Array.isArray(targets) || targets.length > 16 || targets.some(t => isIP(t) !== 4)) throw new Error('Discovery targets must be bounded IPv4 addresses');
  const errors = new Set(), candidates = new Map(), jobs = [], nonce = randomBytes(16).toString('hex');
  const queued = new Set();
  const verify = (url, name, source) => {
    if (queued.has(url) || queued.size >= MAX_CANDIDATES) return;
    queued.add(url);
    jobs.push(probeHealth(url, Math.min(700, timeoutMs)).then(verified => {
      if (verified) candidates.set(verified.url, { ...verified, name: displayName(name), source });
    }));
  };
  for (const value of knownUrls.slice(0, MAX_CANDIDATES)) {
    try { verify(safeUrl(value).href, '', 'configured'); } catch { /* no raw input in diagnostics */ }
  }
  // Older local Hub releases still work without the UDP responder.
  if (targets.includes('127.0.0.1')) verify('http://127.0.0.1:8765/mcp', '', 'local');
  await new Promise(resolve => {
    const socket = createSocket('udp4');
    let done = false, packets = 0;
    const finish = () => {
      if (done) return;
      done = true; clearTimeout(timer);
      try { socket.close(); } catch { /* not bound */ }
      resolve();
    };
    const timer = setTimeout(finish, timeoutMs);
    socket.on('error', error => {
      // A refused loopback probe must not discard replies from another host.
      if (['ECONNREFUSED', 'ECONNRESET'].includes(error.code)) return;
      errors.add('udp_unavailable'); finish();
    });
    socket.on('message', (packet, peer) => {
      if (done || ++packets > 128 || packet.length > 2048 || isIP(peer.address) !== 4) return;
      const first = Number(peer.address.split('.')[0]);
      if (!first || first >= 224) return;
      let reply;
      try { reply = JSON.parse(packet.toString('utf8')); } catch { return; }
      if (!reply || reply.service !== SERVICE || reply.version !== 1 || reply.nonce !== nonce || reply.path !== '/mcp' ||
          !Number.isInteger(reply.port) || reply.port < 1 || reply.port > 65535) return;
      verify(`http://${peer.address}:${reply.port}/mcp`, reply.name, 'discovery');
    });
    socket.bind(0, '0.0.0.0', () => {
      if (done) return;
      try {
        socket.setBroadcast(true);
        const packet = Buffer.from(JSON.stringify({ service: SERVICE, version: 1, nonce }));
        for (const target of targets) socket.send(packet, port, target, error => { if (error) errors.add('udp_send_failed'); });
      } catch { errors.add('udp_unavailable'); finish(); }
    });
  });
  await Promise.all(jobs);
  const found = [...candidates.values()].sort((a, b) => a.url.localeCompare(b.url));
  return { candidates: found, errors: [...errors], manual_required: !found.length };
}

export async function hubDiscover(options = {}) {
  let current = null, configurationError = false;
  try { current = await loadConnection(); } catch { configurationError = true; }
  let currentUrl = null;
  try { if (current) currentUrl = safeUrl(current.url).href; } catch { configurationError = true; }
  const result = await discoverHubs({ ...options, knownUrls: currentUrl ? [currentUrl] : [] });
  const configPath = resolve(process.env.AGENTHUB_CONFIG || process.env.AGENTHUB_CONFIG_FILE ||
    (current?.source && current.source !== 'defaults' ? current.source : defaultClientConfig()));
  return { ...result, current_url: currentUrl, configuration_error: configurationError,
    client_config_path: configPath,
    changed_connection: false, credentials_sent: false,
    next_step: result.candidates.length
      ? '发现结果仅供选择。由用户确认目标后运行安装目录 connect.cmd（Linux: ./connect.sh），验证对应 Hub token 后保存连接；不要把 token 发到聊天中。已有任务先按原 ref 查询，切换后重启宿主 MCP。'
      : '未发现可达 Hub。运行安装目录 connect.cmd（Linux: ./connect.sh）手动填写地址并配对。检查服务器已运行、局域网可达；旧 Hub 或隔离网络可能不支持自动发现。不要把 token 发到聊天中。',
    manual_fallback: '如果仅从宿主市场安装了插件、没有 connect 向导，可安装独立 plugins 包使用向导，或在 client_config_path 指向的本机私有 JSON 中填写 url 与对应 token。如宿主另设了连接地址，也需更新或移除旧设置。扫描不写此文件，修改后重启宿主 MCP。' };
}
