// @ts-check
// 跨进程 tick 锁：同一份 checkin-state.json 可能被多份部署（老 console、工作台）各自的
// 30 分钟定时器共用，tick 必须互斥，否则两个进程会在同一个 retryAt 把同一批平台并发签两遍。
// 全部走临时 HOME / 状态文件 / 锁目录，无凭据、不发网络请求、不碰真实签到状态。
import { test, assert } from './testing/testkit.ts';
import { vi } from 'vitest';
import { mkdtemp, mkdir, writeFile, readFile, stat, utimes } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** checkin.mjs 尚未在 checkin.d.mts 里声明的导出，按实现的真实行为就地补类型 */
type CheckinModule = typeof import('./checkin.mjs') & {
  acquireTickLock(): Promise<boolean>;
  releaseTickLock(): Promise<void>;
};

/** 全新模块实例：AGENTHUB_* 在 import 时生效，每测一套独立目录 */
async function loadModule() {
  const home = await mkdtemp(join(tmpdir(), 'checkin-ticklock-'));
  process.env.AGENTHUB_HOME = home;
  process.env.AGENTHUB_CHECKIN_STATE = join(home, '.agenthub', 'checkin-state.json');
  process.env.AGENTHUB_CHECKIN_TICK_LOCK = join(home, '.agenthub', 'checkin-tick.lock');
  // 引擎账号库（真实 ~/.openmausbot/service-accounts 里有真凭据）指到空目录，绝不能读到真账号
  process.env.OMB_SERVICE_ACCOUNTS_DIR = join(home, 'service-accounts');
  vi.resetModules();
  const mod = (await import('./checkin.mjs')) as CheckinModule;
  return { mod, home, stateFile: process.env.AGENTHUB_CHECKIN_STATE!, lockDir: process.env.AGENTHUB_CHECKIN_TICK_LOCK! };
}

/** 与 checkin.mjs 的 getTodayStr 同一格式（本地日期） */
function todayStr() {
  const now = new Date();
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');
  return `${now.getFullYear()}-${m}-${d}`;
}

/**
 * 造一个状态文件：traecode 今天还没签成（tick 会选它），
 * 其余 7 个平台都已签成（qoder 系的 lastTime 晚于 10:00 开窗，跨期核对也不会选它们）。
 */
async function seedPendingState(stateFile: string) {
  await mkdir(join(stateFile, '..'), { recursive: true });
  const today = todayStr();
  const signed = { status: 'success', lastDate: today, lastTime: '23:59', retryCount: 0, retryAt: 0 };
  const state = {
    autoCheckin: true,
    autoCheckinTime: '08:30',
    customTokens: {},
    platforms: {
      workbuddy: { ...signed },
      codebuddy: { ...signed },
      codearts: { ...signed },
      qoder: { ...signed },
      'qoder-cn': { ...signed },
      minimaxcode: { ...signed },
      meoo: { ...signed },
      traecode: { status: 'pending', lastDate: '2000-01-01', retryCount: 0 },
    },
    history: [],
  };
  await writeFile(stateFile, JSON.stringify(state));
}

async function stateSnapshot(stateFile: string) {
  const raw = JSON.parse(await readFile(stateFile, 'utf-8'));
  return { traecode: raw.platforms.traecode, history: raw.history.length };
}

/** 模拟另一个进程持锁：锁目录 + 新鲜 owner（心跳刚摸过） */
async function holdLockAsOtherProcess(lockDir: string) {
  await mkdir(lockDir, { recursive: true });
  await writeFile(join(lockDir, 'owner'), `${process.pid}\t${Date.now()}\n`);
}

/** 目录应当不存在（ENOENT 才算过，别的错误照抛） */
async function expectMissing(path: string) {
  try {
    await stat(path);
  } catch (err) {
    assert.equal((err as NodeJS.ErrnoException).code, 'ENOENT', '应当不存在');
    return;
  }
  assert.ok(false, '目录不该存在，但 stat 成功了');
}

test('tick 锁被别的进程持有时，本进程的自动 tick 直接跳过、不碰状态文件', async () => {
  const { mod, stateFile, lockDir } = await loadModule();
  await seedPendingState(stateFile);
  await holdLockAsOtherProcess(lockDir);

  const pending = await mod.runAutoCheckinTick();

  assert.deepEqual(pending, [], '锁被占用时 tick 不做任何事');
  const after = await stateSnapshot(stateFile);
  assert.equal(after.traecode.lastDate, '2000-01-01', '状态文件没被写');
  assert.equal(after.history, 0, '没有产生签到历史');
});

test('锁空闲时 tick 正常执行：只选待签平台、如实落盘并清掉锁', async () => {
  const { mod, stateFile, lockDir } = await loadModule();
  await seedPendingState(stateFile);

  const pending = await mod.runAutoCheckinTick();

  assert.deepEqual(pending, ['traecode'], '已签成的平台不再重复选入');
  const after = await stateSnapshot(stateFile);
  assert.notEqual(after.traecode.lastDate, '2000-01-01', '结果落盘（临时 HOME 下无账号，如实记录）');
  assert.equal(after.history, 1, '只产生一条签到历史');
  await expectMissing(lockDir);
});

test('acquire/release：第二个获取者拿不到锁，释放后目录消失', async () => {
  const { mod, lockDir } = await loadModule();

  assert.equal(await mod.acquireTickLock(), true, '空闲锁可以拿到');
  assert.equal(await mod.acquireTickLock(), false, '已持有的锁拿不到（新鲜 owner）');
  await mod.releaseTickLock();
  await expectMissing(lockDir);
});

test('陈旧锁（心跳停了 45 分钟以上）会被接管，接管后锁目录恢复干净', async () => {
  const { mod, lockDir } = await loadModule();
  await holdLockAsOtherProcess(lockDir);
  const stale = new Date(Date.now() - 60 * 60 * 1000);
  await utimes(join(lockDir, 'owner'), stale, stale);

  assert.equal(await mod.acquireTickLock(), true, '陈旧锁被接管');

  const owner = await stat(join(lockDir, 'owner'));
  assert.ok(Date.now() - owner.mtimeMs < 60_000, '接管后 owner 是新鲜的');
  await mod.releaseTickLock();
});

test('runAutoCheckinTick 全程持锁：并发第二个 tick 拿不到锁，不重复签到', async () => {
  const { mod, stateFile } = await loadModule();
  await seedPendingState(stateFile);
  // 模拟第一个 tick 正在跑：直接手工持锁（与 runAutoCheckinTick 内部同一把锁）
  await mod.acquireTickLock();

  const pending = await mod.runAutoCheckinTick();

  assert.deepEqual(pending, [], 'tick 进行中时第二个 tick 跳过');
  const after = await stateSnapshot(stateFile);
  assert.equal(after.history, 0, '第二个 tick 没有写历史');
  // 收尾：释放模拟中的第一把锁
  await mod.releaseTickLock();
});
