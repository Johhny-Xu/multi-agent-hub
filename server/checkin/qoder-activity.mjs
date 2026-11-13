// @ts-check
// Qoder / Qoder CN 每日活动领取的窗口与领取判定助手（C2-W3：从 checkin.mjs 原样搬出，逻辑未改）。
// checkin.mjs 只做 import + re-export，现有 import 方无需改动。

// ---------------------------------------------------------------- Qoder / Qoder CN 活动领取
// 实现方式移植自 L0NE-6/Qoder-Daily（见 README 致谢）：
//   1. 活动列表**不能**带 ?forceRefresh=true（带上会被服务端过滤掉每日活动行，列表恒空）；
//   2. 只认 actionType=CLAIM_BENEFIT 的活动，VIEW_DETAILS 这类常驻活动不参与领取；
//   3. 请求必须带本机 UMID 组件生成的设备风控头，否则国际版每日活动整行不下发。

export const QODER_BENEFIT_ACTION = 'CLAIM_BENEFIT';

/** 从活动接口响应里取 CLAIM_BENEFIT 行（兼容 campaigns / data.campaigns 两种包装） */
export function extractQoderCampaigns(payload) {
  const isBenefit = (row) => String(row?.actionType || row?.action_type || '').toUpperCase() === QODER_BENEFIT_ACTION;
  const data = payload && typeof payload === 'object' && payload.data && typeof payload.data === 'object' ? payload.data : {};
  let rows = Array.isArray(payload?.campaigns) && payload.campaigns.length
    ? payload.campaigns
    : Array.isArray(data.campaigns) ? data.campaigns : [];
  if (!rows.length) {
    // 兜底：有些版本把活动行下沉到更深层，按 actionType 递归捞回来
    const found = [];
    const seen = new Set();
    const visit = (node, depth = 0) => {
      if (!node || depth > 8) return;
      if (Array.isArray(node)) {
        for (const item of node) visit(item, depth + 1);
        return;
      }
      if (typeof node !== 'object') return;
      const id = node.campaignId || node.campaign_id;
      if (id && isBenefit(node)) {
        const key = String(id);
        if (!seen.has(key)) {
          seen.add(key);
          found.push(node);
        }
        return;
      }
      for (const value of Object.values(node)) visit(value, depth + 1);
    };
    visit(payload);
    rows = found;
  }
  return rows.filter((row) => row && typeof row === 'object' && isBenefit(row));
}

export const qoderClaimStatus = (row) => String(row?.claimStatus || row?.claim_status || '').toUpperCase();

/** 活动是否在有效期内。开源项目 qoder-checkin 就是靠 startAt~endAt 判断「今日已领」，
 *  不加这个判断会把上一期 CLAIMED 的老活动当成今天已领（Qoder CN 报「已签到」但客户端还有领取按钮就是这个原因）。
 *  没有窗口字段时不做限制，避免把正常数据判死。 */
export function qoderEpoch(value) {
  if (value === null || value === undefined || value === '') return 0;
  const numeric = Number(value);
  if (Number.isFinite(numeric) && numeric > 0) {
    // 兼容秒级和毫秒级时间戳；上游一旦换成 ISO 字符串，Number() 会得到 NaN，
    // 旧代码会把它当 0 从而「永远在窗口内」，这里一并归一化。
    return numeric > 1e12 ? Math.floor(numeric / 1000) : Math.floor(numeric);
  }
  const parsed = Date.parse(String(value));
  return Number.isFinite(parsed) ? Math.floor(parsed / 1000) : 0;
}

export function qoderInWindow(row, nowSec = Math.floor(Date.now() / 1000)) {
  const s = qoderEpoch(row?.startAt ?? row?.start_at);
  const e = qoderEpoch(row?.endAt ?? row?.end_at);
  if (!e) return true;
  return s <= nowSec && nowSec < e;
}

/** 活动按 UTC+8 每天 10:00 刷新（上游文案：每日 10:00（UTC+8）刷新）。
 *  所以一个「期」是 [今天 10:00, 明天 09:59]，跨自然日；判断「今天这一期」
 *  必须用窗口起始日的 UTC+8 日期，不能只用 now 落在窗口内。 */
const QODER_TZ_OFFSET_SEC = 8 * 3600;

export function qoderDayKey(sec) {
  return new Date((Number(sec) + QODER_TZ_OFFSET_SEC) * 1000).toISOString().slice(0, 10);
}

export function qoderWindowDay(row) {
  const s = qoderEpoch(row?.startAt ?? row?.start_at);
  return s ? qoderDayKey(s) : '';
}

/**
 * 今天这一期是否已经领过。
 * 只判「窗口内」不够：昨天的窗口会一直持续到今天 10:00，于是 00:00–10:00 之间
 * 会把昨天的 CLAIMED 当成「今日已签」，卡片显示已签到、客户端按钮却还能点。
 */
export function qoderClaimedToday(row, nowSec = Math.floor(Date.now() / 1000)) {
  if (!['CLAIMED', 'GRANTED'].includes(qoderClaimStatus(row))) return false;
  if (!qoderInWindow(row, nowSec)) return false;
  const day = qoderWindowDay(row);
  // 没有 startAt 就无法证明是「今天这一期」，退回旧行为（窗口内即已领），
  // 免得把正常数据判成待打卡、一天重试八次。
  if (!day) return true;
  return day === qoderDayKey(nowSec);
}

/** 今天这一期（UTC+8 10:00）的开始时间；用于「上游还没下发活动」时安排重试 */
export function qoderTodayWindowStart(nowSec = Math.floor(Date.now() / 1000)) {
  const dayKey = qoderDayKey(nowSec);
  const midnight = Date.parse(`${dayKey}T00:00:00+08:00`) / 1000;
  return Number.isFinite(midnight) ? midnight + 10 * 3600 : 0;
}

/** 当前窗口结束后下一期的开始时间；上游 endAt 是本期最后一分钟，+60s 就是下期 10:00 */
export function qoderNextWindowStart(row) {
  const e = qoderEpoch(row?.endAt ?? row?.end_at);
  return e ? e + 60 : 0;
}

/** 上一期已领、今天这一期还没开时，算出「几点开窗」。
 *  0:00–10:00 之间打开控制台就是这种状态：不能报「已签到」（卡片会骗人），
 *  报 pending + retryAt，让定时器到点再来一次。没有可等待的窗口时返回 null。 */
export function qoderPendingWindow(staleClaimed, nowSec = Math.floor(Date.now() / 1000)) {
  const rows = Array.isArray(staleClaimed) ? staleClaimed : [];
  const prev = rows.find((item) => qoderNextWindowStart(item) > nowSec) || rows[0];
  const nextStart = prev ? qoderNextWindowStart(prev) : 0;
  if (!nextStart || nowSec >= nextStart || nextStart - nowSec > 12 * 3600) return null;
  const hhmm = new Date((nextStart + QODER_TZ_OFFSET_SEC) * 1000).toISOString().slice(11, 16);
  return { retryAt: nextStart, message: `上一期已领，今日 ${hhmm}（UTC+8）开新一期；到点会自动重试` };
}

/** 秒级时间戳 → UTC+8 的 HH:MM（活动窗口的一切时刻都按 UTC+8 表述） */
export function qoderClock(sec) {
  return new Date((Number(sec) + QODER_TZ_OFFSET_SEC) * 1000).toISOString().slice(11, 16);
}

/** 秒级时间戳 → UTC+8 的 MM-DD HH:MM（窗口跨自然日，要带日期才说得清） */
export function qoderClockDay(sec) {
  return new Date((Number(sec) + QODER_TZ_OFFSET_SEC) * 1000).toISOString().slice(5, 16).replace('T', ' ');
}

/**
 * 当前**仍然开放**的活动窗口。
 * 上游「每日 10:00（UTC+8）刷新」，一期 = [D 10:00, D+1 09:59]，跨自然日：
 *   - 00:00–09:59 之间开放的是**上一期**（今天 09:59 关闭）
 *   - 10:00 之后开放的是**本期**（明天 09:59 关闭）
 * @returns {{start:number, end:number, nextStart:number}} 秒级时间戳
 */
export function qoderOpenWindow(nowSec = Math.floor(Date.now() / 1000)) {
  const todayOpen = qoderTodayWindowStart(nowSec);
  if (nowSec < todayOpen) {
    // 上一期还开着：今天 09:59 关闭，下一期今天 10:00 开
    return { start: qoderTodayWindowStart(nowSec - 86400), end: todayOpen - 60, nextStart: todayOpen };
  }
  return { start: todayOpen, end: todayOpen + 86400 - 60, nextStart: todayOpen + 86400 };
}

/**
 * 窗口内的补拉节奏。
 *   - 开窗后 1 小时内每 10 分钟一次（参考实现 v1.0.12：10 分钟 × 6 次补拉）
 *   - 之后每小时一次，一直补到窗口关闭前 5 分钟
 *   - 窗口即将关闭 → 等下一期开窗
 *
 * ⚠️ 关键：不能因为「这会儿没看到活动行」就把重试推到下一期开窗。
 *   那是丢每日 100 Credits 的真根因：2026-11-01 10:09 活动行还没下发被判 already，
 *   当天再没重试过（历史里 10:09 → 次日 00:57 整整 14.8 小时零重试），
 *   整期 100 分作废；同一期在 11-02 00:57 再看就有了，+100 到账。
 */
export function qoderPollAt(nowSec, win = qoderOpenWindow(nowSec)) {
  const fastUntil = win.start + 3600;          // 开窗后 1 小时内密集补拉
  const step = nowSec < fastUntil ? 600 : 3600;
  const lastChance = win.end - 300;            // 窗口关闭前 5 分钟是最后一次机会
  if (nowSec >= lastChance) return win.nextStart;
  return Math.min(nowSec + step, lastChance);
}

export function qoderResponseMessage(res) {
  const json = res?.json || {};
  const data = json.data && typeof json.data === 'object' ? json.data : {};
  return String(
    json.message || json.msg || data.message || data.msg
    || json.error?.message || data.error?.message || json.error || ''
  ).trim();
}

export function qoderBenefit(item) {
  const benefit = item?.benefit || {};
  return Number(benefit.amount ?? benefit.value ?? benefit.credits ?? 0) || 0;
}

/**
 * 账户总剩余额度（对齐 L0NE-6/Qoder-Daily v1.0.22 的 quota_total_remaining）。
 * claim 响应只说明「受理了」，真正到没到账要看额度回读；这个函数就是回读那一半。
 * 纯函数：不发请求、不刷新令牌、不落盘。
 */
export function qoderQuotaTotalRemaining(json) {
  const data = json?.data && typeof json.data === 'object' ? json.data : json;
  if (!data || typeof data !== 'object') return null;
  let total = 0;
  let seen = false;
  const add = (pool) => {
    if (!pool || typeof pool !== 'object') return;
    const raw = pool.remaining;
    if (raw === null || raw === undefined || raw === '') return;
    const amount = Number(raw);
    if (!Number.isFinite(amount)) return;
    total += amount;
    seen = true;
  };
  add(data.userQuota);
  add(data.addOnQuota);
  for (const pool of Array.isArray(data.dedicatedResourcePackages) ? data.dedicatedResourcePackages : []) add(pool);
  add(data.orgResourcePackage);
  return seen ? total : null;
}

/**
 * claim 前后的额度回读判定（对齐上游 v1.0.22）：只有正增长才算签到成功。
 * 零增长/负增长可能是并发消耗，不能虚报成功；回读不可用只能报「已受理」。
 */
export function qoderClaimConfirm(before, after, amount) {
  const asNumber = (value) => (typeof value === 'number' && Number.isFinite(value) ? value : null);
  const from = asNumber(before);
  const to = asNumber(after);
  const face = asNumber(amount) ?? 0;
  if (from !== null && to !== null) {
    const delta = to - from;
    if (delta > 0) return { confirmed: true, delta, message: `签到成功，额度回读 +${delta}（${from} → ${to}）` };
    return { confirmed: false, delta, message: `签到已受理，额度回读待确认（${from} → ${to}）` };
  }
  if (face > 0) {
    return { confirmed: false, delta: null, message: `签到已受理，额度到账待确认（活动面值 ${face} credits，回读暂不可用）` };
  }
  return { confirmed: false, delta: null, message: '签到已受理，积分到账待回读确认' };
}

const qoderSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * 领取一次活动并回读额度确认。依赖全部注入：单测用假 claim / 假回读 / 假 sleep，
 * 不必真等 2 秒，也不会碰网络。回读异常一律当 null，不能把已受理的 claim 判成失败。
 */
export async function qoderClaimWithConfirm({ claim, readQuota, amount, sleep = qoderSleep, waitMs = 2000 }) {
  let before = null;
  try { before = await readQuota(); } catch { before = null; }
  const claimRes = await claim();
  const outcome = qoderClaimOutcome(claimRes);
  if (outcome.status !== 'success') {
    return { outcome, confirmed: false, delta: null, message: outcome.message || '', before, after: null };
  }
  await sleep(waitMs);
  let after = null;
  try { after = await readQuota(); } catch { after = null; }
  const confirm = qoderClaimConfirm(before, after, amount);
  return { outcome, ...confirm, before, after };
}

/**
 * 额度类 403 分流（对齐参考实现 L0NE-6/Qoder-Daily v1.0.11）。
 *
 * 上游对「额度耗尽」和「每日计费次数上限」也回 403，与凭证被拒同码不同因：
 * - 112 / 带 pricingUrl → 额度耗尽，冷却 30 分钟；
 * - 110 / Billing daily count exceeded → 每日计费上限，冷却到本地零点（封顶 6 小时）。
 * 这两种**不是**凭证失效：既不能触发续期，也不能报「登录态失效」让用户白登录。
 */
export function qoderQuotaCooldown(res) {
  const raw = `${JSON.stringify(res?.json ?? '')} ${res?.text ?? ''}`.replace(/\\/g, '');
  if (raw.includes('pricingUrl') || /"code"\s*:\s*"?112\b/.test(raw)) {
    return { kind: 'exhausted', seconds: 30 * 60 };
  }
  if (raw.includes('Billing daily count exceeded') || /"code"\s*:\s*"?110\b/.test(raw)) {
    const now = new Date();
    const midnight = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1).getTime();
    const seconds = Math.max(60, Math.min(6 * 3600, Math.floor((midnight - now.getTime()) / 1000)));
    return { kind: 'daily', seconds };
  }
  return { kind: '', seconds: 0 };
}

/**
 * 会话失效判定（对齐参考实现 L0NE-6/Qoder-Daily 的 auth_dead_response）。
 *
 * 触发续期的只有两种：
 * - 普通 401/403（**排除**额度类 112/110 —— 那是额度问题，不是凭证问题）；
 * - 业务码 `105` / `10019901001`（上游的「会话失效」码）。
 */
export function qoderAuthDead(res) {
  if (res?.status === 401 || res?.status === 403) return !qoderQuotaCooldown(res).kind;
  const json = res?.json || {};
  const data = json.data && typeof json.data === 'object' ? json.data : {};
  const codes = [json.code, json.Code, data.code, data.Code, json.errorCode, data.errorCode]
    .map((v) => String(v ?? '').trim());
  return codes.some((c) => c === '105' || c === '10019901001');
}

/**
 * 领取结果归一化。
 *
 * 判定口径（对齐参考实现 L0NE-6/Qoder-Daily v1.0.6）：
 * - **只有** `409 + ALREADY_CLAIMED / REPLAYED` 算「今日已领」；
 * - `BLOCKED` / `SAME_PERSON_ALREADY_CLAIMED` 是**没领到**（同设备别的号领过、风控拦截），
 *   当成已领会报成功但其实没到账；
 * - 额度类 403（112/pricingUrl、110）由 qoderQuotaCooldown 单独分流，不算登录失效。
 */
export function qoderClaimOutcome(res) {
  const json = res?.json || {};
  const data = json.data && typeof json.data === 'object' ? json.data : json;
  const status = String(data.status || json.status || '').toUpperCase();
  const code = String(data.code || json.code || data.errorCode || json.errorCode || '').toUpperCase();
  const message = qoderResponseMessage(res);
  const replayed = data.replayed === true || json.replayed === true
    || ['REPLAYED', 'ALREADY_CLAIMED'].includes(status)
    || ['REPLAYED', 'ALREADY_CLAIMED'].includes(code);
  // BLOCKED / SAME_PERSON_ALREADY_CLAIMED 是「没领到」（同设备别的号领过、风控拦截），
  // 不能当成「今日已领」——否则会报成功但其实没到账。对齐参考实现 v1.0.6 的判定。
  const blocked = ['BLOCKED', 'SAME_PERSON_ALREADY_CLAIMED'].includes(status)
    || ['BLOCKED', 'SAME_PERSON_ALREADY_CLAIMED'].includes(code)
    || ['REDEMPTION_CODE_OUT_OF_STOCK', 'CAMPAIGN_NOT_ACTIVE', 'ACHIEVEMENT_NOT_COMPLETED',
      'RISK_BLOCKED', 'RISK_DEPENDENCY_UNAVAILABLE'].includes(code);
  if (res?.status === 401 || res?.status === 403) {
    // 额度类 403 先分流：它是额度问题，不是登录失效，判 expired 会让用户白登录一次
    const quota = qoderQuotaCooldown(res);
    if (quota.kind) {
      return {
        status: 'cooldown',
        kind: quota.kind,
        message: quota.kind === 'exhausted'
          ? '额度已耗尽（HTTP 403 / code 112），账号冷却 30 分钟'
          : '每日计费次数已达上限（HTTP 403 / code 110），账号冷却至零点（最长 6 小时）',
        cooldownSeconds: quota.seconds,
      };
    }
    return { status: 'expired', message: message || '登录态已失效，请重新登录 Qoder CLI' };
  }
  if (res?.status === 404 || res?.status === 405) {
    return { status: 'unsupported', message: message || '该区域暂未开放活动领取接口' };
  }
  // 只有 409 + ALREADY_CLAIMED/REPLAYED 才算「已领」（参考实现 v1.0.6）
  if (res?.status === 409 && (replayed || code === 'ALREADY_CLAIMED')) {
    return { status: 'already', message: message || '今日已领取过' };
  }
  if (replayed) {
    return { status: 'already', message: message || '今日已领取过' };
  }
  if (blocked) {
    const map = {
      SAME_PERSON_ALREADY_CLAIMED: '同一设备身份下的其他账号已领取',
      REDEMPTION_CODE_OUT_OF_STOCK: '今日名额已发完，等待下一轮',
      CAMPAIGN_NOT_ACTIVE: '活动尚未开放或已结束',
      ACHIEVEMENT_NOT_COMPLETED: '活动条件尚未完成',
      RISK_BLOCKED: '设备风控未通过',
      RISK_DEPENDENCY_UNAVAILABLE: '设备风控依赖暂不可用',
    };
    return { status: 'failed', message: message || map[code] || '领取被阻塞' };
  }
  if (['CLAIMED', 'GRANTED', 'SUCCESS', 'OK'].includes(status) || data.success === true || data.claimed === true) {
    return { status: 'success', message: message || '领取成功' };
  }
  return { status: 'failed', message: `活动领取返回 [${res?.status ?? '-'}/${status || '-'}]：${message || '未知错误'}` };
}
