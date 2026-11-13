import { useEffect, useState } from "react";
import { Check, Loader2 } from "lucide-react";

import { api, useStore, type InstanceInfo } from "@/state/store";
import { t } from "@/lib/i18n";
import { cn } from "@/lib/cn";
import { ConfirmDialog } from "./ConfirmDialog";

/** One row of the Antigravity card's account list, as the server reports it. */
export interface AntigravityAccountRow {
  instanceId: string;
  label: string;
  email?: string;
  active: boolean;
  removable: boolean;
}

interface View {
  accounts: AntigravityAccountRow[];
  primaryId: string;
}

function line(account: AntigravityAccountRow): string {
  return account.email && account.email !== account.label ? `${account.label} · ${account.email}` : account.label;
}

/**
 * Every Google account Antigravity can run as, in one list: the primary account and the ones added in Settings.
 * Switching copies that account's sign-in over the primary's, so new tasks start as it; removing drops an added
 * account's instance. The list reloads whenever the set of Antigravity instances changes, so a just-added account
 * shows up without a reload.
 */
export function AntigravityAccounts({ instanceId }: { instanceId: string }) {
  const { state, dispatch, refreshInstances } = useStore();
  const [view, setView] = useState<View | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [removing, setRemoving] = useState<AntigravityAccountRow | null>(null);

  // The accounts the server lists, in its own order: the primary first, then the added ones. This is what
  // reloads the list when an account is added or removed elsewhere on the card.
  const accountIds = state.instances
    .filter((instance) => instance.driverKind === "antigravityAgent"
      && (instance.instanceId === "antigravity" || instance.instanceId.startsWith("antigravity-")))
    .map((instance) => instance.instanceId)
    .sort()
    .join(",");

  useEffect(() => {
    let alive = true;
    // An older server has no such route: the list simply stays away.
    api<{ accounts?: View }>("/api/instances/antigravity-accounts")
      .then((result) => { if (alive) setView(result?.accounts ?? null); })
      .catch(() => {});
    return () => { alive = false; };
  }, [accountIds, instanceId]);

  if (!view || view.accounts.length === 0) return null;
  const active = view.accounts.find((account) => account.active);

  // The bots whose own model is on this account, by name, so the row says which bot to move first. A conversation
  // that once picked the account does not count: removing it sends that conversation back to its bot's model.
  const usersOf = (instanceId: string) =>
    state.bots.filter((bot) => bot.modelSelection?.instanceId === instanceId).map((bot) => bot.name || bot.id);
  const inUseText = (users: string[]) => `${t("accounts.inUse", { count: String(users.length) })} (${users.join(", ")})`;

  const switchTo = async (account: AntigravityAccountRow) => {
    setBusy(account.instanceId);
    setError(null);
    setNotice(null);
    try {
      const result = await api<{ accounts?: View }>("/api/instances/antigravity-account-switch", {
        method: "POST",
        body: JSON.stringify({ accountInstanceId: account.instanceId }),
      });
      if (result?.accounts) setView(result.accounts);
      await Promise.resolve(refreshInstances()).catch(() => {});
      setNotice(t("antigravityAccounts.switched", { name: account.label }));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(null);
    }
  };

  const remove = async (account: AntigravityAccountRow) => {
    setBusy(account.instanceId);
    setError(null);
    try {
      const result = await api<{ instances?: InstanceInfo[] }>(`/api/instances/${encodeURIComponent(account.instanceId)}`, { method: "DELETE" });
      if (Array.isArray(result?.instances)) dispatch({ type: "instances", instances: result.instances });
      else await Promise.resolve(refreshInstances()).catch(() => {});
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(null);
      setRemoving(null);
    }
  };

  return (
    <div data-antigravity-accounts={instanceId} className="mt-3">
      <div className="text-[12px] font-medium text-ink-secondary">
        {t("antigravityAccounts.title")}
        <span className="ml-1.5 font-normal">{active ? line(active) : t("antigravityAccounts.none")}</span>
      </div>
      <ul className="mt-2 divide-y divide-hairline/40 rounded-xl border border-hairline/50 bg-panel/40">
        {view.accounts.map((account) => {
          const users = usersOf(account.instanceId);
          const used = users.length;
          return (
            <li key={account.instanceId} data-antigravity-account={account.instanceId} data-active={account.active || undefined}
              className="flex min-h-10 items-center gap-2 px-3 py-2">
              <span aria-hidden="true" className={cn("flex size-5 shrink-0 items-center justify-center rounded-full",
                account.active ? "bg-success/15 text-success" : "bg-control text-ink-secondary")}>
                {account.active ? <Check size={12} /> : <span className="size-1.5 rounded-full bg-ink-tertiary" />}
              </span>
              <span className="min-w-0 flex-1 truncate text-[13px] text-ink" title={line(account)}>{line(account)}</span>
              {used > 0 && account.removable && (
                <span data-antigravity-account-users className="min-w-0 shrink truncate text-[11px] text-ink-secondary" title={inUseText(users)}>{inUseText(users)}</span>
              )}
              {account.active ? (
                <span className="shrink-0 text-[12px] text-success">{t("antigravityAccounts.active")}</span>
              ) : (
                <button type="button" disabled={busy !== null} onClick={() => void switchTo(account)}
                  className="shrink-0 rounded-lg bg-control px-2.5 py-1 text-[12px] font-medium text-ink hover:bg-raised-hover disabled:opacity-50">
                  {busy === account.instanceId ? <Loader2 size={12} className="animate-spin" /> : t("antigravityAccounts.switch")}
                </button>
              )}
              {account.removable && (
                <button type="button" disabled={busy !== null || used > 0} onClick={() => setRemoving(account)} aria-label={t("accounts.remove")}
                  title={used > 0 ? inUseText(users) : undefined}
                  className="shrink-0 rounded-lg px-2 py-1 text-[12px] text-ink-secondary hover:bg-control hover:text-danger disabled:opacity-50 disabled:hover:bg-transparent disabled:hover:text-ink-secondary">
                  {t("accounts.remove")}
                </button>
              )}
            </li>
          );
        })}
      </ul>
      {notice && <p role="status" className="mt-1 text-[12px] text-success">{notice}</p>}
      {error && <p role="alert" className="mt-1 text-[12px] text-danger">{error}</p>}
      <ConfirmDialog open={removing !== null} title={t("accounts.removeTitle", { name: removing?.label ?? "" })}
        body={t("accounts.removeBodyAntigravity")} confirmLabel={t("accounts.remove")} tone="neutral" pending={busy !== null}
        onCancel={() => { if (busy === null) setRemoving(null); }}
        onConfirm={() => { if (removing) void remove(removing); }} />
    </div>
  );
}
