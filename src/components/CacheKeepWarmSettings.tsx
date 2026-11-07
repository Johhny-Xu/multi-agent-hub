import { useRef, useState } from "react";
import { api, useStore, type ConfigStatus } from "@/state/store";
import { t } from "@/lib/i18n";
import { Card, Switch } from "./SettingsPrimitives";
import { Select } from "./Select";

type KeepWarm = NonNullable<ConfigStatus["cacheKeepWarm"]>;

/** 3h matches Cache Tax's auto-warm window. */
export const KEEP_WARM_WINDOWS = [60, 120, 180, 360, 720] as const;

export function CacheKeepWarmSettings() {
  const { state, dispatch } = useStore();
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const inFlight = useRef(false);
  const current = state.config?.cacheKeepWarm;
  if (!current) return null;
  const save = async (next: KeepWarm) => {
    if (inFlight.current) return;
    inFlight.current = true;
    setSaving(true);
    setError("");
    try {
      const config = await api<ConfigStatus>("/api/config", {
        method: "PUT",
        body: JSON.stringify({ cacheKeepWarm: { enabled: next.enabled, windowMinutes: next.windowMinutes } }),
      });
      dispatch({ type: "configStatus", config });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t("settings.keepWarm.error"));
    } finally {
      inFlight.current = false;
      setSaving(false);
    }
  };
  const windows: number[] = KEEP_WARM_WINDOWS.includes(current.windowMinutes as typeof KEEP_WARM_WINDOWS[number])
    ? [...KEEP_WARM_WINDOWS] : [...KEEP_WARM_WINDOWS, current.windowMinutes].sort((a, b) => a - b);
  return (
    <Card title={t("settings.keepWarm.title")} subtitle={t("settings.keepWarm.subtitle")}>
      <div className="mt-3 flex items-center justify-between gap-4">
        <label htmlFor="cache-keepwarm-enabled" className="text-[13px] font-medium text-ink">{t("settings.keepWarm.enable")}</label>
        <Switch id="cache-keepwarm-enabled" checked={current.enabled} disabled={saving}
          aria-describedby="cache-keepwarm-help cache-keepwarm-cost"
          onClick={() => void save({ ...current, enabled: !current.enabled })} />
      </div>
      <p id="cache-keepwarm-help" className="mt-2 text-[12px] leading-relaxed text-ink-secondary">{t("settings.keepWarm.help")}</p>
      <p id="cache-keepwarm-cost" className="mt-2 text-[12px] leading-relaxed text-ink-secondary">{t("settings.keepWarm.cost")}</p>
      <div className="mt-3 flex items-center justify-between gap-4">
        <label htmlFor="cache-keepwarm-window" className="text-[13px] font-medium text-ink">{t("settings.keepWarm.window")}</label>
        <Select id="cache-keepwarm-window" value={current.windowMinutes} disabled={saving || !current.enabled}
          onChange={(event) => void save({ ...current, windowMinutes: Number(event.target.value) })}>
          {windows.map((minutes) => (
            <option key={minutes} value={minutes}>{t("settings.keepWarm.hours", { hours: Number((minutes / 60).toFixed(2)) })}</option>
          ))}
        </Select>
      </div>
      {saving && <span role="status" className="sr-only">{t("settings.threads.saving")}</span>}
      {error && <p role="alert" className="mt-2 text-[12px] text-danger">{error}</p>}
    </Card>
  );
}
