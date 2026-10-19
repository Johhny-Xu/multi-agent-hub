// @ts-check
// 签到凭据复用与日志清除的回归测试。
// 用 AGENTHUB_HOME / AGENTHUB_CHECKIN_STATE 把读写都指向临时目录——绝不碰真实凭据与线上历史。
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const root = await mkdtemp(join(tmpdir(), 'agenthub-checkin-'));
process.env.AGENTHUB_HOME = root;
process.env.AGENTHUB_CHECKIN_STATE = join(root, 'checkin-state.json');

const mod = await import('../console/checkin.mjs');

/** 造一个 JWT：只需要 payload，代码只解析不验签 */
function fakeJwt(payload) {
  const enc = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
  return `${enc({ alg: 'RS256', typ: 'JWT' })}.${enc(payload)}.sig`;
}

const nowSec = Math.floor(Date.now() / 1000);
const OLD_TOKEN = fakeJwt({ sub: 'u1', nickname: '老凭据', exp: nowSec + 3600 });
const NEW_TOKEN = fakeJwt({ sub: 'u1', nickname: '新凭据', exp: nowSec + 86400 * 20 });
const OTHER_TOKEN = fakeJwt({ sub: 'u2', nickname: '另一个账号', exp: nowSec + 86400 * 10 });

function localToday() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

test('同一账号有多份凭据时，选有效期更长的那份（而不是档案里的旧快照）', async () => {
  const profile = join(root, '.agenthub', 'accounts', 'codebuddy-cn', 'Johhny_Xu');
  await mkdir(profile, { recursive: true });
  await writeFile(join(profile, 'auth.info'), JSON.stringify({ auth: { accessToken: OLD_TOKEN, refreshToken: 'r-old' }, account: {} }), 'utf-8');
  await mkdir(join(root, '.codebuddy-cn'), { recursive: true });
  await writeFile(join(root, '.codebuddy-cn', 'auth.info'), JSON.stringify({
    auth: { accessToken: NEW_TOKEN, refreshToken: 'r-new', domain: 'www.workbuddy.cn' },
    account: { nickname: 'Johhny_Xu' },
  }), 'utf-8');

  const accounts = await mod.listCheckinAccounts('workbuddy');
  assert.equal(accounts.length, 1, '同一身份只保留一条，不能签两次');
  assert.equal(accounts[0].token, NEW_TOKEN, '应使用有效期更长的那份');
  assert.equal(accounts[0].refreshToken, 'r-new', '并保留配套的 refreshToken');
  assert.equal(accounts[0].active, true);
  assert.match(accounts[0].credentialSource, /codebuddy-cn/, '凭据来源指向 CLI 文件');
});

test('不同账号各自保留，不会被去重合并', async () => {
  const other = join(root, '.agenthub', 'accounts', 'codebuddy-cn', 'second');
  await mkdir(other, { recursive: true });
  await writeFile(join(other, 'auth.info'), JSON.stringify({ auth: { accessToken: OTHER_TOKEN, refreshToken: 'r-2' }, account: {} }), 'utf-8');

  const accounts = await mod.listCheckinAccounts('workbuddy');
  assert.equal(accounts.length, 2, '两个不同 UID 都应参与签到');
  const ids = accounts.map((a) => a.identity).sort();
  assert.deepEqual(ids, ['u1', 'u2']);
});

test('CLI 当前凭据优先于档案里的长效旧凭据（重新登录后最常见）', async () => {
  const LONG_OLD = fakeJwt({ data: { id: '9001' }, exp: nowSec + 86400 * 30 });
  const SHORT_NEW = fakeJwt({ data: { id: '9001' }, exp: nowSec + 86400 * 3 });
  const profile = join(root, '.agenthub', 'accounts', 'traecode', 'primary');
  await mkdir(profile, { recursive: true });
  await writeFile(join(profile, 'trae-jwt-token'), LONG_OLD, 'utf-8');
  await mkdir(join(root, '.trae-cn'), { recursive: true });
  await writeFile(join(root, '.trae-cn', 'trae-jwt-token'), SHORT_NEW, 'utf-8');

  const accounts = await mod.listCheckinAccounts('traecode');
  assert.equal(accounts.length, 1);
  assert.equal(accounts[0].token, SHORT_NEW, 'CLI 里正在用的 token 优先，即使旧档案的 exp 更晚');
  assert.match(accounts[0].credentialSource, /trae-cn/);
});

test('同身份的其它候选保留在 alternates 里，供 1001 时回退', async () => {
  const accounts = await mod.listCheckinAccounts('traecode');
  assert.equal(accounts.length, 1);
  assert.ok(Array.isArray(accounts[0].alternates), '带 alternates 列表');
  assert.ok(accounts[0].alternates.length >= 1, '档案里的旧 token 作为备用');
  assert.notEqual(accounts[0].alternates[0].token, accounts[0].token);
});

test('清空日志只清 history，不动今日打卡状态与凭据', async () => {
  const today = localToday();
  await writeFile(process.env.AGENTHUB_CHECKIN_STATE, JSON.stringify({
    autoCheckin: true,
    platforms: {
      workbuddy: { lastDate: today, lastTime: '08:30:00', status: 'already', message: '2 个账号已签', credits: 100, consecutiveDays: 7 },
    },
    history: [
      { time: `${today} 08:30:00`, platform: 'workbuddy', status: 'already', message: '已签' },
      { time: `${today} 08:30:01`, platform: 'traecode', status: 'failed', message: '失败' },
    ],
  }), 'utf-8');

  const res = await mod.clearCheckinHistory();
  assert.equal(res.ok, true);
  assert.equal(res.removed, 2, '返回清掉的条数');
  assert.deepEqual(res.overview.history, [], '历史清空');
  assert.equal(res.overview.platforms.workbuddy.status, 'already', '今日状态保留');
  assert.equal(res.overview.platforms.workbuddy.credits, 100, '今日奖励保留');
  assert.equal(res.overview.platforms.workbuddy.consecutiveDays, 7);
});

test('清空后再清一次是幂等的', async () => {
  const res = await mod.clearCheckinHistory();
  assert.equal(res.ok, true);
  assert.equal(res.removed, 0);
});

test.after(async () => {
  await rm(root, { recursive: true, force: true });
});
