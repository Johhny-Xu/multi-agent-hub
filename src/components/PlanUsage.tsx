import { useCallback, useEffect, useRef, useState } from "react";
import { Loader2, RefreshCw } from "lucide-react";
import { api, useStore, type InstanceInfo } from "@/state/store";
import { t, intlLocale } from "@/lib/i18n";
import { cn } from "@/lib/cn";
import { Card, SIMPLE_CARD } from "./SettingsPrimitives";
import { UsageSummaryCard } from "./CloudUsageMeter";
import { formatPlanSpend, type PlanSpend } from "@/lib/plan-spend";
import { engineReady } from "./EngineLibrary";
import { sortEngines } from "@/lib/engine-sort";

interface PlanWindow {
  available: boolean;
  remainingPercent: number | null;
  usedPercent: number | null;
  resetsAt: string | null;
}

interface PlanExtra {
  label: string;
  remainingPercent: number;
  usedPercent: number;
  resetsAt: string | null;
  spend?: PlanSpend;
  amounts?: { used: number; total: number; unit?: string };
}

interface PlanModelUsage {
  name: string;
  windows: PlanExtra[];
}

interface PlanProvider {
  id: string;
  name: string;
  driver: string;
  plan: string | null;
  ok: boolean;
  error: string | null;
  fiveHour: PlanWindow;
  weekly: PlanWindow;
  extra: PlanExtra[];
  models?: PlanModelUsage[];
}

interface PlanUsageReport {
  fetchedAt: string;
  providers: PlanProvider[];
}

export interface Quota {
  name?: string;
  displayName?: string;
  used?: number;
  total?: number;
  remaining?: number;
  remainingPercentage?: number;
  resetAt?: string | null;
  unlimited?: boolean;
  recurring?: boolean;
  isCreditBalance?: boolean;
  unit?: string;
}

export interface QuotaWorker {
  worker: string;
  fetchedAt?: string;
  account?: string;
  plan?: string;
  message?: string;
  quotas?: Quota[];
}

export interface QuotaReport {
  updatedAt?: string;
  workers?: Record<string, QuotaWorker>;
}

function clampPercent(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(100, Math.max(0, value));
}

function amount(value: number | undefined): string {
  if (typeof value !== "number" || !Number.isFinite(value)) return "–";
  return value.toLocaleString(intlLocale(), { maximumFractionDigits: 1 });
}

export function remainingShare(quota: Quota): number | null {
  if (quota.unlimited) return null;
  if (typeof quota.remainingPercentage === "number" && Number.isFinite(quota.remainingPercentage)) {
    return clampPercent(quota.remainingPercentage);
  }
  const total = typeof quota.total === "number" ? quota.total : 0;
  if (total <= 0) return null;
  const remaining = typeof quota.remaining === "number" ? quota.remaining : total - (quota.used ?? 0);
  return clampPercent((remaining / total) * 100);
}

export function quotaDetail(quota: Quota): string | undefined {
  if (quota.unlimited) return t("planUsage.unlimited");
  if (typeof quota.total === "number" && quota.total > 0) {
    const used = quota.used ?? (typeof quota.remaining === "number" ? quota.total - quota.remaining : 0);
    const unit = quota.unit ? ` ${quota.unit}` : "";
    return `${amount(used)} / ${amount(quota.total)}${unit}`;
  }
  if (typeof quota.remaining === "number" && typeof quota.used === "number") {
    const unit = quota.unit ? ` ${quota.unit}` : "";
    return `${amount(quota.used)} (${amount(quota.remaining)} left${unit})`;
  }
  if (typeof quota.remaining === "number") {
    const unit = quota.unit ? ` ${quota.unit}` : "";
    return `${amount(quota.remaining)} left${unit}`;
  }
  if (typeof quota.used === "number") {
    const unit = quota.unit ? ` ${quota.unit}` : "";
    return `${amount(quota.used)} used${unit}`;
  }
  return undefined;
}

function folded(value: string | undefined): string {
  if (!value) return "";
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "");
}

export function quotaWorkerForInstance(instance: InstanceInfo, workers: Record<string, QuotaWorker>): QuotaWorker | undefined {
  const instanceKeys = [instance.instanceId, instance.displayName, instance.driverKind].map(folded).filter(Boolean);
  for (const [key, worker] of Object.entries(workers)) {
    const workerKeys = [key, worker.worker, worker.account].map(folded).filter(Boolean);
    if (instanceKeys.some((ik) => workerKeys.includes(ik))) {
      return worker;
    }
  }
  return undefined;
}

export function groupAndSortInstances(instances: readonly InstanceInfo[]): InstanceInfo[] {
  const visible = instances.filter((i) => !i.hidden);

  const familyMap = new Map<string, { primary: InstanceInfo; secondaries: InstanceInfo[] }>();

  for (const instance of visible) {
    const id = instance.instanceId;
    let familyKey = id;
    if (id === "claudeApi" || id.startsWith("claude-")) {
      familyKey = "claude";
    } else if (id === "chatgpt" || id.startsWith("chatgpt-")) {
      familyKey = "codex";
    } else if (id === "xaiApi" || id.startsWith("xai-")) {
      familyKey = "grok";
    } else if (id.startsWith("antigravity-")) {
      familyKey = "antigravity";
    }

    const hasPrimary = visible.some((inst) => inst.instanceId === familyKey);
    const targetKey = hasPrimary ? familyKey : id;

    if (!familyMap.has(targetKey)) {
      familyMap.set(targetKey, { primary: instance, secondaries: [] });
    } else {
      const entry = familyMap.get(targetKey)!;
      if (instance.instanceId === targetKey) {
        entry.secondaries.unshift(entry.primary);
        entry.primary = instance;
      } else {
        entry.secondaries.push(instance);
      }
    }
  }

  const sortableGroups = Array.from(familyMap.values()).map((group) => {
    const allInGroup = [group.primary, ...group.secondaries];
    const isReady = allInGroup.some((inst) => engineReady(inst));
    const isSignedIn = allInGroup.some((inst) => inst.snapshot.authenticated === true);
    return {
      name: group.primary.displayName,
      ready: isReady,
      signedIn: isSignedIn,
      group,
    };
  });

  const sorted = sortEngines(sortableGroups);

  return sorted.flatMap((item) => [item.group.primary, ...item.group.secondaries]);
}

function formatResetDistance(resetsAt: string | null, now: number): string | null {
  if (!resetsAt) return null;
  const at = Date.parse(resetsAt);
  if (!Number.isFinite(at) || at <= now) return null;
  const minutes = Math.floor((at - now) / 60_000);
  if (minutes < 1) return "less than a minute";
  const days = Math.floor(minutes / 1440);
  const hours = Math.floor((minutes % 1440) / 60);
  const mins = minutes % 60;
  if (days > 0) return hours > 0 ? `${days}d ${hours}h` : `${days}d`;
  if (hours > 0) return mins > 0 ? `${hours}h ${mins}m` : `${hours}h`;
  return `${mins}m`;
}

function dueResetDeadlines(report: PlanUsageReport, now: number, seen: Set<string>): string[] {
  const due: string[] = [];
  for (const provider of report.providers) {
    if (!provider.ok) continue;
    const stamps = [
      provider.fiveHour.available ? provider.fiveHour.resetsAt : null,
      provider.weekly.available ? provider.weekly.resetsAt : null,
      ...provider.extra.map((extra) => extra.resetsAt),
      ...(provider.models ?? []).flatMap((model) => model.windows.map((entry) => entry.resetsAt)),
    ];
    for (const resetsAt of stamps) {
      if (!resetsAt || seen.has(resetsAt) || due.includes(resetsAt)) continue;
      const at = Date.parse(resetsAt);
      if (Number.isFinite(at) && at <= now) due.push(resetsAt);
    }
  }
  return due;
}

function usageTone(used: number): string {
  if (used >= 90) return "bg-danger";
  if (used >= 70) return "bg-warning";
  return "bg-success";
}

function windowLabel(label: string): string {
  if (label === "5-hour") return t("planUsage.fiveHour");
  if (label === "Weekly") return t("planUsage.weekly");
  if (label === "Monthly spend") return t("planUsage.monthlySpend");
  if (label === "Model credits") return t("planUsage.modelCredits");
  return label;
}

/** The numbers behind an extra line: a money budget's spend, or a credit allowance's counts. */
function extraDetail(extra: PlanExtra): string | undefined {
  if (extra.spend) return formatPlanSpend(extra.spend);
  if (extra.amounts && extra.amounts.total > 0) {
    const unit = extra.amounts.unit ? ` ${extra.amounts.unit}` : "";
    return `${amount(extra.amounts.used)} / ${amount(extra.amounts.total)}${unit}`;
  }
  return undefined;
}

function providerLabel(provider: Pick<PlanProvider, "name">): string {
  const normalized = provider.name.trim().toLowerCase();
  if (normalized === "chatgpt plan") return t("planUsage.provider.chatgptPlan");
  if (normalized === "claude (api key)") return t("planUsage.provider.claudeApiKey");
  return provider.name;
}

function providerError(provider: Pick<PlanProvider, "error">): string | null {
  const message = provider.error?.trim();
  if (!message) return null;
  const signIn = /^Sign in again in (.+)$/i.exec(message);
  return signIn ? t("planUsage.signInAgain", { provider: providerLabel({ name: signIn[1]! }) }) : message;
}

function WindowRow({
  label,
  window,
  now,
  usedHeadline = false,
  detail,
}: {
  label: string;
  window: PlanWindow;
  now: number;
  usedHeadline?: boolean;
  detail?: string;
}) {
  const when = window.available ? formatResetDistance(window.resetsAt, now) : null;
  const used = window.usedPercent ?? 0;
  const headline = usedHeadline
    ? window.usedPercent == null ? null : t("planUsage.used", { used: Math.round(window.usedPercent) })
    : window.remainingPercent == null ? null : t("planUsage.left", { remaining: Math.round(window.remainingPercent) });
  return (
    <div className="grid grid-cols-[4.5rem_minmax(0,1fr)] items-center gap-x-3 gap-y-1">
      <div className="text-[12px] text-ink-secondary">{label}</div>
      {window.available && (headline || detail) ? (
        <div className="min-w-0">
          <div className="flex flex-wrap items-baseline gap-x-2 text-[13px] text-ink">
            {headline && <span className="tabular-nums">{headline}</span>}
            {detail && <span data-plan-spend className="text-[12px] tabular-nums text-ink-secondary">{detail}</span>}
            {when && <span className="text-[12px] text-ink-secondary">{t("planUsage.resetsIn", { when })}</span>}
          </div>
          {window.remainingPercent !== null && window.usedPercent !== null && (
            <div
              className="mt-1 h-1.5 overflow-hidden rounded-full bg-inset"
              role="meter"
              aria-label={label}
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={Math.round(Math.min(100, Math.max(0, used)))}
            >
              <div className={cn("h-full rounded-full", usageTone(used))} style={{ width: `${Math.min(100, Math.max(0, used))}%` }} />
            </div>
          )}
        </div>
      ) : (
        <div className="text-[12px] text-ink-secondary">{t("planUsage.notReported")}</div>
      )}
    </div>
  );
}

function usePlanUsage() {
  const [report, setReport] = useState<PlanUsageReport | null>(null);
  const [quotaReport, setQuotaReport] = useState<QuotaReport | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [now, setNow] = useState(() => Date.now());
  const refreshedDeadlines = useRef(new Set<string>());

  const load = useCallback(async (refresh = false) => {
    setLoading(true);
    setError("");
    try {
      const [data, hubData] = await Promise.all([
        api<PlanUsageReport>(refresh ? "/api/plan-usage?refresh=1" : "/api/plan-usage"),
        api<QuotaReport>("/hub/quota").catch(() => null),
      ]);
      setReport(data);
      setQuotaReport(hubData);
      setNow(Date.now());
    } catch (cause) {
      setError(cause instanceof Error && cause.message ? cause.message : t("planUsage.fetchError"));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load(false);
  }, [load]);

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 30_000);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    if (!report) return;
    const due = dueResetDeadlines(report, now, refreshedDeadlines.current);
    if (due.length === 0) return;
    for (const deadline of due) refreshedDeadlines.current.add(deadline);
    void load(true);
  }, [report, now, load]);

  return { report, quotaReport, loading, error, now, load };
}

/** The budget of a plan with no weekly window, to stand in for the weekly figure. */
export function monthlySpend(report: Pick<PlanUsageReport, "providers"> | null): { provider: PlanProvider; budget: PlanExtra } | null {
  for (const provider of report?.providers ?? []) {
    const budget = provider.ok && !provider.weekly.available ? provider.extra.find((extra) => extra.label === "Monthly spend") : undefined;
    if (budget) return { provider, budget };
  }
  return null;
}

export function busiestWeekly(report: Pick<PlanUsageReport, "providers"> | null): { provider: PlanProvider; used: number } | null {
  let busiest: { provider: PlanProvider; used: number } | null = null;
  for (const provider of report?.providers ?? []) {
    const used = provider.ok && provider.weekly.available ? provider.weekly.usedPercent : null;
    if (used !== null && (!busiest || used > busiest.used)) busiest = { provider, used };
  }
  return busiest;
}

export function PlanUsageSummary() {
  const { report, now } = usePlanUsage();
  if (!report) return null;
  const busiest = busiestWeekly(report);
  const spending = busiest ? null : monthlySpend(report);
  if (spending) {
    const name = providerLabel(spending.provider);
    const used = Math.round(Math.min(100, Math.max(0, spending.budget.usedPercent)));
    return <UsageSummaryCard kind="plan" title={t("settings.simple.billing.monthlySpend", { provider: name })} percent={used} label={`${name}: ${t("planUsage.used", { used })}`}
      note={spending.budget.spend ? formatPlanSpend(spending.budget.spend) : null} />;
  }
  if (!busiest) {
    return <section data-usage-summary="own-ai" className={cn(SIMPLE_CARD, "px-4 py-3.5 text-[14px] leading-5 text-ink-secondary")}>{t("settings.simple.billing.ownAi")}</section>;
  }
  const percent = Math.round(Math.min(100, Math.max(0, busiest.used)));
  const when = formatResetDistance(busiest.provider.weekly.resetsAt, now);
  const name = providerLabel(busiest.provider);
  return (
    <UsageSummaryCard kind="plan" title={t("settings.simple.billing.weekly", { provider: name })} percent={percent} label={`${name}: ${t("planUsage.used", { used: percent })}`}
      note={when ? t("planUsage.resetsIn", { when }) : null} />
  );
}

export function PlanUsage(props: {
  instances?: InstanceInfo[];
  quotaReport?: QuotaReport;
}) {
  const { instances: propInstances, quotaReport: propQuotaReport } = props ?? {};
  const { report, quotaReport: fetchedQuota, loading, error, now, load } = usePlanUsage();
  const quotaReport = propQuotaReport ?? fetchedQuota;

  const store = typeof useStore === "function" ? useStore() : undefined;
  const rawInstances: InstanceInfo[] = propInstances ?? store?.state?.instances ?? [];
  const dispatch = store?.dispatch;

  const instances = groupAndSortInstances(rawInstances);
  const useInstanceMode = instances.length > 0;

  return (
    <Card title={t("planUsage.title")} subtitle={t("planUsage.subtitle")}>
      <div className="mb-3 flex justify-end">
        <button
          type="button"
          onClick={() => void load(true)}
          disabled={loading}
          aria-label={t("planUsage.refresh")}
          title={t("planUsage.refresh")}
          className="ui-icon-button"
        >
          {loading ? <Loader2 size={14} className="animate-spin" /> : <RefreshCw size={14} />}
        </button>
      </div>
      {loading && !report && <p role="status" className="text-[13px] text-ink-secondary">{t("planUsage.loading")}</p>}
      {error && <p role="alert" className="mb-3 text-[13px] text-danger">{error}</p>}
      {!useInstanceMode && report && report.providers.length === 0 && (
        <p className="text-[13px] text-ink-secondary">{t("planUsage.empty")}</p>
      )}
      {useInstanceMode && instances.length === 0 && (
        <p className="text-[13px] text-ink-secondary">{t("planUsage.empty")}</p>
      )}

      {/* Instance-driven mode (shows all registered CLI engines sorted, with multiple plan rows grouped) */}
      {useInstanceMode && instances.length > 0 && (
        <div className="flex flex-col divide-y divide-hairline/30">
          {instances.map((instance) => {
            const provider = report?.providers.find((p) => p.id === instance.instanceId);
            const worker = quotaReport?.workers ? quotaWorkerForInstance(instance, quotaReport.workers) : undefined;
            const hasProviderWindows = provider?.ok && (provider.fiveHour.available || provider.weekly.available || provider.extra.length > 0 || (provider.models && provider.models.length > 0));
            const hasWorkerQuotas = Boolean(worker?.quotas && worker.quotas.length > 0);
            const plan = provider?.plan || worker?.plan || null;
            const isInstalled = instance.snapshot.state === "available";
            const isNotSignedIn = isInstalled && instance.snapshot.authenticated === false;

            return (
              <div
                key={instance.instanceId}
                data-plan-provider={instance.instanceId}
                className={cn(
                  "py-3 first:pt-0 last:pb-0",
                  instance.disabled && "opacity-60",
                )}
              >
                <div className="mb-2 flex min-w-0 items-baseline gap-2">
                  <span className="truncate text-[14px] font-medium text-ink">
                    {providerLabel({ name: instance.displayName })}
                  </span>
                  {plan && <span className="truncate text-[12px] text-ink-secondary">{plan}</span>}
                  {instance.disabled && (
                    <span className="rounded-full bg-ink/[0.07] px-2 py-0.5 text-[11px] font-medium text-ink-tertiary">
                      {t("planUsage.disabled")}
                    </span>
                  )}
                </div>

                {provider && !provider.ok ? (
                  <p className="text-[13px] text-danger">{providerError(provider)}</p>
                ) : hasProviderWindows ? (
                  <div className="flex flex-col gap-2">
                    <WindowRow label={t("planUsage.fiveHour")} window={provider.fiveHour} now={now} />
                    <WindowRow label={t("planUsage.weekly")} window={provider.weekly} now={now} />
                    {provider.extra.map((extra, index) => (
                      <WindowRow
                        key={`${extra.label}-${index}`}
                        label={windowLabel(extra.label)}
                        now={now}
                        usedHeadline={Boolean(extra.spend)}
                        detail={extraDetail(extra)}
                        window={{
                          available: true,
                          remainingPercent: extra.remainingPercent,
                          usedPercent: extra.usedPercent,
                          resetsAt: extra.resetsAt,
                        }}
                      />
                    ))}
                    {(provider.models ?? []).length > 0 && (
                      <div className="mt-1 flex flex-col gap-2">
                        <div className="text-[11px] font-medium uppercase tracking-[0.08em] text-ink-secondary">
                          {t("planUsage.byModel")}
                        </div>
                        {(provider.models ?? []).map((model) => (
                          <div key={model.name} className="flex flex-col gap-1">
                            <div className="truncate text-[13px] font-medium text-ink">{model.name}</div>
                            {model.windows.map((entry, index) => (
                              <WindowRow
                                key={`${model.name}-${entry.label}-${index}`}
                                label={windowLabel(entry.label)}
                                now={now}
                                usedHeadline
                                window={{
                                  available: true,
                                  remainingPercent: entry.remainingPercent,
                                  usedPercent: entry.usedPercent,
                                  resetsAt: entry.resetsAt,
                                }}
                              />
                            ))}
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                ) : hasWorkerQuotas ? (
                  <div className="flex flex-col gap-2">
                    {worker!.quotas!.map((quota, index) => {
                      const remShare = remainingShare(quota);
                      const remainingPercent = remShare;
                      const usedPercent = remShare !== null ? clampPercent(100 - remShare) : null;
                      const detail = quotaDetail(quota);
                      return (
                        <WindowRow
                          key={`${quota.name || quota.displayName || index}-${index}`}
                          label={quota.displayName || quota.name || t("planUsage.quota")}
                          now={now}
                          detail={detail}
                          window={{
                            available: true,
                            remainingPercent,
                            usedPercent,
                            resetsAt: quota.resetAt ?? null,
                          }}
                        />
                      );
                    })}
                  </div>
                ) : !isInstalled ? (
                  <p className="text-[13px] text-ink-secondary">{t("planUsage.notInstalled")}</p>
                ) : isNotSignedIn ? (
                  <div className="flex items-center gap-2">
                    <span className="text-[13px] text-ink-secondary">{t("planUsage.notSignedIn")}</span>
                    <button
                      type="button"
                      onClick={() => dispatch?.({ type: "toggleAppSettings", open: true, section: "engines" })}
                      className="cursor-pointer text-[12px] text-accent hover:underline"
                    >
                      {t("planUsage.goToSignIn")}
                    </button>
                  </div>
                ) : (
                  <p className="text-[13px] text-ink-secondary">{t("planUsage.signedInNoQuota")}</p>
                )}
              </div>
            );
          })}
        </div>
      )}

      {/* Fallback report-only mode (when instances store is not available) */}
      {!useInstanceMode && report && report.providers.length > 0 && (
        <div className="flex flex-col divide-y divide-hairline/30">
          {report.providers.map((provider) => (
            <div key={provider.id} className="py-3 first:pt-0 last:pb-0">
              <div className="mb-2 flex min-w-0 items-baseline gap-2">
                <span className="truncate text-[14px] font-medium text-ink">{providerLabel(provider)}</span>
                {provider.plan && <span className="truncate text-[12px] text-ink-secondary">{provider.plan}</span>}
              </div>
              {provider.ok ? (
                <div className="flex flex-col gap-2">
                  <WindowRow label={t("planUsage.fiveHour")} window={provider.fiveHour} now={now} />
                  <WindowRow label={t("planUsage.weekly")} window={provider.weekly} now={now} />
                  {provider.extra.map((extra, index) => (
                    <WindowRow
                      key={`${extra.label}-${index}`}
                      label={windowLabel(extra.label)}
                      now={now}
                      usedHeadline={Boolean(extra.spend)}
                      detail={extraDetail(extra)}
                      window={{
                        available: true,
                        remainingPercent: extra.remainingPercent,
                        usedPercent: extra.usedPercent,
                        resetsAt: extra.resetsAt,
                      }}
                    />
                  ))}
                  {(provider.models ?? []).length > 0 && (
                    <div className="mt-1 flex flex-col gap-2">
                      <div className="text-[11px] font-medium uppercase tracking-[0.08em] text-ink-secondary">{t("planUsage.byModel")}</div>
                      {(provider.models ?? []).map((model) => (
                        <div key={model.name} className="flex flex-col gap-1">
                          <div className="truncate text-[13px] font-medium text-ink">{model.name}</div>
                          {model.windows.map((entry, index) => (
                            <WindowRow
                              key={`${model.name}-${entry.label}-${index}`}
                              label={windowLabel(entry.label)}
                              now={now}
                              usedHeadline
                              window={{
                                available: true,
                                remainingPercent: entry.remainingPercent,
                                usedPercent: entry.usedPercent,
                                resetsAt: entry.resetsAt,
                              }}
                            />
                          ))}
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              ) : (
                <p className="text-[13px] text-danger">{providerError(provider)}</p>
              )}
            </div>
          ))}
        </div>
      )}
    </Card>
  );
}
