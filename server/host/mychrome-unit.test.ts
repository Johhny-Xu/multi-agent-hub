import { describe, expect, it } from "vitest";

import { MyChromeUnit } from "./mychrome-unit.ts";

describe("the on-demand My Chrome unit", () => {
  it("serves only this host's CDP port 9333", () => {
    const unit = new MyChromeUnit({}, () => {});
    expect(unit.serves("http://127.0.0.1:9333")).toBe(true);
    expect(unit.serves("ws://localhost:9333/devtools/browser/x")).toBe(true);
    expect(unit.serves("http://127.0.0.1:9343")).toBe(false);
    expect(unit.serves("http://10.0.0.2:9333")).toBe(false);
    expect(unit.serves(undefined)).toBe(false);
  });

  it("is off with OMB_MYCHROME_UNIT=off, and ensure then starts nothing", async () => {
    const unit = new MyChromeUnit({ OMB_MYCHROME_UNIT: "off" }, () => {});
    expect(unit.enabled).toBe(false);
    await expect(unit.ensure()).resolves.toBe(true);
  });

  it("never stops a Chrome no bot used, nor one a busy turn holds", async () => {
    const unit = new MyChromeUnit({ OMB_MYCHROME_IDLE_MIN: "0.00001" }, () => {});
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(await unit.tick()).toBe(false);
    unit.addBusy(() => true);
    unit.touch();
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(await unit.tick()).toBe(false);
  });

  it("never stops with OMB_MYCHROME_IDLE_MIN=0", async () => {
    const unit = new MyChromeUnit({ OMB_MYCHROME_IDLE_MIN: "0" }, () => {});
    unit.touch();
    expect(await unit.tick()).toBe(false);
  });
});
