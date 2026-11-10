// Settings → Daily: today's check-in for every hub platform and each worker's remaining allowance, on one page.
// Both read through server/hub-bridge.ts, so a phone needs neither the console's origin nor a second sign-in.
import { useCallback, useEffect, useState } from "react";
import { Loader2, RefreshCw } from "lucide-react";
import { api, useStore } from "@/state/store";
import { cn } from "@/lib/cn";
import { sortEngines } from "@/lib/engine-sort";
import { intlLocale, t, tFromServer } from "@/lib/i18n";
import { engineReady } from "./EngineLibrary";
import { Card, SettingRow, SIMPLE_CARD, Switch } from "./SettingsPrimitives";

/** One account row from /hub/checkin/status: what the platform stores about that identity today. */
type CheckinAccount = {
  name?: string;
  display?: string;
  identity?: string;
  status?: string;
  message?: string;
  credits?: number | string;
  consecutiveDays?: number;
};

/** One platform's answer from /hub/checkin/status. Only the fields the console fills today are listed. */
type CheckinPlatform = {
  available?: boolean;
  source?: string;
  credentialMode?: string;
  lastDate?: string;
  lastTime?: string;
  status?: string;
  message?: string;
  pendingReason?: string;
  retryAt?: number;
  credits?: number | string;
  consecutiveDays?: number;
  accountCount?: number;
  signedAccounts?: number;
  pendingAccounts?: number;
  accounts?: CheckinAccount[];
  /** "qr": the platform signs in by scanning a QR the hub screenshots from its cloud browser (Doubao). */
  loginKind?: string;
};

/** One platform's answer from a run: what the sign-in attempt returned. */
type CheckinRunEntry = {
  ok?: boolean;
  status?: string;
  message?: string;
};

type CheckinRunResults = Record<string, CheckinRunEntry | undefined>;

type CheckinRunResponse = {
  ok?: boolean;
  results?: CheckinRunResults;
  overview?: CheckinStatus;
};

type CheckinStatus = {
  ok?: boolean;
  today?: string;
  autoCheckin?: boolean;
  autoCheckinTime?: string;
  platforms?: Record<string, CheckinPlatform>;
};

/** One allowance row from /hub/quota. Workers fill different subsets: a credit balance has used/total only. */
type Quota = {
  name?: string;
  displayName?: string;
  used?: number;
  total?: number;
  remaining?: number;
  remainingPercentage?: number;
  resetAt?: string;
  unlimited?: boolean;
  recurring?: boolean;
  isCreditBalance?: boolean;
  unit?: string;
};

type QuotaWorker = {
  worker: string;
  fetchedAt?: string;
  account?: string;
  plan?: string;
  message?: string;
  quotas?: Quota[];
};

type QuotaReport = { updatedAt?: string; workers?: Record<string, QuotaWorker> };

/** Brand names the hub uses as keys; anything new still renders, with the key title-cased. */
const PLATFORM_NAMES: Record<string, string> = {
  workbuddy: "WorkBuddy",
  codebuddy: "CodeBuddy",
  "codebuddy-cn": "CodeBuddy CN",
  traecode: "TRAE",
  codearts: "CodeArts",
  qoder: "Qoder",
  "qoder-cn": "Qoder CN",
  minimaxcode: "MiniMax Code",
  mimocode: "MiMo Code",
  meoo: "Meoo",
  doubao: "豆包 Doubao",
  zcode: "ZCode",
  "github-copilot": "GitHub Copilot",
  antigravity: "Antigravity",
};

function platformName(key: string): string {
  const known = PLATFORM_NAMES[key];
  if (known) return known;
  return key.replace(/[-_]+/g, " ").replace(/\b[a-z]/g, (letter) => letter.toUpperCase());
}

/** How many allowance rows a quota card shows before it offers the rest. */
const QUOTA_ROWS = 4;

/** How many account rows a platform card shows before it offers the rest. */
const ACCOUNT_ROWS = 3;

/** The engine behind a hub key, as far as ordering is concerned. */
export type DailyEngine = {
  instanceId: string;
  displayName: string;
  driverKind: string;
  ready: boolean;
  signedIn: boolean;
};

function folded(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "");
}

/** Hub keys and engine ids spell the same thing differently ("codebuddy-cn" / "codebuddyCn"), so both sides drop
 * their punctuation before they are compared. A hub-only platform (TRAE, WorkBuddy) has no engine and sorts last. */
export function engineFor(key: string, engines: readonly DailyEngine[]): DailyEngine | undefined {
  const wanted = folded(key);
  if (!wanted) return undefined;
  return engines.find((engine) =>
    [engine.instanceId, engine.displayName, engine.driverKind].some((value) => folded(value) === wanted));
}

/** The rows a quota card shows: the first few, or all of them once the card is expanded. */
export function shownQuotas<T>(quotas: readonly T[], expanded: boolean): readonly T[] {
  return expanded ? quotas : quotas.slice(0, QUOTA_ROWS);
}

/** The account rows a platform card shows: the first few, or all of them once the card is expanded. */
export function shownAccounts<T>(rows: readonly T[], expanded: boolean): readonly T[] {
  return expanded ? rows : rows.slice(0, ACCOUNT_ROWS);
}

/** The tally a platform card opens with: "2/3 signed" once the platform holds several accounts. */
export function accountSummary(platform: Pick<CheckinPlatform, "accountCount" | "signedAccounts">): string {
  const count = typeof platform.accountCount === "number" ? platform.accountCount : 0;
  const signed = typeof platform.signedAccounts === "number" ? platform.signedAccounts : 0;
  return count > 1 ? t("settings.daily.accountsSigned", { signed, count }) : "";
}

export function statusLabel(status: string | undefined): string {
  switch ((status ?? "").toLowerCase()) {
    case "success":
    case "done":
    case "ok":
      return t("settings.daily.statusSuccess");
    case "already":
      return "已签";
    case "partial":
      return "部分成功";
    case "pending":
    case "waiting":
      return t("settings.daily.statusPending");
    case "failure":
    case "failed":
    case "error":
      return t("settings.daily.statusFailed");
    case "restricted":
      return t("settings.daily.statusRestricted");
    case "unconfigured":
      return t("settings.daily.statusUnconfigured");
    default:
      return t("settings.daily.statusPending");
  }
}

export function statusTone(status: string | undefined): string {
  switch ((status ?? "").toLowerCase()) {
    case "success":
    case "done":
    case "ok":
    case "already":
      return "bg-success/12 text-success";
    case "partial":
      return "bg-warning/12 text-warning";
    case "restricted":
      return "bg-warning/12 text-warning";
    case "failure":
    case "failed":
    case "error":
      return "bg-danger/12 text-danger";
    case "unconfigured":
      return "bg-ink/[0.07] text-ink-tertiary";
    default:
      return "bg-ink/[0.07] text-ink-secondary";
  }
}

/** The label a run button shows once its platform — or every platform — signed today. The signed-today line lands
 * with the locale pack pipeline, so until it is merged the button keeps the run label (tFromServer falls back). */
export function signedTodayLabel(): string {
  return tFromServer("settings.daily.signedToday", t("settings.daily.run"));
}

/** Credits arrive as a number or a preformatted string; empty is the same as none. */
function creditsText(credits: number | string | undefined): string {
  if (typeof credits === "number") return credits > 0 ? credits.toLocaleString(intlLocale()) : "";
  return typeof credits === "string" ? credits.trim() : "";
}

/** What the server said is holding a platform back: waiting for the next window, a quota cooldown, a missing device
 * identity, a campaign that is not open yet. Empty when the server named no reason. */
export function pendingReasonLabel(reason: string | undefined): string {
  switch ((reason ?? "").toLowerCase()) {
    case "identity_missing":
      return t("settings.daily.reasonIdentityMissing");
    case "awaiting_window":
      return t("settings.daily.reasonAwaitingWindow");
    case "quota_cooldown":
      return t("settings.daily.reasonQuotaCooldown");
    case "awaiting_campaign":
      return t("settings.daily.reasonAwaitingCampaign");
    case "campaign_closed":
      return t("settings.daily.reasonCampaignClosed");
    case "await_credits":
      return t("settings.daily.reasonAwaitCredits");
    default:
      return "";
  }
}

/** The one line that says why a platform is not signed today. A platform with no credentials asks for a sign-in;
 * otherwise the reason the server gave for holding it back is shown. Empty when there is nothing to explain. */
export function platformReason(platform: Pick<CheckinPlatform, "available" | "status" | "pendingReason">): string {
  if (platform.available === false || platform.status === "unconfigured") return t("settings.daily.reasonNoCredential");
  return pendingReasonLabel(platform.pendingReason);
}

/** The statuses a run counts as signed. "already" is the platform's own earlier run today; both are a signed account. */
const SIGNED_STATUSES = new Set(["success", "already", "done"]);

/** The statuses that mean the platform itself already signed today: the hub marks a finished day success or already,
 * and its own retry logic treats exactly these, dated today, as done. partial still has accounts waiting. */
const SIGNED_TODAY_STATUSES = new Set(["success", "already"]);

/** True when the platform's own line says it signed on `today`: its status is success or already and lastDate, the
 * hub's YYYY-MM-DD for its last attempt, is today's. */
export function platformSignedToday(
  platform: Pick<CheckinPlatform, "status" | "lastDate">,
  today: string | undefined,
): boolean {
  if (!today || platform.lastDate !== today) return false;
  return SIGNED_TODAY_STATUSES.has((platform.status ?? "").toLowerCase());
}

/** True when every configured platform signed on `today` and at least one is configured, so a run has nothing left
 * to sign. Unconfigured platforms are neither signed nor waitable, and never hold the run button open. */
export function allPlatformsSignedToday(platforms: readonly CheckinPlatform[], today: string | undefined): boolean {
  const configured = platforms.filter((p) => p.available !== false && p.status !== "unconfigured");
  return configured.length > 0 && configured.every((p) => platformSignedToday(p, today));
}

/** What a run did: the platforms it signed, and the ones it did not with the message that says why. */
export function describeRun(results: CheckinRunResults | undefined): {
  signed: string[];
  failed: { key: string; message: string }[];
} {
  const signed: string[] = [];
  const failed: { key: string; message: string }[] = [];
  for (const [key, entry] of Object.entries(results ?? {})) {
    if (!entry) continue;
    if (SIGNED_STATUSES.has(String(entry.status ?? "").toLowerCase())) signed.push(key);
    else failed.push({ key, message: entry.message ?? "" });
  }
  return { signed, failed };
}

function lastCheckinText(platform: CheckinPlatform): string {
  if (!platform.lastDate) return t("settings.daily.lastCheckinNone");
  const time = platform.lastTime ? ` ${platform.lastTime}` : "";
  return t("settings.daily.lastCheckin", { when: `${platform.lastDate}${time}` });
}

function resetText(at: string | undefined): string {
  if (!at) return "";
  const date = new Date(at);
  if (Number.isNaN(date.getTime())) return "";
  return t("settings.daily.reset", {
    when: date.toLocaleString(intlLocale(), { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }),
  });
}

function clampPercent(value: number): number {
  return Math.max(0, Math.min(100, value));
}

/** Remaining share of one allowance, or null when it is unlimited or has no total to divide by. */
function remainingShare(quota: Quota): number | null {
  if (quota.unlimited) return null;
  if (typeof quota.remainingPercentage === "number" && Number.isFinite(quota.remainingPercentage)) {
    return clampPercent(quota.remainingPercentage);
  }
  const total = typeof quota.total === "number" ? quota.total : 0;
  if (total <= 0) return null;
  const remaining = typeof quota.remaining === "number" ? quota.remaining : total - (quota.used ?? 0);
  return clampPercent((remaining / total) * 100);
}

function amount(value: number | undefined): string {
  if (typeof value !== "number" || !Number.isFinite(value)) return "–";
  return value.toLocaleString(intlLocale(), { maximumFractionDigits: 1 });
}

function Skeleton({ rows }: { rows: number }) {
  return (
    <div className="mt-3 flex flex-col gap-2" aria-hidden="true">
      {Array.from({ length: rows }, (_, index) => (
        <div key={index} className="h-12 animate-pulse rounded-lg bg-ink/[0.06] motion-reduce:animate-none" />
      ))}
    </div>
  );
}

function Unreachable({ onRetry }: { onRetry: () => void }) {
  return (
    <div className="mt-3 rounded-lg bg-inset p-3">
      <div className="text-[13px] font-medium text-ink">{t("settings.daily.unreachable")}</div>
      <p className="mt-0.5 text-[12px] leading-relaxed text-ink-secondary">{t("settings.daily.unreachableHelp")}</p>
      <button type="button" className="ui-button mt-2 flex items-center gap-1.5" onClick={onRetry}>
        <RefreshCw size={13} aria-hidden="true" />
        {t("settings.daily.retry")}
      </button>
    </div>
  );
}

type QrAnswer = { ok?: boolean; loggedIn?: boolean; qrPng?: string; error?: string };

/** How long a shown QR is polled before it is called expired; the platform's own codes last about this long. */
const QR_POLL_MS = 3_000;
const QR_LIFETIME_MS = 180_000;

/** Sign a QR-login platform (Doubao) in from here: the hub's cloud browser opens the platform's login page and sends
 * back a screenshot of its QR; the person scans it with the platform's app. No credential ever passes this page. */
export function QrLogin({ platformKey, name, signedIn, onLoggedIn }: {
  platformKey: string;
  name: string;
  signedIn: boolean;
  onLoggedIn?: () => void;
}) {
  const [phase, setPhase] = useState<"idle" | "loading" | "shown" | "done" | "expired" | "failed">("idle");
  const [qr, setQr] = useState<string>("");
  const [error, setError] = useState<string>("");

  useEffect(() => {
    if (phase !== "shown") return;
    let stopped = false;
    const started = Date.now();
    const timer = setInterval(async () => {
      if (stopped) return;
      if (Date.now() - started > QR_LIFETIME_MS) { setPhase("expired"); return; }
      try {
        const answer = await api<QrAnswer>(`/hub/checkin/${platformKey}/login/status`, { timeoutMs: 60_000 });
        if (!stopped && answer?.loggedIn) {
          setPhase("done");
          onLoggedIn?.();
          // The hub checks in right after the scan; its result lands a little later.
          setTimeout(() => onLoggedIn?.(), 45_000);
        }
      } catch {
        // A missed poll is retried on the next tick.
      }
    }, QR_POLL_MS);
    return () => { stopped = true; clearInterval(timer); };
  }, [phase, platformKey, onLoggedIn]);

  const start = async () => {
    setPhase("loading");
    setError("");
    try {
      const answer = await api<QrAnswer>(`/hub/checkin/${platformKey}/login`, { method: "POST", body: "{}", timeoutMs: 180_000 });
      if (answer?.loggedIn) { setPhase("done"); onLoggedIn?.(); return; }
      if (answer?.ok && answer.qrPng) { setQr(answer.qrPng); setPhase("shown"); return; }
      setError(answer?.error || t("settings.daily.qrFailed"));
      setPhase("failed");
    } catch {
      setError(t("settings.daily.qrFailed"));
      setPhase("failed");
    }
  };

  return (
    <div className="flex flex-col gap-1.5" data-daily-qr-login>
      {phase === "shown" && qr && (
        <div className="flex flex-col items-center gap-1.5 rounded-lg bg-inset p-3">
          <img src={`data:image/png;base64,${qr}`} alt={t("settings.daily.qrAlt", { name })} className="size-40 rounded-md bg-white" />
          <p className="text-center text-[12px] leading-relaxed text-ink-secondary">{t("settings.daily.qrHint", { name })}</p>
          <p className="flex items-center gap-1 text-[11px] text-ink-tertiary">
            <Loader2 size={11} className="animate-spin motion-reduce:animate-none" aria-hidden="true" />
            {t("settings.daily.qrWaiting")}
          </p>
        </div>
      )}
      {phase === "done" && <p className="text-[12px] text-ink-secondary">{t("settings.daily.qrDone")}</p>}
      {phase === "expired" && <p className="text-[12px] text-ink-secondary">{t("settings.daily.qrExpired")}</p>}
      {phase === "failed" && error && <p className="break-words text-[12px] text-warning">{error}</p>}
      {phase !== "shown" && phase !== "done" && (
        <button
          type="button"
          className={cn("flex items-center gap-1.5 self-start", signedIn ? "py-1 text-[12px] font-medium text-accent hover:underline" : "ui-button")}
          disabled={phase === "loading"}
          onClick={() => void start()}
        >
          {phase === "loading" && <Loader2 size={13} className="animate-spin motion-reduce:animate-none" aria-hidden="true" />}
          {phase === "loading" ? t("settings.daily.qrLoading")
            : phase === "expired" || phase === "failed" ? t("settings.daily.qrRetry")
              : signedIn ? t("settings.daily.qrRelogin") : t("settings.daily.qrLogin")}
        </button>
      )}
    </div>
  );
}

/** One platform's check-in card: the platform's own line, then every account it signs, each with its status. A long
 * line of error text stays two lines tall until it is asked for in full. */
export function PlatformCard({
  platformKey,
  name,
  platform,
  onRun,
  running,
  busy,
  today,
  onLoginChanged,
}: {
  platformKey: string;
  name: string;
  platform: CheckinPlatform;
  onRun?: (key: string) => void;
  running?: boolean;
  busy?: boolean;
  today?: string;
  /** A QR-login platform signed in (or out): reload the status. */
  onLoginChanged?: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [allAccounts, setAllAccounts] = useState(false);
  const credits = creditsText(platform.credits);
  const accounts = accountSummary(platform);
  const rows = platform.accounts ?? [];
  const isUnconfigured = platform.available === false || platform.status === "unconfigured";
  const signedToday = platformSignedToday(platform, today);
  // Why the platform is not signed today: a sign-in it still needs, or the window, cooldown or campaign it waits for.
  const reason = isUnconfigured ? platformReason(platform) : pendingReasonLabel(platform.pendingReason);
  const qrLogin = platform.loginKind === "qr";
  const hasBody = Boolean(reason) || Boolean(platform.message && !isUnconfigured) || rows.length > 0 || qrLogin;

  return (
    <div className={SIMPLE_CARD} data-daily-platform>
      <SettingRow
        title={name}
        subtitle={accounts ? `${lastCheckinText(platform)} · ${accounts}` : lastCheckinText(platform)}
        className="py-2.5"
      >
        <div className="flex items-center gap-3">
          {credits && (
            <div className="text-right">
              <div className="text-[11px] text-ink-tertiary">{t("settings.daily.credits")}</div>
              <div className="text-[13px] font-medium tabular-nums text-ink">+{credits}</div>
            </div>
          )}
          <span className={cn("inline-block shrink-0 rounded-full px-2 py-0.5 text-[11px] font-medium", statusTone(platform.status))}>
            {statusLabel(platform.status)}
          </span>
          {onRun && (
            <button
              type="button"
              className="ui-button flex shrink-0 items-center gap-1.5"
              disabled={running || busy || isUnconfigured || signedToday}
              onClick={() => onRun(platformKey)}
              title={
                signedToday
                  ? statusLabel(platform.status)
                  : isUnconfigured
                    ? t("settings.daily.reasonNoCredential")
                    : t("settings.daily.run")
              }
            >
              {running && <Loader2 size={13} className="animate-spin motion-reduce:animate-none" aria-hidden="true" />}
              {running ? t("settings.daily.running") : signedToday ? signedTodayLabel() : t("settings.daily.run")}
            </button>
          )}
        </div>
      </SettingRow>

      {hasBody && (
        <div className="flex flex-col gap-1.5 px-4 pb-2.5">
          {reason && (
            <div className="rounded-lg bg-inset px-3 py-2 text-[12px] leading-relaxed text-ink-secondary">
              {reason}
            </div>
          )}
          {qrLogin && (
            <QrLogin platformKey={platformKey} name={name} signedIn={!isUnconfigured && platform.status !== "expired"} onLoggedIn={onLoginChanged} />
          )}
          {platform.message && !isUnconfigured && (
            <button
              type="button"
              onClick={() => setOpen((value) => !value)}
              aria-expanded={open}
              title={platform.message}
              className={cn(
                "w-full flex-1 break-words text-left text-[11px] leading-relaxed text-ink-tertiary",
                open ? "whitespace-pre-wrap" : "line-clamp-2",
              )}
            >
              {platform.message}
            </button>
          )}
          {rows.length > 0 && (
            <div className="flex flex-col divide-y divide-hairline/30" data-daily-accounts>
              {shownAccounts(rows, allAccounts).map((row, index) => (
                <div
                  key={`${row.identity || row.name || index}`}
                  className="flex min-w-0 flex-col gap-0.5 py-1.5"
                >
                  <div className="flex min-w-0 items-center justify-between gap-2">
                    <span
                      className="min-w-0 truncate text-[12px] text-ink"
                      title={row.message || row.display || row.name}
                    >
                      {row.display || row.name || "–"}
                    </span>
                    <div className="flex shrink-0 items-center gap-1.5">
                      {row.credits !== undefined && row.credits !== "" && Number(row.credits) > 0 && (
                        <span className="text-[11px] tabular-nums text-ink-tertiary">+{row.credits}</span>
                      )}
                      <span className={cn("inline-block shrink-0 rounded-full px-2 py-0.5 text-[11px] font-medium", statusTone(row.status))}>
                        {statusLabel(row.status)}
                      </span>
                    </div>
                  </div>
                  {row.message && row.message !== platform.message && (
                    <div className="truncate text-[11px] text-ink-tertiary" title={row.message}>
                      {row.message}
                    </div>
                  )}
                </div>
              ))}
              {rows.length > ACCOUNT_ROWS && (
                <button
                  type="button"
                  onClick={() => setAllAccounts((value) => !value)}
                  aria-expanded={allAccounts}
                  className="self-start py-1.5 text-left text-[12px] font-medium text-accent hover:underline"
                >
                  {allAccounts ? t("settings.daily.showLess") : t("settings.daily.showAll", { count: rows.length })}
                </button>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/** One worker's allowances. Every bar is laid out in the card; past four rows the rest wait behind one button. */
function QuotaCard({ name, worker }: { name: string; worker: QuotaWorker }) {
  const quotas = worker.quotas ?? [];
  const [expanded, setExpanded] = useState(false);
  const shown = shownQuotas(quotas, expanded);
  return (
    <div className={SIMPLE_CARD} data-daily-worker>
      <div className="px-4 py-2.5">
        <div className="text-[14px] font-medium leading-5 text-ink in-data-[settings-look=simple]:font-normal">{name}</div>
        {(worker.account || worker.plan) && (
          <p className="mt-1 text-[12px] leading-relaxed text-ink-secondary in-data-[settings-look=simple]:mt-0 in-data-[settings-look=simple]:text-[13px] in-data-[settings-look=simple]:leading-[18px]">
            {/* The plan usually repeats the account; one line is enough. */}
            {worker.account && worker.plan?.includes(worker.account)
              ? worker.plan
              : [worker.account, worker.plan].filter(Boolean).join(" · ")}
          </p>
        )}
      </div>
      {quotas.length > 0 ? (
        <div className="flex flex-col divide-y divide-hairline/30 px-4">
          {shown.map((entry, index) => {
            const share = remainingShare(entry);
            const used = share === null ? 0 : 100 - share;
            const low = share !== null && share < 20;
            return (
              <div key={`${entry.name ?? entry.displayName ?? index}`} className="min-w-0 py-2.5">
                <div className="flex flex-wrap items-baseline justify-between gap-x-2 text-[12px]">
                  <span className="min-w-0 truncate text-ink">{entry.displayName || entry.name || "–"}</span>
                  <span className={cn("ms-auto shrink-0 tabular-nums", low ? "text-warning" : "text-ink-secondary")}>
                    {share === null ? t("settings.daily.unlimited") : `${Math.round(share)}%`}
                  </span>
                </div>
                <div
                  className="mt-1 h-1.5 w-full min-w-0 overflow-hidden rounded-full bg-inset"
                  data-daily-quota-track
                  role="img"
                  aria-label={`${entry.displayName || entry.name || ""} · ${t("settings.daily.used")} ${amount(entry.used)} / ${entry.unlimited ? t("settings.daily.unlimited") : amount(entry.total)}`}
                >
                  <div
                    className={cn("h-full rounded-full transition-[width] duration-300 motion-reduce:transition-none", low ? "bg-warning" : "bg-accent")}
                    style={{ width: share === null ? "100%" : `${used}%` }}
                  />
                </div>
                <div className="mt-1 flex flex-wrap items-baseline justify-between gap-x-2 text-[11px] text-ink-tertiary">
                  <span className="min-w-0 truncate">
                    {t("settings.daily.used")} {amount(entry.used)}
                    {entry.unlimited ? "" : ` / ${amount(entry.total)}`}
                  </span>
                  {resetText(entry.resetAt) && <span className="shrink-0">{resetText(entry.resetAt)}</span>}
                </div>
              </div>
            );
          })}
          {quotas.length > QUOTA_ROWS && (
            <button
              type="button"
              onClick={() => setExpanded((value) => !value)}
              aria-expanded={expanded}
              className="self-start py-2 text-left text-[12px] font-medium text-accent hover:underline"
            >
              {expanded ? t("settings.daily.showLess") : t("settings.daily.showAll", { count: quotas.length })}
            </button>
          )}
        </div>
      ) : (
        <p className="break-words px-4 pb-2.5 text-[12px] leading-relaxed text-ink-tertiary">
          {worker.message || t("settings.daily.noQuota")}
        </p>
      )}
    </div>
  );
}

export function DailySection() {
  const [checkin, setCheckin] = useState<CheckinStatus | null>(null);
  const [checkinDown, setCheckinDown] = useState(false);
  const [loadingCheckin, setLoadingCheckin] = useState(true);
  const [running, setRunning] = useState(false);
  const [runningPlatform, setRunningPlatform] = useState<string | null>(null);
  const [runFailed, setRunFailed] = useState<string | null>(null);
  const [runReport, setRunReport] = useState<{ signed: string[]; failed: { key: string; message: string }[] } | null>(null);
  const [autoSaving, setAutoSaving] = useState(false);
  const [autoFailed, setAutoFailed] = useState(false);
  const [quota, setQuota] = useState<QuotaReport | null>(null);
  const [quotaDown, setQuotaDown] = useState(false);
  const [loadingQuota, setLoadingQuota] = useState(true);

  const loadCheckin = useCallback(async () => {
    try {
      const next = await api<CheckinStatus>("/hub/checkin/status");
      setCheckin(next);
      setCheckinDown(false);
    } catch {
      setCheckinDown(true);
    } finally {
      setLoadingCheckin(false);
    }
  }, []);

  const loadQuota = useCallback(async () => {
    try {
      const next = await api<QuotaReport>("/hub/quota");
      setQuota(next);
      setQuotaDown(false);
    } catch {
      setQuotaDown(true);
    } finally {
      setLoadingQuota(false);
    }
  }, []);

  useEffect(() => {
    void loadCheckin();
    void loadQuota();
  }, [loadCheckin, loadQuota]);

  // A run really checks in everywhere and the console gives it up to two minutes, so the button stays shut until the
  // fresh status is back rather than reporting a success nobody read.
  const runNow = async () => {
    if (running || runningPlatform) return;
    setRunning(true);
    setRunFailed(null);
    setRunReport(null);
    try {
      const answer = await api<CheckinRunResponse>("/hub/checkin/run", {
        method: "POST",
        body: JSON.stringify({ platform: "all" }),
        timeoutMs: 180_000,
      });
      setRunReport(describeRun(answer?.results));
    } catch {
      setRunFailed(t("settings.daily.runFailed"));
    }
    await loadCheckin();
    setRunning(false);
  };

  // One platform on its own, so a platform that needs a sign-in can be retried without waiting for the other seven.
  const runPlatform = async (platformKey: string) => {
    if (running || runningPlatform) return;
    setRunningPlatform(platformKey);
    setRunFailed(null);
    setRunReport(null);
    try {
      const answer = await api<CheckinRunResponse>("/hub/checkin/run", {
        method: "POST",
        body: JSON.stringify({ platform: platformKey }),
        timeoutMs: 120_000,
      });
      setRunReport(describeRun(answer?.results));
    } catch {
      setRunFailed(t("settings.daily.runFailedPlatform", { name: platformName(platformKey) }));
    }
    await loadCheckin();
    setRunningPlatform(null);
  };

  // The daily run is the hub's own timer, not a second one here: the switch only tells that timer to run or stand still.
  const toggleAuto = async () => {
    if (autoSaving) return;
    const next = !autoOn;
    setAutoSaving(true);
    setAutoFailed(false);
    try {
      const answer = await api<{ ok?: boolean; overview?: CheckinStatus }>("/hub/checkin/config", {
        method: "POST",
        body: JSON.stringify({ autoCheckin: next }),
      });
      if (answer?.overview) setCheckin(answer.overview);
      else await loadCheckin();
    } catch {
      setAutoFailed(true);
    }
    setAutoSaving(false);
  };

  // Both lists are ordered the way the AI lists are: what is ready or signed in first, then the rest by name. No
  // per-engine timestamp reaches the window, so the "recently used" group is never filled. A hub platform with no
  // engine of its own (TRAE, WorkBuddy) has neither flag and lands last.
  const { state } = useStore();
  const engines: DailyEngine[] = state.instances.map((instance) => ({
    instanceId: instance.instanceId,
    displayName: instance.displayName,
    driverKind: instance.driverKind,
    ready: engineReady(instance),
    signedIn: instance.snapshot.authenticated === true,
  }));
  const platforms = sortEngines(Object.entries(checkin?.platforms ?? {}).map(([key, platform]) => {
    const engine = engineFor(key, engines);
    return { key, platform, name: platformName(key), ready: engine?.ready, signedIn: engine?.signedIn };
  }));
  // Nothing left to sign: when every configured platform already signed today, the run button stands down too, and
  // its tooltip says so with the same tally the platform cards show.
  const configuredPlatforms = Object.values(checkin?.platforms ?? {}).filter(
    (platform) => platform.available !== false && platform.status !== "unconfigured",
  );
  const configuredCount = configuredPlatforms.length;
  const allSigned = allPlatformsSignedToday(configuredPlatforms, checkin?.today);
  const workers = sortEngines(Object.entries(quota?.workers ?? {}).map(([key, worker]) => {
    const name = platformName(worker.worker || key);
    const engine = engineFor(worker.worker || key, engines);
    return { key, worker, name, ready: engine?.ready, signedIn: engine?.signedIn };
  }));
  const todayLabel = checkin?.today
    ? t("settings.daily.today", { date: checkin.today })
    : t("settings.daily.todayUnknown");
  const autoLabel = checkin?.autoCheckin
    ? t("settings.daily.autoAt", { time: checkin.autoCheckinTime || "08:30" })
    : "";
  const autoOn = checkin?.autoCheckin !== false;

  return (
    <div className="flex min-h-0 flex-col gap-4" data-daily>
      <Card title={t("settings.daily.checkin")} subtitle={t("settings.daily.checkinHelp")}>
        <SettingRow
          title={todayLabel}
          subtitle={autoLabel || undefined}
          className="px-0"
          message={runFailed ? <p role="status" className="text-warning">{runFailed}</p> : null}
        >
          <button
            type="button"
            className="ui-button ui-button-primary flex shrink-0 items-center gap-1.5"
            disabled={running || !!runningPlatform || loadingCheckin || allSigned}
            onClick={() => void runNow()}
            title={
              allSigned
                ? t("settings.daily.accountsSigned", { signed: configuredCount, count: configuredCount })
                : undefined
            }
          >
            {running && <Loader2 size={13} className="animate-spin motion-reduce:animate-none" aria-hidden="true" />}
            {running ? t("settings.daily.running") : allSigned ? signedTodayLabel() : t("settings.daily.run")}
          </button>
        </SettingRow>
        {runReport && (runReport.signed.length > 0 || runReport.failed.length > 0) && (
          <div className="mt-2 rounded-lg bg-inset px-3 py-2" data-daily-run-report>
            <p className="text-[12px] text-ink-secondary">
              {t("settings.daily.runSummary", { signed: runReport.signed.length, failed: runReport.failed.length })}
            </p>
            {runReport.failed.map((item) => (
              <p key={item.key} className="mt-0.5 truncate text-[12px] text-danger" title={item.message}>
                {platformName(item.key)}{item.message ? ` · ${item.message}` : ""}
              </p>
            ))}
          </div>
        )}
        {!loadingCheckin && !checkinDown && (
          <div className={cn(SIMPLE_CARD, "mt-2")} data-daily-auto>
            <SettingRow
              title={t("settings.daily.autoCheckin")}
              subtitle={autoOn ? autoLabel : t("settings.daily.autoOff")}
              message={autoFailed ? <p role="status" className="text-warning">{t("settings.daily.autoFailed")}</p> : undefined}
            >
              <Switch
                checked={autoOn}
                disabled={autoSaving}
                onClick={() => void toggleAuto()}
                aria-label={t("settings.daily.autoCheckin")}
              />
            </SettingRow>
          </div>
        )}
        {loadingCheckin ? (
          <Skeleton rows={3} />
        ) : checkinDown ? (
          <Unreachable onRetry={() => { setLoadingCheckin(true); void loadCheckin(); }} />
        ) : platforms.length === 0 ? (
          <p className="mt-3 text-[12px] text-ink-secondary">{t("settings.daily.emptyPlatforms")}</p>
        ) : (
          // A wrapping grid, not a rail: every platform is on the page at once, one column on a phone and as many
          // as fit once there is room, so the third card is never half cut off at the edge.
          <div
            className="mt-3 grid gap-2 [grid-template-columns:repeat(auto-fill,minmax(min(15rem,100%),1fr))]"
            data-daily-platforms
          >
            {platforms.map(({ key, platform, name }) => (
              <PlatformCard
                key={key}
                platformKey={key}
                name={name}
                platform={platform}
                onRun={runPlatform}
                running={runningPlatform === key}
                busy={running || !!runningPlatform}
                today={checkin?.today}
                onLoginChanged={loadCheckin}
              />
            ))}
          </div>
        )}
      </Card>

      <Card title={t("settings.daily.quota")} subtitle={t("settings.daily.quotaHelp")}>
        {loadingQuota ? (
          <Skeleton rows={2} />
        ) : quotaDown ? (
          <Unreachable onRetry={() => { setLoadingQuota(true); void loadQuota(); }} />
        ) : workers.length === 0 ? (
          <p className="mt-3 text-[12px] text-ink-secondary">{t("settings.daily.emptyQuota")}</p>
        ) : (
          // The same wrapping grid as the check-in row, and no fixed height: a card grows to fit every allowance bar
          // instead of hiding the ones past its fourth row inside a scroll box of its own.
          <div
            className="mt-3 grid gap-2 [grid-template-columns:repeat(auto-fill,minmax(min(17rem,100%),1fr))]"
            data-daily-workers
          >
            {workers.map(({ key, worker, name }) => (
              <QuotaCard key={key} name={name} worker={worker} />
            ))}
          </div>
        )}
        {quota?.updatedAt && !loadingQuota && !quotaDown && (
          <p className="mt-3 text-[11px] text-ink-tertiary">
            {t("settings.daily.updatedAt", {
              when: new Date(quota.updatedAt).toLocaleString(intlLocale(), { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }),
            })}
          </p>
        )}
      </Card>
    </div>
  );
}
