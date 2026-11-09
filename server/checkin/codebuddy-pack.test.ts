// @ts-check
import { test, assert } from './testing/testkit.ts';

/** checkin.mjs 尚未在 checkin.d.mts 里声明的导出，按实现的真实行为就地补类型 */
interface CreditsSnapshot {
  count?: number;
  dosage?: number;
  creditsRemain?: number;
  packCount?: number;
  packs: Array<{ id: string; size: number; remain: number; [key: string]: unknown }>;
  [key: string]: unknown;
}

interface CreditPack extends Record<string, unknown> {
  id: string;
  size: number;
  remain: number;
}

type CheckinModule = typeof import('./checkin.mjs') & {
  codeBuddyPackGranted(before: CreditsSnapshot | null, after: CreditsSnapshot | null, now?: Date): boolean;
  codeBuddyCreditsArrived(before: CreditsSnapshot | null, after: CreditsSnapshot | null): boolean;
};

const { codeBuddyPackGranted, codeBuddyCreditsArrived } = (await import('./checkin.mjs')) as CheckinModule;

// 固定时刻（UTC 表示；Asia/Shanghai 全年 UTC+8）：
//   2026-11-10T02:00:00Z = 上海 11-10 10:00（非 1 号）
//   2026-11-01T02:00:00Z = 上海 11-01 10:00（11 月 1 号）
//   2026-12-01T02:00:00Z = 上海 12-01 10:00（12 月 1 号，跨年用）
//   上海 12-01 零点 = 2026-11-30T16:00:00Z；上海 2027-01-01 零点 = 2026-12-31T16:00:00Z
const NOT_FIRST = new Date('2026-11-10T02:00:00Z');
const FIRST_NOV = new Date('2026-11-01T02:00:00Z');
const FIRST_DEC = new Date('2026-12-01T02:00:00Z');
const END_DEC_FIRST = Date.parse('2026-11-30T16:00:00Z');
const END_JAN_FIRST = Date.parse('2026-12-31T16:00:00Z');

const pack = (id: string, end: number, remain = 30) => ({ id, name: `包${id}`, size: 30, remain, used: 30 - remain, created: 0, end });
const snapshot = (packs: CreditPack[]) => ({
  count: packs.length,
  dosage: 710,
  packs,
  packCount: packs.length,
  creditsRemain: packs.reduce((s, p) => s + p.remain, 0),
});

test('codeBuddyPackGranted：签到后新增额度包 → 成功', () => {
  const before = snapshot([pack('1', 0), pack('2', 0)]);
  const after = snapshot([pack('1', 0), pack('2', 0), pack('3', 0)]);
  assert.equal(codeBuddyPackGranted(before, after, NOT_FIRST), true, 'after 出现 before 没有的包 id 就是成功');
});

test('codeBuddyPackGranted：前后无变化 → 失败', () => {
  const before = snapshot([pack('1', 0), pack('2', Date.parse('2026-11-15T03:00:00Z'))]);
  const after = snapshot([pack('1', 0), pack('2', Date.parse('2026-11-15T03:00:00Z'))]);
  assert.equal(codeBuddyPackGranted(before, after, NOT_FIRST), false);
  assert.equal(codeBuddyPackGranted(before, after, FIRST_NOV), false,
    '1 号只认「下月 1 号到期」，本月内到期的包不算');
  // 读不到基线或结果时不下结论
  assert.equal(codeBuddyPackGranted(null, after), false);
  assert.equal(codeBuddyPackGranted(before, null), false);
});

test('codeBuddyPackGranted：只剩余积分变多 / dosage 变大 → 失败（新口径不再认）', () => {
  const before = snapshot([pack('1', 0, 30)]);
  // 同一批包，remain/creditsRemain/dosage 都涨了
  const after = snapshot([pack('1', 0, 60)]);
  after.dosage = 740;
  assert.equal(codeBuddyCreditsArrived(before, after), true, '旧口径会认（函数保留，行为不变）');
  assert.equal(codeBuddyPackGranted(before, after, NOT_FIRST), false, '新口径只认额度包');
});

test('codeBuddyPackGranted：每月 1 号（上海）有下月 1 号到期的旧包 → 成功', () => {
  const before = snapshot([pack('1', END_DEC_FIRST)]);
  assert.equal(codeBuddyPackGranted(before, before, FIRST_NOV), true,
    '月包在签到前就发放了（不是新增），换期当天靠「下月 1 号到期」认领');
});

test('codeBuddyPackGranted：1 号但包在本月内到期 → 失败', () => {
  const before = snapshot([pack('1', Date.parse('2026-11-15T03:00:00Z'))]);
  assert.equal(codeBuddyPackGranted(before, snapshot([pack('1', Date.parse('2026-11-15T03:00:00Z'))]), FIRST_NOV), false);
});

test('codeBuddyPackGranted：非 1 号有下月 1 号到期的旧包 → 失败', () => {
  const before = snapshot([pack('1', END_DEC_FIRST)]);
  assert.equal(codeBuddyPackGranted(before, snapshot([pack('1', END_DEC_FIRST)]), NOT_FIRST), false);
});

test('codeBuddyPackGranted：跨年，12 月 1 号 → 次年 1 月 1 号 → 成功', () => {
  const before = snapshot([pack('1', END_JAN_FIRST)]);
  assert.equal(codeBuddyPackGranted(before, snapshot([pack('1', END_JAN_FIRST)]), FIRST_DEC), true,
    '12 月的下月 1 号是次年的 1 月 1 号');
});

test('codeBuddyPackGranted：接受 23:59:59 表示法（下月 1 号零点前 1 秒内）→ 成功', () => {
  const end = Date.parse('2026-11-30T15:59:59Z');
  const before = snapshot([pack('1', end)]);
  assert.equal(codeBuddyPackGranted(before, snapshot([pack('1', end)]), FIRST_NOV), true);
});
