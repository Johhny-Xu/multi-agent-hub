// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Bot, InstanceInfo } from "@/state/store";
import { setLocale } from "@/lib/i18n";

const fixture = vi.hoisted(() => ({ state: { instances: [] as InstanceInfo[], bots: [] as Bot[], config: {} as Record<string, unknown> }, posts: [] as Array<{ path: string; body: unknown }> }));
vi.mock("@/state/store", async (original) => ({
  ...await original<typeof import("@/state/store")>(),
  useStore: () => ({
    state: fixture.state,
    dispatch: (action: { type: string; instances?: InstanceInfo[] }) => { if (action.type === "instances" && action.instances) fixture.state = { ...fixture.state, instances: action.instances }; },
    refreshInstances: async () => {}, refreshModels: async () => {},
  }),
  api: async (path: string, init?: { method?: string; body?: string }) => {
    const method = init?.method ?? "GET";
    if (path === "/api/instances/antigravity-accounts" && method === "GET") return { accounts: accountsView() };
    if (path === "/api/instances/antigravity-accounts" && method === "POST") {
      fixture.posts.push({ path, body: init?.body ? JSON.parse(init.body) : undefined });
      const added = google("antigravity-work", "Work", false);
      return { instanceId: added.instanceId, instances: [...fixture.state.instances, added] };
    }
    const removed = /^\/api\/instances\/(antigravity-[\w-]+)$/u.exec(path);
    if (removed && method === "DELETE") {
      fixture.state = { ...fixture.state, instances: fixture.state.instances.filter((instance) => instance.instanceId !== removed[1]) };
      return { instances: fixture.state.instances };
    }
    return {};
  },
}));
import { EnginesSettings } from "./EnginesSettings";

function google(instanceId: string, displayName: string, authenticated: boolean): InstanceInfo {
  return {
    instanceId, driverKind: "antigravityAgent", displayName, cliDefault: "agy",
    snapshot: { state: "available", authenticated }, models: { default: "gemini", options: [] },
    install: { managed: { label: "Install Antigravity", downloadBytes: 1 } },
  } as InstanceInfo;
}

/** The account list the way the server builds it: the primary first, then every added account. */
function accountsView() {
  const rows = fixture.state.instances
    .filter((instance) => instance.driverKind === "antigravityAgent"
      && (instance.instanceId === "antigravity" || instance.instanceId.startsWith("antigravity-")))
    .sort((left, right) => (left.instanceId === "antigravity" ? -1 : right.instanceId === "antigravity" ? 1 : 0))
    .map((instance) => ({
      instanceId: instance.instanceId,
      label: instance.displayName,
      ...(instance.snapshot.authenticated ? { email: `${instance.displayName.toLowerCase().replaceAll(" ", "-")}@example.test` } : {}),
      active: instance.instanceId === "antigravity" && instance.snapshot.authenticated === true,
      removable: instance.instanceId.startsWith("antigravity-"),
    }));
  return { accounts: rows, primaryId: "antigravity" };
}

let container: HTMLDivElement, root: Root;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  setLocale("en");
  fixture.state = { instances: [google("antigravity", "Google Gemini", true)], bots: [], config: {} };
  fixture.posts = [];
  container = document.createElement("div"); document.body.append(container); root = createRoot(container);
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.unstubAllGlobals(); });

const render = async () => { await act(async () => { root.render(createElement(EnginesSettings)); }); };
const button = (label: string) => [...container.querySelectorAll("button")].find((item) => item.textContent === label);
const click = async (target: Element | undefined) => { expect(target).toBeTruthy(); await act(async () => { (target as HTMLElement).click(); }); };
async function addWork() {
  await render();
  await click(button("Add Google account"));
  const input = container.querySelector<HTMLInputElement>("form[data-add-account] input")!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, "Work");
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await click(button("Add and sign in"));
}
// Every Antigravity card carries the list; the assertions look at the primary card's one.
const rows = () => [...container.querySelector('[data-antigravity-accounts="antigravity"]')!.querySelectorAll("[data-antigravity-account]")];

describe("Settings → Google Gemini → Add Google account", () => {
  it("keeps the new account's Google sign-in under the card it was added from", async () => {
    await addWork();
    await render();
    expect(fixture.posts).toEqual([{ path: "/api/instances/antigravity-accounts", body: { displayName: "Work", sourceInstanceId: "antigravity" } }]);
    const added = container.querySelector("[data-antigravity-added]");
    expect(added?.getAttribute("data-antigravity-added")).toBe("antigravity-work");
    expect([...added!.querySelectorAll("button")].map((item) => item.textContent)).toContain("Sign in with Google");
    expect(added!.textContent).toContain("Work");
  });

  it("drops that sign-in from the card once the new account is signed in", async () => {
    await addWork();
    fixture.state = { ...fixture.state, instances: [google("antigravity", "Google Gemini", true), google("antigravity-work", "Work", true)] };
    await render();
    expect(container.querySelector("[data-antigravity-added]")).toBeNull();
  });
});

describe("Settings → Google Gemini → account list", () => {
  it("lists every account with its email, and hides the saved-account copies section", async () => {
    fixture.state = { ...fixture.state, instances: [google("antigravity", "Google Gemini", true), google("antigravity-work", "Work", true)] };
    await render();
    expect(rows().map((row) => row.getAttribute("data-antigravity-account"))).toEqual(["antigravity", "antigravity-work"]);
    expect(rows()[0]!.getAttribute("data-active")).toBeTruthy();
    expect(rows()[0]!.textContent).toContain("google-gemini@example.test");
    expect(rows()[1]!.textContent).toContain("work@example.test");
    // Only the added account can be removed from here; the active one has no buttons at all.
    expect([...rows()[0]!.querySelectorAll("button")]).toEqual([]);
    expect([...rows()[1]!.querySelectorAll("button")].map((item) => item.textContent)).toEqual(["Use", "Remove"]);
    expect(container.querySelector("[data-service-accounts]")).toBeNull();
  });

  it("shows the account as soon as it exists, without a reload", async () => {
    await addWork();
    await render();
    const work = rows().find((row) => row.getAttribute("data-antigravity-account") === "antigravity-work");
    expect(work).toBeTruthy();
    expect(work!.textContent).toContain("Work");
    expect(work!.textContent).not.toContain("@example.test");
  });

  it("removes an added account after its confirmation", async () => {
    fixture.state = { ...fixture.state, instances: [google("antigravity", "Google Gemini", true), google("antigravity-work", "Work", true)] };
    await render();
    await click([...rows()[1]!.querySelectorAll("button")].find((item) => item.textContent === "Remove"));
    const dialog = document.querySelector('[role="alertdialog"]');
    expect(dialog).toBeTruthy();
    await click([...dialog!.querySelectorAll("button")].find((item) => item.textContent === "Remove"));
    expect(rows().map((row) => row.getAttribute("data-antigravity-account"))).toEqual(["antigravity"]);
  });

  it("keeps an account a bot is running on", async () => {
    const busyBot = { id: "bee", threadId: "bee-thread", name: "Bee", modelSelection: { instanceId: "antigravity-work" } } as unknown as Bot;
    fixture.state = { ...fixture.state, instances: [google("antigravity", "Google Gemini", true), google("antigravity-work", "Work", true)], bots: [busyBot] };
    await render();
    const work = rows().find((row) => row.getAttribute("data-antigravity-account") === "antigravity-work")!;
    const remove = [...work.querySelectorAll("button")].find((item) => item.textContent === "Remove") as HTMLButtonElement;
    expect(remove.disabled).toBe(true);
    expect(work.textContent).toContain("1 bot(s)");
  });
});
