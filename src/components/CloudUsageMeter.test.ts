import { Children, createElement, isValidElement, type ReactElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CloudUsage } from "../../electron/cloud-home.mjs";
import { setLocale } from "@/lib/i18n";

// The card and the section are rendered as React renders them, with Settings' look (a context) unset.
const f = vi.hoisted(() => ({ values: [] as unknown[], index: 0 }));
vi.mock("react", async original => ({ ...await original<typeof import("react")>(),
  useState: (initial: unknown) => { const index = f.index++; if (!(index in f.values)) f.values[index] = typeof initial === "function" ? (initial as () => unknown)() : initial;
    return [f.values[index], (next: unknown) => { f.values[index] = typeof next === "function" ? (next as (value: unknown) => unknown)(f.values[index]) : next; }]; },
  useContext: () => false,
}));
import { CloudUsageCardView, CloudUsageSettingsView } from "./CloudUsageMeter";

type Node = ReactElement<Record<string, any>>;
const nodes = (value: ReactNode): Node[] => {
  if (!isValidElement(value)) return [];
  const node = value as Node;
  if (typeof node.type === "function") return nodes((node.type as (props: unknown) => ReactNode)(node.props));
  return [node, ...Children.toArray(node.props.children).flatMap(nodes)];
};
const button = (tree: Node[], text: string) => tree.find(node => node.type === "button" && renderToStaticMarkup(node).includes(text));
const RESETS = Date.UTC(2026, 10, 1);
const usage = (extra: Partial<CloudUsage> = {}): CloudUsage => ({ tier: "pro", resetsAt: RESETS,
  meters: [{ kind: "computerHours", used: 285, max: 300 }, { kind: "voice", used: 12_000, max: 60_000 }, { kind: "storage", used: 41.2, max: 100 }],
  upgrades: [{ tier: "max", amount: 9900 }], ...extra });

beforeEach(() => { f.values = []; f.index = 0; setLocale("en"); });
afterEach(() => { setLocale("en"); vi.unstubAllGlobals(); });

describe("the sidebar card", () => {
  const card = (props: Partial<Parameters<typeof CloudUsageCardView>[0]> = {}) => {
    const onHide = vi.fn(), onSeeAll = vi.fn(), current = usage();
    const all = { usage: current, meters: [current.meters[0]!], band: "near" as const, onHide, onSeeAll, ...props };
    return { html: renderToStaticMarkup(createElement(CloudUsageCardView, all)), tree: nodes(CloudUsageCardView(all)), onHide, onSeeAll };
  };
  it("shows the tight allowance, used of included with its bar, when it starts over, and a quiet hide; nothing to buy", () => {
    const { html, tree, onHide, onSeeAll } = card();
    for (const text of ["You&#x27;re close to your plan&#x27;s limit", "Cloud desktop hours", "285 of 300 hours", "Resets on Nov 1.", "See all usage"]) expect(html).toContain(text);
    expect(html).toContain('role="progressbar"'); expect(html).toContain('aria-valuenow="95"'); expect(html).toContain('data-band="near"');
    expect(html).not.toContain("Voice replies");
    expect(html).not.toContain("Upgrade"); expect(html).not.toContain("$99");
    tree.find(node => node.type === "button" && node.props["aria-label"] === "Hide for now")!.props.onClick();
    button(tree, "See all usage")!.props.onClick();
    expect([onHide, onSeeAll].map(fn => fn.mock.calls.length)).toEqual([1, 1]);
  });
  it("says a limit is reached and leaves the plan alone", () => {
    expect(card({ band: "full", meters: [{ kind: "x", used: 5_000, max: 5_000, usedUp: true }] }).html).toContain("You&#x27;ve reached your plan&#x27;s limit");
    const top = card({ usage: usage({ tier: "max", upgrades: [] }) });
    expect(top.html).not.toContain("Upgrade"); expect(top.html).toContain("See all usage");
  });
});

describe("Settings → General", () => {
  const section = (current: CloudUsage) => {
    const all = { usage: current };
    return { html: renderToStaticMarkup(createElement(CloudUsageSettingsView, all)), tree: nodes(CloudUsageSettingsView(all)) };
  };
  it("lists every allowance with its meter and the plan, and offers nothing to buy", () => {
    const { html } = section(usage({ tier: "starter", upgrades: [{ tier: "max", amount: 9900 }, { tier: "pro", amount: 4900 }] }));
    for (const text of ["MausBot Cloud usage", "What your Starter plan includes this month", "285 of 300 hours", "12,000 of 60,000 characters", "41.2 of 100 GB",
      "Resets on Nov 1."]) expect(html).toContain(text);
    expect(html.match(/role="progressbar"/g)).toHaveLength(3);
    expect(html).not.toContain("Upgrade"); expect(html).not.toContain("$49"); expect(html).not.toContain("$99");
  });
  it("on Max says it is the top plan, and a team's plan changes by writing to us", () => {
    expect(section(usage({ tier: "max", upgrades: [] })).html).toContain("You&#x27;re on the top plan.");
    expect(section(usage({ tier: "team", upgrades: [] })).html).toContain("To change your team&#x27;s plan, write to us.");
  });
});
