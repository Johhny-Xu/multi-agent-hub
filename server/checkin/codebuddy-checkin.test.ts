// @ts-check
import { test, assert } from './testing/testkit.ts';
import { mkdtemp, writeFile, mkdir, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const tempHome = await mkdtemp(join(tmpdir(), 'agenthub-cb-checkin-'));
process.env.AGENTHUB_HOME = tempHome;
process.env.AGENTHUB_CHECKIN_STATE = join(tempHome, 'checkin-state.json');

/** checkin.mjs 尚未在 checkin.d.mts 里声明的导出，按实现的真实行为就地补类型 */
interface CreditsSnapshot {
  count?: number;
  dosage?: number;
  creditsRemain?: number;
  packCount?: number;
  packs: Array<{ id: string; size: number; remain: number; [key: string]: unknown }>;
  [key: string]: unknown;
}

interface CheckinStateRecord {
  lastDate?: string;
  lastTime?: string;
  status?: string;
  retryCount?: number;
  retryBudget?: number;
  retryAt?: number;
  pendingReason?: string;
  accounts?: Array<{ status?: string; [key: string]: unknown }>;
  [key: string]: unknown;
}

interface CheckinAccount {
  identity?: string;
  name?: string;
  display?: string;
  active?: boolean;
  token?: string;
  refreshToken?: string;
  credentialSource: string;
  alternates: Array<{ token?: string; [key: string]: unknown }>;
  [key: string]: unknown;
}

interface CodeBuddyOutcome {
  ok?: boolean;
  status: string;
  message: string;
  accounts: Array<{ status?: string; [key: string]: unknown }>;
  [key: string]: unknown;
}

interface DecideCodeBuddyInput {
  actStatus?: { active: boolean; todayCheckedIn: boolean; [key: string]: unknown };
  claim?: { ok: boolean; code: number; msg: string; [key: string]: unknown };
  report?: { ok: boolean; days?: number; note?: string; [key: string]: unknown };
  web?: { ok: boolean; note?: string; [key: string]: unknown };
  keep?: { ok: boolean; note?: string; [key: string]: unknown };
  creditsBefore?: CreditsSnapshot | null;
  [key: string]: unknown;
}

interface OverviewWithHistory {
  ok: boolean;
  today: string;
  autoCheckin: boolean;
  autoCheckinTime: string;
  platforms: Record<string, CheckinStateRecord & { available?: boolean }>;
  history: Array<{ platform?: string; status?: string; [key: string]: unknown }>;
  [key: string]: unknown;
}

interface CheckinStateFile {
  autoCheckin?: boolean;
  platforms: Record<string, CheckinStateRecord>;
  history: Array<{ platform?: string; [key: string]: unknown }>;
  [key: string]: unknown;
}

type CheckinModule = Omit<typeof import('./checkin.mjs'), 'runCheckin' | 'getCheckinOverview'> & {
  runCheckin(target?: string): Promise<{
    ok: boolean;
    results: Record<string, CodeBuddyOutcome>;
    overview: OverviewWithHistory;
    due?: string[];
    [key: string]: unknown;
  }>;
  getCheckinOverview(): Promise<OverviewWithHistory>;
  checkinCodeBuddy(overrideToken?: string | null): Promise<CodeBuddyOutcome>;
  listCheckinAccounts(platform: string): Promise<CheckinAccount[]>;
  platformNeedsRetry(state: CheckinStateRecord, today: string, nowSec: number, plat?: string): boolean;
  selectAutoCheckinPlatforms(states: Record<string, CheckinStateRecord>, today: string, nowSec: number, extra?: string[]): string[];
  aggregatePlatformStatus(accounts?: Array<{ status?: string; pendingReason?: string; retryAt?: number; [key: string]: unknown }>): CheckinStateRecord;
  codeBuddyCreditsArrived(before: CreditsSnapshot | null, after: CreditsSnapshot | null): boolean;
  buildCodeBuddyActivityEvent(uid: string): { eventCode: string; userId: string; conversationId: string; requestId: string; timestamp: number; [key: string]: unknown };
  decideCodeBuddyOutcome(input?: DecideCodeBuddyInput): { status: string; message: string; awaitCredits?: boolean; [key: string]: unknown };
};

const checkinMod = (await import('./checkin.mjs')) as CheckinModule;
const { checkinCodeBuddy, runCheckin, runAutoCheckinTick, getCheckinOverview, listCheckinAccounts } = checkinMod;
const {
  CHECKIN_PLATFORMS,
  platformNeedsRetry,
  selectAutoCheckinPlatforms,
  aggregatePlatformStatus,
  codeBuddyCreditsArrived,
  buildCodeBuddyActivityEvent,
  decideCodeBuddyOutcome,
} = checkinMod;
const { encryptLegacyQoderUser } = await import('./qoder.mjs');

/** 与 checkin.mjs 的 getTodayStr 同格式（本地时区 YYYY-MM-DD） */
function todayStr() {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

async function writeQoderTestCredentials() {
  const machineId = '0123456789abcdef';
  const token = ['eyJhbGciOiJIUzI1NiJ9', Buffer.from(JSON.stringify({ exp: 9999999999, sub: 'u1' })).toString('base64url'), 'sig'].join('.');
  const credential = JSON.stringify({ token, refreshToken: 'rt-concurrency', uid: 'u1', nickname: 'ConcurrencyTest' });
  for (const dir of ['.qoder', '.qoder-cn']) {
    await mkdir(join(tempHome, dir, '.auth'), { recursive: true });
    await writeFile(join(tempHome, dir, '.auth', 'machine_id'), machineId);
    await writeFile(join(tempHome, dir, '.auth', 'user'), encryptLegacyQoderUser(credential, machineId));
  }
}

test('CHECKIN_PLATFORMS 是唯一平台清单，且必须含国际版', () => {
  assert.ok(CHECKIN_PLATFORMS.includes('codebuddy'), '国际版漏了就会重演「失败后不再重试」');
  assert.ok(CHECKIN_PLATFORMS.includes('workbuddy'));
  assert.ok(CHECKIN_PLATFORMS.includes('qoder-cn'));
  assert.equal(CHECKIN_PLATFORMS.length, 8);
});

test('platformNeedsRetry：今天没签 / 失败待重试 要补，已成功不补', () => {
  const today = todayStr();
  assert.equal(platformNeedsRetry({}, today, 1000), true, '今天没签过 → 要补');
  assert.equal(platformNeedsRetry({ lastDate: today, status: 'failed', retryCount: 1 }, today, 1000), true);
  assert.equal(platformNeedsRetry({ lastDate: today, status: 'pending', retryCount: 3 }, today, 1000), true);
  assert.equal(platformNeedsRetry({ lastDate: today, status: 'success' }, today, 1000), false);
  assert.equal(platformNeedsRetry({ lastDate: today, status: 'already' }, today, 1000), false);
  assert.equal(platformNeedsRetry({ lastDate: today, status: 'unconfigured' }, today, 1000), false);
  assert.equal(platformNeedsRetry({ lastDate: today, status: 'failed', retryCount: 8 }, today, 1000), false, '重试用满不再打');
  // 平台自己约了时间（Qoder 10:00 开窗）→ 到点前不空转
  assert.equal(platformNeedsRetry({ lastDate: today, status: 'pending', retryAt: 2000 }, today, 1000), false);
  assert.equal(platformNeedsRetry({ lastDate: today, status: 'pending', retryAt: 2000 }, today, 3000), true);
});

test('自动调度器选平台时，国际版失败后仍会被重试（回归：清单曾漏掉 codebuddy）', () => {
  const today = todayStr();
  const sel = selectAutoCheckinPlatforms({ codebuddy: { lastDate: today, status: 'failed', retryCount: 1 } }, today, 1000);
  assert.ok(sel.includes('codebuddy'), '国际版失败后必须进入重试队列');
  // 已成功的平台不进队列
  const sel2 = selectAutoCheckinPlatforms({ codebuddy: { lastDate: today, status: 'success' } }, today, 1000);
  assert.equal(sel2.includes('codebuddy'), false);
  // 账号补签带来的平台也会并进来
  const sel3 = selectAutoCheckinPlatforms({}, today, 1000, ['codebuddy']);
  assert.ok(sel3.includes('codebuddy'));
});

test('buildCodeBuddyActivityEvent：活跃上报事件形状正确，且 userId 必填', () => {
  const ev = buildCodeBuddyActivityEvent('39e9bf8f-1477-4e40-b840-cbcaba45cbfb');
  assert.equal(ev.eventCode, 'chat_request_send');
  assert.equal(ev.userId, '39e9bf8f-1477-4e40-b840-cbcaba45cbfb');
  assert.ok(ev.conversationId, '必须有 conversationId');
  assert.equal(ev.conversationId, ev.requestId);
  assert.ok(Number(ev.timestamp) > 0);
  // 缺 userId 会被上游静默丢弃，所以这里必须是空串而不是 undefined
  assert.equal(buildCodeBuddyActivityEvent('').userId, '');
});

test('decideCodeBuddyOutcome：链路没点亮 → 失败；活动关闭 → pending；链路通了才去等积分', () => {
  const base = {
    actStatus: { active: true, todayCheckedIn: false },
    claim: { ok: true, code: 0, msg: 'OK' },
    report: { ok: true, days: 2 },
    web: { ok: true },
    creditsBefore: { count: 19, dosage: 710, creditsRemain: 610, packs: [] },
  };

  // 1) 活跃上报与网页会话都没成功 → 当日活跃没点亮（调模型不算）
  const dead = decideCodeBuddyOutcome({ ...base, report: { ok: false, note: 'HTTP 500' }, web: { ok: false, note: 'HTTP 500' } });
  assert.equal(dead.status, 'failed');
  assert.ok(dead.message.includes('活跃链路未点亮'));
  assert.ok(dead.message.includes('调模型不算'), '要说明调模型不算活跃');

  // 2) 只有网页会话成功也算点亮（上游口径：任一成功即算当日活跃完成）
  const onlyWeb = decideCodeBuddyOutcome({ ...base, report: { ok: false, note: 'HTTP 500' } });
  assert.equal(onlyWeb.status, 'success');
  assert.equal(onlyWeb.awaitCredits, true, '链路通了要去等 5 分钟积分');

  // 3) 活动关闭 → 不白等 5 分钟，记 pending 并写明原因
  const closed = decideCodeBuddyOutcome({
    ...base,
    actStatus: { active: false, todayCheckedIn: false },
    claim: { ok: false, code: 10001, msg: '签到活动未开启或已过期' },
  });
  assert.equal(closed.status, 'pending');
  assert.equal(closed.awaitCredits, undefined, '活动关闭时不该进 5 分钟等待');
  assert.ok(closed.message.includes('签到活动未开启或已过期'));
  assert.ok(closed.message.includes('活跃链路已完成'));

  // 4) 积分基线读不到 → 不能自称成功（用户口径：只有积分到账才算）
  const noBaseline = decideCodeBuddyOutcome({ ...base, creditsBefore: null });
  assert.equal(noBaseline.status, 'pending');
  assert.ok(noBaseline.message.includes('未能确认到账'));

  // 5) 活动开着但官方接口说「活动未开始或已结束」→ 也不能白等 5 分钟
  const ended = decideCodeBuddyOutcome({
    ...base,
    claim: { ok: false, code: 41000, msg: '活动未开始或已结束' },
  });
  assert.equal(ended.status, 'pending');
  assert.equal(ended.awaitCredits, undefined);
});

test('platformNeedsRetry：账号受限（restricted）不该反复重试', () => {
  const today = todayStr();
  assert.equal(platformNeedsRetry({ lastDate: today, status: 'restricted', retryCount: 1 }, today, 1000), false);
  const aggregated = aggregatePlatformStatus([{ status: 'restricted' }]);
  assert.equal(aggregated.status, 'restricted');
  assert.equal(platformNeedsRetry({ ...aggregated, lastDate: today }, today, 1000), false);
});

test('部分成功且剩余账号受限：保留 partial 展示但不自动重试', () => {
  const today = todayStr();
  const accounts = [{ status: 'success' }, { status: 'restricted' }];
  const aggregated = aggregatePlatformStatus(accounts);
  assert.equal(aggregated.status, 'partial');
  assert.equal(platformNeedsRetry({ ...aggregated, accounts, lastDate: today }, today, 1000), false);
});

test('跨自然日也不能绕过未来的 retryAt', () => {
  assert.equal(platformNeedsRetry({ lastDate: '2026-11-01', status: 'pending', retryAt: 2000 }, '2026-11-02', 1000), false);
  assert.equal(platformNeedsRetry({ lastDate: '2026-11-01', status: 'pending', retryAt: 2000 }, '2026-11-02', 2000), true);
});

test('codeBuddyCreditsArrived：只有积分真的到账才算活跃成功', () => {
  const before = {
    count: 19,
    dosage: 710,
    creditsRemain: 610,
    packs: [{ id: '1', size: 30, remain: 30 }, { id: '2', size: 30, remain: 30 }],
  };
  // 新增一个积分包（活跃发积分的典型形态）
  assert.equal(codeBuddyCreditsArrived(before, {
    ...before, count: 20, dosage: 740, creditsRemain: 640, packs: [...before.packs, { id: '3', size: 30, remain: 30 }],
  }), true, '新发积分包必须认到账');
  // 总量上升
  assert.equal(codeBuddyCreditsArrived(before, { ...before, dosage: 740 }), true);
  // 剩余积分变多
  assert.equal(codeBuddyCreditsArrived(before, { ...before, creditsRemain: 640 }), true);
  // 原有包额度变大
  assert.equal(codeBuddyCreditsArrived(before, {
    ...before, packs: [{ id: '1', size: 60, remain: 60 }, before.packs[1]],
  }), true);
  // 什么都没变 → 未到账
  assert.equal(codeBuddyCreditsArrived(before, { ...before }), false);
  // 只是消耗（额度变小）不算到账
  assert.equal(codeBuddyCreditsArrived(before, {
    ...before, creditsRemain: 580, packs: [{ id: '1', size: 30, remain: 0 }, before.packs[1]],
  }), false, '消耗不能当成到账');
  // 读不到积分时不下结论
  assert.equal(codeBuddyCreditsArrived(before, null), false);
  assert.equal(codeBuddyCreditsArrived(null, before), false);
});


test('checkinCodeBuddy returns unconfigured when no credential exists', async () => {
  const res = await checkinCodeBuddy();
  assert.equal(res.ok, false);
  assert.equal(res.status, 'unconfigured');
  assert.ok(res.message.includes('未检测到 CodeBuddy 国际版登录凭据'));
});

test('checkinCodeBuddy succeeds when the activity chain succeeds (mock hook)', async () => {
  // 配置一个临时 ~/.codebuddy/auth.info
  const cbDir = join(tempHome, '.codebuddy');
  await mkdir(cbDir, { recursive: true });
  await writeFile(join(cbDir, 'auth.info'), JSON.stringify({
    auth: {
      accessToken: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiJ1c2VyMTIzIiwibmlja25hbWUiOiJUZXN0VXNlciIsImV4cCI6OTk5OTk5OTk5OX0.abc',
      refreshToken: 'fake_refresh_token',
      domain: 'www.codebuddy.ai'
    }
  }));

  // 启用测试钩子模拟调用模型发你好成功
  process.env.CODEBUDDY_CHECKIN_MOCK_SUCCESS = '1';
  try {
    const res = await checkinCodeBuddy();
    assert.equal(res.ok, true);
    assert.equal(res.status, 'success');
    assert.ok(res.message.includes('活跃上报与网页会话均已成功'));
    assert.equal(res.accounts.length, 1);
    assert.equal(res.accounts[0].status, 'success');
  } finally {
    delete process.env.CODEBUDDY_CHECKIN_MOCK_SUCCESS;
  }
});

test('runCheckin("codebuddy") integrates with overview and history', async () => {
  process.env.CODEBUDDY_CHECKIN_MOCK_SUCCESS = '1';
  try {
    const res = await runCheckin('codebuddy');
    assert.equal(res.ok, true);
    assert.ok(res.results.codebuddy);
    assert.equal(res.results.codebuddy.status, 'success');

    const overview = await getCheckinOverview();
    assert.ok(overview.platforms.codebuddy);
    assert.equal(overview.platforms.codebuddy.available, true);
    assert.equal(overview.platforms.codebuddy.status, 'success');
    assert.ok(overview.history.some((h) => h.platform === 'codebuddy' && h.status === 'success'));
  } finally {
    delete process.env.CODEBUDDY_CHECKIN_MOCK_SUCCESS;
  }
});

test('两个平台并发 runCheckin：状态、历史和重试计数都合并保留', async () => {
  await writeQoderTestCredentials();
  await writeFile(process.env.AGENTHUB_CHECKIN_STATE!, JSON.stringify({ autoCheckin: true, platforms: {}, history: [] }), 'utf-8');
  const previousEnv = { ...process.env };
  const originalFetch = globalThis.fetch;
  process.env.QODER_UMID_NO_INSTALL = '1';
  process.env.QODER_MACHINE_TOKEN = 'tok-test';
  process.env.QODER_MACHINE_CODE = 'code-test';
  process.env.QODER_MACHINE_TYPE = 'type-test';
  globalThis.fetch = async () => {
    await new Promise((resolve) => setTimeout(resolve, 25));
    return new Response(JSON.stringify({ success: true, campaigns: [] }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  try {
    await Promise.all([runCheckin('qoder'), runCheckin('qoder-cn')]);
    const state = JSON.parse(await readFile(process.env.AGENTHUB_CHECKIN_STATE!, 'utf-8')) as CheckinStateFile;
    assert.equal(state.platforms.qoder.status, 'pending');
    assert.equal(state.platforms['qoder-cn'].status, 'pending');
    assert.equal(state.platforms.qoder.retryCount, 1);
    assert.equal(state.platforms['qoder-cn'].retryCount, 1);
    assert.deepEqual(new Set(state.history.map((row) => row.platform)), new Set(['qoder', 'qoder-cn']));
  } finally {
    globalThis.fetch = originalFetch;
    process.env = previousEnv;
  }
});

test('手动与自动签到并发：自动重试计数递增且不覆盖手动结果', async () => {
  await writeQoderTestCredentials();
  const today = todayStr();
  const platforms: Record<string, CheckinStateRecord> = {};
  for (const plat of CHECKIN_PLATFORMS) {
    const accounts = await listCheckinAccounts(plat);
    platforms[plat] = {
      lastDate: today,
      // A success this late in the day can never fall before a Qoder window start,
      // which keeps the Qoder period rule out of a test about retry accounting.
      lastTime: '23:59:59',
      status: 'success',
      retryCount: 0,
      accounts: accounts.map((account) => ({ identity: account.identity, display: account.display, status: 'success' })),
    };
  }
  platforms['qoder-cn'].status = 'failed';
  platforms['qoder-cn'].retryCount = 2;
  platforms['qoder-cn'].retryBudget = 32;
  await writeFile(process.env.AGENTHUB_CHECKIN_STATE!, JSON.stringify({ autoCheckin: true, platforms, history: [] }), 'utf-8');
  const previousEnv = { ...process.env };
  const originalFetch = globalThis.fetch;
  process.env.QODER_UMID_NO_INSTALL = '1';
  process.env.QODER_MACHINE_TOKEN = 'tok-test';
  process.env.QODER_MACHINE_CODE = 'code-test';
  process.env.QODER_MACHINE_TYPE = 'type-test';
  globalThis.fetch = async () => {
    await new Promise((resolve) => setTimeout(resolve, 25));
    return new Response(JSON.stringify({ success: true, campaigns: [] }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  try {
    // The tick must decide from the state written above, before the manual run's
    // save lands; give it that head start rather than racing the runner's timing.
    const automaticRun = runAutoCheckinTick();
    await new Promise((resolve) => setTimeout(resolve, 5));
    const [, automatic] = await Promise.all([runCheckin('qoder'), automaticRun]);
    assert.deepEqual(automatic, ['qoder-cn']);
    const state = JSON.parse(await readFile(process.env.AGENTHUB_CHECKIN_STATE!, 'utf-8')) as CheckinStateFile;
    assert.equal(state.platforms.qoder.status, 'pending');
    assert.equal(state.platforms.qoder.retryCount, 1);
    assert.equal(state.platforms['qoder-cn'].status, 'pending');
    assert.equal(state.platforms['qoder-cn'].retryCount, 3);
    assert.deepEqual(new Set(state.history.map((row) => row.platform)), new Set(['qoder', 'qoder-cn']));
  } finally {
    globalThis.fetch = originalFetch;
    process.env = previousEnv;
  }
});
