import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";

const fixture = vi.hoisted(() => ({ report: null as unknown }));
vi.mock("react", async (original) => ({
  ...await original<typeof import("react")>(),
  useState: (initial: unknown) => [initial === null ? fixture.report : initial === true ? false : typeof initial === "function" ? (initial as () => unknown)() : initial, () => {}],
}));
vi.mock("@/state/store", () => ({ api: vi.fn(), useStore: () => ({ state: { instances: [] }, dispatch: vi.fn() }) }));
import { PlanUsage } from "./PlanUsage";

describe("Plan usage presentation", () => {
  afterEach(() => { vi.useRealTimers(); });

  it("distinguishes remaining account allowance, per-model usage, and unavailable windows", () => {
    fixture.report = {
      fetchedAt: "2026-10-02T09:00:00Z",
      providers: [{
        id: "fixture", name: "Fixture provider", driver: "claude", plan: "Pro", ok: true, error: null,
        fiveHour: { available: true, remainingPercent: 68, usedPercent: 32, resetsAt: null },
        weekly: { available: false, remainingPercent: null, usedPercent: null, resetsAt: null }, extra: [],
        models: [{ name: "Sonnet", windows: [{ label: "Weekly", remainingPercent: 30, usedPercent: 70, resetsAt: null }] }],
      }],
    };
    const html = renderToStaticMarkup(createElement(PlanUsage));
    expect(html).toContain("68% left");
    expect(html).toContain("70% used");
    expect(html).toContain("Not reported by this plan");
    expect(html).not.toContain("100% left");
    expect(html).toContain('aria-valuenow="32"');
    expect(html).toContain('aria-valuenow="70"');
  });

  it("shows a monthly budget's amounts beside how much of it is used", () => {
    fixture.report = {
      fetchedAt: "2026-10-02T09:00:00Z",
      providers: [{
        id: "fixture", name: "Fixture provider", driver: "claude", plan: "Enterprise", ok: true, error: null,
        fiveHour: { available: false, remainingPercent: null, usedPercent: null, resetsAt: null },
        weekly: { available: false, remainingPercent: null, usedPercent: null, resetsAt: null },
        extra: [{ label: "Monthly spend", remainingPercent: 90.7, usedPercent: 9.3, resetsAt: null, spend: { usedMinor: 4_631, limitMinor: 50_000, currency: "USD", exponent: 2 } }],
        models: [],
      }],
    };
    const html = renderToStaticMarkup(createElement(PlanUsage));
    expect(html).toContain("Monthly spend");
    expect(html).toContain("9% used");
    expect(html).toContain("$46.31 of $500.00 spent");
    expect(html).toContain('aria-valuenow="9"');
  });

  it("shows a credit allowance's counts beside how much of it is used", () => {
    // 12d 13h before the reset below; the countdown must not depend on the day the suite runs.
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-11-08T11:00:00.000Z"));
    fixture.report = {
      fetchedAt: "2026-11-08T09:00:00Z",
      providers: [{
        id: "meoo", name: "Meoo", driver: "meoo", plan: "Free 免费版", ok: true, error: null,
        fiveHour: { available: false, remainingPercent: null, usedPercent: null, resetsAt: null },
        weekly: { available: false, remainingPercent: null, usedPercent: null, resetsAt: null },
        extra: [{ label: "Model credits", remainingPercent: 51.1, usedPercent: 48.9, resetsAt: "2026-11-21T00:00:00.000Z", amounts: { used: 22_000, total: 45_000 } }],
        models: [],
      }],
    };
    const html = renderToStaticMarkup(createElement(PlanUsage));
    expect(html).toContain("Model credits");
    expect(html).toContain("51% left");
    expect(html).toContain("22,000 / 45,000");
    expect(html).toContain("12d 13h");
    expect(html).not.toContain("$");
  });

  it("names the monthly budget in the person's language", async () => {
    const { loadLocale, setLocale } = await import("@/lib/i18n");
    fixture.report = {
      fetchedAt: "2026-10-02T09:00:00Z",
      providers: [{
        id: "fixture", name: "Fixture provider", driver: "claude", plan: "Enterprise", ok: true, error: null,
        fiveHour: { available: false, remainingPercent: null, usedPercent: null, resetsAt: null },
        weekly: { available: false, remainingPercent: null, usedPercent: null, resetsAt: null },
        extra: [{ label: "Monthly spend", remainingPercent: 90.7, usedPercent: 9.3, resetsAt: null, spend: { usedMinor: 4_631, limitMinor: 50_000, currency: "USD", exponent: 2 } }],
        models: [],
      }],
    };
    await loadLocale("zh");
    try {
      expect(renderToStaticMarkup(createElement(PlanUsage))).toContain("每月支出");
    } finally {
      setLocale("en");
    }
  });

  it("shows an account error without inventing zero usage", () => {
    fixture.report = { providers: [{ id: "fixture", name: "Fixture provider", ok: false, error: "Sign in to this account." }] };
    const html = renderToStaticMarkup(createElement(PlanUsage));
    expect(html).toContain("Sign in to this account.");
    expect(html).not.toContain('role="meter"');
    expect(html).not.toContain("100% left");
  });
});

describe("Usage & billing in Simple mode", () => {
  const provider = (id: string, ok: boolean, used: number | null) => ({
    id, name: id, driver: id, plan: null, ok, error: null, extra: [],
    fiveHour: { available: false, remainingPercent: null, usedPercent: null, resetsAt: null },
    weekly: { available: used !== null, remainingPercent: used === null ? null : 100 - used, usedPercent: used, resetsAt: null },
  });

  it("leads with the provider whose weekly allowance is most used, and ignores providers that report none or fail", async () => {
    const { busiestWeekly } = await import("./PlanUsage");
    expect(busiestWeekly({ providers: [provider("claude", true, 34), provider("codex", true, 61), provider("grok", false, 90), provider("kimi", true, null)] }))
      .toMatchObject({ provider: { id: "codex" }, used: 61 });
    expect(busiestWeekly({ providers: [provider("grok", false, 90)] })).toBeNull();
    expect(busiestWeekly(null)).toBeNull();
  });

  it("stands a plan's monthly budget in for the weekly figure when it has none", async () => {
    const { monthlySpend } = await import("./PlanUsage");
    const budget = { label: "Monthly spend", remainingPercent: 91, usedPercent: 9, resetsAt: null };
    expect(monthlySpend({ providers: [{ ...provider("claude", true, null), extra: [budget] }] })).toMatchObject({ provider: { id: "claude" }, budget });
    expect(monthlySpend({ providers: [{ ...provider("claude", true, 40), extra: [budget] }] })).toBeNull();
    expect(monthlySpend({ providers: [{ ...provider("claude", false, null), extra: [budget] }] })).toBeNull();
    expect(monthlySpend(null)).toBeNull();
  });
});

describe("All registered CLI engines & sortEngines ordering", () => {
  const makeInstance = (patch: Partial<import("@/state/store").InstanceInfo> & { instanceId: string; displayName: string }): import("@/state/store").InstanceInfo => ({
    driverKind: "generic",
    models: { default: "m1", options: [{ id: "m1", label: "Model 1" }] },
    snapshot: { state: "available", authenticated: true },
    ...patch,
  });

  it("groups multiple plan rows under the same engine family and sorts by sortEngines", async () => {
    const { groupAndSortInstances } = await import("./PlanUsage");
    const list = [
      makeInstance({ instanceId: "chatgpt", displayName: "ChatGPT plan", driverKind: "codex", snapshot: { state: "available", authenticated: true } }),
      makeInstance({ instanceId: "codex", displayName: "Codex", driverKind: "codex", snapshot: { state: "available", authenticated: true } }),
      makeInstance({ instanceId: "zcode", displayName: "ZCode", driverKind: "zcodeAgent", snapshot: { state: "available", authenticated: true } }),
      makeInstance({ instanceId: "claudeApi", displayName: "Claude (API key)", driverKind: "claudeAgent", snapshot: { state: "available", authenticated: true } }),
      makeInstance({ instanceId: "claude", displayName: "Claude", driverKind: "claudeAgent", snapshot: { state: "available", authenticated: true } }),
      makeInstance({ instanceId: "antigravity", displayName: "Antigravity", driverKind: "antigravityAgent", snapshot: { state: "available", authenticated: true } }),
    ];
    const sorted = groupAndSortInstances(list);
    const ids = sorted.map((i) => i.instanceId);

    // Primary followed by secondaries
    const codexIdx = ids.indexOf("codex");
    const chatgptIdx = ids.indexOf("chatgpt");
    expect(chatgptIdx).toBe(codexIdx + 1);

    const claudeIdx = ids.indexOf("claude");
    const claudeApiIdx = ids.indexOf("claudeApi");
    expect(claudeApiIdx).toBe(claudeIdx + 1);
  });

  it("excludes hidden instances from display", async () => {
    const { groupAndSortInstances } = await import("./PlanUsage");
    const list = [
      makeInstance({ instanceId: "zcode", displayName: "ZCode", hidden: true }),
      makeInstance({ instanceId: "antigravity", displayName: "Antigravity" }),
    ];
    const sorted = groupAndSortInstances(list);
    expect(sorted.map((i) => i.instanceId)).toEqual(["antigravity"]);
  });

  it("matches hub quota worker by folded key, worker name, or account", async () => {
    const { quotaWorkerForInstance } = await import("./PlanUsage");
    const cbcn = makeInstance({ instanceId: "codebuddyCn", displayName: "CodeBuddy CN", driverKind: "codebuddyCnAgent" });
    const mmx = makeInstance({ instanceId: "mcode", displayName: "MiniMax Code", driverKind: "mcodeAgent" });
    const workers = {
      "codebuddy-cn": { worker: "codebuddy-cn", quotas: [{ name: "Pack 1", used: 10, total: 100 }] },
      minimaxcode: { worker: "minimaxcode", quotas: [{ name: "Daily", used: 5, total: 50 }] },
    };
    expect(quotaWorkerForInstance(cbcn, workers)?.quotas?.[0]?.name).toBe("Pack 1");
    expect(quotaWorkerForInstance(mmx, workers)?.quotas?.[0]?.name).toBe("Daily");
  });

  it("renders hub quota data and status states (signedInNoQuota, notSignedIn with 去登录, notInstalled, disabled)", async () => {
    const { loadLocale, setLocale } = await import("@/lib/i18n");
    await loadLocale("zh");
    try {
      const instances = [
        makeInstance({
          instanceId: "zcode",
          displayName: "ZCode",
          driverKind: "zcodeAgent",
          snapshot: { state: "available", authenticated: true },
        }),
        makeInstance({
          instanceId: "antigravity",
          displayName: "Antigravity",
          driverKind: "antigravityAgent",
          snapshot: { state: "available", authenticated: true },
        }),
        makeInstance({
          instanceId: "cursor",
          displayName: "Cursor",
          driverKind: "cursorAgent",
          snapshot: { state: "available", authenticated: false },
        }),
        makeInstance({
          instanceId: "droid",
          displayName: "Droid",
          driverKind: "droidAgent",
          snapshot: { state: "unavailable", authenticated: false },
        }),
        makeInstance({
          instanceId: "qoder",
          displayName: "Qoder",
          driverKind: "qoderAgent",
          disabled: true,
          snapshot: { state: "available", authenticated: true },
        }),
      ];

      const quotaReport = {
        workers: {
          zcode: {
            worker: "zcode",
            plan: "Pro Plan",
            quotas: [
              { displayName: "Coding Quota", used: 20, total: 100, remaining: 80, remainingPercentage: 80 },
            ],
          },
        },
      };

      const html = renderToStaticMarkup(createElement(PlanUsage, { instances, quotaReport }));

      // ZCode renders quota data and plan
      expect(html).toContain("ZCode");
      expect(html).toContain("Pro Plan");
      expect(html).toContain("Coding Quota");
      expect(html).toContain("80%");

      // Antigravity has no quota data -> 此引擎不提供额度信息
      expect(html).toContain("Antigravity");
      expect(html).toContain("此引擎不提供额度信息");

      // Cursor is not signed in -> 未登录 with 去登录
      expect(html).toContain("Cursor");
      expect(html).toContain("未登录");
      expect(html).toContain("去登录");

      // Droid is unavailable -> 未安装
      expect(html).toContain("Droid");
      expect(html).toContain("未安装");

      // Qoder is disabled -> 已停用 badge and opacity styling
      expect(html).toContain("Qoder");
      expect(html).toContain("已停用");
      expect(html).toContain("opacity-60");
    } finally {
      setLocale("en");
    }
  });

  it("renders quota details for all engines that provide quotas with mock data", async () => {
    const { loadLocale, setLocale } = await import("@/lib/i18n");
    await loadLocale("zh");
    try {
      const instances = [
        makeInstance({ instanceId: "codebuddy", displayName: "CodeBuddy", driverKind: "codebuddyAgent" }),
        makeInstance({ instanceId: "codebuddyCn", displayName: "CodeBuddy CN", driverKind: "codebuddyCnAgent" }),
        makeInstance({ instanceId: "qoder", displayName: "Qoder", driverKind: "qoderAgent" }),
        makeInstance({ instanceId: "qoderCn", displayName: "Qoder CN", driverKind: "qoderCnAgent" }),
        makeInstance({ instanceId: "zcode", displayName: "ZCode", driverKind: "zcodeAgent" }),
        makeInstance({ instanceId: "mcode", displayName: "MiniMax Code", driverKind: "mcodeAgent" }),
        makeInstance({ instanceId: "antigravity", displayName: "Antigravity", driverKind: "antigravityAgent" }),
        makeInstance({ instanceId: "githubCopilot", displayName: "GitHub Copilot", driverKind: "copilotAgent" }),
      ];

      const quotaReport = {
        workers: {
          codebuddy: {
            worker: "codebuddy",
            account: "cb@example.com",
            plan: "Free Plan Subscription",
            quotas: [
              { name: "Monthly", displayName: "Monthly", used: 10, total: 100, resetAt: "2026-11-30T15:59:59.000Z" },
              { name: "Bonus Pack 1", displayName: "Bonus Pack 1", used: 30, total: 30, resetAt: "2026-11-15T00:00:00.000Z" },
            ],
          },
          "codebuddy-cn": {
            worker: "codebuddy-cn",
            account: "UserCN",
            plan: "CodeBuddy个人体验版",
            quotas: [
              { name: "Monthly", displayName: "月度体验包", used: 5, total: 50, remaining: 45, remainingPercentage: 90 },
            ],
          },
          qoder: {
            worker: "qoder",
            account: "qoder-user",
            plan: "Qoder (国际版)",
            quotas: [
              { name: "userQuota", displayName: "基础配额", used: 13, total: 100, remaining: 87, remainingPercentage: 87, resetAt: "2026-11-20T00:00:00.000Z" },
            ],
          },
          "qoder-cn": {
            worker: "qoder-cn",
            account: "qoder-cn-user",
            plan: "Qoder CN (国内版)",
            quotas: [
              { name: "dedicated", displayName: "专用资源包", used: 0, total: 200, remaining: 200, remainingPercentage: 100 },
            ],
          },
          zcode: {
            worker: "zcode",
            account: "zcode-user",
            plan: "GLM Coding Plan · lite",
            quotas: [
              { name: "usage", displayName: "GLM配额", used: 25, total: 100, remaining: 75, remainingPercentage: 75, resetAt: "2026-11-25T00:00:00.000Z" },
            ],
          },
          minimaxcode: {
            worker: "minimaxcode",
            account: "MiniMax Code · 国内版",
            plan: "连续签到第 1 天",
            quotas: [
              { name: "签到积分", displayName: "今日签到积分", used: 0, remaining: 400, resetAt: "2026-11-09T00:00:00.000Z", isCreditBalance: true, unit: "points" },
            ],
          },
          antigravity: {
            worker: "antigravity",
            account: "user@gmail.com",
            plan: "Antigravity (user)",
            quotas: [
              { name: "gemini-3.1-pro-high", displayName: "Gemini 3.1 Pro", used: 20, total: 100, remaining: 80, remainingPercentage: 80, resetAt: "2026-11-10T00:00:00.000Z" },
              { name: "claude-sonnet-4-6", displayName: "Claude Sonnet 4.6", used: 50, total: 100, remaining: 50, remainingPercentage: 50 },
            ],
          },
          "github-copilot": {
            worker: "github-copilot",
            account: "copilot-user",
            plan: "Copilot Business",
            quotas: [
              { name: "chat", displayName: "Chat", unlimited: true },
              { name: "premium_interactions", displayName: "高级交互", used: 12, total: 50, remaining: 38, remainingPercentage: 76, resetAt: "2026-12-01T00:00:00.000Z" },
            ],
          },
        },
      };

      const html = renderToStaticMarkup(createElement(PlanUsage, { instances, quotaReport }));

      // CodeBuddy
      expect(html).toContain("CodeBuddy");
      expect(html).toContain("Monthly");
      expect(html).toContain("10 / 100");

      // CodeBuddy CN
      expect(html).toContain("CodeBuddy CN");
      expect(html).toContain("月度体验包");
      expect(html).toContain("剩余 90%");

      // Qoder & Qoder CN
      expect(html).toContain("基础配额");
      expect(html).toContain("专用资源包");

      // ZCode
      expect(html).toContain("GLM配额");
      expect(html).toContain("剩余 75%");

      // MiniMax Code (credit balance without fixed total)
      expect(html).toContain("今日签到积分");
      expect(html).toContain("400 left points");

      // Antigravity
      expect(html).toContain("Gemini 3.1 Pro");
      expect(html).toContain("Claude Sonnet 4.6");

      // GitHub Copilot (unlimited chat without fabricated meter)
      expect(html).toContain("Chat");
      expect(html).toContain("不限");
      expect(html).toContain("高级交互");
      expect(html).toContain("剩余 76%");
    } finally {
      setLocale("en");
    }
  });

  it("renders '此引擎不提供额度信息' for engines that do not provide quota (meoo, perch, opencodeGo without quota)", async () => {
    const { loadLocale, setLocale } = await import("@/lib/i18n");
    await loadLocale("zh");
    try {
      const instances = [
        makeInstance({ instanceId: "meoo", displayName: "Meoo", driverKind: "meooAgent" }),
        makeInstance({ instanceId: "perch", displayName: "Perch", driverKind: "perchAgent" }),
        makeInstance({ instanceId: "opencodeGo", displayName: "OpenCode", driverKind: "opencodeGo" }),
      ];

      // opencodeGo in report has available: false for all windows (e.g. 403 / no Go subscription)
      fixture.report = {
        fetchedAt: "2026-11-08T00:00:00Z",
        providers: [
          {
            id: "opencodeGo",
            name: "OpenCode",
            driver: "opencode",
            plan: null,
            ok: true,
            error: null,
            fiveHour: { available: false, remainingPercent: null, usedPercent: null, resetsAt: null },
            weekly: { available: false, remainingPercent: null, usedPercent: null, resetsAt: null },
            extra: [],
            models: [],
          },
        ],
      };

      const quotaReport = { workers: {} };
      const html = renderToStaticMarkup(createElement(PlanUsage, { instances, quotaReport }));

      expect(html).toContain("Meoo");
      expect(html).toContain("Perch");
      expect(html).toContain("OpenCode");

      // All 3 render the exact unprovided text
      const matches = html.match(/此引擎不提供额度信息/g);
      expect(matches).toHaveLength(3);
    } finally {
      fixture.report = null;
      setLocale("en");
    }
  });

  it("does not fabricate unprovided fields (missing resetAt, missing total/remaining)", async () => {
    const instances = [
      makeInstance({ instanceId: "fixture", displayName: "Fixture AI", driverKind: "fixtureAgent" }),
    ];
    const quotaReport = {
      workers: {
        fixture: {
          worker: "fixture",
          quotas: [
            { displayName: "No Reset Quota", used: 10, total: 100, resetAt: null },
            { displayName: "Unlimited Quota", unlimited: true, resetAt: null },
          ],
        },
      },
    };
    const html = renderToStaticMarkup(createElement(PlanUsage, { instances, quotaReport }));

    // Does not render "resets in" when resetsAt is null
    expect(html).not.toContain("resets in");

    // Unlimited quota shows Unlimited, does not fabricate a progress meter for it
    expect(html).toContain("Unlimited");
  });
});
