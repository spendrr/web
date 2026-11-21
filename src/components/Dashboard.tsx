import { swipeAway } from "../lib/ui/swipeAway";
import { IS_REGTEST } from "../lib/network";
import { RollingDigits } from "./RollingDigits";
import {
  Suspense,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
  type RefObject,
} from "react";
import { createPortal, flushSync } from "react-dom";
import type { Balance, LightningInvoice, Movement, OnchainBalance } from "@secondts/bark";
import {
  closeWallet,
  isOnchainScanActive,
  scheduleMaintenanceDelegated,
  pushOnchainScanActive,
  pushWorkerWatchdogOverride,
  type WalletClient,
} from "../lib/wallet/bark";
import { isMaintenanceSuppressed } from "../lib/maintenance/maintenanceSuppress";
import { effectiveEngineMode, sessionEngineMode } from "../lib/refreshEngine/mode";
import {
  engineSnapshot,
  loadEngineSnapshot,
  maybeRunEngine,
  setRefreshNoteSafe,
  subscribeEngine,
  sweepLocks,
} from "../lib/refreshEngine/runner";
import { hiddenFromHistory, highestMovementId, newestUnseenIncoming } from "../lib/maintenance/refreshHistory";
import { refreshNoteSafe, type LogKind } from "../lib/refreshEngine/engine";
import {
  NO_REFRESHING,
  refreshingSplitsEqual,
  splitRefreshingVtxos,
  type RefreshingSplit,
} from "../lib/maintenance/refreshingBalance";
import Coachmark from "./Coachmark";

// Engine log events after which balance/history are worth re-reading.
const ENGINE_STATE_CHANGING: ReadonlySet<LogKind> = new Set<LogKind>([
  "submitted",
  "resubmitted",
  "adopted",
  "completed",
  "round-failed",
  "ended-unseen",
  "unlocked",
  "quarantined",
  "quarantine-released",
]);

// Lazy-loaded: each of these is only ever rendered behind a boolean flag
// that starts false (a settings screen, two modals, a one-time "what's
// new" popup), so there's no reason to make every visitor download and
// parse all of them — including QrScanner's jsQR dependency — before they
// ever reach the dashboard. React only fetches each chunk the first time its
// gate flips true.
// lazyReady (not React.lazy): a resolved chunk renders directly instead of
// suspending, so the first open does not wait out React's 300 ms reveal delay.
const Settings = lazyReady(() => import("./Settings"));
const UtilityHub = lazyReady(() => import("./UtilityHub"));
const QrScannerModal = lazyReady(() => import("./QrScanner"));
const QrSourceSheet = lazyReady(() => import("./QrSourceSheet"));
const BtcPriceModal = lazyReady(() => import("./BtcPriceModal"));
const WhatsNewModal = lazyReady(() => import("./WhatsNewModal"));
import { lazyReady } from "../lib/ui/lazyReady";
import { shouldShowWhatsNew, markWhatsNewSeen } from "../lib/whatsNew";
import { hasSeenHint, markHintSeen, type HintKey } from "../lib/ui/onboardingHints";
import { WarningIcon } from "./BannerIcons";
import { fetchBtcRates, formatFiat, satsToFiat } from "../lib/price";
import { getFiatCurrency, type FiatCurrency } from "../lib/currency";
import { notifyPayment, PUSH_SUBSCRIPTION_EVENT, refreshPushAuthorization, reportExpiryIfMoved } from "../lib/notifications";
import { hapticNotify, hapticTap } from "../lib/ui/haptics";
import { useMotionOn, withViewTransition } from "../lib/ui/motion";
import { isShakeEnabled, startShakeDetection } from "../lib/ui/shakeToHide";
import {
  loadStoredReceiveAddress,
  saveReceiveAddress,
  clearStoredReceiveAddress,
  snapshotOutpoints,
  evaluateReceiveAddressUsage,
  isInitialOnchainScanDone,
} from "../lib/wallet/onchainReceiveAddress";
import { useExitTracker } from "../lib/exit/useExitTracker";
import { exitMayBeLive } from "../lib/exit/emergencyExit";
import BoardSheet from "./BoardSheet";
import ExitHomeCard from "./ExitHomeCard";
import { exitNotificationHint, exitPushWatchHeight, writeExitNotificationHint } from "../lib/exit/exitNudge";
import ExitSheet from "./ExitSheet";
import { writeExpiryCopy } from "../lib/expiryCopy";
import { localeFor, tf, useLang, useT, type Lang } from "../lib/i18n";
import { loadVault } from "../lib/vault/crypto";
import { requestPasswordSetup } from "../lib/vault/vaultAccess";
import { learnArkServerFrom } from "../lib/send/validArkAddresses";
import {
  withTimeout,
  isWalletCallTimeout,
  WALLET_CALL_TIMEOUT_MS,
  ONCHAIN_SYNC_TIMEOUT_MS,
  SEND_WATCHDOG_MS,
  TIMEOUT_MESSAGE,
} from "../lib/wallet/walletCall";
import { useDesignVersion } from "../lib/ui/designVersion";
import headerMarkInk from "../assets/header-mark-ink.png";
import headerMarkCream from "../assets/header-mark-cream.png";
import { clearSpendLimitsStatus, refreshSpendLimits } from "../lib/wallet/spendLimitsClient";
import { describeError, onErrorToast, rawErrorMessage, surfaceError } from "../lib/appErrors";
import { isOffline, netState, reportNetworkTrouble, useNetState } from "../lib/connectivity/connectivity";
import GiftComposeModal from "./GiftComposeModal";
import RefreshInfoSheet from "./RefreshInfoSheet";
import InstallAppSheet from "./InstallAppSheet";
import SeedBackupSheet from "./SeedBackupSheet";
import { neverShowInstallHint, shouldAutoShowInstallHint, snoozeInstallHint } from "../lib/vault/storageProtection";
import { RecordSealSheet } from "./RecordSealSheet";
import { checkRecordSeal, clearRecordSeal } from "../lib/wallet/recordSealClient";
import { useBackLayer } from "../lib/ui/backLayers";
import { createTapCounter, TAP_MAX_GAP_MS } from "../lib/ui/tapCounter";
import PaymentRequestModal from "./PaymentRequestModal";
import ProfileSheet from "./ProfileSheet";
import ReceiveScreen, { type ReceiveFormat } from "./ReceiveScreen";
import ChatPanel, { ChatButton } from "./chat/ChatPanel";
import { startChat, stopChat } from "../lib/chat/chatClient";
import { installChatPush, whenSlotPeer } from "../lib/chat/chatPush";
import { takePendingOpen, takePendingSchedule } from "../lib/chat/pushSlots";
import { startReminderSync } from "../lib/chat/reminderSync";
import { chatUsed, markChatUsed } from "../lib/chat/chatRead";
import { useChatEnabled } from "../lib/chat/chatEnabled";
import { fetchMyName } from "../lib/names/names";
import { shouldTriggerBackup } from "../lib/backup/backupTrigger";
import { getCachedName, hasHandleFlag, maybeTouchName, setCachedName, type CachedName } from "../lib/names/nameTouch";
import { lastLnAddressServiceOk, lnAddressServiceOk } from "../lib/names/lnAddrHealth";
import { type ActionMenuItem } from "./ActionMenu";
import { SEED_BACKUP_CHANGED_EVENT, getPendingGiftPassword, hasClaimedGift, needsSeedBackup } from "../lib/gift/giftStore";
import { giftFromScannedUrl, isGiftPath, type GiftLinkParams } from "../lib/gift/giftLink";
import { isRequestPath } from "../lib/send/paymentRequest";
import GiftClaimModal from "./GiftClaimModal";
import { autoReturnExpiredGifts } from "../lib/gift/giftReclaim";
import GiftPasswordModal from "./GiftPasswordModal";
import BumpOverlay from "./BumpOverlay";
import { isBumpPayEnabled } from "../lib/bump/bump";
import { isBumpReceiving, isPaymentPriority } from "../lib/wallet/paymentPriority";
import { headlineSats } from "../lib/wallet/headlineBalance";
import {
  BackIcon,
  ReceiveArrowIcon,
  SendArrowIcon,
  GiftIcon,
  RequestIcon,
  ScanIcon,
  AtIcon,
  GearIcon,
  OnchainIcon,
} from "./dashboard/icons";
import { BigActionButton } from "./dashboard/BigActionButton";
import { type ToastDetail, type NetIsland, NET_ISLAND_COPY, toastTone, ToastIslandIcon, ToastCopyButton } from "./dashboard/toastIsland";
import { SendPanel } from "./dashboard/SendPanel";
import { HistoryPanel, ChatTxDetail } from "./dashboard/HistoryPanel";
import "./Dashboard.css";
import "../motion.css";

type View = "home" | "receive" | "send" | "history";

// The toast island lives in <body>, outside #root, so it stays above sheets.
function BodyPortal({ children }: { children: ReactNode }) {
  return createPortal(children, document.body);
}

// Set once the VTXO refresh info card has been shown for the current refresh
// (RefreshInfoSheet, v2 beta); cleared when no round is pending.
const REFRESH_SHEET_SEEN_KEY = "btc-wallet-refresh-sheet-seen";

const BALANCE_HIDDEN_KEY = "btc-wallet-balance-hidden";
// Persists across app restarts (unlike `pendingReceive.lastSeenMovementId`,
// which only lives for the current session) so a payment that arrived while
// the app was fully closed still gets its "Platba přijata" toast the moment
// it's reopened, instead of silently becoming the new baseline.
export const LAST_SEEN_MOVEMENT_KEY = "btc-wallet-last-seen-movement-id";

function getPersistedLastSeenMovementId(): number | null {
  const raw = localStorage.getItem(LAST_SEEN_MOVEMENT_KEY);
  if (raw === null) return null;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : null;
}

function setPersistedLastSeenMovementId(id: number): void {
  localStorage.setItem(LAST_SEEN_MOVEMENT_KEY, String(id));
}

// Same idea as LAST_SEEN_MOVEMENT_KEY above, but for the headline balance
// itself: lets the rolling-digit animation (RollingDigits) roll from what
// the user last actually saw to the fresh value even after the app was
// fully closed and reopened, when no in-session React state survives to
// supply an "old" number to animate from. Cleared on wallet reset/import in
// resetLocalState.ts, so a different wallet's balance never leaks in as a
// false "before" value.
const LAST_SEEN_BALANCE_KEY = "btc-wallet-last-seen-balance";

function getPersistedLastSeenBalance(): number | null {
  const raw = localStorage.getItem(LAST_SEEN_BALANCE_KEY);
  if (raw === null) return null;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : null;
}

function setPersistedLastSeenBalance(spendableSats: number): void {
  localStorage.setItem(LAST_SEEN_BALANCE_KEY, String(spendableSats));
}

function balancesEqual(a: Balance, b: Balance): boolean {
  return (
    a.spendableSats === b.spendableSats &&
    a.needsRefreshSats === b.needsRefreshSats &&
    a.pendingArkoorSendSats === b.pendingArkoorSendSats &&
    a.pendingOffboardSats === b.pendingOffboardSats &&
    a.pendingInRoundSats === b.pendingInRoundSats &&
    a.pendingExitSats === b.pendingExitSats &&
    a.pendingLightningSendSats === b.pendingLightningSendSats &&
    a.claimableLightningReceiveSats === b.claimableLightningReceiveSats &&
    a.pendingBoardSats === b.pendingBoardSats
  );
}

// `updatedAt` is bumped by the SDK on any mutation to a movement (status,
// amount, fee, vtxo ids all included) — comparing it catches an in-round
// send whose amount/fee settles while `status` itself stays "pending",
// which comparing id+status alone would miss.
function historiesEqual(a: Movement[], b: Movement[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (
      a[i].id !== b[i].id ||
      a[i].status !== b[i].status ||
      a[i].updatedAt !== b[i].updatedAt
    ) {
      return false;
    }
  }
  return true;
}

// If timeouts keep happening for this long in a row, the phone likely has no
// real connectivity at all rather than just a slow server — swap to a message
// that points at that instead of suggesting "just try again" forever.
const OFFLINE_THRESHOLD_MS = 30_000;
const OFFLINE_MESSAGE = "Nejsi online.";
// A failure right after the tab wakes back up (see the visibilitychange
// effect below) is usually just the network/worker needing a beat to
// reconnect, not a real problem — stay silent for this long before showing
// any error at all, so a quick retry has a real chance to succeed first
// instead of flashing "Počkej chvíli…" on the very first attempt.
const LOAD_ERROR_GRACE_MS = 8_000;
// Both the Lightning and Ark receive watches drive off the same refresh()
// (sync+balance+history+maintenance) — maintenance() is what actually pulls
// a settlement in locally for either kind, so neither can be checked any
// faster or cheaper than that full cycle. This is the gap *between* cycles,
// not the cycle's own duration — was 8s, which made foreground detection
// feel sluggish (up to ~8s of pure idle wait on top of however long
// sync+maintenance itself takes, even though the user is looking straight
// at the screen waiting for the payment to land). Halved to close that gap;
// a slow cycle still can't overlap with the next tick — refresh() itself
// (not a busyRef pre-check in the watch loops, see their tick() comments)
// hands back the same in-flight promise instead of starting a second one.
const RECEIVE_WATCH_INTERVAL_MS = 4_000;
// Escalating gap used by both watch loops below in place of the fixed
// RECEIVE_WATCH_INTERVAL_MS once refresh() comes back with `undefined` (a
// cycle where *both* sync() and maintenance() failed outright — see
// refresh()'s own comment). The Ark watch in particular runs continuously
// for the entire unlocked session, not just while Receive is open, so a
// server-side stall (a wedged Ark round — the "wallet.maintenance timed out"
// case) used to mean it kept re-queuing a fresh sync()+maintenance() attempt
// every 4s forever. The worker only ever runs one wallet.* call at a time
// (bark.ts), so each of those attempts sat in front of anything the user
// tried to do (Odeslat, opening VTXO mince) until it finally timed out —
// and if a single attempt ran past the worker's own 60s request watchdog,
// that tore down and recreated the *entire* worker, rejecting whatever of
// the user's own was queued behind it and forcing a relock, mid-send.
// Backing off here doesn't fix the underlying server-side stall, but it
// shrinks how often that destructive cycle repeats and leaves much bigger
// gaps for a user-initiated call to actually get a turn. Resets to the base
// interval the moment a cycle succeeds again.
const RECEIVE_WATCH_BACKOFF_DELAYS_MS = [8_000, 15_000, 30_000, 60_000];
// Onchain confirmations take ~10 minutes by nature, so this doesn't need
// anywhere near the Ark watch's cadence — kept on its own slower timer
// rather than folded into refresh() so it doesn't add an onchain round-trip
// to every single Ark poll, most of which will find nothing new here.
// A regtest build (e2e/) mines blocks on demand, so it polls fast to keep the
// tests from idling; dead code in a deployed build.
const ONCHAIN_BALANCE_POLL_MS = IS_REGTEST ? 2_000 : 30_000;
// The first onchain poll waits for the headline balance. Its sync() scans the
// onchain addresses over esplora (~6 s) in the same worker FIFO, so started at
// mount it sat in front of balance() and kept the skeleton up for all of it.
// If the balance never arrives (offline, load error) it starts anyway.
const ONCHAIN_FIRST_POLL_FALLBACK_MS = 10_000;
// How long after Dashboard mounts (or after the address is cleared) the onchain
// receive address is requested in the background.
const ONCHAIN_ADDRESS_PREFETCH_MS = 3_000;
const TOAST_DURATION_MS = 6_000;
// An error toast with a copy button stays up longer: the user has to read
// it, decide the raw text is worth keeping, and reach for the button.
const TOAST_ERROR_DURATION_MS = 10_000;
// "Zkopírováno" and the like only confirm a tap the user just made; the
// island lets them go quickly instead of sitting there for 6s.
const TOAST_NEUTRAL_DURATION_MS = 1_800;
// How long "Jsi zase online" stays up after the network returns.
const NET_BACK_ONLINE_MS = 2_500;
// Matches the toast-out CSS animation's duration — the toast stays mounted
// through it (with the "closing" class applied) so it can fly back out
// instead of just vanishing, then actually unmounts once the animation
// finishes.
const TOAST_EXIT_MS = 250;

// Motion design: the element tapped on Home and the one it grows into, per
// morph (must match motion.css's nav-morph selectors). The QR's frame is a
// gradient drawn with background layers, which computed style can't report,
// so its skin is given: white fill, the gradient's dark stop as outline.
// History is deliberately not here: its transition was tried and dropped.
// Send lands on the destination field, just under the balance: morphing into
// the form's button at the bottom flew across the whole screen (rejected).
type NavMorph = "send" | "receive";
const NAV_MORPH_ENDS: Record<NavMorph, readonly [string, string]> = {
  send: [".big-action-btn--send", ".subview .destination-row input"],
  receive: [".big-action-btn--receive", ".subview .qr-wrap"],
};
const QR_WRAP_SKIN = { background: "rgb(255, 255, 255)", borderColor: "rgb(138, 138, 138)" };

// Lives in Dashboard (not the Receive sub-components) so a pending receive
// keeps being watched even if the user switches to another view (home, send,
// history) or back — the previous per-component polling died the moment its
// component unmounted.
// Exported so UtilityHub's Point-of-Sale tab can plug into the same watch
// (see its own PosPanel) — it creates a Lightning invoice exactly like
// ReceiveScreen does and hands it to this same state via startLightningWatch,
// rather than reinventing a second poll loop for "was this invoice paid".
export type PendingReceive =
  | { kind: "lightning"; invoice: LightningInvoice; status: "waiting" | "paid" }
  | { kind: "ark"; address: string; lastSeenMovementId: number | null };

export default function Dashboard({
  wallet,
  onLock,
  onResetWallet,
  justOnboarded,
  usingFallbackChainSource,
  onCriticalOpChange,
  onWalletStateChanged,
  giftEncryptionKey,
  giftClaimActive,
  payRequest,
  onPayRequestConsumed,
}: {
  wallet: WalletClient;
  onLock: () => void;
  onResetWallet: () => void;
  justOnboarded: boolean;
  // The cloud-backup AES-GCM key (or null when backups are unavailable this
  // session). Used only to encrypt the one-time mnemonic of each outgoing
  // gift link at rest — the 🎁 "send bitcoin as a link" sender flow is
  // disabled without it, since it would have no safe place for the reclaim
  // seed. See giftStore.ts / GiftComposeModal.
  giftEncryptionKey?: CryptoKey | null;
  // True while the "Dostal jsi dárek" claim overlay is still up. The
  // "save your password" prompt below waits for this to clear (i.e. the
  // user tapped "Přijmout dárek") before starting its 7s countdown.
  giftClaimActive?: boolean;
  // A payment-request link (spendrr.app/r#…) the user chose to pay: opens
  // the Send view with its address and amount already filled in. Handed
  // over by App.tsx, which owns the request itself; onPayRequestConsumed
  // fires once it has been taken, so re-renders can't reopen it.
  payRequest?: { destination: string; amountSats?: number } | null;
  onPayRequestConsumed?: () => void;
  // True when App.tsx's openWithMnemonic had to fall back to mempool.space
  // because the primary open (against second.tech's own esplora mirror)
  // failed — see walletWorkerGuard.ts's FALLBACK_ESPLORA_ADDRESS. Surfaced
  // as a small dismissible-by-nature banner (it just stops rendering once
  // locked and re-unlocked successfully against the primary source) rather
  // than silently switched, since it's a real, if minor, change in which
  // third party this session is trusting.
  usingFallbackChainSource?: boolean;
  // Called with true right before a send or the final exit-drain broadcast
  // starts, and false once it settles — App.tsx's auto-lock timer defers
  // locking (which would unmount this whole component) while true, so an
  // in-flight payment is never cut off mid-flight with no way to see
  // whether it went through.
  onCriticalOpChange?: (active: boolean) => void;
  // Called (debounced, by the caller — see lib/backup.ts's
  // createBackupUploader) whenever fetchBalanceAndHistory below actually
  // detects a balance or history change, so App.tsx can trigger a fresh
  // cloud backup upload. Never receives the mnemonic — Dashboard only ever
  // holds the opaque WalletClient, preserving the existing isolation
  // boundary between this file and App.tsx.
  onWalletStateChanged?: () => void;
}) {
  const t = useT();
  const lang = useLang();
  // The v2 toggle, for the features still in beta below.
  const designVersion = useDesignVersion();
  // The wallet worker's spend limits, for the password threshold every send surface asks about.
  useEffect(() => {
    void refreshSpendLimits();
    return clearSpendLimitsStatus;
  }, [wallet]);
  // bark records the worker held back (recordSeal.ts): asked once per opened wallet and after every sync below.
  useEffect(() => {
    void checkRecordSeal();
    return clearRecordSeal;
  }, [wallet]);
  // Money chat (beta): its own opt-in on top of V2, off by default.
  const chatEnabled = useChatEnabled();
  const chatOn = designVersion === "v2" && chatEnabled;
  // Motion design (beta, own switch in Settings): see src/lib/ui/motion.ts.
  const motionOn = useMotionOn();
  // Once a week, while this wallet has a @handle, tell the registry the name is
  // still in use (nameTouch.ts). Delayed so it never competes with the startup
  // calls for the wallet worker's queue, and inert unless the profile screen has
  // ever registered or found a name.
  useEffect(() => {
    const timer = window.setTimeout(() => void maybeTouchName(wallet), 30_000);
    return () => window.clearTimeout(timer);
  }, [wallet]);

  // Money chat (beta): runs for as long as this unlocked session does, so
  // messages arrive while the panel is closed, but only for someone who can be
  // written to (has a @name) or has used Zprávy; everyone else connects on
  // first open. Unmount (lock) stops it and zeroes the key in the chat worker.
  useEffect(() => {
    if (!chatOn) return;
    installChatPush();
    if (hasHandleFlag() || chatUsed()) void startChat(wallet);
    return () => stopChat();
  }, [wallet, chatOn]);
  const [balance, setBalance] = useState<Balance | null>(null);
  // How much is in a VTXO refresh round, split by whether the headline
  // balance already counts it. Only fetched when balance().pendingInRoundSats
  // says there is a round at all, so the normal case costs no extra wallet
  // call. See refreshingBalance.ts for why the aggregate alone can't answer
  // this.
  const [refreshing, setRefreshing] = useState<RefreshingSplit>(NO_REFRESHING);
  const [showSettings, setShowSettings] = useState(false);
  // Opens only once the chunk is in: showSettings swaps the whole dashboard
  // for <Settings>, so flipping it before the chunk arrives left a blank
  // screen (the Suspense fallback is null) for as long as the download took.
  // A failed load still opens, so the error boundary reports it.
  const openSettings = useCallback(() => {
    void Settings.preload().then(
      () => setShowSettings(true),
      () => setShowSettings(true),
    );
  }, []);
  // Utility hub (sats <-> fiat converter, btcmap.org, Point of Sale) —
  // entered via a right swipe on the lock-gesture-area (below). Still "a
  // fully separate page, like Settings" in the sense that it has its own
  // shell/back-button and hides the balance card underneath (see
  // balanceOnScreen below) — but unlike Settings' instant swap, this one
  // wanted a smooth slide transition, which needs the incoming page and the
  // home screen both mounted at once for the duration of the animation
  // rather than an early return that replaces the whole tree in one frame.
  // `showUtility` covers the entire time the overlay is in the DOM (opening
  // through closing); `utilityVisible` is only the on/off-screen CSS state,
  // decoupled so the overlay can animate *out* before actually unmounting
  // (see the overlay's onTransitionEnd further down).
  const [showUtility, setShowUtility] = useState(false);
  const [utilityVisible, setUtilityVisible] = useState(false);
  // Reported live: tapping "Zpět do peněženky" as the very first touch right
  // after the swipe-open needed two taps to register; waiting ~1-2s for the
  // slide-in to definitely finish before tapping made it work every time —
  // confirmed by the user, not guessed. That's a hit-testing race, not an
  // animation-smoothness one (the earlier will-change/backface-visibility
  // promotion on .utility-hub-overlay didn't fix it on its own): a tap
  // landing while the transform is still mid-transition can hit-test
  // against a not-yet-settled compositor frame on some mobile browsers.
  // `utilitySettled` blocks pointer-events (Dashboard.css) on the overlay
  // until its OWN transitionend confirms the transform has actually
  // finished, closing the race outright instead of just reducing its
  // odds. Starts true (see the reduced-motion branch below) so a user with
  // no transition never gets stuck unable to tap anything.
  const [utilitySettled, setUtilitySettled] = useState(true);
  // transitionend (below) is the fast path for clearing utilitySettled, but
  // must never be the ONLY way pointer-events get re-enabled on the overlay
  // — relying on it alone shipped live and got the whole Utility hub stuck
  // permanently untappable (transitionend just never fired; root cause not
  // pinned down, and doesn't need to be — an event that might not fire
  // can't be the sole gate on being able to tap anything at all). This
  // timer is a hard backstop: unblocks a little after the transition's own
  // 0.34s (Dashboard.css) no matter what transitionend does.
  const utilitySettleTimerRef = useRef<number | null>(null);
  const openUtility = useCallback(() => {
    setShowUtility(true);
    const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    setUtilitySettled(reducedMotion);
    if (utilitySettleTimerRef.current !== null) window.clearTimeout(utilitySettleTimerRef.current);
    if (!reducedMotion) {
      utilitySettleTimerRef.current = window.setTimeout(() => setUtilitySettled(true), 420);
    }
    // Mount off-screen first, then flip to the on-screen transform on the
    // next painted frame — flipping both in the same render collapses the
    // transition into a no-op (the element never gets painted at its
    // starting position, so there's nothing for the browser to animate
    // *from*). Double rAF, not a single one: one rAF still sometimes lands
    // before the browser's next actual paint.
    requestAnimationFrame(() => {
      requestAnimationFrame(() => setUtilityVisible(true));
    });
  }, []);
  const closeUtility = useCallback(() => {
    // Only starts the slide-out; the overlay unmounts itself (setShowUtility
    // (false)) from its own onTransitionEnd once the animation actually
    // finishes, so the back button/swipe-back always shows the same
    // slide-away motion instead of vanishing instantly.
    setUtilityVisible(false);
    // ...except under prefers-reduced-motion, where Dashboard.css sets
    // `transition: none` — no transform is ever "transitioning", so no
    // transitionend event fires and the overlay would otherwise stay
    // mounted (invisible, off-screen) forever. Unmount immediately instead.
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      setShowUtility(false);
    }
  }, []);
  // Non-null → Settings opens straight to that section (the gift-recipient
  // seed-backup banner jumps to "seed"). Reset on close.
  const [settingsInitialSection, setSettingsInitialSection] = useState<"seed" | "vtxos" | undefined>(undefined);
  // Beta, refresh engine live: the island only when something needs the
  // user (agreed): the safety stop halted refresh while a coin is under 144
  // blocks, or a refresh has been stuck for over 24 h.
  const engineSnap = useSyncExternalStore(subscribeEngine, engineSnapshot);
  const engineAttention = effectiveEngineMode() === "live" ? (engineSnap.status?.needsAttention ?? null) : null;
  // A wallet created via a gift-link claim shows a single persistent "back
  // up your seed phrase" banner until the seed has been revealed once. Held
  // in state (not read live) so revealing it in Settings and coming back
  // re-checks and the banner disappears.
  const [showSeedBackupBanner, setShowSeedBackupBanner] = useState(() => needsSeedBackup());
  const [seedBackupSheet, setSeedBackupSheet] = useState(false);
  // A password wallet asks for it in a sheet; a passwordless one first sets one (App's sheet).
  const startSeedBackup = () => {
    if (loadVault()) setSeedBackupSheet(true);
    else requestPasswordSetup("backup");
  };
  useEffect(() => {
    const sync = () => setShowSeedBackupBanner(needsSeedBackup());
    window.addEventListener(SEED_BACKUP_CHANGED_EVENT, sync);
    return () => window.removeEventListener(SEED_BACKUP_CHANGED_EVENT, sync);
  }, []);
  // The auto-generated vault password for a fresh gift-link recipient —
  // shown 7s after the wallet opens so it doesn't slam a modal over the
  // balance landing. Held in the clear (giftStore) until confirmed; without
  // this the password could vanish and lock the wallet permanently.
  const [pendingGiftPw, setPendingGiftPw] = useState<string | null>(null);
  // True only when this Dashboard mounted mid-gift-claim for a brand-new
  // recipient (the pending password is written before the wallet opens).
  // Used to keep the headline balance at 0 behind the claim modal.
  const [hideBalanceForGiftReveal] = useState(() => getPendingGiftPassword() !== null);
  // Mirrors giftRevealHold (computed far below, after `spendable`) for the
  // callbacks defined above it — showToast reads it to swallow the
  // "payment received" toast while the claim modal is still up.
  const giftRevealHoldRef = useRef(false);
  useEffect(() => {
    // Wait until the "Dostal jsi dárek" overlay is gone — the countdown
    // starts once the user has actually tapped "Přijmout dárek", not while
    // they're still reading the claim modal.
    if (giftClaimActive) return;
    const pw = getPendingGiftPassword();
    if (!pw) return;
    const h = window.setTimeout(() => setPendingGiftPw(pw), 10_000);
    return () => window.clearTimeout(h);
  }, [giftClaimActive]);
  const [showWhatsNew, setShowWhatsNew] = useState(false);
  // Sticky for this mount, not just "currently active": skipping only while
  // giftClaimActive is true would let the popup fire the instant the claim
  // modal closes — still reading as an interruption right after accepting a
  // gift, just delayed a beat. Once a claim has happened during this
  // Dashboard's lifetime, suppress it for the rest of the session instead;
  // shouldShowWhatsNew() never got to mark the version seen, so a later,
  // non-gift open of the app still shows it normally.
  const sawGiftClaimRef = useRef(false);
  if (giftClaimActive) sawGiftClaimRef.current = true;
  useEffect(() => {
    if (giftClaimActive || sawGiftClaimRef.current) return;
    if (shouldShowWhatsNew(__APP_VERSION__)) setShowWhatsNew(true);
  }, [giftClaimActive]);

  // Sweep any outgoing gift link still unclaimed past its 7-day window back
  // to this wallet. Runs once on mount and again whenever the tab regains
  // focus — a gift only needs returning while the sender's app is open, and
  // the recipient watch / manual "Vzít zpět" cover the rest. No-op without
  // the backup key (the only thing that can decrypt the reclaim seed).
  useEffect(() => {
    if (!giftEncryptionKey) return;
    const key = giftEncryptionKey;
    // A returned gift shows up in the balance on the next ~4s poll — no need
    // to force a refresh from here.
    const sweep = () => void autoReturnExpiredGifts(wallet, key).catch(() => {});
    sweep();
    const onVis = () => {
      if (document.visibilityState === "visible") sweep();
    };
    document.addEventListener("visibilitychange", onVis);
    return () => document.removeEventListener("visibilitychange", onVis);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [wallet, giftEncryptionKey]);
  // Settings and QrScanner are lazy() (see the comment above their imports),
  // so the very first tap on the gear / scan button after opening the app
  // has to wait on a network round-trip + parse for its chunk, with
  // Suspense's fallback being null — no spinner, just a beat of nothing,
  // which read as the button being slow rather than as loading. Prefetching
  // the same specifiers during idle time after the dashboard itself has
  // settled means that by the time anyone actually opens them, the module
  // is already resolved and lazy() just returns it from the browser's
  // module cache instead of fetching. QrScanner pulls in jsQR, so it's the
  // heaviest of these — but the scan button is a primary send path and the
  // first-open lag was noticeable, so it's worth warming on idle too.
  // BtcPriceModal stays un-prefetched — it's an easter egg.
  //
  // UtilityHub belongs here for the same reason, and missing it was an
  // actual reported bug, not just a missed optimization: openUtility's
  // double-rAF "mount off-screen, then flip to on-screen next frame" slide
  // choreography assumes the overlay is already in the DOM to paint that
  // first off-screen frame. With `<Suspense fallback={null}>` around it
  // (see the overlay further down), the very first swipe of a session
  // renders nothing at all until the chunk finishes loading — no off-screen
  // frame to flip from, so the slide either pops in with no animation or
  // (worse) the overlay/back-button mount mid-transition, not yet hydrated
  // when the first tap lands, needing a second tap to register. Every swipe
  // after the first works fine because the chunk is then already cached.
  // Only prefetched under v2 — v1 has no swipe gesture to ever trigger it.
  useEffect(() => {
    // Not idle-gated: right after unlock the first tap on the gear is likely,
    // and the idle callback can fire late under that load.
    void Settings.preload().catch(() => {});
    const prefetch = () => {
      void Settings.preload().catch(() => {});
      void QrScannerModal.preload().catch(() => {});
      if (designVersion === "v2") {
        void UtilityHub.preload().catch(() => {});
      }
    };
    // typeof, not `"requestIdleCallback" in window` — lib.dom.d.ts declares
    // it unconditionally present, which makes TS narrow the `in` check's
    // else branch to `never` even though real support (notably iOS Safari,
    // until quite recently) can't be assumed at runtime.
    if (typeof window.requestIdleCallback === "function") {
      // timeout: without it, "idle" means genuinely idle — and right after
      // unlock the main thread/network are busy with balance/history,
      // sync()+maintenance(), backup restore, push-auth refresh, price
      // fetch, so true idle can take a while to arrive. A swipe into
      // UtilityHub in that window is exactly the unsmooth-first-swipe case
      // this prefetch exists to prevent. 400ms forces it to run anyway —
      // still off the critical first-paint path, but bounded rather than
      // "whenever the browser feels like it". The chunks are small (a few
      // KB to ~9KB gzip each after UtilityHub's own Leaflet split), so
      // firing under some background load is cheap.
      const id = window.requestIdleCallback(prefetch, { timeout: 400 });
      return () => window.cancelIdleCallback(id);
    }
    const id = window.setTimeout(prefetch, 1);
    return () => window.clearTimeout(id);
    // designVersion in deps so toggling v1->v2 in Settings mid-session (no
    // remount) still schedules the UtilityHub prefetch — re-importing
    // Settings/QrScanner too on that rare transition is a harmless no-op,
    // the module is already cached.
  }, [designVersion]);
  // Easter egg on the wordmark: a double-click shows the BTC price chart. A
  // triple-click does nothing (it used to open the converter, which now
  // lives in the Utility hub). Native onDoubleClick can't be used here — it
  // fires on the 2nd click regardless of whether a 3rd follows. Instead
  // every click is counted, and a short timer (a bit above the OS
  // double-click window) waits to see if another click is still coming
  // before deciding what the final count meant.
  const [showPriceEasterEgg, setShowPriceEasterEgg] = useState(false);
  const wordmarkClickRef = useRef<{ count: number; timer: number | null }>({ count: 0, timer: null });
  const handleWordmarkClick = useCallback(() => {
    const ref = wordmarkClickRef.current;
    ref.count += 1;
    if (ref.timer !== null) window.clearTimeout(ref.timer);
    ref.timer = window.setTimeout(() => {
      if (ref.count === 2) setShowPriceEasterEgg(true);
      ref.count = 0;
      ref.timer = null;
    }, 280);
  }, []);
  // Manual tap counting, not native onDoubleClick — mobile browsers routinely
  // eat a double-tap on a plain element as their own zoom gesture instead of
  // delivering it as a "dblclick" DOM event, which made the lock gesture
  // silently do nothing on touch devices even though it worked with a mouse.
  // What counts as a tap (one finger, short, barely moved, near the last one)
  // lives in tapCounter.ts: drags, holds and two-finger touches must never
  // add up to a lock. Exactly two taps lock; a third cancels it.
  const tapCounterRef = useRef(createTapCounter());
  const lockTimerRef = useRef<number | null>(null);
  const registerLockTap = useCallback(
    (taps: number) => {
      if (lockTimerRef.current !== null) {
        window.clearTimeout(lockTimerRef.current);
        lockTimerRef.current = null;
      }
      if (taps === 0) return;
      lockTimerRef.current = window.setTimeout(() => {
        lockTimerRef.current = null;
        const two = tapCounterRef.current.count === 2;
        tapCounterRef.current.reset();
        if (two) onLock();
      }, TAP_MAX_GAP_MS);
    },
    [onLock],
  );
  // Same lock-gesture-area doubles as the entry point into the Utility hub
  // (converter, map, Pokladna) via a right swipe — v2 only, since
  // that's where the feature itself lives. Distinguishing a swipe from the
  // tap counted above needs the same pointerdown/up + horizontal-threshold
  // approach as the balance card's privacy-swipe (handleBalancePointerDown/
  // Up below): only a drag clearly longer and more horizontal than vertical
  // counts as a swipe, so a slightly shaky double-tap never gets eaten as an
  // aborted swipe attempt and misses the lock gesture.
  // Separate from the justOnboarded-gated tour above on purpose: that tour
  // only ever runs once, right after a wallet is created or imported, so an
  // existing wallet that predates this feature would never see it. This one
  // shows once to everyone (still v2-only, since that's where the feature
  // lives) the first time the home screen renders — same
  // hasSeenHint/markHintSeen flag pattern as onchain-info/qr-copy above.
  // Declared here (not down by the other one-time hints) because
  // handleLockAreaPointerUp below needs dismissUtilityHint in its own
  // useCallback deps — referencing a later `const` from an earlier one in
  // the same render is a temporal-dead-zone error for anything evaluated
  // synchronously during render (a deps array is; a callback *body* isn't).
  const [showUtilityHint, setShowUtilityHint] = useState(() => !hasSeenHint("utility-swipe"));
  const dismissUtilityHint = useCallback(() => {
    markHintSeen("utility-swipe");
    setShowUtilityHint(false);
  }, []);
  const lockAreaSwipeStartRef = useRef<{ x: number; y: number } | null>(null);
  const handleLockAreaPointerDown = useCallback((e: ReactPointerEvent<HTMLDivElement>) => {
    tapCounterRef.current.down({
      id: e.pointerId,
      x: e.clientX,
      y: e.clientY,
      t: e.timeStamp,
      primary: e.isPrimary,
      button: e.button,
    });
    if (e.isPrimary) lockAreaSwipeStartRef.current = { x: e.clientX, y: e.clientY };
    e.currentTarget.setPointerCapture(e.pointerId);
  }, []);
  const handleLockAreaPointerUp = useCallback(
    (e: ReactPointerEvent<HTMLDivElement>) => {
      const taps = tapCounterRef.current.up({ id: e.pointerId, x: e.clientX, y: e.clientY, t: e.timeStamp });
      const start = lockAreaSwipeStartRef.current;
      if (e.isPrimary) lockAreaSwipeStartRef.current = null;
      if (!start || !e.isPrimary) {
        registerLockTap(0);
        return;
      }
      const dx = e.clientX - start.x;
      const dy = e.clientY - start.y;
      if (designVersion === "v2" && dx > 40 && Math.abs(dx) > Math.abs(dy) * 1.5) {
        openUtility();
        dismissUtilityHint();
        hapticTap();
        registerLockTap(0);
        return;
      }
      registerLockTap(taps);
    },
    [designVersion, registerLockTap, dismissUtilityHint, openUtility],
  );
  // Belt-and-suspenders: with touch-action: none (Dashboard.css) the browser
  // shouldn't cancel this gesture for its own native panning any more, but a
  // pointercancel can still happen for unrelated reasons (an incoming call,
  // the OS's own gesture UI intervening). Without clearing the ref here, a
  // cancelled first touch would leave a stale start point behind for the
  // *next* unrelated tap/swipe to be measured against.
  const handleLockAreaPointerCancel = useCallback(() => {
    lockAreaSwipeStartRef.current = null;
    tapCounterRef.current.cancel();
    registerLockTap(0);
  }, [registerLockTap]);
  useEffect(() => {
    return () => {
      if (wordmarkClickRef.current.timer !== null) window.clearTimeout(wordmarkClickRef.current.timer);
      if (lockTimerRef.current !== null) window.clearTimeout(lockTimerRef.current);
      if (utilitySettleTimerRef.current !== null) window.clearTimeout(utilitySettleTimerRef.current);
    };
  }, []);
  const wordmarkRef = useRef<HTMLSpanElement>(null);
  const balanceRef = useRef<HTMLDivElement>(null);
  const lockGestureAreaRef = useRef<HTMLDivElement>(null);
  // Beta: the worker reads the address as part of the open (bark.ts's
  // openHeldWallet), so it's here before the first render instead of queued
  // behind the post-unlock sync/maintenance calls. Null otherwise; the
  // effect below then asks for it itself.
  const [address, setAddress] = useState<string | null>(() => wallet.openedAddress ?? null);
  // The wallet's own address names the Ark server, so the send form can tell an
  // address for that server apart without queuing behind the wallet worker.
  useEffect(() => {
    if (address) learnArkServerFrom(address);
  }, [address]);
  // Surfaced right under the "Generuji adresu…" text in ReceiveScreen, not
  // just the generic top-level `loadError` banner below — that banner lives
  // on the home screen and is invisible while the Receive view is open,
  // which is exactly when a stuck address load actually matters. See the
  // address-loading effect's own comment for why this needed its own retry
  // loop in the first place: it used to run exactly once per unlock session,
  // so a single unlucky failure left the Ark receive address permanently
  // unavailable until the next unlock, even though everything else in the
  // app (which retries on its own recurring schedule) kept working fine.
  const [addressError, setAddressError] = useState<string | null>(null);
  const [history, setHistory] = useState<Movement[]>([]);
  // Free and failed VTXO refreshes stay out of the history (they are in
  // Settings → Automatická obnova → Deník instead), see refreshHistory.ts.
  // Display only: the receive watchers keep reading the full history.
  const visibleHistory = useMemo(() => history.filter((m) => !hiddenFromHistory(m)), [history]);
  // `history` is [] both before the first read and for a wallet with no
  // movements; the Ark receive watch must tell them apart (see its effect).
  const [historyLoaded, setHistoryLoaded] = useState(false);
  const [view, setView] = useState<View>("home");
  // User-initiated screen changes. With motion design on they run as a View
  // Transition: `morph` picks the element that grows into the next screen
  // (motion.css). Otherwise, or without the API, this is plain setView.
  const navigate = useCallback((next: View, morph?: NavMorph) => {
    const ends = morph ? NAV_MORPH_ENDS[morph] : null;
    const [fromSel, toSel] = ends ? (next === "home" ? [ends[1], ends[0]] : ends) : [null, null];
    const find = (selector: string | null) => () => {
      const el = selector ? document.querySelector(selector) : null;
      return el ? { el, override: el.matches(".qr-wrap") ? QR_WRAP_SKIN : undefined } : null;
    };
    withViewTransition(
      () => flushSync(() => setView(next)),
      { "nav-dir": next === "home" ? "back" : "forward", ...(morph ? { "nav-morph": morph } : {}) },
      ends ? { name: "nav-morph", from: find(fromSel), to: find(toSel), requireBothEnds: true } : undefined,
    );
  }, []);
  // The QR scanner is a sheet of this screen, not of the Send form: the home
  // button opens the camera over Home, the scan icon in Send first asks camera
  // or gallery. Cancelling just closes the sheet over where the person was.
  const [scanner, setScanner] = useState<"source" | "camera" | null>(null);
  // What the scanner read, for the Send form to fill in once it is open.
  const [scanned, setScanned] = useState<{ raw: string; nonce: number } | null>(null);
  const scannedNonceRef = useRef(0);
  const closeScanner = useCallback(() => setScanner(null), []);
  // The two flows behind the Home buttons' hold-menus. They live here, not
  // in SendPanel/ReceiveScreen, because the buttons that open them are on the
  // home screen — the gift composer used to be mounted inside SendPanel
  // purely because that is where its entry point happened to sit.
  const [giftOpen, setGiftOpen] = useState(false);
  const [requestOpen, setRequestOpen] = useState(false);
  const [profileOpen, setProfileOpen] = useState(false);
  const [chatOpen, setChatOpen] = useState(false);
  // The conversation a tapped chat notification asked for.
  const [chatPeer, setChatPeer] = useState<string | null>(null);
  // The due payment a tapped reminder notification asked for: Zprávy opens
  // with its pay sheet already up.
  const [chatScheduleId, setChatScheduleId] = useState<string | null>(null);
  // Payment reminders by push (beta, V2): registers the soonest due one.
  useEffect(() => {
    if (!chatOn) return;
    return startReminderSync(wallet);
  }, [wallet, chatOn]);
  useEffect(() => {
    if (!chatOn) return;
    let live = true;
    const open = (slot: string) => {
      markChatUsed();
      void startChat(wallet);
      void whenSlotPeer(slot).then((peer) => {
        if (!live || !peer) return;
        setChatPeer(peer);
        setChatOpen(true);
      });
    };
    const openSchedule = (id: string) => {
      markChatUsed();
      void startChat(wallet);
      // Settings and the Utility hub replace or cover the chat; the tap is already consumed.
      setShowSettings(false);
      setShowUtility(false);
      setChatScheduleId(id);
      setChatOpen(true);
    };
    void takePendingOpen().then((slot) => {
      if (slot) open(slot);
    });
    void takePendingSchedule().then((id) => {
      if (id && live) openSchedule(id);
    });
    const onMessage = (e: MessageEvent) => {
      const d = e.data as { type?: unknown; slot?: unknown; id?: unknown } | null;
      if (d?.type === "spendrr-open-schedule" && typeof d.id === "string") {
        void takePendingSchedule();
        openSchedule(d.id);
        return;
      }
      if (d?.type !== "spendrr-open-chat" || typeof d.slot !== "string") return;
      void takePendingOpen();
      open(d.slot);
    };
    navigator.serviceWorker?.addEventListener("message", onMessage);
    return () => {
      live = false;
      navigator.serviceWorker?.removeEventListener("message", onMessage);
    };
  }, [wallet, chatOn]);
  // A gift link someone sent in the chat, being claimed into this wallet.
  const [chatGift, setChatGift] = useState<GiftLinkParams | null>(null);
  // A payment-request link this session should pay: the Send form opens with
  // the destination and amount already filled in. Cleared the moment the
  // Send view is left, so coming back later is a blank form rather than a
  // stale one. The nonce remounts SendPanel (whose initial* props are read
  // once at mount) when a second request arrives while Send is already open.
  const [sendPrefill, setSendPrefill] = useState<{ destination: string; amountSats?: number; nonce: number } | null>(
    null,
  );
  const prefillNonceRef = useRef(0);
  useEffect(() => {
    if (!payRequest) return;
    prefillNonceRef.current += 1;
    setSendPrefill({ ...payRequest, nonce: prefillNonceRef.current });
    setScanner(null);
    setView("send");
    onPayRequestConsumed?.();
  }, [payRequest, onPayRequestConsumed]);
  // Leaving Send drops the prefill, so returning to it later is a blank
  // form rather than one still holding somebody else's request.
  useEffect(() => {
    if (view !== "send") {
      setSendPrefill(null);
      setScanned(null);
    }
  }, [view]);
  const [loadError, setLoadError] = useState<string | null>(null);
  // The friendly copy in loadError itself is deliberately generic (see
  // reportLoadError's own comment) — every refresh() failure collapses to
  // the same "Počkej chvíli…"/"Nejsi online.", whether it's an actual
  // timeout, a genuine SDK/network error, or anything else, so it never
  // dumps a wasm stack trace on someone who just wants to check their
  // balance. That made a report of "this keeps happening" undebuggable from
  // the outside, though — the real cause only ever went to the console (an
  // ordinary user won't open that). Kept here too, copy-pasteable but
  // visually secondary, same pattern as App.tsx's workerLostReason banner.
  const [loadErrorDetail, setLoadErrorDetail] = useState<string | null>(null);
  // Onchain funds received via the Onchain receive tab sit in a separate
  // balance the SDK tracks independently of the Ark one — they only become
  // spendable/visible in the main balance once explicitly boarded. Polled on
  // its own, much slower timer than the Ark refresh() cycle below (onchain
  // confirmations take ~10 minutes anyway, no need to hammer the worker
  // queue for it) — see the effect further down.
  const [onchainBalance, setOnchainBalance] = useState<OnchainBalance | null>(null);
  // Set only when the user has clicked "Přijmout" on the sticky onchain
  // notification, opening the confirm dialog — boarding itself only starts
  // once they confirm inside it, never automatically.
  const [showBoardConfirm, setShowBoardConfirm] = useState(false);
  const [boarding, setBoarding] = useState(false);
  const [boardError, setBoardError] = useState<string | null>(null);
  // Learned lazily from a failed boardAll() (see translateBoardError) — the
  // SDK exposes no way to ask the server's minimum ahead of time. Once known,
  // the sticky toast below switches to an info-only message instead of a
  // "Přijmout" button that would just fail again with the same error.
  const [boardMinSats, setBoardMinSats] = useState<number | null>(null);
  // Unilateral exit: one tracker for the whole session (useExitTracker.ts),
  // shared by the home card, the balance note and the exit sheet.
  const exitTracker = useExitTracker(wallet);
  const exitOverview = exitTracker.overview;
  // Push while an exit runs (exitNudge.ts): the height goes out with the
  // ordinary expiry report, the words stay on the device for sw.js.
  const exitPushWatch = useMemo(() => exitPushWatchHeight(exitOverview), [exitOverview]);
  const exitPushWatchRef = useRef<number | null>(null);
  exitPushWatchRef.current = exitPushWatch;
  const reportedExitPushWatch = useRef<number | null>(null);
  useEffect(() => {
    if (!exitTracker.loaded || exitPushWatch === reportedExitPushWatch.current) return;
    reportedExitPushWatch.current = exitPushWatch;
    void refreshPushAuthorization(wallet, ratesRef.current?.usd, exitPushWatch);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- re-report only when the height changes
  }, [exitTracker.loaded, exitPushWatch, wallet]);
  const exitFeesMissing = exitTracker.feesMissing;
  const exitHint = useMemo(
    () => exitNotificationHint(exitOverview, exitFeesMissing, t, 0),
    [exitOverview, exitFeesMissing, t],
  );
  const exitHintKey = exitHint ? `${exitHint.title}\n${exitHint.body}` : "";
  useEffect(() => {
    if (!exitTracker.loaded) return;
    void writeExitNotificationHint(exitHint ? { ...exitHint, at: Date.now() } : null);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- rewritten only when the words change
  }, [exitTracker.loaded, exitHintKey]);
  const [showExitSheet, setShowExitSheet] = useState(false);
  // An exit that still has transactions to get on-chain pays their fees
  // from the confirmed on-chain balance; boarding it into Ark would stall
  // the exit (see confirmBoard and the on-chain toast). Before the tracker's
  // first successful read the overview is empty, which would read as "no
  // exit" and offer to board exactly the fee money just sent; until then the
  // last session's hint decides, erring towards an exit running.
  const exitNeedsOnchainFees = exitTracker.loaded ? exitOverview.broadcastingIds.length > 0 : exitMayBeLive();
  // While an exit runs, on-chain money here is mostly the change of its own
  // CPFP transactions, not an incoming payment: the notices below say so.
  const exitLive = exitTracker.loaded ? exitOverview.live : exitMayBeLive();
  // Lifted out of ReceiveScreen (rather than kept local + reported up via an
  // effect) so receiveNeedsQrGap below can be derived synchronously in the
  // same render that changes it — an effect-based round trip caused a
  // one-frame flash of the mode-toggle at its old (no-gap) position before
  // the parent re-rendered with the margin applied.
  // v2 adds "ln", the Lightning address, as its default (ReceiveScreen).
  const [receiveMode, setReceiveMode] = useState<ReceiveFormat>("ln");
  // Lifted for the same reason as receiveMode: confirmBoard() below needs to
  // reset this to null on a successful board so the next tab-open fetches a
  // fresh address instead of reusing one that's already received funds.
  // Initialized from localStorage (see onchainReceiveAddress.ts) so a
  // restart doesn't hand out a brand new address on top of one the user may
  // already have shared but not yet been paid to.
  const [onchainAddress, setOnchainAddress] = useState<string | null>(() => loadStoredReceiveAddress()?.address ?? null);
  // The onchain UTXO outpoints known to exist *before* `onchainAddress` was
  // handed out — see hasNewOutpoint()'s doc comment for why this, not the
  // address itself, is what detects "has this been paid yet". Mirrors
  // whatever's persisted alongside onchainAddress; doesn't need to be React
  // state since nothing renders off it directly.
  const onchainReceiveBaselineRef = useRef<string[]>(loadStoredReceiveAddress()?.baseline ?? []);
  // Guards against ReceiveScreen's tab-open effect firing this twice
  // concurrently — e.g. the user flips Ark -> Onchain -> Ark -> Onchain fast
  // enough that onchainAddress is still null (first newAddress() not
  // resolved yet) when the effect re-runs. Without this, both calls would
  // each derive and burn a distinct address, and whichever resolves last
  // would silently win, discarding the other.
  const onchainAddressFetchInFlightRef = useRef(false);
  // Derives a fresh onchain receive address and persists it (with its
  // baseline) so it survives a restart — see onchainReceiveAddress.ts.
  // Called from ReceiveScreen's tab-open effect below. Fire-and-forget by
  // design, like the call it replaces: a failure just leaves onchainAddress
  // null (no error state of its own), same as before this was lifted here.
  const requestOnchainAddress = useCallback(() => {
    if (onchainAddressFetchInFlightRef.current) return;
    onchainAddressFetchInFlightRef.current = true;
    void (async () => {
      try {
        const addr = await withTimeout(wallet.onchainWallet.newAddress(), WALLET_CALL_TIMEOUT_MS, t(TIMEOUT_MESSAGE));
        let baseline: string[] = [];
        try {
          baseline = snapshotOutpoints(
            await withTimeout(wallet.onchainWallet.utxos(), WALLET_CALL_TIMEOUT_MS, t(TIMEOUT_MESSAGE)),
          );
        } catch {
          // Best-effort — worst case this address's baseline is empty and a
          // pre-existing outpoint is misread as "new" once, rotating it
          // early. Never a fund-safety issue (see onchainReceiveAddress.ts),
          // so this must not block showing the address itself.
        }
        onchainReceiveBaselineRef.current = baseline;
        saveReceiveAddress(addr, baseline);
        setOnchainAddress(addr);
      } catch {
        // Swallowed, not surfaced — matches the pre-existing behavior of the
        // call this replaces (no .catch, no dedicated error state).
      } finally {
        onchainAddressFetchInFlightRef.current = false;
      }
    })();
  }, [wallet, t]);
  // Asked for shortly after unlock instead of when the Receive screen or its
  // On-chain tab is first opened: with no stored address the first open showed
  // a placeholder while the worker derived one (it used to collapse the panel).
  // Once per wallet, and again after a payment or a board clears the address.
  // The short wait keeps it out of the way of the unlock's own calls; the
  // worker queue would serialise it anyway. A failed attempt is retried by
  // ReceiveScreen's own effect when it opens. The baseline taken with it is safe
  // before the first on-chain scan has finished, see evaluateReceiveAddressUsage.
  // Not while the wallet's one-time initial on-chain scan is still running (a
  // recovery can take minutes on the same worker queue): the request would wait
  // behind it, hit the 20 s call timeout and still derive an index later. The
  // balance poll re-runs this when it updates, which is when the flag flips.
  useEffect(() => {
    if (onchainAddress || !isInitialOnchainScanDone()) return;
    const timer = window.setTimeout(requestOnchainAddress, ONCHAIN_ADDRESS_PREFETCH_MS);
    return () => window.clearTimeout(timer);
  }, [onchainAddress, onchainBalance, requestOnchainAddress]);
  const [rates, setRates] = useState<Record<FiatCurrency, number> | null>(null);
  // The expiry nudge is worded on this device (sw.js), in the current language,
  // and its "Bitcoin moved since your last look" percentage is counted there from
  // the price at the last look, so it stays right however long the Worker's own
  // copy of the price (sent with a subscribe) is.
  const usdRate = rates?.usd;
  useEffect(() => {
    void writeExpiryCopy(t, usdRate);
  }, [t, usdRate]);
  // Mirrors `rates` for fetchBalanceAndHistory below to read without being a
  // dependency of it — `rates` gets a genuinely new object reference on
  // almost every ~60s price-poll tick (see that effect), and putting it in
  // fetchBalanceAndHistory's own useCallback deps used to recreate that
  // callback on the same cadence, which cascaded through refresh's deps into
  // the mount effect's deps and re-ran full wallet sync()/maintenance() and
  // address re-derivation every ~60s for the whole session — a real bug
  // caught in review, not a hypothetical.
  const ratesRef = useRef<Record<FiatCurrency, number> | null>(null);
  // Chat notifications replaced the browser's push subscription: the payment
  // push registration follows it, with the same values as every other report.
  useEffect(() => {
    const follow = () => void refreshPushAuthorization(wallet, ratesRef.current?.usd, exitPushWatchRef.current);
    window.addEventListener(PUSH_SUBSCRIPTION_EVENT, follow);
    return () => window.removeEventListener(PUSH_SUBSCRIPTION_EVENT, follow);
  }, [wallet]);
  const [currency, setCurrency] = useState<FiatCurrency>(getFiatCurrency());
  // Post-setup onboarding tour: a short, one-time sequence of coachmarks
  // pointing at the wordmark (price easter egg) and balance card (unit
  // switch / privacy swipe), shown only right after the user finishes
  // creating or importing a wallet — see justOnboarded in App.tsx. Each step
  // has its own localStorage flag (onboardingHints.ts), so it's also safe
  // against being interrupted mid-sequence.
  // Fixed priority order, not an array filtered/indexed by a separately
  // advancing counter — that used to drift out of sync with itself: e.g.
  // step 1 (logo-price) shown while `rates` was still null excluded
  // balance-hint from the array entirely, but if `rates` finished loading
  // by the time that step was dismissed, the *next* render's array now
  // included balance-hint too, shifting every later index over by one and
  // silently skipping whatever the stale index used to point at. Deriving
  // the current step fresh each render from hasSeenHint() directly (first
  // not-yet-seen step in this list whose own precondition holds) can't
  // drift, because there's no index to desync from the array's shape.
  // tourVersion exists only to force a re-render after advanceTour() calls
  // markHintSeen() — that write doesn't itself trigger React to re-run this.
  const [tourVersion, setTourVersion] = useState(0);
  const currentTourStepBase = useMemo((): {
    key: HintKey;
    ref: RefObject<HTMLElement | null>;
    text: string;
    placement?: "top" | "bottom";
  } | null => {
    if (!hasSeenHint("logo-price")) {
      return { key: "logo-price", ref: wordmarkRef, text: t("Dvojklikem na logo zobrazíš aktuální kurz bitcoinu.") };
    }
    // Combined into one step (was two separate ones) — both act on the same
    // balance card, so splitting them into consecutive coachmarks pointing
    // at the same element read as redundant. Still gated on rates being
    // loaded: the currency-switch half is a no-op until then (see
    // effectivePrimary below), so surfacing it earlier would describe a
    // gesture that visibly does nothing yet. Not hasSeenHint'd-past just
    // because rates aren't ready — this pauses the sequence here instead of
    // falling through to lock-gesture out of order.
    if (!hasSeenHint("balance-hint")) {
      return rates !== null
        ? { key: "balance-hint", ref: balanceRef, text: t("Přejetím zůstatek skryješ, klepnutím přepneš měnu.") }
        : null;
    }
    if (!hasSeenHint("lock-gesture")) {
      // lock-gesture-area is a tall rectangle stretching toward the bottom
      // of the screen — the default "bottom" placement would put the bubble
      // (with the dismiss button) below it, i.e. off-screen, so this step
      // could never actually be dismissed. See the utility-swipe coachmark
      // below for the same fix on the same target.
      return {
        key: "lock-gesture",
        ref: lockGestureAreaRef,
        text: t("Dvojitým klepnutím sem peněženku zamkneš."),
        placement: "top",
      };
    }
    return null;
    // eslint-disable-next-line react-hooks/exhaustive-deps -- tourVersion is a deliberate recompute trigger, not a real input
  }, [t, rates, tourVersion]);
  const advanceTour = useCallback((key: HintKey) => {
    markHintSeen(key);
    setTourVersion((v) => v + 1);
  }, []);

  // The Přijmout/Odeslat hold-menus have no visible label beyond three faint
  // dots, so they get one introduction. Deliberately outside the tour array
  // above: it runs on first setup only, and this gesture is new to wallets
  // that predate it.
  const sendButtonRef = useRef<HTMLButtonElement>(null);
  const receiveButtonRef = useRef<HTMLButtonElement>(null);
  const [showHoldHint, setShowHoldHint] = useState(() => !hasSeenHint("action-hold"));
  const dismissHoldHint = useCallback(() => {
    markHintSeen("action-hold");
    setShowHoldHint(false);
  }, []);
  const [pendingReceive, setPendingReceive] = useState<PendingReceive | null>(null);
  const [toast, setToast] = useState<{
    message: string;
    kind: "success" | "danger" | "neutral";
    detail?: ToastDetail;
    raw?: string | null;
    closing: boolean;
  } | null>(null);
  const [toastRawCopied, setToastRawCopied] = useState(false);
  const toastCloseTimerRef = useRef<number | null>(null);
  const toastTimerRef = useRef<number | null>(null);
  // Swipe-to-hide balance (privacy peek). Persisted across reloads so it
  // stays hidden until the user swipes it back — a lock-screen refresh
  // shouldn't flash a balance you just deliberately hid.
  const [balanceHidden, setBalanceHidden] = useState(() => localStorage.getItem(BALANCE_HIDDEN_KEY) === "1");
  const [swipeDir, setSwipeDir] = useState<"left" | "right">("right");
  const swipeStartRef = useRef<{ x: number; y: number } | null>(null);
  // Tap (not swipe) on the balance swaps which unit is the big headline
  // number and which is the small line underneath. Falls back to "sats"
  // whenever there's no fiat rate to show — nothing to swap to otherwise.
  const [balancePrimary, setBalancePrimary] = useState<"sats" | "fiat">("sats");
  // Plays the balance's drop-in animation exactly once, the moment it first
  // loads after opening the app — not on every later refresh(). The ref
  // tracks whether we've already seen a loaded balance.
  //
  // Setting the state below happens directly during render (React's
  // documented pattern for derived state — see "Adjusting state when a prop
  // changes" in the React docs), not in an effect. An effect runs *after*
  // the browser has already painted the loaded balance without the
  // animation class, so the very next commit (adding the class) made the
  // number briefly flash — fully visible, then snap back to the animation's
  // "from" state and fade in again. Setting it during render means React
  // re-renders with the class already present before anything is painted
  // at all, so that flash is structurally impossible, not just timed away.
  const hasSeenBalanceRef = useRef(false);
  const [showBalanceEnter, setShowBalanceEnter] = useState(false);
  const balanceLoaded = balance !== null;
  // Skip while the real balance is still forced to a held 0 behind the
  // "Dostal jsi dárek" modal (see hideBalanceForGiftReveal/giftClaimActive
  // below) — the drop-in animation would otherwise play on that placeholder
  // 0 the instant the real balance loads underneath, reading as the number
  // flickering for no reason. It fires for real once the modal closes and
  // this effect re-runs with the actual balance still unseen.
  if (balanceLoaded && !hasSeenBalanceRef.current && !(hideBalanceForGiftReveal && giftClaimActive)) {
    hasSeenBalanceRef.current = true;
    setShowBalanceEnter(true);
  }
  useEffect(() => {
    // Clearing the class is not flicker-sensitive the way setting it is —
    // this just needs to happen sometime after the animation has finished,
    // so a normal effect + timeout is fine here.
    if (!showBalanceEnter) return;
    const timer = window.setTimeout(() => setShowBalanceEnter(false), 700);
    return () => window.clearTimeout(timer);
  }, [showBalanceEnter]);

  // The sats/fiat swap-in animation (.balance-primary-swap / .balance-secondary-swap)
  // is an explicit one-shot, armed only for the ~0.3s a real unit swap or a
  // hide/reveal toggle takes. It must NOT sit on .balance-main permanently:
  // .balance-enter (load) and .balance-bump (payment) are declared later in
  // Dashboard.css and win the `animation` shorthand while present, so a
  // permanently-present .balance-primary-swap gets "unshadowed" the instant
  // either of those classes is removed in place — the browser then sees
  // balance-swap-primary as a freshly-active animation-name and replays it
  // from scale(0.88)/opacity:0. That was the ~300ms-after-load flicker (and
  // an identical blip ~900ms after every received payment).
  const [showBalanceSwap, setShowBalanceSwap] = useState(false);
  const swapTimerRef = useRef<number | null>(null);
  const triggerBalanceSwap = useCallback(() => {
    setShowBalanceSwap(true);
    if (swapTimerRef.current !== null) window.clearTimeout(swapTimerRef.current);
    swapTimerRef.current = window.setTimeout(() => setShowBalanceSwap(false), 320);
  }, []);

  useEffect(() => {
    localStorage.setItem(BALANCE_HIDDEN_KEY, balanceHidden ? "1" : "0");
  }, [balanceHidden]);

  // Alternate trigger for the same toggle swipe uses — opt-in via Settings
  // (NotificationSettings-style toggle), since iOS gates devicemotion behind
  // an explicit permission prompt anyway. Checked once per mount rather than
  // reactively: enabling/disabling it in Settings while Dashboard is already
  // open just takes effect on the next unlock, same as other opt-in toggles
  // here (haptics, bg glow).
  useEffect(() => {
    if (!isShakeEnabled()) return;
    return startShakeDetection(() => {
      setBalanceHidden((h) => !h);
      triggerBalanceSwap();
      hapticTap();
    });
  }, [triggerBalanceSwap]);

  const handleBalancePointerDown = useCallback((e: ReactPointerEvent<HTMLDivElement>) => {
    swipeStartRef.current = { x: e.clientX, y: e.clientY };
    e.currentTarget.setPointerCapture(e.pointerId);
  }, []);

  const handleBalancePointerUp = useCallback(
    (e: ReactPointerEvent<HTMLDivElement>) => {
      const start = swipeStartRef.current;
      swipeStartRef.current = null;
      if (!start) return;
      const dx = e.clientX - start.x;
      const dy = e.clientY - start.y;
      // Require a clearly horizontal drag so a vertical scroll gesture
      // starting on the balance card never accidentally toggles it.
      if (Math.abs(dx) < 40 || Math.abs(dx) < Math.abs(dy) * 1.5) {
        // Barely moved at all — treat it as a tap that swaps sats/fiat,
        // rather than an aborted or too-shallow swipe attempt.
        if (Math.abs(dx) < 10 && Math.abs(dy) < 10 && rates !== null) {
          setBalancePrimary((p) => (p === "sats" ? "fiat" : "sats"));
          triggerBalanceSwap();
          hapticTap();
        }
        return;
      }
      setSwipeDir(dx > 0 ? "right" : "left");
      setBalanceHidden((h) => !h);
      triggerBalanceSwap();
      hapticTap();
    },
    [rates, triggerBalanceSwap],
  );

  const showToast = useCallback((
    message: string,
    kind: "success" | "danger" | "neutral" = "success",
    detail?: ToastDetail,
    // `raw` puts a copy button on the toast; `quiet` skips the OS
    // notification and the payment buzz, for errors that aren't payments.
    extra?: { raw?: string | null; quiet?: boolean },
  ) => {
    // While a fresh gift recipient is still on the "Dostal jsi dárek" modal,
    // don't pop a "payment received" toast behind it — the modal already is
    // that announcement. It fires normally the moment they tap through.
    if (giftRevealHoldRef.current) return;
    if (toastTimerRef.current !== null) window.clearTimeout(toastTimerRef.current);
    if (toastCloseTimerRef.current !== null) window.clearTimeout(toastCloseTimerRef.current);
    setToast({ message, kind, detail, raw: extra?.raw ?? null, closing: false });
    setToastRawCopied(false);
    toastTimerRef.current = window.setTimeout(() => {
      // Flip to the closing animation first, then actually unmount once it
      // finishes, so the toast flies back out instead of just vanishing.
      setToast((current) => (current ? { ...current, closing: true } : current));
      toastCloseTimerRef.current = window.setTimeout(() => setToast(null), TOAST_EXIT_MS);
    }, extra?.raw ? TOAST_ERROR_DURATION_MS : kind === "neutral" ? TOAST_NEUTRAL_DURATION_MS : TOAST_DURATION_MS);
    // A "neutral" toast (e.g. copy confirmation) isn't a payment event — no
    // OS push notification for it, and a light tap instead of the heavier
    // payment-notification buzz.
    if (kind === "neutral" || extra?.quiet) {
      hapticTap();
    } else {
      notifyPayment(message);
      hapticNotify();
    }
  }, []);
  // A scan result. This app's own gift link opens the claim sheet in this session (no reload, no re-unlock),
  // its other same-origin links (a payment request) are opened by a page load, and anything else is a
  // payment destination for the Send form, which is opened with it when it is not open yet.
  const handleScanResult = useCallback((raw: string) => {
    setScanner(null);
    try {
      const gift = giftFromScannedUrl(raw, window.location.origin);
      if (gift) {
        // The fragment holds the gift's mnemonic: decoded here, never stored or logged.
        if (!gift.ok) showToast(t("Odkaz na dárek nejde přečíst."), "danger", undefined, { quiet: true });
        else {
          setView("home");
          if (hasClaimedGift(gift.gift.id)) showToast(t("Tenhle dárek už je vyzvednutý"), "neutral");
          else setChatGift(gift.gift);
        }
        return;
      }
      const url = new URL(raw);
      if (url.origin === window.location.origin && (isGiftPath(url.pathname) || isRequestPath(url.pathname))) {
        window.location.href = raw;
        return;
      }
    } catch {
      // Not a URL at all (a bitcoin:/lightning:/ark: URI, or a bare address/invoice): a destination.
    }
    scannedNonceRef.current += 1;
    setScanned({ raw, nonce: scannedNonceRef.current });
    setView("send");
  }, [showToast, t]);

  // Some of bark's chain requests for the exit went to Second's esplora
  // because the independent one didn't answer (walletWorkerGuard.ts,
  // exitChainRedirect). Said once per session, in the island.
  const chainFallbackToldRef = useRef(false);
  useEffect(() => {
    if (chainFallbackToldRef.current || !exitOverview.live || exitTracker.chainFallbacks === 0) return;
    chainFallbackToldRef.current = true;
    showToast(t("Nezávislý uzel neodpovídá, exit teď běží přes servery Second."), "danger", undefined, { quiet: true });
  }, [exitOverview.live, exitTracker.chainFallbacks, showToast, t]);

  // Errors reported from anywhere in the app (Settings, gift modals, the
  // Utility hub) via appErrors.surfaceError() land here as an island toast.
  useEffect(
    () =>
      onErrorToast((event) => {
        if (event.type === "dismiss") {
          setToast((current) => (current?.kind === "danger" ? { ...current, closing: true } : current));
          return;
        }
        const { text, raw } = describeError(event.error, t, lang);
        showToast(text, "danger", undefined, { raw, quiet: true });
      }),
    [showToast, t, lang],
  );

  const copyToastRaw = useCallback((raw: string) => {
    void navigator.clipboard?.writeText(raw).then(
      () => setToastRawCopied(true),
      () => {},
    );
  }, []);

  // Plays the balance headline's rolling-digit reveal for a confirmed
  // incoming/outgoing payment. Used to be a bare "arm showBalanceBump" flag
  // with the displayed value (revealedSpendable, near `spendable` below)
  // mirrored on the side in its own effect — but those two updating in
  // separate renders meant the roll's `animate` signal and its `text`
  // target routinely didn't land together (the exact order even flipped
  // between the receive and send code paths), so the number would just
  // silently snap on whichever render actually carried it, with no visible
  // roll. bumpBalance() below is now the ONLY thing that reveals a new
  // balance: it sets the displayed value AND arms the roll in the same
  // call, so they can never land in different renders. `overrideSpendable`
  // lets a caller that already has a fresh value in hand (e.g. a receive
  // watcher's own refresh() result) pass it directly instead of relying on
  // headlineRef having caught up to a just-settled setBalance() yet.
  const [showBalanceBump, setShowBalanceBump] = useState(false);
  const bumpTimerRef = useRef<number | null>(null);
  const headlineRef = useRef<number | undefined>(undefined);
  const inRoundRef = useRef(0);
  const [revealedSpendable, setRevealedSpendable] = useState<number | undefined>(undefined);
  const revealedSpendableRef = useRef<number | undefined>(undefined);
  revealedSpendableRef.current = revealedSpendable;
  // Which way RollingDigits should roll for the reveal currently in
  // flight — "up" (the default look) for an increasing balance, "down" for
  // a decreasing one. Computed once per bumpBalance() call, from the value
  // actually being revealed against whatever was revealed before it, not
  // from raw spendable deltas (which could include an off-screen backlog
  // spanning several payments in either direction — only the NET direction
  // of what's about to visibly change matters here).
  const [bumpDirection, setBumpDirection] = useState<"up" | "down">("up");
  const bumpBalance = useCallback((overrideHeadline?: number) => {
    // Same reasoning as showToast's own guard above: while the claim modal
    // holds the headline at 0, a bump animation on that 0 would read as the
    // number flickering for no visible reason.
    if (giftRevealHoldRef.current) return;
    pendingBumpRef.current = false;
    // Callers hand over a complete headline (headlineSats of one balance
    // snapshot); adding the current round amount here would mix snapshots.
    const nextSpendable = overrideHeadline !== undefined ? overrideHeadline : headlineRef.current;
    // Marks this value as already handled so the quiet-catch-up effect
    // (declared below, near `spendable`) doesn't later see `spendable`
    // reach this same number and redundantly schedule its own no-op
    // update — see that effect's own comment for the actual bug this
    // class of mismatch used to cause.
    if (nextSpendable !== undefined) processedHeadlineRef.current = nextSpendable;
    const prevSpendable = revealedSpendableRef.current;
    setBumpDirection(nextSpendable !== undefined && prevSpendable !== undefined && nextSpendable < prevSpendable ? "down" : "up");
    setRevealedSpendable(nextSpendable);
    setShowBalanceBump(true);
    if (bumpTimerRef.current !== null) window.clearTimeout(bumpTimerRef.current);
    bumpTimerRef.current = window.setTimeout(() => setShowBalanceBump(false), 900);
  }, []);
  // What every payment-confirmed call site actually calls (bumpBalance
  // itself is only called from here, or once balanceOnScreen catches up
  // below). Reveals immediately if the balance is actually on screen right
  // now; otherwise just remembers a reveal is owed until it is — see
  // balanceOnScreen's own comment for why revealing off-screen would defeat
  // the whole point of the roll.
  const pendingBumpRef = useRef(false);
  const balanceOnScreenRef = useRef(true);
  const requestBalanceBump = useCallback(
    (overrideHeadline?: number) => {
      if (balanceOnScreenRef.current) {
        bumpBalance(overrideHeadline);
      } else {
        pendingBumpRef.current = true;
      }
    },
    [bumpBalance],
  );

  // Whether the tab/window itself is actually on screen right now — distinct
  // from `view`/`showSettings` below (which track whether *this app's own*
  // balance-card is the thing being shown), this covers the phone being
  // locked or the browser backgrounded while the app's own screen state
  // hasn't changed at all. Feeds balanceOnScreen (declared with `spendable`
  // below) — see its own comment for why the roll animation needs this.
  const [tabVisible, setTabVisible] = useState(() => document.visibilityState === "visible");
  useEffect(() => {
    const onVisibilityChange = () => setTabVisible(document.visibilityState === "visible");
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => document.removeEventListener("visibilitychange", onVisibilityChange);
  }, []);

  useEffect(() => {
    return () => {
      if (toastTimerRef.current !== null) window.clearTimeout(toastTimerRef.current);
      if (toastCloseTimerRef.current !== null) window.clearTimeout(toastCloseTimerRef.current);
      if (swapTimerRef.current !== null) window.clearTimeout(swapTimerRef.current);
      if (bumpTimerRef.current !== null) window.clearTimeout(bumpTimerRef.current);
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    const load = () => {
      fetchBtcRates()
        .then((r) => {
          if (!cancelled) {
            setRates(r);
            ratesRef.current = r;
          }
        })
        .catch(() => {
          // Best-effort only — the fiat line just doesn't show.
        });
    };
    load();
    // Not while hidden (the fiat line isn't on screen); coming back loads at once.
    const tick = () => {
      if (!document.hidden) load();
    };
    const interval = window.setInterval(tick, 60_000);
    document.addEventListener("visibilitychange", tick);
    return () => {
      cancelled = true;
      window.clearInterval(interval);
      document.removeEventListener("visibilitychange", tick);
    };
  }, []);
  // Guards every wallet.* call refresh() makes (sync/balance/history AND the
  // maintenance() that follows) against overlapping with another refresh()
  // triggered while the first is still running — e.g. the background receive
  // watchers below firing on their own timers, or the foreground refresh
  // while a previous refresh's maintenance() phase is still in flight. Two overlapping
  // wallet.* calls crash the WASM bridge, so a second refresh() call while
  // this is true piggybacks on the already-running one (see activeRunRef
  // below) instead of making its own attempt.
  const busyRef = useRef(false);
  // First time a background refresh failure happens in the current streak —
  // cleared as soon as a call actually succeeds. Lets us tell "one slow call"
  // from "we've been failing for 30s straight" without a second poller.
  const loadErrorSinceRef = useRef<number | null>(null);
  // The island says "Jsi offline" (or, beta, that the Ark server isn't
  // answering) for as long as that lasts, then "Jsi zase online" / "Server
  // zase odpovídá" for a moment. See connectivity.ts for what decides it.
  const net = useNetState();
  const [netIsland, setNetIsland] = useState<NetIsland | null>(() => {
    const s = netState();
    return s === "online" ? null : { kind: s, closing: false };
  });
  // Set by the transitions effect below (which also runs on mount).
  const wasBadNetRef = useRef<"offline" | "arkDown" | null>(null);
  // Pending fast-retry timers scheduled by the visibilitychange effect below
  // — tracked so they can be cleared on unmount or a rapid re-toggle rather
  // than firing a stray refresh() after the fact.
  const retryTimersRef = useRef<number[]>([]);

  // The home-screen toast this feeds is a small pill, not a diagnostics
  // panel — whatever wallet.sync()/maintenance() actually threw (a
  // withTimeout() timeout, or a raw SDK/reqwest error whose message can be a
  // multi-paragraph wasm stack dump) never belongs in it. Every refresh()
  // failure collapses to the same short, escalating copy; the real error
  // still goes to the console for debugging.
  const reportLoadError = useCallback(
    (e: unknown) => {
      console.error("refresh() failed:", e);
      // A known, expected reason to be queued behind something slow right
      // now (see isOnchainScanActive's own comment in bark.ts) — not
      // evidence of an actual problem, so don't let it start or extend the
      // failure streak below. Once the scan finishes, a genuinely new
      // problem still gets tracked and shown normally from a clean slate.
      if (isOnchainScanActive()) return;
      // Beta: ask the network whether it explains this (a no-op unless the
      // probe is idle and enabled, see connectivity.ts).
      reportNetworkTrouble();
      if (loadErrorSinceRef.current === null) loadErrorSinceRef.current = Date.now();
      const elapsed = Date.now() - loadErrorSinceRef.current;
      // Still within the initial silent-retry window — record the failure
      // (so the clock keeps running toward OFFLINE_THRESHOLD_MS if it really
      // is a prolonged outage) but don't put anything on screen for it yet.
      if (elapsed < LOAD_ERROR_GRACE_MS) return;
      // "Offline" here has only ever meant "failing for a while", never an
      // actual connectivity check — so a prolonged spell of the *server*
      // erroring (or of wallet.* calls merely queued behind a slow one, see
      // WALLET_CALL_TIMEOUT_MS) read to the user as "Nejsi online." while
      // their own connection was fine the whole time. navigator.onLine is
      // only reliable for the false case (browser knows for sure there's no
      // interface at all) — a true value doesn't guarantee real
      // connectivity, but it does rule out blaming the user's own link, so
      // gate the harsher message on it actually being false.
      const offline = elapsed >= OFFLINE_THRESHOLD_MS && isOffline();
      setLoadError(t(offline ? OFFLINE_MESSAGE : TIMEOUT_MESSAGE));
      setLoadErrorDetail(e instanceof Error ? e.message : String(e));
    },
    [t],
  );

  // Mirrors the balance/history state purely so fetchBalanceAndHistory below
  // can tell "actually changed" from "same as last poll" without making the
  // setState updaters (which must stay pure) do that detection — used to
  // trigger the cloud-backup upload (onWalletStateChanged) only on a real
  // change, not on every ~8s background poll.
  const prevBalanceRef = useRef<Balance | null>(null);
  const prevHistoryRef = useRef<Movement[] | null>(null);

  const fetchBalanceAndHistory = useCallback(async (): Promise<{ balance: Balance; history: Movement[] }> => {
    // Both requests are dispatched here, back to back, before either is
    // awaited — not `await wallet.balance()` followed by a separate
    // `wallet.history()` call once that resolves. The worker's FIFO queue
    // means whichever wallet.* call is requested LATER absorbs whatever
    // else queued up in the meantime: with the old sequential-await shape,
    // by the time this code got around to requesting history(), every other
    // mount-time effect (push-auth refresh, the exit-claim check, the
    // onchain poll — all firing their own wallet.* calls straight from
    // mount) had had a chance to queue ahead of it, even though none of
    // them could land between balance()'s *own* request and its
    // resolution. Measured live from the call log: a cold open where
    // balance() resolved in ~1s but history() then took ~3s right after
    // it, purely from what had queued up in between — "Nedávná aktivita"
    // sitting empty well after the balance/buttons had already rendered.
    // Requesting both in the same synchronous stretch (no `await` between
    // the two request() calls) closes that gap; awaiting them separately
    // below (not Promise.all) still lets setBalance land as soon as
    // balance() resolves, independent of history() — same as before, since
    // the worker's strict FIFO means balance() (requested first) always
    // resolves first anyway. The worker already serializes concurrent
    // calls safely (see wallet.worker.ts's queue), so this is purely about
    // dispatch order, not concurrent execution.
    const balPromise = withTimeout(wallet.balance(), WALLET_CALL_TIMEOUT_MS, t(TIMEOUT_MESSAGE));
    const histPromise = withTimeout(wallet.history(), WALLET_CALL_TIMEOUT_MS, t(TIMEOUT_MESSAGE));
    const bal = await balPromise;
    // The background watchers below call this every ~8s regardless of
    // whether anything actually changed — most polls find nothing new.
    // Bailing out to the previous object/array reference when the fetched
    // values are equivalent lets React's setState bail-out (Object.is on
    // the new value) skip re-rendering the whole Dashboard tree for that
    // tick, instead of every button and panel on screen re-rendering every
    // 8 seconds even when idle.
    const firstLoad = prevBalanceRef.current === null && prevHistoryRef.current === null;
    const balanceChanged = !prevBalanceRef.current || !balancesEqual(prevBalanceRef.current, bal);
    prevBalanceRef.current = bal;
    setBalance((prev) => (prev && balancesEqual(prev, bal) ? prev : bal));
    // Dispatched, never awaited by this function. history() was already
    // requested above so this queues behind it, and the receive watchers act
    // on what this function returns, so awaiting an informational note here
    // would put a whole extra round-trip in front of both the history render
    // and payment detection. Requested only when there is actually a round,
    // so an idle wallet adds no call to the ~4s cycle, and best-effort: a
    // failure must never take balance/history down with it, it just leaves
    // whatever split was last shown.
    // Beta, refresh engine live: once the server issues a refresh's round,
    // bark holds its inputs, so they are out of the headline and
    // pendingInRoundSats (the round's outputs) is exactly the "+" amount. One
    // number from this same balance() read, no second query, and only once
    // the engine has seen bark hold every batch: a participation still
    // waiting for its round is inside the headline AND in pendingInRoundSats,
    // and a "+" then would count it twice (the 2026-09-08 lesson).
    // Otherwise pendingRoundInputVtxos() lists only issued rounds' inputs
    // (wallet/roundInputs.ts), so a waiting participation's coins are simply
    // not in the split: under-reported, never counted twice.
    const engineLive = effectiveEngineMode() === "live";
    void (engineLive
      ? bal.pendingInRoundSats > 0
        ? withTimeout(wallet.pendingRoundStates(), WALLET_CALL_TIMEOUT_MS, t(TIMEOUT_MESSAGE))
            .then((rounds) => {
              // Every pending round ours and locked, or no "+" at all.
              const safe = refreshNoteSafe(engineSnapshot().state, rounds);
              setRefreshNoteSafe(safe);
              return safe ? { countedInHeadlineSats: bal.pendingInRoundSats, withheldSats: 0 } : NO_REFRESHING;
            })
            .catch(() => null)
        : (setRefreshNoteSafe(false), Promise.resolve(NO_REFRESHING))
      : bal.pendingInRoundSats > 0
      ? withTimeout(wallet.pendingRoundInputVtxos(), WALLET_CALL_TIMEOUT_MS, t(TIMEOUT_MESSAGE))
          .then((inputs) => splitRefreshingVtxos(inputs))
          .catch(() => null)
      : Promise.resolve(NO_REFRESHING)
    ).then((split) => {
      if (split) setRefreshing((prev) => (refreshingSplitsEqual(prev, split) ? prev : split));
    });
    const hist = await histPromise;
    // wallet.history()'s own ordering isn't documented/guaranteed — a plain
    // .reverse() here silently assumed oldest-first and left the newest
    // movement buried, which meant the receive watchers below (comparing
    // "the newest movement") never actually saw new payments. Sorting by id
    // (a monotonically increasing counter) descending is unambiguous
    // regardless of what order the SDK hands the array back.
    const ordered = hist.slice().sort((a, b) => b.id - a.id);
    const historyChanged = !prevHistoryRef.current || !historiesEqual(prevHistoryRef.current, ordered);
    prevHistoryRef.current = ordered;
    setHistory((prev) => (historiesEqual(prev, ordered) ? prev : ordered));
    setHistoryLoaded(true);
    if (shouldTriggerBackup({ firstLoad, balanceChanged, historyChanged })) onWalletStateChanged?.();
    if (balanceChanged || historyChanged) {
      // Re-reports the soonest VTXO expiry (+ current price, for the nudge
      // copy) whenever it might actually have moved — same "only on a real
      // change" gate as the backup trigger above, not the ~8s poll cadence.
      // Reads ratesRef rather than depending on `rates` state directly — see
      // ratesRef's own comment for why that matters here.
      void refreshPushAuthorization(wallet, ratesRef.current?.usd, exitPushWatchRef.current);
    }
    return { balance: bal, history: ordered };
  }, [wallet, t, onWalletStateChanged]);

  // Holds the in-flight refresh()'s own promise so a call arriving while
  // busyRef is true can await the SAME cycle's real outcome instead of the
  // old behavior of returning undefined immediately — which the manual
  // refresh button surfaced as "sometimes does nothing": the icon still
  // spun (handleManualRefresh doesn't know the difference), but no
  // wallet.* call was ever actually made for that tap.
  const activeRunRef = useRef<Promise<{ balance: Balance; history: Movement[] } | undefined> | null>(null);

  // The refresh engine's persisted state for this wallet (beta), read before
  // the first tick so the balance note and island start from what is true.
  useEffect(() => {
    loadEngineSnapshot(wallet);
    // Every wallet, every mode, V1 included: release refresh-engine locks
    // nothing covers any more (see sweepLocks). Delayed so the first
    // balance/history read isn't queued behind it; best-effort.
    const timer = window.setTimeout(() => {
      void sweepLocks(wallet, sessionEngineMode() === "live").catch((e) => console.warn("engine lock sweep failed", e));
    }, 5_000);
    return () => window.clearTimeout(timer);
  }, [wallet]);

  // Receive detection (toast, balance roll) runs on every fresh read inside a
  // refresh cycle, not only once the whole cycle ends: maintenance and the
  // engine tick after the read can take seconds, and the history row is
  // already on screen by then. Set to checkPendingReceive below; idempotent.
  const onFreshReadRef = useRef<(r: { balance: Balance; history: Movement[] }) => void>(() => {});

  const refresh = useCallback(() => {
    if (busyRef.current && activeRunRef.current) return activeRunRef.current;
    // Offline: don't queue a call that would only hang in the worker until
    // the network is back. The "online" handler below refreshes at once.
    if (isOffline()) return Promise.resolve(undefined);
    const run = (async (): Promise<{ balance: Balance; history: Movement[] } | undefined> => {
      busyRef.current = true;
      setLoadError(null);
      setLoadErrorDetail(null);
      // This cycle fires every RECEIVE_WATCH_INTERVAL_MS for the entire
      // lifetime of an unlocked session, queued in the same worker FIFO as
      // everything else (bark.ts). Its own 20s UI-level withTimeout below is
      // just how fast the UI gives up waiting — it does nothing about the
      // *worker-level* request watchdog, which starts counting from the
      // moment this call is sent, not from when the worker actually starts
      // processing it. onchainWallet.sync() elsewhere can legitimately run
      // for a while — long enough that this routine, otherwise-fast call
      // ends up merely queued behind it for
      // longer than the watchdog's default 25s, tripping it and tearing
      // down the *whole* worker (forcing every screen back to "unlock",
      // independent of the auto-lock setting) even though nothing was
      // actually stuck. Widening the watchdog here, like every other
      // sync()-adjacent call site in this app, fixes that.
      const popWatchdog = pushWorkerWatchdogOverride(ONCHAIN_SYNC_TIMEOUT_MS);
      let result: { balance: Balance; history: Movement[] } | undefined;
      try {
        await withTimeout(wallet.sync(), WALLET_CALL_TIMEOUT_MS, t(TIMEOUT_MESSAGE));
        result = await fetchBalanceAndHistory();
        loadErrorSinceRef.current = null;
        onFreshReadRef.current(result);
      } catch (e) {
        reportLoadError(e);
      }
      try {
        // Picks up mailbox deliveries (incoming Arkoor/Lightning receives)
        // and settles pending rounds — without this, freshly received funds
        // don't show up even after sync(). Ark round participation can take
        // a while by protocol design (and opens a streamed connection some
        // browsers can't sustain), so this runs after balance/history are
        // already shown instead of blocking the initial display on it.
        //
        // The delegated (non-blocking) variant, for everyone since 2026-09-25
        // (V2 beta since 2026-09-18). The interactive maintenance() waits for
        // the next ~hourly round whenever a VTXO is due for refresh, and
        // maintenanceWithDeadline()'s 60s ceiling then terminated the worker
        // and sent the user back to the unlock screen: exactly what someone
        // opening the app from the expiry push got, on every unlock, until a
        // round happened to start inside that minute. The delegated call
        // schedules the refresh and returns; the next sync() after the round
        // claims it. See scheduleMaintenanceDelegated() in bark.ts and
        // delegatedMaintenance.ts for the gate against re-submitting.
        //
        // isMaintenanceSuppressed() is a manual, sticky Settings toggle
        // (added live 2026-09-15 against a real Ark round-coordinator stall)
        // that skips this call entirely; sync() above already covers the bulk
        // of what a live refresh needs. Also skipped while a tap-to-pay
        // payment is in progress, so the send and the receiver's balance
        // checks never queue behind it (see paymentPriority.ts).
        //
        // Beta: with the refresh engine "live" (src/lib/refreshEngine) this
        // SDK path doesn't run at all; the engine below replaces it. In
        // "dry-run" both run and the engine only logs.
        const engineMode = effectiveEngineMode();
        if (engineMode !== "live" && !isMaintenanceSuppressed() && !isPaymentPriority()) {
          await withTimeout(scheduleMaintenanceDelegated(wallet), WALLET_CALL_TIMEOUT_MS, t(TIMEOUT_MESSAGE));
          // maintenance() is what actually pulls a mailbox delivery in — the
          // balance/history fetched above predate it, so an out-of-round
          // Arkoor or Lightning receive that just landed wouldn't be visible
          // in `result` yet (the receive watchers rely on `result` reflecting
          // this call's outcome, not next cycle's). Re-fetch after it succeeds.
          result = await fetchBalanceAndHistory();
          loadErrorSinceRef.current = null;
          onFreshReadRef.current(result);
        }
        if (engineMode === "off" && !isPaymentPriority()) {
          // A batch a live session left behind: release its coins once the
          // round is over, without waiting for a relock. No-op otherwise.
          await sweepLocks(wallet, false, { onlyIfTracking: true }).catch(() => {});
        }
        if (engineMode !== "off" && !isPaymentPriority()) {
          // Throttled inside to once a minute; never throws (a failed tick
          // is logged by the engine itself, see Settings → Automatická obnova).
          const ran = await maybeRunEngine(wallet, engineMode === "live" ? "auto" : "dry-run").catch(() => null);
          // A submit, lock or completion changes balance/history (locked
          // coins leave the headline, a Refresh movement appears).
          if (ran && ran.events.some((e) => ENGINE_STATE_CHANGING.has(e.kind))) {
            result = await fetchBalanceAndHistory();
            onFreshReadRef.current(result);
            void reportExpiryIfMoved(wallet, ratesRef.current?.usd, exitPushWatchRef.current, { force: true });
          }
        }
        // A finished refresh moves the soonest expiry without moving the
        // balance, so the balance/history gate above would never report it.
        void reportExpiryIfMoved(wallet, ratesRef.current?.usd, exitPushWatchRef.current);
      } catch (e) {
        reportLoadError(e);
      } finally {
        busyRef.current = false;
        activeRunRef.current = null;
        popWatchdog();
      }
      return result;
    })();
    activeRunRef.current = run;
    return run;
  }, [wallet, fetchBalanceAndHistory, t, reportLoadError]);

  // The receive watchers below fire refresh() (sync+maintenance, real
  // network round-trips) every RECEIVE_WATCH_INTERVAL_MS regardless of which
  // view is open (see this file's header comment). The worker only runs one
  // wallet.* call at a time (FIFO queue, see bark.ts), so any other wallet
  // call issued while a refresh() cycle is in flight — e.g. Settings'
  // VtxoList calling wallet.allVtxos() — sits behind it. On a slow mobile
  // connection each refresh() round-trip can take seconds rather than the
  // near-instant case on a fast desktop connection, so that queueing shows
  // up as real, noticeable latency there. Waiting for the current cycle to
  // finish before issuing a fresh call doesn't remove the queueing (a
  // refresh() can still land first either way), but it does stop a caller
  // from being queued *behind two* — its own call plus a refresh() that was
  // already in flight when it asked.
  const waitForIdleRefresh = useCallback(async (): Promise<void> => {
    if (busyRef.current && activeRunRef.current) {
      await activeRunRef.current.catch(() => undefined);
    }
  }, []);

  // When the fresh gift-claim recipient taps "Přijmout dárek" (the overlay
  // closes), pull the balance right away so the just-claimed amount shows
  // immediately instead of on the next ~4s poll.
  const wasGiftClaimActiveRef = useRef(giftClaimActive);
  useEffect(() => {
    if (wasGiftClaimActiveRef.current && !giftClaimActive && hideBalanceForGiftReveal) {
      void refresh();
      // The claim set the "needs backup" flag *after* this Dashboard
      // mounted, so re-read it now — this is also the moment the banner is
      // meant to slide in (it animates on mount, gated below on
      // !giftRevealHold).
      setShowSeedBackupBanner(needsSeedBackup());
      // The headline just jumped from the held 0 to displayBalance's real
      // value in the render that just committed (giftRevealHold's own
      // guard inside bumpBalance() is what kept this from firing any
      // earlier). RollingDigits already held its own `shownText` back at
      // "0" through that render since `animate` wasn't armed yet — this is
      // what actually reveals the real number, right as the modal closes
      // onto the homepage, instead of it sitting there already-updated.
      requestBalanceBump();
    }
    wasGiftClaimActiveRef.current = giftClaimActive;
  }, [giftClaimActive, hideBalanceForGiftReveal, refresh, requestBalanceBump]);

  // Resolves a pending Lightning/Ark receive against a fresh refresh()
  // result — the same match logic the watch loops below run on their own
  // schedule, factored out so the visibilitychange handler just below can
  // also call it directly. Needed because a backgrounded tab's timers are
  // throttled or suspended (see that comment), so leaving the app to pay an
  // invoice from another wallet/app and coming back used to require waiting
  // out however much of the watch loop's stalled cycle was left — this
  // resolves it the instant the tab is visible again instead.
  // Read from a ref, not inside a state updater: the toast, the roll and the
  // stored movement id must happen once, and an updater may be replayed or
  // discarded. The ref moves to the new value at once, so a second caller
  // (the watch tick awaiting the same refresh) sees the payment as settled;
  // the layout effect below keeps it equal to the committed state.
  const pendingReceiveRef = useRef<PendingReceive | null>(null);
  useLayoutEffect(() => {
    pendingReceiveRef.current = pendingReceive;
  }, [pendingReceive]);

  const checkPendingReceive = useCallback(
    (result: { balance: Balance; history: Movement[] } | undefined) => {
      const current = pendingReceiveRef.current;
      if (!result || !current) return;
      if (current.kind === "lightning") {
        if (current.status !== "waiting") return;
        const match = result.history.find((m) => m.paymentHash === current.invoice.paymentHash);
        if (!match || match.effectiveBalanceSats <= 0) return;
        const paid: PendingReceive = { ...current, status: "paid" };
        pendingReceiveRef.current = paid;
        setPendingReceive(paid);
        showToast(
          tf(t("Faktura zaplacena: +{amount} sats"), {
            amount: current.invoice.amountSats.toLocaleString(localeFor(lang)),
          }),
          "success",
          { title: t("Faktura zaplacena"), amountSats: current.invoice.amountSats, direction: "in" },
        );
        requestBalanceBump(headlineSats(result.balance));
        return;
      }
      // Newest incoming movement not seen yet, not history[0]: a refresh
      // created in the same cycle must not hide a payment (refreshHistory.ts).
      const newest = newestUnseenIncoming(result.history, current.lastSeenMovementId);
      if (!newest) return;
      pendingReceiveRef.current = null;
      setPendingReceive(null);
      setPersistedLastSeenMovementId(newest.id);
      if (!isBumpReceiving()) {
        showToast(
          tf(t("Platba přijata: +{amount} sats"), {
            amount: newest.effectiveBalanceSats.toLocaleString(localeFor(lang)),
          }),
          "success",
          { title: t("Platba přijata"), amountSats: newest.effectiveBalanceSats, direction: "in" },
        );
      }
      requestBalanceBump(headlineSats(result.balance));
    },
    [showToast, requestBalanceBump, t, lang],
  );

  useLayoutEffect(() => {
    onFreshReadRef.current = checkPendingReceive;
  }, [checkPendingReceive]);

  // Backgrounded tabs get their timers throttled hard by the browser (often
  // to roughly once a minute, sometimes suspended outright), so the 8s
  // background-watch cycle below effectively stalls while the app is out of
  // view. Failures that piled up during that stall keep `loadErrorSinceRef`
  // pinned to a timestamp from minutes ago, so the very next tick after
  // coming back computes an elapsed time that's already well past
  // OFFLINE_THRESHOLD_MS and shows "Nejsi online." immediately — even though
  // nothing has actually been attempted with the tab in the foreground yet.
  // Reset the streak the moment the tab becomes visible again, so the user
  // gets an honest, current read instead of a stale verdict from while they
  // weren't looking. The network/worker also often need a beat to actually
  // reconnect right after waking up, so this fires one quick retry (+4s)
  // instead of waiting out the normal 8s cadence — combined with
  // LOAD_ERROR_GRACE_MS above, this gives a real reconnect a fair chance to
  // land silently before anything shows on screen. Both attempts also feed
  // their result through checkPendingReceive so a payment that arrived while
  // the tab was hidden shows up immediately, not whenever the stalled watch
  // loop's own timer happens to catch up.
  useEffect(() => {
    const onVisible = () => {
      if (document.visibilityState !== "visible") return;
      loadErrorSinceRef.current = null;
      setLoadError(null);
      setLoadErrorDetail(null);
      refresh().then(checkPendingReceive);
      const t1 = window.setTimeout(() => refresh().then(checkPendingReceive), 4_000);
      retryTimersRef.current = [t1];
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      document.removeEventListener("visibilitychange", onVisible);
      retryTimersRef.current.forEach(window.clearTimeout);
    };
  }, [refresh, checkPendingReceive]);

  // A payment push reached the service worker while this window is in the
  // foreground (public/sw.js): read now instead of at the next poll. A cycle
  // already in flight may have started before the payment landed, so wait for
  // it and run a fresh one rather than joining its (older) result.
  useEffect(() => {
    let live = true;
    const onMessage = (e: MessageEvent) => {
      if ((e.data as { type?: unknown } | null)?.type !== "spendrr-payment-hint") return;
      void (async () => {
        await waitForIdleRefresh();
        if (!live) return;
        checkPendingReceive(await refresh());
      })();
    };
    navigator.serviceWorker?.addEventListener("message", onMessage);
    return () => {
      live = false;
      navigator.serviceWorker?.removeEventListener("message", onMessage);
    };
  }, [refresh, checkPendingReceive, waitForIdleRefresh]);

  const balanceKnown = balance !== null;
  // The first on-chain poll waits for the balance (or a fallback timer), so it
  // doesn't queue ahead of the first balance read.
  const [onchainPollReady, setOnchainPollReady] = useState(false);
  useEffect(() => {
    if (onchainPollReady) return;
    if (balanceKnown) {
      setOnchainPollReady(true);
      return;
    }
    const id = window.setTimeout(() => setOnchainPollReady(true), ONCHAIN_FIRST_POLL_FALLBACK_MS);
    return () => window.clearTimeout(id);
  }, [balanceKnown, onchainPollReady]);

  // Independent of refresh()/busyRef above — this goes through the same
  // worker queue (see wallet.worker.ts), so it's still serialized against
  // every Ark call, just not gated by the same "skip if a cycle is already
  // running" flag, since it's cheap and runs far less often anyway.
  useEffect(() => {
    if (!onchainPollReady) return;
    let cancelled = false;
    // sync() checks every locally revealed onchain address every time and
    // can occasionally take longer than the 30s poll interval below.
    // Without this guard, an overlapping poll would pile another
    // concurrent sync() onto the same worker queue on top of one still
    // running.
    let pollBusy = false;
    const poll = async () => {
      // A tap-to-pay payment is in progress: stay out of the worker queue
      // (see paymentPriority.ts). The next tick after it catches up.
      if (pollBusy || isPaymentPriority() || isOffline()) return;
      pollBusy = true;
      // Widens the 25s worker crash-recovery watchdog for this call too
      // (see pushWorkerWatchdogOverride's comment in bark.ts) — without it,
      // a sync() that occasionally runs long would trip that watchdog and
      // force a re-unlock, even though nothing was actually stuck.
      const popWatchdog = pushWorkerWatchdogOverride(ONCHAIN_SYNC_TIMEOUT_MS);
      // This sync() has its own generous ONCHAIN_SYNC_TIMEOUT_MS ceiling
      // (see withTimeout below) so it never shows an error itself — but
      // while it legitimately runs long, the Ark receive-watch's refresh()
      // cycle (every ~4s, sharing the same single FIFO worker queue) queues
      // behind it and can trip *its* much shorter timeout purely from
      // waiting — see isOnchainScanActive's own comment in bark.ts. Flagging
      // this call lets reportLoadError recognize that as an expected side
      // effect of this poll rather than a real problem.
      const popScanActive = pushOnchainScanActive();
      try {
        // sync() first — balance() alone just reads whatever was last
        // synced, so a payment confirming on-chain never showed up here
        // without this (see OnchainWalletClient.sync() doc comment).
        await withTimeout(wallet.onchainWallet.sync(), ONCHAIN_SYNC_TIMEOUT_MS, t(TIMEOUT_MESSAGE));
        const bal = await withTimeout(wallet.onchainWallet.balance(), WALLET_CALL_TIMEOUT_MS, t(TIMEOUT_MESSAGE));
        if (!cancelled) setOnchainBalance(bal);
        // Rotate the cached receive address once it's actually been paid to
        // (see onchainReceiveAddress.ts) — only checked while one is
        // currently handed out, so a session that never opens the Onchain
        // tab never pays for the extra utxos() round trip.
        if (!cancelled && onchainAddress) {
          const utxos = await withTimeout(wallet.onchainWallet.utxos(), WALLET_CALL_TIMEOUT_MS, t(TIMEOUT_MESSAGE));
          if (!cancelled) {
            const { rotate, baseline } = evaluateReceiveAddressUsage(utxos, onchainReceiveBaselineRef.current);
            if (rotate) {
              onchainReceiveBaselineRef.current = [];
              clearStoredReceiveAddress();
              setOnchainAddress(null);
            } else {
              onchainReceiveBaselineRef.current = baseline;
              saveReceiveAddress(onchainAddress, baseline);
            }
          }
        }
      } catch {
        // Best-effort — the next poll will pick it up. Onchain funds aren't
        // time-sensitive the way an Ark/Lightning receive watch is, so this
        // doesn't need the same reportLoadError() treatment refresh() gets.
      } finally {
        pollBusy = false;
        popWatchdog();
        popScanActive();
      }
    };
    poll();
    const interval = window.setInterval(poll, ONCHAIN_BALANCE_POLL_MS);
    return () => {
      cancelled = true;
      window.clearInterval(interval);
    };
  }, [wallet, t, onchainAddress, onchainPollReady]);

  // Keeps the background push watch alive while notifications are enabled —
  // an authorization lasts PUSH_AUTH_LIFETIME_S (see notifications.ts), so this
  // needs to be re-sent periodically. Piggybacks on Dashboard's mount (i.e.
  // every unlock) rather than its own timer, same "re-check on a natural
  // opportunity" pattern as the exit-vtxos check above. Best-effort by
  // design (see refreshPushAuthorization) — never blocks or errors visibly.
  useEffect(() => {
    // ratesRef, not the `rates` state directly — `rates` is still null at
    // this exact point on almost every mount (the price fetch is a separate
    // async effect that hasn't resolved yet), so reading it here made the
    // very first subscribe of every session always omit the price baseline.
    void refreshPushAuthorization(wallet, ratesRef.current?.usd, exitPushWatchRef.current);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- only re-fire on a new wallet, not every rates refetch
  }, [wallet]);

  // Only called from inside the confirm dialog's own button — boarding never
  // starts on its own just because onchain funds were noticed. On success,
  // re-runs both the Ark refresh() and an immediate onchain balance poll so
  // the sticky notification clears and the boarded amount shows up in the
  // regular balance, instead of waiting for either's next scheduled tick.
  // Also clears onchainAddress so ReceiveScreen's tab-open effect fetches a
  // fresh receive address next time — this one has already received funds
  // and been boarded, no reason to hand it out again.
  const confirmBoard = useCallback(async () => {
    // Defence in depth behind the suppressed button above: an exit can start
    // (or a poll can first notice one) while this dialog is already open, and
    // boardAll() would then sweep the exit's on-chain fee budget into Ark and
    // strand it.
    if (exitNeedsOnchainFees) {
      setBoardError(t("Probíhá nouzový exit — tyhle on-chain sats se drží na jeho poplatky a nejde je teď přesunout."));
      return false;
    }
    setBoarding(true);
    setBoardError(null);
    // See SEND_WATCHDOG_MS's own comment (walletCall.ts) — boardAll() can
    // legitimately mean waiting on Ark round participation, easily longer
    // than bark.ts's 25s crash-recovery default.
    const popWatchdog = pushWorkerWatchdogOverride(SEND_WATCHDOG_MS);
    try {
      await withTimeout(wallet.boardAll(), WALLET_CALL_TIMEOUT_MS, t(TIMEOUT_MESSAGE));
    } catch (e) {
      const raw = e instanceof Error ? e.message : String(e);
      const { message, minSats } = translateBoardError(raw, t, lang);
      surfaceError(e, setBoardError, message);
      if (minSats !== null) setBoardMinSats(minSats);
      return false;
    } finally {
      setBoarding(false);
      popWatchdog();
    }
    onchainReceiveBaselineRef.current = [];
    clearStoredReceiveAddress();
    setOnchainAddress(null);
    // The money moved: BoardSheet closes on `true` right away, the balances
    // catch up behind it (the old modal also closed before this refresh).
    void (async () => {
      try {
        const arkResult = await refresh();
        const bal = await withTimeout(wallet.onchainWallet.balance(), WALLET_CALL_TIMEOUT_MS, t(TIMEOUT_MESSAGE));
        setOnchainBalance(bal);
        showToast(t("Prostředky přesunuty do Ark"));
        requestBalanceBump(arkResult ? headlineSats(arkResult.balance) : undefined);
      } catch (e) {
        console.warn("refresh after board failed", e);
      }
    })();
    return true;
  }, [wallet, t, lang, refresh, showToast, requestBalanceBump, exitNeedsOnchainFees]);

  // Offline/online transitions (and, beta, Ark server down/back). Going bad
  // drops any "Počkej chvíli…" streak: those calls failed because of the
  // outage the island is already naming. Coming back refreshes at once
  // instead of waiting for the next poll tick, and shows "Jsi zase online"
  // (or "Server zase odpovídá") until it has had a moment.
  const refreshRef = useRef(refresh);
  refreshRef.current = refresh;
  const netTimersRef = useRef<number[]>([]);
  useEffect(() => {
    netTimersRef.current.forEach((id) => window.clearTimeout(id));
    netTimersRef.current = [];
    loadErrorSinceRef.current = null;
    if (net !== "online") {
      wasBadNetRef.current = net;
      setLoadError(null);
      setLoadErrorDetail(null);
      setNetIsland({ kind: net, closing: false });
      return;
    }
    const was = wasBadNetRef.current;
    if (!was) return;
    wasBadNetRef.current = null;
    const kind = was === "arkDown" ? "backArk" : "back";
    setNetIsland({ kind, closing: false });
    void refreshRef.current();
    netTimersRef.current = [
      window.setTimeout(() => setNetIsland({ kind, closing: true }), NET_BACK_ONLINE_MS),
      window.setTimeout(() => setNetIsland(null), NET_BACK_ONLINE_MS + TOAST_EXIT_MS),
    ];
  }, [net]);
  useEffect(() => () => netTimersRef.current.forEach((id) => window.clearTimeout(id)), []);

  // Watches a Lightning invoice created via Receive while it's "waiting", and
  // an Ark receive address for a newly-arrived incoming movement — both keep
  // running as long as the Dashboard is mounted, independent of which `view`
  // is currently shown, so switching to Send/History/Home and back no longer
  // loses track of an in-progress receive.
  useEffect(() => {
    if (!pendingReceive || pendingReceive.kind !== "lightning" || pendingReceive.status !== "waiting") return;
    let cancelled = false;
    let timer: number | null = null;
    // isInvoicePaid() alone never reflected a real payment no matter how
    // long it was polled — like the Ark mailbox, this apparently needs
    // maintenance() to have actually run first to pull the settlement in
    // locally. So this drives off the same refresh() as the Ark watch and
    // looks for a completed movement carrying this invoice's payment hash,
    // rather than trusting isInvoicePaid() on its own.
    // No busyRef pre-check here — call refresh() unconditionally. It
    // already returns the SAME shared promise when a cycle is in flight
    // (see its own reentrancy guard), so this just joins whatever's
    // already running instead of missing it. The old code checked busyRef
    // itself and, if true, waited RETRY_WHILE_BUSY_MS before trying again
    // — meaning if that in-flight cycle finished moments after the check,
    // this tick sat idle for up to that whole interval and then kicked off
    // an entirely NEW refresh() cycle (another full sync()+maintenance()
    // round trip) just to re-check, even though the balance/history it
    // needed had already landed. That's what made the animated reveal lag
    // several seconds behind the balance/history actually updating live.
    let consecutiveFailures = 0;
    const tick = async () => {
      if (cancelled) return;
      const result = await refresh();
      if (cancelled) return;
      if (result) {
        consecutiveFailures = 0;
        // The same check refresh() already ran on its fresh reads: it settles
        // against the latest state, so a payment found there is not announced
        // a second time here.
        checkPendingReceive(result);
      } else {
        consecutiveFailures++;
      }
      if (!cancelled) {
        const delay = result
          ? RECEIVE_WATCH_INTERVAL_MS
          : RECEIVE_WATCH_BACKOFF_DELAYS_MS[Math.min(consecutiveFailures - 1, RECEIVE_WATCH_BACKOFF_DELAYS_MS.length - 1)];
        timer = window.setTimeout(tick, delay);
      }
    };
    timer = window.setTimeout(tick, 0);
    return () => {
      cancelled = true;
      if (timer !== null) window.clearTimeout(timer);
    };
  }, [pendingReceive, refresh, checkPendingReceive]);

  useEffect(() => {
    if (!pendingReceive || pendingReceive.kind !== "ark") return;
    let cancelled = false;
    let timer: number | null = null;
    // No busyRef pre-check — see the Lightning watch's tick() comment just
    // above for why calling refresh() unconditionally (it joins an
    // already-in-flight cycle via its own reentrancy guard) is what keeps
    // this from lagging behind a refresh() that finished moments earlier.
    let consecutiveFailures = 0;
    const tick = async () => {
      if (cancelled) return;
      const result = await refresh();
      if (cancelled) return;
      if (result) {
        consecutiveFailures = 0;
        checkPendingReceive(result);
      } else {
        consecutiveFailures++;
      }
      if (!cancelled) {
        const delay = result
          ? RECEIVE_WATCH_INTERVAL_MS
          : RECEIVE_WATCH_BACKOFF_DELAYS_MS[Math.min(consecutiveFailures - 1, RECEIVE_WATCH_BACKOFF_DELAYS_MS.length - 1)];
        timer = window.setTimeout(tick, delay);
      }
    };
    timer = window.setTimeout(tick, 0);
    return () => {
      cancelled = true;
      if (timer !== null) window.clearTimeout(timer);
    };
  }, [pendingReceive, refresh, checkPendingReceive]);

  const startArkWatch = useCallback(() => {
    if (!address) return;
    setPendingReceive((current) => {
      // Must not clobber an active Lightning invoice watch — this now runs
      // automatically as soon as an address exists, not just while the user
      // is looking at the Receive screen.
      if (current && current.kind === "lightning") return current;
      const persisted = getPersistedLastSeenMovementId();
      const newest = persisted !== null ? newestUnseenIncoming(history, persisted) : undefined;
      // A payment already sitting in history that's newer than what we last
      // persisted arrived while the app was closed — surface it right away
      // instead of quietly adopting it as the new baseline. `persisted` is
      // null only on a wallet's very first ever watch start, when there's
      // nothing to compare against yet.
      if (newest) {
        showToast(
          tf(t("Platba přijata: +{amount} sats"), {
            amount: newest.effectiveBalanceSats.toLocaleString(localeFor(lang)),
          }),
          "success",
          { title: t("Platba přijata"), amountSats: newest.effectiveBalanceSats, direction: "in" },
        );
        requestBalanceBump();
      }
      const seen = highestMovementId(history, null);
      if (seen !== null) setPersistedLastSeenMovementId(seen);
      return { kind: "ark", address, lastSeenMovementId: seen };
    });
  }, [address, history, showToast, requestBalanceBump, t, lang]);

  // Monitors the user's own Ark address for an incoming payment as soon as
  // it's known, independent of whether the Receive screen has ever been
  // opened this session — a wallet should notice money arriving while you're
  // sitting on Home, not only while you're staring at the receive address.
  // Not before the first history read: the watch takes the newest movement
  // as its baseline, and started over an empty list it has none, so the
  // first refresh announced the last payment as new ("Platba přijata") on
  // every reload. Only reachable since the beta reads the address during
  // the open, i.e. before history; it used to arrive after it.
  useEffect(() => {
    if (!address || !historyLoaded || pendingReceive?.kind === "ark") return;
    startArkWatch();
  }, [address, historyLoaded, pendingReceive, startArkWatch]);

  const startLightningWatch = useCallback((invoice: LightningInvoice) => {
    setPendingReceive({ kind: "lightning", invoice, status: "waiting" });
  }, []);

  const cancelLightningWatch = useCallback(() => {
    if (pendingReceive?.kind === "lightning" && pendingReceive.status === "waiting") {
      wallet.cancelLightningReceive(pendingReceive.invoice.paymentHash).catch(() => {});
    }
    setPendingReceive(null);
  }, [wallet, pendingReceive]);

  // Motion design: a payment that lands while its QR is on screen dissolves
  // the QR and takes you home, where the balance and the new row show it
  // (the island toast has already said so). Ark: the watch resets to null on
  // a receipt, and nothing else nulls an Ark watch. Lightning: waiting ->
  // paid for the invoice on screen.
  const [receiveDissolving, setReceiveDissolving] = useState(false);
  const prevPendingReceiveRef = useRef(pendingReceive);
  useEffect(() => {
    const prev = prevPendingReceiveRef.current;
    prevPendingReceiveRef.current = pendingReceive;
    if (!motionOn || view !== "receive") return;
    // A payment to the Lightning address lands as an Ark payment, so "ln"
    // dissolves on the Ark watch too.
    const arkArrived = (receiveMode === "ark" || receiveMode === "ln") && prev?.kind === "ark" && pendingReceive === null;
    const invoicePaid =
      receiveMode === "lightning" &&
      prev?.kind === "lightning" &&
      prev.status === "waiting" &&
      pendingReceive?.kind === "lightning" &&
      pendingReceive.status === "paid";
    if (arkArrived || invoicePaid) setReceiveDissolving(true);
  }, [pendingReceive, motionOn, view, receiveMode]);
  // v2 receive opens on the Lightning address every time; a hidden format
  // picked once must not stick. An invoice still waiting to be paid keeps
  // its screen.
  useEffect(() => {
    if (view === "receive") return;
    const invoiceWaiting = pendingReceive?.kind === "lightning" && pendingReceive.status === "waiting";
    setReceiveMode(invoiceWaiting ? "lightning" : "ln");
  }, [view, pendingReceive]);

  // The name and whether its Lightning address is on: from the profile's own
  // cache (nameTouch.ts), so opening Receive costs no request. Read again
  // when the profile sheet closes, which is where it changes. A browser that
  // knows there is a name but has no cached record asks once.
  const [myName, setMyName] = useState<CachedName | null>(null);
  useEffect(() => {
    if (view !== "receive" || profileOpen || !address) return;
    const cached = getCachedName(address);
    setMyName(cached);
    if (cached || !hasHandleFlag()) return;
    let cancelled = false;
    fetchMyName(wallet)
      .then((mine) => {
        if (cancelled || !mine) return;
        const record = { name: mine.name, address: mine.address, lnAddress: mine.lnAddress };
        setCachedName(address, record);
        setMyName(record);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [view, profileOpen, address, wallet]);

  const [lnServiceOk, setLnServiceOk] = useState(lastLnAddressServiceOk);
  const myLnAddressOn = myName?.lnAddress === true;
  useEffect(() => {
    if (view !== "receive" || !myLnAddressOn) return;
    let cancelled = false;
    void lnAddressServiceOk().then((ok) => {
      if (!cancelled) setLnServiceOk(ok);
    });
    return () => {
      cancelled = true;
    };
  }, [view, myLnAddressOn]);

  useEffect(() => {
    if (!receiveDissolving) return;
    if (view !== "receive") {
      setReceiveDissolving(false);
      return;
    }
    const timer = window.setTimeout(() => {
      setReceiveDissolving(false);
      navigate("home");
    }, 900);
    return () => window.clearTimeout(timer);
  }, [receiveDissolving, view, navigate]);

  useEffect(() => {
    let cancelled = false;
    let retryTimer: number | null = null;
    let refreshRetryTimer: number | null = null;

    // Split out from the one-shot initial load below: this used to run
    // exactly once per unlock session with no retry at all, so a single
    // unlucky failure (a slow/queued peekAddress()/newAddress() right at
    // startup, when this effect, the initial refresh(), and the onchain
    // balance poll's first tick are all competing for the same worker
    // queue) left the Ark receive address permanently unavailable for the
    // rest of the session — Přijmout just showed "Generuji adresu…" forever
    // — even though everything else recovers fine because it's on its own
    // recurring schedule (the 8s Ark refresh, the 30s onchain poll). This
    // loops with backoff instead, so a transient failure here behaves the
    // same as everywhere else in the app: it heals itself.
    const RETRY_DELAYS_MS = [5_000, 10_000, 20_000, 30_000, 60_000];
    const loadAddress = async (attempt: number) => {
      if (cancelled) return;
      try {
        let addr: string;
        // See SEND_WATCHDOG_MS's own comment (walletCall.ts) — widened so a
        // call that's merely queued behind something else (e.g. the onchain
        // balance poll's own sync(), which can legitimately run long — both
        // that poll and this effect fire at mount, competing for the same
        // worker) doesn't trip the crash-recovery watchdog. Kept well under
        // that ceiling here, though: on a genuine, repeatable failure (not
        // just one unlucky race at startup), retrying every 30s beats
        // waiting out one multi-minute attempt before even trying again.
        const ADDRESS_ATTEMPT_TIMEOUT_MS = 30_000;
        const popWatchdog = pushWorkerWatchdogOverride(SEND_WATCHDOG_MS);
        try {
          // peekAddress only previews an already-derived key; a brand new
          // wallet has never derived index 0, so fall back to newAddress()
          // (which derives it) the first time.
          addr = await withTimeout(wallet.peekAddress(0), ADDRESS_ATTEMPT_TIMEOUT_MS, t(TIMEOUT_MESSAGE));
        } catch (peekErr) {
          // A timeout is a busy queue, not a missing index: newAddress() would
          // burn a key index (STOP_GAP) on every slow unlock. The outer catch
          // retries with backoff.
          if (isWalletCallTimeout(peekErr)) throw peekErr;
          addr = await withTimeout(wallet.newAddress(), ADDRESS_ATTEMPT_TIMEOUT_MS, t(TIMEOUT_MESSAGE));
        } finally {
          popWatchdog();
        }
        if (cancelled) return;
        setAddress(addr);
        setAddressError(null);
      } catch (e) {
        if (cancelled) return;
        setAddressError(rawErrorMessage(e));
        const delay = RETRY_DELAYS_MS[Math.min(attempt, RETRY_DELAYS_MS.length - 1)];
        retryTimer = window.setTimeout(() => void loadAddress(attempt + 1), delay);
      }
    };

    // Mirrors loadAddress's own backoff retry, for the identical reason —
    // refresh() used to run exactly once at mount with nothing retrying it
    // if that one attempt failed outright (a transient network blip right
    // after unlock, e.g. a "TypeError: Failed to fetch" — a real request
    // that reached the browser's fetch layer and failed there, not our own
    // network-allowlist guard, which rejects with a different message).
    // reportLoadError only tracks the failure streak for the UI message; it
    // never itself retries. Without this, the only things that could ever
    // trigger another attempt were a manual reload, switching
    // tabs away and back (visibilitychange), or a pendingReceive watch that
    // isn't even running yet right after a plain unlock — so a transient
    // failure right here could leave balance/history stuck indefinitely
    // even on a perfectly fine connection, with nothing in the app ever
    // trying again on its own. `result === undefined` is refresh()'s own
    // signal that this cycle made zero progress (see its own comment: a
    // partial success — sync() worked but maintenance() didn't, or vice
    // versa — still returns a defined result), so only retry on a total
    // miss, not a partial one already reflected on screen.
    const loadBalance = async (attempt: number) => {
      if (cancelled) return;
      const result = await refresh();
      if (cancelled || result !== undefined) return;
      const delay = RETRY_DELAYS_MS[Math.min(attempt, RETRY_DELAYS_MS.length - 1)];
      refreshRetryTimer = window.setTimeout(() => void loadBalance(attempt + 1), delay);
    };

    void (async () => {
      // Already known from the open (beta): nothing to ask the worker for.
      // Set again here, not only as the initial state, for a wallet swapped
      // under a Dashboard that stays mounted.
      const opened = wallet.openedAddress;
      if (opened) {
        setAddress(opened);
        setAddressError(null);
      }
      // wallet.balance()/history() read whatever's already persisted in
      // IndexedDB from the last session — no network call, unlike sync().
      // Painting that immediately (instead of the skeleton) is free: it's
      // the exact same call refresh() makes anyway, just once before
      // sync() instead of only after. Awaited, not run alongside refresh()
      // below, to respect the no-concurrent-wallet.*-calls rule.
      try {
        await fetchBalanceAndHistory();
      } catch {
        // Best-effort — loadBalance() right below retries with full error
        // handling (reportLoadError, offline/timeout messaging).
      }
      if (cancelled) return;
      // Dispatched *before* loadBalance() below, not after: peekAddress()/
      // newAddress() need no synced data at all (a local/derived-key read),
      // but used to be gated behind refresh()'s full sync()+maintenance()
      // network round-trip — which can legitimately run long — for no
      // reason, making "Přijmout" wait on a cycle it doesn't depend on.
      // wallet.worker.ts's queue is strict FIFO, so calling this first (its
      // request goes out synchronously, before refresh()'s own sync() call
      // below even gets dispatched) guarantees it's actually served first,
      // however long refresh() ends up taking. Not awaited here — it
      // retries on its own (see loadAddress above).
      if (!opened) void loadAddress(0);
      await loadBalance(0);
    })();
    return () => {
      cancelled = true;
      if (refreshRetryTimer !== null) window.clearTimeout(refreshRetryTimer);
      if (retryTimer !== null) window.clearTimeout(retryTimer);
    };
  }, [wallet, refresh, fetchBalanceAndHistory, t]);

  useEffect(() => {
    // closeWallet() waits for the worker's own request queue to drain
    // before calling wallet.free() — it doesn't need this effect to track
    // in-flight calls itself the way the pre-worker version did, since the
    // worker already serializes every wallet.* call app-wide (see
    // wallet.worker.ts), not just the ones Dashboard happens to know about.
    return () => {
      closeWallet(wallet);
    };
  }, [wallet]);

  // The truly-spendable-right-now amount. Keep this as spendableSats alone
  // (never add pendingInRoundSats to it) — it feeds SendPanel's max-send
  // and fee-estimate calls below, and a VTXO registered into a refresh
  // round is not selectable for a send until the round finishes.
  const spendable = balance ? balance.spendableSats : undefined;
  const headline = balance ? headlineSats(balance) : undefined;
  headlineRef.current = headline;
  inRoundRef.current = balance ? balance.pendingInRoundSats : 0;
  // Whether the balance headline is actually mounted AND on screen for the
  // user right now — `balance-card` (below) unmounts entirely on the
  // Receive/Settings screens, and `tabVisible` (above) covers the app being
  // backgrounded/the phone locked without ever changing `view`. Read via
  // balanceOnScreenRef by requestBalanceBump (declared earlier, above
  // bumpBalance) so a payment-confirmed call site anywhere in this
  // component always sees the current value, not whatever it was when that
  // particular callback closure was created.
  const balanceOnScreen = view !== "receive" && !showSettings && !showUtility && tabVisible;
  balanceOnScreenRef.current = balanceOnScreen;
  // The moment the user comes back to a screen showing the balance, reveal
  // whatever payment requestBalanceBump held back while they couldn't see
  // it (bumpBalance's own 900ms bump window from whenever it originally
  // fired is long since irrelevant — this arms a fresh one).
  useEffect(() => {
    if (balanceOnScreen && pendingBumpRef.current) bumpBalance();
  }, [balanceOnScreen, bumpBalance]);
  // What RollingDigits is actually shown. A genuinely quiet, non-payment
  // change (no pending bump — e.g. a VTXO-refresh blip) is let through
  // (debounced — see below), on or off screen: there's no roll to protect
  // for it, and holding it back would just be a pointless staleness window.
  // A payment change only ever reaches this via bumpBalance() itself (see
  // its own comment for why that's the only writer), never here directly —
  // except for the very first load (see initialRevealDoneRef below), which
  // is a deliberate exception: it's the one case bumpBalance() can't cover
  // on its own, since there's no in-session "before" value yet to roll from.
  const initialRevealDoneRef = useRef(false);
  // Sat between initialRevealDoneRef's decision and the delayed bump below,
  // for exactly one render — see the effect that sets it for why a plain
  // synchronous bumpBalance() call right there wouldn't work.
  const [coldStartTarget, setColdStartTarget] = useState<number | null>(null);
  // The last `spendable` value this effect has already acted on (via a
  // bump OR a quiet catch-up) — NOT the same thing as revealedSpendable.
  // SendPanel's own immediate post-send estimate (see requestBalanceBump's
  // call sites) sets revealedSpendable *ahead* of `spendable`, which hasn't
  // caught up to the send yet at that point — comparing against
  // revealedSpendable directly (the previous version of this effect) read
  // that gap as "spendable changed, better catch revealedSpendable up" and
  // immediately reverted the just-shown estimate back down to the stale
  // pre-send `spendable`, which then jumped forward again once refresh()
  // actually landed — a visible flicker in the wrong direction, on top of
  // whatever legitimate correction followed. Tracking what's already been
  // *processed*, independent of what's currently on screen, avoids that
  // entirely: this effect only ever reacts to `spendable` reaching a value
  // it hasn't seen before, never to revealedSpendable being provisionally
  // ahead of it.
  const processedHeadlineRef = useRef<number | undefined>(undefined);
  // refresh() itself fetches balance twice in a row (once after sync(),
  // again after maintenance() — see refresh()'s own comment), which can
  // each land as a distinct `spendable` change moments apart. Debouncing
  // the quiet catch-up coalesces those into one visible update instead of
  // two, on top of whatever bump already revealed.
  const quietCatchUpTimerRef = useRef<number | null>(null);
  // The cold-start persisted-balance comparison below used to decide on
  // `spendable`'s very FIRST value — but refresh() sets `spendable` twice
  // (once after sync(), again after maintenance()), and sync() alone
  // doesn't pull in Ark mailbox deliveries. So on a cold open where a
  // payment landed while the app was closed, that first value was almost
  // always still the stale pre-payment balance, identical to what's
  // persisted — the comparison below saw "no change" and never armed a
  // reveal at all, silently falling through to plain assignment. Poll
  // (like the quiet catch-up further down does) until the in-flight
  // refresh() cycle this spendable value came from has actually settled
  // (busyRef clear), THEN decide against the truly-final value.
  const initialRevealTimerRef = useRef<number | null>(null);
  useEffect(() => {
    if (headline === undefined) return;
    if (!initialRevealDoneRef.current) {
      if (initialRevealTimerRef.current !== null) window.clearTimeout(initialRevealTimerRef.current);
      const decide = () => {
        if (busyRef.current) {
          initialRevealTimerRef.current = window.setTimeout(decide, 200);
          return;
        }
        initialRevealTimerRef.current = null;
        initialRevealDoneRef.current = true;
        const settled = headlineRef.current;
        if (settled === undefined) return;
        processedHeadlineRef.current = settled;
        const persisted = getPersistedLastSeenBalance();
        if (persisted !== null && persisted !== settled) {
          // The app was fully closed and reopened with the balance already
          // different — e.g. a payment landed while it was closed. No
          // in-session state survived that to supply an "old" value, so seed
          // one from localStorage: render it now (this commit), then arm the
          // roll toward the real value in the effect below, which only runs
          // after THIS commit has actually painted. Doing both in one effect
          // would batch into a single render with nothing left to animate
          // from — the exact bug RollingDigits' own useLayoutEffect comment
          // already describes for the ordinary in-session case.
          setRevealedSpendable(persisted);
          setColdStartTarget(settled);
          return;
        }
        setRevealedSpendable(settled);
      };
      decide();
      return;
    }
    if (headline === processedHeadlineRef.current) return;
    processedHeadlineRef.current = headline;
    if (pendingBumpRef.current) return;
    if (quietCatchUpTimerRef.current !== null) window.clearTimeout(quietCatchUpTimerRef.current);
    // setBalance() (which is what changed `spendable` to get here) always
    // lands *before* the refresh()/confirmBoard() call that produced it has
    // a chance to decide whether this was actually a payment and call
    // requestBalanceBump — that call only happens once refresh() itself
    // resolves, after maintenance() (a real network round-trip) has also
    // run. A flat 400ms timer used to fire well before that, so this quiet
    // path routinely won the race and silently snapped the number to its
    // new value — with revealedSpendable already at the target, the bump
    // that arrived moments later had nothing left to animate, and no roll
    // (or scale-class change, driven off the same value) ever played. As
    // long as busyRef is true, some refresh() is still in flight and could
    // still turn this into an animated bump, so keep deferring until it
    // clears, then re-check pendingBumpRef one more time (it may have been
    // set true in the meantime) before actually applying the quiet catch-up.
    const tryApply = () => {
      if (busyRef.current) {
        quietCatchUpTimerRef.current = window.setTimeout(tryApply, 400);
        return;
      }
      quietCatchUpTimerRef.current = null;
      if (pendingBumpRef.current) return;
      setRevealedSpendable(headlineRef.current);
    };
    quietCatchUpTimerRef.current = window.setTimeout(tryApply, 400);
  }, [headline]);
  useEffect(() => {
    return () => {
      if (quietCatchUpTimerRef.current !== null) window.clearTimeout(quietCatchUpTimerRef.current);
      if (initialRevealTimerRef.current !== null) window.clearTimeout(initialRevealTimerRef.current);
    };
  }, []);
  useEffect(() => {
    if (coldStartTarget === null) return;
    requestBalanceBump(coldStartTarget);
    setColdStartTarget(null);
  }, [coldStartTarget, requestBalanceBump]);
  // Keeps the persisted "last seen" balance current across the whole
  // session (not just right before closing — there's no reliable
  // beforeunload signal on mobile), so whenever the app next cold-starts,
  // the comparison above is against a genuinely fresh number.
  useEffect(() => {
    if (revealedSpendable !== undefined) setPersistedLastSeenBalance(revealedSpendable);
  }, [revealedSpendable]);
  // Money in a running unilateral exit that hasn't reached the destination
  // yet. From the exit tracker, not balance.pendingExitSats: that one only
  // counts coins whose exit already confirmed, and reads 0 whenever bark's
  // exit lock is busy (try_pending_total). Coins still getting on-chain are
  // locked by the exit (exitLocks.ts), so they are out of the headline too,
  // and this is where they show up.
  const exitingSats = exitOverview.liveSats;
  // Funds registered into a VTXO refresh round (manual, the V2 delegated
  // maintenance, or the SDK daemon opportunistically joining any round it
  // sees start). Neither number is added into the headline below, and one of
  // them must not be: a 2026-09-08 attempt to add `pendingInRoundSats` into
  // it (commit 7cf13f2) produced real doubled-balance reports live.
  //
  // bark 0.8 changed this: pendingInRoundSats now counts only the LOCKED inputs
  // of a round, so it is disjoint from spendable for every round kind (a
  // waiting delegated participation holds no lock and is in spendable only).
  // The headline is headlineSats (spendable + the locked inputs); needsRefresh is a note.
  //
  // For bark 0.7 the doubled headline was blamed on the `allVtxos()`
  // duplication quirk, but the likelier cause was not a quirk at all:
  // `pendingInRoundSats` and `spendable` were only disjoint for an
  // *interactive* round. A delegated
  // participation never locks its inputs, so they stay Spendable and sit in
  // BOTH numbers for the whole wait (see refreshingBalance.ts). Which is
  // also why the note can't just print `pendingInRoundSats`: during a
  // delegated refresh that would announce money the headline is already
  // showing. `refreshing` splits the real participation inputs by their
  // actual VTXO state so each half gets the wording that is true of it.
  const refreshingInHeadlineSats = refreshing.countedInHeadlineSats;
  // The headline number: what SendPanel can actually spend right now.
  // While a fresh gift-link recipient is still on the "Dostal jsi dárek"
  // modal, hold the headline at 0 — otherwise they watch the balance tick
  // up behind the popup and the reveal is spoiled. The real number appears
  // the instant they tap "Přijmout dárek" (giftClaimActive → false).
  const giftRevealHold = hideBalanceForGiftReveal && !!giftClaimActive;
  giftRevealHoldRef.current = giftRevealHold;
  const displayBalance = giftRevealHold ? 0 : revealedSpendable;
  // lock-gesture-area (further down) is a fixed height, not flex:1 —
  // deliberately, see its own comment for the live double-tap bug that
  // caused. But a fixed height meant a short history (few or zero rows)
  // left a dead gap between the history card and it: still swipeable/
  // double-tappable, just visually disconnected from the card it sits
  // under, and the whole point of "fills under the history card" is that
  // there's no dead gap left over. Grown by `history.length`, NOT by
  // measuring live layout/viewport — that's the one axis this can safely
  // vary on. It's stable for the ~300ms between two taps of a double-tap
  // (history only changes on an async refresh landing in that exact
  // window, not on viewport-chrome show/hide, which was the actual
  // documented failure mode), so this can't reintroduce that bug. 64px
  // approximates one .history-item row (34px icon + 14px top/bottom
  // padding + 2px border) — approximate on purpose, since getting it exact
  // would need a live DOM measurement, i.e. exactly the "moves under your
  // finger" risk this is avoiding.
  const missingHistoryRows = RECENT_HISTORY_LIMIT - (giftRevealHold ? 0 : Math.min(history.length, RECENT_HISTORY_LIMIT));
  const lockGestureAreaHeight = 140 + missingHistoryRows * 64;
  // A 6+ digit balance overflows the big balance display's width (it's
  // sized for a comfortable few-digit number, not for scaling down on its
  // own) — step the font size down as the sats balance crosses these
  // thresholds, regardless of whether sats or fiat is the primary display
  // (a large sats balance tends to produce a similarly long fiat number).
  const balanceScaleClass =
    displayBalance !== undefined && displayBalance >= 100_000_000
      ? " balance-main--scale-100m"
      : displayBalance !== undefined && displayBalance >= 10_000_000
        ? " balance-main--scale-10m"
        : displayBalance !== undefined && displayBalance >= 1_000_000
          ? " balance-main--scale-1m"
          : displayBalance !== undefined && displayBalance >= 100_000
            ? " balance-main--scale-100k"
            : "";
  const effectivePrimary = rates !== null ? balancePrimary : "sats";
  // The Home buttons' hold-menus, for everyone. The gift sender needs a backup
  // key, since an outgoing gift's reclaim seed has nowhere safe to live without
  // one (see giftStore.ts). An empty array leaves the button an ordinary
  // button, dots and all removed.
  const sendMenu: ActionMenuItem[] = useMemo(
    () =>
      giftEncryptionKey
        ? [
            {
              key: "gift",
              label: t("Poslat dárkem"),
              hint: t("Odkaz, který si příjemce vyzvedne"),
              icon: <GiftIcon />,
              onSelect: () => setGiftOpen(true),
            },
          ]
        : [],
    [giftEncryptionKey, t],
  );
  const receiveMenu: ActionMenuItem[] = useMemo(
    () => [
      {
        key: "request",
        label: t("Požadavek k platbě"),
        hint: t("Odkaz s částkou, stačí zaplatit"),
        icon: <RequestIcon />,
        onSelect: () => setRequestOpen(true),
      },
    ],
    [t],
  );

  const currentTourStep =
    justOnboarded && view === "home" && !showSettings && !chatOpen && balance !== null ? currentTourStepBase : null;

  // A short info card the first time the home screen is shown
  // during a VTXO refresh. Once per refresh, remembered across reloads, and
  // re-armed only once a loaded balance reports no round at all. Waits for
  // the home screen to be free of every other sheet, modal and the tour.
  const [refreshSheet, setRefreshSheet] = useState<{ amountSats: number; withheld: boolean } | null>(null);
  // v2 beta, iOS browser tab only: "Přidej si Spendrr na plochu" (see
  // lib/storageProtection.ts for why). Comes up by itself at most once per
  // mount and then once a week at most, never over anything else.
  const [installSheet, setInstallSheet] = useState(false);
  const installSheetTriedRef = useRef(false);
  const refreshingTotalSats = refreshing.countedInHeadlineSats + refreshing.withheldSats;
  const homeIsFree =
    view === "home" &&
    !showSettings &&
    !showUtility &&
    !currentTourStep &&
    !giftOpen &&
    !requestOpen &&
    !profileOpen &&
    !chatOpen &&
    !pendingGiftPw &&
    !showWhatsNew &&
    !showBoardConfirm &&
    !showPriceEasterEgg &&
    !installSheet &&
    !seedBackupSheet;
  useEffect(() => {
    if (balance === null) return;
    if (balance.pendingInRoundSats === 0) {
      try {
        localStorage.removeItem(REFRESH_SHEET_SEEN_KEY);
      } catch {
        // storage unavailable: the card may just show again next refresh
      }
      return;
    }
    if (refreshingTotalSats === 0 || refreshSheet || !homeIsFree) return;
    try {
      if (localStorage.getItem(REFRESH_SHEET_SEEN_KEY)) return;
    } catch {
      return;
    }
    // A beat after the home screen settles: the page blur pauses every
    // animation under it, and opened with the first balance the headline's
    // drop-in froze at opacity 0 (an empty balance behind the sheet).
    const id = window.setTimeout(() => {
      try {
        localStorage.setItem(REFRESH_SHEET_SEEN_KEY, "1");
      } catch {
        return;
      }
      setRefreshSheet({ amountSats: refreshingTotalSats, withheld: refreshing.withheldSats > 0 });
    }, 1200);
    return () => window.clearTimeout(id);
  }, [balance, refreshingTotalSats, refreshing.withheldSats, refreshSheet, homeIsFree]);

  // Not during a gift recipient's first session (claim, reveal, password
  // sheet): that is already a lot, and moving to the Home Screen needs the
  // seed phrase, which the seed banner asks for first anyway.
  // System back: a sub-screen to home, the Utility overlay slides away.
  useBackLayer(view !== "home", () => {
    if (view === "history") setView("home");
    else if (view !== "home") navigate("home", view);
  });
  useBackLayer(showUtility && utilityVisible, closeUtility);
  const installSheetAllowed =
    balance !== null && homeIsFree && !refreshSheet && !giftClaimActive && !pendingGiftPw;
  useEffect(() => {
    if (!installSheetAllowed || installSheetTriedRef.current) return;
    if (getPendingGiftPassword() !== null || !shouldAutoShowInstallHint()) return;
    // A beat after the home screen settles, not on top of its entrance.
    const id = window.setTimeout(() => {
      installSheetTriedRef.current = true;
      setInstallSheet(true);
    }, 2500);
    return () => window.clearTimeout(id);
  }, [installSheetAllowed]);

  const exitSheet = showExitSheet ? (
    <ExitSheet
      wallet={wallet}
      tracker={exitTracker}
      spendableSats={balance ? balance.spendableSats + balance.needsRefreshSats : null}
      inRoundSats={balance ? balance.pendingInRoundSats : 0}
      onClose={() => setShowExitSheet(false)}
      onKickOut={(message) => showToast(message, "danger", undefined, { quiet: true })}
      onCriticalOpChange={onCriticalOpChange}
      onBoard={
        exitLive &&
        !exitNeedsOnchainFees &&
        onchainBalance !== null &&
        onchainBalance.confirmedSats > 0 &&
        (boardMinSats === null || onchainBalance.confirmedSats >= boardMinSats)
          ? () => {
              setShowExitSheet(false);
              setShowBoardConfirm(true);
            }
          : null
      }
    />
  ) : null;

  if (showSettings) {
    return (
      <>
      <Suspense fallback={null}>
        <Settings
          wallet={wallet}
          initialSection={settingsInitialSection}
          onClose={() => {
            setShowSettings(false);
            setSettingsInitialSection(undefined);
            // The currency preference can only change while Settings is open;
            // re-read it on the way back out rather than plumbing a live
            // subscription through for something that changes this rarely.
            setCurrency(getFiatCurrency());
            // Revealing the seed in Settings clears the gift-recipient flag.
            setShowSeedBackupBanner(needsSeedBackup());
          }}
          onReset={onResetWallet}
          onOpenExit={() => setShowExitSheet(true)}
          onWaitForIdleRefresh={waitForIdleRefresh}
          giftEncryptionKey={giftEncryptionKey}
        />
      </Suspense>
      {exitSheet}
      </>
    );
  }

  return (
    <div className="dashboard">
      {toast && (
        <BodyPortal>
          <div className="toast-island-wrap">
            <div
              className={`toast-island toast-island--${toastTone(toast.kind, toast.detail)}${toast.closing ? " toast-island--closing" : ""}`}
              role="status"
              {...swipeAway(() => {
                if (toastTimerRef.current !== null) window.clearTimeout(toastTimerRef.current);
                if (toastCloseTimerRef.current !== null) window.clearTimeout(toastCloseTimerRef.current);
                setToast(null);
              })}
            >
              <span className="toast-island-icon" aria-hidden="true">
                <ToastIslandIcon tone={toastTone(toast.kind, toast.detail)} />
              </span>
              {toast.detail ? (
                <>
                  <span className="toast-island-text">
                    <span className="toast-island-title">{toast.detail.title}</span>
                    <span className="toast-island-amount">
                      {toast.detail.direction === "in" ? "+" : "−"}
                      {toast.detail.amountSats.toLocaleString(localeFor(lang))} sats
                    </span>
                  </span>
                  {rates !== null && (
                    <span className="toast-island-fiat">
                      {formatFiat(satsToFiat(toast.detail.amountSats, rates[currency]), currency)}
                    </span>
                  )}
                </>
              ) : (
                <span className="toast-island-message">{toast.message}</span>
              )}
              {toast.raw && (
                <ToastCopyButton raw={toast.raw} copied={toastRawCopied} onCopy={copyToastRaw} />
              )}
            </div>
          </div>
        </BodyPortal>
      )}
      <header className="dashboard-header">
        {/* The 3D mark replaces the wordmark. Two renders, one per theme
            (dark ink on light, cream on dark); Dashboard.css shows the right one. */}
        <span className="header-mark" ref={wordmarkRef} onClick={handleWordmarkClick}>
          <img className="header-mark-img header-mark-ink" src={headerMarkInk} width={47} height={37} alt="Spendrr" draggable={false} />
          <img className="header-mark-img header-mark-cream" src={headerMarkCream} width={47} height={36} alt="" aria-hidden="true" draggable={false} />
        </span>
        <div className="header-actions">
          <button
            className="secondary small icon-btn icon-btn-profile"
            onClick={() => setProfileOpen(true)}
            aria-label={t("Profil")}
          >
            <AtIcon />
          </button>
          {chatOn && (
            <ChatButton
              onOpen={() => {
                markChatUsed();
                void startChat(wallet);
                setChatOpen(true);
              }}
              label={t("Zprávy")}
            />
          )}
          <button
            className="secondary small icon-btn icon-btn-gear"
            onClick={openSettings}
            aria-label={t("Nastavení")}
          >
            <GearIcon />
          </button>
        </div>
      </header>

      {usingFallbackChainSource && (
        <div className="banner banner-warning">
          <WarningIcon />
          <span>
            {t(
              "ark.second.tech byl při odemykání nedosažitelný — appka teď pro tuhle relaci používá záložní zdroj dat mempool.space. Příště se zkusí připojit normálně.",
            )}
          </span>
        </div>
      )}

      {view !== "receive" && (
        <div
          className="balance-card"
          ref={balanceRef}
          onPointerDown={handleBalancePointerDown}
          onPointerUp={handleBalancePointerUp}
        >
          <div key={balanceHidden ? "hidden" : "visible"} className={`balance-swipe-content balance-slide-${swipeDir}`}>
            {displayBalance !== undefined ? (
              <>
                <div
                  key={`primary-${effectivePrimary}`}
                  className={`balance-main${showBalanceEnter ? " balance-enter" : showBalanceSwap ? " balance-primary-swap" : ""}${showBalanceBump ? " balance-bump" : ""}${balanceScaleClass}`}
                >
                  {balanceHidden ? (
                    <span className="balance-value balance-dots" aria-label={t("Zůstatek skrytý, přejeď pro zobrazení")}>
                      • • • • • • •
                    </span>
                  ) : effectivePrimary === "fiat" && rates !== null ? (
                    <span className="balance-value">
                      <RollingDigits
                        text={formatFiat(satsToFiat(displayBalance, rates[currency]), currency)}
                        animate={showBalanceBump}
                        direction={bumpDirection}
                      />
                    </span>
                  ) : (
                    <>
                      <span className="balance-value">
                        <RollingDigits
                          text={displayBalance.toLocaleString(localeFor(lang))}
                          animate={showBalanceBump}
                          direction={bumpDirection}
                        />
                      </span>
                      <span className="balance-unit">sats</span>
                    </>
                  )}
                </div>
                {rates !== null && (
                  <div
                    key={`secondary-${effectivePrimary}`}
                    className={`balance-fiat${showBalanceEnter ? " balance-enter-fiat" : showBalanceSwap ? " balance-secondary-swap" : ""}${showBalanceBump ? " balance-bump" : ""}`}
                  >
                    {balanceHidden ? (
                      "• • •"
                    ) : (
                      <RollingDigits
                        text={
                          effectivePrimary === "fiat"
                            ? `${displayBalance.toLocaleString(localeFor(lang))} sats`
                            : `≈ ${formatFiat(satsToFiat(displayBalance, rates[currency]), currency)}`
                        }
                        animate={showBalanceBump}
                        direction={bumpDirection}
                      />
                    )}
                  </div>
                )}
                {/* displayBalance excludes exitingSats (see its own comment
                    above), so funds moved into a unilateral exit simply
                    vanish from the headline number — and an exit runs for
                    days or weeks, during which the wallet truthfully but
                    alarmingly reads near zero. The exit toast further down
                    says an exit is running, but only while `view` is home
                    and only as a separate notice; the number itself needs
                    to account for its own drop. */}
                {!balanceHidden && exitingSats > 0 && (
                  <div className="balance-exit-note">
                    {tf(t("+ {amount} sats v nouzovém exitu"), {
                      amount: exitingSats.toLocaleString(localeFor(lang)),
                    })}
                  </div>
                )}
                {/* The locked inputs of a refresh round ARE in the headline
                    (headlineSats: bark 0.8 counts them once, in
                    pendingInRoundSats), so the number does not drop for the
                    round. They cannot be paid with until it ends, which is
                    what this says. */}
                {!balanceHidden && (balance?.pendingInRoundSats ?? 0) > 0 && (
                  <div className="balance-exit-note">
                    {tf(t("z toho {amount} sats v obnově"), {
                      amount: (balance?.pendingInRoundSats ?? 0).toLocaleString(localeFor(lang)),
                    })}
                  </div>
                )}
                {/* bark 0.8 keeps expired coins and coins at the server's max
                    exit depth out of spendableSats (needsRefreshSats): they
                    cannot be sent out-of-round until a refresh, but are still
                    the user's, so they are named here instead of vanishing
                    from the headline. Disjoint from every other field. */}
                {!balanceHidden && (balance?.needsRefreshSats ?? 0) > 0 && (
                  <div className="balance-exit-note">
                    {tf(t("+ {amount} sats čeká na obnovu"), {
                      amount: (balance?.needsRefreshSats ?? 0).toLocaleString(localeFor(lang)),
                    })}
                  </div>
                )}
                {/* Beta, refresh engine live: coins the engine keeps out of
                    every refresh (quarantine, or over the server's max
                    amount). An "unknown" quarantined one and an over-cap one
                    are still in the number above; a "spent" one is not.
                    Either way the user should know, not find out at expiry
                    (audit 2026-09-26). Details in Settings → VTXO mince. */}
                {!balanceHidden && effectiveEngineMode() === "live" && (engineSnap.status?.unrefreshableSats ?? 0) > 0 && (
                  <div className="balance-exit-note">
                    {tf(t("{amount} sats nejde obnovit"), {
                      amount: (engineSnap.status?.unrefreshableSats ?? 0).toLocaleString(localeFor(lang)),
                    })}
                  </div>
                )}
                {/* The delegated half: these coins ARE inside the number
                    above (their VTXOs are still Spendable), so this says
                    "of which", never "+". Still worth showing, because a
                    refresh round will consume them and a send competing
                    with it can fail. Not with the engine live: its locked
                    inputs are the note above. */}
                {!balanceHidden && effectiveEngineMode() !== "live" && refreshingInHeadlineSats > 0 && (
                  <div className="balance-exit-note">
                    {tf(t("z toho {amount} sats je v obnově VTXO"), {
                      amount: refreshingInHeadlineSats.toLocaleString(localeFor(lang)),
                    })}
                  </div>
                )}
              </>
            ) : (
              <div className="balance-main">
                <span className="balance-skeleton" aria-label={t("Načítám zůstatek")} />
              </div>
            )}
          </div>
        </div>
      )}

      {showSeedBackupBanner && !giftRevealHold && view !== "receive" && (
        <div className="gift-seed-banner">
          <strong>{t("Chybí záloha")}</strong>
          <button
            type="button"
            className="secondary small gift-seed-btn"
            onClick={startSeedBackup}
          >
            {t("Zálohovat")}
          </button>
        </div>
      )}
      {netIsland && !toast && (
        <BodyPortal>
          <div className="toast-island-wrap">
            <div
              className={`toast-island toast-island--net toast-island--${NET_ISLAND_COPY[netIsland.kind].tone === "online" ? "online" : "offline"}${netIsland.closing ? " toast-island--closing" : ""}`}
              role="status"
              {...swipeAway(() => {
                netTimersRef.current.forEach((id) => window.clearTimeout(id));
                netTimersRef.current = [];
                setNetIsland(null);
              })}
            >
              <span className="toast-island-icon" aria-hidden="true">
                <ToastIslandIcon tone={NET_ISLAND_COPY[netIsland.kind].tone} />
              </span>
              {/* Keyed so the text fades in again when offline turns into
                  online, instead of just swapping in place. */}
              <span className="toast-island-text" key={netIsland.kind}>
                <span className="toast-island-headline">{t(NET_ISLAND_COPY[netIsland.kind].headline)}</span>
                <span className="toast-island-title">{t(NET_ISLAND_COPY[netIsland.kind].title)}</span>
              </span>
            </div>
          </div>
        </BodyPortal>
      )}
      {engineAttention && !toast && !netIsland && !loadError && view === "home" && (
        <BodyPortal>
          <div className="toast-island-wrap">
            <button
              type="button"
              className="toast-island toast-island--danger"
              onClick={() => {
                setSettingsInitialSection("vtxos");
                openSettings();
              }}
            >
              <span className="toast-island-icon" aria-hidden="true">
                <ToastIslandIcon tone="danger" />
              </span>
              <span className="toast-island-message">
                {engineAttention === "stuck"
                  ? t("Obnova mincí trvá přes 24 hodin. Klepni pro podrobnosti.")
                  : engineAttention === "unrefreshable-urgent"
                    ? t("Část mincí nejde obnovit a brzy vyprší. Klepni pro podrobnosti.")
                    : t("Obnova mincí se zastavila a mince brzy vyprší. Klepni pro podrobnosti.")}
              </span>
            </button>
          </div>
        </BodyPortal>
      )}
      {loadError && !toast && !netIsland && (
        <BodyPortal>
          <div className="toast-island-wrap">
            <div
              className="toast-island toast-island--danger"
              role="status"
              {...swipeAway(() => {
                setLoadError(null);
                setLoadErrorDetail(null);
              })}
            >
              <span className="toast-island-icon" aria-hidden="true">
                <ToastIslandIcon tone="danger" />
              </span>
              <span className="toast-island-message">{loadError}</span>
              {loadErrorDetail && (
                <ToastCopyButton raw={loadErrorDetail} copied={toastRawCopied} onCopy={copyToastRaw} />
              )}
            </div>
          </div>
        </BodyPortal>
      )}

      {/* Deliberately not a toast (fixed, in the same top spot the transient
          success/error toasts use) — this one is sticky,
          not auto-dismissing, and needs room for a button, so it's laid out
          inline instead of floating: stacking two fixed-position toasts at
          the same coordinates would just overlap. Stays up for as long as
          there's boardable onchain balance, since the whole point is that
          this money is otherwise invisible/unspendable until the user
          explicitly acts on it. Home-only, by explicit request — it used to
          show regardless of `view`, but on Send/History/Receive it just sat
          above unrelated content (and on Receive's Onchain tab duplicated
          that tab's own one-time info banner). */}
      {/* While an unilateral exit runs, neither notice shows: the exit card
          below carries the on-chain amount as one line (agreed with the user
          2026-09-28, two stacked cards looked bad), and moving the money into
          Ark is offered only from the exit sheet, behind a warning
          (BoardSheet). While the exit still needs fees it isn't offered at all:
          boardAll() moves *all* confirmed on-chain funds and would strand it. */}
      {/* Before the tracker's first read the card can't show yet (it needs
          bark's view): if the last session's hint says an exit runs, the
          amount shows here meanwhile, without the button. */}
      {view === "home" && !exitTracker.loaded && exitLive && onchainBalance && onchainBalance.confirmedSats > 0 && (
        <div className="onchain-receive-toast onchain-receive-toast--pending" role="status">
          <OnchainIcon />
          <span>
            {tf(t("On-chain na poplatky: {amount}"), {
              amount: `${onchainBalance.confirmedSats.toLocaleString(localeFor(lang))} sats`,
            })}
          </span>
        </div>
      )}
      {view === "home" &&
        !exitLive &&
        onchainBalance &&
        onchainBalance.confirmedSats > 0 &&
        (boardMinSats === null || onchainBalance.confirmedSats >= boardMinSats ? (
          <div className="onchain-receive-toast" role="status">
            <OnchainIcon />
            <span>
              {tf(t("Příchozí onchain platba: {amount} sats"), {
                amount: onchainBalance.confirmedSats.toLocaleString(localeFor(lang)),
              })}
            </span>
            <button type="button" className="small" onClick={() => setShowBoardConfirm(true)}>
              {t("Přijmout")}
            </button>
          </div>
        ) : (
          <div className="onchain-receive-toast onchain-receive-toast--pending" role="status">
            <OnchainIcon />
            <span>
              {tf(t("Příchozí onchain platba: {amount} sats · pod minimem pro přesun ({min} sats), čeká se na doplnění"), {
                amount: onchainBalance.confirmedSats.toLocaleString(localeFor(lang)),
                min: boardMinSats.toLocaleString(localeFor(lang)),
              })}
            </span>
          </div>
        ))}
      {/* Informational only, no action — an unconfirmed UTXO can't be
          boarded (boardAll() only moves confirmed funds), so unlike the
          notice above this one never gets a button. Stacks independently
          of it: a wallet can have both confirmed funds still waiting to be
          boarded *and* a newer, still-unconfirmed payment at the same
          time — they're different money. Also Home-only, see above. */}
      {view === "home" && !exitLive && onchainBalance && onchainBalance.pendingSats > 0 && (
        <div className="onchain-receive-toast onchain-receive-toast--pending" role="status">
          <OnchainIcon />
          <span>
            {tf(t("Nepotvrzená onchain platba: {amount} sats · čeká na potvrzení"), {
              amount: onchainBalance.pendingSats.toLocaleString(localeFor(lang)),
            })}
          </span>
        </div>
      )}

      {view === "home" && (
        <ExitHomeCard
          tracker={exitTracker}
          outsideSats={balance ? balance.spendableSats : 0}
          onchain={onchainBalance}
          onOpen={() => setShowExitSheet(true)}
        />
      )}

      {view === "home" ? (
        <>
          <nav className="big-actions">
            <BigActionButton
              kind="receive"
              label={t("Přijmout")}
              icon={<ReceiveArrowIcon />}
              onClick={() => navigate("receive", "receive")}
              menu={receiveMenu}
              innerRef={receiveButtonRef}
              onMenuOpen={dismissHoldHint}
            />
            <button
              type="button"
              className="big-action-scan"
              // The sheet opens over Home in the same render; no Send form behind it.
              onClick={() => setScanner("camera")}
              aria-label={t("Naskenovat QR kód")}
            >
              <ScanIcon />
            </button>
            <BigActionButton
              kind="send"
              label={t("Odeslat")}
              icon={<SendArrowIcon />}
              onClick={() => navigate("send", "send")}
              menu={sendMenu}
              innerRef={sendButtonRef}
              onMenuOpen={dismissHoldHint}
            />
          </nav>
          {/* The hold gesture has no label of its own, so it gets exactly
              one introduction, once, on the button that has the most behind
              it: Odeslat where the gift sender is on, otherwise Přijmout (its
              menu is there for everyone). Held back until the balance has
              actually loaded so it doesn't land on a skeleton screen, and
              behind the Utility hub's own hint where that one can show (v2
              only: outside it, that hint is never seen and never marked). */}
          {showHoldHint && balanceLoaded && !chatOpen && !currentTourStep && !(showUtilityHint && designVersion === "v2") && (
            <Coachmark
              targetRef={sendMenu.length > 0 ? sendButtonRef : receiveButtonRef}
              text={t("Podrž tlačítko a objeví se víc možností.")}
              placement="top"
              onDismiss={dismissHoldHint}
            />
          )}

          {/* Passive "tap two phones together to pay" — only while Home is
              actually showing (per its own design: it should never listen
              from Settings, History, etc.), and only once both the v2 beta
              toggle and this feature's own Settings switch are on. Reads
              isBumpPayEnabled() directly rather than via a reactive hook —
              the only place that value changes is Settings, and returning
              from Settings back to Home already re-renders Dashboard, so a
              plain read here is enough to pick that up. */}
          {designVersion === "v2" && isBumpPayEnabled() && address && (
            <BumpOverlay
              wallet={wallet}
              myAddress={address}
              spendable={spendable}
              rates={rates}
              currency={currency}
              onSent={refresh}
              onSentBump={requestBalanceBump}
              onCriticalOpChange={onCriticalOpChange}
              paused={chatOpen}
            />
          )}

          <div className="recent-activity">
            <div className="recent-activity-header">
              <h2>{t("Nedávná aktivita")}</h2>
              {!giftRevealHold && visibleHistory.length > RECENT_HISTORY_LIMIT && (
                <button type="button" className="link-btn" onClick={() => setView("history")}>
                  {t("Zobrazit vše")}
                </button>
              )}
            </div>
            <HistoryPanel
              history={giftRevealHold ? [] : visibleHistory.slice(0, RECENT_HISTORY_LIMIT)}
              currency={currency}
              balanceHidden={balanceHidden}
              wallet={wallet}
              stagger="first-load"
            />
          </div>

          {/* A fixed-size rectangle right below the history card, not a
              flex:1 area stretched to fill the viewport — the header has no
              lock button, so this is the only on-demand way to lock, and a
              variable-sized/positioned target (shifting with content
              length or, on mobile, the browser chrome showing/hiding
              between taps) made the double-tap land inconsistently.
              Manual tap counting (tapCounter.ts), not native
              onDoubleClick: on touch devices a double-tap on a
              plain element is routinely consumed by the browser's own
              double-tap-to-zoom gesture instead of ever reaching the page as
              a "dblclick" event, which made this silently do nothing on
              phones despite working fine with a mouse. */}
          <div
            className="lock-gesture-area"
            ref={lockGestureAreaRef}
            style={{ height: lockGestureAreaHeight }}
            onPointerDown={handleLockAreaPointerDown}
            onPointerUp={handleLockAreaPointerUp}
            onPointerCancel={handleLockAreaPointerCancel}
            aria-hidden="true"
          />
        </>
      ) : (
        <div
          className={`subview${view === "receive" ? " subview--no-balance" : ""}${receiveDissolving ? " subview--dissolving" : ""}`}
        >
          <button
            type="button"
            className="subview-back"
            // History opens and closes without a transition (tried, dropped).
            onClick={() => (view === "history" ? setView("home") : navigate("home", view))}
          >
            <BackIcon />
            {t("Zpět")}
          </button>
          <div key={`${view}:${sendPrefill?.nonce ?? 0}`} className="panel-transition">
            {view === "receive" && (
              <ReceiveScreen
                wallet={wallet}
                format={receiveMode}
                onFormatChange={setReceiveMode}
                lnName={myName?.lnAddress ? myName.name : null}
                lnServiceOk={lnServiceOk}
                onSetupAddress={() => setProfileOpen(true)}
                address={address}
                addressError={addressError !== null ? describeError(new Error(addressError), t, lang).text : null}
                onchainAddress={onchainAddress}
                onRequestOnchainAddress={requestOnchainAddress}
                invoice={pendingReceive?.kind === "lightning" ? pendingReceive : null}
                onInvoiceCreated={startLightningWatch}
                onCancelInvoice={cancelLightningWatch}
                rates={rates}
                currency={currency}
                onQrCopied={() => showToast(t("Zkopírováno do schránky"), "neutral")}
                dissolving={receiveDissolving}
              />
            )}
            {view === "send" && (
              <SendPanel
                wallet={wallet}
                onSent={refresh}
                spendable={spendable}
                inRoundSats={balance?.pendingInRoundSats ?? 0}
                rates={rates}
                currency={currency}
                onSentToast={showToast}
                onSentBump={requestBalanceBump}
                onOpenScanner={() => setScanner("source")}
                scanned={scanned}
                onScannedConsumed={() => setScanned(null)}
                onSendComplete={motionOn ? () => navigate("home") : undefined}
                onCriticalOpChange={onCriticalOpChange}
                initialDestination={sendPrefill?.destination}
                initialAmountSats={sendPrefill?.amountSats}
              />
            )}
            {view === "history" && (
              <HistoryPanel
                history={visibleHistory}
                currency={currency}
                balanceHidden={balanceHidden}
                wallet={wallet}
                groupByDate
              />
            )}
          </div>
        </div>
      )}
      <RecordSealSheet />
      {showPriceEasterEgg && (
        <Suspense fallback={null}>
          <BtcPriceModal currency={currency} onClose={() => setShowPriceEasterEgg(false)} />
        </Suspense>
      )}
      {showWhatsNew && (
        <Suspense fallback={null}>
          <WhatsNewModal
            onClose={() => {
              markWhatsNewSeen(__APP_VERSION__);
              setShowWhatsNew(false);
            }}
          />
        </Suspense>
      )}
      {giftOpen && giftEncryptionKey && (
        <GiftComposeModal
          wallet={wallet}
          spendable={spendable}
          encryptionKey={giftEncryptionKey}
          rates={rates}
          onClose={() => setGiftOpen(false)}
        />
      )}
      {requestOpen && (
        <PaymentRequestModal wallet={wallet} address={address} rates={rates} onClose={() => setRequestOpen(false)} />
      )}
      {profileOpen && (
        <ProfileSheet wallet={wallet} address={address} onClose={() => setProfileOpen(false)} />
      )}
      {chatOpen && chatOn && (
        <ChatPanel
          wallet={wallet}
          initialPeer={chatPeer}
          initialScheduleId={chatScheduleId}
          history={history}
          spendable={spendable}
          rates={rates}
          currency={currency}
          onClose={() => {
            setChatOpen(false);
            setChatPeer(null);
            setChatScheduleId(null);
          }}
          onOpenProfile={() => {
            setChatOpen(false);
            setProfileOpen(true);
          }}
          onPaid={() => void refresh()}
          onCriticalOpChange={onCriticalOpChange}
          onPayDestination={(target) => {
            // The ordinary Send form, prefilled: it checks the destination
            // and shows its frozen confirm screen like for any other payment.
            setChatOpen(false);
            prefillNonceRef.current += 1;
            setSendPrefill({ ...target, nonce: prefillNonceRef.current });
            setScanner(null);
            setView("send");
          }}
          onClaimGift={(gift) => {
            setChatOpen(false);
            if (!hasClaimedGift(gift.id)) setChatGift(gift);
          }}
          renderMovement={(m, close) => (
            <ChatTxDetail
              movement={m}
              history={history}
              currency={currency}
              balanceHidden={balanceHidden}
              wallet={wallet}
              onClose={close}
            />
          )}
        />
      )}
      {scanner === "source" && (
        <Suspense fallback={null}>
          <QrSourceSheet
            onCamera={() => setScanner("camera")}
            onResult={handleScanResult}
            onClose={closeScanner}
          />
        </Suspense>
      )}
      {scanner === "camera" && (
        <Suspense fallback={null}>
          <QrScannerModal onResult={handleScanResult} onClose={closeScanner} />
        </Suspense>
      )}
      {chatGift && (
        <GiftClaimModal
          gift={chatGift}
          liveWallet={wallet}
          // A session is open, so the modal claims straight into it and never
          // asks to create or unlock a wallet.
          onOpenFresh={() => Promise.reject(new Error("wallet already open"))}
          onOpenVault={() => Promise.reject(new Error("wallet already open"))}
          onOpenDevice={() => Promise.reject(new Error("wallet already open"))}
          onDone={() => {
            setChatGift(null);
            void refresh();
          }}
        />
      )}
      {seedBackupSheet && <SeedBackupSheet onClose={() => setSeedBackupSheet(false)} />}
      {installSheet && (
        <InstallAppSheet
          variant="wallet"
          needsSeed={showSeedBackupBanner}
          onShowSeed={() => {
            snoozeInstallHint();
            setInstallSheet(false);
            startSeedBackup();
          }}
          onNever={() => {
            neverShowInstallHint();
            setInstallSheet(false);
          }}
          onClose={() => {
            snoozeInstallHint();
            setInstallSheet(false);
          }}
        />
      )}
      {refreshSheet && (
        <RefreshInfoSheet
          amountSats={refreshSheet.amountSats}
          withheld={refreshSheet.withheld}
          onClose={() => setRefreshSheet(null)}
        />
      )}
      {pendingGiftPw && (
        <GiftPasswordModal
          password={pendingGiftPw}
          onDone={() => {
            // Dismiss only — "Uložil jsem si ho" is not proof they actually
            // did. The stored copy is cleared only where the correct password
            // was actually typed and verified: a successful password unlock
            // (App.tsx), a password change, a biometric enrolment or a seed
            // reveal (all three in Settings). Until one of those happens it
            // survives any number of further locks, same safety net as the
            // unlock-screen version of this prompt.
            setPendingGiftPw(null);
          }}
        />
      )}
      {showBoardConfirm && onchainBalance && (
        <BoardSheet
          wallet={wallet}
          amountSats={onchainBalance.confirmedSats}
          busy={boarding}
          error={boardError}
          exitLive={exitLive}
          onConfirm={confirmBoard}
          onClose={() => {
            setShowBoardConfirm(false);
            setBoardError(null);
          }}
        />
      )}
      {exitSheet}
      {currentTourStep && (
        <Coachmark
          key={currentTourStep.key}
          targetRef={currentTourStep.ref}
          text={currentTourStep.text}
          placement={currentTourStep.placement}
          onDismiss={() => advanceTour(currentTourStep.key)}
        />
      )}
      {/* Gated on !currentTourStep so a brand-new wallet mid-tour never gets
          two coachmarks pointing at the same lock-gesture-area at once —
          for a new wallet this one naturally waits until the tour's own
          lock-gesture step has been dismissed. */}
      {showUtilityHint && designVersion === "v2" && view === "home" && !showSettings && !chatOpen && !currentTourStep && (
        <Coachmark
          key="utility-swipe"
          targetRef={lockGestureAreaRef}
          placement="top"
          text={t("Přejetím doprava sem otevřeš Utility.")}
          onDismiss={dismissUtilityHint}
        />
      )}
      {showUtility && (
        // A fixed full-screen overlay, not the early-return Settings uses —
        // that's what lets it slide over the still-mounted home screen
        // instead of swapping the whole tree in one frame. `utilityVisible`
        // toggles the on/off-screen transform (see openUtility/closeUtility
        // above); onTransitionEnd unmounts it (setShowUtility(false)) only
        // once the slide-out animation has actually finished, and only for
        // the overlay's own transform — transitionend bubbles, and the
        // mode-toggle pill inside UtilityHub animates its own transform on
        // every tab switch, which would otherwise fire this early.
        //
        // Suspense wraps only <UtilityHub/> below, NOT this div — it used to
        // wrap the whole overlay, which meant that until the lazy chunk
        // resolved, this div (the thing that actually carries the slide
        // transform) never rendered at all. openUtility's double-rAF
        // "mount off-screen, flip on-screen next frame" choreography had
        // nothing to mount, so a swipe landing before the chunk finished
        // loading (still possible even with the bounded prefetch — a slow
        // connection, or a swipe within the prefetch's own 400ms window)
        // either popped in with no animation or, worse, the overlay/back
        // button mounted mid-swipe not yet hydrated, needing a second tap.
        // The overlay itself has a solid `background: var(--bg)`
        // (Dashboard.css), so keeping it outside Suspense means the slide
        // always animates smoothly — worst case the panel arrives a beat
        // before its content does, never before the animation itself.
        <div
          className={`utility-hub-overlay${utilityVisible ? " utility-hub-overlay--visible" : ""}${utilitySettled ? " utility-hub-overlay--settled" : ""}`}
          onTransitionEnd={(e) => {
            if (e.target !== e.currentTarget || e.propertyName !== "transform") return;
            if (!utilityVisible) {
              setShowUtility(false);
            } else {
              // The open (slide-in) transition just genuinely finished —
              // see utilitySettled's own comment above for why taps are
              // blocked (pointer-events, Dashboard.css) until this fires
              // (or the backstop timer does, whichever comes first).
              if (utilitySettleTimerRef.current !== null) {
                window.clearTimeout(utilitySettleTimerRef.current);
                utilitySettleTimerRef.current = null;
              }
              setUtilitySettled(true);
            }
          }}
        >
          <Suspense fallback={null}>
            <UtilityHub
              onClose={closeUtility}
              wallet={wallet}
              rates={rates}
              currency={currency}
              pendingReceive={pendingReceive}
              onInvoiceCreated={startLightningWatch}
              onCancelLightningWatch={cancelLightningWatch}
            />
          </Suspense>
        </div>
      )}
    </div>
  );
}

// Rows are the taller "chunky card" style (design-v2.css) — 4 keeps the
// homepage card from growing past what 5 used to take at the old, smaller
// row height.
const RECENT_HISTORY_LIMIT = 4;

/* ---------- Receive ---------- */

// boardAll() rejects amounts below the Ark server's own minimum with a raw
// English message like "board amount of 0.00006 BTC is less than minimum
// board amount required by server (0.00050000 BTC)". Rather than surfacing
// that verbatim (this is a Czech-copy app) or hardcoding a sats figure that
// could drift from whatever the server actually enforces, parse the two BTC
// amounts back out of the SDK's own message and re-render them as a Czech
// sentence in sats. Falls back to the raw message for any other error.
function translateBoardError(
  raw: string,
  t: (s: string) => string,
  lang: Lang,
): { message: string; minSats: number | null } {
  const match = raw.match(/minimum board amount required by server \(([\d.]+) BTC\)/);
  if (match) {
    const minSats = Math.round(Number(match[1]) * 1e8);
    const message = tf(t("Částka je pod minimem pro přesun do Ark ({min} sats). Počkej, až on-chain zůstatek naroste, a zkus to znovu."), {
      min: minSats.toLocaleString(localeFor(lang)),
    });
    return { message, minSats };
  }
  return { message: raw, minSats: null };
}
