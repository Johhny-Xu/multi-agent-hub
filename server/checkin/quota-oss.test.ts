// @ts-check
// QUOTA-OSS-1 的定向回归：额度查询照开源反代实现后的解析与请求形状。
// 每项断言都对着参考实现的出处（文件:行写在 vendor-quota.mjs / quota-deep.mjs 内）：
//   zcode      → HUB zcode-upstream.ts / zcode-entitlements.ts + 9R glm.js
//   minimax    → HUB minimax-credits.ts（credit/details）
//   antigravity→ 9R usage/google.js + antigravity-weekly.js
//   trae       → HUB trae-credits.ts（credits_limit=-1 无限、ide_user_ent_usage 兜底）
//   cline      → HUB cline-quota.ts / cline-credits.ts（workos: 前缀）
//   perch      → jawkills/perch2api gateway.mjs（无剩余字段不编造）
import { test, assert } from './testing/testkit.ts';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const vq = await import('./vendor-quota.mjs');
const deep = await import('./quota-deep.mjs');

const jsonRes = (body: unknown, status = 200) => new Response(JSON.stringify(body), {
  status,
  headers: { 'Content-Type': 'application/json' },
});

type RouterCall = { url: string; headers: Record<string, string>; method: string; body: unknown };
type MockFetchInput = Parameters<typeof fetch>[0];
type MockOpts = { headers?: Record<string, string | undefined>; method?: string; body?: unknown };
type Responder = Record<string, unknown> | ((url: string, opts: MockOpts) => Response);
type FetchRouter = ((url: MockFetchInput, opts?: MockOpts) => Promise<Response>) & { calls: RouterCall[] };

/** 按 URL 片段路由的 mock fetch，记录每次请求的 url/headers/method */
function fetchRouter(routes: Array<[string, Responder]>): FetchRouter {
  const calls: RouterCall[] = [];
  const impl = (async (url: MockFetchInput, opts: MockOpts = {}): Promise<Response> => {
    const u = String(url);
    calls.push({ url: u, headers: (opts.headers || {}) as Record<string, string>, method: opts.method || 'GET', body: opts.body });
    for (const [pattern, responder] of routes) {
      if (u.includes(pattern)) {
        // responder 是函数则自己产 Response；是普通对象则每次现场包一层（不能预构造
        // Response——body 只能读一次，二次消费会拿到空串）
        return typeof responder === 'function' ? responder(u, opts) : jsonRes(responder);
      }
    }
    return jsonRes({ error: 'no route' }, 404);
  }) as FetchRouter;
  impl.calls = calls;
  return impl;
}

// ---------------------------------------------------------------- zcode

test('zcode：balance 解析按模型分桶（HUB zcode-entitlements 实测形状）', () => {
  const parsed = vq.parseZcodeBalance({
    code: 200,
    data: {
      balances: [
        { show_name: 'GLM-5.3', unit_type: 'token', total_units: 3000000, used_units: 1000000, remaining_units: 2000000, available_units: 2000000, expires_at: 1794000000000, capabilities: ['model:glm-5.3'] },
        { show_name: 'GLM-5.3-Flash', unit_type: 'token', total_units: 5000000, used_units: 0, remaining_units: 5000000, capabilities: ['model:glm-5.3-flash'] },
        { show_name: '通用赠送', unit_type: 'token', total_units: 100000000, used_units: 0, remaining_units: 100000000, capabilities: [] },
      ],
    },
  })!;
  assert.equal(parsed.enterprise, false);
  assert.equal(parsed.buckets.length, 3);
  assert.deepEqual(parsed.buckets[0].models, ['glm-5.3']);
  assert.equal(parsed.buckets[0].remaining, 2000000);
  assert.equal(parsed.buckets[1].models[0], 'glm-5.3-flash');
  // 通用桶：capabilities 无 model: 项 ⇒ 无模型归属
  assert.deepEqual(parsed.buckets[2].models, []);
  // 字符串数字也要解析出来（HUB 对这条踩过坑）
  const strParsed = vq.parseZcodeBalance({ data: { balances: [{ show_name: 'X', total_units: '3000000', used_units: '0', remaining_units: '3000000' }] } })!;
  assert.equal(strParsed.buckets[0].total, 3000000);
});

test('zcode：企业版 displayMode=enterprise 不下发数字，不得显示成 0', () => {
  const parsed = vq.parseZcodeBalance({ data: { displayMode: 'enterprise', balances: [] } })!;
  assert.equal(parsed.enterprise, true);
  assert.deepEqual(parsed.buckets, []);
});

test('zcode：Coding Plan monitor 解析照 9R glm.js（limits[].percentage / unit 3→5h / 6→周）', () => {
  const credit = vq.parseGlmQuotaLimits({
    code: 200,
    data: {
      limits: [
        { type: 'CREDIT_LIMIT', unit: 3, number: 5, percentage: 25, nextResetTime: 1787905548392 },
        { type: 'CREDIT_LIMIT', unit: 6, number: 1, percentage: 10, nextResetTime: 1788492142997 },
      ],
      level: 'lite',
    },
    success: true,
  });
  const rows = credit.quotas;
  assert.deepEqual(Object.keys(rows), ['Session (5h)', 'Weekly (7d)']);
  assert.equal(rows['Session (5h)'].used, 25);
  assert.equal(rows['Session (5h)'].remaining, 75);
  assert.equal(rows['Session (5h)'].total, 100);
  assert.equal(rows['Session (5h)'].resetAt, new Date(1787905548392).toISOString());
  assert.equal(credit.plan, 'Lite');

  const tokens = vq.parseGlmQuotaLimits({ data: { limits: [{ type: 'TOKENS_LIMIT', percentage: 40, nextResetTime: 1787905548392 }], level: 'standard' } });
  assert.equal(tokens.quotas.Tokens.used, 40);
  assert.equal(tokens.plan, 'Standard');
});

test('zcode：请求头带 X-Device-Mid 与 Bearer（缺 mid 上游 400 code 3001）', () => {
  const headers = vq.zcodeQuotaHeaders('mid-abc', 'Bearer jwt-token');
  assert.equal(headers['X-Device-Mid'], 'mid-abc');
  assert.equal(headers.Authorization, 'Bearer jwt-token');
  assert.equal(headers['X-ZCode-App-Version'], '3.16.3');
  assert.equal(headers['X-Platform'], 'win32-x64');
  assert.ok(headers['X-Session-Id']);
  const noAuth = vq.zcodeQuotaHeaders('mid-abc');
  assert.equal(noAuth.Authorization, undefined);
});

test('zcode：device_mid 优先官方客户端 telemetry-state，找不到才生成并持久化', async () => {
  const home = await mkdtemp(join(tmpdir(), 'zcode-mid-'));
  try {
    const zcodeDir = join(home, '.zcode', 'v2');
    await mkdir(zcodeDir, { recursive: true });
    await writeFile(join(zcodeDir, 'telemetry-state.json'), JSON.stringify({ deviceMid: 'official-mid-1234' }));
    const official = await vq.resolveZcodeDeviceMid(home);
    assert.equal(official.deviceMid, 'official-mid-1234');
    assert.equal(official.source, 'official-client');

    // 无官方文件：生成一次并持久化，第二次读同一份
    const emptyHome = await mkdtemp(join(tmpdir(), 'zcode-mid2-'));
    try {
      const first = await vq.resolveZcodeDeviceMid(emptyHome);
      assert.equal(first.source, 'generated');
      assert.ok(first.deviceMid.length >= 16);
      const second = await vq.resolveZcodeDeviceMid(emptyHome);
      assert.equal(second.deviceMid, first.deviceMid);
      assert.equal(second.source, 'hub-cache');
      const persisted = (await readFile(join(emptyHome, '.agenthub', 'zcode-device-mid'), 'utf-8')).trim();
      assert.equal(persisted, first.deviceMid);
    } finally { await rm(emptyHome, { recursive: true, force: true }); }
  } finally { await rm(home, { recursive: true, force: true }); }
});

test('zcode：start-plan 主链路（mock fetch）——桶行、单位 token、计划名', async (t) => {
  const router = fetchRouter([
    ['zcode.z.ai/api/v1/zcode-plan/billing/balance', (_url, opts) => {
      // device_mid 来自测试机的官方客户端/持久化副本，这里只断言非空（缺 mid 上游 3001）
      assert.equal(typeof opts.headers!['X-Device-Mid'], 'string');
      assert.ok(opts.headers!['X-Device-Mid']!.length > 0);
      assert.equal(opts.headers!.Authorization, 'Bearer jwt-e2e');
      return jsonRes({
        code: 200,
        data: { balances: [{ show_name: 'GLM-5.3', unit_type: 'token', total_units: 3000000, used_units: 1200000, remaining_units: 1800000, capabilities: ['model:glm-5.3'] }] },
      });
    }],
  ]);
  t.mock.method(globalThis, 'fetch', router);
  const out = await vq.fetchZcodeQuota({ zcodeJwt: 'jwt-e2e', activeProvider: 'bigmodel' });
  assert.equal(out.plan, 'ZCode');
  assert.equal(out.quotas!.length, 1);
  assert.equal(out.quotas![0].displayName, 'GLM-5.3');
  assert.equal(out.quotas![0].unit, 'token');
  assert.equal(out.quotas![0].total, 3000000);
  assert.equal(out.quotas![0].remaining, 1800000);
});

// ---------------------------------------------------------------- minimaxcode

test('minimax：credit/details 余额 = Σ remaining_amount（字符串），每包带 expire_at_ms', () => {
  const parsed = vq.parseMinimaxCreditDetails({
    details: [
      { remaining_amount: '800.00', consumed_amount: '0.00', granted_amount: '800.00', credit_type: 2, granted_at_ms: 1790645562328, expire_at_ms: 1793203200000 },
      { remaining_amount: '1000.00', granted_at_ms: 1790559651000, expire_at_ms: 1793116800000 },
    ],
    total_count: 2,
    base_resp: { status_code: 0, status_msg: 'ok' },
  })!;
  assert.equal(parsed.balance, 1800);
  assert.equal(parsed.packages.length, 2);
  assert.match(parsed.packages[0].name, /积分包/);
  assert.equal(parsed.packages[0].expireAt, new Date(1793203200000).toISOString());
});

test('minimax：业务码在 base_resp.status_code（HTTP 200 也可能带错）；details 缺失 ⇒ 余额 0', () => {
  const bizError = vq.parseMinimaxCreditDetails({ base_resp: { status_code: 1004, status_msg: 'invalid token' } });
  assert.match(bizError!.error!, /invalid token/);
  const empty = vq.parseMinimaxCreditDetails({ total_count: 0, base_resp: { status_code: 0 } })!;
  assert.equal(empty.balance, 0);
  assert.deepEqual(empty.packages, []);
  // 形状完全不对 ⇒ null
  assert.equal(vq.parseMinimaxCreditDetails({ hello: 1 }), null);
});

test('minimax：fetchMiniMaxQuota 以真实余额为主行、签到为附加行（mock fetch）', async (t) => {
  const router = fetchRouter([
    ['agent.minimax.cn/minimax-cloud/api/v1/credit/details', {
      details: [{ remaining_amount: '1234.50', granted_at_ms: 1790645562328, expire_at_ms: 1793203200000 }],
      total_count: 1,
      base_resp: { status_code: 0, status_msg: 'ok' },
    }],
  ]);
  t.mock.method(globalThis, 'fetch', router);
  // 签到面板在本机凭据缺失时返回 null，不阻断余额展示
  const out = await vq.fetchMiniMaxQuota('token-e2e');
  assert.ok(out.quotas!.length >= 1);
  const balance = out.quotas!.find((q) => q.name === '积分余额');
  assert.ok(balance, '必须有积分余额主行');
  assert.equal(balance.total, 1234.5);
  assert.equal(balance.unit, 'credit');
});

// ---------------------------------------------------------------- antigravity

test('antigravity：retrieveUserQuotaSummary 周/5h 分族解析（9R antigravity-weekly.js）', () => {
  const quotas = vq.parseAntigravityWeeklySummary({
    groups: [
      { displayName: 'Gemini Assistance', buckets: [
        { bucketId: 'b-week', window: 'weekly', remainingFraction: 0.9, resetTime: 1787905548392 },
        { bucketId: 'b-5h', window: '5h', remainingFraction: 0.5, resetTime: 1787820000000 },
      ] },
      { displayName: 'Claude & GPT', buckets: [
        { window: 'weekly', remainingFraction: 0.8 },
        { window: '5h', disabled: true, remainingFraction: 0.4 },
      ] },
    ],
  });
  assert.equal(quotas.gemini_weekly.remainingPercentage, 90);
  assert.equal(quotas.gemini_session.remainingPercentage, 50);
  assert.equal(quotas.claude_gpt_weekly.remainingPercentage, 80);
  // disabled 的 5h 桶保留为 0，disabled 的周桶被跳过
  assert.equal(quotas.claude_gpt_session.remainingPercentage, 0);
  assert.equal(quotas.gemini_weekly.total, 1000);
  assert.equal(quotas.gemini_weekly.displayName, 'Gemini (Weekly)');
});

test('antigravity：未知组与 disabled 周桶不产出', () => {
  const quotas = vq.parseAntigravityWeeklySummary({
    groups: [
      { displayName: 'Mystery Group', buckets: [{ window: 'weekly', remainingFraction: 0.5 }] },
      { displayName: 'Gemini', buckets: [{ window: 'weekly', disabled: true, remainingFraction: 0.3 }] },
    ],
  });
  assert.deepEqual(quotas, {});
});

test('antigravity：分模型白名单与 total=1000（9R google.js）；免费档不分模型', () => {
  const data = {
    models: {
      'gemini-3.1-pro-high': { displayName: 'Gemini 3.1 Pro (High)', quotaInfo: { remainingFraction: 0.75, resetTime: 1787905548392 } },
      'claude-sonnet-4-6': { displayName: 'Claude Sonnet 4.6', quotaInfo: { remainingFraction: 0.2 } },
      'some-random-model': { displayName: 'Not listed', quotaInfo: { remainingFraction: 0.9 } },
      'internal-model': { isInternal: true, quotaInfo: { remainingFraction: 0.9 } },
      'no-quota': { displayName: 'No quota info' },
    },
  };
  const quotas = vq.antigravityModelQuotas(data);
  assert.deepEqual(Object.keys(quotas).sort(), ['claude-sonnet-4-6', 'gemini-3.1-pro-high']);
  assert.equal(quotas['gemini-3.1-pro-high'].total, 1000);
  // 9R 形状：used/total/remainingPercentage（remaining = 1000 × 0.75 = 750 ⇒ used 250）
  assert.equal(quotas['gemini-3.1-pro-high'].used, 250);
  assert.equal(quotas['gemini-3.1-pro-high'].remainingPercentage, 75);
  assert.equal(quotas['gemini-3.1-pro-high'].displayName, 'Gemini 3.1 Pro (High)');
});

test('antigravity：免费档（paidTier 空 / free-tier）跳过分模型，只看周额度（mock fetch）', async (t) => {
  const router = fetchRouter([
    ['loadCodeAssist', { cloudaicompanionProject: 'proj-1', currentTier: { name: 'Free' }, paidTier: { id: 'free-tier' } }],
    ['fetchAvailableModels', { models: { 'gemini-3.1-pro-high': { displayName: 'Pro', quotaInfo: { remainingFraction: 0.1 } } } }],
    ['retrieveUserQuotaSummary', { groups: [{ displayName: 'Gemini', buckets: [{ window: 'weekly', remainingFraction: 0.7, resetTime: 1787905548392 }] }] }],
  ]);
  t.mock.method(globalThis, 'fetch', router);
  const out = await vq.fetchAntigravityQuota({ token: 'tok-e2e', email: 'user@example.com' });
  assert.equal(out.plan, 'Free (user)');
  assert.equal(out.quotas!.length, 1);
  assert.equal(out.quotas![0].name, 'gemini_weekly');
  // 免费档不发分模型行
  assert.equal(out.quotas!.find((q) => q.name === 'gemini-3.1-pro-high'), undefined);
  // 两个配额端点必须走 9R 的 daily- 域
  assert.ok(router.calls.some((c) => c.url.startsWith('https://daily-cloudcode-pa.googleapis.com/v1internal:fetchAvailableModels')));
  assert.ok(router.calls.some((c) => c.url.startsWith('https://daily-cloudcode-pa.googleapis.com/v1internal:retrieveUserQuotaSummary')));
  assert.ok(router.calls.every((c) => !c.url.includes('User-Agent: antigravity/ide')));
  assert.ok(router.calls.some((c) => c.headers['User-Agent'] === 'antigravity/hub/2.24.0 darwin/arm64'));
});

test('antigravity：付费档也只展示 Gemini 5h 与周额度（用户 2026-11-08 20:00）', async (t) => {
  const router = fetchRouter([
    ['loadCodeAssist', { cloudaicompanionProject: 'proj-1', currentTier: { name: 'Pro' }, paidTier: { id: 'g1-pro-tier' } }],
    ['fetchAvailableModels', { models: { 'gemini-3.1-pro-high': { displayName: 'Pro', quotaInfo: { remainingFraction: 0.5 } }, 'claude-sonnet-4-6': { displayName: 'Sonnet', quotaInfo: { remainingFraction: 0.5 } } } }],
    ['retrieveUserQuotaSummary', { groups: [
      { displayName: 'Gemini', buckets: [{ window: 'weekly', remainingFraction: 0.7, resetTime: 1787905548392 }, { window: '5h', remainingFraction: 0.4, resetTime: 1787905548392 }] },
      { displayName: 'Claude and GPT', buckets: [{ window: 'weekly', remainingFraction: 0.2, resetTime: 1787905548392 }] },
    ] }],
  ]);
  t.mock.method(globalThis, 'fetch', router);
  const out = await vq.fetchAntigravityQuota({ token: 'tok-e2e', email: 'user@example.com' });
  assert.deepEqual(out.quotas!.map((q) => q.name).sort(), ['gemini_session', 'gemini_weekly']);
});

// ---------------------------------------------------------------- trae

test('trae：credits_limit=-1 视为无限，不并入求和（HUB trae-credits 口径）', () => {
  const packs = [
    { entitlement_base_info: { quota: { credits_limit: 500 } }, usage: { credits_amount: 100 } },
    { entitlement_base_info: { quota: { credits_limit: -1 } }, usage: { credits_amount: 30 } },
    { entitlement_base_info: { quota: { credits_limit: 200 } }, usage: { credits_amount: 50 } },
  ];
  const summary = deep.traePacksSummary(packs)!;
  assert.equal(summary.unlimited, true);
  assert.equal(summary.total, 700);
  assert.equal(summary.used, 180);
});

test('trae：无无限包时 unlimited=false；全空包返回 null', () => {
  const normal = deep.traePacksSummary([{ entitlement_base_info: { quota: { credits_limit: 100 } }, usage: { credits_amount: 40 } }]);
  assert.deepEqual(normal, { total: 100, used: 40, unlimited: false });
  assert.equal(deep.traePacksSummary([{ entitlement_base_info: { quota: { credits_limit: 0 } } }]), null);
  assert.equal(deep.traePacksSummary([]), null);
  assert.equal(deep.traePacksSummary('nope'), null);
});

// ---------------------------------------------------------------- cline

test('cline：Bearer 必须保留 workos: 前缀（剥掉 401）', () => {
  assert.equal(vq.clineBearerValue('eyJ.jwt.sig'), 'workos:eyJ.jwt.sig');
  assert.equal(vq.clineBearerValue('workos:eyJ.jwt.sig'), 'workos:eyJ.jwt.sig');
  assert.equal(vq.clineBearerValue(''), '');
});

test('cline：usage-limits 解析（percentUsed 原值透传、空 resetsAt 窗口交给调用方）', () => {
  const parsed = vq.parseClineUsageLimits({
    success: true,
    data: { limits: [
      { type: 'five_hour', percentUsed: 42.5, resetsAt: '2026-09-29T15:41:02.244817775Z' },
      { type: 'weekly', percentUsed: 10, resetsAt: '' },
      { type: 'monthly', percentUsed: 0, resetsAt: '2026-10-01T00:00:00Z' },
    ] },
  });
  assert.equal(parsed.windows.length, 3);
  assert.equal(parsed.windows[0].percentUsed, 42.5);
  assert.equal(parsed.windows[0].resetsAt, '2026-09-29T15:41:02.244817775Z');
  assert.equal(parsed.windows[1].resetsAt, '');
  // 失败形态：success:false 或网关层 {error}
  assert.match(vq.parseClineUsageLimits({ success: false, error: 'boom' }).error!, /boom/);
  assert.match(vq.parseClineUsageLimits({ error: 'gateway down' }).error!, /gateway down/);
});

test('cline：fetch 主链路（mock fetch）——workos 前缀、me 端点、accountId 余额端点', async (t) => {
  const router = fetchRouter([
    ['/api/v1/users/me/plan/usage-limits', (_url, opts) => {
      assert.equal(opts.headers!.Authorization, 'Bearer workos:jwt-e2e');
      return jsonRes({ success: true, data: { limits: [
        { type: 'five_hour', percentUsed: 30, resetsAt: '2026-11-08T15:00:00Z' },
        { type: 'weekly', percentUsed: 0, resetsAt: '' },
      ] } });
    }],
    ['/api/v1/users/usr-abc/balance', (_url, opts) => {
      assert.equal(opts.headers!.Authorization, 'Bearer workos:jwt-e2e');
      return jsonRes({ data: { userId: 'usr-abc', balance: 500000 }, success: true });
    }],
  ]);
  t.mock.method(globalThis, 'fetch', router);
  const out = await vq.fetchClineQuota({ token: 'jwt-e2e', accountId: 'usr-abc' });
  assert.ok(router.calls.some((c) => c.url === 'https://api.cline.bot/api/v1/users/me/plan/usage-limits'));
  assert.ok(router.calls.some((c) => c.url === 'https://api.cline.bot/api/v1/users/usr-abc/balance'));
  // 空 resetsAt 的窗口不渲染（官方客户端行为），余额按 1e5 折算 USD
  assert.equal(out.quotas!.length, 2);
  assert.equal(out.quotas![0].name, '5 小时窗口');
  assert.equal(out.quotas![0].remainingPercentage, 70);
  const balance = out.quotas!.find((q) => q.name === '余额')!;
  assert.equal(balance.total, 5);
  assert.equal(balance.unit, 'USD');
});

// ---------------------------------------------------------------- perch

test('perch：/api/perchai/account 解析套餐与每日 PT；无剩余字段不编造', async (t) => {
  assert.deepEqual(vq.parsePerchAccount({
    session: { planCode: 'pilot', planName: 'Pilot', entitlements: [{ key: 'limits.daily_runs', value_json: { limit: null } }] },
    usageMeter: { dailyPt: 1234 },
  }), { planCode: 'pilot', planName: 'Pilot', dailyPt: 1234 });
  assert.equal(vq.parsePerchAccount({ session: {} })!.dailyPt, null);
  assert.equal(vq.parsePerchAccount(null), null);

  const router = fetchRouter([
    ['/api/perchai/account', (_url, opts) => {
      assert.equal(opts.headers!.Authorization, 'Bearer perch-tok');
      assert.equal(opts.headers!['User-Agent'], 'perchai-cli/2.4.118');
      assert.equal(opts.headers!['x-perch-locale'], 'en');
      return jsonRes({ session: { planCode: 'starter', planName: 'Starter' }, usageMeter: { dailyPt: 250 } });
    }],
  ]);
  t.mock.method(globalThis, 'fetch', router);
  const out = await vq.fetchPerchQuota({ token: 'perch-tok', appUrl: 'https://app.perchai.app', email: 'a@b.c' });
  assert.equal(out.plan, 'Starter');
  // 不编造剩余：不发额度条，当日已用走 message
  assert.equal(out.quotas!.length, 0);
  assert.match(out.message!, /今日已用 250 PT/);
  assert.match(out.message!, /未下发剩余/);
});

// ---------------------------------------------------------------- 注册表

test('QUOTA_WORKERS 收录 cline / perch', () => {
  assert.ok(vq.QUOTA_WORKERS.includes('cline'));
  assert.ok(vq.QUOTA_WORKERS.includes('perch'));
  // 原有 worker 一个都不能少
  for (const w of ['codebuddy', 'codebuddy-cn', 'github-copilot', 'minimaxcode', 'mimocode', 'antigravity', 'traecode', 'zcode', 'codearts', 'qoder', 'qoder-cn']) {
    assert.ok(vq.QUOTA_WORKERS.includes(w), `${w} 必须仍在清单里`);
  }
});
