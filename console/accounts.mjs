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
import { clearQuotaCache, decryptZcodeCred, hwsSdkSignedHeaders } from './vendor-quota.mjs';
import { getSandbox } from './auth.mjs';
import { readQoderCredential } from './qoder.mjs';

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
 * 全部 12 个 worker 均支持档案保存、自动归档、切换与沙箱添加账号。
 */
export const WORKER_CRED_FILES = {
  'codebuddy': ['.codebuddy/auth.info'],
  'codebuddy-cn': ['.codebuddy-cn/auth.info'],
  // mcode（MiniMax Code 官方 CLI）把 OAuth 凭据放在 ~/.minimax/auth/<env>/<region>/mcode-public/：
  //   auth.json        → { records: { "com.minimax.mcode.oauth.prod.cn <hash>": { accessToken, refreshToken, expiresAtMs } } }
  //   auth-state.json  → { status: "authenticated", region: "cn", expiresAtMs }
  // 登录命令固定 --region cn，所以只登记 cn 这一套（copyFile 要求列出的文件都存在）。
  'minimaxcode': ['.minimax/auth/prod/cn/mcode-public/auth-state.json', '.minimax/auth/prod/cn/mcode-public/auth.json'],
  'antigravity': ['.gemini/antigravity-cli/antigravity-oauth-token'],
  'traecode': ['.trae-cn/trae-jwt-token'],
  'zcode': ['.zcode/v2/credentials.json'],
  'codearts': ['.config/agenthub-codearts/codearts-auth.env'],
  // meoo 是 HTTP 后端的 CLI 外壳（scripts/meoo_agent_cli.mjs），单 AK 鉴权，无 OAuth 用户信息
  'meoo': ['.config/agenthub-meoo/meoo-auth.env'],
  'mimocode': ['.local/share/mimocode/auth.json'],
  'github-copilot': ['.config/github-copilot/copilot-token'],
  'opencode': ['.local/share/opencode/auth.json'],
  'cline': ['.cline/data/secrets.json', '.cline/data/settings/providers.json'],
  'qoder': ['.qoder/.auth/user', '.qoder/.auth/machine_id'],
  'qoder-cn': ['.qoder-cn/.auth/user', '.qoder-cn/.auth/machine_id'],
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

/**
 * 把 srcHome 下的凭据文件复制进档案目录；缺失的文件跳过（cline 的 secrets.json /
 * providers.json 由官方 CLI 按需写入，可能只有其一）。返回实际复制数量。
 */
async function copyCredFiles(srcHome, relFiles, destDir) {
  let copied = 0;
  for (const rel of relFiles) {
    const base = rel.split('/').pop();
    const src = join(srcHome, rel);
    if (!(await exists(src))) continue;
    await copyFile(src, join(destDir, base));
    copied += 1;
  }
  return copied;
}

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
 * provider 集合型身份（opencode 的 auth.json）→ 人类可读的显示名。
 * 规则：1 个提供方就写它自己的名字；2~3 个并列写出来；更多则写「主提供方 等 N 个」。
 * 之前这里固定拼「(N 个提供方)」，单提供方也会带上后缀，且旧档案把字符串写死在 meta.json 里，
 * 于是升级后列表仍显示「opencode (1 个提供方)」这种自相矛盾的文案。
 * @param {string[]} providers
 * @returns {string}
 */
export function formatProvidersDisplay(providers) {
  const list = (Array.isArray(providers) ? providers : []).map((p) => cleanProfileLabel(p)).filter(Boolean);
  if (!list.length) return 'provider';
  // OpenCode Zen 登录后会多一条 opencode，展示时以它为主，而不是永远显示第一条 siliconflow
  const lead = list.includes('opencode') ? 'opencode' : list[0];
  const rest = list.filter((p) => p !== lead);
  if (!rest.length) return lead;
  // 多个 provider 时补一句「几把 Key」：auth.json 一个 provider 存一把，
  // 用户加了两个 Key 却只看到一个名字时会以为丢了一个
  const suffix = `（${list.length} 把 Key）`;
  if (rest.length <= 2) return [lead, ...rest].join(' + ') + suffix;
  return `${lead} 等 ${list.length} 个 provider${suffix}`;
}

/**
 * 身份方案是否「可变异」：这类身份描述的是**当前这一份凭据文件**的属性，
 * 而不是某个独立账号，所以一旦与线上不一致，只说明它是旧快照，不可能是「另一个账号」。
 * 邮箱 / UID / AK 这类稳定身份不在此列——它们不一致代表真的是不同账号，必须保留。
 * @param {string} identity
 */
export function isMutableIdentity(identity) {
  const s = String(identity || '');
  if (!s) return false;
  if (s.startsWith('providers:') || s.startsWith('mcode:') || s.startsWith('mmx:') || s.startsWith('qoder-token:')) return true;
  return /^[0-9a-f]{12}$/.test(s); // 纯文件指纹
}

/**
 * codearts 账号真实身份：AK/SK 签名调 STS v5/caller-identity，从 principal_urn
 * （iam::<account_id>:user:<用户名>）解出用户名与账号 ID。
 * 结果按 AK 哈希落盘缓存（成功永久、失败 6 小时内不重试），listAccounts 高频轮询不会反复打 STS。
 * @returns {Promise<{user:string, accountId:string}|null>}
 */
const CODEARTS_STS_URL = 'https://sts.cn-north-4.myhuaweicloud.com/v5/caller-identity';
const CODEARTS_IDENTITY_ERR_TTL_MS = 6 * 3600_000;
const _codeartsIdentityInFlight = new Map();
async function resolveCodeArtsIdentity(ak, sk, baseHome = HOME) {
  const key = createHash('sha256').update(ak).digest('hex').slice(0, 16);
  const cachePath = join(baseHome, '.agenthub', 'accounts', 'codearts', '.identity-cache.json');
  const readCache = async () => {
    try { return JSON.parse((await readFile(cachePath, 'utf-8')).replace(/^\uFEFF/, '')); } catch { return {}; }
  };
  const writeCache = async (cache) => {
    try {
      await mkdir(dirname(cachePath), { recursive: true });
      await writeFile(cachePath, JSON.stringify(cache, null, 2), 'utf-8');
    } catch { /* 缓存写失败不影响主流程 */ }
  };
  const cached = (await readCache())[key];
  if (cached?.user) return { user: cached.user, accountId: String(cached.accountId || '') };
  if (cached?.errAt && Date.now() - cached.errAt < CODEARTS_IDENTITY_ERR_TTL_MS) return null;
  // 单飞：并发探测同一把 AK 时只发一次请求
  const pending = _codeartsIdentityInFlight.get(key);
  if (pending) return pending;
  const task = (async () => {
    try {
      const res = await fetch(CODEARTS_STS_URL, {
        headers: hwsSdkSignedHeaders(ak, sk, 'GET', CODEARTS_STS_URL),
        signal: AbortSignal.timeout(8000),
      });
      const json = await res.json().catch(() => null);
      const urn = String(json?.principal_urn || '');
      const m = urn.match(/:(?:user|agency):([^:]+)$/);
      const user = m ? cleanProfileLabel(decodeURIComponent(m[1])) : '';
      const cache = await readCache();
      if (user) {
        cache[key] = { user, accountId: String(json?.account_id || '') };
        await writeCache(cache);
        return { user, accountId: String(json?.account_id || '') };
      }
      cache[key] = { errAt: Date.now() };
      await writeCache(cache);
      return null;
    } catch {
      const cache = await readCache();
      cache[key] = { errAt: Date.now() };
      await writeCache(cache);
      return null;
    }
  })().finally(() => { _codeartsIdentityInFlight.delete(key); });
  _codeartsIdentityInFlight.set(key, task);
  return task;
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
      // auth-state.json 在前（带 region），auth.json 兜底；两者都没有时按未登录处理
      let raw = null;
      for (const rel of relFiles) {
        try {
          raw = JSON.parse((await readFile(join(baseHome, rel), 'utf-8')).replace(/^\uFEFF/, ''));
          break;
        } catch { /* 试下一个候选 */ }
      }
      if (!raw) throw new Error('MiniMax 凭据不可用');
      const reg = cleanProfileLabel(raw?.region || raw?.oauth?.region || 'cn') || 'cn';
      // mcode 的 codex-auth.json 按 provider 分槽；老 mmx 的 config.json 会把账号写回 account 字段
      const acctRaw = raw?.account ?? raw?.oauth?.account ?? raw?.user ?? null;
      const acctStr = typeof acctRaw === 'string' ? acctRaw : (acctRaw?.email || acctRaw?.name || acctRaw?.username || acctRaw?.user_name || acctRaw?.nick || '');
      const uname = cleanProfileLabel(acctStr || raw?.email || raw?.user?.email || raw?.user?.name || '');
      // mcode 一个 region 同样只有一个槽位（dataDir 下的 codex-auth.json），身份用 mcode:<region>：
      // 逐字节指纹会随 token 刷新变化，用它当身份会让一个号在列表里反复裂档。
      const label = uname || `mcode-${reg}`;
      // 回退时给个人能读懂的名字；不要拿指纹当展示名，否则前端脱敏后变成 mm***eb，等于没名字
      const regionText = reg === 'cn' ? '中国区' : String(reg).toUpperCase();
      return { label, identity: uname ? `mcode:${reg}:${uname}` : `mcode:${reg}`, display: acctStr || raw?.email || raw?.user?.email || `MiniMax · ${regionText}` };
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
      const ak = (txt.match(/^CODEARTS_CLI_AK=(.+)$/m) || [])[1]?.trim() || '';
      const sk = (txt.match(/^CODEARTS_CLI_SK=(.+)$/m) || [])[1]?.trim() || '';
      const shortAk = cleanProfileLabel(ak.slice(0, 8)) || shortFp;
      const akLabel = `ak-${shortAk}`;
      // 优先用 STS caller-identity 解出的真实用户名：AK/SK 轮换后名字稳定、不再裂新档案，
      // 也不会出现「新旧 AK 前缀相同、掩码后肉眼分不出」的假象。解析失败回退 AK 命名。
      const who = ak && sk ? await resolveCodeArtsIdentity(ak, sk, baseHome) : null;
      if (who?.user) {
        return {
          label: cleanProfileLabel(who.user) || akLabel,
          identity: who.accountId ? `codearts:${who.accountId}:${who.user}` : `codearts-user:${who.user}`,
          display: who.user,
        };
      }
      const display = ak.length > 8 ? `AK:${ak.slice(0, 4)}…${ak.slice(-4)}` : akLabel;
      return { label: akLabel, identity: ak || fp, display };
    }
    if (worker === 'meoo') {
      const txt = await readFile(join(baseHome, relFiles[0]), 'utf-8');
      const ak = (txt.match(/^\s*MEOO_AK\s*=\s*(\S+)/m) || [])[1]?.trim() || '';
      const shortAk = cleanProfileLabel(ak.slice(0, 8)) || shortFp;
      const label = `meo-${shortAk}`;
      const display = ak.length > 8 ? `Meoo AK:${ak.slice(0, 4)}…${ak.slice(-4)}` : label;
      return { label, identity: ak || fp, display };
    }
    if (worker === 'opencode') {
      const raw = JSON.parse((await readFile(join(baseHome, relFiles[0]), 'utf-8')).replace(/^\uFEFF/, ''));
      const providers = Object.keys(raw || {}).filter((k) => raw[k] && (raw[k].key || raw[k].access || raw[k].token));
      const sorted = providers.slice().sort();
      // 登录 OpenCode Zen 后 auth.json 里会多一条 opencode，展示名要以它为主，而不是永远显示第一条 siliconflow
      const label = `${cleanProfileLabel(providers.includes('opencode') ? 'opencode' : (providers[0] || 'opencode'))}-${shortFp}`;
      // 身份用 provider 集合而非文件指纹：重新写入同一把 Key 不应多出一个账号
      const display = formatProvidersDisplay(sorted);
      return { label, identity: `providers:${sorted.join('+')}`, display };
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
      // 身份用「邮箱 / provider + 模型」而不是文件指纹：cline 每次 auth 都会重写 token，
      // 用指纹会导致每次登录都新建一个账号。
      const identity = email ? `email:${email}` : `provider:${provider}`;
      return { label, identity, display: email || `${provider} (${shortFp})` };
    }
    if (worker === 'qoder' || worker === 'qoder-cn') {
      const cred = await readQoderCredential(baseHome, worker);
      if (!cred.ok || !cred.primary) throw new Error(cred.error || cred.reason || 'Qoder 凭据不可用');
      const primary = cred.primary;
      const label = cleanProfileLabel(primary.display || primary.identity) || `${worker === 'qoder-cn' ? 'qdcn' : 'qd'}-${shortFp}`;
      return { label, identity: primary.identity, display: primary.display || label };
    }
  } catch { /* fallback below */ }
  const fallbackLabel = `${cleanProfileLabel(worker).slice(0, 8)}-${shortFp}`;
  return { label: fallbackLabel, identity: fp, display: fallbackLabel };
}

/**
 * 读 mcode 的登录态文件 `~/.minimax/auth/<env>/<region>/mcode-public/auth-state.json`。
 * 目录带 region 一层，所以按 `auth/*` 扫（目前登录命令固定 region=cn）。
 * 返回 { status, region, expiresAtMs, rel } 或 null。
 */
export async function readMinimaxAuthState(baseHome = HOME) {
  const root = join(baseHome, '.minimax', 'auth');
  let envs = [];
  try { envs = await readdir(root, { withFileTypes: true }); } catch { return null; }
  for (const env of envs) {
    if (!env.isDirectory()) continue;
    let regions = [];
    try { regions = await readdir(join(root, env.name), { withFileTypes: true }); } catch { continue; }
    for (const region of regions) {
      if (!region.isDirectory()) continue;
      const rel = join('.minimax', 'auth', env.name, region.name, 'mcode-public', 'auth-state.json');
      try {
        const raw = JSON.parse((await readFile(join(baseHome, rel), 'utf-8')).replace(/^\uFEFF/, ''));
        return {
          status: String(raw?.status || '').trim(),
          region: String(raw?.region || region.name || 'cn').trim(),
          expiresAtMs: Number(raw?.expiresAtMs) || 0,
          rel,
        };
      } catch { /* 换下一个 */ }
    }
  }
  return null;
}

/** 检查指定 HOME 下某 worker 是否存在有效凭据 */
async function isLiveCredValid(worker, relFiles, baseHome = HOME) {
  if (!relFiles || !relFiles.length) return false;
  // Qoder 的可读文件是「盐 + AES-GCM 密文」，必须解密成功且有 token 才算已登录
  if (worker === 'qoder' || worker === 'qoder-cn') {
    const cred = await readQoderCredential(baseHome, worker);
    return cred.ok === true && !!cred.primary;
  }
  // mcode 的登录态由 auth-state.json 的 status 明确表达（authenticated / signed-out），
  // 比「文件存在且非空」更准：登出后 auth.json 仍在，但 status 会翻转。
  if (worker === 'minimaxcode') {
    const state = await readMinimaxAuthState(baseHome);
    return !!state && state.status === 'authenticated';
  }
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
      // 走到这里说明档案里的凭据与线上逐字节一致，所以探测出来的 identity / display 就是它的真值。
      // 旧版本会把「mmx-cn-5cc0eb」这种目录名或「opencode (1 个提供方)」写死进 meta，只在字段缺失时补齐
      // 会永远留着脏值，因此这里按真值同步（note 是用户字段，不动）。
      if (meta.identity !== identity || meta.display !== display) {
        meta.identity = identity;
        meta.display = display;
        meta.savedAt = meta.savedAt || new Date().toISOString();
        await writeFile(metaPath, JSON.stringify(meta, null, 2), 'utf-8');
      }
    } catch { /* ignore */ }
    await writeFile(join(dir, '.active'), chosen, 'utf-8').catch(() => {});
    return { ok: true, worker, name: chosen, identity, display, autoAdded: false };
  }

  // 2. 检查是否同一账号身份 (identity) 刷新了 OAuth Token（若是且未强制指定别的名称，则原地更新该档案）
  let targetName = cleanPref || '';
  const liveFp = await fingerprint(relFiles);
  let activeName = '';
  try { activeName = (await readFile(join(dir, '.active'), 'utf-8')).trim(); } catch { activeName = ''; }
  const metas = [];
  for (const name of names) {
    let meta = null;
    try { meta = JSON.parse((await readFile(join(dir, name, 'meta.json'), 'utf-8')).replace(/^\uFEFF/, '')); } catch { meta = null; }
    metas.push({ name, meta });
  }
  // 当前生效的档案优先参与匹配，避免把所有候选都并到某个旧档案里
  metas.sort((a, b) => (b.name === activeName ? 1 : 0) - (a.name === activeName ? 1 : 0));

  if (!targetName && identity) {
    const exact = metas.find((m) => m.meta?.identity && m.meta.identity === identity);
    if (exact) targetName = exact.name;
  }
  // 2b. opencode 这类「provider 集合」身份：给同一账号新增一个 provider 会让集合从 {a} 变成 {a,b}，
  //     按「旧集合是新集合的子集」认定为同一账号，原地更新，而不是再裂出一个账号
  if (!targetName && String(identity).startsWith('providers:')) {
    const cur = new Set(String(identity).slice('providers:'.length).split('+').filter(Boolean));
    const superset = metas.find((m) => {
      const old = String(m.meta?.identity || '');
      if (!old.startsWith('providers:')) return false;
      const prev = old.slice('providers:'.length).split('+').filter(Boolean);
      return prev.length > 0 && prev.every((p) => cur.has(p));
    });
    if (superset) targetName = superset.name;
  }
  // 2c. 身份只能靠文件指纹的 worker（minimaxcode / copilot 等）token 刷新后指纹必变；
  //     若该 worker 只有一个「机器自动加的」档案，就原地更新它，避免一个号裂成两个。
  //     有真实身份（邮箱/UID/AK/provider 集合）的 worker 不走这条，避免把另一个账号覆盖掉。
  if (!targetName && identity && identity === liveFp) {
    const autoOnes = metas.filter((m) => m.meta?.autoAdded === true);
    if (autoOnes.length === 1) targetName = autoOnes[0].name;
  }
  // Qoder 在凭据不含用户信息时用 refreshToken 指纹当身份，刷新轮换后指纹会变；
  // 同样只在「只有一个自动档案」时原地更新，绝不覆盖用户保存的第二个账号。
  if (!targetName && String(identity).startsWith('qoder-token:')) {
    const autoOnes = metas.filter((m) => m.meta?.autoAdded === true);
    if (autoOnes.length === 1) targetName = autoOnes[0].name;
  }
  // 2d. 单槽位 worker（minimaxcode：一个 region 只有一份 codex-auth.json / config.json）身份从
  //     「文件指纹」升级成 mcode:<region>（历史上是 mmx:<region>）之后，旧档案的 identity 还是旧方案，
  //     按身份匹配必然落空。这里按「同 worker 下取 savedAt 最新的一份复用」兜底，让身份迁移不额外裂出新档案。
  if (!targetName && String(identity).startsWith('mcode:')) {
    const sameScheme = metas.filter((m) => {
      const id = String(m.meta?.identity || '');
      return id.startsWith('mcode:') || id.startsWith('mmx:') || /^[0-9a-f]{12}$/.test(id);
    });
    if (sameScheme.length) {
      sameScheme.sort((a, b) => String(b.meta?.savedAt || '').localeCompare(String(a.meta?.savedAt || '')));
      targetName = sameScheme[0].name;
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
  await copyCredFiles(HOME, relFiles, dest);
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
      let syncedIdentity = '';
      if (livePresent) {
        try {
          const sr = await _autoSyncLiveAccount(worker);
          if (sr?.ok && sr.name) { syncedActiveName = sr.name; syncedIdentity = String(sr.identity || ''); }
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
            let liveTxt = null;
            let profTxt = null;
            try { liveTxt = await readFile(join(HOME, rel), 'utf-8'); } catch { liveTxt = null; }
            try { profTxt = await readFile(join(dir, name, base), 'utf-8'); } catch { profTxt = null; }
            // cline 的两个凭据文件都是可选的：任一侧缺失时跳过该文件，不因此判定不匹配
            if (worker === 'cline' && (!liveTxt || !profTxt)) continue;
            if (liveTxt === null || profTxt === null || liveTxt !== profTxt || liveTxt.trim() === '__LOGGED_OUT__') {
              matchesLive = false;
              break;
            }
          }
        }
        // provider 集合 / 单槽位这类「可变异身份」的显示名在 meta.json 里可能早已固化过时
        // （例如升级前写死的「opencode (1 个提供方)」），这里按 identity 现算一遍，不再信任旧字符串
        let display = meta?.display || meta?.identity || name;
        const metaId = String(meta?.identity || '');
        if (metaId.startsWith('providers:')) {
          display = formatProvidersDisplay(metaId.slice('providers:'.length).split('+').filter(Boolean));
        }
        // 旧快照判定：身份方案本身可变（provider 集合 / mmx 槽位 / 文件指纹），且与线上当前身份不一致
        // —— 只可能是同一份凭据的历史快照，不是「另一个账号」，列表默认收起
        const stale = !matchesLive && !!livePresent && isMutableIdentity(metaId)
          && !!syncedIdentity && metaId !== syncedIdentity;
        rawProfiles.push({
          name,
          savedAt: meta?.savedAt || null,
          note: meta?.note || null,
          identity: meta?.identity || null,
          display,
          matchesLive,
          stale,
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
      // 当前生效账号置顶；历史快照沉底，避免「我只登录了一个号却看到两个」的错觉
      profiles.sort((a, b) => (b.active ? 1 : 0) - (a.active ? 1 : 0)
        || (a.stale ? 1 : 0) - (b.stale ? 1 : 0)
        || a.name.localeCompare(b.name));

      workers[worker] = {
        credFiles: relFiles,
        livePresent,
        liveFingerprint: liveFp,
        activeAccount: activeWinner || null,
        staleCount: profiles.filter((p) => p.stale).length,
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
  // cline 的 secrets.json / providers.json 由官方 CLI 按需写入，任一存在即可归档
  const anyCred = worker === 'cline';
  let presentCreds = 0;
  for (const rel of rels) {
    const srcFile = join(srcHome, rel);
    try {
      const content = (await readFile(srcFile, 'utf-8')).trim();
      if (!content || content === '__LOGGED_OUT__') throw new Error('empty');
      presentCreds += 1;
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
      if (anyCred) continue;
      return { ok: false, error: `尚未检测到新登录凭据（若授权后浏览器跳转到了 localhost 回调地址，请复制浏览器地址栏完整链接粘贴到上方输入框并点击「提交」）` };
    }
  }
  if (anyCred && presentCreds === 0) {
    return { ok: false, error: '尚未检测到新登录凭据：sandbox 里没有 ~/.cline/data 凭据文件，请重新执行登录' };
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
  await copyCredFiles(srcHome, rels, dest);
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
  let archived = 0;
  for (const rel of relFiles) {
    const base = rel.split('/').pop();
    if (await exists(join(src, base))) archived += 1;
  }
  if (!archived) return { ok: false, error: `档案缺少凭据文件: ${name}` };
  const backupDir = join(ROOT, worker, `.backup-${Date.now()}`);
  await mkdir(backupDir, { recursive: true });
  for (const rel of relFiles) {
    const base = rel.split('/').pop();
    const archivedFile = join(src, base);
    if (!(await exists(archivedFile))) continue;
    const liveAbs = join(HOME, rel);
    if (await exists(liveAbs)) await copyFile(liveAbs, join(backupDir, base));
    await mkdir(join(HOME, rel, '..'), { recursive: true });
    await copyFile(archivedFile, liveAbs);
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
