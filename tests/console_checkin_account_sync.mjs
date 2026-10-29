// @ts-check
// 签到区 ↔ worker 账号同步的回归测试。
//
// 背景（2026-10-28 线上实测）：上午 10:22 签完，13:00 在 worker 面板里加了一个 Qoder 账号，
// 签到区到第二天都还是旧的两行 —— 因为旧的 getCheckinOverview 只要「今天签过」就直接回放
// state 里的 accounts 快照，实时账号扫描根本不参与展示。
//
// 这里锁死新约定：账号集合永远以 worker 档案 + 线上凭据为准，今日快照只补状态。
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const root = await mkdtemp(join(tmpdir(), 'agenthub-checkin-sync-'));
process.env.AGENTHUB_HOME = root;
process.env.AGENTHUB_CHECKIN_STATE = join(root, 'checkin-state.json');

const { getCheckinOverview, listCheckinAccounts, pendingAccountPlatforms, checkinMiniMaxPlatform, runCheckin } = await import('../console/checkin.mjs');

const STATE_FILE = join(root, 'checkin-state.json');

function fakeJwt(payload) {
  const enc = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
  return `${enc({ alg: 'RS256', typ: 'JWT' })}.${enc(payload)}.sig`;
}

function localToday() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

const nowSec = Math.floor(Date.now() / 1000);
const TOKEN_A = fakeJwt({ sub: 'user-a', nickname: '甲账号', exp: nowSec + 86400 * 20 });
const TOKEN_B = fakeJwt({ sub: 'user-b', nickname: '乙账号', exp: nowSec + 86400 * 20 });

/** 写一个 CodeBuddy / WorkBuddy 账号档案快照（拍平的 auth.info） */
async function writeAuthProfile(worker, name, token) {
  const dir = join(root, '.agenthub', 'accounts', worker, name);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, 'auth.info'), JSON.stringify({
    auth: { accessToken: token, refreshToken: `r-${name}` },
    account: {},
  }), 'utf-8');
  await writeFile(join(dir, 'meta.json'), JSON.stringify({ identity: `id-${name}`, display: name }), 'utf-8');
}

/** 写今日签到状态：模拟「这些账号今天已经签过了」 */
async function writeState(platform, rows, extra = {}) {
  await writeFile(STATE_FILE, JSON.stringify({
    autoCheckin: true,
    autoCheckinTime: '08:30',
    platforms: {
      [platform]: {
        lastDate: localToday(),
        lastTime: '10:22:00',
        status: 'success',
        message: '今日已签到',
        accounts: rows,
        retryCount: 0,
      },
    },
    history: [],
    ...extra,
  }, null, 2), 'utf-8');
}

/** 清掉上一个用例留下的档案与线上凭据，保证每个用例的前置条件独立 */
async function resetFixtures() {
  for (const rel of ['.agenthub', '.codebuddy-cn', '.codebuddy', '.trae-cn', '.minimax', '.config']) {
    await rm(join(root, rel), { recursive: true, force: true });
  }
}

test.after(async () => { await rm(root, { recursive: true, force: true }); });

test('今日签完之后在 worker 里新加的账号，立刻出现在签到区（而不是等明天）', async () => {
  await resetFixtures();
  await writeAuthProfile('codebuddy-cn', 'first', TOKEN_A);
  await writeAuthProfile('codebuddy-cn', 'second', TOKEN_B);
  // 快照只记了上午签过的 first
  await writeState('workbuddy', [{
    name: 'first', display: '甲账号', identity: 'user-a', active: true,
    status: 'success', message: '签到成功', source: '账号档案快照',
  }]);

  const ov = await getCheckinOverview();
  const rows = ov.platforms.workbuddy.accounts;
  assert.equal(rows.length, 2, '实时扫描出的两个账号都要出现，不能被快照盖住');

  const first = rows.find((r) => r.name === 'first');
  const second = rows.find((r) => r.name === 'second');
  assert.equal(first?.status, 'success', '上午签过的账号保留原状态');
  assert.equal(first?.fresh, undefined, '老账号不该被标成新增');
  assert.equal(second?.status, 'pending', '新账号是待打卡');
  assert.equal(second?.fresh, true, '并标记为新增，前端会显示（新增）');
  assert.match(String(second?.message), /新增账号/);

  assert.equal(ov.platforms.workbuddy.pendingAccounts, 1, '平台级状态是已签，但仍有 1 个账号待补');
  assert.equal(ov.platforms.workbuddy.status, 'success', '平台状态不受新账号影响');
  assert.equal(ov.platforms.workbuddy.accountCount, 2);
});

test('新账号会被「补签 / 定时补签」带上，不用等第二天', async () => {
  const fresh = await pendingAccountPlatforms();
  assert.ok(fresh.includes('workbuddy'), '有新增账号的平台必须进补签队列');
});

test('没有新增账号时 pendingAccounts 归零，按钮回到「今日已签」', async () => {
  await resetFixtures();
  await writeAuthProfile('codebuddy-cn', 'second', TOKEN_B); // 覆盖写，仍只有 first/second
  await writeState('workbuddy', [
    { name: 'first', display: '甲账号', identity: 'user-a', status: 'success', message: '签到成功' },
    { name: 'second', display: '乙账号', identity: 'user-b', status: 'already', message: '今日已签' },
  ]);

  const ov = await getCheckinOverview();
  assert.equal(ov.platforms.workbuddy.accounts.length, 2);
  assert.equal(ov.platforms.workbuddy.pendingAccounts, 0);
  const fresh = await pendingAccountPlatforms();
  assert.ok(!fresh.includes('workbuddy'), '全部签过就不该再补签');
});

test('老快照没有 identity 时按名字/平台规则配对，不会凭空多出一行', async () => {
  await resetFixtures();
  await writeAuthProfile('codebuddy-cn', 'first', TOKEN_A);
  await writeState('workbuddy', [
    { name: 'first', display: '甲账号', status: 'success', message: '签到成功' }, // 旧格式：无 identity
  ]);
  const ov = await getCheckinOverview();
  const rows = ov.platforms.workbuddy.accounts;
  assert.equal(rows.length, 1);
  assert.equal(rows[0].status, 'success');
  assert.equal(rows[0].fresh, undefined);
});

test('凭据今天被删/切走的账号仍保留一行，并标记 stale', async () => {
  await resetFixtures();
  await writeAuthProfile('codebuddy-cn', 'first', TOKEN_A);
  await writeState('workbuddy', [
    { name: 'first', display: '甲账号', identity: 'user-a', status: 'success', message: '签到成功' },
    { name: 'gone', display: '已删账号', identity: 'user-gone', status: 'success', message: '签到成功' },
  ]);
  const ov = await getCheckinOverview();
  const rows = ov.platforms.workbuddy.accounts;
  assert.equal(rows.length, 2, '历史不能因为凭据被移走就消失');
  const gone = rows.find((r) => r.name === 'gone');
  assert.equal(gone?.stale, true);
});

test('平台在等下一期开窗时不算「待补签」，按钮不闪', async () => {
  await resetFixtures();
  await writeAuthProfile('codebuddy-cn', 'first', TOKEN_A);
  const future = Math.floor(Date.now() / 1000) + 3600;
  await writeFile(STATE_FILE, JSON.stringify({
    autoCheckin: true,
    platforms: {
      workbuddy: {
        lastDate: localToday(), lastTime: '10:22:00', status: 'pending', message: '等下一期开窗',
        accounts: [{ name: 'other', display: '另一个号', identity: 'user-z', status: 'pending', message: '等开窗' }],
        retryCount: 1, retryAt: future,
      },
    },
    history: [],
  }, null, 2), 'utf-8');

  const ov = await getCheckinOverview();
  assert.equal(ov.platforms.workbuddy.accounts.filter((r) => r.status === 'pending').length, 2);
  assert.equal(ov.platforms.workbuddy.pendingAccounts, 0, '等待窗口内不催补签');
});

test('Meoo 账号从 worker 档案派生，并与线上同一 AK 去重', async () => {
  await resetFixtures();
  const ak = 'mk-test-0001';
  const dir = join(root, '.agenthub', 'accounts', 'meoo', 'meo-test');
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, 'meoo-auth.env'), `MEOO_AK=${ak}\n`, 'utf-8');
  await mkdir(join(root, '.config', 'agenthub-meoo'), { recursive: true });
  await writeFile(join(root, '.config', 'agenthub-meoo', 'meoo-auth.env'), `MEOO_AK=${ak}\n`, 'utf-8');

  const accounts = await listCheckinAccounts('meoo');
  assert.equal(accounts.length, 1, '同一 AK 只能算一个账号');
  assert.equal(accounts[0].ak, ak, 'AK 要能被签到函数直接拿去 login');
  assert.equal(accounts[0].identity, `meoo:${ak}`);
  assert.equal(accounts[0].active, true, '线上那一份是当前生效账号');
});

test('MiniMax Code 多个账号不再塌缩成一行', async () => {
  await resetFixtures();
  const mkAuth = (token) => JSON.stringify({
    records: { 'com.minimax.mcode.oauth.prod.cn abc': { accessToken: token, refreshToken: `r-${token}`, expiresAtMs: Date.now() + 86400000 } },
  });
  for (const [name, token] of [['mmx-one', 'tok-one'], ['mmx-two', 'tok-two']]) {
    const dir = join(root, '.agenthub', 'accounts', 'minimaxcode', name);
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'auth.json'), mkAuth(token), 'utf-8');
  }
  const accounts = await listCheckinAccounts('minimaxcode');
  assert.equal(accounts.length, 2, '两个不同 token 的档案必须是两个账号');
  const ids = accounts.map((a) => a.identity).sort();
  assert.deepEqual(ids, ['mcode:cn:mmx-one', 'mcode:cn:mmx-two']);
});

test('MiniMax 线上凭据与同 token 的档案快照合并成一行', async () => {
  const liveDir = join(root, '.minimax', 'auth', 'prod', 'cn', 'mcode-public');
  await mkdir(liveDir, { recursive: true });
  await writeFile(join(liveDir, 'auth.json'), JSON.stringify({
    records: { 'com.minimax.mcode.oauth.prod.cn live': { accessToken: 'tok-one', refreshToken: 'r-live', expiresAtMs: Date.now() + 86400000 } },
  }), 'utf-8');

  const accounts = await listCheckinAccounts('minimaxcode');
  assert.equal(accounts.length, 2, '线上那一份与 mmx-one 同 token，只留 active 行；另一个账号照旧');
  const active = accounts.filter((a) => a.active);
  assert.equal(active.length, 1);
  assert.equal(active[0].token, 'tok-one');
  assert.equal(active[0].name, 'mmx-one', '合并后要沿用档案名，不能退化成「(当前登录)」');
  assert.equal(accounts.filter((a) => a.identity === 'mcode:cn:mmx-one').length, 1, '沿用档案身份，刷新或切换后不变');
});

async function writeMiniMax(name, token, { region = 'cn', active = false } = {}) {
  const dir = name
    ? join(root, '.agenthub', 'accounts', 'minimaxcode', name)
    : join(root, '.minimax', 'auth', 'prod', region === 'global' ? 'en' : 'cn', 'mcode-public');
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, 'auth.json'), JSON.stringify({
    records: { [`oauth-${region}`]: { accessToken: token, refreshToken: `refresh-${token}`, expiresAtMs: Date.now() + 86400000 } },
  }));
  await writeFile(join(dir, 'auth-state.json'), JSON.stringify({ status: 'authenticated', region }));
  if (name && active) await writeFile(join(root, '.agenthub', 'accounts', 'minimaxcode', '.active'), name);
}

function mockMiniMax(t, validTokens) {
  const calls = [];
  t.mock.method(globalThis, 'fetch', async (url, opts = {}) => {
    const token = String(opts.headers?.Authorization || '').replace(/^Bearer /, '');
    calls.push({ url: String(url), token });
    if (String(url).includes('/oauth2/token')) return new Response('{}', { status: 401 });
    assert.match(String(url), /\/signin\/status/);
    if (!validTokens.includes(token)) return new Response('{}', { status: 401 });
    return Response.json({ data: { days: [{ day_no: 1, status: 3, is_today: true }] } });
  });
  return calls;
}

test('MiniMax Worker 新 OAuth 优先于签到手工旧 Token', async (t) => {
  await resetFixtures();
  await writeMiniMax('current', 'new-oauth', { active: true });
  await writeMiniMax('', 'new-oauth');
  await writeState('minimaxcode', [], { customTokens: { minimaxcode: 'expired-manual' } });
  const calls = mockMiniMax(t, ['new-oauth']);
  const result = await checkinMiniMaxPlatform();
  assert.equal(result.status, 'already');
  assert.deepEqual(calls.map((c) => c.token), ['new-oauth']);
});

test('MiniMax 仅有 Worker 档案时仍可签到，手工 Token 不覆盖档案', async (t) => {
  await resetFixtures();
  await writeMiniMax('saved', 'profile-oauth', { active: true });
  await writeState('minimaxcode', [], { customTokens: { minimaxcode: 'expired-manual' } });
  const calls = mockMiniMax(t, ['profile-oauth']);
  const result = await checkinMiniMaxPlatform();
  assert.equal(result.status, 'already');
  assert.equal(result.accounts[0].name, 'saved');
  assert.deepEqual(calls.map((c) => c.token), ['profile-oauth']);
  const overview = await getCheckinOverview();
  assert.equal(overview.platforms.minimaxcode.available, true);
  assert.equal(overview.platforms.minimaxcode.credentialMode, 'cli');
  assert.equal(overview.platforms.minimaxcode.autoRefresh, true);
});

test('MiniMax 没有 Worker 凭据时才使用手工 Token', async (t) => {
  await resetFixtures();
  await writeState('minimaxcode', [], { customTokens: { minimaxcode: 'manual-only' } });
  const calls = mockMiniMax(t, ['manual-only']);
  assert.equal((await checkinMiniMaxPlatform()).status, 'already');
  assert.deepEqual(calls.map((c) => c.token), ['manual-only']);
});

test('MiniMax active 档案旧 OAuth 被实时新 OAuth 替换，不重复签到旧凭据', async (t) => {
  await resetFixtures();
  await writeMiniMax('current', 'old-oauth', { active: true });
  await writeMiniMax('other', 'other-oauth');
  await writeMiniMax('', 'new-oauth');
  await writeState('minimaxcode', []);
  const calls = mockMiniMax(t, ['new-oauth', 'other-oauth']);
  const accounts = await listCheckinAccounts('minimaxcode');
  assert.equal(accounts.length, 2);
  assert.equal(accounts.find((a) => a.active)?.name, 'current');
  assert.equal(accounts.find((a) => a.active)?.token, 'new-oauth');
  assert.equal((await checkinMiniMaxPlatform()).status, 'already');
  assert.deepEqual(calls.map((c) => c.token).sort(), ['new-oauth', 'other-oauth']);
});

test('MiniMax 同一档案更新 OAuth 后，耗尽重试的失败签到自动重新入队且只重试一次', async (t) => {
  await resetFixtures();
  await writeMiniMax('current', 'expired-oauth', { active: true });
  await writeMiniMax('', 'expired-oauth');
  await writeState('minimaxcode', []);
  mockMiniMax(t, ['new-oauth']);
  const first = await runCheckin('minimaxcode');
  assert.equal(first.results.minimaxcode.accounts[0].status, 'expired');
  assert.ok(!(await pendingAccountPlatforms()).includes('minimaxcode'), '未换凭据不得无限重试');
  const state = JSON.parse(await readFile(STATE_FILE, 'utf-8'));
  state.platforms.minimaxcode.retryCount = 8;
  for (const plat of ['workbuddy', 'codebuddy', 'traecode', 'codearts', 'qoder', 'qoder-cn', 'meoo']) {
    state.platforms[plat] = { lastDate: localToday(), status: 'already', accounts: [] };
  }
  await writeFile(STATE_FILE, JSON.stringify(state));
  await writeMiniMax('', 'new-oauth');
  const overview = await getCheckinOverview();
  const rows = overview.platforms.minimaxcode.accounts;
  assert.equal(rows.length, 1);
  assert.equal(rows[0].status, 'pending');
  assert.equal(rows[0].fresh, true);
  assert.equal(overview.platforms.minimaxcode.pendingAccounts, 1);
  assert.ok((await pendingAccountPlatforms()).includes('minimaxcode'));
  const retried = await runCheckin('due');
  assert.deepEqual(Object.keys(retried.results), ['minimaxcode']);
  assert.equal(retried.results.minimaxcode.status, 'already');
  assert.ok(!(await pendingAccountPlatforms()).includes('minimaxcode'));
  const saved = await readFile(STATE_FILE, 'utf-8');
  assert.ok(!saved.includes('new-oauth') && !saved.includes('expired-oauth'), '状态文件不能持久化 OAuth 明文');
});

test('MiniMax 成功签到后正常刷新 OAuth，不重复入队', async (t) => {
  await resetFixtures();
  await writeMiniMax('current', 'oauth-before', { active: true });
  await writeMiniMax('', 'oauth-before');
  await writeState('minimaxcode', []);
  mockMiniMax(t, ['oauth-before']);
  await runCheckin('minimaxcode');
  await writeMiniMax('', 'oauth-after');
  assert.equal((await getCheckinOverview()).platforms.minimaxcode.accounts.length, 1);
  assert.ok(!(await pendingAccountPlatforms()).includes('minimaxcode'));
});

test('MiniMax 已移走的失效 OAuth 不再占据签到账号和待签计数', async () => {
  await resetFixtures();
  await writeMiniMax('current', 'new-oauth', { active: true });
  await writeState('minimaxcode', [{ name: 'removed', identity: 'mcode:cn:removed', status: 'expired' }]);
  const overview = await getCheckinOverview();
  assert.equal(overview.platforms.minimaxcode.accounts.length, 1);
  assert.equal(overview.platforms.minimaxcode.pendingAccounts, 1);
});

test('MiniMax 国内与国际凭据各走自己的区域，不遗漏另一套实时凭据', async (t) => {
  await resetFixtures();
  await writeMiniMax('', 'cn-oauth');
  await writeMiniMax('', 'global-oauth', { region: 'global' });
  await writeMiniMax('global', 'global-oauth', { region: 'global' });
  await writeState('minimaxcode', []);
  const calls = mockMiniMax(t, ['cn-oauth', 'global-oauth']);
  assert.equal((await checkinMiniMaxPlatform()).accounts.length, 2);
  assert.ok(calls.some((c) => c.token === 'cn-oauth' && new URL(c.url).hostname === 'agent.minimax.cn'));
  assert.ok(calls.some((c) => c.token === 'global-oauth' && new URL(c.url).hostname === 'agent.minimax.io'));
});

test('MiniMax Worker 已归为历史快照的旧身份，不再作为另一个签到账号', async (t) => {
  await resetFixtures();
  await writeMiniMax('legacy', 'old-oauth');
  await writeMiniMax('current', 'new-oauth', { active: true });
  await writeMiniMax('', 'new-oauth');
  const dir = join(root, '.agenthub', 'accounts', 'minimaxcode');
  await writeFile(join(dir, 'legacy', 'meta.json'), JSON.stringify({ identity: 'aabbccddeeff' }));
  await writeFile(join(dir, 'current', 'meta.json'), JSON.stringify({ identity: 'mcode:cn', display: 'Worker 当前账号' }));
  await writeState('minimaxcode', [{ name: 'legacy', identity: 'mcode:cn:legacy', status: 'expired' }]);
  const calls = mockMiniMax(t, ['new-oauth']);
  const accounts = await listCheckinAccounts('minimaxcode');
  assert.equal(accounts.length, 1);
  assert.equal(accounts[0].display, 'Worker 当前账号');
  assert.equal((await checkinMiniMaxPlatform()).status, 'already');
  assert.deepEqual(calls.map((c) => c.token), ['new-oauth']);
  assert.equal((await getCheckinOverview()).platforms.minimaxcode.accounts.length, 1);
});

test('MiniMax 只有档案且未配置手工 Token 时也不会误报未登录', async (t) => {
  await resetFixtures();
  await writeMiniMax('saved', 'profile-only');
  await writeState('minimaxcode', []);
  mockMiniMax(t, ['profile-only']);
  assert.equal((await checkinMiniMaxPlatform()).status, 'already');
});

test('MiniMax 不同具名身份都保留，即使 Worker 元数据将 mcode 标为可变身份', async (t) => {
  await resetFixtures();
  for (const name of ['alice', 'bob']) {
    await writeMiniMax(name, `oauth-${name}`, { active: name === 'alice' });
    await writeFile(join(root, '.agenthub', 'accounts', 'minimaxcode', name, 'meta.json'), JSON.stringify({ identity: `mcode:cn:${name}` }));
  }
  await writeMiniMax('', 'oauth-alice');
  await writeState('minimaxcode', []);
  const calls = mockMiniMax(t, ['oauth-alice', 'oauth-bob']);
  const result = await checkinMiniMaxPlatform();
  assert.equal(result.accounts.length, 2);
  assert.equal(result.status, 'already');
  assert.deepEqual(calls.map((c) => c.token).sort(), ['oauth-alice', 'oauth-bob']);
});

test('MiniMax 双区域续期同步原档案，不因 active 只指向国内账号而裂档', async (t) => {
  await resetFixtures();
  await writeMiniMax('cn-profile', 'cn-oauth', { active: true });
  await writeMiniMax('', 'cn-oauth');
  await writeMiniMax('global-profile', 'global-old', { region: 'global' });
  await writeMiniMax('', 'global-old', { region: 'global' });
  await writeState('minimaxcode', []);
  let refreshes = 0;
  t.mock.method(globalThis, 'fetch', async (url, opts) => {
    if (String(url).includes('/oauth2/token')) {
      refreshes++;
      assert.equal(new URL(url).hostname, 'account.minimax.io');
      return Response.json({ access_token: 'global-new', refresh_token: 'global-refreshed', expires_in: 3600 });
    }
    if (opts.headers.Authorization === 'Bearer global-old') return new Response('{}', { status: 401 });
    assert.ok(['Bearer global-new', 'Bearer cn-oauth'].includes(opts.headers.Authorization));
    return Response.json({ data: { days: [{ status: 3, is_today: true }] } });
  });
  const result = await runCheckin('minimaxcode');
  assert.equal(result.results.minimaxcode.status, 'already');
  assert.equal((await listCheckinAccounts('minimaxcode')).length, 2);
  assert.ok(!(await pendingAccountPlatforms()).includes('minimaxcode'));
  const profile = JSON.parse(await readFile(join(root, '.agenthub', 'accounts', 'minimaxcode', 'global-profile', 'auth.json'), 'utf-8'));
  assert.equal(profile.records['oauth-global'].accessToken, 'global-new');
  assert.equal((await checkinMiniMaxPlatform()).accounts.length, 2);
  assert.equal(refreshes, 1);
});
