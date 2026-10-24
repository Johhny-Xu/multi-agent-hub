// @ts-check
// Qoder CN 最小请求头复取的回归测试（移植 Qoder-Daily v1.0.10：
// 完整设备头下 200 但活动列表为空时，改用不带设备指纹的最小请求头再取一次）。
//   1. 最小头拿到活动 → 采纳并领取（领取仍走原设备头，与上游一致）
//   2. 最小头显示今日已领 → 采纳为 already，不误报「上游未下发」、不排重试
//   3. 最小头仍为空 → 保留首次空结果，继续走换环境重试，不误报成功
//   4. 国际版不触发最小头复取（上游硬约束：仅中国版启用）
// AGENTHUB_HOME 必须在 import checkin.mjs 之前设置（HOME 在模块加载时绑定）。
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const tempHome = await mkdtemp(join(tmpdir(), 'agenthub-qoder-minimal-'));
process.env.AGENTHUB_HOME = tempHome;
process.env.AGENTHUB_CHECKIN_STATE = join(tempHome, 'checkin-state.json');

const { checkinQoder } = await import('../console/checkin.mjs');
const { encryptLegacyQoderUser } = await import('../console/qoder.mjs');

const MACHINE_ID = '0123456789abcdef';
// exp=9999999999（2286 年）：保证测试期间 token 永不触发刷新分支
const JWT = ['eyJhbGciOiJIUzI1NiJ9', Buffer.from(JSON.stringify({ exp: 9999999999, sub: 'u1' })).toString('base64url'), 'sig'].join('.');
const CRED = JSON.stringify({ token: JWT, refreshToken: 'rt-minimal-1', uid: 'u1', nickname: 'MinimalTest' });

// 国际版（~/.qoder）与国内版（~/.qoder-cn）各放一份凭据，两区域用例共用同一个临时 HOME
for (const dir of ['.qoder', '.qoder-cn']) {
  await mkdir(join(tempHome, dir, '.auth'), { recursive: true });
  await writeFile(join(tempHome, dir, '.auth', 'machine_id'), MACHINE_ID);
  await writeFile(join(tempHome, dir, '.auth', 'user'), encryptLegacyQoderUser(CRED, MACHINE_ID));
}

const DAILY = { campaignId: 'daily-1', actionType: 'CLAIM_BENEFIT', claimStatus: 'CLAIMABLE', benefit: { amount: 100 } };
// 无窗口字段的 CLAIMED：qoderInWindow 无法证伪，按「今日已领」处理（见 console_qoder_daily.mjs 既有断言）
const CLAIMED_TODAY = { campaignId: 'daily-0', actionType: 'CLAIM_BENEFIT', claimStatus: 'CLAIMED', benefit: { amount: 100 } };

function resp(payload, status = 200) {
  return new Response(JSON.stringify(payload), { status, headers: { 'content-type': 'application/json' } });
}

test.after(async () => { await rm(tempHome, { recursive: true, force: true }); });

test('设备头拿到空列表时，最小请求头复取能看到活动并领取', async () => {
  const seen = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (url, options = {}) => {
    const headers = options.headers || {};
    seen.push({ url: String(url), method: options.method || 'GET', headers });
    const hasDevice = 'Cosy-MachineId' in headers;
    if (String(url).includes('/campaigns?forceRefresh=true')) {
      // 完整设备头 → 空列表；最小头 → 当天活动（Qoder-Daily v1.0.10 修的就是这个行为）
      return resp(hasDevice ? { success: true, campaigns: [] } : { success: true, campaigns: [DAILY] });
    }
    if (String(url).includes('/claim')) return resp({ success: true, data: { status: 'CLAIMED' } });
    return resp({ success: true, campaigns: [] });
  };
  let res;
  try {
    res = await checkinQoder('qoder-cn');
  } finally {
    globalThis.fetch = original;
  }
  assert.equal(res.platform, 'qoder-cn');
  assert.equal(res.status, 'success', res.message);
  assert.equal(res.credits, 100);
  assert.equal(seen.length, 3, JSON.stringify(seen.map((s) => s.url)));
  const lists = seen.filter((s) => s.url.includes('/campaigns?forceRefresh=true'));
  assert.equal(lists.length, 2, '设备头一次 + 最小头一次');
  assert.ok(lists[0].headers['Cosy-MachineId'], '首次列表带设备指纹');
  assert.equal(lists[1].headers['Cosy-MachineId'], undefined, '复取用最小请求头');
  const claim = seen.find((s) => s.url.includes('/claim'));
  assert.ok(claim, '应发起领取');
  assert.ok(claim.headers['Cosy-MachineId'], '领取仍走原设备头路径（与上游一致）');
});

test('最小头显示今日已领时采纳结果，不误报「上游未下发」也不排重试', async () => {
  const seen = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (url, options = {}) => {
    const headers = options.headers || {};
    seen.push({ url: String(url), headers });
    const hasDevice = 'Cosy-MachineId' in headers;
    if (String(url).includes('/campaigns?forceRefresh=true')) {
      return resp(hasDevice ? { success: true, campaigns: [] } : { success: true, campaigns: [CLAIMED_TODAY] });
    }
    return resp({ success: true, campaigns: [] });
  };
  let res;
  try {
    res = await checkinQoder('qoder-cn');
  } finally {
    globalThis.fetch = original;
  }
  assert.equal(res.status, 'already', res.message);
  assert.match(res.message, /已领取/);
  assert.ok(!res.retryAt, '已领态不能排重试');
  const lists = seen.filter((s) => s.url.includes('/campaigns?forceRefresh=true'));
  assert.equal(lists.length, 2, '设备头一次 + 最小头一次，已领态不再换环境');
  assert.equal(seen.some((s) => s.url.includes('/claim')), false, '没有可领活动就不能发起领取');
});

test('最小头仍为空时保留首次结果，继续换环境重试且不误报成功', async () => {
  const seen = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (url, options = {}) => {
    const headers = options.headers || {};
    seen.push({ url: String(url), headers });
    return resp({ success: true, campaigns: [] });
  };
  let res;
  try {
    res = await checkinQoder('qoder-cn');
  } finally {
    globalThis.fetch = original;
  }
  const lists = seen.filter((s) => s.url.includes('/campaigns?forceRefresh=true'));
  assert.equal(lists.length, 3, '设备头 CN → 最小头 CN → 换环境 sh，共 3 次');
  assert.ok(lists[0].url.includes('openapi.qoder.com.cn') && lists[0].headers['Cosy-MachineId'], '首次完整设备头打 CN');
  assert.ok(lists[1].url.includes('openapi.qoder.com.cn') && !lists[1].headers['Cosy-MachineId'], '复取最小头打 CN');
  assert.ok(lists[2].url.includes('openapi.qoder.sh'), '仍为空时换环境重试保留');
  assert.ok(lists[2].headers['Cosy-MachineId'], '换环境重试沿用完整设备头（保留首次行为）');
  assert.equal(res.credits, 0);
  // 0:00–10:00（UTC+8）上游没开窗时报 pending，其余时间 already：两种都是「无活动」的正确态
  assert.ok(['already', 'pending'].includes(res.status), `无活动时的状态应为 already/pending，实际 ${res.status}`);
  assert.equal(seen.some((s) => s.url.includes('/claim')), false, '没有可领活动就不能发起领取');
});

test('国际版不触发最小头复取（上游约束：仅中国版启用）', async () => {
  const seen = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (url, options = {}) => {
    const headers = options.headers || {};
    seen.push({ url: String(url), headers });
    return resp({ success: true, campaigns: [] });
  };
  let res;
  try {
    res = await checkinQoder('qoder');
  } finally {
    globalThis.fetch = original;
  }
  assert.equal(res.platform, 'qoder');
  const lists = seen.filter((s) => s.url.includes('/campaigns?forceRefresh=true'));
  assert.equal(lists.length, 2, '国际版只有 首发 + 换环境两次，没有最小头复取');
  assert.ok(lists.every((s) => s.headers['Cosy-MachineId']), '国际版全部沿用完整设备头');
  assert.ok(lists[0].url.includes('openapi.qoder.sh'), '国际版首发打 sh');
  assert.equal(res.credits, 0);
});
