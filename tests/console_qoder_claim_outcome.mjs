// @ts-check
// Qoder 领取判定 / 额度分流 / 设备身份地区隔离 / 重试判定的回归测试。
//
// 对齐参考实现 L0NE-6/Qoder-Daily：
//   v1.0.6  只有 409 + ALREADY_CLAIMED/REPLAYED 才算「已领」，BLOCKED 是「没领到」
//   v1.0.8  地区隔离：国际版运行环境码 3、国内版 0；兜底客户端版本 1.1.69
//   v1.0.11 额度类 403（112/pricingUrl、110）单独分流，不触发续期、不判登录失效
//   v1.0.12 开窗补拉：活动未下发时排重试，不能落「已签」状态
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const tempHome = await mkdtemp(join(tmpdir(), 'agenthub-qoder-claim-'));
process.env.AGENTHUB_HOME = tempHome;
process.env.AGENTHUB_CHECKIN_STATE = join(tempHome, 'checkin-state.json');
// 不去 npm 拉 UMID 组件：本文件只测判定逻辑，设备身份由下面的 env 三件套兜底
process.env.QODER_UMID_NO_INSTALL = '1';
process.env.QODER_MACHINE_TOKEN = 'tok-test';
process.env.QODER_MACHINE_CODE = 'code-test';
process.env.QODER_MACHINE_TYPE = 'type-test';

const { qoderClaimOutcome, qoderQuotaCooldown, platformNeedsRetry, aggregatePlatformStatus, checkinQoder } = await import('../checkin/checkin.mjs');
const { encryptLegacyQoderUser } = await import('../checkin/qoder.mjs');
const device = await import('../checkin/qoder-device.mjs');

const MACHINE_ID = '0123456789abcdef';
const JWT = ['eyJhbGciOiJIUzI1NiJ9', Buffer.from(JSON.stringify({ exp: 9999999999, sub: 'u1' })).toString('base64url'), 'sig'].join('.');
const CRED = JSON.stringify({ token: JWT, refreshToken: 'rt-claim-1', uid: 'u1', nickname: 'ClaimTest' });

for (const dir of ['.qoder', '.qoder-cn']) {
  await mkdir(join(tempHome, dir, '.auth'), { recursive: true });
  await writeFile(join(tempHome, dir, '.auth', 'machine_id'), MACHINE_ID);
  await writeFile(join(tempHome, dir, '.auth', 'user'), encryptLegacyQoderUser(CRED, MACHINE_ID));
}

function res(payload, status = 200) {
  return { status, ok: status >= 200 && status < 300, json: payload, text: JSON.stringify(payload) };
}

test.after(async () => { await rm(tempHome, { recursive: true, force: true }); });

// ---------------------------------------------------------------- 领取判定

test('只有 409 + ALREADY_CLAIMED / REPLAYED 才算今日已领', () => {
  assert.equal(qoderClaimOutcome(res({ code: 'ALREADY_CLAIMED' }, 409)).status, 'already');
  assert.equal(qoderClaimOutcome(res({ data: { status: 'REPLAYED' } }, 409)).status, 'already');
  assert.equal(qoderClaimOutcome(res({ data: { replayed: true } }, 200)).status, 'already');
});

test('409 + BLOCKED 不算已领（没领到就不能报成功）', () => {
  const out = qoderClaimOutcome(res({ code: 'BLOCKED' }, 409));
  assert.equal(out.status, 'failed', 'BLOCKED 必须算失败，不能算已领');
  assert.ok(!/已领取/.test(out.message), `不应出现「已领取」措辞：${out.message}`);
});

test('SAME_PERSON_ALREADY_CLAIMED 算没领到，并说明同设备别的号领过', () => {
  const out = qoderClaimOutcome(res({ code: 'SAME_PERSON_ALREADY_CLAIMED' }, 200));
  assert.equal(out.status, 'failed');
  assert.match(out.message, /同一设备身份下的其他账号已领取/);
});

test('领取成功 / 活动未开始 / 风控拦截 的判定', () => {
  assert.equal(qoderClaimOutcome(res({ data: { status: 'CLAIMED' } })).status, 'success');
  assert.equal(qoderClaimOutcome(res({ data: { status: 'GRANTED' } })).status, 'success');
  assert.equal(qoderClaimOutcome(res({ code: 'CAMPAIGN_NOT_ACTIVE' })).status, 'failed');
  assert.equal(qoderClaimOutcome(res({ code: 'RISK_BLOCKED' })).status, 'failed');
});

test('401/403 判定登录失效，404/405 判定该地区未开放', () => {
  assert.equal(qoderClaimOutcome(res({}, 401)).status, 'expired');
  assert.equal(qoderClaimOutcome(res({}, 403)).status, 'expired');
  assert.equal(qoderClaimOutcome(res({}, 404)).status, 'unsupported');
  assert.equal(qoderClaimOutcome(res({}, 405)).status, 'unsupported');
});

// ---------------------------------------------------------------- 额度分流

test('额度类 403 单独分流，不当成登录失效', () => {
  const exhausted = qoderQuotaCooldown(res({ code: 112, message: 'quota exhausted', pricingUrl: 'https://x/pricing' }, 403));
  assert.equal(exhausted.kind, 'exhausted');
  assert.equal(exhausted.seconds, 30 * 60, '额度耗尽冷却 30 分钟');

  const daily = qoderQuotaCooldown(res({ code: 110, message: 'Billing daily count exceeded' }, 403));
  assert.equal(daily.kind, 'daily');
  assert.ok(daily.seconds > 0 && daily.seconds <= 6 * 3600, `每日上限冷却应落在 0~6 小时内，实际 ${daily.seconds}`);

  const plain = qoderQuotaCooldown(res({ message: 'forbidden' }, 403));
  assert.equal(plain.kind, '', '普通 403 不是额度问题，不该触发冷却');
});

test('额度 403 走 pending + 冷却，不判 expired、也不触发续期', async () => {
  const seen = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (url, options = {}) => {
    seen.push(String(url));
    return new Response(JSON.stringify({ code: 112, message: 'quota exhausted', pricingUrl: 'https://x/pricing' }), {
      status: 403, headers: { 'content-type': 'application/json' },
    });
  };
  let out;
  try {
    out = await checkinQoder('qoder');
  } finally {
    globalThis.fetch = original;
  }
  assert.equal(out.status, 'pending', `额度 403 应判 pending，实际 ${out.status}`);
  assert.equal(out.pendingReason, 'quota_cooldown');
  assert.ok(out.retryAt > Math.floor(Date.now() / 1000), '额度冷却必须排重试');
  assert.ok(!seen.some((u) => u.includes('/refresh')), '额度 403 不能触发 token 续期');
});

test('领取阶段 112 保留 exhausted 类型，不误报每日计费上限', async () => {
  const original = globalThis.fetch;
  globalThis.fetch = async (url) => {
    if (String(url).includes('/claim')) {
      return new Response(JSON.stringify({ code: 112, message: 'quota exhausted', pricingUrl: 'https://x/pricing' }), { status: 403 });
    }
    return new Response(JSON.stringify({ campaigns: [{
      campaignId: 'daily-112', title: '每日签到', actionType: 'CLAIM_BENEFIT', claimStatus: 'CLAIMABLE', benefit: { amount: 100 },
    }] }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  let out;
  try {
    out = await checkinQoder('qoder');
  } finally {
    globalThis.fetch = original;
  }
  assert.equal(out.status, 'pending');
  assert.equal(out.pendingReason, 'quota_cooldown');
  assert.match(out.message, /额度已耗尽/);
  assert.doesNotMatch(out.message, /每日计费次数已达上限/);
});

// ---------------------------------------------------------------- 设备身份地区隔离

test('UMID 运行环境码按地区固定：国际版 3、国内版 0', () => {
  assert.equal(device.QODER_UMID_RUNTIME_ENV.qoder, 3);
  assert.equal(device.QODER_UMID_RUNTIME_ENV['qoder-cn'], 0);
});

test('客户端资源目录严格地区隔离，不跨地区混用', () => {
  const globalDirs = device.qoderResourceDirs('/home/x', 'qoder');
  const cnDirs = device.qoderResourceDirs('/home/x', 'qoder-cn');
  assert.ok(globalDirs.every((d) => !/Qoder\s?CN/i.test(d)), `国际版目录不能含国内版组件：${globalDirs.join(' | ')}`);
  assert.ok(cnDirs.every((d) => !/(^|[\\/])Qoder([\\/]|$)/.test(d)), `国内版目录不能含国际版组件：${cnDirs.join(' | ')}`);
});

test('兜底客户端版本对齐 1.1.83', () => {
  assert.equal(device.QODER_DEFAULT_CLIENT_VERSION, '1.1.83');
});

// ---------------------------------------------------------------- 重试判定

test('pending 会补签，success / already 不补', () => {
  const today = new Date().toISOString().slice(0, 10);
  const now = Math.floor(Date.now() / 1000);
  assert.equal(platformNeedsRetry({ lastDate: today, status: 'pending' }, today, now), true);
  assert.equal(platformNeedsRetry({ lastDate: today, status: 'failed' }, today, now), true);
  assert.equal(platformNeedsRetry({ lastDate: today, status: 'success' }, today, now), false);
  assert.equal(platformNeedsRetry({ lastDate: today, status: 'already' }, today, now), false);
});

test('平台自己约了时间就等，到点再补', () => {
  const today = new Date().toISOString().slice(0, 10);
  const now = Math.floor(Date.now() / 1000);
  assert.equal(platformNeedsRetry({ lastDate: today, status: 'pending', retryAt: now + 600 }, today, now), false);
  assert.equal(platformNeedsRetry({ lastDate: today, status: 'pending', retryAt: now - 1 }, today, now), true);
});

// ---------------------------------------------------------------- 平台级聚合

test('部分账号签成、部分没签成 → partial（不能粉饰成 success）', () => {
  const agg = aggregatePlatformStatus([
    { status: 'success' },
    { status: 'pending', pendingReason: 'awaiting_window', retryAt: 111 },
  ]);
  assert.equal(agg.status, 'partial');
  assert.equal(agg.pendingReason, 'awaiting_window');
  assert.equal(agg.retryAt, 111);
});

test('全 pending → pending；全成功 → success；全已领 → already', () => {
  assert.equal(aggregatePlatformStatus([{ status: 'pending' }]).status, 'pending');
  assert.equal(aggregatePlatformStatus([{ status: 'success' }, { status: 'success' }]).status, 'success');
  assert.equal(aggregatePlatformStatus([{ status: 'already' }, { status: 'already' }]).status, 'already');
  assert.equal(aggregatePlatformStatus([{ status: 'already' }, { status: 'success' }]).status, 'already');
});

test('全失败 → failed；全失效 → expired', () => {
  assert.equal(aggregatePlatformStatus([{ status: 'failed' }, { status: 'failed' }]).status, 'failed');
  assert.equal(aggregatePlatformStatus([{ status: 'expired' }]).status, 'expired');
  assert.equal(aggregatePlatformStatus([{ status: 'failed' }, { status: 'expired' }]).status, 'failed');
});

test('聚合取最早的 retryAt，避免错过某个账号约定的时间', () => {
  const agg = aggregatePlatformStatus([
    { status: 'pending', retryAt: 5000 },
    { status: 'pending', retryAt: 900 },
  ]);
  assert.equal(agg.retryAt, 900);
});

test('partial 也参与补签重试', () => {
  const today = new Date().toISOString().slice(0, 10);
  const now = Math.floor(Date.now() / 1000);
  assert.equal(platformNeedsRetry({ lastDate: today, status: 'partial' }, today, now), true);
});
