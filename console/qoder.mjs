// @ts-check
// Qoder / Qoder CN 共享逻辑：凭据解密、账号身份、模型目录与签到 API。
// CLI 1.1.74 的登录态在 <config>/.auth/user：AES-128-CBC，key=iv=machine_id 前 16 字节。
// 另有 keychain 文件回退（<config>/qoder-cli-credentials.json + .keychain-salt，
// scrypt + AES-256-GCM）用于无系统钥匙串的环境；两种格式都要能读、能切换、能回写。
// 桌面版 auth.v1.dat 是另一套格式（Chromium v11），不直接作为 CLI 凭据使用。

import { createDecipheriv, createCipheriv, scryptSync, randomBytes, createHash } from 'node:crypto';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { fetchJsonSmart } from './vendor-quota.mjs';

export const QODER_REGIONS = {
  qoder: {
    worker: 'qoder',
    label: 'Qoder',
    configDir: '.qoder',
    name: 'Qoder (国际版)',
    openapi: 'https://openapi.qoder.sh',
    website: 'https://qoder.com',
    domain: 'qoder.com',
  },
  'qoder-cn': {
    worker: 'qoder-cn',
    label: 'Qoder CN',
    configDir: '.qoder-cn',
    name: 'Qoder CN (国内版)',
    openapi: 'https://openapi.qoder.com.cn',
    website: 'https://qoder.com.cn',
    domain: 'qoder.com.cn',
  },
};

/** 与 cosy 活动平台对齐的桌面端版本；官方升级后可用环境变量覆盖 */
export const QODER_DESKTOP_VERSION = (process.env.AGENTHUB_QODER_DESKTOP_VERSION || '0.4.3').trim() || '0.4.3';

export const QODER_MODELS = [
  { id: 'dfmodel', name: 'DeepSeek-Flash', credits: '0.1x', tag: '限时免费', default: true },
  { id: 'dmodel', name: 'DeepSeek-V4-Pro' },
  { id: 'auto', name: 'Auto' },
  { id: 'qmodel_38max', name: 'Qwen3.8-Max', credits: '0.50x' },
  { id: 'qfmodel', name: 'Qwen3.8-Flash', tag: '限时免费' },
  { id: 'qmodel_latest', name: 'Qwen3.7-Max', credits: '0.50x' },
  { id: 'qmodel', name: 'Qwen3.7-Plus', credits: '0.10x' },
  { id: 'q37fmodel', name: 'Qwen3.7-Flash' },
  { id: 'gmodel', name: 'GLM-5.3' },
  { id: 'gfmodel', name: 'GLM-5.3-Flash' },
  { id: 'gm51model', name: 'GLM-5.2' },
  { id: 'kmodel_latest', name: 'Kimi-K3' },
  { id: 'kmodel', name: 'Kimi-K2.8-Preview' },
  { id: 'mmodel', name: 'MiniMax-M2.7' },
];

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

export function qoderRegion(worker) {
  return QODER_REGIONS[worker] || QODER_REGIONS.qoder;
}

export function qoderConfigDir(home, worker) {
  return join(home, qoderRegion(worker).configDir);
}

/** 解密 CLI 文件回退凭据；salt 缺失或密文损坏时明确失败，不吞异常 */
export function decryptQoderCredential(cipherText, salt) {
  const key = scryptSync('qoder-cli-credentials', salt, 32);
  const parts = String(cipherText || '').trim().split(':');
  if (parts.length !== 3) throw new Error('Invalid encrypted data format');
  const iv = Buffer.from(parts[0], 'hex');
  const tag = Buffer.from(parts[1], 'hex');
  const data = Buffer.from(parts[2], 'hex');
  if (iv.length !== 16 || tag.length !== 16 || !data.length) throw new Error('Invalid encrypted data format');
  const decipher = createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  const plain = Buffer.concat([decipher.update(data), decipher.final()]).toString('utf-8');
  return JSON.parse(plain.replace(/^\uFEFF/, ''));
}

/** CLI 主登录态 ~/.qoder/.auth/user：AES-128-CBC，key=iv=machine_id[:16] */
export function decryptLegacyQoderUser(cipherText, machineId) {
  const text = String(cipherText || '').trim();
  if (!text) throw new Error('Empty Qoder user file');
  if (text.startsWith('{')) return JSON.parse(text.replace(/^\uFEFF/, ''));
  const key = Buffer.from(String(machineId || '').trim().slice(0, 16), 'utf-8');
  if (key.length !== 16) throw new Error('machine_id shorter than 16 bytes');
  const decipher = createDecipheriv('aes-128-cbc', key, key);
  const plain = Buffer.concat([decipher.update(Buffer.from(text, 'base64')), decipher.final()]).toString('utf-8');
  return JSON.parse(plain.replace(/^\uFEFF/, ''));
}

export function encryptLegacyQoderUser(plain, machineId) {
  const key = Buffer.from(String(machineId || '').trim().slice(0, 16), 'utf-8');
  if (key.length !== 16) throw new Error('machine_id shorter than 16 bytes');
  const cipher = createCipheriv('aes-128-cbc', key, key);
  const data = Buffer.concat([cipher.update(String(plain), 'utf-8'), cipher.final()]);
  return data.toString('base64');
}

function decodeJwt(token) {
  if (typeof token !== 'string' || token.split('.').length !== 3) return null;
  try {
    return JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString('utf-8'));
  } catch {
    return null;
  }
}

function normalizeEpoch(value) {
  if (value === undefined || value === null || value === '') return 0;
  if (typeof value === 'string' && !/^\d+(?:\.\d+)?$/.test(value.trim())) {
    const t = Date.parse(value);
    return Number.isFinite(t) ? Math.floor(t / 1000) : 0;
  }
  let n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return 0;
  if (n > 1e12) n = Math.floor(n / 1000);
  return Math.floor(n);
}

function tokenExpiry(token) {
  const claims = decodeJwt(token);
  return normalizeEpoch(claims?.exp);
}

function credentialToken(cred) {
  const t = cred?.token;
  if (typeof t === 'string') return t.trim();
  if (isObject(t)) return String(t.accessToken || t.access_token || t.token || '').trim();
  return String(cred?.accessToken || cred?.access_token || '').trim();
}

function credentialRefresh(cred) {
  return String(cred?.refreshToken || cred?.refresh_token || cred?.token?.refreshToken || cred?.token?.refresh_token || '').trim();
}

function credentialExpiry(cred, token) {
  return normalizeEpoch(cred?.token?.expiresAt ?? cred?.expiresAt ?? cred?.expires_at ?? cred?.token?.expires_at) || tokenExpiry(token);
}

function credentialUser(cred) {
  const nested = isObject(cred?.user) ? cred.user
    : isObject(cred?.account) ? cred.account
      : isObject(cred?.profile) ? cred.profile
        : null;
  if (nested && Object.keys(nested).length) return nested;
  // legacy ~/.auth/user 把 uid / nickname / email 放在顶层
  return {
    id: cred?.uid || cred?.id,
    name: cred?.nickname || cred?.name,
    email: cred?.email,
    avatar_url: cred?.avatar_url,
  };
}

function accountIdentity(cred, token) {
  const user = credentialUser(cred);
  const claims = decodeJwt(token) || {};
  const id = String(user.id || user.uid || user.user_id || user.userId || cred?.uid || cred?.userId || claims.sub || claims.user_id || '').trim();
  if (id) return `qoder:${id}`;
  const email = String(user.email || cred?.email || claims.email || '').trim().toLowerCase();
  if (email) return `qoder:${email}`;
  // 没有用户信息时不能用「服务名 + 槽位」：切换账号会覆盖同一槽位里的旧档。
  // refreshToken 在 token 刷新时可能轮换，但不会把一个账号判成另一个账号；
  // 只有完全无 refreshToken 时才退回 accessToken。
  const secret = credentialRefresh(cred) || token;
  return `qoder-token:${createHash('sha256').update(String(secret)).digest('hex').slice(0, 12)}`;
}

function accountDisplay(cred, identity) {
  const user = credentialUser(cred);
  const claims = decodeJwt(credentialToken(cred)) || {};
  const email = String(user.email || cred?.email || claims.email || '').trim();
  const name = String(user.name || user.nickname || user.displayName || user.username || cred?.nickname || cred?.name || claims.name || claims.nickname || '').trim();
  if (name && email && name !== email) return `${name} (${email})`;
  return name || email || identity;
}

/**
 * 读取一个 HOME 下某区域的 Qoder 凭据。
 * 返回文件中所有可用 token（同一账号可能按 server 保存多份），并选出有效期最长的主凭据。
 */
export async function readQoderCredential(home, worker = 'qoder') {
  return readQoderCredentialAt(qoderConfigDir(home, worker), worker);
}

/** 从指定配置目录读取（账号档案是扁平存放的，同样适用） */
export async function readQoderCredentialAt(dir, worker = 'qoder') {
  const region = qoderRegion(worker);
  const cfg = region.configDir;
  const isLive = String(dir).replace(/[\\/]+$/, '').endsWith(cfg);
  const entries = [];
  const push = (cred, meta) => {
    if (!isObject(cred)) return;
    const token = credentialToken(cred);
    if (!token) return;
    entries.push({
      token,
      refreshToken: credentialRefresh(cred),
      expiresAt: credentialExpiry(cred, token),
      identity: accountIdentity(cred, token),
      display: accountDisplay(cred, meta.service && meta.account ? `${meta.service}:${meta.account}` : 'qoder'),
      service: String(meta.service || ''),
      account: String(meta.account || ''),
      user: credentialUser(cred),
      tokenType: String(cred?.token?.tokenType || cred?.tokenType || 'Bearer'),
      file: meta.file,
      saltFile: meta.saltFile,
      source: meta.source,
      format: meta.format,
    });
  };

  // 1) CLI 1.1.74 主登录态：<config>/.auth/user（档案里是扁平的 user + machine_id）
  for (const candidate of [
    { userFile: join(dir, '.auth', 'user'), midFile: join(dir, '.auth', 'machine_id'), source: isLive ? `~/${cfg}/.auth/user` : '账号档案 · Qoder' },
    { userFile: join(dir, 'user'), midFile: join(dir, 'machine_id'), source: '账号档案 · Qoder' },
  ]) {
    let cipher;
    try {
      cipher = await readFile(candidate.userFile, 'utf-8');
    } catch {
      continue;
    }
    let mid;
    try {
      mid = (await readFile(candidate.midFile, 'utf-8')).trim();
    } catch {
      return { ok: false, reason: 'missing_salt', file: candidate.userFile, saltFile: candidate.midFile, entries: [], primary: null, error: '缺少 machine_id，无法解密 Qoder 登录态' };
    }
    let data;
    try {
      data = decryptLegacyQoderUser(cipher, mid);
    } catch (e) {
      return { ok: false, reason: 'decrypt_failed', file: candidate.userFile, saltFile: candidate.midFile, entries: [], primary: null, error: e?.message || String(e) };
    }
    push(data, { file: candidate.userFile, saltFile: candidate.midFile, source: candidate.source, format: 'legacy' });
    if (!entries.length) {
      return { ok: false, reason: 'no_token', file: candidate.userFile, saltFile: candidate.midFile, entries: [], primary: null, error: '登录态文件中没有可用 token' };
    }
    entries.sort((a, b) => b.expiresAt - a.expiresAt);
    return { ok: true, file: candidate.userFile, saltFile: candidate.midFile, entries, primary: entries[0], region };
  }

  // 2) 无系统钥匙串时的文件回退：qoder-cli-credentials.json + .keychain-salt
  const credFile = join(dir, 'qoder-cli-credentials.json');
  const saltFile = join(dir, '.keychain-salt');
  let cipher;
  let salt;
  try {
    cipher = (await readFile(credFile, 'utf-8')).trim();
  } catch {
    return { ok: false, reason: 'not_logged_in', file: credFile, saltFile, entries: [], primary: null };
  }
  try {
    salt = await readFile(saltFile);
  } catch {
    return { ok: false, reason: 'missing_salt', file: credFile, saltFile, entries: [], primary: null, error: '缺少 .keychain-salt，无法解密 Qoder 凭据' };
  }
  let data;
  try {
    data = decryptQoderCredential(cipher, salt);
  } catch (e) {
    return { ok: false, reason: 'decrypt_failed', file: credFile, saltFile, entries: [], primary: null, error: e?.message || String(e) };
  }

  const source = isLive ? `~/${cfg}/qoder-cli-credentials.json` : '账号档案 · Qoder';
  if (isObject(data)) {
    for (const [key, value] of Object.entries(data)) {
      let cred = value;
      if (typeof cred === 'string') {
        try { cred = JSON.parse(cred); } catch { continue; }
      }
      if (!isObject(cred)) continue;
      if (credentialToken(cred)) {
        push(cred, { service: '', account: key, file: credFile, saltFile, source, format: 'keychain' });
        continue;
      }
      for (const [account, raw] of Object.entries(cred)) {
        let inner = raw;
        if (typeof inner === 'string') {
          try { inner = JSON.parse(inner); } catch { continue; }
        }
        push(inner, { service: key, account, file: credFile, saltFile, source, format: 'keychain' });
      }
    }
  }

  if (!entries.length) {
    return { ok: false, reason: 'no_token', file: credFile, saltFile, entries: [], primary: null, error: '凭据文件中没有可用 token' };
  }
  entries.sort((a, b) => b.expiresAt - a.expiresAt);
  return { ok: true, file: credFile, saltFile, entries, primary: entries[0], region };
}

export function isQoderTokenExpired(entry, skewSec = 300) {
  const exp = Number(entry?.expiresAt || 0);
  return exp > 0 && Date.now() / 1000 + skewSec >= exp;
}

/**
 * 活动平台请求头。
 *
 * 设备头必须来自本机 UMID 组件（见 qoder-device.mjs）：国际版每日 100 Credits
 * 这类定向活动只会下发给带 Cosy-MachineToken / MachineCode / MachineType 的请求。
 * 没有 device 时退化成只带 clienttype/version 的裸请求——它只能看到公开活动，
 * 定向活动会整行消失，所以签到链路一定要传 device。
 */
export function qoderHeaders(worker, token, device = null) {
  const region = qoderRegion(worker);
  const headers = {
    Authorization: `Bearer ${token}`,
    Accept: 'application/json',
    'User-Agent': 'Qoder',
    'cosy-clienttype': '10',
    'cosy-version': device?.clientVersion || QODER_DESKTOP_VERSION,
    Origin: region.website,
    Referer: `${region.website}/`,
  };
  if (!device) return headers;
  headers['Cosy-Version'] = device.clientVersion || QODER_DESKTOP_VERSION;
  if (device.machineOs) headers['Cosy-MachineOS'] = device.machineOs;
  if (device.machineId) headers['Cosy-MachineId'] = device.machineId;
  if (device.machineHostname) headers['Cosy-MachineHostname'] = device.machineHostname;
  if (device.risk?.machineToken) {
    headers['Cosy-MachineToken'] = device.risk.machineToken;
    headers['Cosy-MachineCode'] = device.risk.machineCode;
    headers['Cosy-MachineType'] = device.risk.machineType;
  }
  return headers;
}

async function qoderRequest(worker, token, path, options = {}) {
  const region = qoderRegion(worker);
  // baseUrlOverride：国际版活动没下发时，用同一个 token 再打一次另一套环境
  // （开源项目 qoder-checkin 的 baseUrls 就是让在 openapi.qoder.sh / openapi.qoder.com.cn 之间切）
  const base = options.baseUrl || region.openapi;
  const res = await fetchJsonSmart(`${base}${path}`, {
    method: options.method || 'GET',
    headers: { ...qoderHeaders(worker, token, options.device), ...(options.body ? { 'Content-Type': 'application/json' } : {}) },
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
  return res;
}

/** forceRefresh=true 是上游要求：不带它会吃到活动缓存，刚开启的活动看不到 */
export async function listQoderCampaigns(worker, token, device = null, baseUrl = '') {
  return qoderRequest(worker, token, '/sash/api/v1/me/campaigns?forceRefresh=true', { device, baseUrl });
}

/** 另一套环境的 openapi（国际 ⇄ 国内），用于活动列表为空时换环境重试 */
export function altQoderBaseUrl(worker) {
  return worker === 'qoder' ? 'https://openapi.qoder.com.cn' : 'https://openapi.qoder.sh';
}

export async function claimQoderCampaign(worker, token, campaignId, device = null, baseUrl = '') {
  return qoderRequest(worker, token, `/sash/api/v1/me/campaigns/${encodeURIComponent(campaignId)}/claim`, { method: 'POST', body: {}, device, baseUrl });
}

/** 刷新 dt-/jt- 配套 refresh token；返回新 token 或 null */
export async function refreshQoderToken(worker, refreshToken) {
  const rt = String(refreshToken || '').trim();
  if (!rt) return null;
  const path = rt.startsWith('jrt-') ? '/api/v1/jobToken/refresh' : '/api/v1/deviceToken/refresh';
  try {
    // 刷新端点只认 refresh_token body，不校验 Bearer；不要带活动平台头
    const res = await fetchJsonSmart(`${qoderRegion(worker).openapi}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json', 'User-Agent': 'Go-http-client/2.0' },
      body: JSON.stringify({ refresh_token: rt }),
    });
    const data = res.json;
    if (!res.ok || !data) return null;
    const body = isObject(data.data) ? data.data : data;
    const token = String(body?.token || body?.device_token || body?.job_token || body?.access_token || '').trim();
    if (!token) return null;
    return {
      token,
      refreshToken: String(body?.refresh_token || body?.refreshToken || rt).trim(),
      expiresIn: Number(body?.expires_in || body?.expiresIn || 0) || 0,
    };
  } catch {
    return null;
  }
}

function encryptQoderCredential(plain, salt) {
  const key = scryptSync('qoder-cli-credentials', salt, 32);
  const iv = randomBytes(16);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const data = Buffer.concat([cipher.update(String(plain), 'utf-8'), cipher.final()]);
  return `${iv.toString('hex')}:${cipher.getAuthTag().toString('hex')}:${data.toString('hex')}`;
}

/**
 * 把刷新后的 token 写回 CLI 的加密凭据文件。
 * 必须整份重新加密（GCM 的 IV 每次都新生成），签名/权限与 CLI 自己写入保持一致。
 */
export async function persistQoderToken({ credFile, saltFile, identity, token, refreshToken = '', expiresAt = 0 }) {
  if (!credFile || !saltFile || !token) return false;
  // CLI 主登录态 ~/.qoder/.auth/user：AES-128-CBC + machine_id
  if (basename(credFile) === 'user' || String(credFile).replace(/\\/g, '/').endsWith('/.auth/user')) {
    try {
      const mid = (await readFile(saltFile, 'utf-8')).trim();
      const cred = decryptLegacyQoderUser(await readFile(credFile, 'utf-8'), mid);
      const currentIdentity = accountIdentity(cred, credentialToken(cred));
      if (identity && currentIdentity !== identity) return false;
      cred.token = token;
      if (refreshToken) cred.refreshToken = refreshToken;
      if (expiresAt) cred.expiresAt = new Date(Number(expiresAt) * 1000).toISOString();
      cred.updatedAt = new Date().toISOString();
      await mkdir(dirname(credFile), { recursive: true });
      await writeFile(credFile, encryptLegacyQoderUser(JSON.stringify(cred, null, 2), mid), { mode: 0o600 });
      return true;
    } catch {
      return false;
    }
  }
  let salt;
  let data;
  try {
    salt = await readFile(saltFile);
    data = decryptQoderCredential(await readFile(credFile, 'utf-8'), salt);
  } catch {
    return false;
  }
  if (!isObject(data)) return false;
  let changed = false;
  const patch = (cred) => {
    if (!isObject(cred)) return;
    const currentToken = credentialToken(cred);
    const currentIdentity = accountIdentity(cred, currentToken);
    if (identity && currentIdentity !== identity) return;
    if (isObject(cred.token)) {
      cred.token.accessToken = token;
      if (refreshToken) cred.token.refreshToken = refreshToken;
      if (expiresAt) cred.token.expiresAt = Number(expiresAt) * 1000;
    } else if (typeof cred.token === 'string') {
      cred.token = token;
      if (expiresAt) cred.expiresAt = Number(expiresAt) * 1000;
    } else {
      cred.accessToken = token;
      if (expiresAt) cred.expiresAt = Number(expiresAt) * 1000;
    }
    if (refreshToken) cred.refreshToken = refreshToken;
    cred.updatedAt = Date.now();
    changed = true;
  };
  for (const [key, value] of Object.entries(data)) {
    let cred = value;
    if (typeof cred === 'string') {
      try { cred = JSON.parse(cred); } catch { continue; }
    }
    if (!isObject(cred)) continue;
    if (credentialToken(cred)) {
      patch(cred);
      if (typeof value === 'string') data[key] = JSON.stringify(cred);
      continue;
    }
    for (const [account, raw] of Object.entries(cred)) {
      let inner = raw;
      if (typeof inner === 'string') {
        try { inner = JSON.parse(inner); } catch { continue; }
      }
      patch(inner);
      if (typeof raw === 'string' && isObject(inner)) cred[account] = JSON.stringify(inner);
    }
  }
  if (!changed) return false;
  try {
    await mkdir(dirname(credFile), { recursive: true });
    await writeFile(credFile, encryptQoderCredential(JSON.stringify(data, null, 2), salt), { mode: 0o600 });
    return true;
  } catch {
    return false;
  }
}
