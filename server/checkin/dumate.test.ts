// FEAT-dumate: 百度搭子 accounts, web API, daily check-in and the shared-browser QR sign-in. Every network and CDP call
// is a fake here; nothing reaches Baidu or the real mychrome.
import { mkdtempSync, readFileSync, statSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { removeTempDir } from "../testing/cleanup.ts";

const home = mkdtempSync(join(tmpdir(), "dumate-"));
const store = join(home, ".agenthub", "dumate-accounts.json");
const loginState = join(home, ".agenthub", "dumate-login.json");
let mod: typeof import("./dumate.mjs");

beforeAll(async () => {
  vi.stubEnv("AGENTHUB_HOME", home);
  vi.stubEnv("DUMATE_ACCOUNTS_FILE", store);
  vi.stubEnv("DUMATE_LOGIN_STATE", loginState);
  vi.resetModules();
  mod = await import("./dumate.mjs");
});
afterAll(() => { vi.unstubAllEnvs(); removeTempDir(home); });
beforeEach(() => { mkdirSync(join(home, ".agenthub"), { recursive: true }); writeFileSync(store, JSON.stringify({ accounts: [] })); writeFileSync(loginState, "{}"); });

const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });

describe("dumate web answers", () => {
  it("reads 401, code 10001/10006 and a bounce to the Baidu login page as a lapsed sign-in", () => {
    expect(mod.classifyWebAnswer(401, { code: 10001, message: "登录已经过期" })).toMatchObject({ ok: false, expired: true, code: 10001 });
    expect(mod.classifyWebAnswer(200, { code: 10006 })).toMatchObject({ ok: false, expired: true });
    expect(mod.classifyWebAnswer(302, null, "https://login.bce.baidu.com/?redirect=x")).toMatchObject({ expired: true });
    expect(mod.classifyWebAnswer(200, { code: 0, result: {} })).toMatchObject({ ok: true, expired: false });
    expect(mod.classifyWebAnswer(200, { success: false, message: "no" })).toMatchObject({ ok: false, expired: false, message: "no" });
    expect(mod.classifyWebAnswer(200, { code: 400, message: "参数错误" })).toMatchObject({ ok: false, expired: false, code: 400 });
  });

  it("calls www.dumate.cn with the cookie and the web client header, and unwraps result", async () => {
    const seen: Array<{ url: string; init: RequestInit }> = [];
    const fetch = vi.fn(async (url: string, init: RequestInit) => { seen.push({ url, init }); return json(200, { code: 0, result: { token: "t" } }); });
    const r = await mod.webCall("BDUSS=a; bce-sessionid=b", "GET", "/api/dumate/app/token/get", { fetch: fetch as never });
    expect(r).toMatchObject({ ok: true, status: 200, result: { token: "t" } });
    expect(seen[0]!.url).toBe("https://www.dumate.cn/api/dumate/app/token/get");
    const headers = seen[0]!.init.headers as Record<string, string>;
    expect(headers.Cookie).toBe("BDUSS=a; bce-sessionid=b");
    expect(headers["X-Dumate-Client-Type"]).toBe("web");
    expect(seen[0]!.init.redirect).toBe("manual");
  });

  it("turns a network failure into status 0 without throwing", async () => {
    const r = await mod.webCall("c=1", "GET", "/x", { fetch: (async () => { throw new Error("ECONNRESET"); }) as never });
    expect(r).toMatchObject({ ok: false, status: 0, expired: false });
    expect(r.message).toContain("ECONNRESET");
  });

  it("works out the balance and the soonest-expiring live pack, skipping never-expiring, empty and inactive packs", () => {
    const day = 86_400;
    const q = mod.parseQuotaOverview({
      totalPoints: "3000", usedPoints: "499.5",
      subscription: [{ totalPoints: 1000, usedPoints: 0, expireDate: null, status: "active" }],
      incremental: [
        { totalPoints: 500, usedPoints: 0, expireDate: 1_900_000_000 + 7 * day, status: "active" },
        { totalPoints: 500, usedPoints: 100, expireDate: 1_900_000_000 + 2 * day, status: "active" },
        { totalPoints: 500, usedPoints: 500, expireDate: 1_900_000_000, status: "active" },
        { totalPoints: 500, usedPoints: 0, expireDate: 1_900_000_000 - day, status: "expired" },
      ],
    });
    expect(q.left).toBe(2500.5);
    expect(q.soonest).toEqual({ expireAt: (1_900_000_000 + 2 * day) * 1000, points: 400 });
    expect(q.packages).toHaveLength(5);
    expect(mod.balanceText({ ok: true, ...q })).toMatch(/^余额 2500\.5 积分，\d+\/\d+ 到期 400$/);
  });

  it("takes csrftoken from the bce-user-info cookie", () => {
    expect(mod.csrfFromCookie('a=1; bce-user-info="abc123"; z=2')).toBe("abc123");
    expect(mod.csrfFromCookie("a=1")).toBe("");
  });
});

describe("dumate cookies from the shared browser", () => {
  const c = (name: string, domain: string, value = "v") => ({ name, domain, value });

  it("waits for BDUSS, then for the console session, then builds one header of Baidu cookies", () => {
    expect(mod.cookieHeaderFrom([c("x", ".google.com")])).toEqual({ stage: "need_login", header: "" });
    expect(mod.cookieHeaderFrom([c("BDUSS", ".baidu.com")])).toEqual({ stage: "need_console", header: "" });
    const ready = mod.cookieHeaderFrom([
      c("BDUSS", ".baidu.com", "u"), c("bce-long-term-sessionid", "console.bce.baidu.com", "s"),
      c("BAIDUID", ".baidu.com", "short"), c("BAIDUID", "console.bce.baidu.com", "long"), c("SID", ".google.com", "no"),
    ]);
    expect(ready.stage).toBe("ready");
    expect(ready.header).toBe("BDUSS=u; bce-long-term-sessionid=s; BAIDUID=long");
  });

  it("opens an isolated context only when the shared browser already holds a live DuMate account", () => {
    expect(mod.wantsIsolatedContext([])).toBe(false);
    expect(mod.wantsIsolatedContext([{ source: "mychrome", expired: true }])).toBe(false);
    expect(mod.wantsIsolatedContext([{ source: "mychrome" }])).toBe(true);
  });
});

describe("dumate account store", () => {
  it("keeps one row per Baidu account, replaces the cookie on a re-login and never hands the cookie out", async () => {
    const first = await mod.saveDumateAccount({ cookie: "BDUSS=one", uid: "1234567", name: "花花", source: "mychrome" });
    const again = await mod.saveDumateAccount({ cookie: "BDUSS=two", uid: "1234567", name: "花花", source: "mychrome" });
    expect(again.id).toBe(first.id);
    const raw = JSON.parse(readFileSync(store, "utf8"));
    expect(raw.accounts).toHaveLength(1);
    expect(raw.accounts[0].cookie).toBe("BDUSS=two");
    const listed = await mod.listDumateAccounts();
    expect(listed).toEqual([{ id: first.id, name: "花花", uid: "1…567", source: "mychrome", addedAt: expect.any(Number), expired: false }]);
    expect(JSON.stringify(listed)).not.toContain("BDUSS");
    expect(statSync(store).mode & 0o777).toBe(0o600);
  });

  it("adds a second account, marks one lapsed, and removes by id", async () => {
    const a = await mod.saveDumateAccount({ cookie: "BDUSS=a", uid: "u-a", name: "甲" });
    const b = await mod.saveDumateAccount({ cookie: "BDUSS=b", uid: "u-b", name: "乙" });
    await mod.markDumateExpired(a.id, true);
    expect((await mod.getDumateAccount())!.id).toBe(b.id);
    expect((await mod.listDumateAccounts()).find((x) => x.id === a.id)!.expired).toBe(true);
    expect(await mod.removeDumateAccount(a.id)).toEqual({ ok: true });
    expect(await mod.removeDumateAccount(a.id)).toEqual({ ok: false });
    expect((await mod.listDumateAccounts()).map((x) => x.id)).toEqual([b.id]);
  });

  it("swaps the cookie for a gateway token once, reuses it, and marks the account lapsed when token/get refuses", async () => {
    const acc = { ...(await mod.saveDumateAccount({ cookie: "BDUSS=t", uid: "u-t" })), cookie: "BDUSS=t" };
    let calls = 0;
    const ok = (async () => { calls++; return json(200, { code: 0, result: { token: `tok${calls}`, expired_at: new Date(Date.now() + 3_600_000).toISOString() } }); }) as never;
    expect(await mod.gatewayToken(acc, { fetch: ok })).toMatchObject({ ok: true, token: "tok1" });
    expect(await mod.gatewayToken(acc, { fetch: ok })).toMatchObject({ ok: true, token: "tok1" });
    expect(await mod.gatewayToken(acc, { fetch: ok, force: true })).toMatchObject({ ok: true, token: "tok2" });
    const dead = (async () => json(401, { code: 10001, message: "登录已经过期" })) as never;
    expect(await mod.gatewayToken(acc, { fetch: dead, force: true })).toMatchObject({ ok: false, expired: true });
    expect((await mod.listDumateAccounts()).find((x) => x.id === acc.id)!.expired).toBe(true);
  });
});

describe("dumate daily check-in", () => {
  const account = { id: "dm-aaaa1111", uid: "998877", name: "测试号", cookie: "BDUSS=x" };
  const quota = async () => ({ ok: true, ...mod.parseQuotaOverview({ totalPoints: 1500, usedPoints: 0 }) });

  it("says already-signed without posting when today's bonus has landed", async () => {
    const claim = vi.fn();
    const r = await mod.checkinDumateAccount(account, { api: {
      loginBonusInfo: async () => ({ ok: true, hasIssued: true, totalPoints: 500, totalTimes: 4 }), claimLoginBonus: claim, quotaOverview: quota,
    } });
    expect(claim).not.toHaveBeenCalled();
    expect(r.row).toMatchObject({ status: "already", message: "今日已签到（累计 4 天）；余额 1500 积分" });
  });

  it("claims, then counts the credit from the ledger delta", async () => {
    let issued = false;
    const r = await mod.checkinDumateAccount(account, { api: {
      loginBonusInfo: async () => ({ ok: true, hasIssued: issued, totalPoints: issued ? 1000 : 500, totalTimes: issued ? 5 : 4 }),
      claimLoginBonus: async () => { issued = true; return { ok: true, expired: false, error: "" }; },
      quotaOverview: quota,
    } });
    expect(r).toMatchObject({ credits: 500, days: 5, row: { status: "success", credits: 500, message: "签到成功 +500 积分（累计 5 天）；余额 1500 积分" } });
  });

  it("does not call a posted-but-unlanded claim a success", async () => {
    const r = await mod.checkinDumateAccount(account, { api: {
      loginBonusInfo: async () => ({ ok: true, hasIssued: false, totalPoints: 0, totalTimes: 0 }),
      claimLoginBonus: async () => ({ ok: true, expired: false, error: "" }), quotaOverview: quota,
    } });
    expect(r.row.status).toBe("failed");
    expect(r.row.message).toContain("尚未到账");
  });

  it("asks for a new scan when the cookie lapsed", async () => {
    const r = await mod.checkinDumateAccount(account, { api: {
      loginBonusInfo: async () => ({ ok: false, expired: true, error: "登录已经过期" }), claimLoginBonus: vi.fn(), quotaOverview: quota,
    } });
    expect(r).toMatchObject({ expired: true, row: { status: "expired", message: mod.RELOGIN_HINT } });
  });

  it("reports a platform with no account as needing a scan, and mixes account outcomes into partial", async () => {
    expect(await mod.checkinDumate({ accounts: [], today: "2026-11-13", time: "08:30:00" })).toMatchObject({
      platform: "dumate", ok: false, status: "expired", loginRequired: true, accounts: [],
    });
    const other = { ...account, id: "dm-bbbb2222", uid: "556677", name: "第二号", cookie: "BDUSS=y" };
    const r = await mod.checkinDumate({
      accounts: [account, other], today: "2026-11-13", time: "08:30:00",
      api: {
        loginBonusInfo: async (cookie: string) => cookie === "BDUSS=x"
          ? { ok: true, hasIssued: true, totalPoints: 500, totalTimes: 2 }
          : { ok: false, expired: true, error: "登录已经过期" },
        claimLoginBonus: vi.fn(), quotaOverview: quota,
      },
    });
    expect(r).toMatchObject({ ok: true, status: "partial", consecutiveDays: 2, today: "2026-11-13" });
    expect(r.accounts.map((x: { status: string }) => x.status)).toEqual(["already", "expired"]);
    expect(r.message).toContain("第二号：");
  });

  it("lists the daily-page rows and quota rows without any cookie", async () => {
    await mod.saveDumateAccount({ cookie: "BDUSS=q", uid: "u-q", name: "额度号" });
    const rows = await mod.listDumateCheckinAccounts();
    expect(rows.at(-1)).toMatchObject({ display: "额度号", identity: "dumate:u-q", token: "cookie" });
    const quotaAnswer = await mod.fetchDumateQuota({
      accounts: [account],
      quotaOverview: async () => ({ ok: true, ...mod.parseQuotaOverview({ totalPoints: 1000, usedPoints: 250, incremental: [{ totalPoints: 500, usedPoints: 0, expireDate: 1_900_000_000, status: "active" }] }) }),
    });
    expect(quotaAnswer.quotas).toEqual([expect.objectContaining({ displayName: "积分", remaining: 750, total: 1000, isCreditBalance: true, unit: "积分", resetAt: new Date(1_900_000_000_000).toISOString() })]);
    expect(JSON.stringify(quotaAnswer)).not.toContain("BDUSS");
  });
});

/** A fake shared browser: records every CDP call; the page reports what each test scripts. */
function fakeCdp(page: { href: string; qr: string; cookies: Array<{ name: string; domain: string; value: string }>; quickLogin?: boolean }, existing = ["USER-TAB"]) {
  const calls: Array<{ method: string; params: any }> = [];
  const targets = new Set(existing);
  return {
    calls,
    connect: async () => ({
      close: () => {},
      call: async (method: string, params: any = {}) => {
        calls.push({ method, params });
        switch (method) {
          case "Target.createBrowserContext": return { browserContextId: "CTX-1" };
          case "Target.createTarget": targets.add("OUR-TAB"); return { targetId: "OUR-TAB" };
          case "Target.attachToTarget": return { sessionId: "S1" };
          case "Target.getTargets": return { targetInfos: [...targets].map((targetId) => ({ targetId })) };
          case "Target.closeTarget": targets.delete(params.targetId); return { success: true };
          case "Runtime.evaluate": {
            const expression = String(params.expression);
            if (expression.includes("location.href")) return { result: { value: page.href } };
            // Both the "快捷登录" probe and the click script report whether the button is there.
            if (expression.includes("快捷登录")) return { result: { value: page.quickLogin === true } };
            return { result: { value: page.qr } };
          }
          case "Page.getFrameTree": return { frameTree: { frame: { id: "F1" } } };
          case "Page.getResourceContent": return { content: "iVBORqr", base64Encoded: true };
          case "Storage.getCookies": return { cookies: page.cookies };
          default: return {};
        }
      },
    }),
  };
}

describe("dumate QR sign-in in the shared browser", () => {
  const ready = [
    { name: "BDUSS", domain: ".baidu.com", value: "u" },
    { name: "bce-long-term-sessionid", domain: "console.bce.baidu.com", value: "s" },
  ];

  it("opens its own background tab on the Baidu login page and hands back the QR image", async () => {
    const cdp = fakeCdp({ href: mod.LOGIN_URL, qr: "https://passport.baidu.com/v2/api/qrcode?sign=x", cookies: [] });
    const r = await mod.dumateLoginStart({ cdpConnect: cdp.connect, pollMs: 1, waitMs: 1_000 });
    expect(r).toEqual({ ok: true, loggedIn: false, qrPng: "iVBORqr" });
    expect(cdp.calls.find((c) => c.method === "Target.createTarget")!.params).toMatchObject({ url: mod.LOGIN_URL, background: true });
    expect(cdp.calls.some((c) => c.method === "Target.createBrowserContext")).toBe(false);
    expect(JSON.parse(readFileSync(loginState, "utf8"))).toMatchObject({ targetId: "OUR-TAB", settled: false });
  });

  it("saves the account straight away when the shared browser is already signed in to Baidu, and closes only its own tab", async () => {
    const cdp = fakeCdp({ href: "https://console.bce.baidu.com/", qr: "", cookies: ready });
    const r = await mod.dumateLoginStart({ cdpConnect: cdp.connect, pollMs: 1, waitMs: 1_000, userInfo: async () => ({ ok: true, uid: "77665544", name: "共享号" }) });
    expect(r).toEqual({ ok: true, loggedIn: true, account: "共享号" });
    const saved = JSON.parse(readFileSync(store, "utf8")).accounts;
    expect(saved).toEqual([expect.objectContaining({ uid: "77665544", source: "mychrome", cookie: "BDUSS=u; bce-long-term-sessionid=s" })]);
    const closed = cdp.calls.filter((c) => c.method === "Target.closeTarget").map((c) => c.params.targetId);
    expect(closed).toEqual(["OUR-TAB"]);
    expect(cdp.calls.some((c) => c.method === "Page.navigate" || c.method === "Page.reload")).toBe(false);
  });

  it("uses an isolated browser context for a second account, then disposes it", async () => {
    await mod.saveDumateAccount({ cookie: "BDUSS=first", uid: "first", name: "一号", source: "mychrome" });
    const cdp = fakeCdp({ href: mod.LOGIN_URL, qr: "https://passport.baidu.com/qr", cookies: [] });
    await mod.dumateLoginStart({ cdpConnect: cdp.connect, pollMs: 1, waitMs: 1_000 });
    expect(cdp.calls.find((c) => c.method === "Target.createTarget")!.params.browserContextId).toBe("CTX-1");
    const page = { href: "https://console.bce.baidu.com/", qr: "", cookies: ready };
    const poll = fakeCdp(page, ["USER-TAB", "OUR-TAB"]);
    const r = await mod.dumateLoginPoll({ cdpConnect: poll.connect, userInfo: async () => ({ ok: true, uid: "second", name: "二号" }) });
    expect(r).toMatchObject({ ok: true, loggedIn: true, account: "二号" });
    expect(poll.calls.find((c) => c.method === "Storage.getCookies")!.params).toEqual({ browserContextId: "CTX-1" });
    expect(poll.calls.some((c) => c.method === "Target.disposeBrowserContext" && c.params.browserContextId === "CTX-1")).toBe(true);
    expect(JSON.parse(readFileSync(store, "utf8")).accounts.map((a: { source: string }) => a.source)).toEqual(["mychrome", "isolated"]);
  });

  it("after the scan, sends its own tab to the console once to plant the session cookie", async () => {
    writeFileSync(loginState, JSON.stringify({ targetId: "OUR-TAB", browserContextId: "", settled: false }));
    const cdp = fakeCdp({ href: "", qr: "", cookies: [{ name: "BDUSS", domain: ".baidu.com", value: "u" }] }, ["USER-TAB", "OUR-TAB"]);
    expect(await mod.dumateLoginPoll({ cdpConnect: cdp.connect })).toEqual({ ok: true, loggedIn: false, stage: "need_console" });
    const nav = cdp.calls.filter((c) => c.method === "Page.navigate");
    expect(nav).toHaveLength(1);
    expect(cdp.calls.find((c) => c.method === "Target.attachToTarget")!.params.targetId).toBe("OUR-TAB");
    const again = fakeCdp({ href: "", qr: "", cookies: [{ name: "BDUSS", domain: ".baidu.com", value: "u" }] }, ["USER-TAB", "OUR-TAB"]);
    await mod.dumateLoginPoll({ cdpConnect: again.connect });
    expect(again.calls.some((c) => c.method === "Page.navigate")).toBe(false);
  });

  it("says so when its tab was closed, and never touches other tabs", async () => {
    writeFileSync(loginState, JSON.stringify({ targetId: "OUR-TAB", browserContextId: "" }));
    const cdp = fakeCdp({ href: "", qr: "", cookies: [] }, ["USER-TAB"]);
    const r = await mod.dumateLoginPoll({ cdpConnect: cdp.connect });
    expect(r).toMatchObject({ ok: false, loggedIn: false });
    expect(cdp.calls.every((c) => c.params?.targetId === undefined || c.params.targetId === "OUR-TAB")).toBe(true);
  });

  it("reports an unreachable shared browser instead of throwing", async () => {
    const r = await mod.dumateLoginStart({ cdpConnect: async () => { throw new Error("ECONNREFUSED"); } });
    expect(r).toMatchObject({ ok: false, loggedIn: false });
    expect(r.error).toContain("omb-mychrome");
  });

  const loginPage = "https://login.bce.baidu.com/?from=oa_dumate";
  const bduss = [{ name: "BDUSS", domain: ".baidu.com", value: "u" }];
  const state = () => JSON.parse(readFileSync(loginState, "utf8"));
  const clicks = (cdp: ReturnType<typeof fakeCdp>) =>
    cdp.calls.filter((c) => c.method === "Runtime.evaluate" && String(c.params.expression).includes(".click()"));

  it("clicks quick login on the owned login tab", async () => {
    writeFileSync(loginState, JSON.stringify({ targetId: "OUR-TAB", browserContextId: "", settled: false }));
    const cdp = fakeCdp({ href: loginPage, qr: "", cookies: bduss, quickLogin: true }, ["USER-TAB", "OUR-TAB"]);
    expect(await mod.dumateLoginPoll({ cdpConnect: cdp.connect })).toEqual({ ok: true, loggedIn: false, stage: "need_console" });
    expect(clicks(cdp)).toHaveLength(1);
    expect(state()).toMatchObject({ settleClickCount: 1, lastSettleClickAt: expect.any(Number) });
    const attaches = cdp.calls.filter((c) => c.method === "Target.attachToTarget");
    expect(attaches.length).toBeGreaterThan(0);
    expect(attaches.every((c) => c.params.targetId === "OUR-TAB")).toBe(true);
    expect(cdp.calls.some((c) => c.method === "Page.navigate")).toBe(false);
  });

  it("navigates to the console without clicking when already on console", async () => {
    writeFileSync(loginState, JSON.stringify({ targetId: "OUR-TAB", browserContextId: "", settled: false }));
    const cdp = fakeCdp({ href: "https://console.bce.baidu.com/", qr: "", cookies: bduss }, ["USER-TAB", "OUR-TAB"]);
    expect(await mod.dumateLoginPoll({ cdpConnect: cdp.connect })).toEqual({ ok: true, loggedIn: false, stage: "need_console" });
    expect(clicks(cdp)).toHaveLength(0);
    expect(cdp.calls.filter((c) => c.method === "Page.navigate").map((c) => c.params.url)).toEqual(["https://console.bce.baidu.com/"]);
    expect(state()).toMatchObject({ settled: true, settleClickCount: 0 });
  });

  it("stops clicking after three attempts", async () => {
    writeFileSync(loginState, JSON.stringify({ targetId: "OUR-TAB", browserContextId: "", settled: false, settleClickCount: 3, lastSettleClickAt: 0 }));
    const cdp = fakeCdp({ href: loginPage, qr: "", cookies: bduss, quickLogin: true }, ["USER-TAB", "OUR-TAB"]);
    await mod.dumateLoginPoll({ cdpConnect: cdp.connect });
    expect(clicks(cdp)).toHaveLength(0);
    expect(state()).toMatchObject({ settleClickCount: 3 });
  });

  it("throttles repeated quick-login clicks", async () => {
    const now = 1_800_000_000_000;
    writeFileSync(loginState, JSON.stringify({ targetId: "OUR-TAB", browserContextId: "", settled: false, settleClickCount: 1, lastSettleClickAt: now - 5_000 }));
    const early = fakeCdp({ href: loginPage, qr: "", cookies: bduss, quickLogin: true }, ["USER-TAB", "OUR-TAB"]);
    await mod.dumateLoginPoll({ cdpConnect: early.connect, now: () => now });
    expect(clicks(early)).toHaveLength(0);
    expect(state()).toMatchObject({ settleClickCount: 1, lastSettleClickAt: now - 5_000 });

    writeFileSync(loginState, JSON.stringify({ targetId: "OUR-TAB", browserContextId: "", settled: false, settleClickCount: 1, lastSettleClickAt: now - 10_000 }));
    const later = fakeCdp({ href: loginPage, qr: "", cookies: bduss, quickLogin: true }, ["USER-TAB", "OUR-TAB"]);
    await mod.dumateLoginPoll({ cdpConnect: later.connect, now: () => now });
    expect(clicks(later)).toHaveLength(1);
    expect(state()).toMatchObject({ settleClickCount: 2, lastSettleClickAt: now });
  });

  it("never attaches to another target", async () => {
    writeFileSync(loginState, JSON.stringify({ targetId: "OUR-TAB", browserContextId: "", settled: false }));
    const cdp = fakeCdp({ href: loginPage, qr: "", cookies: bduss, quickLogin: true },
      ["USER-TAB", "LOGIN-OTHER", "CONSOLE-OTHER", "OUR-TAB"]);
    await mod.dumateLoginPoll({ cdpConnect: cdp.connect });
    const touched = cdp.calls.filter((c) => c.params?.targetId !== undefined).map((c) => c.params.targetId);
    expect(touched.length).toBeGreaterThan(0);
    expect(touched.every((targetId) => targetId === "OUR-TAB")).toBe(true);
  });

  it("does not count an attempt when the button is absent", async () => {
    writeFileSync(loginState, JSON.stringify({ targetId: "OUR-TAB", browserContextId: "", settled: false, settleClickCount: 0, lastSettleClickAt: 0 }));
    const cdp = fakeCdp({ href: loginPage, qr: "", cookies: bduss, quickLogin: false }, ["USER-TAB", "OUR-TAB"]);
    await mod.dumateLoginPoll({ cdpConnect: cdp.connect });
    expect(state()).toMatchObject({ settleClickCount: 0, lastSettleClickAt: 0 });
    expect(cdp.calls.some((c) => c.method === "Page.navigate")).toBe(false);
  });
});
