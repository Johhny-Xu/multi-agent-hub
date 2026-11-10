// @ts-check
// 豆包每日签到（FEAT-doubao-checkin）：8801 只做调度，浏览器跑在云机。
// 参考 wangmingdong/workbuddy-signin（MIT）doubao_sign_server.js：豆包写接口（landing/checkin、
// item/reward/claim）强制 a_bogus 浏览器签名，cookie 裸调回 710010702，所以签到/领奖都在云机常驻
// Chromium 的真实页面里做（云端脚本 doubao-signer.mjs，签到页用 SamanthaDoubao 客户端 UA，登录用普通 UA）。
// 本模块经 ssh 调那个脚本，拿回一行 JSON；登录态只在云机浏览器 profile 里，这里只缓存「是否已登录」。
import { spawn } from 'node:child_process';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, dirname, resolve } from 'node:path';

const HOME = process.env.AGENTHUB_HOME ? resolve(process.env.AGENTHUB_HOME) : homedir();
/** 只记「云机浏览器里是否已登录豆包」与最近一次检查时间，不含任何 cookie。 */
const LOGIN_CACHE = process.env.DOUBAO_LOGIN_CACHE
  ? resolve(process.env.DOUBAO_LOGIN_CACHE)
  : join(HOME, '.agenthub', 'doubao-login.json');

/** 云机签名器命令，取自 DOUBAO_SIGNER_CMD（空白分隔，例：`ssh -o BatchMode=yes <cloud-host> node doubao-signer/doubao-signer.mjs`）。
 * 不内置任何主机：没配置时返回 null，签到卡显示「未配置云机签名器」。 */
export function signerCommand(env = process.env) {
  const raw = String(env.DOUBAO_SIGNER_CMD || '').trim();
  return raw ? raw.split(/\s+/) : null;
}

/** 取子进程输出里最后一行 JSON。 */
export function lastJsonLine(text) {
  const lines = String(text || '').split('\n').map((l) => l.trim()).filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i--) {
    if (!lines[i].startsWith('{')) continue;
    try { return JSON.parse(lines[i]); } catch { /* 继续往前找 */ }
  }
  return null;
}

/** @param {string} cmd @param {{ timeoutMs?: number, env?: NodeJS.ProcessEnv }} [opts] */
export function runSigner(cmd, opts = {}) {
  const base = signerCommand(opts.env);
  if (!base) return Promise.resolve({ ok: false, error: 'signer_unconfigured' });
  const argv = [...base, cmd];
  const timeoutMs = opts.timeoutMs ?? 170_000;
  return new Promise((resolvePromise) => {
    let out = '';
    let err = '';
    let child;
    try {
      child = spawn(argv[0], argv.slice(1), { stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (e) {
      resolvePromise({ ok: false, error: `spawn_failed: ${String(e && /** @type {any} */ (e).message || e)}` });
      return;
    }
    const timer = setTimeout(() => { child.kill('SIGKILL'); }, timeoutMs);
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });
    child.on('error', (e) => { clearTimeout(timer); resolvePromise({ ok: false, error: `spawn_failed: ${e.message}` }); });
    child.on('close', (code) => {
      clearTimeout(timer);
      const parsed = lastJsonLine(out);
      if (parsed) { resolvePromise(parsed); return; }
      const tail = err.replace(/\s+/g, ' ').trim().slice(-200);
      resolvePromise({ ok: false, error: code === null ? 'timeout' : `signer_exit_${code}${tail ? `: ${tail}` : ''}` });
    });
  });
}

export async function readDoubaoLogin() {
  try {
    const j = JSON.parse(await readFile(LOGIN_CACHE, 'utf-8'));
    return { loggedIn: j.loggedIn === true, checkedAt: Number(j.checkedAt) || 0 };
  } catch {
    return { loggedIn: false, checkedAt: 0 };
  }
}

async function writeDoubaoLogin(loggedIn) {
  if (typeof loggedIn !== 'boolean') return;
  await mkdir(dirname(LOGIN_CACHE), { recursive: true }).catch(() => {});
  await writeFile(LOGIN_CACHE, JSON.stringify({ loggedIn, checkedAt: Date.now() })).catch(() => {});
}

/** 签到区账号行：豆包只有云机浏览器里那一个登录号。 */
export async function listDoubaoAccounts() {
  const st = await readDoubaoLogin();
  if (!st.loggedIn) return [];
  return [{ name: 'doubao', display: '豆包（云机浏览器）', identity: 'doubao:cloud-browser', active: true, source: '云机浏览器登录态', token: 'cloud-browser' }];
}

/** 把云端错误翻成签到卡上的人话。 */
export function describeSignerError(error) {
  const e = String(error || '');
  if (e.startsWith('egress_down')) return '国内出口隧道没连上（本机的 doubao-egress 服务），豆包会按海外 IP 拒绝访问';
  if (e === 'signer_unconfigured') return '未配置云机签名器：设置环境变量 DOUBAO_SIGNER_CMD 后重启';
  if (e.startsWith('region_ban')) return '豆包按地区拒绝了云机出口 IP（需要国内出口）';
  if (e === 'not_logged_in') return '云机浏览器还没登录豆包：点「扫码登录」，用豆包 App 扫码';
  if (e === 'timeout') return '云机签到超时（浏览器或网络太慢），稍后自动重试';
  if (e.startsWith('signer_exit_255') || e.startsWith('spawn_failed')) return '连不上云机（ssh 失败），稍后自动重试';
  if (e === 'detail_failed') return '读取豆包任务面板失败';
  return `云机签到出错：${e.slice(0, 160)}`;
}

/**
 * 云端 checkin 结果 → 签到中枢的平台结果（与其它平台同形）。纯函数，便于单测。
 * @param {any} r 云端 doubao-signer.mjs checkin 的输出
 */
export function doubaoOutcome(r, today, time) {
  const base = { platform: 'doubao', credits: 0, consecutiveDays: 0, today, time };
  const row = (status, message, credits = 0) => ({
    ...base, ok: status === 'success' || status === 'already', status, message,
    credits,
    accounts: [{ name: 'doubao', display: '豆包（云机浏览器）', identity: 'doubao:cloud-browser', active: true, status, message, credits, source: '云机浏览器登录态' }],
  });
  if (!r || r.loggedIn === false) {
    return { ...row('expired', describeSignerError('not_logged_in')), accounts: [] , loginRequired: true };
  }
  if (r.ok === false && !r.signed) {
    if (r.error === 'detail_failed') return row('failed', `${describeSignerError(r.error)}（code ${r.detailCode ?? '?'}${r.detailMsg ? `：${r.detailMsg}` : ''}）`);
    return row('failed', describeSignerError(r.error));
  }
  const claims = Array.isArray(r.claims) ? r.claims : [];
  const claimed = claims.filter((c) => c && c.ok);
  const failedClaims = claims.filter((c) => c && !c.ok);
  const gained = claimed.reduce((s, c) => s + (Number(c.reward) || 0), 0);
  const days = Number(r.daily && (r.daily.continuous_days ?? r.daily.consecutive_days ?? r.daily.checkin_days)) || 0;
  const parts = [];
  if (r.signed === 'success') parts.push('签到成功');
  else if (r.signed === 'already') parts.push('今日已签到');
  else parts.push(`签到未成功${r.checkinCode != null ? `（code ${r.checkinCode}${r.checkinMsg ? `：${r.checkinMsg}` : ''}）` : '（没找到「立即签到」按钮或没拿到签到响应）'}`);
  if (days) parts.push(`连续 ${days} 天`);
  if (claimed.length) parts.push(`领取 ${claimed.length} 个已完成任务${gained ? ` +${gained}` : ''}`);
  if (failedClaims.length) parts.push(`${failedClaims.length} 个任务领取失败（${failedClaims.map((c) => `${c.title}:${c.resCode}`).join('，').slice(0, 120)}）`);
  if (!claims.length) parts.push('没有待领取的已完成任务');
  const message = parts.join('，');
  let status;
  if (r.signed === 'failed') status = 'failed';
  else if (failedClaims.length) status = 'partial';
  else status = r.signed === 'already' && !claimed.length ? 'already' : 'success';
  const res = row(status, message, gained);
  return { ...res, consecutiveDays: days };
}

export async function checkinDoubao(deps = {}) {
  const run = deps.runSigner || runSigner;
  const now = new Date();
  const today = deps.today || new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai' }).format(now);
  const time = deps.time || now.toLocaleTimeString('zh-CN', { hour12: false, timeZone: 'Asia/Shanghai' });
  // 没扫码登录过就不去连云机：结果是「待扫码」，当天不再空转（扫码后由登录轮询立刻补签）
  if (!deps.runSigner && !(await readDoubaoLogin()).loggedIn) return doubaoOutcome({ ok: false, loggedIn: false, error: 'not_logged_in' }, today, time);
  const r = await run('checkin');
  if (r && typeof r.loggedIn === 'boolean') await writeDoubaoLogin(r.loggedIn);
  return doubaoOutcome(r, today, time);
}

/** 出码：返回二维码 PNG（base64）给前端展示；凭据从不经过这里。 */
export async function doubaoLoginStart(deps = {}) {
  const run = deps.runSigner || runSigner;
  const r = await run('login-start');
  if (r && typeof r.loggedIn === 'boolean') await writeDoubaoLogin(r.loggedIn);
  if (r && r.loggedIn) return { ok: true, loggedIn: true };
  if (!r || r.ok === false) return { ok: false, loggedIn: false, error: describeSignerError(r && r.error) };
  if (!r.qrFound || !r.qrPng) return { ok: false, loggedIn: false, error: '云机浏览器打开了豆包登录页，但没找到二维码' };
  return { ok: true, loggedIn: false, qrPng: String(r.qrPng) };
}

export async function doubaoLoginPoll(deps = {}) {
  const run = deps.runSigner || runSigner;
  const r = await run('login-poll', { timeoutMs: 60_000 });
  if (r && typeof r.loggedIn === 'boolean') await writeDoubaoLogin(r.loggedIn);
  if (!r || r.ok === false) return { ok: false, loggedIn: false, error: describeSignerError(r && r.error) };
  return { ok: true, loggedIn: !!r.loggedIn };
}
