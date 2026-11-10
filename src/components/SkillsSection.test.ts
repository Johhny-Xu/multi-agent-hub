import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";

import { setLocale } from "@/lib/i18n";
import { filterLibrarySkills, LibrarySkillMeta, EgmSkillsSettings } from "./SkillsSection";
import type { SkillsLibrarySkillWire } from "../../shared/wire";

// The EGM copy keys are delivered ahead of the language pack: unresolved keys render as themselves, so the
// tests assert them by key while the existing skills.library.* keys keep their real wording.
vi.mock("@/lib/i18n", async (original) => ({
  ...await original<typeof import("@/lib/i18n")>(),
  tFromServer: (key: string | undefined) => key ?? "",
}));

const egmStore = vi.hoisted(() => ({ config: {} as Record<string, unknown>, saved: [] as unknown[] }));
vi.mock("@/state/store", () => ({
  useStore: () => ({ state: { config: egmStore.config }, dispatch: vi.fn() }),
  api: async (path: string, init?: { body?: string }) => {
    egmStore.saved.push([path, init?.body]);
    return { ...egmStore.config };
  },
}));

afterEach(() => {
  setLocale("en");
  egmStore.config = {};
  egmStore.saved = [];
});

const skill = (overrides: Partial<SkillsLibrarySkillWire> = {}): SkillsLibrarySkillWire => ({
  name: "order-audit",
  description: "Audits an order before it ships.",
  source: "local-import",
  enabled: true,
  everyBot: false,
  tags: [],
  version: null,
  importedAt: "2026-09-20T12:00:00.000Z",
  warnings: [],
  assignedBots: [],
  ...overrides,
});

describe("filterLibrarySkills", () => {
  const skills = [
    skill({ name: "order-audit", description: "Audits orders", tags: ["orders", "review"], source: "local-import" }),
    skill({ name: "polite-replies", description: "Keeps the tone friendly", tags: ["tone"], source: "bundled" }),
    skill({ name: "spreadsheet-math", description: "Formula help", tags: ["sheets"], source: "org/upload" }),
  ];

  it("matches the query against name, description, and source", () => {
    expect(filterLibrarySkills(skills, "order", null).map((s) => s.name)).toEqual(["order-audit"]);
    expect(filterLibrarySkills(skills, "FRIENDLY", null).map((s) => s.name)).toEqual(["polite-replies"]);
    expect(filterLibrarySkills(skills, "org/", null).map((s) => s.name)).toEqual(["spreadsheet-math"]);
  });

  it("narrows by tag and combines with the query", () => {
    expect(filterLibrarySkills(skills, "", "review").map((s) => s.name)).toEqual(["order-audit"]);
    expect(filterLibrarySkills(skills, "formula", "sheets").map((s) => s.name)).toEqual(["spreadsheet-math"]);
    expect(filterLibrarySkills(skills, "friendly", "sheets").map((s) => s.name)).toEqual([]);
  });

  it("returns everything for an empty query and no tag", () => {
    expect(filterLibrarySkills(skills, "   ", null)).toHaveLength(3);
  });
});

describe("LibrarySkillMeta", () => {
  it("shows the source, a version when one exists, the import date, and tags", () => {
    const html = renderToStaticMarkup(createElement(LibrarySkillMeta, {
      skill: skill({ tags: ["orders"], version: "2.1.0" }),
    }));
    expect(html).toContain("Source: local-import");
    expect(html).toContain("Version 2.1.0");
    expect(html).toContain("orders");
  });

  it("says there is no version instead of rendering a blank", () => {
    const html = renderToStaticMarkup(createElement(LibrarySkillMeta, { skill: skill() }));
    expect(html).toContain("No version");
    expect(html).not.toContain("Version ");
  });
});

describe("EgmSkillsSettings", () => {
  it("offers the built-in EGM skills to every bot unless the workspace turned them off", () => {
    const on = renderToStaticMarkup(createElement(EgmSkillsSettings));
    expect(on).toContain('data-testid="egm-skills-settings"');
    expect(on).toContain("egmSkills.title");
    expect(on).toContain("egmSkills.row");
    expect(on).toContain('aria-label="egmSkills.rowAria"');
    expect(on).toContain('aria-checked="true"');
    egmStore.config = { egmSkills: { enabled: false } };
    const off = renderToStaticMarkup(createElement(EgmSkillsSettings));
    expect(off).toContain('aria-checked="false"');
  });

  it("renders the row copy by key until the language pack merges", () => {
    const html = renderToStaticMarkup(createElement(EgmSkillsSettings));
    expect(html).toContain("egmSkills.subtitle");
    expect(html).toContain("egmSkills.rowDetail");
    expect(html).not.toContain("egmSkills.error");
    expect(egmStore.saved).toEqual([]);
  });
});
