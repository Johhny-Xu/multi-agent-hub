import { describe, expect, it } from "vitest";
import { localBuildRefusal } from "./no-local-build.ts";

describe("no-local-build guard", () => {
  it("refuses vite build when the marker file exists", () => {
    const reason = localBuildRefusal({ command: "build", markerExists: true });
    expect(reason).toContain("本机禁止 vite build");
    expect(reason).toContain("scripts/remote-build.sh");
  });

  it("refuses vite build when OMB_NO_LOCAL_BUILD=1", () => {
    expect(localBuildRefusal({ command: "build", markerExists: false, envFlag: "1" })).toContain("本机禁止 vite build");
  });

  it("allows vite build on hosts that did not opt out", () => {
    expect(localBuildRefusal({ command: "build", markerExists: false })).toBeNull();
    expect(localBuildRefusal({ command: "build", markerExists: false, envFlag: "0" })).toBeNull();
  });

  it("allows serve (vite dev / vitest) even with the marker", () => {
    expect(localBuildRefusal({ command: "serve", markerExists: true, envFlag: "1" })).toBeNull();
  });
});
