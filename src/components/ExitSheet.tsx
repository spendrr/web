// Unilateral exit, as one sheet. Replaces the old five-screen wizard in
// Settings, the sticky home toasts and the claim modal, which each derived
// their own idea of the exit's state and could disagree with bark and with
// each other (audit 2026-09-27).
//
// Three faces, picked from the tracker (useExitTracker / exitModel.ts), never
// from local step state:
//   - start:    no exit running. One screen: what would happen, in real
//               numbers, plus destination + password + one button.
//   - progress: an exit is running. The journey (Ark -> blockchain ->
//               timelock -> your address) shows where it is; everything the
//               user can do opens inline.
//   - done:     bark reported the claim confirmed.
import { pendingRoundInputIds } from "../lib/wallet/roundInputs";
import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import type { ArkInfo, ExitCancelFailure } from "@secondts/bark";
import { pushWorkerWatchdogOverride, type WalletClient } from "../lib/wallet/bark";
import { isValidMainnetBitcoinAddress } from "../lib/send/bitcoinAddress";
import { IS_SIGNET } from "../lib/network";
import { completionArrivedSats, exitMayBeLive, getExitDestinationAddress, getExitDestinationTag } from "../lib/exit/emergencyExit";
import {
  ExitActionError,
  cancelExits,
  claimExits,
  saveExitDestination,
  startExit,
  type ClaimOutcome,
} from "../lib/exit/exitActions";
import { planExitStart, type ExitStartPlan } from "../lib/exit/exitLocks";
import { useNetState } from "../lib/connectivity/connectivity";
import { EXIT_EXPIRY_WARN_BLOCKS, type ExitOverview } from "../lib/exit/exitModel";
import { localeFor, tf, useLang, useT } from "../lib/i18n";
import type { ExitTracker } from "../lib/exit/useExitTracker";
import { ONCHAIN_SYNC_TIMEOUT_MS, TIMEOUT_MESSAGE, WALLET_CALL_TIMEOUT_MS, withTimeout } from "../lib/wallet/walletCall";
import { Collapse, Screen, Sheet, StatusMark, WaitingDots, useSheetClose } from "./sheet/PaySheet";
import ExitJourney, { journeyStepFor } from "./ExitJourney";
import { blocksToApproxDuration } from "../lib/ui/blocks";
import {
  blocksLabel,
  coinLine,
  czechCountForm,
  exitActionErrorText,
  explorerTxUrl,
  formatSats,
  txProgress,
} from "./exitCopy";
import "./ExitSheet.css";

type T = (s: string) => string;

function errorText(e: unknown, t: T): string {
  if (e instanceof ExitActionError) return exitActionErrorText(e.code, t);
  return e instanceof Error ? e.message : String(e);
}

function shortAddress(a: string): string {
  return a.length > 22 ? `${a.slice(0, 10)}…${a.slice(-8)}` : a;
}

// The address typed so far and whether it is a valid mainnet address.
function useAddressField(initial: string) {
  const [value, setValue] = useState(initial);
  const [valid, setValid] = useState<boolean | null>(null);
  useEffect(() => {
    const trimmed = value.trim();
    if (!trimmed) {
      setValid(null);
      return;
    }
    let cancelled = false;
    const timer = window.setTimeout(() => {
      void isValidMainnetBitcoinAddress(trimmed).then((ok) => {
        if (!cancelled) setValid(ok);
      });
    }, 200);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [value]);
  return { value, setValue, valid, trimmed: value.trim() };
}

function AddressInput({ field, t }: { field: ReturnType<typeof useAddressField>; t: T }) {
  return (
    <div className="ex-field">
      <input
        className="sht-field"
        value={field.value}
        onChange={(e) => field.setValue(e.target.value)}
        placeholder={tf(t("Tvoje bitcoinová adresa ({prefix}…)"), { prefix: IS_SIGNET ? "tb1" : "bc1" })}
        autoCapitalize="off"
        autoCorrect="off"
        spellCheck={false}
      />
      {field.valid === false && <p className="ex-hint ex-hint--bad">{t("Tohle není platná bitcoinová adresa.")}</p>}
      {field.valid === true && (
        // Read-back with the ends highlighted: the part people actually
        // compare, and what address-swapping malware hopes they skip.
        <p className="ex-hint ex-readback">
          <strong>{field.trimmed.slice(0, 6)}</strong>
          {field.trimmed.slice(6, -6)}
          <strong>{field.trimmed.slice(-6)}</strong>
        </p>
      )}
    </div>
  );
}

function PasswordInput({
  value,
  onChange,
  onEnter,
  t,
}: {
  value: string;
  onChange: (v: string) => void;
  onEnter?: () => void;
  t: T;
}) {
  return (
    <input
      className="sht-field"
      type="password"
      placeholder={t("Heslo")}
      value={value}
      autoComplete="current-password"
      onChange={(e) => onChange(e.target.value)}
      onKeyDown={(e) => {
        if (e.key === "Enter" && value) onEnter?.();
      }}
    />
  );
}

// --- start ------------------------------------------------------------------

interface StartInfo {
  // Every coin that can exit, including inputs of a pending round.
  exitableSats: number;
  exitableCount: number;
  // Of those, the ones in a pending round (a refresh): left out by default,
  // see planExitStart in exitLocks.ts.
  inRoundSats: number;
  inRoundCount: number;
  // Coins bark refuses to exit because the output would be dust.
  dustSats: number;
  maxDepth: number;
  arkInfo: ArkInfo | null;
  // Blocks until the soonest-expiring coin expires; null when unknown.
  firstExpiryInBlocks: number | null;
  // What the fee estimate is asked about (loadStartFees).
  feeIds: string[];
}

// Loaded after StartInfo: estimateEmergencyExitFee syncs the onchain wallet
// first, which can take a long while, and everything else on the screen can
// show before it (the fee rows as skeletons meanwhile).
interface StartFees {
  onchainConfirmedSats: number | null;
  broadcastFeeSats: number | null;
  claimFeeSats: number | null;
  fundable: boolean | null;
  estimateError: string | null;
  // What the broadcast fee is made of (bark's estimate: rate × weight of
  // every exit transaction not yet confirmed plus its CPFP child), so a
  // number that moved can be traced to the fee market or to more
  // transactions.
  txsToBroadcast: number | null;
  feeRateSatPerVb: number | null;
}

// The coins a new exit would take, and which of them sit in a pending round.
async function loadExitStartPlan(wallet: WalletClient) {
  const [vtxos, roundInputs] = await Promise.all([
    withTimeout(wallet.allVtxos(), WALLET_CALL_TIMEOUT_MS, TIMEOUT_MESSAGE),
    withTimeout(pendingRoundInputIds(wallet), WALLET_CALL_TIMEOUT_MS, TIMEOUT_MESSAGE).catch(() => null),
  ]);
  return { vtxos, plan: planExitStart(vtxos, roundInputs, true) };
}

async function loadStartInfo(wallet: WalletClient): Promise<StartInfo> {
  const [{ vtxos, plan }, arkInfo, tip] = await Promise.all([
    loadExitStartPlan(wallet),
    wallet.arkInfo().catch(() => undefined),
    withTimeout(wallet.onchainWallet.tipHeight(), WALLET_CALL_TIMEOUT_MS, TIMEOUT_MESSAGE).catch(() => null),
  ]);
  const wanted = new Set(plan.ids);
  const real = vtxos.filter((v, i, all) => wanted.has(v.id) && all.findIndex((x) => x.id === v.id) === i);
  return {
    exitableSats: plan.sats,
    exitableCount: plan.ids.length,
    inRoundSats: plan.inRoundSats,
    inRoundCount: plan.inRoundIds.length,
    dustSats: plan.dustSats,
    maxDepth: real.reduce((a, v) => Math.max(a, v.exitDepth), 0),
    arkInfo: arkInfo ?? null,
    firstExpiryInBlocks:
      tip !== null && real.length > 0 ? Math.min(...real.map((v) => v.expiryHeight)) - tip : null,
    feeIds: real.map((v) => v.id),
  };
}

async function loadStartFees(wallet: WalletClient, ids: string[]): Promise<StartFees> {
  const fees: StartFees = {
    onchainConfirmedSats: null,
    broadcastFeeSats: null,
    claimFeeSats: null,
    fundable: null,
    estimateError: null,
    txsToBroadcast: null,
    feeRateSatPerVb: null,
  };
  // Syncs the onchain wallet first, so this is also what makes the balance
  // below current.
  const pop = pushWorkerWatchdogOverride(ONCHAIN_SYNC_TIMEOUT_MS);
  try {
    const e = await withTimeout(wallet.estimateEmergencyExitFee(ids, null, null), ONCHAIN_SYNC_TIMEOUT_MS, TIMEOUT_MESSAGE);
    fees.broadcastFeeSats = e.exitBroadcastFeeSats;
    fees.claimFeeSats = e.claimFeeSats;
    fees.fundable = e.fundable;
    fees.txsToBroadcast = e.txsToBroadcast;
    fees.feeRateSatPerVb = e.feeRateSatPerVb;
  } catch (e) {
    fees.estimateError = e instanceof Error ? e.message : String(e);
  } finally {
    pop();
  }
  const onchain = await withTimeout(wallet.onchainWallet.balance(), WALLET_CALL_TIMEOUT_MS, TIMEOUT_MESSAGE).catch(() => null);
  fees.onchainConfirmedSats = onchain ? onchain.confirmedSats : null;
  return fees;
}

// A value still loading in a facts row.
function FactSkeleton() {
  const t = useT();
  return <span className="ex-skeleton" aria-label={t("Načítám…")} />;
}

function Fact({ label, value, tone }: { label: string; value: ReactNode; tone?: "bad" | "ok" }) {
  return (
    <div className={`ex-fact${tone ? ` ex-fact--${tone}` : ""}`}>
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

// Coins that are inputs of a pending round (a refresh). Left out of the exit
// by default: if the round completes, it spends them and the fees paid for
// their exit are lost. When the Ark server doesn't answer, the round can't
// complete, so they go in by default (planExitStart, exitLocks.ts).
function InRoundChoice({
  sats,
  include,
  onChange,
  arkDown,
}: {
  sats: number;
  include: boolean;
  onChange: (include: boolean) => void;
  arkDown: boolean;
}) {
  const t = useT();
  const lang = useLang();
  const amount = formatSats(sats, lang);
  return (
    <div className="ex-inround">
      <p>
        {arkDown
          ? tf(t("Ark server neodpovídá, takže obnova mincí nedoběhne. {amount} z ní jde do exitu taky."), { amount })
          : tf(t("{amount} je právě v obnově mincí. Do exitu je přidáš, až obnova skončí, obvykle do hodiny."), { amount })}
      </p>
      <label className="ex-check">
        <input type="checkbox" checked={include} onChange={(e) => onChange(e.target.checked)} />
        {arkDown ? t("Přidat i mince z obnovy") : t("Přidat je hned")}
      </label>
      {include && !arkDown && (
        <p className="ex-inround-warn">
          {t("Jen když server nefunguje. Pokud obnovu dokončí, exit těchto mincí skončí a poplatky za ně propadnou.")}
        </p>
      )}
    </div>
  );
}

// Whether coins in a pending round go into the exit: on by default exactly
// when the Ark server doesn't answer (the connectivity probe), and it follows
// that until the user picks.
function useIncludeInRound(): [boolean, (v: boolean) => void, boolean] {
  const arkDown = useNetState() === "arkDown";
  const [picked, setPicked] = useState<boolean | null>(null);
  return [picked ?? arkDown, setPicked, arkDown];
}

function StartScreen({
  wallet,
  tracker,
  onClose,
  onKickOut,
  onCriticalOpChange,
}: {
  wallet: WalletClient;
  tracker: ExitTracker;
  onClose: () => void;
  // Shows `message` in the island, over the sheet.
  onKickOut: (message: string) => void;
  onCriticalOpChange?: (active: boolean) => void;
}) {
  const t = useT();
  const lang = useLang();
  const [info, setInfo] = useState<StartInfo | null>(null);
  const [infoError, setInfoError] = useState<string | null>(null);
  // Prefilled only when the stored address has a tag; startExit still checks
  // that tag against the password before trusting it (addressFromStorage).
  const [prefilled] = useState(() => (getExitDestinationTag() !== null ? (getExitDestinationAddress() ?? "") : ""));
  const address = useAddressField(prefilled);
  const [password, setPassword] = useState("");
  const [ackFees, setAckFees] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // bark returns OK without starting anything when every coin is
  // non-standard; the tracker then still reports no exit.
  const [startedNothing, setStartedNothing] = useState(false);
  const [moreOpen, setMoreOpen] = useState(false);
  const [includeInRound, setIncludeInRound, arkDown] = useIncludeInRound();

  const [fees, setFees] = useState<StartFees | null>(null);

  useEffect(() => {
    let cancelled = false;
    loadStartInfo(wallet)
      .then((i) => {
        if (cancelled) return;
        setInfo(i);
        if (i.feeIds.length === 0) return;
        void loadStartFees(wallet, i.feeIds).then((f) => !cancelled && setFees(f));
      })
      .catch((e) => !cancelled && setInfoError(e instanceof Error ? e.message : String(e)));
    return () => {
      cancelled = true;
    };
  }, [wallet]);

  const underfunded = fees?.fundable === false;
  const missingSats =
    fees && fees.broadcastFeeSats !== null && fees.onchainConfirmedSats !== null
      ? Math.max(0, fees.broadcastFeeSats - fees.onchainConfirmedSats)
      : null;
  // What this start takes, with or without the coins in a pending round.
  const startSats = info ? info.exitableSats - (includeInRound ? 0 : info.inRoundSats) : 0;
  const startCount = info ? info.exitableCount - (includeInRound ? 0 : info.inRoundCount) : 0;
  // Nothing at all on-chain for fees that cost something: the exit could not
  // put a single transaction on the chain, so starting it would only lock the
  // coins and spin. The button then shows the reason in the island (over this
  // sheet, which stays open) instead of starting.
  const noOnchainForFees =
    fees !== null &&
    fees.onchainConfirmedSats === 0 &&
    fees.broadcastFeeSats !== null &&
    fees.broadcastFeeSats > 0;
  const canStart =
    !busy &&
    info !== null &&
    // Not before the fee check answered (or failed): its warning is what
    // stops a start that the on-chain balance can't carry.
    fees !== null &&
    (noOnchainForFees ||
      (startCount > 0 && address.valid === true && password.length > 0 && (!underfunded || ackFees)));

  const submit = async () => {
    if (!canStart) return;
    if (noOnchainForFees) {
      onKickOut(t("Nemáš on-chain peníze na poplatky."));
      return;
    }
    setBusy(true);
    setError(null);
    onCriticalOpChange?.(true);
    try {
      setStartedNothing(false);
      const { result } = await startExit(wallet, password, address.trimmed, {
        includeInRound,
        addressFromStorage: prefilled !== "" && address.trimmed === prefilled.trim(),
      });
      if (result.started.length === 0) {
        // bark refused every coin (non-standard exit chains): nothing runs.
        setStartedNothing(true);
        return;
      }
      // Only reachable with no exit running: a new exit, not an extension.
      tracker.clearCompletion();
      // The sheet switches to the progress face once the tracker sees it.
      await tracker.refresh();
    } catch (e) {
      // A stored address that failed its check was just deleted; it must
      // not stay in the field either, one tap away from being confirmed.
      if (e instanceof ExitActionError && (e.code === "address-mismatch" || e.code === "unverified-address")) {
        address.setValue("");
      }
      setError(errorText(e, t));
    } finally {
      setBusy(false);
      onCriticalOpChange?.(false);
    }
  };
  const delta = info?.arkInfo?.vtxoExitDelta;
  const expirySoon = info?.firstExpiryInBlocks != null && info.firstExpiryInBlocks <= EXIT_EXPIRY_WARN_BLOCKS;

  return (
    <Screen>
      <ExitJourney step={0} idle />
      <h2 className="sht-title">{t("Nouzový exit z Ark")}</h2>
      {info && info.exitableCount > 0 && (
        <div className="ex-amount">
          <strong>{formatSats(startSats, lang)}</strong>
          <span>{t("na tvou bitcoinovou adresu, bez Ark serveru")}</span>
        </div>
      )}

      {!info && !infoError && (
        <p className="ex-loading sht-waiting">
          {t("Načítám mince")}
          <WaitingDots />
        </p>
      )}
      {infoError && (
        <p className="sht-error">
          {tf(t("Nepodařilo se načíst stav peněženky: {error}"), {
            error: infoError,
          })}
        </p>
      )}

      {info && info.exitableCount === 0 && (
        <p className="ex-note">{t("V Ark teď nemáš žádné mince, které by šly takhle vystoupit.")}</p>
      )}

      {info && info.exitableCount > 0 && (
        <>
          <div className="ex-facts">
            <Fact
              label={t("Poplatky teď")}
              value={
                fees === null ? (
                  <FactSkeleton />
                ) : fees.broadcastFeeSats === null ? (
                  t("neznámé")
                ) : fees.onchainConfirmedSats !== null && fees.onchainConfirmedSats < fees.broadcastFeeSats ? (
                  // What you have of what it needs.
                  tf(t("{have} z ~{fee}"), {
                    have: fees.onchainConfirmedSats.toLocaleString(localeFor(lang)),
                    fee: formatSats(fees.broadcastFeeSats, lang),
                  })
                ) : (
                  `~${formatSats(fees.broadcastFeeSats, lang)}`
                )
              }
              tone={underfunded ? "bad" : fees?.fundable ? "ok" : undefined}
            />
            <Fact
              label={t("Za vyzvednutí")}
              value={
                fees === null ? (
                  <FactSkeleton />
                ) : fees.claimFeeSats !== null ? (
                  `~${formatSats(fees.claimFeeSats, lang)}`
                ) : (
                  t("neznámé")
                )
              }
            />
            <Fact
              label={t("Trvání")}
              value={
                delta !== undefined
                  ? tf(t("{steps} bl. + zámek {lock}"), {
                      steps: Math.max(1, info.maxDepth).toLocaleString(localeFor(lang)),
                      lock: blocksToApproxDuration(delta, lang),
                    })
                  : t("hodiny až dny")
              }
            />
          </div>
          <p className="ex-note">
            {t("Mince se zamknou. Exit běží, jen když je appka otevřená.")}{" "}
            <button type="button" className="ex-inline-link" onClick={() => setMoreOpen((v) => !v)}>
              {moreOpen ? t("Méně") : t("Víc")}
            </button>
          </p>
          <div className="ex-collapsible">
            <Collapse open={moreOpen}>
              <ul className="ex-rules">
                <li>{t("Poplatky teď jdou z on-chain zůstatku, za vyzvednutí se strhnou z částky.")}</li>
                {fees?.txsToBroadcast != null && fees.feeRateSatPerVb != null && (
                  <li>
                    {tf(
                      t(
                        {
                          one: "Poplatky teď: {count} transakce na blockchain při ~{rate} sat/vB, rychlé sazbě sítě, která se mění.",
                          few: "Poplatky teď: {count} transakce na blockchain při ~{rate} sat/vB, rychlé sazbě sítě, která se mění.",
                          many: "Poplatky teď: {count} transakcí na blockchain při ~{rate} sat/vB, rychlé sazbě sítě, která se mění.",
                        }[czechCountForm(fees.txsToBroadcast)],
                      ),
                      {
                      count: fees.txsToBroadcast.toLocaleString(localeFor(lang)),
                      rate: fees.feeRateSatPerVb.toLocaleString(localeFor(lang), { maximumFractionDigits: 1 }),
                    })}
                  </li>
                )}
                <li>{t("Když Ark server funguje, je obyčejné odeslání na on-chain adresu levnější.")}</li>
                <li>{t("Zrušit jde, dokud neodejde poslední transakce mince. Odeslané kroky i jejich poplatky zůstanou.")}</li>
                {!expirySoon && info.firstExpiryInBlocks !== null && (
                  <li>
                    {tf(t("Na blockchain se exit musí dostat, než mince vyprší (nejbližší za {left}). Pak si je může vzít Ark server."), {
                      left: blocksToApproxDuration(info.firstExpiryInBlocks, lang),
                    })}
                  </li>
                )}
                {info.dustSats > 0 && (
                  <li>
                    {tf(t("{amount} v drobných mincích zůstane v Ark (pod minimem pro blockchain)."), {
                      amount: formatSats(info.dustSats, lang),
                    })}
                  </li>
                )}
              </ul>
            </Collapse>
          </div>

          {fees?.estimateError && (
            <p className="ex-note">
              {tf(t("Poplatky nejde spočítat: {error}"), {
                error: fees.estimateError,
              })}
            </p>
          )}
          {expirySoon && (
            <div className="ex-alert">
              {info.firstExpiryInBlocks! > 0
                ? tf(
                    t(
                      "Některé mince vyprší za {left}. Exit je musí do té doby dostat celé na blockchain, jinak si je vezme Ark server. Když server funguje, pošli peníze radši běžně na on-chain adresu.",
                    ),
                    { left: blocksToApproxDuration(info.firstExpiryInBlocks!, lang) },
                  )
                : t("Některé mince už vypršely. Exitem je nejspíš nezachráníš: Ark server si je může vzít dřív, než se dostanou na blockchain.")}
            </div>
          )}
          {underfunded && (
            <div className="ex-alert">
              {missingSats !== null && missingSats > 0
                ? tf(t("Na poplatky chybí ~{amount} on-chain. Pošli je přes Přijmout → On-chain a nepřesouvej do Ark."), {
                    amount: formatSats(missingSats, lang),
                  })
                : t("Na poplatky nemáš dost on-chain. Pošli si pár tisíc sats přes Přijmout → On-chain.")}
              {!noOnchainForFees && (
                <label className="ex-check">
                  <input type="checkbox" checked={ackFees} onChange={(e) => setAckFees(e.target.checked)} />
                  {t("Spustit i tak, počká na doplnění")}
                </label>
              )}
            </div>
          )}

          {info.inRoundSats > 0 && (
            <InRoundChoice sats={info.inRoundSats} include={includeInRound} onChange={setIncludeInRound} arkDown={arkDown} />
          )}

          <AddressInput field={address} t={t} />
          <PasswordInput value={password} onChange={setPassword} onEnter={() => void submit()} t={t} />
          {error && <p className="sht-error">{error}</p>}
          {startedNothing && <p className="sht-error">{t("Exit se nespustil pro žádnou minci.")}</p>}
          <button type="button" className="danger sht-wide" disabled={!canStart} onClick={() => void submit()}>
            {busy ? (
              <span className="sht-waiting">
                {t("Spouštím")}
                <WaitingDots />
              </span>
            ) : (
              t("Spustit nouzový exit")
            )}
          </button>
        </>
      )}
      <button type="button" className="sht-link" disabled={busy} onClick={onClose}>
        {t("Zavřít")}
      </button>
    </Screen>
  );
}

// --- progress ---------------------------------------------------------------

type Panel = null | "coins" | "address" | "add" | "cancel";

function stageTitle(o: ExitOverview, t: T): string {
  switch (o.stage) {
    case "ready":
      return t("Připraveno k vyzvednutí");
    case "preparing":
    case "broadcasting":
      return t("Posílám na blockchain");
    case "timelock":
      return t("Běží časový zámek");
    case "claiming":
      return t("Vyzvednutí je na cestě");
    default:
      return t("Nouzový exit");
  }
}

// The transaction to link for a coin: the claim once there is one, the level
// being confirmed while getting on-chain, and from the timelock on the last
// exit transaction, which is the coin's own outpoint (bark's state no longer
// lists the exit transactions then).
function coinTxid(c: ExitOverview["coins"][number]): string | null {
  if (c.claimTxid) return c.claimTxid;
  if (c.currentTxid) return c.currentTxid;
  if (c.phase === "timelock" || c.phase === "claimable" || c.phase === "claim-sent") {
    const txid = c.vtxoId.split(":")[0];
    return /^[0-9a-f]{64}$/.test(txid) ? txid : null;
  }
  return null;
}

function stageSub(o: ExitOverview, t: T, lang: ReturnType<typeof useLang>): string {
  switch (o.stage) {
    case "ready":
      return t("Pošli je na svou adresu.");
    case "preparing":
      return t("Chystám první transakci.");
    case "broadcasting": {
      const p = txProgress(o);
      // "z" takes the genitive: z 1 transakce, z 2 (5) transakcí.
      return tf(t(p.total === 1 ? "Potvrzeno {done} z {total} transakce." : "Potvrzeno {done} z {total} transakcí."), {
        done: p.confirmed,
        total: p.total,
      });
    }
    case "timelock":
      return o.lastReadyInBlocks !== null && o.lastReadyInBlocks > 0
        ? tf(t("Vyzvednout půjde za {left}."), {
            left: blocksLabel(o.lastReadyInBlocks, t, lang),
          })
        : t("Zámek skončil, čekám na další blok.");
    case "claiming":
      return t("Čeká na potvrzení v bloku.");
    default:
      return "";
  }
}

function describeCancelFailure(reason: ExitCancelFailure, t: T): string {
  if (reason.type === "already-broadcast") return t("poslední transakce už odešla");
  if (reason.type === "too-late") return t("exit je už dál");
  return t("žádný exit neprobíhá");
}

function ClaimPanel({
  wallet,
  tracker,
  onCriticalOpChange,
}: {
  wallet: WalletClient;
  tracker: ExitTracker;
  onCriticalOpChange?: (active: boolean) => void;
}) {
  const t = useT();
  const lang = useLang();
  const o = tracker.overview;
  const address = getExitDestinationAddress();
  const hasTag = getExitDestinationTag() !== null;
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [outcome, setOutcome] = useState<ClaimOutcome | null>(null);
  const [fee, setFee] = useState<number | null>(null);
  const idsKey = o.claimableIds.join(",");

  useEffect(() => {
    setFee(null);
    if (!idsKey || !address) return;
    let cancelled = false;
    const pop = pushWorkerWatchdogOverride(ONCHAIN_SYNC_TIMEOUT_MS);
    withTimeout(wallet.estimateEmergencyExitFee(idsKey.split(","), null, address), ONCHAIN_SYNC_TIMEOUT_MS, TIMEOUT_MESSAGE)
      .then((e) => !cancelled && setFee(e.claimFeeSats))
      .catch(() => {
        // Best-effort: the row just stays "počítám".
      })
      .finally(pop);
    return () => {
      cancelled = true;
    };
  }, [wallet, idsKey, address]);

  const submit = async () => {
    if (busy || !password) return;
    setBusy(true);
    setError(null);
    setOutcome(null);
    onCriticalOpChange?.(true);
    try {
      const result = await claimExits(wallet, password, o.claimableIds, o.claimableSats);
      setOutcome(result);
      setPassword("");
      await tracker.refresh({ progress: result.kind !== "rejected" });
    } catch (e) {
      setError(errorText(e, t));
    } finally {
      setBusy(false);
      onCriticalOpChange?.(false);
    }
  };

  return (
    <div className="ex-panel ex-panel--claim">
      <div className="ex-facts">
        <Fact label={t("Částka")} value={formatSats(o.claimableSats, lang)} />
        <Fact label={t("Poplatek")} value={fee !== null ? `~${formatSats(fee, lang)}` : t("počítám…")} />
        {fee !== null && (
          <Fact label={t("Dorazí")} value={`~${formatSats(Math.max(0, o.claimableSats - fee), lang)}`} tone="ok" />
        )}
        <Fact
          label={t("Na adresu")}
          value={address ? shortAddress(address) : t("není nastavená")}
          tone={address && hasTag ? undefined : "bad"}
        />
      </div>
      {!hasTag && address && <p className="ex-note">{t("Adresa není potvrzená heslem, nastav ji znovu v „Změnit adresu“.")}</p>}
      <PasswordInput value={password} onChange={setPassword} onEnter={() => void submit()} t={t} />
      {error && <p className="sht-error">{error}</p>}
      {outcome?.kind === "rejected" && (
        <p className="sht-error">
          {tf(t("Síť transakci odmítla, nic neodešlo: {error}"), {
            error: outcome.message,
          })}
        </p>
      )}
      <button type="button" className="sht-wide" disabled={busy || !password || !address} onClick={() => void submit()}>
        {busy ? (
          <span className="sht-waiting">
            {t("Odesílám")}
            <WaitingDots />
          </span>
        ) : (
          tf(t("Poslat {amount} na moji adresu"), {
            amount: formatSats(o.claimableSats, lang),
          })
        )}
      </button>
    </div>
  );
}

function PendingClaims({ tracker }: { tracker: ExitTracker }) {
  const t = useT();
  const lang = useLang();
  const o = tracker.overview;
  if (o.pendingClaims.length === 0) return null;
  const phaseOf = (ids: string[]) => o.coins.find((c) => ids.includes(c.vtxoId))?.phase;
  return (
    <div className="ex-claims">
      {o.pendingClaims.map((c) => {
        const amount =
          c.amountSats > 0
            ? c.amountSats
            : o.coins.filter((x) => c.vtxoIds.includes(x.vtxoId)).reduce((a, x) => a + x.amountSats, 0);
        const inMempool = phaseOf(c.vtxoIds) === "claiming";
        return (
          <div key={c.attemptedAt} className="ex-claim">
            <div>
              <strong>{formatSats(amount, lang)}</strong> → {shortAddress(c.address)}
            </div>
            <div className="ex-claim-status">
              {inMempool
                ? t("v síti, čeká na potvrzení v bloku")
                : c.sentAt !== null
                  ? t("odesláno, peněženka ho brzy uvidí")
                  : t("síť neodpověděla; když neodešla, do 15 min půjde poslat znovu")}
            </div>
            {c.txid && (
              <a className="ex-txlink" href={explorerTxUrl(c.txid)} target="_blank" rel="noreferrer noopener">
                {t("Zobrazit transakci")}
              </a>
            )}
          </div>
        );
      })}
    </div>
  );
}

function ChangeAddressPanel({ onDone }: { onDone: () => void }) {
  const t = useT();
  const address = useAddressField("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const submit = async () => {
    if (busy || address.valid !== true || !password) return;
    setBusy(true);
    setError(null);
    try {
      await saveExitDestination(address.trimmed, password);
      onDone();
    } catch (e) {
      setError(errorText(e, t));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="ex-panel">
      <p className="ex-note">{t("Platí pro to, co ještě neodešlo.")}</p>
      <AddressInput field={address} t={t} />
      <PasswordInput value={password} onChange={setPassword} onEnter={() => void submit()} t={t} />
      {error && <p className="sht-error">{error}</p>}
      <button
        type="button"
        className="sht-wide"
        disabled={busy || address.valid !== true || !password}
        onClick={() => void submit()}
      >
        {t("Uložit adresu")}
      </button>
    </div>
  );
}

function AddCoinsPanel({
  wallet,
  tracker,
  onCriticalOpChange,
  onDone,
}: {
  wallet: WalletClient;
  tracker: ExitTracker;
  onCriticalOpChange?: (active: boolean) => void;
  onDone: () => void;
}) {
  const t = useT();
  const lang = useLang();
  const [plan, setPlan] = useState<ExitStartPlan | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [includeInRound, setIncludeInRound, arkDown] = useIncludeInRound();
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    loadExitStartPlan(wallet)
      .then(({ plan: p }) => !cancelled && setPlan(p))
      .catch((e) => !cancelled && setLoadError(e instanceof Error ? e.message : String(e)));
    return () => {
      cancelled = true;
    };
  }, [wallet]);
  const addSats = plan ? plan.sats - (includeInRound ? 0 : plan.inRoundSats) : 0;
  const submit = async () => {
    if (busy || !password || addSats <= 0) return;
    setBusy(true);
    setError(null);
    onCriticalOpChange?.(true);
    try {
      const { result } = await startExit(wallet, password, null, { includeInRound });
      await tracker.refresh();
      if (result.started.length === 0) setError(t("Exit se nespustil pro žádnou minci."));
      else onDone();
    } catch (e) {
      setError(errorText(e, t));
    } finally {
      setBusy(false);
      onCriticalOpChange?.(false);
    }
  };
  if (loadError) {
    return (
      <div className="ex-panel">
        <p className="sht-error">{tf(t("Nepodařilo se načíst stav peněženky: {error}"), { error: loadError })}</p>
      </div>
    );
  }
  if (!plan) {
    return (
      <div className="ex-panel">
        <p className="ex-loading sht-waiting">
          {t("Načítám mince")}
          <WaitingDots />
        </p>
      </div>
    );
  }
  return (
    <div className="ex-panel">
      {plan.sats - plan.inRoundSats > 0 && (
        <p className="ex-note">
          {tf(t("Mimo exit máš {amount} (třeba nové platby). Přidají se na stejnou adresu, poplatky jdou z on-chain."), {
            amount: formatSats(plan.sats - plan.inRoundSats, lang),
          })}
        </p>
      )}
      {plan.inRoundSats > 0 && (
        <InRoundChoice sats={plan.inRoundSats} include={includeInRound} onChange={setIncludeInRound} arkDown={arkDown} />
      )}
      {plan.sats === 0 && <p className="ex-note">{t("Mimo exit teď nemáš žádné mince, které by šly přidat.")}</p>}
      {addSats > 0 && (
        <>
          <PasswordInput value={password} onChange={setPassword} onEnter={() => void submit()} t={t} />
          {error && <p className="sht-error">{error}</p>}
          <button type="button" className="danger sht-wide" disabled={busy || !password} onClick={() => void submit()}>
            {tf(t("Přidat {amount} do exitu"), {
              amount: formatSats(addSats, lang),
            })}
          </button>
        </>
      )}
    </div>
  );
}

function CancelPanel({
  wallet,
  tracker,
  onCriticalOpChange,
  onDone,
}: {
  wallet: WalletClient;
  tracker: ExitTracker;
  onCriticalOpChange?: (active: boolean) => void;
  onDone: () => void;
}) {
  const t = useT();
  const lang = useLang();
  const o = tracker.overview;
  const [busy, setBusy] = useState(false);
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [failures, setFailures] = useState<string[]>([]);
  // progressExits() could broadcast the very step being canceled; the SDK
  // daemon (when it runs) can't be stopped from here, but bark's own
  // cancel_exit checks the network before canceling.
  useEffect(() => {
    tracker.setPaused(true);
    return () => tracker.setPaused(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- setPaused is stable
  }, []);
  const cancelableSats = o.coins.filter((c) => c.cancelable).reduce((a, c) => a + c.amountSats, 0);
  const submit = async () => {
    if (busy || !password) return;
    setBusy(true);
    setError(null);
    setFailures([]);
    onCriticalOpChange?.(true);
    try {
      const { failed } = await cancelExits(wallet, password, o.cancelableIds);
      setPassword("");
      await tracker.refresh();
      if (failed.length > 0) {
        setFailures(failed.map((f) => (typeof f.reason === "string" ? f.reason : describeCancelFailure(f.reason, t))));
      } else {
        onDone();
      }
    } catch (e) {
      setError(errorText(e, t));
    } finally {
      setBusy(false);
      onCriticalOpChange?.(false);
    }
  };
  return (
    <div className="ex-panel">
      <p className="ex-note">
        {tf(t("Zrušit jde {count} mincí ({amount}). Vrátí se do Ark, už zaplacené poplatky ne."), {
          count: o.cancelableIds.length,
          amount: formatSats(cancelableSats, lang),
        })}
      </p>
      {failures.length > 0 && (
        <p className="sht-error">
          {tf(t("Některé mince zrušit nešlo: {reasons}"), {
            reasons: [...new Set(failures)].join(", "),
          })}
        </p>
      )}
      <PasswordInput value={password} onChange={setPassword} onEnter={() => void submit()} t={t} />
      {error && <p className="sht-error">{error}</p>}
      <button type="button" className="danger sht-wide" disabled={busy || !password} onClick={() => void submit()}>
        {t("Zrušit exit těchto mincí")}
      </button>
    </div>
  );
}

function ProgressScreen({
  wallet,
  tracker,
  spendableSats,
  inRoundSats,
  onClose,
  onCriticalOpChange,
  onBoard,
}: {
  wallet: WalletClient;
  tracker: ExitTracker;
  spendableSats: number | null;
  inRoundSats: number;
  onClose: () => void;
  onCriticalOpChange?: (active: boolean) => void;
  onBoard: (() => void) | null;
}) {
  const t = useT();
  const lang = useLang();
  const o = tracker.overview;
  const [panel, setPanel] = useState<Panel>(null);
  const toggle = (p: Panel) => setPanel((cur) => (cur === p ? null : p));
  const address = getExitDestinationAddress();
  const hasTag = getExitDestinationTag() !== null;
  const needsFees = o.broadcastingIds.length > 0;
  const budget = tracker.feeBudget;
  const coinsShown = o.coins.filter((c) => c.phase !== "canceled");
  const canChangeAddress = o.coins.some((c) => c.phase !== "claim-sent" && c.phase !== "claiming" && c.phase !== "claimed");
  const timeLabel = tracker.checkedAt
    ? new Date(tracker.checkedAt).toLocaleTimeString(localeFor(lang), {
        hour: "2-digit",
        minute: "2-digit",
      })
    : null;

  return (
    <Screen>
      <ExitJourney step={journeyStepFor(o.stage)} ready={o.stage === "ready"} />
      <h2 className="sht-title">{tracker.feesMissing ? t("Exit stojí") : stageTitle(o, t)}</h2>
      {o.stage !== "ready" && (
        <div className="ex-amount">
          <strong>{formatSats(o.liveSats, lang)}</strong>
        </div>
      )}
      <p className="sht-sub">{stageSub(o, t, lang)}</p>
      {needsFees && o.expiryRiskSats === 0 && (
        <p className="ex-note ex-note--center">
          {o.firstExpiryInBlocks !== null
            ? tf(t("Běží, jen když je appka otevřená. Na blockchain musí doběhnout do {left}."), {
                left: blocksToApproxDuration(o.firstExpiryInBlocks, lang),
              })
            : t("Běží, jen když je appka otevřená.")}
        </p>
      )}
      {needsFees && o.expiryRiskSats > 0 && o.firstExpiryInBlocks !== null && (
        <div className="ex-alert">
          {o.firstExpiryInBlocks > 0
            ? tf(
                t(
                  "Spěchá: {amount} vyprší za {left}. Do té doby musí být celý exit na blockchainu, jinak si mince vezme Ark server. Nech appku otevřenou a měj on-chain na poplatky.",
                ),
                {
                  amount: formatSats(o.expiryRiskSats, lang),
                  left: blocksToApproxDuration(o.firstExpiryInBlocks, lang),
                },
              )
            : tf(
                t(
                  "{amount} už vypršelo, než se exit dostal na blockchain. Ark server si ty mince teď může vzít; exit se o ně dál pokouší.",
                ),
                { amount: formatSats(o.expiryRiskSats, lang) },
              )}
        </div>
      )}

      {tracker.feesMissing && (
        <div className="ex-alert">
          {budget
            ? tf(
                t(
                  "Na poplatky chybí on-chain peníze (potřeba ~{amount}). Pošli je přes Přijmout → On-chain, exit pak pokračuje sám.",
                ),
                {
                  amount: formatSats(budget.neededSats, lang),
                },
              )
            : t("Na poplatky chybí on-chain peníze. Pošli je přes Přijmout → On-chain, exit pak pokračuje sám.")}
        </div>
      )}
      {needsFees && budget?.fundable && (
        <p className="ex-note ex-note--ok ex-note--center">
          {budget.neededSats > 0
            ? tf(t("Na poplatky máš dost (~{amount})."), {
                amount: formatSats(budget.neededSats, lang),
              })
            : t("Poplatky jsou zaplacené, čeká se na potvrzení.")}
        </p>
      )}
      {needsFees && !budget && tracker.feeBudgetError && (
        <p className="ex-note">
          {tf(t("Nepodařilo se ověřit, jestli zůstatek stačí na poplatky: {error}"), { error: tracker.feeBudgetError })}
        </p>
      )}

      {o.claimableIds.length > 0 && <ClaimPanel wallet={wallet} tracker={tracker} onCriticalOpChange={onCriticalOpChange} />}
      <PendingClaims tracker={tracker} />

      {!address && <div className="ex-alert">{t("Chybí cílová adresa. Nastav ji v „Změnit adresu“.")}</div>}

      {o.claimableIds.length === 0 && address && (
        <div className="ex-destination">
          <span>{t("Na adresu")}</span>
          <strong>{shortAddress(address)}</strong>
          {!hasTag && <em className="ex-badge ex-badge--bad">{t("nepotvrzená heslem")}</em>}
        </div>
      )}

      <div className="ex-links">
        <button type="button" className="sht-link" onClick={() => toggle("coins")}>
          {tf(t("Mince ({count})"), { count: coinsShown.length })}
        </button>
        {canChangeAddress && (
          <button type="button" className="sht-link" onClick={() => toggle("address")}>
            {t("Změnit adresu")}
          </button>
        )}
        {((spendableSats !== null && spendableSats > 0) || inRoundSats > 0) && (
          <button type="button" className="sht-link" onClick={() => toggle("add")}>
            {t("Přidat mince")}
          </button>
        )}
        {onBoard && !needsFees && (
          <button type="button" className="sht-link" onClick={onBoard}>
            {t("Přijmout on-chain")}
          </button>
        )}
        {o.cancelableIds.length > 0 && (
          <button type="button" className="sht-link" onClick={() => toggle("cancel")}>
            {t("Zrušit")}
          </button>
        )}
      </div>

      <div className="ex-collapsible">
        <Collapse open={panel !== null}>
          {panel === "coins" && (
            <ul className="ex-coins">
              {coinsShown.map((c) => {
                const txid = coinTxid(c);
                return (
                <li key={c.vtxoId}>
                  <div className="ex-coin-head">
                    <strong>{formatSats(c.amountSats, lang)}</strong>
                    <span className={`ex-coin-phase ex-coin-phase--${c.phase}`}>{coinLine(c, t, lang)}</span>
                  </div>
                  {txid && (
                    <a className="ex-txlink" href={explorerTxUrl(txid)} target="_blank" rel="noreferrer noopener">
                      {t("Zobrazit transakci")}
                    </a>
                  )}
                </li>
                );
              })}
            </ul>
          )}
          {panel === "address" && <ChangeAddressPanel onDone={() => setPanel(null)} />}
          {panel === "add" && (
            <AddCoinsPanel
              wallet={wallet}
              tracker={tracker}
              onCriticalOpChange={onCriticalOpChange}
              onDone={() => setPanel(null)}
            />
          )}
          {panel === "cancel" && (
            <CancelPanel
              wallet={wallet}
              tracker={tracker}
              onCriticalOpChange={onCriticalOpChange}
              onDone={() => setPanel(null)}
            />
          )}
        </Collapse>
      </div>

      {tracker.progressError && <p className="ex-note">{tf(t("Peněženka hlásí: {error}"), { error: tracker.progressError })}</p>}
      {tracker.progressBackoffUntil !== null && (
        <p className="ex-note">
          {tf(t("Posun exitu minule nedoběhl, další pokus v {time}. Hned ho spustí „Zkontrolovat teď“."), {
            time: new Date(tracker.progressBackoffUntil).toLocaleTimeString(localeFor(lang), { hour: "2-digit", minute: "2-digit" }),
          })}
        </p>
      )}
      <p className="ex-footer">
        {tracker.error
          ? tf(t("Poslední kontrola selhala ({error}), zkouším znovu."), {
              error: tracker.error,
            })
          : timeLabel
            ? tf(t("Zkontrolováno v {time}."), { time: timeLabel })
            : null}{" "}
        <button type="button" className="ex-inline-link" onClick={() => void tracker.refresh({ progress: true })}>
          {t("Zkontrolovat teď")}
        </button>
      </p>
      <button type="button" className="secondary sht-wide" onClick={onClose}>
        {t("Zavřít")}
      </button>
    </Screen>
  );
}

// --- done -------------------------------------------------------------------

function DoneScreen({
  tracker,
  onClose,
  onStartNew,
}: {
  tracker: ExitTracker;
  onClose: () => void;
  onStartNew: (() => void) | null;
}) {
  const t = useT();
  const lang = useLang();
  const c = tracker.completion;
  const claims = c ? Object.values(c.claims) : [];
  const arrived = c ? completionArrivedSats(c) : null;
  const fee = claims.every((x) => x.feeSats !== null) ? claims.reduce((a, x) => a + (x.feeSats ?? 0), 0) : null;
  const addresses = [...new Set(claims.map((x) => x.address))];
  const links = claims.filter((x): x is typeof x & { txid: string } => x.txid !== null);
  const [showLinks, setShowLinks] = useState(false);
  return (
    <Screen>
      <ExitJourney step={4} />
      <StatusMark state="success" />
      <h2 className="sht-title">{t("Nouzový exit dokončen")}</h2>
      {arrived !== null && (
        <p className="sht-sub">
          {tf(t("{amount} je na {address}."), {
            amount: formatSats(arrived, lang),
            address: addresses.map(shortAddress).join(", ") || t("tvé adrese"),
          })}
          {fee !== null && fee > 0 && <> {tf(t("Poplatek {amount}."), { amount: formatSats(fee, lang) })}</>}
        </p>
      )}
      {links.length === 1 && (
        <a className="ex-txlink" href={explorerTxUrl(links[0].txid)} target="_blank" rel="noreferrer noopener">
          {t("Zobrazit transakci")}
        </a>
      )}
      {links.length > 1 && (
        <>
          <button type="button" className="sht-link" onClick={() => setShowLinks((v) => !v)} aria-expanded={showLinks}>
            {tf(t("Zobrazit transakce ({count})"), { count: links.length })}
          </button>
          {showLinks &&
            links.map((x) => (
              <a key={x.txid} className="ex-txlink" href={explorerTxUrl(x.txid)} target="_blank" rel="noreferrer noopener">
                {x.arrivedSats !== null ? formatSats(x.arrivedSats, lang) : t("Zobrazit transakci")}
              </a>
            ))}
        </>
      )}
      <button
        type="button"
        className="sht-wide"
        onClick={() => {
          tracker.dismissCompletion();
          onClose();
        }}
      >
        {t("Hotovo")}
      </button>
      {onStartNew && (
        <button type="button" className="sht-link" onClick={onStartNew}>
          {t("Spustit další exit")}
        </button>
      )}
    </Screen>
  );
}

// --- shell ------------------------------------------------------------------

export default function ExitSheet({
  wallet,
  tracker,
  spendableSats,
  inRoundSats = 0,
  onClose,
  onKickOut,
  onCriticalOpChange,
  onBoard = null,
}: {
  wallet: WalletClient;
  tracker: ExitTracker;
  // Coins outside the exit (exiting ones are locked, so this is exactly them).
  spendableSats: number | null;
  // Money in a pending round (balance.pendingInRoundSats): "Přidat mince"
  // shows for it too, since a coin our refresh locked isn't spendable.
  inRoundSats?: number;
  onClose: () => void;
  // The start refused to run (no on-chain money for fees): the host shows
  // `message` in the island; the sheet stays open under it.
  onKickOut?: (message: string) => void;
  onCriticalOpChange?: (active: boolean) => void;
  // Moving the on-chain balance into Ark while the exit no longer needs fees
  // (Dashboard decides): closes this sheet and opens BoardSheet's warning.
  onBoard?: (() => void) | null;
}) {
  const t = useT();
  const { closing, closeThen } = useSheetClose();
  const [forceStart, setForceStart] = useState(false);
  const close = useCallback(() => closeThen(onClose), [closeThen, onClose]);

  const face = useMemo((): "loading" | "start" | "progress" | "done" => {
    // Before the tracker's first read (it can queue behind other wallet
    // calls), the last session's hint decides: with no exit known, the start
    // (or done) face shows straight away instead of "Zjišťuji stav exitu".
    // If the read then finds one running, the sheet switches by itself.
    if (!tracker.loaded && exitMayBeLive()) return "loading";
    if (tracker.loaded && tracker.overview.live) return "progress";
    if (!forceStart && tracker.completion && !tracker.completion.dismissed) return "done";
    return "start";
  }, [tracker.loaded, tracker.overview.live, tracker.completion, forceStart]);

  return (
    <Sheet closing={closing} onBackdrop={close} screenKey={face}>
      {face === "loading" && (
        <Screen>
          <StatusMark state="progress" />
          <h2 className="sht-title">{t("Zjišťuji stav exitu")}</h2>
          {tracker.error && (
            <p className="sht-error">
              {tf(t("Nepodařilo se to: {error}. Zkouším znovu."), {
                error: tracker.error,
              })}
            </p>
          )}
          <button type="button" className="sht-link" onClick={close}>
            {t("Zavřít")}
          </button>
        </Screen>
      )}
      {face === "start" && (
        <StartScreen
          wallet={wallet}
          tracker={tracker}
          onClose={close}
          onKickOut={(message) => onKickOut?.(message)}
          onCriticalOpChange={onCriticalOpChange}
        />
      )}
      {face === "progress" && (
        <ProgressScreen
          wallet={wallet}
          tracker={tracker}
          spendableSats={spendableSats}
          inRoundSats={inRoundSats}
          onClose={close}
          onCriticalOpChange={onCriticalOpChange}
          onBoard={onBoard ? () => closeThen(onBoard) : null}
        />
      )}
      {face === "done" && (
        <DoneScreen
          tracker={tracker}
          onClose={close}
          onStartNew={spendableSats !== null && spendableSats > 0 ? () => setForceStart(true) : null}
        />
      )}
    </Sheet>
  );
}
