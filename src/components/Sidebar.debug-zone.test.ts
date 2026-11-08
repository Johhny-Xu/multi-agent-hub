import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { initialDesktopCapabilities } from "@/lib/desktop";
import { setLocale } from "@/lib/i18n";
import type { AppState, Bot } from "@/state/store";

const fixture = vi.hoisted(() => ({ advanced: true, state: {} as Partial<AppState> }));

vi.mock("@/lib/interface-mode", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/lib/interface-mode")>(),
  useAdvancedMode: () => fixture.advanced,
}));
vi.mock("@/state/store", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/state/store")>();
  return {
    ...original,
    useStore: () => ({ state: { ...original.initialState, ...fixture.state }, dispatch: () => {} }),
  };
});
vi.mock("./DesktopCapabilities", async (importOriginal) => ({
  ...await importOriginal<typeof import("./DesktopCapabilities")>(),
  useDesktopCapabilities: () => ({ capabilities: initialDesktopCapabilities(), ready: true }),
}));

import { Sidebar } from "./Sidebar";

const bot = (id: string, name: string): Bot => ({
  id,
  threadId: `${id}-thread`,
  name,
  title: "",
  description: "",
  notifications: true,
  color: "green",
  unread: false,
  modelSelection: { instanceId: "fake", model: "test" },
  messages: [],
  tasks: [],
});

const render = () => renderToStaticMarkup(createElement(Sidebar, { open: true, onClose: () => {} }));

beforeEach(() => {
  fixture.advanced = true;
  fixture.state = { bots: [bot("atlas", "Atlas"), bot("hub-zcode", "hub·zcode")] };
  vi.stubGlobal("window", { innerWidth: 1280, location: { protocol: "http:", search: "" } });
  setLocale("en");
});

afterEach(() => {
  vi.unstubAllGlobals();
  setLocale("en");
});

describe("debug zone in the sidebar", () => {
  it("keeps hub bots out of the everyday lists and lists them in Debug in Advanced mode", () => {
    const html = render();
    expect(html).toContain('data-sidebar-debug-zone=""');
    expect(html.match(/data-sidebar-bot-row="hub-zcode"/g)).toHaveLength(1);
    expect(html.indexOf('data-sidebar-bot-row="hub-zcode"')).toBeGreaterThan(html.indexOf('data-sidebar-debug-zone=""'));
    expect(html.split('data-sidebar-debug-zone=""')[0]).not.toContain("hub-zcode");
    expect(html).toContain('data-sidebar-bot-row="atlas"');
  });

  it("shows neither the section nor its bots while Advanced mode is off", () => {
    fixture.advanced = false;
    const html = render();
    expect(html).not.toContain('data-sidebar-debug-zone=""');
    expect(html).not.toContain("hub·zcode");
    expect(html).toContain("Atlas");
  });
});
