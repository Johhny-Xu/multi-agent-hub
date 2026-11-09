import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { ProviderMark } from "./ProviderIcons";

const MARKS: Record<string, string> = {
  codebuddyAgent: "0 0 12 12",
  codebuddyCnAgent: "0 0 12 12",
  meooAgent: "0 0 24 24",
  clineAgent: "0 0 113 113",
  zcodeAgent: "0 0 24 24",
};

const render = (driverKind: string) =>
  renderToStaticMarkup(createElement(ProviderMark, { driverKind, size: 20 }));

describe("the engine marks that used to fall back to a letter", () => {
  it.each(Object.entries(MARKS))("draws %s instead of the first-letter placeholder", (driverKind, viewBox) => {
    const html = render(driverKind);
    expect(html.startsWith("<svg")).toBe(true);
    expect(html).toContain(`viewBox="${viewBox}"`);
    expect(html).not.toContain("<span");
  });

  it.each(Object.entries(MARKS))("keeps every %s path coordinate inside its own viewBox", (driverKind, viewBox) => {
    const html = render(driverKind);
    const extent = Math.max(...viewBox.split(" ").slice(2).map(Number));
    const coordinates = [...html.matchAll(/ d="([^"]*)"/g)]
      .flatMap(([, d]) => d!.match(/-?\d+(?:\.\d+)?/g) ?? [])
      .map(Number);
    expect(coordinates.length).toBeGreaterThan(0);
    expect(Math.max(...coordinates)).toBeLessThanOrEqual(extent * 1.02);
  });

  it.each(Object.keys(MARKS))("inks %s in the current colour so it shows on a dark card", (driverKind) => {
    const html = render(driverKind);
    expect(html).toMatch(/var\(--color-ink\)|currentColor/);
    expect(html).not.toMatch(/#[0-9a-f]{3,8}\b/i);
  });

  it("gives both CodeBuddy editions the same mark", () => {
    expect(render("codebuddyCnAgent")).toBe(render("codebuddyAgent"));
  });

  it("cuts CodeBuddy's head and eyes out of the tile with even-odd fill", () => {
    // The official path draws the head and both eyes as holes; non-zero winding fills the head solid.
    const html = render("codebuddyAgent");
    expect(html).toContain('fill-rule="evenodd"');
    expect(html.match(/<path/g)).toHaveLength(1);
  });

  it("draws codebuddy and codebuddy-cn each an svg mark of their own with a viewBox", () => {
    const [codebuddy, codebuddyCn] = ["codebuddyAgent", "codebuddyCnAgent"].map(render);
    for (const html of [codebuddy, codebuddyCn]) {
      expect(html.startsWith("<svg")).toBe(true);
      expect(html).toContain('viewBox="');
      expect(html).not.toContain("<span");
    }
    expect(codebuddyCn).toBe(codebuddy);
  });

  it("leaves no unrendered template text in Meoo's paths", () => {
    const html = render("meooAgent");
    expect(html).not.toMatch(/d="[^"]*[`{]/);
    expect(html.match(/<path/g)).toHaveLength(1);
  });
});
