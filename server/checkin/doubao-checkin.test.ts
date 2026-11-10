// FEAT-doubao-checkin: the 8801 side of Doubao's daily sign-in. The browser runs on a cloud machine
// (doubao-signer.mjs over ssh); these tests drive the module with a fake runner and never reach a network.
import { existsSync, mkdtempSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { removeTempDir } from "../testing/cleanup.ts";

const home = mkdtempSync(join(tmpdir(), "doubao-checkin-"));
const cache = join(home, ".agenthub", "doubao-login.json");
let mod: typeof import("./doubao-checkin.mjs");

beforeAll(async () => {
  vi.stubEnv("AGENTHUB_HOME", home);
  vi.stubEnv("AGENTHUB_CHECKIN_STATE", join(home, ".agenthub", "checkin-state.json"));
  vi.stubEnv("AGENTHUB_CHECKIN_TICK_LOCK", join(home, ".agenthub", "tick.lock"));
  vi.stubEnv("DOUBAO_LOGIN_CACHE", cache);
  vi.resetModules();
  mod = await import("./doubao-checkin.mjs");
});
afterAll(() => { vi.unstubAllEnvs(); removeTempDir(home); });

const signed = {
  ok: true, loggedIn: true, signer: true, signed: "success", checkinCode: 0, checkinMsg: "",
  daily: { checked_in_today: true, continuous_days: 3 },
  claims: [{ code: "chat_3", title: "对话 3 次", status: 2, reward: 20, ok: true, resCode: 0, resMsg: "" }],
  tasks: [],
};

describe("doubao signer plumbing", () => {
  it("has no built-in signer host: DOUBAO_SIGNER_CMD alone names the command", async () => {
    expect(mod.signerCommand({})).toBeNull();
    expect(mod.signerCommand({ DOUBAO_SIGNER_CMD: " ssh cloud-host node x.mjs " })).toEqual(["ssh", "cloud-host", "node", "x.mjs"]);
    expect(await mod.runSigner("status", { env: {} })).toEqual({ ok: false, error: "signer_unconfigured" });
    expect(mod.describeSignerError("signer_unconfigured")).toContain("DOUBAO_SIGNER_CMD");
  });

  it("takes the last JSON line of the signer's output and skips noise", () => {
    expect(mod.lastJsonLine('warn: x\n{"ok":true,"a":1}\n{"ok":false}\n')).toEqual({ ok: false });
    expect(mod.lastJsonLine("[doubao] noise\n{broken\n")).toBeNull();
  });

  it("returns a timeout or exit error instead of throwing when the signer misbehaves", async () => {
    const r = await mod.runSigner("status", { env: { DOUBAO_SIGNER_CMD: `${process.execPath} -e process.exit(3)` } });
    expect(r).toMatchObject({ ok: false, error: expect.stringMatching(/^signer_exit_3/) });
  });

  it("words cloud failures for the check-in card", () => {
    expect(mod.describeSignerError("egress_down: x")).toContain("国内出口隧道");
    expect(mod.describeSignerError("region_ban: x")).toContain("地区");
    expect(mod.describeSignerError("not_logged_in")).toContain("扫码登录");
  });
});

describe("doubaoOutcome", () => {
  it("reports a fresh sign-in with the claimed finished tasks and the streak", () => {
    const r = mod.doubaoOutcome(signed, "2026-11-10", "12:00:00");
    expect(r).toMatchObject({ platform: "doubao", ok: true, status: "success", credits: 20, consecutiveDays: 3 });
    expect(r.message).toContain("签到成功");
    expect(r.message).toContain("领取 1 个已完成任务 +20");
    expect(r.accounts).toHaveLength(1);
  });

  it("is idempotent: already signed and nothing to claim is 'already', not a new success", () => {
    const r = mod.doubaoOutcome({ ...signed, signed: "already", claims: [] }, "2026-11-10", "12:00:00");
    expect(r.status).toBe("already");
    expect(r.message).toContain("今日已签到");
    expect(r.message).toContain("没有待领取的已完成任务");
  });

  it("marks a failed claim partial and a missed sign-in failed, so the scheduler retries", () => {
    const partial = mod.doubaoOutcome({ ...signed, ok: false, claims: [{ ...signed.claims[0], ok: false, resCode: 710010702 }] }, "d", "t");
    expect(partial.status).toBe("partial");
    expect(partial.message).toContain("710010702");
    const failed = mod.doubaoOutcome({ ...signed, ok: false, signed: "failed", checkinCode: 710010702, claims: [] }, "d", "t");
    expect(failed.status).toBe("failed");
  });

  it("asks for the QR sign-in when the cloud browser is not logged in, without retrying all day", () => {
    const r = mod.doubaoOutcome({ ok: false, loggedIn: false, error: "not_logged_in" }, "d", "t");
    expect(r).toMatchObject({ status: "expired", loginRequired: true, accounts: [] });
  });

  it("turns a cloud error into a failed, retryable result", () => {
    expect(mod.doubaoOutcome({ ok: false, error: "egress_down: tunnel" }, "d", "t")).toMatchObject({ status: "failed" });
  });
});

describe("checkinDoubao and the QR sign-in", () => {
  it("caches only whether the cloud browser is logged in, never a credential", async () => {
    const r = await mod.checkinDoubao({ runSigner: async () => signed, today: "2026-11-10", time: "08:30:00" });
    expect(r.status).toBe("success");
    const saved = JSON.parse(readFileSync(cache, "utf-8"));
    expect(Object.keys(saved).sort()).toEqual(["checkedAt", "loggedIn"]);
    expect(saved.loggedIn).toBe(true);
    expect(await mod.listDoubaoAccounts()).toEqual([expect.objectContaining({ identity: "doubao:cloud-browser", active: true })]);
  });

  it("hands the QR screenshot through and reports a missing QR plainly", async () => {
    const qr = await mod.doubaoLoginStart({ runSigner: async () => ({ ok: true, loggedIn: false, qrFound: true, qrPng: "iVBORw0K" }) });
    expect(qr).toEqual({ ok: true, loggedIn: false, qrPng: "iVBORw0K" });
    const none = await mod.doubaoLoginStart({ runSigner: async () => ({ ok: true, loggedIn: false, qrFound: false, qrPng: "x" }) });
    expect(none).toMatchObject({ ok: false, error: expect.stringContaining("二维码") });
    expect(await mod.readDoubaoLogin()).toMatchObject({ loggedIn: false });
  });

  it("polls the scan: logged in flips the cache so the card can run", async () => {
    const r = await mod.doubaoLoginPoll({ runSigner: async (cmd) => (cmd === "login-poll" ? { ok: true, loggedIn: true } : { ok: false }) });
    expect(r).toEqual({ ok: true, loggedIn: true });
    expect(await mod.readDoubaoLogin()).toMatchObject({ loggedIn: true });
  });

  it("does not reach the cloud at all before the first QR sign-in", async () => {
    writeFileSync(cache, JSON.stringify({ loggedIn: false, checkedAt: 1 }));
    const marker = join(home, "signer-ran");
    vi.stubEnv("DOUBAO_SIGNER_CMD", `${process.execPath} -e require('fs').writeFileSync('${marker}','x')`);
    const r = await mod.checkinDoubao({ today: "2026-11-10", time: "08:30:00" });
    vi.stubEnv("DOUBAO_SIGNER_CMD", "");
    expect(r).toMatchObject({ status: "expired", loginRequired: true });
    expect(existsSync(marker)).toBe(false);
  });

  it("joins the check-in hub: doubao is a platform with a QR login entry and its account row", async () => {
    mkdirSync(join(home, ".agenthub"), { recursive: true });
    writeFileSync(cache, JSON.stringify({ loggedIn: true, checkedAt: Date.now() }));
    const checkin = await import("./checkin.mjs");
    expect(checkin.CHECKIN_PLATFORMS).toContain("doubao");
    const overview = await checkin.getCheckinOverview();
    const doubao = overview.platforms.doubao as Record<string, any>;
    expect(doubao).toMatchObject({ available: true, loginKind: "qr", status: "pending", accountCount: 1 });
    expect((overview.openSourceProjects as any).doubao[0].url).toContain("wangmingdong/workbuddy-signin");
  });
});
