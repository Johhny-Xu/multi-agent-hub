// @ts-check
// Multi-Agent Hub 平台每日签到与福利中枢
// 支持 WorkBuddy、Trae (免客户端直签)、CodeArts (华为云码道) 自动化打卡与多账号福利领取
// 接口参考开源逆向成果与无客户端实现

import { readFile, writeFile, mkdir, readdir } from 'node:fs/promises';
import { homedir, hostname } from 'node:os';
import { join, dirname } from 'node:path';
import { randomUUID, createHash, createHmac } from 'node:crypto';
import { fetchJsonSmart } from './vendor-quota.mjs';
import { findCodeBuddySharedAuth } from './accounts.mjs';

const HOME = homedir();
const STATE_FILE = join(HOME, '.agenthub', 'checkin-state.json');

/** 开源项目参考索引 */
export const OPEN_SOURCE_PROJECTS = {
  workbuddy: [
    {
      name: '88lin/workbuddy-auto-signin',
      url: 'https://github.com/88lin/workbuddy-auto-signin',
      description: '腾讯 WorkBuddy / CodeBuddy 自动签到脚本，纯 Python 标准库零依赖，自动探测本地凭据，覆盖每日加油站打卡、开盲盒、领任务、连登奖励与断登补签。',
      tags: ['Python', '零依赖', '加油站积分', '断登补签']
    },
    {
      name: 'yu-echo/workbuddy_checkin',
      url: 'https://github.com/yu-echo/workbuddy_checkin',
      description: '基于 GitHub Actions 的云端自动签到脚本，支持通过本地凭据提取 Refresh Token，支持微信 PushPlus 每日打卡推送。',
      tags: ['GitHub Actions', '云端定时', '微信推送']
    },
    {
      name: 'Coco-katarina/workbuddy-checkin',
      url: 'https://github.com/Coco-katarina/workbuddy-checkin',
      description: '本地自动化任务流与 AI Skill 触发，通过本地安全会话读取实现零上传打卡。',
      tags: ['Skill', '本地凭据', '安全隔离']
    }
  ],
  traecode: [
    {
      name: 'star620/TraeTools',
      url: 'https://github.com/star620/TraeTools',
      description: '针对 Trae Work 的多功能助手工具，集成多账号每日签到、Vault 登录态冷切换备份、用量统计，支持一键部署到 GitHub Actions 实现无客户端云端定时签到。',
      tags: ['多账号', '免客户端', 'GitHub Actions', '用量统计']
    },
    {
      name: 'bluechonk/trae-daily-checkin',
      url: 'https://github.com/bluechonk/trae-daily-checkin',
      description: 'TraeWork CN 每日签到自动化工具，深度解析 api.trae.cn 接口，结合轻量调用完成免客户端自动化打卡。',
      tags: ['免客户端', 'API直签', '轻量化']
    },
    {
      name: 'bluechonk/trae-credential-reverse-engineering',
      url: 'https://github.com/bluechonk/trae-credential-reverse-engineering',
      description: 'Trae 桌面端本地凭据存储结构、Token 刷新与请求签名协议逆向工程文档。',
      tags: ['逆向文档', '协议分析', 'ECDSA']
    }
  ],
  codearts: [
    {
      name: '2951461586/CodeArts2API',
      url: 'https://github.com/2951461586/CodeArts2API',
      description: '华为云码道 (CodeArts Agent) 上游网关，内置每日自动签到与福利 Token 领取逻辑 (/api/v1/benefit/claim)，支持多账号去重与定时轮询。',
      tags: ['Go', 'CodeArts码道', '福利Token', '自动领取']
    },
    {
      name: 'codearts-daily-claim',
      url: 'https://gitcode.com/gh_mirrors/co/codearts-daily-claim',
      description: '基于华为云 CodeArts 及开发者成长中心接口的每日积分与福利自动领取脚本，支持 AK/SK 与凭据注入。',
      tags: ['Python', '成长中心', 'AK/SK签名', '开发者空间']
    },
    {
      name: 'HotWater23/develope',
      url: 'https://github.com/HotWater23/develope',
      description: '华为云开发者成长中心扩展与自动化方案，支持自动检测任务与完成签到。',
      tags: ['Node.js', '开发者空间', '任务打卡']
    }
  ]
};

/** @returns {Promise<object>} */
async function loadState() {
  try {
    const raw = await readFile(STATE_FILE, 'utf-8');
    return JSON.parse(raw.replace(/^\uFEFF/, ''));
  } catch {
    return {
      autoCheckin: true,
      autoCheckinTime: '08:30',
      customTokens: {
        workbuddy: '',
        traecode: '',
        codearts: ''
      },
      platforms: {
        workbuddy: { lastDate: '', lastTime: '', status: 'idle', message: '尚未执行签到', credits: '', consecutiveDays: 0 },
        traecode: { lastDate: '', lastTime: '', status: 'idle', message: '尚未执行签到', credits: '', consecutiveDays: 0 },
        codearts: { lastDate: '', lastTime: '', status: 'idle', message: '尚未执行签到', credits: '', consecutiveDays: 0 }
      },
      history: []
    };
  }
}

/** @param {object} state */
async function saveState(state) {
  try {
    await mkdir(dirname(STATE_FILE), { recursive: true });
    await writeFile(STATE_FILE, JSON.stringify(state, null, 2) + '\n', 'utf-8');
  } catch (err) {
    console.error('[Checkin] 保存签到状态失败:', err.message);
  }
}

function getTodayStr() {
  const now = new Date();
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function getNowTimeStr() {
  const now = new Date();
  return now.toTimeString().slice(0, 8);
}

/**
 * 探测各平台可用凭据
 */
export async function detectCredentials() {
  const creds = {
    workbuddy: { available: false, source: '', token: '' },
    traecode: { available: false, source: '', token: '' },
    codearts: { available: false, source: '', ak: '', sk: '', token: '' }
  };

  const state = await loadState();

  // 1. WorkBuddy
  if (state.customTokens?.workbuddy) {
    creds.workbuddy = { available: true, source: '自定义 Token', token: state.customTokens.workbuddy };
  } else {
    for (const rel of ['.codebuddy-cn/auth.info', '.codebuddy/auth.info']) {
      try {
        const raw = await readFile(join(HOME, rel), 'utf-8');
        const d = JSON.parse(raw.replace(/^\uFEFF/, ''));
        const tok = String(d?.auth?.accessToken || '').trim();
        if (tok && !tok.startsWith('http')) {
          creds.workbuddy = { available: true, source: `本地凭据 (~/${rel})`, token: tok };
          break;
        }
      } catch { /* continue */ }
    }
    if (!creds.workbuddy.available) {
      try {
        const shared = await findCodeBuddySharedAuth(HOME);
        if (shared?.data?.auth?.accessToken) {
          creds.workbuddy = { available: true, source: 'WorkBuddy 共享会话', token: shared.data.auth.accessToken };
        }
      } catch { /* continue */ }
    }
  }

  // 2. Trae (无需客户端直连 / CDP 本地直控)
  if (state.customTokens?.traecode) {
    creds.traecode = { available: true, source: '自定义 JWT Token', token: state.customTokens.traecode };
  } else {
    // 优先检测本地是否运行着开启调试端口的 Trae 客户端 (端口 9222)
    let cdpOnline = false;
    try {
      const cdpPort = process.env.TRAE_CDP_PORT || '9222';
      const cdpHost = process.env.TRAE_CDP_HOST || '127.0.0.1';
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), 800);
      const r = await fetch(`http://${cdpHost}:${cdpPort}/json/version`, { signal: ctrl.signal });
      clearTimeout(t);
      if (r.ok) cdpOnline = true;
    } catch {}

    if (cdpOnline) {
      creds.traecode = { available: true, source: 'Trae 客户端 (CDP 本地直连)', token: 'cdp-session' };
    } else {
      for (const rel of ['.trae-cn/trae-jwt-token', '.trae/trae-jwt-token']) {
        try {
          const tok = (await readFile(join(HOME, rel), 'utf-8')).trim();
          if (tok) {
            creds.traecode = { available: true, source: `本地凭据 (~/${rel})`, token: tok };
            break;
          }
        } catch { /* continue */ }
      }
    }
  }

  // 3. CodeArts
  if (state.customTokens?.codearts) {
    creds.codearts = { available: true, source: '自定义 Token / AK-SK', token: state.customTokens.codearts };
  } else {
    try {
      const txt = await readFile(join(HOME, '.config', 'agenthub-codearts', 'codearts-auth.env'), 'utf-8');
      const akMatch = txt.match(/^CODEARTS_CLI_AK=(.+)$/m);
      const skMatch = txt.match(/^CODEARTS_CLI_SK=(.+)$/m);
      if (akMatch && skMatch) {
        creds.codearts = {
          available: true,
          source: '本地 AK/SK 凭据 (~/.config/agenthub-codearts/codearts-auth.env)',
          ak: akMatch[1].trim(),
          sk: skMatch[1].trim()
        };
      }
    } catch { /* continue */ }
    if (!creds.codearts.available) {
      try {
        const caJson = await readFile(join(HOME, '.codeartsdoer', 'codearts_cli.json'), 'utf-8');
        const d = JSON.parse(caJson);
        const ak = d.ak || d.accessKey || d.access_key;
        const sk = d.sk || d.secretKey || d.secret_key;
        if (ak && sk) {
          creds.codearts = {
            available: true,
            source: '本地 CodeArts 客户端配置 (~/.codeartsdoer/codearts_cli.json)',
            ak, sk
          };
        }
      } catch { /* continue */ }
    }
  }

  return creds;
}

// ---------------------------------------------------------------- 多账号档案扫描
// 签到必须覆盖「所有已保存的账号」，不能只看当前生效的那一个：
// 每个档案目录里就是该账号当时的凭据快照（auth.info / trae-jwt-token / codearts-auth.env）。

/** 平台 → 参与签到的 worker 列表（WorkBuddy 的签到接口只在 www.codebuddy.cn，故仅取 codebuddy-cn） */
const PLATFORM_WORKERS = {
  workbuddy: ['codebuddy-cn'],
  traecode: ['traecode'],
  codearts: ['codearts'],
};

/** 各 worker 档案目录内的凭据文件名 */
const PROFILE_CRED_FILE = {
  'codebuddy-cn': 'auth.info',
  codebuddy: 'auth.info',
  traecode: 'trae-jwt-token',
  codearts: 'codearts-auth.env',
};

/** 解出 JWT 的 payload（失败返回 null，绝不抛错） */
function jwtPayload(tok) {
  try {
    const part = String(tok).split('.')[1];
    if (!part) return null;
    return JSON.parse(Buffer.from(part.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf-8'));
  } catch {
    return null;
  }
}

const maskAk = (ak) => (ak && ak.length > 8 ? `${ak.slice(0, 4)}…${ak.slice(-4)}` : String(ak || ''));

/**
 * 从一个「HOME 目录」读某平台的凭据。
 * @param {'workbuddy'|'traecode'|'codearts'} platform
 * @param {string} dir        HOME 根（线上是 os.homedir()，档案是其快照目录）
 * @param {boolean} flat      档案目录里凭据文件是扁平存放的（auth.info），线上是嵌套路径
 */
async function readCredFrom(platform, dir, flat = false) {
  const tryJson = async (rel) => {
    try {
      const d = JSON.parse((await readFile(join(dir, rel), 'utf-8')).replace(/^\uFEFF/, ''));
      const tok = String(d?.auth?.accessToken || '').trim();
      if (!tok || tok.startsWith('http')) return null;
      const pl = jwtPayload(tok) || {};
      return {
        token: tok,
        identity: pl.sub || '',
        display: pl.nickname || pl.preferred_username || pl.email || '',
        exp: Number(pl.exp) || 0,
      };
    } catch {
      return null;
    }
  };

  if (platform === 'workbuddy') {
    const rels = flat ? ['auth.info'] : ['.codebuddy-cn/auth.info', '.codebuddy/auth.info'];
    for (const rel of rels) {
      const hit = await tryJson(rel);
      if (hit) return { ...hit, source: flat ? '账号档案' : `~/${rel}` };
    }
    // 新版 CodeBuddy CLI 的共享会话存储
    if (!flat) {
      try {
        const shared = await findCodeBuddySharedAuth(dir);
        const tok = String(shared?.data?.auth?.accessToken || '').trim();
        if (tok) {
          const pl = jwtPayload(tok) || {};
          return {
            token: tok,
            identity: pl.sub || '',
            display: pl.nickname || pl.preferred_username || '',
            exp: Number(pl.exp) || 0,
            source: 'CodeBuddy 共享会话',
          };
        }
      } catch { /* ignore */ }
    }
    return null;
  }

  if (platform === 'traecode') {
    const rels = flat ? ['trae-jwt-token'] : ['.trae-cn/trae-jwt-token', '.trae/trae-jwt-token'];
    for (const rel of rels) {
      try {
        const tok = (await readFile(join(dir, rel), 'utf-8')).trim();
        if (!tok || tok.split('.').length !== 3) continue;
        const pl = jwtPayload(tok) || {};
        const d = pl.data || {};
        return {
          token: tok,
          identity: String(d.id || d.user_id || ''),
          display: d.id ? `UID:${d.id}` : '',
          exp: Number(pl.exp) || 0,
          source: flat ? '账号档案' : `~/${rel}`,
        };
      } catch { /* next */ }
    }
    return null;
  }

  if (platform === 'codearts') {
    const rels = flat ? ['codearts-auth.env'] : ['.config/agenthub-codearts/codearts-auth.env'];
    for (const rel of rels) {
      try {
        const txt = await readFile(join(dir, rel), 'utf-8');
        const ak = (txt.match(/^CODEARTS_CLI_AK=(.+)$/m) || [])[1];
        const sk = (txt.match(/^CODEARTS_CLI_SK=(.+)$/m) || [])[1];
        if (ak && sk) {
          const akv = ak.trim();
          return { ak: akv, sk: sk.trim(), identity: akv, display: `AK:${maskAk(akv)}`, source: 'AK/SK' };
        }
      } catch { /* next */ }
    }
    return null;
  }

  return null;
}

/**
 * 汇总某平台的所有可签账号（档案 + 当前线上凭据），按身份去重。
 * @returns {Promise<Array<{name:string, display:string, worker:string, active:boolean, token?:string, ak?:string, sk?:string, exp?:number, source:string}>>}
 */
export async function listCheckinAccounts(platform) {
  const accounts = [];
  const seen = new Set();
  const add = (a) => {
    const key = String(a.identity || '');
    if (!key || seen.has(key)) return;
    seen.add(key);
    accounts.push(a);
  };

  for (const worker of PLATFORM_WORKERS[platform] || []) {
    let names = [];
    try {
      names = (await readdir(join(HOME, '.agenthub', 'accounts', worker))).filter((n) => !n.startsWith('.'));
    } catch { names = []; }
    for (const name of names.sort()) {
      const dir = join(HOME, '.agenthub', 'accounts', worker, name);
      let meta = {};
      try { meta = JSON.parse((await readFile(join(dir, 'meta.json'), 'utf-8')).replace(/^\uFEFF/, '')); } catch { /* 无 meta 也能用 */ }
      const cred = await readCredFrom(platform, dir, true);
      if (!cred) continue;
      add({
        name,
        display: cred.display || meta.display || meta.identity || name,
        worker,
        active: false,
        source: `账号档案 · ${name}`,
        ...cred,
      });
    }
  }

  const live = await readCredFrom(platform, HOME, false);
  if (live) {
    const same = accounts.find((a) => a.identity === live.identity);
    if (same) {
      same.active = true;
      same.token = same.token || live.token;
      same.ak = same.ak || live.ak;
      same.sk = same.sk || live.sk;
    } else {
      add({
        name: '(当前登录)',
        display: live.display || '当前登录账号',
        worker: (PLATFORM_WORKERS[platform] || [''])[0],
        active: false,
        ...live,
      });
    }
  }

  const liveId = live?.identity;
  for (const a of accounts) if (liveId && a.identity === liveId) a.active = true;
  if (accounts.length && !accounts.some((a) => a.active)) accounts[0].active = true;
  return accounts;
}

// ---------------------------------------------------------------- 华为云 SDK-HMAC-SHA256 签名
// 与 huaweicloud-sdk / 开放网关一致。两个必须复刻的坑：
//   1) CanonicalURI 必须以 / 结尾（path 已带尾斜杠时不能补第二个）
//   2) CanonicalHeaders 每行自带 \n 后，整体再与 CanonicalRequest 用 \n 连接（即尾部已有一个 \n，不再额外补）
const _sha256hex = (buf) => createHash('sha256').update(buf).digest('hex');
const _rfc3986 = (s) => encodeURIComponent(s).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);

function codeArtsSignedHeaders(ak, sk, method, rawUrl, body, extra = {}) {
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

  const segs = (u.pathname || '/').split('/').map((s) => _rfc3986(decodeURIComponent(s)));
  let canonicalUri = segs.join('/');
  if (!canonicalUri.endsWith('/')) canonicalUri += '/';

  const canonicalQuery = [...u.searchParams.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${_rfc3986(k)}=${_rfc3986(v)}`)
    .join('&');

  const canonicalRequest = [
    method,
    canonicalUri,
    canonicalQuery,
    canonicalHeaders,
    signedHeaders,
    _sha256hex(payload || Buffer.alloc(0)),
  ].join('\n');
  const stringToSign = ['SDK-HMAC-SHA256', headers['x-sdk-date'], _sha256hex(Buffer.from(canonicalRequest, 'utf-8'))].join('\n');
  const signature = createHmac('sha256', sk).update(stringToSign).digest('hex');
  headers.authorization = `SDK-HMAC-SHA256 Access=${ak}, SignedHeaders=${signedHeaders}, Signature=${signature}`;
  return headers;
}

const CODEARTS_GATEWAY = 'https://opengw.developer.huaweicloud.com';
const CODEARTS_SNAP = 'https://snap-access.cn-north-4.myhuaweicloud.com';
/** 码道客户端的固定身份头，缺一个就会被网关按「非 IDE 客户端」拒掉 */
const CODEARTS_IDENTITY_HEADERS = {
  'content-type': 'application/json',
  'app-id': 'CodeAgent3.0',
  'x-ot-function': 'agent-general',
  'x-ot-client-type': 'IDE',
  'x-ot-client-version': '26.9.902',
  'plugin-name': 'codemate_vscode',
  'plugin-version': '26.9.902',
  'ide-name': 'VSCode',
  'ide-version': '26.9.902',
  'x-language': 'zh-cn',
  'agent-type': 'PromptCenter',
};

/**
 * 带签名调用码道网关。
 * @returns {Promise<{ status:number, json:any, text:string }>}
 */
async function codeArtsFetch(ak, sk, method, url, bodyObj = null) {
  const body = bodyObj ? JSON.stringify(bodyObj) : null;
  const headers = codeArtsSignedHeaders(ak, sk, method, url, body, CODEARTS_IDENTITY_HEADERS);
  const res = await fetch(url, { method, headers, body: body || undefined });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* 非 JSON（网关 404 HTML）*/ }
  return { status: res.status, json, text };
}

/**
 * 单个 WorkBuddy 账号打卡（www.codebuddy.cn 每日加油站）
 * 真实响应字段是 credit / streak_days，已签到时是 code=10001 + "今天已签到，请明天再来"。
 */
async function checkinWorkBuddyOne(token) {
  const res = await fetchJsonSmart('https://www.codebuddy.cn/v2/billing/meter/daily-checkin', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json',
      'X-Domain': 'codebuddy.cn',
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) WorkBuddy/1.0.0'
    },
    body: JSON.stringify({})
  }, 12_000);

  const json = res.json || {};
  const msg = String(json.msg || json.message || '');

  if (res.status === 200 && json.code === 0) {
    const credit = json.data?.credit ?? json.data?.points ?? json.data?.credits ?? 0;
    const streak = json.data?.streak_days ?? json.data?.consecutiveDays ?? 0;
    return {
      ok: true,
      status: 'success',
      message: `签到成功 +${credit} 积分${streak ? `（连签 ${streak} 天）` : ''}`,
      credits: credit,
      consecutiveDays: Number(streak) || 0
    };
  }

  // 10001 = 今天已签到
  if (json.code === 10001 || msg.includes('已签到') || msg.includes('already')) {
    return { ok: true, status: 'already', message: msg || '今日已签到', credits: 0, consecutiveDays: 0 };
  }

  if (res.status === 401 || json.code === 401) {
    return { ok: false, status: 'expired', message: '登录态已失效，请在客户端重新登录', credits: 0, consecutiveDays: 0 };
  }

  return {
    ok: false,
    status: 'failed',
    message: `签到接口返回 [${res.status}/${json.code ?? '-'}]：${msg || '未知错误'}`,
    credits: 0,
    consecutiveDays: 0
  };
}

/**
 * 读取「配置 Token」里手工粘贴的凭据，作为额外账号参与签到。
 * CodeArts 支持 `AK,SK` 或 `AK:SK` 的写法（旧面板只给了单行输入框）。
 */
async function customCredentialAccount(platform) {
  const state = await loadState();
  const raw = String(state.customTokens?.[platform] || '').trim();
  if (!raw) return null;
  if (platform === 'codearts') {
    const m = raw.match(/^([A-Z0-9]{8,})[,:;\s]+([A-Za-z0-9+/=]{8,})$/);
    if (!m) return { name: '自定义凭据', display: '自定义凭据', identity: 'custom', active: false, source: '自定义凭据（格式应为 AK,SK）', invalid: true };
    return { name: '自定义凭据', display: `AK:${maskAk(m[1])}`, identity: m[1], ak: m[1], sk: m[2], active: false, source: '自定义 AK/SK' };
  }
  return { name: '自定义 Token', display: '自定义 Token', identity: 'custom', token: raw, exp: 0, active: false, source: '自定义 Token' };
}

/**
 * 执行 WorkBuddy 签到（覆盖所有已保存账号）
 * 之前只签「当前生效」的那一个，导致另一个号永远签不到。
 */
export async function checkinWorkBuddy(overrideToken = null) {
  const today = getTodayStr();
  const time = getNowTimeStr();

  let accounts;
  if (overrideToken) {
    accounts = [{ name: '自定义 Token', display: '自定义 Token', token: overrideToken, exp: 0, source: '自定义 Token', active: true }];
  } else {
    accounts = await listCheckinAccounts('workbuddy');
    const custom = await customCredentialAccount('workbuddy');
    if (custom) accounts = [custom, ...accounts];
  }

  if (!accounts.length) {
    return {
      platform: 'workbuddy',
      ok: false,
      status: 'unconfigured',
      message: '未检测到 WorkBuddy / CodeBuddy 登录凭据，请先在客户端登录或保存账号档案。',
      today,
      time: getNowTimeStr(),
      accounts: []
    };
  }

  const results = [];
  for (const acct of accounts) {
    const label = acct.display || acct.name;
    if (!acct.token) {
      results.push({ ...acct, ...{ ok: false, status: 'failed', message: '档案内没有可用的 accessToken' } });
      continue;
    }
    if (acct.exp && acct.exp * 1000 < Date.now()) {
      results.push({ ...acct, ...{ ok: false, status: 'expired', message: '登录态已过期，请重新登录该账号' } });
      continue;
    }
    try {
      const r = await checkinWorkBuddyOne(acct.token);
      results.push({ ...acct, ...r, label });
    } catch (err) {
      results.push({ ...acct, ok: false, status: 'failed', message: `网络请求失败：${err.message}`, label });
    }
  }

  const okOnes = results.filter((r) => r.status === 'success');
  const alreadyOnes = results.filter((r) => r.status === 'already');
  const badOnes = results.filter((r) => !['success', 'already'].includes(r.status));

  const status = badOnes.length && !okOnes.length && !alreadyOnes.length
    ? 'failed'
    : (badOnes.length ? 'failed' : (okOnes.length ? 'success' : 'already'));

  const parts = results.map((r) => {
    const name = r.label || r.name;
    if (r.status === 'success') return `${name} +${r.credits}`;
    if (r.status === 'already') return `${name} 已签`;
    return `${name} ${r.status === 'expired' ? '登录态失效' : '失败'}`;
  });

  return {
    platform: 'workbuddy',
    ok: badOnes.length === 0,
    status,
    message: `${results.length} 个账号：${parts.join('；')}`,
    credits: okOnes.reduce((s, r) => s + (Number(r.credits) || 0), 0),
    consecutiveDays: Math.max(0, ...results.map((r) => Number(r.consecutiveDays) || 0)),
    accounts: results.map((r) => ({
      name: r.name,
      display: r.label || r.name,
      active: !!r.active,
      status: r.status,
      message: r.message,
      credits: r.credits,
      consecutiveDays: r.consecutiveDays
    })),
    today,
    time
  };
}


/**
 * 在 Trae 客户端里执行一段脚本（CDP 直连 9222）。
 * 客户端不在线 / 端口不通时返回 null。
 * @param {string} expression 需要返回可 JSON 化的值的表达式
 */
async function evaluateInTrae(expression, timeoutMs = 6000) {
  const cdpPort = process.env.TRAE_CDP_PORT || '9222';
  const cdpHost = process.env.TRAE_CDP_HOST || '127.0.0.1';

  if (typeof globalThis.WebSocket !== 'function') return null;

  let targets;
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 2000);
    const resp = await fetch(`http://${cdpHost}:${cdpPort}/json`, { signal: ctrl.signal });
    clearTimeout(timer);
    if (!resp.ok) return null;
    targets = await resp.json();
  } catch {
    return null;
  }
  if (!Array.isArray(targets) || !targets.length) return null;

  const target = targets.find((t) => t.type === 'page' && t.url && t.url.includes('workbench'))
    || targets.find((t) => t.type === 'page');
  if (!target || !target.webSocketDebuggerUrl) return null;

  const ws = new globalThis.WebSocket(target.webSocketDebuggerUrl);
  let msgId = 1;
  /** @type {Map<number, Function>} */
  const pending = new Map();

  const sendCmd = (method, params = {}) => new Promise((resolve, reject) => {
    const id = msgId++;
    const t = setTimeout(() => { pending.delete(id); reject(new Error(`CDP ${method} timeout`)); }, timeoutMs);
    pending.set(id, (val) => { clearTimeout(t); resolve(val); });
    try { ws.send(JSON.stringify({ id, method, params })); } catch (e) { clearTimeout(t); pending.delete(id); reject(e); }
  });

  ws.onmessage = (event) => {
    try {
      const data = JSON.parse(event.data);
      if (data.id && pending.has(data.id)) {
        const entry = pending.get(data.id);
        pending.delete(data.id);
        entry(data.result);
      }
    } catch { /* 非 JSON 帧忽略 */ }
  };

  try {
    await new Promise((resolve, reject) => {
      const connTimer = setTimeout(() => reject(new Error('WebSocket connect timeout')), 2500);
      ws.onopen = () => { clearTimeout(connTimer); resolve(null); };
      ws.onerror = (e) => { clearTimeout(connTimer); reject(e); };
    });
    const evalResult = await sendCmd('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    return evalResult?.result?.value ?? null;
  } catch {
    return null;
  } finally {
    try { ws.close(); } catch { /* ignore */ }
  }
}

/**
 * 通过 CDP 尝试在 Trae 客户端里点真实签到按钮。
 *
 * 注意：旧实现只要 localStorage 里存在 trae-cn-credits-billing-status 就判定「今日已签到」，
 * 那个 key 一旦写入就永久存在，等于每天都谎报成功。这里必须以按钮文案 / 接口结果为准。
 *
 * @returns {Promise<null|{status:'success'|'already'|'unavailable', message:string, credits?:number}>}
 */
async function checkinTraeViaCdp() {
  const script = `
  (async () => {
    const norm = (s) => (s || '').replace(/\\s+/g, ' ').trim();
    const visible = (el) => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; };

    // 只认「签到」按钮；纯「领取」必须落在积分/权益面板内，
    // 否则会误点活动横幅上的「立即领取」，把用户的羊毛顺手点掉。
    const clickables = Array.from(document.querySelectorAll('button,[role="button"],[class*=btn],[class*=Button]'));
    const hits = clickables.filter((el) => {
      if (!visible(el)) return false;
      const t = norm(el.textContent);
      if (/签到/.test(t) && t.length <= 12) return true;
      if (/^(领取|立即领取|每日领取)$/.test(t)) {
        return !!el.closest('[class*=user-entitlement],[class*=checkin],[class*=credits]');
      }
      return false;
    });

    if (!hits.length) {
      return { status: 'unavailable', message: '客户端界面里没有找到可点击的签到入口' };
    }

    const btn = hits[0];
    const before = norm(btn.textContent);
    if (/已签|已领/.test(before)) {
      return { status: 'already', message: '客户端显示今日已签到（' + before + '）' };
    }

    btn.click();
    await new Promise((r) => setTimeout(r, 1800));

    const after = norm(btn.textContent);
    if (/已签|已领/.test(after)) {
      return { status: 'success', message: '已点击签到，按钮变为「' + after + '」' };
    }
    return { status: 'unavailable', message: '已点击「' + before + '」，但按钮状态未变化（' + after + '）' };
  })()
  `;

  const val = await evaluateInTrae(script, 8000);
  if (!val || !val.status) return null;
  if (val.status === 'success' || val.status === 'already') return val;
  return { status: 'unavailable', message: val.message || '客户端未提供可用的签到入口' };
}

/**
 * 稳定设备号：同一账号 + 同一台机器永远是同一个 UUID。
 *
 * 旧实现每次请求都 randomUUID()，等于每次签到都伪装成一台新设备。
 * Trae 侧按账号统计活跃设备数，设备号天天变很容易被判「当前参与用户太多」(9074)。
 * 这里用 UID + 主机名做 sha256，取前 16 字节拼成 UUID 形状，重启后也不变。
 */
function traeDeviceId(token) {
  let uid = 'anon';
  try {
    uid = String(jwtPayload(token)?.data?.id || jwtPayload(token)?.sub || 'anon');
  } catch { /* 用 anon 兜底 */ }
  let host = 'host';
  try { host = hostname(); } catch { /* ignore */ }
  const h = createHash('sha256').update(`trae:${uid}:${host}`).digest('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`;
}

/** 调 Trae 签到接口（真实头是 Cloud-IDE-JWT，不是 Bearer） */
async function traeApi(token, path) {
  const deviceId = traeDeviceId(token);
  const res = await fetchJsonSmart(`https://api.trae.cn${path}`, {
    method: 'POST',
    headers: {
      'Authorization': `Cloud-IDE-JWT ${token}`,
      'Content-Type': 'application/json',
      'User-Agent': 'Trae/1.107.1 (X11; Linux x86_64) TraeCN',
      'x-device-id': deviceId,
      'x-machine-id': deviceId
    },
    body: JSON.stringify({ req_source: 1 })
  }, 12_000);
  const json = res.json || {};
  return { status: res.status, json };
}

/** 单个 Trae 账号打卡：先查状态，未签才领 */
async function checkinTraeOne(token) {
  const st = await traeApi(token, '/trae/api/v2/ug/checkin_credits/status');
  const stJson = st.json || {};

  if (stJson.code === 1001) {
    // 1001 不等于「过期」：JWT 的 exp 往往还没到，是服务端把这个会话注销了
    //（在别处重新登录、单端登录顶号、账号被踢下线都会这样）。所以提示要给可点的入口，
    // 不能只说「去客户端重新登录」——控制台自带 OAuth，根本不需要装客户端。
    return { ok: false, status: 'expired', message: 'JWT 已被服务端注销（1001），点「重新登录」用 Trae 账号重新授权' };
  }
  if (stJson.checked_in === true) {
    return { ok: true, status: 'already', message: '今日已签到', credits: 0, consecutiveDays: Number(stJson.streak || stJson.consecutive_days) || 0 };
  }

  // 领取接口只有 `{req_source:1}` 这一种正确请求体（多带任何字段都会变成 9004
  // 「order parameters are incorrect」）；9074 是服务端自己的排队/限流，
  // 与参数无关，隔一会儿再打通常就过了，所以这里退避重试几次再报错。
  let r = null;
  let json = {};
  for (let attempt = 0; attempt < 3; attempt++) {
    r = await traeApi(token, '/trae/api/v2/ug/checkin_credits/claim');
    json = r.json || {};
    if (json.code !== 9074) break;
    if (attempt < 2) await new Promise((res) => setTimeout(res, 3000 * (attempt + 1)));
  }
  const msg = String(json.message || json.msg || '');

  if (r.status === 200 && (json.code === 0 || json.code === undefined) && (json.checked_in !== false)) {
    const credits = json.data?.credits ?? json.credits ?? json.data?.credit ?? 0;
    const streak = json.data?.streak ?? json.data?.streak_days ?? 0;
    return { ok: true, status: 'success', message: `领取 ${credits} 积分${streak ? `（连签 ${streak} 天）` : ''}`, credits: Number(credits) || 0, consecutiveDays: Number(streak) || 0 };
  }
  if (json.checked_in === true || /已签到|已领取|already|claimed/.test(msg)) {
    return { ok: true, status: 'already', message: msg || '今日已签到', credits: 0, consecutiveDays: 0 };
  }
  if (json.code === 1001 || /not able to authenticate/.test(msg)) {
    return { ok: false, status: 'expired', message: 'JWT 已被服务端注销（1001），点「重新登录」用 Trae 账号重新授权' };
  }
  if (json.code === 9074) {
    return { ok: false, status: 'failed', message: '签到接口排队中（9074 当前参与用户太多），已重试 3 次，稍后会自动再试' };
  }
  return { ok: false, status: 'failed', message: `签到接口返回 [${r.status}/${json.code ?? '-'}]：${msg || '未知错误'}` };
}

/**
 * 执行 Trae 签到：所有账号走 API，全部失败时再退回 CDP 点客户端按钮
 */
export async function checkinTrae(overrideToken = null) {
  const today = getTodayStr();

  let accounts;
  if (overrideToken) {
    accounts = [{ name: '自定义 Token', display: '自定义 Token', token: overrideToken, exp: 0, source: '自定义 Token', active: true }];
  } else {
    accounts = await listCheckinAccounts('traecode');
    const custom = await customCredentialAccount('traecode');
    if (custom) accounts = [custom, ...accounts];
  }

  const results = [];
  for (const acct of accounts) {
    const label = acct.display || acct.name;
    if (!acct.token) {
      results.push({ ...acct, ok: false, status: 'failed', message: '档案内没有 JWT', label });
      continue;
    }
    if (acct.exp && acct.exp * 1000 < Date.now()) {
      results.push({ ...acct, ok: false, status: 'expired', message: 'JWT 已过期，点「重新登录」重新授权', label });
      continue;
    }
    try {
      const r = await checkinTraeOne(acct.token);
      results.push({ ...acct, ...r, label });
    } catch (err) {
      results.push({ ...acct, ok: false, status: 'failed', message: `网络请求失败：${err.message}`, label });
    }
  }

  const okOnes = results.filter((r) => r.status === 'success');
  const alreadyOnes = results.filter((r) => r.status === 'already');
  const badOnes = results.filter((r) => !['success', 'already'].includes(r.status));

  // API 全军覆没 → 试一次客户端 UI（客户端在本机运行时这条路不依赖 token）
  if (badOnes.length === results.length && results.length) {
    const cdp = await checkinTraeViaCdp();
    if (cdp && cdp.status !== 'unavailable') {
      return {
        platform: 'traecode',
        ok: true,
        status: cdp.status,
        message: `${cdp.message}（API 凭据失效，已改用客户端直签）`,
        credits: cdp.credits || 0,
        consecutiveDays: 0,
        accounts: [{ name: 'Trae 客户端', display: 'Trae 客户端 (CDP)', active: true, status: cdp.status, message: cdp.message }],
        today,
        time: getNowTimeStr()
      };
    }
  }

  const status = badOnes.length
    ? 'failed'
    : (okOnes.length ? 'success' : 'already');

  const parts = results.map((r) => {
    const name = r.label || r.name;
    if (r.status === 'success') return `${name} +${r.credits}`;
    if (r.status === 'already') return `${name} 已签`;
    return `${name} ${r.message}`;
  });

  return {
    platform: 'traecode',
    ok: badOnes.length === 0,
    status,
    message: results.length ? parts.join('；') : '未检测到 Trae 账号',
    credits: okOnes.reduce((s, r) => s + (Number(r.credits) || 0), 0),
    consecutiveDays: Math.max(0, ...results.map((r) => Number(r.consecutiveDays) || 0)),
    accounts: results.map((r) => ({
      name: r.name,
      display: r.label || r.name,
      active: !!r.active,
      status: r.status,
      message: r.message,
      credits: r.credits,
      consecutiveDays: r.consecutiveDays
    })),
    today,
    time: getNowTimeStr()
  };
}
/**
 * 单个 CodeArts AK/SK 账号的真实签到流程（参考 2951461586/CodeArts2API）
 *   1. GET  /api/v1/benefit/claim          福利通道登记（幂等，确认身份）
 *   2. GET  /v1/ops/delivery?channel=IDE   拉任务列表，找 USER_LOGIN 那个 campaign
 *   3. POST /v1/ops/claim                  领取（需要 channel + idempotentKey）
 *
 * 旧实现只要文件里有 AK/SK 就直接返回「已激活」，从来没发过一个请求。
 */
async function checkinCodeArtsOne(ak, sk) {
  // 1. 福利通道（同时验证 AK/SK 真的能过签名）
  let userName = '';
  try {
    const r = await codeArtsFetch(ak, sk, 'GET', `${CODEARTS_GATEWAY}/api/v1/benefit/claim`);
    const code = String(r.json?.error_code ?? '');
    if (code && code !== '0000') {
      const mapped = mapCodeArtsError(code, r.json?.error_msg, r.text);
      return { ok: false, status: mapped.status, message: mapped.message };
    }
    userName = String(r.json?.result?.user_name || '');
  } catch (err) {
    return { ok: false, status: 'failed', message: `福利网关不可达：${err.message}` };
  }

  // 2. 任务列表
  let campaign = null;
  let campaigns = [];
  try {
    const r = await codeArtsFetch(ak, sk, 'GET', `${CODEARTS_SNAP}/v1/ops/delivery?channel=IDE`);
    const items = Array.isArray(r.json?.data?.items) ? r.json.data.items : [];
    campaigns = items;
    campaign = items.find((it) => it.type === 'USER_LOGIN')
      || items.find((it) => /签到/.test(String(it.title || '')))
      || null;
  } catch (err) {
    return { ok: false, status: 'failed', message: `任务列表不可达：${err.message}` };
  }

  if (!campaign) {
    return { ok: false, status: 'failed', message: `没有找到签到任务（共 ${campaigns.length} 个活动）` };
  }

  const amount = Number(campaign.benefitAmount) || 0;
  const unit = campaign.benefitUnit === 'CREDIT' ? '积分' : (campaign.benefitUnit || '');
  const who = userName ? `${userName} ` : '';

  // 3a. 已经领过
  if (campaign.claimable === false && ['CLAIMED', 'CONFIRMED', 'CONSUMED'].includes(String(campaign.status))) {
    return {
      ok: true,
      status: 'already',
      message: `${who}今日已领取「${campaign.title}」（${amount}${unit}）`,
      credits: 0,
      consecutiveDays: 0
    };
  }

  if (campaign.claimable === false) {
    return {
      ok: false,
      status: 'failed',
      message: `「${campaign.title}」当前不可领取（状态 ${campaign.status || '未知'}）`
    };
  }

  // 3b. 真正领取
  const claimRes = await codeArtsFetch(ak, sk, 'POST', `${CODEARTS_SNAP}/v1/ops/claim`, {
    campaignId: campaign.campaignId,
    channel: 'IDE',
    idempotentKey: randomUUID()
  });
  const cj = claimRes.json || {};
  const bizCode = Number(cj.code ?? NaN);
  const bizMsg = String(cj.message || cj.error_msg || '');

  if (bizCode === 0) {
    return {
      ok: true,
      status: 'success',
      message: `${who}签到成功 +${amount}${unit}`,
      credits: amount,
      consecutiveDays: 1
    };
  }
  // 40001 = 权益还没刷新（今日已领）
  if (bizCode === 40001) {
    return { ok: true, status: 'already', message: `${who}${bizMsg || '今日已领取，等明天刷新'}`, credits: 0, consecutiveDays: 0 };
  }
  if (bizCode === 4006) {
    return { ok: false, status: 'failed', message: `${bizMsg || '名额已领完'}（4006）` };
  }
  const mapped = mapCodeArtsError(String(cj.error_code || bizCode), bizMsg, claimRes.text);
  return { ok: false, status: mapped.status, message: mapped.message };
}

/** 把华为云网关/业务错误码翻译成人话 */
function mapCodeArtsError(code, msg, rawText = '') {
  const c = String(code || '');
  const m = String(msg || '');
  if (c === 'APIG.0602' || /token.*(expired|invalid)|sts/i.test(m)) {
    return { status: 'expired', message: 'AK/SK 对应的临时安全凭证（STS）已过期，请重新获取或改用长期 AK/SK' };
  }
  if (c === 'APIG.0301' || c === 'APIG.0303' || /signature/i.test(m)) {
    return { status: 'failed', message: `签名校验失败（${c || 'signature'}），请检查 AK/SK 是否匹配` };
  }
  if (c === 'APIG.0101') {
    return { status: 'failed', message: '接口未在该环境发布（APIG.0101），请检查区域/网关地址' };
  }
  if (c === '4006') {
    return { status: 'failed', message: `${m || '名额已领完'}（4006）` };
  }
  return { status: 'failed', message: `CodeArts 返回 [${c || '-'}]：${m || (rawText || '').slice(0, 120) || '未知错误'}` };
}

/**
 * 执行 CodeArts 签到（覆盖所有 AK/SK 档案）
 */
export async function checkinCodeArts(overrideToken = null) {
  const today = getTodayStr();

  let accounts;
  if (overrideToken) {
    accounts = [{ name: '自定义凭据', display: '自定义凭据', token: overrideToken, source: '自定义凭据', active: true }];
  } else {
    accounts = await listCheckinAccounts('codearts');
    const custom = await customCredentialAccount('codearts');
    if (custom) accounts = [custom, ...accounts];
  }

  if (!accounts.length) {
    return {
      platform: 'codearts',
      ok: false,
      status: 'unconfigured',
      message: '未检测到 CodeArts AK/SK，请检查 ~/.config/agenthub-codearts/codearts-auth.env 或保存账号档案。',
      today,
      time: getNowTimeStr(),
      accounts: []
    };
  }

  const results = [];
  for (const acct of accounts) {
    const label = acct.display || acct.name;
    if (acct.invalid) {
      results.push({ ...acct, ok: false, status: 'failed', message: '自定义凭据格式应为 AK,SK（逗号分隔）', label });
      continue;
    }
    if (!acct.ak || !acct.sk) {
      results.push({ ...acct, ok: false, status: 'failed', message: '缺少 AK/SK', label });
      continue;
    }
    try {
      const r = await checkinCodeArtsOne(acct.ak, acct.sk);
      results.push({ ...acct, ...r, label });
    } catch (err) {
      results.push({ ...acct, ok: false, status: 'failed', message: `请求异常：${err.message}`, label });
    }
  }

  const okOnes = results.filter((r) => r.status === 'success');
  const alreadyOnes = results.filter((r) => r.status === 'already');
  const badOnes = results.filter((r) => !['success', 'already'].includes(r.status));

  const status = badOnes.length ? 'failed' : (okOnes.length ? 'success' : 'already');

  return {
    platform: 'codearts',
    ok: badOnes.length === 0,
    status,
    message: results.map((r) => r.message).join('；'),
    credits: okOnes.reduce((s, r) => s + (Number(r.credits) || 0), 0),
    consecutiveDays: Math.max(0, ...results.map((r) => Number(r.consecutiveDays) || 0)),
    accounts: results.map((r) => ({
      name: r.name,
      display: r.label || r.name,
      active: !!r.active,
      status: r.status,
      message: r.message,
      credits: r.credits,
      consecutiveDays: r.consecutiveDays
    })),
    today,
    time: getNowTimeStr()
  };
}


/**
 * 获取完整签到概览（供 WebUI 展示）
 */
export async function getCheckinOverview() {
  const state = await loadState();
  const creds = await detectCredentials();
  const today = getTodayStr();

  // 整理每个平台的前端渲染数据
  const platforms = {};
  for (const plat of ['workbuddy', 'traecode', 'codearts']) {
    const pState = state.platforms[plat] || {};
    const cInfo = creds[plat] || {};
    const isToday = pState.lastDate === today;

    platforms[plat] = {
      available: cInfo.available,
      source: cInfo.source || '未关联凭据',
      lastDate: pState.lastDate || '无记录',
      lastTime: pState.lastTime || '',
      status: isToday ? pState.status : (cInfo.available ? 'pending' : 'unconfigured'),
      message: isToday ? pState.message : (cInfo.available ? '今日待打卡' : '未检测到有效凭据'),
      credits: pState.credits || '',
      consecutiveDays: pState.consecutiveDays || 0,
      accounts: isToday && Array.isArray(pState.accounts) && pState.accounts.length
        ? pState.accounts
        : (await listCheckinAccounts(plat)).map((a) => ({
          name: a.name,
          display: a.display,
          active: !!a.active,
          status: 'pending',
          message: '今日待打卡',
        })),
    };
  }

  return {
    ok: true,
    today,
    autoCheckin: state.autoCheckin !== false,
    autoCheckinTime: state.autoCheckinTime || '08:30',
    platforms,
    history: (state.history || []).slice(0, 20),
    openSourceProjects: OPEN_SOURCE_PROJECTS
  };
}

/**
 * 执行指定平台签到或一键全签
 * @param {'all'|'workbuddy'|'traecode'|'codearts'} target
 */
export async function runCheckin(target = 'all') {
  const state = await loadState();
  const results = {};

  if (target === 'all' || target === 'workbuddy') {
    results.workbuddy = await checkinWorkBuddy();
  }
  if (target === 'all' || target === 'traecode') {
    results.traecode = await checkinTrae();
  }
  if (target === 'all' || target === 'codearts') {
    results.codearts = await checkinCodeArts();
  }

  // 记录状态与审计历史
  for (const [plat, res] of Object.entries(results)) {
    const prev = state.platforms[plat] || {};
    const failed = !['success', 'already'].includes(res.status);
    state.platforms[plat] = {
      lastDate: res.today,
      lastTime: res.time,
      status: res.status,
      message: res.message,
      credits: res.credits || '',
      consecutiveDays: res.consecutiveDays || (prev.consecutiveDays || 0),
      accounts: res.accounts || [],
      // 同一天内的失败重试计数：定时器据此决定要不要隔半小时再试一次。
      // 旧逻辑只看 lastDate，失败一次就把今天标成「已处理」，9074 这类
      // 服务端排队错误再也没机会重试。成功后清零。
      retryCount: failed ? (prev.lastDate === res.today ? (prev.retryCount || 0) + 1 : 1) : 0
    };
    state.history.unshift({
      time: `${res.today} ${res.time}`,
      platform: plat,
      status: res.status,
      message: res.message
    });
  }

  // 限制历史最多 50 条
  if (state.history.length > 50) {
    state.history = state.history.slice(0, 50);
  }

  await saveState(state);
  return { ok: true, results, overview: await getCheckinOverview() };
}

/**
 * 保存配置（自定义 Token、定时打卡设置等）
 */
export async function updateCheckinConfig(config) {
  const state = await loadState();
  if (typeof config.autoCheckin === 'boolean') {
    state.autoCheckin = config.autoCheckin;
  }
  if (typeof config.autoCheckinTime === 'string') {
    state.autoCheckinTime = config.autoCheckinTime;
  }
  if (config.customTokens && typeof config.customTokens === 'object') {
    state.customTokens = {
      ...state.customTokens,
      ...config.customTokens
    };
  }
  await saveState(state);
  return { ok: true, overview: await getCheckinOverview() };
}

/**
 * 后台定时自动签到调度器
 */
let timerStarted = false;
export function startAutoCheckinScheduler() {
  if (timerStarted) return;
  timerStarted = true;

  // 每 30 分钟检查一次是否到达签到时间或尚未今日打卡
  setInterval(async () => {
    try {
      const state = await loadState();
      if (!state.autoCheckin) return;

      const today = getTodayStr();
      // 只补「还没签」和「今天签失败的」平台：
      // 前者是首次触发；后者给限流/网络抖动留重试机会（每天最多 6 次，约 3 小时）。
      // 旧实现只要有一个平台没签就 runCheckin('all')，会把已签成的平台又打一遍。
      const pending = ['workbuddy', 'traecode', 'codearts'].filter((plat) => {
        const p = state.platforms[plat] || {};
        if (p.lastDate !== today) return true;
        return p.status === 'failed' && (p.retryCount || 0) < 6;
      });
      if (pending.length) {
        console.log(`[Checkin] 触发定时签到（待处理: ${pending.join(', ')}）...`);
        for (const plat of pending) await runCheckin(plat);
      }
    } catch (e) {
      console.error('[Checkin] 自动打卡定时器异常:', e.message);
    }
  }, 30 * 60 * 1000);
}
