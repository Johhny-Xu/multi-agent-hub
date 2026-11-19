import { useEffect, useState } from "react";
import { Check, Copy, Loader2, RefreshCw, RotateCw, Trash2, TriangleAlert } from "lucide-react";

import { api, ApiError } from "@/state/store";
import { cn } from "@/lib/cn";
import { useCopyFeedback } from "@/lib/copy-text";
import { activeLocale, t } from "@/lib/i18n";
import { localizedRelativeTime } from "@/lib/relative-time";
import { ConfirmDialog } from "./ConfirmDialog";

export interface MuseRelayConnection {
  connectionId: string;
  createdAt?: string | number | null;
  lastSeenAt?: string | number | null;
  online?: boolean;
}

export interface MuseRelayConfig {
  connections: MuseRelayConnection[];
  pendingTurns: number;
  canManage: boolean;
}

/** The one-time answer of a create or a rotation: the only place a token is ever shown. */
export interface MuseRelayCredentials {
  connectionId: string;
  token: string;
  basePath: string;
}

const relayPath = (instanceId: string) => `/api/instances/${encodeURIComponent(instanceId)}/muse-relay`;
const connectionsPath = (instanceId: string) => `${relayPath(instanceId)}/connections`;

/** A missing or malformed field must not throw in the settings window: the card shows what it can. */
function readConfig(answer: unknown): MuseRelayConfig {
  const raw = (answer as { config?: unknown } | null | undefined)?.config as Partial<MuseRelayConfig> | undefined;
  const listed = Array.isArray(raw?.connections) ? raw.connections : [];
  const connections = listed.flatMap((entry) => {
    const connectionId = typeof entry?.connectionId === "string" ? entry.connectionId.trim() : "";
    if (!connectionId) return [];
    return [{
      connectionId,
      createdAt: entry?.createdAt ?? null,
      lastSeenAt: entry?.lastSeenAt ?? null,
      online: entry?.online === true,
    }];
  });
  const pending = raw?.pendingTurns;
  return {
    connections,
    pendingTurns: typeof pending === "number" && Number.isFinite(pending) && pending > 0 ? Math.floor(pending) : 0,
    canManage: raw?.canManage === true,
  };
}

function readCredentials(answer: unknown): MuseRelayCredentials | null {
  const raw = (answer as { credentials?: unknown } | null | undefined)?.credentials as Partial<MuseRelayCredentials> | undefined;
  if (!raw || typeof raw.connectionId !== "string" || typeof raw.token !== "string" || typeof raw.basePath !== "string") return null;
  return { connectionId: raw.connectionId, token: raw.token, basePath: raw.basePath };
}

/** Epoch seconds, epoch milliseconds or an ISO stamp; anything else is unknown. */
function timeValue(value: string | number | null | undefined): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value < 1e11 ? value * 1000 : value;
  if (typeof value === "string" && value.trim()) {
    const parsed = Date.parse(value);
    if (!Number.isNaN(parsed)) return parsed;
  }
  return null;
}

/** The server's own words can quote the body it refused, so only the status reaches the screen. */
function safeErrorText(cause: unknown): string {
  const status = cause instanceof ApiError ? cause.status : 0;
  if (status === 401 || status === 403) return t("museRelay.error.forbidden");
  if (status === 404) return t("museRelay.error.missing");
  if (status === 409) return t("museRelay.error.conflict");
  if (status === 429) return t("museRelay.error.busy");
  if (status >= 500) return t("museRelay.error.broken");
  return t("museRelay.error.unreachable");
}

function CredentialLine({ label, value, ariaLabel }: { label: string; value: string; ariaLabel: string }) {
  const { state, copy } = useCopyFeedback(value);
  return (
    <div className="flex min-w-0 flex-col gap-0.5">
      <dt className="text-[11px] text-ink-secondary">{label}</dt>
      <dd className="flex min-w-0 items-start gap-1.5">
        <code className="min-w-0 flex-1 break-all font-mono text-[12px] leading-relaxed text-ink">{value}</code>
        <button
          type="button"
          onClick={copy}
          aria-label={ariaLabel}
          title={ariaLabel}
          className="ui-icon-button shrink-0"
        >
          {state === "copied" ? <Check size={13} aria-hidden="true" className="text-success" /> : <Copy size={13} aria-hidden="true" />}
        </button>
      </dd>
    </div>
  );
}

/** The connections of one Muse relay: who may turn turns over, and the token each one needs.
 *
 * A token is shown once, right after it is made, and lives in this component's state until the
 * person closes the panel: it is never written to a store, a URL or storage.
 */
export function MuseRelayCard({ instanceId }: { instanceId: string }) {
  const [config, setConfig] = useState<MuseRelayConfig | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [credentials, setCredentials] = useState<MuseRelayCredentials | null>(null);
  const [busy, setBusy] = useState<"create" | "rotate" | "revoke" | "refresh" | null>(null);
  const [revoking, setRevoking] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    setLoading(true);
    setError(null);
    setCredentials(null);
    api<{ config?: MuseRelayConfig }>(relayPath(instanceId))
      .then((answer) => { if (alive) setConfig(readConfig(answer)); })
      .catch((cause: unknown) => { if (alive) { setConfig(null); setError(safeErrorText(cause)); } })
      .finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, [instanceId]);

  const run = async (kind: "create" | "rotate" | "revoke" | "refresh", action: () => Promise<void>) => {
    if (busy) return;
    setBusy(kind);
    setError(null);
    setNotice(null);
    try {
      await action();
    } catch (cause) {
      setError(safeErrorText(cause));
      setRevoking(null);
    } finally {
      setBusy(null);
    }
  };

  const create = () => run("create", async () => {
    const answer = await api<{ config?: MuseRelayConfig; credentials?: MuseRelayCredentials }>(connectionsPath(instanceId), {
      method: "POST",
      body: JSON.stringify({}),
    });
    setConfig(readConfig(answer));
    const shown = readCredentials(answer);
    if (shown) setCredentials(shown);
    setNotice(t("museRelay.created"));
  });

  const rotate = (connectionId: string) => run("rotate", async () => {
    const answer = await api<{ config?: MuseRelayConfig; credentials?: MuseRelayCredentials }>(
      `${connectionsPath(instanceId)}/${encodeURIComponent(connectionId)}/rotate`,
      { method: "POST", body: JSON.stringify({}) },
    );
    setConfig(readConfig(answer));
    const shown = readCredentials(answer);
    if (shown) setCredentials(shown);
    setNotice(t("museRelay.rotated"));
  });

  const revoke = (connectionId: string) => run("revoke", async () => {
    const answer = await api<{ config?: MuseRelayConfig }>(
      `${connectionsPath(instanceId)}/${encodeURIComponent(connectionId)}`,
      { method: "DELETE" },
    );
    setConfig(readConfig(answer));
    setNotice(t("museRelay.revoked"));
    setRevoking(null);
  });

  const refresh = () => run("refresh", async () => {
    const answer = await api<{ config?: MuseRelayConfig }>(relayPath(instanceId));
    setConfig(readConfig(answer));
  });

  const canManage = config?.canManage === true;
  const busyNow = busy !== null;

  return (
    <div data-muse-relay={instanceId} className="mt-3 rounded-xl border border-hairline/40 bg-app p-3">
      <div className="flex min-w-0 items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="text-[13px] font-medium leading-5 text-ink">{t("museRelay.title")}</div>
          <p className="mt-0.5 text-[12px] leading-relaxed text-ink-secondary">{t("museRelay.subtitle")}</p>
        </div>
        <button
          type="button"
          onClick={() => void refresh()}
          disabled={busyNow}
          aria-label={t("museRelay.refreshAria")}
          title={t("museRelay.refresh")}
          className="ui-icon-button shrink-0"
        >
          <RefreshCw size={13} aria-hidden="true" className={cn((loading || busy === "refresh") && "animate-spin motion-reduce:animate-none")} />
        </button>
      </div>

      {loading && !config && <p className="mt-2 text-[12px] text-ink-secondary">{t("museRelay.loading")}</p>}
      {error && <p role="alert" className="mt-2 text-[12px] leading-relaxed text-danger">{error}</p>}
      {notice && !error && <p role="status" className="mt-2 text-[12px] text-success">{notice}</p>}

      {config && (
        <>
          <p data-muse-relay-waiting="" className="mt-2 text-[12px] text-ink-secondary">
            {config.pendingTurns === 1 ? t("museRelay.waitingOne") : t("museRelay.waiting", { count: String(config.pendingTurns) })}
          </p>

          {config.connections.length === 0 ? (
            <div className="mt-2 flex flex-wrap items-center gap-2">
              <p className="min-w-0 text-[12px] leading-relaxed text-ink-secondary">{t("museRelay.empty")}</p>
              {canManage && (
                <button type="button" onClick={() => void create()} disabled={busyNow} className="ui-button ui-button-sm ui-button-primary shrink-0">
                  {busy === "create" ? <Loader2 size={12} aria-hidden="true" className="animate-spin motion-reduce:animate-none" /> : null}
                  {t("museRelay.create")}
                </button>
              )}
            </div>
          ) : (
            <ul className="mt-2 flex flex-col gap-1.5">
              {config.connections.map((connection) => {
                const seen = timeValue(connection.lastSeenAt);
                return (
                  <li
                    key={connection.connectionId}
                    data-muse-relay-connection={connection.connectionId}
                    className="flex min-w-0 flex-wrap items-center gap-2 rounded-lg border border-hairline/40 bg-panel px-2.5 py-2"
                  >
                    <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                      <code className="truncate font-mono text-[12px] text-ink" title={connection.connectionId}>{connection.connectionId}</code>
                      <span className="text-[11px] text-ink-secondary">
                        {connection.online
                          ? <><span aria-hidden="true" className="mr-1.5 inline-block size-1.5 rounded-full bg-success align-middle" />{t("museRelay.online")}</>
                          : <><span aria-hidden="true" className="mr-1.5 inline-block size-1.5 rounded-full bg-ink-tertiary align-middle" />{t("museRelay.offline")}</>}
                        {" · "}
                        {seen === null ? t("museRelay.neverSeen") : t("museRelay.lastSeen", { time: localizedRelativeTime(seen, activeLocale()) })}
                      </span>
                    </span>
                    {canManage && (
                      <span className="flex shrink-0 items-center gap-1">
                        <button
                          type="button"
                          onClick={() => void rotate(connection.connectionId)}
                          disabled={busyNow}
                          className="ui-button ui-button-sm"
                        >
                          {busy === "rotate" ? <Loader2 size={12} aria-hidden="true" className="animate-spin motion-reduce:animate-none" /> : <RotateCw size={12} aria-hidden="true" />}
                          {t("museRelay.rotate")}
                        </button>
                        <button
                          type="button"
                          onClick={() => setRevoking(connection.connectionId)}
                          disabled={busyNow}
                          className="ui-button ui-button-sm text-danger"
                        >
                          <Trash2 size={12} aria-hidden="true" />
                          {t("museRelay.revoke")}
                        </button>
                      </span>
                    )}
                  </li>
                );
              })}
            </ul>
          )}

          {!canManage && <p className="mt-2 text-[12px] leading-relaxed text-ink-secondary">{t("museRelay.viewOnly")}</p>}
        </>
      )}

      {credentials && (
        <div data-muse-relay-credentials="" className="mt-3 rounded-lg border border-warning/25 bg-warning/10 p-2.5">
          <p className="flex items-start gap-1.5 text-[12px] leading-relaxed text-warning">
            <TriangleAlert size={13} aria-hidden="true" className="mt-0.5 shrink-0" />
            <span>{t("museRelay.tokenOnce")}</span>
          </p>
          <dl className="mt-2 flex flex-col gap-2">
            <CredentialLine label={t("museRelay.connectionLabel")} value={credentials.connectionId} ariaLabel={t("museRelay.copyConnection")} />
            <CredentialLine label={t("museRelay.tokenLabel")} value={credentials.token} ariaLabel={t("museRelay.copyToken")} />
            <CredentialLine label={t("museRelay.pathLabel")} value={credentials.basePath} ariaLabel={t("museRelay.copyPath")} />
          </dl>
          <p className="mt-2 text-[11px] leading-relaxed text-ink-secondary">{t("museRelay.pathNote")}</p>
          <button type="button" onClick={() => setCredentials(null)} className="ui-button ui-button-sm mt-2">
            {t("museRelay.done")}
          </button>
        </div>
      )}

      <ConfirmDialog
        open={revoking !== null}
        title={t("museRelay.revokeTitle")}
        body={t("museRelay.revokeBody")}
        confirmLabel={t("museRelay.revoke")}
        tone="danger"
        pending={busy === "revoke"}
        onCancel={() => { if (busy !== "revoke") setRevoking(null); }}
        onConfirm={() => { if (revoking) void revoke(revoking); }}
      />
    </div>
  );
}
