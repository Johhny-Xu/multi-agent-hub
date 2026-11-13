// @ts-check
// 百度搭子 DuMate（FEAT-dumate）：账号存储、网页接口（签到 / 积分 / 换网关 token）、经共享浏览器扫码登录。
//
// 参考（MIT，只读其行为，未拷代码）：
//   wearetheone777/dumate2api   src/web-pool.js、src/dumate-web.js、src/login-browser.js
//   R227BOUT/magpie-plugin-dumate index.mjs（签到 / 余额 hook 的判定口径）
// 事实（2026-11-13 开发机实测未登录态 + 上述项目真机记录）：
//   - 网页接口在 https://www.dumate.cn/api/dumate/*，鉴权是百度 cookie（BDUSS + bce-long-term-sessionid 等）；
//     未登录回 HTTP 401 {"code":10001,"message":"登录已经过期"}（10006 同义）。
//   - 模型网关 https://dumate-svc.baidu.com/gateway/apis/v1/chat/completions（OpenAI 兼容），
//     Bearer 是 GET www.dumate.cn/api/dumate/app/token/get 换来的 token（{ token, expired_at }）；
//     坏 token 回 401 invalid_api_key。网关没有 /models（实测 401/404），模型表只能静态。
//   - 签到 POST /api/dumate/points/loginBonus；状态 GET loginBonusInfo（hasIssued / totalPoints / totalTimes）；
//     积分 GET quota_overview（totalPoints / usedPoints / subscription[] / incremental[]，expireDate 秒）。
//   - 登录页 login.bce.baidu.com 默认带百度 App 扫码二维码（img.tang-pass-qrcode-img），
//     登录后要落到 console.bce.baidu.com 一次才种下 bce-long-term-sessionid。
// 凭据纪律：cookie 只落 ~/.agenthub/dumate-accounts.json（0600），绝不回显到接口、日志或页面。
// 免责：积分自动化可能违反上游服务条款（dumate2api README 原话），只做每日登录签到，不做抽奖 / 任务刷分。
import { readFile, writeFile, mkdir, rename, chmod } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';

const HOME = process.env.AGENTHUB_HOME ? resolve(process.env.AGENTHUB_HOME) : homedir();
const STORE_FILE = process.env.DUMATE_ACCOUNTS_FILE
  ? resolve(process.env.DUMATE_ACCOUNTS_FILE)
  : join(HOME, '.agenthub', 'dumate-accounts.json');
/** 扫码登录进行中的标签页（只存 targetId / browserContextId，不含 cookie）。 */
const LOGIN_STATE_FILE = process.env.DUMATE_LOGIN_STATE
  ? resolve(process.env.DUMATE_LOGIN_STATE)
  : join(HOME, '.agenthub', 'dumate-login.json');

export const WEB_BASE = (process.env.DUMATE_WEB_BASE || 'https://www.dumate.cn').replace(/\/+$/, '');
export const CONSOLE_BASE = 'https://console.bce.baidu.com';
export const GATEWAY_URL = (process.env.DUMATE_GATEWAY_URL || 'https://dumate-svc.baidu.com/gateway/apis/v1').replace(/\/+$/, '');
export const LOGIN_URL = 'https://login.bce.baidu.com/?from=oa_dumate&redirect=https%3A%2F%2Fconsole.bce.baidu.com%2F';
const SETTLE_URL = 'https://console.bce.baidu.com/';
/** 快捷登录自动点击：最多 3 次、每次至少间隔 10 秒（百度登录页会吞掉连点，点多了反而卡住）。 */
const SETTLE_CLICK_LIMIT = 3;
const SETTLE_CLICK_INTERVAL_MS = 10_000;
/** 登录页上的可点击元素：按钮优先，链接与 input 按钮一并算（各版登录页结构不同）。 */
const QUICK_LOGIN_SELECTOR = 'button, [role="button"], a, input[type="button"], input[type="submit"]';
const QUICK_LOGIN_LABEL = '快捷登录';
/** 只读探测：页面上是否有可见的「快捷登录」。 */
const QUICK_LOGIN_PROBE = `(() => {
  const norm = (s) => String(s || '').replace(/\\s+/g, '');
  return [...document.querySelectorAll(${JSON.stringify(QUICK_LOGIN_SELECTOR)})].some((el) => {
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0 && norm(el.innerText || el.textContent || el.value) === ${JSON.stringify(QUICK_LOGIN_LABEL)};
  });
})()`;
/** 勾协议 + 点「快捷登录」。只点本页元素：不导航、不碰别的 window/target；没找到按钮就返回 false。 */
const QUICK_LOGIN_CLICK = `(() => {
  const norm = (s) => String(s || '').replace(/\\s+/g, '');
  const visible = (el) => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
  const button = [...document.querySelectorAll(${JSON.stringify(QUICK_LOGIN_SELECTOR)})]
    .find((el) => visible(el) && norm(el.innerText || el.textContent || el.value) === ${JSON.stringify(QUICK_LOGIN_LABEL)});
  if (!button) return false;
  const box = [...document.querySelectorAll('input[type="checkbox"]')].find((el) => !el.disabled && visible(el));
  if (box && !box.checked) box.click();
  button.click();
  return true;
})()`;
/** 共享浏览器 mychrome（omb-mychrome.service）的 CDP。 */
export const CDP_URL = (process.env.DUMATE_CDP_URL || 'http://127.0.0.1:9333').replace(/\/+$/, '');
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';
const TIMEOUT_MS = 20_000;
/** token 提前刷新余量：压在过期点上的请求会吃 401。 */
const TOKEN_SKEW_MS = 5 * 60_000;
/** expired_at 解析不出时的兜底有效期（宁早勿晚）。 */
const TOKEN_FALLBACK_MS = 50 * 60_000;

/** 名字只露首字 + 末三位（日志与汇报用）。 */
export function maskName(value) {
  const s = String(value || '');
  if (s.length <= 4) return s ? `${s[0]}…` : '';
  return `${s[0]}…${s.slice(-3)}`;
}

// ---------------------------------------------------------------- 账号存储

/** @returns {Promise<{ accounts: any[] }>} */
export async function loadStore() {
  try {
    const j = JSON.parse(await readFile(STORE_FILE, 'utf-8'));
    return { accounts: Array.isArray(j?.accounts) ? j.accounts.filter((a) => a && typeof a.cookie === 'string' && a.cookie) : [] };
  } catch {
    return { accounts: [] };
  }
}

async function saveStore(store) {
  await mkdir(dirname(STORE_FILE), { recursive: true });
  const tmp = `${STORE_FILE}.${process.pid}.tmp`;
  await writeFile(tmp, JSON.stringify(store, null, 1), { mode: 0o600 });
  await chmod(tmp, 0o600).catch(() => {});
  await rename(tmp, STORE_FILE);
}

let storeChain = Promise.resolve();
/** 存储的读-改-写串行化（签到、登录、掉线标记可能并发）。 */
function withStore(fn) {
  const next = storeChain.then(async () => {
    const store = await loadStore();
    const out = await fn(store);
    await saveStore(store);
    return out;
  });
  storeChain = next.catch(() => {});
  return next;
}

/** 对外的账号视图：永远不带 cookie。 */
export function publicAccount(a) {
  return {
    id: String(a.id),
    name: String(a.name || ''),
    uid: a.uid ? maskName(a.uid) : '',
    source: String(a.source || ''),
    addedAt: Number(a.addedAt) || 0,
    expired: a.expired === true,
  };
}

export async function listDumateAccounts() {
  return (await loadStore()).accounts.map(publicAccount);
}

/** 按 id 取完整账号（含 cookie，仅本进程内部用）；不给 id 取第一个没掉线的。 */
export async function getDumateAccount(id) {
  const { accounts } = await loadStore();
  if (id) return accounts.find((a) => a.id === id) || null;
  return accounts.find((a) => !a.expired) || accounts[0] || null;
}

/** 同一百度账号（uid 相同）只留一份：重新登录就是换 cookie。 */
export async function saveDumateAccount({ cookie, uid, name, source }) {
  return withStore((store) => {
    const key = String(uid || '');
    // 没拿到 uid 时退到显示名去重，免得同一个号每次重登都多一行
    let hit = key ? store.accounts.find((a) => String(a.uid || '') === key)
      : (name ? store.accounts.find((a) => !a.uid && a.name === name) : null);
    if (hit) {
      hit.cookie = cookie;
      hit.name = name || hit.name;
      hit.source = source || hit.source;
      hit.expired = false;
      hit.updatedAt = Date.now();
    } else {
      hit = { id: `dm-${randomUUID().slice(0, 8)}`, uid: key, name: name || '', cookie, source: source || 'mychrome', addedAt: Date.now(), expired: false };
      store.accounts.push(hit);
    }
    tokenCache.delete(hit.id);
    return publicAccount(hit);
  });
}

export async function removeDumateAccount(id) {
  return withStore((store) => {
    const before = store.accounts.length;
    store.accounts = store.accounts.filter((a) => a.id !== id);
    tokenCache.delete(id);
    return { ok: store.accounts.length !== before };
  });
}

/** 接口回 10001/401 时标记掉线（签到卡与驱动快照据此提示重新扫码）；成功调用后清掉。 */
export async function markDumateExpired(id, expired) {
  const { accounts } = await loadStore();
  const a = accounts.find((x) => x.id === id);
  if (!a || (a.expired === true) === expired) return;
  await withStore((store) => {
    const hit = store.accounts.find((x) => x.id === id);
    if (hit) hit.expired = expired;
  });
}

// ---------------------------------------------------------------- 网页接口

/** 业务失败 / 掉线判定：HTTP 401、code 10001/10006、或被 302 到登录页。 */
export function classifyWebAnswer(status, json, location = '') {
  const code = json && typeof json === 'object' ? Number(json.code) : NaN;
  const expired = status === 401 || code === 10001 || code === 10006 ||
    ((status === 302 || status === 301) && /login\.bce\.baidu\.com|passport\.baidu\.com/.test(location));
  const ok = status >= 200 && status < 300 && !!json && typeof json === 'object' &&
    (!Number.isFinite(code) || code === 0) && json.success !== false;
  const message = json && typeof json === 'object' ? String(json.message || json.msg || '') : '';
  return { ok, expired, code: Number.isFinite(code) ? code : null, message };
}

/** 带 cookie 调网页接口。返回 { ok, status, expired, code, message, result }；网络错误 status=0。 */
export async function webCall(cookie, method, path, opts = {}) {
  const base = opts.base || WEB_BASE;
  const headers = {
    Cookie: cookie,
    Accept: 'application/json, text/plain, */*',
    'Accept-Language': 'zh-CN,zh;q=0.9',
    'X-Dumate-Client-Type': 'web',
    Referer: `${base}/app`,
    Origin: base,
    'User-Agent': UA,
    ...(opts.headers || {}),
  };
  const init = { method, headers, redirect: /** @type {RequestRedirect} */ ('manual'), signal: AbortSignal.timeout(opts.timeoutMs || TIMEOUT_MS) };
  if (opts.body !== undefined) {
    headers['Content-Type'] = 'application/json';
    init.body = JSON.stringify(opts.body);
  }
  const fetchFn = opts.fetch || fetch;
  let res;
  try {
    res = await fetchFn(`${base}${path}`, init);
  } catch (e) {
    return { ok: false, status: 0, expired: false, code: null, message: `网络错误：${String(/** @type {any} */ (e)?.message || e).slice(0, 120)}`, result: null };
  }
  const text = await res.text().catch(() => '');
  let json = null;
  try { json = JSON.parse(text); } catch { /* 非 JSON（登录页 / 网关错误页） */ }
  const c = classifyWebAnswer(res.status, json, res.headers.get('location') || '');
  if (!c.message && !json) c.message = `HTTP ${res.status}`;
  const result = json && typeof json === 'object' ? (('result' in json) ? json.result : ('data' in json ? json.data : json)) : null;
  return { ...c, status: res.status, result };
}

export async function userInfo(cookie, opts = {}) {
  const r = await webCall(cookie, 'GET', '/api/dumate/user/info', opts);
  if (!r.ok) return { ok: false, expired: r.expired, error: r.message || `HTTP ${r.status}` };
  const u = r.result || {};
  return {
    ok: true,
    uid: String(u.uid || u.userId || u.bceAccountId || u.accountId || ''),
    name: String(u.displayName || u.nickname || u.name || u.userName || ''),
  };
}

export async function loginBonusInfo(cookie, opts = {}) {
  const r = await webCall(cookie, 'GET', '/api/dumate/points/loginBonusInfo', opts);
  if (!r.ok) return { ok: false, expired: r.expired, error: r.message || `HTTP ${r.status}` };
  const b = r.result || {};
  return {
    ok: true,
    hasIssued: (b.hasIssued ?? b.has_issued) === true,
    totalPoints: Number(b.totalPoints ?? b.total_points) || 0,
    totalTimes: Number(b.totalTimes ?? b.total_times) || 0,
  };
}

/** csrftoken 取自 bce-user-info cookie（console 域 POST 要它；网页域不要）。 */
export function csrfFromCookie(cookie) {
  const m = String(cookie || '').match(/(?:^|;\s*)bce-user-info=([^;]*)/);
  return m ? m[1].replace(/^["']+|["']+$/g, '') : '';
}

export async function claimLoginBonus(cookie, opts = {}) {
  const r = await webCall(cookie, 'POST', '/api/dumate/points/loginBonus', { ...opts, body: {} });
  if (r.ok || r.expired) return { ok: r.ok, expired: r.expired, error: r.ok ? '' : r.message };
  // 网页域不收时退到控制台域（magpie 插件的路径：带 csrftoken + XHR 头）。
  const c = await webCall(cookie, 'POST', '/api/dumate/points/loginBonus', {
    ...opts, base: CONSOLE_BASE, body: {},
    headers: { csrftoken: csrfFromCookie(cookie), 'X-Requested-With': 'XMLHttpRequest' },
  });
  return { ok: c.ok, expired: c.expired, error: c.ok ? '' : (r.message || c.message || `HTTP ${c.status}`) };
}

/** 积分总览：剩余 = total - used；最早到期的有效积分包单列（「到期积分」）。 */
export function parseQuotaOverview(o) {
  const total = Number(o?.totalPoints) || 0;
  const used = Number(o?.usedPoints) || 0;
  const subs = Array.isArray(o?.subscription) ? o.subscription : [];
  const incs = Array.isArray(o?.incremental) ? o.incremental : [];
  const packs = [...subs.map((p) => ({ p, kind: 'subscription' })), ...incs.map((p) => ({ p, kind: 'incremental' }))]
    .filter(({ p }) => p && typeof p === 'object')
    .map(({ p, kind }) => {
      const ptotal = Number(p.totalPoints) || 0;
      const pused = Number(p.usedPoints) || 0;
      // expireDate 可能是 null（永不过期）：Number(null)=0 会被读成 1970，必须挡掉
      const exp = p.expireDate == null ? NaN : Number(p.expireDate) * 1000;
      return {
        kind, source: String(p.source || p.packageType || ''),
        total: ptotal, used: pused, left: Math.max(0, ptotal - pused),
        expireAt: Number.isFinite(exp) && exp > 0 ? exp : null,
        active: p.status === undefined || p.status === 'active',
      };
    });
  let soonest = null;
  for (const pk of packs) {
    if (!pk.active || pk.expireAt == null || pk.left <= 0) continue;
    if (!soonest || pk.expireAt < soonest.expireAt) soonest = { expireAt: pk.expireAt, points: pk.left };
  }
  return {
    total, used, left: Math.max(0, Math.round((total - used) * 100) / 100),
    throttled: !!(o?.modelThrottleInfo && o.modelThrottleInfo.throttled),
    subscribed: !!o?.isSubscribed,
    soonest, packages: packs,
  };
}

export async function quotaOverview(cookie, opts = {}) {
  const r = await webCall(cookie, 'GET', '/api/dumate/points/quota_overview?clientType=desktop&timezone=Asia%2FShanghai', opts);
  if (!r.ok) return { ok: false, expired: r.expired, error: r.message || `HTTP ${r.status}` };
  return { ok: true, ...parseQuotaOverview(r.result || {}) };
}

// ---------------------------------------------------------------- 网关 token

/** @type {Map<string, { token: string, expiresAt: number }>} */
const tokenCache = new Map();
/** @type {Map<string, Promise<any>>} */
const tokenInflight = new Map();

export function forgetDumateToken(id) { tokenCache.delete(id); }

/**
 * 账号 → 网关 Bearer。并发共享一次刷新；token/get 回掉线时标记账号 expired。
 * @returns {Promise<{ ok: true, token: string, expiresAt: number } | { ok: false, expired: boolean, error: string }>}
 */
export async function gatewayToken(account, opts = {}) {
  const now = Date.now();
  const hit = tokenCache.get(account.id);
  if (!opts.force && hit && hit.expiresAt - TOKEN_SKEW_MS > now) return { ok: true, ...hit };
  const running = tokenInflight.get(account.id);
  if (running) return running;
  const p = (async () => {
    const r = await webCall(account.cookie, 'GET', '/api/dumate/app/token/get', opts);
    const token = r.ok ? String(r.result?.token || '') : '';
    if (!token) {
      tokenCache.delete(account.id);
      if (r.expired && !opts.noMark) await markDumateExpired(account.id, true).catch(() => {});
      return { ok: false, expired: r.expired, error: r.message || `HTTP ${r.status}` };
    }
    const parsed = r.result?.expired_at ? Date.parse(String(r.result.expired_at)) : NaN;
    const expiresAt = Number.isFinite(parsed) && parsed > Date.now() ? parsed : Date.now() + TOKEN_FALLBACK_MS;
    tokenCache.set(account.id, { token, expiresAt });
    if (account.expired && !opts.noMark) await markDumateExpired(account.id, false).catch(() => {});
    return { ok: true, token, expiresAt };
  })().finally(() => tokenInflight.delete(account.id));
  tokenInflight.set(account.id, p);
  return p;
}

// ---------------------------------------------------------------- 签到

const today = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai' }).format(new Date());
const clock = () => new Date().toLocaleTimeString('zh-CN', { hour12: false, timeZone: 'Asia/Shanghai' });
const fmtDay = (ms) => new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', month: 'numeric', day: 'numeric' }).format(new Date(ms));

export const RELOGIN_HINT = '百度搭子登录已过期：到「日常」页百度搭子卡片点「扫码登录」，用百度 App 扫码';

/** 余额一句话：「余额 1234.5 积分，11/20 到期 500」。 */
export function balanceText(q) {
  if (!q || !q.ok) return '';
  const parts = [`余额 ${q.left} 积分`];
  if (q.soonest) parts.push(`${fmtDay(q.soonest.expireAt)} 到期 ${Math.round(q.soonest.points * 100) / 100}`);
  if (q.throttled) parts.push('限速中');
  return parts.join('，');
}

/** 签到区账号行（不含 cookie）。 */
export async function listDumateCheckinAccounts() {
  const { accounts } = await loadStore();
  return accounts.map((a) => ({
    name: a.id, display: a.name ? `${a.name}` : `百度搭子 ${maskName(a.uid || a.id)}`,
    identity: `dumate:${a.uid || a.id}`, active: true, source: a.source === 'mychrome' ? '共享浏览器登录态' : '扫码登录',
    token: 'cookie',
  }));
}

/** 单账号签到（幂等：已签直接 already）。deps.api 供单测注入。 */
export async function checkinDumateAccount(account, deps = {}) {
  const api = deps.api || { loginBonusInfo, claimLoginBonus, quotaOverview };
  const display = account.name || `百度搭子 ${maskName(account.uid || account.id)}`;
  const row = (status, message, credits = 0) => ({
    name: account.id, display, identity: `dumate:${account.uid || account.id}`, active: true,
    status, message, credits, source: '扫码登录',
  });
  const before = await api.loginBonusInfo(account.cookie);
  if (!before.ok) {
    if (before.expired) return { row: row('expired', RELOGIN_HINT), expired: true, days: 0 };
    return { row: row('failed', `读取签到状态失败：${before.error}`), days: 0 };
  }
  const withBalance = async (msg) => {
    const q = await api.quotaOverview(account.cookie).catch(() => null);
    const b = balanceText(q);
    return b ? `${msg}；${b}` : msg;
  };
  if (before.hasIssued) {
    return { row: row('already', await withBalance(`今日已签到（累计 ${before.totalTimes || '?'} 天）`)), days: before.totalTimes };
  }
  const claim = await api.claimLoginBonus(account.cookie);
  if (!claim.ok) {
    if (claim.expired) return { row: row('expired', RELOGIN_HINT), expired: true, days: 0 };
    return { row: row('failed', `签到失败：${claim.error || '上游拒绝'}`), days: before.totalTimes };
  }
  const after = await api.loginBonusInfo(account.cookie);
  if (after.ok && after.hasIssued) {
    // 到账数按前后差值算（今天 +500，上游改过数额，不写死）
    const delta = Math.max(0, Math.round(after.totalPoints - before.totalPoints));
    return {
      row: row('success', await withBalance(`签到成功${delta ? ` +${delta} 积分` : ''}（累计 ${after.totalTimes || '?'} 天）`), delta),
      credits: delta, days: after.totalTimes,
    };
  }
  // 请求过了但流水里还没到账：不能说成功，交给定时器稍后重试
  return { row: row('failed', '签到请求已提交，但今日积分尚未到账，稍后自动重试'), days: before.totalTimes };
}

/** 签到中枢的平台结果（与其它平台同形）。 */
export async function checkinDumate(deps = {}) {
  const t = deps.today || today();
  const time = deps.time || clock();
  const { accounts } = deps.accounts ? { accounts: deps.accounts } : await loadStore();
  const base = { platform: 'dumate', today: t, time, credits: 0, consecutiveDays: 0 };
  if (!accounts.length) {
    return { ...base, ok: false, status: 'expired', loginRequired: true, accounts: [], message: '还没登录百度搭子：点「扫码登录」，用百度 App 扫码' };
  }
  const rows = [];
  let credits = 0;
  let days = 0;
  for (const a of accounts) {
    let r;
    try {
      r = await checkinDumateAccount(a, deps);
    } catch (e) {
      r = { row: { name: a.id, display: a.name || maskName(a.uid || a.id), identity: `dumate:${a.uid || a.id}`, active: true, status: 'failed', message: `签到异常：${String(/** @type {any} */ (e)?.message || e).slice(0, 160)}`, credits: 0, source: '扫码登录' }, days: 0 };
    }
    if (!deps.accounts) await markDumateExpired(a.id, r.expired === true).catch(() => {});
    rows.push(r.row);
    credits += Number(r.credits) || 0;
    days = Math.max(days, Number(r.days) || 0);
  }
  const st = rows.map((r) => r.status);
  const good = st.filter((s) => s === 'success' || s === 'already').length;
  let status;
  if (good === st.length) status = st.includes('success') ? 'success' : 'already';
  else if (good > 0) status = 'partial';
  else if (st.every((s) => s === 'expired')) status = 'expired';
  else status = 'failed';
  const message = rows.length === 1 ? rows[0].message : rows.map((r) => `${r.display}：${r.message}`).join('\n');
  return { ...base, ok: good > 0, status, message, credits, consecutiveDays: days, accounts: rows };
}

// ---------------------------------------------------------------- 余额（日常页额度卡 / 驱动快照）

/** vendor-quota 的 worker 形状：一行一个账号，isCreditBalance，resetAt = 最早一包到期时刻。 */
export async function fetchDumateQuota(deps = {}) {
  const { accounts } = deps.accounts ? { accounts: deps.accounts } : await loadStore();
  const quota = deps.quotaOverview || quotaOverview;
  if (!accounts.length) return { message: '未登录百度搭子（到「日常」页扫码登录）', quotas: [] };
  const quotas = [];
  const notes = [];
  for (const a of accounts) {
    const name = a.name || maskName(a.uid || a.id);
    const q = await quota(a.cookie).catch((e) => ({ ok: false, error: String(e?.message || e) }));
    if (!q.ok) { notes.push(`${name}：${q.expired ? '登录已过期，请重新扫码' : q.error}`); continue; }
    quotas.push({
      name: `dumate-${a.id}`,
      displayName: accounts.length > 1 ? `积分 · ${name}` : '积分',
      used: q.used, total: q.total, remaining: q.left,
      remainingPercentage: q.total > 0 ? Math.round((q.left / q.total) * 1000) / 10 : 0,
      unit: '积分', isCreditBalance: true,
      resetAt: q.soonest ? new Date(q.soonest.expireAt).toISOString() : null,
      ...(q.soonest ? { expiringPoints: q.soonest.points } : {}),
    });
    if (q.soonest) notes.push(`${name}：${fmtDay(q.soonest.expireAt)} 到期 ${Math.round(q.soonest.points * 100) / 100} 积分`);
  }
  return {
    account: accounts.length === 1 ? (accounts[0].name || maskName(accounts[0].uid || accounts[0].id)) : `${accounts.length} 个账号`,
    plan: '个人版积分', quotas, ...(notes.length ? { message: notes.join('；') } : {}),
  };
}

// ---------------------------------------------------------------- CDP 扫码登录（共享浏览器 mychrome）

/**
 * 极简 CDP 客户端：只连浏览器级 websocket，自己开的标签自己管。
 * 纪律：绝不 close / reload / navigate 不是本模块创建的标签（尤其 antigravity 等用户标签）。
 */
export async function cdpConnect(cdpUrl = CDP_URL, deps = {}) {
  const fetchFn = deps.fetch || fetch;
  const WS = deps.WebSocket || globalThis.WebSocket;
  const v = await (await fetchFn(`${cdpUrl}/json/version`, { signal: AbortSignal.timeout(5_000) })).json();
  const ws = new WS(v.webSocketDebuggerUrl);
  await new Promise((ok, bad) => {
    const t = setTimeout(() => bad(new Error('cdp_connect_timeout')), 8_000);
    ws.onopen = () => { clearTimeout(t); ok(undefined); };
    ws.onerror = () => { clearTimeout(t); bad(new Error('cdp_connect_failed')); };
  });
  let seq = 0;
  /** @type {Map<number, (m: any) => void>} */
  const pending = new Map();
  ws.onmessage = (e) => {
    let m;
    try { m = JSON.parse(String(e.data)); } catch { return; }
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
  };
  /** @returns {Promise<any>} */
  const call = (method, params = {}, sessionId, timeoutMs = 15_000) => new Promise((ok, bad) => {
    const id = ++seq;
    const t = setTimeout(() => { pending.delete(id); bad(new Error(`cdp_timeout ${method}`)); }, timeoutMs);
    pending.set(id, (m) => { clearTimeout(t); if (m.error) bad(new Error(`${method}: ${m.error.message}`)); else ok(m.result); });
    ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
  });
  return { call, close: () => { try { ws.close(); } catch { /* 已关 */ } } };
}

async function readLoginState() {
  try { return JSON.parse(await readFile(LOGIN_STATE_FILE, 'utf-8')); } catch { return null; }
}
async function writeLoginState(st) {
  await mkdir(dirname(LOGIN_STATE_FILE), { recursive: true }).catch(() => {});
  if (!st) { await writeFile(LOGIN_STATE_FILE, '{}').catch(() => {}); return; }
  await writeFile(LOGIN_STATE_FILE, JSON.stringify(st)).catch(() => {});
}

/** CDP cookie 列表 → 请求头。只要百度系域；同名取域更具体的那份。缺 BDUSS 或 console 会话返回 stage。 */
export function cookieHeaderFrom(cookies) {
  const byName = new Map();
  for (const c of cookies || []) {
    if (!c || !c.value || !/(^|\.)baidu\.com$/.test(String(c.domain || '').replace(/^\./, ''))) continue;
    const prev = byName.get(c.name);
    if (!prev || String(c.domain || '').length > String(prev.domain || '').length) byName.set(c.name, c);
  }
  const has = (n) => byName.has(n);
  const session = has('bce-long-term-sessionid') || has('bce-sessionid');
  const stage = !has('BDUSS') ? 'need_login' : (!session ? 'need_console' : 'ready');
  const header = [...byName.values()].map((c) => `${c.name}=${c.value}`).join('; ');
  return { stage, header: stage === 'ready' ? header : '' };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function closeOurTab(cdp, st) {
  if (!st) return;
  if (st.targetId) await cdp.call('Target.closeTarget', { targetId: st.targetId }).catch(() => {});
  if (st.browserContextId) await cdp.call('Target.disposeBrowserContext', { browserContextId: st.browserContextId }).catch(() => {});
}

/** 是否要开隔离上下文：共享浏览器里已有一个有效的百度搭子号时，新扫码走隔离上下文（多账号，不顶掉共享登录）。 */
export function wantsIsolatedContext(accounts) {
  return (accounts || []).some((a) => a.source === 'mychrome' && a.expired !== true);
}

async function captureFromTab(cdp, st, deps) {
  const ck = await cdp.call('Storage.getCookies', st.browserContextId ? { browserContextId: st.browserContextId } : {});
  return cookieHeaderFrom(ck?.cookies || []);
}

/** 读到 cookie 后验证并存号，然后关掉自己的标签。 */
async function finishLogin(cdp, st, header, deps) {
  const info = await (deps.userInfo || userInfo)(header);
  if (!info.ok) return { ok: false, loggedIn: false, error: `登录态校验失败：${info.error}` };
  const saved = await saveDumateAccount({ cookie: header, uid: info.uid, name: info.name, source: st.browserContextId ? 'isolated' : 'mychrome' });
  await closeOurTab(cdp, st);
  await writeLoginState(null);
  return { ok: true, loggedIn: true, account: saved.name || maskName(saved.uid) };
}

/**
 * 出码：在共享浏览器新开一个后台标签打开百度智能云登录页，取二维码图片（不截屏，读资源内容）。
 * 共享浏览器若已登录百度，会直接跳到控制台 → 立即存号，返回 loggedIn。
 */
export async function dumateLoginStart(deps = {}) {
  let cdp;
  try {
    cdp = await (deps.cdpConnect || cdpConnect)(CDP_URL, deps);
  } catch (e) {
    return { ok: false, loggedIn: false, error: `连不上共享浏览器（${CDP_URL}，omb-mychrome.service）：${String(/** @type {any} */ (e)?.message || e)}` };
  }
  try {
    await closeOurTab(cdp, await readLoginState());
    const { accounts } = await loadStore();
    const st = { targetId: '', browserContextId: '', startedAt: Date.now(), settled: false };
    if (wantsIsolatedContext(accounts)) {
      st.browserContextId = (await cdp.call('Target.createBrowserContext', { disposeOnDetach: false })).browserContextId;
    }
    st.targetId = (await cdp.call('Target.createTarget', { url: LOGIN_URL, background: true, ...(st.browserContextId ? { browserContextId: st.browserContextId } : {}) })).targetId;
    await writeLoginState(st);
    const { sessionId } = await cdp.call('Target.attachToTarget', { targetId: st.targetId, flatten: true });
    await cdp.call('Page.enable', {}, sessionId);
    const ev = async (expression) => (await cdp.call('Runtime.evaluate', { expression, returnByValue: true }, sessionId))?.result?.value;
    const deadline = Date.now() + (deps.waitMs ?? 25_000);
    while (Date.now() < deadline) {
      await sleep(deps.pollMs ?? 1_000);
      const href = String(await ev('location.href').catch(() => '') || '');
      if (/console\.bce\.baidu\.com/.test(href)) {
        const c = await captureFromTab(cdp, st, deps);
        if (c.stage === 'ready') return await finishLogin(cdp, st, c.header, deps);
      }
      const src = await ev(`(() => { const i = document.querySelector('img.tang-pass-qrcode-img'); return i && i.complete && i.naturalWidth > 0 && !/loading/i.test(i.src) ? i.src : ''; })()`).catch(() => '');
      if (src) {
        const tree = await cdp.call('Page.getFrameTree', {}, sessionId);
        const rc = await cdp.call('Page.getResourceContent', { frameId: tree.frameTree.frame.id, url: src }, sessionId);
        const png = rc.base64Encoded ? rc.content : Buffer.from(String(rc.content), 'binary').toString('base64');
        await cdp.call('Target.detachFromTarget', { sessionId }).catch(() => {});
        return { ok: true, loggedIn: false, qrPng: png };
      }
    }
    await cdp.call('Target.detachFromTarget', { sessionId }).catch(() => {});
    return { ok: false, loggedIn: false, error: '共享浏览器打开了百度登录页，但 25 秒内没等到二维码' };
  } catch (e) {
    return { ok: false, loggedIn: false, error: `扫码登录出错：${String(/** @type {any} */ (e)?.message || e).slice(0, 200)}` };
  } finally {
    cdp.close();
  }
}

/** 轮询：扫码后百度先种 BDUSS，再要落到控制台一次才有 bce 会话 cookie；齐了就验证存号、关标签。 */
export async function dumateLoginPoll(deps = {}) {
  const raw = await readLoginState();
  if (!raw || !raw.targetId) {
    const { accounts } = await loadStore();
    return { ok: true, loggedIn: accounts.some((a) => !a.expired) };
  }
  // 旧版 state 没有这两个字段：补 0 才不会被当成“刚点过”。
  const st = { ...raw, settleClickCount: raw.settleClickCount ?? 0, lastSettleClickAt: raw.lastSettleClickAt ?? 0 };
  let cdp;
  try {
    cdp = await (deps.cdpConnect || cdpConnect)(CDP_URL, deps);
  } catch (e) {
    return { ok: false, loggedIn: false, error: `连不上共享浏览器：${String(/** @type {any} */ (e)?.message || e)}` };
  }
  try {
    const targets = (await cdp.call('Target.getTargets', {}))?.targetInfos || [];
    if (!targets.some((t) => t.targetId === st.targetId)) {
      await writeLoginState(null);
      return { ok: false, loggedIn: false, error: '登录标签已被关闭，请重新点「扫码登录」' };
    }
    const c = await captureFromTab(cdp, st, deps);
    if (c.stage === 'ready') return await finishLogin(cdp, st, c.header, deps);
    if (c.stage === 'need_console') {
      // 只 attach 本模块自己开的标签
      const { sessionId } = await cdp.call('Target.attachToTarget', { targetId: st.targetId, flatten: true });
      try {
        const ev = async (expression) => (await cdp.call('Runtime.evaluate', { expression, returnByValue: true }, sessionId))?.result?.value;
        const href = String(await ev('location.href').catch(() => '') || '');
        const quickLogin = (await ev(QUICK_LOGIN_PROBE).catch(() => false)) === true;
        let hostname = '';
        try { hostname = new URL(href).hostname; } catch { /* 页面还没加载完 */ }
        if (hostname === 'login.bce.baidu.com' || quickLogin) {
          // 停在登录页：勾协议再点「快捷登录」，最多 3 次、间隔 10 秒。
          const now = deps.now?.() ?? Date.now();
          const count = Number(st.settleClickCount) || 0;
          const last = Number(st.lastSettleClickAt) || 0;
          if (count < SETTLE_CLICK_LIMIT && now - last >= SETTLE_CLICK_INTERVAL_MS) {
            const clicked = (await ev(QUICK_LOGIN_CLICK).catch(() => false)) === true;
            if (clicked) await writeLoginState({ ...st, settleClickCount: count + 1, lastSettleClickAt: now });
          }
        } else if (!st.settled) {
          await cdp.call('Page.navigate', { url: SETTLE_URL }, sessionId).catch(() => {});
          await writeLoginState({ ...st, settled: true });
        }
      } finally {
        await cdp.call('Target.detachFromTarget', { sessionId }).catch(() => {});
      }
    }
    return { ok: true, loggedIn: false, stage: c.stage };
  } catch (e) {
    return { ok: false, loggedIn: false, error: `读取登录状态出错：${String(/** @type {any} */ (e)?.message || e).slice(0, 200)}` };
  } finally {
    cdp.close();
  }
}
