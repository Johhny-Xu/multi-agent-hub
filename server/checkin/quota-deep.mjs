// @ts-check
// 深度配额读取：需要「凭据解密 / 设备指纹 / 令牌续期」的一家一个实现。
//
// 为什么单独成文件：qoder.mjs、qoder-device.mjs、trae-checkin.mjs 都会 import
// vendor-quota.mjs 取 fetchJsonSmart。若 vendor-quota 在**初始化期**静态 import
// 本模块，就会形成 ESM 循环依赖（TDZ 报错）。因此 vendor-quota 只在调用期
// `await import('./quota-deep.mjs')`，本模块内部同理全部用动态 import。
//
// 输出契约（与 vendor-quota.getAllQuotas 一致）：
//   { account, plan, quotas: Array<Quota>, message?, fetchedAt 补在调用方 }
//   Quota = { name, displayName, used, total, remaining, remainingPercentage,
//             resetAt, unlimited, isCreditBalance?, unit? }
// ⚠️ quotas 必须是**数组**——前端 popup 与侧栏胶囊只认数组形态。

import { homedir } from 'node:os';

const HOME = homedir();

// ---------------------------------------------------------------- utils
function toNum(value, fallback = 0) {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() && Number.isFinite(Number(value))) return Number(value);
  return fallback;
}

function round2(value) {
  return Math.round(Number(value || 0) * 100) / 100;
}

/** 上游 resetAt 可能是 ISO / 秒 / 毫秒；统一成 ISO 字符串，非法值返回 null */
function toIso(value) {
  if (value === undefined || value === null || value === '') return null;
  try {
    if (typeof value === 'number') return new Date(value < 1e12 ? value * 1000 : value).toISOString();
    const text = String(value).trim();
    if (/^\d+$/.test(text)) {
      const n = Number(text);
      return new Date(n < 1e12 ? n * 1000 : n).toISOString();
    }
    const d = new Date(text);
    return Number.isNaN(d.getTime()) ? null : d.toISOString();
  } catch {
    return null;
  }
}

/** 9999 年那种「永不到期」的时间戳对 UI 没意义，丢掉 */
function usefulReset(value) {
  const iso = toIso(value);
  if (!iso) return null;
  return new Date(iso).getUTCFullYear() > 9000 ? null : iso;
}

/** 单个额度池 → Quota；全零池返回 null（上游经常下发 total=0 的空计划额度） */
function poolQuota(label, pool, { unit = '', resetAt = null } = {}) {
  if (!pool || typeof pool !== 'object') return null;
  const total = toNum(pool.total);
  const used = toNum(pool.used);
  const remainRaw = pool.remaining;
  const remaining = remainRaw === undefined || remainRaw === null ? Math.max(0, total - used) : toNum(remainRaw);
  if (total <= 0 && used <= 0 && remaining <= 0) return null;
  const denominator = total > 0 ? total : Math.max(remaining + used, remaining, 1);
  return {
    name: label,
    displayName: label,
    used: round2(used),
    total: round2(denominator),
    remaining: round2(remaining),
    remainingPercentage: denominator > 0 ? round2((remaining / denominator) * 100) : 0,
    resetAt,
    unlimited: false,
    isCreditBalance: true,
    unit: unit || String(pool.unit || ''),
  };
}

async function fetchJsonRaw(url, options = {}, timeoutMs = 15_000) {
  const res = await fetch(url, { ...options, signal: AbortSignal.timeout(timeoutMs) });
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { json = null; }
  return { status: res.status, ok: res.ok, json, text };
}

// ---------------------------------------------------------------- Qoder
const QODER_QUOTA_PATH = '/api/v2/quota/usage';

/**
 * 配额接口的两种请求头（完整设备指纹 → 最小四件套）。
 * 签到侧的回读和这里的展示共用同一套：端点、region、设备身份都必须一致，
 * 否则「领了 100 分」和「额度没动」会被判成两个账号。
 */
async function qoderQuotaProbe(worker, token, device, fetchJson = fetchJsonRaw) {
  const { qoderHeaders, qoderMinimalHeaders, qoderRegion } = await import('./qoder.mjs');
  const url = `${qoderRegion(worker).openapi}${QODER_QUOTA_PATH}`;
  return {
    url,
    calls: [
      () => fetchJson(url, { headers: qoderHeaders(worker, token, device) }),
      () => fetchJson(url, { headers: qoderMinimalHeaders(token) }),
    ],
    headers: (nextToken = token) => qoderHeaders(worker, nextToken, device),
  };
}

/**
 * 只读读取配额接口的原始 JSON，供签到在 claim 前后回读额度。
 * 不续期令牌、不写凭据；请求失败 / 非 200 / 解析失败一律 null —— 回读失败只影响确认，不能中断签到。
 */
export async function readQoderQuotaUsageJson(worker, token, device = null, deps = {}) {
  const probe = await qoderQuotaProbe(worker, token, device, deps.fetchJson || fetchJsonRaw);
  for (const call of probe.calls) {
    let res = null;
    try { res = await call(); } catch { res = null; }
    if (res?.status === 200 && res.json && typeof res.json === 'object') return res.json;
  }
  return null;
}

/**
 * Qoder / Qoder-CN 实时配额。
 *
 * 端点：`GET {openapi}/api/v2/quota/usage`
 * 头：必须带完整设备指纹（Cosy-MachineToken / MachineCode / MachineType +
 * Cosy-Version），只用最小四件套会被拒。实测响应：
 *   { userType, usageType:"credits", totalUsagePercentage:0.13, isQuotaExceeded,
 *     expiresAt, userQuota:{total,used,remaining,percentage,unit},
 *     addOnQuota:{...}, dedicatedResourcePackages:[...], orgResourcePackage:{...} }
 * 注：`totalUsagePercentage` 是**已用**占比（0.13 = 用了 13%），不是剩余。
 */
async function qoderQuota(worker) {
  const { readQoderCredential, qoderRegion, isQoderTokenExpired, refreshQoderToken } =
    await import('./qoder.mjs');
  const cred = await readQoderCredential(HOME, worker);
  if (!cred?.ok) {
    const reason = cred?.reason === 'not_logged_in' ? '未登录' : (cred?.error || cred?.reason || '凭据不可读');
    return { message: `${qoderRegion(worker).name} 配额不可用：${reason}。` };
  }
  const entry = cred.primary;
  const account = entry.display || entry.identity || worker;
  const region = qoderRegion(worker);
  const plan = `${region.name}${entry.user?.userType ? ` · ${entry.user.userType}` : ''}`;

  let token = entry.token;
  let refreshToken = entry.refreshToken;
  /** 令牌过期就地续期（不落盘，配额是只读展示，不抢签到的写权） */
  const renew = async () => {
    if (!refreshToken) return false;
    const r = await refreshQoderToken(worker, refreshToken);
    if (!r?.token) return false;
    token = r.token;
    refreshToken = r.refreshToken || refreshToken;
    return true;
  };
  if (isQoderTokenExpired(entry)) await renew();

  let device = null;
  try {
    const { resolveQoderDevice } = await import('./qoder-device.mjs');
    device = await resolveQoderDevice(worker, { home: HOME, uid: entry.user?.uid || '' });
  } catch { device = null; }

  const probe = await qoderQuotaProbe(worker, token, device);
  const attempt = (headers) => fetchJsonRaw(probe.url, { headers });
  const calls = probe.calls;

  let res = null;
  let lastError = '';
  for (const call of calls) {
    try {
      res = await call();
    } catch (e) {
      lastError = e?.message || String(e);
      res = null;
      continue;
    }
    if (res.ok) break;
    if (res.status === 401 || res.status === 403) {
      if (await renew()) {
        try { res = await attempt(probe.headers(token)); } catch (e) { lastError = e?.message || String(e); }
        if (res?.ok) break;
      }
    }
    lastError = res ? `HTTP ${res.status}` : lastError;
  }

  if (!res?.ok || !res.json) {
    return { account, plan, message: `${region.name} 凭据在线（${account}），配额接口暂不可用${lastError ? `：${lastError}` : ''}。` };
  }

  const data = res.json || {};
  const quotas = [];
  const userQ = poolQuota('计划额度', data.userQuota);
  if (userQ) quotas.push(userQ);
  const addOnQ = poolQuota('加油包', data.addOnQuota);
  if (addOnQ) quotas.push(addOnQ);
  for (const pkg of Array.isArray(data.dedicatedResourcePackages) ? data.dedicatedResourcePackages : []) {
    if (!pkg || typeof pkg !== 'object') continue;
    const label = pkg.name || pkg.package_name || pkg.displayName || '专属资源包';
    const q = poolQuota(String(label), pkg);
    if (q) quotas.push(q);
  }
  const orgQ = poolQuota('组织资源包', data.orgResourcePackage);
  if (orgQ) quotas.push(orgQ);

  if (!quotas.length) {
    const usedPct = toNum(data.totalUsagePercentage, 0);
    if (data.usageType) {
      quotas.push({
        name: '账户额度',
        displayName: '账户额度',
        used: round2(usedPct * 100),
        total: 100,
        remaining: round2(Math.max(0, 100 - usedPct * 100)),
        remainingPercentage: round2(Math.max(0, 100 - usedPct * 100)),
        resetAt: usefulReset(data.expiresAt),
        unlimited: false,
        unit: String(data.usageType || ''),
      });
    }
  }

  const exceeded = data.isQuotaExceeded === true;
  if (!quotas.length) {
    return {
      account,
      plan,
      message: `${region.name} 凭据在线（${account}）${exceeded ? '，额度已耗尽' : ''}；上游未返回额度明细。`,
    };
  }
  return {
    account,
    plan: exceeded ? `${plan} · 额度耗尽` : plan,
    quotas,
    ...(exceeded ? { message: '账户额度已耗尽，请充值或更换账号。' } : {}),
  };
}

// ---------------------------------------------------------------- Trae CN
const TRAE_ENTITLE_PATH = '/trae/api/v2/pay/user_current_entitlement_list';
// HUB src/trae.ts:64 TRAE_ENT_USAGE_PATH：entitlement 列表不可用时的兜底端点
const TRAE_ENT_USAGE_PATH = '/trae/api/v2/pay/ide_user_ent_usage';
const TRAE_STATUS_PATH = '/trae/api/v2/ug/checkin_credits/status';
const TRAE_REQ_BODY = '{"require_usage": true}';
// HUB trae-credits.ts:331：兜底请求体带 req_source: 2
const TRAE_ENT_USAGE_BODY = '{"require_usage": true, "req_source": 2}';
const TRAE_STATUS_BODY = '{"req_source":1}';

/**
 * 权益包 → 账号积分汇总。credits_limit = -1 表示**无限**（HUB trae-credits.ts
 * 的对齐结论：remain = Σ(credits_limit − usage.credits_amount)，-1 是无限包，
 * 不并入求和，单独以 unlimited 标出）；credits_limit ≤ 0 的其余形态跳过。
 */
export function traePacksSummary(packs) {
  if (!Array.isArray(packs)) return null;
  let total = 0;
  let used = 0;
  let unlimited = false;
  let found = false;
  for (const pack of packs) {
    const limit = toNum(pack?.entitlement_base_info?.quota?.credits_limit);
    const packUsed = toNum(pack?.usage?.credits_amount);
    if (limit === -1) { unlimited = true; found = true; used += Math.max(0, packUsed); continue; }
    if (limit > 0) { found = true; total += limit; used += Math.max(0, packUsed); }
  }
  if (!found) return null;
  return { total, used, unlimited };
}

/**
 * Trae CN 账号积分 + 今日签到。
 *
 * 令牌解析与签到共用一套：桌面端 storage.json 的 accessToken 常常已过期，
 * 真正可用的是 `~/.agenthub/trae-token-cache.json` 里续期后的那份，所以要先
 * 合并缓存再判失效，401/1001 时用 refreshToken 现场续期一次。
 * 积分主端点是 user_current_entitlement_list；**失败时用 ide_user_ent_usage
 * （req_source: 2）兜底**（HUB src/trae-credits.ts:331-340 的口径）。
 * 只读：绝不调用 claim 端点。
 */
async function traeQuota() {
  const trae = await import('./trae-checkin.mjs');
  const {
    readTraeDesktopAuth, readTraeTokenCache, applyCachedTraeToken, resolveTraeDeviceId,
    jwtUid, jwtExpiry, traeHeaders, refreshTraeToken, TRAE_HOST, TRAE_CODE,
  } = trae;

  let auth = null;
  try {
    auth = await readTraeDesktopAuth(HOME);
  } catch { auth = null; }
  if (!auth) return { message: 'Trae CN 凭据不可用（未找到 storage.json 登录态）。' };

  let token = String(auth.accessToken || '').trim();
  let refreshToken = String(auth.refreshToken || '').trim();
  const uid = String(auth.uid || jwtUid(token) || '').trim();

  let cache = null;
  try { cache = await readTraeTokenCache(HOME); } catch { cache = null; }
  const cached = cache && uid ? cache[uid] : null;
  if (cached?.accessToken) {
    const merged = applyCachedTraeToken({ token, refreshToken }, cached);
    token = merged.token;
    refreshToken = merged.refreshToken;
  }

  let deviceId = '';
  try { deviceId = await resolveTraeDeviceId(auth, { home: HOME }); } catch { deviceId = auth.deviceId || ''; }

  const account = uid ? `UID:${uid}` : (deviceId ? `设备:${String(deviceId).slice(-6)}` : 'Trae CN');
  const plan = uid ? `Trae CN (${String(uid).slice(-6)})` : 'Trae CN';

  const post = async (path, body) => {
    try {
      return await fetchJsonRaw(TRAE_HOST + path, {
        method: 'POST',
        headers: traeHeaders(token, deviceId),
        body,
      }, 15_000);
    } catch (e) {
      return { status: 0, ok: false, json: null, text: e?.message || String(e) };
    }
  };

  const renew = async () => {
    if (!refreshToken) return false;
    const keys = auth.privateKeyPem && auth.publicKeyPem
      ? { privateKeyPem: auth.privateKeyPem, publicKeyPem: auth.publicKeyPem, deviceId, machineId: auth.machineId || '' }
      : null;
    try {
      const r = await refreshTraeToken({ refreshToken, keys });
      if (!r?.token) return false;
      token = r.token;
      refreshToken = r.refreshToken || refreshToken;
      return true;
    } catch { return false; }
  };

  const isAuthDead = (res) => {
    const code = Number(res?.json?.code);
    return res?.status === 401 || res?.status === 403 || TRAE_CODE.auth.has(code);
  };

  let entitle = await post(TRAE_ENTITLE_PATH, TRAE_REQ_BODY);
  if (isAuthDead(entitle) && await renew()) entitle = await post(TRAE_ENTITLE_PATH, TRAE_REQ_BODY);

  // 兜底：主端点失败（续期后仍失败）时改问 ide_user_ent_usage（HUB trae-credits.ts:331）
  let usedFallback = false;
  if (!entitle.ok || !entitle.json) {
    let fallback = await post(TRAE_ENT_USAGE_PATH, TRAE_ENT_USAGE_BODY);
    if (isAuthDead(fallback) && await renew()) fallback = await post(TRAE_ENT_USAGE_PATH, TRAE_ENT_USAGE_BODY);
    if (fallback.ok && fallback.json) {
      entitle = fallback;
      usedFallback = true;
    }
  }

  let status = await post(TRAE_STATUS_PATH, TRAE_STATUS_BODY);
  if (isAuthDead(status) && await renew()) status = await post(TRAE_STATUS_PATH, TRAE_STATUS_BODY);

  if (!entitle.ok || !entitle.json) {
    const why = isAuthDead(entitle)
      ? `令牌已被服务端注销（${entitle.status || entitle.json?.code || 'auth'}），自动续期也失败，请让 Trae 客户端重新登录`
      : `积分接口不可用${entitle.status ? `（HTTP ${entitle.status}）` : ''}`;
    const days = jwtExpiry(token) ? Math.max(0, Math.round((jwtExpiry(token) * 1000 - Date.now()) / 86_400_000)) : null;
    return { account, plan, message: `${why}${days !== null ? `；当前 JWT 约剩 ${days} 天` : ''}。` };
  }

  const root = entitle.json?.data && typeof entitle.json.data === 'object' ? entitle.json.data : entitle.json;
  const summary = root?.usage_summary && typeof root.usage_summary === 'object' ? root.usage_summary : {};
  const packs = Array.isArray(root?.user_entitlement_pack_list) ? root.user_entitlement_pack_list : [];
  const packsSummary = traePacksSummary(packs);

  let total = toNum(summary.total_amount);
  let used = toNum(summary.consumed_amount);
  if (packsSummary) {
    // 权益包口径优先于 usage_summary：无限包（credits_limit=-1）只有这里能看到
    total = packsSummary.total;
    used = packsSummary.used;
  } else if (total <= 0) {
    // usage_summary 缺失时按权益包求和（只算 credits_limit > 0 的包）
    let sumTotal = 0;
    let sumUsed = 0;
    let found = false;
    for (const pack of packs) {
      const limit = toNum(pack?.entitlement_base_info?.quota?.credits_limit);
      if (limit > 0) {
        found = true;
        sumTotal += limit;
      }
      sumUsed += toNum(pack?.usage?.credits_amount);
    }
    if (found) { total = sumTotal; used = sumUsed; }
  }

  const unlimited = packsSummary?.unlimited === true;
  const quotas = [];
  if (unlimited) {
    quotas.push({
      name: '账号积分',
      displayName: '账号积分',
      used: round2(used),
      total: 0,
      remaining: 0,
      remainingPercentage: 0,
      resetAt: null,
      unlimited: true,
      isCreditBalance: true,
      unit: 'credits',
    });
  } else if (total > 0 || used > 0) {
    const remaining = Math.max(0, total - used);
    quotas.push({
      name: '账号积分',
      displayName: '账号积分',
      used: round2(used),
      total: round2(total),
      remaining: round2(remaining),
      remainingPercentage: total > 0 ? round2((remaining / total) * 100) : 0,
      resetAt: null,
      unlimited: false,
      isCreditBalance: true,
      unit: 'credits',
    });
  }

  const checkedIn = status?.json?.checked_in === true;
  const checkinEnabled = status?.json?.enable !== false;
  if (checkinEnabled) {
    const now = new Date();
    const nextMidnight = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1, 0, 0, 0, 0);
    quotas.push({
      name: '每日签到',
      displayName: '每日签到',
      used: checkedIn ? 1 : 0,
      total: 1,
      remaining: checkedIn ? 0 : 1,
      remainingPercentage: checkedIn ? 0 : 100,
      resetAt: nextMidnight.toISOString(),
      unlimited: false,
    });
  }

  if (!quotas.length) {
    return { account, plan, message: `Trae CN 凭据在线（${account}），上游未返回积分明细。` };
  }
  return { account, plan, quotas, ...(usedFallback ? { message: '主端点不可用，本次积分数据来自 ide_user_ent_usage 兜底。' } : {}) };
}

// ---------------------------------------------------------------- 出口
const DEEP_HANDLERS = {
  'qoder': () => qoderQuota('qoder'),
  'qoder-cn': () => qoderQuota('qoder-cn'),
  'traecode': () => traeQuota(),
};

/**
 * @param {'qoder'|'qoder-cn'|'traecode'} worker
 * @returns {Promise<{account?:string, plan?:string, quotas?:object[], message?:string}>}
 */
export async function getDeepQuota(worker) {
  const handler = DEEP_HANDLERS[worker];
  if (!handler) return { message: `未实现的深度配额 worker: ${worker}` };
  try {
    return await handler();
  } catch (e) {
    return { message: `配额查询异常: ${e?.message || String(e)}` };
  }
}

export const DEEP_WORKERS = Object.keys(DEEP_HANDLERS);

// 供离线自检使用：判定某家是否需要深度通道
export function isDeepQuotaWorker(worker) {
  return Object.hasOwn(DEEP_HANDLERS, worker);
}
