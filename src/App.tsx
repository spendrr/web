import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent } from "react";
import { flushSync } from "react-dom";
import "./App.css";
import { encryptMnemonic, loadVault, saveVault } from "./lib/vault/crypto";
import {
  closeWallet,
  deleteWalletDb,
  ensureWasm,
  generateMnemonic,
  openHeldWallet,
  prepareSession,
  pushOnchainScanActive,
  pushWorkerWatchdogOverride,
  resetOnchainWalletDb,
  settleMaintenanceDelegated,
  setWorkerLostHandler,
  validateMnemonic,
  type WalletClient,
} from "./lib/wallet/bark";
import {
  BIO_DECRYPT_FAILED,
  NO_HELD_MNEMONIC,
  VAULT_DECRYPT_FAILED,
  type PrepareSource,
} from "./lib/wallet/walletSession";
import { hasBiometricUnlock, unlockWithBiometric } from "./lib/vault/webauthn";
import { DEVICE_KEY_MISSING, hasDeviceVault, loadDeviceUnwrap } from "./lib/vault/deviceVault";
import { PASSWORD_SETUP_EVENT } from "./lib/vault/vaultAccess";
import PasswordSetupSheet from "./components/PasswordSetupSheet";
import { isAutoLockEnabled } from "./lib/vault/autoLock";
import { clearAllLocalWalletState } from "./lib/vault/resetLocalState";
import { clearStoredReceiveAddress } from "./lib/wallet/onchainReceiveAddress";
import { exitMayBeLive, isLiveExitState, rekeyStoredExitDestination } from "./lib/exit/emergencyExit";
import { withTimeout, WALLET_CALL_TIMEOUT_MS, SEND_WATCHDOG_MS, TIMEOUT_MESSAGE } from "./lib/wallet/walletCall";
import {
  applyFetchedBackup,
  createBackupUploader,
  fetchAndDecryptBackup,
  hasAnyLocalWalletData,
  clearRestoreFailure,
  clearSelfInflictedConflictLatch,
  liftConflictLatchIfCovered,
  quarantineWalletDbs,
  isRestoreFailureLatched,
  recordRestoreFailure,
  uploadBackupNow,
  waitForLocalStateToSettle,
} from "./lib/backup/backup";

import BitcoinMark from "./components/BitcoinMark";
import MnemonicGrid from "./components/MnemonicGrid";
import ImportSeedForm from "./components/ImportSeedForm";
import Dashboard from "./components/Dashboard";
import GiftClaimModal from "./components/GiftClaimModal";
import GiftPasswordModal from "./components/GiftPasswordModal";
import { ErrorCircleIcon, WarningIcon } from "./components/BannerIcons";
import { isPasswordStrong, passwordProblem } from "./lib/vault/password";
import { decodeGiftFragment, isGiftPath, type GiftLinkParams } from "./lib/gift/giftLink";
import { decodeRequestFragment, isRequestPath, type PaymentRequestParams } from "./lib/send/paymentRequest";
import PaymentRequestPage from "./components/PaymentRequestPage";
import ProfilePage from "./components/ProfilePage";
import { handleFromPath } from "./lib/names/handle";
import { clearPendingGiftPassword, getPendingGiftPassword, hasClaimedGift } from "./lib/gift/giftStore";
import { tf, useT } from "./lib/i18n";
import { WALLET_OPEN_ELSEWHERE, walletTabLock } from "./lib/wallet/walletTabLock";
import WalletOpenElsewhereSheet from "./components/WalletOpenElsewhereSheet";
import DeleteWalletSheet from "./components/DeleteWalletSheet";
import { isIosBrowserTab, requestPersistentStorage } from "./lib/vault/storageProtection";
import InstallAppSheet from "./components/InstallAppSheet";
import { hapticError, hapticSuccess, hapticTap } from "./lib/ui/haptics";
import { getDesignVersion } from "./lib/ui/designVersion";
import { sessionEngineMode } from "./lib/refreshEngine/mode";

const AUTO_LOCK_MS = 5 * 60 * 1000;
// "input" catches virtual-keyboard text entry that iOS Safari doesn't
// reliably fire "keydown" for (autocomplete taps, predictive text) — typing
// a long invoice or address shouldn't silently fail to count as activity.
const ACTIVITY_EVENTS = ["mousedown", "mousemove", "keydown", "touchstart", "scroll", "wheel", "input"] as const;
const ONCHAIN_SCANNED_KEY = "btc-wallet-onchain-scanned";
// One-time flag for resetOnchainWalletDb()'s repair below — see that
// function's own comment in bark.ts for what it fixes and why.
const ONCHAIN_BLOAT_FIX_KEY = "btc-wallet-onchain-bloat-fixed-v1";
// Positions/timings for the onboarding screen's decorative floating
// Bitcoin-mark background — hand-picked, not generated, so they stay fixed
// across renders instead of jittering.
const ONBOARDING_BG_ICONS = [
  { top: "5%", left: "8%", size: 40, duration: 14, dx: 14, dy: 10, rot: -6, opacity: 0.5 },
  { top: "12%", left: "78%", size: 30, duration: 12, dx: -12, dy: 14, rot: 8, opacity: 0.4 },
  { top: "46%", left: "2%", size: 26, duration: 16, dx: 10, dy: -10, rot: -4, opacity: 0.35 },
  { top: "60%", left: "84%", size: 34, duration: 13, dx: -14, dy: -8, rot: 5, opacity: 0.45 },
  { top: "80%", left: "10%", size: 24, duration: 15, dx: 8, dy: -12, rot: -8, opacity: 0.32 },
  { top: "3%", left: "44%", size: 20, duration: 17, dx: -8, dy: 10, rot: 10, opacity: 0.28 },
] as const;

// How long the unlock screen's padlock gets to visibly swing open before the
// dashboard replaces it (V2 unlock screen only). Only ever spent *after* the
// wallet is already open, never before the password is verified, so the
// animation can't claim a success that hasn't happened.
const UNLOCK_CELEBRATION_MS = 700;

// A lock by hand (the double tap): the unlock screen comes in with the padlock
// still open, this long, and then it closes (the unlock played backwards).
const LOCK_CLOSE_DELAY_MS = 220;

function prefersReducedMotion(): boolean {
  return window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
}

type Screen =
  | { kind: "loading" }
  | { kind: "onboarding" }
  | { kind: "create-confirm"; mnemonic: string }
  | { kind: "import" }
  | { kind: "set-password"; mnemonic: string; isImport: boolean }
  | { kind: "unlock" }
  | { kind: "ready"; wallet: WalletClient };

function Brand() {
  return (
    <div className="brand">
      <span className="wordmark brand-mark">
        Spend
        <span className="accent-r r1">r</span>
        <span className="accent-r r2">r</span>
      </span>
    </div>
  );
}

function LockIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
      <rect x="5" y="11" width="14" height="9" rx="2" stroke="currentColor" strokeWidth="1.8" />
      <path d="M8 11V8a4 4 0 0 1 8 0v3" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
    </svg>
  );
}

function PasswordField({
  value,
  onChange,
  placeholder,
  autoFocus,
}: {
  value: string;
  onChange: (v: string) => void;
  placeholder: string;
  autoFocus?: boolean;
}) {
  return (
    <div className="input-icon-wrap">
      <LockIcon />
      <input
        type="password"
        placeholder={placeholder}
        value={value}
        autoFocus={autoFocus}
        onChange={(e) => onChange(e.target.value)}
      />
    </div>
  );
}

function App() {
  const t = useT();
  const [screen, setScreen] = useState<Screen>({ kind: "loading" });
  const [error, setError] = useState<string | null>(null);
  // Another tab or window already has the wallet open (walletTabLock.ts):
  // shown as a sheet over the unlock/set-password screen rather than as an
  // error line, since nothing is wrong and there is something to do.
  const [openElsewhere, setOpenElsewhere] = useState(false);
  // Set only when the "unlock" screen was reached via a forced worker reset
  // (see setWorkerLostHandler below), not a manual lock or normal idle
  // auto-lock — those need no explanation, this one otherwise looks
  // identical to them from the user's side despite being a very different,
  // worth-investigating event ("it locked itself while I wasn't even doing
  // anything"). Cleared the moment a real unlock attempt starts, so it never
  // lingers across into an unrelated future lock.
  const [workerLostReason, setWorkerLostReason] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // True while the V2 unlock screen's padlock plays its opening transition
  // (the wallet is already open by then).
  const [unlockOpened, setUnlockOpened] = useState(false);
  // Set by the V2 unlock paths only: play the padlock-opening celebration
  // before swapping to the dashboard.
  const celebrateUnlockRef = useRef(false);
  const lockCloseTimerRef = useRef<number | null>(null);
  // Gates create-confirm's "I wrote it down, continue" button — false until
  // MnemonicGrid reports every word has actually been stepped through, reset
  // whenever a fresh mnemonic is generated below.
  const [seedFullyRevealed, setSeedFullyRevealed] = useState(false);
  // True only for the very first Dashboard mount right after the user
  // finishes creating/importing a wallet — gates the onboarding coachmark
  // tour so returning users unlocking an existing wallet never see it again.
  const [justOnboarded, setJustOnboarded] = useState(false);
  // v2 beta, iOS browser tab only: "Vytvořit peněženku" / "Mám seed phrase"
  // first shows the add-to-Home-Screen sheet, once per page load. Holds what
  // the tapped button would have done, for "Pokračovat v prohlížeči".
  const [installGate, setInstallGate] = useState<{ then: () => void } | null>(null);
  const installGateShownRef = useRef(false);

  // Set when the app was opened via a "send bitcoin as a link" URL
  // (spendrr.app/g#…) that hasn't been claimed on this device yet.
  // Rendered as an overlay on top of whatever screen is active — the claim
  // flow itself is entirely separate from the normal onboarding/unlock
  // state machine (see the render branch near the bottom).
  const [giftClaim, setGiftClaim] = useState<GiftLinkParams | null>(null);
  // Read by the auto-lock timer: a lock mid-claim kills the gift worker
  // (closeWallet) while the gift may be on its way into the wallet.
  const giftClaimRef = useRef<GiftLinkParams | null>(null);
  useEffect(() => {
    giftClaimRef.current = giftClaim;
  }, [giftClaim]);
  // "Uložil jsem si ho" was tapped on the unlock-screen gift-password
  // prompt — hides it for this render without touching the stored copy.
  const [strandedPwDismissed, setStrandedPwDismissed] = useState(false);

  // Set when the app was opened via a payment-request URL (spendrr.app/r#…).
  // Unlike a gift link this carries no secret and moves nothing by itself —
  // it is an ask, shown over whatever screen is active until the user either
  // pays it or dismisses it. It deliberately survives the unlock screen, so
  // "Odemknout a zaplatit" lands back on the same request.
  const [payRequestLink, setPayRequestLink] = useState<PaymentRequestParams | null>(null);
  // The request the user accepted, handed to Dashboard for the Send form and
  // cleared as soon as it takes it.
  const [payRequestHandoff, setPayRequestHandoff] = useState<{ destination: string; amountSats?: number } | null>(null);
  // Set when the app was opened via a profile link (spendrr.app/@name). Same
  // idea as the payment request above, minus the amount: shown over whichever
  // screen is active, steps aside for the unlock screen, comes back once a
  // wallet is open. The handoff to the send form reuses payRequestHandoff.
  const [profileLink, setProfileLink] = useState<string | null>(null);
  const [profileHidden, setProfileHidden] = useState(false);
  // "Odemknout a zaplatit" was tapped with no session open: the request page
  // steps aside so the unlock screen underneath can be used, and comes back
  // by itself once a wallet is actually open (the effect below).
  const [payRequestHidden, setPayRequestHidden] = useState(false);
  // PaymentRequestPage defers actually calling `onPay` by SHEET_EXIT_MS (its
  // own exit animation) via a setTimeout that captures whichever `onPay`
  // closure was current at the moment "Zaplatit" was tapped. If `screen`
  // changes in that window (e.g. auto-lock), the already-scheduled call
  // still runs with the stale value baked into that closure — reading
  // through a ref instead means it sees whatever is actually current when
  // it fires, not what was current when it was created.
  const screenRef = useRef(screen);
  const payRequestLinkRef = useRef(payRequestLink);
  useEffect(() => {
    screenRef.current = screen;
    payRequestLinkRef.current = payRequestLink;
  }, [screen, payRequestLink]);

  useEffect(() => {
    // Which screen to show next only depends on a synchronous localStorage
    // read — it doesn't need the ~4MB WASM SDK at all. The open (called
    // once a password is actually submitted) awaits ensureWasm() itself, so
    // starting the fetch here without blocking on it lets it load in the
    // background while the user is already looking at the unlock/onboarding
    // screen, instead of staring at the loading spinner for the entire
    // download+instantiation first.
    ensureWasm();
    if (isGiftPath(window.location.pathname)) {
      const decoded = decodeGiftFragment(window.location.hash);
      // Scrub the fragment immediately, before the claim flow even starts —
      // not just on the invalid/already-claimed path or on eventual onDone.
      // The fragment carries the gift mnemonic in the clear; the decoded
      // value is already safely in JS state (giftClaim) by the time this
      // runs, so leaving it in the URL bar a moment longer only adds
      // exposure (browser history, synced tab history) for no benefit.
      try {
        window.history.replaceState(null, "", "/");
      } catch {
        /* ignore */
      }
      if (decoded.ok && !hasClaimedGift(decoded.gift.id)) {
        setGiftClaim(decoded.gift);
      }
    } else if (isRequestPath(window.location.pathname)) {
      const decoded = decodeRequestFragment(window.location.hash);
      // Scrubbed for tidiness rather than for safety: unlike a gift
      // fragment there is no secret in here (see lib/paymentRequest.ts).
      // It still goes, so a reload doesn't reopen a request already dealt
      // with and the address/amount don't linger in synced tab history.
      try {
        window.history.replaceState(null, "", "/");
      } catch {
        /* ignore */
      }
      if (decoded.ok) setPayRequestLink(decoded.request);
    } else if (handleFromPath(window.location.pathname) !== null) {
      // Open to everyone, beta or not: its audience is people who have never
      // heard of the beta, or of Spendrr.
      // Scrubbed for the same tidiness reason as a request link: a reload
      // shouldn't reopen a page already dealt with.
      const name = handleFromPath(window.location.pathname);
      try {
        window.history.replaceState(null, "", "/");
      } catch {
        /* ignore */
      }
      setProfileLink(name);
    }
    void (async () => {
      const vault = loadVault();
      // One-time repair, awaited before the unlock screen shows (not
      // fire-and-forget) so a password submitted right away can't race the
      // IndexedDB delete below — see resetOnchainWalletDb()'s comment in
      // bark.ts. Clearing ONCHAIN_SCANNED_KEY alongside it makes the next
      // open's initialScan() rediscover any real onchain history the reset
      // just wiped the local record of.
      const hasAnyVault = vault !== null || hasDeviceVault();
      if (hasAnyVault && localStorage.getItem(ONCHAIN_BLOAT_FIX_KEY) !== "1") {
        await resetOnchainWalletDb();
        localStorage.removeItem(ONCHAIN_SCANNED_KEY);
        localStorage.setItem(ONCHAIN_BLOAT_FIX_KEY, "1");
      }
      // A passwordless gift wallet (deviceVault.ts) counts as a wallet: the unlock screen opens it by itself.
      setScreen(hasAnyVault ? { kind: "unlock" } : { kind: "onboarding" });
    })();
  }, []);

  useEffect(() => {
    if (screen.kind === "ready" && payRequestHidden) setPayRequestHidden(false);
  }, [screen.kind, payRequestHidden]);

  // Ask the browser to keep this origin's storage (the vault's only copy) out
  // of eviction, on every open. Throttled to once a day inside, so
  // a Firefox user who dismissed its prompt is not asked on every unlock;
  // create/import force it (finishWithMnemonic).
  useEffect(() => {
    if (screen.kind === "ready") void requestPersistentStorage();
  }, [screen.kind]);
  useEffect(() => {
    if (screen.kind === "ready" && profileHidden) setProfileHidden(false);
  }, [screen.kind, profileHidden]);

  // Set by Dashboard (via the onCriticalOpChange prop) while a send or exit
  // call is actually in flight — checked by the auto-lock timer below so it
  // never unmounts Dashboard mid-payment. A ref, not state: this changes
  // far more often than a render should care about, and the timer effect
  // only needs to read the latest value when it's about to fire.
  const criticalOpRef = useRef(false);

  // The debounced cloud-backup trigger for the currently-open wallet (see
  // lib/backup.ts), created fresh in openSession from the keys the wallet
  // worker derived. A ref, not state: Dashboard never receives the mnemonic
  // — nor could it, since the mnemonic never reaches this thread at all —
  // only this plain `() => void`, invoked when it detects a real balance or
  // history change. Null when backups are unavailable for this session.
  const backupTriggerRef = useRef<ReturnType<typeof createBackupUploader> | null>(null);

  // The cloud-backup AES-GCM key, kept for a second use: encrypting each
  // outgoing gift link's one-time mnemonic at rest (giftStore.ts). Null when
  // backups are unavailable this session — the 🎁 sender flow is then
  // disabled (it has no safe place to keep the reclaim seed).
  const giftEncryptionKeyRef = useRef<CryptoKey | null>(null);

  // The worker's serialized queue means one wallet.* call that never
  // resolves wedges every later call behind it forever — bark.ts's own
  // watchdog now recovers from that by terminating and recreating the
  // worker, but the in-memory wallet (and the mnemonic that only ever lived
  // inside that worker) is gone at that point either way. Force back to the
  // unlock screen so the user re-enters their password rather than being
  // left on a Dashboard whose wallet calls will now all fail with "Wallet
  // not open".
  useEffect(() => {
    setWorkerLostHandler((reason) => {
      // Keep the first reason: the relock itself tends to spin up a fresh
      // worker, and when that one fails too (offline, its script can't load)
      // its reason used to overwrite the one that actually explains the lock.
      setWorkerLostReason((current) => current ?? reason);
      setScreen({ kind: "unlock" });
    });
    return () => setWorkerLostHandler(null);
  }, []);

  // Auto-lock after inactivity — real funds sit behind whatever screen is
  // left open, so an unattended unlocked tab shouldn't stay unlocked
  // indefinitely. Locking just means dropping back to the "unlock" screen;
  // Dashboard's own unmount cleanup handles freeing the WASM wallet safely,
  // same as the manual lock button.
  useEffect(() => {
    if (screen.kind !== "ready") return;
    let timer: number;
    // A send/exit call actually in flight (criticalOpRef) must never be cut
    // off by unmounting Dashboard mid-payment — recheck shortly instead of
    // locking immediately, rather than silently dropping the user back to
    // "unlock" while they have no way to see whether the payment went
    // through.
    // A focused text field (destination address, LN invoice, amount, ...)
    // means the user is mid-entry — possibly having paused for a while to
    // think, re-check, or switch apps to copy something in, none of which
    // fire any of the ACTIVITY_EVENTS below. Losing that input to an
    // auto-lock would be far more disruptive than a few extra idle minutes,
    // so defer the same way an in-flight send does, for as long as the
    // field stays focused — normal inactivity locking resumes the moment
    // it's blurred, since blurring itself happens via a click/tap that's
    // already an activity event.
    const isEditingField = () => {
      const el = document.activeElement;
      return el instanceof HTMLElement && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.isContentEditable);
    };
    const lock = () => {
      // Checked at fire time (not captured once when the effect starts) so
      // flipping the Settings toggle takes effect immediately, without
      // needing to re-run this effect.
      // A passwordless gift wallet has nothing to ask on unlock, so locking it would only reopen it.
      if (!isAutoLockEnabled() || loadVault() === null || criticalOpRef.current || giftClaimRef.current !== null || isEditingField()) {
        timer = window.setTimeout(lock, 2000);
        return;
      }
      setScreen({ kind: "unlock" });
    };
    const scheduleLock = () => {
      window.clearTimeout(timer);
      timer = window.setTimeout(lock, AUTO_LOCK_MS);
    };
    // `scroll` is one of the few DOM events that does NOT bubble — scrolling
    // an inner element (a modal, the tx history list, Settings) only fires
    // on that element, never on `window`, unless the listener is registered
    // for the capture phase instead. Without `capture: true` here, a user
    // scrolling through history for several minutes was real activity the
    // timer never saw, so it locked out from under them mid-use.
    ACTIVITY_EVENTS.forEach((e) => window.addEventListener(e, scheduleLock, { passive: true, capture: e === "scroll" }));
    scheduleLock();
    return () => {
      window.clearTimeout(timer);
      ACTIVITY_EVENTS.forEach((e) => window.removeEventListener(e, scheduleLock, { capture: e === "scroll" }));
    };
  }, [screen.kind]);

  // Set once a wallet.worker "open" call has actually needed the fallback
  // chain source (see below) — read by Dashboard.tsx to show a small notice
  // that it's currently trusting mempool.space rather than second.tech's
  // own esplora mirror, since that's a real (if minor) trust change the
  // user should be able to see, even though nothing they have to act on.
  const [usingFallbackChainSource, setUsingFallbackChainSource] = useState(false);

  // Opens a wallet session from any of the three seed sources (see
  // PrepareSource in lib/walletSession.ts). The plaintext mnemonic is
  // resolved inside the wallet worker and never crosses back here: for the
  // password path this function only ever holds the *password* and the
  // derived, non-extractable backup keys. That's the whole point of the
  // two-step prepareSession/openHeldWallet shape — this realm is where
  // React, jsqr and every other dependency live, i.e. the largest attack
  // surface the app has, and it used to decrypt the vault itself.
  const openSessionInner = useCallback(async (source: PrepareSource, allowDbWipeRetry: boolean, tryRestoreBackup = false) => {
    // Step one: the worker decrypts the vault (or unwraps the biometric
    // one), holds the seed, and derives the cloud-backup keys from it. A
    // wrong password fails here, before any WASM/IndexedDB work — the
    // sentinel VAULT_DECRYPT_FAILED, mapped to a message by the callers
    // below.
    const { backupKeys, rehashedVault } = await prepareSession(source);

    if (source.kind === "vault" && rehashedVault) {
      // The vault was still on the legacy PBKDF2 iteration count and the
      // worker has re-encrypted it at the current one. Best-effort, silent,
      // and never allowed to fail the unlock.
      try {
        saveVault(rehashedVault);
        // Same password, but a fresh salt — which is enough to invalidate
        // the exit destination's authentication tag and turn the final exit
        // claim into a permanent "this address is not what you saved"
        // refusal. Re-tag under the new vault rather than letting a silent
        // background upgrade lock funds out of a running exit.
        // Only over an address the old tag vouches for (exitDestinationTag.ts).
        await rekeyStoredExitDestination(
          { password: source.password, vault: source.vault },
          { password: source.password, vault: rehashedVault },
        );
      } catch {
        // Ignored — the vault just stays on the old iteration count.
      }
    }

    // Cloud backup restore (see ARCHITECTURE.md's backup section / lib/backup.ts)
    // — only on the import/recovery path, never for a freshly generated
    // mnemonic (create-confirm), which can't possibly have a prior backup.
    // Runs before the SDK has ever opened either local database this
    // session — deliberately, after an earlier close-then-restore-then-reopen
    // design hit two real bugs during a live recovery test: it silently
    // dropped any IndexedDB store the SDK creates lazily on first real use
    // rather than upfront, and even after fixing that, the version-bump
    // needed to create a missing store could get stuck on IndexedDB's
    // `blocked` event (closeWallet() resolving doesn't guarantee the WASM
    // side's own connection has actually released yet), leaving the DB
    // briefly inconsistent. Restoring before anything has ever opened these
    // DB names this session removes that race entirely — see
    // backupStore.ts's restoreDatabase() for the rest of the story.
    // Beyond the explicit import/recovery case above, also attempt a restore
    // on a plain *unlock* when the local DB looks empty — that happens if
    // the browser has wiped/reset IndexedDB (storage pressure, partial
    // "clear site data") while btc-wallet-vault in localStorage survived.
    // Without this, the line below would open a blank local DB, and the
    // one-shot uploadBackupNow() a few lines down would then commit that
    // near-empty state over a perfectly good server backup — permanently,
    // since the server only keeps one blob per wallet. That's the exact
    // class of loss this whole feature exists to prevent (see ARCHITECTURE.md's
    // STOP_GAP note). hasAnyLocalWalletData() is a cheap count()-based check
    // (not a full dump), so it's safe to run on every unlock. If the check
    // itself fails for any reason, default to "data present" — restoring
    // unnecessarily risks clobbering current local state with an older
    // backup, which is worse than just skipping this safety net for once.
    const shouldAttemptRestore = tryRestoreBackup || !(await hasAnyLocalWalletData().catch(() => true));
    // Set only when a restore was actually attempted and threw. Continuing
    // into the normal open is still right (see the catch below), but backing
    // *up* afterwards is not: applyFetchedBackup() writes the two databases
    // one after the other, and restoreDatabase() clears each store before
    // refilling it, so a throw partway through leaves local state that is a
    // strict subset of what the server still holds. The one-shot upload
    // below would then dump exactly that, verify it round-trips (it does —
    // it's perfectly valid ciphertext, just missing data), and commit it
    // over the last good backup. There is only one blob per wallet, so that
    // is unrecoverable, and it is the same class of loss this whole feature
    // exists to prevent. Skip every upload for this session instead and let
    // the user reopen the app once the underlying problem is gone.
    //
    // Deliberately covers a *fetch* failure too, not just a half-finished
    // write — which is the likelier trigger (offline, a 500) and looks
    // harmless because nothing was written locally. It isn't: a restore is
    // only ever attempted when the local databases are empty or this is an
    // import, so "the restore didn't happen" and "local state is empty" are
    // the same situation, and uploading empty state is precisely the
    // overwrite this guard exists to stop.
    // Seeded from the *persisted* latch, not `false`: a restore failure
    // switches uploads off for the session it happened in, but the danger
    // outlives that session. The SDK's own lossy, key-gap-limited recovery scan
    // (run by openHeldWallet below when the restore didn't deliver) leaves
    // the local DB holding a strict subset of what the server still has. On
    // the *next* plain unlock hasAnyLocalWalletData() then reports "data
    // present", shouldAttemptRestore is false, and the one-shot
    // uploadBackupNow() further down commits that subset over the last good
    // server blob — permanently, since there's only one blob per wallet.
    // That's the exact loss this whole feature exists to prevent (see
    // ARCHITECTURE.md's STOP_GAP note), so the latch has to persist until a
    // restore genuinely succeeds.
    let restoreFailed = isRestoreFailureLatched();
    let restoreSucceeded = false;
    if (shouldAttemptRestore) {
      try {
        // backupKeys is null only when the worker couldn't derive them (or
        // couldn't hand them across) — treat that as "restore unavailable",
        // which lands in the same catch and therefore also switches uploads
        // off for the session. That's the conservative direction: local
        // state may be empty and we have no way to check what the server
        // holds, so writing anything back would risk exactly the overwrite
        // described below.
        if (!backupKeys) throw new Error("backup keys unavailable");
        const fetched = await fetchAndDecryptBackup(backupKeys);
        if (fetched) {
          await applyFetchedBackup(fetched);
          // Only a restore that actually pulled real data down and applied
          // it clears the latch. A 404 (fetched === null) means the server
          // has no blob to restore *from*, which is not evidence that local
          // state is whole — so a pre-existing latch stays set.
          restoreSucceeded = true;
        }
      } catch (e) {
        // Best-effort — network hiccup, corrupt backup, decrypt failure, or
        // a restore write that failed partway through. Nothing has opened
        // the wallet yet at this point, so it's always safe to just
        // continue into the normal open below, which then either finds
        // partially-or-fully-restored local state (better than nothing) or
        // falls back to the SDK's own lossy recovery scan.
        console.error("[backup] restore failed, continuing with normal open", e);
        restoreFailed = true;
        // Surfaced in Settings under its own banner rather than only the
        // console — a silently skipped backup is exactly the kind of thing
        // that made the two launch-day backup bugs undiagnosable from a real
        // phone, and this one switches uploads off until a restore succeeds.
        recordRestoreFailure(e);
      }
    }
    // Cleared only on a genuinely successful restore this session — NOT
    // merely because this particular open didn't itself re-hit the failure.
    // A healthy-looking local DB on a later unlock is precisely the state
    // the SDK's lossy scan leaves behind, so "no error this time" says
    // nothing about whether local state is complete again.
    if (restoreSucceeded) {
      restoreFailed = false;
      clearRestoreFailure();
    }

    let wallet: WalletClient | undefined;
    let primaryError: unknown;
    // An exit the app believes is live keeps bark's chain traffic off
    // Second's esplora from the first request (walletWorkerGuard.ts,
    // exitChainRedirect).
    const exitChain = exitMayBeLive();
    try {
      wallet = await openHeldWallet(false, exitChain);
    } catch (e) {
      primaryError = e;
      // The local wallet DB is keyed by db name, not by mnemonic — a
      // leftover DB from a different wallet (e.g. one created before a
      // reset) makes Wallet.open reject this mnemonic as "incorrect
      // mnemonic". Since this app only ever holds one wallet at a time,
      // it's safe to wipe that stale DB and retry once — but only when the
      // error actually is that specific mismatch, and only on the
      // onboarding/import path. A plain unlock() hitting this same catch on
      // a transient network/server error (not a mnemonic mismatch) must
      // never wipe the local IndexedDB — that's the worst possible moment
      // to lose local SDK state (out-of-round VTXOs, in-progress exit
      // bookkeeping), especially if the network is down because it's
      // needed for a unilateral exit.
      const isMnemonicMismatch = e instanceof Error && e.message.includes("incorrect mnemonic");
      if (allowDbWipeRetry && isMnemonicMismatch) {
        // Whatever a restore above just wrote into the local DB is about to
        // be deleted along with it — restoreSucceeded having been true says
        // nothing about the state deleteWalletDb() is about to leave behind.
        // Re-latch unconditionally, before the wipe, and regardless of
        // whether the retry below succeeds: either way, local state past
        // this point is at best the SDK's own lossy STOP_GAP scan, never the
        // backup that was just restored, so it must not be trusted as
        // "whole" and uploaded back over the one good server copy.
        if (restoreSucceeded) {
          restoreFailed = true;
          recordRestoreFailure(new Error("local DB wiped after restore (stale-DB mnemonic-mismatch retry)"));
        }
        try {
          await quarantineWalletDbs();
          await deleteWalletDb();
          // The onchain receive address cache (see onchainReceiveAddress.ts)
          // is keyed to whatever wallet's HD derivation produced it — the
          // stale DB just deleted belongs to a *different* wallet than the
          // mnemonic being opened here, so any cached address (and the
          // outpoint baseline used to detect it's been paid) is for a wallet
          // this session no longer has any relation to. Showing it as "the"
          // receive address for the new wallet would offer an address the
          // new mnemonic can't actually spend from.
          clearStoredReceiveAddress();
          wallet = await openHeldWallet(false, exitChain);
        } catch (e2) {
          primaryError = e2;
        }
      }
    }
    if (!wallet) {
      // The primary open failed for a reason that wasn't (or wasn't only) a
      // mnemonic/DB mismatch — most plausibly second.tech's esplora mirror
      // being unreachable, since that's the one dependency an otherwise
      // fine device/mnemonic/password can't route around on its own.
      // Automatic and silent rather than an opt-in toggle: a person locked
      // out mid-emergency has no way to know *which* box to tick, and this
      // retry touches no local state either way — it only changes which
      // chain source the wallet talks to. If it still fails, the error
      // actually shown is the primary one (more likely to be meaningful —
      // e.g. a real password/DB problem — than whatever this retry hit).
      try {
        wallet = await openHeldWallet(true, exitChain);
        setUsingFallbackChainSource(true);
      } catch {
        throw primaryError;
      }
    } else {
      setUsingFallbackChainSource(false);
    }

    // One-shot: back this wallet up right after every successful
    // open/unlock, not just on import — closes the exposure window for a
    // wallet that has never backed up yet, and keeps an existing backup
    // fresh even if nothing changes for a while. Fire-and-forget; failures
    // are only ever visible via Settings' backup status line.
    //
    // The keys came out of prepareSession above (derived in the worker from
    // the seed, which is the only thing that can derive them) and only the
    // result — a public lookupKey plus a non-extractable CryptoKey — is
    // kept alive in backupTriggerRef for the rest of the session. Nothing
    // mnemonic-shaped is ever captured in a closure here, and nothing on
    // this thread could re-derive these even if it wanted to.
    // A latch set by an upload's version conflict (not a failed restore) is
    // lifted when the server still holds exactly the version this device
    // last committed, i.e. the conflict was this device racing itself. See
    // clearSelfInflictedConflictLatch. Only reached while latched, so the
    // extra meta round trip never touches a normal unlock.
    if (restoreFailed && backupKeys && (await clearSelfInflictedConflictLatch(backupKeys))) {
      restoreFailed = false;
    }
    // Still latched: check in the background whether the server backup holds
    // anything this device lacks. If not, the latch goes and uploads resume
    // on the next open. See liftConflictLatchIfCovered.
    if (restoreFailed && backupKeys) void liftConflictLatchIfCovered(backupKeys);
    if (restoreFailed || !backupKeys) {
      // See restoreFailed's own comment above: local state may be a subset
      // of the server's, so nothing may be written back — this session or
      // any later one, until a restore succeeds and clears the latch. A
      // missing key is the same situation for a different reason.
      //
      // cancel() first: a previous uploader (a prior wallet in this same
      // session, e.g. via resetWallet then a fresh import) may still have an
      // armed debounce timer. Dropping the reference alone doesn't stop it —
      // see createBackupUploader's own comment on why that's the exact bug
      // this fixes.
      backupTriggerRef.current?.cancel();
      backupTriggerRef.current = null;
      giftEncryptionKeyRef.current = null;
    } else {
      // Same reasoning as the cancel() above: retire whatever uploader (and
      // whatever armed timer) belonged to a previous wallet in this session
      // before replacing the ref with one for this wallet's keys.
      backupTriggerRef.current?.cancel();
      // Not `uploadBackupNow(backupKeys)` directly: see
      // waitForLocalStateToSettle's own comment for the real incident this
      // fixes — Wallet.open's recovery scan resolving doesn't guarantee
      // every VTXO it found is durably written yet, and uploading on the
      // very next tick could back up (and, via a later restore, permanently
      // freeze) an incomplete view of the wallet. Fire-and-forget, same as
      // uploadBackupNow always was — doesn't delay the unlock/import screen
      // transition, which has already happened by this point.
      void (async () => {
        // The delegated variant, for everyone (was V2 only): the interactive
        // maintenance() waits for a round whenever a VTXO is due, and its 60s
        // ceiling then reset the worker and relocked the wallet right after
        // unlock. settleMaintenanceDelegated, not the bare scheduler: when the
        // schedule is skipped this loop still needs the sync() it would
        // otherwise be left without (see createSettleMaintenance).
        // Beta, refresh engine live: no maintenanceDelegated() at all, but
        // this loop still needs its own server round-trip, which is sync().
        await waitForLocalStateToSettle(
          wallet,
          sessionEngineMode() === "live" ? () => wallet.sync() : () => settleMaintenanceDelegated(wallet),
        );
        uploadBackupNow(backupKeys);
      })();
      backupTriggerRef.current = createBackupUploader(backupKeys);
      // Reused (not re-derived) to encrypt the one-time mnemonic of each
      // outgoing gift link at rest in IndexedDB — see giftStore.ts. Same
      // non-extractable AES-GCM key that protects the cloud backup blob.
      giftEncryptionKeyRef.current = backupKeys.encryptionKey;
    }

    if (celebrateUnlockRef.current) {
      // The wallet is open for real at this point — this only delays the
      // swap to the dashboard so the padlock can finish opening.
      setUnlockOpened(true);
      hapticSuccess();
      const reduced = prefersReducedMotion();
      await new Promise((r) => setTimeout(r, reduced ? 200 : UNLOCK_CELEBRATION_MS));
      const openedWallet = wallet;
      const enter = () => setScreen({ kind: "ready", wallet: openedWallet });
      if (!reduced && !document.hidden && document.startViewTransition) {
        const transition = document.startViewTransition(() => flushSync(enter));
        // The browser skips the animation (rejecting these) e.g. when the
        // tab goes hidden mid-transition; the swap itself still happens.
        transition.ready.catch(() => {});
        transition.finished.catch(() => {});
        // Awaited so the caller's `finally` (busy/phase reset) can't
        // re-render the unlock screen back to a closed padlock before the
        // transition has snapshotted it.
        await transition.updateCallbackDone.catch(enter);
      } else {
        enter();
      }
    } else {
      setScreen({ kind: "ready", wallet });
    }
    // initialScan() finds pre-existing onchain history that a fresh
    // OnchainWallet instance wouldn't otherwise know about (sync() only
    // covers addresses this instance has itself revealed) — needed once per
    // wallet, not on every unlock, and never blocks reaching the dashboard
    // since it's a gap-limited scan that can take a while.
    if (localStorage.getItem(ONCHAIN_SCANNED_KEY) !== "1") {
      // Neither guard existed before: no pushWorkerWatchdogOverride meant a
      // slow gap-limited scan could trip bark.ts's own crash-recovery
      // watchdog and tear down the worker mid-scan (forcing a re-unlock for
      // a reason that had nothing to do with anything the user did); no
      // pushOnchainScanActive meant Dashboard's refresh() cycle — running
      // every ~4s for the whole session — had no way to know this was
      // running and queued behind it, so it showed "Počkej chvíli…" for
      // what was really just this scan hogging the shared worker queue.
      //
      // Deliberately SEND_WATCHDOG_MS (3min), not the full 20min
      // ONCHAIN_SYNC_TIMEOUT_MS the 30s onchain-balance poll gets: that
      // override is shared globally (watchdogOverrideMs in bark.ts takes the
      // max of every currently-active push, not just this call's own), so
      // pushing the 20min one here briefly gave *every other* concurrent
      // wallet.* call — including a payment sent right after unlock, which
      // this runs immediately after — up to 20 minutes of rope before
      // anything would reject it. Every payment call now has its own
      // withTimeout regardless (see SendPanel's send()), so this only needs
      // to be wide enough to stop THIS scan specifically from tripping the
      // default watchdog — not as wide as the address-count-scaling sync()
      // that justifies the 20min constant elsewhere.
      const popWatchdog = pushWorkerWatchdogOverride(SEND_WATCHDOG_MS);
      const popScanActive = pushOnchainScanActive();
      wallet.onchainWallet
        .initialScan()
        .then(() => localStorage.setItem(ONCHAIN_SCANNED_KEY, "1"))
        .catch(() => {
          // Best-effort — if it fails (offline, etc.), the flag stays
          // unset so it's simply retried on the next unlock.
        })
        .finally(() => {
          popWatchdog();
          popScanActive();
        });
    }
  }, []);

  // Once prepareSession() above resolves, the worker is holding this
  // session's plaintext seed, waiting for the openHeld that consumes it. If
  // the open then fails for any reason, that openHeld is never coming — and
  // nothing else would ever tell the worker so: the failure path drops back
  // to the unlock screen without mounting Dashboard, whose unmount cleanup
  // is the only other caller of closeWallet(). The seed used to sit there
  // for as long as the tab stayed open, while the app looked locked, and a
  // replayed openHeld could consume it with no password at all.
  //
  // A wrapper rather than a try/catch buried inside the function above, so
  // this cleanup can't be missed by a future caller — and so the diff stays
  // readable in a file where that matters.
  const openSession = useCallback(
    async (source: PrepareSource, allowDbWipeRetry: boolean, tryRestoreBackup = false) => {
      try {
        await openSessionInner(source, allowDbWipeRetry, tryRestoreBackup);
      } catch (e) {
        // Harmless when prepareSession itself was what failed (a wrong
        // password holds no seed and opens no wallet — close is then a
        // no-op), and never allowed to mask the real error: if the close
        // fails too, the worker's own expiry backstop still drops the seed.
        await closeWallet().catch(() => {});
        throw e;
      }
    },
    [openSessionInner],
  );

  // Maps the worker's sentinel failures onto something a user can act on.
  // Anything else is passed through as-is — those are SDK/network errors
  // whose own text is more informative than a generic message would be.
  const describeOpenError = useCallback(
    (e: unknown): string | null => {
      const message = e instanceof Error ? e.message : String(e);
      // Not an error to print: the sheet explains it (see openElsewhere).
      if (message === WALLET_OPEN_ELSEWHERE) {
        setOpenElsewhere(true);
        return null;
      }
      if (message === VAULT_DECRYPT_FAILED) return t("Nesprávné heslo nebo poškozený trezor.");
      if (message === BIO_DECRYPT_FAILED) {
        return t("Otisk se ověřil, ale trezor se nepodařilo rozšifrovat. Odemkni heslem.");
      }
      // The worker was terminated between resolving the seed and opening the
      // wallet — bark.ts's watchdog, or a worker crash. Nothing is wrong
      // with the vault; the attempt just has to start over.
      if (message === NO_HELD_MNEMONIC) return t("Odemykání bylo přerušeno. Zkus to prosím znovu.");
      return message;
    },
    [t],
  );

  const finishWithMnemonic = useCallback(
    async (mnemonic: string, password: string, isImport: boolean) => {
      setBusy(true);
      setError(null);
      try {
        // Before saveVault: replacing the vault under a wallet another tab has
        // open would leave that tab running one wallet over another's vault.
        if (await walletTabLock.heldElsewhere()) {
          setOpenElsewhere(true);
          return;
        }
        const vault = await encryptMnemonic(mnemonic, password);
        saveVault(vault);
        // Still close to the tap, which Firefox's permission prompt wants.
        void requestPersistentStorage({ force: true });
        setJustOnboarded(true);
        // Only the import path can possibly have a prior backup — a
        // brand-new mnemonic from create-confirm never does, so skip the
        // network round-trip for it entirely.
        //
        // The mnemonic is unavoidably in this realm on the create/import
        // path (it was just shown to the user word by word, or typed in by
        // them), so handing it to the worker here is not a new exposure —
        // it just means every session goes through the same single open
        // path. See PrepareSource's "mnemonic" variant.
        await openSession({ kind: "mnemonic", mnemonic }, true, isImport);
      } catch (e) {
        setError(describeOpenError(e));
      } finally {
        setBusy(false);
      }
    },
    [openSession, describeOpenError],
  );

  const unlock = useCallback(
    async (password: string) => {
      const vault = loadVault();
      if (!vault) {
        setScreen({ kind: "onboarding" });
        return;
      }
      setJustOnboarded(false);
      setBusy(true);
      setError(null);
      setWorkerLostReason(null);
      celebrateUnlockRef.current = true;
      // Everything below is wrapped in one try/finally so `busy` always
      // clears, however it exits — a throw from any step here used to leave
      // the unlock button stuck on "Odemykám…" forever (nothing else ever
      // resets `busy`), only recoverable by reloading the page. Individual
      // steps below still have their own try/catch for user-facing error
      // messages or intentionally-ignored failures; this outer one is purely
      // a safety net.
      try {
        // The password crosses into the wallet worker; the mnemonic never
        // comes back out. Decrypting the vault here — which is what this
        // used to do — put the plaintext seed in the same realm as React
        // and every other main-thread dependency for the length of an
        // unlock. The legacy-iteration rehash and the exit-tag re-signing
        // that used to sit here moved into openSession for the same reason
        // (both need the plaintext seed).
        await openSession({ kind: "vault", vault, password }, false);
        // A successful unlock proves the user now has the auto-generated
        // gift password — safe to drop the plaintext copy.
        clearPendingGiftPassword();
      } catch (e) {
        setError(describeOpenError(e));
      } finally {
        celebrateUnlockRef.current = false;
        setUnlockOpened(false);
        setBusy(false);
      }
    },
    [openSession, describeOpenError],
  );

  // The user's own lock (double tap), never an auto-lock: a press, the
  // dashboard crossfades into a padlock that closes. V2 only; otherwise a
  // plain swap.
  const lockByHand = useCallback(() => {
    const plain = () => setScreen({ kind: "unlock" });
    if (getDesignVersion() !== "v2" || prefersReducedMotion() || document.hidden) {
      plain();
      return;
    }
    hapticTap();
    const enter = () => {
      setUnlockOpened(true);
      plain();
    };
    if (lockCloseTimerRef.current !== null) window.clearTimeout(lockCloseTimerRef.current);
    lockCloseTimerRef.current = window.setTimeout(() => {
      lockCloseTimerRef.current = null;
      setUnlockOpened(false);
    }, LOCK_CLOSE_DELAY_MS);
    if (document.startViewTransition) {
      const transition = document.startViewTransition(() => flushSync(enter));
      transition.ready.catch(() => {});
      transition.finished.catch(() => {});
    } else {
      enter();
    }
  }, []);

  const unlockBiometric = useCallback(async () => {
    setJustOnboarded(false);
    setBusy(true);
    setError(null);
    setWorkerLostReason(null);
    celebrateUnlockRef.current = true;
    try {
      // Stops one step short of the mnemonic: WebAuthn has to run on this
      // thread (navigator.credentials doesn't exist in a worker), but what
      // comes back is a non-extractable CryptoKey plus the ciphertext it
      // opens — the worker does the actual unwrap. See BiometricUnwrap.
      // Before the fingerprint prompt, not after it: prepareSession would
      // refuse anyway, but only once the user had already been asked for it.
      if (await walletTabLock.heldElsewhere()) {
        setOpenElsewhere(true);
        return;
      }
      const unwrap = await unlockWithBiometric();
      await openSession({ kind: "bioVault", ...unwrap }, false);
    } catch (e) {
      setError(describeOpenError(e));
    } finally {
      celebrateUnlockRef.current = false;
      setUnlockOpened(false);
      setBusy(false);
    }
  }, [openSession, describeOpenError]);

  // The wallet of a gift link made without a password (deviceVault.ts). Same open path as the fingerprint ("bioVault"):
  // the worker gets the device key and unwraps the seed, this thread never holds it. Opening it on a later start also
  // raises the setup sheet that turns it into a normal password wallet.
  const [setupReason, setSetupReason] = useState<"gift" | "spend" | null>(null);
  const unlockDevice = useCallback(async () => {
    setJustOnboarded(false);
    setBusy(true);
    setError(null);
    setWorkerLostReason(null);
    try {
      if (await walletTabLock.heldElsewhere()) {
        setOpenElsewhere(true);
        return;
      }
      const unwrap = await loadDeviceUnwrap();
      await openSession({ kind: "bioVault", ...unwrap }, false);
      setSetupReason((r) => r ?? "gift");
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      setError(
        message === DEVICE_KEY_MISSING || message === BIO_DECRYPT_FAILED
          ? t("Peněženku se na tomhle zařízení nepodařilo otevřít. Obnov ji ze seed fráze.")
          : describeOpenError(e),
      );
    } finally {
      setBusy(false);
    }
  }, [openSession, describeOpenError, t]);

  const [showResetConfirm, setShowResetConfirm] = useState(false);
  // Whether a unilateral exit is mid-flight when the reset dialog opens.
  // Deleting the wallet then is not the harmless "your seed still has the
  // funds" operation the dialog otherwise (correctly) describes: an exit in
  // progress lives entirely in the local IndexedDB deleteWalletDb() wipes —
  // which transactions were built, which already went out, how far up the
  // tree it got — and re-deriving it from a restored seed means asking the
  // Ark server, the very party a unilateral exit exists to work without.
  //
  // A seeded default from localStorage, so this also warns on the unlock
  // screen where no wallet is open to ask; upgraded to the SDK's own answer
  // whenever one is.
  const [resetPendingExit, setResetPendingExit] = useState(false);
  const requestReset = useCallback(() => {
    if (screen.kind !== "ready") {
      // From the unlock screen, another tab may have this wallet open, and
      // deleting its IndexedDB then does not fail: the delete waits until that
      // tab closes the wallet and wipes it at that moment. Say so instead.
      void walletTabLock.heldElsewhere().then((elsewhere) => {
        if (elsewhere) {
          setOpenElsewhere(true);
          return;
        }
        setResetPendingExit(exitMayBeLive());
        setShowResetConfirm(true);
      });
      return;
    }
    setResetPendingExit(exitMayBeLive());
    setShowResetConfirm(true);
    const wallet = screen.wallet;
    void withTimeout(wallet.getExitVtxos(), WALLET_CALL_TIMEOUT_MS, TIMEOUT_MESSAGE)
      .then((vtxos) => setResetPendingExit(vtxos.some((v) => isLiveExitState(v.state.type))))
      .catch(() => {
        // Best-effort: keep whatever the localStorage hint said. Failing to
        // reach the wallet must never *downgrade* the warning — an offline
        // check is exactly the situation where an exit is most likely to be
        // the reason the user is here.
      });
  }, [screen]);

  const resetWallet = useCallback(() => {
    setShowResetConfirm(false);
    // Capture the live wallet (if any is open) before flipping the screen —
    // Dashboard's own unmount cleanup also calls closeWallet(), but that's
    // fire-and-forget from a React cleanup function, so it can't be awaited
    // here. closeWallet() waits for the worker's request queue to drain
    // before it calls wallet.free(), so deleting the IndexedDB only after
    // that resolves is deterministic — no guessed delay, and no risk of the
    // delete request landing while the worker still has the DB open, which
    // would make Wallet.open reject a different future mnemonic as
    // "incorrect mnemonic".
    const liveWallet = screen.kind === "ready" ? screen.wallet : null;
    backupTriggerRef.current?.cancel();
    backupTriggerRef.current = null;
    void clearAllLocalWalletState();
    setScreen({ kind: "onboarding" });
    void (async () => {
      if (liveWallet) await closeWallet(liveWallet);
      await deleteWalletDb();
    })();
  }, [screen]);

  // A passwordless wallet opens by itself on the unlock screen. One attempt per visit to that screen, so a failure shows
  // its error with a retry button instead of looping; a claim in progress opens the wallet itself (GiftClaimModal).
  const deviceAttemptRef = useRef(false);
  useEffect(() => {
    if (screen.kind === "ready") {
      deviceAttemptRef.current = false;
      return;
    }
    if (screen.kind !== "unlock" || giftClaim || deviceAttemptRef.current) return;
    if (loadVault() !== null || !hasDeviceVault()) return;
    deviceAttemptRef.current = true;
    void unlockDevice();
  }, [screen.kind, giftClaim, unlockDevice]);

  // Anything that needs a password when there is none yet (a larger payment, the exit, Settings) asks for the sheet.
  useEffect(() => {
    const open = () => {
      if (loadVault() === null && hasDeviceVault()) setSetupReason((r) => r ?? "spend");
    };
    window.addEventListener(PASSWORD_SETUP_EVENT, open);
    return () => window.removeEventListener(PASSWORD_SETUP_EVENT, open);
  }, []);

  // The paying side of a payment request (spendrr.app/r#…). Mounted in two
  // places below rather than wrapped around the whole screen machine: over
  // the live Dashboard when a session is open, and over a plain branded
  // backdrop when there isn't one — which is the common case, since the
  // person opening a request link is usually not this wallet's owner and may
  // not have Spendrr at all.
  const payRequestShown = payRequestLink !== null && !payRequestHidden;
  // Recomputed only when the screen state machine actually moves — vault
  // creation/import/reset always comes with a transition — instead of
  // re-parsing the whole vault out of localStorage on every unrelated App
  // re-render (autolock churn, showResetConfirm, giftClaim, ...) while this
  // page happens to be up.
  // screen.kind isn't read inside the callback — it's here purely as the
  // recompute trigger, since vault creation/import/reset always comes with
  // a screen transition.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const hasWallet = useMemo(() => loadVault() !== null || hasDeviceVault(), [screen.kind]);
  const payRequestEl =
    payRequestLink && payRequestShown ? (
      <PaymentRequestPage
        request={payRequestLink}
        hasWallet={hasWallet}
        walletReady={screen.kind === "ready"}
        onPay={() => {
          const currentScreen = screenRef.current;
          const currentLink = payRequestLinkRef.current;
          if (currentScreen.kind === "ready" && currentLink?.address) {
            setPayRequestHandoff({ destination: currentLink.address, amountSats: currentLink.amountSats });
            setPayRequestLink(null);
            return;
          }
          // No session yet: get out of the way so the unlock screen can be
          // used. The request itself is kept and re-shown once it opens.
          setPayRequestHidden(true);
        }}
        onDismiss={() => setPayRequestLink(null)}
      />
    ) : null;

  // The public page for a @handle (spendrr.app/@name), mounted in the same two
  // places as the payment request page above and for the same reason.
  const profileShown = profileLink !== null && !profileHidden;
  const profileEl =
    profileLink && profileShown ? (
      <ProfilePage
        name={profileLink}
        hasWallet={hasWallet}
        walletReady={screen.kind === "ready"}
        onPay={(destination) => {
          if (screenRef.current.kind === "ready") {
            setPayRequestHandoff({ destination });
            setProfileLink(null);
            return;
          }
          setProfileHidden(true);
        }}
        onDismiss={() => setProfileLink(null)}
      />
    ) : null;

  // Gift-link claim (spendrr.app/g#…). Deliberately handled before
  // the normal screen machine: for a brand-new recipient the modal shows
  // over a plain backdrop while the wallet is created + the gift pulled in
  // on the background; once a session is open it renders over the live
  // Dashboard. Normal onboarding/import/unlock are untouched by this path.
  if (giftClaim) {
    const liveWallet = screen.kind === "ready" ? screen.wallet : null;
    return (
      <>
        {liveWallet ? (
          <Dashboard
            wallet={liveWallet}
            onLock={lockByHand}
            onResetWallet={requestReset}
            justOnboarded={justOnboarded}
            usingFallbackChainSource={usingFallbackChainSource}
            onCriticalOpChange={(active) => {
              criticalOpRef.current = active;
            }}
            giftEncryptionKey={giftEncryptionKeyRef.current}
            giftClaimActive={true}
            onWalletStateChanged={() => backupTriggerRef.current?.trigger()}
          />
        ) : (
          <div className="centered-screen">
            <Brand />
          </div>
        )}
        <GiftClaimModal
          gift={giftClaim}
          liveWallet={liveWallet}
          onOpenFresh={(mnemonic) => openSession({ kind: "mnemonic", mnemonic }, false, false)}
          onOpenDevice={async () => {
            const unwrap = await loadDeviceUnwrap();
            await openSession({ kind: "bioVault", ...unwrap }, false, false);
          }}
          onOpenVault={(password) => {
            const v = loadVault();
            return v
              ? openSession({ kind: "vault", vault: v, password }, false, false)
              : Promise.reject(new Error(t("Trezor nenalezen.")));
          }}
          onDone={() => {
            try {
              window.history.replaceState(null, "", "/");
            } catch {
              /* ignore */
            }
            setGiftClaim(null);
          }}
        />
      </>
    );
  }

  // Before the screen machine, and only while nothing is open: the request
  // is the whole reason this app was launched, so it shows over a plain
  // backdrop rather than behind an unlock or onboarding screen the visitor
  // did not ask for. Exception: on "unlock" specifically, the visitor may
  // well be this wallet's own owner (this device already has a vault), so
  // the stranded-gift-password reminder that would otherwise show on the
  // unlock screen below still needs to surface here too — it's the same
  // one-time recovery prompt, just not gated behind an extra "Odemknout a
  // zaplatit" tap first.
  if ((payRequestShown || profileShown) && screen.kind !== "ready") {
    const strandedPw = screen.kind === "unlock" && !strandedPwDismissed ? getPendingGiftPassword() : null;
    return (
      <>
        <div className="centered-screen">
          <Brand />
        </div>
        {payRequestEl}
        {profileEl}
        {strandedPw && <GiftPasswordModal password={strandedPw} onDone={() => setStrandedPwDismissed(true)} />}
      </>
    );
  }

  const startCreate = async () => {
    // generateMnemonic() needs the WASM module, which may still be loading
    // in the background (kicked off on mount but no longer blocking this
    // screen from showing) — wait for it here instead of assuming it's
    // already ready.
    setBusy(true);
    try {
      const mnemonic = await generateMnemonic();
      setSeedFullyRevealed(false);
      setScreen({ kind: "create-confirm", mnemonic });
    } finally {
      setBusy(false);
    }
  };

  // A Home Screen web app on iOS does not share storage with Safari, so the
  // cheapest moment to move there is before a wallet exists at all.
  const throughInstallGate = (then: () => void) => {
    if (isIosBrowserTab() && !installGateShownRef.current) {
      installGateShownRef.current = true;
      setInstallGate({ then });
      return;
    }
    then();
  };

  if (screen.kind === "loading") {
    return (
      <div className="centered-screen">
        <Brand />
        <div className="spinner" role="status" aria-label={t("Načítám")} />
      </div>
    );
  }

  if (screen.kind === "onboarding") {
    return (
      <div className="centered-screen onboarding-screen">
        <div className="onboarding-glow onboarding-glow-1" />
        <div className="onboarding-glow onboarding-glow-2" />
        <div className="onboarding-bg-icons">
          {ONBOARDING_BG_ICONS.map((icon, i) => (
            <BitcoinMark
              key={i}
              className="onboarding-bg-icon"
              style={
                {
                  top: icon.top,
                  left: icon.left,
                  width: icon.size,
                  height: icon.size,
                  opacity: icon.opacity,
                  animationDuration: `${icon.duration}s`,
                  animationDelay: `${i * 0.6}s`,
                  "--drift-x": `${icon.dx}px`,
                  "--drift-y": `${icon.dy}px`,
                  "--drift-r": `${icon.rot}deg`,
                } as CSSProperties
              }
            />
          ))}
        </div>
        <Brand />
        <div className="auth-card onboarding-card">
          <span className="onboarding-badge">{t("SELF CUSTODIAL")}</span>
          <h1>
            {t("Bitcoin.")}
            <br />
            {t("Bez prostředníka.")}
          </h1>
          <p className="muted">{t("Klíče k penězům držíš jen ty, v telefonu.")}</p>
          <div className="stack">
            <button disabled={busy} onClick={() => throughInstallGate(startCreate)}>
              {t("Vytvořit peněženku")}
            </button>
            <button
              className="secondary"
              disabled={busy}
              onClick={() => throughInstallGate(() => setScreen({ kind: "import" }))}
            >
              {t("Mám seed phrase")}
            </button>
          </div>
          <a className="onboarding-learn" href="/learn" target="_blank" rel="noopener">
            {t("Jak to funguje")}
          </a>
        </div>
        {installGate && (
          <InstallAppSheet
            variant="onboarding"
            onContinueInBrowser={() => {
              const { then } = installGate;
              setInstallGate(null);
              then();
            }}
            onClose={() => setInstallGate(null)}
          />
        )}
      </div>
    );
  }

  if (screen.kind === "create-confirm") {
    const words = screen.mnemonic.split(" ");
    return (
      <div className="centered-screen">
        <div className="auth-card">
          <h1>{t("Zapiš si seed phrase")}</h1>
          <div className="banner banner-warning">
            <WarningIcon />
            <span className="seed-warning-text">
              {tf(t("Těchto {n} slov je jediný způsob, jak obnovit peněženku. "), { n: words.length })}
              <strong>{t("Napiš si je na papír a ulož na bezpečné místo. Nikdy je nikomu nesděluj.")}</strong>
            </span>
          </div>
          <MnemonicGrid words={words} onAllRevealedChange={setSeedFullyRevealed} />
          <button
            disabled={!seedFullyRevealed}
            onClick={() => setScreen({ kind: "set-password", mnemonic: screen.mnemonic, isImport: false })}
          >
            {t("Zapsal jsem si to, pokračovat")}
          </button>
        </div>
      </div>
    );
  }

  if (screen.kind === "import") {
    return (
      <ImportSeedForm
        error={error}
        busy={busy}
        onCancel={() => {
          setError(null);
          setScreen({ kind: "onboarding" });
        }}
        onSubmit={async (mnemonic) => {
          const normalized = mnemonic.trim().toLowerCase().replace(/\s+/g, " ");
          setBusy(true);
          try {
            if (!(await validateMnemonic(normalized))) {
              setError(t("Neplatná seed phrase."));
              return;
            }
            setError(null);
            setScreen({ kind: "set-password", mnemonic: normalized, isImport: true });
          } finally {
            setBusy(false);
          }
        }}
      />
    );
  }

  if (screen.kind === "set-password") {
    return (
      <>
        <SetPasswordForm
          error={error}
          busy={busy}
          onCancel={() => {
            setError(null);
            setScreen({ kind: "onboarding" });
          }}
          onSubmit={(password) => finishWithMnemonic(screen.mnemonic, password, screen.isImport)}
        />
        {openElsewhere && <WalletOpenElsewhereSheet onClose={() => setOpenElsewhere(false)} />}
      </>
    );
  }

  if (screen.kind === "unlock" && loadVault() === null && hasDeviceVault()) {
    return (
      <>
        <div className="centered-screen">
          <Brand />
          {!error && (busy || !deviceAttemptRef.current) ? (
            <p className="muted">{t("Otevírám…")}</p>
          ) : (
            <>
              {error && <p className="error">{error}</p>}
              <button
                type="button"
                className="primary"
                onClick={() => {
                  deviceAttemptRef.current = true;
                  void unlockDevice();
                }}
              >
                {t("Zkusit znovu")}
              </button>
              <button type="button" className="secondary" onClick={requestReset}>
                {t("Smazat peněženku")}
              </button>
            </>
          )}
        </div>
        {showResetConfirm && (
          <DeleteWalletSheet pendingExit={resetPendingExit} onConfirm={resetWallet} onCancel={() => setShowResetConfirm(false)} />
        )}
        {openElsewhere && <WalletOpenElsewhereSheet onClose={() => setOpenElsewhere(false)} />}
      </>
    );
  }

  if (screen.kind === "unlock") {
    // A gift-link recipient who refreshed (or got auto-locked) before the
    // dashboard's delayed "save your password" prompt fired is now staring
    // at an unlock screen for a password they've never seen. It's still in
    // localStorage (cleared only once they've actually typed it somewhere —
    // see giftStore.ts's PENDING_PW_KEY for the full list of clear sites) —
    // surface it right here, no delay, so a plain refresh is all the
    // recovery they need. "Uložil jsem si ho" only hides the modal; the
    // stored copy survives until a successful unlock, so another refresh
    // still shows it.
    const strandedPw = strandedPwDismissed ? null : getPendingGiftPassword();
    return (
      <>
        <UnlockForm
          error={error}
          workerLostReason={workerLostReason}
          busy={busy}
          onSubmit={unlock}
          onReset={requestReset}
          onBiometric={hasBiometricUnlock() ? unlockBiometric : undefined}
          opened={unlockOpened}
        />
        {strandedPw && <GiftPasswordModal password={strandedPw} onDone={() => setStrandedPwDismissed(true)} />}
        {showResetConfirm && (
          <DeleteWalletSheet pendingExit={resetPendingExit} onConfirm={resetWallet} onCancel={() => setShowResetConfirm(false)} />
        )}
        {openElsewhere && <WalletOpenElsewhereSheet onClose={() => setOpenElsewhere(false)} />}
      </>
    );
  }

  return (
    <>
      <Dashboard
        wallet={screen.wallet}
        onLock={lockByHand}
        onResetWallet={requestReset}
        justOnboarded={justOnboarded}
        usingFallbackChainSource={usingFallbackChainSource}
        onCriticalOpChange={(active) => {
          criticalOpRef.current = active;
        }}
        giftEncryptionKey={giftEncryptionKeyRef.current}
        giftClaimActive={giftClaim !== null}
        payRequest={payRequestHandoff}
        onPayRequestConsumed={() => setPayRequestHandoff(null)}
        onWalletStateChanged={() => backupTriggerRef.current?.trigger()}
      />
      {payRequestEl}
      {profileEl}
      {setupReason && loadVault() === null && hasDeviceVault() && (
        <PasswordSetupSheet reason={setupReason} onDone={() => setSetupReason(null)} />
      )}
      {showResetConfirm && <DeleteWalletSheet pendingExit={resetPendingExit} onConfirm={resetWallet} onCancel={() => setShowResetConfirm(false)} />}
    </>
  );
}

function SetPasswordForm({
  onSubmit,
  onCancel,
  error,
  busy,
}: {
  onSubmit: (password: string) => void;
  onCancel: () => void;
  error: string | null;
  busy: boolean;
}) {
  const t = useT();
  const [password, setPassword] = useState("");
  const [confirmPw, setConfirmPw] = useState("");
  const mismatch = confirmPw.length > 0 && password !== confirmPw;
  const problem = passwordProblem(password);
  const canSubmit = isPasswordStrong(password) && !mismatch;
  return (
    <form
      className="centered-screen"
      onSubmit={(e) => {
        e.preventDefault();
        if (!busy && canSubmit) onSubmit(password);
      }}
    >
      <div className="auth-card">
        <h1>{t("Nastav heslo")}</h1>
        <p className="muted">
          {t("Heslo šifruje seed phrase v tomto prohlížeči. Neposílá se nikam a nikdo ho nemůže obnovit za tebe.")}
        </p>
        <div className="field-group">
          <PasswordField value={password} onChange={setPassword} placeholder={t("Heslo")} autoFocus />
          <PasswordField value={confirmPw} onChange={setConfirmPw} placeholder={t("Heslo znovu")} />
        </div>
        {mismatch && <p className="error">{t("Hesla se neshodují.")}</p>}
        {/* The hint names the specific weakness the estimator found (a
            common word, a keyboard run, a date, ...) rather than reciting a
            character-class rule — there is no such rule any more, and
            "add a capital letter" is advice that doesn't help against the
            attack this gate exists for. See lib/passwordStrength.ts. */}
        {!mismatch && problem && <p className="hint">{t(problem)}</p>}
        {error && (
          <div className="banner banner-danger">
            <ErrorCircleIcon />
            <span>{error}</span>
          </div>
        )}
        <div className="stack">
          <button type="submit" disabled={busy || !canSubmit}>
            {busy ? t("Zakládám peněženku…") : t("Vytvořit peněženku")}
          </button>
          <button type="button" className="secondary" onClick={onCancel}>
            {t("Zpět")}
          </button>
        </div>
      </div>
    </form>
  );
}

function FingerprintIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
      <path
        d="M12 3.5c-4.7 0-8.5 3.8-8.5 8.5 0 2.3 0 4.2-1 6M12 3.5c4.7 0 8.5 3.8 8.5 8.5 0 1.7-.1 3-.4 4M8 20.5c1-1.5 1.5-3.5 1.5-6a2.5 2.5 0 0 1 5 0c0 1 0 1.8-.2 2.5M6 18c.6-1.5 1-3.3 1-6a5 5 0 0 1 10 0c0 .7 0 1.3-.1 1.9"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

type UnlockFormProps = {
  onSubmit: (password: string) => void;
  onReset: () => void;
  onBiometric?: () => void;
  error: string | null;
  workerLostReason: string | null;
  busy: boolean;
  opened: boolean;
};

// Thin outline padlock, proportioned like SF Symbols' lock. The shackle is clipped at the body's top edge and
// its left leg is shorter than the right, so opening is one straight upward
// slide (a CSS transition, see .unlock-lock in App.css): the left leg lifts
// clear while the right one stays attached to the body.
function UnlockLock({ state }: { state: "idle" | "busy" | "open" }) {
  return (
    <div className={`unlock-lock is-${state}`} aria-hidden="true">
      <svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
        <defs>
          <clipPath id="unlock-shackle-clip">
            <rect x="0" y="-8" width="24" height="18.5" />
          </clipPath>
        </defs>
        <g clipPath="url(#unlock-shackle-clip)">
          <path className="unlock-shackle" d="M7.5 10.5V8.5a4.5 4.5 0 0 1 9 0V13" />
        </g>
        <rect x="4" y="10.5" width="16" height="11" rx="3.5" />
      </svg>
      <span className="unlock-progress" />
    </div>
  );
}

function EyeIcon({ crossed }: { crossed: boolean }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
      <path
        d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12Z"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinejoin="round"
      />
      <circle cx="12" cy="12" r="3" stroke="currentColor" strokeWidth="1.8" />
      {crossed && <path d="M4 20 20 4" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />}
    </svg>
  );
}

// A damped sine sampled finely enough that linear interpolation between
// samples reads as one smooth motion rather than discrete jumps.
const UNLOCK_SHAKE: Keyframe[] = Array.from({ length: 25 }, (_, i) => {
  const p = i / 24;
  return { transform: `translateX(${(Math.sin(p * Math.PI * 4) * 6 * (1 - p)).toFixed(2)}px)` };
});

// Unlock screen: animated padlock, real progress line, biometric first when
// enrolled, password reveal + Caps Lock hint. (The old V1 screen was removed
// once this one shipped to everyone.)
// Mostly the plain label, sometimes a greeting by time of day or a welcome back.
// The emoji sits outside the translated text, so the i18n keys stay plain.
type UnlockHeading = { text: string; emoji?: string };
function unlockHeading(): UnlockHeading {
  const welcome: UnlockHeading = { text: "Vítej zpět", emoji: "👋" };
  const r = Math.random();
  if (r < 0.3) return { text: "Odemknout peněženku" };
  if (r < 0.6) return welcome;
  const h = new Date().getHours();
  if (h >= 5 && h < 10) return { text: "Dobré ráno", emoji: "☀️" };
  if (h >= 18 && h < 23) return { text: "Dobrý večer", emoji: "🌙" };
  return welcome;
}

function UnlockForm({
  onSubmit,
  onReset,
  onBiometric,
  error,
  workerLostReason,
  busy,
  opened,
}: UnlockFormProps) {
  const t = useT();
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [capsLock, setCapsLock] = useState(false);
  // With a biometric credential enrolled, the fingerprint is the one-tap
  // path and the password field waits behind "Použít heslo". Never
  // auto-prompted: Safari requires a user gesture for WebAuthn.
  const [usePassword, setUsePassword] = useState(!onBiometric);
  const shakeRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!error) return;
    hapticError();
    if (!prefersReducedMotion()) {
      shakeRef.current?.animate(UNLOCK_SHAKE, { duration: 480, easing: "linear" });
    }
  }, [error]);

  const lockState = opened ? "open" : busy ? "busy" : "idle";
  // Picked once per mount so the heading does not change while typing.
  const [heading] = useState<UnlockHeading>(() => unlockHeading());

  const readCapsLock = (e: KeyboardEvent<HTMLInputElement>) => setCapsLock(e.getModifierState("CapsLock"));

  return (
    <form
      className="centered-screen unlock-v2"
      onSubmit={(e) => {
        e.preventDefault();
        if (!busy && password) onSubmit(password);
      }}
    >
      {/* No glow of its own: #root's ambient glow shows through, the same as
          on the home screen behind it, so unlocking changes nothing but the
          content. */}
      <Brand />
      <UnlockLock state={lockState} />
      <div className="auth-card">
        <h1>{t(heading.text)}{heading.emoji ? ` ${heading.emoji}` : ""}</h1>
        {usePassword && (
          <>
            <div className="unlock-password" ref={shakeRef}>
              <input
                type={showPassword ? "text" : "password"}
                placeholder={t("Heslo")}
                value={password}
                autoFocus
                autoComplete="current-password"
                onChange={(e) => setPassword(e.target.value)}
                onKeyDown={readCapsLock}
                onKeyUp={readCapsLock}
                onBlur={() => setCapsLock(false)}
              />
              <button
                type="button"
                className="unlock-reveal"
                aria-label={showPassword ? t("Skrýt heslo") : t("Zobrazit heslo")}
                aria-pressed={showPassword}
                onClick={() => setShowPassword((v) => !v)}
              >
                <EyeIcon crossed={showPassword} />
              </button>
            </div>
            {capsLock && <p className="unlock-caps">{t("Máš zapnutý Caps Lock.")}</p>}
          </>
        )}
        {workerLostReason && (
          <div className="banner banner-warning">
            <WarningIcon />
            <span>
              {t(
                "Peněženka se restartovala. Data jsou v pořádku, stačí se přihlásit.",
              )}
              <br />
              <code className="worker-lost-reason">{workerLostReason}</code>
            </span>
          </div>
        )}
        {error && (
          <div className="banner banner-danger">
            <ErrorCircleIcon />
            <span>{error}</span>
          </div>
        )}
        <div className="stack">
          {usePassword ? (
            <>
              <button type="submit" disabled={busy || !password}>
                {busy ? t("Odemykám…") : t("Odemknout")}
              </button>
              {onBiometric && (
                <button type="button" className="secondary" disabled={busy} onClick={onBiometric}>
                  <span className="btn-icon-row">
                    <FingerprintIcon />
                    {t("Odemknout otiskem")}
                  </span>
                </button>
              )}
            </>
          ) : (
            <>
              <button type="button" disabled={busy} onClick={onBiometric}>
                <span className="btn-icon-row">
                  <FingerprintIcon />
                  {busy ? t("Odemykám…") : t("Odemknout otiskem")}
                </span>
              </button>
              <button type="button" className="unlock-text-link" disabled={busy} onClick={() => setUsePassword(true)}>
                {t("Použít heslo")}
              </button>
            </>
          )}
        </div>
      </div>
      <button type="button" className="forgot-password-link" onClick={onReset}>
        {t("Zapomenuté heslo")}
      </button>
    </form>
  );
}

export default App;
