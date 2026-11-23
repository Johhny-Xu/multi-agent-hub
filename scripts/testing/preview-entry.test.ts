// The four preview entries are the app's isolated verification pages. A missing export or module makes the page a test
// opens never start, and a text check cannot see that, so this builds them through the project's own Vite config.
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { build } from "vite";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const ENTRIES = [
  "scripts/testing/threads-preview.tsx",
  "scripts/testing/sidebar-groups-preview.tsx",
  "scripts/testing/team-access-preview.tsx",
  "scripts/testing/lend-automatically-preview.tsx",
];

describe("preview entries", () => {
  it("builds all four through the project's Vite config, in memory", async () => {
    const result = await build({
      root: ROOT,
      configFile: fileURLToPath(new URL("../../vite.config.ts", import.meta.url)),
      logLevel: "silent",
      build: {
        write: false,
        // The test proves every import resolves and bundles; minifying the whole app would only add minutes.
        minify: false,
        cssMinify: false,
        reportCompressedSize: false,
        rollupOptions: {
          input: Object.fromEntries(ENTRIES.map((file) => [file.split("/").pop()!.replace(/\.tsx$/, ""), fileURLToPath(new URL(`../../${file}`, import.meta.url))])),
        },
      },
    });
    const outputs = Array.isArray(result) ? result : [result];
    const chunks = outputs.flatMap((output) => ("output" in output ? output.output : []));
    expect(chunks.length, "the four entries bundle").toBeGreaterThan(0);
  }, 600_000);
});
