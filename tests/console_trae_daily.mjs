// @ts-check
// Trae 签到实现（移植 L0NE-6/Trae-AutoCheckin）的回归测试：
//   1. 桌面端 storage.json 解密（tc 头 + AES-128-CBC + sha512 校验）
//   2. 真实设备号识别（两种键写法）、设备号分配
//   3. 请求头只发一个小写 x-device-id
//   4. 签到链路：先查状态 → 领取 → 同设备号回查确认；9095/9074/1001 的语义
//   5. 1001 时用 refreshToken + 设备证明续期并落盘缓存
import test from 'node:test';
import assert from 'node:assert/strict';
import { createSign, generateKeyPairSync } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const trae = await import('../console/trae-checkin.mjs');

const b64url = (obj) => Buffer.from(JSON.stringify(obj)).toString('base64url');
const fakeJwt = (payload) => `${b64url({ alg: 'RS256' })}.${b64url(payload)}.sig`;

// ---------------------------------------------------------------- storage 解密

test('storage 加密值可以解密回来（tc 头 + sha512 校验）', () => {
  const plain = JSON.stringify({ accessToken: 'eyJ-abc', refreshToken: 'rt-xyz' });
  const cipher = trae.encryptTraeStorageValue(plain);
  assert.equal(trae.decryptTraeStorageValue(cipher), plain);
  const priv = trae.encryptTraeStorageValue(plain, { private: true });
  assert.equal(trae.decryptTraeStorageValue(priv), plain);
});

test('密文被篡改时校验失败，不返回脏数据', () => {
  const cipher = Buffer.from(trae.encryptTraeStorageValue('{"a":1}'), 'base64');
  cipher[cipher.length - 1] ^= 0xff;
  assert.throws(() => trae.decryptTraeStorageValue(cipher.toString('base64')), /校验失败|填充|解密|长度/);
});

test('未知头部直接报错', () => {
  assert.throws(() => trae.decryptTraeStorageValue(Buffer.alloc(80, 7).toString('base64')), /未知的加密类型/);
});

// ---------------------------------------------------------------- 设备号

test('真实设备号两种键写法都能识别', () => {
  assert.equal(trae.traeDeviceIdOfStorage({ 'iCubeAuthInfo://icube-dc:3014218253872104': 'x' }), '3014218253872104');
  assert.equal(trae.traeDeviceIdOfStorage({ 'iCubeAuthInfo://icube-dc': '1234567890123456' }), '1234567890123456');
  assert.equal(trae.traeDeviceIdOfStorage({ 'iCubeAuthInfo://icube-dc:abc': 'x' }), '', '非数字不算真实号');
});

test('storage.json 候选路径覆盖 Linux 的 ~/.config/Trae CN', () => {
  const list = trae.traeStorageCandidates('/home/u');
  assert.ok(list.some((p) => p.includes(join('.config', 'Trae CN', 'User', 'globalStorage', 'storage.json'))));
  assert.ok(list.some((p) => p.includes('AppData') || p.includes('.config')));
});

test('兜底设备号是 16 位十进制且稳定', () => {
  const a = trae.generatedTraeDeviceId('account-1');
  const b = trae.generatedTraeDeviceId('account-1');
  assert.equal(a, b);
  assert.match(a, /^\d{16}$/);
  assert.notEqual(a, trae.generatedTraeDeviceId('account-2'));
});

test('有真实设备号时优先用真实号，第二个账号才落到兜底号', async () => {
  const home = await mkdtemp(join(tmpdir(), 'agenthub-trae-home-'));
  const prevStoragePath = process.env.TRAE_STORAGE_PATH;
  try {
    const dir = join(home, '.config', 'Trae CN', 'User', 'globalStorage');
    await mkdir(dir, { recursive: true });
    const fixture = join(dir, 'storage.json');
    await writeFile(fixture, JSON.stringify({ 'iCubeAuthInfo://icube-dc:3014218253872104': 'x' }));
    // 开发机可能真装了 Trae，显式指定 fixture，避免读到本机客户端的号
    process.env.TRAE_STORAGE_PATH = fixture;
    trae.resetTraeDeviceCache();
    const used = new Set();
    assert.equal(await trae.resolveTraeDeviceId({ uid: 'a' }, { home, used }), '3014218253872104');
    const second = await trae.resolveTraeDeviceId({ uid: 'b' }, { home, used });
    assert.match(second, /^\d{16}$/);
    assert.notEqual(second, '3014218253872104');
  } finally {
    if (prevStoragePath === undefined) delete process.env.TRAE_STORAGE_PATH;
    else process.env.TRAE_STORAGE_PATH = prevStoragePath;
    trae.resetTraeDeviceCache();
    await rm(home, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------- 请求头 / JWT

test('只发一个小写 x-device-id，不发大写变体', () => {
  const headers = trae.traeHeaders('jwt', '3014218253872104');
  assert.equal(headers['x-device-id'], '3014218253872104');
  assert.equal(headers['X-Device-Id'], undefined);
  assert.equal(headers.Authorization, 'Cloud-IDE-JWT jwt');
  assert.equal(headers['X-User-Region'], 'CN');
});

test('中国版 TokenExpireAt 字符串（秒 / 毫秒）都能读到期', () => {
  assert.equal(trae.jwtExpiry(fakeJwt({ exp: 1_800_000_000 })), 1_800_000_000);
  assert.equal(trae.jwtExpiry(fakeJwt({ TokenExpireAt: '1800000000' })), 1_800_000_000);
  assert.equal(trae.jwtExpiry(fakeJwt({ tokenExpireAt: 1_800_000_000_000 })), 1_800_000_000);
  assert.equal(trae.jwtExpiry(fakeJwt({})), 0);
});

test('ECDSA 签名归一化到低半区', () => {
  const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const der = privateKey.export({ type: 'pkcs8', format: 'pem' });
  const signer = createSign('SHA256');
  signer.update('canonical');
  const signature = signer.sign(der);
  const low = trae.normalizeDerLowS(signature);
  assert.ok(Buffer.isBuffer(low));
  // 解析 DER，确认 s <= n/2
  const N = BigInt('0xffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551');
  let offset = 2;
  if (low[1] & 0x80) offset = 2 + (low[1] & 0x7f);
  const rLen = low[offset + 1];
  const sLen = low[offset + 2 + rLen + 1];
  const s = BigInt(`0x${low.subarray(offset + 2 + rLen + 2, offset + 2 + rLen + 2 + sLen).toString('hex')}`);
  assert.ok(s <= N / BigInt(2), '高位 s 必须归一化');
});

// ---------------------------------------------------------------- 签到链路

function mockFetch(routes) {
  const calls = [];
  globalThis.fetch = async (url, options = {}) => {
    const target = String(url);
    calls.push({ url: target, body: options.body ? String(options.body) : '' });
    for (const [pattern, handler] of routes) {
      if (target.includes(pattern)) {
        const payload = typeof handler === 'function' ? handler(target, options) : handler;
        return new Response(JSON.stringify(payload), { status: 200, headers: { 'content-type': 'application/json' } });
      }
    }
    return new Response('{}', { status: 404, headers: { 'content-type': 'application/json' } });
  };
  return calls;
}

test('今日已签：只查状态，不发 claim，并回带积分余额', async () => {
  const home = await mkdtemp(join(tmpdir(), 'agenthub-trae-cache-'));
  process.env.AGENTHUB_TRAE_TOKEN_CACHE = join(home, 'cache.json');
  const calls = mockFetch([
    ['checkin_credits/status', { code: 0, checked_in: true, credits: 100 }],
    ['user_current_entitlement_list', { data: { usage_summary: { total_amount: 5000, consumed_amount: 900 } } }],
  ]);
  try {
    const r = await trae.checkinTraeAccount({ token: 'jwt', uid: 'u1' }, { home });
    assert.equal(r.status, 'already');
    assert.equal(r.credits, 4100);
    assert.ok(!calls.some((c) => c.url.includes('/checkin_credits/claim')), '已签不该再发 claim');
    for (const url of ['checkin_credits/status', 'checkin_credits/claim']) {
      const hit = calls.filter((c) => c.url.includes(url));
      assert.ok(hit.every((c) => c.body.includes('req_source')), `${url} 必须带 req_source`);
    }
  } finally {
    delete process.env.AGENTHUB_TRAE_TOKEN_CACHE;
    await rm(home, { recursive: true, force: true });
  }
});

test('未签：claim 成功且回查翻转才算成功', async () => {
  const home = await mkdtemp(join(tmpdir(), 'agenthub-trae-ok-'));
  process.env.AGENTHUB_TRAE_TOKEN_CACHE = join(home, 'cache.json');
  let statusCalls = 0;
  const calls = mockFetch([
    ['checkin_credits/status', () => {
      statusCalls += 1;
      return { code: 0, checked_in: statusCalls > 1, enable: true };
    }],
    ['checkin_credits/claim', { code: 0, data: { points: 100 } }],
    ['user_current_entitlement_list', { data: { usage_summary: { total_amount: 300, consumed_amount: 0 } } }],
  ]);
  try {
    const r = await trae.checkinTraeAccount({ token: 'jwt', uid: 'u1' }, { home });
    assert.equal(r.status, 'success');
    assert.equal(r.credits, 300);
    assert.match(r.message, /回查确认|当前余额/);
    assert.ok(calls.some((c) => c.url.includes('/checkin_credits/claim')));
  } finally {
    delete process.env.AGENTHUB_TRAE_TOKEN_CACHE;
    await rm(home, { recursive: true, force: true });
  }
});

test('claim 返回 0 但回查没翻转：判为未成功，不虚报', async () => {
  const home = await mkdtemp(join(tmpdir(), 'agenthub-trae-fake-'));
  process.env.AGENTHUB_TRAE_TOKEN_CACHE = join(home, 'cache.json');
  mockFetch([
    ['checkin_credits/status', { code: 0, checked_in: false, enable: true }],
    ['checkin_credits/claim', { code: 0 }],
  ]);
  try {
    const r = await trae.checkinTraeAccount({ token: 'jwt', uid: 'u1' }, { home });
    assert.equal(r.status, 'rate_limited');
    assert.match(r.message, /回查未确认/);
  } finally {
    delete process.env.AGENTHUB_TRAE_TOKEN_CACHE;
    await rm(home, { recursive: true, force: true });
  }
});

test('9095 按今日已签处理，9074 按排队限流处理', async () => {
  const home = await mkdtemp(join(tmpdir(), 'agenthub-trae-codes-'));
  process.env.AGENTHUB_TRAE_TOKEN_CACHE = join(home, 'cache.json');
  try {
    mockFetch([
      ['checkin_credits/status', { code: 0, checked_in: false, enable: true }],
      ['checkin_credits/claim', { code: 9095 }],
      ['user_current_entitlement_list', { data: { usage_summary: { total_amount: 10, consumed_amount: 0 } } }],
    ]);
    assert.equal((await trae.checkinTraeAccount({ token: 'jwt', uid: 'a' }, { home })).status, 'already');

    mockFetch([
      ['checkin_credits/status', { code: 0, checked_in: false, enable: true }],
      ['checkin_credits/claim', { code: 9074 }],
    ]);
    const rate = await trae.checkinTraeAccount({ token: 'jwt', uid: 'a' }, { home });
    assert.equal(rate.status, 'rate_limited');
    assert.match(rate.message, /9074/);
  } finally {
    delete process.env.AGENTHUB_TRAE_TOKEN_CACHE;
    await rm(home, { recursive: true, force: true });
  }
});

test('enable=false 判为未开放，不再浪费 claim', async () => {
  const home = await mkdtemp(join(tmpdir(), 'agenthub-trae-off-'));
  process.env.AGENTHUB_TRAE_TOKEN_CACHE = join(home, 'cache.json');
  const calls = mockFetch([['checkin_credits/status', { code: 0, checked_in: false, enable: false }]]);
  try {
    const r = await trae.checkinTraeAccount({ token: 'jwt', uid: 'u1' }, { home });
    assert.equal(r.status, 'unsupported');
    assert.ok(!calls.some((c) => c.url.includes('/claim')));
  } finally {
    delete process.env.AGENTHUB_TRAE_TOKEN_CACHE;
    await rm(home, { recursive: true, force: true });
  }
});

test('1001 用 refreshToken + 设备证明续期，新 token 继续签到并写入缓存', async () => {
  const home = await mkdtemp(join(tmpdir(), 'agenthub-trae-refresh-'));
  process.env.AGENTHUB_TRAE_TOKEN_CACHE = join(home, 'cache.json');
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const privateKeyPem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
  const publicKeyPem = publicKey.export({ type: 'spki', format: 'pem' }).toString();
  const freshToken = fakeJwt({ exp: Math.floor(Date.now() / 1000) + 3600, data: { id: 'u1' } });

  let usedToken = '';
  const calls = mockFetch([
    ['oauth/ExchangeToken', { Result: { Token: freshToken, RefreshToken: 'rotated-rt' } }],
    ['checkin_credits/status', (url, options) => {
      usedToken = options.headers.Authorization;
      if (options.headers.Authorization === 'Cloud-IDE-JWT stale') return { code: 1001, message: 'not able to authenticate' };
      return { code: 0, checked_in: true };
    }],
    ['user_current_entitlement_list', { data: { usage_summary: { total_amount: 200, consumed_amount: 0 } } }],
  ]);
  try {
    const r = await trae.checkinTraeAccount({
      token: 'stale',
      refreshToken: 'rt-old',
      uid: 'u1',
      privateKeyPem,
      publicKeyPem,
      machineId: 'machine-1',
      deviceId: '3014218253872104',
    }, { home });
    assert.equal(r.status, 'already');
    assert.equal(usedToken, `Cloud-IDE-JWT ${freshToken}`);
    const exchange = calls.find((c) => c.url.includes('oauth/ExchangeToken'));
    assert.ok(exchange, '必须走新版 ExchangeToken');
    const body = JSON.parse(exchange.body);
    assert.equal(body.DeviceProof.Signature.length > 40, true, '要带设备签名');
    assert.equal(body.DeviceInfo.DevicePublicKey, publicKeyPem);
    assert.equal(body.ClientID, 'ono9krqynydwx5');
    const cache = JSON.parse(await readFile(join(home, 'cache.json'), 'utf-8'));
    assert.equal(cache.u1.refreshToken, 'rotated-rt', '轮换后的 refreshToken 必须落盘');
  } finally {
    delete process.env.AGENTHUB_TRAE_TOKEN_CACHE;
    await rm(home, { recursive: true, force: true });
  }
});
