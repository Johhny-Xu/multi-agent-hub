// Per-engine account switching for CLIs that keep their own sign-in on disk. A snapshot copies the
// CLI's credential files into this server's data folder; switching writes one back. The CLI reads
// the files when it starts, so a switch reaches every new task and never touches a running one.
import { createDecipheriv, createHash, randomUUID } from "node:crypto";
import {
  chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync,
} from "node:fs";
import { basename, dirname, join, resolve } from "node:path";

import { SERVICE_ACCOUNT_LABEL_MAX, type ServiceAccountsView } from "../shared/service-accounts.ts";
import { writeFileAtomic } from "./atomic.ts";
import { DATA_DIR } from "./config.ts";
import type { InstanceConfig } from "./contracts.ts";
import { decryptZcodeCredentialValue } from "./drivers/zcode-acp.ts";
import { userHome } from "./env-path.ts";

const MAX_FILE_BYTES = 4 * 1024 * 1024;
const MAX_TREE_BYTES = 16 * 1024 * 1024;
const MAX_TREE_FILES = 4000;
const ACCOUNT_ID = /^[a-f0-9-]{36}$/;
const INSTANCE_ID = /^[\w.-]{1,200}$/;

type Env = Record<string, string | undefined>;

interface SpecEntry {
  /** Stable name for the payload inside a snapshot folder. */
  key: string;
  kind: "file" | "dir";
  /** The first existing path is read; the first path is written on restore. */
  paths: string[];
  /** Inside a folder, the files to read in this order — the first that exists is the sign-in. */
  dirPriority?: string[];
}

interface Spec {
  entries(env: Env): SpecEntry[];
  identity?(read: (key: string) => Buffer | undefined): string | undefined;
  /** A stable invariant of the account — a uid, an email, a key id — that no nickname change alters. */
  key?(read: (key: string) => Buffer | undefined): string | undefined;
  /**
   * The sign-in without the credential that rotates: one account agrees on it across a token refresh,
   * and two different accounts never do. It is the second line of recognition, after the account's
   * own invariant.
   */
  stable?(read: (key: string) => Buffer | undefined): string | undefined;
  /** Says why a sign-in cannot be read as stored; a pair of files that only work together is checked here. */
  validate?(read: (key: string) => Buffer | undefined): SignInProblem | undefined;
  /** The fingerprint of the credential itself, which rotates on a refresh; matching it alone never mixes two accounts. */
  credentialKey?(read: (key: string) => Buffer | undefined): string | undefined;
  /** The account's own id as the engine stores it; it survives a token refresh. */
  accountId?(read: (key: string) => Buffer | undefined): string | undefined;
  /** The entries that hold the rotating credential; every other entry must be unchanged to reuse a snapshot. */
  tokenEntries?: string[];
  /** True when the identity names the account rather than a provider list, so a lone identity match decides. */
  identityNamesAccount?: boolean;
  note?: "shared-gh";
}

interface AccountKeys {
  invariant?: string;
  credential?: string;
}

type SignInProblem = "missing-machine-key" | "unreadable";

const PROBLEM_TEXT: Record<SignInProblem, string> = {
  "missing-machine-key": "the machine key that decrypts it is missing",
  unreadable: "it cannot be read with its machine key",
};

interface StoredAccount {
  id: string;
  label: string;
  identity?: string;
  /** The account's stable id (uid, email, key fingerprint); a nickname change never alters it. */
  key?: string;
  /** The account's own id as the engine stores it; it survives a token refresh. */
  accountId?: string;
  createdAt: number;
  hashes: Record<string, string | null>;
}

interface AccountIndex {
  version: 1;
  activeId: string | null;
  accounts: StoredAccount[];
}

export type { ServiceAccountsView } from "../shared/service-accounts.ts";

export const SERVICE_ACCOUNTS_DIR = join(DATA_DIR, "service-accounts");

function fail(status: number, message: string): Error & { status: number } {
  return Object.assign(new Error(message), { status });
}

function homeOf(env: Env): string {
  return userHome(env);
}

function under(env: Env, name: string, fallback: string): string {
  const raw = env[name]?.trim();
  return raw ? resolve(raw) : fallback;
}

function xdgConfig(env: Env): string {
  return under(env, "XDG_CONFIG_HOME", join(homeOf(env), ".config"));
}

function xdgData(env: Env): string {
  return under(env, "XDG_DATA_HOME", join(homeOf(env), ".local", "share"));
}

function fileEntry(key: string, ...paths: string[]): SpecEntry {
  return { key, kind: "file", paths: paths.filter(Boolean) };
}

function dirEntry(key: string, path: string, dirPriority?: string[]): SpecEntry {
  return { key, kind: "dir", paths: [path], ...(dirPriority ? { dirPriority } : {}) };
}

function parseJson(buffer: Buffer | undefined): unknown {
  if (!buffer) return undefined;
  try {
    return JSON.parse(buffer.toString("utf8"));
  } catch {
    return undefined;
  }
}

function text(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim().replace(/\p{Cc}/gu, "");
  return trimmed ? trimmed.slice(0, 120) : undefined;
}

function field(read: (key: string) => Buffer | undefined, key: string, ...names: string[]): string | undefined {
  let value = parseJson(read(key)) as Record<string, unknown> | undefined;
  for (const name of names) {
    if (!value || typeof value !== "object") return undefined;
    value = value[name] as Record<string, unknown> | undefined;
  }
  return text(value);
}

/** hosts.yml is the `gh` CLI's own store: the login is the user named under github.com. */
function ghLogin(read: (key: string) => Buffer | undefined): string | undefined {
  const raw = read("gh-hosts");
  if (raw) {
    const match = /^[ \t]+user:[ \t]*["']?([^"'\s]+)["']?[ \t]*$/m.exec(raw.toString("utf8"));
    if (match?.[1]) return text(match[1]);
  }
  const token = read("token")?.toString("utf8").trim();
  if (token) {
    const fp = createHash("sha256").update(token).digest("hex").slice(0, 8);
    return `copilot-${fp}`;
  }
  return undefined;
}

function clineSettingsPath(env: Env): string {
  if (env.CLINE_PROVIDER_SETTINGS_PATH?.trim()) return resolve(env.CLINE_PROVIDER_SETTINGS_PATH.trim());
  const home = under(env, "CLINE_DIR", join(homeOf(env), ".cline"));
  const data = under(env, "CLINE_DATA_DIR", join(home, "data"));
  return join(data, "settings", "providers.json");
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function clineIdentity(read: (key: string) => Buffer | undefined): string | undefined {
  const parsed = parseJson(read("providers")) as Record<string, unknown> | undefined;
  if (!parsed) return undefined;
  const providers = record(parsed.providers);
  if (!providers) return undefined;
  const last = typeof parsed.lastUsedProvider === "string" ? parsed.lastUsedProvider : Object.keys(providers)[0];
  const p = last ? record(providers[last]) : undefined;
  const settings = record(p?.settings);
  const auth = record(settings?.auth);
  const metadata = record(auth?.metadata);
  const userInfo = record(metadata?.userInfo);
  const name = text(userInfo?.name) ?? text(userInfo?.firstName);
  const email = text(userInfo?.email);
  if (name && email) return `${name} (${email})`;
  if (email) return email;
  if (name) return name;
  const accountId = text(auth?.accountId);
  if (accountId) return accountId;
  return last ? `provider:${last}` : undefined;
}

function codeartsIdentity(read: (key: string) => Buffer | undefined): string | undefined {
  const account = codeartsAccount(read);
  if (account?.userName) return account.userName;
  const env = read("env")?.toString("utf8");
  if (env) {
    const match = /^CODEARTS_CLI_AK=(.+)$/m.exec(env);
    if (match?.[1]?.trim()) {
      return text(`AK:${match[1].trim()}`);
    }
  }
  return field(read, "auth", "name") ?? field(read, "auth", "username");
}

function codebuddyIdentity(read: (key: string) => Buffer | undefined): string | undefined {
  const nick = field(read, "auth", "account", "nickname");
  if (nick) return nick;
  const uid = field(read, "auth", "account", "uid") ?? field(read, "auth", "account", "uin");
  return uid ? `UID:${uid}` : undefined;
}

function meooIdentity(read: (key: string) => Buffer | undefined): string | undefined {
  const user = field(read, "credentials", "username") ?? field(read, "credentials", "userId");
  if (user) return user;
  const env = read("env")?.toString("utf8");
  if (env) {
    const match = /^MEOO_AK=(.+)$/m.exec(env);
    if (match?.[1]?.trim()) {
      const ak = match[1].trim();
      const fp = createHash("sha256").update(ak).digest("hex").slice(0, 8);
      return `ak-${fp}`;
    }
  }
  return undefined;
}

function opencodeIdentity(read: (key: string) => Buffer | undefined): string | undefined {
  const parsed = parseJson(read("auth")) as Record<string, unknown> | undefined;
  if (!parsed) return undefined;
  const keys = Object.keys(parsed).filter((k) => parsed[k] !== null && parsed[k] !== undefined).sort();
  return keys.length ? `providers:${keys.join("+")}` : undefined;
}

function zcodeIdentity(read: (key: string) => Buffer | undefined): string | undefined {
  for (const { user } of zcodeUsers(read)) {
    const name = text(user.displayName) ?? text(user.username) ?? text(user.name);
    if (name) return name;
  }
  return undefined;
}

function mcodeIdentity(read: (key: string) => Buffer | undefined): string | undefined {
  const parsed = parseJson(read("auth")) as Record<string, unknown> | undefined;
  if (typeof parsed?.region === "string") return `mcode:${parsed.region}`;
  const region = mcodeRegion(read);
  return region ? `mcode:${region}` : undefined;
}

function mimoIdentity(read: (key: string) => Buffer | undefined): string | undefined {
  const parsed = parseJson(read("auth")) as Record<string, unknown> | undefined;
  const meta = parsed?.xiaomi && typeof parsed.xiaomi === "object" ? (parsed.xiaomi as Record<string, unknown>).metadata as Record<string, unknown> | undefined : undefined;
  const uid = parsed?.uid ?? parsed?.userId ?? parsed?.id ?? meta?.uid;
  return uid ? text(`UID:${uid}`) : undefined;
}

/**
 * `qodercli login` stores its sign-in in `.auth/user` as AES-128-CBC with the machine id as both key and
 * IV (qoder-cli 1.1.74); older builds may leave plain JSON. Without that machine id the file cannot be
 * read, so a Qoder account is the pair of files, never the user file alone.
 */
function qoderUser(read: (key: string) => Buffer | undefined): Record<string, unknown> | SignInProblem {
  const raw = read("user")?.toString("utf8").trim();
  if (!raw) return "unreadable";
  const parsed = (value: string): Record<string, unknown> | undefined => {
    try {
      return record(JSON.parse(value.replace(/^\uFEFF/, "")));
    } catch {
      return undefined;
    }
  };
  if (raw.startsWith("{")) return parsed(raw) ?? "unreadable";
  const key = Buffer.from((read("machine_id")?.toString("utf8").trim() ?? "").slice(0, 16), "utf8");
  if (key.length !== 16) return "missing-machine-key";
  try {
    const decipher = createDecipheriv("aes-128-cbc", key, key);
    const plain = Buffer.concat([decipher.update(Buffer.from(raw, "base64")), decipher.final()]).toString("utf8");
    return parsed(plain) ?? "unreadable";
  } catch {
    return "unreadable";
  }
}

function qoderIdentity(read: (key: string) => Buffer | undefined): string | undefined {
  const parsed = qoderUser(read);
  if (typeof parsed === "string") return undefined;
  const nested = [parsed.user, parsed.account, parsed.profile].map(record).find(Boolean) ?? parsed;
  const name = text(nested.nickname) ?? text(nested.name) ?? text(nested.displayName) ?? text(nested.username);
  const email = text(nested.email) ?? text(parsed.email);
  const id = text(nested.uid) ?? text(nested.id) ?? text(nested.user_id) ?? text(nested.userId);
  if (name) return name;
  if (email) return email;
  return id ? `qoder-${createHash("sha256").update(id).digest("hex").slice(0, 8)}` : undefined;
}

function qoderProblem(read: (key: string) => Buffer | undefined): SignInProblem | undefined {
  const parsed = qoderUser(read);
  return typeof parsed === "string" ? parsed : undefined;
}

function antigravityIdentity(read: (key: string) => Buffer | undefined): string | undefined {
  const parsed = parseJson(read("token")) as Record<string, unknown> | undefined;
  if (!parsed) return undefined;
  if (typeof parsed.id_token_email === "string" && parsed.id_token_email) return text(parsed.id_token_email);
  if (typeof parsed.email === "string" && parsed.email) return text(parsed.email);
  if (typeof parsed.id_token === "string") {
    const parts = parsed.id_token.split(".");
    if (parts.length >= 2) {
      try {
        const payload = JSON.parse(Buffer.from(parts[1]!, "base64").toString("utf8")) as Record<string, unknown>;
        if (typeof payload.email === "string" && payload.email) return text(payload.email);
      } catch {}
    }
  }
  return undefined;
}

function jwtIdentity(read: (key: string) => Buffer | undefined, key: string): string | undefined {
  const raw = read(key)?.toString("utf8").trim();
  if (!raw) return undefined;
  const parts = raw.split(".");
  if (parts.length >= 2) {
    try {
      const payload = JSON.parse(Buffer.from(parts[1]!, "base64").toString("utf8")) as Record<string, unknown>;
      const data = record(payload.data) ?? payload;
      const id = data.id ?? data.user_id ?? payload.sub;
      if (id !== undefined) return `UID:${id}`;
    } catch {}
  }
  return undefined;
}


/** The account's own uid, as the CLI stores it: an id the account keeps when its nickname changes. */
function codebuddyKey(read: (key: string) => Buffer | undefined): string | undefined {
  return field(read, "auth", "account", "uid") ?? field(read, "auth", "account", "uin");
}

/**
 * GitHub's own account id as the gh store names it: the login under `user:`. The Copilot token is
 * reissued every few hours, the login it belongs to is not, so the login is what identifies the account.
 */
function ghAccountLogin(read: (key: string) => Buffer | undefined): string | undefined {
  const raw = read("gh-hosts")?.toString("utf8");
  if (!raw) return undefined;
  const match = /^[ \t]+user:[ \t]*["']?([^"'\s]+)["']?[ \t]*$/m.exec(raw);
  return match?.[1] ? text(match[1]) : undefined;
}

/** The Copilot token's own fingerprint: what the account was called before the login was read. */
function copilotCredentialKey(read: (key: string) => Buffer | undefined): string | undefined {
  const token = read("token")?.toString("utf8").trim();
  if (!token) return undefined;
  return `v2:copilot-token:${createHash("sha256").update(token).digest("hex").slice(0, 12)}`;
}

/** The Meoo AK's own fingerprint: what the account was called before the user id was read. */
function meooCredentialKey(read: (key: string) => Buffer | undefined): string | undefined {
  const env = read("env")?.toString("utf8");
  const match = env ? /^MEOO_AK=(.+)$/m.exec(env) : null;
  if (!match?.[1]?.trim()) return undefined;
  return `v2:meoo-ak:${createHash("sha256").update(match[1].trim()).digest("hex").slice(0, 12)}`;
}

/** The CodeArts AK's own fingerprint: what the account was called before the domain and user were read. */
function codeartsCredentialKey(read: (key: string) => Buffer | undefined): string | undefined {
  const env = read("env")?.toString("utf8");
  const match = env ? /^CODEARTS_CLI_AK=(.+)$/m.exec(env) : null;
  if (!match?.[1]?.trim()) return undefined;
  return `v2:codearts-ak:${createHash("sha256").update(match[1].trim()).digest("hex").slice(0, 12)}`;
}

/** The GitHub login the shared gh store names; it is the Copilot account's own id. */
function copilotAccountId(read: (key: string) => Buffer | undefined): string | undefined {
  return ghAccountLogin(read);
}

/** The Meoo account's own user id, as its credential file keeps it beside the rotating API key. */
function meooUserId(read: (key: string) => Buffer | undefined): string | undefined {
  return field(read, "credentials", "userId") ?? field(read, "credentials", "username");
}

/** CodeArts' own account id: the domain and user its OAuth credential carries, next to the rotating AK. */
function codeartsAccount(read: (key: string) => Buffer | undefined): { domainId: string; userId: string; userName?: string; domainName?: string } | undefined {
  const parsed = parseJson(read("auth")) as Record<string, unknown> | undefined;
  const provider = parsed ? record(parsed["inferhub-provider"]) : undefined;
  const raw = provider?.accountId;
  if (typeof raw !== "string" || !raw) return undefined;
  let account: Record<string, unknown> | undefined;
  try {
    account = record(JSON.parse(raw));
  } catch {
    return undefined;
  }
  if (!account) return undefined;
  const domainId = text(account.domain_id);
  const userId = text(account.user_id);
  if (!domainId || !userId) return undefined;
  return { domainId, userId, userName: text(account.user_name), domainName: text(account.domain_name) };
}

/** Every signed-in provider in ZCode's credential store, active provider first. */
function zcodeUsers(read: (key: string) => Buffer | undefined): Array<{ provider: string; user: Record<string, unknown> }> {
  const raw = read("credentials");
  if (!raw) return [];
  let parsed: Record<string, unknown> | undefined;
  try {
    parsed = JSON.parse(raw.toString("utf8"));
  } catch {
    return [];
  }
  if (!parsed || typeof parsed !== "object") return [];
  const active = decryptZcodeCredentialValue(parsed["oauth:active_provider"], process.env)?.trim();
  const users: Array<{ provider: string; user: Record<string, unknown> }> = [];
  for (const [key, val] of Object.entries(parsed)) {
    if (!key.includes("user_info")) continue;
    const dec = decryptZcodeCredentialValue(val, process.env);
    if (!dec) continue;
    try {
      const user = JSON.parse(dec);
      if (user && typeof user === "object") {
        users.push({ provider: key.replace(/^oauth:/, "").replace(/:user_info$/, ""), user });
      }
    } catch {}
  }
  users.sort((a, b) => (a.provider === active ? -1 : b.provider === active ? 1 : 0));
  return users;
}

function zcodeKey(read: (key: string) => Buffer | undefined): string | undefined {
  for (const { user } of zcodeUsers(read)) {
    const id = text(user.id) ?? text(user.uid) ?? text(user.userId);
    if (id) return id;
  }
  return undefined;
}

function qoderKey(read: (key: string) => Buffer | undefined): string | undefined {
  const parsed = qoderUser(read);
  if (typeof parsed === "string") return undefined;
  const nested = [parsed.user, parsed.account, parsed.profile].map(record).find(Boolean) ?? parsed;
  return text(nested.uid) ?? text(nested.user_id) ?? text(nested.userId) ?? text(nested.id);
}

function clineKey(read: (key: string) => Buffer | undefined): string | undefined {
  const parsed = parseJson(read("providers")) as Record<string, unknown> | undefined;
  if (!parsed) return undefined;
  const providers = record(parsed.providers);
  if (!providers) return undefined;
  const last = typeof parsed.lastUsedProvider === "string" ? parsed.lastUsedProvider : Object.keys(providers)[0];
  const p = last ? record(providers[last]) : undefined;
  const auth = record(record(p?.settings)?.auth);
  const metadata = record(auth?.metadata);
  const userInfo = record(metadata?.userInfo);
  return text(userInfo?.email) ?? text(auth?.accountId);
}

function meooKey(read: (key: string) => Buffer | undefined): string | undefined {
  const user = meooUserId(read);
  return user ? `v2:meoo:${user}` : undefined;
}


/**
 * Copilot's account: the GitHub login the gh store names. The Copilot token itself is reissued every
 * few hours, so its fingerprint names a moment, not an account.
 */
function copilotKey(read: (key: string) => Buffer | undefined): string | undefined {
  const login = ghAccountLogin(read);
  return login ? `v2:gh:${login}` : undefined;
}


/** CodeArts' account: the domain and user its OAuth credential carries, next to the rotating AK. */
function codeartsKey(read: (key: string) => Buffer | undefined): string | undefined {
  const account = codeartsAccount(read);
  return account ? `v2:codearts:${account.domainId}:${account.userId}` : undefined;
}


/** CodeArts' own id as a string, stable across a reissued AK. */
function codeartsAccountId(read: (key: string) => Buffer | undefined): string | undefined {
  const account = codeartsAccount(read);
  if (!account) return undefined;
  return `${account.domainId}:${account.userId}`;
}

/** Meoo's own id, stable across a reissued API key. */
function meooAccountId(read: (key: string) => Buffer | undefined): string | undefined {
  return meooUserId(read);
}

/** The region MiniMax Code is signed in to, as its credential store names it. */
function mcodeRegion(read: (key: string) => Buffer | undefined): string | undefined {
  const parsed = parseJson(read("auth")) as Record<string, unknown> | undefined;
  const region = text(parsed?.region);
  if (region) return region;
  const records = record(parsed?.records);
  if (!records) return undefined;
  for (const name of Object.keys(records)) {
    const match = /\.mcode\.oauth\.prod\.([a-z]{2})/.exec(name);
    if (match?.[1]) return match[1];
  }
  return undefined;
}

/**
 * OpenCode's credential per provider: an api key names the account, an oauth entry is named by the
 * refresh token, which survives the access token it hands out.
 */
function opencodeKey(read: (key: string) => Buffer | undefined): string | undefined {
  const parsed = parseJson(read("auth")) as Record<string, unknown> | undefined;
  if (!parsed) return undefined;
  const parts: string[] = [];
  for (const name of Object.keys(parsed).sort()) {
    const entry = record(parsed[name]);
    if (!entry) continue;
    const material = text(entry.refresh) ?? text(entry.key);
    if (!material) continue;
    const fp = createHash("sha256").update(material).digest("hex").slice(0, 12);
    parts.push(`${name}:${fp}`);
  }
  return parts.length ? `v2:opencode:${createHash("sha256").update(parts.join("|")).digest("hex").slice(0, 16)}` : undefined;
}

/**
 * MiniMax Code's own login: the epoch of each session it holds. A token refresh keeps the epoch; a
 * different account logs in with a different one.
 */
function mcodeKey(read: (key: string) => Buffer | undefined): string | undefined {
  const parsed = parseJson(read("auth")) as Record<string, unknown> | undefined;
  const records = record(parsed?.records);
  if (!records) return undefined;
  const epochs = Object.values(records)
    .map((entry) => text(record(entry)?.loginEpoch))
    .filter((value): value is string => Boolean(value))
    .sort();
  if (!epochs.length) return undefined;
  return `v2:mcode:${createHash("sha256").update(epochs.join("|")).digest("hex").slice(0, 16)}`;
}

/**
 * What each engine's own login consists of. Paths mirror the driver that launches the CLI, so a
 * snapshot and the CLI read the same file.
 */
export const SPECS: Record<string, Spec> = {
  antigravityAgent: {
    entries: (env) => [fileEntry("token", join(homeOf(env), ".gemini", "antigravity-cli", "antigravity-oauth-token"))],
    identity: antigravityIdentity,
    key: antigravityIdentity,
  },
  codebuddyAgent: {
    entries: (env) => [fileEntry("auth", join(under(env, "CODEBUDDY_HOME", join(homeOf(env), ".codebuddy")), "auth.info"))],
    identity: codebuddyIdentity,
    key: codebuddyKey,
  },
  codebuddyCnAgent: {
    entries: (env) => [fileEntry("auth", join(under(env, "CODEBUDDY_HOME", join(homeOf(env), ".codebuddy-cn")), "auth.info"))],
    identity: codebuddyIdentity,
    key: codebuddyKey,
  },
  qoderAgent: {
    entries: (env) => [
      fileEntry("user", join(homeOf(env), ".qoder", ".auth", "user")),
      fileEntry("machine_id", join(homeOf(env), ".qoder", ".auth", "machine_id")),
    ],
    identity: qoderIdentity,
    key: qoderKey,
    validate: qoderProblem,
  },
  qoderCnAgent: {
    entries: (env) => [
      fileEntry("user", join(homeOf(env), ".qoder-cn", ".auth", "user")),
      fileEntry("machine_id", join(homeOf(env), ".qoder-cn", ".auth", "machine_id")),
    ],
    identity: qoderIdentity,
    key: qoderKey,
    validate: qoderProblem,
  },
  zcodeAgent: {
    entries: (env) => [fileEntry("credentials", join(under(env, "OMB_ZCODE_HOME", join(homeOf(env), ".zcode")), "v2", "credentials.json"))],
    identity: zcodeIdentity,
    key: zcodeKey,
  },
  mcodeAgent: {
    entries: (env) => [dirEntry("auth", join(under(env, "OMB_MCODE_HOME", homeOf(env)), ".minimax", "auth", "prod"), [
      "cn/mcode-public/auth.json",
      "global/mcode-public/auth.json",
    ])],
    identity: mcodeIdentity,
    key: mcodeKey,
  },
  codeartsAcpAgent: {
    entries: (env) => [
      fileEntry("auth", join(under(env, "OMB_CODEARTS_HOME", homeOf(env)), ".codeartsdoer", "cli-data", "auth.json")),
      fileEntry("env", join(xdgConfig(env), "agenthub-codearts", "codearts-auth.env")),
    ],
    identity: codeartsIdentity,
    key: codeartsKey,
    credentialKey: codeartsCredentialKey,
    accountId: codeartsAccountId,
    tokenEntries: ["env"],
    identityNamesAccount: true,
  },
  copilotAgent: {
    entries: (env) => [
      fileEntry("gh-hosts", join(under(env, "GH_CONFIG_DIR", join(xdgConfig(env), "gh")), "hosts.yml")),
      fileEntry("token", join(xdgConfig(env), "github-copilot", "copilot-token")),
    ],
    identity: ghLogin,
    key: copilotKey,
    credentialKey: copilotCredentialKey,
    accountId: copilotAccountId,
    tokenEntries: ["token"],
    identityNamesAccount: true,
    note: "shared-gh",
  },
  clineAgent: {
    entries: (env) => [fileEntry("providers", clineSettingsPath(env))],
    identity: clineIdentity,
    key: clineKey,
  },
  opencodeGo: {
    entries: (env) => [fileEntry("auth",
      join(xdgData(env), "opencode", "auth.json"),
      join(homeOf(env), ".local", "share", "opencode", "auth.json"))],
    identity: opencodeIdentity,
    key: opencodeKey,
  },
  meooAgent: {
    entries: (env) => [
      fileEntry("credentials", join(under(env, "OMB_MEOO_HOME", homeOf(env)), ".meoo", "credentials.json")),
      fileEntry("env", join(xdgConfig(env), "agenthub-meoo", "meoo-auth.env")),
    ],
    identity: meooIdentity,
    key: meooKey,
    credentialKey: meooCredentialKey,
    accountId: meooAccountId,
    tokenEntries: ["env"],
    identityNamesAccount: true,
  },
  traecodeAgent: {
    entries: (env) => [
      fileEntry("token",
        join(homeOf(env), ".trae-cn", "trae-jwt-token"),
        join(homeOf(env), ".trae", "trae-jwt-token")),
    ],
    identity: (read) => jwtIdentity(read, "token"),
    key: (read) => jwtIdentity(read, "token"),
  },
  mimocodeAgent: {
    entries: (env) => [
      fileEntry("auth",
        join(xdgData(env), "mimocode", "auth.json"),
        join(homeOf(env), ".local", "share", "mimocode", "auth.json")),
    ],
    identity: mimoIdentity,
    key: mimoIdentity,
  },
};

const EXISTING_ACCOUNT_REASON: Record<string, string> = {
  claudeAgent: "Claude accounts are already added as separate accounts in Settings; choose the account for a bot there.",
  codex: "ChatGPT accounts are already added as separate accounts in Settings; choose the account for a bot there.",
};

export function specFor(driver: string): Spec | undefined {
  if (SPECS[driver]) return SPECS[driver];
  if (driver === "codearts") return SPECS.codeartsAcpAgent;
  if (driver === "copilot" || driver === "githubCopilot") return SPECS.copilotAgent;
  if (driver === "mcode" || driver === "minimaxcode") return SPECS.mcodeAgent;
  if (driver === "opencode") return SPECS.opencodeGo;
  if (driver === "trae" || driver === "traecode") return SPECS.traecodeAgent;
  if (driver === "mimo" || driver === "mimocode") return SPECS.mimocodeAgent;
  if (driver === "codebuddy") return SPECS.codebuddyAgent;
  if (driver === "codebuddy-cn" || driver === "codebuddyCn") return SPECS.codebuddyCnAgent;
  if (driver === "qoder") return SPECS.qoderAgent;
  if (driver === "qoder-cn" || driver === "qoderCn") return SPECS.qoderCnAgent;
  if (driver === "zcode") return SPECS.zcodeAgent;
  if (driver === "cline") return SPECS.clineAgent;
  if (driver === "meoo") return SPECS.meooAgent;
  if (driver === "antigravity") return SPECS.antigravityAgent;
  if (SPECS[`${driver}Agent`]) return SPECS[`${driver}Agent`];
  return undefined;
}

function envFor(entry: InstanceConfig): Env {
  return { ...process.env, ...entry.environment };
}

function requireInstance(instanceId: string): void {
  if (!INSTANCE_ID.test(instanceId) || instanceId === "." || instanceId === "..") throw fail(400, "Unknown engine.");
}

function instanceDir(root: string, instanceId: string): string {
  return join(root, instanceId);
}

function ensurePrivateDir(path: string): void {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  chmodSync(path, 0o700);
}

export function sha256(data: Buffer): string {
  return createHash("sha256").update(data).digest("hex");
}

export function fileHash(path: string): string {
  return sha256(readFileSync(path));
}

export function treeHash(path: string, prefix = ""): string {
  const parts: string[] = [];
  for (const name of readdirSync(path).sort()) {
    if (name.endsWith(".lock")) continue;
    const child = join(path, name);
    const stat = lstatSync(child);
    if (stat.isSymbolicLink()) continue;
    if (stat.isDirectory()) parts.push(`${prefix}${name}/`, treeHash(child, `${prefix}${name}/`));
    else if (stat.isFile()) parts.push(`${prefix}${name}:${fileHash(child)}`);
  }
  return sha256(Buffer.from(parts.join("\n")));
}

function livePath(entry: SpecEntry): string | undefined {
  return entry.paths.find((path) => existsSync(path));
}

function fingerprint(entry: SpecEntry): string | null {
  const path = livePath(entry);
  if (!path) return null;
  try {
    return statSync(path).isDirectory() ? treeHash(path) : fileHash(path);
  } catch {
    return null;
  }
}

function readLive(entries: SpecEntry[], key: string): Buffer | undefined {
  const entry = entries.find((candidate) => candidate.key === key);
  if (!entry) return undefined;
  const path = livePath(entry);
  if (!path) return undefined;
  try {
    const stat = statSync(path);
    if (stat.isFile()) return readFileSync(path);
    if (stat.isDirectory()) {
      for (const sub of dirFiles(entry, path)) {
        if (existsSync(sub)) return readFileSync(sub);
      }
    }
    return undefined;
  } catch {
    return undefined;
  }
}

/** The files a folder entry is read from, in the order the engine's own layout names them. */
function dirFiles(entry: SpecEntry, base: string): string[] {
  if (entry.dirPriority) return entry.dirPriority.map((name) => join(base, name));
  return [
    join(base, "cn", "mcode-public", "auth-state.json"),
    join(base, "cn", "mcode-public", "auth.json"),
    join(base, "auth-state.json"),
    join(base, "auth.json"),
  ];
}

function findSnapshotPath(accountDir: string, entry: SpecEntry): string | undefined {
  const direct = join(accountDir, entry.key);
  if (existsSync(direct)) return direct;
  for (const path of entry.paths) {
    const candidate = join(accountDir, basename(path));
    if (existsSync(candidate)) return candidate;
  }
  return undefined;
}

function readSnapshot(entries: SpecEntry[], accountDir: string, key: string): Buffer | undefined {
  const entry = entries.find((candidate) => candidate.key === key);
  if (!entry) return undefined;
  const path = findSnapshotPath(accountDir, entry);
  if (!path) return undefined;
  try {
    const stat = statSync(path);
    if (stat.isFile()) return readFileSync(path);
    if (stat.isDirectory()) {
      for (const sub of dirFiles(entry, path)) {
        if (existsSync(sub)) return readFileSync(sub);
      }
    }
    return undefined;
  } catch {
    return undefined;
  }
}

/**
 * The stable id of a saved account. A snapshot written before the key was recorded still knows its
 * own account, so the key is read from the snapshot's own files; the recorded one is only a cache.
 */
function accountKeyOf(spec: Spec, entries: SpecEntry[], accountDir: string, stored: StoredAccount): AccountKeys {
  // The snapshot's own files decide: a key written by an older build names a moment, not an account.
  return accountKeys(spec, entries, accountDir, stored);
}

function liveKeyOf(spec: Spec, entries: SpecEntry[]): string | undefined {
  return spec.key?.((key) => readLive(entries, key));
}

/**
 * The names the live sign-in can be recognised by: the account's own invariant, and the fingerprint of
 * the credential it holds. The second one is what a snapshot written before the invariant existed can
 * still be matched by, and it is also what separates two accounts that share a nickname.
 */
function liveKeysOf(spec: Spec, entries: SpecEntry[]): AccountKeys {
  const read = (key: string) => readLive(entries, key);
  return { invariant: spec.key?.(read), credential: spec.credentialKey?.(read) };
}

/** The same names for a saved account: what its own snapshot says, plus what the index recorded. */
function accountKeys(spec: Spec, entries: SpecEntry[], accountDir: string, stored: StoredAccount): AccountKeys {
  const read = (key: string) => readSnapshot(entries, accountDir, key);
  const invariant = spec.key?.(read) ?? (stored.key?.startsWith("v2:") ? stored.key : undefined);
  return { invariant, credential: spec.credentialKey?.(read) ?? (stored.key && !stored.key.startsWith("v2:") ? stored.key : undefined) };
}

/** The live sign-in's own account id, as the engine stores it. */
function liveAccountIdOf(spec: Spec, entries: SpecEntry[]): string | undefined {
  return spec.accountId?.((key) => readLive(entries, key));
}

/** A saved account's own id: the recorded one, or one read from its own snapshot. */
function accountAccountIdOf(spec: Spec, entries: SpecEntry[], accountDir: string, stored: StoredAccount): string | undefined {
  if (stored.accountId) return stored.accountId;
  return spec.accountId?.((key) => readSnapshot(entries, accountDir, key));
}

/**
 * The saved account the live sign-in belongs to. The stable key decides; the account's own id is the
 * second line, because it survives a token refresh that changed the key; the identity is the third,
 * and only for engines whose identity names the account rather than a provider list.
 */
function ownerOf(spec: Spec, entries: SpecEntry[], dir: string, accounts: StoredAccount[], liveKeys: AccountKeys, liveIdentity: string | undefined): StoredAccount | undefined {
  return matchAccount(spec, entries, dir, accounts, liveKeys, liveIdentity, liveAccountIdOf(spec, entries));
}

/**
 * The saved account the live sign-in belongs to, in the order the evidence gets stronger.
 *
 * - The stable key decides: it is the account's own id, so it says the same thing before and after a
 *   token refresh.
 * - The account's own id is the second line, for a snapshot whose recorded key was written by an older
 *   build and does not parse.
 * - The identity is the last line, and only when the files that are not credentials are unchanged: a
 *   reissued token changes the credential entry alone, so the account is still the same one. Two
 *   different accounts cannot both match it, because they would have to differ in a file that is not
 *   the credential.
 */
function matchAccount(
  spec: Spec,
  entries: SpecEntry[],
  dir: string,
  accounts: StoredAccount[],
  liveKeys: AccountKeys,
  liveIdentity: string | undefined,
  liveAccountId: string | undefined,
): StoredAccount | undefined {
  if (liveKeys.invariant) {
    const byKey = accounts.find((account) => accountKeyOf(spec, entries, join(dir, account.id), account).invariant === liveKeys.invariant);
    if (byKey) return byKey;
  }
  if (liveAccountId) {
    const byAccountId = accounts.find((account) => accountAccountIdOf(spec, entries, join(dir, account.id), account) === liveAccountId);
    if (byAccountId) return byAccountId;
  }
  if (liveKeys.credential) {
    const byCredential = accounts.find((account) => {
      const keys = accountKeyOf(spec, entries, join(dir, account.id), account);
      return !keys.invariant && keys.credential === liveKeys.credential;
    });
    if (byCredential) return byCredential;
  }
  if (liveIdentity === undefined) return undefined;
  const liveHashes = hashesOf(entries);
  const sameIdentity = accounts.filter((account) => account.identity === liveIdentity);
  if (!sameIdentity.length) return undefined;
  const byUnchangedFiles = sameIdentity.find((account) => onlyCredentialChanged(spec, account, liveHashes));
  if (byUnchangedFiles) return byUnchangedFiles;
  return sameIdentity.length === 1 && spec.identityNamesAccount ? sameIdentity[0] : undefined;
}

/** Every file that is not a credential is the one it was: the credential alone was reissued. */
function onlyCredentialChanged(spec: Spec, account: StoredAccount, liveHashes: Record<string, string | null>): boolean {
  const tokens = new Set(spec.tokenEntries ?? []);
  return Object.keys(account.hashes).every((key) => tokens.has(key)
    ? true
    : (account.hashes[key] ?? null) === (liveHashes[key] ?? null));
}

function hashesOf(entries: SpecEntry[]): Record<string, string | null> {
  return Object.fromEntries(entries.map((entry) => [entry.key, fingerprint(entry)]));
}

/** The live sign-in is no longer the saved one: another account, or — with no id to compare — other files. */
function driftedFrom(
  spec: Spec,
  entries: SpecEntry[],
  accountDir: string,
  active: StoredAccount | undefined,
  liveKeys: AccountKeys,
  liveIdentity: string | undefined,
): boolean {
  if (!active) return false;
  const activeKey = accountKeyOf(spec, entries, accountDir, active);
  if (activeKey.invariant && liveKeys.invariant) return activeKey.invariant !== liveKeys.invariant;
  if (activeKey.credential && liveKeys.credential) return activeKey.credential !== liveKeys.credential;
  if (active.identity) return active.identity !== liveIdentity;
  return entries.some((entry) => (active.hashes[entry.key] ?? null) !== fingerprint(entry));
}

function copyFilePrivate(from: string, to: string): void {
  const size = statSync(from).size;
  if (size > MAX_FILE_BYTES) throw fail(400, "This engine's sign-in file is too large to copy.");
  const data = readFileSync(from);
  writeFileAtomic(to, data, { mode: 0o600 });
  chmodSync(to, 0o600);
}

function copyTreePrivate(from: string, to: string, budget = { bytes: 0, files: 0 }): void {
  rmSync(to, { recursive: true, force: true });
  ensurePrivateDir(to);
  for (const name of readdirSync(from)) {
    if (name.endsWith(".lock")) continue;
    const source = join(from, name);
    const destination = join(to, name);
    const stat = lstatSync(source);
    if (stat.isSymbolicLink()) continue;
    if (stat.isDirectory()) {
      mkdirSync(destination, { mode: 0o700 });
      chmodSync(destination, 0o700);
      copyTreePrivate(source, destination, budget);
      continue;
    }
    if (!stat.isFile()) continue;
    budget.files += 1;
    budget.bytes += stat.size;
    if (budget.files > MAX_TREE_FILES || budget.bytes > MAX_TREE_BYTES) {
      throw fail(400, "This engine's sign-in folder is too large to copy.");
    }
    copyFilePrivate(source, destination);
  }
}

function writeSnapshot(entries: SpecEntry[], accountDir: string): Record<string, string | null> {
  ensurePrivateDir(accountDir);
  const hashes: Record<string, string | null> = {};
  for (const entry of entries) {
    hashes[entry.key] = fingerprint(entry);
    const destination = join(accountDir, entry.key);
    const source = livePath(entry);
    if (!source) {
      rmSync(destination, { recursive: true, force: true });
      continue;
    }
    if (statSync(source).isDirectory()) copyTreePrivate(source, destination);
    else copyFilePrivate(source, destination);
  }
  return hashes;
}

function restoreSnapshot(entries: SpecEntry[], accountDir: string): void {
  for (const entry of entries) {
    const saved = findSnapshotPath(accountDir, entry);
    if (!saved) {
      for (const path of entry.paths) rmSync(path, { recursive: true, force: true });
      continue;
    }
    const destination = entry.paths[0]!;
    mkdirSync(dirname(destination), { recursive: true, mode: 0o700 });
    if (statSync(saved).isDirectory()) copyTreePrivate(saved, destination);
    else copyFilePrivate(saved, destination);
    // The CLI may read any of these paths; a copy left behind would name the account just switched away from.
    // The xdg path and its HOME fallback resolve to one file when XDG_DATA_HOME is unset — and that one is the restore itself.
    for (const stale of entry.paths.slice(1)) {
      if (stale === destination) continue;
      rmSync(stale, { recursive: true, force: true });
    }
  }
}

function readIndex(dir: string): AccountIndex {
  const empty: AccountIndex = { version: 1, activeId: null, accounts: [] };
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(join(dir, "index.json"), "utf8"));
  } catch {
    return empty;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return empty;
  const record = parsed as Record<string, unknown>;
  const accounts = Array.isArray(record.accounts) ? record.accounts.flatMap((raw): StoredAccount[] => {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return [];
    const entry = raw as Record<string, unknown>;
    if (typeof entry.id !== "string" || !ACCOUNT_ID.test(entry.id)) return [];
    if (typeof entry.label !== "string" || !entry.label.trim()) return [];
    if (typeof entry.createdAt !== "number") return [];
    const hashes: Record<string, string | null> = {};
    if (entry.hashes && typeof entry.hashes === "object" && !Array.isArray(entry.hashes)) {
      for (const [key, value] of Object.entries(entry.hashes as Record<string, unknown>)) {
        if (typeof key === "string" && key.length <= 40) hashes[key] = typeof value === "string" ? value : null;
      }
    }
    return [{ id: entry.id, label: entry.label.slice(0, SERVICE_ACCOUNT_LABEL_MAX), ...(typeof entry.identity === "string" ? { identity: entry.identity.slice(0, 120) } : {}), ...(typeof entry.key === "string" ? { key: entry.key.slice(0, 120) } : {}), ...(typeof entry.accountId === "string" ? { accountId: entry.accountId.slice(0, 120) } : {}), createdAt: entry.createdAt, hashes }];
  }) : [];
  const activeId = typeof record.activeId === "string" ? record.activeId : null;
  return {
    version: 1,
    activeId: activeId && accounts.some((account) => account.id === activeId) ? activeId : null,
    accounts,
  };
}

function writeIndex(dir: string, index: AccountIndex): void {
  ensurePrivateDir(dir);
  const path = join(dir, "index.json");
  writeFileAtomic(path, JSON.stringify(index), { mode: 0o600 });
  chmodSync(path, 0o600);
}

function cleanLabel(value: string | undefined): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim().replace(/\p{Cc}/gu, "");
  if (!trimmed) return undefined;
  return trimmed.slice(0, SERVICE_ACCOUNT_LABEL_MAX);
}

interface Context {
  spec: Spec;
  entries: SpecEntry[];
  dir: string;
}

function context(instanceId: string, entry: InstanceConfig, root: string): Context | ServiceAccountsView {
  const spec = specFor(entry.driver);
  if (!spec) {
    return {
      supported: false,
      reason: EXISTING_ACCOUNT_REASON[entry.driver] ?? "This engine has no CLI sign-in this server can copy.",
      accounts: [], activeId: null, drifted: false,
    };
  }
  requireInstance(instanceId);
  return { spec, entries: spec.entries(envFor(entry)), dir: instanceDir(root, instanceId) };
}

function isUnsupported(value: Context | ServiceAccountsView): value is ServiceAccountsView {
  return !("entries" in value);
}

export function serviceAccountsView(instanceId: string, entry: InstanceConfig, root = SERVICE_ACCOUNTS_DIR): ServiceAccountsView {
  const ctx = context(instanceId, entry, root);
  if (isUnsupported(ctx)) return ctx;
  const index = readIndex(ctx.dir);
  const active = index.accounts.find((account) => account.id === index.activeId);
  const liveIdentity = ctx.spec.identity?.((key) => readLive(ctx.entries, key));
  const liveKeys = liveKeysOf(ctx.spec, ctx.entries);
  const drifted = driftedFrom(ctx.spec, ctx.entries, active ? join(ctx.dir, active.id) : ctx.dir, active, liveKeys, liveIdentity);
  return {
    supported: true,
    ...(ctx.spec.note ? { note: ctx.spec.note } : {}),
    accounts: index.accounts.map(({ id, label, identity, createdAt }) => ({ id, label, ...(identity ? { identity } : {}), createdAt })),
    activeId: index.activeId,
    drifted,
    ...(liveIdentity ? { liveIdentity } : {}),
  };
}

/** Saves what the CLI is signed in with now as a named account, and makes it the active one. */
export function saveServiceAccount(instanceId: string, entry: InstanceConfig, rawLabel: string | undefined, root = SERVICE_ACCOUNTS_DIR): ServiceAccountsView {
  const ctx = context(instanceId, entry, root);
  if (isUnsupported(ctx)) throw fail(400, ctx.reason ?? "This engine cannot switch accounts here.");
  const index = readIndex(ctx.dir);
  const hashes = hashesOf(ctx.entries);
  if (Object.values(hashes).every((hash) => hash === null)) {
    throw fail(400, "Sign in to this engine first, then save the account.");
  }
  const problem = ctx.spec.validate?.((key) => readLive(ctx.entries, key));
  if (problem) {
    throw fail(400, `This sign-in cannot be saved: ${PROBLEM_TEXT[problem]}. Sign in again, then save it.`);
  }
  const identity = ctx.spec.identity?.((key) => readLive(ctx.entries, key));
  const key = liveKeyOf(ctx.spec, ctx.entries);
  const keys = liveKeysOf(ctx.spec, ctx.entries);
  const accountId = liveAccountIdOf(ctx.spec, ctx.entries);
  const label = cleanLabel(rawLabel) ?? identity ?? `Account ${index.accounts.length + 1}`;
  const unchanged = (account: StoredAccount) =>
    ctx.entries.every((item) => (account.hashes[item.key] ?? null) === (hashes[item.key] ?? null));
  // A refreshed token is the same account: the key and the account's own id keep one entry instead of
  // a copy per refresh.
  const same = matchAccount(ctx.spec, ctx.entries, ctx.dir, index.accounts, keys, identity, accountId)
    ?? index.accounts.find(unchanged);
  if (same) {
    same.label = label;
    if (identity) same.identity = identity;
    if (key) same.key = key;
    if (accountId) same.accountId = accountId;
    if (!unchanged(same)) {
      writeSnapshot(ctx.entries, join(ctx.dir, same.id));
      same.hashes = hashes;
    }
    index.activeId = same.id;
    writeIndex(ctx.dir, index);
    return serviceAccountsView(instanceId, entry, root);
  }
  const id = randomUUID();
  writeSnapshot(ctx.entries, join(ctx.dir, id));
  index.accounts.push({ id, label, ...(identity ? { identity } : {}), ...(key ? { key } : {}), ...(accountId ? { accountId } : {}), createdAt: Date.now(), hashes });
  index.activeId = id;
  writeIndex(ctx.dir, index);
  return serviceAccountsView(instanceId, entry, root);
}

/**
 * Writes the saved account's credentials over the CLI's own, keeping whatever is live now: the
 * active snapshot is refreshed, or — when the live sign-in is another account — saved as its own
 * entry first, so switching never loses a sign-in. A saved account that cannot be read is refused
 * instead of restored.
 */
export function switchServiceAccount(instanceId: string, entry: InstanceConfig, accountId: string, root = SERVICE_ACCOUNTS_DIR): ServiceAccountsView {
  const ctx = context(instanceId, entry, root);
  if (isUnsupported(ctx)) throw fail(400, ctx.reason ?? "This engine cannot switch accounts here.");
  if (!ACCOUNT_ID.test(accountId)) throw fail(404, "That saved account is gone.");
  const index = readIndex(ctx.dir);
  const target = index.accounts.find((account) => account.id === accountId);
  if (!target) throw fail(404, "That saved account is gone.");

  const hashes = hashesOf(ctx.entries);
  const identity = ctx.spec.identity?.((key) => readLive(ctx.entries, key));
  const key = liveKeyOf(ctx.spec, ctx.entries);
  const keys = liveKeysOf(ctx.spec, ctx.entries);
  const active = index.accounts.find((account) => account.id === index.activeId);
  const drifted = driftedFrom(ctx.spec, ctx.entries, active ? join(ctx.dir, active.id) : ctx.dir, active, keys, identity);
  // Asking for the account already in use is a no-op only while the live sign-in still is that account.
  if (index.activeId === accountId && !drifted) return serviceAccountsView(instanceId, entry, root);

  const broken = ctx.spec.validate?.((key) => readSnapshot(ctx.entries, join(ctx.dir, target.id), key));
  if (broken) {
    throw fail(409, `That saved account cannot be used: ${PROBLEM_TEXT[broken]}. Sign in again and save it as a new account.`);
  }

  const hasLive = Object.values(hashes).some((hash) => hash !== null);
  // A live sign-in that cannot be read is not worth keeping; writing it over the active snapshot would lose both.
  const liveBroken = ctx.spec.validate?.((key) => readLive(ctx.entries, key)) !== undefined;
  if (hasLive && !liveBroken) {
    const owner = ownerOf(ctx.spec, ctx.entries, ctx.dir, index.accounts, keys, identity)
      ?? (active && (!active.identity || !identity) ? active : undefined);
    if (owner) {
      writeSnapshot(ctx.entries, join(ctx.dir, owner.id));
      owner.hashes = hashes;
      if (identity) owner.identity = identity;
      if (key) owner.key = key;
      if (liveAccountIdOf(ctx.spec, ctx.entries)) owner.accountId = liveAccountIdOf(ctx.spec, ctx.entries);
    } else {
      const id = randomUUID();
      writeSnapshot(ctx.entries, join(ctx.dir, id));
      index.accounts.push({
        id, label: identity ?? "Signed in outside OpenMausBot", ...(identity ? { identity } : {}), ...(key ? { key } : {}),
        ...(liveAccountIdOf(ctx.spec, ctx.entries) ? { accountId: liveAccountIdOf(ctx.spec, ctx.entries) } : {}),
        createdAt: Date.now(), hashes,
      });
    }
  }
  restoreSnapshot(ctx.entries, join(ctx.dir, target.id));
  index.activeId = target.id;
  writeIndex(ctx.dir, index);
  return serviceAccountsView(instanceId, entry, root);
}

export function removeServiceAccount(instanceId: string, entry: InstanceConfig, accountId: string, root = SERVICE_ACCOUNTS_DIR): ServiceAccountsView {
  const ctx = context(instanceId, entry, root);
  if (isUnsupported(ctx)) throw fail(400, ctx.reason ?? "This engine cannot switch accounts here.");
  if (!ACCOUNT_ID.test(accountId)) throw fail(404, "That saved account is gone.");
  const index = readIndex(ctx.dir);
  if (!index.accounts.some((account) => account.id === accountId)) throw fail(404, "That saved account is gone.");
  if (index.activeId === accountId) throw fail(409, "Switch to another account before removing this one.");
  rmSync(join(ctx.dir, accountId), { recursive: true, force: true });
  index.accounts = index.accounts.filter((account) => account.id !== accountId);
  writeIndex(ctx.dir, index);
  return serviceAccountsView(instanceId, entry, root);
}
