import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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

import { CommandPalette } from "./CommandPalette";

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

const render = () => renderToStaticMarkup(createElement(CommandPalette, { initialOpen: true }));

beforeEach(() => {
  fixture.advanced = true;
  fixture.state = { bots: [bot("atlas", "Atlas"), bot("hub-minimax", "hub·minimaxcode")], groups: [] };
  vi.stubGlobal("window", { addEventListener: () => {}, removeEventListener: () => {} });
  setLocale("en");
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("Command palette debug zone filtering", () => {
  it("shows debug bots in CommandPalette when advanced mode is on", () => {
    fixture.advanced = true;
    const html = render();
    expect(html).toContain("Atlas");
    expect(html).toContain("hub·minimaxcode");
  });

  it("filters debug bots in CommandPalette when advanced mode is off", () => {
    fixture.advanced = false;
    const html = render();
    expect(html).toContain("Atlas");
    expect(html).not.toContain("hub·minimaxcode");
  });
});
