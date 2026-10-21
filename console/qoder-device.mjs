// @ts-check
// Qoder 设备风控身份（UMID 组件）
//
// 实现方式移植自 L0NE-6/Qoder-Daily（https://github.com/L0NE-6/Qoder-Daily，
// 见 README 致谢）。上游把「每日 100 Credits」这类定向活动只下发给带设备风控头的
// 请求，三个头必须由本机 Qoder 客户端 / qodercli 自带的 runtime-info 组件生成：
//   Cosy-MachineToken / Cosy-MachineCode / Cosy-MachineType
// 自己编、或用桌面端 auth.v1.dat 派生，服务端都会把定向活动过滤掉（活动行直接不下发）。
//
// 组件查找顺序（与本机真实安装形态对齐）：
//   1. 环境变量 QODER_UMID_PATH
//   2. Qoder / Qoder CN 客户端的 resources/umid/runtime-info（含解包目录）
//   3. ~/.qoder*/.bin 下的 runtime-info（umid-<ver>/ 子目录或直接扁平文件两种布局）
//   4. ~/.agenthub/qoder-umid/runtime-info（上次从官方包提取的缓存）
//   5. 国际版缺组件时，从官方 qodercli npm 包提取并做 sha512 校验（QODER_UMID_NO_INSTALL=1 关闭）

import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmod, mkdir, readFile, readdir, rename, writeFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { homedir, hostname } from 'node:os';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { qoderRegion } from './qoder.mjs';

/** 与上游 Qoder 客户端版本对齐的默认值；真实版本优先取客户端 build-manifest.json */
export const QODER_DEFAULT_CLIENT_VERSION = '0.2.5';
/** 风控身份有效期（上游实测 50 分钟足够稳，超过后 token 可能被判定过期） */
const RISK_TTL_MS = 50 * 60 * 1000;
/** 组件调用超时：runtime-info 首次运行要做设备指纹采集，给足 25 秒 */
const COMPONENT_TIMEOUT_MS = 25_000;

const NPM_REGISTRIES = ['https://registry.npmmirror.com', 'https://registry.npmjs.org'];
const NPM_AUTHORITY = 'https://registry.npmjs.org';
const NPM_PACKAGE_PATH = '@qoder-ai%2fqodercli';
const BUNDLE_ENTRY = 'package/bundle/qodercli.js';

const DEVICE_CACHE = new Map();
const RISK_CACHE = new Map();

const firstText = (...values) => {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) return value.trim();
    if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  }
  return '';
};

/** 设备平台串，上游按 <arch>_<system> 拼（x86_64_linux / aarch64_darwin / x86_64_win32） */
export function qoderMachineOs() {
  const raw = process.arch.toLowerCase();
  const arch = ['x64', 'amd64', 'x86_64'].includes(raw) ? 'x86_64'
    : ['arm64', 'aarch64'].includes(raw) ? 'aarch64'
      : 'unknown';
  const system = process.platform === 'win32' ? 'win32'
    : process.platform === 'darwin' ? 'darwin'
      : 'linux';
  return `${arch}_${system}`;
}

/**
 * 主机名头：可打印就直接用，含非 ASCII（中文主机名）时退化成「清洗后的名字-哈希前 8 位」，
 * 保证跨请求稳定、又不会把乱码发给上游。
 */
export function qoderMachineHostname(raw = hostname()) {
  const value = String(raw || '').trim();
  if (!value) return '';
  const digest = createHash('sha256').update(value, 'utf-8').digest('hex').slice(0, 8);
  // eslint-disable-next-line no-control-regex
  const printable = [...value].every((ch) => {
    const code = ch.codePointAt(0) || 0;
    return (code >= 0x21 && code <= 0x7e) || ch === ' ';
  });
  if (printable) return value.length > 96 ? `${value.slice(0, 87).replace(/[- ]+$/, '')}-${digest}` : value;
  const cleaned = [...value].map((ch) => {
    const code = ch.codePointAt(0) || 0;
    return (code >= 0x21 && code <= 0x7e) ? ch : '-';
  }).join('').split('-').filter(Boolean).join('-');
  const text = cleaned ? `${cleaned}-${digest}` : `unknown-${digest}`;
  return text.length > 96 ? `${text.slice(0, 87).replace(/[- ]+$/, '')}-${digest}` : text;
}

function deviceFile(home) {
  return join(home, '.agenthub', 'qoder-device.json');
}

/**
 * 稳定的设备号：签到风控要求同一台机器多次运行保持一致，
 * 因此落盘到 ~/.agenthub/qoder-device.json（按区域各一份），不每次随机。
 */
export async function readQoderMachineId(home, worker = 'qoder') {
  const file = deviceFile(home);
  let data = {};
  try {
    data = JSON.parse(await readFile(file, 'utf-8'));
  } catch {
    data = {};
  }
  const current = firstText(data?.[worker]);
  if (current) return current;
  const value = createHash('sha256')
    .update(`${worker}:${hostname()}:${home}:${Date.now()}:${Math.random()}`)
    .digest('hex');
  data = { ...(data && typeof data === 'object' ? data : {}), [worker]: value };
  try {
    await mkdir(join(home, '.agenthub'), { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    await writeFile(tmp, `${JSON.stringify(data, null, 2)}\n`, { mode: 0o600 });
    await rename(tmp, file);
  } catch { /* 落盘失败不阻塞签到，下次会重新生成 */ }
  return value;
}

/** 客户端 resources 目录候选：先本区域客户端，再另一区域，最后本机解包目录 */
export function qoderResourceDirs(home, worker = 'qoder') {
  const names = worker === 'qoder' ? ['Qoder', 'Qoder CN'] : ['Qoder CN', 'Qoder'];
  const dirs = [];
  for (const name of names) {
    if (process.platform === 'win32') {
      const roots = [];
      if (process.env.LOCALAPPDATA) roots.push(join(process.env.LOCALAPPDATA, 'Programs', name));
      for (const variable of ['ProgramFiles', 'ProgramFiles(x86)']) {
        const base = process.env[variable];
        if (base) roots.push(join(base, name));
      }
      for (const install of roots) dirs.push(join(install, 'resources'));
    } else if (process.platform === 'darwin') {
      dirs.push(`/Applications/${name}.app/Contents/Resources`);
      dirs.push(join(home, 'Applications', `${name}.app`, 'Contents', 'Resources'));
    } else {
      const slug = name.toLowerCase().replace(/ /g, '-');
      dirs.push(`/opt/${name}/resources`);
      dirs.push(`/opt/${slug}/resources`);
      dirs.push(`/usr/lib/${slug}/resources`);
      dirs.push(`/snap/${slug}/current/resources`);
    }
  }
  if (process.platform !== 'win32' && process.platform !== 'darwin') {
    // 本机部署形态：deb 解包到 ~/qoder-app、~/qoder-cn-app 后直接运行
    for (const [app, name] of [['qoder-app', 'Qoder'], ['qoder-cn-app', 'Qoder CN']]) {
      dirs.push(join(home, app, 'opt', name, 'resources'));
      dirs.push(join(home, app, 'resources'));
    }
  }
  return dirs;
}

/** 客户端真实版本：优先 build-manifest.json，取不到再退回默认值 */
export async function detectQoderClientVersion(home, worker = 'qoder') {
  for (const resources of qoderResourceDirs(home, worker)) {
    try {
      const manifest = JSON.parse(await readFile(join(resources, 'build-manifest.json'), 'utf-8'));
      const version = firstText(manifest?.productVersion);
      if (version) return version;
    } catch { /* 继续找下一个 */ }
  }
  return QODER_DEFAULT_CLIENT_VERSION;
}

const umidExeName = () => (process.platform === 'win32' ? 'runtime-info.exe' : 'runtime-info');

/** ~/.qoder 与 ~/.qoder-cn 的 .bin 目录：兼容 umid-<ver>/runtime-info 与 runtime-info-<plat> 两种布局 */
async function findCliUmid(home, worker) {
  const bin = join(home, qoderRegion(worker).configDir, '.bin');
  let entries = [];
  try {
    entries = await readdir(bin);
  } catch {
    return null;
  }
  for (const entry of entries.sort().reverse()) {
    if (entry.startsWith('umid-')) {
      const path = join(bin, entry, umidExeName());
      if (await isFile(path)) return { path, env: worker === 'qoder' ? 4 : 0, source: 'qodercli' };
    }
  }
  for (const entry of entries.sort().reverse()) {
    if (entry.startsWith('runtime-info-')) {
      const path = join(bin, entry);
      if (await isFile(path)) return { path, env: worker === 'qoder' ? 4 : 0, source: 'qodercli' };
    }
  }
  return null;
}

async function isFile(path) {
  try {
    const { stat } = await import('node:fs/promises');
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
}

/**
 * 定位 UMID 组件。返回 { path, env, source }：
 * env 是组件的运行环境码（客户端=3/0，CLI 与缓存=4/0，国际版/国内版不同）。
 */
export async function findQoderUmidComponent(home = homedir(), worker = 'qoder') {
  const custom = String(process.env.QODER_UMID_PATH || '').trim();
  if (custom && await isFile(custom)) return { path: custom, env: worker === 'qoder' ? 4 : 0, source: 'env' };

  const appEnv = worker === 'qoder' ? 3 : 0;
  for (const resources of qoderResourceDirs(home, worker)) {
    const path = join(resources, 'umid', umidExeName());
    if (await isFile(path)) return { path, env: appEnv, source: 'app' };
  }

  const cli = await findCliUmid(home, worker);
  if (cli) return cli;

  const cached = join(home, '.agenthub', 'qoder-umid', umidExeName());
  if (await isFile(cached)) return { path: cached, env: 4, source: 'cache' };
  return null;
}

/** 运行组件，返回 { machineToken, machineCode, machineType } */
export function runQoderUmidComponent(componentPath, env, uid = '') {
  return new Promise((resolve, reject) => {
    const args = [String(env)];
    let input;
    if (process.platform === 'win32' || process.platform === 'darwin') {
      // 桌面端组件靠 stdin 传账号，用来生成与账号绑定的设备指纹
      args.push('--account-stdin');
      input = `${JSON.stringify({ account: uid || '' })}\n`;
    }
    const child = execFile(componentPath, args, {
      timeout: COMPONENT_TIMEOUT_MS,
      maxBuffer: 2 * 1024 * 1024,
      windowsHide: true,
    }, (error, stdout) => {
      if (error && !stdout) {
        reject(new Error(String(error.message || error)));
        return;
      }
      const line = String(stdout || '').split(/\r?\n/)[0].trim();
      if (!line) {
        reject(new Error('组件没有输出'));
        return;
      }
      let data;
      try {
        data = JSON.parse(line);
      } catch {
        reject(new Error('组件输出不是 JSON'));
        return;
      }
      const values = {};
      for (const key of ['machineToken', 'machineCode', 'machineType']) {
        const value = data?.[key];
        if (typeof value !== 'string' || !value.trim() || value.length > 4096) {
          reject(new Error(`组件输出缺少 ${key}`));
          return;
        }
        values[key] = value.trim();
      }
      resolve(values);
    });
    if (input !== undefined) {
      child.stdin?.end(input);
    }
  });
}

// ---------------------------------------------------------------- 官方包提取（缺组件时的兜底）

async function fetchBytes(url, timeoutMs = 180_000) {
  const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}

async function npmMeta(registry) {
  const body = await fetchBytes(`${registry}/${NPM_PACKAGE_PATH}/latest`, 30_000);
  const payload = JSON.parse(body.toString('utf-8'));
  const dist = payload?.dist && typeof payload.dist === 'object' ? payload.dist : {};
  const tarball = firstText(dist.tarball);
  const integrity = firstText(dist.integrity);
  if (!tarball || !integrity) throw new Error('元数据缺少 tarball / integrity');
  return { version: firstText(payload?.version), tarball, integrity };
}

/** 极简 tar 读取：只需要从 qodercli 包里挑出 package/bundle/qodercli.js */
export function readTarGzEntry(buffer, wanted = BUNDLE_ENTRY) {
  const tar = gunzipSync(buffer);
  let offset = 0;
  while (offset + 512 <= tar.length) {
    const header = tar.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) break;
    const name = header.subarray(0, 100).toString('utf-8').replace(/\0.*$/, '').trim();
    const sizeRaw = header.subarray(124, 136).toString('ascii').replace(/\0.*$/, '').trim();
    const size = parseInt(sizeRaw, 8) || 0;
    const dataStart = offset + 512;
    if (name === wanted || name === `./${wanted}`) return tar.subarray(dataStart, dataStart + size);
    offset = dataStart + Math.ceil(size / 512) * 512;
  }
  return null;
}

/**
 * 从 qodercli 的 JS bundle 里抠出本机架构的 runtime-info ELF：
 * bundle 里以 base64 字符串内嵌，ELF 头 e_machine 决定架构（x86_64=62，aarch64=183）。
 */
export function extractUmidElf(bundleText, machine) {
  const mark = '"f0VMRgIB';
  let position = 0;
  while (position < bundleText.length) {
    const hit = bundleText.indexOf(mark, position);
    if (hit < 0) return null;
    const end = bundleText.indexOf('"', hit + 1);
    if (end < 0) return null;
    const encoded = bundleText.slice(hit + 1, end);
    try {
      const head = Buffer.from(encoded.slice(0, 4096), 'base64');
      if (head.length >= 20 && head.readUInt16LE(18) === machine) {
        return Buffer.from(encoded, 'base64');
      }
    } catch { /* 不是合法 base64，继续找下一处 */ }
    position = end + 1;
  }
  return null;
}

/** 下载官方 qodercli 包并提取 UMID 组件，写到 ~/.agenthub/qoder-umid/runtime-info */
export async function installQoderUmidComponent(home = homedir()) {
  const arch = qoderMachineOs().split('_')[0];
  const machine = arch === 'x86_64' ? 62 : arch === 'aarch64' ? 183 : 0;
  if (!machine) throw new Error('当前 CPU 架构不受支持');
  let authority = null;
  try {
    authority = await npmMeta(NPM_AUTHORITY);
  } catch { /* 官方源不可达时只做单源校验 */ }
  const errors = [];
  for (const registry of NPM_REGISTRIES) {
    try {
      const meta = await npmMeta(registry);
      if (registry !== NPM_AUTHORITY && authority) {
        if (authority.version && meta.version && authority.version !== meta.version) {
          errors.push(`${registry}：版本与官方源不一致`);
          continue;
        }
        if (authority.integrity !== meta.integrity) {
          errors.push(`${registry}：integrity 与官方源不一致`);
          continue;
        }
      }
      const body = await fetchBytes(meta.tarball);
      if (meta.integrity.startsWith('sha512-')) {
        const actual = createHash('sha512').update(body).digest('base64');
        if (actual !== meta.integrity.slice(7)) {
          errors.push(`${registry}：下载内容与 integrity 不一致`);
          continue;
        }
      }
      const entry = readTarGzEntry(body);
      if (!entry) {
        errors.push(`${registry}：包里没有 ${BUNDLE_ENTRY}`);
        continue;
      }
      const elf = extractUmidElf(entry.toString('utf-8'), machine);
      if (!elf) {
        errors.push(`${registry}：包里没有本机架构的 UMID 组件`);
        continue;
      }
      const dir = join(home, '.agenthub', 'qoder-umid');
      await mkdir(dir, { recursive: true });
      const path = join(dir, umidExeName());
      await writeFile(path, elf, { mode: 0o755 });
      try { await chmod(path, 0o755); } catch { /* Windows 无执行位 */ }
      return { path, version: meta.version || '', source: 'npm' };
    } catch (error) {
      errors.push(`${registry}：${error instanceof Error ? error.message : String(error)}`);
    }
  }
  throw new Error(errors.join('；') || '没有可用来源');
}

// ---------------------------------------------------------------- 对外入口

// 真实设备指纹（Cosy-MachineToken/Code/Type）落在 ~/.config/agenthub-qoder/device.env。
// 上游按设备下发活动：指纹不对，活动列表就是空的（Qoder 国际版长期签不上的根因）。
// 环境变量优先，文件兜底；三件套必须齐全才生效。
function loadQoderDeviceEnv() {
  if (process.env.QODER_MACHINE_TOKEN && process.env.QODER_MACHINE_CODE && process.env.QODER_MACHINE_TYPE) return;
  try {
    const file = join(homedir(), '.config', 'agenthub-qoder', 'device.env');
    const raw = readFileSync(file, 'utf-8');
    for (const line of raw.split('\n')) {
      const m = line.match(/^\s*(QODER_MACHINE_(?:TOKEN|CODE|TYPE))\s*=\s*(\S+)/);
      if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
    }
  } catch { /* 没这个文件就走原来的探测逻辑 */ }
}

async function resolveRisk(worker, home, uid) {
  loadQoderDeviceEnv();
  const envToken = firstText(process.env.QODER_MACHINE_TOKEN);
  const envCode = firstText(process.env.QODER_MACHINE_CODE);
  const envType = firstText(process.env.QODER_MACHINE_TYPE);
  if (envToken || envCode || envType) {
    if (envToken && envCode && envType) {
      return { risk: { machineToken: envToken, machineCode: envCode, machineType: envType }, source: 'env', note: '' };
    }
    return { risk: null, source: '', note: '设备风控环境变量不完整（需要 QODER_MACHINE_TOKEN / QODER_MACHINE_CODE / QODER_MACHINE_TYPE 三件套）' };
  }

  const custom = String(process.env.QODER_UMID_PATH || '').trim();
  if (custom && !(await isFile(custom))) {
    // 显式指定了组件却不存在：直接报错，不去扫描（测试与自定义部署都靠这个短路）
    return { risk: null, source: '', note: `QODER_UMID_PATH 指向的组件不存在：${custom}` };
  }

  let component = await findQoderUmidComponent(home, worker);
  if (!component && worker === 'qoder' && !String(process.env.QODER_UMID_NO_INSTALL || '').trim()) {
    try {
      const installed = await installQoderUmidComponent(home);
      component = { path: installed.path, env: 4, source: 'npm' };
    } catch (error) {
      return { risk: null, source: '', note: `设备风控组件安装失败：${error instanceof Error ? error.message : String(error)}` };
    }
  }
  if (!component) {
    return { risk: null, source: '', note: '本机没有 Qoder 客户端 / qodercli 的 UMID 组件' };
  }
  try {
    const risk = await runQoderUmidComponent(component.path, component.env, uid);
    return { risk, source: component.source, note: '' };
  } catch (error) {
    return { risk: null, source: component.source, note: `设备风控身份生成失败：${error instanceof Error ? error.message : String(error)}` };
  }
}

/**
 * 解析一次签到要用的设备身份（带 50 分钟缓存，同一进程内多次签到复用）。
 * @param {'qoder'|'qoder-cn'} worker
 */
export async function resolveQoderDevice(worker = 'qoder', { home = homedir(), uid = '' } = {}) {
  const key = `${worker}:${uid}`;
  const hit = RISK_CACHE.get(key);
  if (hit && Date.now() - hit.at < RISK_TTL_MS) return hit.value;
  const [clientVersion, machineId] = await Promise.all([
    detectQoderClientVersion(home, worker),
    readQoderMachineId(home, worker),
  ]);
  const { risk, source, note } = await resolveRisk(worker, home, uid);
  const value = {
    worker,
    clientVersion,
    machineOs: qoderMachineOs(),
    machineId,
    machineHostname: qoderMachineHostname(),
    risk,
    source,
    note,
  };
  RISK_CACHE.set(key, { at: Date.now(), value });
  return value;
}

/** 测试用：清掉进程内缓存 */
export function resetQoderDeviceCache() {
  DEVICE_CACHE.clear();
  RISK_CACHE.clear();
}
