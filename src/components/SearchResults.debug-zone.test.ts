import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { setLocale } from "@/lib/i18n";
import type { SearchHit } from "@/lib/search-hit";
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

import { SearchResults } from "./SearchResults";

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

const sampleHits: SearchHit[] = [
  {
    threadId: "t1",
    messageId: "m1",
    at: Date.now(),
    role: "assistant",
    kind: "text",
    snippet: "Hello from Atlas",
    matchStart: 11,
    matchLength: 5,
    botId: "atlas",
    name: "Atlas",
    onActivePath: true,
  },
  {
    threadId: "t2",
    messageId: "m2",
    at: Date.now(),
    role: "assistant",
    kind: "text",
    snippet: "Hello from hub worker",
    matchStart: 11,
    matchLength: 3,
    botId: "hub-qoder",
    name: "hub·qoder-cn",
    onActivePath: true,
  },
];

const render = () => renderToStaticMarkup(createElement(SearchResults, { query: "hello", onLanded: () => {}, initialHits: sampleHits }));

beforeEach(() => {
  fixture.advanced = true;
  fixture.state = { bots: [bot("atlas", "Atlas"), bot("hub-qoder", "hub·qoder-cn")] };
  setLocale("en");
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("SearchResults debug zone filtering", () => {
  it("includes debug bot hits when advanced mode is on", () => {
    fixture.advanced = true;
    const html = render();
    expect(html).toContain("Atlas");
    expect(html).toContain("hub·qoder-cn");
  });

  it("filters out debug bot hits when advanced mode is off", () => {
    fixture.advanced = false;
    const html = render();
    expect(html).toContain("Atlas");
    expect(html).not.toContain("hub·qoder-cn");
  });
});
