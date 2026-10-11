// @ts-check
// Multi-Agent Hub 账号切换器（ccSwitch 理念的最小集成版）
// 仅做一件事：按 worker 管理各官方 CLI 的 OAuth 凭据文件快照，一键换入/存档。
// 快照库：~/.agenthub/accounts/<worker>/<profile>/<原文件名> + meta.json

import { readFile, writeFile, mkdir, readdir, copyFile, stat, chmod } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { clearQuotaCache } from './vendor-quota.mjs';
import { getSandbox } from './auth.mjs';

const HOME = homedir();
const ROOT = join(HOME, '.agenthub', 'accounts');

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
/** 账号档案写操作共用一把互斥锁；addFromSandbox 内部调用 _switchAccount 避免重入自锁 */
const ACCOUNTS_WRITE_LOCK = 'accounts-write';

/**
 * worker → 该账号身份对应的凭据文件（相对 HOME）。
 * 只收 OAuth 身份文件，不收会话/缓存；切换即换身份。
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
  // github-copilot：令牌在 gnome-keyring，文件切换不换身份，故不纳入
};

const exists = async (p) => { try { await stat(p); return true; } catch { return false; } };

function profileDir(worker, name) {
  return join(ROOT, worker, name);
}

async function fingerprint(relPaths) {
  const hash = createHash('sha256');
  for (const rel of relPaths) {
    try { hash.update(await readFile(join(HOME, rel), 'utf-8')); } catch { hash.update('<missing>'); }
  }
  return hash.digest('hex').slice(0, 12);
}

/** 列出所有 worker 的账号档案与当前生效状态 */
export async function listAccounts() {
  const workers = {};
  for (const [worker, relFiles] of Object.entries(WORKER_CRED_FILES)) {
    const liveFp = await fingerprint(relFiles);
    /** @type {Array<{name:string, savedAt:string|null, note:string|null, active:boolean}>} */
    const profiles = [];
    const dir = join(ROOT, worker);
    let names = [];
    try { names = (await readdir(dir)).filter((n) => !n.startsWith('.')); } catch { names = []; }
    for (const name of names.sort()) {
      let meta = null;
      try { meta = JSON.parse(await readFile(join(dir, name, 'meta.json'), 'utf-8')); } catch { meta = null; }
      let active = false;
      for (const rel of relFiles) {
        const base = rel.split('/').pop();
        try {
          const liveTxt = await readFile(join(HOME, rel), 'utf-8');
          const profTxt = await readFile(join(dir, name, base), 'utf-8');
          if (liveTxt === profTxt) { active = true; break; }
        } catch { /* 任一侧缺失则不算 active */ }
      }
      profiles.push({ name, savedAt: meta?.savedAt || null, note: meta?.note || null, active });
    }
    workers[worker] = {
      credFiles: relFiles,
      livePresent: await exists(join(HOME, relFiles[0])),
      liveFingerprint: liveFp,
      profiles,
    };
  }
  return { root: ROOT, workers };
}

/** 把当前生效凭据存为一个档案 */
async function _saveAccount(worker, name) {
  const relFiles = WORKER_CRED_FILES[worker];
  if (!relFiles) return { ok: false, error: `不支持的 worker: ${worker}` };
  for (const rel of relFiles) {
    if (!(await exists(join(HOME, rel)))) return { ok: false, error: `凭据文件不存在: ~/${rel}` };
  }
  const dest = profileDir(worker, name);
  await mkdir(dest, { recursive: true });
  for (const rel of relFiles) {
    const base = rel.split('/').pop();
    await copyFile(join(HOME, rel), join(dest, base));
  }
  await writeFile(join(dest, 'meta.json'), JSON.stringify({ savedAt: new Date().toISOString(), files: relFiles }, null, 2), 'utf-8');
  return { ok: true, worker, name, savedAt: new Date().toISOString() };
}

/** 凭据文件位于 HOME 下的 worker（可沙箱添加账号）；copilot 在 keyring、codebuddy 走 /login，不在此列 */
const SANDBOX_CRED_FILES = {
  'minimaxcode': ['.mmx/config.json'],
};

/** 沙箱添加账号：把沙箱 HOME 里新生成的凭据快照成档案并立即切换 */
async function _addFromSandbox(worker, name, loginId) {
  const rels = SANDBOX_CRED_FILES[worker];
  if (!rels) return { ok: false, error: `该 worker 暂不支持沙箱添加账号` };
  const sandbox = getSandbox(loginId);
  if (!sandbox) return { ok: false, error: '登录会话不存在或已过期' };
  const dest = profileDir(worker, name);
  await mkdir(dest, { recursive: true });
  for (const rel of rels) {
    const base = rel.split('/').pop();
    const srcFile = join(sandbox, rel);
    try {
      await readFile(srcFile, 'utf-8');
    } catch {
      return { ok: false, error: `沙箱内未生成凭据（可能尚未完成授权）: ${rel}` };
    }
    await copyFile(srcFile, join(dest, base));
  }
  await writeFile(join(dest, 'meta.json'), JSON.stringify({ savedAt: new Date().toISOString(), via: 'sandbox-add' }, null, 2), 'utf-8');
  const sw = await _switchAccount(worker, name);
  return { ok: true, worker, name, switched: sw.ok === true, note: '新账号已快照为档案并切换生效' };
}

/** 切换到指定档案：先把当前凭据备份到 .backup-<ts>，再复制档案文件到生效位 */
async function _switchAccount(worker, name) {
  const relFiles = WORKER_CRED_FILES[worker];
  if (!relFiles) return { ok: false, error: `不支持的 worker: ${worker}` };
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
  await writeFile(join(backupDir, 'meta.json'), JSON.stringify({ note: `切换到 ${name} 前的自动备份`, at: new Date().toISOString() }, null, 2), 'utf-8');
  clearQuotaCache(worker);
  return { ok: true, worker, switchedTo: name, backup: backupDir, note: '凭据已换入，配额缓存已清空；如该 CLI 有长连接进程请重启后生效。' };
}

// ---- 并发加固：以下导出为串行互斥包装（内部实现为 _<name>） ----
export function saveAccount(worker, name) { return withLock(ACCOUNTS_WRITE_LOCK, () => _saveAccount(worker, name)); }
export function switchAccount(worker, name) { return withLock(ACCOUNTS_WRITE_LOCK, () => _switchAccount(worker, name)); }
export function addFromSandbox(worker, name, loginId) { return withLock(ACCOUNTS_WRITE_LOCK, () => _addFromSandbox(worker, name, loginId)); }
