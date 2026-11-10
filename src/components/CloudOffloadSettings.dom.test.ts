// @vitest-environment happy-dom
import { createElement } from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setLocale } from "@/lib/i18n";
import type { ConfigStatus } from "@/state/store";

type CloudOffload = NonNullable<ConfigStatus["cloudOffload"]>;

const fx = vi.hoisted(() => ({
  puts: [] as Array<{ path: string; body: { cloudOffload?: CloudOffload } }>,
  config: {} as Pick<ConfigStatus, "cloudOffload">,
}));
vi.mock("@/state/store", () => ({
  api: async (path: string, init: { body: string }) => {
    const body = JSON.parse(init.body) as { cloudOffload?: CloudOffload };
    fx.puts.push({ path, body });
    return { cloudOffload: body.cloudOffload };
  },
  useStore: () => ({ state: { config: fx.config }, dispatch: () => {} }),
}));
import { CloudOffloadSettings } from "./CloudOffloadSettings";

let container: HTMLDivElement, root: Root;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  setLocale("en");
  fx.puts = [];
  fx.config = { cloudOffload: { enabled: true, guard: true, authDomains: [] } };
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.unstubAllGlobals(); });

const show = async () => { await act(async () => { root.render(createElement(CloudOffloadSettings)); }); };
const settle = async () => { for (let i = 0; i < 6; i++) await act(async () => { await Promise.resolve(); }); };
const toggle = (id: string) => container.querySelector<HTMLButtonElement>(`#${id}`)!;
const domains = () => container.querySelector<HTMLTextAreaElement>("#cloud-offload-auth-domains")!;
const saveButton = () => [...container.querySelectorAll("button")].find(button => button.textContent === "Save")!;
const click = async (target: Element) => { await act(async () => { (target as HTMLElement).click(); }); await settle(); };
const write = async (value: string) => {
  const box = domains();
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(box, value);
    box.dispatchEvent(new Event("input", { bubbles: true }));
  });
};

describe("CloudOffloadSettings", () => {
  it("renders nothing when the server sends no cloudOffload section", async () => {
    fx.config = {};
    await show();
    expect(container.textContent).toBe("");
  });

  it("saves the whole section, with the cloud browser off, when the first switch is clicked", async () => {
    fx.config = { cloudOffload: { enabled: true, guard: true, authDomains: ["x.com"] } };
    await show();
    await click(toggle("cloud-offload-enabled"));
    expect(fx.puts).toEqual([{ path: "/api/config", body: { cloudOffload: { enabled: false, guard: true, authDomains: ["x.com"] } } }]);
  });

  it("keeps the guard switch disabled while the cloud browser is off, and saves nothing from it", async () => {
    fx.config = { cloudOffload: { enabled: false, guard: true, authDomains: [] } };
    await show();
    expect(toggle("cloud-offload-guard").disabled).toBe(true);
    await click(toggle("cloud-offload-guard"));
    expect(fx.puts).toEqual([]);
  });

  it("saves the domains trimmed, lower-cased, without a scheme, a path or repeats", async () => {
    fx.config = { cloudOffload: { enabled: true, guard: false, authDomains: ["github.com"] } };
    await show();
    await write(" https://GitHub.com/login \n\n x.com \n x.com");
    await click(saveButton());
    expect(fx.puts).toEqual([{ path: "/api/config", body: { cloudOffload: { enabled: true, guard: false, authDomains: ["github.com", "x.com"] } } }]);
  });

  it("saves the domains when the box loses focus", async () => {
    fx.config = { cloudOffload: { enabled: true, guard: false, authDomains: [] } };
    await show();
    await write(" Example.COM/a ");
    await act(async () => { domains().dispatchEvent(new FocusEvent("focusout", { bubbles: true })); });
    await settle();
    expect(fx.puts).toEqual([{ path: "/api/config", body: { cloudOffload: { enabled: true, guard: false, authDomains: ["example.com"] } } }]);
  });

  it("shows an alert for a line that is not a domain and saves nothing", async () => {
    fx.config = { cloudOffload: { enabled: true, guard: true, authDomains: [] } };
    await show();
    await write("not a domain");
    await click(saveButton());
    expect(container.querySelector("[role='alert']")?.textContent).toBe("Not a valid domain: not a domain");
    expect(fx.puts).toEqual([]);
  });
});
