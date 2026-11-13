// @vitest-environment happy-dom
import { createElement } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BotEditorStore, initialState, reducer, type Action, type AppState, type Bot } from "@/state/store";
import { BotContextMenu } from "./Sidebar";
import { setLocale } from "@/lib/i18n";

vi.mock("@/lib/use-owner-or-admin", () => ({ useOwnerOrAdmin: () => true }));
vi.mock("./DesktopCapabilities", () => ({ useDesktopCapabilities: () => ({}) }));
const mode = vi.hoisted(() => ({ advanced: true }));
vi.mock("@/lib/interface-mode", async (original) => ({
  ...await original<typeof import("@/lib/interface-mode")>(), useAdvancedMode: () => mode.advanced,
}));

const bot: Bot = { id: "reviewer", threadId: "selected", name: "Reviewer", title: "", description: "", color: "green",
  notifications: true, unread: true, messages: [], modelSelection: { instanceId: "fake", model: "test" },
  tasks: [
    { threadId: "selected", title: "Selected", createdAt: 1, unread: false },
    { threadId: "background", title: "Report", createdAt: 2, unread: true },
    { threadId: "next", title: "Another report", createdAt: 3, unread: true },
  ],
};
let root: Root, container: HTMLDivElement, state: AppState;
let menu: { botId: string; x: number; y: number } | null;
const onClose = vi.fn();
const onRename = vi.fn();
const dispatch = (action: Action) => { state = reducer(state, action); draw(); };
const draw = () => flushSync(() => root.render(createElement(BotEditorStore, {
  value: { state, dispatch, flushBotPatches: async () => null, refreshInstances: async () => {}, refreshModels: async () => {} },
  children: createElement(BotContextMenu, { menu, onClose, onArchive: vi.fn(), onDelete: vi.fn(), onMoveToSection: vi.fn(), onNewFolder: vi.fn(), onNewTaskFolder: vi.fn(), onRename }),
})));
const button = (label = "Mark all conversations as read") => [...document.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')].find((node) => node.textContent === label)!;
const response = (threadId: string) => {
  const current = state.bots[0]!;
  return new Response(JSON.stringify({ bot: { ...current, tasks: current.tasks!.map((task) => task.threadId === threadId ? { ...task, unread: false } : task) } }), { headers: { "content-type": "application/json" } });
};

beforeEach(() => {
  mode.advanced = true;
  setLocale("en"); document.documentElement.dataset.reducedMotion = "true";
  container = document.createElement("div"); document.body.append(container); root = createRoot(container);
  state = { ...initialState, bots: [structuredClone(bot)], selectedId: "another-bot" };
  menu = { botId: bot.id, x: 50, y: 50 }; onClose.mockReset();
});
afterEach(() => { flushSync(() => root.unmount()); container.remove(); vi.unstubAllGlobals(); delete window.ogb; setLocale("en"); });

describe("bot menu bulk reads", () => {
  it("remains available with the full thread tree hidden, including Portuguese copy", () => {
    setLocale("pt-br"); draw();
    expect(button("Marcar todas as conversas como lidas").disabled).toBe(false);
  });

  it("disables the action when there is no unread conversation", () => {
    state.bots[0]!.tasks!.forEach((task) => { task.unread = false; }); draw();
    expect(button().disabled).toBe(true);
  });

  it("guards repeat clicks, shows progress and closes only after the last read is confirmed", async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const fetch = vi.fn(async (_url: unknown, init?: RequestInit) => {
      const { threadId } = JSON.parse(String(init?.body));
      await gate; return response(threadId);
    });
    vi.stubGlobal("fetch", fetch); draw();
    const trigger = button(); flushSync(() => { trigger.click(); trigger.click(); });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(button("Marking conversations as read…").disabled).toBe(true);
    expect(onClose).not.toHaveBeenCalled();
    release();
    await expect.poll(() => onClose.mock.calls.length).toBe(1);
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(state.selectedId).toBe("another-bot");
    expect(state.bots[0]!.threadId).toBe("selected");
    expect(state.bots[0]!.tasks!.every((task) => !task.unread)).toBe(true);
  });

  it("shows a recoverable failure, retains confirmed reads, and retries only the unread remainder", async () => {
    const fetch = vi.fn(async (_url: unknown, init?: RequestInit) => response(JSON.parse(String(init?.body)).threadId));
    fetch.mockImplementationOnce(async () => response("background"));
    fetch.mockImplementationOnce(async () => new Response(JSON.stringify({ error: "Fixture read failed" }), { status: 500 }));
    vi.stubGlobal("fetch", fetch); draw(); flushSync(() => button().click());
    await expect.poll(() => document.querySelector('[role="alert"]')?.textContent).toContain("Completed reads were kept");
    expect(document.querySelector('[role="alert"]')?.textContent).toContain("Fixture read failed");
    expect(onClose).not.toHaveBeenCalled();
    expect(state.bots[0]!.tasks!.find((task) => task.threadId === "background")?.unread).toBe(false);
    expect(state.bots[0]!.tasks!.find((task) => task.threadId === "next")?.unread).toBe(true);
    flushSync(() => button().click()); await expect.poll(() => onClose.mock.calls.length).toBe(1);
    expect(fetch).toHaveBeenCalledTimes(3);
    expect(JSON.parse(String(fetch.mock.calls[2]![1]?.body)).threadId).toBe("next");
  });

  it("does not close a different menu opened while a read is in flight", async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const fetch = vi.fn(async (_url: unknown, init?: RequestInit) => { await gate; return response(JSON.parse(String(init?.body)).threadId); });
    vi.stubGlobal("fetch", fetch); draw(); flushSync(() => button().click());
    menu = { botId: bot.id, x: 60, y: 60 }; draw(); release();
    await expect.poll(() => state.bots[0]!.tasks!.every((task) => !task.unread)).toBe(true);
    expect(onClose).not.toHaveBeenCalled();
  });

  it("does not expose bulk sibling reads to thread-pinned remote clients", () => {
    window.ogb = { remoteClient: { active: true } } as typeof window.ogb;
    draw(); expect(button()).toBeUndefined();
  });

  it("offers Simple mode one toggle: Mark as read while anything is unread, Mark as unread once nothing is", async () => {
    mode.advanced = false;
    const fetch = vi.fn(async (_url: unknown, init?: RequestInit) => response(JSON.parse(String(init?.body)).threadId));
    vi.stubGlobal("fetch", fetch); draw();
    expect(button("Mark as unread")).toBeUndefined();
    flushSync(() => button("Mark as read").click());
    await expect.poll(() => onClose.mock.calls.length).toBe(1);
    expect(state.bots[0]!.tasks!.every((task) => !task.unread)).toBe(true);
    draw();
    expect(button("Mark as read")).toBeUndefined();
    flushSync(() => button("Mark as unread").click());
    expect(state.bots[0]!.unread).toBe(true);
  });
});

describe("Simple mode's bot menu", () => {
  const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
  const sheet = () => document.querySelector<HTMLElement>('[data-bot-menu][aria-label="Actions for Reviewer"]')!;
  const more = () => document.querySelector<HTMLElement>("[data-bot-menu-more]")!;
  const flyout = () => document.querySelector('[role="menu"][aria-label="More"]');
  const point = (target: Element, y: number) => target.dispatchEvent(new MouseEvent("pointerover", { bubbles: true, clientX: 60, clientY: y }));
  beforeEach(() => { mode.advanced = false; });

  it("leads with Pin, Move and Mark as read, then the thread items, then Rename, then Copy conversation ID and More, and ends with Archive and Delete", () => {
    draw();
    expect([...sheet().querySelectorAll("button")].map((node) => node.textContent)).toEqual([
      "Pin", "Move to department", "Mark as read", "Mark all as read", "New thread", "View threads", "Rename", "Copy conversation ID", "More", "Archive", "Delete",
    ]);
    expect([...sheet().children].map((node) => node.getAttribute("role") === "separator" ? "|" : node.textContent)).toEqual([
      "Pin", "Move to department", "Mark as read", "Mark all as read", "|", "New thread", "View threads", "|", "Rename", "|", "Copy conversation ID", "More", "|", "Archive", "Delete",
    ]);
    flushSync(() => button("Rename").click());
    expect(onRename).toHaveBeenCalledWith(bot.id);
  });

  it("offers Delete all conversations only with two or more, last and in danger, and asks with its count", () => {
    draw();
    flushSync(() => more().click());
    const deleteAll = [...flyout()!.querySelectorAll("button")].at(-1)!;
    expect(deleteAll.textContent).toBe("Delete all conversations…");
    expect(deleteAll.className).toContain("text-danger");
    flushSync(() => deleteAll.click());
    expect(document.body.textContent).toContain("Delete all conversations (3)?");
    state = { ...state, bots: [{ ...structuredClone(bot), tasks: [bot.tasks![0]!] }] };
    menu = { botId: bot.id, x: 50, y: 50 };
    draw();
    flushSync(() => more().click());
    expect([...flyout()!.querySelectorAll("button")].map((node) => node.textContent)).not.toContain("Delete all conversations…");
  });

  it("opens More only after the pointer rests on it, closes it when a sibling row takes the pointer, and opens it at once on a click", async () => {
    draw();
    const pin = button("Pin");
    point(more(), 200);
    await wait(100);
    expect(flyout()).toBeNull();
    point(pin, 80);
    await wait(400);
    expect(flyout()).toBeNull();
    point(more(), 200);
    await wait(320);
    expect(flyout()).not.toBeNull();
    expect([...flyout()!.querySelectorAll("button")].map((node) => node.textContent)).toEqual(["Edit profile", "Make Chief of Staff", "Duplicate", "Delete all conversations…"]);
    point(pin, 80);
    await wait(20);
    expect(flyout()).toBeNull();
    flushSync(() => more().click());
    await wait(20);
    expect(flyout()).not.toBeNull();
  });
});

describe("bot list's Mark all as read", () => {
  const other: Bot = { id: "scout", threadId: "scout-main", name: "Scout", title: "", description: "", color: "blue",
    notifications: true, unread: true, messages: [], modelSelection: { instanceId: "fake", model: "test" },
    tasks: [{ threadId: "scout-main", title: "Main", createdAt: 1, unread: true }] };
  const archived: Bot = { ...structuredClone(other), id: "attic", threadId: "attic-main", name: "Attic", hidden: true,
    tasks: [{ threadId: "attic-main", title: "Old", createdAt: 1, unread: true }] };
  const room = { id: "room", name: "Room", memberIds: ["reviewer", "scout"], messages: [], unread: true, threadId: "room-thread" } as unknown as AppState["groups"][number];
  const reads = (fetch: ReturnType<typeof vi.fn>) => fetch.mock.calls.map(([url, init]) => `${String(url)} ${init?.body ? JSON.parse(String(init.body)).threadId : ""}`.trim());
  const serve = async (url: unknown, init?: RequestInit) => {
    const path = String(url);
    if (path.startsWith("/api/groups/")) return new Response(JSON.stringify({ group: { id: "room", unread: false } }), { headers: { "content-type": "application/json" } });
    const botId = path.split("/")[3]!, threadId = JSON.parse(String(init?.body)).threadId;
    const current = state.bots.find((candidate) => candidate.id === botId)!;
    return new Response(JSON.stringify({ bot: { ...current, unread: false, tasks: current.tasks!.map((task) => task.threadId === threadId ? { ...task, unread: false } : task) } }), { headers: { "content-type": "application/json" } });
  };
  let answer = vi.fn(serve);
  beforeEach(() => {
    answer = vi.fn(serve);
    state = { ...state, bots: [structuredClone(bot), structuredClone(other), structuredClone(archived)], groups: [structuredClone(room)] };
  });

  it("sits right after the bot's own read item in both views", () => {
    draw();
    const labels = [...document.querySelectorAll('[role="menuitem"]')].map((node) => node.textContent);
    expect(labels.indexOf("Mark all as read")).toBe(labels.indexOf("Mark all conversations as read") + 1);
    mode.advanced = false; draw();
    const simple = [...document.querySelectorAll('[role="menuitem"]')].map((node) => node.textContent);
    expect(simple.indexOf("Mark all as read")).toBe(simple.indexOf("Mark as read") + 1);
  });

  it("reads every shown bot's unread threads and every unread group chat, one request at a time, then closes", async () => {
    vi.stubGlobal("fetch", answer); draw();
    flushSync(() => button("Mark all as read").click());
    await expect.poll(() => onClose.mock.calls.length).toBe(1);
    expect(reads(answer)).toEqual([
      "/api/bots/reviewer/read background", "/api/bots/reviewer/read next", "/api/bots/scout/read scout-main", "/api/groups/room/read",
    ]);
    expect(state.bots.filter((candidate) => !candidate.hidden).every((candidate) => candidate.tasks!.every((task) => !task.unread))).toBe(true);
    expect(state.groups[0]!.unread).toBe(false);
    expect(state.selectedId).toBe("another-bot");
  });

  it("is disabled once nothing shown is unread, even with an archived bot still unread", () => {
    state.bots.filter((candidate) => !candidate.hidden).forEach((candidate) => { candidate.unread = false; candidate.tasks!.forEach((task) => { task.unread = false; }); });
    state.groups[0]!.unread = false; draw();
    expect(button("Mark all as read").disabled).toBe(true);
  });

  it("works from a bot with nothing unread of its own", async () => {
    state.bots[0]!.tasks!.forEach((task) => { task.unread = false; }); state.bots[0]!.unread = false;
    vi.stubGlobal("fetch", answer); draw();
    expect(button().disabled).toBe(true);
    expect(button("Mark all as read").disabled).toBe(false);
    flushSync(() => button("Mark all as read").click());
    await expect.poll(() => onClose.mock.calls.length).toBe(1);
    expect(reads(answer)).toEqual(["/api/bots/scout/read scout-main", "/api/groups/room/read"]);
  });

  it("keeps completed reads and shows the failure when one request fails, guarding repeat clicks", async () => {
    const fetch = vi.fn(serve);
    fetch.mockImplementationOnce(serve);
    fetch.mockImplementationOnce(async () => new Response(JSON.stringify({ error: "Fixture read failed" }), { status: 500 }));
    vi.stubGlobal("fetch", fetch); draw();
    const trigger = button("Mark all as read");
    flushSync(() => { trigger.click(); trigger.click(); });
    await expect.poll(() => document.querySelector('[role="alert"]')?.textContent).toContain("Fixture read failed");
    expect(document.querySelector('[role="alert"]')?.textContent).toContain("Completed reads were kept");
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(onClose).not.toHaveBeenCalled();
    expect(state.bots[0]!.tasks!.find((task) => task.threadId === "background")?.unread).toBe(false);
    expect(state.bots[1]!.tasks![0]!.unread).toBe(true);
  });

  it("is not offered to thread-pinned remote clients", () => {
    window.ogb = { remoteClient: { active: true } } as typeof window.ogb;
    draw(); expect(button("Mark all as read")).toBeUndefined();
  });
});
