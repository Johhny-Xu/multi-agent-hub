// @ts-check
// 签到卡片「状态 → UI」判定的回归测试。
//
// 覆盖用户报的核心问题：一键全签之后，两个国际版卡片仍显示「立即签到」且点了没用。
// 根因在前端：旧的 isSigned 只认 success/already，其余状态一律渲染成可点的「立即签到」。
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { join } from 'node:path';

const require = createRequire(import.meta.url);
const CLIENT = join(process.cwd(), 'console', 'client');

// 浏览器与 Node 共用同一份实现：这里直接 require 客户端模块
const { cardState, verdictText, parseRunResponse, allCheckinSummary } = require(join(CLIENT, 'checkin-card-state.js'));

test('已签成：按钮禁用并显示「今日已签」', () => {
  const st = cardState({ status: 'success', platform: 'qoder', accountCount: 3, signedAccounts: 3, pendingAccounts: 0 });
  assert.equal(st.clickable, false);
  assert.equal(st.btn, '今日已签');
  assert.equal(st.badge, '今日已领取', 'Credits 平台的已签文案跟别家区分');
});

test('已签成但还有账号没签：按钮变成「补签新增账号 N」且可点', () => {
  const st = cardState({ status: 'success', platform: 'codebuddy', accountCount: 2, signedAccounts: 1, pendingAccounts: 1 });
  assert.equal(st.clickable, true);
  assert.match(st.btn, /补签新增账号 1/);
  assert.equal(st.badge, '部分已签');
});

test('部分成功（partial）：补签个数按「总数-已签数」推导', () => {
  const st = cardState({ status: 'partial', platform: 'qoder', accountCount: 3, signedAccounts: 2, pendingAccounts: 0 });
  assert.equal(st.clickable, true);
  assert.match(st.btn, /补签 1 个账号/);
  assert.equal(st.badge, '部分成功（2/3）');
});

test('partial 也必须尊重冷却、等开窗和缺设备身份', () => {
  const base = { status: 'partial', platform: 'qoder', accountCount: 3, signedAccounts: 2 };
  assert.equal(cardState({ ...base, pendingReason: 'quota_cooldown' }).clickable, false);
  assert.equal(cardState({ ...base, pendingReason: 'quota_cooldown' }).btn, '冷却中');
  assert.equal(cardState({ ...base, pendingReason: 'awaiting_window' }).clickable, false);
  assert.equal(cardState({ ...base, pendingReason: 'awaiting_window' }).btn, '待开启');
  assert.equal(cardState({ ...base, pendingReason: 'identity_missing' }).clickable, false);
  assert.equal(cardState({ ...base, pendingReason: 'identity_missing' }).btn, '无法签到');
  assert.equal(cardState({ ...base, pendingReason: 'awaiting_campaign' }).clickable, true);
});

test('pending + 等开窗：按钮禁用并显示「待开启 HH:MM」（原来显示「立即签到」）', () => {
  const retryAt = Math.floor(Date.now() / 1000) + 600;
  const st = cardState({ status: 'pending', pendingReason: 'awaiting_window', platform: 'qoder', retryAt });
  assert.equal(st.clickable, false, '等开窗时点也没用，必须禁用');
  assert.equal(st.btn, '待开启');
  assert.match(st.badge, /待活动开启（\d{2}:\d{2}）/);
});

test('pending + 额度冷却：按钮禁用并显示「冷却中」', () => {
  const st = cardState({ status: 'pending', pendingReason: 'quota_cooldown', platform: 'qoder' });
  assert.equal(st.clickable, false);
  assert.equal(st.btn, '冷却中');
});

test('pending + 缺设备身份：按钮禁用并说明原因', () => {
  const st = cardState({ status: 'pending', pendingReason: 'identity_missing', platform: 'qoder', message: '本机没有 UMID 组件' });
  assert.equal(st.clickable, false);
  assert.equal(st.badge, '缺少设备身份');
  assert.match(st.tip, /UMID/);
});

test('pending + 上游活动没开：按钮可点「再试一次」（允许手动探测）', () => {
  const st = cardState({ status: 'pending', pendingReason: 'campaign_closed', platform: 'codebuddy' });
  assert.equal(st.clickable, true);
  assert.equal(st.btn, '再试一次');
  assert.equal(st.badge, '活动未开启');
});

test('pending + 等活动行下发：可点「立即签到」', () => {
  const st = cardState({ status: 'pending', pendingReason: 'awaiting_campaign', platform: 'qoder' });
  assert.equal(st.clickable, true);
  assert.equal(st.btn, '立即签到');
});

test('pending + 积分待确认：不再误用 Qoder 的「上游活动行没下发」文案', () => {
  const st = cardState({ status: 'pending', pendingReason: 'await_credits', platform: 'codebuddy' });
  assert.equal(st.clickable, false, '积分异步到账，重复点击不会再领一次');
  assert.equal(st.badge, '积分待确认');
  assert.equal(st.btn, '待确认');
  assert.match(st.tip, /积分/);
  assert.doesNotMatch(st.tip, /活动行/);
  assert.match(verdictText({ status: 'pending', pendingReason: 'await_credits' }), /积分待上游确认/);
});

test('失败 / 受限 / 失效 / 未配置 各自如实显示', () => {
  assert.deepEqual(
    { c: cardState({ status: 'failed' }).clickable, b: cardState({ status: 'failed' }).btn },
    { c: true, b: '重试签到' });
  const r = cardState({ status: 'restricted' });
  assert.equal(r.clickable, false);
  assert.equal(r.btn, '账号受限');
  const e = cardState({ status: 'expired' });
  assert.equal(e.clickable, false);
  assert.equal(e.btn, '需重新登录');
  const u = cardState({ status: 'unconfigured' });
  assert.equal(u.clickable, false);
  assert.equal(u.btn, '配置凭据');
});

test('点击反馈文案说清「在等什么」', () => {
  assert.match(verdictText({ status: 'pending', pendingReason: 'awaiting_window' }), /自动补领/);
  assert.match(verdictText({ status: 'pending', pendingReason: 'campaign_closed' }), /活动未开启/);
  assert.match(verdictText({ status: 'pending', pendingReason: 'quota_cooldown' }), /冷却/);
  assert.match(verdictText({ status: 'success' }), /已签到/);
  assert.match(verdictText({ status: 'partial' }), /部分/);
});

test('签到响应拒绝 HTTP 错误、非 JSON、空响应和业务失败', async () => {
  const httpError = await parseRunResponse(500, '{"error":"boom"}');
  assert.equal(httpError.ok, false);
  assert.match(httpError.error, /boom/);
  const notJson = await parseRunResponse(500, '<html>bad</html>');
  assert.equal(notJson.ok, false);
  assert.match(notJson.error, /非 JSON/);
  const empty = await parseRunResponse(200, '');
  assert.equal(empty.ok, false);
  assert.match(empty.error, /空响应/);
  const nullBody = await parseRunResponse(200, 'null');
  assert.equal(nullBody.ok, false);
  assert.match(nullBody.error, /空响应/);
  const business = await parseRunResponse(200, '{"ok":false,"error":"denied"}');
  assert.equal(business.ok, false);
  assert.match(business.error, /denied/);
  const valid = await parseRunResponse(200, '{"ok":true,"overview":{"platforms":{}}}');
  assert.equal(valid.ok, true);
  // qa-grid 传的是 fetch 的 Response：必须同样解析并把 payload 摊平
  const viaResponse = await parseRunResponse(new Response('{"ok":true,"results":{"qoder":{"status":"success"}}}', { status: 200 }));
  assert.equal(viaResponse.ok, true);
  assert.equal(viaResponse.results.qoder.status, 'success');
  const viaErrorResponse = await parseRunResponse(new Response('{"error":"boom"}', { status: 500 }));
  assert.equal(viaErrorResponse.ok, false);
  assert.match(viaErrorResponse.error, /boom/);
});

test('全签汇总包含 unconfigured，空平台状态不能谎报全部完成', () => {
  const summary = allCheckinSummary({ platforms: {
    qoder: { status: 'success' },
    codebuddy: { status: 'unconfigured' },
  } });
  assert.equal(summary.ok, false);
  assert.match(summary.text, /1\/2 · 1 个待补/);
  assert.deepEqual(summary.still, ['codebuddy']);
  assert.match(allCheckinSummary({ platforms: {} }).text, /未取得平台状态/);
  assert.match(allCheckinSummary({}).title, /无法确认/);
});

test('index.html 在 qa-grid.js 之前加载了 checkin-card-state.js', async () => {
  const html = await readFile(join(CLIENT, 'index.html'), 'utf-8');
  const stateAt = html.indexOf('checkin-card-state.js');
  const gridAt = html.indexOf('./qa-grid.js');
  assert.ok(stateAt > 0, 'index.html 应引入 checkin-card-state.js');
  assert.ok(gridAt > 0, 'index.html 应引入 qa-grid.js');
  assert.ok(stateAt < gridAt, 'checkin-card-state.js 必须先于 qa-grid.js 加载');
});
