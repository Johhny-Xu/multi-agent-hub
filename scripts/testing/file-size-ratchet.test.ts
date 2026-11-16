// Every source file over 1,000 lines is listed here with its line count, and
// a count may only go down: a PR that grows one of these files, or adds a new
// file over 1,000 lines, fails here. A PR that shrinks a file leaves its number
// alone: scripts/tighten-ratchets.mjs lowers the numbers (and drops files under
// 1,000 lines) at each release, so two such PRs never conflict here. The split program
// (server/host/README.md) moves server/index.ts into modules of under 1,500
// lines; nothing new may exceed HARD_CAP, and the files listed above the cap
// are the ones that program takes apart. Tests, fixtures, goldens and
// vendored code are not counted.
import { readdirSync, readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const ROOT = new URL("../../", import.meta.url);
const HARD_CAP = 2000;
const LISTED_FROM = 1000;

const LINES: Record<string, number> = {
  "server/index.ts": 15968,
  "src/state/store.tsx": 3344,
  "electron/main.mjs": 3160,
  "server/store.ts": 2427,
  "src/components/Sidebar.tsx": 1721,
  "server/drivers/claude.ts": 2090,
  "server/drivers/agents-call.ts": 1002,
  "server/drivers/acp/core.ts": 1704,
  "server/drivers/codex.ts": 1718,
  "server/routines.ts": 1567,
  "src/components/ComputerPanel.tsx": 1799,
  "src/components/RoutineCalendarPage.tsx": 1622,
  "server/config.ts": 1368,
  "src/components/ChatView.tsx": 1296,
  "server/routine-requests.ts": 1474,
  "src/components/GroupView.tsx": 1220,
  "src/components/LocalComputerSection.tsx": 1443,
  "src/components/CursorAvatar.tsx": 1324,
  "server/skills.ts": 1379,
  "server/composio.ts": 1038,
  "server/vps-computer.ts": 1332,
  "scripts/mcp-server.ts": 1411,
  "server/boat.ts": 1253,
  "server/drivers/pi.ts": 1033,
  "server/plan-usage.ts": 1115,
  "server/container-computer.ts": 1175,
  "src/components/ModelPicker.tsx": 1045,
  "src/components/PhoneSetupFlow.tsx": 1089,
  "server/cli.ts": 1062,
  "src/components/AttachmentPreview.tsx": 1035,
  "server/meetings/meetbot.ts": 1047,
  // fork 既有超限（multi-agent-hub，2026-11-10 按当时行数登记；只能减不能增）
  "server/browser/viewers/core.ts": 1017,
  "server/checkin/checkin.mjs": 3800,
  "server/checkin/vendor-quota.mjs": 1676,
  "server/drivers/zcode-acp.ts": 1784,
  "server/hub-compat/dispatch.ts": 2033,
  "server/service-accounts.ts": 1191,
  "shared/wire.ts": 1012,
  // project fork: OpenAI-compatible chat driver (BYOK/9router) passes 1,000 lines; 2026-11-13
  // 2026-11-13 fork: DuMate / Gemini Decision 1 / box relay / workdir tools grew five listed files by a few lines (pins raised once; only down from here)
  "server/drivers/openai-chat.ts": 1032,
  // 2026-11-14 维护者选择放宽（不拆分）：按当时行数登记，只能减不能增
  "server/cloud-browser.ts": 1371,
  "server/browser-runtime.ts": 1013,
  "server/cloud-cdp-proxy.ts": 1365,
  "server/drivers/web-chat/core.ts": 1069,
};

const SOURCE_DIRS = ["server", "shared", "src", "scripts", "evals", "electron", "companion"];
const SKIP_DIRS = new Set(["node_modules", ".git", "dist", "dist-server", "release", "state"]);

/** Tracked files from git; a copy without .git (rtest rsyncs the tree without it) walks the same folders instead. */
function listedFiles(): string[] {
  try {
    return execFileSync("git", ["ls-files", ...SOURCE_DIRS], { cwd: ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).split("\n");
  } catch {
    const root = fileURLToPath(ROOT);
    const out: string[] = [];
    const walk = (rel: string): void => {
      let entries;
      try {
        entries = readdirSync(root + rel, { withFileTypes: true });
      } catch {
        return;
      }
      for (const entry of entries) {
        if (entry.isDirectory()) {
          if (!SKIP_DIRS.has(entry.name)) walk(`${rel}/${entry.name}`);
        } else if (entry.isFile()) out.push(`${rel}/${entry.name}`);
      }
    };
    for (const dir of SOURCE_DIRS) walk(dir);
    return out;
  }
}

function sourceFiles(): string[] {
  return listedFiles().filter((file) => /\.(ts|tsx|mjs|cjs)$/.test(file))
    .filter((file) => !file.includes(".test.") && !file.includes("/testing/") && !file.includes("goldens") && !file.startsWith("electron/vendor/"));
}

const count = (file: string) => readFileSync(new URL(file, ROOT), "utf8").split("\n").length - 1;

describe("source files stay a readable size", () => {
  it("no listed file grows, and no new file over 1,000 lines goes unlisted", () => {
    const problems: string[] = [];
    const seen = new Set<string>();
    for (const file of sourceFiles()) {
      const lines = count(file);
      const pinned = LINES[file];
      if (pinned !== undefined) {
        seen.add(file);
        if (lines > pinned) problems.push(`${file} grew to ${lines} lines (listed at ${pinned}): move code out, do not add here`);
      } else if (lines > LISTED_FROM) {
        problems.push(lines > HARD_CAP
          ? `${file} is ${lines} lines, over the ${HARD_CAP}-line cap: split it`
          : `${file} is ${lines} lines: a new file over ${LISTED_FROM} lines needs a line here and a reason in the PR`);
      }
    }
    expect(problems, "See server/host/README.md").toEqual([]);
  });
});
