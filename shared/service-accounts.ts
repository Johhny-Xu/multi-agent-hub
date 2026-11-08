/** One saved CLI sign-in as the account routes report it; never carries the credentials themselves. */
export interface ServiceAccount {
  id: string;
  label: string;
  identity?: string;
  createdAt: number;
}

/** A note the account section shows under the list for engines whose sign-in is shared with a tool. */
export type ServiceAccountNote = "shared-gh";

export interface ServiceAccountsView {
  supported: boolean;
  reason?: string;
  note?: ServiceAccountNote;
  accounts: ServiceAccount[];
  activeId: string | null;
  drifted: boolean;
  liveIdentity?: string;
}

export const SERVICE_ACCOUNT_LABEL_MAX = 80;
