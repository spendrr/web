// Settings → VTXO mince → "Automatická obnova" (live for everyone since
// 2026-10-17). The card is short: status, warnings and actions; the plan and
// what is running sit behind "Detail" (RefreshEngineDetailSheet). Everything
// comes from one read the VTXO screen does for itself (VtxoList in
// Settings.tsx), so the card never loads on its own.
import { useCallback, useState, useSyncExternalStore } from "react";
import type { WalletClient } from "../lib/wallet/bark";
import { localeFor, tf, useLang, useT } from "../lib/i18n";
import { effectiveEngineMode, needsRelockForMode } from "../lib/refreshEngine/mode";
import {
  engineSnapshot,
  previewManualRefresh,
  releaseEngineQuarantine,
  releaseEngineStranded,
  resetEngineBreaker,
  runEngine,
  subscribeEngine,
  type EngineOverview,
} from "../lib/refreshEngine/runner";
import type { TickResult } from "../lib/refreshEngine/engine";
import type { Plan } from "../lib/refreshEngine/plan";
import { rawErrorMessage } from "../lib/appErrors";
import { CoinList, coinsLabel, EngineLogRow, RefreshEngineDetailSheet, Totals, useEngineSummary } from "./RefreshEngineOverview";
import type { LogEntry } from "../lib/refreshEngine/engine";
import { Screen, Sheet, useSheetClose } from "./sheet/PaySheet";

const OUTCOME_LABEL: Record<TickResult["outcome"], string> = {
  idle: "Nic k obnově",
  submitted: "Odesláno",
  resubmitted: "Dokončeno dřívější odeslání, zkus znovu",
  "plan-changed": "Mince nebo poplatek se změnily",
  "dry-run": "Zkušebně naplánováno",
  "skip-foreign-pending": "Čeká na jinou obnovu",
  "skip-unknown-round": "Neznámý stav kola, čeká",
  "skip-uncertain": "Ověřuje předchozí odeslání",
  "skip-breaker": "Zastaveno pojistkou",
  "skip-backoff": "Čeká po chybě",
  "skip-rate": "Denní limit pokusů, čeká",
  "skip-network": "Čeká na síť",
  partial: "Odesláno zčásti",
  failed: "Selhalo",
  error: "Chyba při kontrole",
};

function useEngineSnapshot() {
  return useSyncExternalStore(subscribeEngine, engineSnapshot);
}

export default function RefreshEnginePanel({
  wallet,
  overview,
  overviewError,
  onChanged,
}: {
  wallet: WalletClient;
  overview: EngineOverview | null;
  overviewError: string | null;
  onChanged: () => void;
}) {
  const t = useT();
  const lang = useLang();
  const locale = localeFor(lang);
  const snap = useEngineSnapshot();
  const [showLog, setShowLog] = useState(false);
  const [showDetail, setShowDetail] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [preview, setPreview] = useState<ManualPreview | null>(null);

  const live = effectiveEngineMode() === "live";

  const time = (at: number) =>
    new Date(at).toLocaleString(locale, { day: "numeric", month: "numeric", hour: "2-digit", minute: "2-digit" });

  // What "Obnovit teď" shows before anything is sent. Loaded while the
  // Detail sheet stays open (it shows "Načítám…" and any error): the preview
  // queues behind whatever the worker is doing, and on mainnet that can take
  // a while; the sheet used to close first and leave nothing on screen.
  const loadPreview = useCallback(async (): Promise<ManualPreview> => {
    const { plan, fees } = await previewManualRefresh(wallet);
    return {
      plan,
      fees: fees.map((f) => f.feeSats),
      feeSats: fees.reduce((s, f) => s + f.feeSats, 0),
      amountSats: plan.batches.reduce((s, b) => s + b.amountSats, 0),
    };
  }, [wallet]);

  const confirmManual = useCallback(async () => {
    if (!preview) return;
    setBusy(true);
    setError(null);
    try {
      // Exactly what the user is looking at, or nothing (see ManualExpectation).
      const r = await runEngine(wallet, "manual", {
        batches: preview.plan.batches.map((b) => b.ids),
        feeSats: preview.feeSats,
      });
      if (r.outcome !== "submitted") setError(t(OUTCOME_LABEL[r.outcome]));
      setPreview(null);
      onChanged();
    } catch (e) {
      setError(rawErrorMessage(e) || t("Neznámá chyba"));
    } finally {
      setBusy(false);
    }
  }, [wallet, t, onChanged, preview]);

  // The snapshot follows every save (a tick, a release); the overview is the
  // last full read.
  const { state } = snap;
  const status = snap.status ?? overview?.status ?? null;
  const log = [...state.log].reverse();
  const waitUntil = status?.backoffUntil
    ? `${time(status.backoffUntil)} · ${status.backoffWhy === "rate" ? t("denní limit") : t("po chybě")}`
    : null;

  return (
    <div className="vtxo-card">
      <div className="info-row">
        <span>{t("Automatická obnova")}</span>
      </div>
      <div className="settings-body engine-card-body">
        {!live ? (
          // Beta switched on mid-session: the open decides (runDaemon).
          <div className="info-row">
            <span>{t("Zapne se")}</span>
            <code>{needsRelockForMode() ? t("po zamknutí a odemčení") : t("vypnuto")}</code>
          </div>
        ) : (
          <>
            {overview && <EngineSummaryRow overview={overview} waitUntil={waitUntil} />}
            {!overview && overviewError && <p className="muted small">{`${t("Plán nedostupný")}: ${overviewError}`}</p>}
            {(status?.overCapSats ?? 0) > 0 && (
              <p className="muted small">
                {t("Mince nad limitem serveru obnovit nejde. Pošli část na svou adresu, rozdělí se na menší.")}
              </p>
            )}
            {status?.breaker && (
              <div className="info-row">
                <span>{t("Pojistka")}</span>
                <strong className="error">{t("zastavena, 5 neúspěchů")}</strong>
              </div>
            )}
            {Object.keys(state.stranded).length > 0 && (
              <p className="muted small">
                {t("Server tyto mince započítal do kola, na které appka nedostala odpověď. Tahle verze peněženky je nevyzvedne; pomůže novější verze, nebo nouzový exit.")}
              </p>
            )}
            {Object.entries(state.stranded).map(([id, x]) => (
              <div key={`s-${id}`} className="info-row">
                <span>
                  {t("Uvízla v kole")} {id.slice(0, 8)}… · {time(x.at)}
                </span>
                <button
                  className="secondary small"
                  disabled={busy}
                  onClick={() => void releaseEngineStranded(wallet, id).then(onChanged)}
                >
                  {t("Uvolnit")}
                </button>
              </div>
            ))}
            {Object.entries(state.quarantine).map(([id, q]) => (
              <div key={id} className="info-row">
                <span>
                  {t("Karanténa")} {id.slice(0, 8)}… · {q.reason === "spent" ? t("utracená") : t("znovu za 7 dní")}
                </span>
                <button
                  className="secondary small"
                  disabled={busy}
                  onClick={() => void releaseEngineQuarantine(wallet, id).then(onChanged)}
                >
                  {t("Uvolnit")}
                </button>
              </div>
            ))}
            {error && <p className="error">{error}</p>}
            {status?.breaker && (
              <button className="secondary small engine-wide" onClick={() => void resetEngineBreaker(wallet).then(onChanged)}>
                {t("Zkusit znovu")}
              </button>
            )}
            <div className="engine-actions">
              <button className="secondary small" disabled={!overview} onClick={() => setShowDetail(true)}>
                {t("Detail")}
              </button>
              <button className="secondary small" onClick={() => setShowLog(true)}>
                {tf(t("Deník ({n})"), { n: state.log.length })}
              </button>
            </div>
          </>
        )}
      </div>

      {showDetail && overview && (
        <RefreshEngineDetailSheet
          overview={overview}
          waitUntil={waitUntil}
          loadPreview={loadPreview}
          onPreview={(p) => {
            setError(null);
            setShowDetail(false);
            setPreview(p);
          }}
          onClose={() => setShowDetail(false)}
        />
      )}
      {showLog && (
        <EngineLogSheet
          log={log}
          onClose={() => setShowLog(false)}
        />
      )}
      {preview && (
        <ManualRefreshSheet
          preview={preview}
          lifetimeBlocks={overview?.lifetimeBlocks ?? 4032}
          busy={busy}
          error={error}
          onConfirm={confirmManual}
          onClose={() => setPreview(null)}
        />
      )}
    </div>
  );
}

// A due refresh held back by the 24 h cap or a failure pause shows when it
// may go instead of "teď".
function EngineSummaryRow({ overview, waitUntil }: { overview: EngineOverview; waitUntil: string | null }) {
  const t = useT();
  const summary = useEngineSummary(overview);
  const now = summary.now;
  const next = waitUntil && summary.next === t("teď") ? waitUntil : summary.next;
  return (
    <div className="info-row">
      <span>{now ? t("Právě probíhá") : t("Příští obnova")}</span>
      <strong>{now ?? next}</strong>
    </div>
  );
}

export interface ManualPreview {
  plan: Plan;
  // Per batch, in plan order.
  fees: number[];
  feeSats: number;
  amountSats: number;
}

// The newest five, older ones five at a time.
const LOG_PAGE = 5;

function EngineLogSheet({
  log,
  onClose,
}: {
  log: readonly LogEntry[];
  onClose: () => void;
}) {
  const t = useT();
  const { closing, closeThen } = useSheetClose();
  const [shown, setShown] = useState(LOG_PAGE);
  const close = () => closeThen(onClose);
  return (
    <Sheet closing={closing} onBackdrop={close} screenKey="engine-log">
      <Screen>
        <h2 className="sht-title">{t("Deník obnovy")}</h2>
        <div className="engine-detail engine-log">
          {log.length === 0 && <p className="muted small">{t("Zatím nic.")}</p>}
          {log.slice(0, shown).map((e, i) => (
            <EngineLogRow key={`${e.at}-${i}`} entry={e} />
          ))}
        </div>
        {log.length > shown && (
          <button type="button" className="engine-link engine-more" onClick={() => setShown((n) => n + LOG_PAGE)}>
            {t("Starší")}
          </button>
        )}
        <button type="button" className="secondary sht-wide" onClick={close}>
          {t("Zavřít")}
        </button>
      </Screen>
    </Sheet>
  );
}

// Same shape as the Detail sheet: one muted line, the coins, the four tiles
// (the first version was five label/value rows of equal weight).
function ManualRefreshSheet({
  preview,
  lifetimeBlocks,
  busy,
  error,
  onConfirm,
  onClose,
}: {
  preview: ManualPreview;
  lifetimeBlocks: number;
  busy: boolean;
  error: string | null;
  onConfirm: () => Promise<void>;
  onClose: () => void;
}) {
  const t = useT();
  const { closing, closeThen } = useSheetClose();
  const close = () => {
    if (!busy) closeThen(onClose);
  };
  const batches = preview.plan.batches;
  const empty = batches.length === 0;
  const coinCount = batches.reduce((s, b) => s + b.ids.length, 0);
  return (
    <Sheet closing={closing} onBackdrop={close} screenKey="engine-manual">
      <Screen>
        <h2 className="sht-title">{t("Obnovit všechny mince")}</h2>
        {empty ? (
          <p className="sht-sub">{t("Není co obnovit.")}</p>
        ) : (
          <div className="engine-detail">
            <p className="muted small engine-facts">
              {coinsLabel(coinCount, t)} · {t("příští kolo, do ~1 h")}
            </p>
            {batches.map((b, i) => {
              const coins = [...b.due, ...b.companions];
              // PlannedVtxo carries blocksLeft; the tip is what it was counted from.
              const tip = coins[0] ? coins[0].expiryHeight - coins[0].blocksLeft : 0;
              const fee = preview.fees[i] ?? 0;
              return (
                <div key={i} className="engine-batch">
                  <CoinList title={batches.length > 1 ? tf(t("Dávka {n}"), { n: i + 1 }) : t("Mince")} coins={coins} tip={tip} />
                  <Totals amountSats={b.amountSats} feeSats={fee} outputSats={b.amountSats - fee} lifetimeBlocks={lifetimeBlocks} />
                </div>
              );
            })}
          </div>
        )}
        {error && <p className="error">{error}</p>}
        <div className="engine-sheet-actions">
          {!empty && (
            <button type="button" className="sht-wide" disabled={busy} onClick={() => void onConfirm()}>
              {busy ? t("Odesílám…") : t("Potvrdit")}
            </button>
          )}
          <button type="button" className="secondary sht-wide" disabled={busy} onClick={close}>
            {t("Zpět")}
          </button>
        </div>
      </Screen>
    </Sheet>
  );
}
