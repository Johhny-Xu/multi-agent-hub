// Antigravity's accounts are its instances: the primary `antigravity` plus every `antigravity-<uuid>` added in
// Settings, each signed in with its own Google profile. This lists them as one account list, switches which
// account the primary runs as, and leaves removal to the instance route that already owns it.
import { copyFileSync, mkdirSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

import { antigravityProfileDirectory, isAddedAntigravityAccount } from "./drivers/antigravity-acp.ts";
import { antigravityAccount } from "./drivers/antigravity-account.ts";
import { userHome } from "./env-path.ts";

/** One row of the card's account list; never carries a credential. */
export interface AntigravityAccountRow {
  /** The instance that holds this account's Google sign-in. */
  instanceId: string;
  label: string;
  email?: string;
  /** The account the primary instance is signed in with right now. */
  active: boolean;
  /** The first account stays: it is the provider itself, not one added here. */
  removable: boolean;
}

export interface AntigravityAccountsView {
  accounts: AntigravityAccountRow[];
  /** The instance whose card this list belongs to. */
  primaryId: string;
}

type Env = Record<string, string | undefined>;

/** Where the agy CLI keeps its sign-in for an added account: its own profile HOME, never the person's ~/.gemini. */
function addedCliTokenPath(instanceId: string, baseDir?: string): string {
  return join(antigravityProfileDirectory(instanceId, baseDir), "home", ".gemini", "antigravity-cli", "antigravity-oauth-token");
}

/** The packaged runtime's own sign-in file, for an instance that runs it instead of the CLI. */
function packagedTokenPath(instanceId: string, baseDir?: string): string {
  return join(antigravityProfileDirectory(instanceId, baseDir), "antigravity-acp", "acp_token.json");
}

/** The primary instance shares the person's real GEMINI_HOME, so its sign-in is the one the CLI itself reads. */
function primaryCliTokenPath(env: Env): string {
  const geminiHome = env.GEMINI_HOME?.trim() ? resolve(env.GEMINI_HOME.trim()) : join(userHome(env), ".gemini");
  return join(geminiHome, "antigravity-cli", "antigravity-oauth-token");
}

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

/** The sign-in file this instance actually has, or undefined when it has none. */
export function antigravityTokenPath(instanceId: string, env: Env = process.env, baseDir?: string): string | undefined {
  const candidates = isAddedAntigravityAccount(instanceId)
    ? [addedCliTokenPath(instanceId, baseDir), packagedTokenPath(instanceId, baseDir)]
    : [primaryCliTokenPath(env), packagedTokenPath(instanceId, baseDir)];
  return candidates.find(isFile);
}

/** Every Antigravity instance, in the order the card shows them: the primary first, then the added ones. */
export function antigravityAccountInstances(
  instances: Record<string, { driver?: string; displayName?: string }>,
  primaryId = "antigravity",
): Array<{ instanceId: string; label: string }> {
  const rows: Array<{ instanceId: string; label: string }> = [];
  const primary = instances[primaryId];
  if (primary?.driver === "antigravityAgent") {
    rows.push({ instanceId: primaryId, label: primary.displayName ?? "Antigravity" });
  }
  for (const [instanceId, entry] of Object.entries(instances)) {
    if (entry.driver !== "antigravityAgent" || !isAddedAntigravityAccount(instanceId)) continue;
    rows.push({ instanceId, label: entry.displayName ?? instanceId });
  }
  return rows;
}

/** The card's account list: who is signed in, with which email, and which one the primary runs as. */
export async function antigravityAccountsView(
  instances: Record<string, { driver?: string; displayName?: string }>,
  options: { primaryId?: string; env?: Env; baseDir?: string } = {},
): Promise<AntigravityAccountsView> {
  const primaryId = options.primaryId ?? "antigravity";
  const env = options.env ?? process.env;
  const accounts = await Promise.all(antigravityAccountInstances(instances, primaryId).map(async (row) => {
    const path = antigravityTokenPath(row.instanceId, env, options.baseDir);
    const identity = path ? await antigravityAccount(path) : undefined;
    return {
      instanceId: row.instanceId,
      label: row.label,
      ...(identity?.email ? { email: identity.email } : {}),
      // The primary row is what every new task runs as. A just-switched-away added account still holds a copy
      // of the same sign-in, but nothing reads it until that account is switched to again.
      active: row.instanceId === primaryId && Boolean(path),
      removable: isAddedAntigravityAccount(row.instanceId),
    } satisfies AntigravityAccountRow;
  }));
  return { accounts, primaryId };
}

/**
 * Makes `accountInstanceId`'s Google sign-in the one the primary runs as: the primary's own sign-in file is
 * replaced with that account's, so every new task on the primary starts as that account. The added account's
 * own profile is left alone, so switching back is the same copy in the other direction.
 */
export function switchAntigravityAccount(
  instances: Record<string, { driver?: string; displayName?: string }>,
  accountInstanceId: string,
  options: { primaryId?: string; env?: Env; baseDir?: string } = {},
): void {
  const primaryId = options.primaryId ?? "antigravity";
  const env = options.env ?? process.env;
  // Only an Antigravity instance is an account here, and only a set-up Antigravity primary can run it.
  if (!isAntigravityAccountInstance(instances, primaryId) || !isAntigravityAccountInstance(instances, accountInstanceId)) {
    throw Object.assign(new Error("Antigravity is not set up here."), { status: 400 });
  }
  const source = antigravityTokenPath(accountInstanceId, env, options.baseDir);
  if (!source) throw Object.assign(new Error("That account is not signed in yet. Sign it in first."), { status: 409 });
  // The primary's file is the CLI's own when it exists; otherwise this is the first sign-in it gets.
  const target = antigravityTokenPath(primaryId, env, options.baseDir) ?? primaryCliTokenPath(env);
  if (resolve(source) === resolve(target)) return;
  mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
  copyFileSync(source, target);
}

/** True when the instance is one this module may switch to: an Antigravity instance that exists. */
export function isAntigravityAccountInstance(
  instances: Record<string, { driver?: string }>,
  instanceId: string,
): boolean {
  return instances[instanceId]?.driver === "antigravityAgent" && (instanceId === "antigravity" || isAddedAntigravityAccount(instanceId));
}
