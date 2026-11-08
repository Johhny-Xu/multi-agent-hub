import { useEffect, useRef, useState } from "react";
import { api, useStore, type ConfigStatus } from "@/state/store";
import { t } from "@/lib/i18n";
import { Card, Switch } from "./SettingsPrimitives";

type AutoPlacement = NonNullable<ConfigStatus["autoPlacement"]>;

/** Auto sends a turn to the cloud when the host is above these; the recovery thresholds stay at their defaults. */
export function AutoPlacementSettings() {
  const { state, dispatch } = useStore();
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const inFlight = useRef(false);
  const current = state.config?.autoPlacement;
  if (!current) return null;
  const save = async (next: AutoPlacement) => {
    if (inFlight.current) return;
    if (next.cpuHigh <= next.cpuLow) { setError(t("settings.autoPlacement.cpuOrder")); return; }
    if (next.memHighPct >= next.memLowPct) { setError(t("settings.autoPlacement.memOrder")); return; }
    inFlight.current = true;
    setSaving(true);
    setError("");
    try {
      const config = await api<ConfigStatus>("/api/config", { method: "PUT", body: JSON.stringify({ autoPlacement: next }) });
      dispatch({ type: "configStatus", config });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t("settings.autoPlacement.error"));
    } finally {
      inFlight.current = false;
      setSaving(false);
    }
  };
  return (
    <Card title={t("settings.autoPlacement.title")} subtitle={t("settings.autoPlacement.subtitle")}>
      <div className="mt-3 flex items-center justify-between gap-4">
        <label htmlFor="auto-placement-enabled" className="text-[13px] font-medium text-ink">{t("settings.autoPlacement.enable")}</label>
        <Switch id="auto-placement-enabled" checked={current.enabled} disabled={saving}
          aria-describedby="auto-placement-help"
          onClick={() => void save({ ...current, enabled: !current.enabled })} />
      </div>
      <p id="auto-placement-help" className="mt-2 text-[12px] leading-relaxed text-ink-secondary">{t("settings.autoPlacement.help")}</p>
      <ThresholdField id="auto-placement-cpu-high" label={t("settings.autoPlacement.cpuHigh")} unit="%"
        value={current.cpuHigh} min={1} max={100} disabled={saving || !current.enabled}
        onSave={(cpuHigh) => save({ ...current, cpuHigh })} />
      <ThresholdField id="auto-placement-mem-high" label={t("settings.autoPlacement.memHigh")} unit="%"
        value={current.memHighPct} min={0} max={100} disabled={saving || !current.enabled}
        onSave={(memHighPct) => save({ ...current, memHighPct })} />
      <ThresholdField id="auto-placement-mem-min" label={t("settings.autoPlacement.memMin")} unit="MB"
        value={current.memMinMb} min={0} max={1_000_000} disabled={saving || !current.enabled}
        onSave={(memMinMb) => save({ ...current, memMinMb })} />
      {saving && <span role="status" className="sr-only">{t("settings.threads.saving")}</span>}
      {error && <p role="alert" className="mt-2 text-[12px] text-danger">{error}</p>}
    </Card>
  );
}

function ThresholdField({ id, label, unit, value, min, max, disabled, onSave }: {
  id: string; label: string; unit: string; value: number; min: number; max: number;
  disabled: boolean; onSave: (value: number) => Promise<void>;
}) {
  const [draft, setDraft] = useState(String(value));
  const [dirty, setDirty] = useState(false);
  useEffect(() => {
    if (!dirty) setDraft(String(value));
  }, [value, dirty]);
  const commit = () => {
    if (!dirty) return;
    const parsed = Number(draft);
    if (!Number.isFinite(parsed) || parsed < min || parsed > max) return;
    setDirty(false);
    if (parsed !== value) void onSave(Math.round(parsed));
  };
  return (
    <div className="mt-3 flex items-center justify-between gap-3">
      <label htmlFor={id} className="text-[13px] text-ink">{label}</label>
      <div className="flex w-[150px] shrink-0 items-center rounded-lg border border-hairline/40 bg-control focus-within:border-focus">
        <input id={id} type="number" min={min} max={max} step={1} inputMode="numeric" value={draft}
          disabled={disabled}
          onChange={(event) => { setDraft(event.target.value); setDirty(true); }}
          onBlur={commit}
          onKeyDown={(event) => { if (event.key === "Enter") event.currentTarget.blur(); }}
          className="min-w-0 flex-1 bg-transparent px-2.5 py-1.5 text-[13px] tabular-nums text-ink focus:outline-none disabled:opacity-50" />
        <span className="pr-2.5 text-[13px] text-ink-secondary">{unit}</span>
      </div>
    </div>
  );
}
