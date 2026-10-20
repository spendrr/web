// The unilateral exit on the home screen: one card, one line of truth from
// exitModel.ts, tap to open the exit sheet. Replaces up to four stacked
// toasts (progress, retry, and three kinds of error) that each told part of
// the story.
import { useLang, useT, tf } from "../lib/i18n";
import type { ExitTracker } from "../lib/exit/useExitTracker";
import { blocksToApproxDuration } from "../lib/ui/blocks";
import { formatSats, homeHeadline } from "./exitCopy";
import { EXIT_DUST_SATS } from "../lib/exit/exitLocks";
import { completionArrivedSats } from "../lib/exit/emergencyExit";
import { BTC_PATH } from "./BitcoinMark";
import "./ExitSheet.css";

export default function ExitHomeCard({
  tracker,
  outsideSats = 0,
  onchain = null,
  onOpen,
}: {
  tracker: ExitTracker;
  // Spendable money not in the exit (new payments, coins back from a
  // refresh that was held out of it): a reminder that it can be added.
  outsideSats?: number;
  // The on-chain balance: while an exit runs, Dashboard hides its own on-chain
  // notices and the card shows the amount as one line instead.
  onchain?: { confirmedSats: number; pendingSats: number } | null;
  onOpen: () => void;
}) {
  const t = useT();
  const lang = useLang();
  const o = tracker.overview;
  const completion = tracker.completion;
  const showDone = !o.live && completion !== null && !completion.dismissed;
  if (!o.live && !showDone) return null;

  if (showDone) {
    const arrived = completionArrivedSats(completion);
    return (
      <button type="button" className="exit-card exit-card--ready" onClick={onOpen}>
        <svg className="exit-card-icon" viewBox="-2.5 -2.5 29 29" fill="currentColor" aria-hidden="true">
          <path d={BTC_PATH} />
        </svg>
        <span className="exit-card-text">
          <span className="exit-card-title">{t("Nouzový exit dokončen")}</span>
          {arrived !== null && <span>{tf(t("{amount} je na tvé adrese"), { amount: formatSats(arrived, lang) })}</span>}
        </span>
        <span className="exit-card-cta">{t("Detail")}</span>
      </button>
    );
  }

  const stalled = tracker.feesMissing;
  // Coins still getting on-chain close to their expiry (exitModel.ts).
  const expiring = o.expiryRiskSats > 0 && o.firstExpiryInBlocks !== null;
  const ready = o.stage === "ready";
  const sub = expiring
    ? o.firstExpiryInBlocks! > 0
      ? tf(t("Spěchá: mince vyprší za {left}"), { left: blocksToApproxDuration(o.firstExpiryInBlocks!, lang) })
      : t("Mince vypršely, exit nestihl blockchain")
    : stalled
    ? t("Stojí: chybí on-chain na poplatky")
    : tracker.error
      ? t("Kontrola selhala, zkouším znovu")
      : outsideSats >= EXIT_DUST_SATS
        ? tf(t("{amount} mimo exit, můžeš je přidat"), { amount: formatSats(outsideSats, lang) })
        : null;
  const feeMoney = o.broadcastingIds.length > 0;
  const onchainLine =
    onchain && onchain.confirmedSats > 0
      ? [
          tf(t(feeMoney ? "On-chain na poplatky: {amount}" : "On-chain navíc: {amount}"), {
            amount: formatSats(onchain.confirmedSats, lang),
          }),
          onchain.pendingSats > 0 ? tf(t("{amount} čeká"), { amount: formatSats(onchain.pendingSats, lang) }) : null,
        ]
          .filter(Boolean)
          .join(" · ")
      : onchain && onchain.pendingSats > 0
        ? // Only unconfirmed money: no "0 sats" in front of it.
          tf(t(feeMoney ? "On-chain na poplatky: {amount} čeká" : "On-chain navíc: {amount} čeká"), {
            amount: formatSats(onchain.pendingSats, lang),
          })
        : null;
  return (
    <button
      type="button"
      className={`exit-card${ready ? " exit-card--ready" : ""}${stalled || expiring ? " exit-card--alert" : ""}`}
      onClick={onOpen}
    >
      <svg className="exit-card-icon" viewBox="-2.5 -2.5 29 29" fill="currentColor" aria-hidden="true">
        <path d={BTC_PATH} />
      </svg>
      <span className="exit-card-text">
        <span className="exit-card-title">{t("Nouzový exit")}</span>
        <span>{homeHeadline(o, t, lang)}</span>
        {sub && <span className="exit-card-sub">{sub}</span>}
        {onchainLine && <span className="exit-card-sub">{onchainLine}</span>}
      </span>
      <span className="exit-card-cta">{ready ? t("Vyzvednout") : t("Detail")}</span>
    </button>
  );
}
