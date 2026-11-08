import { useEffect, useState } from "react";
import { Check, Loader2, Plus } from "lucide-react";

import { api, useStore, type InstanceInfo } from "@/state/store";
import { t } from "@/lib/i18n";
import { cn } from "@/lib/cn";
import { SERVICE_ACCOUNT_LABEL_MAX, type ServiceAccount, type ServiceAccountsView } from "../../shared/service-accounts";
import { ConfirmDialog } from "./ConfirmDialog";

function accountLine(account: ServiceAccount): string {
  return account.identity && account.identity !== account.label ? `${account.label} · ${account.identity}` : account.label;
}

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
  const base = `/api/instances/${encodeURIComponent(instance.instanceId)}/service-accounts`;

  useEffect(() => {
    let alive = true;
    // An older server has no such route: the section simply stays away.
    api<{ accounts?: ServiceAccountsView }>(base)
      .then((result) => { if (alive) setView(result?.accounts ?? null); })
      .catch(() => {});
    return () => { alive = false; };
  }, [base]);

  if (!view?.supported) return null;

  const active = view.accounts.find((account) => account.id === view.activeId);
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
  const save = () => run("save", () => api(base, { method: "POST", body: JSON.stringify({ label: label.trim() || undefined }) }), () => {
    setAdding(false);
    setLabel("");
  });
  const remove = (account: ServiceAccount) => run(account.id, () => api(base + `/${account.id}`, { method: "DELETE" }), () => setConfirm(null));

  return (
    <details data-service-accounts={instance.instanceId} className="mt-4 border-t border-hairline/40 pt-3">
      <summary className="cursor-pointer rounded-md py-1 text-[12px] font-medium text-ink-secondary outline-none hover:text-ink focus-visible:ring-2 focus-visible:ring-accent">
        {t("serviceAccounts.title")}
        <span className="ml-1.5 font-normal text-ink-secondary">
          {active ? accountLine(active) : view.liveIdentity ?? t("serviceAccounts.none")}
        </span>
      </summary>
      <p className="mt-2 text-[12px] leading-relaxed text-ink-secondary">{t("serviceAccounts.hint")}</p>
      {view.drifted && (
        <p role="status" data-accounts-drifted className="mt-2 rounded-lg border border-warning/25 bg-warning/10 px-2.5 py-2 text-[12px] leading-relaxed text-warning">
          {t("serviceAccounts.drifted")}
        </p>
      )}
      {view.accounts.length > 0 && (
        <ul data-accounts={instance.instanceId} className="mt-2 divide-y divide-hairline/40 rounded-xl border border-hairline/50 bg-panel/40">
          {view.accounts.map((account) => {
            const current = account.id === view.activeId;
            return (
              <li key={account.id} className="flex min-h-10 items-center gap-2 px-3 py-2" data-service-account={account.id} data-active={current || undefined}>
                <span aria-hidden="true" className={cn("flex size-5 shrink-0 items-center justify-center rounded-full",
                  current ? "bg-success/15 text-success" : "bg-control text-ink-secondary")}>
                  {current ? <Check size={12} /> : <span className="size-1.5 rounded-full bg-ink-tertiary" />}
                </span>
                <span className="min-w-0 flex-1 truncate text-[13px] text-ink" title={accountLine(account)}>{accountLine(account)}</span>
                {current && !view.drifted ? (
                  <span className="shrink-0 text-[12px] text-success">{t("serviceAccounts.active")}</span>
                ) : (
                  <button type="button" disabled={busy !== null} onClick={() => void switchTo(account)}
                    className="shrink-0 rounded-lg bg-control px-2.5 py-1 text-[12px] font-medium text-ink hover:bg-raised-hover disabled:opacity-50">
                    {busy === account.id ? <Loader2 size={12} className="animate-spin" /> : t("serviceAccounts.switch")}
                  </button>
                )}
                {!current && (
                  <button type="button" disabled={busy !== null} onClick={() => setConfirm(account)}
                    className="shrink-0 rounded-lg px-2 py-1 text-[12px] text-ink-secondary hover:bg-control hover:text-danger disabled:opacity-50">
                    {t("serviceAccounts.remove")}
                  </button>
                )}
              </li>
            );
          })}
        </ul>
      )}
      {adding ? (
        <form className="mt-2 flex flex-wrap items-end gap-2" onSubmit={(event) => { event.preventDefault(); void save(); }}>
          <label className="flex min-w-[10rem] flex-1 flex-col gap-1 text-[12px] font-medium text-ink">
            {t("serviceAccounts.nameLabel")}
            <input value={label} onChange={(event) => setLabel(event.target.value)} maxLength={SERVICE_ACCOUNT_LABEL_MAX} autoFocus disabled={busy !== null}
              placeholder={view.liveIdentity ?? t("serviceAccounts.namePlaceholder")}
              className="rounded-lg border border-hairline/40 bg-inset px-3 py-1.5 text-[13px] font-normal text-ink outline-none focus:border-accent-border disabled:opacity-50" />
          </label>
          <button type="submit" disabled={busy !== null} className="flex items-center gap-1.5 rounded-lg bg-accent px-3 py-1.5 text-[12px] font-semibold text-white hover:brightness-110 disabled:opacity-50">
            {busy === "save" && <Loader2 size={12} className="animate-spin" />}{t("serviceAccounts.saveCurrent")}
          </button>
          <button type="button" disabled={busy !== null} onClick={() => { setAdding(false); setError(null); }}
            className="rounded-lg px-2.5 py-1.5 text-[12px] text-ink-secondary hover:bg-control disabled:opacity-50">
            {t("common.cancel")}
          </button>
        </form>
      ) : (
        <button type="button" onClick={() => setAdding(true)} disabled={busy !== null}
          className="mt-2 flex min-h-8 items-center gap-1.5 rounded-lg px-2 py-1.5 text-[12px] font-medium text-ink-secondary outline-none hover:bg-control hover:text-ink focus-visible:ring-2 focus-visible:ring-accent disabled:opacity-50">
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
