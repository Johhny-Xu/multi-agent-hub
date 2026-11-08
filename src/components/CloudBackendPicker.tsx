import type { CloudBackend } from "../../shared/wire";
import type { VpsInstanceView } from "../../shared/vps";
import { cn } from "@/lib/cn";
import { useStore } from "@/state/store";
import { t } from "@/lib/i18n";

export interface VpsPickerRow {
  id: string;
  label: string;
  unavailable: boolean;
}

/** A selected instance that vanished stays visible as its own row, never replaced by the first in the list. */
export function vpsPickerRows(instances: readonly VpsInstanceView[], selectedId?: string): VpsPickerRow[] {
  const rows = instances.map((instance) => ({
    id: instance.id,
    label: instance.kind === "mcp" ? `${instance.name} · simular-box` : instance.name,
    unavailable: instance.available === false,
  }));
  if (selectedId && !rows.some((row) => row.id === selectedId)) {
    rows.unshift({ id: selectedId, label: t("botAccess.cloud.missingInstance"), unavailable: true });
  }
  return rows;
}

/** Choosing a backend and its instance is one value, so no turn sees VPS with a stale id. */
export function vpsPickerSelection(backend: CloudBackend, instanceId: string | undefined, defaultId?: string): { backend: CloudBackend; instanceId?: string } {
  if (backend !== "vps") return { backend };
  const next = instanceId ?? defaultId;
  return { backend, ...(next ? { instanceId: next } : {}) };
}

/** A bot that never chose an instance takes the marked default, else the first listed. */
export function vpsPickerDefaultId(instances: readonly VpsInstanceView[], markedDefault?: string): string | undefined {
  return markedDefault ?? instances[0]?.id;
}

export function CloudBackendPicker({
  value,
  instanceId,
  compact = false,
  onChange,
}: {
  value: CloudBackend;
  instanceId?: string;
  compact?: boolean;
  onChange: (selection: { backend: CloudBackend; instanceId?: string }) => void;
}) {
  const { state } = useStore();
  if (state.config?.cloudHome) return null;
  const instances = state.config?.vps?.instances ?? [];
  const hasBoat = Boolean(state.config?.box?.configured || state.config?.box?.included);
  const rows = vpsPickerRows(instances, value === "vps" ? instanceId : undefined);
  const defaultId = vpsPickerDefaultId(instances, state.config?.vps?.defaultInstanceId);
  const choose = (backend: CloudBackend) => onChange(vpsPickerSelection(backend, instanceId, defaultId));

  const selectValue = value === "box" && hasBoat ? "box" : (instanceId ?? "");

  return (
    <div className="mt-3 rounded-lg bg-inset p-3" data-testid="cloud-backend-picker">
      <div className="text-[12px] font-medium text-ink">{compact ? t("botAccess.cloud.provider") : t("botAccess.cloud.backend")}</div>
      <div className="mt-0.5 text-[12px] text-ink-secondary">
        {compact
          ? value === "vps" ? t("botAccess.cloud.vpsDescription") : t("botAccess.cloud.hostedDescription")
          : value === "vps"
          ? t("botAccess.cloud.vpsAutoDescription")
          : t("botAccess.cloud.hostedBackendDescription")}
      </div>
      {(instances.length === 0 || hasBoat) && (
        <div className="mt-2 flex overflow-hidden rounded-lg border border-hairline/40">
          {(["box", "vps"] as const).map((backend, i) => (
            <button
              key={backend}
              type="button"
              onClick={() => choose(backend)}
              className={cn(
                "flex-1 py-1.5 text-[12px]",
                i > 0 && "border-l border-hairline/40",
                value === backend ? "bg-raised text-ink" : "text-ink-secondary hover:bg-raised/60 hover:text-ink",
              )}
            >
              {backend === "vps" ? t("botAccess.cloud.selfHostedVps") : t("botAccess.cloud.boat")}
            </button>
          ))}
        </div>
      )}
      {(value === "vps" || (hasBoat && instances.length > 0) || (!hasBoat && instances.length > 0)) && instances.length > 0 && (
        <select
          aria-label={t("botAccess.cloud.instance")}
          value={selectValue}
          onChange={(event) => {
            const next = event.target.value;
            if (next === "box") {
              onChange({ backend: "box" });
            } else {
              onChange({ backend: "vps", ...(next ? { instanceId: next } : {}) });
            }
          }}
          className="mt-2 w-full rounded-lg border border-hairline/40 bg-raised px-2 py-1.5 text-[12px] text-ink"
        >
          {hasBoat && <option value="box">{t("botAccess.cloud.boat")}</option>}
          <option value="">{t("botAccess.cloud.chooseInstance")}</option>
          {rows.map((row) => (
            <option key={row.id} value={row.id}>
              {row.label}{row.unavailable ? ` · ${t("botAccess.cloud.unavailable")}` : ""}
            </option>
          ))}
        </select>
      )}
    </div>
  );
}
