import { mkdtempSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { perchProjectMcpConfig } from "./perch.ts";

const read = (dir: string) => JSON.parse(readFileSync(join(dir, ".perch", "mcp.json"), "utf-8"));

describe("perchProjectMcpConfig (E63)", () => {
  it("writes the turn's servers into the folder's .perch/mcp.json", () => {
    const dir = mkdtempSync(join(tmpdir(), "perch-mcp-"));
    perchProjectMcpConfig(dir, [
      { name: "computer", command: "node", args: ["proxy.js"], env: [{ name: "A", value: "1" }] },
      { type: "http", name: "web", url: "http://127.0.0.1:1/mcp", headers: [{ name: "X", value: "y" }] },
    ]);
    expect(read(dir).servers).toEqual({
      computer: { type: "stdio", command: "node", args: ["proxy.js"], env: { A: "1" } },
      web: { type: "http", url: "http://127.0.0.1:1/mcp", headers: { X: "y" } },
    });
  });

  it("keeps the person's own servers and drops ones OpenMausBot no longer sends", () => {
    const dir = mkdtempSync(join(tmpdir(), "perch-mcp-"));
    mkdirSync(join(dir, ".perch"));
    writeFileSync(join(dir, ".perch", "mcp.json"), JSON.stringify({ servers: { mine: { type: "stdio", command: "x", args: [] } } }));
    perchProjectMcpConfig(dir, [{ name: "computer", command: "node", args: [], env: [] }]);
    perchProjectMcpConfig(dir, [{ name: "browser", command: "node", args: [], env: [] }]);
    expect(Object.keys(read(dir).servers).sort()).toEqual(["browser", "mine"]);
  });

  it("leaves a folder alone when there is nothing to mount", () => {
    const dir = mkdtempSync(join(tmpdir(), "perch-mcp-"));
    perchProjectMcpConfig(dir, []);
    expect(() => readFileSync(join(dir, ".perch", "mcp.json"))).toThrow();
  });
});
