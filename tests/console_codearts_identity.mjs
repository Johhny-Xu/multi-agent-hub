// @ts-check
// codearts 账号真实身份的回归测试：
//   1. STS caller-identity 解出用户名 → label/display 用真实用户名，identity 含 account_id（AK 轮换不裂档）
//   2. 命中缓存后不再发网络请求
//   3. STS 失败 / 无用户名 / 缺 SK → 回退 AK 命名，不抛异常
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const { detectAccountInfo } = await import('../console/accounts.mjs');

const AK = 'HPUATESTAK00000000000000000001';
const SK = 'sk-test-000000000000000000000000000';

async function tempHomeWithCred(ak = AK, sk = SK) {
  const home = await mkdtemp(join(tmpdir(), 'agenthub-ca-identity-'));
  await mkdir(join(home, '.config', 'agenthub-codearts'), { recursive: true });
  await writeFile(
    join(home, '.config', 'agenthub-codearts', 'codearts-auth.env'),
    `CODEARTS_CLI_AK=${ak}\nCODEARTS_CLI_SK=${sk}\n`
  );
  return home;
}

function stsOk(user = 'tester01', accountId = 'acct-0001') {
  return new Response(JSON.stringify({ account_id: accountId, principal_urn: `iam::${accountId}:user:${user}`, principal_id: 'p1' }), { status: 200, headers: { 'content-type': 'application/json' } });
}

test.after(async () => { /* 各用例自清 */ });

test('STS 解出真实用户名：label/display 用用户名，identity 绑定 account_id', async () => {
  const home = await tempHomeWithCred();
  const original = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async (url) => {
    if (String(url).includes('caller-identity')) { calls += 1; return stsOk('tester01', 'acct-0001'); }
    throw new Error('unexpected fetch');
  };
  try {
    const info = await detectAccountInfo('codearts', home);
    assert.equal(info.label, 'tester01');
    assert.equal(info.display, 'tester01');
    assert.equal(info.identity, 'codearts:acct-0001:tester01');
    assert.equal(calls, 1);
    // 第二次命中缓存：不再发请求，结果一致
    globalThis.fetch = async () => { throw new Error('cache miss: should not fetch'); };
    const again = await detectAccountInfo('codearts', home);
    assert.equal(again.identity, 'codearts:acct-0001:tester01');
  } finally {
    globalThis.fetch = original;
    await rm(home, { recursive: true, force: true });
  }
});

test('agency 类型 AK 同样取名（principal_urn 的 agency:<名>）', async () => {
  const home = await tempHomeWithCred();
  const original = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({ account_id: 'acct-2', principal_urn: 'iam::acct-2:agency:my-agent' }), { status: 200 });
  try {
    const info = await detectAccountInfo('codearts', home);
    assert.equal(info.display, 'my-agent');
    assert.equal(info.identity, 'codearts:acct-2:my-agent');
  } finally {
    globalThis.fetch = original;
    await rm(home, { recursive: true, force: true });
  }
});

test('STS 失败回退 AK 命名且不抛异常', async () => {
  const home = await tempHomeWithCred();
  const original = globalThis.fetch;
  globalThis.fetch = async () => new Response('{"error":"denied"}', { status: 403 });
  try {
    const info = await detectAccountInfo('codearts', home);
    assert.equal(info.label, 'ak-HPUATEST');
    assert.equal(info.identity, AK);
    assert.match(info.display, /^AK:HPUA…0001$/);
  } finally {
    globalThis.fetch = original;
    await rm(home, { recursive: true, force: true });
  }
});

test('STS 200 但 principal_urn 无 user/agency 段时回退 AK 命名', async () => {
  const home = await tempHomeWithCred();
  const original = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({ account_id: 'acct-3', principal_urn: 'iam::acct-3' }), { status: 200 });
  try {
    const info = await detectAccountInfo('codearts', home);
    assert.equal(info.identity, AK);
    assert.equal(info.label, 'ak-HPUATEST');
  } finally {
    globalThis.fetch = original;
    await rm(home, { recursive: true, force: true });
  }
});

test('缺 SK（只有 AK）时直接回退 AK 命名，不访问网络', async () => {
  const home = await tempHomeWithCred(AK, '');
  const original = globalThis.fetch;
  globalThis.fetch = async () => { throw new Error('should not fetch'); };
  try {
    const info = await detectAccountInfo('codearts', home);
    assert.equal(info.identity, AK);
  } finally {
    globalThis.fetch = original;
    await rm(home, { recursive: true, force: true });
  }
});
