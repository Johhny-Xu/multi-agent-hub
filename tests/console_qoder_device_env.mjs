// @ts-check
// Qoder 设备指纹「按地区隔离」的回归测试。
//
// 事故背景（2026-11-03 实测）：
//   服务端 device.env 里塞的是**中国版**的三件套（从 Windows 上 Qoder CN 的
//   umid-cache 提的），而 QODER_MACHINE_* 是全局变量，于是国际版账号也拿到了
//   中国版指纹。上游按设备下发活动，看到「另一台设备的中国版客户端」就下发空列表，
//   控制台表现为「活动 0 个 / 未派发」，但同一台机器上 Qoder 桌面端能正常签到。
//
//   本机两份 umid-cache 的真实值对比（同前缀、不同正文）：
//     国际版 environment=4  P1gAGri9W-…  / 2cca32f49157e10942 / 3944a47200066faae3
//     中国版 environment=0  P1gAxveT2…   / 64e527ea91460d13b4 / 6c6603d9006166ec9f
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const tempHome = await mkdtemp(join(tmpdir(), 'agenthub-qoder-device-'));
process.env.AGENTHUB_HOME = tempHome;
// 组件/安装路径全部短路：本测试只验证「环境变量三件套的选择逻辑」
process.env.QODER_UMID_NO_INSTALL = '1';

const { resolveQoderDevice, resetQoderDeviceCache } = await import('../checkin/qoder-device.mjs');

const KEYS = [
  'QODER_MACHINE_TOKEN', 'QODER_MACHINE_CODE', 'QODER_MACHINE_TYPE',
  'QODER_INTL_MACHINE_TOKEN', 'QODER_INTL_MACHINE_CODE', 'QODER_INTL_MACHINE_TYPE',
  'QODER_CN_MACHINE_TOKEN', 'QODER_CN_MACHINE_CODE', 'QODER_CN_MACHINE_TYPE',
];

const INTL = { token: 'intl-token-aaaaaaaa', code: 'intl-code', type: 'intl-type' };
const CN = { token: 'cn-token-bbbbbbbb', code: 'cn-code', type: 'cn-type' };
const LEGACY = { token: 'legacy-token', code: 'legacy-code', type: 'legacy-type' };

function clearEnv() {
  for (const k of KEYS) delete process.env[k];
  resetQoderDeviceCache();
}

function setTriple(prefix, t) {
  process.env[`${prefix}_TOKEN`] = t.token;
  process.env[`${prefix}_CODE`] = t.code;
  process.env[`${prefix}_TYPE`] = t.type;
}

async function deviceOf(worker) {
  resetQoderDeviceCache();
  return resolveQoderDevice(worker, { home: tempHome, uid: '' });
}

test('地区级三件套各自生效：国际版用 INTL、中国版用 CN', async () => {
  clearEnv();
  setTriple('QODER_INTL_MACHINE', INTL);
  setTriple('QODER_CN_MACHINE', CN);

  const intl = await deviceOf('qoder');
  assert.equal(intl.risk.machineToken, INTL.token);
  assert.equal(intl.risk.machineCode, INTL.code);
  assert.equal(intl.risk.machineType, INTL.type);
  assert.equal(intl.source, 'env:qoder');

  const cn = await deviceOf('qoder-cn');
  assert.equal(cn.risk.machineToken, CN.token);
  assert.equal(cn.source, 'env:qoder-cn');
});

test('回归：地区级优先于通用 QODER_MACHINE_*，国际版不再被中国版指纹污染', async () => {
  clearEnv();
  // 模拟事故现场：device.env 里只有中国版指纹（通用变量）
  setTriple('QODER_MACHINE', CN);
  // 修好之后补上的国际版指纹
  setTriple('QODER_INTL_MACHINE', INTL);

  const intl = await deviceOf('qoder');
  assert.equal(intl.risk.machineToken, INTL.token, '国际版必须用自己的指纹，不能被通用变量盖掉');
  assert.notEqual(intl.risk.machineToken, CN.token);
  assert.equal(intl.source, 'env:qoder');
  assert.equal(intl.note, '', '用地区级指纹时不该有告警');
});

test('只有通用指纹时中国版行为保持不变（本次改动不能动 CN）', async () => {
  clearEnv();
  setTriple('QODER_MACHINE', CN);

  const cn = await deviceOf('qoder-cn');
  assert.equal(cn.risk.machineToken, CN.token, 'CN 账号仍拿通用指纹，行为与改动前一致');
  assert.equal(cn.source, 'env:legacy', '未配地区级变量时标记为通用兜底来源');
});

test('只有通用指纹时国际版仍能跑，但会标记降级来源（不能判成身份缺失）', async () => {
  clearEnv();
  setTriple('QODER_MACHINE', CN);

  const intl = await deviceOf('qoder');
  assert.equal(intl.risk.machineToken, CN.token, '兜底不阻断，避免老部署直接失效');
  assert.equal(intl.source, 'env:legacy', '用 source 标记降级，便于诊断');
  assert.equal(intl.note, '', 'note 会被 checkinQoderOne 当成「身份缺失」直接停掉补拉，降级告警不能写这里');
});

test('地区级只填了一半：明确报错，不静默回落到通用指纹', async () => {
  clearEnv();
  setTriple('QODER_MACHINE', CN);
  process.env.QODER_INTL_MACHINE_TOKEN = 'intl-token-only';

  const intl = await deviceOf('qoder');
  assert.equal(intl.risk, null);
  assert.match(intl.note, /QODER_INTL_MACHINE/);
  assert.match(intl.note, /三件套不完整/);
});

test('通用变量只填了一半：保持原来的报错文案', async () => {
  clearEnv();
  process.env.QODER_MACHINE_TOKEN = 'only-token';

  const intl = await deviceOf('qoder');
  assert.equal(intl.risk, null);
  assert.match(intl.note, /三件套/);
});
