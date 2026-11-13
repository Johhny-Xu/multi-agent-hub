#!/usr/bin/env node
// doubao-signer.mjs —— 豆包每日签到「云机浏览器」端（跑在云服务器，不在本机）。
// 参考 wangmingdong/workbuddy-signin（MIT）doubao_sign_server.js / doubao_sign.js：
//   豆包写接口（landing/checkin、item/reward/claim）强制 a_bogus 浏览器签名，cookie 裸调回 710010702，
//   必须在真实浏览器页面里 fetch（前端包装的 window.fetch 自动加签）；签到本身自 2026-10-31 起只认
//   客户端 UI 点击「立即签到」，所以签到页要用带 SamanthaDoubao/<版本> 的客户端 UA 打开（登录用普通 UA）。
// 浏览器：本机常驻 Chromium（独立 profile，CDP 只绑 127.0.0.1），由本脚本按需拉起；不碰别人的浏览器。
// 用法（每条命令输出一行 JSON 到 stdout）：
//   node doubao-signer.mjs status        登录态 + 今日签到 + 任务列表（只读）
//   node doubao-signer.mjs login-start   打开登录页、点「登录」，截二维码 → {qrPng: base64}
//   node doubao-signer.mjs login-poll    用户扫码后轮询：拿到登录 cookie 即 loggedIn=true
//   node doubao-signer.mjs checkin       签到（已签则跳过）+ 只领 task_status=2 的已完成任务（幂等）
// 不打印 cookie / token。
import { spawn } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync, openSync } from 'node:fs';
import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import { join } from 'node:path';

const DIR = process.env.DOUBAO_SIGNER_DIR || join(homedir(), 'doubao-signer');
const PROFILE = join(DIR, 'profile');
const STATE = join(DIR, 'state.json');
const PORT = Number(process.env.DOUBAO_CDP_PORT || 9341);
const CDP = `http://127.0.0.1:${PORT}`;
const CHROME = process.env.DOUBAO_CHROME || '/usr/bin/chromium';
const DISPLAY = process.env.DOUBAO_DISPLAY || process.env.DISPLAY || ':1';
const CLIENT_VER = process.env.DOUBAO_CLIENT_VERSION || '2.35.8';
const CHROME_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36';
const CLIENT_UA = `${CHROME_UA} SamanthaDoubao/${CLIENT_VER}`;
const BASE = 'https://www.doubao.com';
const SIGN_PAGE = `${BASE}/pc/agent-explore`;
const LOGIN_PAGE = `${BASE}/chat/`;
const SCENE = 'pc_incentive_task_mvp_v3';
const QP = 'version_code=20800&language=zh&device_platform=pc&doubao_device_platform=pc&aid=497858&real_aid=497858&pkg_type=release_version&samantha_web=0&web_platform=pc&runtime=pc';
const LOGIN_COOKIES = ['sessionid', 'sessionid_ss', 'sid_tt'];
// 豆包对海外 IP 直接跳 /security/doubao-region-ban：云机浏览器经本机反向 SOCKS（ssh -R）出口走国内 IP。
// 只是网络出口，浏览器与渲染都在云机。设为空字符串则直连。
const PROXY = process.env.DOUBAO_PROXY ?? 'socks5://127.0.0.1:19341';

mkdirSync(DIR, { recursive: true });
const require = createRequire(join(DIR, 'x.js'));
const { chromium } = require('playwright-core');

const out = (o) => { process.stdout.write(JSON.stringify(o) + '\n'); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const loadState = () => { try { return JSON.parse(readFileSync(STATE, 'utf8')); } catch { return {}; } };
const saveState = (s) => writeFileSync(STATE, JSON.stringify(s));

async function cdpUp() {
  try { const r = await fetch(`${CDP}/json/version`, { signal: AbortSignal.timeout(2500) }); return r.ok; } catch { return false; }
}

async function proxyUp() {
  if (!PROXY) return true;
  const m = PROXY.match(/:(\d+)$/);
  const net = await import('node:net');
  return new Promise((res) => {
    const s = net.connect(Number(m && m[1]), '127.0.0.1');
    s.once('connect', () => { s.destroy(); res(true); });
    s.once('error', () => res(false));
    setTimeout(() => { s.destroy(); res(false); }, 2000);
  });
}

async function ensureBrowser() {
  if (!(await proxyUp())) throw new Error(`egress_down: 国内出口隧道 ${PROXY} 不通（本机的 doubao-egress 服务没连上）`);
  const st = loadState();
  if (await cdpUp()) {
    if ((st.launchProxy ?? '') === PROXY) return;
    // 本脚本自己的专用 Chromium（独立 profile）换出口参数：只关这一个进程，不碰别的浏览器
    await new Promise((r) => spawn('pkill', ['-f', '--', `--user-data-dir=${PROFILE}`]).on('exit', r));
    for (let i = 0; i < 20 && (await cdpUp()); i++) await sleep(500);
  }
  mkdirSync(PROFILE, { recursive: true });
  const log = openSync(join(DIR, 'chromium.log'), 'a');
  const child = spawn(CHROME, [
    `--remote-debugging-port=${PORT}`, '--remote-debugging-address=127.0.0.1', `--user-data-dir=${PROFILE}`,
    '--no-first-run', '--no-default-browser-check', '--disable-blink-features=AutomationControlled',
    '--disable-dev-shm-usage', '--window-size=1280,900', '--lang=zh-CN', `--user-agent=${CHROME_UA}`,
    ...(PROXY ? [`--proxy-server=${PROXY}`] : []), 'about:blank',
  ], { detached: true, stdio: ['ignore', log, log], env: { ...process.env, DISPLAY, TZ: 'Asia/Shanghai' } });
  child.unref();
  saveState({ ...st, launchProxy: PROXY });
  for (let i = 0; i < 40; i++) { if (await cdpUp()) return; await sleep(500); }
  throw new Error('云机 Chromium 没起来（CDP 未就绪）');
}

async function connect() {
  await ensureBrowser();
  const browser = await chromium.connectOverCDP(CDP, { timeout: 20000 });
  const ctx = browser.contexts()[0];
  return { browser, ctx };
}

async function loggedIn(ctx) {
  const cookies = await ctx.cookies(BASE);
  return cookies.some((c) => LOGIN_COOKIES.includes(c.name) && c.value);
}

async function openPage(ctx, url, ua) {
  const page = await ctx.newPage();
  const cdp = await ctx.newCDPSession(page);
  await cdp.send('Network.setUserAgentOverride', { userAgent: ua, acceptLanguage: 'zh-CN,zh;q=0.9', platform: 'Win32' });
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await sleep(1500);
  if (page.url().includes('region-ban')) { await page.close().catch(() => {}); throw new Error('region_ban: 豆包按地区拒绝了当前出口 IP（需国内出口）'); }
  if (ua.includes('SamanthaDoubao') && (await page.getByText('版本过低', { exact: true }).count().catch(() => 0))) { await page.close().catch(() => {}); throw new Error('client_too_old: 豆包提示客户端版本过低，需调大 DOUBAO_CLIENT_VERSION'); }
  return page;
}

/** 页面内 fetch：豆包前端包装过的 window.fetch 会自动加 a_bogus。 */
async function pageFetch(page, method, path, body) {
  return page.evaluate(async ({ method, path, body, QP, BASE }) => {
    const sep = path.includes('?') ? '&' : '?';
    const init = { method, credentials: 'include', headers: { 'Content-Type': 'application/json' } };
    if (body !== undefined) init.body = JSON.stringify(body);
    const r = await fetch(BASE + path + sep + QP, init);
    const t = await r.text();
    try { return JSON.parse(t); } catch { return { code: -1, __http: r.status, __raw: t.slice(0, 200) }; }
  }, { method, path, body, QP, BASE });
}

async function waitSigner(page) {
  for (let i = 0; i < 30; i++) {
    if (await page.evaluate(() => typeof window.byted_acrawler !== 'undefined').catch(() => false)) return true;
    await sleep(1000);
  }
  return false;
}

/** 任务面板：先按用户给的 GET，拿不到再按参考实现的 POST。 */
async function readDetail(page) {
  let d = await pageFetch(page, 'GET', `/alice/ug/campaign/v3/detail/?campaign_code=${SCENE}`);
  if (!(d && d.code === 0 && d.data)) d = await pageFetch(page, 'POST', '/alice/ug/campaign/v3/detail/', { campaign_group_code: SCENE, AgwCommonParam: {} });
  const tasks = (d && d.data && (d.data.tasks || d.data.task_list)) || [];
  return { code: d && d.code, msg: d && (d.msg || d.message), tasks };
}

const reward = (t) => (Array.isArray(t.reward_summaries) && t.reward_summaries.length
  ? t.reward_summaries.reduce((s, x) => s + (Number(x.reward_amount) || 0), 0)
  : (Number(t.reward_amount) || 0));
const isSignin = (t) => t.campaign_code === 'daily_signin' || t.task_kind === 'daily_signin';
const taskView = (t) => ({ code: t.campaign_code, title: t.title || t.subtitle || t.campaign_code, status: t.task_status, reward: reward(t) });

async function status() {
  const { browser, ctx } = await connect();
  try {
    if (!(await loggedIn(ctx))) return out({ ok: true, loggedIn: false });
    const page = await openPage(ctx, SIGN_PAGE, CLIENT_UA);
    try {
      await waitSigner(page);
      const d = await readDetail(page);
      const daily = (d.tasks.find(isSignin) || {}).daily_checkin || null;
      out({ ok: d.code === 0, loggedIn: true, detailCode: d.code, detailMsg: d.msg, checkedInToday: !!(daily && daily.checked_in_today), daily, tasks: d.tasks.map(taskView) });
    } finally { await page.close().catch(() => {}); }
  } finally { await browser.close().catch(() => {}); }
}

async function loginStart() {
  const { browser, ctx } = await connect();
  try {
    if (await loggedIn(ctx)) return out({ ok: true, loggedIn: true });
    const st = loadState();
    // 关掉上一次没扫的登录页，重新出码（二维码几分钟就过期）
    for (const p of ctx.pages()) if (p.url().startsWith(BASE)) await p.close().catch(() => {});
    const page = await openPage(ctx, LOGIN_PAGE, CHROME_UA);
    const btn = page.getByRole('button', { name: '登录', exact: true }).first();
    await btn.waitFor({ state: 'visible', timeout: 20000 }).catch(() => {});
    await btn.click({ timeout: 10000 }).catch(() => {});
    // 登录弹窗右侧「打开 豆包 / 飞书 App 扫码登录」的二维码
    const qrEl = page.locator('[data-testid="qrcode_image"]').first();
    await qrEl.waitFor({ state: 'visible', timeout: 20000 }).catch(() => {});
    await sleep(3500);
    let qr = null;
    if (await qrEl.isVisible().catch(() => false)) qr = qrEl;
    let shot;
    const box = qr ? await qr.boundingBox().catch(() => null) : null;
    if (box) shot = await page.screenshot({ timeout: 10000, clip: { x: Math.max(0, box.x - 12), y: Math.max(0, box.y - 12), width: box.width + 24, height: box.height + 24 } });
    else shot = await page.screenshot({ timeout: 10000 });
    saveState({ ...st, loginUrl: page.url(), loginStartedAt: Date.now() });
    out({ ok: true, loggedIn: false, qrFound: !!qr, qrPng: shot.toString('base64'), pageTitle: await page.title().catch(() => '') });
  } finally { await browser.close().catch(() => {}); }
}

async function loginPoll() {
  const { browser, ctx } = await connect();
  try {
    const ok = await loggedIn(ctx);
    if (ok) {
      const st = loadState();
      for (const p of ctx.pages()) if (p.url().startsWith(BASE)) await p.close().catch(() => {});
      saveState({ ...st, loginUrl: '', loggedInAt: Date.now() });
    }
    out({ ok: true, loggedIn: ok });
  } finally { await browser.close().catch(() => {}); }
}

async function checkin() {
  const { browser, ctx } = await connect();
  try {
    if (!(await loggedIn(ctx))) return out({ ok: false, loggedIn: false, error: 'not_logged_in' });
    const page = await openPage(ctx, SIGN_PAGE, CLIENT_UA);
    let checkinResp = null;
    page.on('response', async (r) => {
      if (!r.url().includes('/alice/ug/campaign/landing/checkin')) return;
      try { checkinResp = await r.json(); } catch { checkinResp = { code: -1, msg: 'unparsed' }; }
    });
    try {
      const signer = await waitSigner(page);
      let d = await readDetail(page);
      if (d.code !== 0) return out({ ok: false, loggedIn: true, signer, error: 'detail_failed', detailCode: d.code, detailMsg: d.msg });
      let daily = (d.tasks.find(isSignin) || {}).daily_checkin || null;
      let signed = 'already';
      if (!(daily && daily.checked_in_today)) {
        const btn = page.getByText('立即签到', { exact: true }).first();
        await btn.waitFor({ state: 'visible', timeout: 25000 }).catch(() => {});
        if (await btn.isVisible().catch(() => false)) {
          await btn.click();
          for (let i = 0; i < 30 && !checkinResp; i++) await sleep(500);
        }
        await sleep(1500);
        d = await readDetail(page);
        daily = (d.tasks.find(isSignin) || {}).daily_checkin || null;
        signed = daily && daily.checked_in_today ? 'success' : 'failed';
      }
      // 只领 task_status=2（已完成未领）的任务；已领/未完成/无奖励一律跳过 → 幂等
      const claims = [];
      for (const t of d.tasks) {
        if (isSignin(t) || t.task_status !== 2 || reward(t) <= 0 || !t.campaign_code) continue;
        const r = await pageFetch(page, 'POST', '/alice/ug/campaign/item/reward/claim/', { campaign_code: t.campaign_code, campaign_group_code: t.campaign_group_code ?? SCENE, AgwCommonParam: {} });
        claims.push({ ...taskView(t), ok: !!(r && r.code === 0), resCode: r && r.code, resMsg: (r && (r.msg || r.message)) || '' });
        await sleep(800);
      }
      out({
        ok: signed !== 'failed' && claims.every((c) => c.ok), loggedIn: true, signer, signed,
        checkinCode: checkinResp ? checkinResp.code : null, checkinMsg: checkinResp ? (checkinResp.msg || checkinResp.message || '') : '',
        daily, claims, tasks: d.tasks.map(taskView),
      });
    } finally { await page.close().catch(() => {}); }
  } finally { await browser.close().catch(() => {}); }
}

const cmd = process.argv[2] || 'status';
const fns = { status, 'login-start': loginStart, 'login-poll': loginPoll, checkin };
if (!fns[cmd]) { out({ ok: false, error: `unknown command ${cmd}` }); process.exit(2); }
const killer = setTimeout(() => { out({ ok: false, error: 'timeout' }); process.exit(3); }, Number(process.env.DOUBAO_SIGNER_TIMEOUT_MS || 150000));
fns[cmd]().then(() => { clearTimeout(killer); process.exit(0); }, (e) => { clearTimeout(killer); out({ ok: false, error: String(e && e.message || e).slice(0, 300) }); process.exit(1); });
