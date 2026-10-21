// @ts-check
// 签到凭据复用与日志清除的回归测试。
// 用 AGENTHUB_HOME / AGENTHUB_CHECKIN_STATE 把读写都指向临时目录——绝不碰真实凭据与线上历史。
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createCipheriv, randomBytes, scryptSync } from 'node:crypto';

const root = await mkdtemp(join(tmpdir(), 'agenthub-checkin-'));
process.env.AGENTHUB_HOME = root;
process.env.AGENTHUB_CHECKIN_STATE = join(root, 'checkin-state.json');

const mod = await import('../console/checkin.mjs');
const { readQoderCredential, readQoderCredentialAt, persistQoderToken } = await import('../console/qoder.mjs');

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

/** 合成 Qoder CLI 文件回退凭据：盐 + AES-256-GCM(nonce:tag:cipher) */
async function writeQoderCredHome(home, worker, { uid, name, token, refreshToken, exp }) {
  const dir = join(home, worker === 'qoder-cn' ? '.qoder-cn' : '.qoder');
  await mkdir(dir, { recursive: true });
  const salt = randomBytes(32);
  await writeFile(join(dir, '.keychain-salt'), salt);
  const credential = {
    serverName: worker === 'qoder-cn' ? 'qoder.com.cn' : 'qoder.com',
    token: { accessToken: token, tokenType: 'Bearer', expiresAt: exp * 1000 },
    refreshToken,
  };
  if (uid) credential.user = { id: uid, name, email: `${uid}@example.com` };
  const data = { qoder: { [credential.serverName]: JSON.stringify(credential) } };
  const key = scryptSync('qoder-cli-credentials', salt, 32);
  const iv = randomBytes(16);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const enc = Buffer.concat([cipher.update(JSON.stringify(data), 'utf-8'), cipher.final()]);
  await writeFile(join(dir, 'qoder-cli-credentials.json'), `${iv.toString('hex')}:${cipher.getAuthTag().toString('hex')}:${enc.toString('hex')}`);
}

async function writeQoderLegacyHome(home, worker, payload, machineId = '0123456789abcdef-legacy-machine') {
  const auth = join(home, worker === 'qoder-cn' ? '.qoder-cn' : '.qoder', '.auth');
  await mkdir(auth, { recursive: true });
  await writeFile(join(auth, 'machine_id'), `${machineId}\n`);
  const key = Buffer.from(machineId.slice(0, 16), 'utf-8');
  const cipher = createCipheriv('aes-128-cbc', key, key);
  const plain = Buffer.from(JSON.stringify(payload), 'utf-8');
  const enc = Buffer.concat([cipher.update(plain), cipher.final()]).toString('base64');
  await writeFile(join(auth, 'user'), enc);
}

async function writeQoderCredProfile(worker, profile, credential, exp) {
  const dir = join(root, '.agenthub', 'accounts', worker, profile);
  await mkdir(dir, { recursive: true });
  const salt = randomBytes(32);
  await writeFile(join(dir, '.keychain-salt'), salt);
  const data = { qoder: { 'qoder.com': JSON.stringify({
    serverName: 'qoder.com',
    token: { accessToken: credential.token, tokenType: 'Bearer', expiresAt: exp * 1000 },
    refreshToken: credential.refreshToken,
    user: { id: credential.uid, name: credential.name, email: `${credential.uid}@example.com` },
  }) } };
  const key = scryptSync('qoder-cli-credentials', salt, 32);
  const iv = randomBytes(16);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const enc = Buffer.concat([cipher.update(JSON.stringify(data), 'utf-8'), cipher.final()]);
  await writeFile(join(dir, 'qoder-cli-credentials.json'), `${iv.toString('hex')}:${cipher.getAuthTag().toString('hex')}:${enc.toString('hex')}`);
  await writeFile(join(dir, 'meta.json'), JSON.stringify({ identity: `qoder:${credential.uid}`, display: credential.name }), 'utf-8');
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

test('Qoder 凭据解密成功，并与档案中的同一账号合并（CLI 在线凭据优先）', async () => {
  const nowSecQ = Math.floor(Date.now() / 1000);
  await writeQoderCredHome(root, 'qoder', {
    uid: '7001', name: 'Henry', token: 'dt-live', refreshToken: 'drt-live', exp: nowSecQ + 86400 * 10,
  });
  await writeQoderCredProfile('qoder', 'qd-old', {
    uid: '7001', name: 'Henry', token: 'dt-old', refreshToken: 'drt-old',
  }, nowSecQ + 86400 * 20);

  const accounts = await mod.listCheckinAccounts('qoder');
  assert.equal(accounts.length, 1, '同一 UID 只保留一条');
  assert.equal(accounts[0].identity, 'qoder:7001');
  assert.equal(accounts[0].token, 'dt-live', 'CLI 当前在用的凭据优先于档案里的长效旧 token');
  assert.equal(accounts[0].active, true);
  assert.ok(accounts[0].alternates.some((a) => a.token === 'dt-old'), '旧档案保留为回退候选');
});

test('Qoder CN 使用独立的 ~/.qoder-cn 凭据', async () => {
  const nowSecQ = Math.floor(Date.now() / 1000);
  await writeQoderCredHome(root, 'qoder-cn', {
    uid: '7002', name: 'CN User', token: 'dt-cn', refreshToken: 'drt-cn', exp: nowSecQ + 86400 * 5,
  });
  const accounts = await mod.listCheckinAccounts('qoder-cn');
  assert.equal(accounts.length, 1);
  assert.equal(accounts[0].identity, 'qoder:7002');
  assert.equal(accounts[0].token, 'dt-cn');
});

test('签到概览同时包含 Qoder 与 Qoder CN，且能识别已登录凭据', async () => {
  const overview = await mod.getCheckinOverview();
  assert.ok(overview.platforms.qoder, '国际版卡片');
  assert.ok(overview.platforms['qoder-cn'], '国内版卡片');
  assert.equal(overview.platforms.qoder.available, true);
  assert.equal(overview.platforms['qoder-cn'].available, true);
  assert.equal(overview.platforms.qoder.autoRefresh, true, '带 refreshToken 时自动续期');
});

test('Qoder 凭据没有用户信息时用 refreshToken 指纹区分账号，不会被切换覆盖', async () => {
  const anonHome = join(root, 'anon-home');
  const nowSecQ = Math.floor(Date.now() / 1000);
  await writeQoderCredHome(anonHome, 'qoder', { token: 'dt-a1', refreshToken: 'drt-a', exp: nowSecQ + 3600 });
  const first = await readQoderCredentialAt(join(anonHome, '.qoder'), 'qoder');
  await writeQoderCredHome(anonHome, 'qoder', { token: 'dt-b1', refreshToken: 'drt-b', exp: nowSecQ + 3600 });
  const second = await readQoderCredentialAt(join(anonHome, '.qoder'), 'qoder');
  await writeQoderCredHome(anonHome, 'qoder', { token: 'dt-a2', refreshToken: 'drt-a', exp: nowSecQ + 7200 });
  const refreshed = await readQoderCredentialAt(join(anonHome, '.qoder'), 'qoder');

  assert.match(first.primary.identity, /^qoder-token:/);
  assert.notEqual(first.primary.identity, second.primary.identity, '不同 refreshToken 是不同账号');
  assert.equal(first.primary.identity, refreshed.primary.identity, 'accessToken 刷新但 refreshToken 未变，身份保持稳定');
});

test('Qoder CLI 主登录态 .auth/user 可解密、可回写', async () => {
  const home = join(root, 'legacy-home');
  const nowSecQ = Math.floor(Date.now() / 1000);
  await writeQoderLegacyHome(home, 'qoder', {
    token: 'dt-legacy',
    refreshToken: 'drt-legacy',
    expiresAt: new Date((nowSecQ + 3600) * 1000).toISOString(),
    uid: '8001',
    nickname: 'Legacy User',
    email: 'legacy@example.com',
    user: { id: '8001', name: 'Legacy User', email: 'legacy@example.com' },
  });
  const cred = await readQoderCredential(home, 'qoder');
  assert.equal(cred.ok, true);
  assert.equal(cred.primary.identity, 'qoder:8001');
  assert.equal(cred.primary.display, 'Legacy User (legacy@example.com)');
  assert.equal(cred.primary.token, 'dt-legacy');
  assert.equal(cred.primary.format, 'legacy');

  const saved = await persistQoderToken({
    credFile: cred.file,
    saltFile: cred.saltFile,
    identity: 'qoder:8001',
    token: 'dt-legacy-2',
    refreshToken: 'drt-legacy-2',
    expiresAt: nowSecQ + 7200,
  });
  assert.equal(saved, true);
  const again = await readQoderCredential(home, 'qoder');
  assert.equal(again.primary.token, 'dt-legacy-2');
  assert.equal(again.primary.refreshToken, 'drt-legacy-2');
  assert.ok(again.primary.expiresAt >= nowSecQ + 7000);
});

test('Qoder 一键签到会拉取活动并逐个领取（幂等重放不重复计数）', async () => {
  const realFetch = globalThis.fetch;
  const prevEnv = { ...process.env };
  // 单测不碰真机 UMID 组件、也不去 npm 下包：显式指向一个不存在的组件即可短路
  process.env.QODER_UMID_PATH = join(root, 'no-such-runtime-info');
  process.env.QODER_UMID_NO_INSTALL = '1';
  const calls = [];
  globalThis.fetch = async (url, options = {}) => {
    calls.push(`${options.method || 'GET'} ${url}`);
    if (/\/me\/campaigns(\?|$)/.test(String(url))) {
      return new Response(JSON.stringify({
        data: {
          campaigns: [
            { campaignId: 'c1', actionType: 'CLAIM_BENEFIT', claimStatus: 'CLAIMABLE', benefit: { kind: 'CREDITS', amount: 100 } },
            { campaignId: 'c2', actionType: 'CLAIM_BENEFIT', claimStatus: 'CLAIMED', benefit: { kind: 'CREDITS', amount: 50 } },
            // 常驻的「查看详情」活动：以前会被算成今日已领，现在必须忽略
            { campaignId: 'v1', actionType: 'VIEW_DETAILS', claimStatus: 'CLAIMED' },
          ],
        },
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    if (String(url).endsWith('/campaigns/c1/claim')) {
      return new Response(JSON.stringify({ status: 'CLAIMED' }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    if (String(url).endsWith('/campaigns/c2/claim')) {
      return new Response(JSON.stringify({ status: 'CLAIMED', replayed: true }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    return new Response('{}', { status: 404, headers: { 'Content-Type': 'application/json' } });
  };
  try {
    const res = await mod.runCheckin('qoder');
    assert.equal(res.results.qoder.ok, true);
    assert.equal(res.results.qoder.status, 'success');
    assert.equal(res.results.qoder.credits, 100, '只为 CLAIMABLE 活动计数');
    assert.match(res.results.qoder.message, /领取 1 个活动/);
    assert.match(res.results.qoder.message, /1 个今日已领/);
    assert.ok(calls.some((c) => c.includes('/me/campaigns?forceRefresh=true')), '活动列表必须带 forceRefresh');
    assert.ok(calls.some((c) => c.startsWith('POST ') && c.includes('/campaigns/c1/claim')));
    assert.ok(!calls.some((c) => c.includes('/campaigns/c2/claim')), '已领取的活动不再请求');
    assert.ok(!calls.some((c) => c.includes('/campaigns/v1/claim')), 'VIEW_DETAILS 活动不参与领取');
    assert.equal(res.overview.platforms.qoder.status, 'success');
    assert.equal(res.overview.platforms.qoder.credits, 100);
  } finally {
    globalThis.fetch = realFetch;
    process.env = prevEnv;
  }
});

test('清空日志只清 history，不动今日打卡状态与凭据', async () => {
  const today = localToday();
  await writeFile(process.env.AGENTHUB_CHECKIN_STATE, JSON.stringify({
    autoCheckin: true,
    platforms: {
      workbuddy: { lastDate: today, lastTime: '08:30:00', status: 'already', message: '2 个账号已签', credits: 100, consecutiveDays: 7 },
      qoder: { lastDate: today, lastTime: '08:31:00', status: 'success', message: '领取 1 个活动，+100 Credits', credits: 100, consecutiveDays: 3 },
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
  assert.equal(res.overview.platforms.qoder.status, 'success', 'Qoder 今日状态保留');
  assert.equal(res.overview.platforms.qoder.credits, 100);
});

test('清空后再清一次是幂等的', async () => {
  const res = await mod.clearCheckinHistory();
  assert.equal(res.ok, true);
  assert.equal(res.removed, 0);
});

test.after(async () => {
  await rm(root, { recursive: true, force: true });
});
