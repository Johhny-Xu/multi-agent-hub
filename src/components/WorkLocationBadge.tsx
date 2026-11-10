import { cn } from "@/lib/cn";
import { t } from "@/lib/i18n";
import { effectivePlace, type EffectivePlace } from "@/lib/place";
import { useStore, type Bot, type Task } from "@/state/store";
import { PlaceIcon } from "./PlaceIcon";

export interface WorkLocationFacts {
  place: EffectivePlace;
  backend: "box" | "vps";
  instanceName?: string;
  auto: boolean;
  reason?: string | null;
  /** The machine and browser an Auto browser actually ran on (E72): "cloud-a" / "mychrome". */
  browserAt?: { machine: string; browser: string; reason?: string } | null;
}

export function workLocationText(facts: WorkLocationFacts): { label: string; title: string } {
  const label = facts.place === "off"
    ? t("workLocation.off")
    : facts.place === "auto"
      ? t("workLocation.auto")
      : facts.place === "cloud"
        ? facts.backend === "vps" && facts.instanceName
          ? t("workLocation.vps", { name: facts.instanceName })
          : t("workLocation.cloud")
        : facts.place === "vm"
          ? t("workLocation.vm")
          : facts.place === "browser"
            ? t("workLocation.browser")
            : t("workLocation.local");
  // An Auto browser names the machine and browser it resolved to (E72), not just "Auto".
  const at = facts.browserAt && (facts.place === "browser" || facts.place === "auto") ? facts.browserAt : null;
  if (at) {
    const shown = t("workLocation.browserAt", { where: `${at.machine} / ${at.browser}` });
    const title = at.reason ? t("workLocation.autoReason", { reason: at.reason }) : t("workLocation.title", { place: shown });
    return { label: shown, title };
  }
  // An automatic placement says so on the badge itself, not only in the hover title (E38).
  const shown = facts.auto && facts.place !== "auto" ? `${label} · ${t("workLocation.auto")}` : label;
  const title = facts.auto && facts.reason
    ? t("workLocation.autoReason", { reason: facts.reason })
    : t("workLocation.title", { place: label });
  return { label: shown, title };
}

/** Where the bot in this conversation is working right now, in the chat header so a turn's place is never a guess. */
export function WorkLocationBadge({ bot, task, className }: {
  bot: Pick<Bot, "computer" | "cloudBackend" | "vpsInstanceId">;
  task?: Pick<Task, "surface" | "surfaceAuto" | "placementReason" | "browserPlacement"> | null;
  className?: string;
}) {
  const { state } = useStore();
  const vps = state.config?.vps;
  const instances = vps?.instances ?? [];
  const hasBoat = Boolean(state.config?.box?.configured || state.config?.box?.included);
  const hasVps = instances.length > 0 || Boolean(vps?.configured);
  const place = effectivePlace(bot, task);
  const { label, title } = workLocationText({
    place,
    backend: bot.cloudBackend === "vps" || (!hasBoat && hasVps) ? "vps" : "box",
    instanceName: instances.find((instance) => instance.id === bot.vpsInstanceId)?.name,
    auto: task?.surfaceAuto === true,
    reason: task?.placementReason,
    browserAt: task?.browserPlacement ?? null,
  });
  return (
    <span
      data-testid="work-location"
      data-place={place}
      title={title}
      className={cn(
        "flex shrink-0 items-center gap-1 rounded-full border border-hairline/40 bg-raised/60 px-2 py-0.5 text-[11px] text-ink-secondary",
        className,
      )}
    >
      <PlaceIcon place={place} size={12} aria-hidden="true" />
      <span className="max-w-[16rem] truncate">{label}</span>
    </span>
  );
}
