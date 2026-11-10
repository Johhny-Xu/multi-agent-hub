// The vendor copy of Google's Elephant-Goldfish Model (EGM) skills, offered to every bot through the
// imported-skills path as built-in skills: on unless the person turns them off for the whole workspace or
// for one bot. The SKILL.md files stay in the read-only vendor copy — a turn is told where the agents/,
// resources/ and docs/ folders its steps reference live, since those sit at the vendor root, not beside a
// skill folder. Four of the seven skills spawn fresh subagents to review with no earlier conversation, so
// a bot whose runner has no subagent tool skips those rather than getting stuck mid-review.
import { createHash } from "node:crypto";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { egmSkillsEnabled, type AppConfig } from "./config.ts";
import { isSkillName } from "../shared/skill-md.ts";

/** The vendor copy's root; OMB_EGM_VENDOR_DIR moves it for tests. */
function vendorRoot(): string {
  return process.env.OMB_EGM_VENDOR_DIR || fileURLToPath(new URL("../vendor/elephant-goldfish-model", import.meta.url));
}

const SKILLS_DIR = "skills";

/** The agent runners that can spawn a fresh subagent with no earlier conversation; every other driver is
 * treated as without one, including any kind this table does not know. */
const SUBAGENT_DRIVERS = new Set(["claudeAgent", "codex", "antigravityAgent", "opencodeGo"]);

export function driverSpawnsSubagents(driverKind: string | undefined): boolean {
  return driverKind !== undefined && SUBAGENT_DRIVERS.has(driverKind);
}

/** The vendor's SKILL.md files fold long descriptions over several lines (`description: >-`), which the
 * shared single-line frontmatter reader cannot; this reads just the keys the listings show. */
function readEgmFrontmatter(raw: string): { name: string; description: string; license?: string } | null {
  const match = raw.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!match) return null;
  let name = "";
  let description = "";
  let license: string | undefined;
  const lines = match[1]!.split(/\r?\n/);
  for (let at = 0; at < lines.length; at += 1) {
    const kv = lines[at]!.match(/^([A-Za-z][\w-]*):\s*(.*)$/);
    if (!kv) continue;
    const key = kv[1]!.toLowerCase();
    if (key !== "name" && key !== "description" && key !== "license") continue;
    let value = kv[2]!.trim().replace(/^["']|["']$/g, "");
    if (/^[>|][+-]?$/.test(value)) {
      const folded: string[] = [];
      while (at + 1 < lines.length && /^\s/.test(lines[at + 1]!)) folded.push(lines[++at]!.trim());
      value = folded.join(" ");
    }
    if (key === "name") name = value;
    else if (key === "description") description = value;
    else license = value;
  }
  return name && description ? { name, description, license } : null;
}

export interface EgmSkill {
  name: string;
  description: string;
  license?: string;
  /** The skill's own folder in the vendor copy, which a task folder's skill links point at. */
  folder: string;
  file: string;
  /** The vendor root: where the agents/, resources/ and docs/ folders its steps reference live. */
  root: string;
  requiresSubagents: boolean;
}

/** The EGM skills in the vendor copy, read fresh each call, so a missing or changed vendor copy only
 * changes what bots are offered, never an error. `driverKind` is not used here; it gates the turn views. */
export function egmSkills(options: { root?: string } = {}): EgmSkill[] {
  const root = options.root ?? vendorRoot();
  let names: string[];
  try {
    names = readdirSync(join(root, SKILLS_DIR)).filter((name) => name.startsWith("egm-")).sort();
  } catch {
    return [];
  }
  const skills: EgmSkill[] = [];
  for (const name of names) {
    if (!isSkillName(name)) continue;
    const folder = join(root, SKILLS_DIR, name);
    let raw: string;
    try {
      if (!statSync(join(folder, "SKILL.md")).isFile()) continue;
      raw = readFileSync(join(folder, "SKILL.md"), "utf8");
    } catch {
      continue;
    }
    const parsed = readEgmFrontmatter(raw);
    if (!parsed || parsed.name !== name) continue;
    skills.push({
      name,
      description: parsed.description,
      ...(parsed.license ? { license: parsed.license } : {}),
      folder,
      file: join(folder, "SKILL.md"),
      root,
      requiresSubagents: /^## Delegation\b/m.test(raw),
    });
  }
  return skills;
}

export function isEgmSkillName(name: string): boolean {
  return name.startsWith("egm-") && egmSkills().some((skill) => skill.name === name);
}

/** The SKILL.md of a vendor EGM skill, only while the vendor copy still has it under its own name. */
export function readEgmSkillFile(name: string): string | null {
  if (!isEgmSkillName(name)) return null;
  try {
    return readFileSync(join(vendorRoot(), SKILLS_DIR, name, "SKILL.md"), "utf8");
  } catch {
    return null;
  }
}

/** Claude Code and Antigravity take the vendor plugin's `egm` namespace; every other runner takes the bare name. */
export function egmCommandPrefix(driverKind: string | undefined): string {
  return driverKind === "claudeAgent" || driverKind === "antigravityAgent" ? "/egm:" : "/";
}

/** Bot Settings → Skills: every EGM skill with this bot's switch folded in. A review skill on a runner
 * without subagents shows as off for this bot, with the reason a person reads. */
export interface EgmListing {
  name: string;
  description: string;
  enabled: boolean;
  source: string;
  /** The vendor SKILL.md path, named so a search finds it while the skill is on. */
  file: string;
  sha256: string;
  importedAt: string;
  license?: string;
  warnings: string[];
}

export const EGM_SUBAGENTS_WARNING =
  "needs fresh subagents for its review steps, which this bot's runner cannot spawn — its turns skip the skill";

export const EGM_SOURCE = "vendor/elephant-goldfish-model";

export function egmListings(cfg: AppConfig, off: ReadonlySet<string>, driverKind: string | undefined): EgmListing[] {
  if (!egmSkillsEnabled(cfg)) return [];
  const withoutSubagents = driverKind !== undefined && !driverSpawnsSubagents(driverKind);
  return egmSkills().map((skill) => {
    const skipped = skill.requiresSubagents && withoutSubagents;
    const enabled = !off.has(skill.name) && !skipped;
    return {
      name: skill.name,
      description: skill.description,
      enabled,
      source: EGM_SOURCE,
      file: skill.file,
      sha256: createHash("sha256").update(readEgmSkillFile(skill.name) ?? "").digest("hex"),
      importedAt: importedAt(skill.file),
      ...(skill.license ? { license: skill.license } : {}),
      warnings: skipped ? [EGM_SUBAGENTS_WARNING] : [],
    };
  });
}

/** One EGM skill as a turn uses it, with the vendor root and the command form its prompt line states. */
export interface EgmTurnSkill extends EgmSkill {
  command: string;
}

/** The EGM skills for one turn: the workspace switch on, not switched off for this bot, not shadowed by one
 * of the bot's own or library skills, and the review skills only where the runner can spawn subagents. */
export function egmTurnSkills(
  cfg: AppConfig,
  off: ReadonlySet<string>,
  shadowed: ReadonlySet<string>,
  driverKind: string | undefined,
): EgmTurnSkill[] {
  if (!egmSkillsEnabled(cfg)) return [];
  const prefix = egmCommandPrefix(driverKind);
  return egmSkills()
    .filter((skill) => !shadowed.has(skill.name) && !off.has(skill.name))
    .filter((skill) => !skill.requiresSubagents || driverSpawnsSubagents(driverKind))
    .map((skill) => ({ ...skill, command: `${prefix}${skill.name}` }));
}

function importedAt(file: string): string {
  try {
    return new Date(statSync(file).mtimeMs).toISOString();
  } catch {
    return new Date(0).toISOString();
  }
}
