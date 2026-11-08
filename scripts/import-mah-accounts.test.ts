import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { importMahAccounts, WORKER_SPECS } from "./import-mah-accounts.ts";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture() {
  const base = mkdtempSync(join(tmpdir(), "import-mah-fixture-"));
  roots.push(base);
  const source = join(base, "source");
  const target = join(base, "target");
  mkdirSync(source, { recursive: true });
  mkdirSync(target, { recursive: true });
  return { base, source, target };
}

describe("importMahAccounts", () => {
  it("performs a dry-run without writing any files", () => {
    const { source, target } = fixture();
    const qoderDir = join(source, "qoder", "Profile-1");
    mkdirSync(qoderDir, { recursive: true });
    writeFileSync(join(qoderDir, "user"), "fake-user");
    writeFileSync(join(qoderDir, "machine_id"), "1234567890123456");
    writeFileSync(join(qoderDir, "meta.json"), JSON.stringify({ display: "Profile One", identity: "id-1" }));
    writeFileSync(join(source, "qoder", ".active"), "Profile-1\n");

    const results = importMahAccounts({ sourceDir: source, targetDir: target, dryRun: true });
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({
      worker: "qoder",
      instanceId: "qoder",
      sourceAccounts: 1,
      existingAccounts: 0,
      addedAccounts: 1,
      activeAccount: expect.any(String),
    });
    expect(results[0]!.accounts[0]).toMatchObject({
      label: "Profile One",
      identity: "id-1",
      status: "added",
    });

    // Target directory must remain empty
    expect(() => statSync(join(target, "qoder"))).toThrow();
  });

  it("imports accounts idempotently and preserves existing IDs", () => {
    const { source, target } = fixture();
    const cbDir = join(source, "codebuddy", "user-a");
    mkdirSync(cbDir, { recursive: true });
    writeFileSync(join(cbDir, "auth.info"), JSON.stringify({ account: { nickname: "Ada" } }));
    writeFileSync(join(cbDir, "meta.json"), JSON.stringify({ display: "Ada", identity: "ada@example.test" }));
    writeFileSync(join(source, "codebuddy", ".active"), "user-a\n");

    const first = importMahAccounts({ sourceDir: source, targetDir: target, dryRun: false });
    expect(first[0]!.addedAccounts).toBe(1);
    const id = first[0]!.accounts[0]!.id;

    const accountDir = join(target, "codebuddy", id);
    expect(statSync(accountDir).mode & 0o777).toBe(0o700);
    expect(statSync(join(accountDir, "auth")).mode & 0o777).toBe(0o600);
    const index = JSON.parse(readFileSync(join(target, "codebuddy", "index.json"), "utf8"));
    expect(index.activeId).toBe(id);
    expect(index.accounts).toHaveLength(1);
    expect(index.accounts[0].label).toBe("Ada");

    // Second run must be idempotent: 0 added, same id, same activeId
    const second = importMahAccounts({ sourceDir: source, targetDir: target, dryRun: false });
    expect(second[0]!.addedAccounts).toBe(0);
    expect(second[0]!.existingAccounts).toBe(1);
    expect(second[0]!.accounts[0]!.id).toBe(id);
    expect(second[0]!.accounts[0]!.status).toBe("existing");
  });

  it("merges new accounts into an existing index without overriding existing accounts", () => {
    const { source, target } = fixture();
    const qoderTarget = join(target, "qoder");
    mkdirSync(join(qoderTarget, "existing-id"), { recursive: true, mode: 0o700 });
    writeFileSync(join(qoderTarget, "existing-id", "user"), "existing-user");
    writeFileSync(join(qoderTarget, "existing-id", "machine_id"), "existing-mid");
    writeFileSync(
      join(qoderTarget, "index.json"),
      JSON.stringify({
        version: 1,
        activeId: "existing-id",
        accounts: [
          {
            id: "existing-id",
            label: "Henry Baker",
            identity: "Henry Baker",
            createdAt: 1000,
            hashes: { user: "u-hash", machine_id: "m-hash" },
          },
        ],
      }),
    );

    // Source contains Henry Baker and Kangsheng Xu
    const henryDir = join(source, "qoder", "Henry");
    mkdirSync(henryDir, { recursive: true });
    writeFileSync(join(henryDir, "user"), "existing-user");
    writeFileSync(join(henryDir, "machine_id"), "existing-mid");
    writeFileSync(join(henryDir, "meta.json"), JSON.stringify({ display: "Henry Baker", identity: "Henry Baker" }));

    const xuDir = join(source, "qoder", "Kangsheng-Xu");
    mkdirSync(xuDir, { recursive: true });
    writeFileSync(join(xuDir, "user"), "xu-user");
    writeFileSync(join(xuDir, "machine_id"), "xu-mid");
    writeFileSync(join(xuDir, "meta.json"), JSON.stringify({ display: "Kangsheng Xu", identity: "Kangsheng Xu" }));

    const res = importMahAccounts({ sourceDir: source, targetDir: target, dryRun: false });
    expect(res[0]!.existingAccounts).toBe(1);
    expect(res[0]!.addedAccounts).toBe(1);
    expect(res[0]!.accounts).toHaveLength(2);
    expect(res[0]!.accounts[0]).toMatchObject({ id: "existing-id", label: "Henry Baker", status: "existing" });
    expect(res[0]!.accounts[1]).toMatchObject({ label: "Kangsheng Xu", status: "added" });

    const updatedIndex = JSON.parse(readFileSync(join(qoderTarget, "index.json"), "utf8"));
    expect(updatedIndex.activeId).toBe("existing-id");
    expect(updatedIndex.accounts).toHaveLength(2);
    expect(updatedIndex.accounts[0].id).toBe("existing-id");
  });

  it("covers all 14 CLIs defined in WORKER_SPECS", () => {
    const expectedClis = [
      "antigravity", "cline", "codearts", "codebuddy", "codebuddy-cn",
      "github-copilot", "meoo", "mimocode", "minimaxcode", "opencode",
      "qoder", "qoder-cn", "traecode", "zcode",
    ];
    for (const cli of expectedClis) {
      expect(WORKER_SPECS).toHaveProperty(cli);
    }
  });
});

describe("safeIdentity", () => {
  it("hides an API key used as identity and keeps ordinary ids", async () => {
    const { safeIdentity } = await import("./import-mah-accounts.ts");
    const hidden = safeIdentity("meoo_ak_FAKEFAKEFAKEFAKEFAKEFAKEFAKE1234");
    expect(hidden).toMatch(/^key:[0-9a-f]{12}$/);
    expect(safeIdentity("sk-abcdef")).toMatch(/^key:/);
    expect(safeIdentity("qoder:01a0b28b-bc2d-7ba4-a536-93fecafc4103")).toBe("qoder:01a0b28b-bc2d-7ba4-a536-93fecafc4103");
    expect(safeIdentity("johhny.xks@gmail.com")).toBe("johhny.xks@gmail.com");
  });
});
