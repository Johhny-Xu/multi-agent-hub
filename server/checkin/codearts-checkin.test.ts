// CodeArts（华为云码道）福利中心：所有 claimable 活动都要领，不能只看第一条 USER_LOGIN。
// 回归 2026-11-17：第一条 USER_LOGIN 是已领的「Skill创新赛报名礼」，旧逻辑据此判「今日已领取」，
// 「Skill创新赛每日签到礼」「每日签到领150积分」「2026年学生专属福利」全部漏领。
import { test, assert } from './testing/testkit.ts';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const tempHome = await mkdtemp(join(tmpdir(), 'agenthub-codearts-checkin-'));
process.env.AGENTHUB_HOME = tempHome;
process.env.AGENTHUB_CHECKIN_STATE = join(tempHome, 'checkin-state.json');

const { classifyCodeArtsCampaigns, checkinCodeArtsOne } = await import('./checkin.mjs');

const NOW = Date.parse('2026-11-17T02:30:00Z') / 1000; // 10:30 UTC+8

function row(id: number, title: string, type: string, amount: number, status: string, claimable: boolean, start = '2026-11-11T00:00:00Z', end = '2026-12-31T15:59:00Z') {
  return { campaignId: id, title, type, benefitAmount: amount, benefitUnit: 'CREDIT', status, claimable, extra: { startTime: start, endTime: end, triggerMode: 'MANUAL_CLAIM' } };
}

const LIVE_ITEMS = [
  row(42, 'Skill创新赛报名礼', 'USER_LOGIN', 2000, 'CLAIMED', false),
  row(40, 'Skill创新赛每日签到礼', 'USER_LOGIN', 1000, 'ELIGIBLE', true),
  row(39, '2026年学生专属福利', 'STUDENT_CERTIFIED', 5000, 'ELIGIBLE', true, '2026-11-17T02:00:00Z'),
  row(34, '每日签到领150积分', 'USER_LOGIN', 150, 'ELIGIBLE', true),
  row(2, '学生认证领积分', 'STUDENT_CERTIFIED', 4000, 'CONFIRMED', false),
];

function fakeFetch(items: unknown[], claimReply: (id: number) => unknown = () => ({ code: 0, message: 'ok' })) {
  const claimed: number[] = [];
  const fn = async (_ak: string, _sk: string, method: string, url: string, body?: { campaignId: number }) => {
    if (url.includes('/api/v1/benefit/claim')) return { status: 200, json: { error_code: '4000', error_msg: 'invalid channel, group not found' }, text: '' };
    if (url.includes('/v1/ops/delivery')) return { status: 200, json: { code: 0, data: { items } }, text: '' };
    if (method === 'POST' && url.includes('/v1/ops/claim') && body) {
      claimed.push(body.campaignId);
      return { status: 200, json: claimReply(body.campaignId), text: '' };
    }
    throw new Error(`unexpected ${method} ${url}`);
  };
  return { fn, claimed };
}

test('classify：claimable 的全领，已领 / 一次性 / 未参与的跳过', () => {
  const g = classifyCodeArtsCampaigns(LIVE_ITEMS, NOW);
  assert.deepEqual(g.claimable.map((c) => c.campaignId), [40, 39, 34]);
  assert.deepEqual(g.claimed.map((c) => c.campaignId), [42, 2]);
  assert.equal(g.upcoming.length, 0);
});

test('三条可领活动都发 claim，积分累加，状态 success', async () => {
  const { fn, claimed } = fakeFetch(LIVE_ITEMS);
  const r = await checkinCodeArtsOne('ak', 'sk', { fetch: fn, nowSec: NOW });
  assert.deepEqual(claimed, [40, 39, 34]);
  assert.equal(r.status, 'success');
  assert.equal(r.credits, 6150);
  assert.ok(r.message.includes('Skill创新赛每日签到礼'));
  assert.ok(r.message.includes('每日签到领150积分'));
  assert.ok(r.message.includes('2026年学生专属福利'));
});

test('全部已领：already，不发 claim', async () => {
  const items = LIVE_ITEMS.map((c) => (c.claimable ? { ...c, claimable: false, status: 'CLAIMED' } : c));
  const { fn, claimed } = fakeFetch(items);
  const r = await checkinCodeArtsOne('ak', 'sk', { fetch: fn, nowSec: NOW });
  assert.deepEqual(claimed, []);
  assert.equal(r.status, 'already');
});

test('月度福利当天晚些才开窗：先领每日的，约 retryAt 到点补领（partial）', async () => {
  const early = Date.parse('2026-11-16T16:00:13Z') / 1000; // 00:00:13 UTC+8
  const items = LIVE_ITEMS.map((c) => (c.campaignId === 39 ? { ...c, claimable: false, status: 'ENTRY' } : c));
  const { fn, claimed } = fakeFetch(items);
  const r = await checkinCodeArtsOne('ak', 'sk', { fetch: fn, nowSec: early });
  assert.deepEqual(claimed, [40, 34]);
  assert.equal(r.status, 'partial');
  assert.equal(r.ok, true);
  assert.equal(r.pendingReason, 'awaiting_window');
  assert.equal(r.retryAt, Date.parse('2026-11-17T02:00:00Z') / 1000);
});

test('不在开放期（没认证 / 本月已领）的月度活动不领、不算失败', async () => {
  const items = LIVE_ITEMS.map((c) => (c.campaignId === 39 ? { ...c, claimable: false, status: 'ENTRY', extra: { ...c.extra, startTime: '2026-11-01T00:00:00Z' } } : c));
  const { fn, claimed } = fakeFetch(items);
  const r = await checkinCodeArtsOne('ak', 'sk', { fetch: fn, nowSec: NOW });
  assert.deepEqual(claimed, [40, 34]);
  assert.equal(r.status, 'success');
});

test('一条领失败：partial（ok=false），其余照领；40001 视为已领', async () => {
  const { fn, claimed } = fakeFetch(LIVE_ITEMS, (id) => (id === 40 ? { code: 40001, message: '权益未刷新' } : id === 39 ? { code: 4006, message: '名额已领完' } : { code: 0 }));
  const r = await checkinCodeArtsOne('ak', 'sk', { fetch: fn, nowSec: NOW });
  assert.deepEqual(claimed, [40, 39, 34]);
  assert.equal(r.status, 'partial');
  assert.equal(r.ok, false);
  assert.equal(r.credits, 150);
});
