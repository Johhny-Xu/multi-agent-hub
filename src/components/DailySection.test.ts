// The Daily page's own logic: which engine a hub key belongs to, how many allowance rows a card shows, and the order
// both lists come out in. Rendering is left to the app; these run in node.
import { expect, it } from "vitest";

import { sortEngines } from "@/lib/engine-sort";
import {
  accountSummary,
  describeRun,
  engineFor,
  pendingReasonLabel,
  platformReason,
  shownAccounts,
  shownQuotas,
  statusLabel,
  statusTone,
  type DailyEngine,
} from "./DailySection";

const engines: DailyEngine[] = [
  { instanceId: "codebuddyCn", displayName: "CodeBuddy CN", driverKind: "codebuddyCnAgent", ready: true, signedIn: true },
  { instanceId: "githubCopilot", displayName: "GitHub Copilot", driverKind: "copilotAgent", ready: true, signedIn: true },
  { instanceId: "antigravity", displayName: "Google Gemini (Antigravity)", driverKind: "antigravityAgent", ready: true, signedIn: true },
  { instanceId: "mcode", displayName: "MiniMax Code", driverKind: "mcodeAgent", ready: true, signedIn: true },
  { instanceId: "codearts", displayName: "CodeArts", driverKind: "codeartsAcpAgent", ready: false, signedIn: false },
];

it("finds the engine behind a hub key however the two spell it", () => {
  expect(engineFor("codebuddy-cn", engines)?.instanceId).toBe("codebuddyCn");
  expect(engineFor("github-copilot", engines)?.instanceId).toBe("githubCopilot");
  expect(engineFor("antigravity", engines)?.instanceId).toBe("antigravity");
  expect(engineFor("minimaxcode", engines)?.instanceId).toBe("mcode");
  expect(engineFor("qoder-cn", engines)).toBeUndefined();
});

it("leaves a hub-only platform without an engine", () => {
  expect(engineFor("workbuddy", engines)).toBeUndefined();
  expect(engineFor("traecode", engines)).toBeUndefined();
  expect(engineFor("", engines)).toBeUndefined();
});

it("shows four allowance rows until the card asks for the rest", () => {
  const quotas = ["a", "b", "c", "d", "e", "f"];
  expect(shownQuotas(quotas, false)).toEqual(["a", "b", "c", "d"]);
  expect(shownQuotas(quotas, true)).toEqual(quotas);
  expect(shownQuotas(["a"], false)).toEqual(["a"]);
});

it("orders cards ready first, then by name, and hub-only platforms last", () => {
  const cards = [
    { key: "workbuddy", name: "WorkBuddy", ready: undefined, signedIn: undefined },
    { key: "zcode", name: "ZCode", ready: true, signedIn: true },
    { key: "codearts", name: "CodeArts", ready: false, signedIn: false },
    { key: "antigravity", name: "Antigravity", ready: true, signedIn: true },
  ];
  expect(sortEngines(cards).map((card) => card.key)).toEqual(["antigravity", "zcode", "codearts", "workbuddy"]);
});

it("shows three account rows until the card asks for the rest", () => {
  const rows = ["a", "b", "c", "d", "e"];
  expect(shownAccounts(rows, false)).toEqual(["a", "b", "c"]);
  expect(shownAccounts(rows, true)).toEqual(rows);
  expect(shownAccounts(["a"], false)).toEqual(["a"]);
});

it("tallies a platform's accounts only once it holds more than one", () => {
  expect(accountSummary({ accountCount: 3, signedAccounts: 2 })).toContain("2");
  expect(accountSummary({ accountCount: 3, signedAccounts: 2 })).toContain("3");
  expect(accountSummary({ accountCount: 1, signedAccounts: 1 })).toBe("");
  expect(accountSummary({})).toBe("");
});

it("names what a platform without credentials is, instead of calling it pending", () => {
  expect(statusLabel("unconfigured")).not.toBe(statusLabel("pending"));
  expect(statusLabel("restricted")).not.toBe(statusLabel("failed"));
  expect(statusLabel("success")).toBe(statusLabel("done"));
});

it("maps status values to appropriate human-readable labels", () => {
  expect(statusLabel("already")).toBe("已签");
  expect(statusLabel("partial")).toBe("部分成功");
  expect(statusLabel("waiting")).toBe(statusLabel("pending"));
  expect(statusLabel("error")).toBe(statusLabel("failed"));
  expect(statusLabel(undefined)).toBe(statusLabel("pending"));
});

it("maps check-in statuses to semantic tone styles", () => {
  expect(statusTone("success")).toContain("text-success");
  expect(statusTone("already")).toContain("text-success");
  expect(statusTone("partial")).toContain("text-warning");
  expect(statusTone("restricted")).toContain("text-warning");
  expect(statusTone("failed")).toContain("text-danger");
  expect(statusTone("error")).toContain("text-danger");
  expect(statusTone("unconfigured")).toContain("text-ink-tertiary");
  expect(statusTone("pending")).toContain("text-ink-secondary");
  expect(statusTone(undefined)).toContain("text-ink-secondary");
});

it("names the reason a platform is waiting, instead of showing the server's code", () => {
  expect(pendingReasonLabel("identity_missing")).not.toBe("");
  expect(pendingReasonLabel("awaiting_window")).not.toBe("");
  expect(pendingReasonLabel("quota_cooldown")).not.toBe("");
  expect(pendingReasonLabel("awaiting_campaign")).not.toBe("");
  expect(pendingReasonLabel("campaign_closed")).not.toBe("");
  expect(pendingReasonLabel("await_credits")).not.toBe("");
  expect(pendingReasonLabel("")).toBe("");
  expect(pendingReasonLabel(undefined)).toBe("");
  // The raw code never reaches the page, and neither does an untranslated key.
  expect(pendingReasonLabel("identity_missing")).not.toContain("identity_missing");
  expect(pendingReasonLabel("identity_missing")).not.toMatch(/^settings\./);
  expect(pendingReasonLabel("awaiting_window")).not.toMatch(/^settings\./);
});

it("asks for a sign-in when a platform has no credentials", () => {
  expect(platformReason({ available: false })).not.toBe("");
  expect(platformReason({ available: false })).not.toMatch(/^settings\./);
  expect(platformReason({ available: false, status: "unconfigured" })).not.toBe("");
  expect(platformReason({ available: true, pendingReason: "awaiting_window" })).toBe(
    pendingReasonLabel("awaiting_window"),
  );
  expect(platformReason({ available: true })).toBe("");
});

it("splits a run into the platforms it signed and the ones it did not", () => {
  const outcome = describeRun({
    workbuddy: { ok: true, status: "success", message: "签到成功 +10 积分" },
    codebuddy: { ok: true, status: "already", message: "今日已签到" },
    qoder: { ok: false, status: "failed", message: "等待设备身份" },
    trae: { ok: false, status: "pending", message: "等下一期开窗" },
  });
  expect(outcome.signed).toEqual(["workbuddy", "codebuddy"]);
  expect(outcome.failed.map((item) => item.key)).toEqual(["qoder", "trae"]);
  expect(outcome.failed[0]?.message).toBe("等待设备身份");
});

it("reads a run with nothing in it as nothing signed and nothing failed", () => {
  expect(describeRun(undefined)).toEqual({ signed: [], failed: [] });
  expect(describeRun({})).toEqual({ signed: [], failed: [] });
});
