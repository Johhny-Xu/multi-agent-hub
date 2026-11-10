import { useRef, useState } from "react";
import { api, useStore, type ConfigStatus } from "@/state/store";
import { t } from "@/lib/i18n";
import { Card, Switch } from "./SettingsPrimitives";

type CloudOffload = NonNullable<ConfigStatus["cloudOffload"]>;

/** A domain as the guard matches it: lower-case labels separated by dots, no scheme, port or path. */
const DOMAIN = /^[a-z0-9-]+(\.[a-z0-9-]+)+$/;

/** FEAT-cloud-offload: a bot's browser on a cloud server's Chrome first, a guard that keeps this computer's own
 * headless Chrome off its load, and the sites that must keep the sign-in this computer already has. */
export function CloudOffloadSettings() {
  const { state, dispatch } = useStore();
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [draft, setDraft] = useState<string | null>(null);
  const inFlight = useRef(false);
  const current = state.config?.cloudOffload;
  if (!current) return null;
  const domains = draft ?? current.authDomains.join("\n");
  const save = async (next: CloudOffload) => {
    if (inFlight.current) return;
    inFlight.current = true;
    setSaving(true);
    setError("");
    try {
      const config = await api<ConfigStatus>("/api/config", { method: "PUT", body: JSON.stringify({ cloudOffload: next }) });
      setDraft(null);
      dispatch({ type: "configStatus", config });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t("settings.cloudOffload.error"));
    } finally {
      inFlight.current = false;
      setSaving(false);
    }
  };
  const saveDomains = () => {
    const next = normalizeDomains(domains);
    const invalid = next.find((domain) => !DOMAIN.test(domain));
    if (invalid !== undefined) { setError(t("settings.cloudOffload.invalidDomain", { domain: invalid })); return; }
    if (next.length === current.authDomains.length && next.every((domain, index) => domain === current.authDomains[index])) { setDraft(null); return; }
    void save({ ...current, authDomains: next });
  };
  return (
    <Card title={t("settings.cloudOffload.title")} subtitle={t("settings.cloudOffload.subtitle")}>
      <div className="mt-3 flex items-center justify-between gap-4">
        <label htmlFor="cloud-offload-enabled" className="text-[13px] font-medium text-ink">{t("settings.cloudOffload.enable")}</label>
        <Switch id="cloud-offload-enabled" checked={current.enabled} disabled={saving}
          onClick={() => void save({ ...current, enabled: !current.enabled })} />
      </div>
      <div className="mt-3 flex items-center justify-between gap-4">
        <label htmlFor="cloud-offload-guard" className="text-[13px] font-medium text-ink">{t("settings.cloudOffload.guard")}</label>
        <Switch id="cloud-offload-guard" checked={current.guard} disabled={saving || !current.enabled}
          onClick={() => void save({ ...current, guard: !current.guard })} />
      </div>
      <div className="mt-4">
        <label htmlFor="cloud-offload-auth-domains" className="block text-[13px] font-medium text-ink">{t("settings.cloudOffload.authDomains")}</label>
        <textarea id="cloud-offload-auth-domains" rows={4} value={domains} disabled={saving} placeholder="example.com"
          onChange={(event) => setDraft(event.target.value)}
          onBlur={saveDomains}
          className="mt-2 min-h-[84px] w-full resize-y rounded-lg border border-hairline/40 bg-inset px-3 py-2 text-[13px] text-ink placeholder:text-ink-secondary focus:outline-none" />
        <div className="mt-2 flex items-start justify-between gap-3">
          <p className="text-[12px] leading-relaxed text-ink-secondary">{t("settings.cloudOffload.authDomainsHelp")}</p>
          <button type="button" onClick={saveDomains} disabled={saving}
            className="flex w-[72px] shrink-0 cursor-pointer items-center justify-center rounded-lg bg-control py-1.5 text-[13px] text-ink hover:bg-raised-hover disabled:cursor-not-allowed disabled:opacity-50">
            {t("settings.cloudOffload.save")}
          </button>
        </div>
      </div>
      {saving && <span role="status" className="sr-only">{t("settings.threads.saving")}</span>}
      {error && <p role="alert" className="mt-2 text-[12px] text-danger">{error}</p>}
    </Card>
  );
}

/** One domain per line: trimmed, lower-cased, without a scheme or a path, and without repeats. */
function normalizeDomains(text: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const line of text.split("\n")) {
    const domain = line.trim().toLowerCase().replace(/^https?:\/\//, "").split("/")[0]!.trim();
    if (!domain || seen.has(domain)) continue;
    seen.add(domain);
    out.push(domain);
  }
  return out;
}
