// @ts-check
// Multi-Agent Hub 平台每日签到与福利中枢
// 支持 WorkBuddy、Trae (免客户端直签)、CodeArts (华为云码道) 自动化打卡与多账号福利领取
// 接口参考开源逆向成果与无客户端实现

import { readFile, writeFile, mkdir, readdir, stat, rename, copyFile, utimes, rm } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, dirname, resolve, basename } from 'node:path';
import { randomUUID, createHash, createHmac } from 'node:crypto';
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fetchJsonSmart, hwsSdkSignedHeaders as codeArtsSignedHeaders } from './vendor-quota.mjs';
import { findCodeBuddySharedAuth, isMutableIdentity } from './accounts.mjs';
import {
  readQoderCredential, readQoderCredentialAt, refreshQoderToken, persistQoderToken,
  listQoderCampaigns, claimQoderCampaign, isQoderTokenExpired, qoderRegion,
} from './qoder.mjs';
import { resolveQoderDevice } from './qoder-device.mjs';
import { checkinTraeAccount, readTraeDesktopAuth, readTraeTokenCache, jwtUid } from './trae-checkin.mjs';
import { checkinDoubao, listDoubaoAccounts, readDoubaoLogin } from './doubao-checkin.mjs';
import { checkinMiniMax, fetchMiniMaxSignin, readMinimaxCredential, readMinimaxCredentialFile, minimaxCredentialVersion, MINIMAX_REGIONS } from './minimax-checkin.mjs';
// Qoder 活动窗口/领取判定助手（C2-W3 搬到 qoder-activity.mjs，逻辑未改）；对外名字继续从本模块 re-export
import {
  QODER_BENEFIT_ACTION, extractQoderCampaigns, qoderAuthDead, qoderBenefit, qoderClaimedToday,
  qoderClaimOutcome, qoderClaimStatus, qoderClock, qoderClockDay, qoderDayKey, qoderEpoch, qoderInWindow,
  qoderNextWindowStart, qoderOpenWindow, qoderPendingWindow, qoderPollAt, qoderQuotaCooldown,
  qoderResponseMessage, qoderTodayWindowStart, qoderWindowDay,
} from './qoder-activity.mjs';

export {
  extractQoderCampaigns, qoderAuthDead, qoderClaimedToday, qoderClaimOutcome, qoderClock, qoderClockDay,
  qoderEpoch, qoderInWindow, qoderNextWindowStart, qoderOpenWindow, qoderPendingWindow, qoderPollAt,
  qoderQuotaCooldown, qoderTodayWindowStart, qoderWindowDay,
} from './qoder-activity.mjs';

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
      description: '腾讯 CodeBuddy 国际版，通过活跃上报（/v2/report）+ 网页会话（/console/as/conversations/）完成每日活跃，并以积分到账为准判定成功。',
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
      description: 'Qoder 每日签到脚本（中国版 / 国际版），本项目的签到链路移植自该项目：CLAIM_BENEFIT 定向活动筛选、本机 UMID 组件生成的设备风控头与 token 续期。',
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
  ],
  doubao: [
    {
      name: 'wangmingdong/workbuddy-signin',
      url: 'https://github.com/wangmingdong/workbuddy-signin',
      description: '豆包每日签到参考（MIT）：写接口强制 a_bogus 浏览器签名，必须在真实浏览器页面里 fetch；签到页用 SamanthaDoubao 客户端 UA 点「立即签到」，任务面板只领已完成的任务。本项目把浏览器放在云机，经国内出口访问。',
      tags: ['浏览器实时签名', 'a_bogus', '扫码登录', '云机浏览器']
    }
  ]
};

/** @returns {Promise<object>} */
async function loadState() {
  let raw;
  try {
    raw = await readFile(STATE_FILE, 'utf-8');
  } catch (err) {
    // 文件不存在 = 首次运行，可以返回默认值；其它读取错误不能静默当成空状态。
    if (err?.code !== 'ENOENT') throw err;
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
  try {
    return JSON.parse(raw.replace(/^\uFEFF/, ''));
  } catch (err) {
    // 半截 JSON 不能当成「没有状态」：那会把所有平台状态和手工 Token 静默清空。
    // 留一份带时间戳的现场副本，方便人工恢复，也不会被下一次保存覆盖。
    await copyFile(STATE_FILE, `${STATE_FILE}.corrupt-${Date.now()}`).catch(() => {});
    throw new Error(`签到状态文件损坏（${STATE_FILE}）：${err.message}`);
  }
}

/** @param {object} state */
async function saveState(state) {
  try {
    await mkdir(dirname(STATE_FILE), { recursive: true });
    // 先写同目录临时文件再原子替换，避免轮询读到半截 JSON；
    // 临时文件带 pid/时间，多个进程同时写也不会互相截断。
    const temp = `${STATE_FILE}.tmp-${process.pid}-${Date.now()}`;
    await writeFile(temp, JSON.stringify(state, null, 2) + '\n', 'utf-8');
    await rename(temp, STATE_FILE);
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
    meoo: { available: false, source: '', ak: '', token: '' },
    // 豆包没有 CLI 凭据：登录态只在云机浏览器 profile 里，这里只看「是否已扫码登录」的缓存
    doubao: { available: false, source: '', token: '' }
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

  const doubaoLogin = await readDoubaoLogin();
  if (doubaoLogin.loggedIn) creds.doubao = { available: true, source: '云机浏览器登录态（豆包 App 扫码）', token: '' };

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
  // 豆包不是 worker：账号就是云机浏览器里扫码登录的那一个（listCheckinAccounts 单独处理）
  doubao: [],
};

/**
 * 参与签到的平台总表（唯一事实来源）。
 *
 * 自动调度器、「补签」、账号补签三处必须用同一份清单：
 * 早先自动调度器手写了一份列表，**漏掉了 'codebuddy'（国际版）**，
 * 结果国际版失败一次后当天再没有重试机会（账号补签只认「从没签过的新账号」，
 * 失败过的账号不归它管）。
 */
export const CHECKIN_PLATFORMS = Object.keys(PLATFORM_WORKERS);

/**
 * 每个平台每天最多重试多少次（通用 8 次 ≈ 4 小时，够覆盖一次网络抖动）。
 *
 * Qoder 需要放宽：它的每日活动行是「窗口内随时可能下发」的，开窗后要一直补拉到窗口关闭，
 * 一天下来十几次（开窗 1 小时内每 10 分钟 + 之后每小时）。8 次预算会在窗口中途就耗光，
 * 后面连**下一期开窗**都进不去（实测 2026-11-02 的 retryCount 已经用到 4/8，
 * 而那一期的窗口 09:59 才关 —— 预算耗光 = 这期 100 Credits 白丢）。
 */
export const CHECKIN_RETRY_BUDGET = { qoder: 32, 'qoder-cn': 32 };
export const retryBudgetFor = (plat) => CHECKIN_RETRY_BUDGET[plat] || 8;

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
  if (platform === 'doubao') return listDoubaoAccounts();
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

// ---------------------------------------------------------------- CodeBuddy 国际版：活跃打卡
//
// ⚠️ 这一段曾经踩过三个实打实的坑，现在**整条 CLI 路径已经删掉**，原因记在这里免得有人改回去：
//
// 1) CLI 的登录态在 **XDG 共享存储** 里（$HOME/.local/share/CodeBuddyExtension/Data/Public/auth/
//    Tencent-Cloud.coding-copilot.info），**不是** CODEBUDDY_CONFIG_DIR/auth.info。
//    诱饵实测：cfg 里放 A 号、共享存储放 B 号，CLI 认的是 B 号。
//
// 2) 走 ~/.local/bin/codebuddy-intl 包装器 = 永远用默认账号（AC_intl_dir=$HOME/.codebuddy）。
//    旧实现正是这样，于是「henrybaker 档案」那一行照样报签到成功，实际打的却是 johhny.xks，
//    另一个账号的活跃根本没记上——本地假成功，上游没生效。
//
// 3) 就算绕开包装器、自搭沙箱，「调模型发你好」也只是**保活对话**：上游的「当日活跃」计数
//    根本不认它（issue #277），所以它永远换不到积分。
//
// 现在国际版改走**上游真正认的那两发**（活跃上报 + 网页会话），全程用该账号自己的
// Bearer token，账号归属由构造保证，不再需要靠 CLI 日志反查「这一枪打到了谁」。

/** 读 auth.info 里的账号标识：uid（= JWT sub）与邮箱（= account.nickname） */
async function readCodeBuddyAccountInfo(file) {
  if (!file) return { uid: '', email: '' };
  try {
    const doc = JSON.parse((await readFile(file, 'utf-8')).replace(/^\uFEFF/, ''));
    const pl = jwtPayload(String(doc?.auth?.accessToken || '')) || {};
    return {
      uid: String(doc?.account?.uid || pl.sub || '').trim(),
      email: String(doc?.account?.nickname || pl.email || pl.preferred_username || '').trim(),
    };
  } catch { return { uid: '', email: '' }; }
}

/**
 * 读账号当前的积分/资源快照。
 *
 * 活跃成功的唯一依据是**积分到账**：上游会在活跃成功后发一次积分，
 * 能在插件同一套接口里看到（插件配额面板用的就是它）：
 *   POST https://www.codebuddy.ai/v2/billing/meter/get-user-resource
 * 只看「模型有没有回话」或「链路有没有返回 200」都会误判——
 * 旧实现就是用回话判成功，于是打成别的账号也算成功，而上游根本没给那个号发积分。
 */
async function fetchCodeBuddyCredits(token, domain = 'www.codebuddy.ai') {
  if (!token) return null;
  try {
    const res = await fetchJsonSmart(`https://${domain}/v2/billing/meter/get-user-resource`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: '{}',
    }, 15_000);
    if (!res.ok || res.json?.code !== 0) return null;
    const data = res.json?.data?.Response?.Data || {};
    const accounts = Array.isArray(data.Accounts) ? data.Accounts : [];
    const nowMs = Date.now();
    // 已彻底过期的包不算（否则「历史包被消耗」会被误读成积分变化）
    const alive = accounts.filter((a) => {
      const de = Number(a.DeductionEndTime);
      return !Number.isFinite(de) || !de || de > nowMs;
    });
    const packs = alive.map((a) => ({
      id: String(a.AccountId ?? ''),
      name: String(a.PackageName || a.SubProductName || ''),
      size: Number(a.CapacitySize) || 0,
      remain: Number(a.CapacityRemain) || 0,
      used: Number(a.CapacityUsed) || 0,
      created: Number(a.CreateTime) || 0,
      end: Number(a.DeductionEndTime) || 0,
    }));
    return {
      count: Number(data.TotalCount) || 0,
      dosage: Number(data.TotalDosage) || 0,
      packs,
      packCount: packs.length,
      creditsRemain: packs.reduce((s, p) => s + p.remain, 0),
    };
  } catch {
    return null;
  }
}

/**
 * 积分是否到账：资源向量出现**正向**变化。
 * 只认增加（新包 / 额度变大 / 总量上升 / 剩余积分变多）；
 * 消耗（额度变小）不算到账。
 */
export function codeBuddyCreditsArrived(before, after) {
  if (!before || !after) return false;
  if (after.count > before.count) return true;
  if (after.dosage > before.dosage) return true;
  if (after.creditsRemain > before.creditsRemain) return true;
  const beforeIds = new Set(before.packs.map((p) => p.id));
  if (after.packs.some((p) => p.id && !beforeIds.has(p.id))) return true;
  const old = new Map(before.packs.map((p) => [p.id, p]));
  return after.packs.some((p) => {
    const o = old.get(p.id);
    return !!o && (p.remain > o.remain || p.size > o.size);
  });
}

// en-CA 的日期就是 YYYY-MM-DD
const SHANGHAI_DATE = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai' });

/**
 * 用户口径（2026-11-10）：活跃成功 = **额度包**到账，剩余积分变多、dosage 变大不再单独算成功。
 *   1) 签到后出现 before 没有的包 id（上游新发的包）；
 *   2) 或当天是每月 1 号（Asia/Shanghai）且 after 里有一个未过期、过期时间落在下月 1 号（Asia/Shanghai）的包——
 *      月包可能在签到前就已发放、基线里已有它，换期当天只能靠「下月 1 号到期」认领；
 *      上游也有用 23:59:59 表示下月 1 号 00:00:00 的，零点前 1 秒以内一并接受。
 * 旧口径 codeBuddyCreditsArrived 保留不删（别处/测试在用）。
 */
export function codeBuddyPackGranted(before, after, now = new Date()) {
  if (!before || !after) return false;
  const beforeIds = new Set((before.packs || []).map((p) => p.id));
  if ((after.packs || []).some((p) => p.id && !beforeIds.has(p.id))) return true;
  const [y, m, d] = SHANGHAI_DATE.format(now).split('-').map(Number);
  if (d !== 1) return false;
  const ny = m === 12 ? y + 1 : y;
  const nm = m === 12 ? 1 : m + 1;
  const firstOfNext = `${ny}-${String(nm).padStart(2, '0')}-01`;
  // Asia/Shanghai 全年固定 UTC+8（无夏令时），下月 1 号的上海零点就落在这个 UTC 时刻
  const midnightMs = Date.UTC(ny, nm - 1, 1) - 8 * 60 * 60 * 1000;
  return (after.packs || []).some((p) => {
    if (!p.end || p.end <= now.getTime()) return false;
    return SHANGHAI_DATE.format(new Date(p.end)) === firstOfNext
      || (p.end >= midnightMs - 1000 && p.end < midnightMs);
  });
}

/** 用户口径：5 分钟内积分没到账，就当活跃没成功 */
const CODEBUDDY_CREDIT_WAIT_MS = 5 * 60 * 1000;
const CODEBUDDY_CREDIT_POLL_MS = 15 * 1000;

// ---------------------------------------------------------------- CodeBuddy 国际版：活跃链路
//
// 参考实现：https://github.com/L0NE-6/WorkBuddy-Daily（workbuddy_intl_daily.py，v3.9 起对齐上游 3.0.4–3.0.8）
//
// 国际版的「每日活跃」**不是**调模型换积分，而是一组事件上报：
//   1) POST /billing/meter/checkin-activity-status   探测签到活动是否开放、今天是否已领
//      ⚠️ 这个端点**没有 /v2 前缀**。旧的 /v2/billing/meter/checkin-status 是废弃口径，
//      恒返回 active=false / 全 0 积分，拿它判断会让「活动其实开着」也被误判成关闭。
//   2) POST /v2/billing/meter/daily-checkin           活动开放且今日未领时领取
//   3) POST /v2/report                                 活跃上报（chat_request_send）→ 点亮成长中心连登
//      GET  /activity/growth/streak                    回读连登天数
//   4) POST /console/as/conversations/                 网页会话 → 上游「当日活跃」计数只认这一发
//      （issue #277：桌面端对话与 /v2/report 都不进这个计数）
//   5) POST /v2/chat/completions                       保活对话（只维持「账号有调用」，**不算**当日活跃）
//
// 上游口径（v3.0.8）：活跃上报或网页会话任一成功即算当日活跃完成，积分由上游异步发放。
// 本实现仍以**积分到账**为唯一成功判据（用户口径：5 分钟内没到账 = 活跃没成功）。

const CODEBUDDY_INTL_UA = 'WorkBuddy/5.5.2 WorkBuddy AI/5.5.2 CLI/2.137.1';
const CODEBUDDY_CHAT_UA = 'WorkBuddy/5.8.4 workbuddy-ai/5.8.4 CLI/2.161.0';
const CODEBUDDY_WEB_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 '
  + '(KHTML, like Gecko) Chrome/152.0.0.0 Safari/537.36';
/** 保活 / 网页会话共用的免费模型链（可用 CODEBUDDY_ACTIVITY_MODELS 覆盖） */
const CODEBUDDY_ACTIVITY_MODELS = (process.env.CODEBUDDY_ACTIVITY_MODELS
  || 'deepseek-v4.1-flash,hy3,hy4-preview,hy4-preview-f')
  .split(',').map((s) => s.trim()).filter(Boolean);

/** 国际版通用请求头族（对齐官方客户端 5.5.2） */
function codeBuddyIntlHeaders(token, uid = '', extra = {}) {
  const h = {
    Accept: 'application/json',
    'Content-Type': 'application/json',
    Authorization: `Bearer ${token}`,
    'User-Agent': CODEBUDDY_INTL_UA,
    'X-IDE-Type': 'WorkBuddy',
    'X-IDE-Name': 'WorkBuddy AI',
    'X-IDE-Version': '5.5.2',
    'X-Product': 'WorkBuddy AI',
  };
  if (uid) h['X-User-Id'] = uid;
  return { ...h, ...extra };
}

/**
 * 国际版签到活动状态（正确端点：/billing/meter/checkin-activity-status，无 /v2 前缀）。
 * 字段：active=活动是否开放、today_checked_in=今天是否已领、
 *       daily_credit/today_credit=每日与今日的奖励额度、total_credits=活动累计发放、streak_days=活动连签。
 */
async function fetchCodeBuddyActivityStatus(token, domain = 'www.codebuddy.ai', uid = '') {
  if (!token) return null;
  try {
    const res = await fetchJsonSmart(`https://${domain}/billing/meter/checkin-activity-status`, {
      method: 'POST',
      headers: codeBuddyIntlHeaders(token, uid),
      body: '{}',
    }, 15_000);
    if (!res.ok || res.json?.code !== 0) return null;
    const d = res.json?.data || {};
    return {
      active: !!d.active,
      todayCheckedIn: !!d.today_checked_in,
      dailyCredit: Number(d.daily_credit) || 0,
      todayCredit: Number(d.today_credit) || 0,
      totalCredits: Number(d.total_credits) || 0,
      streakDays: Number(d.streak_days) || 0,
      isStreakDay: !!d.is_streak_day,
    };
  } catch {
    return null;
  }
}

/** 账号级风控：11140 / request illegal（国际版命中后要停掉该账号本轮） */
export function isCodeBuddyAccountRestricted(status, payload) {
  const code = payload?.code;
  if (code === 11140 || code === '11140') return true;
  const blob = JSON.stringify(payload ?? '').toLowerCase();
  const markers = ['11140', 'account restricted', 'request illegal', '账号受限', '账号被限制', '账户受限'];
  return Number(status) === 403 && markers.some((m) => blob.includes(m));
}

/** 活跃上报事件（chat_request_send，官方客户端同形状；userId 必填，缺了会被上游静默丢弃） */
export function buildCodeBuddyActivityEvent(uid) {
  const nowMs = Date.now();
  const cid = `wbintl-${randomUUID().replace(/-/g, '')}`;
  return {
    eventCode: 'chat_request_send',
    timestamp: nowMs,
    reportDelay: 0,
    mode: 'craft',
    conversationId: cid,
    requestId: cid,
    inputLength: 12,
    requestModelId: 'deepseek-v4.1-flash',
    requestModelName: 'DeepSeek V4.1 Flash',
    isPlan: false,
    isAutoExecuteTerminal: false,
    isAutoModify: false,
    codebaseEnable: false,
    maxToken: 0,
    maxSteps: 0,
    temperature: 0,
    maxRetries: 0,
    mentionContexts: [],
    knowledgeId: [],
    knowledgeName: [],
    codebaseId: '',
    mentionContextCount: 0,
    command: '',
    expertId: '',
    recommendId: '',
    skillId: '',
    skillCount: 0,
    totalCount: 0,
    fileUri: '',
    presentAt: nowMs,
    traceId: '',
    rootRequestId: cid,
    parentConversationId: cid,
    agentName: 'default',
    agentType: 'conversation',
    userId: String(uid || ''),
  };
}

/** 回读成长中心连登天数 */
async function fetchCodeBuddyStreakDays(token, uid, domain = 'www.codebuddy.ai') {
  try {
    const res = await fetchJsonSmart(`https://${domain}/activity/growth/streak`, {
      method: 'GET',
      headers: codeBuddyIntlHeaders(token, uid),
    }, 20_000);
    if (!res.ok || res.json?.code !== 0) return null;
    const days = Number(res.json?.data?.streak?.days);
    return Number.isFinite(days) ? days : null;
  } catch {
    return null;
  }
}

/** 活跃上报（/v2/report）：点亮成长中心「连登」的唯一通道 */
async function reportCodeBuddyActivity(token, uid, domain = 'www.codebuddy.ai') {
  if (!uid) return { ok: false, note: '缺少账号 uid，无法上报活跃' };
  try {
    const res = await fetchJsonSmart(`https://${domain}/v2/report`, {
      method: 'POST',
      headers: codeBuddyIntlHeaders(token, uid),
      body: JSON.stringify([buildCodeBuddyActivityEvent(uid)]),
    }, 25_000);
    const json = res.json || {};
    if (!res.ok || (json.code !== 0 && json.code !== undefined)) {
      return {
        ok: false,
        note: `HTTP ${res.status} code=${json.code ?? '-'}`,
        restricted: isCodeBuddyAccountRestricted(res.status, json),
      };
    }
    const days = await fetchCodeBuddyStreakDays(token, uid, domain);
    return {
      ok: true,
      note: days == null ? '活跃上报成功' : `活跃上报成功，连登 ${days} 天`,
      days,
    };
  } catch (err) {
    return { ok: false, note: `请求异常：${err.message}` };
  }
}

/** 网页会话（/console/as/conversations/）：上游「当日活跃」计数只认这一发 */
async function createCodeBuddyWebConversation(token, uid, domain = 'www.codebuddy.ai') {
  if (!uid) return { ok: false, note: '缺少账号 uid，无法建网页会话' };
  let last = '网页会话创建失败（模型链全部未建成）';
  for (const model of CODEBUDDY_ACTIVITY_MODELS) {
    const body = {
      prompt: 'Hi',
      model,
      conversationOrigin: 'workbuddy-app',
      plugins: [{ name: 'weixinpay', marketplace: 'codebuddy-builtin' }],
    };
    try {
      const res = await fetchJsonSmart(`https://${domain}/console/as/conversations/`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json, text/plain, */*',
          'User-Agent': CODEBUDDY_WEB_UA,
          Origin: `https://${domain}`,
          Referer: `https://${domain}/app`,
          Authorization: `Bearer ${token}`,
          'X-User-Id': uid,
        },
        body: JSON.stringify(body),
      }, 40_000);
      const json = res.json || {};
      const data = json.data && typeof json.data === 'object' ? json.data : {};
      if (res.ok && (json.code === 0 || json.code === undefined) && data.id) {
        return { ok: true, note: '网页会话已创建', model, conversationId: String(data.id) };
      }
      last = `HTTP ${res.status} code=${json.code ?? '-'}`;
      if (isCodeBuddyAccountRestricted(res.status, json)) return { ok: false, note: last, restricted: true };
    } catch (err) {
      last = `请求异常：${err.message}`;
    }
  }
  return { ok: false, note: last };
}

/** 对话链路请求头族（对齐国际版客户端 5.8.4；渠道校验 11-128 按这组头识别客户端） */
function codeBuddyChatHeaders(token, uid, domain = 'www.codebuddy.ai') {
  const conversationId = randomUUID();
  const requestId = randomUUID().replace(/-/g, '');
  const messageId = randomUUID().replace(/-/g, '');
  const traceId = randomUUID().replace(/-/g, '');
  const spanId = randomUUID().replace(/-/g, '').slice(0, 16);
  const h = {
    'Content-Type': 'application/json',
    Accept: 'text/event-stream',
    'User-Agent': CODEBUDDY_CHAT_UA,
    'X-IDE-Type': 'WorkBuddy',
    'X-IDE-Name': 'WorkBuddy',
    'X-IDE-Version': '5.8.4',
    'X-Product': 'SaaS',
    'X-Agent-Intent': 'craft',
    'X-Agent-Purpose': 'conversation',
    'X-Agent-Type': 'main',
    'X-Private-Data': 'true',
    'X-Conversation-ID': conversationId,
    'X-Conversation-Request-ID': requestId,
    'X-Root-Request-ID': requestId,
    'X-Conversation-Message-ID': messageId,
    'X-Request-ID': messageId,
    'X-Trace-ID': traceId,
    traceparent: `00-${traceId}-${spanId}-01`,
    b3: `${traceId}-${spanId}-1`,
    'X-B3-TraceId': traceId,
    'X-B3-SpanId': spanId,
    'X-B3-Sampled': '1',
    'Accept-Language': 'en-US',
    'X-Requested-With': 'XMLHttpRequest',
    'X-CodeBuddy-Request': '1',
    Origin: `https://${domain}`,
    Referer: `https://${domain}/`,
    'X-Domain': domain,
    Authorization: `Bearer ${token}`,
  };
  if (uid) h['X-User-Id'] = uid;
  return h;
}

/**
 * 保活对话：只维持「账号有调用」。
 * ⚠️ 上游口径：**只保活对话成功不算当日活跃**（它不进「当日活跃」计数，也不点亮连登）。
 */
async function keepaliveCodeBuddyChat(token, uid, domain = 'www.codebuddy.ai') {
  let last = '未知错误';
  for (const model of CODEBUDDY_ACTIVITY_MODELS) {
    const body = {
      model,
      stream: false,
      max_tokens: 16,
      messages: [
        { role: 'system', content: 'You are a helpful assistant.' },
        { role: 'user', content: 'hi' },
      ],
    };
    try {
      const res = await fetchJsonSmart(`https://${domain}/v2/chat/completions`, {
        method: 'POST',
        headers: codeBuddyChatHeaders(token, uid, domain),
        body: JSON.stringify(body),
      }, 60_000);
      if (res.ok) return { ok: true, note: `保活成功（${model}）` };
      if (res.status === 403) {
        last = 'HTTP 403（模型无权限，非账号风控）';
        continue;
      }
      last = `HTTP ${res.status}`;
    } catch (err) {
      last = `请求异常：${err.message}`;
    }
  }
  return { ok: false, note: last };
}

/**
 * 国际版官方签到接口（同国内版 daily-checkin）。
 * 活动未开启时上游返回 code=10001「签到活动未开启或已过期」。
 */
async function claimCodeBuddyCheckin(token, domain = 'www.codebuddy.ai') {
  if (!token) return { ok: false, code: 0, msg: '无凭据' };
  try {
    const res = await fetchJsonSmart(`https://${domain}/v2/billing/meter/daily-checkin`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        'X-Domain': 'codebuddy.ai',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) CodeBuddy/1.0.0',
        Accept: 'application/json',
      },
      body: '{}',
    }, 15_000);
    const json = res.json || {};
    const data = json?.data || {};
    const msg = String(json.msg || json.message || '');
    if (!res.ok || json.code !== 0) {
      return { ok: false, code: Number(json.code) || res.status, msg: msg || `HTTP ${res.status}`, data };
    }
    return {
      ok: true,
      code: 0,
      msg,
      credit: Number(data.credit ?? data.today_credit ?? 0) || 0,
      streakDays: Number(data.streak_days) || 0,
      data,
    };
  } catch (err) {
    return { ok: false, code: -1, msg: `请求异常：${err.message}` };
  }
}

/**
 * 活动是否处于「未开启/已结束」状态（决定要不要白等 5 分钟）。
 * 口径以**正确端点** checkin-activity-status 的 active 为准；
 * 官方领取接口的错误码/文案只作补充（10001=未开启或已过期，41000=未开始或已结束）。
 */
function codeBuddyCampaignClosed(claim, status) {
  const code = Number(claim?.code) || 0;
  if (code === 10001 || code === 41000) return true;
  const msg = String(claim?.msg || '');
  if (/未开启|已过期|未开始|已结束/.test(msg)) return true;
  if (status && status.active === false && !status.todayCheckedIn) return true;
  return false;
}

/**
 * 国际版打卡的**判定**（纯函数，便于单测）。
 *
 * 输入：活动状态 + 官方领取结果 + 活跃链路各腿结果 + 积分基线；
 * 输出：status / message / 是否去等积分。
 *
 * 口径（用户）：**积分到账才算成功**，5 分钟内没到账即视为没成功。
 * 这里只负责「该不该去等积分」——等不等由 actStatus 决定：
 * 活动压根没开 → 上游没有奖励可发 → 不白等 5 分钟，记 pending。
 */
export function decideCodeBuddyOutcome({ actStatus, claim, report, web, keep, creditsBefore } = {}) {
  const chainOk = !!(report?.ok || web?.ok);
  const chainNote = [
    report?.ok
      ? `活跃上报成功${report.days != null ? `（连登 ${report.days} 天）` : ''}`
      : `活跃上报未成功（${report?.note || '未知'}）`,
    web?.ok ? '网页会话已建' : `网页会话未建（${web?.note || '未知'}）`,
  ].join('，');
  const keepNote = keep
    ? (keep.ok ? '保活对话成功（仅维持账号有调用，不计入活跃）' : `保活对话未成功（${keep.note}）`)
    : '';

  // 上游口径：活跃上报或网页会话任一成功即算当日活跃完成；
  // 两发都没成功 → 当日活跃没点亮。
  if (!chainOk) {
    return {
      status: 'failed',
      message: `活跃链路未点亮：${chainNote}${keepNote ? `；${keepNote}` : ''}。当日活跃只认「活跃上报」或「网页会话」，调模型不算`,
      credits: 0,
    };
  }

  const campaignClosed = codeBuddyCampaignClosed(claim, actStatus);
  if (campaignClosed) {
    return {
      status: 'pending',
      message: `签到活动未开启或已过期（${claim?.msg || 'active=false'}）；活跃链路已完成（${chainNote}），上游积分异步发放，待活动开启后重试`,
      credits: 0,
      campaignClosed: true,
      pendingReason: 'campaign_closed',
      // 上游活动没开的开启时间未知：约 3 小时后再探一次。
      // 不这么设的话，8 次/天的重试预算会被「活动没开」这种空转迅速耗光，
      // 活动万一中途开启反而没机会了（实测已经用到 6/8）。
      retryAt: Math.floor(Date.now() / 1000) + 3 * 3600,
    };
  }

  // 读不到积分基线就没法判断到账，不能自称成功（用户口径：只有积分到账才算）
  if (!creditsBefore) {
    return {
      status: 'pending',
      message: `活跃链路已完成（${chainNote}）；但积分接口读取失败，本次未能确认到账，稍后重试`,
      credits: 0,
      pendingReason: 'await_credits',
    };
  }

  return {
    status: 'success',
    message: `活跃链路已完成（${chainNote}）${claim?.ok ? '，官方签到已受理' : ''}，待确认积分到账`,
    credits: '活跃+1',
    creditsBefore,
    awaitCredits: true,
  };
}

/**
 * 单个 CodeBuddy 国际版账号打卡。
 *
 * 判定口径（用户）：**积分到账才算活跃成功**，5 分钟内没到账即视为没成功。
 * 触发方式（上游口径，见上方「活跃链路」注释）：
 *   探测活动 → 活动开着就领官方签到 → 活跃上报(/v2/report) + 网页会话(/console/as/conversations/)
 *   → 平台层统一轮询 5 分钟看积分到账。
 *
 * ⚠️ 旧实现拿「调模型发你好」当活跃触发——那只是**保活对话**，上游的「当日活跃」计数不认它，
 *    所以永远换不到积分（旧实现还因此报了一堆假成功）。现在换成上游真正认的那两发。
 */
async function checkinCodeBuddyOne(acct) {
  // 允许通过环境变量或测试钩子模拟打卡成功
  if (process.env.CODEBUDDY_CHECKIN_MOCK_SUCCESS === '1') {
    return {
      ok: true,
      status: 'success',
      message: '签到成功（测试钩子：活跃上报与网页会话均已成功，积分已到账）',
      credits: '活跃+1',
      consecutiveDays: 0,
    };
  }

  const expected = await readCodeBuddyAccountInfo(acct.file);
  const domain = acct.domain || 'www.codebuddy.ai';
  const token = acct.token || '';
  // uid = JWT sub：/v2/report 缺 userId 会被上游静默丢弃，网页会话也必须带 X-User-Id
  const uid = expected.uid || String(jwtPayload(token)?.sub || '');

  // 1) 探测签到活动（正确端点：无 /v2 前缀的 checkin-activity-status）
  const actStatus = await fetchCodeBuddyActivityStatus(token, domain, uid);
  if (actStatus?.todayCheckedIn) {
    return {
      ok: true,
      status: 'already',
      message: `今日已领取（checkin-activity-status today_checked_in=true，活动连签 ${actStatus.streakDays} 天）`,
      credits: '活跃+1',
      consecutiveDays: actStatus.streakDays,
    };
  }

  // 2) 积分基线要在一切动作**之前**取，后面才有得比
  const creditsBefore = await fetchCodeBuddyCredits(token, domain);

  // 3) 活动开放且今日未领 → 官方领取（活动关闭时上游没有每日奖励可发，不空打）
  const claim = actStatus?.active
    ? await claimCodeBuddyCheckin(token, domain)
    : { ok: false, code: 0, msg: actStatus ? '活动未开启' : '活动状态读取失败' };

  // 4) 活跃链路：活跃上报 + 网页会话（上游口径：任一成功即算当日活跃完成）
  const report = await reportCodeBuddyActivity(token, uid, domain);
  if (report.restricted) {
    return {
      ok: false,
      status: 'restricted',
      message: '账号受限（上游返回 11140 / request illegal），本轮停止，不续期也不重试',
      credits: 0,
      consecutiveDays: 0,
    };
  }
  const web = await createCodeBuddyWebConversation(token, uid, domain);
  if (web.restricted) {
    return {
      ok: false,
      status: 'restricted',
      message: '账号受限（上游返回 11140 / request illegal），本轮停止，不续期也不重试',
      credits: 0,
      consecutiveDays: 0,
    };
  }
  // 4.5) 网页会话没建起来时，退一步用保活对话维持「账号有调用」
  //      （⚠️ 上游口径：只保活对话成功**不算**当日活跃，只是别让账号彻底闲置）
  let keep = null;
  if (!web.ok) {
    keep = await keepaliveCodeBuddyChat(token, uid, domain);
  }

  const outcome = decideCodeBuddyOutcome({ actStatus, claim, report, web, keep, creditsBefore });
  return {
    ok: outcome.status === 'success',
    status: outcome.status,
    message: outcome.message,
    credits: outcome.credits,
    consecutiveDays: 0,
    // pendingReason / retryAt 必须透传：前端靠它区分「上游活动没开」「等积分到账」，
    // 调度器靠 retryAt 决定什么时候再来（漏传就退化成笼统的「立即签到」+ 空转重试）。
    ...(outcome.pendingReason ? { pendingReason: outcome.pendingReason } : {}),
    ...(outcome.retryAt ? { retryAt: outcome.retryAt } : {}),
    ...(outcome.campaignClosed ? { campaignClosed: true } : {}),
    ...(outcome.awaitCredits ? { creditsBefore: outcome.creditsBefore, awaitCredits: true } : {}),
  };
}

/**
 * 执行 CodeBuddy 国际版签到（活跃上报 + 网页会话触发当日活跃，积分到账才算成功）
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

  // 活跃成功的唯一依据是**积分到账**（用户口径：5 分钟内没到账 = 没活跃成功）。
  // 所有账号的模型调用都结束后再统一并行轮询，多个账号共用一个 5 分钟窗口。
  const pending = results.filter((r) => r.awaitCredits && r.creditsBefore);
  if (pending.length) {
    const waitMs = Number(process.env.CODEBUDDY_CREDIT_WAIT_MS) || CODEBUDDY_CREDIT_WAIT_MS;
    const deadline = Date.now() + waitMs;
    const settled = new Map(pending.map((r) => [r, { arrived: false, after: null }]));
    for (;;) {
      await Promise.all(pending.map(async (r) => {
        if (settled.get(r).arrived) return;
        const after = await fetchCodeBuddyCredits(r.token, r.domain || 'www.codebuddy.ai');
        if (codeBuddyPackGranted(r.creditsBefore, after)) settled.set(r, { arrived: true, after });
      }));
      if ([...settled.values()].every((s) => s.arrived)) break;
      const left = deadline - Date.now();
      if (left <= 0) break;
      await new Promise((res) => setTimeout(res, Math.min(CODEBUDDY_CREDIT_POLL_MS, left)));
    }
    for (const r of pending) {
      const s = settled.get(r);
      if (s.arrived) {
        const delta = s.after && r.creditsBefore ? (s.after.creditsRemain - r.creditsBefore.creditsRemain) : 0;
        r.ok = true;
        r.status = 'success';
        r.message = `活跃成功（积分已到账${delta ? ` +${delta}` : ''}）`;
      } else {
        r.ok = false;
        r.status = 'failed';
        r.message = `活跃链路已完成，但 ${Math.round(waitMs / 1000)} 秒内积分未到账，活跃未生效`;
      }
      delete r.awaitCredits;
      delete r.creditsBefore;
    }
  }

  const anySuccess = results.some((r) => r.ok && r.status === 'success');
  const anyAlready = results.some((r) => r.status === 'already');
  // 统一聚合口径：以前「有任一成功就整体 success」会把另一个账号的 pending 吃掉，
  // 现在部分成功一律是 partial，前端据此显示「还差几个号」。
  const agg = aggregatePlatformStatus(results);
  const finalStatus = agg.status;

  const summaryMsg = results.map((r) => `${r.label}: ${r.message}`).join('；');
  // pendingReason 透出：前端要能区分「上游活动没开」「等积分到账」「等开窗」「额度冷却」
  const pendingReason = agg.pendingReason;

  return {
    platform: 'codebuddy',
    ok: anySuccess || anyAlready,
    status: finalStatus,
    message: summaryMsg,
    today,
    time,
    pendingReason,
    retryAt: agg.retryAt,
    accounts: results.map((r) => ({
      name: r.name,
      display: r.label || r.name,
      active: !!r.active,
      status: r.status,
      message: r.message,
      credits: r.credits || '',
      consecutiveDays: r.consecutiveDays || 0,
      pendingReason: r.pendingReason || '',
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

/**
 * 拉一次活动列表，必要时先续期一次。
 *
 * 判定顺序（对齐参考实现的 fetch_campaigns / fetch_campaign_rows）：
 *   1. 额度类 403（112/pricingUrl、110）→ 直接带回冷却，**不续期**；
 *   2. 会话失效（普通 401/403 或业务码 105 / 10019901001）→ 续期一次并落盘，再取一次；
 *   3. 其余照原样返回。
 */
/** 活动列表顶层的账号 uid（兼容 data 包装；对齐 v1.0.14 的 campaign_uid_from_payload） */
export function qoderUidFromPayload(payload) {
  if (!payload || typeof payload !== 'object') return '';
  const bodies = [payload, payload.data].filter((body) => body && typeof body === 'object');
  for (const body of bodies) {
    for (const key of ['uid', 'userId', 'user_id']) {
      const value = body[key];
      if (value === undefined || value === null) continue;
      const text = String(value).trim();
      if (text) return text;
    }
  }
  return '';
}

/**
 * 国际版两段式拉活动列表（对齐 L0NE-6/Qoder-Daily v1.0.14 的 fetch_campaigns）：
 *   1. 先**不带任何风控头**拉一次，只为读响应顶层的账号 uid；
 *   2. 用这个 uid 生成 UMID 设备身份，带风控头再拉一次；
 *   3. 拿不到 uid 就**不**生成无绑定账号的设备身份，直接返回第一次的响应，结果保持中性未领取，
 *      不虚报签到成功。配置里的 uid 只做兜底，接口给了就以接口为准。
 * 两个阶段都保留「会话失效 → 续期 → 重放」。国际版领定向活动必须走这条路：先用空账号身份
 * 请求会拿到「鉴权成功但活动列表为空」的假未下发。
 */
async function fetchQoderCampaignsGlobal(acct) {
  let fresh = await ensureQoderFresh(acct);
  let token = fresh.token;
  let renewedOnce = false;

  const bare = () => listQoderCampaigns(acct.worker, token, null, { bare: true });
  const renew = async () => {
    if (!acct.refreshToken) return false;
    const next = await refreshQoderToken(acct.worker, acct.refreshToken);
    if (!next?.token) return false;
    token = next.token;
    renewedOnce = true;
    if (acct.file && acct.saltFile) {
      const expiresAt = next.expiresIn ? Math.floor(Date.now() / 1000 + next.expiresIn) : 0;
      await persistQoderToken({
        credFile: acct.file,
        saltFile: acct.saltFile,
        identity: acct.identity,
        token: next.token,
        refreshToken: next.refreshToken,
        expiresAt,
      }).catch(() => false);
    }
    return true;
  };

  let res = await bare();
  let quota = qoderQuotaCooldown(res);
  if (quota.kind) return { res, token, quota, device: null, deviceNote: '', uid: '' };
  if (qoderAuthDead(res) && await renew()) {
    res = await bare();
    quota = qoderQuotaCooldown(res);
    if (quota.kind) return { res, token, quota, device: null, deviceNote: '', uid: '' };
  }
  if (!res.ok || qoderAuthDead(res)) {
    return { res, token, quota: null, device: null, deviceNote: '', uid: '' };
  }

  const uid = qoderUidFromPayload(res.json)
    || String(acct.user?.id || acct.user?.uid || acct.uid || '').trim();
  if (!uid) {
    return {
      res, token, quota: null, device: null, uid: '',
      deviceNote: '活动列表没有返回账号 UID，无法生成国际版设备身份（v1.0.14 语义：结果保持未领取，不虚报成功）',
    };
  }
  // 接口最新 UID 覆盖配置里的旧值，否则设备身份会和账号对不上。
  const uidFromPayload = qoderUidFromPayload(res.json);
  console.log(`[qoder] ${acct.worker} 两段式：第一段裸请求 uid=${uid}（响应顶层 ${uidFromPayload || '空'}，配置 ${acct.uid ? '有' : '无'}），用该 uid 生成设备身份后二次拉取`);
  acct.uid = uid;

  let device = null;
  let deviceNote = '';
  try {
    device = await resolveQoderDevice(acct.worker, { home: HOME, uid });
    deviceNote = device?.note || '';
  } catch (error) {
    device = null;
    deviceNote = `设备风控身份生成失败：${error instanceof Error ? error.message : String(error)}`;
  }

  res = await listQoderCampaigns(acct.worker, token, device);
  quota = qoderQuotaCooldown(res);
  if (quota.kind) return { res, token, quota, device, deviceNote, uid };
  if (qoderAuthDead(res) && !renewedOnce && await renew()) {
    // 续期后重放完整两段：新令牌可能对应另一个 uid，设备身份要跟着重建。
    res = await bare();
    const again = qoderUidFromPayload(res.json) || uid;
    acct.uid = again;
    try {
      device = await resolveQoderDevice(acct.worker, { home: HOME, uid: again });
      deviceNote = device?.note || '';
    } catch (error) {
      device = null;
      deviceNote = `设备风控身份生成失败：${error instanceof Error ? error.message : String(error)}`;
    }
    if (device) res = await listQoderCampaigns(acct.worker, token, device);
    quota = qoderQuotaCooldown(res);
  }
  return { res, token, quota, device, deviceNote, uid };
}

async function fetchQoderCampaigns(acct, device = null, options = {}) {
  let fresh = await ensureQoderFresh(acct);
  let res = await listQoderCampaigns(acct.worker, fresh.token, device, options);
  let token = fresh.token;
  const quota = qoderQuotaCooldown(res);
  if (quota.kind) return { res, token, quota };
  if (qoderAuthDead(res) && acct.refreshToken) {
    const renewed = await refreshQoderToken(acct.worker, acct.refreshToken);
    if (renewed?.token) {
      fresh = { token: renewed.token, refreshed: true };
      token = renewed.token;
      // 续期后的新 refresh_token 必须落盘（参考实现 v1.0.x：长期无人值守的前提）
      if (acct.file && acct.saltFile) {
        const expiresAt = renewed.expiresIn ? Math.floor(Date.now() / 1000 + renewed.expiresIn) : 0;
        await persistQoderToken({
          credFile: acct.file,
          saltFile: acct.saltFile,
          identity: acct.identity,
          token: renewed.token,
          refreshToken: renewed.refreshToken,
          expiresAt,
        }).catch(() => false);
      }
      res = await listQoderCampaigns(acct.worker, token, device, options);
      const q2 = qoderQuotaCooldown(res);
      if (q2.kind) return { res, token, quota: q2 };
    }
  }
  return { res, token, quota: qoderQuotaCooldown(res) };
}

/** 单个 Qoder 账号：解析设备身份 → 拉活动列表 → 逐个领取 → 汇总积分 */
async function checkinQoderOne(acct) {
  const candidates = [acct, ...(Array.isArray(acct.alternates) ? acct.alternates : [])];
  const worker = acct.worker || 'qoder';
  const uid = String(acct.user?.id || acct.user?.uid || acct.uid || '').trim();
  const nowSec = Math.floor(Date.now() / 1000);
  const win = qoderOpenWindow(nowSec);
  // 当前窗口是不是「今天这一期」：00:00–09:59 仍属于昨天开的那一期。
  // 在这一期里领到的分不能记成「今天已签」，否则 10:00 新一期不会触发补签。
  const currentPeriod = qoderDayKey(win.start) === qoderDayKey(nowSec);
  // 设备身份按账号 uid 生成：桌面端组件会把指纹与账号绑在一起。
  // 国际版拿不到 uid 就先不建身份——uid 只能从活动列表响应里读出来，所以走两段式（见
  // fetchQoderCampaignsGlobal）；中国版仍是一次带设备头拉取。
  const globalRegion = worker !== 'qoder-cn';
  let device = null;
  let deviceNote = '';
  if (!globalRegion) {
    try {
      device = await resolveQoderDevice(worker, { home: HOME, uid });
    } catch {
      device = null;
    }
    deviceNote = device?.note || '';
  }
  let fetched = null;
  let winner = null;
  for (const candidate of candidates) {
    const entry = { ...candidate, expiresAt: candidate.expiresAt || candidate.exp || 0 };
    if (globalRegion) {
      fetched = await fetchQoderCampaignsGlobal(entry);
      if (fetched.device) device = fetched.device;
      if (fetched.deviceNote) deviceNote = fetched.deviceNote;
    } else {
      fetched = await fetchQoderCampaigns(entry, device);
    }
    winner = entry;
    // 额度类 403 是账号级冷却，换一份同账号的旧 token 也只会再吃一次 403；
    // 必须在候选回退前终止，否则最后一个普通 403 会把冷却误报成凭据失效。
    if (fetched.quota?.kind) break;
    if (fetched.res.status !== 401 && fetched.res.status !== 403) break;
  }
  const { res } = fetched;
  let token = fetched.token;
  // 额度类 403（112 / pricingUrl、110 / 每日计费上限）不是凭证失效：单独分流，
  // 既不续期也不判 expired——否则会让用户白登录一次。
  if (fetched.quota?.kind) {
    const seconds = fetched.quota.seconds;
    const until = new Date(Date.now() + seconds * 1000);
    const hhmm = `${String(until.getHours()).padStart(2, '0')}:${String(until.getMinutes()).padStart(2, '0')}`;
    return {
      ok: false,
      status: 'pending',
      message: fetched.quota.kind === 'exhausted'
        ? `额度已耗尽（HTTP ${res.status} / code 112），账号冷却 30 分钟；请充值或更换账号`
        : `每日计费次数已达上限（HTTP ${res.status} / code 110），账号冷却至 ${hhmm}（最长 6 小时）；请稍后或更换账号`,
      credits: 0,
      consecutiveDays: 0,
      pendingReason: 'quota_cooldown',
      retryAt: Math.floor(Date.now() / 1000) + seconds,
    };
  }
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
  let claimable = campaigns.filter((item) => qoderClaimStatus(item) === 'CLAIMABLE' && qoderInWindow(item));
  let claimedBefore = campaigns.filter((item) => qoderClaimedToday(item));
  let staleClaimed = campaigns.filter((item) => ['CLAIMED', 'GRANTED'].includes(qoderClaimStatus(item)) && !qoderClaimedToday(item));

  // Qoder CN：完整设备头下 200 但活动列表为空时，改用**最小鉴权四件套**
  // （Authorization / cosy-clienttype / User-Agent / Content-Type，不带任何设备指纹）再取一次。
  // 移植 L0NE-6/Qoder-Daily v1.0.10：上游对带完整设备头的请求可能下发空活动列表，最小头才看得到。
  //   - 触发条件对齐参考的 campaign_response_is_empty：200 + 非会话失效 + 列表为空；
  //   - 最小头拿到的 401 / 105 / 429 / 5xx **原样透传**（不吞），否则会把真实错误报成「上游未下发」；
  //   - 最小头仍为空 → 保留首次空结果，照常走「无活动」分支。
  // ⚠️ 这个降级**只对中国版启用**：国际版不做（参考实现 v1.0.10 明确）。
  if (worker === 'qoder-cn' && device && res.ok && !claimable.length && !claimedBefore.length && !qoderAuthDead(res)) {
    let minimal = null;
    try {
      minimal = await fetchQoderCampaigns({ ...winner, token }, null, { minimal: true });
    } catch (err) {
      return { ok: false, status: 'failed', message: `最小请求头复取异常：${err.message}`, credits: 0, consecutiveDays: 0 };
    }
    if (minimal.quota?.kind) {
      const seconds = minimal.quota.seconds;
      const until = new Date(Date.now() + seconds * 1000);
      const hhmm = `${String(until.getHours()).padStart(2, '0')}:${String(until.getMinutes()).padStart(2, '0')}`;
      return {
        ok: false,
        status: 'pending',
        message: minimal.quota.kind === 'exhausted'
          ? '额度已耗尽（HTTP 403 / code 112），账号冷却 30 分钟；请充值或更换账号'
          : `每日计费次数已达上限（HTTP 403 / code 110），账号冷却至 ${hhmm}（最长 6 小时）；请稍后或更换账号`,
        credits: 0,
        consecutiveDays: 0,
        pendingReason: 'quota_cooldown',
        retryAt: Math.floor(Date.now() / 1000) + seconds,
      };
    }
    const mRes = minimal.res;
    if (mRes.status === 401 || qoderAuthDead(mRes)) {
      return { ok: false, status: 'expired', message: `签到活动查询失败（HTTP ${mRes.status}），请重新登录 Qoder CN`, credits: 0, consecutiveDays: 0 };
    }
    if (mRes.status === 429) {
      return { ok: false, status: 'failed', message: '签到活动查询失败（HTTP 429），请稍后重试', credits: 0, consecutiveDays: 0, retryAt: Math.floor(Date.now() / 1000) + 600 };
    }
    if (!mRes.ok) {
      return { ok: false, status: 'failed', message: `活动列表返回 [${mRes.status}]：${qoderResponseMessage(mRes) || '未知错误'}`, credits: 0, consecutiveDays: 0 };
    }
    const minimalBodyCode = Number(mRes.json?.code ?? mRes.json?.errorCode);
    if (minimalBodyCode === 401 || minimalBodyCode === 403) {
      return { ok: false, status: 'expired', message: qoderResponseMessage(mRes) || '登录态已失效，请在 Qoder CN 重新登录', credits: 0, consecutiveDays: 0 };
    }
    if (mRes.json?.success === false || (Number.isFinite(minimalBodyCode) && ![0, 200].includes(minimalBodyCode))) {
      return { ok: false, status: 'failed', message: `活动列表返回 [${minimalBodyCode}]：${qoderResponseMessage(mRes) || '未知错误'}`, credits: 0, consecutiveDays: 0 };
    }
    const minimalCampaigns = extractQoderCampaigns(mRes.json);
    if (minimalCampaigns.length) {
      campaigns = minimalCampaigns;
      claimable = minimalCampaigns.filter((item) => qoderClaimStatus(item) === 'CLAIMABLE' && qoderInWindow(item));
      claimedBefore = minimalCampaigns.filter((item) => qoderClaimedToday(item));
      staleClaimed = minimalCampaigns.filter((item) => ['CLAIMED', 'GRANTED'].includes(qoderClaimStatus(item)) && !qoderClaimedToday(item));
      token = minimal.token;
    }
  }

  // 注意：**不再**把国际版账号换到另一套 openapi 再问一次。
  // 参考实现 v1.0.10 明确「空表复取只对中国版启用；国际版路径保持不变」——
  // 跨地区请求拿不到活动，还会把账号送进风控看。

  if (!claimable.length) {
    if (claimedBefore.length) {
      return { ok: true, status: 'already', message: claimedBefore.length > 1 ? `今日 ${claimedBefore.length} 个活动已领取` : '今日已领取', credits: 0, consecutiveDays: 0 };
    }
    // 「当前开放窗口这一期」的每日活动行是不是已经领过？
    // 不能只看 claimedBefore：它按**自然日**比对窗口起始日，00:00 一翻篇就把还在窗口内的
    // 本期行算成「上一期」（实测 11-02 00:57 领到的 act-20261101-825，00:00 之后就被算成上一期）。
    const openRow = campaigns.find((item) => qoderInWindow(item, nowSec));
    const openClaimed = !!openRow && ['CLAIMED', 'GRANTED'].includes(qoderClaimStatus(openRow));
    if (openClaimed) {
      // 本期已领 → 等下一期开窗（每天 10:00 UTC+8）。
      // 上一期已领、今天这一期还没开：0:00–10:00 之间就是这种状态。
      // 这时不能报「已签到」（卡片会骗人），报 pending 让定时器到点重试一次。
      const pend = qoderPendingWindow(staleClaimed, nowSec)
        || { retryAt: win.nextStart, message: `本期已领，下一期 ${qoderClock(win.nextStart)}（UTC+8）开新一期；到点会自动补领` };
      return {
        ok: false,
        status: 'pending',
        message: pend.message,
        credits: 0,
        consecutiveDays: 0,
        pendingReason: 'awaiting_window',
        // 定时器不必在开窗之前反复试：到点再来，免得重试预算全耗在等窗口上
        retryAt: pend.retryAt
      };
    }

    // ⚠️ 到这里 = 「当前开放窗口这一期的活动行还没下发」，上游开窗后延迟下发是常态。
    // 这里**绝对不能判 already、也不能把重试推到下一期开窗**：
    //   判 already 等于「今天已领」，而 platformNeedsRetry 只重试 failed/pending → 当天不再拉一次；
    //   推到下一期开窗则直接跳过**本期还开着的窗口**（上一期 11-01 10:00 → 11-02 09:59）。
    //   两者都会让每日 100 Credits 直接丢：
    //   实测 2026-11-01 10:09 活动 0 个 → already → 当天零重试（历史里 10:09 → 次日 00:57 整整
    //   14.8 小时没再拉过），同一期在 11-02 00:57 再看就有了，+100 到账。
    // 正确口径：窗口还开着就继续补拉（开窗 1 小时内每 10 分钟，之后每小时，直到窗口关闭前 5 分钟）。
    const retryAt = qoderPollAt(nowSec, win);
    // 诊断补充：`campaigns` 只保留 CLAIM_BENEFIT 行，但上游常常同时下发「升级/展示类」
    // （VIEW_DETAILS）活动。只报「活动 0 个：空」会让人误判成「上游什么都没下发」——
    // 实测 Henry-Baker 这个账号今天就只有一条 VIEW_DETAILS/CLAIMED，从来没有每日 Credits 行。
    const nonBenefitRows = (() => {
      const payload = res?.json;
      const all = Array.isArray(payload?.campaigns) ? payload.campaigns
        : Array.isArray(payload?.data?.campaigns) ? payload.data.campaigns : [];
      return all.filter((row) => row && typeof row === 'object'
        && String(row.actionType || row.action_type || '').toUpperCase() !== QODER_BENEFIT_ACTION).length;
    })();
    const diag = `[活动 ${campaigns.length} 个：` + (campaigns.map((c) => `${qoderClaimStatus(c) || '?'}`).join('/') || '空') + ']'
      + (nonBenefitRows ? `，另有 ${nonBenefitRows} 个非领取类活动（升级/展示类，不计入每日 Credits）` : '')
      + (staleClaimed.length ? `，其中 ${staleClaimed.length} 个是过期的 CLAIMED` : '');
    if (deviceNote) {
      return {
        ok: false,
        status: 'pending',
        message: `未领取：${deviceNote}。国际版签到需要本机 Qoder 客户端或 qodercli 的 UMID 组件（装好后会自动重试）`,
        credits: 0,
        consecutiveDays: 0,
        pendingReason: 'identity_missing',
        retryAt,
      };
    }
    return {
      ok: false,
      status: 'pending',
      message: `${diag} 本期活动行尚未下发（本期窗口 ${qoderClockDay(win.start)} → ${qoderClockDay(win.end)} UTC+8），`
        + `窗口内会自动补拉，最晚 ${qoderClockDay(win.end)} 前领到都算数`,
      credits: 0,
      consecutiveDays: 0,
      pendingReason: 'awaiting_campaign',
      retryAt,
    };
  }

  let credits = 0;
  let successCount = 0;
  let alreadyCount = 0;
  const failures = [];
  let cooldown = null;
  for (const item of claimable) {
    const campaignId = item.campaignId || item.campaign_id;
    const amount = qoderBenefit(item);
    try {
      const claim = await claimQoderCampaign(worker, token, campaignId, device);
      const outcome = qoderClaimOutcome(claim);
      if (outcome.status === 'success') {
        successCount += 1;
        credits += amount;
      } else if (outcome.status === 'already') {
        alreadyCount += 1;
      } else if (outcome.status === 'cooldown') {
        // 额度类 403：中断该账号后续领取（再打也是 403），整号进冷却
        cooldown = { kind: outcome.kind || '', message: outcome.message, seconds: outcome.cooldownSeconds || 1800 };
        break;
      } else {
        failures.push(outcome.message);
      }
    } catch (err) {
      failures.push(`请求异常：${err.message}`);
    }
    if (claimable.length > 1) await new Promise((r) => setTimeout(r, 800));
  }

  if (cooldown) {
    const seconds = cooldown.seconds;
    const until = new Date(Date.now() + seconds * 1000);
    const hhmm = `${String(until.getHours()).padStart(2, '0')}:${String(until.getMinutes()).padStart(2, '0')}`;
    return {
      ok: false,
      status: 'pending',
      message: cooldown.kind === 'exhausted'
        ? '额度已耗尽（HTTP 403 / code 112），账号冷却 30 分钟；请充值或更换账号'
        : `每日计费次数已达上限（HTTP 403 / code 110），账号冷却至 ${hhmm}（最长 6 小时）；请稍后或更换账号`,
      credits,
      consecutiveDays: 0,
      pendingReason: 'quota_cooldown',
      retryAt: Math.floor(Date.now() / 1000) + seconds,
    };
  }

  // 关键：在 00:00–09:59 领到的是**上一期**，不是今天的签到。
  // 如果这里直接返回 success，平台状态会记成今天已签，10:00 新一期彻底不补。
  // 上一期该领的分照领、credits 照报，但今天状态必须是 pending + 等 10:00 开窗。
  if (!currentPeriod && !failures.length && (successCount || alreadyCount)) {
    return {
      ok: false,
      status: 'pending',
      message: `上一期已领取${credits ? ` +${credits} Credits` : ''}；今日 ${qoderClock(win.nextStart)}（UTC+8）开新一期，到点自动补领`,
      credits,
      consecutiveDays: 0,
      pendingReason: 'awaiting_window',
      retryAt: win.nextStart,
    };
  }

  const parts = [];
  if (successCount) parts.push(`领取 ${successCount} 个活动${credits ? `，+${credits} Credits` : ''}`);
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
  const agg = aggregatePlatformStatus(results);
  const status = agg.status;
  const retryAt = agg.retryAt;
  // pendingReason 要透出到平台级：前端据此区分「等开窗」「等额度冷却」「设备身份缺失」，
  // 否则按钮只能显示笼统的「待签到」，用户点了也不知道在等什么。
  const pendingReason = agg.pendingReason;
  return {
    platform,
    ok: badOnes.length === 0,
    status,
    // 多账号时带上账号名，否则「已领取 + 未下发」两段并排看着自相矛盾
    message: results.map((r) => (results.length > 1 ? `${r.label}：${r.message}` : r.message)).join('；'),
    credits: okOnes.reduce((s, r) => s + (Number(r.credits) || 0), 0),
    consecutiveDays: 0,
    retryAt,
    pendingReason,
    accounts: results.map((r) => ({
      name: r.name,
      display: r.label || r.name,
      active: !!r.active,
      status: r.status,
      message: r.message,
      credits: r.credits,
      consecutiveDays: r.consecutiveDays,
      pendingReason: r.pendingReason || '',
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
  for (const plat of CHECKIN_PLATFORMS) {
    const pState = state.platforms[plat] || {};
    const cInfo = creds[plat] || {};
    const isToday = pState.lastDate === today;
    const nowSec = Math.floor(Date.now() / 1000);
    const futureRetry = Number(pState.retryAt) > nowSec;
    const hasActiveState = isToday || futureRetry;

    // 账号行 = 实时账号集合（worker 档案 + CLI 凭据）∪ 今日快照状态。
    // 以前只要 isToday 就直接回放快照，导致「签完之后在 worker 里新加的账号」当天永远不出现。
    const accountRows = mergeAccountRows(
      await listCheckinAccounts(plat),
      hasActiveState ? pState.accounts : [],
      plat,
    );
    // 还有几个账号今天没签成：前端据此把「今日已签」按钮改成「补签新增账号」
    // 平台处在「等下一期开窗」（Qoder 每天 0:00 / 10:00）或「等额度冷却」时不算待补：
    // 那时点也只会再拿到一次 pending，白让按钮闪一下，用户还以为漏签了。
    // （注意：等窗口归零的是**按钮文案**，不代表这些账号不用签——
    //   partial 状态的补签个数由前端按「总数-已签数」自行推导，不依赖这个字段。）
    const waitingWindow = futureRetry;
    // stale 行只用于「历史不消失」的展示，不参与账号总数/待签/已签统计，
    // 否则被切走的旧号会虚增「补签 N 个账号」并让按钮反复提示。
    const activeRows = accountRows.filter((r) => !r.stale);
    const pendingRows = activeRows.filter((r) => ['pending', 'failed', 'expired', 'restricted'].includes(String(r.status)));
    // 等下一期时普通失败号不催（点了也只会再 pending）；但**新加的账号**必须保留计数，
    // 否则前端会因 retryAt 未来而把「补签新增账号」按钮禁用，新号又得等到明天。
    const pendingAccounts = waitingWindow
      ? pendingRows.filter((r) => r.fresh).length
      : pendingRows.length;
    // 已签账号数：前端据此显示「部分已签（2/3）」，不再只靠一个笼统状态
    const signedAccounts = activeRows.filter((r) => ['success', 'already'].includes(String(r.status))).length;

    platforms[plat] = {
      available: cInfo.available,
      source: cInfo.source || '未关联凭据',
      // cli = 直接复用已安装 CLI 的凭据（自动跟随 CLI 刷新）；custom = 手工配置；none = 没找到
      credentialMode: !cInfo.available ? 'none' : (String(cInfo.source || '').includes('CLI 实时') ? 'cli' : 'custom'),
      // WorkBuddy / CodeBuddy / Qoder / MiniMax Code 有 refreshToken，签到前会自动续期，不需要人管
      autoRefresh: ['workbuddy', 'codebuddy', 'qoder', 'qoder-cn', 'minimaxcode'].includes(plat) && cInfo.refreshable === true,
      lastDate: pState.lastDate || '无记录',
      lastTime: pState.lastTime || '',
      status: hasActiveState ? pState.status : (cInfo.available ? 'pending' : 'unconfigured'),
      message: hasActiveState ? pState.message : (cInfo.available ? '今日待打卡' : '未检测到有效凭据'),
      // pending 的具体原因 + 平台约的重试时刻：前端据此如实显示「等开窗 / 等额度冷却」，
      // 并在约好的时刻之前把按钮置灰（点了也只是再拿一次 pending，白闪一下）。
      pendingReason: hasActiveState ? (pState.pendingReason || '') : '',
      retryAt: hasActiveState ? (pState.retryAt || 0) : 0,
      credits: pState.credits || '',
      consecutiveDays: pState.consecutiveDays || 0,
      accounts: accountRows,
      // >0 表示「今天还有账号没签成」——可能是刚在 worker 里加的，也可能是某个号失败了
      pendingAccounts,
      // 已签成的账号数：前端据此显示「部分已签（2/3）」，不再只靠一个笼统状态
      signedAccounts,
      accountCount: activeRows.length,
      // 需要扫码登录的平台：前端据此显示「扫码登录」入口（二维码由云机浏览器截取）
      ...(plat === 'doubao' ? { loginKind: 'qr' } : {}),
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
  for (const plat of CHECKIN_PLATFORMS) {
    const p = st.platforms?.[plat] || {};
    const rows = mergeAccountRows(
      await listCheckinAccounts(plat),
      p.lastDate === today ? p.accounts : [],
      plat,
    );
    // 新账号不受平台 retryAt 限制：retryAt 是「老账号本期已领，等下一期」，
    // 但新账号可能连本期都还没签，必须当天补上，不能一起被拖到下一期。
    if (rows.some((r) => r.fresh)) {
      out.push(plat);
      continue;
    }
    // 没有新账号时，平台自己约了时间（Qoder 每天 10:00 开新一期）就别提前空转
    if (p.retryAt && nowSec < Number(p.retryAt)) continue;
  }
  return out;
}

let checkinStateLock = Promise.resolve();

function withCheckinStateLock(fn) {
  const run = checkinStateLock.then(fn, fn);
  checkinStateLock = run.then(() => undefined, () => undefined);
  return run;
}

/**
 * 一键清除签到日志。
 * 只清历史记录，不动各平台今日状态与凭据——这样「清日志」不会让卡片误以为今天没签。
 */
export function clearCheckinHistory() {
  return withCheckinStateLock(async () => {
    const state = await loadState();
    const removed = Array.isArray(state.history) ? state.history.length : 0;
    state.history = [];
    await saveState(state);
    return { ok: true, removed, overview: await getCheckinOverview() };
  });
}

/**
 * 平台级状态聚合（纯函数，便于单测）。
 *
 * ⚠️ 为什么要统一：以前 codebuddy 是「有任一成功就整体 success」，
 * qoder 是「有任一失败就整体 failed」——同一个平台里一个号签上、一个号没签成时，
 * 两边的显示口径还不一样，用户看到的结论互相打架。
 *
 * 统一后的口径：
 *   success  全部账号都签成
 *   already  全部账号今日都领过（幂等命中）
 *   partial  **部分**账号签成、其余没签成 → 必须告诉用户还差几个号，不能粉饰成成功
 *   pending  全部账号都在等（等开窗 / 等额度冷却 / 等积分到账）
 *   expired  全部账号凭据都失效
 *   failed   其余（真失败）
 */
/**
 * 平台级 pendingReason 的优先级（数字小的先报）。
 * 排在前面的是「用户能动手解决」或「正在丢钱」的原因，
 * 「等开窗」这种什么都不用做的排最后。
 */
export const PENDING_REASON_PRIORITY = [
  'identity_missing',   // 缺设备身份：装上客户端就能领
  'quota_cooldown',     // 额度用尽：充值或换号
  'await_credits',      // 活跃链路已完成，积分异步到账中（CodeBuddy）
  'awaiting_campaign',  // 上游活动行还没下发：正在窗口内补拉，错过就丢 100 分
  'campaign_closed',    // 上游活动整段关闭
  'awaiting_window',    // 下一期还没开窗：什么都不用做
];

export function aggregatePlatformStatus(results = []) {
  const list = (results || []).filter((r) => r && r.status);
  if (!list.length) return { status: 'failed', pendingReason: '', retryAt: 0 };
  const n = (s) => list.filter((r) => r.status === s).length;
  const signed = n('success') + n('already');
  const pending = n('pending');
  const restricted = n('restricted');
  const bad = n('failed') + n('expired');
  // pendingReason 取**优先级最高**的那个账号原因，而不是第一个：
  // 「等上游下发活动行」（正在丢 100 Credits）必须排在「等开窗」（什么都不用做）前面，
  // 否则卡片会显示「待活动开启」而用户以为没戏了，实际是我们还在窗口内补拉。
  const pendingReason = (() => {
    for (const reason of PENDING_REASON_PRIORITY) {
      if (list.some((r) => r.pendingReason === reason)) return reason;
    }
    return list.find((r) => r.pendingReason)?.pendingReason || '';
  })();
  // retryAt 取最早的约定时刻：任何一个账号约好了，整平台就跟着那个点再试
  const retryAt = list.reduce((min, r) => (r.retryAt && (!min || r.retryAt < min) ? r.retryAt : min), 0);

  if (signed === list.length) {
    return { status: n('success') === list.length ? 'success' : 'already', pendingReason: '', retryAt: 0 };
  }
  if (!signed && restricted && !bad && !pending) return { status: 'restricted', pendingReason: '', retryAt: 0 };
  if (signed && (bad || pending || restricted)) return { status: 'partial', pendingReason, retryAt };
  if (bad + restricted === list.length) {
    return { status: n('expired') === list.length ? 'expired' : 'failed', pendingReason: '', retryAt };
  }
  if (pending === list.length) return { status: 'pending', pendingReason, retryAt };
  return { status: bad ? 'failed' : 'pending', pendingReason, retryAt };
}

/**
 * 这个平台现在还需不需要补签（纯函数，便于单测）。
 *
 * 口径统一成一句话：**今天没签成、且平台没约时间、且没把重试次数用完**。
 * - 今天没签过 → 要（首次触发）
 * - 平台自己约了时间（Qoder 每天 10:00 开窗）→ 先等，到点再来
 * - failed / pending → 补（限流、网络抖动、排队错误都靠它重试，每天最多 8 次）
 * - success / already / unconfigured → 不补
 */
/**
 * Qoder 的跨期遗留状态：00:57 领的是上一期，却把平台记成 today+success。
 * 10:00 新一期开窗后，普通 success 不会被 platformNeedsRetry 选中，
 * 必须额外强制核对一次，否则当天新一期永远不补。
 */
export function qoderPeriodNeedsCheck(p = {}, today = getTodayStr(), nowSec = Math.floor(Date.now() / 1000)) {
  if (!['success', 'already'].includes(p.status) || p.lastDate !== today) return false;
  const win = qoderOpenWindow(nowSec);
  if (qoderDayKey(win.start) !== qoderDayKey(nowSec)) return false;
  const last = String(p.lastTime || '');
  return !last || last.slice(0, 5) < qoderClock(win.start);
}

/** retryAt 由「本轮签到结束时刻 + N 小时」算出，总比整点 :11 的定时 tick 晚几秒；
 *  不留余量的话 tick 会差几秒错过、白等一整小时（09:11:39 的 tick 对 09:11:40 的 retryAt）。 */
export const RETRY_AT_GRACE_SEC = 120;

export function platformNeedsRetry(p = {}, today = getTodayStr(), nowSec = Math.floor(Date.now() / 1000), plat = '') {
  if (p.retryAt && nowSec + RETRY_AT_GRACE_SEC < Number(p.retryAt)) return false;
  if (p.status === 'restricted') return false;
  if (p.lastDate !== today) return true;
  if (p.status === 'partial' && Array.isArray(p.accounts)) {
    const remaining = p.accounts.filter((r) => !['success', 'already'].includes(r?.status));
    if (remaining.length && remaining.every((r) => r.status === 'restricted')) return false;
  }
  // partial 也要补：部分账号签成了、部分没签成，那几个没成的还得再试
  // 预算按平台走（Qoder 要横跨整个 24 小时窗口补拉，见 CHECKIN_RETRY_BUDGET）。
  // plat 是兜底：老状态文件里还没有 retryBudget 字段，不能让 Qoder 被通用 8 次卡死。
  const budget = Number(p.retryBudget) || retryBudgetFor(plat) || 8;
  return ['failed', 'pending', 'partial'].includes(p.status) && (p.retryCount || 0) < budget;
}

/**
 * 定时器这一轮要补签哪些平台（纯函数，便于单测）。
 * extraPlatforms：账号补签带来的「今天还没签过的新账号」所属平台。
 */
export function selectAutoCheckinPlatforms(platforms = {}, today = getTodayStr(), nowSec = Math.floor(Date.now() / 1000), extraPlatforms = []) {
  const out = [];
  for (const plat of CHECKIN_PLATFORMS) {
    if (platformNeedsRetry(platforms[plat] || {}, today, nowSec, plat)) out.push(plat);
  }
  // Qoder 跨期遗留：上一期成功不能替代今天这一期；10:00 开窗后强制核对一次。
  for (const plat of ['qoder', 'qoder-cn']) {
    if (!out.includes(plat) && qoderPeriodNeedsCheck(platforms[plat] || {}, today, nowSec)) out.push(plat);
  }
  for (const plat of extraPlatforms) {
    if (CHECKIN_PLATFORMS.includes(plat) && !out.includes(plat)) out.push(plat);
  }
  return out;
}

// 同一平台的并发执行共享同一个 Promise：手动点击与定时 tick 撞车时，
// 上游只请求一次，只有首个调用者负责落盘，后到者复用结果而不重复写历史。
const checkinPlatformRuns = new Map();

function runCheckinPlatformOnce(platform, fn) {
  const running = checkinPlatformRuns.get(platform);
  if (running) return running.then((value) => ({ shared: true, value }));
  const task = (async () => fn())();
  checkinPlatformRuns.set(platform, task);
  return task.then(
    (value) => ({ shared: false, value }),
    (error) => {
      throw error;
    },
  ).finally(() => {
    if (checkinPlatformRuns.get(platform) === task) checkinPlatformRuns.delete(platform);
  });
}

/**
 * 执行指定平台签到或一键全签
 * @param {'all'|'due'|'workbuddy'|'codebuddy'|'traecode'|'codearts'|'qoder'|'qoder-cn'|'minimaxcode'|'meoo'} target
 */
export async function runCheckin(target = 'all') {
  const state = await loadState();
  const results = {};
  const stateResults = {};

  // due = 只补「今天还没签成」的平台（pending/failed），给「刷新状态」按钮用：
  // 以前刷新只重读一遍状态，昨天那期已领就一直显示已签，点多少次都不动。
  let only = null;
  if (target === 'due') {
    const today = getTodayStr();
    const nowSec = Math.floor(Date.now() / 1000);
    only = CHECKIN_PLATFORMS.filter((plat) => platformNeedsRetry(state.platforms[plat] || {}, today, nowSec, plat));
    // 已经签成、但 worker 里又新加了账号的平台：也要在「刷新/补签」里带上，
    // 否则新账号当天永远签不到（旧逻辑只看平台级状态，账号级新增完全看不见）。
    const fresh = await pendingAccountPlatforms(state);
    only = [...new Set([...only, ...fresh])];
    if (!only.length) return { ok: true, results: {}, due: [], overview: await getCheckinOverview() };
  }
  const want = (plat) => (only ? only.includes(plat) : (target === 'all' || target === plat));
  const collect = async (plat, fn) => {
    const { shared, value } = await runCheckinPlatformOnce(plat, fn);
    results[plat] = value;
    // 后到者只复用结果，不重复落盘，避免同一结果产生两条 history。
    if (!shared) stateResults[plat] = value;
  };

  if (want('workbuddy')) {
    await collect('workbuddy', () => checkinWorkBuddy());
  }
  if (want('codebuddy')) {
    await collect('codebuddy', () => checkinCodeBuddy());
  }
  if (want('traecode')) {
    await collect('traecode', () => checkinTrae());
  }
  if (want('codearts')) {
    await collect('codearts', () => checkinCodeArts());
  }
  if (want('qoder')) {
    await collect('qoder', () => checkinQoder('qoder'));
  }
  if (want('qoder-cn')) {
    await collect('qoder-cn', () => checkinQoder('qoder-cn'));
  }
  if (want('minimaxcode')) {
    await collect('minimaxcode', () => checkinMiniMaxPlatform('cn'));
  }
  if (want('meoo')) {
    await collect('meoo', () => checkinMeoo());
  }
  if (want('doubao')) {
    await collect('doubao', () => checkinDoubao());
  }

  await withCheckinStateLock(async () => {
    const latest = await loadState();
    for (const [plat, res] of Object.entries(stateResults)) {
      const prev = latest.platforms[plat] || {};
      const retryable = ['failed', 'pending', 'partial'].includes(res.status);
      latest.platforms[plat] = {
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
        retryCount: retryable ? (prev.lastDate === res.today ? (prev.retryCount || 0) + 1 : 1) : 0,
        // 该平台每天的重试预算（Qoder 要横跨整个 24 小时窗口补拉，通用 8 次不够用）
        retryBudget: retryBudgetFor(plat),
        // 平台自己给出「几点再来」（Qoder 每天 10:00 开新一期）：到点前定时器不空转
        retryAt: res.retryAt || 0,
        // pending 的具体原因：前端要据此把按钮改成「等开窗」「等额度冷却」这类如实文案
        pendingReason: res.pendingReason || ''
      };
      latest.history.unshift({
        time: `${res.today} ${res.time}`,
        platform: plat,
        status: res.status,
        message: res.message
      });
    }

    if (latest.history.length > 50) {
      latest.history = latest.history.slice(0, 50);
    }
    await saveState(latest);
  });
  return { ok: true, results, overview: await getCheckinOverview() };
}

/**
 * 保存配置（自定义 Token、定时打卡设置等）
 */
export function updateCheckinConfig(config) {
  return withCheckinStateLock(async () => {
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
  });
}

/**
 * 后台定时自动签到调度器
 */
const AUTO_CHECKIN_INTERVAL_MS = 30 * 60 * 1000;
let autoCheckinTimer = null;
let autoCheckinActive = false;

// 跨进程 tick 锁。同一份状态文件（~/.agenthub/checkin-state.json）可能被多份部署共用——
// 老 console、工作台各自都有一份这个模块、各自的 30 分钟定时器；不互斥的话两个进程会在同一个
// retryAt 同时醒来，把同一批平台并发签两遍（token 续期互相踩）。mkdir 在 POSIX 上是原子的，
// 谁建成目录谁持锁；持锁期间每 30 秒摸一次 owner 的 mtime（心跳），45 分钟摸不到心跳视为持锁
// 进程已死，下一个进程把目录原子挪走后重建。
const TICK_LOCK_DIR = process.env.AGENTHUB_CHECKIN_TICK_LOCK
  ? resolve(process.env.AGENTHUB_CHECKIN_TICK_LOCK)
  : join(HOME, '.agenthub', 'checkin-tick.lock');
const TICK_LOCK_STALE_MS = 45 * 60 * 1000;
const TICK_LOCK_HEARTBEAT_MS = 30_000;
const TICK_LOCK_ACQUIRE_GRACE_MS = 5_000;

export async function acquireTickLock() {
  // 父目录（~/.agenthub）可能还没建过：建父目录不参与抢锁，抢锁的 mkdir 必须保持非递归原子性
  await mkdir(dirname(TICK_LOCK_DIR), { recursive: true }).catch(() => {});
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      await mkdir(TICK_LOCK_DIR);
      await writeFile(join(TICK_LOCK_DIR, 'owner'), `${process.pid}\t${Date.now()}\n`);
      return true;
    } catch (err) {
      if (err.code !== 'EEXIST') return true;
    }
    let holder;
    try {
      holder = await stat(join(TICK_LOCK_DIR, 'owner'));
    } catch {
      try { holder = await stat(TICK_LOCK_DIR); } catch { continue; }
      // 目录刚建、owner 还没落盘：宽限期内的正常抢锁中间态，不算陈旧
      if (Date.now() - holder.mtimeMs < TICK_LOCK_ACQUIRE_GRACE_MS) return false;
    }
    if (Date.now() - holder.mtimeMs < TICK_LOCK_STALE_MS) return false;
    // 挪走前再核一次：上面的 stat 到 rename 之间，别的进程可能已抢到并重建了锁
    let stillStale = true;
    try {
      const recheck = await stat(join(TICK_LOCK_DIR, 'owner'));
      stillStale = Date.now() - recheck.mtimeMs >= TICK_LOCK_STALE_MS;
    } catch { /* owner 没了：宽限期外视为陈旧 */ }
    if (!stillStale) return false;
    const aside = `${TICK_LOCK_DIR}.stale-${process.pid}-${attempt}`;
    try { await rename(TICK_LOCK_DIR, aside); await rm(aside, { recursive: true, force: true }); } catch { /* 别的进程已经挪走了 */ }
  }
  return false;
}

export async function releaseTickLock() {
  await rm(TICK_LOCK_DIR, { recursive: true, force: true });
}

export async function runAutoCheckinTick() {
  if (!(await acquireTickLock())) return [];
  const owner = join(TICK_LOCK_DIR, 'owner');
  const heartbeat = setInterval(() => {
    utimes(owner, new Date(), new Date()).catch(() => {});
  }, TICK_LOCK_HEARTBEAT_MS);
  heartbeat.unref?.();
  try {
    const state = await loadState();
    if (!state.autoCheckin) return [];
    const pending = selectAutoCheckinPlatforms(
      state.platforms || {},
      getTodayStr(),
      Math.floor(Date.now() / 1000),
      await pendingAccountPlatforms(state),
    );
    // 状态 pending/failed 但 retryAt 未到的平台不在「待处理」里（等开窗 / 等活动 / 冷却），单独列出，免得看日志以为漏了。
    const nowSec = Math.floor(Date.now() / 1000);
    const deferred = CHECKIN_PLATFORMS.filter((plat) => !pending.includes(plat))
      .map((plat) => [plat, state.platforms?.[plat] || {}])
      .filter(([, p]) => ['failed', 'pending', 'partial'].includes(p.status) && Number(p.retryAt) > nowSec + RETRY_AT_GRACE_SEC)
      .map(([plat, p]) => `${plat}@${new Date(Number(p.retryAt) * 1000).toLocaleTimeString('zh-CN', { hour12: false, timeZone: 'Asia/Shanghai' })}`);
    if (deferred.length) console.log(`[Checkin] 暂缓到点重试: ${deferred.join(', ')}`);
    if (pending.length) {
      console.log(`[Checkin] 触发定时签到（待处理: ${pending.join(', ')}）...`);
      for (const plat of pending) await runCheckin(plat);
    }
    return pending;
  } finally {
    clearInterval(heartbeat);
    await releaseTickLock();
  }
}

export function nextAutoCheckinDelay(state, nowMs = Date.now()) {
  if (state?.autoCheckin === false) return AUTO_CHECKIN_INTERVAL_MS;
  const retryTimes = Object.entries(state?.platforms || {})
    .filter(([plat, p]) => {
      const budget = Number(p?.retryBudget) || retryBudgetFor(plat) || 8;
      return ['failed', 'pending', 'partial'].includes(p?.status)
        && (p.retryCount || 0) < budget && Number(p.retryAt) > 0;
    })
    .map(([, p]) => Number(p.retryAt) * 1000);
  if (retryTimes.some((at) => at <= nowMs)) return 0;
  if (!retryTimes.length) return AUTO_CHECKIN_INTERVAL_MS;
  return Math.min(AUTO_CHECKIN_INTERVAL_MS, Math.max(0, Math.min(...retryTimes) - nowMs));
}

async function scheduleNextAutoCheckin() {
  if (!autoCheckinActive) return;
  const state = await loadState().catch(() => null);
  if (!autoCheckinActive) return;
  autoCheckinTimer = setTimeout(async () => {
    autoCheckinTimer = null;
    try {
      await runAutoCheckinTick();
    } catch (e) {
      console.error('[Checkin] 自动打卡定时器异常:', e.message);
    }
    await scheduleNextAutoCheckin();
  }, nextAutoCheckinDelay(state));
  autoCheckinTimer.unref?.();
}

export function startAutoCheckinScheduler() {
  if (autoCheckinActive) return;
  autoCheckinActive = true;
  void scheduleNextAutoCheckin();
}

/** 停止后台调度器（server.dispose 调用；停止后可重新 start） */
export function stopAutoCheckinScheduler() {
  autoCheckinActive = false;
  if (!autoCheckinTimer) return;
  clearTimeout(autoCheckinTimer);
  autoCheckinTimer = null;
}
