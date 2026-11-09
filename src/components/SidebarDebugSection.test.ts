import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { setLocale } from "@/lib/i18n";
import { SidebarDebugSection } from "./SidebarDebugSection";

const render = (collapsed: boolean, onToggle?: () => void) => renderToStaticMarkup(
  createElement(
    SidebarDebugSection,
    { count: 2, collapsed, onToggle, children: createElement("div", { "data-debug-row": "one" }, "hub·zcode") },
  ),
);

beforeEach(() => setLocale("en"));
afterEach(() => setLocale("en"));

describe("debug zone section", () => {
  it("heads the section and lists its bots", () => {
    const html = render(false, vi.fn());
    expect(html).toContain('data-sidebar-debug-zone=""');
    expect(html).toContain("Debug");
    expect(html).toContain('data-debug-row="one"');
    expect(html).toContain('aria-expanded="true"');
  });

  it("hides its rows when collapsed and shows the collapsed header", () => {
    const html = render(true, vi.fn());
    expect(html).toContain("Debug");
    expect(html).not.toContain('data-debug-row="one"');
    expect(html).toContain('aria-expanded="false"');
  });

  it("draws no header where the sidebar is only avatars", () => {
    const html = renderToStaticMarkup(
      createElement(
        SidebarDebugSection,
        { count: 2, collapsed: false, showHeader: false, children: createElement("div", { "data-debug-row": "one" }) },
      ),
    );
    expect(html).not.toContain("Debug");
    expect(html).toContain('data-debug-row="one"');
  });
});
