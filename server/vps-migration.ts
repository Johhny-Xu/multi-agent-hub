import { createHash } from "node:crypto";
import { readFileSync, writeFileSync, renameSync, mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";

import type { AppConfig } from "./config.ts";
import { isValidSshAlias } from "./config.ts";
import type { BotRecord } from "./store.ts";
import { sshVpsInstance, type VpsConfig, type VpsInstance } from "../shared/vps.ts";

export interface VpsMigrationPlan {
  config: VpsConfig;
  botPatches: Array<{ id: string; vpsInstanceId: string }>;
  legacyAliases: Record<string, string>;
}

export interface VpsMigrationDeps {
  dataDir: string;
  writeConfig(config: VpsConfig): void | Promise<void>;
  writeBot(id: string, patch: { vpsInstanceId: string; vpsAlias?: undefined }): void | Promise<void>;
}

const PROGRESS_FILE = "vps-migration-progress.json";
const BACKUP_FILE = "vps-migration-backup.json";

function legacyInstanceId(alias: string, taken: ReadonlySet<string>): string {
  let length = 12;
  for (;;) {
    const id = `legacy-${createHash("sha256").update(alias).digest("hex").slice(0, length)}`;
    if (!taken.has(id)) return id;
    length += 4;
    if (length > 60) throw new Error("could not allocate a stable VPS instance id");
  }
}

/** Binds only bots that had a usable pre-v2 target; a default instance never pulls a bot that had none. */
export function planVpsMigration(cfg: Readonly<AppConfig>, bots: readonly BotRecord[]): VpsMigrationPlan {
  const stored = cfg.vps;
  const existing: VpsInstance[] = stored?.version === 2 && Array.isArray(stored.instances) ? [...stored.instances] : [];
  const byAlias = new Map<string, string>();
  for (const instance of existing) {
    if (instance.kind === "ssh") byAlias.set(instance.sshAlias, instance.id);
  }
  const taken = new Set(existing.map((instance) => instance.id));
  const order: string[] = [];
  const addAlias = (alias: string | undefined) => {
    if (!isValidSshAlias(alias) || byAlias.has(alias) || order.includes(alias)) return;
    order.push(alias);
  };
  addAlias(stored?.sshAlias);
  for (const bot of bots) addAlias(bot.vpsAlias);

  const added: VpsInstance[] = [];
  for (const alias of order) {
    const id = legacyInstanceId(alias, taken);
    taken.add(id);
    byAlias.set(alias, id);
    added.push(sshVpsInstance(alias, id));
  }
  const config: VpsConfig = {
    version: 2,
    instances: [...existing, ...added],
  };
  const legacyDefault = isValidSshAlias(stored?.sshAlias) ? byAlias.get(stored.sshAlias) : undefined;
  const defaultInstanceId = legacyDefault
    ?? (stored?.version === 2 ? stored.defaultInstanceId : undefined);
  if (defaultInstanceId && config.instances.some((instance) => instance.id === defaultInstanceId)) {
    config.defaultInstanceId = defaultInstanceId;
  }

  const legacyAliases: Record<string, string> = {};
  const botPatches: Array<{ id: string; vpsInstanceId: string }> = [];
  // Once the list is written, the global alias is gone; a legacy- default still marks where unbound bots used to land.
  const migratedDefault = stored?.version === 2 && stored.defaultInstanceId?.startsWith("legacy-")
    ? existing.find((instance) => instance.id === stored.defaultInstanceId && instance.kind === "ssh")
    : undefined;
  const fallbackAlias = isValidSshAlias(stored?.sshAlias)
    ? stored.sshAlias
    : migratedDefault?.kind === "ssh" ? migratedDefault.sshAlias : undefined;
  for (const bot of bots) {
    if (bot.vpsInstanceId) continue;
    const alias = isValidSshAlias(bot.vpsAlias) ? bot.vpsAlias : fallbackAlias;
    if (!alias) continue;
    const instanceId = byAlias.get(alias);
    if (!instanceId) continue;
    legacyAliases[bot.id] = alias;
    botPatches.push({ id: bot.id, vpsInstanceId: instanceId });
  }
  return { config, botPatches, legacyAliases };
}

function writeJsonAtomic(path: string, value: unknown): void {
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, JSON.stringify(value, null, 2), { mode: 0o600 });
  renameSync(temporary, path);
}

function readProgress(dataDir: string): { stage: string } | null {
  try {
    const raw = JSON.parse(readFileSync(join(dataDir, PROGRESS_FILE), "utf8")) as { stage?: unknown };
    return typeof raw.stage === "string" ? { stage: raw.stage } : null;
  } catch {
    return null;
  }
}

/** Idempotent in three steps: back up, write the list, then pin each bot and drop its legacy alias. */
export async function applyVpsMigration(plan: VpsMigrationPlan, deps: VpsMigrationDeps): Promise<void> {
  mkdirSync(deps.dataDir, { recursive: true });
  const progress = readProgress(deps.dataDir);
  const backupPath = join(deps.dataDir, BACKUP_FILE);
  if (!existsSync(backupPath) && progress === null) {
    writeJsonAtomic(backupPath, {
      at: new Date().toISOString(),
      version: 2,
      config: plan.config,
      legacyAliases: plan.legacyAliases,
    });
  }

  if (progress?.stage !== "bots") {
    writeJsonAtomic(join(deps.dataDir, PROGRESS_FILE), { stage: "config", at: new Date().toISOString() });
    await deps.writeConfig(plan.config);
    writeJsonAtomic(join(deps.dataDir, PROGRESS_FILE), { stage: "bots", at: new Date().toISOString() });
  }

  for (const patch of plan.botPatches) {
    await deps.writeBot(patch.id, { vpsInstanceId: patch.vpsInstanceId, vpsAlias: undefined });
  }

  await deps.writeConfig(plan.config);
  try {
    writeJsonAtomic(join(deps.dataDir, PROGRESS_FILE), { stage: "done", at: new Date().toISOString() });
  } catch {
  }
}
