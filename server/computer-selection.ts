import type { Surface } from "./surface.ts";

export interface ComputerOption {
  surface: Surface;
  available: boolean;
  ready: boolean;
  canStart: boolean;
  canCreate: boolean;
}

/** `startsOnFirstCall`: the turn's first computer call creates or wakes it, so it is this turn's before it is up, and
 * asking for it (or for Auto) keeps it rather than restarting the request elsewhere. */
export function pickComputer<T extends ComputerOption>(
  options: readonly T[],
  requested: Surface | "auto",
  current: string | undefined,
  startsOnFirstCall: boolean,
): { option: T | undefined; current: boolean } {
  const isCurrent = (option: T) => option.surface === current && (option.ready || (startsOnFirstCall && option.available));
  const option = requested === "auto"
    ? options.find(isCurrent)
      ?? options.find((candidate) => candidate.ready && candidate.surface === "vm")
      ?? options.find((candidate) => candidate.ready)
      ?? options.find((candidate) => candidate.canStart)
      ?? options.find((candidate) => candidate.canCreate && candidate.surface === "vm")
      ?? options.find((candidate) => candidate.canCreate)
    : options.find((candidate) => candidate.surface === requested);
  return { option, current: option !== undefined && isCurrent(option) };
}
