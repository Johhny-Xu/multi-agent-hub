// @ts-check
// Multi-Agent Hub 平台每日签到与福利中枢
// 支持 WorkBuddy、Trae (免客户端直签)、CodeArts (华为云码道) 自动化打卡与多账号福利领取
// 接口参考开源逆向成果与无客户端实现

import { readFile, writeFile, mkdir, readdir, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, dirname, resolve, basename } from 'node:path';
import { randomUUID, createHash, createHmac } from 'node:crypto';
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fetchJsonSmart, hwsSdkSignedHeaders as codeArtsSignedHeaders } from './vendor-quota.mjs';
import { findCodeBuddySharedAuth, isMutableIdentity } from './accounts.mjs';
import {
  readQoderCredential, readQoderCredentialAt, refreshQoderToken, persistQoderToken,
  listQoderCampaigns, claimQoderCampaign, isQoderTokenExpired, qoderRegion, altQoderBaseUrl,
} from './qoder.mjs';
import { resolveQoderDevice } from './qoder-device.mjs';
import { checkinTraeAccount, readTraeDesktopAuth, readTraeTokenCache, jwtUid } from './trae-checkin.mjs';
import { checkinMiniMax, fetchMiniMaxSignin, readMinimaxCredential, readMinimaxCredentialFile, minimaxCredentialVersion, MINIMAX_REGIONS } from './minimax-checkin.mjs';

// AGENTHUB_HOME 仅用于测试：把「已安装 CLI 的凭据目录」指到临时目录
const HOME = process.env.AGENTHUB_HOME ? resolve(process.env.AGENTHUB_HOME) : homedir();
// 允许用环境变量指向临时文件：单测不能碰线上真实的签到历史。
const STATE_FILE = process.env.AGENTHUB_CHECKIN_STATE
  ? resolve(process.env.AGENTHUB_CHECKIN_STATE)
  : join(HOME, '.agenthub', 'checkin-state.json');

/** 开源项目参考索引 */
export const OPEN_SOURCE_PROJECTS = {
  workbuddy: [
    {
      name: '88lin/workbuddy-auto-signin',
      url: 'https://github.com/88lin/workbuddy-auto-signin',
      description: '腾讯 WorkBuddy / CodeBuddy 自动签到脚本，纯 Python 标准库零依赖，自动探测本地凭据，覆盖每日加油站打卡、开盲盒、领任务、连登奖励与断登补签。',
      tags: ['Python', '零依赖', '加油站积分', '断登补签']
    },
    {
      name: 'yu-echo/workbuddy_checkin',
      url: 'https://github.com/yu-echo/workbuddy_checkin',
      description: '基于 GitHub Actions 的云端自动签到脚本，支持通过本地凭据提取 Refresh Token，支持微信 PushPlus 每日打卡推送。',
      tags: ['GitHub Actions', '云端定时', '微信推送']
    },
    {
      name: 'Coco-katarina/workbuddy-checkin',
      url: 'https://github.com/Coco-katarina/workbuddy-checkin',
      description: '本地自动化任务流与 AI Skill 触发，通过本地安全会话读取实现零上传打卡。',
      tags: ['Skill', '本地凭据', '安全隔离']
    }
  ],
  codebuddy: [
    {
      name: 'CodeBuddy 国际版打卡',
      url: 'https://www.codebuddy.ai',
      description: '腾讯 CodeBuddy 国际版，通过调用模型发送「你好」完成每日活跃打卡。',
      tags: ['CodeBuddy', '国际版', '模型调用', '每日打卡']
    },
    {
      name: '88lin/workbuddy-auto-signin',
      url: 'https://github.com/88lin/workbuddy-auto-signin',
      description: '腾讯 WorkBuddy / CodeBuddy 凭据探测与自动打卡参考。',
      tags: ['Python', '凭据管理', '多平台']
    }
  ],
  traecode: [
    {
      name: 'L0NE-6/Trae-AutoCheckin',
      url: 'https://github.com/L0NE-6/Trae-AutoCheckin',
      description: 'Trae 每日签到脚本（抗 9074 限流）。本项目的 Trae 签到链路移植自该项目：req_source 请求体、客户端真实注册设备号、状态→领取→同设备号回查确认，以及 refreshToken + ECDSA 设备证明续期。',
      tags: ['活动签到', '真实设备号', '设备证明续期', '多账号']
    },
    {
      name: 'star620/TraeTools',
      url: 'https://github.com/star620/TraeTools',
      description: '针对 Trae Work 的多功能助手工具，集成多账号每日签到、Vault 登录态冷切换备份、用量统计，支持一键部署到 GitHub Actions 实现无客户端云端定时签到。',
      tags: ['多账号', '免客户端', 'GitHub Actions', '用量统计']
    },
    {
      name: 'bluechonk/trae-daily-checkin',
      url: 'https://github.com/bluechonk/trae-daily-checkin',
      description: 'TraeWork CN 每日签到自动化工具，深度解析 api.trae.cn 接口，结合轻量调用完成免客户端自动化打卡。',
      tags: ['免客户端', 'API直签', '轻量化']
    },
    {
      name: 'bluechonk/trae-credential-reverse-engineering',
      url: 'https://github.com/bluechonk/trae-credential-reverse-engineering',
      description: 'Trae 桌面端本地凭据存储结构、Token 刷新与请求签名协议逆向工程文档。',
      tags: ['逆向文档', '协议分析', 'ECDSA']
    }
  ],
  codearts: [
    {
      name: '2951461586/CodeArts2API',
      url: 'https://github.com/2951461586/CodeArts2API',
      description: '华为云码道 (CodeArts Agent) 上游网关，内置每日自动签到与福利 Token 领取逻辑 (/api/v1/benefit/claim)，支持多账号去重与定时轮询。',
      tags: ['Go', 'CodeArts码道', '福利Token', '自动领取']
    },
    {
      name: 'codearts-daily-claim',
      url: 'https://gitcode.com/gh_mirrors/co/codearts-daily-claim',
      description: '基于华为云 CodeArts 及开发者成长中心接口的每日积分与福利自动领取脚本，支持 AK/SK 与凭据注入。',
      tags: ['Python', '成长中心', 'AK/SK签名', '开发者空间']
    },
    {
      name: 'HotWater23/develope',
      url: 'https://github.com/HotWater23/develope',
      description: '华为云开发者成长中心扩展与自动化方案，支持自动检测任务与完成签到。',
      tags: ['Node.js', '开发者空间', '任务打卡']
    }
  ],
  qoder: [
    {
      name: 'shuishuipingan/qoder2api-hub',
      url: 'https://github.com/shuishuipingan/qoder2api-hub',
      description: 'Qoder / Qoder CN 双区域账号池与 OpenAI 兼容网关，含设备授权、令牌刷新、每日活动签到与额度查询的完整逆向实现。',
      tags: ['Python', '双区域', '活动签到', '令牌刷新']
    },
    {
      name: 'L0NE-6/Qoder-Daily',
      url: 'https://github.com/L0NE-6/Qoder-Daily',
      description: 'Qoder 每日签到脚本（中国版 / 国际版），本项目的签到链路移植自该项目：forceRefresh 实时活动、CLAIM_BENEFIT 定向活动筛选、本机 UMID 组件生成的设备风控头与 token 续期。',
      tags: ['活动签到', 'UMID 设备风控', '多账号', 'GitHub Actions']
    },
    {
      name: 'wallechfox/qoder-checkin',
      url: 'https://github.com/wallechfox/qoder-checkin',
      description: '从 Qoder 本地凭据提取登录态并完成每日领取的轻量脚本。',
      tags: ['本地凭据', '每日领取', '轻量']
    },
    {
      name: 'techysy/CreditDaddy',
      url: 'https://github.com/techysy/CreditDaddy',
      description: 'Qoder 活动与 Credits 领取工具，覆盖多类 campaign 与幂等重放处理。',
      tags: ['Campaign', 'Credits', '幂等']
    },
    {
      name: '70548887/Qoder-Switch',
      url: 'https://github.com/70548887/Qoder-Switch',
      description: 'Qoder 多账号切换工具，按配置目录备份/还原登录态，可作为账号快切流程的参考实现。',
      tags: ['多账号', '快速切换', '配置备份']
    }
  ],
  minimaxcode: [
    {
      name: '@user_3a370331/totorosir-minimax-checkin',
      url: 'https://skillhub.cn/skills/user_3a370331/totorosir-minimax-checkin',
      description: 'MiniMax Code（海螺 AI）每日签到领积分，作者龙猫科技说（longmaoit）。本项目的签到链路移植自该技能：直接复用 mcode CLI 的 OAuth 登录态，按桌面端同款参数与签名调用 signin/status → signin/claim，401 时用 refresh_token 自动续期。',
      tags: ['接口直签', 'OAuth 自动续期', '桌面端签名', '纯标准库']
    }
  ]
};

/** @returns {Promise<object>} */
async function loadState() {
  try {
    const raw = await readFile(STATE_FILE, 'utf-8');
    return JSON.parse(raw.replace(/^\uFEFF/, ''));
  } catch {
    return {
      autoCheckin: true,
      autoCheckinTime: '08:30',
      customTokens: {
        workbuddy: '',
        traecode: '',
        codearts: '',
        qoder: '',
        'qoder-cn': '',
        minimaxcode: '',
        meoo: ''
      },
      platforms: {
        workbuddy: { lastDate: '', lastTime: '', status: 'idle', message: '尚未执行签到', credits: '', consecutiveDays: 0 },
        traecode: { lastDate: '', lastTime: '', status: 'idle', message: '尚未执行签到', credits: '', consecutiveDays: 0 },
        codearts: { lastDate: '', lastTime: '', status: 'idle', message: '尚未执行签到', credits: '', consecutiveDays: 0 },
        qoder: { lastDate: '', lastTime: '', status: 'idle', message: '尚未执行签到', credits: '', consecutiveDays: 0 },
        'qoder-cn': { lastDate: '', lastTime: '', status: 'idle', message: '尚未执行签到', credits: '', consecutiveDays: 0 },
        minimaxcode: { lastDate: '', lastTime: '', status: 'idle', message: '尚未执行签到', credits: '', consecutiveDays: 0 },
        meoo: { lastDate: '', lastTime: '', status: 'idle', message: '尚未执行签到', credits: '', consecutiveDays: 0 }
      },
      history: []
    };
  }
}

/** @param {object} state */
async function saveState(state) {
  try {
    await mkdir(dirname(STATE_FILE), { recursive: true });
    await writeFile(STATE_FILE, JSON.stringify(state, null, 2) + '\n', 'utf-8');
  } catch (err) {
    console.error('[Checkin] 保存签到状态失败:', err.message);
  }
}

function getTodayStr() {
  const now = new Date();
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function getNowTimeStr() {
  const now = new Date();
  return now.toTimeString().slice(0, 8);
}

/**
 * 探测各平台可用凭据。
 *
 * 原则：**已安装 CLI 的凭据优先**——签到直接用 CLI 正在用的那一份，
 * 不另存副本，所以 CLI 刷新后签到自动跟着新，不会拿着一份过期快照反复失败。
 * 手工「配置 Token」只在 CLI 完全找不到凭据时兜底。
 */
export async function detectCredentials() {
  const creds = {
    workbuddy: { available: false, source: '', token: '' },
    codebuddy: { available: false, source: '', token: '' },
    traecode: { available: false, source: '', token: '' },
    codearts: { available: false, source: '', ak: '', sk: '', token: '' },
    qoder: { available: false, source: '', token: '' },
    'qoder-cn': { available: false, source: '', token: '' },
    minimaxcode: { available: false, source: '', token: '' },
    // meoo 以前没占位：控制台配了 customTokens.meoo 时下面那个循环会读到 undefined 直接抛错
    meoo: { available: false, source: '', ak: '', token: '' }
  };

  const platforms = ['workbuddy', 'codebuddy', 'traecode', 'codearts', 'qoder', 'qoder-cn', 'minimaxcode', 'meoo'];
  const live = {
    workbuddy: await readCredFrom('workbuddy', HOME, false),
    codebuddy: await readCredFrom('codebuddy', HOME, false),
    traecode: await readCredFrom('traecode', HOME, false),
    codearts: await readCredFrom('codearts', HOME, false),
    qoder: await readCredFrom('qoder', HOME, false),
    'qoder-cn': await readCredFrom('qoder-cn', HOME, false),
    minimaxcode: (await listCheckinAccounts('minimaxcode')).find((a) => a.active),
    meoo: await readMeooAk(),
  };

  for (const plat of platforms) {
    const hit = live[plat];
    if (!hit) continue;
    creds[plat] = {
      available: true,
      source: `${hit.source}（CLI 实时凭据）`,
      token: hit.token || '',
      ak: hit.ak || '',
      sk: hit.sk || '',
      exp: hit.exp || 0,
      identity: hit.identity || '',
      refreshable: !!hit.refreshToken,
    };
  }

  // Trae 客户端装在本机时，storage.json 里的 refreshToken 也算可用凭据：
  // 即使 CLI 的 JWT 被注销，也能用设备证明续期换新，不必再走客户端 UI。
  if (!creds.traecode.available) {
    let desktop = null;
    try {
      desktop = await readTraeDesktopAuth(HOME);
    } catch {
      desktop = null;
    }
    if (desktop?.refreshToken || desktop?.accessToken) {
      creds.traecode = {
        available: true,
        source: 'Trae 客户端 storage.json（可自动续期）',
        token: desktop.accessToken || '',
        refreshToken: desktop.refreshToken || '',
      };
    }
  }

  // 兜底：CLI 找不到任何凭据时，才用手工配置的 Token
  const state = await loadState();
  for (const plat of platforms) {
    const raw = String(state.customTokens?.[plat] || '').trim();
    if (!raw || creds[plat].available) continue;
    if (plat === 'codearts') {
      const m = raw.match(/^([A-Z0-9]{8,})[,:;\s]+([A-Za-z0-9+/=]{8,})$/);
      creds.codearts = m
        ? { available: true, source: '自定义 AK/SK（CLI 未检测到）', ak: m[1], sk: m[2] }
        : { available: true, source: '自定义凭据（CLI 未检测到）', token: raw };
    } else {
      creds[plat] = { available: true, source: '自定义 Token（CLI 未检测到）', token: raw };
    }
  }

  return creds;
}

// ---------------------------------------------------------------- 多账号档案扫描
// 签到必须覆盖「所有已保存的账号」，不能只看当前生效的那一个：
// 每个档案目录里就是该账号当时的凭据快照（auth.info / trae-jwt-token / codearts-auth.env）。

/**
 * 平台 → 参与签到的 worker 列表（WorkBuddy 的签到接口只在 www.codebuddy.cn，故仅取 codebuddy-cn）
 *
 * 约定（2026-10-28 起）：**worker 侧保存的账号就是签到账号的来源**。
 * 在控制台给某个 worker 加了账号，签到区必须自动多出一行，不再各自维护一份名单。
 * 因此这里每加一个平台，就必须同时给 readCredCandidates 加一个对应分支，否则档案扫得出来也读不出凭据。
 */
const PLATFORM_WORKERS = {
  workbuddy: ['codebuddy-cn'],
  codebuddy: ['codebuddy'],
  traecode: ['traecode'],
  codearts: ['codearts'],
  qoder: ['qoder'],
  'qoder-cn': ['qoder-cn'],
  minimaxcode: ['minimaxcode'],
  meoo: ['meoo'],
};

// 各 worker 档案目录里的凭据文件名由 readCredCandidates 的分支决定（拍平存放：auth.info /
// trae-jwt-token / codearts-auth.env / user / auth.json / meoo-auth.env），这里不再另维护一张表——
// 之前那张 PROFILE_CRED_FILE 从没被读过，加了 meoo 反而让人以为改了它就会生效。

/** 解出 JWT 的 payload（失败返回 null，绝不抛错） */
function jwtPayload(tok) {
  try {
    const part = String(tok).split('.')[1];
    if (!part) return null;
    return JSON.parse(Buffer.from(part.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf-8'));
  } catch {
    return null;
  }
}

const maskAk = (ak) => (ak && ak.length > 8 ? `${ak.slice(0, 4)}…${ak.slice(-4)}` : String(ak || ''));

/** 文件 mtime（毫秒），读不到算 0 */
async function fileMtime(file) {
  try { return (await stat(file)).mtimeMs; } catch { return 0; }
}

/**
 * 一个目录下某平台的全部凭据候选。
 *
 * 「已安装 CLI 的凭据」可能同时存在于多处：CLI 自己的 auth.info、桌面版共享会话、
 * 账号档案里的历史快照。它们的新旧并不一致，所以这里**全部读出来**交给调用方择优——
 * 旧实现遇到第一个就 return，很容易拿到过期快照去签到。
 */
async function readCredCandidates(platform, dir, flat = false) {
  const out = [];

  const addJson = async (rel, source, { writable = true, kind = 'cli' } = {}) => {
    const file = join(dir, rel);
    try {
      const d = JSON.parse((await readFile(file, 'utf-8')).replace(/^\uFEFF/, ''));
      const auth = d?.auth || {};
      const tok = String(auth.accessToken || '').trim();
      if (!tok || tok.startsWith('http')) return;
      const pl = jwtPayload(tok) || {};
      out.push({
        token: tok,
        refreshToken: String(auth.refreshToken || '').trim(),
        identity: pl.sub || '',
        display: pl.nickname || pl.preferred_username || pl.email || '',
        exp: Number(pl.exp) || 0,
        domain: String(auth.domain || '').trim(),
        file: writable ? file : '',
        mtime: await fileMtime(file),
        source,
        kind: writable ? kind : 'shared',
      });
    } catch { /* 没有这份文件 */ }
  };

  if (platform === 'workbuddy') {
    if (flat) {
      await addJson('auth.info', '账号档案', { kind: 'profile' });
      return out;
    }
    // 只取国内站凭据：签到打的是 www.codebuddy.cn，国际版（~/.codebuddy）的 token 不适用。
    // 之前按「exp 最大」统一挑选会把国际版那份挑进来，签到时必然 401。
    await addJson('.codebuddy-cn/auth.info', '~/.codebuddy-cn/auth.info');
    // 桌面版共享会话：只读。写它会把桌面版顶成别的账号（accounts.mjs 有同样约定）。
    try {
      const shared = await findCodeBuddySharedAuth(dir);
      const tok = String(shared?.data?.auth?.accessToken || '').trim();
      if (tok && !tok.startsWith('http')) {
        const pl = jwtPayload(tok) || {};
        out.push({
          token: tok,
          refreshToken: String(shared?.data?.auth?.refreshToken || '').trim(),
          identity: pl.sub || '',
          display: pl.nickname || pl.preferred_username || '',
          exp: Number(pl.exp) || 0,
          file: '',
          mtime: await fileMtime(shared.file),
          source: 'WorkBuddy 共享会话（只读）',
          kind: 'shared',
        });
      }
    } catch { /* ignore */ }
    return out;
  }

  if (platform === 'codebuddy') {
    if (flat) {
      await addJson('auth.info', '账号档案', { kind: 'profile' });
      return out;
    }
    // CodeBuddy 国际版取 ~/.codebuddy/auth.info
    await addJson('.codebuddy/auth.info', '~/.codebuddy/auth.info');
    try {
      const shared = await findCodeBuddySharedAuth(dir);
      const tok = String(shared?.data?.auth?.accessToken || '').trim();
      if (tok && !tok.startsWith('http')) {
        const pl = jwtPayload(tok) || {};
        out.push({
          token: tok,
          refreshToken: String(shared?.data?.auth?.refreshToken || '').trim(),
          identity: pl.sub || '',
          display: pl.nickname || pl.preferred_username || pl.email || '',
          exp: Number(pl.exp) || 0,
          domain: String(shared?.data?.auth?.domain || 'www.codebuddy.ai').trim(),
          file: '',
          mtime: await fileMtime(shared.file),
          source: 'CodeBuddy 共享会话（只读）',
          kind: 'shared',
        });
      }
    } catch { /* ignore */ }
    return out;
  }

  if (platform === 'traecode') {
    const rels = flat ? ['trae-jwt-token'] : ['.trae-cn/trae-jwt-token', '.trae/trae-jwt-token'];
    for (const rel of rels) {
      const file = join(dir, rel);
      try {
        const tok = (await readFile(file, 'utf-8')).trim();
        if (!tok || tok.split('.').length !== 3) continue;
        const pl = jwtPayload(tok) || {};
        const d = pl.data || {};
        out.push({
          token: tok,
          identity: String(d.id || d.user_id || ''),
          display: d.id ? `UID:${d.id}` : '',
          exp: Number(pl.exp) || 0,
          file,
          mtime: await fileMtime(file),
          source: flat ? '账号档案' : `~/${rel}`,
          kind: flat ? 'profile' : 'cli',
        });
      } catch { /* next */ }
    }
    return out;
  }

  if (platform === 'codearts') {
    const rels = flat ? ['codearts-auth.env'] : ['.config/agenthub-codearts/codearts-auth.env'];
    for (const rel of rels) {
      const file = join(dir, rel);
      try {
        const txt = await readFile(file, 'utf-8');
        const ak = (txt.match(/^CODEARTS_CLI_AK=(.+)$/m) || [])[1];
        const sk = (txt.match(/^CODEARTS_CLI_SK=(.+)$/m) || [])[1];
        if (ak && sk) {
          const akv = ak.trim();
          out.push({
            ak: akv, sk: sk.trim(), identity: akv, display: `AK:${maskAk(akv)}`,
            exp: 0, file, mtime: await fileMtime(file),
            source: flat ? '账号档案 · AK/SK' : `~/${rel}`, kind: flat ? 'profile' : 'cli',
          });
        }
      } catch { /* next */ }
    }
    if (!flat) {
      // CodeArts 客户端自己的配置文件（长期 AK/SK 的另一个来源）
      const file = join(dir, '.codeartsdoer', 'codearts_cli.json');
      try {
        const d = JSON.parse((await readFile(file, 'utf-8')).replace(/^\uFEFF/, ''));
        const ak = d.ak || d.accessKey || d.access_key;
        const sk = d.sk || d.secretKey || d.secret_key;
        if (ak && sk) {
          out.push({
            ak: String(ak).trim(), sk: String(sk).trim(), identity: String(ak).trim(),
            display: `AK:${maskAk(String(ak).trim())}`,
            exp: 0, file, mtime: await fileMtime(file),
            source: '~/.codeartsdoer/codearts_cli.json', kind: 'cli',
          });
        }
      } catch { /* 没有这份文件 */ }
    }
    return out;
  }

  if (platform === 'qoder' || platform === 'qoder-cn') {
    const worker = platform;
    const cred = flat ? await readQoderCredentialAt(dir, worker) : await readQoderCredential(dir, worker);
    if (cred.ok) {
      const mtime = await fileMtime(cred.file);
      for (const entry of cred.entries) {
        out.push({
          token: entry.token,
          refreshToken: entry.refreshToken,
          identity: entry.identity,
          display: entry.display,
          user: entry.user,
          exp: entry.expiresAt || 0,
          file: cred.file,
          saltFile: cred.saltFile,
          worker,
          mtime,
          source: entry.source || (flat ? '账号档案 · Qoder' : `~/${qoderRegion(worker).configDir}/.auth/user`),
          kind: flat ? 'profile' : 'cli',
        });
      }
    }
    return out;
  }

  if (platform === 'minimaxcode') {
    const regions = flat ? ['cn'] : ['cn', 'global'];
    const profileKey = flat ? basename(dir) : '';
    for (const region of regions) {
      const cred = flat
        ? await readMinimaxCredentialFile(join(dir, 'auth.json'), region)
        : await readMinimaxCredential(dir, region);
      if (!cred?.token) continue;
      const cfg = MINIMAX_REGIONS[cred.region];
      if (!cfg) continue;
      out.push({
        ...cred,
        identity: `mcode:${cfg.key}${profileKey ? `:${profileKey}` : ''}`,
        display: cfg.name,
        exp: Math.floor((Number(cred.expiresAtMs) || 0) / 1000),
        mtime: await fileMtime(cred.file),
        source: flat ? `账号档案 · MiniMax Code（${profileKey}）` : cred.source,
        kind: flat ? 'profile' : 'cli',
        credentialVersion: minimaxCredentialVersion(cred),
      });
    }
    return out;
  }

  if (platform === 'meoo') {
    // Meoo（秒悟）是 AK 鉴权，凭据文件就是一行 MEOO_AK=...，没有 JWT 也没有 refresh。
    // 账号档案把它拍平成 meoo-auth.env；身份直接用 AK 本身（与 codearts 的 AK 同一套做法）。
    const rel = flat ? 'meoo-auth.env' : join('.config', 'agenthub-meoo', 'meoo-auth.env');
    const file = join(dir, rel);
    try {
      const txt = await readFile(file, 'utf-8');
      const ak = (txt.match(/^\s*MEOO_AK\s*=\s*(\S+)/m) || [])[1];
      if (ak) {
        const akv = ak.trim();
        out.push({
          ak: akv, identity: `meoo:${akv}`, display: `Meoo · ${maskAk(akv)}`,
          exp: 0, file, mtime: await fileMtime(file),
          source: flat ? '账号档案 · MEOO_AK' : `~/${rel}`, kind: flat ? 'profile' : 'cli',
        });
      }
    } catch { /* 没有这份文件 */ }
    return out;
  }

  return out;
}

/**
 * 从一处目录挑「最可信」的一份凭据。
 * exp 大者优先（JWT 有效期最长）；exp 相同比文件 mtime；再相同按来源优先级（CLI > 共享会话 > 档案）。
 * AK/SK 没有 exp，于是自然按 mtime 取最新的那份。
 */
async function readCredFrom(platform, dir, flat = false) {
  const list = await readCredCandidates(platform, dir, flat);
  if (!list.length) return null;
  const rank = { cli: 2, shared: 1, profile: 0 };
  return list.slice().sort((a, b) =>
    (Number(b.exp) || 0) - (Number(a.exp) || 0)
    || (Number(b.mtime) || 0) - (Number(a.mtime) || 0)
    || (rank[b.kind] || 0) - (rank[a.kind] || 0)
  )[0];
}

/**
 * 汇总某平台的所有可签账号（档案 + 当前线上凭据），按身份去重。
 * @returns {Promise<Array<{name:string, display:string, worker:string, active:boolean, token?:string, ak?:string, sk?:string, exp?:number, source:string}>>}
 */
export async function listCheckinAccounts(platform) {
  const rank = { cli: 2, shared: 1, profile: 0 };
  const scoreOf = (x) => [Number(x.exp) || 0, Number(x.mtime) || 0, rank[x.kind] || 0];
  const betterOf = (a, b) => {
    if (!a) return b;
    const sa = scoreOf(a);
    const sb = scoreOf(b);
    for (let i = 0; i < sa.length; i++) if (sb[i] !== sa[i]) return sb[i] > sa[i] ? b : a;
    return a;
  };

  /** @type {Map<string, any>} 身份 → 最优凭据（同一账号只留一份，绝不重复签） */
  const byIdentity = new Map();
  /** @type {Map<string, any[]>} 身份 → 全部候选：首选 token 被服务端注销时还要有备胎 */
  const candidates = new Map();
  const remember = (acct) => {
    if (!acct.token) return;
    const list = candidates.get(acct.identity) || [];
    if (!list.some((c) => c.token === acct.token)) list.push(acct);
    candidates.set(acct.identity, list);
  };

  for (const worker of PLATFORM_WORKERS[platform] || []) {
    let names = [];
    try {
      names = (await readdir(join(HOME, '.agenthub', 'accounts', worker))).filter((n) => !n.startsWith('.'));
    } catch { names = []; }
    for (const name of names.sort()) {
      const dir = join(HOME, '.agenthub', 'accounts', worker, name);
      let meta = {};
      try { meta = JSON.parse((await readFile(join(dir, 'meta.json'), 'utf-8')).replace(/^\uFEFF/, '')); } catch { /* 无 meta 也能用 */ }
      const cred = await readCredFrom(platform, dir, true);
      if (!cred?.identity) continue;
      const acct = {
        name,
        display: cred.display || meta.display || meta.identity || name,
        worker,
        active: false,
        source: `账号档案 · ${name}`,
        ...cred,
        ...(platform === 'minimaxcode' ? { workerIdentity: meta.identity || '', display: meta.display || cred.display } : {}),
        kind: 'profile',
        credentialSource: '账号档案快照',
      };
      remember(acct);
      byIdentity.set(acct.identity, betterOf(byIdentity.get(acct.identity), acct));
    }
  }

  if (platform === 'minimaxcode') {
    let accounts = [...byIdentity.values()];
    let activeName = '';
    try { activeName = (await readFile(join(HOME, '.agenthub', 'accounts', 'minimaxcode', '.active'), 'utf-8')).trim(); } catch { /* 没有生效档案 */ }
    for (const live of await readCredCandidates(platform, HOME, false)) {
      const sameRegion = accounts.filter((a) => a.region === live.region);
      const matches = sameRegion.filter((a) => a.token === live.token);
      // OAuth 轮换会改变 token；worker 的 active 档案仍是同一个账号。
      const profile = matches.find((a) => a.name === activeName) || matches[0]
        || sameRegion.find((a) => a.name === activeName);
      const row = {
        ...live,
        name: profile?.name || `mcode-${live.region}`,
        identity: profile?.identity || live.identity,
        display: profile?.display || live.display,
        worker: 'minimaxcode',
        active: true,
        credentialSource: live.source,
        liveFile: live.file,
        profileCredential: profile ? { file: profile.file, recordKey: profile.recordKey, token: profile.token } : null,
      };
      accounts = accounts.filter((a) => {
        if (a === profile || matches.includes(a)) return false;
        const stale = a.region === live.region && profile?.workerIdentity
          && isMutableIdentity(a.workerIdentity) && !/^mcode:[^:]+:.+/.test(a.workerIdentity)
          && a.workerIdentity !== profile.workerIdentity;
        return !stale;
      });
      accounts.push(row);
    }
    if (accounts.length && !accounts.some((a) => a.active)) {
      (accounts.find((a) => a.name === activeName) || accounts[0]).active = true;
    }
    return accounts;
  }

  const live = await readCredFrom(platform, HOME, false);
  if (live?.identity) {
    remember({ ...live, kind: 'cli' });
    const prev = byIdentity.get(live.identity);
    if (prev) {
      // CLI 当前在用的那份优先——不能只看 exp：重新登录后旧 JWT 仍留在档案里，
      // 且有效期往往比新 token 更长（这次 Trae 重登就是 10-30 的旧 token 压过 10-26 的新 token）。
      const liveExpired = live.exp > 0 && live.exp * 1000 <= Date.now();
      const winner = liveExpired ? betterOf(prev, { ...live, kind: 'cli' }) : { ...live, kind: 'cli' };
      byIdentity.set(live.identity, {
        ...winner,
        // 账号名沿用档案里更可读的那个
        name: prev.name || winner.name,
        display: prev.display || winner.display,
        worker: prev.worker || winner.worker,
        active: true,
        credentialSource: winner.source,
        liveFile: live.file || '',
      });
    } else {
      byIdentity.set(live.identity, {
        name: '(当前登录)',
        display: live.display || '当前登录账号',
        worker: (PLATFORM_WORKERS[platform] || [''])[0],
        active: true,
        ...live,
        kind: 'cli',
        credentialSource: live.source,
        liveFile: live.file || '',
      });
    }
  }

  let accounts = [...byIdentity.values()];
  accounts = accounts.map((a) => {
    // 同身份的其它候选（不同 token）：首选被服务端注销时按顺序回退
    const alts = (candidates.get(a.identity) || [])
      .filter((c) => c.token && c.token !== a.token)
      .map((c) => ({ token: c.token, refreshToken: c.refreshToken, identity: c.identity, exp: c.exp, source: c.source, file: c.file, saltFile: c.saltFile, worker: c.worker }));
    return alts.length ? { ...a, alternates: alts } : a;
  });
  if (accounts.length && !accounts.some((a) => a.active)) accounts[0].active = true;
  return accounts;
}

// 华为云 SDK-HMAC-SHA256 签名实现已抽到 vendor-quota.mjs（hwsSdkSignedHeaders），账号档案模块共用。
// 两个必须复刻的坑也在那边注释里：CanonicalURI 尾斜杠、CanonicalHeaders 尾部 \n。

const CODEARTS_GATEWAY = 'https://opengw.developer.huaweicloud.com';
const CODEARTS_SNAP = 'https://snap-access.cn-north-4.myhuaweicloud.com';
/** 码道客户端的固定身份头，缺一个就会被网关按「非 IDE 客户端」拒掉 */
const CODEARTS_IDENTITY_HEADERS = {
  'content-type': 'application/json',
  'app-id': 'CodeAgent3.0',
  'x-ot-function': 'agent-general',
  'x-ot-client-type': 'IDE',
  'x-ot-client-version': '26.9.902',
  'plugin-name': 'codemate_vscode',
  'plugin-version': '26.9.902',
  'ide-name': 'VSCode',
  'ide-version': '26.9.902',
  'x-language': 'zh-cn',
  'agent-type': 'PromptCenter',
};

/**
 * 带签名调用码道网关。
 * @returns {Promise<{ status:number, json:any, text:string }>}
 */
async function codeArtsFetch(ak, sk, method, url, bodyObj = null) {
  const body = bodyObj ? JSON.stringify(bodyObj) : null;
  const headers = codeArtsSignedHeaders(ak, sk, method, url, body, CODEARTS_IDENTITY_HEADERS);
  const res = await fetch(url, { method, headers, body: body || undefined });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* 非 JSON（网关 404 HTML）*/ }
  return { status: res.status, json, text };
}

// ---------------------------------------------------------------- 凭据自动续期
// CodeBuddy / WorkBuddy 的 accessToken 有效期 30 天、refreshToken 60 天。
// CLI 启动时会自己刷新；签到如果拿着快过期/已过期的 token 直接打接口，
// 到期那天起就会天天失败。这里复刻 CLI 自己的刷新请求（同端点、同文件），
// 刷新后写回 **CLI 的 auth.info**——签到与 CLI 共用一份凭据，谁刷新都生效。

const CODEBUDDY_REFRESH_PATH = '/v2/plugin/auth/token/refresh';
const DEFAULT_CODEBUDDY_DOMAIN = 'www.workbuddy.cn';
/** 距过期不足 2 小时就提前续期，避免签到跑到一半过期 */
const TOKEN_REFRESH_MARGIN_MS = 2 * 3600 * 1000;

/**
 * 刷新一份 CodeBuddy auth.info 并写回原文件。
 * 注意：刷新会轮换 refreshToken，**必须写回**，否则 CLI 手里那份就废了。
 * @returns {Promise<{token:string, exp:number, refreshToken:string}|null>}
 */
async function refreshCodeBuddyAuth(file, refreshToken, domain = '') {
  if (!file || !refreshToken) return null;
  const host = domain || DEFAULT_CODEBUDDY_DOMAIN;
  try {
    const res = await fetchJsonSmart(`https://${host}${CODEBUDDY_REFRESH_PATH}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Refresh-Token': refreshToken,
        'X-Auth-Refresh-Source': 'plugin',
        'X-Domain': host,
      },
      body: '{}',
    }, 15_000);
    const data = res.json?.data;
    const token = String(data?.accessToken || '').trim();
    if (!token) return null;

    const doc = JSON.parse((await readFile(file, 'utf-8')).replace(/^\uFEFF/, ''));
    const now = Date.now();
    const nextAuth = { ...(doc.auth || {}), ...data, lastRefreshTime: now };
    if (data.expiresIn && !data.expiresAt) nextAuth.expiresAt = now + Number(data.expiresIn) * 1000;
    if (data.refreshExpiresIn && !data.refreshExpiresAt) nextAuth.refreshExpiresAt = now + Number(data.refreshExpiresIn) * 1000;
    doc.auth = nextAuth;
    await writeFile(file, JSON.stringify(doc, null, 2) + '\n', 'utf-8');

    const pl = jwtPayload(token) || {};
    return { token, exp: Number(pl.exp) || 0, refreshToken: String(data.refreshToken || refreshToken) };
  } catch (err) {
    console.warn('[Checkin] WorkBuddy 凭据自动续期失败:', err.message);
    return null;
  }
}

/**
 * 签到前确保凭据新鲜：快过期或已过期时用 refreshToken 续期。
 * 无法续期（没有 refreshToken / 共享会话只读）时保持原样，由签到结果给出提示。
 */
async function ensureFreshWorkBuddy(acct) {
  const expMs = (Number(acct.exp) || 0) * 1000;
  if (expMs && expMs - Date.now() > TOKEN_REFRESH_MARGIN_MS) {
    return { token: acct.token, exp: acct.exp, refreshed: false };
  }
  const renewed = await refreshCodeBuddyAuth(acct.file, acct.refreshToken, acct.domain);
  if (!renewed) return { token: acct.token, exp: acct.exp, refreshed: false };
  return { ...renewed, refreshed: true };
}

/**
 * 单个 WorkBuddy 账号打卡（www.codebuddy.cn 每日加油站）
 * 真实响应字段是 credit / streak_days，已签到时是 code=10001 + "今天已签到，请明天再来"。
 */
async function checkinWorkBuddyOne(token) {
  const res = await fetchJsonSmart('https://www.codebuddy.cn/v2/billing/meter/daily-checkin', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json',
      'X-Domain': 'codebuddy.cn',
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) WorkBuddy/1.0.0'
    },
    body: JSON.stringify({})
  }, 12_000);

  const json = res.json || {};
  const msg = String(json.msg || json.message || '');

  if (res.status === 200 && json.code === 0) {
    const credit = json.data?.credit ?? json.data?.points ?? json.data?.credits ?? 0;
    const streak = json.data?.streak_days ?? json.data?.consecutiveDays ?? 0;
    return {
      ok: true,
      status: 'success',
      message: `签到成功 +${credit} 积分${streak ? `（连签 ${streak} 天）` : ''}`,
      credits: credit,
      consecutiveDays: Number(streak) || 0
    };
  }

  // 10001 = 今天已签到
  if (json.code === 10001 || msg.includes('已签到') || msg.includes('already')) {
    return { ok: true, status: 'already', message: msg || '今日已签到', credits: 0, consecutiveDays: 0 };
  }

  if (res.status === 401 || json.code === 401) {
    return { ok: false, status: 'expired', message: '登录态已失效，请在客户端重新登录', credits: 0, consecutiveDays: 0 };
  }

  return {
    ok: false,
    status: 'failed',
    message: `签到接口返回 [${res.status}/${json.code ?? '-'}]：${msg || '未知错误'}`,
    credits: 0,
    consecutiveDays: 0
  };
}

/**
 * 读取「配置 Token」里手工粘贴的凭据，作为额外账号参与签到。
 * CodeArts 支持 `AK,SK` 或 `AK:SK` 的写法（旧面板只给了单行输入框）。
 */
async function customCredentialAccount(platform) {
  const state = await loadState();
  const raw = String(state.customTokens?.[platform] || '').trim();
  if (!raw) return null;
  if (platform === 'codearts') {
    const m = raw.match(/^([A-Z0-9]{8,})[,:;\s]+([A-Za-z0-9+/=]{8,})$/);
    if (!m) return { name: '自定义凭据', display: '自定义凭据', identity: 'custom', active: false, source: '自定义凭据（格式应为 AK,SK）', invalid: true };
    return { name: '自定义凭据', display: `AK:${maskAk(m[1])}`, identity: m[1], ak: m[1], sk: m[2], active: false, source: '自定义 AK/SK' };
  }
  // 手工粘贴的 Token 也解出真实身份：与 CLI 凭据是同一个账号时不再重复签一次
  const pl = jwtPayload(raw) || {};
  const identity = platform === 'traecode'
    ? String((pl.data || {}).id || (pl.data || {}).user_id || '')
    : String(pl.sub || '');
  return {
    name: '自定义 Token',
    display: pl.nickname || (identity && platform === 'traecode' ? `UID:${identity}` : '自定义 Token'),
    identity: identity || 'custom',
    token: raw,
    exp: Number(pl.exp) || 0,
    // 不带 worker 时 qoder-cn 的自定义 Token 会被 checkinQoderOne 当成国际版（打错 baseUrl）
    worker: (PLATFORM_WORKERS[platform] || [''])[0],
    active: false,
    source: '自定义 Token',
  };
}

/** 自定义凭据只在「不与任何 CLI 账号撞身份」时才加入，避免同一账号被签两次 */
function mergeCustomAccount(accounts, custom) {
  if (!custom || custom.invalid) return accounts;
  if (accounts.some((a) => (a.identity && custom.identity && a.identity === custom.identity) || (custom.token && a.token === custom.token))) return accounts;
  return [custom, ...accounts];
}

/**
 * 执行 WorkBuddy 签到（覆盖所有已保存账号）
 * 之前只签「当前生效」的那一个，导致另一个号永远签不到。
 */
export async function checkinWorkBuddy(overrideToken = null) {
  const today = getTodayStr();
  const time = getNowTimeStr();

  let accounts;
  if (overrideToken) {
    accounts = [{ name: '自定义 Token', display: '自定义 Token', token: overrideToken, exp: 0, source: '自定义 Token', active: true }];
  } else {
    accounts = await listCheckinAccounts('workbuddy');
    const custom = await customCredentialAccount('workbuddy');
    accounts = mergeCustomAccount(accounts, custom);
  }

  if (!accounts.length) {
    return {
      platform: 'workbuddy',
      ok: false,
      status: 'unconfigured',
      message: '未检测到 WorkBuddy / CodeBuddy 登录凭据，请先在客户端登录或保存账号档案。',
      today,
      time: getNowTimeStr(),
      accounts: []
    };
  }

  const results = [];
  for (const acct of accounts) {
    const label = acct.display || acct.name;
    if (!acct.token) {
      results.push({ ...acct, ok: false, status: 'failed', message: '档案内没有可用的 accessToken', label });
      continue;
    }

    // 复用 CLI 的凭据：快过期先用 refreshToken 续期，续期结果写回 CLI 的 auth.info
    let fresh = await ensureFreshWorkBuddy(acct);
    if (fresh.exp && fresh.exp * 1000 < Date.now()) {
      results.push({
        ...acct,
        ok: false,
        status: 'expired',
        message: fresh.refreshed ? '凭据续期后仍然过期，请重新登录该账号' : 'CLI 凭据已过期且无法自动续期，请重新登录一次 CLI',
        label,
      });
      continue;
    }
    try {
      let r = await checkinWorkBuddyOne(fresh.token);
      // 401 常见于「CLI 刚好也在刷新」：再续期一次换新 token 重试，而不是直接判失败
      if (r.status === 'expired') {
        const again = await refreshCodeBuddyAuth(acct.file, fresh.refreshToken || acct.refreshToken, acct.domain);
        if (again) r = await checkinWorkBuddyOne(again.token);
      }
      // 续期也救不回来时，试同身份的其它候选（例如 CLI 当前 token 被注销、档案里那份还能用）
      if (r.status === 'expired') {
        for (const alt of acct.alternates || []) {
          if (alt.exp && alt.exp * 1000 < Date.now()) continue;
          const altRes = await checkinWorkBuddyOne(alt.token);
          if (altRes.status !== 'expired') { r = altRes; break; }
        }
      }
      results.push({ ...acct, ...r, refreshed: fresh.refreshed, label });
    } catch (err) {
      results.push({ ...acct, ok: false, status: 'failed', message: `网络请求失败：${err.message}`, label });
    }
  }

  const okOnes = results.filter((r) => r.status === 'success');
  const alreadyOnes = results.filter((r) => r.status === 'already');
  const badOnes = results.filter((r) => !['success', 'already'].includes(r.status));

  const status = badOnes.length && !okOnes.length && !alreadyOnes.length
    ? 'failed'
    : (badOnes.length ? 'failed' : (okOnes.length ? 'success' : 'already'));

  const parts = results.map((r) => {
    const name = r.label || r.name;
    if (r.status === 'success') return `${name} +${r.credits}`;
    if (r.status === 'already') return `${name} 已签`;
    return `${name} ${r.status === 'expired' ? '登录态失效' : '失败'}`;
  });

  return {
    platform: 'workbuddy',
    ok: badOnes.length === 0,
    status,
    message: `${results.length} 个账号：${parts.join('；')}`,
    credits: okOnes.reduce((s, r) => s + (Number(r.credits) || 0), 0),
    consecutiveDays: Math.max(0, ...results.map((r) => Number(r.consecutiveDays) || 0)),
    accounts: results.map((r) => ({
      name: r.name,
      display: r.label || r.name,
      active: !!r.active,
      status: r.status,
      message: r.message,
      credits: r.credits,
      consecutiveDays: r.consecutiveDays,
      // identity 必须进快照：下次读概览时靠它把「今天的签到状态」精确贴回实时账号行，
      // 只按名字贴的话，改过名的账号（Qoder 改了昵称、MiniMax 换了档案名）会被当成新账号。
      identity: r.identity || '',
      source: r.credentialSource || r.source || ''
    })),
    today,
    time
  };
}

/**
 * 解析 CodeBuddy 国际版可执行 CLI 路径
 */
function resolveCodeBuddyIntlBin() {
  const cands = [
    process.env.CODEBUDDY_INTL_BIN,
    join(HOME, '.local', 'bin', 'codebuddy-intl'),
    join(HOME, '.npm-global', 'bin', 'codebuddy-intl'),
    process.env.CODEBUDDY_BIN,
    join(HOME, '.npm-global', 'bin', 'codebuddy'),
    join(HOME, '.local', 'bin', 'codebuddy'),
    '/usr/local/bin/codebuddy-intl',
    '/usr/local/bin/codebuddy',
    '/opt/homebrew/bin/codebuddy',
  ].filter(Boolean);
  for (const c of cands) {
    try { if (existsSync(c)) return c; } catch { /* ignore */ }
  }
  return process.platform === 'win32' ? 'codebuddy.cmd' : 'codebuddy';
}

/**
 * 单个 CodeBuddy 国际版账号打卡（调用模型发「你好」）
 */
async function checkinCodeBuddyOne(acct) {
  return new Promise((resolve) => {
    // 允许通过环境变量或测试钩子模拟打卡成功
    if (process.env.CODEBUDDY_CHECKIN_MOCK_SUCCESS === '1') {
      return resolve({
        ok: true,
        status: 'success',
        message: '签到成功（已调用模型发你好：你好！很高兴为您服务。）',
        credits: '活跃+1',
        consecutiveDays: 0,
      });
    }

    const bin = resolveCodeBuddyIntlBin();
    const useShell = process.platform === 'win32';
    const isIntlWrapper = typeof bin === 'string' && bin.includes('codebuddy-intl');
    const args = ['-p', '你好', '--permission-mode', 'bypassPermissions', '--model', 'deepseek-v4.1-flash'];

    const env = {
      ...process.env,
      DISABLE_AUTOUPDATER: '1',
      NO_COLOR: '1',
    };
    if (!isIntlWrapper) {
      env.CODEBUDDY_INTERNET_ENVIRONMENT = 'external';
      if (acct?.file) {
        env.CODEBUDDY_CONFIG_DIR = dirname(acct.file);
      } else {
        env.CODEBUDDY_CONFIG_DIR = join(HOME, '.codebuddy');
      }
    }

    execFile(bin, args, { env, timeout: 60_000, windowsHide: true, shell: useShell, maxBuffer: 4 * 1024 * 1024 }, (err, stdout, stderr) => {
      const out = String(stdout || '').trim();
      const errOut = String(stderr || '').trim();
      const missing = err?.code === 'ENOENT';
      const clean = out.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '').trim();
      const isAuthErr = /401\s+Authentication\s+required/i.test(clean) || /401\s+Authentication\s+required/i.test(errOut);

      if (missing) {
        return resolve({
          ok: false,
          status: 'failed',
          message: '未检测到 codebuddy CLI 命令，请确保已安装 @tencent-ai/codebuddy-code 或配置 codebuddy-intl 路径',
          credits: 0,
          consecutiveDays: 0,
        });
      }

      if (isAuthErr) {
        return resolve({
          ok: false,
          status: 'expired',
          message: '登录态已失效，请在客户端或 CLI 重新登录 CodeBuddy 国际版',
          credits: 0,
          consecutiveDays: 0,
        });
      }

      if (!err && clean.length > 0) {
        const snippet = clean.split('\n')[0].slice(0, 40);
        return resolve({
          ok: true,
          status: 'success',
          message: `签到成功（模型响应：${snippet}）`,
          credits: '活跃+1',
          consecutiveDays: 0,
        });
      }

      return resolve({
        ok: false,
        status: 'failed',
        message: `模型调用返回异常 [exit=${err?.code ?? 1}]：${clean || errOut || err?.message || '无输出'}`,
        credits: 0,
        consecutiveDays: 0,
      });
    });
  });
}

/**
 * 执行 CodeBuddy 国际版签到（通过调用模型发「你好」完成活跃打卡）
 */
export async function checkinCodeBuddy(overrideToken = null) {
  const today = getTodayStr();
  const time = getNowTimeStr();

  let accounts;
  if (overrideToken) {
    accounts = [{ name: '自定义 Token', display: '自定义 Token', token: overrideToken, exp: 0, source: '自定义 Token', active: true }];
  } else {
    accounts = await listCheckinAccounts('codebuddy');
    const custom = await customCredentialAccount('codebuddy');
    accounts = mergeCustomAccount(accounts, custom);
  }

  if (!accounts.length) {
    return {
      platform: 'codebuddy',
      ok: false,
      status: 'unconfigured',
      message: '未检测到 CodeBuddy 国际版登录凭据，请先在客户端登录或保存账号档案。',
      today,
      time: getNowTimeStr(),
      accounts: []
    };
  }

  const results = [];
  for (const acct of accounts) {
    const label = acct.display || acct.name;
    let fresh = await ensureFreshWorkBuddy(acct);
    if (fresh.exp && fresh.exp * 1000 < Date.now()) {
      results.push({
        ...acct,
        ok: false,
        status: 'expired',
        message: fresh.refreshed ? '凭据续期后仍然过期，请重新登录该账号' : 'CLI 凭据已过期且无法自动续期，请重新登录一次 CLI',
        label,
      });
      continue;
    }

    try {
      let r = await checkinCodeBuddyOne({ ...acct, token: fresh.token });
      if (r.status === 'expired' && acct.refreshToken && acct.file) {
        const again = await refreshCodeBuddyAuth(acct.file, fresh.refreshToken || acct.refreshToken, acct.domain || 'www.codebuddy.ai');
        if (again) r = await checkinCodeBuddyOne({ ...acct, token: again.token });
      }
      results.push({ ...acct, ...r, refreshed: fresh.refreshed, label });
    } catch (err) {
      results.push({ ...acct, ok: false, status: 'failed', message: `调用模型异常：${err.message}`, label });
    }
  }

  const anySuccess = results.some((r) => r.ok && r.status === 'success');
  const anyAlready = results.some((r) => r.status === 'already');
  const allExpired = results.length > 0 && results.every((r) => r.status === 'expired');

  let finalStatus = 'failed';
  if (anySuccess) finalStatus = 'success';
  else if (anyAlready) finalStatus = 'already';
  else if (allExpired) finalStatus = 'expired';

  const summaryMsg = results.map((r) => `${r.label}: ${r.message}`).join('；');

  return {
    platform: 'codebuddy',
    ok: anySuccess || anyAlready,
    status: finalStatus,
    message: summaryMsg,
    today,
    time,
    accounts: results.map((r) => ({
      name: r.name,
      display: r.label || r.name,
      active: !!r.active,
      status: r.status,
      message: r.message,
      credits: r.credits || '',
      consecutiveDays: r.consecutiveDays || 0,
      // identity 必须进快照：下次读概览时靠它把「今天的签到状态」精确贴回实时账号行，
      // 只按名字贴的话，改过名的账号（Qoder 改了昵称、MiniMax 换了档案名）会被当成新账号。
      identity: r.identity || '',
      source: r.credentialSource || r.source || ''
    })),
    credits: anySuccess ? '活跃+1' : '',
    consecutiveDays: 0,
  };
}


/**
 * 执行 Trae 签到（实现移植自 L0NE-6/Trae-AutoCheckin，见 README 致谢）。
 *
 * 链路：读桌面端 storage.json 取真实设备号 / refreshToken / 设备密钥
 *      → 逐账号「查状态 → 必要时续期 → 领取 → 同设备号回查确认」。
 *
 * 不再保留 CDP 点客户端按钮的兜底：那条路只在客户端开着且停在对话页时有效，
 * 失败时只能报「找不到签到按钮」；现在的失败原因能落到 9074 / 1001 / enable=false 上。
 */
export async function checkinTrae(overrideToken = null) {
  const today = getTodayStr();
  const home = HOME;

  let accounts;
  if (overrideToken) {
    accounts = [{ name: '自定义 Token', display: '自定义 Token', token: overrideToken, exp: 0, source: '自定义 Token', active: true }];
  } else {
    accounts = await listCheckinAccounts('traecode');
    const custom = await customCredentialAccount('traecode');
    accounts = mergeCustomAccount(accounts, custom);
  }

  // 桌面端凭据：提供 refreshToken（续期）与真实设备号 / 设备密钥（过设备检查）
  let desktop = null;
  try {
    desktop = await readTraeDesktopAuth(home);
  } catch {
    desktop = null;
  }
  const tokenCache = await readTraeTokenCache(home);
  const usedDeviceIds = new Set();
  const results = [];

  for (const acct of accounts) {
    const label = acct.display || acct.name;
    const uid = String(acct.user?.id || acct.user?.uid || acct.uid || jwtUid(acct.token) || '').trim();
    // 桌面端登的是同一个账号时才借用它的 refreshToken / 设备密钥，否则会把别人的 token 刷掉。
    // 客户端凭据里没写 uid 时（只有 refreshToken 的情况）仅在单账号下视为同一账号。
    const desktopUid = String(desktop?.uid || jwtUid(desktop?.accessToken) || '').trim();
    const desktopMatches = !!desktop && (desktopUid ? desktopUid === uid : accounts.length === 1);
    const tokens = [acct.token, ...(acct.alternates || []).map((a) => a.token)]
      .map((t) => String(t || '').trim())
      .filter((t, index, arr) => t && arr.indexOf(t) === index);

    const base = {
      uid,
      identity: acct.identity,
      name: label,
      refreshToken: acct.refreshToken || (desktopMatches ? desktop.refreshToken : '') || '',
      deviceId: acct.deviceId || '',
      privateKeyPem: desktopMatches ? desktop.privateKeyPem : '',
      publicKeyPem: desktopMatches ? desktop.publicKeyPem : '',
      machineId: desktopMatches ? desktop.machineId : '',
    };

    let r = null;
    try {
      for (const token of (tokens.length ? tokens : [''])) {
        r = await checkinTraeAccount({ ...base, token }, { home, cache: tokenCache, usedDeviceIds });
        if (r.status !== 'expired') break;
      }
    } catch (err) {
      results.push({ ...acct, ok: false, status: 'failed', message: `网络请求失败：${err.message}`, label });
      continue;
    }

    const status = r?.status === 'success' ? 'success'
      : r?.status === 'already' ? 'already'
        : r?.status === 'expired' ? 'expired'
          : 'failed';
    results.push({
      ...acct,
      ok: status === 'success' || status === 'already',
      status,
      message: r?.message || '未取得签到结果',
      credits: Number(r?.credits) || 0,
      consecutiveDays: Number(r?.consecutiveDays) || 0,
      deviceId: r?.deviceId || '',
      label,
    });
  }

  const okOnes = results.filter((r) => r.status === 'success');
  const alreadyOnes = results.filter((r) => r.status === 'already');
  const badOnes = results.filter((r) => !['success', 'already'].includes(r.status));

  const status = badOnes.length ? 'failed' : (okOnes.length ? 'success' : 'already');
  const parts = results.map((r) => {
    const name = r.label || r.name;
    if (r.status === 'success') return `${name} +${r.credits}`;
    if (r.status === 'already') return `${name} 已签`;
    return `${name} ${r.message}`;
  });

  return {
    platform: 'traecode',
    ok: badOnes.length === 0,
    status,
    message: results.length ? parts.join('；') : '未检测到 Trae 账号',
    credits: okOnes.reduce((sum, r) => sum + (Number(r.credits) || 0), 0),
    consecutiveDays: Math.max(0, ...results.map((r) => Number(r.consecutiveDays) || 0)),
    accounts: results.map((r) => ({
      name: r.name,
      display: r.label || r.name,
      active: !!r.active,
      status: r.status,
      message: r.message,
      credits: r.credits,
      consecutiveDays: r.consecutiveDays,
      // identity 必须进快照：下次读概览时靠它把「今天的签到状态」精确贴回实时账号行，
      // 只按名字贴的话，改过名的账号（Qoder 改了昵称、MiniMax 换了档案名）会被当成新账号。
      identity: r.identity || '',
      source: r.credentialSource || r.source || '',
    })),
    today,
    time: getNowTimeStr(),
  };
}

/**
 * 单个 CodeArts AK/SK 账号的真实签到流程（参考 2951461586/CodeArts2API）
 *   1. GET  /api/v1/benefit/claim          福利通道登记（幂等，确认身份）
 *   2. GET  /v1/ops/delivery?channel=IDE   拉任务列表，找 USER_LOGIN 那个 campaign
 *   3. POST /v1/ops/claim                  领取（需要 channel + idempotentKey）
 *
 * 旧实现只要文件里有 AK/SK 就直接返回「已激活」，从来没发过一个请求。
 */
async function checkinCodeArtsOne(ak, sk) {
  // 1. 福利 Token 通道（opengw）——**只是顺手领，失败不能挡住签到**
  //    2026-10 起 opengw 的 /api/v1/benefit/claim 对不少账号稳定返回
  //    {"error_code":"4000","error_msg":"invalid channel, group not found"}（benefit 通道按账号下线/迁移），
  //    而真正给「每日 1000 积分」的 /v1/ops/claim 在 snap-access 上是好的。
  //    以前这里一失败就 return，导致整个 CodeArts 签到被判失败。
  let userName = '';
  let benefitNote = '';
  try {
    const r = await codeArtsFetch(ak, sk, 'GET', `${CODEARTS_GATEWAY}/api/v1/benefit/claim`);
    const code = String(r.json?.error_code ?? '');
    if (code && code !== '0000') {
      const mapped = mapCodeArtsError(code, r.json?.error_msg, r.text);
      // 签名/凭证类错误说明凭据本身有问题，这时候继续也没意义
      if (mapped.status === 'expired' || /签名校验失败/.test(mapped.message)) {
        return { ok: false, status: mapped.status, message: mapped.message };
      }
      benefitNote = `福利 Token 通道不可用（${code}），已跳过；`;
    } else {
      userName = String(r.json?.result?.user_name || '');
    }
  } catch (err) {
    benefitNote = `福利 Token 通道不可达（${err.message}），已跳过；`;
  }

  // 2. 任务列表
  let campaign = null;
  let campaigns = [];
  try {
    const r = await codeArtsFetch(ak, sk, 'GET', `${CODEARTS_SNAP}/v1/ops/delivery?channel=IDE`);
    const items = Array.isArray(r.json?.data?.items) ? r.json.data.items : [];
    campaigns = items;
    campaign = items.find((it) => it.type === 'USER_LOGIN')
      || items.find((it) => /签到/.test(String(it.title || '')))
      || null;
  } catch (err) {
    return { ok: false, status: 'failed', message: `任务列表不可达：${err.message}` };
  }

  if (!campaign) {
    return { ok: false, status: 'failed', message: `没有找到签到任务（共 ${campaigns.length} 个活动）` };
  }

  const amount = Number(campaign.benefitAmount) || 0;
  const unit = campaign.benefitUnit === 'CREDIT' ? '积分' : (campaign.benefitUnit || '');
  const who = userName ? `${userName} ` : '';

  // 3a. 已经领过
  if (campaign.claimable === false && ['CLAIMED', 'CONFIRMED', 'CONSUMED'].includes(String(campaign.status))) {
    return {
      ok: true,
      status: 'already',
      message: `${benefitNote}${who}今日已领取「${campaign.title}」（${amount}${unit}）`,
      credits: 0,
      consecutiveDays: 0
    };
  }

  if (campaign.claimable === false) {
    return {
      ok: false,
      status: 'failed',
      message: `「${campaign.title}」当前不可领取（状态 ${campaign.status || '未知'}）`
    };
  }

  // 3b. 真正领取
  const claimRes = await codeArtsFetch(ak, sk, 'POST', `${CODEARTS_SNAP}/v1/ops/claim`, {
    campaignId: campaign.campaignId,
    channel: 'IDE',
    idempotentKey: randomUUID()
  });
  const cj = claimRes.json || {};
  const bizCode = Number(cj.code ?? NaN);
  const bizMsg = String(cj.message || cj.error_msg || '');

  if (bizCode === 0) {
    return {
      ok: true,
      status: 'success',
      message: `${benefitNote}${who}签到成功 +${amount}${unit}`,
      credits: amount,
      consecutiveDays: 1
    };
  }
  // 40001 = 权益还没刷新（今日已领）
  if (bizCode === 40001) {
    return { ok: true, status: 'already', message: `${who}${bizMsg || '今日已领取，等明天刷新'}`, credits: 0, consecutiveDays: 0 };
  }
  if (bizCode === 4006) {
    return { ok: false, status: 'failed', message: `${bizMsg || '名额已领完'}（4006）` };
  }
  const mapped = mapCodeArtsError(String(cj.error_code || bizCode), bizMsg, claimRes.text);
  return { ok: false, status: mapped.status, message: mapped.message };
}

/** 把华为云网关/业务错误码翻译成人话 */
function mapCodeArtsError(code, msg, rawText = '') {
  const c = String(code || '');
  const m = String(msg || '');
  if (c === 'APIG.0602' || /token.*(expired|invalid)|sts/i.test(m)) {
    return { status: 'expired', message: 'AK/SK 对应的临时安全凭证（STS）已过期，请重新获取或改用长期 AK/SK' };
  }
  if (c === 'APIG.0301' || c === 'APIG.0303' || /signature/i.test(m)) {
    return { status: 'failed', message: `签名校验失败（${c || 'signature'}），请检查 AK/SK 是否匹配` };
  }
  if (c === 'APIG.0101') {
    return { status: 'failed', message: '接口未在该环境发布（APIG.0101），请检查区域/网关地址' };
  }
  if (c === '4006') {
    return { status: 'failed', message: `${m || '名额已领完'}（4006）` };
  }
  return { status: 'failed', message: `CodeArts 返回 [${c || '-'}]：${m || (rawText || '').slice(0, 120) || '未知错误'}` };
}

/**
 * 执行 CodeArts 签到（覆盖所有 AK/SK 档案）
 */
export async function checkinCodeArts(overrideToken = null) {
  const today = getTodayStr();

  let accounts;
  if (overrideToken) {
    accounts = [{ name: '自定义凭据', display: '自定义凭据', token: overrideToken, source: '自定义凭据', active: true }];
  } else {
    accounts = await listCheckinAccounts('codearts');
    const custom = await customCredentialAccount('codearts');
    accounts = mergeCustomAccount(accounts, custom);
  }

  if (!accounts.length) {
    return {
      platform: 'codearts',
      ok: false,
      status: 'unconfigured',
      message: '未检测到 CodeArts AK/SK，请检查 ~/.config/agenthub-codearts/codearts-auth.env 或保存账号档案。',
      today,
      time: getNowTimeStr(),
      accounts: []
    };
  }

  const results = [];
  for (const acct of accounts) {
    const label = acct.display || acct.name;
    if (acct.invalid) {
      results.push({ ...acct, ok: false, status: 'failed', message: '自定义凭据格式应为 AK,SK（逗号分隔）', label });
      continue;
    }
    if (!acct.ak || !acct.sk) {
      results.push({ ...acct, ok: false, status: 'failed', message: '缺少 AK/SK', label });
      continue;
    }
    try {
      const r = await checkinCodeArtsOne(acct.ak, acct.sk);
      results.push({ ...acct, ...r, label });
    } catch (err) {
      results.push({ ...acct, ok: false, status: 'failed', message: `请求异常：${err.message}`, label });
    }
  }

  const okOnes = results.filter((r) => r.status === 'success');
  const alreadyOnes = results.filter((r) => r.status === 'already');
  const badOnes = results.filter((r) => !['success', 'already'].includes(r.status));

  const status = badOnes.length ? 'failed' : (okOnes.length ? 'success' : 'already');

  return {
    platform: 'codearts',
    ok: badOnes.length === 0,
    status,
    message: results.map((r) => r.message).join('；'),
    credits: okOnes.reduce((s, r) => s + (Number(r.credits) || 0), 0),
    consecutiveDays: Math.max(0, ...results.map((r) => Number(r.consecutiveDays) || 0)),
    accounts: results.map((r) => ({
      name: r.name,
      display: r.label || r.name,
      active: !!r.active,
      status: r.status,
      message: r.message,
      credits: r.credits,
      consecutiveDays: r.consecutiveDays,
      // identity 必须进快照：下次读概览时靠它把「今天的签到状态」精确贴回实时账号行，
      // 只按名字贴的话，改过名的账号（Qoder 改了昵称、MiniMax 换了档案名）会被当成新账号。
      identity: r.identity || '',
      source: r.credentialSource || r.source || ''
    })),
    today,
    time: getNowTimeStr()
  };
}


// ---------------------------------------------------------------- Qoder / Qoder CN 活动领取
// 实现方式移植自 L0NE-6/Qoder-Daily（见 README 致谢）：
//   1. 活动列表必须带 ?forceRefresh=true，否则吃到缓存、刚开的活动看不到；
//   2. 只认 actionType=CLAIM_BENEFIT 的活动，VIEW_DETAILS 这类常驻活动不参与领取；
//   3. 请求必须带本机 UMID 组件生成的设备风控头，否则国际版每日活动整行不下发。

const QODER_BENEFIT_ACTION = 'CLAIM_BENEFIT';

/** 从活动接口响应里取 CLAIM_BENEFIT 行（兼容 campaigns / data.campaigns 两种包装） */
export function extractQoderCampaigns(payload) {
  const isBenefit = (row) => String(row?.actionType || row?.action_type || '').toUpperCase() === QODER_BENEFIT_ACTION;
  const data = payload && typeof payload === 'object' && payload.data && typeof payload.data === 'object' ? payload.data : {};
  let rows = Array.isArray(payload?.campaigns) && payload.campaigns.length
    ? payload.campaigns
    : Array.isArray(data.campaigns) ? data.campaigns : [];
  if (!rows.length) {
    // 兜底：有些版本把活动行下沉到更深层，按 actionType 递归捞回来
    const found = [];
    const seen = new Set();
    const visit = (node, depth = 0) => {
      if (!node || depth > 8) return;
      if (Array.isArray(node)) {
        for (const item of node) visit(item, depth + 1);
        return;
      }
      if (typeof node !== 'object') return;
      const id = node.campaignId || node.campaign_id;
      if (id && isBenefit(node)) {
        const key = String(id);
        if (!seen.has(key)) {
          seen.add(key);
          found.push(node);
        }
        return;
      }
      for (const value of Object.values(node)) visit(value, depth + 1);
    };
    visit(payload);
    rows = found;
  }
  return rows.filter((row) => row && typeof row === 'object' && isBenefit(row));
}

const qoderClaimStatus = (row) => String(row?.claimStatus || row?.claim_status || '').toUpperCase();

/** 活动是否在有效期内。开源项目 qoder-checkin 就是靠 startAt~endAt 判断「今日已领」，
 *  不加这个判断会把上一期 CLAIMED 的老活动当成今天已领（Qoder CN 报「已签到」但客户端还有领取按钮就是这个原因）。
 *  没有窗口字段时不做限制，避免把正常数据判死。 */
export function qoderInWindow(row, nowSec = Math.floor(Date.now() / 1000)) {
  const s = Number(row?.startAt ?? row?.start_at ?? 0) || 0;
  const e = Number(row?.endAt ?? row?.end_at ?? 0) || 0;
  if (!e) return true;
  return s <= nowSec && nowSec < e;
}

/** 活动按 UTC+8 每天 10:00 刷新（上游文案：每日 10:00（UTC+8）刷新）。
 *  所以一个「期」是 [今天 10:00, 明天 09:59]，跨自然日；判断「今天这一期」
 *  必须用窗口起始日的 UTC+8 日期，不能只用 now 落在窗口内。 */
const QODER_TZ_OFFSET_SEC = 8 * 3600;

function qoderDayKey(sec) {
  return new Date((Number(sec) + QODER_TZ_OFFSET_SEC) * 1000).toISOString().slice(0, 10);
}

export function qoderWindowDay(row) {
  const s = Number(row?.startAt ?? row?.start_at ?? 0) || 0;
  return s ? qoderDayKey(s) : '';
}

/**
 * 今天这一期是否已经领过。
 * 只判「窗口内」不够：昨天的窗口会一直持续到今天 10:00，于是 00:00–10:00 之间
 * 会把昨天的 CLAIMED 当成「今日已签」，卡片显示已签到、客户端按钮却还能点。
 */
export function qoderClaimedToday(row, nowSec = Math.floor(Date.now() / 1000)) {
  if (!['CLAIMED', 'GRANTED'].includes(qoderClaimStatus(row))) return false;
  if (!qoderInWindow(row, nowSec)) return false;
  const day = qoderWindowDay(row);
  // 没有 startAt 就无法证明是「今天这一期」，退回旧行为（窗口内即已领），
  // 免得把正常数据判成待打卡、一天重试八次。
  if (!day) return true;
  return day === qoderDayKey(nowSec);
}

/** 今天这一期（UTC+8 10:00）的开始时间；用于「上游还没下发活动」时安排重试 */
export function qoderTodayWindowStart(nowSec = Math.floor(Date.now() / 1000)) {
  const dayKey = qoderDayKey(nowSec);
  const midnight = Date.parse(`${dayKey}T00:00:00+08:00`) / 1000;
  return Number.isFinite(midnight) ? midnight + 10 * 3600 : 0;
}

/** 当前窗口结束后下一期的开始时间；上游 endAt 是本期最后一分钟，+60s 就是下期 10:00 */
export function qoderNextWindowStart(row) {
  const e = Number(row?.endAt ?? row?.end_at ?? 0) || 0;
  return e ? e + 60 : 0;
}

/** 上一期已领、今天这一期还没开时，算出「几点开窗」。
 *  0:00–10:00 之间打开控制台就是这种状态：不能报「已签到」（卡片会骗人），
 *  报 pending + retryAt，让定时器到点再来一次。没有可等待的窗口时返回 null。 */
export function qoderPendingWindow(staleClaimed, nowSec = Math.floor(Date.now() / 1000)) {
  const rows = Array.isArray(staleClaimed) ? staleClaimed : [];
  const prev = rows.find((item) => qoderNextWindowStart(item) > nowSec) || rows[0];
  const nextStart = prev ? qoderNextWindowStart(prev) : 0;
  if (!nextStart || nowSec >= nextStart || nextStart - nowSec > 12 * 3600) return null;
  const hhmm = new Date((nextStart + QODER_TZ_OFFSET_SEC) * 1000).toISOString().slice(11, 16);
  return { retryAt: nextStart, message: `上一期已领，今日 ${hhmm}（UTC+8）开新一期；到点会自动重试` };
}

function qoderResponseMessage(res) {
  const json = res?.json || {};
  const data = json.data && typeof json.data === 'object' ? json.data : {};
  return String(
    json.message || json.msg || data.message || data.msg
    || json.error?.message || data.error?.message || json.error || ''
  ).trim();
}

function qoderBenefit(item) {
  const benefit = item?.benefit || {};
  return Number(benefit.amount ?? benefit.value ?? benefit.credits ?? 0) || 0;
}

/** 领取结果归一化：重放/同人已领都按「今日已领」处理，不重复计数 */
function qoderClaimOutcome(res) {
  const json = res?.json || {};
  const data = json.data && typeof json.data === 'object' ? json.data : json;
  const status = String(data.status || json.status || '').toUpperCase();
  const code = String(data.code || json.code || data.errorCode || json.errorCode || '').toUpperCase();
  const message = qoderResponseMessage(res);
  const replayed = data.replayed === true || json.replayed === true
    || ['REPLAYED', 'ALREADY_CLAIMED', 'SAME_PERSON_ALREADY_CLAIMED', 'BLOCKED'].includes(status)
    || ['REPLAYED', 'ALREADY_CLAIMED', 'SAME_PERSON_ALREADY_CLAIMED', 'BLOCKED'].includes(code);
  if (res?.status === 401 || res?.status === 403) {
    return { status: 'expired', message: message || '登录态已失效，请重新登录 Qoder CLI' };
  }
  if (res?.status === 404 || res?.status === 405) {
    return { status: 'unsupported', message: message || '该区域暂未开放活动领取接口' };
  }
  if (replayed || res?.status === 409) {
    return { status: 'already', message: message || '今日已领取过' };
  }
  if (['CLAIMED', 'GRANTED', 'SUCCESS', 'OK'].includes(status) || data.success === true || data.claimed === true) {
    return { status: 'success', message: message || '领取成功' };
  }
  return { status: 'failed', message: `活动领取返回 [${res?.status ?? '-'}/${status || '-'}]：${message || '未知错误'}` };
}

async function ensureQoderFresh(acct) {
  if (!isQoderTokenExpired(acct)) return { token: acct.token, refreshed: false };
  const renewed = await refreshQoderToken(acct.worker, acct.refreshToken);
  if (!renewed) return { token: acct.token, refreshed: false };
  const expiresAt = renewed.expiresIn ? Math.floor(Date.now() / 1000 + renewed.expiresIn) : 0;
  if (acct.file && acct.saltFile) {
    await persistQoderToken({
      credFile: acct.file,
      saltFile: acct.saltFile,
      identity: acct.identity,
      token: renewed.token,
      refreshToken: renewed.refreshToken,
      expiresAt,
    }).catch(() => false);
  }
  return { token: renewed.token, refreshed: true };
}

async function fetchQoderCampaigns(acct, device = null) {
  let fresh = await ensureQoderFresh(acct);
  let res = await listQoderCampaigns(acct.worker, fresh.token, device);
  if ((res.status === 401 || res.status === 403) && acct.refreshToken) {
    const renewed = await refreshQoderToken(acct.worker, acct.refreshToken);
    if (renewed?.token) {
      fresh = { token: renewed.token, refreshed: true };
      res = await listQoderCampaigns(acct.worker, fresh.token, device);
    }
  }
  return { res, token: fresh.token };
}

/** 单个 Qoder 账号：解析设备身份 → 拉活动列表 → 逐个领取 → 汇总积分 */
async function checkinQoderOne(acct) {
  const candidates = [acct, ...(Array.isArray(acct.alternates) ? acct.alternates : [])];
  const worker = acct.worker || 'qoder';
  const uid = String(acct.user?.id || acct.user?.uid || acct.uid || '').trim();
  // 设备身份按账号 uid 生成：桌面端组件会把指纹与账号绑在一起
  let device = null;
  try {
    device = await resolveQoderDevice(worker, { home: HOME, uid });
  } catch {
    device = null;
  }
  const deviceNote = device?.note || '';
  let fetched = null;
  let winner = null;
  for (const candidate of candidates) {
    const entry = { ...candidate, expiresAt: candidate.expiresAt || candidate.exp || 0 };
    fetched = await fetchQoderCampaigns(entry, device);
    winner = entry;
    if (fetched.res.status !== 401 && fetched.res.status !== 403) break;
  }
  const { res } = fetched;
  let token = fetched.token;
  if (res.status === 401 || res.status === 403) {
    return { ok: false, status: 'expired', message: `签到活动查询失败（HTTP ${res.status}），请确认凭证有效且地区选择正确`, credits: 0, consecutiveDays: 0 };
  }
  if (res.status === 429) {
    return { ok: false, status: 'failed', message: '签到活动查询失败（HTTP 429），请稍后重试', credits: 0, consecutiveDays: 0 };
  }
  if (!res.ok) {
    return { ok: false, status: 'failed', message: `活动列表返回 [${res.status}]：${qoderResponseMessage(res) || '未知错误'}`, credits: 0, consecutiveDays: 0 };
  }
  const bodyCode = Number(res.json?.code ?? res.json?.errorCode);
  if (bodyCode === 401 || bodyCode === 403) {
    return { ok: false, status: 'expired', message: qoderResponseMessage(res) || '登录态已失效，请在 Qoder CLI 重新登录', credits: 0, consecutiveDays: 0 };
  }
  if (res.json?.success === false || (Number.isFinite(bodyCode) && ![0, 200].includes(bodyCode))) {
    return { ok: false, status: 'failed', message: `活动列表返回 [${bodyCode}]：${qoderResponseMessage(res) || '未知错误'}`, credits: 0, consecutiveDays: 0 };
  }
  let campaigns = extractQoderCampaigns(res.json);
  let claimable = campaigns.filter((item) => qoderClaimStatus(item) === 'CLAIMABLE');
  let claimedBefore = campaigns.filter((item) => qoderClaimedToday(item));
  let staleClaimed = campaigns.filter((item) => ['CLAIMED', 'GRANTED'].includes(qoderClaimStatus(item)) && !qoderClaimedToday(item));
  let useBase = '';

  // Qoder CN：完整设备头下 200 但活动列表为空时，改用最小请求头（不带设备指纹）再取一次
  // （移植 L0NE-6/Qoder-Daily v1.0.10：上游对带完整设备头的请求可能下发空活动列表，最小头才看得到）。
  // 采纳条件是「最小头列表非空」——今日已领（CLAIMED）也要采纳，否则会把已领态误报成「上游未下发」；
  // 领取仍走原设备头路径，与上游一致（复取只解决「看不见」，不改变领取请求）。
  // 最小头仍为空 → 保留首次空结果照常走「无活动」分支；HTTP 401/403 走 fetchQoderCampaigns 内已有的续期重试。
  if (worker === 'qoder-cn' && device && res.ok && !claimable.length && !claimedBefore.length) {
    try {
      const minimal = await fetchQoderCampaigns({ ...winner, token }, null);
      const minimalCampaigns = minimal.res.ok && minimal.res.json?.success !== false
        ? extractQoderCampaigns(minimal.res.json)
        : [];
      if (minimalCampaigns.length) {
        campaigns = minimalCampaigns;
        claimable = minimalCampaigns.filter((item) => qoderClaimStatus(item) === 'CLAIMABLE');
        claimedBefore = minimalCampaigns.filter((item) => qoderClaimedToday(item));
        staleClaimed = minimalCampaigns.filter((item) => ['CLAIMED', 'GRANTED'].includes(qoderClaimStatus(item)) && !qoderClaimedToday(item));
        token = minimal.token;
      }
    } catch { /* 最小头复取失败按原结果走 */ }
  }

  // 国际版活动列表为空时，换一套环境用同一个 token 再问一次。
  // 开源项目 qoder-checkin 的 baseUrls 就是让在 openapi.qoder.sh / openapi.qoder.com.cn 之间切，
  // 国际账号被下发到另一套环境时，只有换环境才看得到活动。
  if (!claimable.length && !claimedBefore.length) {
    const alt = altQoderBaseUrl(worker);
    if (alt) {
      try {
        const altRes = await listQoderCampaigns(worker, token, device, alt);
        if (altRes.ok) {
          const altCampaigns = extractQoderCampaigns(altRes.json);
          const altClaimable = altCampaigns.filter((item) => qoderClaimStatus(item) === 'CLAIMABLE');
          if (altClaimable.length) {
            campaigns = altCampaigns;
            claimable = altClaimable;
            claimedBefore = altCampaigns.filter((item) => qoderClaimedToday(item));
            staleClaimed = altCampaigns.filter((item) => ['CLAIMED', 'GRANTED'].includes(qoderClaimStatus(item)) && !qoderClaimedToday(item));
            useBase = alt;
          }
        }
      } catch { /* 换环境失败就按原结果走 */ }
    }
  }

  if (!claimable.length) {
    const nowSec = Math.floor(Date.now() / 1000);
    if (claimedBefore.length) {
      return { ok: true, status: 'already', message: claimedBefore.length > 1 ? `今日 ${claimedBefore.length} 个活动已领取` : '今日已领取', credits: 0, consecutiveDays: 0 };
    }
    // 上一期已领、今天这一期还没开：0:00–10:00 之间就是这种状态。
    // 这时不能报「已签到」（卡片会骗人），报 pending 让定时器到点重试一次。
    const pend = qoderPendingWindow(staleClaimed, nowSec);
    if (pend) {
      return {
        ok: true,
        status: 'pending',
        message: pend.message,
        credits: 0,
        consecutiveDays: 0,
        // 定时器不必在开窗之前反复试：到点再来，免得一天 8 次重试全耗在等窗口上
        retryAt: pend.retryAt
      };
    }
    // 上游整个列表还没下发（国际版早上常见）也不能收工：约到今天 10:00 再看一次
    const todayOpen = qoderTodayWindowStart(nowSec);
    if (todayOpen && nowSec < todayOpen) {
      const hhmm = new Date((todayOpen + QODER_TZ_OFFSET_SEC) * 1000).toISOString().slice(11, 16);
      return {
        ok: true,
        status: 'pending',
        message: `上游暂未下发今日活动，今日 ${hhmm}（UTC+8）开新一期；到点会自动重试`,
        credits: 0,
        consecutiveDays: 0,
        retryAt: todayOpen
      };
    }
    // 国际版：定向活动没下发时把原因说清楚，别让人以为接口挂了
    if (worker === 'qoder') {
      if (deviceNote) {
        return { ok: true, status: 'already', message: `未领取：${deviceNote}。国际版签到需要本机 Qoder 客户端或 qodercli 的 UMID 组件`, credits: 0, consecutiveDays: 0 };
      }
      const diag = `[活动 ${campaigns.length} 个：` + (campaigns.map((c) => `${qoderClaimStatus(c) || '?'}`).join('/') || '空') + (staleClaimed.length ? `，其中 ${staleClaimed.length} 个是过期的 CLAIMED` : '') + ']';
    return {
        ok: true,
        status: 'already',
        message: diag + ' 上游暂未下发今日活动（已试 openapi.qoder.sh / openapi.qoder.com.cn 两套环境）。'
          + '常见原因：① 官方窗口每天 10:00 开启，到点会自动重试；② 客户端今天已领过；'
          + '③ 设备指纹（Cosy-MachineToken）过期——回 Windows 跑 qoder-checkin 的 01_extract.py 重新提取，或在 Qoder 客户端重新登录一次',
        credits: 0,
        consecutiveDays: 0
      };
    }
    return { ok: true, status: 'already', message: '当前没有可领取的签到活动', credits: 0, consecutiveDays: 0 };
  }

  let credits = 0;
  let successCount = 0;
  let alreadyCount = 0;
  const failures = [];
  for (const item of claimable) {
    const campaignId = item.campaignId || item.campaign_id;
    const amount = qoderBenefit(item);
    try {
      const claim = await claimQoderCampaign(worker, token, campaignId, device, useBase);
      const outcome = qoderClaimOutcome(claim);
      if (outcome.status === 'success') {
        successCount += 1;
        credits += amount;
      } else if (outcome.status === 'already') {
        alreadyCount += 1;
      } else {
        failures.push(outcome.message);
      }
    } catch (err) {
      failures.push(`请求异常：${err.message}`);
    }
    if (claimable.length > 1) await new Promise((r) => setTimeout(r, 800));
  }

  const parts = [];
  if (successCount) parts.push(`领取 ${successCount} 个活动${credits ? `，+${credits} Credits` : ''}${useBase ? `（已切到 ${useBase.replace('https://', '')}）` : ''}`);
  const alreadyTotal = alreadyCount + claimedBefore.length;
  if (alreadyTotal) parts.push(`${alreadyTotal} 个今日已领`);
  if (failures.length) parts.push(`失败 ${failures.length} 个：${failures[0]}`);
  if (!parts.length) parts.push('当前没有可领取的签到活动');
  const status = failures.length ? 'failed' : (successCount ? 'success' : 'already');
  return {
    ok: !failures.length,
    status,
    message: parts.join('；'),
    credits,
    consecutiveDays: 0,
  };
}

/**
 * 执行 Qoder / Qoder CN 一键签到（覆盖所有账号档案与当前 CLI 凭据）
 * @param {'qoder'|'qoder-cn'} target
 */
export async function checkinQoder(target = 'qoder') {
  const platform = target === 'qoder-cn' ? 'qoder-cn' : 'qoder';
  const today = getTodayStr();
  let accounts = await listCheckinAccounts(platform);
  const custom = await customCredentialAccount(platform);
  accounts = mergeCustomAccount(accounts, custom);

  if (!accounts.length) {
    return {
      platform,
      ok: false,
      status: 'unconfigured',
      message: `未检测到 ${qoderRegion(platform).name} 凭据，请先在控制台完成 Qoder CLI 登录或保存账号档案。`,
      today,
      time: getNowTimeStr(),
      accounts: [],
    };
  }

  const results = [];
  for (const acct of accounts) {
    const label = acct.display || acct.name;
    try {
      const r = await checkinQoderOne(acct);
      results.push({ ...acct, ...r, label });
    } catch (err) {
      results.push({ ...acct, ok: false, status: 'failed', message: `请求异常：${err.message}`, label });
    }
  }

  const okOnes = results.filter((r) => r.status === 'success');
  // pending（等 10:00 开窗）不是失败：别因为一个账号在等窗口就把整个平台标红
  const badOnes = results.filter((r) => !['success', 'already', 'pending'].includes(r.status));
  const pendOnes = results.filter((r) => r.status === 'pending');
  const status = badOnes.length ? 'failed' : (okOnes.length ? 'success' : (pendOnes.length ? 'pending' : 'already'));
  const retryAt = status === 'pending' ? (pendOnes.find((r) => r.retryAt)?.retryAt || 0) : 0;
  return {
    platform,
    ok: badOnes.length === 0,
    status,
    // 多账号时带上账号名，否则「已领取 + 未下发」两段并排看着自相矛盾
    message: results.map((r) => (results.length > 1 ? `${r.label}：${r.message}` : r.message)).join('；'),
    credits: okOnes.reduce((s, r) => s + (Number(r.credits) || 0), 0),
    consecutiveDays: 0,
    retryAt,
    accounts: results.map((r) => ({
      name: r.name,
      display: r.label || r.name,
      active: !!r.active,
      status: r.status,
      message: r.message,
      credits: r.credits,
      consecutiveDays: r.consecutiveDays,
      // identity 必须进快照：下次读概览时靠它把「今天的签到状态」精确贴回实时账号行，
      // 只按名字贴的话，改过名的账号（Qoder 改了昵称、MiniMax 换了档案名）会被当成新账号。
      identity: r.identity || '',
      source: r.credentialSource || r.source || '',
    })),
    today,
    time: getNowTimeStr(),
  };
}

/**
 * MiniMax Code 每日签到。
 * 链路移植自 SkillHub 的 `@user_3a370331/totorosir-minimax-checkin`（作者 龙猫科技说 longmaoit）：
 * 复用 mcode CLI 自己的 OAuth 登录态，按桌面端同款签名直签，401 用 refresh_token 自愈。
 */
// ---------------------------------------------------------------- Meoo（秒悟 / 阿里云）
// Meoo 的每日积分是「每日登录赠送」（账号权益里 typeCode = daily_login，2000/天）。
// 官方 CLI `@aliyun-meoo/cli` 的 `meoo login` 就是一次登录，所以签到 = 跑一次 login + 读一次 account。
// AK 放在 ~/.config/agenthub-meoo/meoo-auth.env（MEOO_AK=...），不进仓库。

const MEOO_AK_FILE = join(homedir(), '.config', 'agenthub-meoo', 'meoo-auth.env');

/** 读 Meoo 的 AK：先看 env 文件，再看控制台里手工配的 customTokens.meoo */
async function readMeooAk() {
  let ak = String(process.env.MEOO_AK || '').trim();
  if (!ak) {
    try {
      const raw = await readFile(MEOO_AK_FILE, 'utf-8');
      const m = raw.match(/^\s*MEOO_AK\s*=\s*(\S+)/m);
      if (m) ak = m[1].trim();
    } catch { /* 没有文件就走 customTokens */ }
  }
  if (!ak) {
    try {
      const st = await loadState();
      ak = String(st.customTokens?.meoo || '').trim();
    } catch { /* ignore */ }
  }
  if (!ak) return { available: false, source: '', ak: '' };
  const from = process.env.MEOO_AK ? '环境变量 MEOO_AK' : (ak === (await loadState().catch(() => ({})))?.customTokens?.meoo ? '控制台自定义 AK' : '~/.config/agenthub-meoo/meoo-auth.env');
  return { available: true, source: from, ak, token: ak };
}

// 服务是 systemd 拉起的，PATH 里通常没有 ~/.npm-global/bin，这里按常见安装位置兜底
function resolveMeooBin() {
  const cands = [
    process.env.MEOO_BIN,
    join(homedir(), '.npm-global', 'bin', 'meoo'),
    join(homedir(), '.local', 'bin', 'meoo'),
    '/usr/local/bin/meoo',
    '/opt/homebrew/bin/meoo',
  ].filter(Boolean);
  for (const c of cands) {
    try { if (existsSync(c)) return c; } catch { /* ignore */ }
  }
  return process.platform === 'win32' ? 'meoo.cmd' : 'meoo';
}

/** 跑一次 meoo 子命令，返回 { ok, code, stdout, stderr } */
function runMeoo(args, timeout = 45000) {
  return new Promise((resolve) => {
    // Windows 上 npm 全局装的是 meoo.cmd，execFile 直接调会 ENOENT，必须走 shell
    const useShell = process.platform === 'win32';
    execFile(resolveMeooBin(), args, { timeout, windowsHide: true, shell: useShell, maxBuffer: 4 * 1024 * 1024 }, (err, stdout, stderr) => {
      resolve({
        ok: !err,
        code: err?.code ?? 0,
        missing: err?.code === 'ENOENT',
        stdout: String(stdout || ''),
        stderr: String(stderr || ''),
      });
    });
  });
}

/**
 * 单 AK：login（= 每日登录）→ account（读积分）。
 * @returns {Promise<{ok:boolean, status:string, message:string, user:string, plan:string, balance:number}>}
 */
async function checkinMeooOne(ak) {
  const login = await runMeoo(['login', '--ak', ak]);
  if (login.missing) return { ok: false, status: 'failed', message: '没找到 meoo 命令：先 npm i -g @aliyun-meoo/cli' };
  const loginText = (login.stdout + ' ' + login.stderr).replace(/\s+/g, ' ').trim();
  if (!login.ok) {
    const bad = /401|403|invalid|expired|无效|失败/i.test(loginText);
    return {
      ok: false,
      status: bad ? 'expired' : 'failed',
      message: bad ? `Meoo 登录失败：AK 无效或已过期（${loginText.slice(0, 120)}）` : `Meoo 登录失败：${loginText.slice(0, 160)}`,
    };
  }

  const acc = await runMeoo(['account', '--json']);
  let user = '';
  let balance = 0;
  let plan = '';
  if (acc.ok) {
    try {
      const j = JSON.parse(acc.stdout.slice(acc.stdout.indexOf('{')));
      const d = j.data || j;
      user = d?.user?.username || '';
      plan = d?.plan?.planName || '';
      balance = Number(d?.points?.availableBalance ?? 0) || 0;
    } catch { /* 解析失败就只报登录成功 */ }
  }
  return { ok: true, status: 'success', message: '', user, plan, balance };
}

/** Meoo 签到：login（= 每日登录）→ account（读积分）。覆盖所有已保存的 AK。 */
export async function checkinMeoo() {
  const today = getTodayStr();
  const time = getNowTimeStr();

  // 账号来源与其它平台对齐：worker 档案 + 线上 meoo-auth.env（listCheckinAccounts 已合并两者）
  let accounts = await listCheckinAccounts('meoo');
  if (!accounts.length) {
    const cred = await readMeooAk();
    if (cred.available) {
      accounts = [{
        name: 'meoo',
        display: `Meoo · ${maskAk(cred.ak)}`,
        identity: `meoo:${cred.ak}`,
        ak: cred.ak,
        active: true,
        source: cred.source,
      }];
    }
  }
  if (!accounts.length) {
    return {
      platform: 'meoo', ok: false, status: 'failed',
      message: '未配置 Meoo AK：写到 ~/.config/agenthub-meoo/meoo-auth.env（MEOO_AK=...）或在控制台「配置 Token」里填',
      credits: 0, consecutiveDays: 0, today, time, accounts: [],
    };
  }

  // 多账号时余额对比失去意义（state 里只存一个总余额），只在单账号时保留「较上次 +N」
  let prevBalance = 0;
  if (accounts.length === 1) {
    try { prevBalance = Number((await loadState())?.platforms?.meoo?.credits) || 0; } catch { /* ignore */ }
  }

  const results = [];
  for (const acct of accounts) {
    const ak = String(acct.ak || '').trim();
    if (!ak) {
      results.push({ ...acct, ok: false, status: 'failed', message: '账号档案里没有 MEOO_AK' });
      continue;
    }
    const r = await checkinMeooOne(ak);
    if (!r.ok) { results.push({ ...acct, ...r }); continue; }

    const who = r.user ? `${r.user} ` : '';
    const parts = [`${who}登录态已同步`];
    if (r.plan) parts.push(r.plan);
    if (r.balance) parts.push(`可用积分 ${r.balance.toLocaleString('en-US')}`);
    // 注意：Meoo 的每日积分是「网页登录时服务端自动发放」，CLI 的 login 走 AK 认证、不会触发。
    // 所以这里只报余额，不承诺涨幅（余额变动多半是用户自己在网页上领的）。
    if (prevBalance && r.balance && r.balance !== prevBalance) {
      const d = r.balance - prevBalance;
      parts.push(d > 0 ? `（较上次 +${d.toLocaleString('en-US')}，多半是网页端领的）` : `（较上次 ${d.toLocaleString('en-US')}）`);
    }
    results.push({ ...acct, ok: true, status: 'success', message: parts.join('，'), user: r.user, balance: r.balance });
  }

  // meoo login 会把该 AK 写成「当前登录」；多账号轮完后把正在生效的那个写回去，
  // 不然签完一轮，CLI 停在最后一个账号上（下次手动跑 meoo 会莫名换了人）。
  const active = accounts.find((a) => a.active && a.ak);
  if (accounts.length > 1 && active) {
    try { await runMeoo(['login', '--ak', String(active.ak)]); } catch { /* 恢复失败不影响签到结果 */ }
  }

  const badOnes = results.filter((r) => !r.ok);
  return {
    platform: 'meoo',
    ok: badOnes.length === 0,
    status: badOnes.length ? 'failed' : 'success',
    message: results.map((r) => (results.length > 1 ? `${r.display || r.name}：${r.message}` : r.message)).join('；'),
    credits: 0,
    consecutiveDays: 0,
    today,
    time,
    accounts: results.map((r) => ({
      name: r.name,
      display: r.user ? `${r.user}` : (r.display || r.name),
      identity: r.identity || '',
      active: !!r.active,
      status: r.status,
      message: r.message,
      credits: 0,
      source: r.source || '',
    })),
  };
}

export async function checkinMiniMaxPlatform(region = 'cn') {
  const today = getTodayStr();
  const time = getNowTimeStr();
  const cfg = MINIMAX_REGIONS[region] || MINIMAX_REGIONS.cn;
  const state = await loadState();
  const custom = String(state.customTokens?.minimaxcode || '').trim();
  let accounts = await listCheckinAccounts('minimaxcode');
  if (!accounts.length && !custom) {
    return {
      platform: 'minimaxcode',
      ok: false,
      status: 'unconfigured',
      message: `未检测到 ${cfg.name} 登录态，请先在控制台点「登录」完成 mcode 设备码授权。`,
      credits: 0,
      consecutiveDays: 0,
      today,
      time,
      accounts: [],
    };
  }

  if (!accounts.length) {
    accounts = [{ name: `mcode-${cfg.key}`, display: cfg.name, identity: `mcode:${cfg.key}`, region: cfg.key, active: true, source: '自定义 Token' }];
  }

  const results = [];
  for (const acct of accounts) {
    const label = acct.display || acct.name;
    try {
      const r = await checkinMiniMax(acct.region || cfg.key, acct.token ? acct : custom);
      results.push({ ...acct, ...r, label });
    } catch (err) {
      results.push({ ...acct, ok: false, status: 'failed', message: `请求异常：${err.message}`, credits: 0, consecutiveDays: 0, label });
    }
  }

  const okOnes = results.filter((r) => r.status === 'success');
  const badOnes = results.filter((r) => !['success', 'already', 'pending'].includes(r.status));
  return {
    platform: 'minimaxcode',
    ok: badOnes.length === 0,
    status: badOnes.length ? 'failed' : (okOnes.length ? 'success' : (results.some((r) => r.status === 'pending') ? 'pending' : 'already')),
    message: results.map((r) => (results.length > 1 ? `${r.label}：${r.message}` : r.message)).join('；'),
    credits: results.reduce((s, r) => s + (Number(r.credits) || 0), 0),
    consecutiveDays: results[0]?.consecutiveDays || 0,
    today,
    time,
    accounts: results.map((r) => ({
      name: r.name,
      display: r.label || r.name,
      identity: r.identity || '',
      active: !!r.active,
      status: r.status,
      message: r.message,
      credits: r.credits,
      consecutiveDays: r.consecutiveDays,
      source: r.source || r.credentialSource || '',
      credentialVersion: r.credentialVersion || '',
    })),
  };
}

/**
 * 把「worker 侧当前账号」与「今日已签快照」合成前端渲染用的账号行。
 *
 * 这是 2026-10-28 的核心修正：旧实现只要有今日快照就直接用快照，
 * 于是「上午 10:22 签完，13:00 在 worker 里加了个账号」这种再正常不过的操作，
 * 签到区会一直装作没看见，直到第二天才冒出来。
 * 新规则：
 *   · 账号集合以 **worker 档案 + 线上凭据**（实时扫描）为准；
 *   · 今日快照只负责给同身份的行补状态（已签/失败/积分），不决定行是否存在；
 *   · 实时有、快照没有 → 新增账号，pending；
 *   · 快照有、实时没有 → 凭据今日被删/被切走，仍保留一行并标记 stale，避免历史凭空消失。
 *
 * @param {Array<object>} liveAccounts listCheckinAccounts 的结果
 * @param {Array<object>} snapshotRows  state.platforms[plat].accounts
 * @param {string} platform
 */
function mergeAccountRows(liveAccounts, snapshotRows, platform) {
  const snaps = (Array.isArray(snapshotRows) ? snapshotRows : []).filter(Boolean);
  /** 快照行的匹配键：新快照带 identity；旧快照只有名字，靠平台规则归一 */
  const keysOf = (row) => {
    const keys = new Set();
    if (row.identity) keys.add(String(row.identity));
    if (row.name) keys.add(String(row.name));
    if (platform === 'minimaxcode') {
      // 老快照写的是 mcode-cn（= mcode:cn），实时行 identiy 也是 mcode:cn，归一后就能对上
      const m = String(row.name || '').match(/^mcode-(.+)$/);
      if (m) keys.add(`mcode:${m[1]}`);
    }
    return keys;
  };

  const used = new Set();
  const rows = [];
  for (const acct of liveAccounts) {
    let hit = null;
    const liveKeys = [acct.identity, acct.name].filter(Boolean).map(String);
    for (const s of snaps) {
      if (used.has(s)) continue;
      const k = keysOf(s);
      if (liveKeys.some((x) => k.has(x))) { hit = s; used.add(s); break; }
    }
    const base = {
      name: acct.name,
      display: acct.display || acct.name,
      identity: acct.identity || '',
      active: !!acct.active,
      source: acct.credentialSource || acct.source || '',
      ...(platform === 'minimaxcode' ? { credentialVersion: acct.credentialVersion || '' } : {}),
    };
    const replaced = platform === 'minimaxcode' && hit
      && ['expired', 'failed', 'unconfigured'].includes(hit.status)
      && base.credentialVersion && hit.credentialVersion !== base.credentialVersion;
    if (replaced) {
      rows.push({ ...base, status: 'pending', message: 'Worker 授权已更新 · 今日待打卡', fresh: true });
    } else if (hit) {
      rows.push({
        ...base,
        status: hit.status || 'pending',
        message: hit.message || '',
        credits: hit.credits,
        consecutiveDays: hit.consecutiveDays,
        // 凭据来源以签到当时的记录为准（说明这一行是谁签的）
        source: hit.source || base.source,
      });
    } else {
      rows.push({ ...base, status: 'pending', message: '新增账号 · 今日待打卡', fresh: true });
    }
  }

  const leftSnaps = snaps.filter((s) => !used.has(s));
  const unmatchedLive = rows.filter((r) => r.fresh);
  // meoo 的老快照记录的是「用户名」（Johhny），worker 档案名却是「meo-meoo_ak_」，两边名字天然对不上，
  // 而这一列在升级当天只会有 1 个账号，所以「两边各剩一行」必然是同一个号 —— 配起来，避免多出一行假新增。
  // 其它平台不做这种兜底配对：同日「删掉一个号 + 新加一个号」会被错配成同一个账号，宁可多一行。
  if (platform === 'meoo' && leftSnaps.length === 1 && unmatchedLive.length === 1) {
    const snap = leftSnaps.pop();
    const row = unmatchedLive[0];
    Object.assign(row, {
      // meoo 的快照里 display 是登录后拿到的用户名（Johhny），比「Meoo · meoo…5gIV」好认
      display: snap.display || row.display,
      status: snap.status || 'pending',
      message: snap.message || '',
      credits: snap.credits,
      consecutiveDays: snap.consecutiveDays,
      source: snap.source || row.source,
      fresh: false,
    });
  }
  for (const s of leftSnaps) {
    if (platform === 'minimaxcode' && !['success', 'already'].includes(s.status)) continue;
    rows.push({ ...s, stale: true, message: s.message || '凭据已不在 worker 账号里' });
  }
  return rows;
}

/**
 * 获取完整签到概览（供 WebUI 展示）
 */
export async function getCheckinOverview() {
  const state = await loadState();
  const creds = await detectCredentials();
  const today = getTodayStr();

  // 整理每个平台的前端渲染数据
  const platforms = {};
  for (const plat of ['workbuddy', 'codebuddy', 'traecode', 'codearts', 'qoder', 'qoder-cn', 'minimaxcode', 'meoo']) {
    const pState = state.platforms[plat] || {};
    const cInfo = creds[plat] || {};
    const isToday = pState.lastDate === today;

    // 账号行 = 实时账号集合（worker 档案 + CLI 凭据）∪ 今日快照状态。
    // 以前只要 isToday 就直接回放快照，导致「签完之后在 worker 里新加的账号」当天永远不出现。
    const accountRows = mergeAccountRows(
      await listCheckinAccounts(plat),
      isToday ? pState.accounts : [],
      plat,
    );
    // 还有几个账号今天没签成：前端据此把「今日已签」按钮改成「补签新增账号」
    // 平台处在「等下一期开窗」（Qoder 每天 0:00 / 10:00）时不算待补：那时候点也只会再拿到一次 pending，
    // 白让按钮闪一下，用户还以为漏签了。
    const waitingWindow = isToday && Number(pState.retryAt) > 0 && Math.floor(Date.now() / 1000) < Number(pState.retryAt);
    const pendingAccounts = waitingWindow
      ? 0
      : accountRows.filter((r) => ['pending', 'failed', 'expired'].includes(String(r.status))).length;

    platforms[plat] = {
      available: cInfo.available,
      source: cInfo.source || '未关联凭据',
      // cli = 直接复用已安装 CLI 的凭据（自动跟随 CLI 刷新）；custom = 手工配置；none = 没找到
      credentialMode: !cInfo.available ? 'none' : (String(cInfo.source || '').includes('CLI 实时') ? 'cli' : 'custom'),
      // WorkBuddy / CodeBuddy / Qoder / MiniMax Code 有 refreshToken，签到前会自动续期，不需要人管
      autoRefresh: ['workbuddy', 'codebuddy', 'qoder', 'qoder-cn', 'minimaxcode'].includes(plat) && cInfo.refreshable === true,
      lastDate: pState.lastDate || '无记录',
      lastTime: pState.lastTime || '',
      status: isToday ? pState.status : (cInfo.available ? 'pending' : 'unconfigured'),
      message: isToday ? pState.message : (cInfo.available ? '今日待打卡' : '未检测到有效凭据'),
      credits: pState.credits || '',
      consecutiveDays: pState.consecutiveDays || 0,
      accounts: accountRows,
      // >0 表示「今天还有账号没签成」——可能是刚在 worker 里加的，也可能是某个号失败了
      pendingAccounts,
      accountCount: accountRows.length,
    };
  }

  return {
    ok: true,
    today,
    autoCheckin: state.autoCheckin !== false,
    autoCheckinTime: state.autoCheckinTime || '08:30',
    platforms,
    history: (state.history || []).slice(0, 20),
    openSourceProjects: OPEN_SOURCE_PROJECTS
  };
}

/**
 * 今天还有「新账号没签」的平台列表。
 *
 * 场景：上午签完了，下午在 worker 面板里又加了一个账号 —— 它必须当天就能签，
 * 而不是等第二天定时任务。这里只认「今日快照里完全没有这个身份」的账号（fresh），
 * 已经尝试过并失败的不算：失败重试由平台级 retryCount 负责，否则每半小时都会把失败号重打一遍。
 *
 * @param {object} [state] 已加载的状态（省一次读盘）
 * @returns {Promise<string[]>}
 */
export async function pendingAccountPlatforms(state = null) {
  const st = state || (await loadState());
  const today = getTodayStr();
  const nowSec = Math.floor(Date.now() / 1000);
  const out = [];
  for (const plat of ['workbuddy', 'codebuddy', 'traecode', 'codearts', 'qoder', 'qoder-cn', 'minimaxcode', 'meoo']) {
    const p = st.platforms?.[plat] || {};
    // 平台自己约了时间（Qoder 每天 10:00 开新一期）就别提前空转
    if (p.retryAt && nowSec < Number(p.retryAt)) continue;
    const rows = mergeAccountRows(
      await listCheckinAccounts(plat),
      p.lastDate === today ? p.accounts : [],
      plat,
    );
    if (rows.some((r) => r.fresh)) out.push(plat);
  }
  return out;
}

/**
 * 一键清除签到日志。
 * 只清历史记录，不动各平台今日状态与凭据——这样「清日志」不会让卡片误以为今天没签。
 */
export async function clearCheckinHistory() {
  const state = await loadState();
  const removed = Array.isArray(state.history) ? state.history.length : 0;
  state.history = [];
  await saveState(state);
  return { ok: true, removed, overview: await getCheckinOverview() };
}

/**
 * 执行指定平台签到或一键全签
 * @param {'all'|'workbuddy'|'traecode'|'codearts'|'qoder'|'qoder-cn'} target
 */
export async function runCheckin(target = 'all') {
  const state = await loadState();
  const results = {};

  // due = 只补「今天还没签成」的平台（pending/failed），给「刷新状态」按钮用：
  // 以前刷新只重读一遍状态，昨天那期已领就一直显示已签，点多少次都不动。
  let only = null;
  if (target === 'due') {
    const today = getTodayStr();
    only = ['workbuddy', 'codebuddy', 'traecode', 'codearts', 'qoder', 'qoder-cn', 'minimaxcode', 'meoo'].filter((plat) => {
      const p = state.platforms[plat] || {};
      if (p.lastDate !== today) return true;
      if (p.retryAt && Math.floor(Date.now() / 1000) < Number(p.retryAt)) return false;
      return ['failed', 'pending'].includes(p.status) && (p.retryCount || 0) < 8;
    });
    // 已经签成、但 worker 里又新加了账号的平台：也要在「刷新/补签」里带上，
    // 否则新账号当天永远签不到（旧逻辑只看平台级状态，账号级新增完全看不见）。
    const fresh = await pendingAccountPlatforms(state);
    only = [...new Set([...only, ...fresh])];
    if (!only.length) return { ok: true, results: {}, due: [], overview: await getCheckinOverview() };
  }
  const want = (plat) => (only ? only.includes(plat) : (target === 'all' || target === plat));

  if (want('workbuddy')) {
    results.workbuddy = await checkinWorkBuddy();
  }
  if (want('codebuddy')) {
    results.codebuddy = await checkinCodeBuddy();
  }
  if (want('traecode')) {
    results.traecode = await checkinTrae();
  }
  if (want('codearts')) {
    results.codearts = await checkinCodeArts();
  }
  if (want('qoder')) {
    results.qoder = await checkinQoder('qoder');
  }
  if (want('qoder-cn')) {
    results['qoder-cn'] = await checkinQoder('qoder-cn');
  }
  if (want('minimaxcode')) {
    results.minimaxcode = await checkinMiniMaxPlatform('cn');
  }
  if (want('meoo')) {
    results.meoo = await checkinMeoo();
  }

  // 记录状态与审计历史
  for (const [plat, res] of Object.entries(results)) {
    const prev = state.platforms[plat] || {};
    const failed = !['success', 'already'].includes(res.status);
    state.platforms[plat] = {
      lastDate: res.today,
      lastTime: res.time,
      status: res.status,
      message: res.message,
      credits: res.credits || '',
      consecutiveDays: res.consecutiveDays || (prev.consecutiveDays || 0),
      accounts: res.accounts || [],
      // 同一天内的失败重试计数：定时器据此决定要不要隔半小时再试一次。
      // 旧逻辑只看 lastDate，失败一次就把今天标成「已处理」，9074 这类
      // 服务端排队错误再也没机会重试。成功后清零。
      retryCount: failed ? (prev.lastDate === res.today ? (prev.retryCount || 0) + 1 : 1) : 0,
      // 平台自己给出「几点再来」（Qoder 每天 10:00 开新一期）：到点前定时器不空转
      retryAt: res.retryAt || 0
    };
    state.history.unshift({
      time: `${res.today} ${res.time}`,
      platform: plat,
      status: res.status,
      message: res.message
    });
  }

  // 限制历史最多 50 条
  if (state.history.length > 50) {
    state.history = state.history.slice(0, 50);
  }

  await saveState(state);
  return { ok: true, results, overview: await getCheckinOverview() };
}

/**
 * 保存配置（自定义 Token、定时打卡设置等）
 */
export async function updateCheckinConfig(config) {
  const state = await loadState();
  if (typeof config.autoCheckin === 'boolean') {
    state.autoCheckin = config.autoCheckin;
  }
  if (typeof config.autoCheckinTime === 'string') {
    state.autoCheckinTime = config.autoCheckinTime;
  }
  if (config.customTokens && typeof config.customTokens === 'object') {
    state.customTokens = {
      ...state.customTokens,
      ...config.customTokens
    };
  }
  await saveState(state);
  return { ok: true, overview: await getCheckinOverview() };
}

/**
 * 后台定时自动签到调度器
 */
let autoCheckinTimer = null;
export function startAutoCheckinScheduler() {
  if (autoCheckinTimer) return;

  // 每 30 分钟检查一次是否到达签到时间或尚未今日打卡
  autoCheckinTimer = setInterval(async () => {
    try {
      const state = await loadState();
      if (!state.autoCheckin) return;

      const today = getTodayStr();
      // 只补「还没签」和「今天没签成」的平台：
      // 前者是首次触发；后者给限流/网络抖动/等 10:00 开窗留重试机会（每天最多 8 次，约 4 小时）。
      // pending 必须一起重试：Qoder 每天 10:00 才开新一期，08:30 那次只能标 pending。
      // 旧实现只要有一个平台没签就 runCheckin('all')，会把已签成的平台又打一遍。
      const pending = ['workbuddy', 'traecode', 'codearts', 'qoder', 'qoder-cn', 'minimaxcode', 'meoo'].filter((plat) => {
        const p = state.platforms[plat] || {};
        if (p.lastDate !== today) return true;
        // 平台自己约了时间（如 Qoder 10:00 开窗）就别提前空转
        if (p.retryAt && Math.floor(Date.now() / 1000) < Number(p.retryAt)) return false;
        return ['failed', 'pending'].includes(p.status) && (p.retryCount || 0) < 8;
      });
      // worker 侧新增的账号同样要当天补签（只补「从没签过」的，失败重试仍归 retryCount 管）
      for (const plat of await pendingAccountPlatforms(state)) {
        if (!pending.includes(plat)) pending.push(plat);
      }
      if (pending.length) {
        console.log(`[Checkin] 触发定时签到（待处理: ${pending.join(', ')}）...`);
        for (const plat of pending) await runCheckin(plat);
      }
    } catch (e) {
      console.error('[Checkin] 自动打卡定时器异常:', e.message);
    }
  }, 30 * 60 * 1000);
  // unref：调度器不参与事件循环保活，否则 dispose/测试结束后进程无法自然退出
  autoCheckinTimer.unref?.();
}

/** 停止后台调度器（server.dispose 调用；停止后可重新 start） */
export function stopAutoCheckinScheduler() {
  if (!autoCheckinTimer) return;
  clearInterval(autoCheckinTimer);
  autoCheckinTimer = null;
}
