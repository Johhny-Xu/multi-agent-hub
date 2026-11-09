import { useEffect, useState } from "react";
import { Check, Loader2, Plus } from "lucide-react";

import { api, useStore, type InstanceInfo } from "@/state/store";
import { t } from "@/lib/i18n";
import { cn } from "@/lib/cn";
import { SERVICE_ACCOUNT_LABEL_MAX, type ServiceAccount, type ServiceAccountsView } from "../../shared/service-accounts";
import { ConfirmDialog } from "./ConfirmDialog";
import { SIMPLE_CARD, SettingRow, Switch } from "./SettingsPrimitives";

function accountLine(account: ServiceAccount): string {
  return account.identity && account.identity !== account.label ? `${account.label} · ${account.identity}` : account.label;
}

/** What the auto-switch route reports; `available: false` means this host does not wire the feature. */
type AutoSwitchStatus = { enabled: boolean; limited: Array<{ accountId: string; until: number }>; available?: boolean };

const hhmm = (ms: number) => {
  const at = new Date(ms);
  return `${String(at.getHours()).padStart(2, "0")}:${String(at.getMinutes()).padStart(2, "0")}`;
};

/**
 * The accounts this engine can switch between. Only engines whose CLI keeps its sign-in in files are
 * listed; others already switch accounts by adding one in Settings.
 */
export function ServiceAccounts({ instance }: { instance: InstanceInfo }) {
  const { refreshInstances } = useStore();
  const [view, setView] = useState<ServiceAccountsView | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [label, setLabel] = useState("");
  const [confirm, setConfirm] = useState<ServiceAccount | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [autoSwitch, setAutoSwitch] = useState<AutoSwitchStatus | null>(null);
  const [autoSwitchError, setAutoSwitchError] = useState<string | null>(null);
  // null until the person opens or closes the section by hand; before that the default rule decides.
  const [userOpen, setUserOpen] = useState<boolean | null>(null);
  const base = `/api/instances/${encodeURIComponent(instance.instanceId)}/service-accounts`;

  useEffect(() => {
    let alive = true;
    // An older server has no such route: the section simply stays away.
    api<{ accounts?: ServiceAccountsView }>(base)
      .then((result) => { if (alive) setView(result?.accounts ?? null); })
      .catch(() => {});
    return () => { alive = false; };
  }, [base]);

  useEffect(() => {
    let alive = true;
    // An older server has no such route: the toggle simply stays away.
    api<{ autoSwitch?: AutoSwitchStatus }>(base + "/auto-switch")
      .then((result) => {
        if (alive && result?.autoSwitch && result.autoSwitch.available !== false) setAutoSwitch(result.autoSwitch);
      })
      .catch(() => {});
    return () => { alive = false; };
  }, [base]);

  useEffect(() => {
    if (!notice) return;
    const timer = window.setTimeout(() => setNotice(null), 4000);
    return () => window.clearTimeout(timer);
  }, [notice]);

  if (!view?.supported) return null;

  const active = view.accounts.find((account) => account.id === view.activeId);
  const cooling = (accountId: string) => {
    const entry = autoSwitch?.limited?.find((candidate) => candidate.accountId === accountId && candidate.until > Date.now());
    return entry ? t("serviceAccounts.coolingUntil", { time: hhmm(entry.until) }) : null;
  };
  const open = userOpen ?? (view.accounts.length >= 2 || view.drifted || autoSwitch?.enabled === true);
  const run = async (id: string, request: () => Promise<{ accounts?: ServiceAccountsView }>, done?: () => void) => {
    setBusy(id);
    setError(null);
    setNotice(null);
    try {
      const result = await request();
      if (result?.accounts) setView(result.accounts);
      await Promise.resolve(refreshInstances()).catch(() => {});
      done?.();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(null);
    }
  };
  const switchTo = (account: ServiceAccount) => run(account.id, () => api(base + `/${account.id}/switch`, { method: "POST", body: "{}" }),
    () => setNotice(t("serviceAccounts.switched", { name: account.label })));
  const toggleAutoSwitch = (on: boolean) => {
    const previous = autoSwitch;
    setAutoSwitchError(null);
    setAutoSwitch({ ...(previous ?? { enabled: on, limited: [] as AutoSwitchStatus["limited"] }), enabled: on });
    api<{ autoSwitch?: AutoSwitchStatus }>(base + "/auto-switch", { method: "PUT", body: JSON.stringify({ enabled: on }) })
      .then((result) => {
        if (result?.autoSwitch) setAutoSwitch(result.autoSwitch);
        void Promise.resolve(refreshInstances()).catch(() => {});
      })
      .catch((cause) => {
        setAutoSwitch(previous);
        setAutoSwitchError(cause instanceof Error ? cause.message : String(cause));
      });
  };
  const save = () => run("save", () => api(base, { method: "POST", body: JSON.stringify({ label: label.trim() || undefined }) }), () => {
    setAdding(false);
    setLabel("");
  });
  const remove = (account: ServiceAccount) => run(account.id, () => api(base + `/${account.id}`, { method: "DELETE" }), () => setConfirm(null));

  return (
    <details data-service-accounts={instance.instanceId} open={open}
      onToggle={(event) => { const now = event.currentTarget.open; if (now !== open) setUserOpen(now); }}
      className="mt-4 border-t border-hairline/40 pt-3">
      <summary className="cursor-pointer rounded-md py-1 text-[12px] font-medium text-ink-secondary outline-none hover:text-ink focus-visible:ring-2 focus-visible:ring-accent">
        {t("serviceAccounts.title")}
        <span className="ml-1.5 font-normal text-ink-secondary">
          {active ? accountLine(active) : view.liveIdentity ?? t("serviceAccounts.none")}
        </span>
      </summary>
      <p className="mt-2 text-[12px] leading-relaxed text-ink-secondary">{t("serviceAccounts.hint")}</p>
      {view.drifted && (
        <div role="status" data-accounts-drifted
          className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1.5 rounded-lg border border-warning/25 bg-warning/10 px-2.5 py-2 text-[12px] leading-relaxed text-warning">
          <span className="min-w-0 flex-1">{t("serviceAccounts.drifted")}</span>
          <button type="button" data-save-as-new="" onClick={() => { setLabel(view.liveIdentity ?? ""); setAdding(true); }}
            className="shrink-0 rounded-lg border border-warning/30 px-2 py-0.5 text-[12px] font-medium text-warning hover:bg-warning/15">
            {t("serviceAccounts.saveAsNew")}
          </button>
        </div>
      )}
      {view.accounts.length > 0 && (
        <ul data-accounts={instance.instanceId} className={cn(SIMPLE_CARD, "mt-2 divide-y divide-(--settings-edge)")}>
          {view.accounts.map((account) => {
            const current = account.id === view.activeId;
            const coolingLabel = cooling(account.id);
            return (
              <li key={account.id} className="flex min-h-10 items-center gap-2 px-4 py-2" data-service-account={account.id} data-active={current || undefined}>
                <span aria-hidden="true" className={cn("flex size-5 shrink-0 items-center justify-center rounded-full",
                  current ? "bg-success/15 text-success" : "bg-control text-ink-secondary")}>
                  {current ? <Check size={12} /> : <span className="size-1.5 rounded-full bg-ink-tertiary" />}
                </span>
                <span className="min-w-0 flex-1 truncate text-[13px] text-ink" title={accountLine(account)}>{accountLine(account)}</span>
                {coolingLabel && (
                  <span data-cooling="" className="shrink-0 rounded-md bg-control px-1.5 py-0.5 text-[11px] text-ink-secondary">
                    {coolingLabel}
                  </span>
                )}
                {current && !view.drifted ? (
                  <span className="shrink-0 text-[12px] text-success">{t("serviceAccounts.active")}</span>
                ) : (
                  <button type="button" disabled={busy !== null} title={coolingLabel ?? undefined} onClick={() => void switchTo(account)}
                    className="shrink-0 rounded-lg px-2.5 py-1 text-[12px] font-medium text-ink-secondary hover:bg-raised hover:text-ink disabled:opacity-50">
                    {busy === account.id ? <Loader2 size={12} className="animate-spin" /> : t("serviceAccounts.switch")}
                  </button>
                )}
                {!current && (
                  <button type="button" disabled={busy !== null} onClick={() => setConfirm(account)}
                    className="shrink-0 rounded-lg px-2 py-1 text-[12px] text-ink-secondary hover:bg-danger/10 hover:text-danger disabled:opacity-50">
                    {t("serviceAccounts.remove")}
                  </button>
                )}
              </li>
            );
          })}
        </ul>
      )}
      {autoSwitch && (
        <div data-auto-switch-row={instance.instanceId} className="mt-3">
          <SettingRow className="px-0" title={t("serviceAccounts.autoSwitch")}
            subtitle={view.accounts.length < 2 ? t("serviceAccounts.autoSwitchNeedsTwo") : t("serviceAccounts.autoSwitchHint")}
            message={autoSwitchError ? <span role="alert" className="text-danger">{autoSwitchError}</span> : undefined}>
            <Switch data-auto-switch={instance.instanceId} aria-label={t("serviceAccounts.autoSwitch")}
              checked={autoSwitch.enabled} disabled={view.accounts.length < 2 || busy !== null}
              onClick={() => toggleAutoSwitch(!autoSwitch.enabled)} />
          </SettingRow>
        </div>
      )}
      {adding ? (
        <form className="mt-2 flex flex-wrap items-end gap-2" onSubmit={(event) => { event.preventDefault(); void save(); }}>
          <label className="flex min-w-[10rem] flex-1 flex-col gap-1 text-[12px] font-medium text-ink">
            {t("serviceAccounts.nameLabel")}
            <input value={label} onChange={(event) => setLabel(event.target.value)} maxLength={SERVICE_ACCOUNT_LABEL_MAX} autoFocus
              placeholder={view.liveIdentity ?? t("serviceAccounts.namePlaceholder")}
              className="rounded-lg border border-hairline/40 bg-inset px-3 py-1.5 text-[13px] font-normal text-ink outline-none focus:border-accent-border" />
          </label>
          <button type="submit" disabled={busy !== null}
            className="flex items-center gap-1.5 rounded-lg bg-accent px-3 py-1.5 text-[12px] font-semibold text-white hover:brightness-110 disabled:opacity-50">
            {busy === "save" && <Loader2 size={12} className="animate-spin" />}{t("serviceAccounts.saveCurrent")}
          </button>
          <button type="button" onClick={() => { setAdding(false); setError(null); }}
            className="rounded-lg px-2.5 py-1.5 text-[12px] text-ink-secondary hover:bg-control">
            {t("common.cancel")}
          </button>
        </form>
      ) : (
        <button type="button" onClick={() => setAdding(true)}
          className="mt-2 flex min-h-8 items-center gap-1.5 rounded-lg px-2 py-1.5 text-[12px] font-medium text-ink-secondary outline-none hover:bg-control hover:text-ink focus-visible:ring-2 focus-visible:ring-accent">
          <Plus size={13} />{t("serviceAccounts.add")}
        </button>
      )}
      <p className="mt-1.5 text-[12px] leading-relaxed text-ink-secondary">{t("serviceAccounts.addHint")}</p>
      {view.note === "shared-gh" && <p className="mt-1 text-[12px] leading-relaxed text-ink-secondary">{t("serviceAccounts.note.sharedGh")}</p>}
      {notice && <p role="status" className="mt-1 text-[12px] text-success">{notice}</p>}
      {error && <p role="alert" className="mt-1 text-[12px] text-danger">{error}</p>}
      <ConfirmDialog
        open={confirm !== null}
        title={t("serviceAccounts.removeTitle", { name: confirm?.label ?? "" })}
        body={t("serviceAccounts.removeBody")}
        confirmLabel={t("serviceAccounts.remove")}
        tone="neutral"
        pending={busy !== null}
        onCancel={() => { if (busy === null) setConfirm(null); }}
        onConfirm={() => { if (confirm) void remove(confirm); }}
      />
    </details>
  );
}
