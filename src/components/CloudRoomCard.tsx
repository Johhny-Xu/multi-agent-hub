import { useState, type ReactNode } from "react";

import type { CloudPlanBridge, CloudPlanSnapshot } from "../../electron/cloud-account.mjs";
import { usageBridge } from "./CloudUsageMeter";
import { useCloudPlanSnapshot } from "./CloudTrialNotice";
import { t } from "@/lib/i18n";
import { readRoomCardHidden, rememberRoomCardHidden, roomCardBusy, roomCardView, type RoomCardView } from "@/lib/room-card";
import { readUsageCardDismissed, usageCardView } from "@/lib/usage-meter";
import { useStore } from "@/state/store";

/** The card as it looks: what ran short, in the person's own numbers, and the way to put it away. It never sells a plan. */
export function CloudRoomCardView({ view, onNotNow, children }: { view: RoomCardView | null; onNotNow: () => void; children?: ReactNode }) {
  if (!view) return <>{children}</>;
  return (
    <section aria-labelledby="cloud-room-card-title" data-cloud-room-card="tip" data-room-cause={view.kind}
      className="mb-2 rounded-xl border border-hairline/50 bg-card p-3 text-ink shadow-sm">
      <h2 id="cloud-room-card-title" className="text-[13px] font-semibold leading-5">{view.title}</h2>
      <p className="mt-1 text-[12px] leading-relaxed text-ink">{view.cause}</p>
      {view.tip && <p className="mt-1.5 text-[12px] leading-relaxed text-ink-secondary">{view.tip}</p>}
      <button type="button" className="ui-button mt-2.5 w-full justify-center" onClick={onNotNow}>{t("roomCard.gotIt")}</button>
      {children}
    </section>
  );
}

/** The plan's snapshot as the room card reads it, with the bridge that acts on it. */
export function useCloudRoom(): { snapshot: CloudPlanSnapshot | null; bridge: CloudPlanBridge | undefined; teamHome: boolean } {
  const { state } = useStore();
  const bridge = usageBridge(state.config?.cloudHome === true);
  return { snapshot: useCloudPlanSnapshot(bridge), bridge, teamHome: Boolean(state.config?.cloudHome && state.config?.team) };
}

/**
 * Where the usage meter's card is (the sidebar's foot, the phone's bar): this Cloud is short on room, said once, calmly.
 * Not now holds it back (the Admin, for two weeks).
 */
export function CloudRoomCard() {
  const { state } = useStore();
  const { snapshot, bridge, teamHome } = useCloudRoom();
  const usage = snapshot?.status === "paid" ? snapshot.usage ?? null : null;
  const [hidden, setHidden] = useState(readRoomCardHidden);
  const view = roomCardView({ room: snapshot?.status === "paid" ? snapshot.room : null, usage, busy: roomCardBusy(state.bots, state.config?.waitingForRoom), hidden, teamHome,
    usageCardShown: Boolean(usageCardView({ usage, teamHome, dismissed: readUsageCardDismissed() })) });
  const notNow = () => {
    if (!view) return;
    rememberRoomCardHidden(view.id);
    setHidden(view.id);
    void bridge?.roomNotNow?.(view.id).catch(() => false);
  };
  return <CloudRoomCardView view={view} onNotNow={notNow} />;
}
