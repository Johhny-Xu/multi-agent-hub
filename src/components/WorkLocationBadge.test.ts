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
    expect(workLocationText(facts({ place: "cloud", backend: "vps", instanceName: "instabox" })).label).toBe("Cloud VPS instabox");
    expect(workLocationText(facts({ place: "cloud", backend: "vps" })).label).toBe("Cloud");
  });

  it("says a bot without a computer works locally and is not using one", () => {
    expect(workLocationText(facts({ place: "off" })).label).toBe("Local (no computer)");
  });

  it("says Auto until the server has picked a place", () => {
    expect(workLocationText(facts({ place: "auto" })).label).toBe("Auto");
  });

  it("shows the server's placement reason as the title in Auto mode", () => {
    const auto = workLocationText(facts({ place: "cloud", backend: "vps", instanceName: "instabox", auto: true, reason: "本机 CPU 92%，转云端 VPS instabox" }));
    expect(auto.label).toBe("Cloud VPS instabox · Auto");
    expect(auto.title).toBe("Auto: 本机 CPU 92%，转云端 VPS instabox");
  });

  it("ignores a reason that belongs to a place the person pinned", () => {
    expect(workLocationText(facts({ place: "local", auto: true })).label).toBe("Local · Auto");
    expect(workLocationText(facts({ place: "local", reason: "本机 CPU 92%" })).title).toBe("Where this bot is working now: Local");
  });
});
