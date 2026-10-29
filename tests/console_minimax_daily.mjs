// MiniMax Code（mcode）签到链路：凭据解析 + 签名头 + 领取分支。
// 全部走桩 fetch，不联网、不碰真实登录态。
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
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

for (const useProfile of [false, true]) {
  test(`MiniMax ${useProfile ? '档案' : '实时'} OAuth 刷新只写回选中的 record，下一次直接使用新凭据`, async (t) => {
    const untouched = { accessToken: 'other-account', refreshToken: 'other-refresh', expiresAtMs: 1 };
    const { home, dir } = await makeHome({
      records: { first: untouched, selected: { accessToken: 'expired-selected', refreshToken: 'refresh-selected', expiresAtMs: Date.now() + 60000 } },
      state: { status: 'authenticated', region: 'cn' },
    });
    t.after(() => rm(home, { recursive: true, force: true }));
    let refreshes = 0;
    t.mock.method(globalThis, 'fetch', async (url, opts) => {
      if (String(url).includes('/oauth2/token')) {
        refreshes++;
        assert.equal(opts.body.get('refresh_token'), 'refresh-selected');
        return Response.json({ access_token: 'refreshed-selected', refresh_token: 'rotated-refresh', expires_in: 3600 });
      }
      if (opts.headers.Authorization === 'Bearer expired-selected') return new Response('{}', { status: 401 });
      assert.equal(opts.headers.Authorization, 'Bearer refreshed-selected');
      return Response.json({ data: { days: [{ day_no: 2, status: 3, is_today: true }] } });
    });
    const mod = await loadModule(home);
    const cred = useProfile ? await mod.readMinimaxCredentialFile(join(dir, 'auth.json')) : '';
    const result = await mod.checkinMiniMax('cn', cred);
    assert.equal(result.status, 'already');
    const saved = JSON.parse(await readFile(join(dir, 'auth.json'), 'utf-8'));
    assert.deepEqual(saved.records.first, untouched);
    assert.equal(saved.records.selected.accessToken, 'refreshed-selected');
    assert.equal(saved.records.selected.refreshToken, 'rotated-refresh');
    const updated = await mod.readMinimaxCredential(home);
    assert.equal(result.credentialVersion, mod.minimaxCredentialVersion(updated));
    assert.equal((await mod.checkinMiniMax('cn', useProfile ? updated : '')).status, 'already');
    assert.equal(refreshes, 1);
  });
}

test('MiniMax 刷新期间新登录写入的 OAuth 不被旧会话覆盖', async (t) => {
  const { home, dir } = await makeHome({
    records: { same: { accessToken: 'old-session', refreshToken: 'old-refresh', expiresAtMs: 1000 } },
    state: { status: 'authenticated', region: 'cn', generation: 1 },
  });
  t.after(() => rm(home, { recursive: true, force: true }));
  const newLogin = { accessToken: 'new-login', refreshToken: 'new-login-refresh', expiresAtMs: 9999999999999 };
  t.mock.method(globalThis, 'fetch', async (url, opts) => {
    if (String(url).includes('/oauth2/token')) {
      await writeFile(join(dir, 'auth.json'), JSON.stringify({ records: { same: newLogin } }));
      await writeFile(join(dir, 'auth-state.json'), JSON.stringify({ status: 'authenticated', region: 'cn', generation: 99 }));
      return Response.json({ access_token: 'old-session-refreshed', refresh_token: 'old-refresh-rotated', expires_in: 3600 });
    }
    if (opts.headers.Authorization === 'Bearer old-session') return new Response('{}', { status: 401 });
    return Response.json({ data: { days: [{ status: 3, is_today: true }] } });
  });
  const mod = await loadModule(home);
  await mod.checkinMiniMax();
  const saved = JSON.parse(await readFile(join(dir, 'auth.json'), 'utf-8'));
  assert.deepEqual(saved.records.same, newLogin);
  assert.equal(JSON.parse(await readFile(join(dir, 'auth-state.json'), 'utf-8')).generation, 99);
});

test('MiniMax 已登出时忽略 auth.json 残留 OAuth', async (t) => {
  const { home } = await makeHome({
    records: { old: { accessToken: 'logged-out', refreshToken: 'logged-out-refresh', expiresAtMs: Date.now() + 60000 } },
    state: { status: 'signed-out', region: 'cn' },
  });
  t.after(() => rm(home, { recursive: true, force: true }));
  const mod = await loadModule(home);
  assert.equal(await mod.readMinimaxCredential(home), null);
});

// 2026-10-29 线上事故：refresh 明明成功换到了新 token，只是重试的 status 又被 401 打回来，
// 结果文案却写「refresh_token 也续不动了，请在控制台重新登录」，把人往重登的方向带。
// 这两条锁死「refresh 失败」与「refresh 成功后仍被拒」必须分开报。
test('refresh 成功但重试仍 401 时，不报「请重新登录」而是报刷新成功', async () => {
  const { home } = await makeHome({
    records: { r: { accessToken: 'stale', refreshToken: 'ref-1', expiresAtMs: Date.now() - 1000 } },
    state: { status: 'authenticated', region: 'cn' },
  });
  const restore = stubFetch(async (url) => {
    const u = String(url);
    if (u.includes('/oauth2/token')) {
      const body = { access_token: 'fresh', refresh_token: 'ref-2', expires_in: 3600 };
      return { status: 200, json: async () => body, text: async () => JSON.stringify(body) };
    }
    // 换新 token 之后仍然被拒（风控 / 签名 / 上游抖动）
    return { status: 401, text: async () => JSON.stringify({ error: 'unauthorized' }) };
  });
  try {
    const mod = await loadModule(home);
    const r = await mod.checkinMiniMax('cn');
    assert.equal(r.ok, false);
    assert.equal(r.status, 'failed', '不是 expired：凭据本身是新的');
    assert.match(r.message, /OAuth 刷新成功/);
    assert.match(r.message, /HTTP 401/);
    assert.ok(!/重新登录/.test(r.message), `不该劝人重新登录，实际：${r.message}`);
  } finally {
    restore();
    await rm(home, { recursive: true, force: true });
  }
});

test('refresh 本身失败时才判定凭据失效并要求重新登录', async () => {
  const { home } = await makeHome({
    records: { r: { accessToken: 'stale', refreshToken: 'dead-refresh', expiresAtMs: Date.now() - 1000 } },
    state: { status: 'authenticated', region: 'cn' },
  });
  const restore = stubFetch(async (url) => {
    const u = String(url);
    if (u.includes('/oauth2/token')) {
      return { status: 400, text: async () => JSON.stringify({ error: 'invalid_grant' }), json: async () => ({ error: 'invalid_grant' }) };
    }
    return { status: 401, text: async () => JSON.stringify({ error: 'unauthorized' }) };
  });
  try {
    const mod = await loadModule(home);
    const r = await mod.checkinMiniMax('cn');
    assert.equal(r.ok, false);
    assert.equal(r.status, 'expired');
    assert.match(r.message, /重新登录/);
  } finally {
    restore();
    await rm(home, { recursive: true, force: true });
  }
});

test('fetchMiniMaxSignin 也带 phase，区分刷新失败与刷新后被拒', async () => {
  const { home } = await makeHome({
    records: { r: { accessToken: 'stale', refreshToken: 'ref-1', expiresAtMs: Date.now() - 1000 } },
    state: { status: 'authenticated', region: 'cn' },
  });
  let statusCalls = 0;
  const restore = stubFetch(async (url) => {
    const u = String(url);
    if (u.includes('/oauth2/token')) {
      const body = { access_token: 'fresh', refresh_token: 'ref-2', expires_in: 3600 };
      return { status: 200, json: async () => body, text: async () => JSON.stringify(body) };
    }
    statusCalls += 1;
    // 第一次 401 触发自愈，续期后重试这次换成 403（上游风控/签名层拒）
    if (statusCalls === 1) return { status: 401, text: async () => JSON.stringify({ error: 'token expired' }) };
    return { status: 403, text: async () => JSON.stringify({ error: 'forbidden' }) };
  });
  try {
    const mod = await loadModule(home);
    const r = await mod.fetchMiniMaxSignin('cn');
    assert.equal(r.panel, null);
    assert.equal(r.phase, 'status_after_refresh');
    assert.equal(r.status, 403, '要把真实的 HTTP 状态透出来，而不是一律 401');
    assert.match(r.message, /OAuth 刷新成功/);
  } finally {
    restore();
    await rm(home, { recursive: true, force: true });
  }
});
