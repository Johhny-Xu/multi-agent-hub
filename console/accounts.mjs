// @ts-check
// Multi-Agent Hub 账号切换器（ccSwitch 理念的最小集成版）
// 仅做一件事：按 worker 管理各官方 CLI 的 OAuth 凭据文件快照，一键换入/存档。
// 快照库：~/.agenthub/accounts/<worker>/<profile>/<原文件名> + meta.json

import { readFile, writeFile, mkdir, readdir, copyFile, stat, chmod } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { clearQuotaCache } from './vendor-quota.mjs';

const HOME = homedir();
const ROOT = join(HOME, '.agenthub', 'accounts');

/**
 * worker → 该账号身份对应的凭据文件（相对 HOME）。
 * 只收 OAuth 身份文件，不收会话/缓存；切换即换身份。
 */
export const WORKER_CRED_FILES = {
  'codebuddy': ['.codebuddy/auth.info'],
  'codebuddy-cn': ['.codebuddy-cn/auth.info'],
  'minimaxcode': ['.mmx/config.json'],
  'antigravity': ['.gemini/antigravity-cli/antigravity-oauth-token'],
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
export async function saveAccount(worker, name) {
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

/** 切换到指定档案：先把当前凭据备份到 .backup-<ts>，再复制档案文件到生效位 */
export async function switchAccount(worker, name) {
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
