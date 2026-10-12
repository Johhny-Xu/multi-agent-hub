// @ts-check
// Multi-Agent Hub 原生 OAuth 配额跟踪器
// 从 9router usage services 移植（codebuddy-cn / minimax / antigravity），
// 令牌直接读取各官方 CLI 的 OAuth 凭据文件 —— 不再依赖 9router。
// 零第三方依赖（Node 22 全局 fetch）。

import { readFile } from 'node:fs/promises';
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import http from 'node:http';
import tls from 'node:tls';
import { homedir, platform as osPlatform, userInfo as osUserInfo } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HOME = homedir();
const CACHE_TTL_MS = 60_000;
/** @type {Map<string, {ts:number, data:object}>} */
const cache = new Map();
/** Singleflight：全量抓取并发合并锁 —— 同一时刻只允许一次 getAllQuotas 扫描，
 *  后续并发请求复用同一 Promise，杜绝缓存过期/强刷时的 N×9 外部请求雪崩 */
let inFlightAll = null;
/** @type {Map<string, Promise<object>>} 单 worker 维度的在途抓取合并 */
const inFlightWorker = new Map();
/** 自检/压测计数：实际绕过缓存发起上游抓取的次数 */
let fetchAttempts = 0;
/** 仅供测试/自检读取实际抓取次数（不影响运行时行为） */
export function debugFetchAttempts() { return fetchAttempts; }

// 直连不可达的厂商（如 Google）经本地代理 CONNECT 隧道访问；可用环境变量覆盖
const PROXY_URL = process.env.AGENTHUB_QUOTA_PROXY || 'http://127.0.0.1:7890';

/** 支持原生配额读取的 worker 清单（github-copilot 令牌在系统 keyring，暂不直读） */
export const QUOTA_WORKERS = ['codebuddy', 'codebuddy-cn', 'github-copilot', 'minimaxcode', 'mimocode', 'antigravity', 'traecode', 'zcode', 'codearts'];

// ---------------------------------------------------------------- utils
/** @returns {Promise<object|null>} */
async function readJsonSafe(path) {
  try { return JSON.parse((await readFile(path, 'utf-8')).replace(/^\uFEFF/, '')); } catch { return null; }
}

function toFiniteNumber(value, fallback = 0) {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() && Number.isFinite(Number(value))) return Number(value);
  return fallback;
}

/** 解析各厂商返回的重置时间（Unix 秒/毫秒、ISO 字符串）→ ISO 字符串 */
function parseResetTime(resetValue) {
  if (!resetValue) return null;
  try {
    if (typeof resetValue === 'number') {
      return new Date(resetValue < 1e12 ? resetValue * 1000 : resetValue).toISOString();
    }
    if (typeof resetValue === 'string') {
      if (/^\d+$/.test(resetValue)) {
        const ts = Number(resetValue);
        return new Date(ts < 1e12 ? ts * 1000 : ts).toISOString();
      }
      return new Date(resetValue).toISOString();
    }
  } catch { /* ignore */ }
  return null;
}

async function fetchJson(url, options = {}, timeoutMs = 10_000) {
  const res = await fetch(url, { ...options, signal: AbortSignal.timeout(timeoutMs) });
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { json = null; }
  return { status: res.status, ok: res.ok, json, text };
}

/** 经 HTTP 代理 CONNECT 隧道的 HTTPS 请求（零依赖，返回与 fetchJson 同构结果） */
function fetchViaProxy(targetUrl, options = {}, timeoutMs = 20_000) {
  return new Promise((resolve, reject) => {
    const u = new URL(targetUrl);
    const proxy = new URL(PROXY_URL);
    const port = u.port || 443;
    const req = http.request({
      host: proxy.hostname,
      port: Number(proxy.port) || 80,
      method: 'CONNECT',
      path: `${u.hostname}:${port}`,
      headers: { Host: `${u.hostname}:${port}` },
    });
    const timer = setTimeout(() => req.destroy(new Error('proxy connect timeout')), timeoutMs);
    req.on('connect', (pres, socket) => {
      if (pres.statusCode !== 200) {
        clearTimeout(timer); socket.destroy();
        return reject(new Error(`proxy connect failed: ${pres.statusCode}`));
      }
      const tlsSocket = tls.connect({ socket, servername: u.hostname }, () => {
        clearTimeout(timer);
        const body = options.body || '';
        const lines = [`${options.method || 'GET'} ${u.pathname}${u.search} HTTP/1.1`, `Host: ${u.hostname}`];
        for (const [k, v] of Object.entries(options.headers || {})) if (v != null) lines.push(`${k}: ${v}`);
        lines.push('Connection: close', `Content-Length: ${Buffer.byteLength(body)}`);
        tlsSocket.write(lines.join('\r\n') + '\r\n\r\n' + body);
        /** @type {Buffer[]} */
        const chunks = [];
        tlsSocket.on('data', (c) => chunks.push(c));
        tlsSocket.on('end', () => {
          const raw = Buffer.concat(chunks).toString('utf-8');
          const sep = raw.indexOf('\r\n\r\n');
          const head = sep >= 0 ? raw.slice(0, sep) : raw;
          let text = sep >= 0 ? raw.slice(sep + 4) : '';
          if (/transfer-encoding:\s*chunked/i.test(head)) text = decodeChunked(text);
          const status = parseInt(head.split(' ')[1], 10) || 0;
          let json = null;
          try { json = text ? JSON.parse(text) : null; } catch { json = null; }
          resolve({ status, ok: status >= 200 && status < 300, json, text });
        });
        tlsSocket.on('error', reject);
      });
      tlsSocket.on('error', (e) => { clearTimeout(timer); reject(e); });
    });
    req.on('error', (e) => { clearTimeout(timer); reject(e); });
    req.end();
  });
}

function decodeChunked(body) {
  let out = '';
  let i = 0;
  while (i < body.length) {
    const nl = body.indexOf('\r\n', i);
    if (nl < 0) break;
    const size = parseInt(body.slice(i, nl).split(';')[0], 16);
    if (!Number.isFinite(size) || size <= 0) break;
    out += body.substr(nl + 2, size);
    i = nl + 2 + size + 2;
  }
  return out;
}

/** 直连优先，网络级失败（超时/DNS/拒连）自动走代理重试 */
export async function fetchJsonSmart(url, options = {}, timeoutMs = 15_000) {
  try {
    return await fetchJson(url, options, timeoutMs);
  } catch {
    try {
      return await fetchViaProxy(url, options, timeoutMs);
    } catch (pe) {
      throw new Error(`直连与代理(${PROXY_URL})均不可达: ${pe.message}`);
    }
  }
}

// ---------------------------------------------------------------- ZCode enc:v1 凭据加解密（与 ZCode 官方 credentialService 对齐）
function zcodeCipherKey() {
  let username = 'unknown';
  try { username = osUserInfo().username; } catch { /* ignore */ }
  const secret = process.env.ZCODE_CREDENTIAL_SECRET || `zcode-credential-fallback:${osPlatform()}:${HOME}:${username}`;
  return createHash('sha256').update(secret).digest();
}

export function encryptZcodeCred(plain) {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', zcodeCipherKey(), iv);
  const enc = Buffer.concat([cipher.update(String(plain), 'utf-8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `enc:v1:${iv.toString('base64url')}.${tag.toString('base64url')}.${enc.toString('base64url')}`;
}

export function decryptZcodeCred(raw) {
  if (typeof raw !== 'string' || !raw.startsWith('enc:v1:')) return raw;
  const parts = raw.slice(7).split('.');
  if (parts.length !== 3) return raw;
  try {
    const iv = Buffer.from(parts[0], 'base64url');
    const tag = Buffer.from(parts[1], 'base64url');
    const data = Buffer.from(parts[2], 'base64url');
    const decipher = createDecipheriv('aes-256-gcm', zcodeCipherKey(), iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(data), decipher.final()]).toString('utf-8');
  } catch {
    return raw;
  }
}

// ---------------------------------------------------------------- token readers
/** 令牌读取器：CLI OAuth 凭据文件是唯一事实来源 */
const TOKEN_READERS = {
  'codebuddy': async () => {
    const d = await readJsonSafe(join(HOME, '.codebuddy', 'auth.info'));
    return d?.auth?.accessToken || null;
  },
  'codebuddy-cn': async () => {
    const d = await readJsonSafe(join(HOME, '.codebuddy-cn', 'auth.info'));
    return d?.auth?.accessToken || null;
  },
  'minimaxcode': async () => {
    const d = await readJsonSafe(join(HOME, '.mmx', 'config.json'));
    return d?.oauth?.access_token || d?.api_key || d?.apiKey || null;
  },
  'antigravity': async () => {
    const d = await readJsonSafe(join(HOME, '.gemini', 'antigravity-cli', 'antigravity-oauth-token'));
    return d?.token?.access_token || null;
  },
  'github-copilot': async () => {
    // 优先检查本地镜像凭据文件（支持多账号档案切换与 WebUI 登出状态），其次读取 gnome-keyring
    try {
      const mirror = (await readFile(join(HOME, '.config', 'github-copilot', 'copilot-token'), 'utf-8')).trim();
      if (mirror === '__LOGGED_OUT__') return null;
      if (mirror) return mirror;
    } catch { /* fallback to keyring */ }
    const { execFile } = await import('node:child_process');
    const { promisify } = await import('node:util');
    const pExec = promisify(execFile);
    const helper = join(dirname(fileURLToPath(import.meta.url)), 'secret-get.py');
    const { stdout } = await pExec('python3', [helper, 'copilot-cli', 'https://github.com'], { timeout: 8000 });
    const token = String(stdout || '').trim();
    return token || null;
  },
  'traecode': async () => {
    try { return (await readFile(join(HOME, '.trae-cn', 'trae-jwt-token'), 'utf-8')).trim() || null; }
    catch { return null; }
  },
  'zcode': async () => {
    const d = await readJsonSafe(join(HOME, '.zcode', 'v2', 'credentials.json'));
    if (!d || typeof d !== 'object') return null;
    const decMap = {};
    for (const [k, v] of Object.entries(d)) {
      if (typeof v === 'string') decMap[k] = decryptZcodeCred(v);
    }
    const active = String(decMap['oauth:active_provider'] || '').trim();
    const keys = Object.keys(decMap).filter((k) => k.endsWith(':api-key') && decMap[k]);
    const hit = keys.find((k) => active && k.includes(active)) || keys.find((k) => k.includes('bigmodel')) || keys.find((k) => k.includes('zai')) || keys[0];
    const oauthTok = decMap[`oauth:${active || 'bigmodel'}:access_token`] || decMap['oauth:bigmodel:access_token'] || decMap['oauth:zai:access_token'] || decMap['zcodejwttoken'] || null;
    const apiKey = hit ? decMap[hit] : null;
    if (!apiKey && !oauthTok) return null;
    let userInfo = null;
    try {
      const rawUi = decMap[`oauth:${active || 'bigmodel'}:user_info`] || decMap['oauth:bigmodel:user_info'] || decMap['oauth:zai:user_info'];
      if (rawUi) userInfo = JSON.parse(rawUi);
    } catch { /* ignore */ }
    return { token: apiKey || oauthTok, apiKey, oauthTok, activeProvider: active || 'bigmodel', userInfo };
  },
  'mimocode': async () => {
    const d = await readJsonSafe(join(HOME, '.local', 'share', 'mimocode', 'auth.json'));
    if (!d || typeof d !== 'object') return null;
    const keys = Object.keys(d).filter((k) => d[k] && (d[k].key || d[k].access || d[k].token));
    if (keys.length === 0) return null;
    return { providers: keys, raw: d };
  },
  'codearts': async () => {
    try {
      const txt = await readFile(join(HOME, '.config', 'agenthub-codearts', 'codearts-auth.env'), 'utf-8');
      const akMatch = txt.match(/^CODEARTS_CLI_AK=(.+)$/m);
      const skMatch = txt.match(/^CODEARTS_CLI_SK=(.+)$/m);
      const ak = akMatch ? akMatch[1].trim() : '';
      const sk = skMatch ? skMatch[1].trim() : '';
      if (!ak || !sk) return null;
      return { ak, sk };
    } catch {
      return null;
    }
  },
};

async function readToken(worker) {
  const reader = TOKEN_READERS[worker];
  if (!reader) return null;
  try { return await reader(); } catch { return null; }
}

// ---------------------------------------------------------------- codebuddy-cn
// 配额在腾讯计费端点（POST，data.Response.Data 双层包裹）。两类积分不可合并：
//  - 基础体验包（Cycle 字段，周期性刷新，recurring:true）
//  - 活动赠送包（Capacity 字段，一次性，到期作废，recurring:false）
function num(precise, plain) {
  const n = Number(precise ?? plain);
  return Number.isFinite(n) ? n : 0;
}

function refillCadence(acc) {
  const start = parseResetTime(acc.CycleStartTime);
  const end = parseResetTime(acc.CycleEndTime);
  if (start && end) {
    const days = (new Date(end).getTime() - new Date(start).getTime()) / 86400000;
    if (days <= 1.5) return 'Daily';
    if (days <= 10) return 'Weekly';
  }
  return 'Monthly';
}

async function fetchCodeBuddyQuota(token, base, label) {
  if (!token) return { message: `${label} 凭据不可用（未登录或 auth.info 缺失）。` };
  let res;
  try {
    res = await fetchJson(base + '/v2/billing/meter/get-user-resource', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', Accept: 'application/json' },
      body: '{}',
    });
  } catch (e) {
    return { message: `${label} 请求异常: ${e.message}` };
  }
  if (res.status === 401 || res.status === 403) return { message: `${label} 凭据无效或已过期。` };
  if (!res.ok) return { message: `${label} 配额接口错误 (${res.status})。` };
  const json = res.json;
  if (json?.code !== 0) return { message: `${label} 配额错误: ${json?.msg || 'unknown'}` };

  const data = json?.data?.Response?.Data || {};
  const accounts = Array.isArray(data.Accounts) ? data.Accounts : [];
  if (accounts.length === 0) return { message: `${label} 已连接，未发现积分套餐。` };

  const cycleEndMs = (acc) => {
    const r = parseResetTime(acc.CycleEndTime);
    return r ? new Date(r).getTime() : Number.POSITIVE_INFINITY;
  };
  const REFILL_GAP_MS = 2 * 24 * 60 * 60 * 1000;
  const isRefill = (acc) => {
    const ce = cycleEndMs(acc);
    const de = Number(acc.DeductionEndTime);
    return Number.isFinite(ce) && Number.isFinite(de) && de - ce > REFILL_GAP_MS;
  };
  const byExpiry = (a, b) => cycleEndMs(a) - cycleEndMs(b);
  const nowMs = Date.now();
  // 过滤已彻底过期的套餐（DeductionEndTime 早于当前时间），避免历史包刷屏
  const alive = accounts.filter((acc) => {
    const de = Number(acc.DeductionEndTime);
    return !Number.isFinite(de) || !de || de > nowMs;
  });
  const refills = alive.filter(isRefill).sort(byExpiry);
  const bonuses = alive.filter((a) => !isRefill(a)).sort(byExpiry);

  const quotas = {};
  const seenRefill = {};
  refills.forEach((acc) => {
    const base = refillCadence(acc);
    seenRefill[base] = (seenRefill[base] || 0) + 1;
    const name = seenRefill[base] > 1 ? `${base} ${seenRefill[base]}` : base;
    quotas[name] = {
      used: num(acc.CycleCapacityUsedPrecise, acc.CycleCapacityUsed),
      total: num(acc.CycleCapacitySizePrecise, acc.CycleCapacitySize),
      resetAt: parseResetTime(acc.CycleEndTime),
      unlimited: false,
      recurring: true,
    };
  });
  bonuses.forEach((acc, i) => {
    quotas[`Bonus Pack ${i + 1}`] = {
      used: num(acc.CapacityUsedPrecise, acc.CapacityUsed),
      total: num(acc.CapacitySizePrecise, acc.CapacitySize),
      resetAt: parseResetTime(acc.CycleEndTime),
      unlimited: false,
      recurring: false,
    };
  });

  const basePkg = refills[0] || accounts[0] || {};
  return { plan: basePkg.PackageName || basePkg.SubProductName || label, quotas };
}

// ---------------------------------------------------------------- minimax
// 国内 OAuth（region=cn）用 minimaxi.com 域；国际用 minimax.io。
// ~/.mmx/config.json 的 oauth.resource_url 优先。
const MINIMAX_PATHS = ['/v1/api/openplatform/coding_plan/remains', '/v1/token_plan/remains'];
const MINIMAX_REGION_BASES = {
  cn: ['https://www.minimaxi.com', 'https://api.minimaxi.com'],
  intl: ['https://www.minimax.io', 'https://api.minimax.io'],
};

function minimaxUrls() {
  return readJsonSafe(join(HOME, '.mmx', 'config.json')).then((cfg) => {
    const oauth = cfg?.oauth || {};
    const bases = [];
    if (typeof oauth.resource_url === 'string' && oauth.resource_url.startsWith('http')) {
      bases.push(oauth.resource_url.replace(/\/+$/, ''));
    }
    for (const b of MINIMAX_REGION_BASES[oauth.region === 'cn' ? 'cn' : 'intl'] || []) bases.push(b);
    const urls = [];
    for (const base of bases) for (const p of MINIMAX_PATHS) {
      const u = base + p;
      if (!urls.includes(u)) urls.push(u);
    }
    return urls;
  });
}

function getMiniMaxField(model, snakeKey, camelKey) {
  if (!model || typeof model !== 'object') return null;
  return model[snakeKey] ?? model[camelKey] ?? null;
}

function formatMiniMaxQuotaName(model) {
  const rawName = String(getMiniMaxField(model, 'model_name', 'modelName') || '').trim();
  if (!rawName) return 'MiniMax';
  // M3+ 共享池：MiniMax 把 M 系列报成通配桶（"MiniMax-M*"），新返回改叫 "general"
  if (rawName === 'MiniMax-M*' || rawName === 'general') return 'M-series';
  return rawName
    .replace(/[_-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/\b\w/g, (ch) => ch.toUpperCase())
    .replace(/\bTo\b/g, 'to')
    .replace(/\bTts\b/g, 'TTS')
    .replace(/\bHd\b/g, 'HD');
}

function getMiniMaxProvidedPercent(model, snakeKey, camelKey) {
  const raw = getMiniMaxField(model, snakeKey, camelKey);
  if (raw === null || raw === undefined) return null;
  const n = Number(raw);
  return Number.isFinite(n) ? Math.max(0, Math.min(100, n)) : null;
}

function getMiniMaxSessionTotal(model) {
  return Math.max(0, Number(getMiniMaxField(model, 'current_interval_total_count', 'currentIntervalTotalCount')) || 0);
}

function getMiniMaxWeeklyTotal(model) {
  return Math.max(0, Number(getMiniMaxField(model, 'current_weekly_total_count', 'currentWeeklyTotalCount')) || 0);
}

function hasMiniMaxQuota(model) {
  if (getMiniMaxSessionTotal(model) > 0 || getMiniMaxWeeklyTotal(model) > 0) return true;
  if (getMiniMaxProvidedPercent(model, 'current_interval_remaining_percent', 'currentIntervalRemainingPercent') !== null) return true;
  if (getMiniMaxProvidedPercent(model, 'current_weekly_remaining_percent', 'currentWeeklyRemainingPercent') !== null) return true;
  return false;
}

function getMiniMaxResetAt(model, capturedAtMs, remainsSnake, remainsCamel, endSnake, endCamel) {
  const remainsMs = Number(getMiniMaxField(model, remainsSnake, remainsCamel)) || 0;
  if (remainsMs > 0) return new Date(capturedAtMs + remainsMs).toISOString();
  return parseResetTime(getMiniMaxField(model, endSnake, endCamel));
}

function providedPercentage(provided, remaining, total) {
  if (provided !== null && provided !== undefined && Number.isFinite(provided)) return Math.max(0, Math.min(100, provided));
  return total > 0 ? Math.max(0, Math.min(100, (remaining / total) * 100)) : 0;
}

function buildMiniMaxQuota(total, count, resetAt, countMeansRemaining, providedPercent = null) {
  const safeTotal = Math.max(0, total);
  const used = countMeansRemaining ? Math.max(safeTotal - count, 0) : Math.min(Math.max(0, count), safeTotal);
  const remaining = Math.max(safeTotal - used, 0);
  return {
    used,
    total: safeTotal,
    remaining,
    remainingPercentage: providedPercentage(providedPercent, remaining, safeTotal),
    resetAt,
    unlimited: false,
  };
}

function addMiniMaxQuota(quotas, key, model, getTotal, countSnake, countCamel, percentSnake, percentCamel, resetArgs, countMeansRemaining) {
  const total = getTotal(model);
  const providedPercent = getMiniMaxProvidedPercent(model, percentSnake, percentCamel);
  if (total <= 0 && providedPercent === null) return;
  const count = Math.max(0, Number(getMiniMaxField(model, countSnake, countCamel)) || 0);
  let effectiveTotal = total;
  let effectiveCount = count;
  if (total <= 0) {
    // M 系列桶：API 只给 *_remaining_percent（计数为 0），归一化到 total=100
    effectiveTotal = 100;
    effectiveCount = countMeansRemaining
      ? Math.round(effectiveTotal * (providedPercent / 100))
      : Math.round(effectiveTotal * (1 - providedPercent / 100));
  }
  quotas[key] = buildMiniMaxQuota(effectiveTotal, effectiveCount, getMiniMaxResetAt(model, ...resetArgs), countMeansRemaining, providedPercent);
}

async function fetchMiniMaxQuota(token) {
  if (!token) return { message: 'MiniMax 凭据不可用（~/.mmx/config.json 缺失或未登录）。' };
  const usageUrls = await minimaxUrls();
  let lastErrorMessage = '';
  for (let index = 0; index < usageUrls.length; index += 1) {
    const usageUrl = usageUrls[index];
    const canFallback = index < usageUrls.length - 1;
    let res;
    try {
      res = await fetchJson(usageUrl, {
        method: 'GET',
        headers: { Authorization: `Bearer ${token}`, Accept: 'application/json', 'Content-Type': 'application/json' },
      }, 12_000);
    } catch (e) {
      lastErrorMessage = e.message;
      if (!canFallback) break;
      continue;
    }
    {
      const rawText = res.text || '';
      let payload = {};
      try { payload = rawText ? JSON.parse(rawText) : {}; } catch { payload = {}; }
      const baseResp = payload?.base_resp ?? payload?.baseResp ?? {};
      const apiStatusCode = Number(baseResp.status_code ?? baseResp.statusCode) || 0;
      const apiStatusMessage = String(baseResp.status_msg ?? baseResp.statusMsg ?? '').trim();
      const authLike = /invalid api key|invalid key|unauthorized|token expired|inactive/i;
      const combined = `${apiStatusMessage} ${rawText}`.trim();

      if (res.status === 401 || res.status === 403 || apiStatusCode === 1004 || authLike.test(combined)) {
        return { message: 'MiniMax 凭据无效或已失效，请重新登录 mmx。' };
      }
      if (!res.ok) {
        lastErrorMessage = `MiniMax 配额接口错误 (${res.status})`;
        if ((res.status === 404 || res.status === 405 || res.status >= 500) && canFallback) continue;
        return { message: `MiniMax 已连接。${lastErrorMessage}` };
      }
      if (apiStatusCode !== 0) {
        lastErrorMessage = apiStatusMessage || `上游配额接口错误 (${apiStatusCode})`;
        if (canFallback) continue;
        return { message: `MiniMax 已连接。${lastErrorMessage}` };
      }

      const modelRemains = payload?.model_remains ?? payload?.modelRemains;
      const allModels = Array.isArray(modelRemains) ? modelRemains : [];
      const quotaModels = allModels.filter(hasMiniMaxQuota);
      if (quotaModels.length === 0) return { message: 'MiniMax 已连接，未返回配额数据。' };

      const capturedAtMs = Date.now();
      const countMeansRemaining = usageUrl.includes('/coding_plan/remains');
      const quotas = {};
      for (const model of quotaModels) {
        const displayName = formatMiniMaxQuotaName(model);
        addMiniMaxQuota(quotas, `${displayName} (5h)`, model, getMiniMaxSessionTotal,
          'current_interval_usage_count', 'currentIntervalUsageCount',
          'current_interval_remaining_percent', 'currentIntervalRemainingPercent',
          [capturedAtMs, 'remains_time', 'remainsTime', 'end_time', 'endTime'], countMeansRemaining);
        addMiniMaxQuota(quotas, `${displayName} (7d)`, model, getMiniMaxWeeklyTotal,
          'current_weekly_usage_count', 'currentWeeklyUsageCount',
          'current_weekly_remaining_percent', 'currentWeeklyRemainingPercent',
          [capturedAtMs, 'weekly_remains_time', 'weeklyRemainsTime', 'weekly_end_time', 'weeklyEndTime'], countMeansRemaining);
      }
      if (Object.keys(quotas).length === 0) return { message: 'MiniMax 已连接，无法解析配额。' };
      return { quotas };
    }
  }
  return { message: lastErrorMessage ? `MiniMax 已连接，拉取配额失败: ${lastErrorMessage}` : 'MiniMax 已连接，拉取配额失败。' };
}

// ---------------------------------------------------------------- antigravity
const ANTIGRAVITY_QUOTA_URL = 'https://cloudcode-pa.googleapis.com/v1internal:fetchAvailableModels';
const ANTIGRAVITY_LOADCODEASSIST_URL = 'https://cloudcode-pa.googleapis.com/v1internal:loadCodeAssist';
const ANTIGRAVITY_UA = 'antigravity/ide/2.1.1 darwin/arm64';
const ANTIGRAVITY_IDE_VERSION = '2.1.1';
const PLATFORM_ENUM = { linux: 3, darwin: 2, win32: 1 };
const CLIENT_METADATA = { ideType: 9, platform: PLATFORM_ENUM[process.platform] ?? 3, pluginType: 2 };
const ANTIGRAVITY_IMPORTANT_MODELS = [
  'gemini-3-flash-agent', 'gemini-3.5-flash-low', 'gemini-3.5-flash-extra-low',
  'gemini-pro-agent', 'gemini-3.1-pro-low', 'claude-sonnet-4-6', 'claude-opus-4-6-thinking',
  'gpt-oss-120b-medium', 'gemini-3-flash', 'gemini-3.1-flash-image', 'gemini-3-pro-image',
];

async function fetchAntigravityQuota(token) {
  if (!token) return { message: 'Antigravity 凭据不可用（antigravity-oauth-token 缺失或未登录）。' };
  try {
    // 先取订阅信息拿 projectId 与套餐名
    let projectId = null;
    let plan = 'Unknown';
    try {
      const sub = await fetchJsonSmart(ANTIGRAVITY_LOADCODEASSIST_URL, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'User-Agent': ANTIGRAVITY_UA, 'Content-Type': 'application/json' },
        body: JSON.stringify({ metadata: CLIENT_METADATA, mode: 1 }),
      }, 20_000);
      if (sub.ok && sub.json) {
        projectId = sub.json.cloudaicompanionProject || null;
        plan = sub.json.currentTier?.name || plan;
      }
    } catch { /* 订阅信息失败不阻断配额查询 */ }

    const res = await fetchJsonSmart(ANTIGRAVITY_QUOTA_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'User-Agent': ANTIGRAVITY_UA,
        'Content-Type': 'application/json',
        'X-Client-Name': 'antigravity',
        'X-Client-Version': ANTIGRAVITY_IDE_VERSION,
      },
      body: JSON.stringify(projectId ? { project: projectId } : {}),
    }, 20_000);
    if (res.status === 403) return { plan, message: 'Antigravity 配额接口拒绝访问（会话可能仍可用）。', quotas: {} };
    if (res.status === 401) return { plan, message: 'Antigravity 令牌已过期，请在 CLI 重新登录。', quotas: {} };
    if (!res.ok) return { message: `Antigravity 配额接口错误 (${res.status})。` };

    const data = res.json || {};
    const quotas = {};
    if (data.models) {
      for (const [modelKey, info] of Object.entries(data.models)) {
        if (!info?.quotaInfo) continue;
        if (info.isInternal || !ANTIGRAVITY_IMPORTANT_MODELS.includes(modelKey)) continue;
        const remainingFraction = info.quotaInfo.remainingFraction || 0;
        const total = 1000; // 归一化基数
        const remaining = Math.round(total * remainingFraction);
        quotas[modelKey] = {
          used: total - remaining,
          total,
          resetAt: parseResetTime(info.quotaInfo.resetTime),
          remainingPercentage: remainingFraction * 100,
          unlimited: false,
          displayName: info.displayName || modelKey,
        };
      }
    }
    if (Object.keys(quotas).length === 0) {
      return { plan, message: '上游未返回分模型配额（free-tier 账号常见）；订阅与连通性正常。', quotas: {} };
    }
    return { plan, quotas };
  } catch (e) {
    return { message: `Antigravity 错误: ${e.message}` };
  }
}

// ---------------------------------------------------------------- github-copilot
async function fetchCopilotQuota(token) {
  if (!token) return { message: 'Copilot 令牌不可读（keyring 未解锁或未登录 copilot CLI）。' };
  let res;
  try {
    res = await fetchJson('https://api.github.com/copilot_internal/user', {
      headers: {
        'Authorization': `token ${token}`,
        'Accept': 'application/json',
        'X-GitHub-Api-Version': '2025-04-01',
        'User-Agent': 'GitHub Copilot CLI',
        'Editor-Version': 'vscode/1.100.0',
        'Editor-Plugin-Version': 'copilot-chat/0.26.7',
      },
    });
  } catch (e) {
    return { message: `GitHub API 请求异常: ${e.message}` };
  }
  if (!res.ok) return { message: `GitHub API 错误 (${res.status})。` };
  const data = res.json || {};
  const fmtSnap = (q) => q ? { used: (q.entitlement || 0) - (q.remaining || 0), total: q.entitlement || 0, remaining: q.remaining || 0, unlimited: !!q.unlimited } : { used: 0, total: 0, unlimited: true };

  if (data.quota_snapshots) {
    const resetAt = parseResetTime(data.quota_reset_date);
    const s = data.quota_snapshots;
    return {
      plan: data.copilot_plan || data.access_type_sku || 'Copilot',
      quotas: {
        chat: { ...fmtSnap(s.chat), resetAt },
        completions: { ...fmtSnap(s.completions), resetAt },
        premium_interactions: { ...fmtSnap(s.premium_interactions), resetAt },
      },
    };
  }
  if (data.monthly_quotas || data.limited_user_quotas) {
    const monthly = data.monthly_quotas || {};
    const used = data.limited_user_quotas || {};
    const resetAt = parseResetTime(data.limited_user_reset_date);
    return {
      plan: data.copilot_plan || data.access_type_sku || 'Copilot',
      quotas: {
        chat: { used: used.chat || 0, total: monthly.chat || 0, unlimited: false, resetAt },
        completions: { used: used.completions || 0, total: monthly.completions || 0, unlimited: false, resetAt },
      },
    };
  }
  return { plan: data.copilot_plan || data.access_type_sku || null, message: 'Copilot 已连接，未返回配额结构。' };
}

// ---------------------------------------------------------------- traecode
function jwtExp(token) {
  try {
    const payload = JSON.parse(Buffer.from(String(token).split('.')[1], 'base64').toString('utf-8'));
    return payload.exp ? Number(payload.exp) : null;
  } catch { return null; }
}

async function fetchTraeQuota(token) {
  if (!token) return { message: 'Trae 凭据不可用（~/.trae-cn/trae-jwt-token 缺失）。' };
  const exp = jwtExp(token);
  if (!exp) return { plan: 'Trae CN', message: '凭据在线（JWT 无法解析有效期）。' };
  const days = (exp * 1000 - Date.now()) / 86400000;
  if (days <= 0) return { plan: 'Trae CN', message: 'JWT 已过期，请重新登录 TraeCode 桌面端。' };
  return { plan: 'Trae CN', message: `凭据在线，有效期约 ${days < 1 ? Math.max(1, Math.round(days * 24)) + ' 小时' : Math.round(days) + ' 天'}（官方未公开分模型配额端点）。` };
}

// ---------------------------------------------------------------- zcode
async function fetchZcodeQuota(tokenObj) {
  if (!tokenObj) return { message: 'ZCode 凭据不可用（未登录或 ~/.zcode/v2/credentials.json 缺失）。' };
  const key = typeof tokenObj === 'object' ? (tokenObj.apiKey || tokenObj.token) : String(tokenObj);
  const activeProv = typeof tokenObj === 'object' ? (tokenObj.activeProvider || 'bigmodel') : 'bigmodel';
  const username = typeof tokenObj === 'object' ? (tokenObj.userInfo?.username || tokenObj.userInfo?.displayName || null) : null;
  const planName = username ? `GLM Coding Plan (${username})` : 'GLM Coding Plan';
  const attempts = [
    ['https://open.bigmodel.cn/api/monitor/usage/quota/limit', key],
    ['https://api.z.ai/api/monitor/usage/quota/limit', key],
  ];
  for (const [url, k] of attempts) {
    if (!k) continue;
    try {
      const res = await fetchJson(url, { headers: { Authorization: k } }, 8000);
      if (res.ok && (res.json?.success === true || res.json?.code === 0 || res.json?.code === 200) && res.json?.data) {
        const d = res.json.data;
        if (d.total_usage || d.limits || d.total !== undefined) {
          const used = toFiniteNumber(d?.total_usage?.used ?? d?.used, 0);
          const total = toFiniteNumber(d?.total_usage?.limit ?? d?.total, 100);
          return {
            plan: d.level ? `${planName} · ${d.level}` : planName,
            quotas: {
              usage: {
                used,
                total,
                unlimited: false,
                resetAt: parseResetTime(d?.next_refresh_at || d?.reset_time || d?.resetTime),
              },
            },
          };
        }
      }
    } catch { /* 下一个 */ }
  }
  const acctLabel = username ? `账号 ${username} (${activeProv})` : `通道 ${activeProv}`;
  return { plan: planName, message: `凭据在线（${acctLabel}）；当前账号未返回公开 Coding Plan 配额，以客户端显示为准。` };
}

// ---------------------------------------------------------------- mimocode
async function fetchMimoQuota(tokenObj) {
  if (!tokenObj) return { message: 'MiMo 凭据不可用（未登录或 ~/.local/share/mimocode/auth.json 缺失）。' };
  const provs = Array.isArray(tokenObj.providers) ? tokenObj.providers : ['xiaomi'];
  const xm = tokenObj.raw?.xiaomi;
  const uid = xm?.metadata?.uid ? ` · UID:${xm.metadata.uid}` : '';
  return {
    plan: `Xiaomi MiMo${uid}`,
    message: `凭据在线（已配置通道: ${provs.join(', ')}）；官方暂无公开分模型配额端点。`,
  };
}

// ---------------------------------------------------------------- codearts
async function fetchCodeArtsQuota(tokenObj) {
  if (!tokenObj || !tokenObj.ak) return { message: 'CodeArts 凭据不可用（未登录或 ~/.config/agenthub-codearts/codearts-auth.env 缺失）。' };
  const akMask = tokenObj.ak.length > 8
    ? `${tokenObj.ak.slice(0, 4)}…${tokenObj.ak.slice(-4)}`
    : `${tokenObj.ak.slice(0, 3)}…`;
  return {
    plan: `CodeArts Doer (${akMask})`,
    message: `AK/SK 凭据已就绪（${akMask}）；计费倍率见模型目录。`,
  };
}

// ---------------------------------------------------------------- public API
const FETCHERS = {
  'codebuddy': (t) => fetchCodeBuddyQuota(t, 'https://www.codebuddy.ai', 'CodeBuddy 国际版'),
  'codebuddy-cn': (t) => fetchCodeBuddyQuota(t, 'https://copilot.tencent.com', 'CodeBuddy CN'),
  'github-copilot': fetchCopilotQuota,
  'minimaxcode': fetchMiniMaxQuota,
  'mimocode': fetchMimoQuota,
  'antigravity': fetchAntigravityQuota,
  'traecode': fetchTraeQuota,
  'zcode': fetchZcodeQuota,
  'codearts': fetchCodeArtsQuota,
};

export function clearQuotaCache(worker) {
  if (worker) cache.delete(worker); else cache.clear();
}

export async function getQuota(worker, { force = false } = {}) {
  const hit = cache.get(worker);
  if (!force && hit && Date.now() - hit.ts < CACHE_TTL_MS) return hit.data;
  const inFlight = inFlightWorker.get(worker);
  if (inFlight) return inFlight;
  const p = (async () => {
    fetchAttempts++;
    const token = await readToken(worker);
    const fetcher = FETCHERS[worker];
    let data;
    if (!fetcher) data = { message: `未知的配额 worker: ${worker}` };
    else if (worker !== 'github-copilot' && !token) data = await fetcher(null);
    else {
      try { data = await fetcher(token); }
      catch (e) { data = { message: `配额查询异常: ${e.message}` }; }
    }
    const payload = { worker, fetchedAt: new Date().toISOString(), ...data };
    cache.set(worker, { ts: Date.now(), data: payload });
    return payload;
  })();
  inFlightWorker.set(worker, p);
  try { return await p; } finally { inFlightWorker.delete(worker); }
}

export async function getAllQuotas({ force = false } = {}) {
  if (inFlightAll) return inFlightAll;
  inFlightAll = (async () => {
    const workers = {};
    await Promise.all(QUOTA_WORKERS.map(async (w) => { workers[w] = await getQuota(w, { force }); }));
    return { updatedAt: new Date().toISOString(), workers };
  })();
  try {
    return await inFlightAll;
  } finally {
    inFlightAll = null;
  }
}
