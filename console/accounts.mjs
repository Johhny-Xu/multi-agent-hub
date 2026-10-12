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
 * 全部 9 个 worker 均支持档案保存、自动归档、切换与沙箱添加账号。
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
  const s = String(raw || '').trim()
    .replace(/@.*$/, '')
    .replace(/[^a-zA-Z0-9._-]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 40);
  return s || '';
}

/**
 * 从凭据文件中提取可读的账号标识名称与唯一身份 ID（绝不暴露密钥明文）
 * @param {string} worker
 * @param {string} [baseHome]
 * @returns {Promise<{ label: string, identity: string }>}
 */
export async function detectAccountInfo(worker, baseHome = HOME) {
  const relFiles = WORKER_CRED_FILES[worker] || [];
  const fp = await fingerprint(relFiles, baseHome);
  const shortFp = fp.slice(0, 6);
  try {
    if (worker === 'antigravity') {
      const raw = JSON.parse((await readFile(join(baseHome, relFiles[0]), 'utf-8')).replace(/^\uFEFF/, ''));
      const claims = decodeJwtPayload(raw?.id_token || '');
      const email = claims?.email || '';
      const sub = claims?.sub || '';
      const label = cleanProfileLabel(email || claims?.name || (sub ? `google-${String(sub).slice(-6)}` : '')) || `google-${shortFp}`;
      return { label, identity: email || sub || fp };
    }
    if (worker === 'codebuddy' || worker === 'codebuddy-cn') {
      const raw = JSON.parse((await readFile(join(baseHome, relFiles[0]), 'utf-8')).replace(/^\uFEFF/, ''));
      const acct = raw?.account || raw?.user || {};
      const uid = String(acct.uid || acct.uin || acct.oneidAccountId || '').trim();
      const nick = cleanProfileLabel(acct.email || acct.nickname || '');
      const prefix = worker === 'codebuddy-cn' ? 'cb-cn' : 'cb';
      const label = nick || (uid ? `${prefix}-${uid.slice(0, 8)}` : `${prefix}-${shortFp}`);
      return { label, identity: uid || fp };
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
      return { label: uname || `zcode-${shortFp}`, identity: String(ui?.id || ui?.username || fp) };
    }
    if (worker === 'traecode') {
      const tok = (await readFile(join(baseHome, relFiles[0]), 'utf-8')).trim();
      const claims = decodeJwtPayload(tok) || {};
      const uname = cleanProfileLabel(claims.email || claims.username || claims.name || (claims.user_id ? `trae-${String(claims.user_id).slice(-6)}` : ''));
      return { label: uname || `trae-${shortFp}`, identity: String(claims.user_id || claims.sub || fp) };
    }
    if (worker === 'minimaxcode') {
      const raw = JSON.parse((await readFile(join(baseHome, relFiles[0]), 'utf-8')).replace(/^\uFEFF/, ''));
      const reg = cleanProfileLabel(raw?.region || raw?.oauth?.region || 'cn') || 'cn';
      const uname = cleanProfileLabel(raw?.email || raw?.user?.email || raw?.user?.name || '');
      return { label: uname || `mmx-${reg}-${shortFp}`, identity: fp };
    }
    if (worker === 'mimocode') {
      const raw = JSON.parse((await readFile(join(baseHome, relFiles[0]), 'utf-8')).replace(/^\uFEFF/, ''));
      const uid = raw?.xiaomi?.metadata?.uid;
      if (uid) return { label: `mimo-${cleanProfileLabel(String(uid)).slice(0, 10)}`, identity: String(uid) };
      const firstProvider = Object.keys(raw || {}).find((k) => raw[k] && (raw[k].key || raw[k].access || raw[k].token)) || 'mimo';
      return { label: `${cleanProfileLabel(firstProvider)}-${shortFp}`, identity: fp };
    }
    if (worker === 'github-copilot') {
      return { label: `copilot-${shortFp}`, identity: fp };
    }
    if (worker === 'codearts') {
      const txt = await readFile(join(baseHome, relFiles[0]), 'utf-8');
      const m = txt.match(/^CODEARTS_CLI_AK=(.+)$/m);
      const ak = m ? m[1].trim() : '';
      const shortAk = cleanProfileLabel(ak.slice(0, 8)) || shortFp;
      return { label: `ak-${shortAk}`, identity: ak || fp };
    }
  } catch { /* fallback below */ }
  return { label: `${cleanProfileLabel(worker).slice(0, 8)}-${shortFp}`, identity: fp };
}

/** 检查指定 HOME 下某 worker 是否存在有效凭据 */
async function isLiveCredValid(worker, relFiles, baseHome = HOME) {
  if (!relFiles || !relFiles.length) return false;
  for (const rel of relFiles) {
    const abs = join(baseHome, rel);
    if (!(await exists(abs))) return false;
    try {
      const txt = (await readFile(abs, 'utf-8')).trim();
      if (!txt || txt === '__LOGGED_OUT__') return false;
      if (worker === 'mimocode') {
        const d = JSON.parse(txt.replace(/^\uFEFF/, ''));
        const keys = Object.keys(d || {}).filter((k) => d[k] && (d[k].key || d[k].access || d[k].token));
        if (!keys.length) return false;
      }
    } catch {
      return false;
    }
  }
  return true;
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

  const dir = join(ROOT, worker);
  await mkdir(dir, { recursive: true });
  let names = [];
  try { names = (await readdir(dir)).filter((n) => !n.startsWith('.')); } catch { names = []; }

  const { label: detectedLabel, identity } = await detectAccountInfo(worker, HOME);
  const cleanPref = cleanProfileLabel(preferredName);

  // 1. 检查是否已有档案与当前生效凭据完全一致
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
    if (allMatch) {
      // 如果用户明确指定了新档案名且不同于现有匹配档案，另存一份
      if (cleanPref && cleanPref !== name) break;
      return { ok: true, worker, name, identity, autoAdded: false };
    }
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
    JSON.stringify({ savedAt: new Date().toISOString(), files: relFiles, identity, autoAdded: true }, null, 2),
    'utf-8',
  );
  return { ok: true, worker, name: targetName, identity, autoAdded: true };
}

/** 列出所有 worker 的账号档案与当前生效状态（自动将未归档的已登录凭据纳入账号列表） */
export async function listAccounts() {
  return withLock(ACCOUNTS_WRITE_LOCK, async () => {
    await ensureCopilotMirrorFile();
    const workers = {};
    for (const [worker, relFiles] of Object.entries(WORKER_CRED_FILES)) {
      const livePresent = await isLiveCredValid(worker, relFiles, HOME);
      if (livePresent) {
        try { await _autoSyncLiveAccount(worker); } catch { /* ignore */ }
      }
      const liveFp = await fingerprint(relFiles);
      /** @type {Array<{name:string, savedAt:string|null, note:string|null, identity:string|null, active:boolean}>} */
      const profiles = [];
      const dir = join(ROOT, worker);
      let names = [];
      try { names = (await readdir(dir)).filter((n) => !n.startsWith('.')); } catch { names = []; }
      for (const name of names.sort()) {
        let meta = null;
        try { meta = JSON.parse((await readFile(join(dir, name, 'meta.json'), 'utf-8')).replace(/^\uFEFF/, '')); } catch { meta = null; }
        let active = false;
        if (livePresent) {
          for (const rel of relFiles) {
            const base = rel.split('/').pop();
            try {
              const liveTxt = await readFile(join(HOME, rel), 'utf-8');
              const profTxt = await readFile(join(dir, name, base), 'utf-8');
              if (liveTxt === profTxt && liveTxt.trim() !== '__LOGGED_OUT__') { active = true; break; }
            } catch { /* 任一侧缺失则不算 active */ }
          }
        }
        profiles.push({
          name,
          savedAt: meta?.savedAt || null,
          note: meta?.note || null,
          identity: meta?.identity || null,
          active,
        });
      }
      workers[worker] = {
        credFiles: relFiles,
        livePresent,
        liveFingerprint: liveFp,
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

  const { label, identity } = await detectAccountInfo(worker, HOME);
  const finalName = cleanProfileLabel(name) || label;
  const dest = profileDir(worker, finalName);
  await mkdir(dest, { recursive: true });
  for (const rel of relFiles) {
    const base = rel.split('/').pop();
    await copyFile(join(HOME, rel), join(dest, base));
  }
  await writeFile(
    join(dest, 'meta.json'),
    JSON.stringify({ savedAt: new Date().toISOString(), files: relFiles, identity }, null, 2),
    'utf-8',
  );
  return { ok: true, worker, name: finalName, identity, savedAt: new Date().toISOString() };
}

/** 全部 9 个 worker 均支持沙箱隔离添加新账号 */
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
      return { ok: false, error: `尚未检测到新登录凭据（请先在浏览器完成授权或粘贴回调信息提交）` };
    }
  }
  const { label: detectedLabel, identity } = await detectAccountInfo(worker, srcHome);
  const finalName = cleanProfileLabel(name) || detectedLabel || `acc-${Date.now().toString().slice(-4)}`;
  const dest = profileDir(worker, finalName);
  await mkdir(dest, { recursive: true });
  for (const rel of rels) {
    const base = rel.split('/').pop();
    await copyFile(join(srcHome, rel), join(dest, base));
  }
  await writeFile(
    join(dest, 'meta.json'),
    JSON.stringify({ savedAt: new Date().toISOString(), via: 'oauth-add', identity }, null, 2),
    'utf-8',
  );
  const sw = await _switchAccount(worker, finalName);
  return { ok: true, worker, name: finalName, identity, switched: sw.ok === true, note: `新账号「${finalName}」已自动添加并切换生效` };
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
