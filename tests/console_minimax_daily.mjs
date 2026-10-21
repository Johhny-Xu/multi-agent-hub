// MiniMax Code（mcode）签到链路：凭据解析 + 签名头 + 领取分支。
// 全部走桩 fetch，不联网、不碰真实登录态。
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let seq = 0;

/** 造一个带 mcode 登录态的临时 HOME，返回 { home, dir } */
async function makeHome({ records, state } = {}) {
  const home = await mkdtemp(join(tmpdir(), 'mmx-checkin-'));
  const dir = join(home, '.minimax', 'auth', 'prod', 'cn', 'mcode-public');
  await mkdir(dir, { recursive: true });
  if (records) await writeFile(join(dir, 'auth.json'), JSON.stringify({ schemaVersion: 2, records }, null, 2));
  if (state) await writeFile(join(dir, 'auth-state.json'), JSON.stringify(state, null, 2));
  return { home, dir };
}

/** 每次都拿一份全新的模块实例，好让 AGENTHUB_HOME 在 import 时生效 */
async function loadModule(home) {
  process.env.AGENTHUB_HOME = home;
  return import(`../console/minimax-checkin.mjs?case=${++seq}`);
}

function stubFetch(handler) {
  const original = globalThis.fetch;
  globalThis.fetch = handler;
  return () => { globalThis.fetch = original; };
}

const MD5_HEX = /^[0-9a-f]{32}$/;

test('readMinimaxCredential 取 expiresAtMs 最晚的一条，region 来自 auth-state', async () => {
  const { home } = await makeHome({
    records: {
      'com.minimax.mcode.oauth.prod.cn old': { accessToken: 'tok-old', refreshToken: 'ref-old', expiresAtMs: 1_000 },
      'com.minimax.mcode.oauth.prod.cn new': { accessToken: 'tok-new', refreshToken: 'ref-new', expiresAtMs: 9_000 },
    },
    state: { status: 'authenticated', region: 'cn' },
  });
  const mod = await loadModule(home);
  const cred = await mod.readMinimaxCredential(home, 'cn');
  assert.equal(cred.token, 'tok-new');
  assert.equal(cred.refreshToken, 'ref-new');
  assert.equal(cred.region, 'cn');
  assert.equal(cred.status, 'authenticated');
  assert.match(cred.source, /\.minimax\/auth\/prod\/cn\/mcode-public\/auth\.json$/);
  await rm(home, { recursive: true, force: true });
});

test('readMinimaxCredential 在没有 records 时返回 null（不把空文件当登录态）', async () => {
  const { home } = await makeHome({ records: {}, state: { status: 'signed-out', region: 'cn' } });
  const mod = await loadModule(home);
  assert.equal(await mod.readMinimaxCredential(home, 'cn'), null);
  await rm(home, { recursive: true, force: true });
});

test('国际版 auth 目录是 en，不是 global', async () => {
  const mod = await loadModule(tmpdir());
  assert.equal(mod.MINIMAX_REGIONS.global.authDir, 'en');
  assert.equal(mod.MINIMAX_REGIONS.cn.authDir, 'cn');
  const dir = mod.minimaxAuthDir('/home/u', 'global').split(/[\\/]/).join('/');
  assert.ok(dir.endsWith('/.minimax/auth/prod/en/mcode-public'), `实际路径：${dir}`);
});

test('可领取时发 POST /signin/claim，签名头齐全，返回 success 与积分', async () => {
  const { home } = await makeHome({
    records: { r: { accessToken: 'tok', refreshToken: 'ref', expiresAtMs: Date.now() + 3600_000 } },
    state: { status: 'authenticated', region: 'cn' },
  });
  const calls = [];
  const restore = stubFetch(async (url, opts = {}) => {
    calls.push({ url: String(url), method: opts.method || 'GET', headers: opts.headers || {} });
    const body = String(url).includes('/signin/claim')
      ? { data: { claim_result: 1, day_no: 3, points: 400, bonus_points: 100 } }
      : { data: { days: [{ day_no: 3, status: 2, points: 400, bonus_points: 100, is_today: true }] } };
    return { status: 200, text: async () => JSON.stringify(body) };
  });
  try {
    const mod = await loadModule(home);
    const r = await mod.checkinMiniMax('cn');
    assert.equal(r.status, 'success');
    assert.equal(r.credits, 500);
    assert.equal(r.consecutiveDays, 3);
    const claim = calls.find((c) => c.url.includes('/signin/claim'));
    assert.ok(claim, '应当调用 signin/claim');
    assert.equal(claim.method, 'POST');
    assert.match(claim.headers['x-signature'], MD5_HEX);
    assert.match(claim.headers.yy, MD5_HEX);
    assert.match(claim.headers['x-timestamp'], /^\d{10}$/);
    assert.equal(claim.headers.Authorization, 'Bearer tok');
    // 参数键序与桌面端一致，且签名路径带 client=desktop
    assert.match(claim.url, /device_platform=web&biz_id=3&app_id=3001&version_code=22201&unix=\d{13}/);
    assert.match(claim.url, /op_ticket=undefined/);
    assert.match(claim.url, /&client=desktop$/);
  } finally {
    restore();
    await rm(home, { recursive: true, force: true });
  }
});

test('今日已领取（status=3）时只查不领', async () => {
  const { home } = await makeHome({
    records: { r: { accessToken: 'tok', expiresAtMs: Date.now() + 3600_000 } },
    state: { status: 'authenticated', region: 'cn' },
  });
  const calls = [];
  const restore = stubFetch(async (url) => {
    calls.push(String(url));
    return {
      status: 200,
      text: async () => JSON.stringify({ data: { days: [{ day_no: 3, status: 3, points: 400, bonus_points: 0, is_today: true }] } }),
    };
  });
  try {
    const mod = await loadModule(home);
    const r = await mod.checkinMiniMax('cn');
    assert.equal(r.status, 'already');
    assert.equal(r.credits, 0);
    assert.equal(calls.filter((u) => u.includes('/signin/claim')).length, 0, '已领取时不得再发 claim');
  } finally {
    restore();
    await rm(home, { recursive: true, force: true });
  }
});

test('未登录时返回 unconfigured，且一个请求都不发', async () => {
  const home = await mkdtemp(join(tmpdir(), 'mmx-checkin-'));
  let called = 0;
  const restore = stubFetch(async () => { called += 1; return { status: 200, text: async () => '{}' }; });
  try {
    const mod = await loadModule(home);
    const r = await mod.checkinMiniMax('cn');
    assert.equal(r.status, 'unconfigured');
    assert.equal(called, 0);
  } finally {
    restore();
    await rm(home, { recursive: true, force: true });
  }
});

test('401 用 refresh_token 续期后重试，并把新 token 写回 auth.json', async () => {
  const { home, dir } = await makeHome({
    records: { r: { accessToken: 'stale', refreshToken: 'ref-1', expiresAtMs: Date.now() + 3600_000 } },
    state: { status: 'authenticated', region: 'cn' },
  });
  let statusCalls = 0;
  const restore = stubFetch(async (url) => {
    const u = String(url);
    if (u.includes('/oauth2/token')) {
      const body = { access_token: 'fresh', refresh_token: 'ref-2', expires_in: 3600 };
      // oauthRefresh 走 res.json()，apiCall 走 res.text()：两种都给
      return { status: 200, json: async () => body, text: async () => JSON.stringify(body) };
    }
    statusCalls += 1;
    if (statusCalls === 1) return { status: 401, text: async () => JSON.stringify({ error: 'invalid token' }) };
    return {
      status: 200,
      text: async () => JSON.stringify({ data: { days: [{ day_no: 3, status: 3, points: 400, bonus_points: 0, is_today: true }] } }),
    };
  });
  try {
    const mod = await loadModule(home);
    const r = await mod.checkinMiniMax('cn');
    assert.equal(r.status, 'already');
    assert.match(r.source, /自动续期/);
    const saved = JSON.parse(await (await import('node:fs/promises')).readFile(join(dir, 'auth.json'), 'utf-8'));
    const record = Object.values(saved.records)[0];
    assert.equal(record.accessToken, 'fresh');
    assert.equal(record.refreshToken, 'ref-2');
  } finally {
    restore();
    await rm(home, { recursive: true, force: true });
  }
});
