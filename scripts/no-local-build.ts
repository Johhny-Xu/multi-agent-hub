import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/** Hosts that must never run `vite build` themselves create this marker (or set OMB_NO_LOCAL_BUILD=1). */
export const NO_LOCAL_BUILD_MARKER = ".config/omb-no-local-build";

export interface LocalBuildCheckInput {
  command: string;
  markerExists: boolean;
  envFlag?: string;
}

/** Refuses `vite build` on a host that opted out (marker file or env flag) so it cannot exhaust that host's memory. */
export function localBuildRefusal(input: LocalBuildCheckInput): string | null {
  if (input.command !== "build") return null;
  if (!input.markerExists && input.envFlag !== "1") return null;
  return "本机禁止 vite build（会内存耗尽死机），请用 scripts/remote-build.sh 在远端构建";
}

export function assertNoLocalBuild(command: string): void {
  const reason = localBuildRefusal({
    command,
    markerExists: existsSync(join(homedir(), NO_LOCAL_BUILD_MARKER)),
    envFlag: process.env.OMB_NO_LOCAL_BUILD,
  });
  if (reason) throw new Error(reason);
}
