import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { createVpsStatusStore } from "./vps-status.ts";

describe("VPS check status store", () => {
  it("remembers the last check of each computer", () => {
    const store = createVpsStatusStore();
    store.set("alpha", { online: true, latencyMs: 42, checkedAt: "2026-11-08T10:00:00.000Z" });
    store.set("beta", { online: false, checkedAt: "2026-11-08T10:01:00.000Z", error: "The computer did not answer." });
    expect(store.get("alpha")).toEqual({ online: true, latencyMs: 42, checkedAt: "2026-11-08T10:00:00.000Z" });
    expect(store.get("beta")).toMatchObject({ online: false, error: "The computer did not answer." });
    expect(store.get("ghost")).toBeUndefined();
  });

  it("keeps the answer between restarts", () => {
    const file = join(mkdtempSync(join(tmpdir(), "omb-vps-status-")), "vps-status.json");
    createVpsStatusStore(file).set("alpha", { online: true, latencyMs: 7, checkedAt: "2026-11-08T10:00:00.000Z" });
    expect(createVpsStatusStore(file).get("alpha")).toEqual({ online: true, latencyMs: 7, checkedAt: "2026-11-08T10:00:00.000Z" });
  });

  it("never writes a secret into the remembered answer", () => {
    const file = join(mkdtempSync(join(tmpdir(), "omb-vps-status-")), "vps-status.json");
    const store = createVpsStatusStore(file);
    const remembered = store.set("alpha", {
      online: false,
      checkedAt: "2026-11-08T10:00:00.000Z",
      error: "ssh: Authorization: Bearer fake-token-value-0000 failed",
    });
    expect(remembered.error).not.toContain("fake-token-value-0000");
    expect(readFileSync(file, "utf8")).not.toContain("fake-token-value-0000");
  });

  it("forgets a computer that is no longer listed", () => {
    const store = createVpsStatusStore();
    store.set("alpha", { online: true, checkedAt: "2026-11-08T10:00:00.000Z" });
    store.set("beta", { online: true, checkedAt: "2026-11-08T10:00:00.000Z" });
    store.prune(["alpha"]);
    expect(store.get("alpha")).toBeDefined();
    expect(store.get("beta")).toBeUndefined();
  });

  it("reads no memory from a file that is not there", () => {
    const file = join(mkdtempSync(join(tmpdir(), "omb-vps-status-")), "vps-status.json");
    const store = createVpsStatusStore(file);
    store.set("alpha", { online: true, checkedAt: "2026-11-08T10:00:00.000Z" });
    expect(createVpsStatusStore(file).get("alpha")).toBeDefined();
    expect(createVpsStatusStore(join(file, "missing.json")).get("alpha")).toBeUndefined();
  });
});
