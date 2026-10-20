// Moving the confirmed on-chain balance into Ark (boardAll), in the shared
// sheet. Boarding only ever starts from this sheet's own button; the home
// notice that opens it is never a trigger. estimateBoardFee() is best-effort
// context, not a precondition: boardAll() doesn't need it.
//
// While an unilateral exit runs, the on-chain balance may be the change of its
// own CPFP transactions or money sent ahead for more exit fees. Dashboard already refuses to board while the exit
// still needs fees; after that (timelock, claim) boarding is allowed, but only
// past a warning: in Ark the exit can't use the money any more, and an exit is
// usually done because Ark can't be relied on.
import { useEffect, useState } from "react";
import type { FeeEstimate } from "@secondts/bark";
import type { WalletClient } from "../lib/wallet/bark";
import { estimateBoardNetworkFee } from "../lib/send/boardFee";
import { localeFor, useLang, useT } from "../lib/i18n";
import {
  Screen,
  Sheet,
  StatusMark,
  WaitingDots,
  useSheetClose,
} from "./sheet/PaySheet";
import "./ExitSheet.css";

export default function BoardSheet({
  wallet,
  amountSats,
  busy,
  error,
  exitLive,
  onConfirm,
  onClose,
}: {
  wallet: WalletClient;
  amountSats: number;
  busy: boolean;
  error: string | null;
  exitLive: boolean;
  // Resolves true once the money moved.
  onConfirm: () => Promise<boolean>;
  onClose: () => void;
}) {
  const t = useT();
  const lang = useLang();
  const { closing, closeThen } = useSheetClose();
  // Frozen when the sheet opens, like the send flow's SendPlan: Dashboard
  // updates the balance right after a board, while this sheet is closing.
  const [amount] = useState(amountSats);
  const [estimate, setEstimate] = useState<FeeEstimate | null>(null);
  const [estimateFailed, setEstimateFailed] = useState(false);
  const [ack, setAck] = useState(false);
  // undefined: loading; null: couldn't estimate.
  const [networkFee, setNetworkFee] = useState<number | null | undefined>(undefined);

  useEffect(() => {
    let cancelled = false;
    wallet
      .estimateBoardFee(amount)
      .then((e) => {
        if (!cancelled) setEstimate(e);
      })
      .catch(() => {
        if (!cancelled) setEstimateFailed(true);
      });
    return () => {
      cancelled = true;
    };
  }, [wallet, amount]);

  useEffect(() => {
    let cancelled = false;
    Promise.all([wallet.onchainWallet.utxos(), wallet.onchainWallet.feeRates()])
      .then(([utxos, rates]) => {
        if (!cancelled) setNetworkFee(estimateBoardNetworkFee(utxos, rates));
      })
      .catch(() => {
        if (!cancelled) setNetworkFee(null);
      });
    return () => {
      cancelled = true;
    };
  }, [wallet, amount]);

  // The Ark server's board fee is 0 today, so it has no row of its own; it is
  // still taken off here in case that changes. A failed estimate counts as 0.
  const arkFee = estimate ? estimate.feeSats : estimateFailed ? 0 : undefined;
  const arrives = arkFee !== undefined && typeof networkFee === "number" ? amount - arkFee - networkFee : null;

  const close = () => {
    if (!busy) closeThen(onClose);
  };
  const fmt = (n: number) => `${n.toLocaleString(localeFor(lang))} sats`;
  const skeleton = <span className="ex-skeleton" aria-label={t("Načítám…")} />;

  return (
    <Sheet closing={closing} onBackdrop={close} screenKey="board">
      <Screen>
        <StatusMark state="incoming" />
        <h2 className="sht-title">{exitLive ? t("Přijmout do zůstatku") : t("Přijmout onchain platbu")}</h2>
        <div className="ex-facts">
          <div className="ex-fact">
            <span>{t("Částka")}</span>
            <strong>{fmt(amount)}</strong>
          </div>
          {/* Not in estimateBoardFee() (boardFee.ts), paid out of the amount. */}
          {networkFee !== null && (
            <div className="ex-fact">
              <span>{t("Poplatek síti")}</span>
              <strong>{networkFee === undefined ? skeleton : `~${fmt(networkFee)}`}</strong>
            </div>
          )}
          {networkFee !== null && (
            <div className="ex-fact">
              <span>{t("Přijde na zůstatek")}</span>
              <strong>{arrives !== null ? `~${fmt(arrives)}` : skeleton}</strong>
            </div>
          )}
        </div>
        {!exitLive && (
          <p className="sht-sub">{t("Přesunou se do zůstatku, kde je normálně utratíš.")}</p>
        )}
        {exitLive && (
          <div className="ex-alert">
            {t("Běží nouzový exit a tyhle peníze můžou být potřeba na jeho poplatky. Po přesunu je exit nepoužije.")}
            <label className="ex-check">
              <input type="checkbox" checked={ack} disabled={busy} onChange={(e) => setAck(e.target.checked)} />
              {t("Rozumím, přesto přesunout")}
            </label>
          </div>
        )}
        {error && <p className="sht-error">{error}</p>}
        <button
          type="button"
          className="sht-wide"
          disabled={busy || (exitLive && !ack)}
          onClick={() => {
            void onConfirm().then((ok) => {
              if (ok) closeThen(onClose);
            });
          }}
        >
          {busy ? (
            <span className="sht-waiting">
              {t("Přesouvám")}
              <WaitingDots />
            </span>
          ) : (
            t("Potvrdit a přijmout")
          )}
        </button>
        <button type="button" className="sht-link" disabled={busy} onClick={close}>
          {t("Zpět")}
        </button>
      </Screen>
    </Sheet>
  );
}
