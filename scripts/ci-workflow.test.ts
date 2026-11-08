import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

const workflows = new URL("../.github/workflows/", import.meta.url);
const readWorkflow = (name: string) => parse(readFileSync(new URL(name, workflows), "utf8"));

type Step = { name?: string; run?: string; uses?: string; with?: Record<string, unknown>; env?: Record<string, string> };
type Job = { "runs-on"?: string; steps?: Step[]; needs?: string | string[]; permissions?: Record<string, string> };

const ci = readWorkflow("ci.yml");
const release = readWorkflow("release.yml");

const stepsOf = (workflow: { jobs: Record<string, Job> }) =>
  Object.values(workflow.jobs).flatMap((job) => job.steps ?? []);
const usesOf = (workflow: { jobs: Record<string, Job> }) =>
  stepsOf(workflow).flatMap((step) => (step.uses && !step.uses.startsWith("./") ? [step.uses] : []));

describe("Workflows", () => {
  it("pins every external action to a full commit SHA", () => {
    for (const workflow of [ci, release]) {
      const uses = usesOf(workflow);
      expect(uses.length).toBeGreaterThan(0);
      for (const action of uses) expect(action).toMatch(/^[\w.-]+\/[\w./-]+@[0-9a-f]{40}$/);
    }
  });

  it("holds no secret but the workflow's own GITHUB_TOKEN, and no plaintext token", () => {
    const secretRefs = (name: string) => [...readFileSync(new URL(name, workflows), "utf8").matchAll(/secrets\.\w+/g)].map((match) => match[0]);
    expect(secretRefs("ci.yml")).toEqual([]);
    expect(secretRefs("release.yml").length).toBeGreaterThan(0);
    expect(new Set(secretRefs("release.yml"))).toEqual(new Set(["secrets.GITHUB_TOKEN"]));
    for (const name of ["ci.yml", "release.yml"]) {
      const text = readFileSync(new URL(name, workflows), "utf8");
      expect(text, name).not.toMatch(/ghp_[A-Za-z0-9]|github_pat_[A-Za-z0-9]|AKIA[0-9A-Z]{16}|xox[baprs]-/);
    }
  });
});

describe("CI workflow", () => {
  it("runs on pull requests and pushes to main, and nothing else", () => {
    expect(ci.on).toEqual({ pull_request: null, push: { branches: ["main"] } });
  });

  it("runs read-only and supersedes a PR's old runs without cancelling a running main push", () => {
    expect(ci.permissions).toEqual({ contents: "read" });
    expect(ci.concurrency["cancel-in-progress"]).toBe("${{ github.event_name == 'pull_request' }}");
    expect(ci.concurrency.group).toContain("format('pr-{0}', github.event.pull_request.number)");
    expect(ci.concurrency.group).toContain("github.ref");
  });

  it("runs targeted unit tests, never a full typecheck or the full suite", () => {
    // A bare `pnpm exec vitest run` would pull in this repository's whole
    // suite, and `pnpm typecheck` type-builds every project, so the job's
    // test step must name its files.
    const steps = ci.jobs.unit.steps as Step[];
    const run = steps.find((step) => step.name === "Targeted unit tests")!;
    expect(run.run).toContain("pnpm exec vitest run ");
    const files = run.run!.replace("pnpm exec vitest run ", "").trim().split(/\s+/);
    expect(files.length).toBeGreaterThan(0);
    for (const file of files) expect(existsSync(new URL(`../${file}`, import.meta.url)), file).toBe(true);
    for (const step of steps) {
      if (step.run) expect(step.run).not.toMatch(/pnpm typecheck|tsc -b|pnpm test\b|pnpm test:/);
    }
  });
});

describe("Release workflow", () => {
  it("publishes on a v* tag push and nothing else", () => {
    expect(release.on).toEqual({ push: { tags: ["v*"] } });
  });

  it("builds the Linux and Windows packages, and never a macOS artifact", () => {
    const jobs = release.jobs as Record<string, Job>;
    expect(Object.keys(jobs).sort()).toEqual(["linux", "release", "windows"]);
    expect(jobs.linux["runs-on"]).toBe("ubuntu-latest");
    expect(jobs.windows["runs-on"]).toBe("windows-latest");
    expect(release.jobs.release.needs).toEqual(["linux", "windows"]);
    for (const step of [...jobs.linux.steps!, ...jobs.windows.steps!, ...jobs.release.steps!]) {
      if (step.run) expect(step.run).not.toMatch(/--mac\b|package:mac/);
    }
  });

  it("uploads both platforms' installers and updater feeds, and fails when one is missing", () => {
    const jobs = release.jobs as Record<string, Job>;
    const paths = (job: string) => {
      const step = jobs[job].steps!.find((step) => step.uses?.startsWith("actions/upload-artifact@"))!;
      expect(step.with!["if-no-files-found"]).toBe("error");
      return (step.with!.path as string).split("\n").map((line) => line.trim()).filter(Boolean);
    };
    expect(paths("linux")).toEqual(["release/*.AppImage", "release/*.deb", "release/latest-linux.yml", "release/*.blockmap"]);
    expect(paths("windows")).toEqual(["release/*.exe", "release/*.zip", "release/latest.yml", "release/*.blockmap"]);
    const download = jobs.release.steps!.find((step) => step.uses?.startsWith("actions/download-artifact@"))!;
    expect(download.with).toMatchObject({ path: "artifacts", "merge-multiple": true });
    const present = jobs.release.steps!.find((step) => step.name === "Check the updater feeds and installers are present")!;
    for (const pattern of ["*.AppImage", "*.deb", "latest-linux.yml", "*-setup.exe", "latest.yml"]) {
      expect(present.run, pattern).toContain(`'${pattern}'`);
    }
  });

  it("rejects a tag that does not match package.json's version, before any install", () => {
    const { version } = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version: string };
    const jobs = release.jobs as Record<string, Job>;
    for (const job of ["linux", "windows"]) {
      const order = jobs[job].steps!.map((step) => step.name);
      expect(order.indexOf("Check the tag matches package.json")).toBeLessThan(order.indexOf("Install dependencies"));
      const run = jobs[job].steps!.find((step) => step.name === "Check the tag matches package.json")!.run!;
      const script = run.match(/node -e '([\s\S]+)'/)![1];
      // Execute the actual guard, not a duplicate of its check.
      const check = (tag: string) => spawnSync(process.execPath, ["-e", script], {
        env: { ...process.env, GITHUB_REF_NAME: tag }, encoding: "utf8", timeout: 5_000,
      });
      expect(check(`v${version}`).status).toBe(0);
      expect(check("v0.0.0-wrong").status).not.toBe(0);
    }
  });

  it("keeps the build jobs read-only and gives write access to the publish job alone", () => {
    expect(release.permissions).toEqual({ contents: "read" });
    expect((release.jobs.release as Job).permissions).toEqual({ contents: "write" });
    for (const job of ["linux", "windows"]) expect((release.jobs as Record<string, Job>)[job].permissions).toBeUndefined();
  });

  it("publishes the tag's release in this repository with gh and GITHUB_TOKEN", () => {
    const publish = (release.jobs.release as Job).steps!.find((step) => step.name === "Publish the tag's release with GITHUB_TOKEN")!;
    expect(publish.env).toMatchObject({ GH_TOKEN: "${{ secrets.GITHUB_TOKEN }}", GH_REPO: "${{ github.repository }}" });
    expect(publish.run).toContain('gh release create "${tag}" artifacts/* --verify-tag');
    expect(publish.run).toContain('gh release upload "${tag}" artifacts/* --clobber');
  });
});
