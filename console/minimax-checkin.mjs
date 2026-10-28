// @ts-check
// MiniMax Code（海螺 AI / mcode）每日签到。
//
// 签到链路移植自 SkillHub 的 `@user_3a370331/totorosir-minimax-checkin`
// （作者：龙猫科技说 longmaoit，https://skillhub.cn/skills/user_3a370331/totorosir-minimax-checkin）。
// 实现为原生 JS、零第三方依赖：签名算法、参数键序、接口路径与桌面端 3.1.x 一致。
//
// 三步：查面板（GET signin/status）→ 可领取则领（POST signin/claim）→ 401 用 refresh_token 续期重试。
// 凭据直接复用 mcode CLI 自己的登录态，不另存副本：
//   ~/.minimax/auth/prod/<region>/mcode-public/auth.json
//     records["com.minimax.mcode.oauth.prod.cn <hash>"] = { accessToken, refreshToken, expiresAtMs }
//   ~/.minimax/auth/prod/<region>/mcode-public/auth-state.json
//     { status: "authenticated", region: "cn", expiresAtMs }

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { createHash, randomUUID, randomInt } from 'node:crypto';
import { homedir } from 'node:os';
import { join, dirname, resolve } from 'node:path';

// AGENTHUB_HOME 仅用于测试：把「mcode 凭据目录」指到临时目录，绝不碰真实登录态
const HOME = process.env.AGENTHUB_HOME ? resolve(process.env.AGENTHUB_HOME) : homedir();
const STORE_FILE = join(HOME, '.agenthub', 'minimax-checkin.json');

/** 区域表：国内版 auth 目录是 cn，国际版是 en（实测，不是 global） */
export const MINIMAX_REGIONS = {
  cn: { key: 'cn', name: 'MiniMax Code（国内版）', host: 'https://agent.minimax.cn', account: 'https://account.minimax.cn', authDir: 'cn' },
  global: { key: 'global', name: 'MiniMax Code（国际版）', host: 'https://agent.minimax.io', account: 'https://account.minimax.io', authDir: 'en' },
};

const SIGN_SALT = 'I*7Cf%WZ#S&%1RlZJ&C2';
const SIGN_SUFFIX = 'ooui';
const CLIENT_ID = 'mcode-public';
const OAUTH_SCOPE = 'agent.default';
const OAUTH_AUDIENCE = 'agent-backend';

const APP_ID = '3001';
const BIZ_ID = '3';
const VERSION_CODE = '22201';
const DEFAULT_APP_VERSION = '3.1.0';

const API_STATUS = '/minimax-cloud/api/v1/signin/status';
const API_CONFIG = '/minimax-cloud/api/v1/signin/config';
const API_CLAIM = '/minimax-cloud/api/v1/signin/claim';

/** 签到日状态：1=未开始 2=可领取 3=已领取 4=不可用 */
const DAY = { UPCOMING: 1, CLAIMABLE: 2, CLAIMED: 3, DISABLED: 4 };
const DAY_TEXT = { 1: '未开始', 2: '可领取', 3: '已领取', 4: '不可用' };
const CLAIM_RESULT_TEXT = { 1: '领取成功', 2: '今日已领取' };

const md5 = (text) => createHash('md5').update(String(text), 'utf-8').digest('hex');

/** 签名路径要按 JS 的 encodeURIComponent 规则编码（不编码 !~*'()，与桌面端一致） */
function encodeUriComponent(text) {
  return encodeURIComponent(String(text));
}

async function readJsonSafe(path) {
  try {
    return JSON.parse((await readFile(path, 'utf-8')).replace(/^\uFEFF/, ''));
  } catch {
    return null;
  }
}

async function readStore() {
  return (await readJsonSafe(STORE_FILE)) || {};
}

async function writeStore(data) {
  try {
    await mkdir(dirname(STORE_FILE), { recursive: true });
    await writeFile(STORE_FILE, JSON.stringify(data, null, 2) + '\n', { mode: 0o600 });
  } catch { /* 缓存写不进去不影响签到 */ }
}

/** 某区域下 mcode 的凭据目录（auth 目录名按区域不同：cn / en） */
export function minimaxAuthDir(baseHome, region) {
  const cfg = MINIMAX_REGIONS[region] || MINIMAX_REGIONS.cn;
  return join(baseHome, '.minimax', 'auth', 'prod', cfg.authDir, 'mcode-public');
}

/**
 * 读 mcode 的 OAuth 凭据（records 里可能有多条，取 expiresAtMs 最晚的一条）。
 * @returns {Promise<{token:string, refreshToken:string, expiresAtMs:number, region:string, status:string, file:string, source:string}|null>}
 */
export async function readMinimaxCredential(baseHome = HOME, region = 'cn') {
  const cfg = MINIMAX_REGIONS[region] || MINIMAX_REGIONS.cn;
  const dir = minimaxAuthDir(baseHome, region);
  const file = join(dir, 'auth.json');
  const data = await readJsonSafe(file);
  const records = data?.records;
  if (!records || typeof records !== 'object') return null;
  let best = null;
  for (const value of Object.values(records)) {
    if (!value || typeof value !== 'object') continue;
    const token = String(value.accessToken || '').trim();
    if (!token) continue;
    const exp = Number(value.expiresAtMs) || 0;
    if (!best || exp > best.expiresAtMs) {
      best = {
        token,
        refreshToken: String(value.refreshToken || '').trim(),
        expiresAtMs: exp,
        clientId: String(value.clientId || CLIENT_ID),
      };
    }
  }
  if (!best) return null;
  const state = await readJsonSafe(join(dir, 'auth-state.json'));
  return {
    ...best,
    region: String(state?.region || cfg.key),
    status: String(state?.status || '').toLowerCase(),
    file,
    source: `~/.minimax/auth/prod/${cfg.authDir}/mcode-public/auth.json`,
  };
}

/** 把续期后的新凭据回写 mcode 的登录态，保证 CLI 与签到两边同步 */
async function writeBackCredential(file, credentials) {
  if (!file || !credentials?.token) return;
  const data = await readJsonSafe(file);
  const records = data?.records;
  if (!records || typeof records !== 'object') return;
  for (const record of Object.values(records)) {
    if (!record || typeof record !== 'object' || !record.accessToken) continue;
    record.accessToken = credentials.token;
    if (credentials.refreshToken) record.refreshToken = credentials.refreshToken;
    if (credentials.expiresAtMs) record.expiresAtMs = Number(credentials.expiresAtMs);
    record.generation = Number(record.generation || 0) + 1;
    try {
      await writeFile(file, JSON.stringify(data, null, 2) + '\n', { mode: 0o600 });
      const stateFile = join(dirname(file), 'auth-state.json');
      const state = await readJsonSafe(stateFile);
      if (state) {
        if (credentials.expiresAtMs) state.expiresAtMs = Number(credentials.expiresAtMs);
        state.generation = Number(state.generation || 0) + 1;
        await writeFile(stateFile, JSON.stringify(state, null, 2) + '\n', { mode: 0o600 });
      }
    } catch { /* 回写失败不影响本次签到 */ }
    return;
  }
}

/** OAuth 续期：POST {account}/oauth2/token（refresh_token 模式） */
async function oauthRefresh(region, refreshToken) {
  if (!refreshToken) return null;
  const cfg = MINIMAX_REGIONS[region] || MINIMAX_REGIONS.cn;
  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
    client_id: CLIENT_ID,
    scope: OAUTH_SCOPE,
    audience: OAUTH_AUDIENCE,
  });
  try {
    const res = await fetch(`${cfg.account}/oauth2/token`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Accept: 'application/json',
        'User-Agent': 'MiniMaxAgent/3.1.0',
      },
      body,
      signal: AbortSignal.timeout(20_000),
    });
    const json = await res.json().catch(() => null);
    if (!json?.access_token) return null;
    const ttl = Number(json.expires_in) || 3600;
    return {
      token: json.access_token,
      refreshToken: json.refresh_token || refreshToken,
      expiresAtMs: Date.now() + ttl * 1000,
    };
  } catch {
    return null;
  }
}

/** 本机身份（uuid / user_id / 客户端版本）；服务器上没有桌面端，退回稳定落盘值 */
async function resolveIdentity(store) {
  const ident = { ...(store.identity || {}) };
  if (!ident.uuid) ident.uuid = randomUUID();
  if (!ident.user_id) ident.user_id = '0';
  if (!ident.app_version) ident.app_version = DEFAULT_APP_VERSION;
  if (!ident.device_id) ident.device_id = String(randomInt(10_000_000, 99_999_999));
  return ident;
}

/** 按桌面端 mC() 的键序构造参数（op_ticket / token 也参与签名） */
function buildParams(ms, ident) {
  const offset = -new Date().getTimezoneOffset() * 60;
  const osName = process.platform === 'win32' ? 'Windows' : (process.platform === 'darwin' ? 'macOS' : 'Linux');
  return [
    ['device_platform', 'web'],
    ['biz_id', BIZ_ID],
    ['app_id', APP_ID],
    ['version_code', VERSION_CODE],
    ['unix', String(ms)],
    ['timezone_offset', String(offset)],
    ['is_desktop', '1'],
    ['desktop_version', String(ident.app_version)],
    ['sys_language', 'zh'],
    ['lang', 'zh'],
    ['uuid', String(ident.uuid)],
    ['device_id', String(ident.device_id)],
    ['os_name', osName],
    ['browser_name', 'Chrome'],
    ['device_memory', '32'],
    ['cpu_core_num', '20'],
    ['browser_language', 'zh-CN'],
    ['browser_platform', process.platform === 'win32' ? 'Win32' : 'Linux x86_64'],
    ['user_id', String(ident.user_id)],
    ['op_ticket', 'undefined'],
    ['screen_width', '1746'],
    ['screen_height', '982'],
    ['token', 'null'],
  ];
}

function buildHeaders(region, path, bodyStr, params, ms, token) {
  const cfg = MINIMAX_REGIONS[region] || MINIMAX_REGIONS.cn;
  const signedPath = `${path}?${params.map(([k, v]) => `${k}=${v}`).join('&')}&client=desktop`;
  const sec = Math.floor(ms / 1000);
  return {
    'User-Agent': 'MiniMaxAgent Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 '
      + '(KHTML, like Gecko) MiniMax/3.1.0 Chrome/148.0.7778.280 Safari/537.36',
    Origin: cfg.host,
    Referer: `${cfg.host}/`,
    Accept: 'application/json, text/plain, */*',
    'Content-Type': 'application/json',
    'Accept-Language': 'zh-CN,zh;q=0.9',
    Authorization: `Bearer ${token}`,
    yy: md5(`${encodeUriComponent(signedPath)}_${bodyStr || '{}'}${md5(String(ms))}${SIGN_SUFFIX}`),
    'x-timestamp': String(sec),
    'x-signature': md5(`${sec}${SIGN_SALT}${bodyStr}`),
  };
}

/** 调 MiniMax Code 后端接口，返回 { status, json, text } */
async function apiCall(region, token, ident, path, method = 'GET') {
  const cfg = MINIMAX_REGIONS[region] || MINIMAX_REGIONS.cn;
  let ms = Date.now();
  ms -= ms % 1000; // 桌面端把 unix 对齐到整秒
  const params = buildParams(ms, ident);
  const bodyStr = method === 'GET' ? '' : '{}';
  const query = `${params.map(([k, v]) => `${k}=${v}`).join('&')}&client=desktop`;
  const url = `${cfg.host}${path}?${query}`;
  try {
    const res = await fetch(url, {
      method,
      headers: buildHeaders(region, path, bodyStr, params, ms, token),
      body: method === 'GET' ? undefined : bodyStr,
      signal: AbortSignal.timeout(25_000),
    });
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch { json = null; }
    return { status: res.status, json, text };
  } catch (err) {
    return { status: -1, json: null, text: `${err.name}: ${err.message}` };
  }
}

function todayPanel(panel) {
  for (const day of panel?.days || []) {
    if (day?.is_today) return day;
  }
  return null;
}

/** 401 自愈：用 refresh_token 续期后重试一次 */
async function recover401(region, ident, cred) {
  const refreshed = await oauthRefresh(region, cred?.refreshToken);
  if (!refreshed) return null;
  await writeBackCredential(cred.file, refreshed);
  const res = await apiCall(region, refreshed.token, ident, API_STATUS);
  if (res.status !== 200) return null;
  return { ...cred, ...refreshed, panel: res.json?.data || {}, refreshed: true };
}

/**
 * 执行一次签到。
 * @param {'cn'|'global'} region
 * @param {string|{token:string, refreshToken?:string, expiresAtMs?:number, file?:string, source?:string}} [override]
 *        手工配置的 accessToken（CLI 未登录时的兜底），或一份账号档案凭据（多账号签到用）
 */
export async function checkinMiniMax(region = 'cn', override = '') {
  const cfg = MINIMAX_REGIONS[region] || MINIMAX_REGIONS.cn;
  const store = await readStore();
  const ident = await resolveIdentity(store);
  store.identity = { uuid: ident.uuid, user_id: ident.user_id, app_version: ident.app_version, device_id: ident.device_id };
  await writeStore(store);

  // override 既可能是「手工粘贴的 token 字符串」，也可能是账号档案里的一整份凭据对象。
  // 后者带上 refreshToken，401 时仍能自愈，所以多账号签到时优先走这条。
  const credObj = override && typeof override === 'object' ? override : null;
  const manual = credObj ? '' : String(override || '').trim();
  let cred = credObj && credObj.token
    ? {
      token: String(credObj.token),
      refreshToken: String(credObj.refreshToken || ''),
      expiresAtMs: Number(credObj.expiresAtMs) || 0,
      file: String(credObj.file || ''),
      source: String(credObj.source || '账号档案快照'),
      region: cfg.key,
    }
    : await readMinimaxCredential(HOME, cfg.key);
  if (manual) {
    cred = { token: manual, refreshToken: '', expiresAtMs: 0, file: '', source: '自定义 Token（mcode 未登录）', region: cfg.key };
  }
  if (!cred) {
    return {
      ok: false,
      status: 'unconfigured',
      message: `未检测到 ${cfg.name} 登录态，请先在控制台点「登录」完成 mcode 设备码授权。`,
      credits: 0,
      consecutiveDays: 0,
      region: cfg.key,
      source: '',
    };
  }

  let res = await apiCall(cfg.key, cred.token, ident, API_STATUS);
  if (res.status === 401) {
    const healed = await recover401(cfg.key, ident, cred);
    if (!healed) {
      return {
        ok: false,
        status: 'expired',
        message: 'MiniMax 登录态已失效（HTTP 401），refresh_token 也续不动了，请在控制台重新登录。',
        credits: 0,
        consecutiveDays: 0,
        region: cfg.key,
        source: cred.source,
      };
    }
    cred = healed;
    res = { status: 200, json: { data: healed.panel }, text: '' };
  }
  if (res.status !== 200) {
    const hint = res.status === 429 ? '请求过于频繁（HTTP 429），请稍后重试' : `接口返回 HTTP ${res.status}：${String(res.text || '').slice(0, 160)}`;
    return { ok: false, status: 'failed', message: hint, credits: 0, consecutiveDays: 0, region: cfg.key, source: cred.source };
  }

  const panel = res.json?.data || {};
  const today = todayPanel(panel) || {};
  const dayNo = Number(today.day_no) || 0;
  const dayStatus = Number(today.status) || 0;
  const basePoints = Number(today.points) || 0;
  const bonusPoints = Number(today.bonus_points) || 0;
  const sourceNote = cred.refreshed ? `${cred.source}（已自动续期）` : cred.source;

  if (dayStatus === DAY.CLAIMED) {
    return {
      ok: true,
      status: 'already',
      message: `今日已领取（连续签到第 ${dayNo} 天）${basePoints + bonusPoints ? `，今日 ${basePoints} 基础 + ${bonusPoints} 奖励` : ''}`,
      credits: 0,
      consecutiveDays: dayNo,
      region: cfg.key,
      source: sourceNote,
    };
  }
  if (dayStatus === DAY.DISABLED) {
    return { ok: false, status: 'failed', message: '今日签到入口未开放（上游 status=4）', credits: 0, consecutiveDays: dayNo, region: cfg.key, source: sourceNote };
  }
  if (dayStatus === DAY.UPCOMING) {
    return { ok: true, status: 'already', message: '今日签到尚未开始（上游 status=1），稍后再试', credits: 0, consecutiveDays: dayNo, region: cfg.key, source: sourceNote };
  }

  // 可领取 → 领
  let claim = await apiCall(cfg.key, cred.token, ident, API_CLAIM, 'POST');
  if (claim.status === 401) {
    const healed = await recover401(cfg.key, ident, cred);
    if (healed) {
      cred = healed;
      claim = await apiCall(cfg.key, cred.token, ident, API_CLAIM, 'POST');
    }
  }
  if (claim.status !== 200) {
    return {
      ok: false,
      status: 'failed',
      message: `领取失败（HTTP ${claim.status}）：${String(claim.text || '').slice(0, 160)}`,
      credits: 0,
      consecutiveDays: dayNo,
      region: cfg.key,
      source: sourceNote,
    };
  }

  const data = claim.json?.data || {};
  const claimResult = Number(data.claim_result);
  const gotPoints = Number(data.points ?? basePoints) || 0;
  const gotBonus = Number(data.bonus_points ?? bonusPoints) || 0;
  const total = gotPoints + gotBonus;
  const claimedDay = Number(data.day_no) || dayNo;
  const already = claimResult === 2;
  return {
    ok: true,
    status: already ? 'already' : 'success',
    message: already
      ? `今日已领取（连续签到第 ${claimedDay} 天）`
      : `领取成功：连续签到第 ${claimedDay} 天，+${total} 积分${gotBonus ? `（含奖励 ${gotBonus}）` : ''}`,
    credits: already ? 0 : total,
    consecutiveDays: claimedDay,
    region: cfg.key,
    source: sourceNote,
  };
}

/**
 * 只查不领（供配额/概览展示用）：返回今日状态与积分。
 */
export async function fetchMiniMaxSignin(region = 'cn') {
  const cfg = MINIMAX_REGIONS[region] || MINIMAX_REGIONS.cn;
  const store = await readStore();
  const ident = await resolveIdentity(store);
  const cred = await readMinimaxCredential(HOME, cfg.key);
  if (!cred) return null;
  let res = await apiCall(cfg.key, cred.token, ident, API_STATUS);
  if (res.status === 401) {
    const healed = await recover401(cfg.key, ident, cred);
    if (!healed) return { status: 401, panel: null, source: cred.source };
    res = { status: 200, json: { data: healed.panel } };
  }
  if (res.status !== 200) return { status: res.status, panel: null, source: cred.source };
  const panel = res.json?.data || {};
  const today = todayPanel(panel) || {};
  return {
    status: 200,
    source: cred.source,
    panel,
    today: {
      dayNo: Number(today.day_no) || 0,
      dayStatus: Number(today.status) || 0,
      dayText: DAY_TEXT[Number(today.status)] || '未知',
      points: Number(today.points) || 0,
      bonusPoints: Number(today.bonus_points) || 0,
    },
  };
}

export { DAY_TEXT, CLAIM_RESULT_TEXT };
