// The built-in EGM skills: the vendor copy is read-only, so the tests point OMB_EGM_VENDOR_DIR at a fixture
// root they write themselves and only the discovery test reads the real vendor copy, which the rtest sync
// brings along. HOME and the data folder are this test file's own temporary ones (server/testing/setup.ts).
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { DATA_DIR, egmSkillsEnabled, loadConfig, saveConfig } from "./config.ts";
import { EGM_SUBAGENTS_WARNING, egmCommandPrefix, egmListings, egmSkills, egmTurnSkills, driverSpawnsSubagents } from "./egm-skills.ts";
import {
  IMPORTED_SKILLS_DIR, importedSkillListings, importedSkillsFor, importedSkillsPrompt, readImportedSkillFile, setImportedSkillEnabled,
} from "./imported-skills.ts";

const EGMS = ["egm-bootstrap", "egm-brainstorm", "egm-draft", "egm-drift-report", "egm-resolve", "egm-review", "egm-review-loop"];
const REVIEWERS = new Set(["egm-bootstrap", "egm-brainstorm", "egm-review", "egm-review-loop"]);
const newBot = () => `bot-${Math.random().toString(36).slice(2, 10)}`;

let fixtureRoot = "";

const skillMd = (name: string, description: string, delegation: boolean) =>
  `---\nname: ${name}\nlicense: Apache-2.0\ndisable-model-invocation: true\ndescription: >-\n  ${description}\n---\n\n# ${name}\n` +
  (delegation ? "\n## Delegation\n\nSpawn each subagent with your harness's subagent tool.\n" : "\nDo the work yourself.\n");

function fixtureVendor(): string {
  const root = mkdtempSync(join(tmpdir(), "omb-egm-vendor-"));
  for (const name of EGMS) {
    mkdirSync(join(root, "skills", name), { recursive: true });
    writeFileSync(join(root, "skills", name, "SKILL.md"), skillMd(name, `The ${name} skill.`, REVIEWERS.has(name)));
  }
  return root;
}

beforeEach(() => {
  mkdirSync(DATA_DIR, { recursive: true });
  fixtureRoot = fixtureVendor();
  process.env.OMB_EGM_VENDOR_DIR = fixtureRoot;
});

afterEach(() => {
  delete process.env.OMB_EGM_VENDOR_DIR;
  rmSync(fixtureRoot, { recursive: true, force: true });
  if (!DATA_DIR.startsWith(join(tmpdir(), "omb-test-home-"))) throw new Error(`refusing to clean ${DATA_DIR}: not this test's home`);
  rmSync(join(DATA_DIR, "config.json"), { force: true });
  rmSync(IMPORTED_SKILLS_DIR, { recursive: true, force: true });
  rmSync(join(DATA_DIR, "skill-state"), { recursive: true, force: true });
});

describe("built-in EGM skills", () => {
  it("discovers the vendor copy's seven skills, with the review skills marked as needing subagents", () => {
    delete process.env.OMB_EGM_VENDOR_DIR;
    const skills = egmSkills();
    expect(skills.map((skill) => skill.name)).toEqual(EGMS);
    for (const skill of skills) {
      expect(skill.description).not.toHaveLength(0);
      expect(skill.license).toBe("Apache-2.0");
      expect(skill.folder.startsWith(skill.root)).toBe(true);
      expect(skill.requiresSubagents).toBe(REVIEWERS.has(skill.name));
    }
  });

  it("is on by default for a new bot, and its prompt names the vendor root and the command", () => {
    expect(egmSkillsEnabled(loadConfig())).toBe(true);
    const skills = importedSkillsFor(newBot(), new Set(), [], { driverKind: "codex" });
    expect(skills.map((skill) => skill.name)).toEqual(EGMS);
    for (const skill of skills) {
      expect(skill.root).toBe(fixtureRoot);
      expect(skill.command).toBe(`/${skill.name}`);
    }
    const prompt = importedSkillsPrompt(skills);
    expect(prompt).toContain(JSON.stringify(fixtureRoot));
    expect(prompt).toContain(`The command is /egm-bootstrap.`);
  });

  it("turned off for the whole workspace, no bot's turn offers any of them", () => {
    saveConfig({ egmSkills: { enabled: false } });
    expect(egmSkillsEnabled(loadConfig())).toBe(false);
    const bot = newBot();
    expect(importedSkillsFor(bot, new Set(), [], { driverKind: "codex" })).toEqual([]);
    expect(importedSkillListings(bot, new Set(), "", { driverKind: "codex" })).toEqual([]);
    expect(egmTurnSkills(loadConfig(), new Set(), new Set(), "codex")).toEqual([]);
    saveConfig({ egmSkills: { enabled: true } });
    expect(importedSkillsFor(bot, new Set(), [], { driverKind: "codex" }).map((skill) => skill.name)).toEqual(EGMS);
  });

  it("one bot's switch leaves the others untouched, and a bot made later is on again", () => {
    const [off, on, fresh] = [newBot(), newBot(), newBot()];
    expect(setImportedSkillEnabled(off, "egm-draft", false)).toMatchObject({ enabled: false });
    expect(importedSkillsFor(off, new Set(), [], { driverKind: "codex" }).map((skill) => skill.name)).toEqual(EGMS.filter((name) => name !== "egm-draft"));
    expect(importedSkillsFor(on, new Set(), [], { driverKind: "codex" }).map((skill) => skill.name)).toEqual(EGMS);
    expect(importedSkillsFor(fresh, new Set(), [], { driverKind: "codex" }).map((skill) => skill.name)).toEqual(EGMS);
    expect(importedSkillListings(off, new Set(), "", { driverKind: "codex" }).find((skill) => skill.name === "egm-draft")).toMatchObject({ enabled: false });
    // The switch goes through the shared choices file, so the same bot's turn path sees it too.
    expect(readImportedSkillFile("egm-draft")).toContain(`name: egm-draft`);
  });

  it("skips the review skills on a runner without subagents, with the reason in the list", () => {
    expect(driverSpawnsSubagents("claudeAgent")).toBe(true);
    expect(driverSpawnsSubagents("codex")).toBe(true);
    expect(driverSpawnsSubagents("antigravityAgent")).toBe(true);
    expect(driverSpawnsSubagents("opencodeGo")).toBe(true);
    expect(driverSpawnsSubagents("qwenAgent")).toBe(false);
    const bot = newBot();
    const without = importedSkillsFor(bot, new Set(), [], { driverKind: "qwenAgent" });
    expect(without.map((skill) => skill.name)).toEqual(EGMS.filter((name) => !REVIEWERS.has(name)));
    expect(egmCommandPrefix("claudeAgent")).toBe("/egm:");
    expect(without[0]!.command).toBe("/egm-draft");
    const listings = importedSkillListings(bot, new Set(), "", { driverKind: "qwenAgent" });
    expect(listings.find((skill) => skill.name === "egm-review")).toMatchObject({ enabled: false, warnings: [EGM_SUBAGENTS_WARNING] });
    expect(listings.find((skill) => skill.name === "egm-draft")).toMatchObject({ enabled: true, warnings: [] });
    const withClaude = importedSkillsFor(bot, new Set(), [], { driverKind: "claudeAgent" });
    expect(withClaude.map((skill) => skill.name)).toEqual(EGMS);
    expect(withClaude.find((skill) => skill.name === "egm-review")!.command).toBe("/egm:egm-review");
    expect(egmListings(loadConfig(), new Set(), "claudeAgent").find((skill) => skill.name === "egm-review")).toMatchObject({ enabled: true });
  });

  it("a missing vendor copy is no error, just no skills anywhere", () => {
    process.env.OMB_EGM_VENDOR_DIR = join(tmpdir(), `omb-egm-missing-${Math.random().toString(36).slice(2)}`);
    expect(existsSync(process.env.OMB_EGM_VENDOR_DIR)).toBe(false);
    expect(egmSkills()).toEqual([]);
    expect(egmListings(loadConfig(), new Set(), "codex")).toEqual([]);
    expect(egmTurnSkills(loadConfig(), new Set(), new Set(), "codex")).toEqual([]);
    expect(importedSkillsFor(newBot(), new Set(), [], { driverKind: "codex" })).toEqual([]);
    expect(readImportedSkillFile("egm-draft")).toBeNull();
    expect(setImportedSkillEnabled(newBot(), "egm-draft", false)).toEqual({ error: `no skill named "egm-draft" was brought in from this computer` });
  });
});
