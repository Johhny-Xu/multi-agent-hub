// Settings → Hub: the daily check-in and the hub console, both served through server/hub-bridge.ts.
// The bridge is the only thing that talks to the hub; when it is down this section says so and nothing else changes.
// The "dispatched tasks" card reads /api/hub/tasks and follows each ref's event stream, so a task sent
// through hub_dispatch_cli is visible here while it runs, not only through hub_task_status.
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { api } from "@/state/store";
import { t } from "@/lib/i18n";
import type { LocaleKey } from "@/locales";
import {
  applyHubEvent,
  formatElapsed,
  isTerminalStatus,
  mergeTaskSnapshot,
  parseHubEvent,
  rowElapsedSeconds,
  type HubLiveRow,
  type HubTaskView,
} from "@/lib/hub-tasks";
import { Card, SettingRow, SIMPLE_CARD } from "./SettingsPrimitives";

type HubHealth = { console: { ok: boolean; url: string }; scheduler: { ok: boolean; url: string } };
type HubPanel = "checkin" | "ui";

const PANELS: readonly { id: HubPanel; title: () => string; help: () => string; src: string }[] = [
  { id: "checkin", title: () => t("settings.hub.checkin"), help: () => t("settings.hub.checkinHelp"), src: "/hub/ui/#checkin" },
  { id: "ui", title: () => t("settings.hub.webui"), help: () => t("settings.hub.webuiHelp"), src: "/hub/ui/" },
];

/** Tailwind's md breakpoint, as a media query: below it the console cannot fit its three columns. */
const NARROW = "(max-width: 767.98px)";

/** True while the window is phone-width; follows the window as it is resized or the phone turns. */
function useNarrowScreen() {
  const [narrow, setNarrow] = useState(() =>
    typeof window !== "undefined" && typeof window.matchMedia === "function" ? window.matchMedia(NARROW).matches : false,
  );
  useEffect(() => {
    if (typeof window === "undefined" || typeof window.matchMedia !== "function") return;
    const media = window.matchMedia(NARROW);
    const sync = () => setNarrow(media.matches);
    sync();
    media.addEventListener("change", sync);
    return () => media.removeEventListener("change", sync);
  }, []);
  return narrow;
}

const FRAME_SANDBOX = "allow-scripts allow-same-origin allow-forms allow-popups";

const STATUS_KEY: Record<string, LocaleKey> = {
  running: "settings.hub.statusRunning",
  completed: "settings.hub.statusDone",
  error: "settings.hub.statusError",
  timeout: "settings.hub.statusTimeout",
  unknown: "settings.hub.statusUnknown",
};

const STATUS_TONE: Record<string, string> = {
  running: "bg-success/15 text-success",
  completed: "bg-success/10 text-success",
  error: "bg-danger/10 text-danger",
  timeout: "bg-warning/10 text-warning",
  unknown: "bg-ink-tertiary/10 text-ink-secondary",
};

/**
 * The dispatched work: a list snapshot every 5s discovers new refs, and each running ref
 * follows its own SSE stream. A stream is closed once its task reaches a terminal event.
 */
function useHubTasks() {
  const [rows, setRows] = useState<Record<string, HubLiveRow>>({});
  const [now, setNow] = useState(() => Date.now() / 1000);
  const streams = useRef(new Map<string, EventSource>());

  useEffect(() => {
    let live = true;
    const load = async () => {
      try {
        const body = await api<{ tasks?: HubTaskView[] }>("/api/hub/tasks");
        if (!live) return;
        const tasks = Array.isArray(body.tasks) ? body.tasks : [];
        setRows((current) => {
          const next: Record<string, HubLiveRow> = {};
          for (const task of tasks) next[task.ref] = mergeTaskSnapshot(current[task.ref], task);
          // A row the stream knows and the list already dropped is still worth showing while it runs.
          for (const [ref, row] of Object.entries(current)) {
            if (!next[ref] && !isTerminalStatus(row.status)) next[ref] = row;
          }
          return next;
        });
      } catch {
        /* the hub is down: keep whatever the last successful read produced */
      }
    };
    void load();
    const timer = setInterval(() => void load(), 5_000);
    return () => {
      live = false;
      clearInterval(timer);
    };
  }, []);

  useEffect(() => {
    for (const row of Object.values(rows)) {
      const ref = row.task.ref;
      if (!ref || isTerminalStatus(row.status) || streams.current.has(ref)) continue;
      if (typeof EventSource === "undefined") continue;
      const source = new EventSource(`/api/hub/tasks/${encodeURIComponent(ref)}/events`);
      streams.current.set(ref, source);
      const onEvent = (event: Event) => {
        const data = (event as MessageEvent).data;
        const parsed = parseHubEvent(typeof data === "string" ? data : "");
        if (!parsed) return;
        setRows((current) => {
          const existing = current[ref];
          if (!existing) return current;
          return { ...current, [ref]: applyHubEvent(existing, parsed) };
        });
      };
      const stop = () => {
        source.close();
        streams.current.delete(ref);
      };
      source.addEventListener("hub", onEvent);
      source.addEventListener("end", stop);
      let errors = 0;
      source.onerror = () => {
        // EventSource retries on its own; after a few misses the 5s list poll reopens it if the hub is back.
        errors += 1;
        if (errors >= 3) stop();
      };
    }
    for (const [ref, source] of streams.current) {
      const row = rows[ref];
      if (!row || isTerminalStatus(row.status)) {
        source.close();
        streams.current.delete(ref);
      }
    }
  }, [rows]);

  useEffect(() => {
    if (!Object.values(rows).some((row) => row.status === "running")) return;
    const timer = setInterval(() => setNow(Date.now() / 1000), 1_000);
    return () => clearInterval(timer);
  }, [rows]);

  useEffect(() => () => {
    for (const source of streams.current.values()) source.close();
    streams.current.clear();
  }, []);

  const ordered = Object.values(rows).sort((left, right) =>
    (left.status === "running" ? 0 : 1) - (right.status === "running" ? 0 : 1) || right.updatedAt - left.updatedAt);
  return { rows: ordered, now };
}

function DispatchedTasks() {
  const { rows, now } = useHubTasks();
  return (
    <Card title={t("settings.hub.tasksTitle")} subtitle={t("settings.hub.tasksHelp")}>
      {rows.length === 0 ? (
        <p className="mt-2 text-[12px] text-ink-secondary" role="status">{t("settings.hub.tasksEmpty")}</p>
      ) : (
        <ul className="mt-3 flex flex-col gap-2">
          {rows.map((row) => {
            const elapsed = rowElapsedSeconds(row, now);
            const detail = row.status === "running" ? row.progress : row.result;
            return (
              <li key={row.task.ref} className={SIMPLE_CARD} data-hub-task={row.task.ref}>
                <div className="px-4 py-2.5">
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[13px] font-medium text-ink">
                        <span className="truncate">{row.task.agent}</span>
                        <span className="font-mono text-[11px] font-normal text-ink-tertiary">{row.task.ref}</span>
                      </div>
                      {row.task.title && (
                        <p className="mt-0.5 line-clamp-2 break-words text-[12px] text-ink-secondary">{row.task.title}</p>
                      )}
                    </div>
                    <div className="shrink-0 text-right">
                      <span className={`inline-block rounded-full px-2 py-0.5 text-[11px] font-medium ${STATUS_TONE[row.status] ?? STATUS_TONE.unknown}`}>
                        {t(STATUS_KEY[row.status] ?? "settings.hub.statusUnknown")}
                      </span>
                      {elapsed !== null && (
                        <div className="mt-1 font-mono text-[11px] text-ink-tertiary">{formatElapsed(elapsed)}</div>
                      )}
                    </div>
                  </div>
                  {detail && (
                    <p className="mt-2 line-clamp-3 whitespace-pre-wrap break-words text-[12px] leading-relaxed text-ink-secondary">
                      {detail}
                    </p>
                  )}
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </Card>
  );
}

export function HubSection() {
  const [health, setHealth] = useState<HubHealth | null>(null);
  const [open, setOpen] = useState<HubPanel | null>(null);
  const narrow = useNarrowScreen();
  useEffect(() => {
    let live = true;
    api<HubHealth>("/hub/health")
      .then((next) => { if (live) setHealth(next); })
      .catch(() => { if (live) setHealth(null); });
    return () => { live = false; };
  }, []);
  // A phone shows the console as a full-screen sheet, so Escape closes it and the page behind stays put.
  useEffect(() => {
    if (!narrow || !open) return;
    const onKey = (event: KeyboardEvent) => { if (event.key === "Escape") setOpen(null); };
    window.addEventListener("keydown", onKey);
    const previous = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      window.removeEventListener("keydown", onKey);
      document.body.style.overflow = previous;
    };
  }, [narrow, open]);
  const up = health !== null && health.console.ok;
  const sheet = narrow && open ? PANELS.find((panel) => panel.id === open) : undefined;
  return (
    <>
      <DispatchedTasks />
      <Card title={t("settings.hub.title")} subtitle={t("settings.hub.subtitle")}>
        <p className="flex items-center gap-1.5 text-[12px] text-ink-secondary" role="status">
          <span aria-hidden className={up ? "size-2 rounded-full bg-success" : "size-2 rounded-full bg-ink-tertiary"} />
          {up ? t("settings.hub.online") : t("settings.hub.offline")}
        </p>
        <div className="mt-3 flex flex-col gap-2">
          {PANELS.map((panel) => (
            <div key={panel.id} className={SIMPLE_CARD}>
              <SettingRow title={panel.title()} subtitle={panel.help()} className="py-2.5">
                <button type="button" className="ui-button shrink-0" onClick={() => setOpen(open === panel.id ? null : panel.id)}>
                  {open === panel.id ? t("settings.hub.close") : t("settings.hub.open")}
                </button>
              </SettingRow>
              {open === panel.id && !narrow && (
                <iframe
                  src={panel.src}
                  title={t("settings.hub.frameTitle")}
                  sandbox={FRAME_SANDBOX}
                  referrerPolicy="no-referrer"
                  className="h-[60vh] w-full border-0 border-t border-hairline/40 bg-app"
                />
              )}
            </div>
          ))}
        </div>
        {/* Below md the console's three columns would be squeezed into 375px, so it takes the whole screen instead.
            Portalled out of the settings sheet: that sheet scrolls and clips, which would cut a fixed frame short. */}
        {sheet && createPortal(
          <div className="fixed inset-0 z-[60] flex flex-col bg-app" role="dialog" aria-modal="true" aria-label={sheet.title()} data-hub-sheet>
            <div className="flex shrink-0 items-center justify-between gap-3 border-b border-hairline/40 bg-panel px-4 pb-2.5" data-hub-sheet-bar>
              <div className="min-w-0">
                <div className="truncate text-[14px] font-medium text-ink">{sheet.title()}</div>
                <p className="mt-0.5 truncate text-[12px] text-ink-secondary">{sheet.help()}</p>
              </div>
              <button type="button" className="ui-button shrink-0" onClick={() => setOpen(null)} autoFocus>
                {t("settings.hub.close")}
              </button>
            </div>
            <iframe
              src={sheet.src}
              title={t("settings.hub.frameTitle")}
              sandbox={FRAME_SANDBOX}
              referrerPolicy="no-referrer"
              className="min-h-0 w-full flex-1 border-0 bg-app"
              data-hub-sheet-frame
            />
          </div>,
          document.body,
        )}
      </Card>
    </>
  );
}
