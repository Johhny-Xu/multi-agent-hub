import { mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { antigravityProfileDirectory } from "./drivers/antigravity-acp.ts";
import { antigravityAccountsView, antigravityTokenPath, keepOutgoingPrimaryAccount, switchAntigravityAccount } from "./antigravity-accounts.ts";

let home: string;
const primary = "antigravity";
const added = "antigravity-2f1c9a44-0000-4000-8000-000000000001";

/** Where the agy CLI keeps an added account's sign-in: inside its profile HOME. */
const addedToken = () => join(antigravityProfileDirectory(added, home), "home", ".gemini", "antigravity-cli", "antigravity-oauth-token");

/** A sign-in file the way the agy CLI writes it: the account's own address inside the id_token. */
function tokenJson(email: string): string {
  const payload = Buffer.from(JSON.stringify({ email }), "utf8").toString("base64").replace(/=+$/u, "");
  return JSON.stringify({ token: `header.${payload}.signature`, refresh_token: `refresh-${email}` });
}

function write(path: string, body: string) {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, body);
}

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "agy-accounts-"));
  // The primary reads the CLI's own GEMINI_HOME; an added account reads its profile's HOME.
  write(join(home, ".gemini", "antigravity-cli", "antigravity-oauth-token"), tokenJson("first@example.test"));
});
afterEach(() => {
  vi.unstubAllGlobals();
});

const instances = () => ({
  [primary]: { driver: "antigravityAgent", displayName: "Google Gemini" },
  [added]: { driver: "antigravityAgent", displayName: "Work" },
  other: { driver: "claudeAgent", displayName: "Claude" },
});

describe("Antigravity's account list", () => {
  it("lists the primary and every added account, with the email each one is signed in as", async () => {
    write(addedToken(), tokenJson("work@example.test"));
    expect(antigravityTokenPath(added, { HOME: home }, home)).toBe(addedToken());
    const view = await antigravityAccountsView(instances(), { env: { HOME: home }, baseDir: home });
    expect(view.primaryId).toBe(primary);
    expect(view.accounts.map((row) => row.instanceId)).toEqual([primary, added]);
    expect(view.accounts.map((row) => row.email)).toEqual(["first@example.test", "work@example.test"]);
    expect(view.accounts.map((row) => row.label)).toEqual(["Google Gemini", "Work"]);
    // The primary is the one in use until another is switched to; only added accounts can be removed.
    expect(view.accounts.map((row) => row.active)).toEqual([true, false]);
    expect(view.accounts.map((row) => row.removable)).toEqual([false, true]);
  });

  it("lists an added account before it signs in, without an email yet, and never lists another engine", async () => {
    const view = await antigravityAccountsView(instances(), { env: { HOME: home }, baseDir: home });
    expect(view.accounts.map((row) => row.instanceId)).toEqual([primary, added]);
    expect(view.accounts[0]!.email).toBe("first@example.test");
    expect(view.accounts[1]!.email).toBeUndefined();
    expect(view.accounts[1]!.active).toBe(false);
    expect(view.accounts[1]!.removable).toBe(true);
  });

  it("switches by copying the chosen account's sign-in over the primary's, keeping both", async () => {
    write(addedToken(), tokenJson("work@example.test"));
    switchAntigravityAccount(instances(), added, { env: { HOME: home }, baseDir: home });
    const view = await antigravityAccountsView(instances(), { env: { HOME: home }, baseDir: home });
    expect(view.accounts.find((row) => row.instanceId === primary)?.email).toBe("work@example.test");
    expect(view.accounts.find((row) => row.instanceId === primary)?.active).toBe(true);
    expect(view.accounts.find((row) => row.instanceId === added)?.active).toBe(false);
    // The added account's own profile still holds its sign-in, so switching back is the same copy.
    expect(antigravityTokenPath(added, { HOME: home }, home)).toBe(addedToken());
  });

  it("refuses to switch to an account that is not signed in", () => {
    expect(() => switchAntigravityAccount(instances(), added, { env: { HOME: home }, baseDir: home }))
      .toThrow(/not signed in/u);
  });

  it("refuses an instance that is not an Antigravity account", () => {
    expect(() => switchAntigravityAccount(instances(), "other", { env: { HOME: home } }))
      .toThrow(/not set up here/u);
  });
  it("keeps the account the primary was signed in with as its own row before a switch overwrites it", async () => {
    write(addedToken(), tokenJson("work@example.test"));
    const list = instances() as Record<string, { driver?: string; displayName?: string; config?: unknown }>;
    const kept = "antigravity-2f1c9a44-0000-4000-8000-0000000000aa";
    expect(await keepOutgoingPrimaryAccount(list, added, { env: { HOME: home }, baseDir: home, newId: () => kept })).toBe(kept);
    expect(list[kept]).toEqual({ driver: "antigravityAgent", displayName: "first@example.test", config: {} });
    const keptToken = antigravityTokenPath(kept, { HOME: home }, home)!;
    expect(readFileSync(keptToken, "utf8")).toBe(tokenJson("first@example.test"));
    if (process.platform !== "win32") expect(statSync(keptToken).mode & 0o777).toBe(0o600);
    switchAntigravityAccount(list, added, { env: { HOME: home }, baseDir: home });
    const view = await antigravityAccountsView(list, { env: { HOME: home }, baseDir: home });
    // Every account is still listed once by its own row: nothing dropped out when the primary changed accounts.
    expect(view.accounts.map((row) => [row.instanceId, row.email])).toEqual([
      [primary, "work@example.test"], [added, "work@example.test"], [kept, "first@example.test"],
    ]);
    // Switching back to it restores the first account on the primary, and keeps nothing new: work@ is held by `added`.
    expect(await keepOutgoingPrimaryAccount(list, kept, { env: { HOME: home }, baseDir: home, newId: () => "antigravity-never" })).toBeUndefined();
    switchAntigravityAccount(list, kept, { env: { HOME: home }, baseDir: home });
    expect((await antigravityAccountsView(list, { env: { HOME: home }, baseDir: home })).accounts[0]!.email).toBe("first@example.test");
  });

  it("keeps nothing when an added account already holds the primary's account, or the chosen one is not signed in", async () => {
    const list = instances() as Record<string, { driver?: string; displayName?: string; config?: unknown }>;
    expect(await keepOutgoingPrimaryAccount(list, added, { env: { HOME: home }, baseDir: home })).toBeUndefined();
    write(addedToken(), tokenJson("FIRST@example.test"));
    expect(await keepOutgoingPrimaryAccount(list, added, { env: { HOME: home }, baseDir: home })).toBeUndefined();
    expect(await keepOutgoingPrimaryAccount(list, primary, { env: { HOME: home }, baseDir: home })).toBeUndefined();
    expect(Object.keys(list)).toEqual([primary, added, "other"]);
  });
});
