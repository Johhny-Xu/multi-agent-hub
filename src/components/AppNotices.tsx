import { useEffect, useState } from "react";
import type { CloudAccountState } from "../../electron/cloud-account.mjs";
import { api, useStore } from "@/state/store";
import { track } from "@/lib/analytics";
import { brandStatus } from "@/lib/brand";
import { cloudNoticeKind, cloudPlanView, cloudTrialNotice, cloudTrialView } from "@/lib/cloud-plan";
import { jobRoutine, useCloudIntent } from "@/lib/cloud-intent";
import { CLOUD_INTENT_GIVEN, cloudSetupStage } from "@/lib/cloud-setup";
import { cornerPopupWaits, firstChatQuiet, firstReplyPending } from "@/lib/corner-popup";
import { CLOUD_NOTICE, CLOUD_TRIAL_NOTICE, dismissNotice, dismissNotices, GROK_MOVE_NOTICE, launchNotice, markLaunchNotice, nextNotice, noticeSeen,
  PHONE_UPDATE_NOTICE, phoneUpdateHint, SIMPLE_MODE_NOTICE, TWO_PLACES_NOTICE } from "@/lib/notices";
import { useTwoPlaces } from "@/lib/two-places";
import { SIMPLE_ONLY } from "@/lib/simple-only";
import { useAdvancedBackDue, useNewLookDue } from "@/lib/new-look";
import { useAdvancedMode } from "@/lib/interface-mode";
import { useSimpleModePromptSeen } from "@/lib/simple-mode-prompt";
import { cloudSignInDue, welcomeFinishedThisLaunch, type WelcomeViewer } from "@/lib/onboarding";
import { launchDialogShown, markLaunchDialog } from "@/lib/launch-dialogs";
import { useUpdaterState } from "@/lib/updater";
import { phonePairingSettingsAction } from "@/lib/phone-pairing";
import { engineReady } from "./EngineLibrary";
import { CLOUD_NOTICE_CARD, cloudNoticeStep, CloudNoticeCard } from "./CloudNotice";
import { useMoveQuiet } from "./CloudSendStrip";
import { CloudTrialNoticeCard, useCloudPlanSnapshot } from "./CloudTrialNotice";
import { GrokMovePopup, reportGrokMovePopup, type GrokMovePopupAction } from "./GrokMovePopup";
import { GrokMoveDialog } from "./lazy-screens";
import { useDesktopNotices, useOtherDialogOpen } from "./notice-dialogs";
import { localDesktopPage } from "./onboarding/WelcomeGate";
import { useMausBotWelcomeDue } from "./MausBotWelcome";
import { NewLookNotice, reportNewLook } from "./NewLookNotice";
import { PhoneUpdateCard, phonesToTell, useRetiredLinkPhones } from "./PhoneUpdateNotice";
import { reportSimpleModePrompt, SimpleModePrompt } from "./SimpleModePrompt";
import { TwoPlacesCard } from "./TwoPlacesCard";

const trialKey = (trial: { state: string; endsAt: number }) => `${trial.state}:${trial.endsAt}`;
/** A first run lands in its Chief's chat, whose first messages arrive one at a time; the Grok Bot popup follows them. */
const FIRST_MESSAGES_MS = 6_000;

export function AppNotices({ quiet = false, viewer = null, now = Date.now }: { quiet?: boolean; viewer?: WelcomeViewer | null; now?: () => number }) {
  const { state, dispatch } = useStore();
  const remote = window.ogb?.remoteClient?.active === true;
  const local = localDesktopPage();
  const bridge = !remote && local ? window.ogb?.cloudAccount : undefined;
  const desktop = remote ? undefined : window.ogb?.desktopNotices;
  const desktopState = useDesktopNotices(desktop);
  // Asked once main has restored the Cloud sign-in, which it waits for before answering desktopState.
  const planBridge = !remote && (bridge || (viewer?.cloudHome && (desktopState || !desktop))) ? window.ogb?.cloudPlan : undefined;
  const [account, setAccount] = useState<CloudAccountState | null>(null);
  const plan = useCloudPlanSnapshot(planBridge);
  const [organization, setOrganization] = useState<boolean | null>(window.ogb?.organization ? null : false);
  const [closed, setClosed] = useState(false);
  const [trialOpen, setTrialOpen] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [simpleShown, setSimpleShown] = useState(false);
  const [grokShown, setGrokShown] = useState(false);
  const [grokOpen, setGrokOpen] = useState(false);
  const [grokLanded, setGrokLanded] = useState(false);
  const updater = useUpdaterState();
  const intent = useCloudIntent();
  const moving = useMoveQuiet(now);
  const mausBot = useMausBotWelcomeDue(viewer);
  // Bots in two places: this computer's page only, where main knows what lives here.
  const two = useTwoPlaces();
  const twoFact = !local || two.suggest === null ? false : two.suggest === undefined ? null : true;
  // Phones whose older app lost its way in: this computer's own page only, never a Cloud, a server's page or client mode.
  const linkPhones = useRetiredLinkPhones(!remote && local);
  useEffect(() => {
    if (!bridge) return;
    let active = true, updated = false;
    const unsubscribe = bridge.onState(next => { updated = true; if (active) setAccount(next); });
    void bridge.state().then(next => { if (active && !updated) setAccount(next); }).catch(() => {});
    return () => { active = false; unsubscribe(); };
  }, [bridge]);
  useEffect(() => {
    const org = window.ogb?.organization;
    if (!org) return;
    let active = true;
    const read = (next: { status: string; organization?: unknown }) => { if (active) setOrganization(next.status !== "signed-out" && Boolean(next.organization)); };
    const unsubscribe = org.onState(read);
    void org.state().then(read, () => { if (active) setOrganization(false); });
    return () => { active = false; unsubscribe(); };
  }, []);
  const view = bridge ? cloudPlanView(account) : null;
  const record = state.config?.onboarding;
  const trialDue = cloudTrialNotice(plan);
  // Every page with the app's chrome, desktop or Cloud, new install or not: once per browser, as the mode is. With Simple
  // the only mode, its place goes to the word about the new look, only where Advanced was on; a browser put back on
  // Advanced gets the word that it is back there instead.
  const promptSeen = useSimpleModePromptSeen(), newLookDue = useNewLookDue(), backDue = useAdvancedBackDue(), advanced = useAdvancedMode();
  const advancedBack = backDue && advanced;
  const simpleDue = SIMPLE_ONLY ? newLookDue : advancedBack || !promptSeen;
  const simpleBlocked = useOtherDialogOpen(simpleDue) || Boolean(state.liveCall && state.liveCall.status !== "ended");

  const trial = plan?.trial;
  const key = trial ? trialKey(trial) : null;
  const setupRecord = record && (intent.pending || intent.sent) ? { ...record, hintsSeen: [...record.hintsSeen, CLOUD_INTENT_GIVEN] } : record;
  const setupHere = cloudSignInDue(viewer, state, engineReady)
    || ["waiting", "shown"].includes(cloudSetupStage({ viewer, connected: state.connected, enginesKnown: state.instances.length > 0,
      engineReady: state.instances.some(engineReady), onboarding: setupRecord, planned: Boolean(jobRoutine(state.routines, intent.sent)) }));
  const waits = cornerPopupWaits(state, updater, { quiet, idle: true, viewer, duringFirstChat: true }) || Boolean(state.cloudAdd) || state.cloudHowTo || setupHere;
  const kind = view ? cloudNoticeKind(view, account) : null;
  // A notice never lands on a new install's first chat: it waits for its first reply. Account and billing notices keep
  // their own rules. Unknown (null) until the bots have loaded, so nothing lower in the queue flashes up before them.
  const firstChat = firstReplyPending(state);
  // MausBot's first-launch card goes first: the popup waits while it is due. The popup skips a launch the card used.
  const afterWelcome = welcomeFinishedThisLaunch() || launchDialogShown() === "mausbot" || firstChat;
  const mausBotFirst = mausBot.due;
  // The Grok Bot popup: once for everyone who can add a bot, the one thing a first chat may be interrupted by. Nothing reads
  // this computer for it: GrokMoveDialog does that, once opened.
  const grokDue = !remote && viewer?.canSave !== false && !state.config?.team && brandStatus().source !== "file" && organization !== true && moving !== true
    && launchDialogShown() !== "mausbot" && !noticeSeen(record, GROK_MOVE_NOTICE) && !desktopState?.seen.includes(GROK_MOVE_NOTICE);
  const grokBlocked = useOtherDialogOpen(grokDue) || Boolean(state.liveCall && state.liveCall.status !== "ended");
  const grokLanding = welcomeFinishedThisLaunch() && !grokLanded;
  useEffect(() => {
    if (!grokDue || !grokLanding || waits) return;
    const timer = setTimeout(() => setGrokLanded(true), FIRST_MESSAGES_MS);
    return () => clearTimeout(timer);
  }, [grokDue, grokLanding, waits]);
  const grokNow = !grokDue ? false
    : !viewer || (desktop && !desktopState) || organization === null || firstChat === null || mausBotFirst || moving === null || grokLanding || grokBlocked ? null : true;
  const retiredPhones = phonesToTell(linkPhones, record);
  const phoneNow = retiredPhones?.length === 0 ? false
    : retiredPhones === undefined || !viewer || mausBotFirst || (state.liveCall && state.liveCall.status !== "ended") ? null : true;
  const launch = launchNotice();
  const notice = waits ? null
    : firstChatQuiet(state) ? (grokNow === true && (launch === null || launch === GROK_MOVE_NOTICE) ? GROK_MOVE_NOTICE : null)
    : nextNotice({
      [GROK_MOVE_NOTICE]: grokNow,
      [PHONE_UPDATE_NOTICE]: phoneNow,
      // As the What's new popup was: never in the launch whose welcome just finished, nor over MausBot's first-launch card.
      [SIMPLE_MODE_NOTICE]: !simpleDue || afterWelcome === true ? false : afterWelcome === null || mausBotFirst || simpleBlocked ? null : true,
      [TWO_PLACES_NOTICE]: twoFact,
      [CLOUD_TRIAL_NOTICE]: planBridge && plan === null ? null : Boolean(key && (trialDue || trialOpen === key)),
      [CLOUD_NOTICE]: !view ? false : view.kind === "unknown" ? null
        : Boolean(kind && !noticeSeen(record, CLOUD_NOTICE_CARD[kind].dismissed)),
    }, () => false, launch, closed);

  const shownKey = notice === CLOUD_TRIAL_NOTICE ? key : notice;
  useEffect(() => {
    if (!shownKey || !notice) return;
    markLaunchNotice(notice);
    // The popups own this launch: MausBot's first-launch card waits for a later one.
    if (shownKey === GROK_MOVE_NOTICE || shownKey === SIMPLE_MODE_NOTICE) markLaunchDialog("notices");
    if (notice === CLOUD_TRIAL_NOTICE && trialOpen !== shownKey) {
      setTrialOpen(shownKey);
      void planBridge?.noticeSeen?.().catch(() => {});
    } else if (shownKey === SIMPLE_MODE_NOTICE && !simpleShown) {
      setSimpleShown(true);
      if (SIMPLE_ONLY || advancedBack) reportNewLook("shown", advancedBack);
      else reportSimpleModePrompt("shown");
    } else if (shownKey === GROK_MOVE_NOTICE && !grokShown) {
      setGrokShown(true);
      reportGrokMovePopup("shown");
    }
  }, [shownKey]);

  const save = (id: string) => {
    const patch = dismissNotice(record, id);
    if (patch) void api("/api/config", { method: "PUT", body: JSON.stringify(patch) })
      .then(config => dispatch({ type: "configStatus", config })).catch(() => {});
  };
  const close = () => { setClosed(true); setTrialOpen(null); setFailed(false); };
  if (grokOpen) return <GrokMoveDialog onClose={() => setGrokOpen(false)} />;
  if (!notice) return null;

  if (notice === GROK_MOVE_NOTICE) {
    const done = (action: GrokMovePopupAction) => {
      reportGrokMovePopup(action); close(); save(GROK_MOVE_NOTICE);
      void desktop?.seen(GROK_MOVE_NOTICE).catch(() => {});
      if (action === "start") setGrokOpen(true);
    };
    return <GrokMovePopup onDone={done} />;
  }

  if (notice === PHONE_UPDATE_NOTICE && retiredPhones?.length) {
    const done = () => { close(); const patch = dismissNotices(record, retiredPhones.map(phone => phoneUpdateHint(phone.id)));
      if (patch) void api("/api/config", { method: "PUT", body: JSON.stringify(patch) }).then(config => dispatch({ type: "configStatus", config })).catch(() => {}); };
    return <PhoneUpdateCard phones={retiredPhones} onOpen={() => { done(); dispatch(phonePairingSettingsAction()); }} onDismiss={done} />;
  }

  if (notice === SIMPLE_MODE_NOTICE) {
    return SIMPLE_ONLY || advancedBack ? <NewLookNotice onClose={close} back={advancedBack} /> : <SimpleModePrompt onClose={close} />;
  }

  if (notice === CLOUD_TRIAL_NOTICE && trial) {
    const shown = cloudTrialView(trial, plan?.credit);
    const act = () => { setFailed(false); void planBridge?.manage().then(close, () => setFailed(true)); };
    return <CloudTrialNoticeCard view={shown} failed={failed} onAction={act} onClose={close} />;
  }
  if (notice === CLOUD_NOTICE && kind && bridge) {
    const act = () => {
      if (busy) return;
      setFailed(false); setBusy(true);
      void cloudNoticeStep(kind, bridge).then(next => setAccount(next), () => setFailed(true)).finally(() => setBusy(false));
    };
    return <CloudNoticeCard kind={kind} busy={busy} failed={failed} onAction={act} onNotNow={() => { close(); save(CLOUD_NOTICE_CARD[kind].dismissed); }} />;
  }
  if (notice === TWO_PLACES_NOTICE && two.suggest) {
    const { key: place, kind: placeKind } = two.suggest;
    return <TwoPlacesCard key={place} suggest={two.suggest}
      onBring={() => { track("two_places_card", { action: "bring", kind: placeKind }); return two.accept(place).then(close); }}
      onDismiss={() => { track("two_places_card", { action: "not_now", kind: placeKind }); two.dismiss(place); close(); }} />;
  }
  return null;
}
