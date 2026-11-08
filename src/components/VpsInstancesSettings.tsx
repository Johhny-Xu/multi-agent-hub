import { useEffect, useState } from "react";
import { Loader2, Plus, Trash2 } from "lucide-react";

import type { VpsInstanceView } from "../../shared/vps";
import { api } from "@/state/api";
import { useStore } from "@/state/store";
import { t } from "@/lib/i18n";
import { cn } from "@/lib/cn";
import {
  checkVpsInstances,
  vpsCanCheck,
  vpsCheckedAtText,
  vpsDotState,
  vpsMergedRows,
  vpsRowAfterCheck,
  vpsRowAfterCheckFailure,
  vpsRowsToAutoCheck,
  vpsStatusLine,
  vpsUnsavedMessage,
} from "@/lib/vps-status";

export interface VpsAddInput {
  kind: "ssh" | "mcp";
  name: string;
  sshAlias?: string;
  mcpServer?: string;
  boxId?: string;
}

/** The body the API accepts, or the one thing still missing. */
export function vpsAddBody(input: VpsAddInput, revision: string): Record<string, string> | { error: string } {
  const name = input.name.trim();
  if (!name) return { error: t("keys.vps.nameRequired") };
  if (input.kind === "ssh") {
    const sshAlias = input.sshAlias?.trim() ?? "";
    return sshAlias ? { kind: "ssh", name, sshAlias, expectedRevision: revision } : { error: t("keys.vps.aliasRequired") };
  }
  const mcpServer = input.mcpServer?.trim() ?? "";
  const boxId = input.boxId?.trim() ?? "";
  if (!mcpServer || !boxId) return { error: t("keys.vps.boxRequired") };
  return { kind: "mcp", adapter: "simular-box", name, mcpServer, boxId, expectedRevision: revision };
}

export function vpsRowsAfterRemoval(rows: readonly VpsInstanceView[], admitted: boolean, id: string): VpsInstanceView[] {
  return admitted ? rows.filter((row) => row.id !== id) : [...rows];
}

const DOT_CLASS = {
  online: "bg-success",
  offline: "bg-danger",
  unknown: "bg-ink-tertiary",
  checking: "bg-ink-tertiary",
} as const;

export function VpsInstancesSettings() {
  const { state } = useStore();
  const vps = state.config?.vps;
  const rows = vps?.instances ?? [];
  const [localRevision, setLocalRevision] = useState<string | null>(null);
  const revision = localRevision ?? vps?.revision ?? "";
  const [kind, setKind] = useState<"ssh" | "mcp">("ssh");
  const [name, setName] = useState("");
  const [sshAlias, setSshAlias] = useState("");
  const [mcpServer, setMcpServer] = useState("simular-box");
  const [boxId, setBoxId] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [localRows, setLocalRows] = useState<VpsInstanceView[] | null>(null);
  const [checking, setChecking] = useState<Record<string, boolean>>({});
  const [serverIds, setServerIds] = useState<Set<string>>(() => new Set());
  const shown = vpsMergedRows(rows, localRows);

  const run = async (work: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try {
      await work();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
    }
  };

  const requestCheck = (id: string, expectedRevision: string) => api<VpsInstanceView>(
    `/api/vps/instances/${encodeURIComponent(id)}/check`,
    { method: "POST", body: JSON.stringify({ expectedRevision }) },
  );

  // Opening the list asks every computer how it is, without holding the page up.
  useEffect(() => {
    let stopped = false;
    void (async () => {
      const listed = await api<{ revision: string; instances: VpsInstanceView[] }>("/api/vps/instances")
        .catch(() => null);
      if (stopped || !listed) return;
      setServerIds(new Set((listed.instances ?? []).map((instance) => instance.id)));
      const toCheck = vpsRowsToAutoCheck(listed.instances);
      if (toCheck.length === 0) return;
      setLocalRevision(listed.revision);
      setLocalRows((current) => vpsMergedRows(listed.instances, current));
      setChecking(Object.fromEntries(toCheck.map((instance) => [instance.id, true])));
      await checkVpsInstances(
        toCheck,
        listed.revision,
        requestCheck,
        (view) => {
          if (stopped) return;
          setLocalRows((current) => vpsRowAfterCheck(current ?? shown, view.id, view));
          setChecking((current) => ({ ...current, [view.id]: false }));
        },
        (id, reason) => {
          if (stopped) return;
          setLocalRows((current) => vpsRowAfterCheckFailure(current ?? shown, id, reason));
          setChecking((current) => ({ ...current, [id]: false }));
        },
      );
      if (!stopped) setChecking({});
    })();
    return () => { stopped = true; };
  }, []);

  const add = () => run(async () => {
    const body = vpsAddBody({ kind, name, sshAlias, mcpServer, boxId }, revision);
    if ("error" in body) { setError(body.error); return; }
    const created = await api<{ instance: VpsInstanceView; revision: string }>("/api/vps/instances", { method: "POST", body: JSON.stringify(body) });
    setLocalRows([...shown, created.instance]);
    setLocalRevision(created.revision);
    setServerIds((current) => new Set([...current, created.instance.id]));
    setName(""); setSshAlias(""); setBoxId("");
  });

  const remove = (id: string) => run(async () => {
    const removed = await api<{ revision: string }>(`/api/vps/instances/${encodeURIComponent(id)}`, { method: "DELETE", body: JSON.stringify({ expectedRevision: revision }) })
      .then((body) => body, () => null);
    if (removed) {
      setLocalRows(vpsRowsAfterRemoval(shown, true, id));
      setLocalRevision(removed.revision);
      setServerIds((current) => {
        const next = new Set(current);
        next.delete(id);
        return next;
      });
    }
  });

  const check = (row: VpsInstanceView) => run(async () => {
    if (!vpsCanCheck(row, serverIds)) {
      setError(vpsUnsavedMessage());
      return;
    }
    setChecking((current) => ({ ...current, [row.id]: true }));
    try {
      const view = await requestCheck(row.id, revision);
      setLocalRows((current) => vpsRowAfterCheck(current ?? shown, row.id, view));
    } catch (reason) {
      setLocalRows((current) => vpsRowAfterCheckFailure(current ?? shown, row.id, reason));
    } finally {
      setChecking((current) => ({ ...current, [row.id]: false }));
    }
  });

  const makeDefault = (id: string) => run(async () => {
    const saved = await api<{ revision: string }>("/api/vps/default-instance", {
      method: "PUT",
      body: JSON.stringify({ id, expectedRevision: revision }),
    });
    setLocalRevision(saved.revision);
  });

  return (
    <div className="flex flex-col gap-3">
      <p className="text-[12px] leading-4 text-ink-secondary">{t("keys.vps.descBefore")}</p>
      <div className="flex flex-col gap-1.5">
        {shown.length === 0 && <div className="text-[12px] text-ink-secondary">{t("keys.vps.empty")}</div>}
        {shown.map((row) => {
          const state = vpsDotState(row, checking[row.id] === true);
          return (
            <div key={row.id} className="flex flex-wrap items-center gap-2 rounded-lg bg-inset px-3 py-2">
              <span className="flex size-3 shrink-0 items-center justify-center" aria-hidden="true">
                {state === "checking"
                  ? <Loader2 size={12} className="animate-spin text-ink-secondary" />
                  : <span className={cn("size-1.5 rounded-full", DOT_CLASS[state])} />}
              </span>
              <span className="min-w-0 flex-1 truncate text-[13px] text-ink">{row.name}</span>
              <span className="text-[11px] text-ink-secondary">{row.kind === "mcp" ? "simular-box" : t("keys.vps.sshKind")}</span>
              <span className="text-[11px] text-ink-secondary" title={row.detail}>{vpsStatusLine(row, checking[row.id] === true)}</span>
              {row.checkedAt && <span className="text-[11px] text-ink-tertiary">{vpsCheckedAtText(row.checkedAt)}</span>}
              <button type="button" onClick={() => void check(row)} disabled={busy} className="flex items-center gap-1 text-[11px] text-ink-secondary hover:text-ink">
                {checking[row.id] === true && <Loader2 size={12} className="animate-spin" aria-hidden="true" />}
                {t("keys.vps.check")}
              </button>
              <button type="button" onClick={() => void makeDefault(row.id)} disabled={busy} className="text-[11px] text-ink-secondary hover:text-ink">
                {vps?.defaultInstanceId === row.id ? t("keys.vps.default") : t("keys.vps.setDefault")}
              </button>
              <button type="button" onClick={() => void remove(row.id)} disabled={busy} aria-label={t("keys.row.remove")} className="text-ink-secondary hover:text-danger">
                <Trash2 size={14} />
              </button>
            </div>
          );
        })}
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <select value={kind} onChange={(event) => setKind(event.target.value as "ssh" | "mcp")} aria-label={t("keys.vps.kind")} className="rounded-lg border border-hairline/40 bg-raised px-2 py-1.5 text-[12px] text-ink">
          <option value="ssh">{t("keys.vps.sshKind")}</option>
          <option value="mcp">simular-box</option>
        </select>
        <input value={name} onChange={(event) => setName(event.target.value)} placeholder={t("keys.vps.namePlaceholder")} aria-label={t("keys.vps.name")} className="min-w-[8rem] flex-1 rounded-lg border border-hairline/40 bg-raised px-2 py-1.5 text-[12px] text-ink" />
        {kind === "ssh" ? (
          <input value={sshAlias} onChange={(event) => setSshAlias(event.target.value)} placeholder="my-vps" aria-label={t("keys.vps.aria")} className="min-w-[8rem] flex-1 rounded-lg border border-hairline/40 bg-raised px-2 py-1.5 font-mono text-[12px] text-ink" />
        ) : (
          <>
            <input value={mcpServer} onChange={(event) => setMcpServer(event.target.value)} placeholder="simular-box" aria-label={t("keys.vps.connection")} className="min-w-[7rem] flex-1 rounded-lg border border-hairline/40 bg-raised px-2 py-1.5 font-mono text-[12px] text-ink" />
            <input value={boxId} onChange={(event) => setBoxId(event.target.value)} placeholder={t("keys.vps.boxId")} aria-label={t("keys.vps.boxId")} className="min-w-[7rem] flex-1 rounded-lg border border-hairline/40 bg-raised px-2 py-1.5 font-mono text-[12px] text-ink" />
          </>
        )}
        <button type="button" onClick={() => void add()} disabled={busy} className="ui-button ui-button-primary shrink-0">
          {busy ? <Loader2 size={13} className="animate-spin" aria-hidden="true" /> : <Plus size={13} aria-hidden="true" />}
          {t("keys.vps.add")}
        </button>
      </div>
      {error && <div role="alert" className="text-[12px] leading-4 text-danger">{error}</div>}
    </div>
  );
}
