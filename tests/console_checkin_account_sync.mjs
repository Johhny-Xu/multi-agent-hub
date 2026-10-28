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
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const root = await mkdtemp(join(tmpdir(), 'agenthub-checkin-sync-'));
process.env.AGENTHUB_HOME = root;
process.env.AGENTHUB_CHECKIN_STATE = join(root, 'checkin-state.json');

const { getCheckinOverview, listCheckinAccounts, pendingAccountPlatforms } = await import('../console/checkin.mjs');

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
  assert.equal(accounts.filter((a) => a.identity === 'mcode:cn:mmx-one').length, 0, '重复的档案行被合掉');
});
