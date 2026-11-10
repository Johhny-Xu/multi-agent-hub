import type { Surface } from "./surface.ts";

export interface ComputerOption {
  surface: Surface;
  available: boolean;
  ready: boolean;
  canStart: boolean;
  canCreate: boolean;
}

/** The place a person chose for this conversation: their own pin in it, else the bot's Works on. A pin a turn made on
 * its own is not a choice, and Auto or Off chooses no place. */
export function chosenPlace(task: { surface?: Surface; surfaceSource?: "user" | "auto" } | undefined, worksOn: string | undefined): Surface | undefined {
  if (task?.surface && task.surfaceSource !== "auto") return task.surface;
  return worksOn === "cloud" || worksOn === "vm" || worksOn === "local" || worksOn === "browser" ? worksOn : undefined;
}

/** What the host-load sampler found, in the words the decision is reported with. */
export interface PlacementLoad {
  pressure: "low" | "high";
  reason: string;
  /** The configured cloud backend, for the reason: "VPS cloud-a", "桌面". */
  cloudName?: string;
}

const PLACEMENT_LABEL: Record<Surface, string> = { local: "本地", vm: "本地虚拟机", cloud: "云端", browser: "内置浏览器" };

/** `startsOnFirstCall`: the turn's first computer call creates or wakes it, so it is this turn's before it is up, and
 * asking for it (or for Auto) keeps it rather than restarting the request elsewhere.
 * `chosen`: the place the person chose. Auto keeps it whenever it can be had, up or not, so a bot never moves their work
 * to another computer on its own; only a request naming another place moves it. Otherwise a private desktop that is set
 * up (up, stopped, or recreatable on this device) comes before waking or creating a cloud computer.
 * `placement`: the host's load this turn, applied only on Auto with no chosen place: low keeps work here, high sends it
 * to a ready or creatable cloud computer, and a cloud that cannot be had leaves it here. */
export function pickComputer<T extends ComputerOption>(
  options: readonly T[],
  requested: Surface | "auto",
  current: string | undefined,
  startsOnFirstCall: boolean,
  chosen?: Surface,
  placement?: PlacementLoad,
): { option: T | undefined; current: boolean; placementReason?: string } {
  const isCurrent = (option: T) => option.surface === current && (option.ready || (startsOnFirstCall && option.available));
  const kept = chosen === undefined ? undefined : options.find((candidate) => candidate.surface === chosen && candidate.available);
  const fromLoad = placement !== undefined && requested === "auto" && chosen === undefined;
  const preferred = fromLoad && placement.pressure === "low"
    ? options.find((candidate) => candidate.surface === "local" && candidate.available)
    : fromLoad && placement.pressure === "high"
      ? options.find((candidate) => candidate.surface === "cloud" && (candidate.ready || candidate.available))
      : undefined;
  const option = requested !== "auto" ? options.find((candidate) => candidate.surface === requested)
    : kept ?? preferred ?? options.find(isCurrent)
      ?? options.find((candidate) => candidate.ready && candidate.surface === "vm")
      ?? options.find((candidate) => candidate.ready)
      ?? options.find((candidate) => candidate.available && candidate.surface === "vm")
      ?? options.find((candidate) => candidate.canStart)
      ?? options.find((candidate) => candidate.canCreate);
  return { option, current: option !== undefined && isCurrent(option), ...(placementReason(option, fromLoad, placement)) };
}

function placementReason(option: ComputerOption | undefined, fromLoad: boolean, placement?: PlacementLoad): { placementReason?: string } {
  if (!fromLoad || !placement || !option) return {};
  if (placement.pressure === "high") {
    if (option.surface === "cloud") return { placementReason: `${placement.reason}，转云端${placement.cloudName ? ` ${placement.cloudName}` : ""}` };
    if (option.surface === "local") return { placementReason: `${placement.reason}，云端不可用，留在本地` };
    return { placementReason: `${placement.reason}，云端不可用，用${PLACEMENT_LABEL[option.surface]}` };
  }
  if (option.surface === "local") return { placementReason: `${placement.reason}，留在本地` };
  return { placementReason: `${placement.reason}，本机不可用，用${PLACEMENT_LABEL[option.surface]}` };
}
