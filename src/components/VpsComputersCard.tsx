import { AlertTriangle, Loader2, RefreshCw, Server, Trash2 } from "lucide-react";
import { t } from "@/lib/i18n";
import { cn } from "@/lib/cn";
import { Card } from "./SettingsPrimitives";
import { KeysLink } from "./keys/KeysLink";
import {
  computerStateLabel,
  vpsComputerInventoryStateKind,
  vpsComputerShortId,
  type VpsComputerInventoryInstance,
} from "./LocalComputerSection";

export interface VpsInstanceSection {
  id: string;
  name: string;
  kind: "ssh" | "mcp";
  state?: string;
  sshAlias?: string;
  mcpServer?: string;
  boxId?: string;
  desktops: VpsComputerInventoryInstance[];
}

/** Settings' list of OpenMaus-managed VPS computers, across every server in play. */
export function VpsComputersCard({
  instances,
  sections,
  configured,
  aliases,
  loading,
  removingName,
  error,
  unavailableReason,
  onRefresh,
  onRemove,
}: {
  instances: VpsComputerInventoryInstance[];
  sections?: VpsInstanceSection[];
  configured: boolean | null;
  aliases: string[];
  loading: boolean;
  removingName: string | null;
  error: string | null;
  unavailableReason: string | null;
  onRefresh: () => void;
  onRemove: (instance: VpsComputerInventoryInstance) => void;
}) {
  const computedSections: VpsInstanceSection[] = sections && sections.length > 0
    ? sections
    : aliases.length > 0
      ? aliases.map((alias) => ({
          id: alias,
          name: alias,
          kind: "ssh" as const,
          sshAlias: alias,
          state: instances.some((inst) => (inst.vpsAlias === alias || !inst.vpsAlias) && (inst.inUse || inst.state === "running")) ? "running" : "ready",
          desktops: instances.filter((inst) => inst.vpsAlias === alias || !inst.vpsAlias),
        }))
      : instances.length > 0
        ? [{
            id: instances[0]?.instanceId ?? "default",
            name: instances[0]?.vpsAlias ?? "SSH",
            kind: "ssh" as const,
            sshAlias: instances[0]?.vpsAlias,
            state: instances.some((inst) => inst.inUse || inst.state === "running") ? "running" : "ready",
            desktops: instances,
          }]
        : [];

  const noVpsAtAll = configured === false && computedSections.length === 0;

  return (
    <Card
      title={t("vm.vps.title")}
      subtitle={t("vm.vps.subtitle")}
    >
      <div className="flex items-center justify-between gap-3">
        <div className="text-[12px] text-ink-secondary">
          {configured === true
            ? t("vm.vps.sshHost", { alias: aliases.join(", ") || t("vm.vps.configuredFallback") })
            : noVpsAtAll
              ? <>{t("vm.vps.needsAlias")} <KeysLink id="vps" /></>
              : t("vm.vps.refreshHint")}
        </div>
        <button
          type="button"
          onClick={onRefresh}
          disabled={loading || removingName !== null}
          aria-label={t("vm.vps.refreshAria")}
          className="flex shrink-0 items-center gap-1.5 rounded-lg border border-hairline/40 px-2.5 py-1.5 text-[12px] text-ink-secondary hover:bg-control hover:text-ink disabled:opacity-40"
        >
          <RefreshCw size={12} className={cn(loading && "animate-spin")} /> {t("vm.refresh")}
        </button>
      </div>

      {error && <div role="alert" className="mt-3 rounded-lg bg-danger/10 px-3 py-2 text-[12px] text-danger">{error}</div>}

      <p role="status" aria-live="polite" aria-atomic="true" className="sr-only">
        {loading
          ? t("vm.vps.checking")
          : unavailableReason
            ? t("vm.vps.unavailable", { reason: unavailableReason })
            : noVpsAtAll
              ? t("vm.vps.notConfigured")
              : instances.length === 1
                ? t("vm.vps.foundOne")
                : t("vm.vps.foundMany", { count: instances.length })}
      </p>

      {!(noVpsAtAll && !loading && !unavailableReason) && (
        <div
          aria-busy={loading || removingName !== null}
          className="mt-3 flex flex-col gap-3"
        >
          {unavailableReason && (instances.length > 0 || computedSections.length > 0) && (
            <div className="flex items-center gap-2 rounded-xl border border-hairline/35 px-3 py-2.5 text-[12px] text-ink-secondary">
              <AlertTriangle size={14} className="shrink-0 text-warning" /> {unavailableReason}
            </div>
          )}
          {loading && computedSections.length === 0 ? (
            <div className="flex items-center gap-2 rounded-xl border border-hairline/40 px-3 py-4 text-[13px] text-ink-secondary">
              <Loader2 size={13} className="animate-spin" /> {t("vm.vps.checkingList")}
            </div>
          ) : unavailableReason && computedSections.length === 0 ? (
            <div className="flex items-center gap-2 rounded-xl border border-hairline/40 px-3 py-4 text-[13px] text-ink-secondary">
              <AlertTriangle size={14} className="shrink-0 text-warning" /> {unavailableReason}
            </div>
          ) : noVpsAtAll ? (
            <div className="flex items-center gap-2 rounded-xl border border-hairline/40 px-3 py-4 text-[13px] text-ink-secondary">
              <Server size={14} className="shrink-0" /> {t("vm.vps.notConfigured")}
            </div>
          ) : computedSections.length === 0 ? (
            <div className="rounded-xl border border-hairline/40 px-3 py-4 text-[13px] text-ink-secondary">{t("vm.vps.noneFound")}</div>
          ) : (
            computedSections.map((section) => (
              <div
                key={section.id}
                className="overflow-hidden rounded-xl border border-hairline/40"
                data-testid={`vps-section-${section.id}`}
              >
                <div className="flex items-center justify-between border-b border-hairline/35 bg-control/40 px-3 py-2.5">
                  <div className="flex flex-wrap items-center gap-2 min-w-0">
                    <span className="text-[13px] font-semibold text-ink truncate">{section.name}</span>
                    <span className="rounded-full bg-control px-2 py-0.5 font-mono text-[11px] text-ink-secondary">
                      {section.kind === "mcp" ? (section.mcpServer ?? "simular-box") : "SSH"}
                    </span>
                    {section.kind === "ssh" && (
                      <span className="text-[11px] text-ink-secondary">
                        {t("vm.vps.sshHost", { alias: section.sshAlias || section.name })}
                      </span>
                    )}
                  </div>
                  <span className={cn(
                    "rounded-full px-2 py-0.5 text-[11px]",
                    section.state === "running" ? "bg-success/15 text-success" : "bg-control text-ink-secondary"
                  )}>
                    {section.state ?? "ready"}
                  </span>
                </div>
                {section.kind === "mcp" ? (
                  <div className="flex items-center justify-between px-3 py-3 text-[12px] text-ink-secondary">
                    <div className="flex items-center gap-2">
                      <span>Box: <span className="font-mono text-ink">{section.boxId}</span></span>
                    </div>
                    <span className="text-[11px] text-ink-secondary">
                      {section.state ?? "ready"}
                    </span>
                  </div>
                ) : section.desktops.length === 0 ? (
                  <div className="px-3 py-3 text-[12px] text-ink-secondary">{t("vm.vps.sshEmpty")}</div>
                ) : (
                  section.desktops.map((instance, index) => {
                    const kind = vpsComputerInventoryStateKind(instance);
                    const state = computerStateLabel(kind);
                    const removing = removingName === instance.name;
                    const shortId = vpsComputerShortId(instance.name);
                    return (
                      <div
                        key={`${instance.vpsAlias ?? ""}:${instance.name}`}
                        className={cn(
                          "flex items-start justify-between gap-3 px-3 py-3",
                          index > 0 && "border-t border-hairline/35",
                        )}
                      >
                        <div className="min-w-0 flex-1">
                          <div className="flex flex-wrap items-center gap-2">
                            <span className="truncate text-[14px] font-medium text-ink">
                              {instance.orphaned ? t("vm.vps.orphan", { id: shortId }) : instance.ownerName}
                            </span>
                            <span
                              className={cn(
                                "rounded-full px-2 py-0.5 text-[11px]",
                                instance.inUse || kind === "running"
                                  ? "bg-success/15 text-success"
                                  : kind === "stopped" || kind === "paused"
                                    ? "bg-control text-ink-secondary"
                                    : "bg-warning/15 text-warning",
                              )}
                            >
                              {state}
                            </span>
                          </div>
                          <div className="mt-1 text-[12px] text-ink-secondary">
                            {instance.orphaned ? t("vm.owner.gone") : t("vm.owner.owned")}
                          </div>
                          {instance.inUse && (
                            <div className="mt-1 text-[12px] text-ink-secondary">{t("vm.vps.stopFirst")}</div>
                          )}
                        </div>
                        <button
                          type="button"
                          onClick={() => onRemove(instance)}
                          disabled={loading || instance.inUse || removingName !== null}
                          aria-busy={removing || undefined}
                          title={t("vm.vps.removeTitle")}
                          className="flex shrink-0 items-center gap-1.5 rounded-lg bg-danger/10 px-2.5 py-1.5 text-[12px] font-medium text-danger hover:bg-danger/15 disabled:cursor-not-allowed disabled:opacity-40"
                        >
                          {removing ? <Loader2 size={12} className="animate-spin" /> : <Trash2 size={12} />}
                          {t("vm.vps.remove")}
                        </button>
                      </div>
                    );
                  })
                )}
              </div>
            ))
          )}
        </div>
      )}
    </Card>
  );
}
