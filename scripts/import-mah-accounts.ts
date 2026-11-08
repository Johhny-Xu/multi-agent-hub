import { createHash, randomUUID } from "node:crypto";
import {
  chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { writeFileAtomic } from "../server/atomic.ts";

export interface AccountImportResult {
  worker: string;
  instanceId: string;
  sourceAccounts: number;
  existingAccounts: number;
  addedAccounts: number;
  activeAccount: string | null;
  accounts: Array<{
    id: string;
    label: string;
    identity?: string;
    status: "existing" | "added";
  }>;
}

export interface ImportOptions {
  sourceDir?: string;
  targetDir?: string;
  dryRun?: boolean;
}

interface WorkerSpec {
  instanceId: string;
  driver: string;
  /** Maps mah filename in the profile directory to OpenMausBot snapshot key. */
  files: Record<string, string>;
  isDirTree?: boolean;
}

const DEFAULT_SOURCE = join(homedir(), ".agenthub", "accounts");
const DEFAULT_TARGET = join(homedir(), ".openmausbot", "service-accounts");

export const WORKER_SPECS: Record<string, WorkerSpec> = {
  qoder: {
    instanceId: "qoder",
    driver: "qoderAgent",
    files: { user: "user", machine_id: "machine_id" },
  },
  "qoder-cn": {
    instanceId: "qoderCn",
    driver: "qoderCnAgent",
    files: { user: "user", machine_id: "machine_id" },
  },
  codebuddy: {
    instanceId: "codebuddy",
    driver: "codebuddyAgent",
    files: { "auth.info": "auth" },
  },
  "codebuddy-cn": {
    instanceId: "codebuddyCn",
    driver: "codebuddyCnAgent",
    files: { "auth.info": "auth" },
  },
  zcode: {
    instanceId: "zcode",
    driver: "zcodeAgent",
    files: { "credentials.json": "credentials" },
  },
  opencode: {
    instanceId: "opencodeGo",
    driver: "opencodeGo",
    files: { "auth.json": "auth" },
  },
  cline: {
    instanceId: "cline",
    driver: "clineAgent",
    files: { "providers.json": "providers", "secrets.json": "secrets" },
  },
  meoo: {
    instanceId: "meoo",
    driver: "meooAgent",
    files: { "meoo-auth.env": "env", "credentials.json": "credentials" },
  },
  minimaxcode: {
    instanceId: "mcode",
    driver: "mcodeAgent",
    files: { "auth.json": "auth", "auth-state.json": "auth" },
    isDirTree: true,
  },
  codearts: {
    instanceId: "codearts",
    driver: "codeartsAcpAgent",
    files: { "codearts-auth.env": "env", "auth.json": "auth" },
  },
  "github-copilot": {
    instanceId: "githubCopilot",
    driver: "copilotAgent",
    files: { "copilot-token": "token", "hosts.yml": "gh-hosts" },
  },
  antigravity: {
    instanceId: "antigravity",
    driver: "antigravityAgent",
    files: { "antigravity-oauth-token": "token" },
  },
  traecode: {
    instanceId: "traecode",
    driver: "traecodeAgent",
    files: { "trae-jwt-token": "token" },
  },
  mimocode: {
    instanceId: "mimocode",
    driver: "mimocodeAgent",
    files: { "auth.json": "auth" },
  },
};

function sha256(data: Buffer): string {
  return createHash("sha256").update(data).digest("hex");
}

function fileHash(path: string): string {
  return sha256(readFileSync(path));
}

function copyFilePrivate(from: string, to: string): void {
  mkdirSync(dirname(to), { recursive: true, mode: 0o700 });
  const data = readFileSync(from);
  writeFileAtomic(to, data, { mode: 0o600 });
  chmodSync(to, 0o600);
}

interface StoredAccount {
  id: string;
  label: string;
  identity?: string;
  createdAt: number;
  hashes: Record<string, string | null>;
}

interface AccountIndex {
  version: 1;
  activeId: string | null;
  accounts: StoredAccount[];
}

function readIndex(dir: string): AccountIndex {
  const empty: AccountIndex = { version: 1, activeId: null, accounts: [] };
  const path = join(dir, "index.json");
  if (!existsSync(path)) return empty;
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
    const accounts = Array.isArray(parsed.accounts) ? (parsed.accounts as StoredAccount[]) : [];
    const activeId = typeof parsed.activeId === "string" ? parsed.activeId : null;
    return { version: 1, activeId, accounts };
  } catch {
    return empty;
  }
}

function writeIndex(dir: string, index: AccountIndex): void {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);
  const path = join(dir, "index.json");
  writeFileAtomic(path, JSON.stringify(index, null, 2), { mode: 0o600 });
  chmodSync(path, 0o600);
}

/** mah keeps some API-key accounts (meoo) with the key itself as identity; never carry a secret
 * into an identity that OpenMausBot stores in plain view and this script prints. */
export function safeIdentity(identity: string): string {
  if (/(?:^|_)(?:ak|sk)_|^sk-|^[A-Za-z0-9_]{32,}$/.test(identity)) {
    return `key:${createHash("sha256").update(identity).digest("hex").slice(0, 12)}`;
  }
  return identity;
}

function parseMeta(profileDir: string): { display?: string; identity?: string; savedAt?: string } {
  const metaPath = join(profileDir, "meta.json");
  if (!existsSync(metaPath)) return {};
  try {
    const raw = JSON.parse(readFileSync(metaPath, "utf8").replace(/^\uFEFF/, "")) as Record<string, unknown>;
    const display = typeof raw.display === "string" ? raw.display.trim() : undefined;
    const identity = typeof raw.identity === "string" ? safeIdentity(raw.identity.trim()) : undefined;
    const savedAt = typeof raw.savedAt === "string" ? raw.savedAt : undefined;
    return { display, identity, savedAt };
  } catch {
    return {};
  }
}

export function importMahAccounts(options: ImportOptions = {}): AccountImportResult[] {
  const sourceDir = resolve(options.sourceDir ?? process.env.MAH_ACCOUNTS_DIR ?? DEFAULT_SOURCE);
  const targetDir = resolve(options.targetDir ?? process.env.OMB_SERVICE_ACCOUNTS_DIR ?? DEFAULT_TARGET);
  const dryRun = options.dryRun ?? true;

  if (!existsSync(sourceDir)) return [];

  const results: AccountImportResult[] = [];
  const entries = readdirSync(sourceDir).sort();

  for (const worker of entries) {
    const spec = WORKER_SPECS[worker];
    if (!spec) continue;

    const workerDir = join(sourceDir, worker);
    if (!statSync(workerDir).isDirectory()) continue;

    const items = readdirSync(workerDir).sort();
    const profiles = items.filter((item) => !item.startsWith(".") && statSync(join(workerDir, item)).isDirectory());
    if (profiles.length === 0) continue;

    const activeProfile = items.includes(".active")
      ? readFileSync(join(workerDir, ".active"), "utf8").trim()
      : null;

    const instanceTargetDir = join(targetDir, spec.instanceId);
    const index = readIndex(instanceTargetDir);
    const initialExistingCount = index.accounts.length;
    let addedCount = 0;
    const resultAccounts: AccountImportResult["accounts"] = [];
    let matchedActiveId: string | null = index.activeId;

    for (const profile of profiles) {
      const profileDir = join(workerDir, profile);
      const meta = parseMeta(profileDir);

      const hashes: Record<string, string | null> = {};
      if (spec.isDirTree) {
        // MiniMax Code uses auth/cn/mcode-public layout
        const treeParts: string[] = [];
        for (const file of ["auth-state.json", "auth.json"]) {
          const src = join(profileDir, file);
          if (existsSync(src)) {
            treeParts.push(`cn/mcode-public/${file}:${fileHash(src)}`);
          }
        }
        hashes.auth = treeParts.length > 0 ? sha256(Buffer.from(treeParts.join("\n"))) : null;
      } else {
        for (const [srcFile, specKey] of Object.entries(spec.files)) {
          const src = join(profileDir, srcFile);
          hashes[specKey] = existsSync(src) ? fileHash(src) : null;
        }
      }

      // Check for an existing matching account
      const matched = index.accounts.find((acc) => {
        if (meta.identity && acc.identity === meta.identity) return true;
        const keys = Object.keys(hashes);
        if (keys.length > 0 && keys.every((k) => hashes[k] !== null && acc.hashes?.[k] === hashes[k])) return true;
        if (meta.display && acc.label === meta.display) return true;
        return false;
      });

      let accountId: string;
      if (matched) {
        accountId = matched.id;
        resultAccounts.push({
          id: accountId,
          label: matched.label,
          identity: matched.identity,
          status: "existing",
        });
      } else {
        accountId = randomUUID();
        const label = meta.display || profile.replace(/[-_]+/g, " ");
        const identity = meta.identity || label;
        const createdAt = meta.savedAt ? Date.parse(meta.savedAt) || Date.now() : Date.now();

        if (!dryRun) {
          const accountDir = join(instanceTargetDir, accountId);
          mkdirSync(accountDir, { recursive: true, mode: 0o700 });
          chmodSync(accountDir, 0o700);

          if (spec.isDirTree) {
            const destSubDir = join(accountDir, "auth", "cn", "mcode-public");
            mkdirSync(destSubDir, { recursive: true, mode: 0o700 });
            for (const file of ["auth-state.json", "auth.json"]) {
              const src = join(profileDir, file);
              if (existsSync(src)) copyFilePrivate(src, join(destSubDir, file));
            }
          } else {
            for (const [srcFile, specKey] of Object.entries(spec.files)) {
              const src = join(profileDir, srcFile);
              if (existsSync(src)) copyFilePrivate(src, join(accountDir, specKey));
            }
          }

          index.accounts.push({
            id: accountId,
            label,
            identity,
            createdAt,
            hashes,
          });
        }

        addedCount += 1;
        resultAccounts.push({
          id: accountId,
          label,
          identity,
          status: "added",
        });
      }

      if (profile === activeProfile && !matchedActiveId) {
        matchedActiveId = accountId;
      }
    }

    if (!dryRun && addedCount > 0) {
      if (!index.activeId && matchedActiveId) {
        index.activeId = matchedActiveId;
      }
      writeIndex(instanceTargetDir, index);
    }

    results.push({
      worker,
      instanceId: spec.instanceId,
      sourceAccounts: profiles.length,
      existingAccounts: initialExistingCount,
      addedAccounts: addedCount,
      activeAccount: matchedActiveId,
      accounts: resultAccounts,
    });
  }

  return results;
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(new URL(import.meta.url).pathname)) {
  const isApply = process.argv.includes("--apply") || process.argv.includes("--execute");
  const plan = importMahAccounts({ dryRun: !isApply });
  console.log(`MAH account import (${isApply ? "EXECUTE" : "DRY RUN"}):`);
  let totalSource = 0;
  let totalAdded = 0;
  for (const row of plan) {
    totalSource += row.sourceAccounts;
    totalAdded += row.addedAccounts;
    console.log(`- ${row.worker} -> ${row.instanceId}: ${row.sourceAccounts} source accounts, ${row.existingAccounts} existing, ${row.addedAccounts} to add`);
    for (const acc of row.accounts) {
      const activeMark = acc.id === row.activeAccount ? " [active]" : "";
      console.log(`    • ${acc.label} (${acc.identity ?? "no identity"}) [${acc.status}]${activeMark}`);
    }
  }
  console.log(`\nTotal: ${totalSource} source accounts across ${plan.length} CLIs. New accounts to import: ${totalAdded}.`);
}
