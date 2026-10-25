// @ts-check
// meoo 账号接入的回归测试：
//   1. 登录指令登记齐全（此前 WebUI 弹「不支持的 worker: meoo」就是缺这条）
//   2. 凭据文件登记 + 身份探测（AK 命名，缺文件时回退指纹）
//   3. startLogin 走 meoo_ak 分支：不需要浏览器、等待粘贴回调
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const { detectAccountInfo, WORKER_CRED_FILES } = await import('../console/accounts.mjs');
const { LOGIN_COMMANDS, startLogin } = await import('../console/auth.mjs');

test('登录指令已登记 meoo：粘贴 AK 即可完成认证', async () => {
  const spec = LOGIN_COMMANDS.meoo;
  assert.ok(spec, 'LOGIN_COMMANDS.meoo 存在（此前弹「不支持的 worker: meoo」）');
  assert.equal(spec.mode, 'meoo_ak');
  assert.equal(spec.needsCallbackInput, true);

  // startLogin 走通 meoo_ak 分支：返回等待粘贴，不报「不支持的 worker」
  const r = await startLogin('meoo');
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.mode, 'meoo_ak');
  assert.equal(r.needsCallbackInput, true);
  assert.match(r.note || spec.note, /meoo/);
});

test('凭据文件登记与身份探测：MEOO_AK 命名，缺文件回退指纹', async () => {
  assert.deepEqual(WORKER_CRED_FILES.meoo, ['.config/agenthub-meoo/meoo-auth.env']);

  const home = await mkdtemp(join(tmpdir(), 'agenthub-meoo-acc-'));
  try {
    await mkdir(join(home, '.config', 'agenthub-meoo'), { recursive: true });
    await writeFile(join(home, '.config', 'agenthub-meoo', 'meoo-auth.env'), '# 注释行\nMEOO_AK=MEOOAK1234567890ABCDEF\n');
    const info = await detectAccountInfo('meoo', home);
    assert.equal(info.identity, 'MEOOAK1234567890ABCDEF');
    assert.equal(info.label, 'meo-MEOOAK12');
    assert.equal(info.display, 'Meoo AK:MEOO…CDEF');

    // 文件缺失时不能抛异常：回退 worker+指纹命名
    await rm(join(home, '.config', 'agenthub-meoo', 'meoo-auth.env'));
    const fallback = await detectAccountInfo('meoo', home);
    assert.match(fallback.label, /^meoo-/);
    assert.notEqual(fallback.identity, 'MEOOAK1234567890ABCDEF');
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});
