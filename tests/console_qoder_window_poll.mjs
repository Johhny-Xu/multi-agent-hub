// @ts-check
// Qoder 国际版「窗口内补拉」的回归测试。
//
// 根因（实测 2026-11-01 / 11-02，三个国际版账号）：
//   上游每日活动行按 UTC+8 10:00 开窗、到次日 09:59 关窗，窗口内随时可能下发。
//   旧逻辑「这会儿没看到活动行」就判 already（或把重试推到下一期开窗），
//   结果 11-01 10:09 → 11-02 00:57 整整 14.8 小时零重试，那一期 100 Credits 直接作废；
//   同一期在 11-02 00:57 再看就有了，+100 到账。
//   现在：窗口还开着就继续补拉（开窗 1 小时内每 10 分钟，之后每小时），
//        并按平台给足重试预算，别让通用 8 次预算在窗口中途就耗光。
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const tempHome = await mkdtemp(join(tmpdir(), 'agenthub-qoder-window-'));
process.env.AGENTHUB_HOME = tempHome;
process.env.AGENTHUB_CHECKIN_STATE = join(tempHome, 'checkin-state.json');
process.env.QODER_UMID_NO_INSTALL = '1';
process.env.QODER_MACHINE_TOKEN = 'tok-test';
process.env.QODER_MACHINE_CODE = 'code-test';
process.env.QODER_MACHINE_TYPE = 'type-test';

const {
  qoderOpenWindow, qoderPollAt, qoderClock, qoderClockDay, qoderTodayWindowStart,
  qoderEpoch, qoderInWindow, qoderWindowDay, qoderNextWindowStart,
  qoderPeriodNeedsCheck, platformNeedsRetry, aggregatePlatformStatus,
  selectAutoCheckinPlatforms, checkinQoder, retryBudgetFor,
  startAutoCheckinScheduler, stopAutoCheckinScheduler, nextAutoCheckinDelay,
} = await import('../console/checkin.mjs');
const { encryptLegacyQoderUser } = await import('../console/qoder.mjs');

const MACHINE_ID = '0123456789abcdef';
const JWT = ['eyJhbGciOiJIUzI1NiJ9', Buffer.from(JSON.stringify({ exp: 9999999999, sub: 'u1' })).toString('base64url'), 'sig'].join('.');
const CRED = JSON.stringify({ token: JWT, refreshToken: 'rt-window-1', uid: 'u1', nickname: 'WindowTest' });

for (const dir of ['.qoder', '.qoder-cn']) {
  await mkdir(join(tempHome, dir, '.auth'), { recursive: true });
  await writeFile(join(tempHome, dir, '.auth', 'machine_id'), MACHINE_ID);
  await writeFile(join(tempHome, dir, '.auth', 'user'), encryptLegacyQoderUser(CRED, MACHINE_ID));
}

test.after(async () => { await rm(tempHome, { recursive: true, force: true }); });

/** 2026-11-02 00:00（UTC+8） */
const T = (hhmm) => Date.parse(`2026-11-02T${hhmm}:00+08:00`) / 1000;

// ---------------------------------------------------------------- 开放窗口

test('00:00–09:59 之间开放的是上一期（今天 09:59 关闭，下一期今天 10:00 开）', () => {
  const win = qoderOpenWindow(T('00:00'));
  assert.equal(win.start, qoderTodayWindowStart(T('00:00') - 86400), '起点是昨天 10:00');
  assert.equal(win.end, qoderTodayWindowStart(T('00:00')) - 60, '终点是今天 09:59');
  assert.equal(win.nextStart, qoderTodayWindowStart(T('00:00')), '下一期今天 10:00 开');
});

test('10:00 之后开放的是本期（明天 09:59 关闭，下一期明天 10:00 开）', () => {
  const win = qoderOpenWindow(T('10:00'));
  assert.equal(win.start, qoderTodayWindowStart(T('10:00')));
  assert.equal(win.end, win.start + 86400 - 60, '终点是明天 09:59');
  assert.equal(win.nextStart, win.start + 86400);
});

test('qoderClock 按 UTC+8 输出 HH:MM', () => {
  assert.equal(qoderClock(T('10:00')), '10:00');
  assert.equal(qoderClock(T('00:00')), '00:00');
  assert.equal(qoderClock(T('09:59')), '09:59');
});

test('活动时间兼容秒、毫秒和 ISO 字符串，不会把 ISO 静默当成 NaN/0', () => {
  const startSec = T('10:00');
  const endSec = startSec + 86400 - 60;
  const iso = {
    startAt: '2026-11-02T02:00:00Z',
    endAt: '2026-11-03T01:59:00Z',
  };
  const millis = { startAt: startSec * 1000, endAt: endSec * 1000 };
  for (const row of [iso, millis]) {
    assert.equal(qoderEpoch(row.startAt), startSec);
    assert.equal(qoderEpoch(row.endAt), endSec);
    assert.equal(qoderInWindow(row, T('10:00')), true, '开窗瞬间算在窗口内');
    assert.equal(qoderInWindow(row, endSec), false, '关窗瞬间不算在窗口内');
    assert.equal(qoderWindowDay(row), '2026-11-02');
    assert.equal(qoderNextWindowStart(row), Date.parse('2026-11-03T02:00:00Z') / 1000);
  }
});

test('qoderClockDay 带日期（窗口跨自然日，光有 HH:MM 说不清）', () => {
  assert.equal(qoderClockDay(T('10:00')), '11-02 10:00');
  assert.equal(qoderClockDay(T('09:59')), '11-02 09:59');
});

// ---------------------------------------------------------------- 补拉节奏

test('开窗后 1 小时内每 10 分钟补拉一次（参考实现 v1.0.12）', () => {
  const win = qoderOpenWindow(T('10:00'));
  assert.equal(qoderPollAt(T('10:05'), win), T('10:15'));
  assert.equal(qoderPollAt(T('10:55'), win), T('11:05'));
});

test('开窗 1 小时之后改成每小时一次，一直补到窗口关闭前 5 分钟', () => {
  const win = qoderOpenWindow(T('10:00'));
  assert.equal(qoderPollAt(T('11:30'), win), T('12:30'));
  // 窗口内第 8 小时（18:00）→ 19:00
  assert.equal(qoderPollAt(win.start + 8 * 3600, win), win.start + 9 * 3600);
});

test('窗口快关了就把下一次安排在窗口关闭前 5 分钟，而不是跳过本期', () => {
  const win = qoderOpenWindow(T('10:00'));
  // 明天 09:00 → 最晚 09:54（明天 09:59 关闭）
  const tomorrowNine = T('10:00') + 86400 - 3600;
  assert.equal(qoderPollAt(tomorrowNine, win), win.end - 300);
});

test('窗口已经进入最后 5 分钟 → 等下一期开窗', () => {
  const win = qoderOpenWindow(T('10:00'));
  const lastMoment = win.end - 120;   // 明天 09:57
  assert.equal(qoderPollAt(lastMoment, win), win.nextStart);
});

test('补拉点永远落在本期窗口之内，不会越过窗口去等下一期', () => {
  // 这正是丢分的那条路：旧逻辑在 00:00–09:59 直接把重试推到 10:00，
  // 而本期窗口 09:59 才关 → 窗口内上游补发的活动行再也看不到。
  const now = Math.floor(Date.now() / 1000);
  const win = qoderOpenWindow(now);
  const at = qoderPollAt(now, win);
  if (now < win.end - 300) {
    assert.ok(at <= win.end, `补拉点 ${at} 必须落在窗口 ${win.start}–${win.end} 内`);
    assert.ok(at > now, '补拉点必须在未来');
    assert.ok(at - now <= 3600, `补拉间隔不应超过 1 小时，实际 ${at - now}`);
  } else {
    assert.equal(at, win.nextStart, '窗口尾段才等下一期');
  }
});

// ---------------------------------------------------------------- 重试预算

test('Qoder 的重试预算放宽到 32 次，通用平台仍是 8 次', () => {
  assert.equal(retryBudgetFor('qoder'), 32);
  assert.equal(retryBudgetFor('qoder-cn'), 32);
  assert.equal(retryBudgetFor('codebuddy'), 8);
  assert.equal(retryBudgetFor('traecode'), 8);
});

test('重试预算按平台走：8 次用完也不该提前放弃 Qoder', () => {
  const today = new Date().toISOString().slice(0, 10);
  const now = Math.floor(Date.now() / 1000);
  // 通用平台（没给平台名、状态里也没有 retryBudget）仍然受 8 次限制
  assert.equal(platformNeedsRetry({ lastDate: today, status: 'pending', retryCount: 8 }, today, now), false);
  assert.equal(platformNeedsRetry({ lastDate: today, status: 'pending', retryCount: 7 }, today, now), true);
  // Qoder：状态里写了 32 次预算 → 8 次时继续补
  assert.equal(platformNeedsRetry({ lastDate: today, status: 'pending', retryCount: 8, retryBudget: 32 }, today, now), true);
  assert.equal(platformNeedsRetry({ lastDate: today, status: 'pending', retryCount: 32, retryBudget: 32 }, today, now), false);
  // 老状态文件没有 retryBudget 字段时，按平台名兜底，Qoder 不能被 8 次卡死
  assert.equal(platformNeedsRetry({ lastDate: today, status: 'pending', retryCount: 8 }, today, now, 'qoder'), true);
  assert.equal(platformNeedsRetry({ lastDate: today, status: 'pending', retryCount: 8 }, today, now, 'traecode'), false);
});

// ---------------------------------------------------------------- 平台级原因优先级

test('平台级 pendingReason：等上游下发排在等开窗前面（前者正在丢分）', () => {
  const agg = aggregatePlatformStatus([
    { status: 'pending', pendingReason: 'awaiting_window', retryAt: 2000 },
    { status: 'pending', pendingReason: 'awaiting_campaign', retryAt: 900 },
  ]);
  assert.equal(agg.pendingReason, 'awaiting_campaign');
  assert.equal(agg.retryAt, 900);
});

test('缺设备身份 / 额度冷却的优先级高于等开窗', () => {
  assert.equal(aggregatePlatformStatus([
    { status: 'pending', pendingReason: 'awaiting_window' },
    { status: 'pending', pendingReason: 'identity_missing' },
  ]).pendingReason, 'identity_missing');
  assert.equal(aggregatePlatformStatus([
    { status: 'pending', pendingReason: 'awaiting_window' },
    { status: 'pending', pendingReason: 'quota_cooldown' },
  ]).pendingReason, 'quota_cooldown');
});

// ---------------------------------------------------------------- 端到端（空活动列表）

test('上游只返回常驻 VIEW_DETAILS 行时：判 pending + 窗口内补拉，不判 already', async () => {
  const original = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({
    campaigns: [{
      campaignId: 'v1', campaignKey: 'act-20261020-944', actionType: 'VIEW_DETAILS',
      claimStatus: 'CLAIMED', startAt: 1792548000, endAt: 1796054340,
    }],
  }), { status: 200, headers: { 'content-type': 'application/json' } });
  let out;
  try {
    out = await checkinQoder('qoder');
  } finally {
    globalThis.fetch = original;
  }
  const now = Math.floor(Date.now() / 1000);
  const win = qoderOpenWindow(now);
  assert.equal(out.status, 'pending', `活动行没下发必须判 pending，实际 ${out.status}`);
  assert.notEqual(out.status, 'already', '绝对不能判 already（那会让当天彻底不再重试）');
  assert.equal(out.pendingReason, 'awaiting_campaign');
  assert.ok(out.retryAt > now, '必须排下一次补拉');
  if (now < win.end - 300) {
    assert.ok(out.retryAt <= win.end, `补拉点 ${out.retryAt} 必须落在本期窗口 ${win.start}–${win.end} 内`);
    assert.ok(out.retryAt - now <= 3600, '补拉间隔不应超过 1 小时');
  }
});

test('00:57 本期活动行已领 → 等下一期开窗（不空转）', async () => {
  const now = T('00:57');
  const win = qoderOpenWindow(now);
  const original = globalThis.fetch;
  const originalNow = Date.now;
  Date.now = () => now * 1000;
  globalThis.fetch = async () => new Response(JSON.stringify({
    campaigns: [{
      campaignId: 'c1', campaignKey: 'act-20261101-825', actionType: 'CLAIM_BENEFIT',
      claimStatus: 'CLAIMED', startAt: win.start, endAt: win.end,
      benefit: { kind: 'CREDITS', amount: 100 },
    }],
  }), { status: 200, headers: { 'content-type': 'application/json' } });
  let out;
  try {
    out = await checkinQoder('qoder');
  } finally {
    globalThis.fetch = original;
    Date.now = originalNow;
  }
  assert.equal(out.status, 'pending');
  assert.equal(out.pendingReason, 'awaiting_window');
  assert.equal(out.retryAt, win.nextStart, '已领就等下一期开窗，别在窗口里空转');
});

test('00:57 领到上一期活动：照领 +100，但今天状态必须是 pending 等 10:00', async () => {
  const now = T('00:57');
  const win = qoderOpenWindow(now);
  const original = globalThis.fetch;
  const originalNow = Date.now;
  Date.now = () => now * 1000;
  globalThis.fetch = async (url) => {
    if (String(url).includes('/claim')) {
      return new Response(JSON.stringify({ success: true, data: { status: 'CLAIMED' } }), { status: 200 });
    }
    return new Response(JSON.stringify({
      campaigns: [{
        campaignId: 'previous-period', actionType: 'CLAIM_BENEFIT', claimStatus: 'CLAIMABLE',
        startAt: win.start, endAt: win.end, benefit: { kind: 'CREDITS', amount: 100 },
      }],
    }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  let out;
  try {
    out = await checkinQoder('qoder');
  } finally {
    globalThis.fetch = original;
    Date.now = originalNow;
  }
  assert.equal(out.status, 'pending', '上一期的分不能记成今天已签，否则 10:00 新一期不补');
  assert.equal(out.pendingReason, 'awaiting_window');
  assert.equal(out.retryAt, win.nextStart);
  assert.match(out.message, /上一期已领取.*\+100 Credits/, '上一期实际领取仍要在消息里如实报告');
});

test('跨期 success 遗留状态：10:00 后定时器必须强制核对当前期', () => {
  const today = '2026-11-02';
  const legacy = { lastDate: today, lastTime: '00:57:10', status: 'success' };
  assert.equal(qoderPeriodNeedsCheck(legacy, today, T('10:00')), true);
  assert.ok(selectAutoCheckinPlatforms({ 'qoder-cn': legacy }, today, T('10:00')).includes('qoder-cn'));
  assert.equal(qoderPeriodNeedsCheck({ ...legacy, lastTime: '10:05:00' }, today, T('10:30')), false);
  assert.equal(qoderPeriodNeedsCheck(legacy, today, T('09:59')), false, '开窗前不空转');
});

test('10:00 后本期活动行已领 → already，不再排重试', async () => {
  const now = T('10:00');
  const win = qoderOpenWindow(now);
  const original = globalThis.fetch;
  const originalNow = Date.now;
  Date.now = () => now * 1000;
  globalThis.fetch = async () => new Response(JSON.stringify({
    campaigns: [{
      campaignId: 'c2', actionType: 'CLAIM_BENEFIT', claimStatus: 'CLAIMED',
      startAt: win.start, endAt: win.end, benefit: { kind: 'CREDITS', amount: 100 },
    }],
  }), { status: 200, headers: { 'content-type': 'application/json' } });
  let out;
  try {
    out = await checkinQoder('qoder');
  } finally {
    globalThis.fetch = original;
    Date.now = originalNow;
  }
  assert.equal(out.status, 'already');
  assert.ok(!out.retryAt);
});

test('过期 CLAIMABLE 不会触发领取，只处理当前窗口活动', async () => {
  const now = T('10:30');
  const win = qoderOpenWindow(now);
  const original = globalThis.fetch;
  const originalNow = Date.now;
  const claims = [];
  Date.now = () => now * 1000;
  globalThis.fetch = async (url, options = {}) => {
    const target = String(url);
    if (target.includes('/claim')) {
      claims.push(target);
      return new Response(JSON.stringify({ success: true, data: { status: 'CLAIMED' } }), { status: 200 });
    }
    return new Response(JSON.stringify({ campaigns: [
      { campaignId: 'expired', actionType: 'CLAIM_BENEFIT', claimStatus: 'CLAIMABLE', startAt: win.start - 86400, endAt: win.end - 86400 },
      { campaignId: 'current', actionType: 'CLAIM_BENEFIT', claimStatus: 'CLAIMABLE', startAt: win.start, endAt: win.end, benefit: { amount: 100 } },
    ] }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  let out;
  try {
    out = await checkinQoder('qoder');
  } finally {
    globalThis.fetch = original;
    Date.now = originalNow;
  }
  assert.equal(out.status, 'success');
  assert.equal(claims.length, 1);
  assert.ok(claims[0].includes('/campaigns/current/claim'));
});

test('真实调度器按最近的 retryAt 在 10 分钟后唤醒', async () => {
  const nowSec = T('10:00');
  const state = {
    autoCheckin: true,
    platforms: { qoder: { lastDate: '2026-11-02', status: 'pending', retryCount: 0, retryBudget: 32, retryAt: nowSec + 600 } },
    history: [],
  };
  await writeFile(process.env.AGENTHUB_CHECKIN_STATE, JSON.stringify(state), 'utf-8');
  assert.equal(nextAutoCheckinDelay(state, nowSec * 1000), 600000);
  const originalNow = Date.now;
  const originalSetTimeout = globalThis.setTimeout;
  let resolveDelay;
  const scheduled = new Promise((resolve) => { resolveDelay = resolve; });
  Date.now = () => nowSec * 1000;
  globalThis.setTimeout = (fn, delay) => {
    resolveDelay(delay);
    const handle = originalSetTimeout(() => {}, 0x7fffffff);
    handle.unref();
    return handle;
  };
  try {
    startAutoCheckinScheduler();
    assert.equal(await scheduled, 600000);
  } finally {
    stopAutoCheckinScheduler();
    globalThis.setTimeout = originalSetTimeout;
    Date.now = originalNow;
  }
});
