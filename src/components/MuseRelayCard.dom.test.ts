// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { setLocale } from "@/lib/i18n";

const fixture = vi.hoisted(() => ({
  config: { connections: [] as Array<Record<string, unknown>>, pendingTurns: 0, canManage: true },
  calls: [] as Array<{ path: string; method: string }>,
  failWith: 0,
  token: "muse-token-2f9c",
  connectionId: "conn-1",
  basePath: "/hooks/muse-relay/v1/conn-1",
}));

vi.mock("@/state/store", async (original) => {
  const real = await original<typeof import("@/state/store")>();
  return {
    ...real,
    api: async (path: string, init?: { method?: string }) => {
      const method = init?.method ?? "GET";
      fixture.calls.push({ path, method });
      if (method === "GET" && fixture.failWith) {
        // The server's own words can quote what it refused, so the card must not show them.
        throw new real.ApiError(`token ${fixture.token} is not valid`, fixture.failWith, { error: "refused" });
      }
      if (method === "DELETE") return { config: fixture.config };
      if (method === "POST" && path.endsWith("/rotate")) {
        return { config: fixture.config, credentials: { connectionId: fixture.connectionId, token: fixture.token, basePath: fixture.basePath } };
      }
      if (method === "POST") {
        return { config: fixture.config, credentials: { connectionId: fixture.connectionId, token: fixture.token, basePath: fixture.basePath } };
      }
      return { config: fixture.config };
    },
  };
});

import { MuseRelayCard } from "./MuseRelayCard";

const TOKEN = "muse-token-2f9c";

let container: HTMLDivElement, root: Root, writes: string[];

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  setLocale("en");
  fixture.config = { connections: [], pendingTurns: 0, canManage: true };
  fixture.calls = [];
  fixture.failWith = 0;
  fixture.token = TOKEN;
  fixture.connectionId = "conn-1";
  fixture.basePath = "/hooks/muse-relay/v1/conn-1";
  writes = [];
  Object.defineProperty(navigator, "clipboard", {
    value: { writeText: async (text: string) => { writes.push(text); } },
    configurable: true,
  });
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

const render = async () => {
  await act(async () => { root.render(createElement(MuseRelayCard, { instanceId: "muse-relay" })); });
};

const button = (label: string, scope: ParentNode = document) =>
  [...scope.querySelectorAll("button")].find((item) => item.getAttribute("aria-label") === label || item.textContent === label);

const click = async (target: Element | undefined) => {
  expect(target).toBeTruthy();
  await act(async () => { (target as HTMLElement).click(); });
};

const card = () => container.querySelector("[data-muse-relay]")!;

describe("Muse relay connections", () => {
  it("lists every connection with its state and the turns waiting", async () => {
    fixture.config = {
      connections: [
        { connectionId: "conn-1", createdAt: "2026-11-18T08:00:00.000Z", lastSeenAt: new Date(Date.now() - 60_000).toISOString(), online: true },
        { connectionId: "conn-2", createdAt: "2026-11-18T08:00:00.000Z", lastSeenAt: null, online: false },
      ],
      pendingTurns: 3,
      canManage: true,
    };
    await render();

    const rows = card().querySelectorAll("[data-muse-relay-connection]");
    expect([...rows].map((row) => row.getAttribute("data-muse-relay-connection"))).toEqual(["conn-1", "conn-2"]);
    expect(rows[0]!.textContent).toContain("Online");
    expect(rows[0]!.textContent).toContain("Last seen");
    expect(rows[1]!.textContent).toContain("Offline");
    expect(rows[1]!.textContent).toContain("Never checked in");
    expect(card().querySelector("[data-muse-relay-waiting]")!.textContent).toBe("3 turns waiting");
    expect(fixture.calls).toEqual([{ path: "/api/instances/muse-relay/muse-relay", method: "GET" }]);
  });

  it("counts one waiting turn in the singular", async () => {
    fixture.config = { connections: [], pendingTurns: 1, canManage: true };
    await render();
    expect(card().querySelector("[data-muse-relay-waiting]")!.textContent).toBe("1 turn waiting");
  });

  it("offers a first connection when there is none", async () => {
    await render();
    expect(card().textContent).toContain("No connection yet");
    const create = button("Create connection", card());
    expect(create).toBeTruthy();

    await click(create);
    expect(fixture.calls).toEqual([
      { path: "/api/instances/muse-relay/muse-relay", method: "GET" },
      { path: "/api/instances/muse-relay/muse-relay/connections", method: "POST" },
    ]);
    expect(card().querySelector("[data-muse-relay-credentials]")).toBeTruthy();
    expect(card().textContent).toContain(TOKEN);
    expect(card().textContent).toContain("/hooks/muse-relay/v1/conn-1");
    expect(card().textContent).toContain("This token is shown once");
  });

  it("copies the token, the connection and the path", async () => {
    await render();
    await click(button("Create connection", card()));
    await click(button("Copy the token", card()));
    await click(button("Copy the connection id", card()));
    await click(button("Copy the hook path", card()));
    expect(writes).toEqual([TOKEN, "conn-1", "/hooks/muse-relay/v1/conn-1"]);
  });

  it("keeps the token out of storage, the address bar and the page once it is closed", async () => {
    await render();
    await click(button("Create connection", card()));
    expect(card().textContent).toContain(TOKEN);

    await click(button("Done", card()));
    expect(card().querySelector("[data-muse-relay-credentials]")).toBeNull();
    expect(card().textContent).not.toContain(TOKEN);
    expect(localStorage.getItem(TOKEN)).toBeNull();
    expect(sessionStorage.getItem(TOKEN)).toBeNull();
    expect(document.cookie).not.toContain(TOKEN);
    expect(window.location.href).not.toContain(TOKEN);
  });

  it("shows no token again after the page is loaded a second time", async () => {
    await render();
    await click(button("Create connection", card()));
    expect(card().textContent).toContain(TOKEN);

    await act(async () => root.unmount());
    root = createRoot(container);
    await render();
    expect(card().textContent).not.toContain(TOKEN);
    expect(card().querySelector("[data-muse-relay-credentials]")).toBeNull();
  });

  it("rotates the token of one connection", async () => {
    fixture.config = { connections: [{ connectionId: "conn-1", lastSeenAt: null, online: false }], pendingTurns: 0, canManage: true };
    await render();
    await click(button("Rotate token", card()));
    expect(fixture.calls.filter((call) => call.method === "POST")).toEqual([
      { path: "/api/instances/muse-relay/muse-relay/connections/conn-1/rotate", method: "POST" },
    ]);
    expect(card().querySelector("[data-muse-relay-credentials]")!.textContent).toContain(TOKEN);
    expect(card().textContent).toContain("Token rotated");
  });

  it("revokes a connection only after the confirmation", async () => {
    fixture.config = { connections: [{ connectionId: "conn-1", lastSeenAt: null, online: false }], pendingTurns: 0, canManage: true };
    await render();
    await click(button("Revoke", card()));

    const dialog = document.querySelector('[role="alertdialog"]');
    expect(dialog).toBeTruthy();
    expect(fixture.calls.some((call) => call.method === "DELETE")).toBe(false);
    // Cancel is focused, so a stray Enter never revokes.
    expect((document.activeElement as HTMLElement)?.textContent).toBe("Cancel");

    await click(button("Revoke", dialog!));
    expect(fixture.calls.filter((call) => call.method === "DELETE")).toEqual([
      { path: "/api/instances/muse-relay/muse-relay/connections/conn-1", method: "DELETE" },
    ]);
    expect(card().textContent).toContain("Connection revoked");
  });

  it("leaves the connections alone for someone who cannot manage them", async () => {
    fixture.config = { connections: [{ connectionId: "conn-1", lastSeenAt: null, online: false }], pendingTurns: 0, canManage: false };
    await render();
    expect(card().textContent).toContain("You can see these connections but not change them");
    expect(button("Rotate token", card())).toBeUndefined();
    expect(button("Revoke", card())).toBeUndefined();
    expect(button("Create connection", card())).toBeUndefined();
  });

  it("shows a safe message when the connections cannot be read", async () => {
    fixture.failWith = 403;
    await render();
    const alert = card().querySelector("[role='alert']")!;
    expect(alert.textContent).toBe("Your account can't manage these connections.");
    // The server's own words, which can quote what it refused, stay out of the window.
    expect(card().textContent).not.toContain(TOKEN);
    expect(card().textContent).not.toContain("not valid");
  });

  it("names the reason when the setup is not there at all", async () => {
    fixture.failWith = 404;
    await render();
    expect(card().querySelector("[role='alert']")!.textContent).toBe("Couldn't find the Muse setup for this AI.");
  });

  it("says when the app itself had a problem", async () => {
    fixture.failWith = 500;
    await render();
    expect(card().querySelector("[role='alert']")!.textContent).toBe("Something went wrong on the app's side. Try again.");
  });

  it("keeps a long connection id inside its row", async () => {
    const long = "conn-" + "x".repeat(120);
    fixture.config = { connections: [{ connectionId: long, lastSeenAt: null, online: false }], pendingTurns: 0, canManage: true };
    await render();
    const row = card().querySelector("[data-muse-relay-connection]")!;
    const id = row.querySelector("code")!;
    expect(id.textContent).toBe(long);
    expect(id.getAttribute("title")).toBe(long);
    expect(id.className).toContain("truncate");
    expect(row.className).toContain("flex-wrap");
  });

  it("names every action for a screen reader and keeps it a real button", async () => {
    fixture.config = { connections: [{ connectionId: "conn-1", lastSeenAt: null, online: false }], pendingTurns: 0, canManage: true };
    await render();
    const actions = [...card().querySelectorAll("button")];
    expect(actions.length).toBeGreaterThan(0);
    for (const action of actions) {
      expect(action.tagName).toBe("BUTTON");
      expect(action.getAttribute("aria-label") ?? action.textContent).toBeTruthy();
    }
    expect(button("Refresh the connections", card())).toBeTruthy();
  });

  it("reads the connections again on demand", async () => {
    await render();
    await click(button("Refresh the connections", card()));
    expect(fixture.calls.filter((call) => call.method === "GET").length).toBe(2);
  });
});
