import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { BUMP_EMOJI, BumpSession, findBumpArrival, maxMovementId, type BumpOutcome, type FlowView } from "../lib/bump/bump";
import {
  PASSWORD_REQUIRED_THRESHOLD_SATS,
  SPEND_AUTH_FAILED,
  SPEND_AUTH_REQUIRED,
  SPEND_LIMIT_EXCEEDED,
} from "../lib/wallet/walletSession";
import { withTimeout, isWalletCallTimeout, SEND_WATCHDOG_MS, TIMEOUT_MESSAGE } from "../lib/wallet/walletCall";
import { loadVaultOrPrompt, missingVaultText } from "../lib/vault/vaultAccess";
import { hapticNotify, hapticSuccess, hapticTap } from "../lib/ui/haptics";
import type { FiatCurrency } from "../lib/currency";
import { localeFor, tf, useLang, useT } from "../lib/i18n";
import type { Movement } from "@secondts/bark";
import type { WalletClient } from "../lib/wallet/bark";
import { setBumpReceiving, setPaymentPriority } from "../lib/wallet/paymentPriority";
import {
  AmountField,
  BigAmount,
  Collapse,
  Pill,
  Screen,
  Sheet,
  SHEET_EXIT_MS,
  StatusMark,
  useAmountEntry,
  useKeyboardInset,
  WaitingDots,
} from "./sheet/PaySheet";
import "./BumpOverlay.css";

// Real, wallet-integrated "tap two phones together to pay" — see
// src/lib/bump/bump.ts's own top comment for the pairing design, and
// public/bump-lab.html for the standalone feasibility test it grew out of.
//
// Deliberately passive: no button. This mounts once, for as long as the
// home screen is showing, the v2 beta toggle and this feature's own
// Settings switch are both on, and motion permission was already granted
// (see BumpPayToggle in Settings.tsx). It renders nothing at all until two
// phones actually paired; the rest of the home screen is untouched.
//
// After pairing, both phones follow one shared flow held by the server
// (worker/bump.ts's PairFlow), so each shows the other's progress live:
//   paired    emoji + "Platím" / "Přijímám" (picking also confirms emoji)
//   sender    amount → "Zaplatit" → progress → "Doručeno" once the
//             receiver's own history shows it
//   receiver  "zadává částku…" → "Přichází 2 500 sats" → "Přijato"
// Only the sender ever enters an amount.
//
// The payment itself is a single, narrow, arkoor-only call made directly
// here (wallet.sendArkoorPayment, with the same withTimeout/SEND_WATCHDOG_MS
// protection and password-above-threshold gate SendPanel's own send() uses)
// rather than routed through SendPanel's classify/confirm machinery — bump
// never has an ambiguous destination to classify (it's always exactly the
// address the pairing handed back). Before any money moves, the sender
// announces the amount to the pair and only pays if the server accepts it
// (it refuses once the receiver cancelled).
//
// Motion: sheet springs up from the bottom, each step cross-fades in while
// the sheet's height eases to fit it, the paired screen plays a "tap"
// animation, progress rings resolve into a drawn checkmark, and amounts
// count up. All of it collapses to plain fades under
// prefers-reduced-motion (BumpOverlay.css).

// How long after "sent" before each side stops waiting for the other and
// says so plainly (the payment itself may still land; history is truth).
const DELIVERY_WAIT_MS = 30_000;
const RESULT_AUTO_CLOSE_MS = 4000;
const NOTICE_AUTO_CLOSE_MS = 3500;
// Receiver, while money is on its way: a direct wallet.history() read every
// second (local, and the SDK's daemon pulls the incoming payment in by
// itself), plus a full refresh every few seconds as a backstop.
const ARRIVAL_POLL_MS = 1000;
const RECEIVER_REFRESH_MS = 6000;
const HISTORY_READ_TIMEOUT_MS = 5000;
// Retry for the history baseline taken at pairing, if the first read fails.
const BASELINE_RETRY_MS = 2000;
// The sheet's own exit animation (PaySheet.css); the quiet bubble's exit
// is timed to the same beat.
const EXIT_MS = SHEET_EXIT_MS;
// A quiet (faint-tap) pairing nobody touched goes away on its own.
const QUIET_BUBBLE_MS = 10_000;

export default function BumpOverlay({
  wallet,
  myAddress,
  spendable,
  rates,
  currency,
  onSent,
  onSentBump,
  onCriticalOpChange,
  paused = false,
}: {
  wallet: WalletClient;
  myAddress: string;
  spendable: number | undefined;
  rates: Record<FiatCurrency, number> | null;
  currency: FiatCurrency;
  onSent: () => Promise<{ balance: { spendableSats: number }; history: Movement[] } | undefined> | void;
  onSentBump?: (overrideSpendable?: number) => void;
  // Same mechanism SendPanel's own send() uses (Dashboard.tsx) to defer
  // App.tsx's inactivity auto-lock while a payment is actually in flight.
  onCriticalOpChange?: (active: boolean) => void;
  // Another full-screen surface is up (Zprávy): stop listening for taps. A
  // pairing or payment already under way is never cut off; the pause takes
  // effect once it is over.
  paused?: boolean;
}) {
  const t = useT();
  const lang = useLang();
  const fmt = (n: number) => n.toLocaleString(localeFor(lang));
  const rate = rates ? rates[currency] : null;

  const [outcome, setOutcome] = useState<BumpOutcome>({ kind: "idle" });
  const keyboardInset = useKeyboardInset();
  const sessionRef = useRef<BumpSession | null>(null);
  const [closing, setClosing] = useState(false);
  // This phone only felt a faint tap: show the pairing as a small bubble
  // (see the "paired" outcome's `quiet`) until someone taps it.
  const [quiet, setQuiet] = useState(false);

  // Sender.
  const [password, setPassword] = useState("");
  const [sendBusy, setSendBusy] = useState(false);
  // Synchronous double-tap guard for pay(). sendBusy alone can't be one: two
  // taps inside one frame both run pay() before the re-render that disables
  // the button, and the server accepts a repeated "sending" as a harmless
  // retry, so both went on to call sendArkoorPayment. Owned by pay() alone
  // (restart() leaves it be): only the pay() that set it may clear it.
  const payingRef = useRef(false);
  // The amount the wallet call was actually made with. The screens after
  // "Zaplatit" show this, not the live amountSats, which in fiat mode moves
  // with every price update.
  const [sentSats, setSentSats] = useState<number | null>(null);
  // The worker asked for the password on an amount under the threshold: the
  // rolling daily cap on password-less sends is used up (SPEND_LIMIT_EXCEEDED),
  // the same case SendPanel's spendLimitReached covers. Kept across restarts
  // on purpose: the cap lives as long as this wallet session, so the next
  // bump would only hit it again after a pointless failed attempt.
  const [forcePassword, setForcePassword] = useState(false);
  const [sendError, setSendError] = useState<string | null>(null);
  const [errorNonce, setErrorNonce] = useState(0);
  // The big amount field (sats/fiat toggle, formatting, shake-on-refusal)
  // is the shared one every sheet in this app uses — see PaySheet.tsx.
  const amount = useAmountEntry(rate, currency, fmt, () => setSendError(null));
  // Deliberately never a confident "sent!" on the SDK call alone:
  // archive/canary/README.md documents sendArkoorPayment() sometimes reporting
  // success while funds don't move. "Doručeno" needs the receiver's own
  // confirmation; without it the screen says "Odesláno" and points at
  // history. A genuine timeout is its own state, never a plain retryable
  // error (withTimeout only stops waiting, it can't know if the call
  // landed), so the person isn't invited to pay twice.
  const [sendResult, setSendResult] = useState<"sent" | "timeout" | null>(null);
  const [deliveryWaitOver, setDeliveryWaitOver] = useState(false);

  // Receiver. The payment is recognised by a new movement in the wallet's
  // own history (see findBumpArrival), compared against the highest movement
  // id taken at pairing, before the sender can have paid. undefined: not
  // read yet.
  const [historyBaseline, setHistoryBaseline] = useState<number | undefined>(undefined);
  const receivedRef = useRef(false);
  const [receivedSats, setReceivedSats] = useState<number | null>(null);
  const [arrivalWaitOver, setArrivalWaitOver] = useState(false);

  // Once money can be moving (the sender's "sending" was accepted, or the
  // receiver saw it), this screen belongs to the payment, not to the pairing
  // server. Losing the server after that (a deploy, a dead connection) used
  // to replace the sender's "Odesláno" or "Odesílám…" with "Platba vypršela"
  // or "Spojení se přerušilo", which reads as "try again" and invites paying
  // twice. Now such a notice only marks the flow as detached: the sender
  // keeps its real result, the receiver keeps watching its own history, and
  // each just stops waiting for the other phone's word.
  const committedRef = useRef(false);
  const [detached, setDetached] = useState(false);

  const restart = useCallback(() => {
    // Always stop the outgoing session first: a leaked one keeps its
    // listener and its callbacks racing the new one (the 2026-09-19
    // incident — see git history of this file).
    sessionRef.current?.stop();
    amount.reset();
    setPassword("");
    setSendError(null);
    setSendResult(null);
    // Every exit from pay() clears this itself; reset here too so no future
    // path can leave the next pairing's sender on a button-less "Odesílám…".
    setSendBusy(false);
    setSentSats(null);
    setDeliveryWaitOver(false);
    setReceivedSats(null);
    setArrivalWaitOver(false);
    setHistoryBaseline(undefined);
    receivedRef.current = false;
    committedRef.current = false;
    setDetached(false);
    setQuiet(false);
    // "paired" arrives again when its settling flag flips; only the first
    // one decides bubble vs. sheet, so a bubble someone already opened
    // doesn't fold back up.
    let quietDecided = false;
    const session = new BumpSession(myAddress, (o) => {
      if (committedRef.current && NOTICE_KINDS.has(o.kind)) {
        setDetached(true);
        return;
      }
      if (o.kind === "paired" && !quietDecided) {
        quietDecided = true;
        setQuiet(o.quiet);
      }
      // A notice about a faint pairing that was never shown: dropped (the
      // notice effect below restarts silently while quiet).
      if (NOTICE_KINDS.has(o.kind) && "quiet" in o && o.quiet) setQuiet(true);
      setOutcome(o);
    });
    sessionRef.current = session;
    void session.start();
  }, [myAddress, amount.reset]);

  const listenPaused = paused && (outcome.kind === "idle" || outcome.kind === "armed");
  useEffect(() => {
    if (listenPaused) return;
    restart();
    return () => sessionRef.current?.stop();
  }, [restart, listenPaused]);

  // Plays the sheet's exit animation, then runs `then` (normally restart).
  const closeThen = useCallback(
    (then: () => void) => {
      setClosing(true);
      setTimeout(() => {
        setClosing(false);
        then();
      }, EXIT_MS);
    },
    [],
  );

  // Backing out on purpose: tell the other phone (while that's still
  // meaningful — see BumpSession.cancel), then close.
  const cancelAndClose = useCallback(() => {
    sessionRef.current?.cancel();
    closeThen(restart);
  }, [closeThen, restart]);

  const flow: FlowView | null = outcome.kind === "sending" || outcome.kind === "receiving" ? outcome.flow : null;
  const stage = flow?.stage;

  const isNotice = NOTICE_KINDS.has(outcome.kind);

  // From pairing until the sheet closes, keep the wallet queue clear of
  // background chores so the send and the receiver's history checks never
  // wait behind them (see paymentPriority.ts). Started at pairing, not at
  // "Zaplatit", so a chore already running has time to finish while the
  // amount is being typed. Re-armed because the window self-expires.
  const inFlow = outcome.kind === "paired" || outcome.kind === "sending" || outcome.kind === "receiving";
  useEffect(() => {
    if (!inFlow) return;
    setPaymentPriority(true);
    const rearm = setInterval(() => setPaymentPriority(true), 30_000);
    return () => {
      clearInterval(rearm);
      setPaymentPriority(false);
    };
  }, [inFlow]);

  // While this phone is the receiver, Dashboard's own "Platba přijata" toast
  // for the same payment is suppressed (see setBumpReceiving). Re-armed
  // because the window self-expires; released with a short grace on exit.
  const receivingRole = outcome.kind === "receiving";
  useEffect(() => {
    if (!receivingRole) return;
    setBumpReceiving(true);
    const rearm = setInterval(() => setBumpReceiving(true), 30_000);
    return () => {
      clearInterval(rearm);
      setBumpReceiving(false);
    };
  }, [receivingRole]);

  // --- Notices close themselves -----------------------------------------
  // A quiet pairing ends silently: a phone that never took over the screen
  // shouldn't then pop up "Nejednoznačné" or "zrušeno" about it.
  useEffect(() => {
    if (!isNotice) return;
    if (quiet) {
      restart();
      return;
    }
    const timer = setTimeout(() => closeThen(restart), NOTICE_AUTO_CLOSE_MS);
    return () => clearTimeout(timer);
  }, [isNotice, quiet, closeThen, restart]);

  // --- Sender: waiting for the receiver's confirmation -------------------
  // The receiver's word alone is not "Doručeno": it only counts once this
  // phone's own wallet call went through (or timed out, where it can't be
  // ruled out). A receiver reporting arrival while the call here threw, or
  // was never made, gets its own screen that says exactly that rather than a
  // confident success over a local failure.
  const peerConfirmed = outcome.kind === "sending" && stage === "received";
  const delivered = peerConfirmed && (sendResult === "sent" || sendResult === "timeout");
  const deliveryConflict = peerConfirmed && !delivered && !sendBusy;
  useEffect(() => {
    if (sendResult !== "sent" || delivered) return;
    const timer = setTimeout(() => setDeliveryWaitOver(true), DELIVERY_WAIT_MS);
    return () => clearTimeout(timer);
  }, [sendResult, delivered]);
  useEffect(() => {
    if (!delivered) return;
    hapticSuccess();
    const timer = setTimeout(() => closeThen(restart), RESULT_AUTO_CLOSE_MS);
    return () => clearTimeout(timer);
  }, [delivered, closeThen, restart]);

  // --- Receiver: spotting the money --------------------------------------
  // Recognised by the wallet's own history, not by the balance going up. A
  // balance delta can't tell the payment from anything else that raises
  // spendable: a VTXO refresh finishing (locked round funds become spendable
  // again, and the SDK daemon keeps joining rounds during the flow), or an
  // unrelated incoming payment. Either used to show "Přijato" here and
  // "Doručeno" on the sender for money that may never have been sent.
  const isReceiving = outcome.kind === "receiving";
  const incoming = isReceiving && (stage === "sending" || stage === "sent");
  useEffect(() => {
    if (incoming) committedRef.current = true;
  }, [incoming]);
  const expectedSats = isReceiving ? flow?.amountSats : undefined;
  const readHistory = useCallback(async (): Promise<Movement[] | undefined> => {
    try {
      return await withTimeout(wallet.history(), HISTORY_READ_TIMEOUT_MS, TIMEOUT_MESSAGE);
    } catch {
      return undefined;
    }
  }, [wallet]);

  // Baseline: the highest movement id, taken from pairing on, while no money
  // can be moving yet (the sender still has to pick a direction and type an
  // amount). Once "sending" is seen, a read still in flight is discarded
  // rather than trusted: it may already contain the payment, which would
  // then never count as new. Without a baseline nothing is recognised and
  // the receiver falls back to "Platba je na cestě"; a missed confirmation
  // is harmless, a false one is not.
  const baselineWindow = inFlow && stage !== "sending" && stage !== "sent" && stage !== "received";
  useEffect(() => {
    if (!baselineWindow || historyBaseline !== undefined) return;
    let stopped = false;
    let retry: ReturnType<typeof setTimeout> | undefined;
    const attempt = async () => {
      const movements = await readHistory();
      if (stopped) return;
      if (movements) setHistoryBaseline(maxMovementId(movements));
      else retry = setTimeout(() => void attempt(), BASELINE_RETRY_MS);
    };
    void attempt();
    return () => {
      stopped = true;
      clearTimeout(retry);
    };
  }, [baselineWindow, historyBaseline, readHistory]);

  const checkArrival = useCallback(
    (movements: readonly Movement[] | undefined) => {
      if (receivedRef.current || historyBaseline === undefined || !movements) return;
      const match = findBumpArrival(movements, historyBaseline, expectedSats);
      if (!match) return;
      receivedRef.current = true;
      setReceivedSats(match.effectiveBalanceSats);
      hapticNotify();
      void sessionRef.current?.confirmReceived();
      void Promise.resolve(onSent())
        .then((result) => onSentBump?.(result?.balance.spendableSats))
        .catch(() => {});
    },
    [historyBaseline, expectedSats, onSentBump, onSent],
  );

  // Money on its way: read the history directly every second, with a full
  // refresh now and then as a backstop (its result is checked too).
  useEffect(() => {
    if (!incoming || receivedSats !== null || historyBaseline === undefined) return;
    let stopped = false;
    let busy = false;
    const tick = async () => {
      if (busy || stopped) return;
      busy = true;
      const movements = await readHistory();
      busy = false;
      if (!stopped) checkArrival(movements);
    };
    void tick();
    const poll = setInterval(() => void tick(), ARRIVAL_POLL_MS);
    const refresh = setInterval(() => {
      void Promise.resolve(onSent())
        .then((result) => {
          if (!stopped) checkArrival(result?.history);
        })
        .catch(() => {});
    }, RECEIVER_REFRESH_MS);
    return () => {
      stopped = true;
      clearInterval(poll);
      clearInterval(refresh);
    };
  }, [incoming, receivedSats, historyBaseline, readHistory, checkArrival, onSent]);

  useEffect(() => {
    // Detached, the sender's "sent" will never come: start the clock anyway.
    if (!isReceiving || (stage !== "sent" && !(detached && incoming)) || receivedSats !== null) return;
    const timer = setTimeout(() => setArrivalWaitOver(true), DELIVERY_WAIT_MS);
    return () => clearTimeout(timer);
  }, [isReceiving, stage, receivedSats, detached, incoming]);

  useEffect(() => {
    if (receivedSats === null) return;
    const timer = setTimeout(() => closeThen(restart), RESULT_AUTO_CLOSE_MS);
    return () => clearTimeout(timer);
  }, [receivedSats, closeThen, restart]);

  // --- Sender: amount ------------------------------------------------------
  const amountSats = amount.sats;
  const overBalance = spendable !== undefined && amountSats > spendable;
  const needsPassword = amountSats >= PASSWORD_REQUIRED_THRESHOLD_SATS || forcePassword;
  const canPay = amountSats > 0 && !overBalance && (!needsPassword || password.length > 0) && !sendBusy;

  // A refused amount shakes side to side, like a wrong passcode on iOS.
  const shake = (message: string) => {
    setSendError(message);
    setErrorNonce((n) => n + 1);
    amount.shake();
  };

  const pay = async () => {
    if (payingRef.current || outcome.kind !== "sending" || !canPay) return;
    const session = sessionRef.current;
    if (!session) return;
    payingRef.current = true;
    const peerAddress = outcome.peerAddress;
    const sats = amountSats;
    const auth = needsPassword ? password : null;
    // Whether the screen still belongs to this pairing. Closing or replacing
    // it stops (or swaps) the session, so a stopped or foreign session means
    // nobody is looking at this payment any more.
    const current = () => sessionRef.current === session && !session.closed;
    let critical = false;
    setSendBusy(true);
    setSendError(null);
    setSentSats(sats);
    try {
      // Receiver sees "Přichází …" from here. Refused = the other phone
      // cancelled or the pair expired; the session has already switched the
      // screen to that outcome, so just don't pay.
      let accepted: boolean;
      try {
        accepted = await session.announceSending(sats);
      } catch {
        if (current()) shake(t("Nepodařilo se spojit s druhým telefonem. Zkus to znovu."));
        return;
      }
      if (!accepted) return;
      // Accepted, but the screen moved on while the announcement was in
      // flight (a notice closed it, or the overlay unmounted): no payment
      // nobody can see the result of. Put the receiver back on the amount.
      if (!current()) {
        session.abandonSending();
        return;
      }
      committedRef.current = true;
      // Defers App.tsx's inactivity auto-lock for the duration of the actual
      // wallet call (see the prop's comment).
      critical = true;
      onCriticalOpChange?.(true);
      try {
        let spender = wallet;
        if (auth !== null) {
          const vault = loadVaultOrPrompt();
          if (!vault) throw new Error(t(missingVaultText()));
          spender = wallet.withAuth({ vault, password: auth });
        }
        await withTimeout(spender.sendArkoorPayment(peerAddress, sats), SEND_WATCHDOG_MS, t(TIMEOUT_MESSAGE));
        session.reportSendResult(true);
        setSendResult("sent");
        const result = await onSent();
        onSentBump?.(result?.balance.spendableSats);
      } catch (e) {
        if (isWalletCallTimeout(e)) {
          setSendResult("timeout");
          return;
        }
        session.reportSendResult(false);
        const message = e instanceof Error ? e.message : String(e);
        // The worker's spend gate refused the call before any money moved
        // (walletWorkerImpl.ts's enforceSpendPolicy). Matched exactly, like
        // SendPanel does, never by a regex over the text.
        if (message === SPEND_LIMIT_EXCEEDED || (message === SPEND_AUTH_REQUIRED && auth === null)) {
          // Needs the password after all: bring the field up on this very
          // screen and keep the amount, so it's one more tap, not a retype.
          setForcePassword(true);
          shake(
            t(
              message === SPEND_LIMIT_EXCEEDED
                ? "Denní limit plateb bez hesla je vyčerpaný. Potvrď prosím platbu heslem."
                : "Tuto platbu je potřeba potvrdit heslem.",
            ),
          );
        } else if (message === SPEND_AUTH_FAILED || message === SPEND_AUTH_REQUIRED) {
          shake(t("Nesprávné heslo."));
        } else {
          shake(friendlySendError(e, t));
        }
      }
    } finally {
      if (critical) onCriticalOpChange?.(false);
      setSendBusy(false);
      payingRef.current = false;
    }
  };

  // --- Quiet bubble ------------------------------------------------------
  // Money actually on its way always gets the full sheet.
  const compact =
    quiet &&
    (outcome.kind === "paired" ||
      ((outcome.kind === "sending" || outcome.kind === "receiving") && stage === "entering"));
  const compactPaired = compact && outcome.kind === "paired";
  useEffect(() => {
    if (!compactPaired) return;
    const timer = setTimeout(cancelAndClose, QUIET_BUBBLE_MS);
    return () => clearTimeout(timer);
  }, [compactPaired, cancelAndClose]);

  // --- Rendering -----------------------------------------------------------
  if (outcome.kind === "idle" || outcome.kind === "armed") return null;
  if (quiet && isNotice) return null;

  if (compact && (outcome.kind === "paired" || outcome.kind === "sending" || outcome.kind === "receiving")) {
    const text =
      outcome.kind === "paired"
        ? t("Spojit s telefonem poblíž?")
        : outcome.kind === "receiving"
          ? t("Telefon poblíž ti posílá platbu")
          : t("Telefon poblíž od tebe čeká platbu");
    return (
      <div
        className={`bump-bubble${closing ? " is-closing" : ""}`}
        style={{ ["--kb" as string]: `${keyboardInset}px` }}
        role="button"
        tabIndex={0}
        onClick={() => setQuiet(false)}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") setQuiet(false);
        }}
      >
        <span className="bump-bubble-emoji">{outcome.emoji}</span>
        <span className="bump-bubble-text">{text}</span>
        <button
          type="button"
          className="bump-bubble-close"
          aria-label={t("Zavřít")}
          onClick={(e) => {
            e.stopPropagation();
            cancelAndClose();
          }}
        >
          <svg viewBox="0 0 16 16" aria-hidden="true">
            <path d="M4 4l8 8M12 4l-8 8" />
          </svg>
        </button>
      </div>
    );
  }

  // Tapping outside: back out wherever that's harmless. Never while the
  // sender's payment is running or its result is on screen (a stray tap
  // mustn't hide an uncertain outcome), and on the amount screen a tap
  // outside is far more likely a miss than an intent to cancel.
  const onBackdrop = () => {
    if (outcome.kind === "sending") return;
    if (outcome.kind === "paired" || (outcome.kind === "receiving" && stage === "entering")) cancelAndClose();
    else closeThen(restart);
  };

  let screenKey: string;
  let body: ReactNode;

  if (outcome.kind === "paired") {
    screenKey = "paired";
    body = (
      <Screen>
        <PairHero />
        <h2 className="sht-title bump-reveal" style={{ ["--d" as string]: "240ms" }}>
          {t("Spojeno")}
        </h2>
        <EmojiRow emoji={outcome.emoji} startMs={REEL_START_MS} />
        <p className="sht-sub bump-reveal" style={{ ["--d" as string]: "900ms" }}>
          {t("Svítí na druhém telefonu stejné symboly?")}
        </p>
        <SettledReveal settling={outcome.settling} baseMs={CHOICE_REVEAL_MS}>
          {(className, delay) => (
            <>
              <div className={`bump-choice ${className}`} style={{ ["--d" as string]: delay(0) }}>
                <button
                  type="button"
                  className="bump-choice-btn bump-choice-btn--pay"
                  disabled={outcome.settling}
                  onClick={() => void sessionRef.current?.choose("send")}
                >
                  <ArrowGlyph dir="up" />
                  <span>{t("Platím")}</span>
                </button>
                <button
                  type="button"
                  className="bump-choice-btn bump-choice-btn--receive"
                  disabled={outcome.settling}
                  onClick={() => void sessionRef.current?.choose("receive")}
                >
                  <ArrowGlyph dir="down" />
                  <span>{t("Přijímám")}</span>
                </button>
              </div>
              <button
                type="button"
                className={`sht-link ${className}`}
                style={{ ["--d" as string]: delay(80) }}
                onClick={cancelAndClose}
              >
                {t("Symboly nesedí")}
              </button>
            </>
          )}
        </SettledReveal>
      </Screen>
    );
  } else if (outcome.kind === "sending" && delivered) {
    screenKey = "delivered";
    body = (
      <Screen>
        <StatusMark state="success" />
        <h2 className="sht-title">{t("Doručeno")}</h2>
        <BigAmount sats={sentSats ?? flow?.amountSats ?? amountSats} rate={rate} currency={currency} fmt={fmt} />
        <p className="sht-sub">{t("Příjemce potvrdil přijetí.")}</p>
        <button type="button" className="primary sht-wide" onClick={() => closeThen(restart)}>
          {t("Hotovo")}
        </button>
      </Screen>
    );
  } else if (outcome.kind === "sending" && deliveryConflict) {
    // No "Zaplatit" here on purpose: the money may well have arrived, and
    // paying again would pay twice.
    screenKey = "delivery-conflict";
    body = (
      <Screen>
        <StatusMark state="warn" />
        <h2 className="sht-title">{t("Příjemce hlásí přijetí")}</h2>
        {flow?.amountSats ? <BigAmount sats={flow.amountSats} rate={rate} currency={currency} fmt={fmt} /> : null}
        <p className="sht-sub">{t("Tahle peněženka ale platbu nepotvrdila. Než zaplatíš znovu, zkontroluj historii.")}</p>
        <button type="button" className="primary sht-wide" onClick={() => closeThen(restart)}>
          {t("Hotovo")}
        </button>
      </Screen>
    );
  } else if (outcome.kind === "sending" && sendResult === "timeout") {
    screenKey = "send-timeout";
    body = (
      <Screen>
        <StatusMark state="warn" />
        <h2 className="sht-title">{t("Nevíme jistě, jestli platba prošla")}</h2>
        <p className="sht-sub">{t("Než to zkusíš znovu, zkontroluj prosím historii.")}</p>
        <button type="button" className="primary sht-wide" onClick={() => closeThen(restart)}>
          {t("Hotovo")}
        </button>
      </Screen>
    );
  } else if (outcome.kind === "sending" && sendResult === "sent") {
    // The wallet call succeeded: say so right away (accent check), then
    // upgrade to "Doručeno" once the receiver's own history confirms it.
    screenKey = "sent";
    body = (
      <Screen>
        <StatusMark state="sent" />
        <h2 className="sht-title">{t("Odesláno")}</h2>
        <BigAmount sats={sentSats ?? amountSats} rate={rate} currency={currency} fmt={fmt} />
        {deliveryWaitOver || detached ? (
          <p className="sht-sub">{t("Příjemce zatím nepotvrdil přijetí. Platba se objeví v historii.")}</p>
        ) : (
          <p className="sht-sub sht-waiting">
            <WaitingDots />
            {t("Čekám na potvrzení od příjemce")}
          </p>
        )}
        <button type="button" className="secondary sht-wide" onClick={() => closeThen(restart)}>
          {t("Hotovo")}
        </button>
      </Screen>
    );
  } else if (outcome.kind === "sending" && sendBusy) {
    screenKey = "sending-progress";
    body = (
      <Screen>
        <StatusMark state="progress" />
        <h2 className="sht-title">{t("Odesílám…")}</h2>
        <BigAmount sats={sentSats ?? amountSats} rate={rate} currency={currency} fmt={fmt} />
        <IdentityPill emoji={outcome.emoji} label={t("Platíš")} />
      </Screen>
    );
  } else if (outcome.kind === "sending") {
    screenKey = "amount";
    body = (
      <Screen>
        <IdentityPill emoji={outcome.emoji} label={t("Platíš")} />
        {outcome.flow.peerLost && <p className="sht-warning">{t("Druhý telefon neodpovídá")}</p>}
        <AmountField entry={amount} currency={currency} over={overBalance} autoFocus label={t("Částka")} />
        <p className={`sht-balance${overBalance ? " is-over" : ""}`}>
          {overBalance
            ? t("Nedostatek prostředků")
            : spendable !== undefined
              ? tf(t("Zůstatek {amount} sats"), { amount: fmt(spendable) })
              : " "}
        </p>
        <Collapse open={needsPassword}>
          <input
            className="sht-field"
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder={t("Heslo")}
            autoComplete="current-password"
          />
        </Collapse>
        {sendError && (
          <p className="sht-error" key={errorNonce}>
            {sendError}
          </p>
        )}
        <div className="sht-actions">
          <button type="button" className="secondary" onClick={cancelAndClose}>
            {t("Zrušit")}
          </button>
          <button type="button" className="primary" disabled={!canPay} onClick={() => void pay()}>
            {t("Zaplatit")}
          </button>
        </div>
      </Screen>
    );
  } else if (outcome.kind === "receiving" && receivedSats !== null) {
    screenKey = "received";
    body = (
      <Screen>
        <StatusMark state="success" />
        <h2 className="sht-title">{t("Přijato")}</h2>
        <BigAmount sats={receivedSats} rate={rate} currency={currency} fmt={fmt} countUp />
        <button type="button" className="primary sht-wide" onClick={() => closeThen(restart)}>
          {t("Hotovo")}
        </button>
      </Screen>
    );
  } else if (outcome.kind === "receiving" && incoming && arrivalWaitOver) {
    screenKey = "arrival-late";
    body = (
      <Screen>
        <StatusMark state="neutral" />
        <h2 className="sht-title">{t("Platba je na cestě")}</h2>
        {expectedSats ? <BigAmount sats={expectedSats} rate={rate} currency={currency} fmt={fmt} /> : null}
        <p className="sht-sub">{t("Objeví se v historii, jakmile dorazí.")}</p>
        <button type="button" className="primary sht-wide" onClick={() => closeThen(restart)}>
          {t("Hotovo")}
        </button>
      </Screen>
    );
  } else if (outcome.kind === "receiving" && incoming) {
    screenKey = "incoming";
    body = (
      <Screen>
        <StatusMark state="incoming" />
        <h2 className="sht-title">{t("Přichází")}</h2>
        {expectedSats ? <BigAmount sats={expectedSats} rate={rate} currency={currency} fmt={fmt} countUp /> : null}
        <IdentityPill emoji={outcome.emoji} label={t("Přijímáš")} />
      </Screen>
    );
  } else if (outcome.kind === "receiving") {
    screenKey = "waiting";
    body = (
      <Screen>
        <IdentityPill emoji={outcome.emoji} label={t("Přijímáš")} />
        {outcome.flow.peerLost ? (
          <>
            <StatusMark state="warn" />
            <h2 className="sht-title">{t("Druhý telefon neodpovídá")}</h2>
          </>
        ) : (
          <>
            <TypingBubble />
            <h2 className="sht-title">{t("Druhý telefon zadává částku")}</h2>
          </>
        )}
        <button type="button" className="secondary sht-wide" onClick={cancelAndClose}>
          {t("Zrušit")}
        </button>
      </Screen>
    );
  } else {
    // Notices: cancelled / ambiguous / expired / error / slow.
    screenKey = `notice-${outcome.kind}`;
    const [title, sub] = noticeCopy(outcome, t);
    body = (
      <Screen>
        <StatusMark state={outcome.kind === "cancelled" ? "neutral" : "warn"} />
        <h2 className="sht-title">{title}</h2>
        {sub && <p className="sht-sub">{sub}</p>}
        <button type="button" className="secondary sht-wide" onClick={() => closeThen(restart)}>
          {t("Zavřít")}
        </button>
      </Screen>
    );
  }

  return (
    <Sheet closing={closing} onBackdrop={onBackdrop} screenKey={screenKey}>
      {body}
    </Sheet>
  );
}

const NOTICE_KINDS: ReadonlySet<BumpOutcome["kind"]> = new Set(["ambiguous", "expired", "error", "cancelled", "slow"]);

function noticeCopy(outcome: BumpOutcome, t: (s: string) => string): [string, string | null] {
  switch (outcome.kind) {
    case "cancelled":
      return [t("Druhá strana platbu zrušila"), null];
    case "ambiguous":
      return [t("Nejednoznačné"), t("Poblíž ťuklo víc telefonů najednou. Zkus to znovu.")];
    case "slow":
      return [t("Síť nestíhá"), t("Ťuknutí dorazilo pozdě. Zkus to znovu.")];
    case "expired":
      return [
        outcome.phase === "pairing"
          ? t("Druhý telefon se nenašel")
          : outcome.phase === "choosing"
            ? t("Vypršel čas na výběr")
            : t("Platba vypršela"),
        t("Ťukněte telefony o sebe znovu."),
      ];
    case "error":
      return [t("Něco se pokazilo"), t(outcome.message)];
    default:
      return ["", null];
  }
}

// The SDK's own errors are English and technical ("bad user input: …");
// the common one gets a real sentence, anything else a generic one.
function friendlySendError(e: unknown, t: (s: string) => string): string {
  const raw = e instanceof Error ? e.message : String(e);
  if (/insufficient|not enough|balance/i.test(raw)) return t("Nedostatek prostředků.");
  if (/password|decrypt|auth/i.test(raw)) return t("Nesprávné heslo.");
  return t("Platbu se nepodařilo odeslat.");
}

// --- Building blocks ---------------------------------------------------------

// The paired screen's choice buttons (and "Symboly nesedí") rise in
// CHOICE_REVEAL_MS after the screen appears, exactly as they always have. A
// direction can only be picked once the pairing has settled (see
// BumpOutcome's settling), so should it settle later than that they rise in
// then instead, with the same animation: never visible before they work,
// and no disabled state or "please wait" text in between. The space they
// take is kept from the start, so the sheet doesn't grow when they appear.
const CHOICE_REVEAL_MS = 1000;

function SettledReveal({
  settling,
  baseMs,
  children,
}: {
  settling: boolean;
  baseMs: number;
  children: (className: string, delay: (extraMs: number) => string) => ReactNode;
}) {
  const [baseElapsed, setBaseElapsed] = useState(false);
  useEffect(() => {
    const timer = setTimeout(() => setBaseElapsed(true), baseMs);
    return () => clearTimeout(timer);
  }, [baseMs]);
  // Adding bump-reveal starts its rise animation, so it's added at
  // max(baseMs, settled) and runs with no further delay of its own.
  const visible = baseElapsed && !settling;
  return <>{children(visible ? "bump-reveal" : "bump-await-reveal", (extraMs) => `${extraMs}ms`)}</>;
}

// Two phones slide in, meet in the middle and "tap", with a ripple from the
// point of contact.
function PairHero() {
  return (
    <div className="bump-hero" aria-hidden="true">
      <span className="bump-hero-ripple" />
      <span className="bump-hero-ripple bump-hero-ripple--late" />
      <svg className="bump-hero-phone bump-hero-phone--left" viewBox="0 0 28 48">
        <rect x="1.5" y="1.5" width="25" height="45" rx="6" />
        <line x1="10" y1="6" x2="18" y2="6" />
      </svg>
      <svg className="bump-hero-phone bump-hero-phone--right" viewBox="0 0 28 48">
        <rect x="1.5" y="1.5" width="25" height="45" rx="6" />
        <line x1="10" y1="6" x2="18" y2="6" />
      </svg>
    </div>
  );
}

// Slot-machine reveal: each symbol is a reel that spins through random
// emoji and lands on its real value, left to right, with a small overshoot
// and a haptic tick per stop. The filler differs between the two phones;
// only where each reel stops is shared. Reduced motion: no spin at all.
const REEL_START_MS = 250;
const REEL_SPIN_MS = [620, 780, 940];
const REEL_FILLER = 14;

function EmojiRow({ emoji, startMs }: { emoji: string; startMs: number }) {
  const finals = useMemo(() => emoji.split(" "), [emoji]);
  const reduced = useMemo(() => window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false, []);
  const strips = useMemo(
    () =>
      finals.map((final) => [
        ...Array.from({ length: REEL_FILLER }, () => BUMP_EMOJI[Math.floor(Math.random() * BUMP_EMOJI.length)]),
        final,
      ]),
    [finals],
  );
  useEffect(() => {
    if (reduced) return;
    const timers = finals.map((_, i) => setTimeout(hapticTap, startMs + REEL_SPIN_MS[i % REEL_SPIN_MS.length]));
    return () => timers.forEach(clearTimeout);
  }, [finals, reduced, startMs]);
  return (
    <div className="bump-emoji" role="img" aria-label={emoji}>
      {strips.map((strip, i) => (
        <span
          key={i}
          className="bump-reel"
          style={{
            ["--d" as string]: `${startMs}ms`,
            ["--dur" as string]: `${REEL_SPIN_MS[i % REEL_SPIN_MS.length]}ms`,
            ["--n" as string]: strip.length - 1,
          }}
        >
          <span className="bump-reel-strip">
            {strip.map((e, j) => (
              <span key={j} className="bump-reel-cell">
                {e}
              </span>
            ))}
          </span>
        </span>
      ))}
    </div>
  );
}

// The bump-specific pill: the shared one plus the pairing emoji.
function IdentityPill({ emoji, label }: { emoji: string; label: string }) {
  return (
    <Pill label={label}>
      <span className="bump-pill-emoji">{emoji}</span>
    </Pill>
  );
}

// iMessage-style "the other side is typing" bubble.
function TypingBubble() {
  return (
    <div className="bump-typing" aria-hidden="true">
      <span />
      <span />
      <span />
    </div>
  );
}

function ArrowGlyph({ dir }: { dir: "up" | "down" }) {
  return (
    <svg className="bump-choice-glyph" viewBox="0 0 32 32" aria-hidden="true">
      <circle cx="16" cy="16" r="15" />
      {dir === "up" ? <path d="M16 23V10M10 15.5l6-6 6 6" /> : <path d="M16 9v13M10 16.5l6 6 6-6" />}
    </svg>
  );
}
