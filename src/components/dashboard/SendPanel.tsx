import {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import type { Balance, FeeEstimate, LightningSendStatus, Movement } from "@secondts/bark";
import {
  pushWorkerWatchdogOverride,
  type WalletClient,
} from "../../lib/wallet/bark";
import { effectiveEngineMode } from "../../lib/refreshEngine/mode";
import { isRefreshNoteSafe } from "../../lib/refreshEngine/runner";
import { ErrorCircleIcon, SuccessCircleIcon } from "../BannerIcons";
import { fiatToSats, satsToFiat } from "../../lib/price";
import { type FiatCurrency } from "../../lib/currency";
import { hapticError, hapticSuccess } from "../../lib/ui/haptics";
import { shake, useMotionOn } from "../../lib/ui/motion";
import { localeFor, tf, useLang, useT, type Lang } from "../../lib/i18n";
import { loadVaultOrPrompt, missingVaultText } from "../../lib/vault/vaultAccess";
import {
  SPEND_AUTH_FAILED,
  SPEND_AUTH_REQUIRED,
  SPEND_LIMIT_EXCEEDED,
} from "../../lib/wallet/walletSession";
import { decodeBolt11Amount, normalizeDestination } from "../../lib/send/destination";
import { classifyStatic, isArkAddressShape, parseScannedPayload } from "../../lib/send/destinationCheck";
import { isKnownValidArkAddress, rememberValidArkAddress } from "../../lib/send/validArkAddresses";
import { isValidMainnetBitcoinAddress } from "../../lib/send/bitcoinAddress";
import { resolveBip353 } from "../../lib/bip353/client";
import type { Bip353ErrorCode } from "../../lib/bip353/errors";
import { bip353Expired, bip353Target, isExplicitBip353, pickBip353Method, type Bip353Pick } from "../../lib/send/bip353Destination";
import {
  withTimeout,
  isWalletCallTimeout,
  WALLET_CALL_TIMEOUT_MS,
  SEND_WATCHDOG_MS,
  TIMEOUT_MESSAGE,
} from "../../lib/wallet/walletCall";
import { useDesignVersion } from "../../lib/ui/designVersion";
import { chargeQuick, loadQuickState, quickDecision, scanAutoQuick, type QuickReason } from "../../lib/send/quickPay";
import { getNoPasswordSats, getSpendLimitsStatus, refreshSpendLimits, useSpendLimitsStatus } from "../../lib/wallet/spendLimitsClient";
import { surfaceError } from "../../lib/appErrors";
import { isOffline } from "../../lib/connectivity/connectivity";
import { SendConfirmSheet } from "../sheet/SendConfirmSheet";
import Avatar from "../Avatar";
import { NAME_DOMAIN, handleFromProfileUrl, parseHandleDestination } from "../../lib/names/handle";
import { cachedLookup, lookupName, type LookupOutcome, type NameAbsentStatus } from "../../lib/names/names";
import { nameLookupDelayMs } from "../../lib/names/lookupDelay";
import {
  checkNamePin,
  logNamedPayment,
  pinName,
  pinnedAddressFor,
  distinctSuggestions,
  pinnedNamesStartingWith,
  type PinCheck,
} from "../../lib/names/namePins";
import { giftFromScannedUrl, isGiftPath, type GiftLinkParams } from "../../lib/gift/giftLink";
import { isRequestPath } from "../../lib/send/paymentRequest";
import { ScanIcon } from "../dashboard/icons";
import { type ToastDetail } from "../dashboard/toastIsland";

const QrScannerModal = lazy(() => import("../QrScanner"));
const QrSourceSheet = lazy(() => import("../QrSourceSheet"));

// Taps on Send this soon after a paste are ignored (a double tap on Paste).
const SEND_AFTER_PASTE_GUARD_MS = 350;

/* ---------- Send ---------- */

// "invalid" is a deny-list-by-default result: the destination matched none of
// the SDK-supported formats (Ark, any Lightning kind, or a well-formed
// mainnet on-chain address) after both static and async classification ran.
// It exists so an unrecognized string is rejected with a clear Czech message
// instead of silently defaulting to "onchain" and being handed to
// wallet.sendOnchain(), which used to surface a raw untranslated SDK error
// (e.g. "base58 error") at send time. See the classification effect below.
type DestinationKind = "lightning-invoice" | "lightning-address" | "lightning-offer" | "lnurl" | "ark" | "onchain" | "invalid" | null;

// A send frozen at the moment the user asked to review it: the literal
// argument values that will be handed to the SDK, and the only thing the
// confirm screen renders. See SendPanel's `plan` state for why this is a
// separate object rather than re-derived state.
type SendPlan = {
  // Which wallet.* method this dispatches to. Resolved once, so the
  // debounced Ark/on-chain classification can no longer change it out from
  // under a confirm screen that has already been shown. "invalid" is never a
  // buildable plan kind — validationError() rejects it before a plan exists.
  kind: Exclude<DestinationKind, null | "invalid">;
  // Passed verbatim as the destination/invoice/address argument, already
  // normalized (normalizeDestination).
  destination: string;
  // Passed verbatim as `amountSats`. undefined means the SDK call omits it
  // — only ever the case for a BOLT11 invoice, which carries its own
  // amount.
  amountSats: number | undefined;
  // What this send actually moves: amountSats, or the amount decoded out of
  // a BOLT11 invoice. Drives the password threshold, the confirm-button arm
  // delay, the amount shown on the confirm screen and the sent toast — none
  // of which would otherwise see an invoice's amount at all.
  effectiveAmountSats: number | undefined;
  // Set when the destination was typed as a @handle. `destination` above is
  // then the address the handle resolved to at the moment the plan was built,
  // frozen with everything else, so the confirm screen can show who the payment
  // is for AND where it is really going. `pin` is what this wallet remembers
  // about the handle from earlier payments.
  recipient?: { name: string; address: string; pin: PinCheck };
  // Set when the destination was typed as a BIP 353 name (user@domain). The
  // DNSSEC-validated record it resolved to is frozen in `destination`/`kind`
  // above; `name` is what the confirm screen shows as the payee, `validUntil`
  // (unix seconds) the end of the DNSSEC proof it was resolved from. Past it the
  // plan is refused, not sent: "verified" must not outlive the proof.
  bip353?: { name: string; validUntil: number };
};

// A BIP 353 name is looked up through our Worker and validated here against the
// DNS root. Only the explicit "₿user@domain" form counts: a plain user@domain
// stays a Lightning address, with no extra wait and no request to our Worker.
// Set true to try every user@domain as a BIP 353 name first (falling back to the
// Lightning address when it has no record); that costs one Worker request and a
// short wait per address typed.
const BIP353_BARE_NAMES = false;

// A fresh answer is asked for again this often while the form is open, like the
// @handle lookup: the plan freezes whatever this last said.
const BIP353_REFRESH_MS = 60_000;

const BIP353_LOOKUP_DEBOUNCE_MS = 400;

// How the send field's BIP 353 lookup stands, keyed by the name it was made for.
type Bip353Resolution = { query: string } & (
  | { state: "found"; pick: Bip353Pick; validUntil: number }
  // A bare user@domain with no record (or no way to ask): the Lightning
  // address path takes over, exactly as without BIP 353.
  | { state: "fallback" }
  | { state: "absent" }
  | { state: "invalid"; code: Bip353ErrorCode }
  | { state: "unsupported" }
  | { state: "error" }
);

// How often an open send form re-checks the address behind a typed @handle.
const NAME_REFRESH_MS = 30_000;

// Every prefix typed on the way to a name is a distinct name and a request
// (and a slot in the per-IP miss limiter), so the lookup waits for a pause in
// typing, not for the next keystroke. A name this wallet has paid before skips
// the wait: it is almost certainly the whole name.
const NAME_LOOKUP_DEBOUNCE_MS = 400;

// Longer, when what is typed is the beginning of a name already paid (lookupDelay.ts).
const NAME_LOOKUP_PREFIX_DEBOUNCE_MS = 1_500;

// A failed first lookup is tried once more after this, before "could not
// verify" is shown: a dropped connection or a momentary rate limit usually
// clears in that time.
const NAME_LOOKUP_RETRIES = 1;

const NAME_LOOKUP_RETRY_MS = 1_200;

// How the send field's @handle lookup stands. Keyed by the handle it was made
// for, so a stale answer for a name the user has since edited is never read as
// the current one.
type NameResolution = {
  query: string;
} & (
  | { state: "found"; address: string }
  // Resolved by the registry, not yet accepted by the SDK: shown, not payable.
  | { state: "checking"; address: string }
  | { state: "absent"; status: NameAbsentStatus }
  | { state: "error" }
  | { state: "bad-address" }
);

// Whether this send has to carry a SpendAuth. Must agree exactly with what
// the wallet worker enforces (enforceSpendPolicy in walletWorkerImpl.ts),
// which is why the threshold itself lives in walletSession.ts rather than
// being written down separately on each side: if the UI decided not to ask
// for a password the worker then insists on, the send just fails with a
// sentinel the user can't act on.
//
// An undefined amount counts as "needs the password", matching the worker's
// treatment of an amount it can't read — the direction that errs toward
// asking, since a send whose size nobody can see is the last one to wave
// through. In practice this is only reachable for an amountless BOLT11
// invoice with no amount typed, which has nothing to send anyway.
function planNeedsPassword(plan: SendPlan): boolean {
  return plan.effectiveAmountSats === undefined || plan.effectiveAmountSats >= getNoPasswordSats();
}

// Why a scan that tried to pay by itself opened the confirm screen instead. Above the
// threshold is the ordinary case and says nothing.
function quickNoteText(reason: QuickReason, t: (cs: string) => string): string | null {
  switch (reason) {
    case "budget":
      return t("Denní budget rychlé platby je vyčerpaný.");
    case "over-hard":
      return t("Nevejde se do denního limitu.");
    case "no-price":
      return t("Bez kurzu se potvrzuje.");
    default:
      return null;
  }
}

const CURRENCY_SYMBOLS: Record<FiatCurrency, string> = { czk: "Kč", eur: "EUR", usd: "USD" };

// Shared by Send and both Receive forms — every amount the wallet itself
// works with is sats, but a human thinking in Kč/EUR/USD shouldn't have to
// do the conversion by hand. `sats` stays the single source of truth passed
// up to the parent; the fiat text box is a local, self-syncing view onto it.
function AmountInput({
  label,
  hint,
  sats,
  onSatsChange,
  rates,
  currency,
  placeholder,
  actionSlot,
  onUnitChange,
}: {
  label: string;
  hint?: ReactNode;
  sats: string;
  onSatsChange: (v: string) => void;
  rates: Record<FiatCurrency, number> | null;
  currency: FiatCurrency;
  placeholder?: string;
  actionSlot?: ReactNode;
  onUnitChange?: (unit: "sats" | "fiat") => void;
}) {
  const lang = useLang();
  const [unit, setUnit] = useState<"sats" | "fiat">("sats");
  const [fiatText, setFiatText] = useState("");
  const rate = rates ? rates[currency] : null;
  // Tracks the sats string this component itself last emitted via the fiat
  // box, so the sync effect below can tell "the parent changed `sats` out
  // from under us (Poslat vše, a QR scan)" apart from "we just caused this
  // very change ourselves" — without it, every keystroke in the fiat box
  // would immediately overwrite itself with a rounded-off echo.
  const lastEmittedRef = useRef<string | null>(null);

  useEffect(() => {
    if (unit !== "fiat" || !rate || sats === lastEmittedRef.current) return;
    const satsNum = Number(sats);
    setFiatText(satsNum > 0 ? satsToFiat(satsNum, rate).toFixed(2) : "");
  }, [sats, unit, rate]);

  const switchUnit = (next: "sats" | "fiat") => {
    if (next === unit) return;
    if (next === "fiat" && rate) {
      const satsNum = Number(sats);
      setFiatText(satsNum > 0 ? satsToFiat(satsNum, rate).toFixed(2) : "");
    }
    setUnit(next);
    onUnitChange?.(next);
  };

  const handleFiatChange = (text: string) => {
    setFiatText(text);
    const amount = Number(text);
    if (!text || !Number.isFinite(amount) || amount <= 0 || !rate) {
      lastEmittedRef.current = "";
      onSatsChange("");
      return;
    }
    const satsStr = String(fiatToSats(amount, rate));
    lastEmittedRef.current = satsStr;
    onSatsChange(satsStr);
  };

  return (
    <div className="field">
      <div className="field-label-row">
        <label className="field-label">
          {label}
          {hint}
        </label>
        <div className="field-label-actions">
          {rate !== null && (
            <div className="unit-toggle">
              <button type="button" className={unit === "sats" ? "active" : ""} onClick={() => switchUnit("sats")}>
                sats
              </button>
              <button type="button" className={unit === "fiat" ? "active" : ""} onClick={() => switchUnit("fiat")}>
                {CURRENCY_SYMBOLS[currency]}
              </button>
            </div>
          )}
          {actionSlot}
        </div>
      </div>
      {unit === "sats" ? (
        <input type="number" min={1} value={sats} onChange={(e) => onSatsChange(e.target.value)} placeholder={placeholder} />
      ) : (
        <input
          type="number"
          min={0}
          step="0.01"
          value={fiatText}
          onChange={(e) => handleFiatChange(e.target.value)}
          placeholder="0.00"
        />
      )}
      {unit === "fiat" && Number(sats) > 0 && (
        <p className="muted small">≈ {Number(sats).toLocaleString(localeFor(lang))} sats</p>
      )}
    </div>
  );
}

const KIND_LABELS: Record<Exclude<DestinationKind, null | "invalid">, string> = {
  "lightning-invoice": "Lightning faktura",
  "lightning-address": "Lightning adresa",
  "lightning-offer": "Lightning offer (BOLT12)",
  lnurl: "LNURL platba",
  ark: "Ark adresa",
  onchain: "On-chain (bitcoin) adresa",
};

export function describeSendStatus(
  status: LightningSendStatus,
  t: (cs: string) => string,
  lang: Lang,
): { ok: boolean; indeterminate?: boolean; text: string } {
  if (status.type === "paid") {
    return {
      ok: true,
      text: tf(t("Lightning platba zaplacena. Preimage: {preimage}…"), {
        preimage: status.preimage.slice(0, 16),
      }),
    };
  }
  if (status.type === "inProgress") {
    return {
      ok: true,
      text: tf(t("Platba se zpracovává ({amount} sats)…"), {
        amount: status.send.amountSats.toLocaleString(localeFor(lang)),
      }),
    };
  }
  // status.type === "unknown": the SDK submitted the payment but genuinely
  // can't tell whether it settled — it may still complete. This must NOT be
  // handled like a plain failure that leaves the form filled: the user then
  // taps Odeslat again, and for a Lightning address / LNURL that fetches a
  // *fresh* invoice each time, so the retry is a second real payment on top
  // of a first one that may well go through. Flagged so send() clears the
  // form (any retry has to be re-entered deliberately) and refreshes history
  // instead of claiming either success or failure.
  return {
    ok: false,
    indeterminate: true,
    text: t("Nevíme, jestli platba prošla. Zkontroluj historii. Pokud tam platba není, zkus to za chvíli znovu."),
  };
}

// Whether a plan gets SendPanel's long confirm-arm delay: only a @name whose
// address changed. On-chain and password-sized sends arm as fast as any other.
function isLongArm(plan: SendPlan): boolean {
  return plan.recipient?.pin === "changed";
}

export function SendPanel({
  wallet,
  onSent,
  spendable,
  rates,
  currency,
  onSentToast,
  onSentBump,
  inRoundSats,
  autoScan,
  onCancelAutoScan,
  onCriticalOpChange,
  onScannedGift,
  initialDestination,
  initialAmountSats,
  onSendComplete,
}: {
  wallet: WalletClient;
  // Typed as awaitable (not plain `() => void`) so the success path below
  // can wait for the post-send refresh() to actually land before revealing
  // the new balance — see onSentBump's own comment for why that ordering
  // matters here specifically.
  onSent: () => Promise<{ balance: Balance; history: Movement[] } | undefined> | void;
  spendable: number | undefined;
  rates: Record<FiatCurrency, number> | null;
  currency: FiatCurrency;
  onSentToast: (message: string, kind?: "success" | "danger", detail?: ToastDetail) => void;
  // Plays the same rolling-digit bump the balance gets on an incoming
  // payment (see bumpBalance in the parent Dashboard) — an outgoing send is
  // the other half of "payment event", not a VTXO-refresh-driven change.
  // Called with the fresh spendableSats from onSent()'s own result once
  // it's awaited (see the success path below) rather than relying on the
  // parent's own state having caught up by then — an outgoing send's
  // balance-lowering refresh() happens strictly *after* this fires, unlike
  // a receive, where by the time bumpBalance() is called the balance has
  // usually already been fetched.
  onSentBump?: (overrideHeadline?: number) => void;
  // Locked refresh inputs, frozen with spendable at the tap: the bump target is one snapshot.
  inRoundSats?: number;
  autoScan?: boolean;
  onCancelAutoScan?: () => void;
  onCriticalOpChange?: (active: boolean) => void;
  // A scanned gift link of this app: the parent opens the claim sheet. Without it the link is opened by a page load.
  onScannedGift?: (gift: GiftLinkParams) => void;
  // Prefill from a payment-request link. Read once at mount (this panel is
  // remounted whenever the Send view is entered, and again on a new
  // request), never as a controlled value — the fields stay the user's from
  // the first keystroke on.
  initialDestination?: string;
  initialAmountSats?: number;
  // Motion design: called after a send that definitely went through, so the
  // parent can take the user home (the island toast confirms it there).
  onSendComplete?: () => void;
}) {
  const t = useT();
  const lang = useLang();
  const [destination, setDestination] = useState(initialDestination ?? "");
  const [amount, setAmount] = useState(initialAmountSats ? String(initialAmountSats) : "");
  // Which unit the amount was typed in; the V2 confirm sheet leads with it.
  const [amountUnit, setAmountUnit] = useState<"sats" | "fiat">("sats");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  // The pending send, or null when the form is showing. This IS the send:
  // every field on it is passed verbatim to the matching SDK method by
  // send() below, and the confirm screen renders nothing but these same
  // fields.
  //
  // It used to be a bare `confirming` boolean, with both the confirm screen
  // and the SDK call each re-deriving destination/amount/kind from the
  // input state independently. That makes the confirmation step blind to
  // any disagreement between what is shown and what is sent — and the
  // disagreement was reachable, not hypothetical: the debounced
  // Ark/on-chain classification (see the effect above) keeps running while
  // the confirm screen is up, so `kind` could flip from under a screen the
  // user was already reading, and send() would then dispatch to a
  // different SDK method than the "Typ" row said. Freezing the arguments at
  // the moment the user asks to review them is what makes the review
  // meaningful.
  const [plan, setPlan] = useState<SendPlan | null>(null);
  // The confirm screen's own button sits in the exact same on-screen
  // position as the form's "Odeslat" button that led to it — a fast
  // double-tap (the second tap landing before the user has registered the
  // screen changed) can land squarely on "Potvrdit a odeslat" with no
  // perceived confirmation step at all. A brief disable window after the
  // confirm screen mounts closes that gap without adding a deliberate delay
  // for anyone actually reading it.
  const [confirmReady, setConfirmReady] = useState(false);
  const [confirmPassword, setConfirmPassword] = useState("");
  // Set once the worker has refused a sub-threshold send because the
  // rolling no-password budget is spent (SPEND_LIMIT_EXCEEDED). From then
  // on this panel asks for the password on every send regardless of
  // amount — without it there would be no way to supply one for a small
  // payment at all (the password field is normally only rendered above
  // the threshold, and payments under 1000 sats skip the confirm screen
  // entirely), leaving the user staring at an error with no way forward.
  // Never cleared for the session: an authorized send does not refill the
  // budget, and asking once too often is the harmless direction.
  const [spendLimitReached, setSpendLimitReached] = useState(false);
  const [resolvedKind, setResolvedKind] = useState<"ark" | "onchain" | "invalid" | null>(null);
  // Every address/invoice format here is checksum-based, so there is no way
  // to tell "wrong" apart from "correct but not finished yet" — a half-typed
  // bc1q… or ark1… fails isValidMainnetBitcoinAddress()/validateArkoorAddress
  // just as hard as actual garbage does, by design (see bitcoinAddress.ts).
  // Showing the red "invalid" badge on every debounced re-check while the
  // field still has focus would make it flash red for anyone typing an
  // address by hand instead of pasting/scanning one — this only holds the
  // *visual* alarm back until the field is blurred (tab away, or clicking
  // Odeslat, which blurs it first); the Send button stays disabled and
  // validationError() still rejects "invalid" regardless of focus, so
  // nothing unsendable becomes sendable by typing quickly.
  const [destinationFocused, setDestinationFocused] = useState(false);
  const [feeEstimate, setFeeEstimate] = useState<FeeEstimate | null>(null);
  // A failed estimate stops the "loading" state of the V2 sheet's fee row.
  const [feeFailed, setFeeFailed] = useState(false);

  // Initial value only — the homepage QR shortcut passes autoScan={true} to
  // jump straight into the scanner. SendPanel remounts fresh (key={view} on
  // its wrapper) every time Send is entered, so reading this once at mount
  // is enough; afterwards `scanning` is just normal local state.
  const [scanning, setScanning] = useState(autoScan ?? false);
  // The 🎁 "send bitcoin as a link" entry point moved to the home screen's
  // Odeslat hold-menu (ActionMenu.tsx) — it was a third icon in the address
  // row here, next to a field it had nothing to do with.
  const motionOn = useMotionOn();
  // Motion design: marks the destination field as the landing spot of the
  // scanner's lock frame for one View Transition (motion.css, scan-lock).
  const [justScanned, setJustScanned] = useState(false);
  // The scan button first asks camera or gallery.
  const [pickingSource, setPickingSource] = useState(false);
  useEffect(() => {
    if (!justScanned) return;
    const timer = window.setTimeout(() => setJustScanned(false), 800);
    return () => window.clearTimeout(timer);
  }, [justScanned]);
  // Motion design: a refused action shakes its message, like a wrong
  // password on the unlock screen. Fires on each new message, not on re-renders.
  const errorRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!error || !motionOn) return;
    shake(errorRef.current);
    hapticError();
  }, [error, motionOn]);
  // "@pavel" / "pavel@spendrr.app" resolve through the name registry
  // instead of being read as a Lightning address at a domain with no LNURL.
  const nameQuery = useMemo(() => parseHandleDestination(destination), [destination]);
  const [nameResolution, setNameResolution] = useState<NameResolution | null>(null);
  // Handles paid before, offered while one is being typed: local, so they show
  // from the first letter, before any lookup could answer. Not tied to the
  // field's focus on purpose: on a touch screen the blur can land before the
  // tap, which would unmount the list under the finger. The exact name typed
  // is never suggested, so the list empties by itself once one is picked.
  const nameSuggestions = useMemo(
    () => (nameQuery !== null ? pinnedNamesStartingWith(nameQuery) : []),
    [nameQuery],
  );
  const currentNameResolution = nameQuery !== null && nameResolution?.query === nameQuery ? nameResolution : null;
  // A pin whose address is the one the typed name already resolved to (an old
  // or deleted handle of the same wallet) would list the same person twice.
  const visibleSuggestions = useMemo(
    () =>
      distinctSuggestions(
        nameSuggestions,
        currentNameResolution?.state === "found" || currentNameResolution?.state === "checking"
          ? currentNameResolution.address
          : null,
      ),
    [nameSuggestions, currentNameResolution],
  );
  // BIP 353 (beta): user@domain resolved through DNS, validated on this side.
  const bip353On = useDesignVersion() === "v2";
  const bipTarget = useMemo(
    () => (bip353On && nameQuery === null ? bip353Target(destination, BIP353_BARE_NAMES) : null),
    [bip353On, nameQuery, destination],
  );
  const [bipResolution, setBipResolution] = useState<Bip353Resolution | null>(null);
  const currentBip = bipTarget !== null && bipResolution?.query === bipTarget.name ? bipResolution : null;
  // True while the name is being resolved, and once it has resolved to
  // anything but "use the Lightning address instead".
  const bipActive = bipTarget !== null && currentBip?.state !== "fallback";
  // A ₿ name the BIP 353 path does not take must not fall through as a Lightning
  // address (the ₿ is dropped by normalizeDestination): invalid, never unchecked.
  const bipMalformed = bip353On && nameQuery === null && bipTarget === null && isExplicitBip353(destination);
  const staticKind = useMemo(() => {
    if (nameQuery !== null || bipActive) return null;
    const trimmed = normalizeDestination(destination);
    return trimmed ? classifyStatic(trimmed) : null;
  }, [destination, nameQuery, bipActive]);
  // A resolved handle is an Ark destination; while the lookup is in flight the
  // kind stays null (Send disabled), and a failed one is "invalid".
  const nameKind: DestinationKind =
    currentNameResolution === null || currentNameResolution.state === "checking"
      ? null
      : currentNameResolution.state === "found"
        ? "ark"
        : "invalid";
  // A well-formed Ark address needs no round trip to be recognised: bech32m
  // with the right hrp is decided here, on the keystroke. The wallet worker is
  // still asked below (its queue can sit behind a sync for a long time), but
  // only as a second opinion that can turn "ark" into "invalid" (an address
  // for another server); a slow or failed answer leaves it "ark".
  const localKind: DestinationKind = useMemo(() => {
    if (nameQuery !== null || bipActive) return null;
    if (staticKind) return staticKind;
    const trimmed = normalizeDestination(destination);
    return trimmed && isArkAddressShape(trimmed) ? "ark" : null;
  }, [destination, nameQuery, staticKind, bipActive]);
  // A BIP 353 name is "ark" / "lightning-offer" / "onchain" by the method its
  // record resolved to; while resolving it is null (Send disabled).
  const bipKind: DestinationKind = !bipActive || currentBip === null ? null : currentBip.state === "found" ? currentBip.pick.kind : "invalid";
  const kind: DestinationKind =
    nameQuery !== null
      ? nameKind
      : bipMalformed
        ? "invalid"
        : bipActive
          ? bipKind
          : localKind === "ark" && resolvedKind === "invalid"
            ? "invalid"
            : (localKind ?? resolvedKind);

  useEffect(() => {
    if (nameQuery === null) return;
    let cancelled = false;
    const controller = new AbortController();
    // A cached answer and the fresh one can both be settling at once; only
    // the latest to start may write, so an older validation finishing late
    // can never put back an address the fresh lookup already replaced.
    let seq = 0;
    const settle = async (result: LookupOutcome) => {
      const mine = ++seq;
      if (result.kind === "absent") {
        setNameResolution({ query: nameQuery, state: "absent", status: result.status });
        return;
      }
      if (result.kind === "error") {
        setNameResolution({ query: nameQuery, state: "error" });
        return;
      }
      if (isKnownValidArkAddress(result.address)) {
        setNameResolution({ query: nameQuery, state: "found", address: result.address });
        return;
      }
      // Who it is can show now; Send waits for the SDK's verdict below, which
      // queues behind whatever the wallet worker is busy with.
      setNameResolution({ query: nameQuery, state: "checking", address: result.address });
      // The registry is a third party for this purpose: only pay an address
      // the SDK itself accepts as an Ark address.
      let valid = false;
      try {
        valid = await withTimeout(wallet.validateArkoorAddress(result.address), WALLET_CALL_TIMEOUT_MS, TIMEOUT_MESSAGE);
      } catch {
        valid = false;
      }
      if (cancelled || mine !== seq) return;
      if (valid) rememberValidArkAddress(result.address);
      setNameResolution(
        valid
          ? { query: nameQuery, state: "found", address: result.address }
          : { query: nameQuery, state: "bad-address" },
      );
    };
    const cached = cachedLookup(nameQuery);
    if (cached) void settle(cached);
    // A name paid before shows who it is at once, from the pin. It is only a
    // hint: "checking" is not payable, and the registry's answer (asked with no
    // wait) replaces it, since the address behind a handle can have changed.
    const pinned = cached ? null : pinnedAddressFor(nameQuery);
    if (pinned) setNameResolution({ query: nameQuery, state: "checking", address: pinned });
    // Requests are numbered when they START: two can overlap (the first
    // lookup and a refresh), and a slow older answer arriving after a newer one
    // must not put its address back over it.
    let requestSeq = 0;
    let goodAnswer = cached !== null && cached.kind !== "error";
    // Refreshing only matters for a name that resolves: a free, invalid or
    // reserved one stays that for the life of the form and a second request
    // per 30 s for it is pure waste.
    let refreshable = cached === null || cached.kind !== "absent";
    let retries = 0;
    let retryTimer: ReturnType<typeof setTimeout> | undefined;
    const resolve = async () => {
      const mine = ++requestSeq;
      const result = await lookupName(nameQuery, controller.signal);
      if (cancelled || mine !== requestSeq) return;
      if (result.kind === "error") {
        // A blip after a good answer (the cached one, or one this form got
        // itself) keeps that answer; the next refresh tries again. It used to
        // be only the cache, whose 30 s lifetime equals the refresh interval,
        // so the very refresh that hit a blip usually found it expired and
        // flipped a resolved name to "could not verify".
        if (goodAnswer) return;
        // First lookup failed: one quick retry before telling the user, since
        // most failures are a dropped connection or a momentary rate limit.
        if (retries < NAME_LOOKUP_RETRIES) {
          retries += 1;
          retryTimer = setTimeout(() => void resolve(), NAME_LOOKUP_RETRY_MS);
          return;
        }
      } else {
        goodAnswer = true;
        refreshable = result.kind === "found";
      }
      await settle(result);
    };
    const prefixOfPaidName = !cached && !pinned && pinnedNamesStartingWith(nameQuery, 1).length > 0;
    const timer = setTimeout(
      () => void resolve(),
      nameLookupDelayMs({ answeredLocally: !!(cached || pinned), prefixOfPaidName }, NAME_LOOKUP_DEBOUNCE_MS, NAME_LOOKUP_PREFIX_DEBOUNCE_MS),
    );
    // A handle's address can change while the form sits open, and the plan
    // freezes whatever this last said. Refreshing keeps that at most this old.
    const refresh = setInterval(() => {
      if (refreshable) void resolve();
    }, NAME_REFRESH_MS);
    return () => {
      cancelled = true;
      controller.abort();
      clearTimeout(timer);
      clearTimeout(retryTimer);
      clearInterval(refresh);
      // Dropped whenever the typed handle changes or is cleared, so retyping
      // a name always starts from a fresh lookup and never from a leftover
      // answer for it.
      setNameResolution(null);
    };
  }, [nameQuery, wallet]);

  // BIP 353 lookup. The Worker only carries the DNSSEC proof; resolveBip353
  // validates it against the DNS root, and a record that fails is never worked
  // around (not even for a bare user@domain, which would otherwise fall back to
  // the Lightning address). Only "no record" and "could not ask" fall back.
  const bipName = bipTarget?.name ?? null;
  const bipExplicit = bipTarget?.explicit ?? false;
  useEffect(() => {
    if (bipName === null) return;
    const name = bipName;
    const explicit = bipExplicit;
    let cancelled = false;
    const controller = new AbortController();
    // End (unix seconds) of the last validated answer; 0 until there is one.
    let goodUntil = 0;
    let refreshable = true;
    // Numbered when they start: a slow older answer must not land over a newer one.
    let seq = 0;
    const resolve = async () => {
      const mine = ++seq;
      const outcome = await resolveBip353(name, { signal: controller.signal });
      if (cancelled || mine !== seq) return;
      // After a validated answer, a later "no record" or failed refresh does not
      // flip the form to another destination under the user's hands, but only
      // while that answer's proof is still valid.
      if ((outcome.kind === "error" || outcome.kind === "absent") && goodUntil * 1000 > Date.now()) return;
      if (outcome.kind === "found") {
        // A throw here leaves the record unusable, not the lookup unanswered; it
        // never turns into the bare Lightning address (that is only for "no record").
        let pick: Bip353Pick | null = null;
        try {
          pick = await pickBip353Method(outcome.instruction, {
            arkAddress: async (address) => {
              if (isKnownValidArkAddress(address)) return true;
              try {
                const valid = await withTimeout(wallet.validateArkoorAddress(address), WALLET_CALL_TIMEOUT_MS, TIMEOUT_MESSAGE);
                if (valid) rememberValidArkAddress(address);
                return valid;
              } catch {
                return false;
              }
            },
            // The Base58 check awaits Web Crypto; a rejection there means "not usable",
            // not an unhandled one that would leave the lookup unanswered.
            onchainAddress: async (address) => {
              try {
                return await isValidMainnetBitcoinAddress(address);
              } catch {
                return false;
              }
            },
          });
        } catch {
          pick = null;
        }
        if (cancelled || mine !== seq) return;
        goodUntil = outcome.validUntil;
        setBipResolution(pick ? { query: name, state: "found", pick, validUntil: outcome.validUntil } : { query: name, state: "unsupported" });
        return;
      }
      if (outcome.kind === "invalid") {
        refreshable = false;
        setBipResolution({ query: name, state: "invalid", code: outcome.code });
        return;
      }
      // absent / error: nothing was decided. An explicit "₿name" says so; a bare
      // name goes on as the Lightning address it may also be. A transport error on
      // an explicit name keeps refreshing: nothing was decided, retrying is safe.
      refreshable = explicit && outcome.kind === "error";
      setBipResolution({ query: name, state: explicit ? (outcome.kind === "absent" ? "absent" : "error") : "fallback" });
    };
    const timer = setTimeout(() => void resolve(), BIP353_LOOKUP_DEBOUNCE_MS);
    const refresh = setInterval(() => {
      if (refreshable) void resolve();
    }, BIP353_REFRESH_MS);
    return () => {
      cancelled = true;
      controller.abort();
      clearTimeout(timer);
      clearInterval(refresh);
      setBipResolution(null);
    };
  }, [bipName, bipExplicit, wallet]);

  // A record that names an amount fills the empty field, once per resolved name.
  const bipAmount = currentBip?.state === "found" ? currentBip.pick.amountSats : undefined;
  // Only a value this effect filled is ever replaced or cleared again; a typed
  // amount survives a change of name.
  const bipFilledAmountRef = useRef<string | null>(null);
  useEffect(() => {
    const prev = bipFilledAmountRef.current;
    if (bipAmount !== undefined) {
      const filled = String(bipAmount);
      bipFilledAmountRef.current = filled;
      setAmount((cur) => (cur && cur !== prev ? cur : filled));
    } else if (prev !== null) {
      bipFilledAmountRef.current = null;
      setAmount((cur) => (cur === prev ? "" : cur));
    }
  }, [bipAmount]);

  // Everything that is not a Lightning kind or a well-formed Ark address is
  // on-chain or nothing, and that is decided locally too
  // (isValidMainnetBitcoinAddress, src/lib/send/bitcoinAddress.ts: bech32/bech32m
  // and base58check, no network, no worker). It used to wait for the wallet
  // worker's validateArkoorAddress first, which shares the FIFO queue with
  // sync()/maintenance(), so a plain bc1… address could sit unclassified (Send
  // disabled) for as long as the queue was busy, and a real Ark address turned
  // "invalid" when that call timed out.
  useEffect(() => {
    const trimmed = normalizeDestination(destination);
    if (!trimmed || staticKind || nameQuery !== null || bipActive || localKind === "ark") return;
    let cancelled = false;
    void isValidMainnetBitcoinAddress(trimmed).then((looksOnchain) => {
      if (!cancelled) setResolvedKind(looksOnchain ? "onchain" : "invalid");
    });
    return () => {
      cancelled = true;
    };
  }, [destination, staticKind, nameQuery, bipActive, localKind]);

  // The SDK's opinion on a well-formed Ark address, debounced. Only "no" is
  // acted on. Bounded by withTimeout for the reason it always was: the worker
  // queue can hold this behind calls that widen the watchdog for minutes, and
  // an unbounded wait would leave this promise hanging with nothing to reject
  // it.
  useEffect(() => {
    const trimmed = normalizeDestination(destination);
    if (!trimmed || nameQuery !== null || localKind !== "ark") return;
    let cancelled = false;
    const t = setTimeout(async () => {
      try {
        const isArk = await withTimeout(wallet.validateArkoorAddress(trimmed), WALLET_CALL_TIMEOUT_MS, TIMEOUT_MESSAGE);
        if (!cancelled && !isArk) setResolvedKind("invalid");
      } catch {
        // No opinion (timeout, queue, error): the address is well formed and
        // the send itself is validated by the SDK again.
      }
    }, 350);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [destination, localKind, nameQuery, wallet]);

  // A BOLT11 invoice is the one kind that can carry its own amount, and only
  // when it does: an amountless one needs the amount typed like any other
  // destination (it used to go through without one and fail in the SDK).
  const invoiceAmountSats = kind === "lightning-invoice" ? decodeBolt11Amount(normalizeDestination(destination)) : null;
  const invoiceHasAmount = invoiceAmountSats !== null;
  const amountRequired = !invoiceHasAmount;
  // Show the invoice's own amount in the field. Only a value we filled is
  // ever cleared again, so a typed amount survives a destination change.
  const autoFilledAmountRef = useRef<string | null>(null);
  useEffect(() => {
    if (invoiceAmountSats !== null) {
      const filled = String(invoiceAmountSats);
      autoFilledAmountRef.current = filled;
      setAmount(filled);
    } else if (autoFilledAmountRef.current !== null) {
      const filled = autoFilledAmountRef.current;
      autoFilledAmountRef.current = null;
      setAmount((cur) => (cur === filled ? "" : cur));
    }
  }, [invoiceAmountSats]);

  const validationError = useCallback((): string | null => {
    // `kind` briefly reads as null while the 350ms debounced Ark/on-chain
    // classification is still pending — sending during that window used to
    // fall through to the on-chain branch by accident (both send() and the
    // SDK calls below key off `kind === "ark" | "onchain" | ...`, and a
    // bare `else` treated unresolved the same as on-chain).
    if (nameQuery !== null && kind !== "ark") {
      if (currentNameResolution === null || currentNameResolution.state !== "found") {
        if (currentNameResolution === null || currentNameResolution.state === "checking") {
          return t("Ověřuji jméno, chvíli počkej.");
        }
        return nameProblemText(currentNameResolution, t);
      }
    }
    if (bipActive && currentBip?.state !== "found") {
      return currentBip === null ? t("Ověřuji jméno, chvíli počkej.") : bip353ProblemText(currentBip, t);
    }
    if (kind === null) {
      return t("Ještě ověřuji cílovou adresu, chvíli počkej.");
    }
    if (kind === "invalid") {
      return t("Neplatná adresa nebo faktura. Zkontroluj, že jsi ji zkopíroval/a celou a bez překlepu.");
    }
    const amountSats = amount ? Number(amount) : undefined;
    if (amountSats !== undefined && (!Number.isInteger(amountSats) || amountSats <= 0)) {
      return t("Zadej platnou částku v satoshi (celé číslo).");
    }
    if (amountRequired && amountSats === undefined) {
      return t("Zadej platnou částku v satoshi (celé číslo).");
    }
    // A BOLT11 invoice that already encodes an amount must not also accept a
    // typed one that disagrees with it — buildPlan/send() below only ever
    // dispatch the invoice's own decoded amount in that case (never both),
    // but a mismatched typed amount left in the field would still misprice
    // the password threshold, the confirm screen and the toast, all of
    // which read the plan's effectiveAmountSats before dispatch even runs.
    // Refusing here, before a plan can be built at all, is what keeps those
    // screens honest about what's actually about to be paid.
    if (kind === "lightning-invoice" && amountSats !== undefined) {
      const invoiceAmount = decodeBolt11Amount(normalizeDestination(destination));
      if (invoiceAmount !== null && invoiceAmount !== amountSats) {
        return tf(t("Faktura už obsahuje částku {amount} sats — smaž zadanou částku, aby se použila ta z faktury."), {
          amount: invoiceAmount.toLocaleString(localeFor(lang)),
        });
      }
    }
    return null;
  }, [amount, amountRequired, destination, kind, lang, t, nameQuery, currentNameResolution, bipActive, currentBip]);

  // Takes the plan as an argument rather than reading component state, so
  // the values sent are provably the values that were confirmed.
  const send = useCallback(async (plan: SendPlan) => {
    // Frozen at the tap, before any await: the optimistic bump on the success
    // path must not read these back after the send, since a send can take
    // minutes and both the ~4s balance poll and the debounced fee estimate
    // keep running behind the confirm screen.
    const spendableAtSend = spendable;
    const inRoundAtSend = inRoundSats ?? 0;
    const feeSatsAtSend = feeEstimate?.feeSats;
    // Offline the SDK retries instead of failing, so the send would just hang
    // behind the confirm screen. Nothing has left yet: keep the plan and say so.
    if (isOffline()) {
      surfaceError(new Error(t("Jsi offline. Platbu pošleš, až se připojíš.")), setError);
      return;
    }
    if (plan.bip353 && bip353Expired(plan.bip353.validUntil, Date.now())) {
      setPlan(null);
      surfaceError(new Error(t("Ověření jména vypršelo. Chvíli počkej a zkus znovu.")), setError);
      return;
    }
    setBusy(true);
    setError(null);
    setSuccess(null);
    onCriticalOpChange?.(true);
    // See SEND_WATCHDOG_MS's own comment (walletCall.ts): none of the actual
    // payment calls below have any protection against bark.ts's 25s
    // crash-recovery watchdog by default — a legitimately slow (not stuck)
    // Lightning payment or Ark send would otherwise get the worker torn down
    // and the whole app forced back to "unlock" mid-payment.
    const popWatchdog = pushWorkerWatchdogOverride(SEND_WATCHDOG_MS);
    // The outcome for "the payment may or may not have gone through" — the
    // SDK reporting type:"unknown", or our own withTimeout giving up on a
    // call that is still running in the worker. Neither is a failure, so
    // neither may leave the form filled: a still-filled form invites a blind
    // second tap, and for a Lightning address / LNURL that resolves a
    // *fresh* invoice, making the retry a second real payment on top of a
    // first one that may well settle. Clear exactly like the success path so
    // any retry has to be re-entered deliberately, and refresh so it shows
    // up in history if it did land — but don't claim success, don't fire the
    // "-{amount} sats" toast, and don't buzz.
    const finishIndeterminate = (text: string) => {
      setDestination("");
      setAmount("");
      setResolvedKind(null);
      setPlan(null);
      setConfirmPassword("");
      onSentToast(text, "danger");
      onSent();
    };
    try {
      // Destructured from the plan, not re-derived — buildPlan() already
      // normalized the destination, parsed the amount and ran
      // validationError(). Re-deriving any of it here is exactly the
      // UI/call divergence the plan exists to rule out.
      const { kind: planKind, destination: trimmed, amountSats, effectiveAmountSats } = plan;

      // Large sends need the password re-entered, not just the confirm
      // screen — an unlocked device left unattended within the auto-lock
      // window otherwise lets anyone holding it move funds with a single
      // tap. Small/everyday sends stay frictionless. Gated on the plan's
      // effective amount, which for a BOLT11 invoice is the amount decoded
      // out of the invoice (the `amount` field is always empty for that
      // kind, and gating on it alone silently skipped this check for every
      // invoice payment).
      //
      // The password is no longer *checked* here, only collected and handed
      // across: the wallet worker verifies it against the seed the open
      // wallet was actually opened with, and refuses the call otherwise
      // (see SpendAuth in walletSession.ts). Verifying on this side too
      // would mean a second 600k-iteration PBKDF2 per payment for an answer
      // that no longer decides anything — this thread is the one an
      // attacker would be running in, so its opinion of the password was
      // never worth much.
      let spender = wallet;
      if (planNeedsPassword(plan) || spendLimitReached) {
        const vault = loadVaultOrPrompt();
        if (!vault) throw new Error(t(missingVaultText()));
        spender = wallet.withAuth({ vault, password: confirmPassword });
      }

      // Every payment call below used to run with pushWorkerWatchdogOverride
      // above but no withTimeout of its own — the one worker-level
      // protection but nothing at the UI level. That was fine only as long
      // as SEND_WATCHDOG_MS was the *widest* override anything could ever be
      // running concurrently; it stopped being fine the moment another
      // caller (the onchain-balance poll, initialScan()) could push a wider
      // one, since watchdogOverrideMs (bark.ts) is shared and takes the max
      // of every currently-active push, not just this call's own. Queued
      // behind one of those, a send had nothing to ever reject it — the
      // button just spun forever with no error, reported as "the payment
      // will not send". Bounding each call here at the UI level closes that
      // regardless of what else is currently widening the shared watchdog.
      //
      // Set (only) when a Lightning call came back type:"unknown" — see
      // describeSendStatus. Handled after the dispatch below as its own
      // outcome, neither success nor a thrown error.
      let indeterminateText: string | null = null;
      if (planKind === "lightning-invoice") {
        const status = await withTimeout(
          spender.payLightningInvoice({ invoice: trimmed, amountSats, wait: true }),
          SEND_WATCHDOG_MS,
          t(TIMEOUT_MESSAGE),
        );
        const outcome = describeSendStatus(status, t, lang);
        if (outcome.indeterminate) indeterminateText = outcome.text;
        else if (!outcome.ok) throw new Error(outcome.text);
        else setSuccess(outcome.text);
      } else if (planKind === "lightning-address") {
        const status = await withTimeout(
          spender.payLightningAddress({ lightningAddress: trimmed, amountSats: amountSats as number, wait: true }),
          SEND_WATCHDOG_MS,
          t(TIMEOUT_MESSAGE),
        );
        const outcome = describeSendStatus(status, t, lang);
        if (outcome.indeterminate) indeterminateText = outcome.text;
        else if (!outcome.ok) throw new Error(outcome.text);
        else setSuccess(outcome.text);
      } else if (planKind === "lightning-offer") {
        const status = await withTimeout(
          spender.payLightningOffer({ offer: trimmed, amountSats, wait: true }),
          SEND_WATCHDOG_MS,
          t(TIMEOUT_MESSAGE),
        );
        const outcome = describeSendStatus(status, t, lang);
        if (outcome.indeterminate) indeterminateText = outcome.text;
        else if (!outcome.ok) throw new Error(outcome.text);
        else setSuccess(outcome.text);
      } else if (planKind === "lnurl") {
        const status = await withTimeout(
          spender.payLnurl({ lnurl: trimmed, amountSats: amountSats as number, wait: true }),
          SEND_WATCHDOG_MS,
          t(TIMEOUT_MESSAGE),
        );
        const outcome = describeSendStatus(status, t, lang);
        if (outcome.indeterminate) indeterminateText = outcome.text;
        else if (!outcome.ok) throw new Error(outcome.text);
        else setSuccess(outcome.text);
      } else if (planKind === "ark") {
        await withTimeout(spender.sendArkoorPayment(trimmed, amountSats as number), SEND_WATCHDOG_MS, t(TIMEOUT_MESSAGE));
        // Only now, once the money has gone: remember what this handle
        // resolved to, so a later change of address is flagged.
        if (plan.recipient) {
          pinName(plan.recipient.name, plan.recipient.address);
          logNamedPayment(plan.recipient.name, amountSats as number);
        }
        setSuccess(t("Platba přes Ark odeslána."));
      } else {
        await withTimeout(spender.sendOnchain(trimmed, amountSats as number), SEND_WATCHDOG_MS, t(TIMEOUT_MESSAGE));
        setSuccess(t("On-chain transakce odeslána."));
      }
      if (indeterminateText !== null) {
        finishIndeterminate(indeterminateText);
        return;
      }
      if (effectiveAmountSats !== undefined) {
        onSentToast(
          tf(t("Platba odeslána: -{amount} sats"), { amount: effectiveAmountSats.toLocaleString(localeFor(lang)) }),
          "danger",
          { title: t("Platba odeslána"), amountSats: effectiveAmountSats, direction: "out" },
        );
        // Fires right alongside the toast, using a locally-computed
        // estimate rather than waiting on refresh()'s real network
        // round-trip — that used to mean the roll only started once
        // wallet.sync() + maintenance() had both finished, sometimes
        // seconds after the toast already showed. Includes feeEstimate
        // (already computed for the confirm screen) where this plan has
        // one — Ark sends have no separate fee, so effectiveAmountSats
        // alone is exact there; onchain's estimate is for this exact
        // destination/amount, so it should match too. Lightning's routing
        // fee can still genuinely differ once the real payment settles —
        // any such small correction folds in silently through the
        // quiet-catch-up path once onSent() below resolves, without a
        // second roll (see that path's own comment).
        if (spendableAtSend !== undefined) {
          // Clamped — a concurrent receive/refresh landing between reading
          // `spendable` and this running, or a fee estimate that ran high,
          // could otherwise send a negative number into the headline for
          // one frame (a real "-1 234 sats" would render, briefly, since
          // RollingDigits has no notion that a balance can't go negative).
          onSentBump?.(Math.max(0, spendableAtSend - effectiveAmountSats - (feeSatsAtSend ?? 0)) + inRoundAtSend);
        }
      }
      setDestination("");
      setAmount("");
      setResolvedKind(null);
      setPlan(null);
      setConfirmPassword("");
      hapticSuccess();
      onSent();
      onSendComplete?.();
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      // SEND_WATCHDOG_MS elapsed. withTimeout can't cancel anything, so the
      // payment is still being attempted inside the worker and may yet
      // settle — this says the UI stopped waiting, not that the money stayed
      // put. Reporting it as an error (which is what the generic branch at
      // the bottom does, leaving destination and amount filled) is what made
      // a slow-but-successful Lightning payment one tap away from being paid
      // twice. Same outcome as a type:"unknown" status: possibly sent, so
      // don't invite a blind retry.
      //
      // Deliberately narrow — only withTimeout's own rejection qualifies. A
      // rejection that came from the call itself has a verdict attached (a
      // refused address, insufficient funds, an unspendable VTXO), the money
      // definitively didn't move, and keeping the form filled so the user
      // can correct it and retry is the right behaviour there.
      //
      // The other "no verdict" case, bark.ts's watchdog terminating the
      // worker mid-send, needs nothing here: it fires onWorkerLost, which
      // App.tsx turns into a forced return to the unlock screen, so this
      // whole component unmounts and there is no filled form left to tap.
      if (isWalletCallTimeout(e)) {
        finishIndeterminate(
          t("Nevíme, jestli platba prošla. Zkontroluj historii. Pokud tam platba není, zkus to za chvíli znovu."),
        );
        return;
      }
      // The worker rejected the authorization rather than the payment. Stay
      // on the confirm screen with the plan intact so the password can be
      // retried without re-entering the destination and amount — the same
      // behaviour the (now removed) main-thread password check had, just
      // decided one realm further in.
      if (message === SPEND_AUTH_FAILED || message === SPEND_AUTH_REQUIRED) {
        setError(t("Nesprávné heslo."));
        return;
      }
      if (message === SPEND_LIMIT_EXCEEDED) {
        // Sub-threshold sends are capped per rolling day precisely so a
        // compromised page can't drain a wallet in small pieces. Reaching
        // it legitimately just means this payment needs the password too,
        // so keep the plan on screen — spendLimitReached makes the field
        // appear on the very screen the user is already looking at.
        setSpendLimitReached(true);
        setError(t("Denní limit plateb bez hesla je vyčerpaný. Potvrď prosím platbu heslem."));
        return;
      }
      // Beta, refresh engine live: coins in a refresh are locked, so a send
      // that needed them fails as "not enough funds" while the note under the
      // balance still shows them. Say why, in the same breath.
      if (
        effectiveEngineMode() === "live" &&
        /insufficient (money|funds)|insufficientfunds|not enough money|inputs only amount to/i.test(message) &&
        isRefreshNoteSafe()
      ) {
        setError(t("Na tuhle platbu nestačí volné mince. Část je právě v obnově a uvolní se po kole serveru, do ~1 hodiny."));
        setPlan(null);
        setConfirmPassword("");
        return;
      }
      surfaceError(e, setError);
      setPlan(null);
      setConfirmPassword("");
    } finally {
      setBusy(false);
      onCriticalOpChange?.(false);
      popWatchdog();
      void refreshSpendLimits();
    }
    // spendable / feeEstimate?.feeSats / onSentBump feed the optimistic
    // balance bump above and belong here: without them the bump ran against
    // whatever `spendable` was when this callback was last built, and rolled
    // the headline to a number that was simply wrong until the real refresh()
    // corrected it. Not a cost worth avoiding — SendPanel re-renders on every
    // balance poll regardless, `spendable` being one of its own props.
  }, [
    wallet,
    onSent,
    onSentToast,
    t,
    lang,
    confirmPassword,
    spendLimitReached,
    onCriticalOpChange,
    spendable,
    inRoundSats,
    feeEstimate?.feeSats,
    onSentBump,
    onSendComplete,
  ]);

  const CONFIRM_THRESHOLD_SATS = 1000;
  // The long delay is only for a changed @name address (isLongArm).
  const CONFIRM_BUTTON_ARM_DELAY_MS = 350;
  const CONFIRM_BUTTON_ARM_DELAY_LONG_MS = 1000;

  // Freezes the current form state into the exact set of arguments the SDK
  // call will receive. The single place destination normalization, amount
  // parsing and BOLT11 amount decoding happen — every consumer downstream
  // (the confirm screen, the fee preview, the password threshold, the arm
  // delay, the SDK call itself) reads the result rather than redoing any of
  // it. Returns null (having set the error) when the form isn't sendable.
  const buildPlan = useCallback((): SendPlan | null => {
    const validationMsg = validationError();
    if (validationMsg) {
      setError(validationMsg);
      return null;
    }
    // validationError() rejects a null or "invalid" kind, so this is safe —
    // and it's the only place the cast is needed, instead of at every SDK
    // call site.
    const planKind = kind as Exclude<DestinationKind, null | "invalid">;
    // For a @handle the destination handed to the SDK is the address it
    // resolved to, frozen here with everything else. validationError() only
    // lets a resolved handle through as "ark", so `found` is guaranteed.
    const resolved = nameQuery !== null && currentNameResolution?.state === "found" ? currentNameResolution : null;
    // Same for a BIP 353 name: the destination is the method picked from the
    // validated record. validationError() lets it through only as "found".
    const bipFound = bipActive && bipTarget !== null && currentBip?.state === "found" ? currentBip : null;
    const destinationArg = resolved ? resolved.address : bipFound ? bipFound.pick.destination : normalizeDestination(destination);
    const typedAmountSats = amount ? Number(amount) : undefined;
    const invoiceAmountSats = planKind === "lightning-invoice" ? decodeBolt11Amount(destinationArg) : null;
    // validationError() above already refused to build a plan at all when a
    // typed amount disagrees with what the invoice itself encodes, so by
    // this point the two can only ever be undefined/absent or equal. Still,
    // when the invoice carries its own amount, dispatch `undefined` rather
    // than the (necessarily-equal) typed value — bark decodes the invoice
    // amount itself, so there is nothing to gain from also passing an
    // explicit one alongside it, and every send.ts call site below reads
    // this same `amountSats`, so this is the one place that decides it.
    const amountSats = invoiceAmountSats !== null ? undefined : typedAmountSats;
    // A BOLT11 invoice never goes through the amount field at all (it's
    // encoded in the invoice itself, see amountRequired above), so its
    // amountSats stays undefined while what it actually moves is the
    // decoded invoice amount. Everything that reasons about "how much is
    // this send" — the password threshold, the arm delay, the confirm
    // screen, the toast — uses this, not amountSats.
    const effectiveAmountSats = invoiceAmountSats ?? typedAmountSats;
    const recipient =
      resolved && nameQuery !== null
        ? { name: nameQuery, address: resolved.address, pin: checkNamePin(nameQuery, resolved.address) }
        : undefined;
    const bip353 = bipFound && bipTarget ? { name: bipTarget.name, validUntil: bipFound.validUntil } : undefined;
    return { kind: planKind, destination: destinationArg, amountSats, effectiveAmountSats, recipient, bip353 };
  }, [validationError, kind, destination, amount, nameQuery, currentNameResolution, bipActive, bipTarget, currentBip]);

  useEffect(() => {
    if (!plan) {
      setConfirmReady(false);
      return;
    }
    setConfirmReady(false);
    const delay = isLongArm(plan) ? CONFIRM_BUTTON_ARM_DELAY_LONG_MS : CONFIRM_BUTTON_ARM_DELAY_MS;
    const timer = window.setTimeout(() => setConfirmReady(true), delay);
    return () => window.clearTimeout(timer);
  }, [plan]);

  // Beta: while the destination is empty the send button is a Paste button
  // (it could not be pressed anyway). On the tap only, never automatically: a
  // clipboard swapped by other software must not become the destination
  // unseen (the kind badge shows what landed). If the browser refuses to read
  // it, the field is focused so a long-press paste is one tap away.
  const pasteBeta = useDesignVersion() === "v2";
  const quickBeta = pasteBeta;
  const scannedDestRef = useRef<string | null>(null);
  // Set by a scan that should pay on its own (quick pay on, the QR carries the amount); the deadline keeps a
  // stale flag from firing on a later, unrelated edit.
  const autoQuickUntilRef = useRef(0);
  // From a scan that pays by itself until the sheet has taken over the screen, the form stays out of sight: it
  // would otherwise flash the raw invoice string between the camera closing and the sheet rising.
  const [quickHold, setQuickHold] = useState(false);
  const holdSawPlanRef = useRef(false);
  const holdTimerRef = useRef<number | undefined>(undefined);
  useEffect(() => () => window.clearTimeout(holdTimerRef.current), []);
  // The scan-triggered attempt in progress, so the confirm sheet can say why quick pay did not take it.
  const autoQuickFiredRef = useRef(false);
  const [quickNote, setQuickNote] = useState<QuickReason | null>(null);
  const [quickSheet, setQuickSheet] = useState(false);
  // Re-renders the panel when the worker reports new limits, so the password field follows the user's amount.
  useSpendLimitsStatus();
  const destinationRef = useRef<HTMLInputElement>(null);
  const pasteMode = pasteBeta && !destination.trim() && typeof navigator.clipboard?.readText === "function";
  const pastedAtRef = useRef(0);
  const destinationLiveRef = useRef(destination);
  useEffect(() => {
    destinationLiveRef.current = destination;
  }, [destination]);
  const pasteFromClipboard = () => {
    navigator.clipboard
      .readText()
      .then((text) => {
        const pasted = text.trim();
        if (!pasted) {
          destinationRef.current?.focus();
          return;
        }
        // The browser's paste prompt can take seconds: a read that lands after the person typed or scanned
        // something must not overwrite it.
        if (destinationLiveRef.current.trim()) return;
        pastedAtRef.current = Date.now();
        // Same unwrapping as a scan, so a copied bitcoin: URI fills the address (and amount) instead of
        // landing in the field as an invalid destination.
        const { destination: dest, amountSats } = parseScannedPayload(pasted);
        setDestination(dest);
        setResolvedKind(null);
        if (amountSats !== undefined) setAmount(String(amountSats));
      })
      .catch(() => destinationRef.current?.focus());
  };

  const requestSend = useCallback(() => {
    setError(null);
    const built = buildPlan();
    if (!built) {
      // The error effect only fires when the message changes; a second tap
      // on the same refusal still gets its shake here.
      if (motionOn && errorRef.current) {
        shake(errorRef.current);
        hapticError();
      }
      return;
    }
    if (built.bip353 && bip353Expired(built.bip353.validUntil, Date.now())) {
      surfaceError(new Error(t("Ověření jména vypršelo. Chvíli počkej a zkus znovu.")), setError);
      return;
    }
    // Small payments go straight through; anything above the threshold (or
    // an amount we can't see yet, e.g. embedded in a Lightning invoice)
    // gets a review step first, since sends can't be undone. On-chain always
    // gets the review step regardless of amount — irreversible, slower/
    // harder to reason about after the fact than an Ark/Lightning send, and
    // the on-chain network fee itself is worth seeing before a small payment
    // that's mostly fee anyway.
    //
    // Either way the same frozen plan is what gets sent: the fast path
    // hands it straight to send(), the review path parks it in state and
    // send() receives that identical object on confirmation.
    //
    // The fast path is also off once the worker's no-password budget is
    // spent (spendLimitReached): such a send now needs a password, and the
    // fast path has no screen on which to ask for one.
    const fromAutoScan = autoQuickFiredRef.current;
    autoQuickFiredRef.current = false;
    // The amount of an invoice is in the invoice: amountSats is undefined for it, effectiveAmountSats is not.
    const effective = built.effectiveAmountSats;
    const reviewable =
      !spendLimitReached &&
      built.kind !== "onchain" &&
      // Paying a name always gets the review step: it is the one place a look-alike or a changed address can be
      // caught before the money moves.
      built.recipient === undefined &&
      built.bip353 === undefined &&
      effective !== undefined;
    let fast = false;
    let quickPaid = false;
    let denied: QuickReason | null = null;
    if (reviewable) {
      if (!quickBeta) {
        // V1: payments up to 1000 sats typed in, as ever (never above what the worker lets through without a password).
        fast = built.amountSats !== undefined && built.amountSats <= Math.min(CONFIRM_THRESHOLD_SATS, getNoPasswordSats() - 1);
      } else {
        // V2 beta: quick pay is opt-in, only for what the camera just scanned, inside the user's own limits.
        const scanned = scannedDestRef.current;
        if (scanned !== null && normalizeDestination(built.destination) === scanned) {
          const d = quickDecision({
            state: loadQuickState(),
            currency,
            btcRate: rates?.[currency] ?? null,
            noPasswordSats: getNoPasswordSats(),
            hardRemainingSats: getSpendLimitsStatus()?.hardRemainingSats ?? null,
            amountSats: effective,
            now: Date.now(),
          });
          fast = d.ok;
          quickPaid = d.ok;
          if (!d.ok) denied = d.reason;
        }
      }
    }
    setQuickNote(fromAutoScan && denied !== null ? denied : null);
    if (fast) {
      if (quickPaid && effective !== undefined) {
        chargeQuick(effective, Date.now());
        // The sheet opens already sending: nothing to tap. It closes itself when the payment is through.
        setQuickSheet(true);
        setPlan(built);
      }
      send(built);
    } else {
      setQuickSheet(false);
      setPlan(built);
    }
  }, [buildPlan, send, spendLimitReached, motionOn, quickBeta, currency, rates]);

  // The parent passes a new function each render; a ref keeps handleScanResult (given to the scanner) stable.
  const onScannedGiftRef = useRef(onScannedGift);
  useEffect(() => {
    onScannedGiftRef.current = onScannedGift;
  }, [onScannedGift]);
  const handleScanResult = useCallback((raw: string) => {
    // A QR of this app's own gift/payment-request link (the composer's own
    // ShareLinkResult renders one, precisely so another phone's camera can
    // read it) isn't a send destination at all — it's a URL this same app
    // already knows how to open. Same-origin only: this must actually be a
    // link this app generated, not merely something claiming to be one.
    try {
      const url = new URL(raw);
      // The fragment holds the gift's mnemonic: decoded here, never stored or logged.
      const gift = onScannedGiftRef.current ? giftFromScannedUrl(raw, window.location.origin) : null;
      if (gift) {
        setScanning(false);
        if (gift.ok) onScannedGiftRef.current?.(gift.gift);
        else setError(t("Odkaz na dárek nejde přečíst."));
        return;
      }
      if (
        url.origin === window.location.origin &&
        (isGiftPath(url.pathname) || isRequestPath(url.pathname))
      ) {
        setScanning(false);
        window.location.href = raw;
        return;
      }
    } catch {
      // Not a URL at all (a bitcoin:/lightning:/ark: URI, or a bare
      // address/invoice) — falls through to the normal destination parse.
    }
    // A scanned profile link ("https://spendrr.app/@pavel"): pay the handle.
    const scannedHandle = handleFromProfileUrl(raw, window.location.origin);
    if (scannedHandle) {
      setDestination(`@${scannedHandle}`);
      setResolvedKind(null);
      setJustScanned(true);
      setScanning(false);
      return;
    }
    const { destination: dest, amountSats } = parseScannedPayload(raw);
    // Quick pay (beta) only applies to what the camera read, and only while the field still holds exactly that.
    scannedDestRef.current = normalizeDestination(dest);
    const auto = quickBeta && scanAutoQuick(loadQuickState(), amountSats, decodeBolt11Amount(normalizeDestination(dest)));
    if (auto) {
      autoQuickUntilRef.current = Date.now() + 4000;
      holdSawPlanRef.current = false;
      setQuickHold(true);
      window.clearTimeout(holdTimerRef.current);
      // Never hide the form for good: if no sheet comes, it is back after a moment.
      holdTimerRef.current = window.setTimeout(() => {
        if (!holdSawPlanRef.current) setQuickHold(false);
      }, 4500);
    }
    setDestination(dest);
    setResolvedKind(null);
    // The scan-lock landing animation is for a field the person is about to read; a quick payment skips the field.
    if (!auto) setJustScanned(true);
    if (amountSats !== undefined) setAmount(String(amountSats));
    setScanning(false);
  }, [quickBeta, t]);

  // Quick pay: a scan that carries its amount goes on by itself once the form can be built, which is a send
  // when it fits the user's limits and the confirm screen when it does not. On-chain is always reviewed, so
  // there the scan only fills the form.
  useEffect(() => {
    if (autoQuickUntilRef.current === 0) return;
    if (Date.now() > autoQuickUntilRef.current) {
      autoQuickUntilRef.current = 0;
      return;
    }
    if (validationError()) return; // still resolving, or not buildable: look again on the next change
    autoQuickUntilRef.current = 0;
    if (kind === "onchain") {
      setQuickHold(false);
      return;
    }
    autoQuickFiredRef.current = true;
    requestSend();
    // requestSend either opened a sheet or refused (an error on the form): in the second case the form comes back.
    window.setTimeout(() => {
      if (planRef.current === null) setQuickHold(false);
    }, 700);
  }, [kind, destination, amount, validationError, requestSend]);

  // The hold ends once the sheet it was waiting for has come and gone.
  const planRef = useRef<SendPlan | null>(null);
  useEffect(() => {
    planRef.current = plan;
    if (!quickHold) return;
    if (plan !== null) {
      holdSawPlanRef.current = true;
      return;
    }
    if (holdSawPlanRef.current) {
      holdSawPlanRef.current = false;
      setQuickHold(false);
    }
  }, [plan, quickHold]);

  // Only meaningful for single-destination kinds with a queryable network
  // fee (Ark/on-chain) — Lightning routing fees are per-hop and uncertain
  // ahead of time, and an invoice's own amount shouldn't be second-guessed.
  // A resolved @name is kind "ark" (null while checking), so it qualifies too.
  const canSendMax = (kind === "ark" || kind === "onchain") && spendable !== undefined && spendable > 0;
  const [sendingMax, setSendingMax] = useState(false);
  // The Ark fee for the whole balance does not depend on the destination, and
  // the wallet queue can sit behind a sync for a long while, so the estimate
  // starts as soon as Send opens and "Poslat vše" usually finds it ready.
  const arkMaxFeeRef = useRef<{ spendable: number; estimate: Promise<{ netAmountSats: number }> } | null>(null);
  useEffect(() => {
    if (spendable === undefined || spendable <= 0) return;
    const promise = wallet.estimateArkoorPaymentFee(spendable);
    promise.catch(() => {});
    arkMaxFeeRef.current = { spendable, estimate: promise };
  }, [wallet, spendable]);

  // The balance can move while an estimate is in flight (the refresh watcher
  // polls every few seconds); the amount must match the balance as it is now.
  const spendableRef = useRef(spendable);
  useEffect(() => {
    spendableRef.current = spendable;
  });

  const sendMax = useCallback(async () => {
    // A BIP 353 name pays the address its record resolved to, not the typed name.
    const trimmed = bipActive && currentBip?.state === "found" ? currentBip.pick.destination : normalizeDestination(destination);
    if (!trimmed || spendable === undefined || (kind !== "ark" && kind !== "onchain")) return;
    setSendingMax(true);
    setError(null);
    try {
      let target = spendable;
      let estimate;
      // One re-estimate for a balance that moved meanwhile. Nothing later
      // compares the amount to the balance, so a second move is refused here.
      for (let attempt = 0; attempt < 2; attempt++) {
        const prefetched = arkMaxFeeRef.current;
        estimate =
          kind === "ark"
            ? await (prefetched?.spendable === target
                ? prefetched.estimate.catch(() => wallet.estimateArkoorPaymentFee(target))
                : wallet.estimateArkoorPaymentFee(target))
            : await wallet.estimateSendOnchainFee(trimmed, target);
        const latest = spendableRef.current;
        if (latest === undefined || latest === target) break;
        target = latest;
      }
      if (spendableRef.current !== target) throw new Error(t("Zůstatek se změnil, zkus to znovu."));
      if (!estimate || estimate.netAmountSats <= 0) {
        throw new Error(t("Zůstatek nepokryje ani poplatek za odeslání."));
      }
      setAmount(String(estimate.netAmountSats));
    } catch (e) {
      surfaceError(e, setError);
    } finally {
      setSendingMax(false);
    }
  }, [wallet, destination, kind, spendable, t, bipActive, currentBip]);

  // Best-effort fee preview for the confirm screen — onchain sends here go
  // through the Ark wallet's own onchain payout (wallet.sendOnchain), which
  // has no fee-rate parameter to offer the user a choice on; the SDK/server
  // decides the rate. This at least surfaces what it'll actually cost before
  // the irreversible tap, same non-blocking pattern as BoardConfirmModal's
  // estimateBoardFee() — a failed estimate still lets the send proceed.
  // Lightning kinds (invoice/address/lnurl/offer) share one estimator that
  // only takes an amount, not the destination — the routing fee doesn't
  // depend on which invoice/address it resolves to, only how much is sent.
  useEffect(() => {
    if (!plan) {
      setFeeEstimate(null);
      return;
    }
    const isLightning =
      plan.kind === "lightning-invoice" ||
      plan.kind === "lightning-address" ||
      plan.kind === "lnurl" ||
      plan.kind === "lightning-offer";
    if (plan.kind !== "onchain" && !isLightning) {
      setFeeEstimate(null);
      return;
    }
    // Estimated for the plan's own destination/amount, so the fee shown is
    // the fee for the send that will actually happen.
    const { destination: trimmed, effectiveAmountSats: amountSats } = plan;
    if (!trimmed || amountSats === undefined) return;
    // The previous send's fee must not show for this plan while it loads.
    setFeeEstimate(null);
    setFeeFailed(false);
    let cancelled = false;
    const estimate =
      plan.kind === "onchain"
        ? wallet.estimateSendOnchainFee(trimmed, amountSats)
        : wallet.estimateLightningSendFee(amountSats);
    estimate
      .then((result) => {
        if (!cancelled) setFeeEstimate(result);
      })
      .catch(() => {
        if (!cancelled) {
          setFeeEstimate(null);
          setFeeFailed(true);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [plan, wallet]);

  const confirmSheet =
    plan ? (
        <SendConfirmSheet
          plan={{
            onchain: plan.kind === "onchain",
            lightningAddress: plan.kind === "lightning-address",
            destination: plan.destination,
            amountSats: plan.effectiveAmountSats,
            recipient: plan.recipient && {
              name: plan.recipient.name,
              address: plan.recipient.address,
              changed: plan.recipient.pin === "changed",
            },
            bip353: plan.bip353,
          }}
          feeSats={feeEstimate ? feeEstimate.feeSats : null}
          feePending={
            !feeEstimate &&
            !feeFailed &&
            plan.effectiveAmountSats !== undefined &&
            (plan.kind === "onchain" ||
              plan.kind === "lightning-invoice" ||
              plan.kind === "lightning-address" ||
              plan.kind === "lnurl" ||
              plan.kind === "lightning-offer")
          }
          rate={rates ? rates[currency] : null}
          currency={currency}
          amountUnit={amountUnit}
          needsPassword={planNeedsPassword(plan) || spendLimitReached}
          password={confirmPassword}
          onPassword={setConfirmPassword}
          busy={busy}
          ready={confirmReady}
          armMs={motionOn ? (isLongArm(plan) ? CONFIRM_BUTTON_ARM_DELAY_LONG_MS : CONFIRM_BUTTON_ARM_DELAY_MS) : undefined}
          error={error}
          errorRef={errorRef}
          onConfirm={() => send(plan)}
          onBack={() => {
            setPlan(null);
            setConfirmPassword("");
          }}
          quick={quickSheet}
          extraNote={quickNote === null ? null : quickNoteText(quickNote, t)}
        />
    ) : null;

  return (
    <>
    <div className={`panel${quickHold ? " is-quick-hold" : ""}`}>
      <div className="field">
        <label className="field-label">{t("Komu platíš?")}</label>
        <div className="destination-row">
          <input
            ref={destinationRef}
            className={justScanned ? "just-scanned" : undefined}
            value={destination}
            onChange={(e) => {
              const v = e.target.value;
              // A pasted BIP21 URI is unwrapped exactly like a scanned one
              // (ark=/lightning=/lno= beside the address, amount).
              if (/^\s*(?:bitcoin|ark):/i.test(v)) {
                const { destination: dest, amountSats } = parseScannedPayload(v);
                setDestination(dest);
                if (amountSats !== undefined) setAmount(String(amountSats));
              } else {
                setDestination(v);
              }
              setResolvedKind(null);
            }}
            onFocus={() => setDestinationFocused(true)}
            onBlur={() => setDestinationFocused(false)}
            placeholder={t("ark… / bc… / lnbc… / jmeno@domena.cz")}
            spellCheck={false}
            autoComplete="off"
          />
          <button
            type="button"
            className="secondary scan-btn"
            onClick={() => setPickingSource(true)}
            aria-label={t("Naskenovat QR kód")}
          >
            <ScanIcon />
          </button>
        </div>
        {visibleSuggestions.length > 0 && (
          <div className="name-suggestions" role="listbox" aria-label={t("Dříve placená jména")}>
            {visibleSuggestions.map((s) => (
              <button
                key={s.name}
                type="button"
                role="option"
                aria-selected={false}
                className="name-suggestion"
                onClick={() => {
                  setDestination(`@${s.name}`);
                  setResolvedKind(null);
                }}
              >
                <Avatar seed={s.address} size={28} />
                <span className="recipient-chip-name">
                  {s.name}
                  <span className="recipient-chip-domain">@{NAME_DOMAIN}</span>
                </span>
              </button>
            ))}
          </div>
        )}
        {nameQuery !== null ? (
          // While suggestions are up, a half-typed name is not yet a mistake:
          // "Takové jméno nikdo nemá" for "pav" would only be noise.
          (visibleSuggestions.length === 0 ||
            currentNameResolution?.state === "found" ||
            currentNameResolution?.state === "checking") && (
            <NameLookupStatus query={nameQuery} resolution={currentNameResolution} />
          )
        ) : bipTarget !== null && bipActive ? (
          <Bip353LookupStatus name={bipTarget.name} resolution={currentBip} />
        ) : (
          <>
            {kind && kind !== "invalid" && <span className="kind-badge">{t(KIND_LABELS[kind])}</span>}
            {kind === "invalid" && !destinationFocused && (
              <span className="kind-badge kind-badge-invalid">{t("Neplatná adresa nebo faktura")}</span>
            )}
          </>
        )}
      </div>
      {pickingSource && (
        <Suspense fallback={null}>
          <QrSourceSheet
            onCamera={() => {
              setPickingSource(false);
              setScanning(true);
            }}
            onResult={(text) => {
              setPickingSource(false);
              handleScanResult(text);
            }}
            onClose={() => setPickingSource(false)}
          />
        </Suspense>
      )}
      {scanning && (
        <Suspense fallback={null}>
          <QrScannerModal
            onResult={handleScanResult}
            onClose={() => {
              setScanning(false);
              // Only when this scanner was opened via the homepage's QR
              // shortcut — cancelling it should feel like backing out of that
              // shortcut entirely (back to Home), not landing on an empty Send
              // form the user never asked to see. A manual reopen of the
              // scanner from within the form (autoScan is a mount-time-only
              // value, so this stays false after the first close) cancels
              // back into the form as normal.
              if (autoScan) onCancelAutoScan?.();
            }}
          />
        </Suspense>
      )}
      <AmountInput
        label={t("Částka")}
        sats={amount}
        onSatsChange={setAmount}
        onUnitChange={setAmountUnit}
        rates={rates}
        currency={currency}
        placeholder="21000"
        actionSlot={
          canSendMax ? (
            <button type="button" className="link-btn" disabled={sendingMax} onClick={sendMax}>
              {sendingMax ? t("Počítám…") : t("Poslat vše")}
            </button>
          ) : undefined
        }
      />
      {/* While the V2 sheet is open it shows the error itself and owns the ref. */}
      {error && !confirmSheet && (
        <div className="banner banner-danger" ref={errorRef}>
          <ErrorCircleIcon />
          <span>{error}</span>
        </div>
      )}
      {success && (
        <div className="banner banner-success">
          <SuccessCircleIcon />
          <span>{success}</span>
        </div>
      )}
      <button
        className={`send-submit${motionOn && busy ? " sending" : ""}`}
        disabled={
          pasteBeta
            ? busy || (!pasteMode && (!destination.trim() || (amountRequired && !amount) || kind === null || kind === "invalid"))
            : busy || !destination.trim() || (amountRequired && !amount) || kind === null || kind === "invalid"
        }
        onClick={() => {
          if (pasteMode) pasteFromClipboard();
          // A double tap on Paste must not carry straight on to the confirm sheet.
          else if (Date.now() - pastedAtRef.current > SEND_AFTER_PASTE_GUARD_MS) requestSend();
        }}
      >
        {pasteBeta ? (
          <span className="send-swap" data-mode={pasteMode ? "paste" : "send"}>
            <span className="send-swap-paste" aria-hidden={!pasteMode}>
              {t("Vložit ze schránky")}
            </span>
            <span className="send-swap-send" aria-hidden={pasteMode}>
              {t("Odeslat")}
            </span>
          </span>
        ) : (
          t("Odeslat")
        )}
      </button>
    </div>
    {confirmSheet}
    </>
  );
}

// What to tell the person when a BIP 353 name can't be paid.
function bip353ProblemText(resolution: Bip353Resolution, t: (cs: string) => string): string {
  switch (resolution.state) {
    case "found":
    case "fallback":
      return "";
    case "absent":
      return t("Jméno nemá platební záznam.");
    case "unsupported":
      return t("Záznam nemá podporovaný způsob platby.");
    case "error":
      return t("Jméno se nepodařilo ověřit. Zkus to za chvíli znovu.");
    case "invalid":
      if (resolution.code === "expired") return t("Podpis záznamu je mimo platnost. Zkontroluj čas v zařízení.");
      if (resolution.code === "ambiguous") return t("Záznam není jednoznačný. Platbu jsem zastavil.");
      if (resolution.code === "unsupported") return t("Záznam vyžaduje nepodporovanou funkci.");
      return t("Záznam se nepodařilo ověřit. Platbu jsem zastavil.");
  }
}

// The line under the send field for a BIP 353 name: who it is (avatar drawn from
// the address the record resolved to, so a changed record is a visibly different
// picture) and by which method it will be paid, or why it can't be.
function Bip353LookupStatus({ name, resolution }: { name: string; resolution: Bip353Resolution | null }) {
  const t = useT();
  if (resolution === null) return <span className="kind-badge">{t("Ověřuji jméno…")}</span>;
  if (resolution.state === "found") {
    const { pick } = resolution;
    const at = name.lastIndexOf("@");
    return (
      <>
        <span className="recipient-chip">
          <Avatar seed={pick.destination} size={24} />
          <span className="recipient-chip-name">
            {name.slice(0, at)}
            <span className="recipient-chip-domain">{name.slice(at)}</span>
          </span>
        </span>
        <span className="kind-badge">{t(KIND_LABELS[pick.kind])}</span>
      </>
    );
  }
  return <span className="kind-badge kind-badge-invalid">{bip353ProblemText(resolution, t)}</span>;
}

// What to tell the person when a typed @handle can't be paid.
function nameProblemText(resolution: NameResolution, t: (cs: string) => string): string {
  if (resolution.state === "found" || resolution.state === "checking") return "";
  if (resolution.state === "bad-address") return t("Tohle jméno ukazuje na neplatnou adresu. Platbu jsem zastavil.");
  if (resolution.state === "error") return t("Jméno se nepodařilo ověřit. Zkus to za chvíli znovu.");
  switch (resolution.status) {
    case "quarantined":
      return t("Tohle jméno se teď nedá použít.");
    case "reserved":
      return t("Tohle jméno je vyhrazené.");
    case "free":
      return t("Takové jméno nikdo nemá. Zkontroluj překlepy.");
    default:
      return t("Neplatné jméno.");
  }
}

// The line under the send field while a @handle is being typed: who it
// resolves to (avatar drawn from the address, so a one-character typo in the
// name is a visibly different picture) or why it can't be paid.
// The name is written out as the full address, "pavel@spendrr.app" with the
// domain muted: "@pavel" is only the short way to type it in Spendrr, and the
// full form is the one that also works from other wallets.
function NameLookupStatus({ query, resolution }: { query: string; resolution: NameResolution | null }) {
  const t = useT();
  if (resolution === null) return <span className="kind-badge">{t("Ověřuji jméno…")}</span>;
  if (resolution.state === "found" || resolution.state === "checking") {
    return (
      <span className={`recipient-chip${resolution.state === "checking" ? " is-checking" : ""}`}>
        <Avatar seed={resolution.address} size={24} />
        <span className="recipient-chip-name">
          {query}
          <span className="recipient-chip-domain">@{NAME_DOMAIN}</span>
        </span>
        <span className="muted small">
          {resolution.state === "checking"
            ? t("ověřuji…")
            : `${resolution.address.slice(0, 8)}…${resolution.address.slice(-4)}`}
        </span>
      </span>
    );
  }
  return <span className="kind-badge kind-badge-invalid">{nameProblemText(resolution, t)}</span>;
}
