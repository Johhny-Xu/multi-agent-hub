// @ts-check
// Multi-Agent Hub 账号切换与自动归档器
// 按 worker 管理各官方 CLI 的 OAuth 凭据文件快照：
// 1. OAuth 登录成功后自动识别账号身份（邮箱/用户名/UID/指纹）并自动加入账号档案列表；
// 2. 登录新账号前自动备份保护已有生效凭据，绝不覆盖丢失旧账号；
// 3. 支持一键切换、手动命名保存、沙箱隔离添加与删除档案。
// 快照库：~/.agenthub/accounts/<worker>/<profile>/<原文件名> + meta.json

import { readFile, writeFile, mkdir, readdir, copyFile, stat, chmod, rm } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { execFile as execFileCb } from 'node:child_process';
import { promisify } from 'node:util';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { clearQuotaCache, decryptZcodeCred } from './vendor-quota.mjs';
import { getSandbox } from './auth.mjs';

const execFile = promisify(execFileCb);
const HOME = homedir();
const ROOT = join(HOME, '.agenthub', 'accounts');
const SECRET_HELPER = join(dirname(fileURLToPath(import.meta.url)), 'secret-get.py');

const _writeLocks = new Map();
/** 进程内异步互斥锁：同一 key 的临界区严格串行，消除并发读-改-写覆盖丢失（RMW lost update） */
async function withLock(key, fn) {
  const prev = _writeLocks.get(key) || Promise.resolve();
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  _writeLocks.set(key, gate);
  try { await prev; } catch { /* 前序临界区失败不阻塞后续 */ }
  try {
    return await fn();
  } finally {
    release();
    if (_writeLocks.get(key) === gate) _writeLocks.delete(key);
  }
}
/** 账号档案写操作共用一把互斥锁 */
const ACCOUNTS_WRITE_LOCK = 'accounts-write';

/**
 * worker → 该账号身份对应的凭据文件（相对 HOME）。
 * 全部 11 个 worker 均支持档案保存、自动归档、切换与沙箱添加账号。
 */
export const WORKER_CRED_FILES = {
  'codebuddy': ['.codebuddy/auth.info'],
  'codebuddy-cn': ['.codebuddy-cn/auth.info'],
  'minimaxcode': ['.mmx/config.json'],
  'antigravity': ['.gemini/antigravity-cli/antigravity-oauth-token'],
  'traecode': ['.trae-cn/trae-jwt-token'],
  'zcode': ['.zcode/v2/credentials.json'],
  'codearts': ['.config/agenthub-codearts/codearts-auth.env'],
  'mimocode': ['.local/share/mimocode/auth.json'],
  'github-copilot': ['.config/github-copilot/copilot-token'],
  'opencode': ['.local/share/opencode/auth.json'],
  'cline': ['.cline/data/secrets.json', '.cline/data/settings/providers.json'],
};

/** 同步 github-copilot 的 gnome-keyring 与本地镜像文件 */
async function ensureCopilotMirrorFile() {
  const mirrorPath = join(HOME, '.config', 'github-copilot', 'copilot-token');
  try {
    const { stdout } = await execFile('python3', [SECRET_HELPER, 'copilot-cli', 'https://github.com'], { timeout: 6000 });
    const token = String(stdout || '').trim();
    if (token) {
      await mkdir(dirname(mirrorPath), { recursive: true });
      await writeFile(mirrorPath, token, { mode: 0o600 });
      return token;
    }
  } catch { /* ignore */ }
  try {
    const existing = (await readFile(mirrorPath, 'utf-8')).trim();
    if (existing && existing !== '__LOGGED_OUT__') return existing;
  } catch { /* ignore */ }
  return null;
}

async function syncCopilotKeyringFromMirror() {
  const mirrorPath = join(HOME, '.config', 'github-copilot', 'copilot-token');
  try {
    const token = (await readFile(mirrorPath, 'utf-8')).trim();
    if (token && token !== '__LOGGED_OUT__') {
      await execFile('python3', [SECRET_HELPER, '--set', 'copilot-cli', 'https://github.com', token], { timeout: 6000 });
    }
  } catch { /* ignore */ }
}

const exists = async (p) => { try { await stat(p); return true; } catch { return false; } };

function profileDir(worker, name) {
  return join(ROOT, worker, name);
}

/**
 * CodeBuddy 新版 CLI（≥2.164）的真实会话存储：XDG sharedDataPath 下的 auth/<产品认证ID>.info。
 * 注意它跟随 HOME，不随 CODEBUDDY_CONFIG_DIR；官方 CN/国际版共用同一文件（同 authentication.id）。
 */
const CODEBUDDY_SHARED_AUTH_REL = join('.local', 'share', 'CodeBuddyExtension', 'Data', 'Public', 'auth');

/**
 * 在指定 HOME 下扫描 CodeBuddy 共享会话存储，返回首个有效凭据（auth.accessToken 为真实 JWT 而非跳转 URL）。
 * 备份轮换文件（文件名带日期戳）自动排在后面。
 * @returns {Promise<{ file: string, data: any } | null>}
 */
export async function findCodeBuddySharedAuth(baseHome = HOME) {
  const dir = join(baseHome, CODEBUDDY_SHARED_AUTH_REL);
  let files = [];
  try { files = await readdir(dir); } catch { return null; }
  const cands = files.filter((f) => f.endsWith('.info')).sort((a, b) => a.length - b.length);
  for (const f of cands) {
    try {
      const d = JSON.parse((await readFile(join(dir, f), 'utf-8')).replace(/^\uFEFF/, ''));
      const tok = String(d?.auth?.accessToken || '').trim();
      if (tok && !tok.startsWith('http')) return { file: join(dir, f), data: d };
    } catch { /* 下一个候选 */ }
  }
  return null;
}

// 注意：绝不在账号切换/登录时回写真实 HOME 下的 CodeBuddy 共享会话存储（XDG auth/*.info）——
// 那里是 WorkBuddy 桌面版的会话，hub 写它会把桌面版顶成别的账号。
// 派发侧隔离由各 wrapper（~/.local/bin/codebuddy-intl / codebuddy-cn）的隔离 HOME 负责；
// 本模块只【读】沙箱里的共享存储用于登录捕获（findCodeBuddySharedAuth），不写真实存储。

async function fingerprint(relPaths, baseHome = HOME) {
  const hash = createHash('sha256');
  for (const rel of relPaths) {
    try { hash.update(await readFile(join(baseHome, rel), 'utf-8')); } catch { hash.update('<missing>'); }
  }
  return hash.digest('hex').slice(0, 12);
}

function decodeJwtPayload(token) {
  try {
    const parts = String(token || '').trim().split('.');
    if (parts.length < 2) return null;
    return JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
  } catch {
    return null;
  }
}

export function cleanProfileLabel(raw) {
  // 保留 Unicode 字母与数字（含中文），仅剥离文件系统不安全字符，避免 CJK 账号名被吞成纯数字
  const s = String(raw || '').trim()
    .replace(/@.*$/, '')
    .replace(/[^\p{L}\p{N}._-]/gu, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 40);
  return s || '';
}

/**
 * 从凭据文件中提取可读的账号标识名称与唯一身份 ID（绝不暴露密钥明文）
 * @param {string} worker
 * @param {string} [baseHome]
 * @returns {Promise<{ label: string, identity: string, display: string }>}
 */
export async function detectAccountInfo(worker, baseHome = HOME) {
  const relFiles = WORKER_CRED_FILES[worker] || [];
  const fp = await fingerprint(relFiles, baseHome);
  const shortFp = fp.slice(0, 6);
  try {
    if (worker === 'antigravity') {
      const raw = JSON.parse((await readFile(join(baseHome, relFiles[0]), 'utf-8')).replace(/^\uFEFF/, ''));
      const claims = decodeJwtPayload(raw?.id_token || '');
      const email = String(claims?.email || raw?.email || '').trim();
      const sub = String(claims?.sub || '').trim();
      const label = cleanProfileLabel(email || claims?.name || (sub ? `google-${sub.slice(-6)}` : '')) || `google-${shortFp}`;
      return { label, identity: email || sub || fp, display: email || claims?.name || label };
    }
    if (worker === 'codebuddy' || worker === 'codebuddy-cn') {
      const raw = JSON.parse((await readFile(join(baseHome, relFiles[0]), 'utf-8')).replace(/^\uFEFF/, ''));
      // account / accounts[0] / allAccounts[0] 是三份同构副本，任取其一；国际版可能只有 JWT
      const acct = raw?.account || raw?.accounts?.[0] || raw?.allAccounts?.[0] || raw?.user || {};
      const rawTok = String(raw?.auth?.accessToken || '');
      // 国际版未完成登录时 accessToken 会是 https://...started?state=... 跳转 URL，不是 JWT
      const jwtClaims = (rawTok && !rawTok.startsWith('http') ? decodeJwtPayload(rawTok) : null) || {};
      const email = String(acct.email || jwtClaims.email || '').trim();
      const phone = String(acct.phoneNumber || jwtClaims.preferred_username || '').trim();
      const rawNick = String(acct.nickname || jwtClaims.nickname || jwtClaims.name || '').trim();
      const uid = String(acct.uid || acct.uin || acct.oneidAccountId || jwtClaims.sub || '').trim();
      const prefix = worker === 'codebuddy-cn' ? 'cb-cn' : 'cb';
      // 显示层绝不暴露手机号：只显示账户名称/邮箱；档案名也优先名称而非手机号
      const nickSafe = /^1\d{10}$/.test(rawNick) ? '' : rawNick;
      const label = cleanProfileLabel(email || nickSafe) || (uid ? `${prefix}-${cleanProfileLabel(uid).slice(0, 8)}` : `${prefix}-${shortFp}`);
      const display = (nickSafe && email && nickSafe !== email)
        ? `${nickSafe} (${email})`
        : (nickSafe || email || (uid ? `UID:${uid.slice(0, 8)}…` : label));
      return { label, identity: uid || email || phone || fp, display };
    }
    if (worker === 'zcode') {
      const raw = JSON.parse((await readFile(join(baseHome, relFiles[0]), 'utf-8')).replace(/^\uFEFF/, ''));
      const decMap = {};
      for (const [k, v] of Object.entries(raw || {})) {
        if (typeof v === 'string') decMap[k] = decryptZcodeCred(v);
      }
      const active = String(decMap['oauth:active_provider'] || 'bigmodel').trim();
      const uiRaw = decMap[`oauth:${active}:user_info`] || decMap['oauth:bigmodel:user_info'] || decMap['oauth:zai:user_info'] || '';
      let ui = null;
      try { if (uiRaw) ui = JSON.parse(uiRaw); } catch { ui = null; }
      const uname = cleanProfileLabel(ui?.username || ui?.displayName || ui?.id || '');
      const label = uname || `zcode-${shortFp}`;
      const display = String(ui?.displayName || ui?.username || label);
      return { label, identity: String(ui?.id || ui?.username || fp), display };
    }
    if (worker === 'traecode') {
      const tok = (await readFile(join(baseHome, relFiles[0]), 'utf-8')).trim();
      const claims = decodeJwtPayload(tok) || {};
      const uid = String(claims.data?.user_id || claims.data?.id || claims.user_id || claims.sub || '').trim();
      const uname = cleanProfileLabel(claims.email || claims.username || claims.name || (uid ? `trae-${uid.slice(-8)}` : ''));
      const label = uname || `trae-${shortFp}`;
      const display = claims.email || claims.username || (uid ? `UID:${uid}` : label);
      return { label, identity: uid || fp, display };
    }
    if (worker === 'minimaxcode') {
      const raw = JSON.parse((await readFile(join(baseHome, relFiles[0]), 'utf-8')).replace(/^\uFEFF/, ''));
      const reg = cleanProfileLabel(raw?.region || raw?.oauth?.region || 'cn') || 'cn';
      // mmx OAuth 登录时官方 CLI 会把 token 响应里的 account 写回 config.json
      const acctRaw = raw?.account ?? raw?.oauth?.account ?? null;
      const acctStr = typeof acctRaw === 'string' ? acctRaw : (acctRaw?.email || acctRaw?.name || acctRaw?.username || acctRaw?.user_name || acctRaw?.nick || '');
      const uname = cleanProfileLabel(acctStr || raw?.email || raw?.user?.email || raw?.user?.name || '');
      const label = uname || `mmx-${reg}-${shortFp}`;
      return { label, identity: uname || fp, display: acctStr || raw?.email || raw?.user?.email || label };
    }
    if (worker === 'mimocode') {
      const raw = JSON.parse((await readFile(join(baseHome, relFiles[0]), 'utf-8')).replace(/^\uFEFF/, ''));
      const uid = raw?.xiaomi?.metadata?.uid;
      if (uid) {
        const label = `mimo-${cleanProfileLabel(String(uid)).slice(0, 12)}`;
        return { label, identity: String(uid), display: `小米 UID:${uid}` };
      }
      const firstProvider = Object.keys(raw || {}).find((k) => raw[k] && (raw[k].key || raw[k].access || raw[k].token)) || 'mimo';
      const label = `${cleanProfileLabel(firstProvider)}-${shortFp}`;
      return { label, identity: fp, display: `${firstProvider} (${shortFp})` };
    }
    if (worker === 'github-copilot') {
      const label = `copilot-${shortFp}`;
      return { label, identity: fp, display: label };
    }
    if (worker === 'codearts') {
      const txt = await readFile(join(baseHome, relFiles[0]), 'utf-8');
      const m = txt.match(/^CODEARTS_CLI_AK=(.+)$/m);
      const ak = m ? m[1].trim() : '';
      const shortAk = cleanProfileLabel(ak.slice(0, 8)) || shortFp;
      const label = `ak-${shortAk}`;
      const display = ak.length > 8 ? `AK:${ak.slice(0, 4)}…${ak.slice(-4)}` : label;
      return { label, identity: ak || fp, display };
    }
    if (worker === 'opencode') {
      const raw = JSON.parse((await readFile(join(baseHome, relFiles[0]), 'utf-8')).replace(/^\uFEFF/, ''));
      const providers = Object.keys(raw || {}).filter((k) => raw[k] && (raw[k].key || raw[k].access || raw[k].token));
      const first = providers[0] || 'provider';
      const label = `${cleanProfileLabel(first)}-${shortFp}`;
      return { label, identity: `${first}:${fp}`, display: `${first} (${providers.length} 个提供方)` };
    }
    if (worker === 'cline') {
      // cline 把账号身份放在 secrets.json 的 cline:clineAccountId（内含 idToken），取邮箱作为显示名
      let email = '';
      try {
        const secrets = JSON.parse((await readFile(join(baseHome, '.cline/data/secrets.json'), 'utf-8')).replace(/^\uFEFF/, ''));
        const acct = JSON.parse(String(secrets['cline:clineAccountId'] || '{}'));
        const claims = decodeJwtPayload(acct.idToken || '') || {};
        email = String(claims.email || acct.email || '').trim();
      } catch { /* 无 OAuth 账号时按 provider 命名 */ }
      let provider = 'provider';
      try {
        const prov = JSON.parse((await readFile(join(baseHome, '.cline/data/settings/providers.json'), 'utf-8')).replace(/^\uFEFF/, ''));
        provider = String(prov?.lastUsedProvider || 'provider');
      } catch { /* ignore */ }
      const label = cleanProfileLabel(email) || `${cleanProfileLabel(provider)}-${shortFp}`;
      return { label, identity: email || fp, display: email || `${provider} (${shortFp})` };
    }
  } catch { /* fallback below */ }
  const fallbackLabel = `${cleanProfileLabel(worker).slice(0, 8)}-${shortFp}`;
  return { label: fallbackLabel, identity: fp, display: fallbackLabel };
}

/** 检查指定 HOME 下某 worker 是否存在有效凭据 */
async function isLiveCredValid(worker, relFiles, baseHome = HOME) {
  if (!relFiles || !relFiles.length) return false;
  // cline 的 secrets.json / providers.json 由官方 CLI 按需写入，任一存在且非空即视为已登录
  const anyOf = worker === 'cline';
  let present = 0;
  for (const rel of relFiles) {
    const abs = join(baseHome, rel);
    if (!(await exists(abs))) {
      if (anyOf) continue;
      return false;
    }
    try {
      const txt = (await readFile(abs, 'utf-8')).trim();
      if (!txt || txt === '__LOGGED_OUT__') {
        if (anyOf) continue;
        return false;
      }
      if (worker === 'mimocode' || worker === 'opencode') {
        const d = JSON.parse(txt.replace(/^\uFEFF/, ''));
        const keys = Object.keys(d || {}).filter((k) => d[k] && (d[k].key || d[k].access || d[k].token));
        if (!keys.length) {
          if (anyOf) continue;
          return false;
        }
      }
      if (worker === 'codebuddy' || worker === 'codebuddy-cn') {
        // 未完成授权时 auth.accessToken 可能是 https://...started?state=... 跳转 URL 半成品，不算有效凭据
        const d = JSON.parse(txt.replace(/^\uFEFF/, ''));
        const tok = String(d?.auth?.accessToken || '').trim();
        if (!tok || tok.startsWith('http')) return false;
      }
      present += 1;
    } catch {
      if (anyOf) continue;
      return false;
    }
  }
  return anyOf ? present > 0 : true;
}

/**
 * 自动将当前生效凭据同步归档到 ~/.agenthub/accounts/<worker>/ 中：
 * - 若当前凭据内容已匹配某个现有档案，直接返回该档案名；
 * - 若当前凭据尚未归档（例如刚完成 OAuth 登录，或首次接管系统已有凭据），
 *   自动按账号身份（邮箱/用户名/UID）生成档案并标记为 active！
 * @param {string} worker
 * @param {string} [preferredName]
 */
async function _autoSyncLiveAccount(worker, preferredName = '') {
  const relFiles = WORKER_CRED_FILES[worker];
  if (!relFiles) return { ok: false, error: `不支持的 worker: ${worker}` };
  if (worker === 'github-copilot') await ensureCopilotMirrorFile();
  const valid = await isLiveCredValid(worker, relFiles, HOME);
  if (!valid) return { ok: false, reason: 'not_logged_in' };

  // mimocode 特例：仅有 xiaomi API Key（无 OAuth uid、无其他通道）时，凭据只是通道配置而非账号身份，
  // 不自动归档为账号，避免「自添加 API Key 被当作账号加入列表」
  if (worker === 'mimocode') {
    try {
      const d = JSON.parse((await readFile(join(HOME, relFiles[0]), 'utf-8')).replace(/^\uFEFF/, ''));
      const hasUid = !!(d?.xiaomi?.metadata?.uid);
      const otherProviders = Object.keys(d || {}).filter((k) => k !== 'xiaomi' && d[k] && (d[k].key || d[k].access || d[k].token));
      if (!hasUid && !otherProviders.length) return { ok: false, reason: 'api_key_only' };
    } catch { /* 解析失败时按普通流程处理 */ }
  }

  const dir = join(ROOT, worker);
  await mkdir(dir, { recursive: true });
  let names = [];
  try { names = (await readdir(dir)).filter((n) => !n.startsWith('.')); } catch { names = []; }

  const { label: detectedLabel, identity, display } = await detectAccountInfo(worker, HOME);
  const cleanPref = cleanProfileLabel(preferredName);

  // 1. 检查是否已有档案与当前生效凭据完全一致
  const matchingNames = [];
  for (const name of names) {
    let allMatch = true;
    for (const rel of relFiles) {
      const base = rel.split('/').pop();
      try {
        const liveTxt = await readFile(join(HOME, rel), 'utf-8');
        const profTxt = await readFile(join(dir, name, base), 'utf-8');
        if (liveTxt !== profTxt) { allMatch = false; break; }
      } catch {
        allMatch = false;
        break;
      }
    }
    if (allMatch) matchingNames.push(name);
  }

  if (matchingNames.length > 0 && (!cleanPref || matchingNames.includes(cleanPref))) {
    let chosen = cleanPref && matchingNames.includes(cleanPref) ? cleanPref : '';
    if (!chosen) {
      try {
        const actMarker = (await readFile(join(dir, '.active'), 'utf-8')).trim();
        if (actMarker && matchingNames.includes(actMarker)) chosen = actMarker;
      } catch { /* ignore */ }
    }
    if (!chosen) {
      chosen = matchingNames.find((n) => n === detectedLabel) || matchingNames[0];
    }
    // 自动补全旧档案缺失的 identity / display 元数据
    try {
      const metaPath = join(dir, chosen, 'meta.json');
      let meta = {};
      try { meta = JSON.parse((await readFile(metaPath, 'utf-8')).replace(/^\uFEFF/, '')); } catch { meta = {}; }
      if (!meta.identity || !meta.display) {
        meta.identity = meta.identity || identity;
        meta.display = meta.display || display;
        meta.savedAt = meta.savedAt || new Date().toISOString();
        await writeFile(metaPath, JSON.stringify(meta, null, 2), 'utf-8');
      }
    } catch { /* ignore */ }
    await writeFile(join(dir, '.active'), chosen, 'utf-8').catch(() => {});
    return { ok: true, worker, name: chosen, identity, display, autoAdded: false };
  }

  // 2. 检查是否同一账号身份 (identity) 刷新了 OAuth Token（若是且未强制指定别的名称，则原地更新该档案）
  let targetName = cleanPref || '';
  if (!targetName && identity) {
    for (const name of names) {
      try {
        const meta = JSON.parse((await readFile(join(dir, name, 'meta.json'), 'utf-8')).replace(/^\uFEFF/, ''));
        if (meta?.identity && meta.identity === identity) {
          targetName = name;
          break;
        }
      } catch { /* ignore */ }
    }
  }

  // 3. 确定最终档案名称（避免覆盖不同账号的同名档案）
  if (!targetName) {
    const baseName = detectedLabel || `acc-${names.length + 1}`;
    let candidate = baseName;
    let idx = 2;
    while (names.includes(candidate)) {
      candidate = `${baseName}-${idx++}`;
    }
    targetName = candidate;
  }

  const dest = profileDir(worker, targetName);
  await mkdir(dest, { recursive: true });
  for (const rel of relFiles) {
    const base = rel.split('/').pop();
    await copyFile(join(HOME, rel), join(dest, base));
  }
  await writeFile(
    join(dest, 'meta.json'),
    JSON.stringify({ savedAt: new Date().toISOString(), files: relFiles, identity, display, autoAdded: true }, null, 2),
    'utf-8',
  );
  await writeFile(join(dir, '.active'), targetName, 'utf-8').catch(() => {});
  return { ok: true, worker, name: targetName, identity, display, autoAdded: true };
}

/** 列出所有 worker 的账号档案与当前生效状态（自动将未归档的已登录凭据纳入账号列表） */
export async function listAccounts() {
  return withLock(ACCOUNTS_WRITE_LOCK, async () => {
    await ensureCopilotMirrorFile();
    const workers = {};
    for (const [worker, relFiles] of Object.entries(WORKER_CRED_FILES)) {
      const livePresent = await isLiveCredValid(worker, relFiles, HOME);
      let syncedActiveName = '';
      if (livePresent) {
        try {
          const sr = await _autoSyncLiveAccount(worker);
          if (sr?.ok && sr.name) syncedActiveName = sr.name;
        } catch { /* ignore */ }
      }
      const liveFp = await fingerprint(relFiles);
      const dir = join(ROOT, worker);
      if (!syncedActiveName) {
        try { syncedActiveName = (await readFile(join(dir, '.active'), 'utf-8')).trim(); } catch { syncedActiveName = ''; }
      }
      /** @type {Array<{name:string, savedAt:string|null, note:string|null, identity:string|null, display:string|null, active:boolean}>} */
      const rawProfiles = [];
      let names = [];
      try { names = (await readdir(dir)).filter((n) => !n.startsWith('.')); } catch { names = []; }
      for (const name of names.sort()) {
        let meta = null;
        try { meta = JSON.parse((await readFile(join(dir, name, 'meta.json'), 'utf-8')).replace(/^\uFEFF/, '')); } catch { meta = null; }
        let matchesLive = false;
        if (livePresent) {
          matchesLive = true;
          for (const rel of relFiles) {
            const base = rel.split('/').pop();
            try {
              const liveTxt = await readFile(join(HOME, rel), 'utf-8');
              const profTxt = await readFile(join(dir, name, base), 'utf-8');
              if (liveTxt !== profTxt || liveTxt.trim() === '__LOGGED_OUT__') { matchesLive = false; break; }
            } catch {
              matchesLive = false;
              break;
            }
          }
        }
        rawProfiles.push({
          name,
          savedAt: meta?.savedAt || null,
          note: meta?.note || null,
          identity: meta?.identity || null,
          display: meta?.display || meta?.identity || name,
          matchesLive,
        });
      }

      // 确保同一时刻最多只有 1 个档案标记为 active（优先匹配 .active 记录的档案名）
      const matchingList = rawProfiles.filter((p) => p.matchesLive);
      let activeWinner = '';
      if (matchingList.length === 1) {
        activeWinner = matchingList[0].name;
      } else if (matchingList.length > 1) {
        const preferred = matchingList.find((p) => p.name === syncedActiveName);
        activeWinner = preferred ? preferred.name : matchingList[0].name;
      }

      const profiles = rawProfiles.map(({ matchesLive, ...rest }) => ({
        ...rest,
        active: rest.name === activeWinner,
      }));
      // 将当前生效账号排在第一位，方便用户在列表与卡片上一眼看到
      profiles.sort((a, b) => (b.active ? 1 : 0) - (a.active ? 1 : 0) || a.name.localeCompare(b.name));

      workers[worker] = {
        credFiles: relFiles,
        livePresent,
        liveFingerprint: liveFp,
        activeAccount: activeWinner || null,
        profiles,
      };
    }
    return { root: ROOT, workers };
  });
}

/** 把当前生效凭据存为一个档案 */
async function _saveAccount(worker, name) {
  const relFiles = WORKER_CRED_FILES[worker];
  if (!relFiles) return { ok: false, error: `不支持的 worker: ${worker}` };
  if (worker === 'github-copilot') await ensureCopilotMirrorFile();
  const valid = await isLiveCredValid(worker, relFiles, HOME);
  if (!valid) return { ok: false, error: `当前未检测到 ${worker} 的有效登录凭据，请先完成 OAuth 登录` };

  const { label, identity, display } = await detectAccountInfo(worker, HOME);
  const finalName = cleanProfileLabel(name) || label;
  const dest = profileDir(worker, finalName);
  await mkdir(dest, { recursive: true });
  for (const rel of relFiles) {
    const base = rel.split('/').pop();
    await copyFile(join(HOME, rel), join(dest, base));
  }
  await writeFile(
    join(dest, 'meta.json'),
    JSON.stringify({ savedAt: new Date().toISOString(), files: relFiles, identity, display }, null, 2),
    'utf-8',
  );
  await writeFile(join(ROOT, worker, '.active'), finalName, 'utf-8').catch(() => {});
  return { ok: true, worker, name: finalName, identity, display, savedAt: new Date().toISOString() };
}

/** 全部 11 个 worker 均支持沙箱隔离添加新账号 */
export const SANDBOX_CRED_FILES = { ...WORKER_CRED_FILES };

/** 沙箱添加账号：把沙箱 HOME 里新生成的凭据快照成档案并立即切换 */
async function _addFromSandbox(worker, name, loginId) {
  const rels = SANDBOX_CRED_FILES[worker];
  if (!rels) return { ok: false, error: `该 worker 暂不支持沙箱添加账号` };
  // 先保护当前已登录的主账号不丢失
  try { await _autoSyncLiveAccount(worker); } catch { /* ignore */ }

  const sandbox = getSandbox(loginId);
  const srcHome = sandbox || HOME;
  if (worker === 'github-copilot') {
    const tok = await ensureCopilotMirrorFile();
    if (tok && sandbox) {
      const sbFile = join(sandbox, rels[0]);
      await mkdir(dirname(sbFile), { recursive: true });
      await writeFile(sbFile, tok, { mode: 0o600 });
    }
  }
  for (const rel of rels) {
    const srcFile = join(srcHome, rel);
    try {
      const content = (await readFile(srcFile, 'utf-8')).trim();
      if (!content || content === '__LOGGED_OUT__') throw new Error('empty');
    } catch {
      // codebuddy 新版 CLI 把会话写进 XDG 共享存储而非配置目录：尝试从共享存储镜像出 legacy auth.info
      if (worker === 'codebuddy' || worker === 'codebuddy-cn') {
        const shared = await findCodeBuddySharedAuth(srcHome);
        if (shared) {
          const payload = { ...shared.data };
          if (!payload.allAccounts && payload.account) payload.allAccounts = [payload.account];
          payload.updatedAt = payload.updatedAt || new Date().toISOString();
          await mkdir(dirname(srcFile), { recursive: true });
          await writeFile(srcFile, JSON.stringify(payload, null, 2) + '\n', { mode: 0o600 });
          continue;
        }
      }
      return { ok: false, error: `尚未检测到新登录凭据（若授权后浏览器跳转到了 localhost 回调地址，请复制浏览器地址栏完整链接粘贴到上方输入框并点击「提交」）` };
    }
  }
  // 复用各 worker 专属有效性校验（如 codebuddy 半成品 URL、mimocode 空通道），拦住未完成的授权
  if (!(await isLiveCredValid(worker, rels, srcHome))) {
    return { ok: false, error: '凭据文件尚未写入完整（授权可能仍在进行），请稍候再次点击「我已完成授权」检测' };
  }

  const dir = join(ROOT, worker);
  await mkdir(dir, { recursive: true });
  let existingNames = [];
  try { existingNames = (await readdir(dir)).filter((n) => !n.startsWith('.')); } catch { existingNames = []; }

  const { label: detectedLabel, identity, display } = await detectAccountInfo(worker, srcHome);
  const cleanPref = cleanProfileLabel(name);
  let finalName = cleanPref || '';

  if (!finalName && identity) {
    for (const existing of existingNames) {
      try {
        const meta = JSON.parse((await readFile(join(dir, existing, 'meta.json'), 'utf-8')).replace(/^\uFEFF/, ''));
        if (meta?.identity && meta.identity === identity) {
          finalName = existing;
          break;
        }
      } catch { /* ignore */ }
    }
  }

  if (!finalName) {
    const baseName = detectedLabel || `acc-${existingNames.length + 1}`;
    let candidate = baseName;
    let idx = 2;
    while (existingNames.includes(candidate)) {
      // 若同名档案身份相同则直接复用，否则加数字后缀避免覆盖旧账号
      try {
        const meta = JSON.parse((await readFile(join(dir, candidate, 'meta.json'), 'utf-8')).replace(/^\uFEFF/, ''));
        if (meta?.identity && meta.identity === identity) break;
      } catch { /* ignore */ }
      candidate = `${baseName}-${idx++}`;
    }
    finalName = candidate;
  }

  const dest = profileDir(worker, finalName);
  await mkdir(dest, { recursive: true });
  for (const rel of rels) {
    const base = rel.split('/').pop();
    await copyFile(join(srcHome, rel), join(dest, base));
  }
  await writeFile(
    join(dest, 'meta.json'),
    JSON.stringify({ savedAt: new Date().toISOString(), via: 'oauth-add', identity, display }, null, 2),
    'utf-8',
  );
  const sw = await _switchAccount(worker, finalName);
  return { ok: true, worker, name: finalName, identity, display, switched: sw.ok === true, note: `新账号「${finalName}」已自动添加并切换生效` };
}

/** 切换到指定档案：先把当前未保存凭据自动归档并备份，再复制目标档案文件到生效位 */
async function _switchAccount(worker, name) {
  const relFiles = WORKER_CRED_FILES[worker];
  if (!relFiles) return { ok: false, error: `不支持的 worker: ${worker}` };
  // 切换前若当前生效凭据尚未归档，自动归档以防丢失
  try { await _autoSyncLiveAccount(worker); } catch { /* ignore */ }

  const src = profileDir(worker, name);
  for (const rel of relFiles) {
    const base = rel.split('/').pop();
    if (!(await exists(join(src, base)))) return { ok: false, error: `档案缺少凭据文件: ${name}/${base}` };
  }
  const backupDir = join(ROOT, worker, `.backup-${Date.now()}`);
  await mkdir(backupDir, { recursive: true });
  for (const rel of relFiles) {
    const liveAbs = join(HOME, rel);
    const base = rel.split('/').pop();
    if (await exists(liveAbs)) await copyFile(liveAbs, join(backupDir, base));
    await mkdir(join(HOME, rel, '..'), { recursive: true });
    await copyFile(join(src, base), liveAbs);
    await chmod(liveAbs, 0o600);
  }
  if (worker === 'github-copilot') {
    await syncCopilotKeyringFromMirror();
  }
  // CodeBuddy 切换不写真实 XDG 共享会话存储（属 WorkBuddy 桌面版会话）；派发侧由 wrapper 隔离 HOME 承接账号
  await writeFile(join(ROOT, worker, '.active'), name, 'utf-8').catch(() => {});
  await writeFile(join(backupDir, 'meta.json'), JSON.stringify({ note: `切换到 ${name} 前的自动备份`, at: new Date().toISOString() }, null, 2), 'utf-8');
  clearQuotaCache(worker);
  return { ok: true, worker, switchedTo: name, backup: backupDir, note: `已切换至账号「${name}」` };
}

/** 删除指定账号档案 */
async function _deleteAccount(worker, name) {
  if (!WORKER_CRED_FILES[worker]) return { ok: false, error: `不支持的 worker: ${worker}` };
  const target = profileDir(worker, name);
  if (!(await exists(target))) return { ok: false, error: `档案不存在: ${name}` };
  await rm(target, { recursive: true, force: true });
  return { ok: true, worker, deleted: name };
}

// ---- 并发加固：以下导出为串行互斥包装（内部实现为 _<name>） ----
export function autoSyncLiveAccount(worker, preferredName = '') { return withLock(ACCOUNTS_WRITE_LOCK, () => _autoSyncLiveAccount(worker, preferredName)); }
export function saveAccount(worker, name) { return withLock(ACCOUNTS_WRITE_LOCK, () => _saveAccount(worker, name)); }
export function switchAccount(worker, name) { return withLock(ACCOUNTS_WRITE_LOCK, () => _switchAccount(worker, name)); }
export function addFromSandbox(worker, name, loginId) { return withLock(ACCOUNTS_WRITE_LOCK, () => _addFromSandbox(worker, name, loginId)); }
export function deleteAccount(worker, name) { return withLock(ACCOUNTS_WRITE_LOCK, () => _deleteAccount(worker, name)); }
