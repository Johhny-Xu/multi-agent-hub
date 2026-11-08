import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";

import en from "@/locales/en.json";

const fixture = vi.hoisted(() => ({ config: null as unknown }));
vi.mock("@/state/store", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/state/store")>();
  return { ...original, useStore: () => ({ state: { ...original.initialState, config: fixture.config }, dispatch: vi.fn() }) };
});

const { CloudBackendPicker } = await import("./CloudBackendPicker");
const picker = (value: "box" | "vps" = "box") => renderToStaticMarkup(createElement(CloudBackendPicker, { value, onChange: () => {} }));

describe("CloudBackendPicker", () => {
  afterEach(() => { fixture.config = null; });

  it("offers Boat or a self-hosted VPS on a desktop or self-hosted server", () => {
    fixture.config = { cloudHome: false };
    expect(picker()).toContain("Self-hosted VPS");
  });

  it("is hidden on My Cloud", () => {
    fixture.config = { cloudHome: true };
    expect(picker()).toBe("");
  });

  it.each(["box", "vps"] as const)("offers both backends whichever is chosen (%s)", (value) => {
    const markup = picker(value);
    expect(markup).toContain("Boat");
    expect(markup).toContain("Self-hosted VPS");
    expect(markup).not.toContain("disabled");
    expect(markup).not.toMatch(/ACP model provider/);
  });

  it("leaves no message that tells someone to switch backends for an engine", () => {
    expect(Object.keys(en)).not.toContain("computer.err.vpsEngine");
    expect(Object.values(en).filter((value) => /switch the cloud backend to Boat/i.test(value))).toEqual([]);
  });
});

describe("CloudBackendPicker with instances", () => {
  afterEach(() => { fixture.config = null; });

  const instanceView = (id: string, name: string) => ({
    id, name, kind: "ssh" as const, configured: true, available: null,
    capabilities: { status: true, join: true, screenshot: true, start: true, stop: true, remove: true },
  });

  it("saves a backend and instance together", async () => {
    const { vpsPickerSelection } = await import("./CloudBackendPicker");
    expect(vpsPickerSelection("vps", "alpha")).toEqual({ backend: "vps", instanceId: "alpha" });
    expect(vpsPickerSelection("vps", undefined, "alpha")).toEqual({ backend: "vps", instanceId: "alpha" });
    expect(vpsPickerSelection("box", "alpha")).toEqual({ backend: "box" });
  });

  it("takes the newly marked default after the default instance switches", async () => {
    const { vpsPickerDefaultId, vpsPickerSelection } = await import("./CloudBackendPicker");
    const instances = [instanceView("alpha", "Alpha"), instanceView("beta", "Beta")];
    expect(vpsPickerDefaultId(instances, "beta")).toBe("beta");
    expect(vpsPickerSelection("vps", undefined, vpsPickerDefaultId(instances, "beta")))
      .toEqual({ backend: "vps", instanceId: "beta" });
  });

  it("falls back to the first listed instance when none is marked default", async () => {
    const { vpsPickerDefaultId } = await import("./CloudBackendPicker");
    expect(vpsPickerDefaultId([instanceView("beta", "Beta"), instanceView("alpha", "Alpha")], undefined)).toBe("beta");
    expect(vpsPickerDefaultId([], undefined)).toBeUndefined();
  });

  it("shows a missing selected instance without selecting the first", () => {
    fixture.config = {
      cloudHome: false,
      vps: {
        revision: "r",
        instances: [
          { id: "alpha", name: "Alpha", kind: "ssh", configured: true, available: null, capabilities: { status: true, join: true, screenshot: true, start: true, stop: true, remove: true } },
        ],
      },
    };
    const markup = renderToStaticMarkup(createElement(CloudBackendPicker, { value: "vps", instanceId: "gone", onChange: () => {} }));
    expect(markup).toContain("no longer available");
    expect(markup).toMatch(/<option[^>]*value="gone"[^>]*selected/);
  });

  it("coexists Boat and VPS instances side-by-side in options when both are available", () => {
    fixture.config = {
      cloudHome: false,
      box: { configured: true },
      vps: {
        revision: "r",
        instances: [
          { id: "alpha", name: "Alpha", kind: "ssh", configured: true, available: null, capabilities: { status: true, join: true, screenshot: true, start: true, stop: true, remove: true } },
          { id: "sim-1", name: "Simular Box", kind: "mcp", configured: true, available: null, capabilities: { status: true, join: false, screenshot: true, start: true, stop: true, remove: false } },
        ],
      },
    };
    const markup = renderToStaticMarkup(createElement(CloudBackendPicker, { value: "box", onChange: () => {} }));
    expect(markup).toContain("Boat");
    expect(markup).toContain("Alpha");
    expect(markup).toContain("Simular Box · simular-box");
  });

  it("lists VPS instances without requiring Boat when Boat is absent", () => {
    fixture.config = {
      cloudHome: false,
      box: { configured: false },
      vps: {
        revision: "r",
        instances: [
          { id: "alpha", name: "Alpha", kind: "ssh", configured: true, available: null, capabilities: { status: true, join: true, screenshot: true, start: true, stop: true, remove: true } },
        ],
      },
    };
    const markup = renderToStaticMarkup(createElement(CloudBackendPicker, { value: "vps", instanceId: "alpha", onChange: () => {} }));
    expect(markup).toContain("Alpha");
    expect(markup).not.toContain("disabled");
  });
});
