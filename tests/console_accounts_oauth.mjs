// Node 24+：仅替换 auth.mjs 的 getSandbox；账号读写、身份识别、归档与切换均使用真实实现。
import test from 'node:test';
import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import { mkdtemp, mkdir, readFile, writeFile, readdir, rm } from 'node:fs/promises';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import { registerHooks, syncBuiltinESMExports } from 'node:module';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

async function writeSnapshot(dir, files) {
  await mkdir(dir, { recursive: true });
  for (const [name, data] of Object.entries(files)) {
    await writeFile(join(dir, name), JSON.stringify(data), 'utf-8');
  }
}

async function assertSnapshot(dir, files, message) {
  for (const [name, data] of Object.entries(files)) {
    const actual = await readFile(join(dir, name), 'utf-8');
    // 即使失败也不把凭据内容打印到测试日志。
    assert.ok(actual === JSON.stringify(data), `${message}: ${name}`);
  }
}

function minimaxSnapshot(version, expiresAtMs) {
  return {
    'auth-state.json': { status: 'authenticated', region: 'cn', expiresAtMs },
    'auth.json': { records: {
      'com.minimax.mcode.oauth.prod.cn fixture': {
        accessToken: `test-only-${version}-access`,
        refreshToken: `test-only-${version}-refresh`,
        expiresAtMs,
      },
    } },
  };
}

function codebuddySnapshot(uid, version) {
  return { 'auth.info': {
    account: { uid, email: `${uid}@example.test` },
    auth: { accessToken: `test-only-${version}-access`, refreshToken: `test-only-${version}-refresh` },
  } };
}

// 子测试串行运行；HOME 在导入产品模块之前隔离，结束后恢复并删除全部临时数据。
test('账号 OAuth 隔离回归', { concurrency: false }, async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'agenthub-accounts-oauth-'));
  const home = join(root, 'home');
  const sandbox = join(root, 'sandbox');
  const previousEnv = Object.fromEntries(['HOME', 'USERPROFILE', 'AGENTHUB_HOME'].map((key) => [key, process.env[key]]));
  const forbiddenCalls = [];
  let hook;
  try {
    process.env.HOME = process.env.USERPROFILE = process.env.AGENTHUB_HOME = home;
    await mkdir(home);
    assert.equal(homedir(), home, '必须先让 homedir() 指向临时 HOME');

    // 安全护栏不是业务替身：任何联网/真实 CLI 尝试都立即失败，吞错也会在最终断言暴露。
    for (const [target, methods] of [
      [globalThis, ['fetch']],
      [childProcess, ['exec', 'execSync', 'execFile', 'execFileSync', 'spawn', 'spawnSync', 'fork']],
      [http, ['request', 'get']],
      [https, ['request', 'get']],
      [net.Socket.prototype, ['connect']],
    ]) {
      for (const method of methods) {
        t.mock.method(target, method, () => {
          forbiddenCalls.push(method);
          throw new Error(`隔离测试禁止外部调用: ${method}`);
        });
      }
    }
    syncBuiltinESMExports();

    const authURL = new URL('../console/auth.mjs', import.meta.url).href;
    hook = registerHooks({
      load(url, context, nextLoad) {
        if (url !== authURL) return nextLoad(url, context);
        return {
          format: 'module', shortCircuit: true,
          source: `export function getSandbox(loginId) {
            if (loginId !== 'fixture-login') throw new Error('Unexpected sandbox login');
            return ${JSON.stringify(sandbox)};
          }`,
        };
      },
    });
    const { addFromSandbox, saveAccount, switchAccount, detectAccountInfo } = await import('../console/accounts.mjs');
    const workerDir = (worker) => join(home, '.agenthub', 'accounts', worker);
    const profileNames = async (worker) => (await readdir(workerDir(worker))).filter((name) => !name.startsWith('.')).sort();
    const readMeta = async (dir) => JSON.parse(await readFile(join(dir, 'meta.json'), 'utf-8'));

    t.beforeEach(async () => {
      await rm(home, { recursive: true, force: true });
      await rm(sandbox, { recursive: true, force: true });
      await mkdir(home);
    });

    await t.test('MiniMax 同区域重新授权复用档案，新 OAuth 生效且保留旧凭据备份', async () => {
      const worker = 'minimaxcode';
      const credentialDir = (base) => join(base, '.minimax', 'auth', 'prod', 'cn', 'mcode-public');
      // 失效 OAuth 的状态仍可能是 authenticated，必须复现这条归档覆盖路径。
      const expired = minimaxSnapshot('expired', Date.now() - 86400_000);
      const fresh = minimaxSnapshot('fresh', Date.now() + 86400_000);
      await writeSnapshot(credentialDir(home), expired);
      const saved = await saveAccount(worker, 'minimax-main');
      assert.equal(saved.ok, true);
      assert.equal(saved.identity, 'mcode:cn');
      await writeSnapshot(credentialDir(sandbox), fresh);
      assert.equal((await detectAccountInfo(worker, sandbox)).identity, saved.identity);

      const result = await addFromSandbox(worker, '', 'fixture-login');
      assert.equal(result.ok, true);
      assert.equal(result.switched, true);
      assert.equal(result.name, saved.name, '同身份应复用已有档案');
      assert.equal(result.identity, saved.identity);
      assert.deepEqual(await profileNames(worker), [saved.name], '不应裂出新档案');
      assert.equal(await readFile(join(workerDir(worker), '.active'), 'utf-8'), saved.name);

      const backups = (await readdir(workerDir(worker))).filter((name) => name.startsWith('.backup-'));
      assert.equal(backups.length, 1, '应保留切换前的备份');
      await assertSnapshot(join(workerDir(worker), backups[0]), expired, '备份应保留旧 OAuth');
      await assertSnapshot(credentialDir(sandbox), fresh, '沙箱原始凭据不应被修改');
      await assertSnapshot(credentialDir(home), fresh, 'live 应使用新 OAuth');
      await assertSnapshot(join(workerDir(worker), saved.name), fresh, '已有档案应使用新 OAuth');
      const meta = await readMeta(join(workerDir(worker), saved.name));
      assert.equal(meta.identity, saved.identity);
      assert.equal(meta.via, 'oauth-add');
    });

    for (const hasCurrentProfile of [false, true]) {
      await t.test(`普通 switchAccount 保护${hasCurrentProfile ? '已刷新' : '未归档'}的当前凭据，保留不同账号档案`, async () => {
        const worker = 'codebuddy';
        const liveDir = join(home, '.codebuddy');
        const target = codebuddySnapshot('other-user', 'target');
        const current = codebuddySnapshot('current-user', 'current-fresh');
        await writeSnapshot(liveDir, target);
        const targetSaved = await saveAccount(worker, 'other-profile');
        assert.equal(targetSaved.ok, true);
        const targetDir = join(workerDir(worker), targetSaved.name);
        const targetMeta = await readFile(join(targetDir, 'meta.json'), 'utf-8');
        let currentName = 'current-user';
        if (hasCurrentProfile) {
          await writeSnapshot(liveDir, codebuddySnapshot('current-user', 'current-stale'));
          const currentSaved = await saveAccount(worker, 'current-profile');
          assert.equal(currentSaved.ok, true);
          currentName = currentSaved.name;
        }
        // live 比已保存的档案更新，或压根还没有对应档案。
        await writeSnapshot(liveDir, current);

        const result = await switchAccount(worker, targetSaved.name);
        assert.equal(result.ok, true);
        assert.equal(result.switchedTo, targetSaved.name);
        assert.equal(dirname(result.backup), workerDir(worker));
        await assertSnapshot(result.backup, current, '切换备份应保护当前最新凭据');
        await assertSnapshot(liveDir, target, '目标档案应生效');
        await assertSnapshot(targetDir, target, '不同身份的目标档案不能被覆盖');
        assert.equal(await readFile(join(targetDir, 'meta.json'), 'utf-8'), targetMeta);
        const currentDir = join(workerDir(worker), currentName);
        await assertSnapshot(currentDir, current, '切换前应归档当前最新凭据');
        assert.equal((await readMeta(currentDir)).identity, 'current-user');
        assert.deepEqual(await profileNames(worker), [currentName, targetSaved.name].sort());
        assert.equal(await readFile(join(workerDir(worker), '.active'), 'utf-8'), targetSaved.name);

        const back = await switchAccount(worker, currentName);
        assert.equal(back.ok, true, '应能切回被保护的账号');
        await assertSnapshot(liveDir, current, '切回后应使用最新凭据');
        await assertSnapshot(targetDir, target, '切回也不能丢失另一档案');
      });
    }
  } finally {
    hook?.deregister();
    t.mock.restoreAll();
    syncBuiltinESMExports();
    for (const [key, value] of Object.entries(previousEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await rm(root, { recursive: true, force: true });
    assert.deepEqual(forbiddenCalls, [], '不得尝试执行 CLI 或联网');
  }
});
