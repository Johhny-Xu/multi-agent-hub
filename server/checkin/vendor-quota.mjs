// @ts-check
// Multi-Agent Hub 原生 OAuth 配额跟踪器（E66：完整版随工作台放在 server/checkin/，
// /hub/quota 在没有外部控制台时兜底用它；签到模块也从这里取 fetchJsonSmart / hwsSdkSignedHeaders）
// 直读各官方 CLI 已落盘的 OAuth 凭据，向各厂商官方接口查询剩余配额；
// 令牌与账号不落本模块，只做即时解密与转发。
// 零第三方依赖（Node 22 全局 fetch）。

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes } from 'node:crypto';
import http from 'node:http';
import https from 'node:https';
import tls from 'node:tls';
import { homedir, platform as osPlatform, userInfo as osUserInfo } from 'node:os';
import { join, dirname } from 'node:path';
import { fetchMiniMaxSignin } from './minimax-checkin.mjs';
import { fetchDumateQuota } from './dumate.mjs';
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
export const QUOTA_WORKERS = ['codebuddy', 'codebuddy-cn', 'github-copilot', 'minimaxcode', 'mimocode', 'antigravity', 'traecode', 'zcode', 'codearts', 'qoder', 'qoder-cn', 'cline', 'perch', '9router', 'dumate'];

/**
 * 需要跨模块协作的 worker（凭据解密与设备指纹在 qoder.mjs / qoder-device.mjs
 * / trae-checkin.mjs 里，而这些模块反过来 import 本模块取 fetchJsonSmart）。
 * 静态 import 会形成 ESM 初始化期循环依赖，此处一律在**调用期**动态装载。
 */
const DEEP_QUOTA_WORKERS = new Set(['qoder', 'qoder-cn', 'traecode']);
let deepQuotaModule = null;
async function loadDeepQuota() {
  if (!deepQuotaModule) deepQuotaModule = import('./quota-deep.mjs');
  return deepQuotaModule;
}

/**
 * quotas 统一归一化为**数组**：前端（popup 与侧栏胶囊）只认
 * `[{name, displayName, used, total, remaining, remainingPercentage, resetAt, unlimited}]`。
 * 历史 fetcher 里有对象 map 形态，这里做一次兼容转换，避免各家各写一套渲染。
 */
export function normalizeQuotas(quotas) {
  if (!quotas) return quotas;
  if (Array.isArray(quotas)) {
    return quotas.map((q, i) => {
      if (!q || typeof q !== 'object') return q;
      const name = q.name || q.displayName || `q${i + 1}`;
      return { ...q, name, displayName: q.displayName || name };
    });
  }
  if (typeof quotas !== 'object') return quotas;
  return Object.entries(quotas).map(([name, q]) => {
    const item = q && typeof q === 'object' ? q : {};
    return { ...item, name: item.name || name, displayName: item.displayName || name };
  });
}

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

/** 经 HTTP 代理 CONNECT 隧道的 HTTPS 请求（使用 Node 原生 https.request 解析 chunked 响应） */
function fetchViaProxy(targetUrl, options = {}, timeoutMs = 20_000) {
  return new Promise((resolve, reject) => {
    const u = new URL(targetUrl);
    const proxy = new URL(PROXY_URL);
    const port = Number(u.port) || 443;
    const req = http.request({
      host: proxy.hostname,
      port: Number(proxy.port) || 80,
      method: 'CONNECT',
      path: `${u.hostname}:${port}`,
      headers: { Host: `${u.hostname}:${port}` },
    });
    const timer = setTimeout(() => {
      req.destroy(new Error('proxy connect timeout'));
      reject(new Error('proxy connect timeout'));
    }, timeoutMs);
    req.on('connect', (pres, socket) => {
      if (pres.statusCode !== 200) {
        clearTimeout(timer); socket.destroy();
        return reject(new Error(`proxy connect failed: ${pres.statusCode}`));
      }
      const tlsSocket = tls.connect({ socket, servername: u.hostname });
      tlsSocket.on('error', (e) => { clearTimeout(timer); reject(e); });
      const bodyStr = options.body ? String(options.body) : '';
      const reqHeaders = { ...(options.headers || {}) };
      if (bodyStr && !reqHeaders['Content-Length'] && !reqHeaders['content-length']) {
        reqHeaders['Content-Length'] = Buffer.byteLength(bodyStr);
      }
      const hreq = https.request({
        hostname: u.hostname,
        port,
        path: `${u.pathname}${u.search}`,
        method: options.method || 'GET',
        headers: reqHeaders,
        createConnection: () => tlsSocket,
      }, (hres) => {
        /** @type {Buffer[]} */
        const chunks = [];
        hres.on('data', (c) => chunks.push(c));
        hres.on('end', () => {
          clearTimeout(timer);
          const text = Buffer.concat(chunks).toString('utf-8');
          const status = hres.statusCode || 0;
          let json = null;
          try { json = text ? JSON.parse(text) : null; } catch { json = null; }
          resolve({ status, ok: status >= 200 && status < 300, json, text });
        });
        hres.on('error', (e) => { clearTimeout(timer); reject(e); });
      });
      hreq.on('error', (e) => { clearTimeout(timer); reject(e); });
      if (bodyStr) hreq.write(bodyStr);
      hreq.end();
    });
    req.on('error', (e) => { clearTimeout(timer); reject(e); });
    req.end();
  });
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

// ---------------------------------------------------------------- 华为云 SDK-HMAC-SHA256 签名
// 与 huaweicloud-sdk / 开放网关一致。两个必须复刻的坑：
//   1) CanonicalURI 必须以 / 结尾（path 已带尾斜杠时不能补第二个）
//   2) CanonicalHeaders 每行自带 \n 后，整体再与 CanonicalRequest 用 \n 连接（即尾部已有一个 \n，不再额外补）
const _hwsSha256hex = (buf) => createHash('sha256').update(buf).digest('hex');
const _hwsRfc3986 = (s) => encodeURIComponent(s).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);

export function hwsSdkSignedHeaders(ak, sk, method, rawUrl, body, extra = {}) {
  const u = new URL(rawUrl);
  const headers = {};
  for (const [k, v] of Object.entries(extra)) headers[k.toLowerCase()] = v;
  headers.host = u.host;
  const d = new Date();
  const p = (n, w = 2) => String(n).padStart(w, '0');
  headers['x-sdk-date'] = `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}T${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}Z`;

  const payload = ['PUT', 'PATCH', 'POST', 'DELETE'].includes(method) ? body : null;
  const names = Object.keys(headers).sort();
  let canonicalHeaders = '';
  for (const k of names) canonicalHeaders += `${k}:${String(headers[k]).trim()}\n`;
  const signedHeaders = names.join(';');
  const segs = (u.pathname || '/').split('/').map((s) => _hwsRfc3986(decodeURIComponent(s)));
  let canonicalUri = segs.join('/');
  if (!canonicalUri.endsWith('/')) canonicalUri += '/';
  const canonicalQuery = [...u.searchParams.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${_hwsRfc3986(k)}=${_hwsRfc3986(v)}`)
    .join('&');
  const canonicalRequest = [
    method,
    canonicalUri,
    canonicalQuery,
    canonicalHeaders,
    signedHeaders,
    _hwsSha256hex(payload || Buffer.alloc(0)),
  ].join('\n');
  const stringToSign = ['SDK-HMAC-SHA256', headers['x-sdk-date'], _hwsSha256hex(Buffer.from(canonicalRequest, 'utf-8'))].join('\n');
  const signature = createHmac('sha256', sk).update(stringToSign).digest('hex');
  headers.authorization = `SDK-HMAC-SHA256 Access=${ak}, SignedHeaders=${signedHeaders}, Signature=${signature}`;
  return headers;
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

function parseJwtPayloadSafe(tok) {
  if (!tok || typeof tok !== 'string' || !tok.includes('.')) return null;
  try {
    return JSON.parse(Buffer.from(tok.split('.')[1], 'base64').toString('utf-8'));
  } catch {
    return null;
  }
}

const ANTIGRAVITY_REFRESH = {
  tokenUrl: 'https://oauth2.googleapis.com/token',
  clientId: '1071006060591-tmhssin2h21lcre235vtolojh4g403ep.apps.googleusercontent.com',
  installedVerifierB64: 'R09DU1BYLUs1OEZXUjQ4NkxkTEoxbUxCOHNYQzR6NnFEQWY=',
};

// 令牌续期只换内存里的 access_token，**不写回凭据文件**：9R 的刷新实现
// （open-sse/services/tokenRefresh/providers.js refreshGoogleToken）同样只把
// 新令牌返回给调用方、不落盘，官方 antigravity-cli 与 8890 console 才是这个
// 文件的写方，配额查询不与它们竞争写权。
async function refreshAntigravityTokenIfNeeded(d) {
  const tokObj = d?.token;
  if (!tokObj?.access_token) return null;
  const expMs = tokObj.expiry ? new Date(tokObj.expiry).getTime() : 0;
  if ((!expMs || expMs - Date.now() > 120_000) && tokObj.access_token) {
    return tokObj.access_token;
  }
  if (!tokObj.refresh_token) return tokObj.access_token;
  try {
    const body = new URLSearchParams({
      grant_type: 'refresh_token',
      client_id: ANTIGRAVITY_REFRESH.clientId,
      client_secret: process.env.ANTIGRAVITY_OAUTH_CLIENT_SECRET || Buffer.from(ANTIGRAVITY_REFRESH.installedVerifierB64, 'base64').toString('utf8'),
      refresh_token: tokObj.refresh_token,
    }).toString();
    const res = await fetchJsonSmart(ANTIGRAVITY_REFRESH.tokenUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
      body,
    }, 15_000);
    if (res.ok && res.json?.access_token) {
      tokObj.access_token = res.json.access_token;
      tokObj.expiry = new Date(Date.now() + (Number(res.json.expires_in) || 3600) * 1000).toISOString();
      if (res.json.id_token) d.id_token = res.json.id_token;
      return tokObj.access_token;
    }
  } catch { /* fallback to current access_token */ }
  return tokObj.access_token;
}

// ---------------------------------------------------------------- token readers
/** 令牌读取器：CLI OAuth 凭据文件是唯一事实来源 */
const TOKEN_READERS = {
  'codebuddy': async () => {
    const d = await readJsonSafe(join(HOME, '.codebuddy', 'auth.info'));
    const tok = String(d?.auth?.accessToken || '').trim();
    // 未完成授权的半成品：accessToken 是 started?state=... 跳转 URL
    if (!tok || tok.startsWith('http')) return null;
    const pl = parseJwtPayloadSafe(tok);
    const acct = d.account || d.accounts?.[0] || d.allAccounts?.[0] || {};
    const account = acct.nickname || acct.email || pl?.email || pl?.preferred_username || pl?.name || (acct.uid ? `UID:${String(acct.uid).slice(0, 8)}…` : null);
    return { token: tok, account };
  },
  'codebuddy-cn': async () => {
    const d = await readJsonSafe(join(HOME, '.codebuddy-cn', 'auth.info'));
    const tok = String(d?.auth?.accessToken || '').trim();
    if (!tok || tok.startsWith('http')) return null;
    const pl = parseJwtPayloadSafe(tok);
    const acct = d.account || d.accounts?.[0] || d.allAccounts?.[0] || {};
    const nick = String(acct.nickname || pl?.nickname || '').trim();
    const email = String(acct.email || pl?.email || '').trim();
    const uid = String(acct.uid || acct.uin || pl?.sub || '').trim();
    // 显示层不暴露手机号：只显示账户名称/邮箱
    const account = (/^1\d{10}$/.test(nick) ? '' : nick) || email || (uid ? `UID:${uid.slice(0, 8)}…` : null);
    return { token: tok, account };
  },
  'minimaxcode': async () => {
    const auth = await readMinimaxAuth();
    return auth ? findMinimaxToken(auth.raw) : null;
  },
  'antigravity': async () => {
    const credPath = join(HOME, '.gemini', 'antigravity-cli', 'antigravity-oauth-token');
    const d = await readJsonSafe(credPath);
    if (!d?.token?.access_token) return null;
    const accessToken = await refreshAntigravityTokenIfNeeded(d);
    const pl = parseJwtPayloadSafe(d.id_token);
    const email = pl?.email || d.email || d.user?.email || null;
    return { token: accessToken, email };
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
    const zcodeJwt = decMap['zcodejwttoken'] || null;
    if (!apiKey && !oauthTok && !zcodeJwt) return null;
    let userInfo = null;
    try {
      const rawUi = decMap[`oauth:${active || 'bigmodel'}:user_info`] || decMap['oauth:bigmodel:user_info'] || decMap['oauth:zai:user_info'];
      if (rawUi) userInfo = JSON.parse(rawUi);
    } catch { /* ignore */ }
    return { token: apiKey || oauthTok || zcodeJwt, apiKey, oauthTok, zcodeJwt, activeProvider: active || 'bigmodel', userInfo };
  },
  'mimocode': async () => {
    const d = await readJsonSafe(join(HOME, '.local', 'share', 'mimocode', 'auth.json'));
    if (!d || typeof d !== 'object') return null;
    const keys = Object.keys(d).filter((k) => d[k] && (d[k].key || d[k].access || d[k].token));
    if (keys.length === 0) return null;
    return { providers: keys, raw: d };
  },
  'cline': async () => {
    const d = await readJsonSafe(join(HOME, '.cline', 'data', 'settings', 'providers.json'));
    const auth = d?.providers?.cline?.settings?.auth;
    const tok = String(auth?.accessToken || '').trim();
    if (!tok) return null;
    const accountId = String(auth?.accountId || '').trim() || null;
    return { token: tok, accountId };
  },
  'perch': async () => {
    const d = await readJsonSafe(join(HOME, '.perch', 'cli-auth-session.json'));
    const tok = String(d?.accessToken || '').trim();
    if (!tok) return null;
    return {
      token: tok,
      appUrl: typeof d.appUrl === 'string' ? d.appUrl.replace(/\/+$/, '') : null,
      email: typeof d.email === 'string' ? d.email : null,
    };
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

async function fetchCodeBuddyQuota(tokenObj, base, label) {
  const token = typeof tokenObj === 'object' && tokenObj ? tokenObj.token : tokenObj;
  const account = typeof tokenObj === 'object' && tokenObj ? tokenObj.account : null;
  if (!token) return { message: `${label} 凭据不可用（未登录或 auth.info 缺失）。` };
  let res;
  try {
    res = await fetchJson(base + '/v2/billing/meter/get-user-resource', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', Accept: 'application/json' },
      body: '{}',
    });
  } catch (e) {
    return { account, message: `${label} 请求异常: ${e.message}` };
  }
  if (res.status === 401 || res.status === 403) return { account, message: `${label} 凭据无效或已过期。` };
  if (!res.ok) return { account, message: `${label} 配额接口错误 (${res.status})。` };
  const json = res.json;
  if (json?.code !== 0) return { account, message: `${label} 配额错误: ${json?.msg || 'unknown'}` };

  const data = json?.data?.Response?.Data || {};
  const accounts = Array.isArray(data.Accounts) ? data.Accounts : [];
  if (accounts.length === 0) return { account, message: `${label} 已连接，未发现积分套餐。` };

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
  return { account, plan: basePkg.PackageName || basePkg.SubProductName || label, quotas };
}

// ---------------------------------------------------------------- minimax
// 国内 OAuth（region=cn）用 minimaxi.com 域；国际用 minimax.io。
// mcode（MiniMax Code 官方 CLI）的 OAuth 凭据在 ~/.minimax/auth/<env>/<region>/mcode-public/：
//   auth.json       { records: { "com.minimax.mcode.oauth.prod.cn <hash>": { accessToken, expiresAtMs } } }
//   auth-state.json { status: "authenticated", region: "cn" }
// 老的 mmx CLI 是 ~/.mmx/config.json —— 放最后兜底。
//
// 真实余额照 iJetLi/dsh-providers-hub src/minimax-credits.ts（端点 7-9 行、
// 解析 600-670 行）：GET {agent.minimax.cn|io}/minimax-cloud/api/v1/credit/details，
// 响应平铺（details/total_count 与 base_resp 同级，无 data 包裹）；
// 余额 = Σ details[].remaining_amount（**字符串**），每包 expire_at_ms 毫秒；
// total_count 是**记录条数**不是余额；业务码在 base_resp.status_code
//（HTTP 200 也可能带错）。

/** mcode 凭据候选路径；MCODE_AUTH_DIR 可整体覆盖 ~/.minimax/auth */
function minimaxAuthCandidates() {
  const out = [];
  const envDir = String(process.env.MCODE_AUTH_DIR || '').trim();
  if (envDir) {
    for (const rel of ['auth.json', 'auth-state.json']) {
      out.push({ label: join(envDir, rel), path: join(envDir, rel) });
    }
  }
  for (const region of ['cn', 'global', 'intl']) {
    for (const rel of ['auth.json', 'auth-state.json']) {
      const p = join(HOME, '.minimax', 'auth', 'prod', region, 'mcode-public', rel);
      out.push({ label: join('.minimax/auth/prod', region, 'mcode-public', rel), path: p });
    }
  }
  out.push({ label: join('.mmx', 'config.json'), path: join(HOME, '.mmx', 'config.json') });
  return out;
}

async function readMinimaxAuth() {
  for (const item of minimaxAuthCandidates()) {
    const raw = await readJsonSafe(item.path);
    if (raw) return { raw, source: item.label, legacy: item.label.startsWith('.mmx'), dir: dirname(item.path) };
  }
  return null;
}

/** 在 auth.json 的 records 里挑一份 token（记录键形如 "com.minimax.mcode.oauth.prod.cn <hash>"） */
function pickMinimaxRecordToken(raw) {
  const records = raw?.records;
  if (!records || typeof records !== 'object') return null;
  let best = null;
  for (const value of Object.values(records)) {
    if (!value || typeof value !== 'object') continue;
    const tok = typeof value.accessToken === 'string' ? value.accessToken.trim() : '';
    if (!tok) continue;
    const exp = Number(value.expiresAtMs) || 0;
    if (!best || exp > best.exp) best = { tok, exp };
  }
  return best ? best.tok : null;
}

/**
 * 兼容两种形态：mcode 的 auth.json（records[].accessToken）与老 mmx 的 config.json（oauth.access_token）。
 * 兜底再按「已知 token 字段名」限深递归，覆盖字段名跨版本变化的情况。
 */
function findMinimaxToken(node, depth = 0) {
  const fromRecords = pickMinimaxRecordToken(node);
  if (fromRecords) return fromRecords;
  if (!node || typeof node !== 'object' || depth > 4) return null;
  const keys = ['access_token', 'accessToken', 'access', 'token', 'api_key', 'apiKey', 'apiKeyValue'];
  for (const key of keys) {
    const value = node[key];
    if (typeof value === 'string') {
      const tok = value.trim();
      if (tok.length > 8 && !/^https?:/i.test(tok)) return tok;
    }
  }
  for (const value of Object.values(node)) {
    const hit = findMinimaxToken(value, depth + 1);
    if (hit) return hit;
  }
  return null;
}

function minimaxRegionOf(raw) {
  const region = String(raw?.region || raw?.oauth?.region || '').trim().toLowerCase();
  return region === 'global' || region === 'intl' ? 'intl' : 'cn';
}

/** credit/details 的主机只按 region 取（HUB minimax-product.ts：中国版 agent.minimax.cn / 国际版 agent.minimax.io） */
async function minimaxCreditHosts() {
  const auth = await readMinimaxAuth();
  const state = auth?.dir ? await readJsonSafe(join(auth.dir, 'auth-state.json')) : null;
  const raw = { ...(auth?.raw || {}), ...(state || {}) };
  const host = MINIMAX_CREDIT_HOSTS[minimaxRegionOf(raw)];
  return host ? [host] : Object.values(MINIMAX_CREDIT_HOSTS);
}

const MINIMAX_CREDIT_HOSTS = { cn: 'https://agent.minimax.cn', intl: 'https://agent.minimax.io' };
const MINIMAX_CREDIT_DETAILS_PATH = '/minimax-cloud/api/v1/credit/details';

/**
 * HUB fetchMinimaxCreditBalanceDetailed 的解析（minimax-credits.ts:600-670）。
 * `details` 缺失/非数组 ⇒ 余额 0（「真的为 0」），不是查询失败；形状完全不对
 * （连 details 与 total_count 都没有）才返回 null。
 */
export function parseMinimaxCreditDetails(json) {
  if (!json || typeof json !== 'object') return null;
  const baseResp = json.base_resp ?? json.baseResp ?? {};
  const statusCode = Number(baseResp.status_code ?? baseResp.statusCode);
  if (Number.isFinite(statusCode) && statusCode !== 0) {
    return { error: String(baseResp.status_msg ?? baseResp.statusMsg ?? `上游错误 ${statusCode}`) };
  }
  const details = Array.isArray(json.details) ? json.details : undefined;
  if (details === undefined && json.total_count === undefined && json.totalCount === undefined) return null;
  let balance = 0;
  const packages = [];
  for (const entry of details ?? []) {
    if (!entry || typeof entry !== 'object') continue;
    const remaining = toFiniteNumber(entry.remaining_amount ?? entry.remainingAmount, NaN);
    if (!Number.isFinite(remaining)) continue;
    balance += remaining;
    const grantedMs = Number(entry.granted_at_ms ?? entry.grantedAtMs) || 0;
    const expireMs = Number(entry.expire_at_ms ?? entry.expireAtMs) || 0;
    packages.push({
      name: grantedMs > 0 ? `积分包 ${new Date(grantedMs).toLocaleDateString('zh-CN')}` : '积分包',
      remaining,
      expireAt: expireMs > 0 ? new Date(expireMs).toISOString() : null,
    });
  }
  return { balance, packages };
}

/** 查询 mcode 账号的真实积分余额与每包到期（HUB minimax-cloud credit/details） */
export async function fetchMinimaxCreditDetails(token) {
  const hosts = await minimaxCreditHosts();
  let lastError = '';
  for (const host of hosts) {
    let res;
    try {
      res = await fetchJson(host + MINIMAX_CREDIT_DETAILS_PATH, {
        headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
      }, 12_000);
    } catch (e) {
      lastError = e.message;
      continue;
    }
    if (res.status === 401 || res.status === 403) return { error: 'auth' };
    if (!res.ok) { lastError = `HTTP ${res.status}`; continue; }
    const parsed = parseMinimaxCreditDetails(res.json);
    if (parsed) return parsed;
    lastError = '响应形状不符合预期';
  }
  return { error: lastError || '不可达' };
}

async function fetchMiniMaxSigninQuota() {
  try {
    const info = await fetchMiniMaxSignin('cn');
    if (!info) return null;
    if (info.status === 401) return { expired: true };
    if (info.status !== 200 || !info.today) return null;
    const { dayNo, dayText, points, bonusPoints } = info.today;
    const total = (Number(points) || 0) + (Number(bonusPoints) || 0);
    if (total <= 0) return { plan: dayNo ? `连续签到第 ${dayNo} 天` : null, detail: `今日${dayText}` };
    const now = new Date();
    const nextMidnight = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1, 0, 0, 0, 0);
    return {
      plan: dayNo ? `连续签到第 ${dayNo} 天` : null,
      detail: `今日${dayText} · ${points} 基础 + ${bonusPoints} 奖励 = ${total} 积分`,
      quota: {
        name: '签到积分',
        displayName: '今日签到积分',
        used: 0,
        total: Number(total),
        remaining: Number(total),
        remainingPercentage: 100,
        resetAt: nextMidnight.toISOString(),
        unlimited: false,
        isCreditBalance: true,
        unit: 'points',
      },
    };
  } catch {
    return null;
  }
}

export async function fetchMiniMaxQuota(token) {
  if (!token) return { message: 'MiniMax 凭据不可用（~/.minimax/auth/prod/cn/mcode-public/auth.json 缺失或未登录，请点「登录」走 mcode 设备码授权）。' };
  // 真实余额：minimax-cloud credit/details（HUB 方案）；签到积分降为附加一行
  const credit = await fetchMinimaxCreditDetails(token);
  if (credit.error === 'auth') {
    return { message: 'MiniMax 凭据无效或已失效，请重新登录（控制台「登录」走 mcode 设备码授权）。' };
  }
  const signin = await fetchMiniMaxSigninQuota();
  const account = 'MiniMax Code · 国内版';
  if (credit.error) {
    const signinLine = signin?.detail ? `；${signin.detail}` : '';
    return { account, message: `MiniMax 余额接口暂不可用（${credit.error}）${signinLine}。`, ...(signin?.quota ? { quotas: [signin.quota] } : {}) };
  }

  const quotas = [];
  if (credit.balance > 0 || credit.packages.length > 0) {
    // HUB 口径：consumed/granted 的总量语义未实测，只填有把握的 total=remaining
    quotas.push({
      name: '积分余额',
      displayName: '积分余额',
      used: 0,
      total: Math.round(credit.balance * 100) / 100,
      remaining: Math.round(credit.balance * 100) / 100,
      remainingPercentage: 100,
      resetAt: null,
      unlimited: false,
      isCreditBalance: true,
      unit: 'credit',
    });
    for (const pkg of credit.packages) {
      if (credit.packages.length < 2) break;
      quotas.push({
        name: pkg.name,
        displayName: pkg.name,
        used: 0,
        total: Math.round(pkg.remaining * 100) / 100,
        remaining: Math.round(pkg.remaining * 100) / 100,
        remainingPercentage: 100,
        resetAt: pkg.expireAt,
        unlimited: false,
        isCreditBalance: true,
        unit: 'credit',
      });
    }
  }
  if (signin?.quota) quotas.push(signin.quota);

  if (!quotas.length) {
    return { account, plan: signin?.plan || 'MiniMax Code', message: `MiniMax 已连接${signin?.detail ? `（${signin.detail}）` : ''}；当前积分为 0。` };
  }
  return {
    account,
    plan: signin?.plan || 'MiniMax Code',
    quotas,
    message: signin?.detail ? `${signin.detail}（签到积分 30 天内有效）` : undefined,
  };
}

// ---------------------------------------------------------------- antigravity
// 整套照 decolua/9router 的额度实现（不与旧自写逻辑混用）：
//  - 端点：open-sse/providers/registry/antigravity.js:38-40 —— 两个配额端点走
//    daily-cloudcode-pa.googleapis.com（9R providers/shared.js:96
//    ANTIGRAVITY_IDE_BASE_URL），loadCodeAssist 走 cloudcode-pa.googleapis.com。
//  - 客户端指纹：providers/shared.js:95-97（UA antigravity/hub/2.24.0 darwin/arm64）。
//  - 免费档判断：usage/google.js:150-152 —— paidTier.id 为空或 "free-tier" 时
//    fetchAvailableModels 的分模型数据不可信，只看周额度。
//  - 分模型白名单：usage/google.js:157-186 importantModels 原样沿用。
//  - 周/5h 汇总：usage/antigravity-weekly.js:49-111 parseWeeklyQuotaSummary。
const ANTIGRAVITY_BASE_URL = 'https://daily-cloudcode-pa.googleapis.com';
const ANTIGRAVITY_QUOTA_URL = `${ANTIGRAVITY_BASE_URL}/v1internal:fetchAvailableModels`;
const ANTIGRAVITY_QUOTA_SUMMARY_URL = `${ANTIGRAVITY_BASE_URL}/v1internal:retrieveUserQuotaSummary`;
const ANTIGRAVITY_LOADCODEASSIST_URL = 'https://cloudcode-pa.googleapis.com/v1internal:loadCodeAssist';
const ANTIGRAVITY_UA = 'antigravity/hub/2.24.0 darwin/arm64';
const ANTIGRAVITY_IDE_VERSION = '2.24.0';
const PLATFORM_ENUM = { linux: 3, darwin: 2, win32: 1 };
const CLIENT_METADATA = { ideType: 9, platform: PLATFORM_ENUM[process.platform] ?? 3, pluginType: 2 };
// 9R usage/google.js importantModels（配 fetchAvailableModels 返回过滤，白名单外的模型不展示）
const ANTIGRAVITY_IMPORTANT_MODELS = [
  'gemini-4-argon-high', 'gemini-4-argon-medium', 'gemini-4-argon-low',
  'gemini-3.8-flash-high', 'gemini-3.8-flash-medium', 'gemini-3.8-flash-low',
  'gemini-3.7-flash-high', 'gemini-3.7-flash-medium', 'gemini-3.7-flash-low',
  'gemini-3.6-flash-high', 'gemini-3.6-flash-medium', 'gemini-3.6-flash-low',
  'gemini-3.1-pro-high', 'gemini-pro-agent', 'gemini-3.1-pro-low',
  'claude-sonnet-5-5-high', 'claude-sonnet-5-5-medium', 'claude-sonnet-5-5-low', 'claude-sonnet-5-5',
  'claude-opus-5-5-high', 'claude-opus-5-5-medium', 'claude-opus-5-5-low', 'claude-opus-5-5',
  'claude-sonnet-4-6', 'claude-opus-4-6-thinking', 'gpt-oss-120b-medium',
  'gemini-3.1-flash-image',
];

/**
 * 9R antigravity-weekly.js parseWeeklyQuotaSummary 的移植：
 * groups[].buckets[]，window=weekly/5h（或文案含 weekly/five hour/5h/daily），
 * 组名按 /gemini/i 与 /claude|gpt/i 分两族；被上游标 disabled 的**周**桶是真的
 * 不可用（跳过），disabled 的 **5h** 桶保留（以 remainingFraction=0 展示）。
 */
export function parseAntigravityWeeklySummary(data) {
  if (!data || typeof data !== 'object') return {};
  const groups = Array.isArray(data.groups)
    ? data.groups
    : Array.isArray(data.quotaSummary?.groups) ? data.quotaSummary.groups : null;
  if (!groups) return {};

  const GROUP_CONFIGS = [
    { pattern: /gemini/i, weekly: { key: 'gemini_weekly', displayName: 'Gemini (Weekly)' }, session: { key: 'gemini_session', displayName: 'Gemini (5h)' } },
    { pattern: /claude|gpt/i, weekly: { key: 'claude_gpt_weekly', displayName: 'Claude & GPT (Weekly)' }, session: { key: 'claude_gpt_session', displayName: 'Claude & GPT (5h)' } },
  ];

  const result = {};
  for (const group of groups) {
    if (!group || typeof group !== 'object') continue;
    const displayName = group.displayName || '';
    const buckets = Array.isArray(group.buckets) ? group.buckets : [];
    for (const bucket of buckets) {
      if (!bucket || typeof bucket !== 'object') continue;
      const windowType = String(bucket.window || '').toLowerCase();
      const bucketText = `${bucket.bucketId || ''} ${bucket.displayName || ''}`.toLowerCase();
      const isWeekly = windowType === 'weekly' || bucketText.includes('weekly');
      const isSession = windowType === '5h' || bucketText.includes('five hour') || bucketText.includes('5h') || bucketText.includes('daily') || windowType === 'daily';
      if (!isWeekly && !isSession) continue;
      if (bucket.disabled === true && isWeekly) continue;
      const remainingFraction = bucket.disabled === true ? 0 : Number(bucket.remainingFraction);
      if (!Number.isFinite(remainingFraction)) continue;
      for (const config of GROUP_CONFIGS) {
        if (config.pattern.test(displayName)) {
          const target = isWeekly ? config.weekly : config.session;
          if (result[target.key]) break;
          const total = 1000;
          const remaining = Math.round(total * remainingFraction);
          const used = Math.max(0, total - remaining);
          result[target.key] = {
            used,
            total,
            resetAt: parseResetTime(bucket.resetTime),
            remainingPercentage: remainingFraction * 100,
            unlimited: false,
            displayName: target.displayName,
          };
          break;
        }
      }
    }
  }
  return result;
}

/** 9R usage/google.js 的分模型解析（仅付费档调用）：total 归一化 1000 */
export function antigravityModelQuotas(data) {
  const quotas = {};
  if (!data?.models) return quotas;
  for (const [modelKey, info] of Object.entries(data.models)) {
    if (!info?.quotaInfo) continue;
    if (info.isInternal || !ANTIGRAVITY_IMPORTANT_MODELS.includes(modelKey)) continue;
    const remainingFraction = info.quotaInfo.remainingFraction || 0;
    const total = 1000;
    const remaining = Math.round(total * remainingFraction);
    quotas[modelKey] = {
      used: Math.max(0, total - remaining),
      total,
      resetAt: parseResetTime(info.quotaInfo.resetTime),
      remainingPercentage: remainingFraction * 100,
      unlimited: false,
      displayName: info.displayName || modelKey,
    };
  }
  return quotas;
}

/** 9R usage/google.js 的「族内全见底 → 5h 行清零并取最晚 reset」调和 */
function reconcileExhaustedSessions(quotas, weeklyQuotas) {
  const entries = Object.entries(quotas);
  const families = [
    { prefix: 'gemini-', excludeImage: true, session: 'gemini_session' },
    { prefix: 'claude-', excludeImage: false, session: 'claude_gpt_session' },
  ];
  for (const fam of families) {
    const models = entries.filter(([k]) => k.startsWith(fam.prefix) && (!fam.excludeImage || !k.includes('image')));
    const sessionRow = weeklyQuotas[fam.session];
    if (!sessionRow || models.length === 0) continue;
    const allExhausted = models.every(([, q]) => (q.remainingPercentage ?? 0) === 0);
    if (allExhausted && sessionRow.remainingPercentage > 0) {
      const maxResetAt = models.reduce((max, [, q]) => (!max || (q.resetAt && new Date(q.resetAt) > new Date(max)) ? q.resetAt : max), null);
      sessionRow.used = sessionRow.total;
      sessionRow.remainingPercentage = 0;
      if (maxResetAt) sessionRow.resetAt = maxResetAt;
    }
  }
}

export const ANTIGRAVITY_DISPLAY_KEYS = ['gemini_session', 'gemini_weekly'];

export async function fetchAntigravityQuota(tokenObj) {
  const token = typeof tokenObj === 'object' && tokenObj ? tokenObj.token : tokenObj;
  const email = typeof tokenObj === 'object' && tokenObj ? tokenObj.email : null;
  if (!token) return { message: 'Antigravity 凭据不可用（antigravity-oauth-token 缺失或未登录）。' };
  try {
    // loadCodeAssist：拿 project、套餐名与付费档判据（9R getAntigravitySubscriptionInfo）
    let projectId = null;
    let tierName = null;
    let paidTierId = null;
    try {
      const sub = await fetchJsonSmart(ANTIGRAVITY_LOADCODEASSIST_URL, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'User-Agent': ANTIGRAVITY_UA, 'Content-Type': 'application/json' },
        body: JSON.stringify({ metadata: CLIENT_METADATA, mode: 1 }),
      }, 15_000);
      if (sub.ok && sub.json) {
        projectId = sub.json.cloudaicompanionProject || null;
        tierName = sub.json.currentTier?.name || null;
        paidTierId = sub.json.paidTier?.id ?? null;
      }
    } catch { /* 订阅信息失败不阻断配额查询 */ }

    const isFreeTier = !paidTierId || paidTierId === 'free-tier';
    const plan = email ? `${tierName || 'Antigravity'} (${email.split('@')[0]})` : (tierName || 'Antigravity');

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
    if (res.status === 403) return { account: email, plan, message: 'Antigravity 配额接口拒绝访问（会话可能仍可用）。', quotas: [] };
    if (res.status === 401) return { account: email, plan, message: 'Antigravity 令牌已过期，请点击下方 OAuth 登录重新授权。', quotas: [] };
    if (!res.ok) return { account: email, plan, message: `Antigravity 配额接口错误 (${res.status})。` };

    const data = res.json || {};
    // 免费档：分模型数据误导（缺 remainingFraction 会默认 0，或反映的是周限而非 5h），只看周额度
    const quotas = isFreeTier ? {} : antigravityModelQuotas(data);

    // 周/5h 汇总（best-effort，失败不阻断分模型结果）
    try {
      const weekly = await fetchJsonSmart(ANTIGRAVITY_QUOTA_SUMMARY_URL, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'User-Agent': ANTIGRAVITY_UA,
          'Content-Type': 'application/json',
          'X-Client-Name': 'antigravity',
          'X-Client-Version': ANTIGRAVITY_IDE_VERSION,
        },
        body: JSON.stringify(projectId ? { project: projectId } : {}),
      }, 15_000);
      if (weekly.ok && weekly.json) {
        const weeklyQuotas = parseAntigravityWeeklySummary(weekly.json);
        reconcileExhaustedSessions(quotas, weeklyQuotas);
        Object.assign(quotas, weeklyQuotas);
      }
    } catch { /* weekly is best-effort */ }

    // 用户 2026-11-08 20:00 定：工作台只显示 Gemini 的 5h 与周额度；分模型行仅用于上面的 reconcile，不展示。
    for (const k of Object.keys(quotas)) if (!ANTIGRAVITY_DISPLAY_KEYS.includes(k)) delete quotas[k];
    if (Object.keys(quotas).length === 0) {
      return { account: email, plan, message: `凭据在线${email ? ` (${email})` : ''}${isFreeTier ? '（免费档：分模型配额不下发，仅周额度）' : ''}；上游未返回配额数据。`, quotas: [] };
    }
    return { account: email, plan, quotas: Object.entries(quotas).map(([name, q]) => ({ name, ...q })) };
  } catch (e) {
    return { account: email, message: `Antigravity 错误: ${e.message}` };
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
  const login = data.login || null;
  const basePlan = data.copilot_plan || data.access_type_sku || 'Copilot';
  const plan = login ? `${basePlan} (${login})` : basePlan;
  const fmtSnap = (q) => q ? { used: (q.entitlement || 0) - (q.remaining || 0), total: q.entitlement || 0, remaining: q.remaining || 0, unlimited: !!q.unlimited } : { used: 0, total: 0, unlimited: true };

  if (data.quota_snapshots) {
    const resetAt = parseResetTime(data.quota_reset_date);
    const s = data.quota_snapshots;
    return {
      account: login,
      plan,
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
      account: login,
      plan,
      quotas: {
        chat: { used: used.chat || 0, total: monthly.chat || 0, unlimited: false, resetAt },
        completions: { used: used.completions || 0, total: monthly.completions || 0, unlimited: false, resetAt },
      },
    };
  }
  return { account: login, plan, message: 'Copilot 已连接，未返回配额结构。' };
}

// ---------------------------------------------------------------- traecode
// 真实积分读取在 quota-deep.mjs（需要 trae-checkin.mjs 的令牌续期与设备号派生，
// 而那两者反过来 import 本模块，故不能在初始化期静态引用）。旧实现只解析 JWT
// 有效期、不查积分，已下线。

// ---------------------------------------------------------------- zcode
// 额度查询照两份开源实现，不自行发明：
//  - start-plan 积分（送的 token 包）：iJetLi/dsh-providers-hub
//    src/zcode-upstream.ts:57,65（积分制无论 bigmodel 还是 zai 账号都走
//    zcode.z.ai 的 /api/v1/zcode-plan/billing/balance；Authorization 与
//    X-Device-Mid 均必需，缺后者 400 code 3001）+ src/zcode-entitlements.ts
//    （balances[] 按模型分桶，capabilities:["model:<id>"]，单位 token；
//    企业版 displayMode:"enterprise" 不下发数字，不得显示成 0）。
//  - GLM Coding Plan monitor（5h/周窗口）：decolua/9router
//    open-sse/services/usage/glm.js:19-58 —— data.limits[]，type 只认
//    TOKENS_LIMIT/CREDIT_LIMIT，percentage 是**已用**%，unit 3→Session、
//    6→Weekly，nextResetTime 毫秒，data.level 是套餐名。
//  - 请求头形状照 HUB buildZcodeHeaders（zcode-upstream.ts:299-347）：平台
//    三件套同源（官方 win32 客户端指纹）。
const ZCODE_ORIGIN = 'https://zcode.z.ai';
const ZCODE_BALANCE_URL = `${ZCODE_ORIGIN}/api/v1/zcode-plan/billing/balance`;
// HUB 的版本门控最低值（zcode-upstream.ts ZCODE_VERSION_GATED_MIN_APP_VERSION）
const ZCODE_APP_VERSION = '3.16.3';
// HUB zcode-upstream.ts ZCODE_SPOOF_PLATFORM：非 Windows 宿主也按官方 win32
// 客户端的真实指纹发，三件套必须同源
const ZCODE_SPOOF_PLATFORM = { platform: 'win32-x64', osCategory: 'windows', osVersion: '10.0.26100' };
/** 每个账号（device_mid）一个、进程内稳定的伪会话 id（HUB zcodeSessionId） */
const zcodeSessionIds = new Map();

function zcodeSessionId(deviceMid) {
  const key = typeof deviceMid === 'string' ? deviceMid : '';
  let id = zcodeSessionIds.get(key);
  if (!id) {
    id = randomBytes(16).toString('hex');
    zcodeSessionIds.set(key, id);
  }
  return id;
}

/**
 * device_mid 三级来源：官方客户端的 `~/.zcode/v2/telemetry-state.json`
 * deviceMid（HUB src/zcode.ts:15 readDeviceMid 的出处）→ hub 自己持久化的
 * 副本 → 现场生成 UUID 并持久化（HUB zcode-login.ts:156 generateDeviceMid，
 * 生成后必须固定：同一账号换 mid 等于「换了台设备」）。绝不写官方客户端的
 * telemetry-state.json，hub 副本落在自己的状态目录。
 */
export async function resolveZcodeDeviceMid(home = HOME) {
  const telemetry = await readJsonSafe(join(home, '.zcode', 'v2', 'telemetry-state.json'));
  const official = typeof telemetry?.deviceMid === 'string' ? telemetry.deviceMid.trim() : '';
  if (official) return { deviceMid: official, source: 'official-client' };
  const hubPath = join(home, '.agenthub', 'zcode-device-mid');
  let persisted = '';
  try { persisted = (await readFile(hubPath, 'utf-8')).trim(); } catch { /* first run */ }
  if (persisted) return { deviceMid: persisted, source: 'hub-cache' };
  const generated = randomBytes(16).toString('hex');
  try {
    await mkdir(dirname(hubPath), { recursive: true });
    await writeFile(hubPath, `${generated}\n`, { mode: 0o600 });
  } catch { /* 只读环境：退化为进程内不稳定 mid，仍能过 3001 校验 */ }
  return { deviceMid: generated, source: 'generated' };
}

/** HUB buildZcodeHeaders 的配额子集（billing 全家桶的头形状） */
export function zcodeQuotaHeaders(deviceMid, authorization) {
  return {
    'User-Agent': `ZCode/${ZCODE_APP_VERSION}`,
    'HTTP-Referer': ZCODE_ORIGIN,
    'X-Title': 'Z Code@electron',
    'X-ZCode-App-Version': ZCODE_APP_VERSION,
    'X-Release-Channel': 'production',
    'X-Client-Language': 'zh-CN',
    'X-Client-Timezone': 'Asia/Shanghai',
    'X-Device-Mid': deviceMid,
    'X-Platform': ZCODE_SPOOF_PLATFORM.platform,
    'X-Os-Category': ZCODE_SPOOF_PLATFORM.osCategory,
    'X-Os-Version': ZCODE_SPOOF_PLATFORM.osVersion,
    'X-ZCode-Agent': 'glm',
    'X-Session-Id': zcodeSessionId(deviceMid),
    'X-ZCode-Session-Type': 'other',
    'X-Request-Id': randomBytes(16).toString('hex'),
    'X-ZCode-Trace-Id': randomBytes(16).toString('hex'),
    Accept: 'application/json',
    ...(authorization !== undefined ? { Authorization: authorization } : {}),
  };
}

/**
 * HUB fetchZcodeBalance 的解析（zcode-upstream.ts:635-706）：
 * 余额是 `data.balances[]`，一条一个模型桶；`capabilities: ["model:<小写 id>"]`
 * 是模型归属判据（zcode-entitlements.ts:65-71，非 model: 前缀一律不猜）。
 */
export function parseZcodeBalance(json) {
  const data = json?.data && typeof json.data === 'object' ? json.data : null;
  if (!data) return null;
  if (data.displayMode === 'enterprise') return { enterprise: true, buckets: [] };
  const rawBuckets = Array.isArray(data.balances) ? data.balances : [];
  const buckets = [];
  for (const item of rawBuckets) {
    if (!item || typeof item !== 'object') continue;
    const capabilities = Array.isArray(item.capabilities) ? item.capabilities : [];
    const models = capabilities
      .filter((c) => typeof c === 'string' && c.toLowerCase().startsWith('model:'))
      .map((c) => c.slice('model:'.length).trim().toLowerCase())
      .filter(Boolean);
    const remainingRaw = item.available_units ?? item.remaining_units;
    buckets.push({
      planId: typeof item.plan_id === 'string' ? item.plan_id : null,
      showName: typeof item.show_name === 'string' ? item.show_name : null,
      unitType: typeof item.unit_type === 'string' ? item.unit_type : null,
      total: toFiniteNumber(item.total_units, 0),
      used: toFiniteNumber(item.used_units, 0),
      remaining: remainingRaw === undefined || remainingRaw === null ? null : toFiniteNumber(remainingRaw, 0),
      expiresAt: parseResetTime(item.expires_at),
      models,
    });
  }
  return { enterprise: false, buckets };
}

/**
 * 9R glm.js parseGlmQuotaResponse 的逐行移植（open-sse/services/usage/glm.js:19-58）：
 * limits[].percentage 是已用%，unit 3→Session(N h)、6→Weekly (7d)。
 */
export function parseGlmQuotaLimits(json) {
  const data = json?.data && typeof json.data === 'object' ? json.data : {};
  const limits = Array.isArray(data.limits) ? data.limits : [];
  const quotas = {};
  for (const limit of limits) {
    if (!limit || (limit.type !== 'TOKENS_LIMIT' && limit.type !== 'CREDIT_LIMIT')) continue;
    const usedPercent = Number(limit.percentage) || 0;
    const resetMs = Number(limit.nextResetTime) || 0;
    const remaining = Math.max(0, 100 - usedPercent);
    let key = 'session';
    if (limit.unit === 3) {
      key = `Session (${limit.number}h)`;
    } else if (limit.unit === 6) {
      key = 'Weekly (7d)';
    } else if (limit.type === 'TOKENS_LIMIT') {
      key = 'Tokens';
    } else {
      key = `Limit (${limit.number})`;
    }
    quotas[key] = {
      used: usedPercent,
      total: 100,
      remaining,
      remainingPercentage: remaining,
      resetAt: resetMs > 0 ? new Date(resetMs).toISOString() : null,
      unlimited: false,
    };
  }
  const levelRaw = typeof data.level === 'string' ? data.level : '';
  const plan = levelRaw ? levelRaw.charAt(0).toUpperCase() + levelRaw.slice(1).toLowerCase() : 'Unknown';
  return { plan, quotas };
}

const ZCODE_MONITOR_URLS = [
  'https://open.bigmodel.cn/api/monitor/usage/quota/limit',
  'https://api.z.ai/api/monitor/usage/quota/limit',
];

export async function fetchZcodeQuota(tokenObj) {
  if (!tokenObj) return { message: 'ZCode 凭据不可用（未登录或 ~/.zcode/v2/credentials.json 缺失）。' };
  const username = tokenObj.userInfo?.username || tokenObj.userInfo?.displayName || null;
  const activeProv = tokenObj.activeProvider || 'bigmodel';
  const planName = username ? `ZCode (${username})` : 'ZCode';
  const { deviceMid } = await resolveZcodeDeviceMid();

  // 第一路：start-plan 积分（zcodejwttoken + X-Device-Mid，按模型分桶，单位 token）
  const jwt = tokenObj.zcodeJwt || tokenObj.oauthTok;
  let quotas = [];
  let plan = planName;
  let startPlanError = '';
  if (jwt) {
    try {
      const res = await fetchJson(ZCODE_BALANCE_URL, {
        headers: zcodeQuotaHeaders(deviceMid, `Bearer ${jwt}`),
      }, 10_000);
      if (res.ok && res.json) {
        const parsed = parseZcodeBalance(res.json);
        if (parsed?.enterprise) {
          quotas.push({ name: 'start-plan', displayName: '企业版额度', used: 0, total: 0, remaining: 0, remainingPercentage: 0, unlimited: true });
        } else if (parsed && parsed.buckets.length > 0) {
          for (const bucket of parsed.buckets) {
            const model = bucket.models[0] || null;
            const label = bucket.showName || model || 'start-plan 积分';
            const displayName = model && bucket.showName && !bucket.showName.toLowerCase().includes(model)
              ? `${bucket.showName} · ${model}`
              : label;
            const remaining = bucket.remaining ?? Math.max(0, bucket.total - bucket.used);
            if (bucket.total <= 0 && remaining <= 0 && bucket.used <= 0) continue;
            quotas.push({
              name: displayName,
              displayName,
              used: bucket.used,
              total: bucket.total,
              remaining,
              remainingPercentage: bucket.total > 0 ? Math.max(0, Math.min(100, (remaining / bucket.total) * 100)) : 0,
              resetAt: bucket.expiresAt,
              unlimited: false,
              isCreditBalance: true,
              unit: bucket.unitType || 'token',
            });
          }
        } else if (parsed) {
          startPlanError = 'start-plan 余额为空';
        }
      } else if (res.status === 401 || res.status === 403) {
        startPlanError = `start-plan 余额接口拒绝（HTTP ${res.status}），令牌可能过期`;
      } else {
        startPlanError = `start-plan 余额接口错误（HTTP ${res.status}）`;
      }
    } catch (e) {
      startPlanError = `start-plan 余额请求异常: ${e.message}`;
    }
  }

  // 第二路：GLM Coding Plan monitor（api-key 才是 monitor 的凭据，9R glm.js）
  const apiKey = tokenObj.apiKey;
  if (apiKey) {
    for (const url of ZCODE_MONITOR_URLS) {
      try {
        const res = await fetchJson(url, { headers: { Authorization: `Bearer ${apiKey}`, Accept: 'application/json' } }, 8000);
        if (res.ok && res.json?.data) {
          const parsed = parseGlmQuotaLimits(res.json);
          if (Object.keys(parsed.quotas).length > 0) {
            plan = `${planName} · GLM Coding Plan ${parsed.plan}`;
            for (const [name, q] of Object.entries(parsed.quotas)) quotas.push({ name, displayName: name, ...q });
            break;
          }
        }
      } catch { /* 下一个 */ }
    }
  }

  if (!quotas.length) {
    const acctLabel = username ? `账号 ${username} (${activeProv})` : `通道 ${activeProv}`;
    return {
      account: username,
      plan: planName,
      message: `凭据在线（${acctLabel}）${startPlanError ? `；${startPlanError}` : ''}；未取得可展示的额度明细。`,
    };
  }
  const enterprise = quotas.length === 1 && quotas[0].unlimited === true;
  return {
    account: username,
    plan,
    ...(enterprise ? { message: '企业版（displayMode=enterprise）不下发额度数字，仅显示通道状态。' } : {}),
    quotas: enterprise ? [] : quotas,
  };
}

// ---------------------------------------------------------------- mimocode
async function fetchMimoQuota(tokenObj) {
  if (!tokenObj) return { message: 'MiMo 凭据不可用（未登录或 ~/.local/share/mimocode/auth.json 缺失）。' };
  const provs = Array.isArray(tokenObj.providers) ? tokenObj.providers : ['xiaomi'];
  const xm = tokenObj.raw?.xiaomi;
  const uidVal = xm?.metadata?.uid ? String(xm.metadata.uid) : null;
  const uidSuffix = uidVal ? ` · UID:${uidVal}` : '';
  const account = uidVal ? `mimo-${uidVal}` : provs[0] || null;
  return {
    account,
    plan: `Xiaomi MiMo${uidSuffix}`,
    message: `凭据在线（账号: ${uidVal ? `小米 UID ${uidVal}` : provs.join(', ')} · 已配置通道: ${provs.join(', ')}）；官方暂无公开分模型配额端点。`,
  };
}

// ---------------------------------------------------------------- codearts
/**
 * 华为云码道（CodeArts Doer）真实配额。
 *
 * 数据源：snap-manager `/v1/statistics/plugin`（AK/SK 签名，SDK-HMAC-SHA256），
 * 也就是 CodeArts 客户端「资源用量」面板背后的同一支接口。返回的关键字段：
 *  - `package.package_name_cn` 套餐名（高级版/专业版…），`end_date` 本周期到期日
 *  - `metrics[]` 里 `usageTotalPackageCredit` 是**积分总包**（amount/used/remain），
 *    `usageBasicPackageCredit` 基础包、`usageBonusPackageCredit` 赠送包是其拆分，
 *    `usageOnDemandPackageCredit` 按需包通常为 0（不展示）。
 * ⚠️ `usageTokenChatMessages.package_token_amount` 只有一个「1」，没有可用的
 * 月度 tokens 上限，别拿它编一个总量出来——只展示积分口径。
 */
const CODEARTS_REGIONS = ['cn-north-4', 'cn-east-3', 'cn-south-1'];

async function fetchCodeArtsQuota(tokenObj) {
  if (!tokenObj || !tokenObj.ak) return { message: 'CodeArts 凭据不可用（未登录或 ~/.config/agenthub-codearts/codearts-auth.env 缺失）。' };
  const akMask = tokenObj.ak.length > 8
    ? `${tokenObj.ak.slice(0, 4)}…${tokenObj.ak.slice(-4)}`
    : `${tokenObj.ak.slice(0, 3)}…`;
  const account = akMask;

  let payload = null;
  let lastError = '';
  for (const region of CODEARTS_REGIONS) {
    const url = `https://snap-access.${region}.myhuaweicloud.com/snap-manager/v1/statistics/plugin`;
    let headers;
    try {
      headers = hwsSdkSignedHeaders(tokenObj.ak, tokenObj.sk, 'GET', url, '', {
        'Content-Type': 'application/json',
        'Agent-Type': 'PromptCenter',
        'X-Language': 'zh-cn',
      });
    } catch (e) {
      lastError = e.message;
      continue;
    }
    let res;
    try {
      res = await fetchJson(url, { headers }, 15_000);
    } catch (e) {
      lastError = e.message;
      continue;
    }
    if (res.ok && res.json && typeof res.json === 'object') {
      if (Array.isArray(res.json.metrics) && res.json.metrics.length) { payload = res.json; break; }
      lastError = '接口未返回 metrics';
      continue;
    }
    lastError = `HTTP ${res.status}`;
  }

  if (!payload) {
    return { account, plan: `CodeArts Doer (${akMask})`, message: `凭据在线（${akMask}），配额接口暂不可用${lastError ? `：${lastError}` : ''}。` };
  }

  const metrics = Array.isArray(payload.metrics) ? payload.metrics : [];
  const byName = (name) => metrics.find((m) => m && m.name === name) || null;
  const resetAt = parseResetTime(payload.end_date);
  const planName = payload?.package?.package_name_cn ? `CodeArts Doer (${payload.package.package_name_cn})` : `CodeArts Doer (${akMask})`;

  const quotas = [];
  const pushCredit = (label, metric, primary) => {
    if (!metric) return;
    const total = toFiniteNumber(metric.package_credit_amount, 0);
    const used = toFiniteNumber(metric.package_credit_used, 0);
    const remainRaw = metric.package_credit_remain;
    const remaining = remainRaw === undefined || remainRaw === null
      ? Math.max(0, total - used)
      : toFiniteNumber(remainRaw, 0);
    if (total <= 0 && remaining <= 0 && used <= 0) return;
    quotas.push({
      name: label,
      displayName: label,
      used: Math.round(used * 100) / 100,
      total: Math.round(total * 100) / 100,
      remaining: Math.round(remaining * 100) / 100,
      remainingPercentage: total > 0 ? Math.round((remaining / total) * 10000) / 100 : 0,
      resetAt,
      unlimited: false,
      isCreditBalance: true,
      primary: primary === true,
      unit: 'credits',
    });
  };

  pushCredit('积分总额', byName('usageTotalPackageCredit'), true);
  pushCredit('基础包', byName('usageBasicPackageCredit'), false);
  const bonus = byName('usageBonusPackageCredit');
  if (bonus && toFiniteNumber(bonus.package_credit_remain, 0) > 0) pushCredit('赠送包', bonus, false);
  const onDemand = byName('usageOnDemandPackageCredit');
  if (onDemand && (toFiniteNumber(onDemand.package_credit_remain, 0) > 0 || toFiniteNumber(onDemand.package_credit_used, 0) > 0)) {
    pushCredit('按需包', onDemand, false);
  }

  if (!quotas.length) {
    return { account, plan: planName, message: `凭据在线（${akMask}），本期无可用积分包。` };
  }
  return { account, plan: planName, quotas };
}

// ---------------------------------------------------------------- cline
// 照 iJetLi/dsh-providers-hub 的 Cline 额度实现：
//  - 订阅窗口：src/cline-quota.ts:18-58 —— GET https://api.cline.bot/api/v1/users/me/plan/usage-limits
//    （路径是字面量 users/me，按 Bearer 判账号），返回 limits[]{type:
//    five_hour|weekly|monthly, percentUsed, resetsAt}；resetsAt 是带纳秒的 ISO，
//    用量为 0 的窗口 resetsAt 是**空串**（官方客户端不渲染该行）。
//  - 余额：src/cline-credits.ts:1-60 —— GET /api/v1/users/{accountId}/balance，
//    userId 用凭据里的 accountId（usr-…），**不是** JWT 的 sub（user_…，传了 400）；
//    Authorization 必须原样保留 workos: 前缀（剥掉 401 且报错误导成「版本过旧」）；
//    余额单位实测 500000，按 CLINE_BALANCE_SCALE=1e5 折算 USD（HUB 79 行）。
const CLINE_API_BASE = 'https://api.cline.bot';
const CLINE_CLIENT_HEADERS = {
  'HTTP-Referer': 'https://cline.bot',
  'X-Title': 'Cline',
  'X-IS-MULTIROOT': 'false',
  'X-CLIENT-TYPE': 'cline-sdk',
};
const CLINE_BALANCE_SCALE = 100_000;

export function clineBearerValue(accessToken) {
  const token = String(accessToken || '').trim();
  if (!token) return '';
  return token.startsWith('workos:') ? token : `workos:${token}`;
}

/** HUB parseClineUsageLimits 的移植（cline-quota.ts:139-170） */
export function parseClineUsageLimits(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return { windows: [], error: '响应不是 JSON 对象' };
  const serverError = typeof value.error === 'string' && value.error.trim() ? value.error.trim()
    : typeof value.message === 'string' && value.message.trim() ? value.message.trim() : '';
  if (value.success === false || (serverError !== '' && value.success !== true)) {
    return { windows: [], error: serverError || '服务端返回失败' };
  }
  const payload = value.data && typeof value.data === 'object' && !Array.isArray(value.data) ? value.data : value;
  if (!Array.isArray(payload.limits)) return { windows: [], error: '响应缺少 limits 字段' };
  const windows = [];
  for (const item of payload.limits) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
    const type = typeof item.type === 'string' ? item.type.trim() : '';
    if (!type) continue;
    const percent = Number(item.percentUsed);
    windows.push({
      type,
      percentUsed: Number.isFinite(percent) ? percent : 0,
      resetsAt: typeof item.resetsAt === 'string' ? item.resetsAt.trim() : '',
    });
  }
  return { windows };
}

function clineWindowLabel(type) {
  if (type === 'five_hour') return '5 小时窗口';
  if (type === 'weekly') return '每周窗口';
  if (type === 'monthly') return '每月窗口';
  return type;
}

async function clineGet(url, token) {
  return fetchJson(url, {
    headers: { Authorization: `Bearer ${clineBearerValue(token)}`, Accept: 'application/json', ...CLINE_CLIENT_HEADERS },
  }, 15_000);
}

export async function fetchClineQuota(tokenObj) {
  const token = typeof tokenObj === 'object' && tokenObj ? tokenObj.token : null;
  const accountId = typeof tokenObj === 'object' && tokenObj ? tokenObj.accountId : null;
  if (!token) return { message: 'Cline 凭据不可用（未登录或 ~/.cline/data/settings/providers.json 缺失）。' };

  const quotas = [];
  let lastError = '';
  try {
    const res = await clineGet(`${CLINE_API_BASE}/api/v1/users/me/plan/usage-limits`, token);
    if (res.ok && res.json) {
      const parsed = parseClineUsageLimits(res.json);
      if (parsed.error) lastError = parsed.error;
      for (const w of parsed.windows) {
        if (!w.resetsAt) continue;
        const remaining = Math.max(0, 100 - w.percentUsed);
        quotas.push({
          name: clineWindowLabel(w.type),
          displayName: clineWindowLabel(w.type),
          used: w.percentUsed,
          total: 100,
          remaining,
          remainingPercentage: remaining,
          resetAt: parseResetTime(w.resetsAt),
          unlimited: false,
        });
      }
    } else {
      lastError = `额度接口错误 (HTTP ${res.status})`;
    }
  } catch (e) {
    lastError = e.message;
  }

  // 余额：必须用 accountId（usr-…），不是 JWT sub
  if (accountId) {
    try {
      const res = await clineGet(`${CLINE_API_BASE}/api/v1/users/${encodeURIComponent(accountId)}/balance`, token);
      if (res.ok && res.json) {
        const raw = Number(res.json?.data?.balance);
        if (Number.isFinite(raw)) {
          const usd = Math.round((raw / CLINE_BALANCE_SCALE) * 100) / 100;
          quotas.push({
            name: '余额',
            displayName: '余额',
            used: 0,
            total: usd,
            remaining: usd,
            remainingPercentage: 100,
            resetAt: null,
            unlimited: false,
            isCreditBalance: true,
            unit: 'USD',
          });
        }
      }
    } catch { /* 余额失败不影响窗口展示 */ }
  }

  if (!quotas.length) {
    return { account: accountId, plan: 'Cline', message: `Cline 已连接${lastError ? `；${lastError}` : ''}；未取得可展示的额度窗口。` };
  }
  return { account: accountId, plan: 'Cline', quotas };
}

// ---------------------------------------------------------------- perch
// 照 jawkills/perch2api 的额度实现：src/gateway.mjs:213-228（GET
// {appUrl}/api/perchai/account，头 Accept / Authorization Bearer /
// User-Agent: perchai-cli/<ver> / x-perch-locale）+ docs/RE-FINDINGS.md:293-303
// （session.planCode/planName/entitlements[] 与 usageMeter.dailyPt，1PT=$0.001；
// **响应没有剩余/上限字段 → 不编造剩余**，只展示套餐与当日已用 PT）。
const PERCH_DEFAULT_APP_URL = 'https://app.perchai.app';

export function parsePerchAccount(json) {
  if (!json || typeof json !== 'object') return null;
  const session = json.session && typeof json.session === 'object' ? json.session : {};
  const usageMeter = json.usageMeter && typeof json.usageMeter === 'object' ? json.usageMeter : {};
  const dailyPt = Number(usageMeter.dailyPt);
  return {
    planCode: typeof session.planCode === 'string' ? session.planCode : null,
    planName: typeof session.planName === 'string' ? session.planName : null,
    dailyPt: Number.isFinite(dailyPt) ? dailyPt : null,
  };
}

export async function fetchPerchQuota(tokenObj) {
  const token = typeof tokenObj === 'object' && tokenObj ? tokenObj.token : null;
  const email = typeof tokenObj === 'object' ? tokenObj.email : null;
  const appUrl = (typeof tokenObj === 'object' && tokenObj?.appUrl) || PERCH_DEFAULT_APP_URL;
  if (!token) return { message: 'Perch 凭据不可用（未登录或 ~/.perch/cli-auth-session.json 缺失）。' };
  let res;
  try {
    res = await fetchJson(`${appUrl}/api/perchai/account`, {
      headers: {
        Accept: 'application/json',
        Authorization: `Bearer ${token}`,
        'User-Agent': 'perchai-cli/2.4.118',
        'x-perch-locale': 'en',
      },
    }, 15_000);
  } catch (e) {
    return { account: email, message: `Perch 请求异常: ${e.message}` };
  }
  if (res.status === 401 || res.status === 403) return { account: email, message: 'Perch 凭据无效或已过期，请重新登录。' };
  if (!res.ok) return { account: email, message: `Perch 账户接口错误 (${res.status})。` };
  const parsed = parsePerchAccount(res.json);
  if (!parsed) return { account: email, message: 'Perch 账户响应形状不符合预期。' };

  const plan = parsed.planName || parsed.planCode || 'Perch';
  const daily = parsed.dailyPt;
  if (daily === null) {
    return { account: email, plan, message: 'Perch 已连接；接口未下发用量数据。' };
  }
  // 无剩余/上限字段：不编造，当日已用 PT 走 message（1 PT = $0.001）
  return {
    account: email,
    plan,
    quotas: [],
    message: `今日已用 ${daily} PT（≈ $${(Math.round(daily * 0.001 * 100) / 100).toFixed(2)}）；接口未下发剩余额度，不做推算。`,
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
  'zcode': fetchZcodeQuota,
  'codearts': fetchCodeArtsQuota,
  'cline': fetchClineQuota,
  'perch': fetchPerchQuota,
  '9router': fetchNinerouterQuota,
  // 百度搭子：账号与 cookie 在 dumate.mjs 自己的存储里（日常页扫码登录），不经 TOKEN_READERS
  'dumate': () => fetchDumateQuota(),
};

// ---------------------------------------------------------------- 9router（用户 2026-11-08 21:57：9router 的额度就用 ollama 的）
// 不碰 9router 数据库与 key：本机 9router 自己的 /api/providers 列连接、/api/usage/<id> 取额度
// （即 9router 内置 ollama 实现：ollama.com/api/usage）。只取启用中的 provider=ollama 连接。
const NINEROUTER_URL = (process.env.NINEROUTER_URL || 'http://127.0.0.1:20128').replace(/\/+$/, '');
export function mergeNinerouterOllama(conns, usages) {
  const quotas = [];
  const plans = new Set();
  const errors = [];
  conns.forEach((c, i) => {
    const u = usages[i] || {};
    const label = `ollama ${c.name || c.id.slice(0, 8)}`;
    if (u.plan) plans.add(u.plan);
    const qs = normalizeQuotas(u.quotas) || [];
    if (!qs.length) { errors.push(`${label}: ${u.message || u.error || '无额度数据'}`); return; }
    for (const q of qs) quotas.push({ ...q, name: `${label} · ${q.name}`, displayName: `${label} · ${q.displayName || q.name}` });
  });
  const out = { plan: plans.size ? `Ollama Cloud ${[...plans].join('/')}` : 'Ollama Cloud', quotas };
  if (errors.length) out.message = errors.join('；');
  return out;
}
async function fetchNinerouterQuota() {
  let list;
  try { const r = await fetchJson(`${NINEROUTER_URL}/api/providers`, {}, 10_000); if (!r.ok) return { message: `9router /api/providers 返回 ${r.status}` }; list = r.json; }
  catch (e) { return { message: `9router 不可达: ${e.message}` }; }
  const conns = (list?.connections || []).filter((c) => c && c.provider === 'ollama' && c.isActive !== false && c.isActive !== 0)
    .map((c) => ({ id: String(c.id), name: c.name || '' }));
  if (!conns.length) return { plan: 'Ollama Cloud', message: '9router 没有启用中的 ollama 连接', quotas: [] };
  const usages = await Promise.all(conns.map((c) => fetchJson(`${NINEROUTER_URL}/api/usage/${encodeURIComponent(c.id)}`, {}, 20_000)
    .then((r) => r.json || { message: `HTTP ${r.status}` }).catch((e) => ({ message: e.message }))));
  return mergeNinerouterOllama(conns, usages);
}

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
    let data;
    if (DEEP_QUOTA_WORKERS.has(worker)) {
      // 走 quota-deep.mjs：自行解密凭据 + 解析设备身份，不需要本地 TOKEN_READERS
      try {
        const mod = await loadDeepQuota();
        data = await mod.getDeepQuota(worker);
      } catch (e) {
        data = { message: `配额查询异常: ${e.message}` };
      }
    } else {
      const token = await readToken(worker);
      const fetcher = FETCHERS[worker];
      if (!fetcher) data = { message: `未知的配额 worker: ${worker}` };
      else {
        // 未登录也走 fetcher(null) 出「凭据不可用」提示；任何一家抛错只影响自己这一格，
        // 不能让 getAllQuotas 整体失败（E66：/hub/quota 因此回 502）。
        try { data = await fetcher(worker !== 'github-copilot' && !token ? null : token); }
        catch (e) { data = { message: `配额查询异常: ${e.message}` }; }
      }
    }
    const payload = { worker, fetchedAt: new Date().toISOString(), ...(data || {}) };
    if (payload.quotas) payload.quotas = normalizeQuotas(payload.quotas);
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
