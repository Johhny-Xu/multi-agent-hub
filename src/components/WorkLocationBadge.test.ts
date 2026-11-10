import { describe, expect, it } from "vitest";

import { workLocationText, type WorkLocationFacts } from "./WorkLocationBadge";

const facts = (over: Partial<WorkLocationFacts>): WorkLocationFacts => ({
  place: "local",
  backend: "box",
  auto: false,
  ...over,
});

describe("the chat header's work location", () => {
  it("names each place the bot can work in", () => {
    expect(workLocationText(facts({ place: "local" })).label).toBe("Local");
    expect(workLocationText(facts({ place: "vm" })).label).toBe("Virtual machine");
    expect(workLocationText(facts({ place: "browser" })).label).toBe("Browser");
    expect(workLocationText(facts({ place: "cloud" })).label).toBe("Cloud");
  });

  it("names the VPS instance a bot on its own server works on", () => {
    expect(workLocationText(facts({ place: "cloud", backend: "vps", instanceName: "cloud-a" })).label).toBe("Cloud VPS cloud-a");
    expect(workLocationText(facts({ place: "cloud", backend: "vps" })).label).toBe("Cloud");
  });

  it("says a bot without a computer works locally and is not using one", () => {
    expect(workLocationText(facts({ place: "off" })).label).toBe("Local (no computer)");
  });

  it("says Auto until the server has picked a place", () => {
    expect(workLocationText(facts({ place: "auto" })).label).toBe("Auto");
  });

  it("shows the server's placement reason as the title in Auto mode", () => {
    const auto = workLocationText(facts({ place: "cloud", backend: "vps", instanceName: "cloud-a", auto: true, reason: "本机 CPU 92%，转云端 VPS cloud-a" }));
    expect(auto.label).toBe("Cloud VPS cloud-a · Auto");
    expect(auto.title).toBe("Auto: 本机 CPU 92%，转云端 VPS cloud-a");
  });

  it("ignores a reason that belongs to a place the person pinned", () => {
    expect(workLocationText(facts({ place: "local", auto: true })).label).toBe("Local · Auto");
    expect(workLocationText(facts({ place: "local", reason: "本机 CPU 92%" })).title).toBe("Where this bot is working now: Local");
  });
  it("names the machine and browser an Auto browser resolved to (E72)", () => {
    const at = { machine: "cloud-a", browser: "mychrome", reason: "云端优先：cloud-a 最空闲（负载 1%）" };
    const shown = workLocationText(facts({ place: "browser", auto: true, browserAt: at }));
    expect(shown.label).toBe("Browser · cloud-a / mychrome");
    expect(shown.title).toBe("Auto: 云端优先：cloud-a 最空闲（负载 1%）");
    expect(workLocationText(facts({ place: "auto", browserAt: { machine: "本机", browser: "mychrome" } })).label).toBe("Browser · 本机 / mychrome");
    expect(workLocationText(facts({ place: "cloud", backend: "vps", instanceName: "cloud-a", browserAt: at })).label).toBe("Cloud VPS cloud-a");
  });
});
