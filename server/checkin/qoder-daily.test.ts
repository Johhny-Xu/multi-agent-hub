// @ts-check
// Qoder 签到实现（移植 L0NE-6/Qoder-Daily）的回归测试：
//   1. 只认 actionType=CLAIM_BENEFIT 的活动（VIEW_DETAILS 等常驻活动不参与领取）
//   2. 活动列表**不能**带 ?forceRefresh=true（带上会被服务端过滤掉每日活动行）
//   3. 请求要带 UMID 组件给出的设备风控头
//   4. 组件定位 / 官方包提取（tar + base64 ELF）可用
import { test, assert } from './testing/testkit.ts';
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { gzipSync } from 'node:zlib';
import { createHash } from 'node:crypto';

const {
  extractQoderCampaigns, qoderInWindow, qoderClaimedToday, qoderNextWindowStart, qoderPendingWindow,
  qoderTodayWindowStart,
} = await import('./checkin.mjs');
const {
  qoderHeaders, listQoderCampaigns, claimQoderCampaign, refreshQoderToken, persistQoderToken,
  encryptLegacyQoderUser, decryptLegacyQoderUser,
} = await import('./qoder.mjs');
const device = await import('./qoder-device.mjs');

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
  assert.equal(bare['cosy-version'], '1.1.83');
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

test('UMID 缓存按地区目录读取，与国际版隔离', async () => {
  const home = await mkdtemp(join(tmpdir(), 'agenthub-qoder-cache-'));
  const prev = { ...process.env };
  try {
    delete process.env.QODERCN_RUNTIME_INFO;
    delete process.env.QODER_UMID_PATH;
    const dir = join(home, '.agenthub', 'qoder-umid', 'qoder-cn');
    await mkdir(dir, { recursive: true });
    const cached = join(dir, process.platform === 'win32' ? 'runtime-info.exe' : 'runtime-info');
    await writeFile(cached, 'test');
    const found = await device.findQoderUmidComponent(home, 'qoder-cn');
    assert.equal(found.path, cached);
    assert.equal(found.source, 'cache');
    assert.equal(found.env, 0);
    assert.deepEqual(device.QODER_UMID_CLI_RUNTIME_ENV, { qoder: 4, 'qoder-cn': 0 });
  } finally {
    process.env = prev;
    await rm(home, { recursive: true, force: true });
  }
});

test('CN 官方包安装使用本机架构并写入地区缓存（npm 全部 mock）', async () => {
  const home = await mkdtemp(join(tmpdir(), 'agenthub-qoder-cn-install-'));
  const machine = process.arch === 'x64' ? 62 : process.arch === 'arm64' ? 183 : 0;
  if (!machine) return;
  const elf = Buffer.alloc(64);
  Buffer.from([0x7f, 0x45, 0x4c, 0x46, 0x02, 0x01, 0x01, 0x00]).copy(elf, 0);
  elf.writeUInt16LE(machine, 18);
  const content = Buffer.from(`var x = "${elf.toString('base64')}";`);
  const tar = Buffer.alloc(512 * 4);
  tar.write('package/bundle/qoder-worker-runtime.mjs', 0, 'utf-8');
  tar.write(content.length.toString(8).padStart(11, '0'), 124, 'ascii');
  tar.write('0', 156, 'ascii');
  content.copy(tar, 512);
  const body = gzipSync(tar);
  const integrity = `sha512-${createHash('sha512').update(body).digest('base64')}`;
  const seen = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (url) => {
    seen.push(String(url));
    if (String(url).endsWith('/pkg.tgz')) return new Response(body);
    return new Response(JSON.stringify({
      version: '1.2.3', dist: { tarball: 'https://packages.test/pkg.tgz', integrity },
    }), { status: 200 });
  };
  try {
    const installed = await device.installQoderUmidComponent(home, 'qoder-cn');
    assert.ok(installed.path.includes(join('qoder-umid', 'qoder-cn')));
    assert.deepEqual(await readFile(installed.path), elf);
    assert.ok(seen.some((url) => url.includes('@qodercn-ai%2fqoderclicn')));
  } finally {
    globalThis.fetch = original;
    await rm(home, { recursive: true, force: true });
  }
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
    const cli = await device.findCliUmid(home, 'qoder');
    assert.ok(cli, '应找到 .bin 下的 runtime-info');
    assert.equal(cli.source, 'qodercli');
    assert.equal(cli.env, 4, '国际版 CLI / 官方包组件运行环境码是 4（客户端组件才是 3）');
    // 客户端安装目录是机器全局的，装了 Qoder 的机器上 findQoderUmidComponent 会先命中 app 源；
    // 把环境变量指向夹具，执行链路才不随本机是否装了客户端而变。
    const prevUmidPath = process.env.QODER_UMID_PATH;
    process.env.QODER_UMID_PATH = script;
    try {
      const found = await device.findQoderUmidComponent(home, 'qoder');
      assert.ok(found, '应找到 UMID 组件');
      assert.equal(found.env, 3, '环境变量显式指定的组件按 app 口径（3）运行');
      if (process.platform === 'win32') {
        t.diagnostic('Windows 下 .cmd 无法直接 execFile，执行链路由 n5095 实测覆盖');
        return;
      }
      const risk = await device.runQoderUmidComponent(found.path, found.env, 'u1');
      assert.equal(risk.machineToken, 'tok-x');
      assert.equal(risk.machineType, 'type-x');
    } finally {
      if (prevUmidPath === undefined) delete process.env.QODER_UMID_PATH;
      else process.env.QODER_UMID_PATH = prevUmidPath;
    }
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test('国内版 CLI 的运行环境码是 0（与国际版严格隔离）', async () => {
  const home = await mkdtemp(join(tmpdir(), 'agenthub-qoder-cli-cn-'));
  const bin = join(home, '.qoder-cn', '.bin');
  await mkdir(bin, { recursive: true });
  const payload = JSON.stringify({ machineToken: 'tok-cn', machineCode: 'code-cn', machineType: 'type-cn' });
  const script = join(bin, 'runtime-info-x86_64-test');
  await writeFile(script, `#!/bin/sh\nprintf '%s\\n' '${payload}'\n`, { mode: 0o755 });
  await chmod(script, 0o755);
  try {
    const cli = await device.findCliUmid(home, 'qoder-cn');
    assert.ok(cli, '应找到 .qoder-cn/.bin 下的 runtime-info');
    assert.equal(cli.source, 'qodercli');
    assert.equal(cli.env, 0, '国内版运行环境码固定为 0');
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

// ------------------------------------------------- 「今天这一期」判定
// 上游活动窗口按 UTC+8 每天 10:00 刷新，一期 = [今天 10:00, 明天 09:59]，
// 会跨自然日。线上真实数据（2026-10-22）：startAt=1792634400 (10:00+08)，
// endAt=1792720740 (次日 09:59+08)。00:00–10:00 之间看到的仍是昨天那期。

test('窗口内 CLAIMED 且窗口从今天开始，才算今日已领', () => {
  const todayRow = { campaignId: 'a1', actionType: 'CLAIM_BENEFIT', claimStatus: 'CLAIMED', startAt: 1792634400, endAt: 1792720740 };
  assert.equal(qoderClaimedToday(todayRow, 1792634400 + 3600), true, '11:00 看今天这期');
  assert.equal(qoderClaimedToday(todayRow, 1792634400 - 3600), false, '09:00 窗口还没开');
});

test('昨天那期一直到今天 10:00，不能当成今日已签', () => {
  // 昨天 10:00 → 今天 09:59
  const yesterdayRow = { campaignId: 'a0', actionType: 'CLAIM_BENEFIT', claimStatus: 'CLAIMED', startAt: 1792548000, endAt: 1792634340 };
  const atMidnight = 1792598400; // 2026-10-22 00:00 +08
  assert.ok(atMidnight > yesterdayRow.startAt && atMidnight < yesterdayRow.endAt, '此刻确实还在昨天那期的窗口里');
  assert.equal(qoderClaimedToday(yesterdayRow, atMidnight), false, '窗口内不等于今天已签');
  assert.equal(qoderNextWindowStart(yesterdayRow), 1792634400, '下一期 10:00 开');
});

test('没有窗口字段时退回「窗口内即已领」，避免把正常数据判死', () => {
  const bare = { campaignId: 'a2', actionType: 'CLAIM_BENEFIT', claimStatus: 'CLAIMED' };
  assert.equal(qoderInWindow(bare), true);
  assert.equal(qoderClaimedToday(bare), true, '无 startAt 时无法证伪，按已领处理');
});

test('0:00–10:00 之间报「待打卡 + 10:00 开窗」，不再谎报已签到', () => {
  const yesterdayRow = { campaignId: 'a0', actionType: 'CLAIM_BENEFIT', claimStatus: 'CLAIMED', startAt: 1792548000, endAt: 1792634340 };
  const pend = qoderPendingWindow([yesterdayRow], 1792598400); // 10-22 00:00 +08
  assert.ok(pend, '应给出等待窗口');
  assert.equal(pend.retryAt, 1792634400, '到 10:00 再试');
  assert.match(pend.message, /今日 10:00/);
});

test('没有上一期可等时不产生 pending 窗口', () => {
  assert.equal(qoderPendingWindow([], 1792598400), null);
  // 已经是今天这期（窗口开在今天），不该算「等开窗」
  const todayRow = { campaignId: 'a1', actionType: 'CLAIM_BENEFIT', claimStatus: 'CLAIMED', startAt: 1792634400, endAt: 1792720740 };
  assert.equal(qoderPendingWindow([todayRow], 1792640000), null);
});

test('早上还没开窗时，重试点是今天 10:00（UTC+8）', () => {
  assert.equal(qoderTodayWindowStart(1792598400), 1792634400); // 10-22 00:00 +08 → 10:00 +08
  assert.equal(qoderTodayWindowStart(1792634400 + 60), 1792634400, '开窗后仍是今天这一期');
});
