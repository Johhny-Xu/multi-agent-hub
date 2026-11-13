import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import type { ServiceAccountsView } from "../shared/service-accounts.ts";
import { createAccountAutoSwitch, isLimitFailure, type AutoSwitchDeps } from "./account-auto-switch.ts";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

interface FakeAccount {
  id: string;
  label: string;
}

const ABC: FakeAccount[] = [
  { id: "acc-a", label: "Alpha" },
  { id: "acc-b", label: "Beta" },
  { id: "acc-c", label: "Gamma" },
];

const asView = (accounts: FakeAccount[], activeId: string | null, drifted: boolean): ServiceAccountsView => ({
  supported: true,
  accounts: accounts.map((account) => ({ ...account, createdAt: 0 })),
  activeId,
  drifted,
});

function setup(accounts: FakeAccount[], activeId: string | null, options: { drifted?: boolean; supported?: boolean; switchThrows?: boolean } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "account-auto-switch-"));
  dirs.push(dir);
  const statePath = join(dir, "auto-switch.json");
  let current = activeId;
  const switchedTo: string[] = [];
  const deps: AutoSwitchDeps = {
    statePath,
    view: () => (options.supported === false
      ? { supported: false, reason: "This engine cannot switch accounts here.", accounts: [], activeId: null, drifted: false }
      : asView(accounts, current, options.drifted ?? false)),
    switchTo: (_instanceId, accountId) => {
      if (options.switchThrows) throw new Error("switch refused");
      if (!accounts.some((account) => account.id === accountId)) throw new Error("That saved account is gone.");
      current = accountId;
      switchedTo.push(accountId);
      return asView(accounts, current, false);
    },
  };
  return { deps, statePath, switchedTo };
}

describe("createAccountAutoSwitch", () => {
  it("is off by default and reports disabled instead of switching", () => {
    const fake = setup(ABC, "acc-a");
    const auto = createAccountAutoSwitch(fake.deps);
    expect(auto.enabled("inst")).toBe(false);
    expect(auto.onTurnFailed("inst", "You have exceeded your quota")).toEqual({ switched: false, instanceId: "inst", why: "disabled" });
    expect(fake.switchedTo).toEqual([]);
  });

  it("persists enabled to the state file and a fresh instance reads it back", () => {
    const fake = setup(ABC, "acc-a");
    const first = createAccountAutoSwitch(fake.deps);
    first.setEnabled("inst", true);
    expect(existsSync(fake.statePath)).toBe(true);
    expect(JSON.parse(readFileSync(fake.statePath, "utf8"))).toEqual({ enabled: { inst: true }, limitedUntil: {} });
    const second = createAccountAutoSwitch(fake.deps);
    expect(second.enabled("inst")).toBe(true);
  });

  it("treats a corrupt state file as empty instead of throwing", () => {
    const fake = setup(ABC, "acc-a");
    writeFileSync(fake.statePath, "{not json", "utf8");
    const auto = createAccountAutoSwitch(fake.deps);
    expect(auto.enabled("inst")).toBe(false);
    auto.setEnabled("inst", true);
    const second = createAccountAutoSwitch(fake.deps);
    expect(second.enabled("inst")).toBe(true);
    expect(second.onTurnFailed("inst", "429 Too Many Requests")).toMatchObject({ switched: true, to: { id: "acc-b" } });
  });

  it("leaves the account alone when the error is not a quota or rate-limit failure", () => {
    const fake = setup(ABC, "acc-a");
    const auto = createAccountAutoSwitch(fake.deps);
    auto.setEnabled("inst", true);
    expect(auto.onTurnFailed("inst", "The model returned an invalid response")).toEqual({ switched: false, instanceId: "inst", why: "not_limit_error" });
    expect(fake.switchedTo).toEqual([]);
    expect(auto.status("inst").limited).toEqual([]);
  });

  it("switches to the next saved account in list order on a quota failure", () => {
    const fake = setup(ABC, "acc-a");
    const auto = createAccountAutoSwitch(fake.deps);
    auto.setEnabled("inst", true);
    expect(auto.onTurnFailed("inst", "quota exhausted for this account")).toEqual({
      switched: true,
      instanceId: "inst",
      from: { id: "acc-a", label: "Alpha" },
      to: { id: "acc-b", label: "Beta" },
      reason: "quota",
    });
    expect(fake.switchedTo).toEqual(["acc-b"]);
  });

  it("switches on a rate-limit failure too", () => {
    const fake = setup(ABC, "acc-a");
    const auto = createAccountAutoSwitch(fake.deps);
    auto.setEnabled("inst", true);
    expect(auto.onTurnFailed("inst", "429 Too Many Requests")).toEqual({
      switched: true,
      instanceId: "inst",
      from: { id: "acc-a", label: "Alpha" },
      to: { id: "acc-b", label: "Beta" },
      reason: "rate_limited",
    });
  });

  it("wraps past the end of the list back to its head", () => {
    const fake = setup(ABC, "acc-c");
    const auto = createAccountAutoSwitch(fake.deps);
    auto.setEnabled("inst", true);
    expect(auto.onTurnFailed("inst", "You've hit your usage limit")).toMatchObject({
      switched: true,
      to: { id: "acc-a", label: "Alpha" },
      reason: "quota",
    });
  });

  it("skips an account that is still inside its cooldown", () => {
    const fake = setup(ABC, "acc-a");
    writeFileSync(fake.statePath, JSON.stringify({ enabled: { inst: true }, limitedUntil: { inst: { "acc-b": 2_000 } } }), "utf8");
    let clock = 1_000;
    const auto = createAccountAutoSwitch({ ...fake.deps, now: () => clock });
    expect(auto.status("inst").limited).toEqual([{ accountId: "acc-b", until: 2_000 }]);
    expect(auto.onTurnFailed("inst", "quota exhausted")).toEqual({
      switched: true,
      instanceId: "inst",
      from: { id: "acc-a", label: "Alpha" },
      to: { id: "acc-c", label: "Gamma" },
      reason: "quota",
    });
  });

  it("reports no_other_account when every other account is cooling down", () => {
    const fake = setup([{ id: "acc-a", label: "Alpha" }, { id: "acc-b", label: "Beta" }], "acc-a");
    let clock = 1_000;
    const auto = createAccountAutoSwitch({ ...fake.deps, now: () => clock, cooldownMs: 60_000 });
    auto.setEnabled("inst", true);
    expect(auto.onTurnFailed("inst", "quota exhausted")).toMatchObject({ switched: true, to: { id: "acc-b" } });
    expect(auto.onTurnFailed("inst", "429 Too Many Requests")).toEqual({ switched: false, instanceId: "inst", why: "no_other_account" });
    expect(fake.switchedTo).toEqual(["acc-b"]);
    expect(auto.status("inst").limited.map((entry) => entry.accountId).sort()).toEqual(["acc-a", "acc-b"]);
  });

  it("does not switch when the live sign-in has drifted from the saved snapshot", () => {
    const fake = setup(ABC, "acc-a", { drifted: true });
    const auto = createAccountAutoSwitch(fake.deps);
    auto.setEnabled("inst", true);
    expect(auto.onTurnFailed("inst", "quota exhausted")).toEqual({ switched: false, instanceId: "inst", why: "drifted" });
    expect(fake.switchedTo).toEqual([]);
    expect(auto.status("inst").limited).toEqual([]);
  });

  it("reports unsupported when the engine has no switchable saved accounts", () => {
    const fake = setup(ABC, "acc-a", { supported: false });
    const auto = createAccountAutoSwitch(fake.deps);
    auto.setEnabled("inst", true);
    expect(auto.onTurnFailed("inst", "quota exhausted")).toEqual({ switched: false, instanceId: "inst", why: "unsupported" });
    expect(fake.switchedTo).toEqual([]);
  });

  it("reports switch_failed without throwing when the switch itself fails", () => {
    const fake = setup(ABC, "acc-a", { switchThrows: true });
    const auto = createAccountAutoSwitch(fake.deps);
    auto.setEnabled("inst", true);
    expect(auto.onTurnFailed("inst", "quota exhausted")).toEqual({ switched: false, instanceId: "inst", why: "switch_failed" });
    expect(fake.switchedTo).toEqual([]);
  });

  it("selects a cooled-down account again once its cooldown has passed", () => {
    const fake = setup([{ id: "acc-a", label: "Alpha" }, { id: "acc-b", label: "Beta" }], "acc-a");
    let clock = 1_000;
    const auto = createAccountAutoSwitch({ ...fake.deps, now: () => clock, cooldownMs: 60_000 });
    auto.setEnabled("inst", true);
    expect(auto.onTurnFailed("inst", "quota exhausted")).toMatchObject({ switched: true, to: { id: "acc-b" } });
    clock += 61_000;
    expect(auto.onTurnFailed("inst", "quota exhausted")).toEqual({
      switched: true,
      instanceId: "inst",
      from: { id: "acc-b", label: "Beta" },
      to: { id: "acc-a", label: "Alpha" },
      reason: "quota",
    });
    expect(auto.status("inst").limited).toEqual([{ accountId: "acc-b", until: clock + 60_000 }]);
  });

  it("walks the real view on two consecutive failures instead of guessing", () => {
    const fake = setup(ABC, "acc-a");
    let clock = 5_000;
    const auto = createAccountAutoSwitch({ ...fake.deps, now: () => clock });
    auto.setEnabled("inst", true);
    const first = auto.onTurnFailed("inst", "quota exhausted");
    const second = auto.onTurnFailed("inst", "quota exhausted");
    expect(first).toMatchObject({ switched: true, from: { id: "acc-a" }, to: { id: "acc-b" } });
    expect(second).toMatchObject({ switched: true, from: { id: "acc-b" }, to: { id: "acc-c" } });
    expect(fake.switchedTo).toEqual(["acc-b", "acc-c"]);
    expect(auto.status("inst").limited.map((entry) => entry.accountId).sort()).toEqual(["acc-a", "acc-b"]);
  });

  it("isLimitFailure recognises the quota and rate-limit wordings and nothing else", () => {
    expect(isLimitFailure("You have exceeded quota limit for this month")).toBe("quota");
    expect(isLimitFailure("error code 1005")).toBe("quota");
    expect(isLimitFailure("您的额度已用完")).toBe("quota");
    expect(isLimitFailure("You've hit your usage limit, resets Monday")).toBe("quota");
    expect(isLimitFailure("429 Too Many Requests")).toBe("rate_limited");
    expect(isLimitFailure("The model returned an invalid response")).toBeNull();
    expect(isLimitFailure("")).toBeNull();
  });

  it("isLimitFailure reads Google's RESOURCE_EXHAUSTED wordings (Antigravity) as quota, not overload", () => {
    expect(isLimitFailure("You have exhausted your capacity on this model. Your quota will reset after 2h3m.")).toBe("quota");
    expect(isLimitFailure("You have exhausted your capacity on this model.")).toBe("quota");
    expect(isLimitFailure("RESOURCE_EXHAUSTED: Resource has been exhausted (e.g. check quota).")).toBe("quota");
    expect(isLimitFailure("Resource exhausted")).toBe("quota");
    expect(isLimitFailure("The server is overloaded, try again")).toBeNull();
  });
});
