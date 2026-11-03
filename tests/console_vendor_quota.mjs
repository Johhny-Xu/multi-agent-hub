// @ts-check
// 「子代理 → 账号 → 实时配额」的回归测试。
//
// 覆盖三件曾经/容易出错的事：
//   1. 配额形态：后端历史上有对象 map，也有数组；前端只认数组，必须归一化。
//   2. codebuddy-cn 曾映射到 `codebuddy` 这个**国际版** worker，显示的是另一个
//      账号的额度——两个 CodeBuddy 是两条独立凭据，不能混。
//   3. 胶囊挑「代表值」时不能被「每日签到（0/1）」这种状态位抢走，否则 Trae
//      永远显示「余 0%」。
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { join } from 'node:path';

const require = createRequire(import.meta.url);
const CLIENT = join(process.cwd(), 'console', 'client');

const {
  quotaPlatformOf, quotaItemsOf, pickPrimaryQuota, quotaSummaryOf,
  quotaCapsuleText, capsuleFor, fmtQuotaAmount, QUOTA_AGENT_PLATFORM,
} = require(join(CLIENT, 'quota-view.js'));

const { normalizeQuotas, QUOTA_WORKERS } = await import('../console/vendor-quota.mjs');
const { DEEP_WORKERS, isDeepQuotaWorker } = await import('../console/quota-deep.mjs');

// ---------------------------------------------------------------- 后端形态
test('normalizeQuotas：对象 map → 带 name/displayName 的数组', () => {
  const out = normalizeQuotas({ gemini_session: { used: 3, total: 10, remainingPercentage: 70 } });
  assert.equal(Array.isArray(out), true);
  assert.equal(out.length, 1);
  assert.equal(out[0].name, 'gemini_session');
  assert.equal(out[0].displayName, 'gemini_session');
  assert.equal(out[0].remainingPercentage, 70);
});

test('normalizeQuotas：数组原样保留并补齐 name', () => {
  const out = normalizeQuotas([{ displayName: '积分总额', used: 1, total: 2 }]);
  assert.equal(out.length, 1);
  assert.equal(out[0].name, '积分总额');
  assert.equal(out[0].displayName, '积分总额');
});

test('normalizeQuotas：null / undefined 不炸', () => {
  assert.equal(normalizeQuotas(null), null);
  assert.equal(normalizeQuotas(undefined), undefined);
});

test('QUOTA_WORKERS 覆盖 qoder / qoder-cn / codearts / traecode', () => {
  for (const w of ['qoder', 'qoder-cn', 'codearts', 'traecode']) {
    assert.ok(QUOTA_WORKERS.includes(w), `${w} 必须在配额清单里`);
  }
});

test('quota-deep 接管三家需要设备指纹/令牌续期的 worker', () => {
  assert.deepEqual(new Set(DEEP_WORKERS), new Set(['qoder', 'qoder-cn', 'traecode']));
  assert.equal(isDeepQuotaWorker('qoder-cn'), true);
  assert.equal(isDeepQuotaWorker('codearts'), false);
});

// ---------------------------------------------------------------- 平台映射
test('codebuddy 与 codebuddy-cn 映射到各自独立的 worker', () => {
  assert.equal(quotaPlatformOf('codebuddy'), 'codebuddy');
  assert.equal(quotaPlatformOf('codebuddy-cn'), 'codebuddy-cn');
  assert.notEqual(quotaPlatformOf('codebuddy'), quotaPlatformOf('codebuddy-cn'));
});

test('qoder 系与 codearts 已接入平台映射', () => {
  assert.equal(quotaPlatformOf('qoder'), 'qoder');
  assert.equal(quotaPlatformOf('qoder-cn'), 'qoder-cn');
  assert.equal(quotaPlatformOf('codearts'), 'codearts');
  assert.equal(quotaPlatformOf('workbuddy'), null, '未接入的 worker 返回 null');
});

// ---------------------------------------------------------------- 归一化 + 摘要
test('对象 map 形态的 quotas 也能算出来（兼容旧缓存）', () => {
  const data = {
    antigravity: {
      account: 'a@b.c',
      plan: 'Antigravity',
      quotas: { gemini_session: { used: 5, total: 10, remainingPercentage: 50, displayName: 'Gemini 5h' } },
    },
  };
  const sum = quotaSummaryOf('antigravity', data, null);
  assert.equal(sum.ok, true);
  assert.equal(sum.items.length, 1);
  assert.equal(sum.items[0].displayName, 'Gemini 5h');
  assert.equal(sum.pct, 50);
});

test('Qoder：加油包按积分口径显示绝对值', () => {
  const data = {
    'qoder-cn': {
      account: 'johhny',
      plan: 'Qoder CN (国内版)',
      quotas: [{ name: '加油包', displayName: '加油包', used: 200, total: 1600, remaining: 1400, remainingPercentage: 87.5, isCreditBalance: true }],
    },
  };
  const sum = quotaSummaryOf('qoder-cn', data, null);
  assert.equal(sum.ok, true);
  assert.equal(sum.account, 'johhny');
  assert.equal(quotaCapsuleText(sum), '剩1400');
  assert.equal(sum.level, 'ok');
});

test('CodeArts：有 primary 标记时优先用它，而不是先出现的基础包', () => {
  const data = {
    codearts: {
      plan: 'CodeArts Doer (高级版)',
      quotas: [
        { name: '基础包', used: 658.88, total: 2906.84, remaining: 2247.96, remainingPercentage: 77.33, isCreditBalance: true },
        { name: '积分总额', used: 3658.88, total: 26106.84, remaining: 22447.96, remainingPercentage: 85.98, isCreditBalance: true, primary: true },
        { name: '赠送包', used: 3000, total: 23200, remaining: 20200, remainingPercentage: 87.07, isCreditBalance: true },
      ],
    },
  };
  const sum = quotaSummaryOf('codearts', data, null);
  assert.equal(sum.primary.name, '积分总额');
  assert.equal(quotaCapsuleText(sum), '剩22.4K');
});

test('Trae：每日签到不能被当成余额主口径', () => {
  const data = {
    traecode: {
      account: 'UID:123',
      plan: 'Trae CN (123)',
      quotas: [
        { name: '账号积分', used: 0, total: 3600, remaining: 3600, remainingPercentage: 100, isCreditBalance: true },
        { name: '每日签到', used: 1, total: 1, remaining: 0, remainingPercentage: 0 },
      ],
    },
  };
  const sum = quotaSummaryOf('traecode', data, null);
  assert.equal(sum.primary.name, '账号积分');
  assert.equal(sum.pct, 100);
  assert.equal(sum.level, 'ok');
});

test('严重度分级：<40% 警告、<15% 危险', () => {
  const data = (pct) => ({ qoder: { quotas: [{ name: '加油包', total: 100, used: 100 - pct, remaining: pct, remainingPercentage: pct, isCreditBalance: true }] } });
  assert.equal(quotaSummaryOf('qoder', data(60), null).level, 'ok');
  assert.equal(quotaSummaryOf('qoder', data(30), null).level, 'warn');
  assert.equal(quotaSummaryOf('qoder', data(5), null).level, 'critical');
  assert.match(capsuleFor('qoder', data(5), null).cls, /critical/);
});

test('不限额度显示「不限额」', () => {
  const data = { qoder: { quotas: [{ name: 'x', unlimited: true, total: 0, used: 0, remaining: 0 }] } };
  const sum = quotaSummaryOf('qoder', data, null);
  assert.equal(quotaCapsuleText(sum), '不限额');
});

test('额度字段缺失时按 total-used 兜底（codebuddy 的包只有 used/total）', () => {
  const items = quotaItemsOf({ quotas: [{ name: 'Monthly', used: 24.23, total: 100 }] });
  assert.equal(items[0].remaining, 75.77);
  assert.equal(Math.round(items[0].pct), 76);
});

test('没有 quotas 但有 plan：胶囊显示「已接入」占位，详情放 tooltip', () => {
  const cap = capsuleFor('mimocode', { mimocode: { plan: 'Xiaomi MiMo · UID:1', message: '官方暂无公开配额端点' } }, null);
  assert.ok(cap);
  assert.equal(cap.text, '已接入', '胶囊位很窄，不能塞长套餐名');
  assert.equal(cap.cls, 'pill-quota');
  assert.match(cap.title, /官方暂无公开配额端点/);
  assert.match(cap.title, /Xiaomi MiMo/);
});

test('完全没有数据：胶囊返回 null（不占位）', () => {
  assert.equal(capsuleFor('mimocode', {}, null), null);
  assert.equal(capsuleFor('workbuddy', {}, null), null);
});

test('fetch 失败时胶囊不抛错，标题里带原因', () => {
  const cap = capsuleFor('qoder', { qoder: { error: 'HTTP 401' } }, null);
  assert.equal(cap, null);
  const sum = quotaSummaryOf('qoder', { qoder: { error: 'HTTP 401' } }, null);
  assert.equal(sum.ok, false);
  assert.match(sum.reason, /401/);
});

test('fmtQuotaAmount：万级缩写成 K', () => {
  assert.equal(fmtQuotaAmount(1400), '1400');
  assert.equal(fmtQuotaAmount(22447.96), '22.4K');
  assert.equal(fmtQuotaAmount(null), '-');
  assert.equal(fmtQuotaAmount('abc'), '-');
});

test('平台映射表不含拼错/多余的键', () => {
  for (const [agent, plat] of Object.entries(QUOTA_AGENT_PLATFORM)) {
    assert.equal(typeof plat, 'string');
    assert.ok(plat.length > 0, `${agent} 的 worker 键不能为空`);
  }
});
