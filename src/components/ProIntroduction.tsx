import { useEffect, useState } from "react";
import type { CloudAccountState } from "../../electron/cloud-account.mjs";
import { cloudPlanView, type CloudPlanView } from "@/lib/cloud-plan";

/** The Cloud plan this window knows, for the places that read whether one is paid or still signing in. */
export function useCloudPlan(): { view: CloudPlanView; account: CloudAccountState | null } | null {
  const bridge = window.ogb?.remoteClient?.active ? undefined : window.ogb?.cloudAccount;
  const [account, setAccount] = useState<CloudAccountState | null>(null);
  useEffect(() => {
    if (!bridge) return;
    let active = true, updated = false;
    const unsubscribe = bridge.onState(next => { updated = true; if (active) setAccount(next); });
    void bridge.state().then(next => { if (active && !updated) setAccount(next); }).catch(() => {});
    return () => { active = false; unsubscribe(); };
  }, [bridge]);
  return bridge ? { view: cloudPlanView(account), account } : null;
}
