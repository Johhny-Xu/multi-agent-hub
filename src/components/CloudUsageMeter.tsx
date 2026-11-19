import { useContext, useState, type ReactNode } from "react";
import { X } from "lucide-react";
import type { CloudPlanBridge, CloudPlanSnapshot } from "../../electron/cloud-account.mjs";
import type { CloudUsage, CloudUsageMeter } from "../../electron/cloud-home.mjs";
import { useCloudPlanSnapshot } from "./CloudTrialNotice";
import { Card, SettingsLook, SIMPLE_CARD } from "./SettingsPrimitives";
import { localDesktopPage } from "./onboarding/WelcomeGate";
import { cloudPlanLabel } from "@/lib/cloud-plan";
import { cn } from "@/lib/cn";
import { t } from "@/lib/i18n";
import { useAdvancedMode } from "@/lib/interface-mode";
import {
  includedUsePercent, meterAmounts, meterBand, meterLabel, meterPercent, readUsageCardDismissed, rememberUsageCardDismissed, resetLine, usageCardView, type MeterBand,
} from "@/lib/usage-meter";
import { useStore } from "@/state/store";

const TEAM_TIERS: readonly string[] = ["team", "business"];

export function usageBridge(cloudHome: boolean): CloudPlanBridge | undefined {
  if (window.ogb?.remoteClient?.active === true) return undefined;
  return localDesktopPage() ? (window.ogb?.cloudAccount ? window.ogb?.cloudPlan : undefined) : cloudHome ? window.ogb?.cloudPlan : undefined;
}

export function useCloudUsage(): { usage: CloudUsage | null; bridge: CloudPlanBridge | undefined; teamHome: boolean } {
  const { state } = useStore();
  const bridge = usageBridge(state.config?.cloudHome === true);
  const plan: CloudPlanSnapshot | null = useCloudPlanSnapshot(bridge);
  return { usage: plan?.status === "paid" ? plan.usage ?? null : null, bridge, teamHome: Boolean(state.config?.cloudHome && state.config?.team) };
}

export function MeterBar({ meter, label, compact = false }: { meter: CloudUsageMeter; label: string; compact?: boolean }) {
  const percent = meterPercent(meter), band = meterBand(percent);
  // Settings draws its bars in ink on an ink 8% track: accent is only for links there.
  const settings = useContext(SettingsLook);
  return (
    <div role="progressbar" aria-label={label} aria-valuemin={0} aria-valuemax={100} aria-valuenow={percent} aria-valuetext={meterAmounts(meter)}
      data-meter={meter.kind} data-band={band} className={cn("w-full overflow-hidden rounded-full", settings ? "bg-ink/[0.08]" : "bg-inset", compact ? "h-1.5" : "h-2")}>
      <div className={cn("h-full rounded-full", settings && band === "ok" ? "bg-ink" : BAR[band])} style={{ width: `${Math.max(percent, meter.used > 0 ? 2 : 0)}%` }} />
    </div>
  );
}
const BAR: Record<MeterBand, string> = { ok: "bg-accent", near: "bg-warning", full: "bg-danger" };
const AMOUNT: Record<MeterBand, string> = { ok: "text-ink-secondary", near: "text-warning", full: "text-danger" };

export function MeterRow({ meter, compact = false }: { meter: CloudUsageMeter; compact?: boolean }) {
  const label = meterLabel(meter.kind), band = meterBand(meterPercent(meter));
  return (
    <div className={compact ? "mt-2.5" : "py-2.5"}>
      <div className={cn("mb-1 flex flex-wrap items-baseline justify-between gap-x-3", compact ? "text-[12px]" : "text-[13px]")}>
        <span className="min-w-0 text-ink">{label}</span>
        <span className={cn("ms-auto shrink-0 tabular-nums", AMOUNT[band])}>{meterAmounts(meter)}</span>
      </div>
      <MeterBar meter={meter} label={label} compact={compact} />
    </div>
  );
}

export function CloudUsageCardView({ usage, meters, band, onHide, onSeeAll, children }: {
  usage: CloudUsage; meters: CloudUsageMeter[]; band: "near" | "full"; onHide: () => void; onSeeAll: () => void; children?: ReactNode;
}) {
  return (
    <section aria-labelledby="cloud-usage-card-title" data-cloud-usage-card={band}
      className="mb-2 rounded-xl border border-hairline/50 bg-card p-3 text-ink shadow-sm">
      <div className="flex items-start justify-between gap-2">
        <h2 id="cloud-usage-card-title" className="min-w-0 text-[13px] font-semibold leading-5">{t(band === "full" ? "usageMeter.card.full" : "usageMeter.card.near")}</h2>
        <button type="button" onClick={onHide} aria-label={t("usageMeter.card.hide")} title={t("usageMeter.card.hide")} className="ui-icon-button -me-1 -mt-0.5 shrink-0"><X size={14} /></button>
      </div>
      {meters.map((meter) => <MeterRow key={meter.kind} meter={meter} compact />)}
      <p className="mt-2 text-[12px] text-ink-secondary">{resetLine(usage)}</p>
      <button type="button" className="mt-1.5 w-full py-1 text-center text-[12px] text-ink-secondary hover:text-ink" onClick={onSeeAll}>{t("usageMeter.card.seeAll")}</button>
      {children}
    </section>
  );
}

export function CloudUsageCard() {
  const { dispatch } = useStore();
  const advanced = useAdvancedMode();
  const { usage, teamHome } = useCloudUsage();
  const [dismissed, setDismissed] = useState(readUsageCardDismissed);
  const view = usageCardView({ usage, teamHome, dismissed });
  if (!view || !usage) return null;
  const hide = () => { rememberUsageCardDismissed(view.dismissKey); setDismissed(view.dismissKey); };
  return (
    <CloudUsageCardView usage={usage} meters={view.meters} band={view.band}
      onHide={hide} onSeeAll={() => dispatch({ type: "toggleAppSettings", open: true, section: advanced ? "general" : "usage" })} />
  );
}

function MeterList({ usage }: { usage: CloudUsage }) {
  return usage.meters.length ? <div className="divide-y divide-hairline/30">{usage.meters.map((meter) => <MeterRow key={meter.kind} meter={meter} />)}</div>
    : <p className="text-[13px] text-ink-secondary">{t("usageMeter.empty")}</p>;
}

function TopPlanNote({ usage }: { usage: CloudUsage }) {
  return <p className="text-[13px] text-ink-secondary">{t(TEAM_TIERS.includes(usage.tier) ? "usageMeter.teamPlan" : "usageMeter.topPlan")}</p>;
}

export function CloudUsageSettingsView({ usage, children }: { usage: CloudUsage; children?: ReactNode }) {
  return (
    <Card title={t("usageMeter.title")} subtitle={t("usageMeter.subtitle", { plan: cloudPlanLabel(usage.tier) })}>
      <div data-cloud-usage={usage.tier}>
        <MeterList usage={usage} />
        <p className="mt-2 text-[12px] text-ink-secondary">{resetLine(usage)}</p>
        {usage.upgrades.length === 0 && <div className="mt-4"><TopPlanNote usage={usage} /></div>}
      </div>
      {children}
    </Card>
  );
}

export function useCloudUsageSettings(): { usage: CloudUsage | null } {
  const { usage, teamHome } = useCloudUsage();
  return { usage: usage && !(teamHome && !TEAM_TIERS.includes(usage.tier)) ? usage : null };
}

export function CloudUsageSettings() {
  const { usage } = useCloudUsageSettings();
  if (!usage) return null;
  return <CloudUsageSettingsView usage={usage} />;
}

const SUMMARY_BAR: Record<MeterBand, string> = { ok: "bg-ink/80", near: "bg-warning", full: "bg-danger" };

export function UsageSummaryCard({ kind, title, percent, label, note, children }: {
  kind: "cloud" | "plan";
  title: string;
  percent: number;
  label: string;
  note: ReactNode;
  children?: ReactNode;
}) {
  const band = meterBand(percent);
  return (
    <section data-usage-summary={kind} data-band={band} aria-label={label} className={cn(SIMPLE_CARD, "px-4 py-3.5")}>
      <p className="text-[13px] leading-[18px] text-ink">{title}</p>
      <p className="mt-2 flex items-baseline gap-1.5">
        <span className="text-[22px] font-medium leading-7 tracking-[-0.012em] text-ink tabular-nums">{percent}%</span>
        <span className="text-[13px] text-ink-secondary">{t("settings.simple.billing.used")}</span>
      </p>
      <div role="progressbar" aria-label={label} aria-valuemin={0} aria-valuemax={100} aria-valuenow={percent} className="mt-2 h-1 w-full overflow-hidden rounded-full bg-ink/[0.04]">
        <div className={cn("h-full rounded-full", SUMMARY_BAR[band])} style={{ width: `${percent > 0 ? Math.max(percent, 1) : 0}%` }} />
      </div>
      <p className="mt-2 text-[12px] leading-4 text-ink-secondary">{note}</p>
      {children}
    </section>
  );
}

export function CloudUsageSummaryView({ usage, children }: { usage: CloudUsage; children?: ReactNode }) {
  const percent = includedUsePercent(usage);
  return (
    <UsageSummaryCard kind="cloud" title={t("settings.simple.billing.included")} percent={percent} label={t("settings.simple.billing.summary", { percent: String(percent) })} note={resetLine(usage)}>
      {children}
    </UsageSummaryCard>
  );
}

export function CloudUsageDetails({ usage }: { usage: CloudUsage }) {
  return (
    <Card title={t("usageMeter.title")} subtitle={t("usageMeter.subtitle", { plan: cloudPlanLabel(usage.tier) })}>
      <div data-cloud-usage={usage.tier}>
        <MeterList usage={usage} />
        {usage.upgrades.length === 0 && <div className="mt-3"><TopPlanNote usage={usage} /></div>}
      </div>
    </Card>
  );
}
