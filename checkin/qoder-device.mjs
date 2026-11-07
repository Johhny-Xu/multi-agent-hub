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

/**
 * 与上游 Qoder 客户端版本对齐的默认值；真实版本优先取客户端 build-manifest.json。
 * 兜底值对齐参考实现 v1.0.8：当前桌面 worker runtime 为 1.1.69（旧的 0.2.5 已过期）。
 */
export const QODER_DEFAULT_CLIENT_VERSION = '1.1.83';
/** 风控身份有效期（上游实测 50 分钟足够稳，超过后 token 可能被判定过期） */
const RISK_TTL_MS = 50 * 60 * 1000;
/** 组件调用超时：runtime-info 首次运行要做设备指纹采集，给足 25 秒 */
const COMPONENT_TIMEOUT_MS = 25_000;

const NPM_REGISTRIES = ['https://registry.npmmirror.com', 'https://registry.npmjs.org'];
const NPM_AUTHORITY = 'https://registry.npmjs.org';

/**
 * 官方 CLI 包（缺组件时的兜底来源）：**按地区严格隔离**。
 * 国际版用 `@qoder-ai/qodercli`，中国版用 `@qodercn-ai/qoderclicn`。
 * 参考实现 L0NE-6/Qoder-Daily 的 install_umid_component 两个 bundle 入口都试。
 */
const NPM_PACKAGES = {
  qoder: {
    path: '@qoder-ai%2fqodercli',
    bundles: ['package/bundle/qodercli.js', 'package/bundle/qoder-worker-runtime.mjs'],
  },
  'qoder-cn': {
    path: '@qodercn-ai%2fqoderclicn',
    bundles: ['package/bundle/qoder-worker-runtime.mjs', 'package/bundle/qodercli.js'],
  },
};
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

/**
 * 客户端 resources 目录候选：**严格按地区隔离**。
 * 国际版只认 Qoder（运行环境码 3），国内版只认 Qoder CN / QoderCN（运行环境码 0）。
 * 参考实现 L0NE-6/Qoder-Daily v1.0.8 明确「地区隔离，互不混用」——
 * 跨地区拿组件会用错地区的指纹去要活动，服务端按地区过滤，活动行整行不下发。
 */
export function qoderResourceDirs(home, worker = 'qoder') {
  const global = worker === 'qoder';
  const names = global ? ['Qoder'] : ['Qoder CN', 'QoderCN'];
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
    // 国内版上游安装目录还可能是这两种写法
    if (!global) {
      dirs.push('/opt/Qoder-CN/resources', '/opt/QoderCN/resources');
    }
    // 本机部署形态：deb 解包到 ~/qoder-app、~/qoder-cn-app 后直接运行（同样按地区分开）
    const apps = global ? [['qoder-app', 'Qoder']] : [['qoder-cn-app', 'Qoder CN']];
    for (const [app, name] of apps) {
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

/**
 * 组件的运行环境码：**按地区固定**，与组件来源无关。
 * 参考实现 L0NE-6/Qoder-Daily v1.0.8：国际版一律 3，国内版一律 0
 * （客户端目录、CLI 缓存、官方包提取出来的都是同一个码）。
 * 传错码 → 生成的设备指纹对不上 → 服务端按错误地区过滤，每日活动行整行不下发。
 */
export const QODER_UMID_RUNTIME_ENV = { qoder: 3, 'qoder-cn': 0 };
/**
 * 从官方 CLI 包里提取/复用的组件是「CLI 组件」，国际版必须用新加坡环境参数 4。
 * 对齐 L0NE-6/Qoder-Daily v1.0.14：客户端组件继续 3，CLI / 下载组件 4。
 */
export const QODER_UMID_CLI_RUNTIME_ENV = { qoder: 4, 'qoder-cn': 0 };

/**
 * ~/.qoder 与 ~/.qoder-cn 的 .bin 目录：兼容 umid-<ver>/runtime-info 与 runtime-info-<plat> 两种布局。
 *
 * 导出给单测：客户端安装目录是**机器全局**的（不随 home 走），
 * 在装了 Qoder 客户端的机器上 findQoderUmidComponent 会先命中 app 源，
 * 只有直接测这个函数才能断言 CLI 布局的识别与地区码。
 */
export async function findCliUmid(home, worker) {
  const bin = join(home, qoderRegion(worker).configDir, '.bin');
  // CLI 缓存里的组件是提取来的，国际版环境码是 4（v1.0.14），不是客户端的 3。
  const env = QODER_UMID_CLI_RUNTIME_ENV[worker] ?? 4;
  let entries = [];
  try {
    entries = await readdir(bin);
  } catch {
    return null;
  }
  for (const entry of entries.sort().reverse()) {
    if (entry.startsWith('umid-')) {
      const path = join(bin, entry, umidExeName());
      if (await isFile(path)) return { path, env, source: 'qodercli' };
    }
  }
  for (const entry of entries.sort().reverse()) {
    if (entry.startsWith('runtime-info-')) {
      const path = join(bin, entry);
      if (await isFile(path)) return { path, env, source: 'qodercli' };
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
 * 定位 UMID 组件。返回 { path, env, source }。
 *
 * env 是组件的运行环境码：客户端组件按地区固定（国际版 3 / 中国版 0）；
 * 从 CLI 提取的组件国际版用 4（对齐 L0NE-6/Qoder-Daily v1.0.14）。
 * 取值顺序（对齐参考实现 L0NE-6/Qoder-Daily 的 find_umid_component）：
 *   1. 地区专属环境变量 QODER_RUNTIME_INFO / QODERCN_RUNTIME_INFO
 *   2. 通用环境变量 QODER_UMID_PATH
 *   3. 本地区客户端的 resources/umid/runtime-info
 *   4. 本地区 CLI 的 ~/.qoder 或 ~/.qoder-cn 下的 .bin/runtime-info
 *   5. 本地区缓存 ~/.agenthub/qoder-umid/<地区>/runtime-info
 */
export async function findQoderUmidComponent(home = homedir(), worker = 'qoder') {
  const env = QODER_UMID_RUNTIME_ENV[worker] ?? 3;
  const cliEnv = QODER_UMID_CLI_RUNTIME_ENV[worker] ?? 4;
  const regional = String(process.env[worker === 'qoder-cn' ? 'QODERCN_RUNTIME_INFO' : 'QODER_RUNTIME_INFO'] || '').trim();
  if (regional && await isFile(regional)) return { path: regional, env, source: 'env' };
  const custom = String(process.env.QODER_UMID_PATH || '').trim();
  if (custom && await isFile(custom)) return { path: custom, env, source: 'env' };

  for (const resources of qoderResourceDirs(home, worker)) {
    const path = join(resources, 'umid', umidExeName());
    if (await isFile(path)) return { path, env, source: 'app' };
  }

  const cli = await findCliUmid(home, worker);
  if (cli) return cli;

  // 这份缓存是「从官方 CLI 包提取过的」，属于 CLI 组件：国际版要用环境码 4，不是客户端的 3。
  const cached = join(home, '.agenthub', 'qoder-umid', worker, umidExeName());
  if (await isFile(cached)) return { path: cached, env: cliEnv, source: 'cache' };
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

async function npmMeta(registry, packagePath = NPM_PACKAGES.qoder.path) {
  const body = await fetchBytes(`${registry}/${packagePath}/latest`, 30_000);
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

/**
 * 从官方 CLI 包里抠出本机架构的 runtime-info ELF：写到 ~/.agenthub/qoder-umid/<地区>/runtime-info
 *
 * @param {string} home
 * @param {'qoder'|'qoder-cn'} worker 地区：国际版 qodercli / 中国版 qoderclicn
 */
export async function installQoderUmidComponent(home = homedir(), worker = 'qoder') {
  const pkg = NPM_PACKAGES[worker] || NPM_PACKAGES.qoder;
  const arch = qoderMachineOs().replace(/_(?:linux|win32|darwin)$/, '');
  const machine = arch === 'x86_64' ? 62 : arch === 'aarch64' ? 183 : 0;
  if (!machine) throw new Error('当前 CPU 架构不受支持');
  let authority = null;
  try {
    authority = await npmMeta(NPM_AUTHORITY, pkg.path);
  } catch { /* 官方源不可达时只做单源校验 */ }
  const errors = [];
  for (const registry of NPM_REGISTRIES) {
    try {
      const meta = await npmMeta(registry, pkg.path);
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
      // 两个 bundle 入口都试（参考实现 install_umid_component 同款）
      let entry = null;
      let usedEntry = '';
      for (const candidate of pkg.bundles) {
        entry = readTarGzEntry(body, candidate);
        if (entry) { usedEntry = candidate; break; }
      }
      if (!entry) {
        errors.push(`${registry}：包里没有 ${pkg.bundles.join(' 或 ')}`);
        continue;
      }
      const elf = extractUmidElf(entry.toString('utf-8'), machine);
      if (!elf) {
        errors.push(`${registry}：包里没有本机架构的 UMID 组件`);
        continue;
      }
      // 缓存按地区分目录：两个地区的指纹不混用
      const dir = join(home, '.agenthub', 'qoder-umid', worker);
      await mkdir(dir, { recursive: true });
      const path = join(dir, umidExeName());
      await writeFile(path, elf, { mode: 0o755 });
      try { await chmod(path, 0o755); } catch { /* Windows 无执行位 */ }
      return { path, version: meta.version || '', source: 'npm', entry: usedEntry };
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
//
// ⚠️ 设备身份**按地区隔离**（对齐参考实现 L0NE-6/Qoder-Daily：
//    `地区隔离设备身份：中国版读取 Qoder CN / qoderclicn，国际版读取 Qoder / qodercli`）。
//    同一台 Windows 机器上，两个地区的 machineToken 前缀相同但正文不同：
//      国际版 environment=4  P1gAGri9W-…  / 2cca32f49157e10942 / 3944a47200066faae3
//      中国版 environment=0  P1gAxveT2…   / 64e527ea91460d13b4 / 6c6603d9006166ec9f
//    把中国版的指纹喂给国际版账号，上游看到的是「另一台设备的中国版客户端」，
//    下发的活动行就是空的（表现：活动 0 个 / 未派发）。
//
// 变量优先级：地区级 > 通用兜底（通用是为旧部署与单测保留的）
//   qoder      → QODER_INTL_MACHINE_{TOKEN,CODE,TYPE}
//   qoder-cn   → QODER_CN_MACHINE_{TOKEN,CODE,TYPE}
//   任意地区兜底 → QODER_MACHINE_{TOKEN,CODE,TYPE}
const QODER_REGION_ENV_PREFIX = {
  qoder: 'QODER_INTL_MACHINE',
  'qoder-cn': 'QODER_CN_MACHINE',
};
const QODER_LEGACY_ENV_PREFIX = 'QODER_MACHINE';
const QODER_TRIPLE_KEYS = ['TOKEN', 'CODE', 'TYPE'];
/** 通用兜底的告警只打一次，避免每个账号每次签到刷一行 */
let legacyEnvWarned = false;

/** 从 `<prefix>_TOKEN/_CODE/_TYPE` 读三件套：齐全 → 对象；只填了一部分 → 'incomplete'；没填 → null */
function readTripleFromEnv(prefix) {
  if (!prefix) return null;
  const vals = QODER_TRIPLE_KEYS.map((k) => firstText(process.env[`${prefix}_${k}`]));
  const filled = vals.filter(Boolean).length;
  if (filled === 0) return null;
  if (filled < QODER_TRIPLE_KEYS.length) return 'incomplete';
  return { machineToken: vals[0], machineCode: vals[1], machineType: vals[2] };
}

function loadQoderDeviceEnv() {
  try {
    const file = join(homedir(), '.config', 'agenthub-qoder', 'device.env');
    const raw = readFileSync(file, 'utf-8');
    for (const line of raw.split('\n')) {
      const m = line.match(/^\s*((?:QODER_INTL_MACHINE|QODER_CN_MACHINE|QODER_MACHINE)_(?:TOKEN|CODE|TYPE))\s*=\s*(\S+)/);
      if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
    }
  } catch { /* 没这个文件就走原来的探测逻辑 */ }
}

async function resolveRisk(worker, home, uid) {
  loadQoderDeviceEnv();

  // 1) 地区级三件套（正确姿势）
  const scoped = readTripleFromEnv(QODER_REGION_ENV_PREFIX[worker]);
  if (scoped === 'incomplete') {
    const p = QODER_REGION_ENV_PREFIX[worker];
    return { risk: null, source: '', note: `${p}_TOKEN / _CODE / _TYPE 三件套不完整` };
  }
  if (scoped) return { risk: scoped, source: `env:${worker}`, note: '' };

  // 2) 通用兜底：单地区部署或旧配置
  const legacy = readTripleFromEnv(QODER_LEGACY_ENV_PREFIX);
  if (legacy === 'incomplete') {
    return { risk: null, source: '', note: '设备风控环境变量不完整（需要 QODER_MACHINE_TOKEN / QODER_MACHINE_CODE / QODER_MACHINE_TYPE 三件套）' };
  }
  if (legacy) {
    // ⚠️ 这里**不能**把提示写进 note：checkinQoderOne 把非空 note 当作「设备身份缺失」
    // 直接判 identity_missing 并停掉补拉。跨地区共用指纹只是降级告警，不该阻断签到，
    // 所以走 source 标记 + 一条进程级 warn，只用真正缺身份时才用 note。
    if (!legacyEnvWarned) {
      legacyEnvWarned = true;
      console.warn(`[qoder-device] 使用通用 QODER_MACHINE_* 兜底（${worker}）；`
        + `跨地区共用同一份指纹会导致活动列表为空，建议配置 ${QODER_REGION_ENV_PREFIX[worker]}_TOKEN/_CODE/_TYPE`);
    }
    return { risk: legacy, source: 'env:legacy', note: '' };
  }

  const custom = String(process.env.QODER_UMID_PATH || '').trim();
  if (custom && !(await isFile(custom))) {
    // 显式指定了组件却不存在：直接报错，不去扫描（测试与自定义部署都靠这个短路）
    return { risk: null, source: '', note: `QODER_UMID_PATH 指向的组件不存在：${custom}` };
  }

  let component = await findQoderUmidComponent(home, worker);
  if (!component && !String(process.env.QODER_UMID_NO_INSTALL || '').trim()) {
    try {
      const installed = await installQoderUmidComponent(home, worker);
      // 从官方 CLI 包抠出来的组件走 CLI 环境码（国际版 4），对齐 v1.0.14。
      component = { path: installed.path, env: QODER_UMID_CLI_RUNTIME_ENV[worker] ?? 4, source: 'npm' };
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
