// @ts-check
// Qoder 签到实现（移植 L0NE-6/Qoder-Daily）的回归测试：
//   1. 只认 actionType=CLAIM_BENEFIT 的活动（VIEW_DETAILS 等常驻活动不参与领取）
//   2. 活动列表必须带 ?forceRefresh=true
//   3. 请求要带 UMID 组件给出的设备风控头
//   4. 组件定位 / 官方包提取（tar + base64 ELF）可用
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';

const { extractQoderCampaigns } = await import('../console/checkin.mjs');
const { qoderHeaders, listQoderCampaigns, claimQoderCampaign } = await import('../console/qoder.mjs');
const device = await import('../console/qoder-device.mjs');

const DEVICE = {
  worker: 'qoder',
  clientVersion: '0.4.8',
  machineOs: 'x86_64_linux',
  machineId: 'mid-0123456789abcdef',
  machineHostname: 'n5095-abcdef12',
  risk: { machineToken: 'tok-abc', machineCode: 'code-abc', machineType: 'type-abc' },
  source: 'qodercli',
  note: '',
};

// ---------------------------------------------------------------- 活动筛选

test('只把 CLAIM_BENEFIT 当成签到活动', () => {
  const payload = {
    campaigns: [
      { campaignId: 'a1', actionType: 'CLAIM_BENEFIT', claimStatus: 'CLAIMABLE', benefit: { amount: 100 } },
      { campaignId: 'v1', actionType: 'VIEW_DETAILS', claimStatus: 'CLAIMED' },
    ],
  };
  const rows = extractQoderCampaigns(payload);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].campaignId, 'a1');
});

test('VIEW_DETAILS 已领取不会伪装成今日已签', () => {
  const payload = { campaigns: [{ campaignId: 'v1', actionType: 'VIEW_DETAILS', claimStatus: 'CLAIMED' }] };
  assert.deepEqual(extractQoderCampaigns(payload), []);
});

test('支持 data.campaigns 包装与 snake_case 字段', () => {
  const payload = { data: { campaigns: [{ campaign_id: 'c9', action_type: 'CLAIM_BENEFIT', claim_status: 'CLAIMABLE' }] } };
  const rows = extractQoderCampaigns(payload);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].campaign_id, 'c9');
});

test('活动行下沉到更深层时按 actionType 递归捞回来', () => {
  const payload = { data: { groups: [{ items: [{ campaignId: 'deep-1', actionType: 'CLAIM_BENEFIT', claimStatus: 'CLAIMABLE' }] }] } };
  const rows = extractQoderCampaigns(payload);
  assert.equal(rows.length, 1, JSON.stringify(rows));
});

// ---------------------------------------------------------------- 请求头与 URL

test('设备头来自 UMID 组件，缺组件时不编造', () => {
  const full = qoderHeaders('qoder', 'dt-token', DEVICE);
  assert.equal(full['Cosy-MachineToken'], 'tok-abc');
  assert.equal(full['Cosy-MachineCode'], 'code-abc');
  assert.equal(full['Cosy-MachineType'], 'type-abc');
  assert.equal(full['Cosy-MachineOS'], 'x86_64_linux');
  assert.equal(full['Cosy-MachineId'], 'mid-0123456789abcdef');
  assert.equal(full['Cosy-Version'], '0.4.8');
  assert.equal(full['cosy-clienttype'], '10');

  const bare = qoderHeaders('qoder', 'dt-token');
  assert.equal(bare['Cosy-MachineToken'], undefined);
  assert.equal(bare['cosy-version'], '0.4.3');
});

test('拉活动列表带 forceRefresh，领取带设备头', async () => {
  const seen = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (url, options) => {
    seen.push({ url: String(url), headers: options?.headers || {} });
    return new Response(JSON.stringify({ campaigns: [] }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  try {
    await listQoderCampaigns('qoder-cn', 'dt-token', DEVICE);
    await claimQoderCampaign('qoder-cn', 'dt-token', 'camp 1', DEVICE);
  } finally {
    globalThis.fetch = original;
  }
  assert.match(seen[0].url, /openapi\.qoder\.com\.cn/);
  assert.match(seen[0].url, /\/sash\/api\/v1\/me\/campaigns\?forceRefresh=true/);
  assert.equal(seen[0].headers['Cosy-MachineToken'], 'tok-abc');
  assert.match(seen[1].url, /\/campaigns\/camp%201\/claim$/);
  assert.equal(seen[1].headers['Cosy-MachineToken'], 'tok-abc');
});

// ---------------------------------------------------------------- 设备身份

test('machineOs 按 <arch>_<system> 输出', () => {
  assert.match(device.qoderMachineOs(), /^(x86_64|aarch64|unknown)_(linux|win32|darwin)$/);
});

test('主机名带非 ASCII 时退化成「清洗名-哈希」，且稳定', () => {
  const a = device.qoderMachineHostname('研发机-01');
  const b = device.qoderMachineHostname('研发机-01');
  assert.equal(a, b);
  assert.match(a, /^[0-9A-Za-z-]+-[0-9a-f]{8}$/);
  assert.equal(device.qoderMachineHostname('n5095'), 'n5095');
  assert.ok(device.qoderMachineHostname('x'.repeat(200)).length <= 96);
});

test('machineId 落盘后跨次读取保持一致', async () => {
  const home = await mkdtemp(join(tmpdir(), 'agenthub-qoder-device-'));
  try {
    const first = await device.readQoderMachineId(home, 'qoder');
    const second = await device.readQoderMachineId(home, 'qoder');
    assert.equal(first, second);
    const other = await device.readQoderMachineId(home, 'qoder-cn');
    assert.notEqual(first, other, '两个区域各自一份设备号');
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test('解包 tar.gz 能取到 bundle 条目', () => {
  const content = Buffer.from('console.log("qodercli")', 'utf-8');
  const tar = Buffer.alloc(512 * 3);
  tar.write('package/bundle/qodercli.js', 0, 'utf-8');
  tar.write(content.length.toString(8).padStart(11, '0'), 124, 'ascii');
  tar.write('0', 156, 'ascii');
  content.copy(tar, 512);
  const found = device.readTarGzEntry(gzipSync(tar));
  assert.ok(found);
  assert.equal(found.toString('utf-8'), 'console.log("qodercli")');
});

test('从 bundle 里按 ELF e_machine 挑出本机架构组件', () => {
  const elf = Buffer.alloc(64);
  // 真实 ELF64 头：7f 45 4c 46 02 01 01 → base64 前缀 "f0VMRgIB"（组件按这个前缀找）
  Buffer.from([0x7f, 0x45, 0x4c, 0x46, 0x02, 0x01, 0x01, 0x00]).copy(elf, 0);
  elf.writeUInt16LE(62, 18); // x86_64
  const bundle = `var x = "${elf.toString('base64')}";`;
  const picked = device.extractUmidElf(bundle, 62);
  assert.ok(picked);
  assert.equal(picked.readUInt16LE(18), 62);
  assert.equal(device.extractUmidElf(bundle, 183), null, '架构不匹配时不能返回别的架构');
});

test('设备风控环境变量不完整时明确报错，不拿半套身份硬上', async () => {
  const home = await mkdtemp(join(tmpdir(), 'agenthub-qoder-env-'));
  const prev = { ...process.env };
  try {
    device.resetQoderDeviceCache();
    process.env.QODER_MACHINE_TOKEN = 'only-token';
    delete process.env.QODER_MACHINE_CODE;
    delete process.env.QODER_MACHINE_TYPE;
    const resolved = await device.resolveQoderDevice('qoder', { home, uid: 'u1' });
    assert.equal(resolved.risk, null);
    assert.match(resolved.note, /不完整/);
    const headers = qoderHeaders('qoder', 'dt-token', resolved);
    assert.equal(headers['Cosy-MachineToken'], undefined);
  } finally {
    process.env = prev;
    device.resetQoderDeviceCache();
    await rm(home, { recursive: true, force: true });
  }
});

test('本机 CLI 的 runtime-info 能被识别（执行部分仅 Unix）', async (t) => {
  const home = await mkdtemp(join(tmpdir(), 'agenthub-qoder-cli-'));
  const bin = join(home, '.qoder', '.bin');
  await mkdir(bin, { recursive: true });
  const payload = JSON.stringify({ machineToken: 'tok-x', machineCode: 'code-x', machineType: 'type-x' });
  let script;
  if (process.platform === 'win32') {
    script = join(bin, 'runtime-info-x.cmd');
    await writeFile(script, `@echo ${payload}\r\n`);
  } else {
    script = join(bin, 'runtime-info-x86_64-test');
    await writeFile(script, `#!/bin/sh\nprintf '%s\\n' '${payload}'\n`, { mode: 0o755 });
    await chmod(script, 0o755);
  }
  try {
    const found = await device.findQoderUmidComponent(home, 'qoder');
    assert.ok(found, '应找到 .bin 下的 runtime-info');
    assert.equal(found.source, 'qodercli');
    if (process.platform === 'win32') {
      t.diagnostic('Windows 下 .cmd 无法直接 execFile，执行链路由 n5095 实测覆盖');
      return;
    }
    const risk = await device.runQoderUmidComponent(found.path, found.env, 'u1');
    assert.equal(risk.machineToken, 'tok-x');
    assert.equal(risk.machineType, 'type-x');
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});
