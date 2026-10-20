// Settings → VTXO mince → Automatická obnova: the readable part. What the
// engine will refresh next, when and why, what rides along and for how much
// (Plán), what is being refreshed right now and where it stands (Právě
// probíhá), and the log as sentences (Deník). Everything shown comes from the
// engine's own state and the same planner it runs (forecast.ts).
import { useState } from "react";
import { localeFor, tf, useLang, useT } from "../lib/i18n";
import type { EngineOverview } from "../lib/refreshEngine/runner";
import { Screen, Sheet, useSheetClose } from "./sheet/PaySheet";
import { rawErrorMessage } from "../lib/appErrors";
import type { ManualPreview } from "./RefreshEnginePanel";
import type { LogEntry, LoggedCoin, TrackedBatch } from "../lib/refreshEngine/engine";
import type { CoinSchedule } from "../lib/refreshEngine/forecast";
import type { PlannedVtxo } from "../lib/refreshEngine/plan";

type T = (cs: string) => string;

// Short labels, no sentences: the panel is read at a glance.
const REASON: Record<string, string> = {
  expired: "vypršela",
  expiring: "pod 250 bloků",
  "max-depth": "max. hloubka",
  free: "zdarma",
  dust: "drobná (do 330 sats)",
  "small-cheap": "malá, nejlevnější pásmo",
  "small-deep": "malá, hloubka 60+",
};

const FATE: Record<CoinSchedule["fate"], string> = {
  "next-due": "spustí příští",
  "next-companion": "přibere se",
  later: "později",
  quarantined: "karanténa",
  "in-refresh": "v obnově",
  locked: "zamčená (platba)",
  held: "odložená",
  "over-max-amount": "nad limitem serveru",
};

const ROUND_STATE: Record<string, string> = {
  "delegated-pending": "čeká na kolo",
  pending: "kolo začíná",
  ongoing: "kolo běží",
  "awaiting-confirmations": "čeká na potvrzení",
};

const LOG_TITLE: Record<LogEntry["kind"], string> = {
  "dry-run": "Zkušebně",
  submitted: "Odesláno",
  fee: "Placená obnova",
  rejected: "Odmítnuto",
  uncertain: "Nejisté odeslání",
  resubmitted: "Odesláno znovu",
  adopted: "Převzato",
  "uncertain-dropped": "Nejisté vzdáno",
  "lock-failed": "Zámek selhal",
  completed: "Dokončeno",
  "round-failed": "Kolo selhalo",
  unlocked: "Uvolněno",
  quarantined: "Karanténa",
  "quarantine-released": "Z karantény",
  breaker: "Pojistka",
  "breaker-reset": "Pojistka obnovena",
  suspected: "Přibrané vynechány",
  stranded: "Uvízla v kole",
  "released-ended": "Uvolněná obnova skončila",
  "ended-unseen": "Skončilo bez potvrzení",
  "strand-check": "Kontrola uvíznutí",
  skipped: "Přeskočeno",
  check: "Kontrola",
};

const NOTE: Record<string, string> = {
  manual: "ručně",
  "without-companions": "bez přibraných",
  isolation: "hledání vadné mince",
  "isolation-waits": "hledání čeká na limit",
  "rate-waits": "denní limit 6 pokusů",
  "below-dust-after-fee": "po poplatku pod 330 sats",
  "tick-error": "chyba kontroly",
  "manual-plan-changed": "plán se změnil",
  "inputs-changed": "mince se mezitím změnily",
  "resubmit-window": "10 min uplynulo",
  resubmit: "opakování",
  orphan: "osiřelý zámek",
  "quarantine-orphan": "mimo karanténu",
  "quarantine-passive": "mimo ostrý režim",
  unlock: "odemčení selhalo",
  "waits-network": "čeká na viditelnou appku a síť",
  "gave-up": "bez odpovědi 2 h, vzdáno",
  stranded: "znovu v plánu",
  stuck: "přes 24 h, uvolněno",
  "strand-check": "zkouší mince po jedné",
  passed: "mince prošla, neuvízly",
  landed: "odmítnuty po jedné, uvízly",
  inconclusive: "nejde rozhodnout, zpět v plánu",
  unknown: "důvod neznámý, znovu za 7 dní",
  spent: "utracená, jen ručně",
  failures: "5 neúspěchů",
  user: "ručně",
};

// Blocks are ~10 minutes each.
export function approxTime(blocks: number, t: T): string {
  const minutes = Math.max(0, blocks) * 10;
  if (minutes < 60) return tf(t("~{n} min"), { n: Math.max(1, Math.round(minutes)) });
  const hours = Math.round(minutes / 60);
  if (hours < 48) return tf(t("~{n} h"), { n: hours });
  const days = Math.round(hours / 24);
  if (days === 1) return t("~1 den");
  return tf(t(days <= 4 ? "~{n} dny" : "~{n} dní"), { n: days });
}

function useFmt() {
  const t = useT();
  const lang = useLang();
  const locale = localeFor(lang);
  return {
    t,
    sats: (n: number) => `${n.toLocaleString(locale)} sats`,
    clock: (at: number) =>
      new Date(at).toLocaleString(locale, { day: "numeric", month: "numeric", hour: "2-digit", minute: "2-digit" }),
    when: (blocks: number) => approxTime(blocks, t),
  };
}

// "Detail" in Settings → Automatická obnova: what is running now and the
// whole plan (the user wanted the card itself short, the plan one tap away).
export function RefreshEngineDetailSheet({
  overview,
  loadPreview,
  onPreview,
  onClose,
  waitUntil,
}: {
  overview: EngineOverview;
  // "29. 9. 17:34 · denní limit" when a due refresh is held back.
  waitUntil: string | null;
  // "Obnovit teď": the preview loads here, the sheet closes once it's ready.
  loadPreview: () => Promise<ManualPreview>;
  onPreview: (p: ManualPreview) => void;
  onClose: () => void;
}) {
  const { t } = useFmt();
  const { closing, closeThen } = useSheetClose();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const close = () => {
    if (!loading) closeThen(onClose);
  };
  const refreshNow = async () => {
    setLoading(true);
    setError(null);
    try {
      const p = await loadPreview();
      closeThen(() => onPreview(p));
    } catch (e) {
      setError(rawErrorMessage(e) || t("Neznámá chyba"));
    } finally {
      setLoading(false);
    }
  };
  return (
    <Sheet closing={closing} onBackdrop={close} screenKey="engine-detail">
      <Screen>
        <h2 className="sht-title">{t("Automatická obnova")}</h2>
        <div className="engine-detail">
          <InProgress overview={overview} />
          <Plan overview={overview} waitUntil={waitUntil} />
        </div>
        <div className="engine-sheet-actions">
          {error && <p className="error">{error}</p>}
          <button type="button" className="secondary sht-wide" disabled={loading} onClick={() => void refreshNow()}>
            {loading ? t("Načítám…") : t("Obnovit teď")}
          </button>
          <button type="button" className="secondary sht-wide" onClick={close}>
            {t("Zavřít")}
          </button>
        </div>
      </Screen>
    </Sheet>
  );
}

// The card's one-line answers: when the next refresh is, and what is running.
export function useEngineSummary(overview: EngineOverview) {
  const { t, sats, when } = useFmt();
  const f = overview.forecast;
  const soonest = f.coins.find((c) => c.fate === "later");
  const next =
    f.nextAtHeight === null
      ? soonest?.dueAtHeight != null
        ? `${when(soonest.dueAtHeight - f.tipHeight)} · ${sats(soonest.amountSats)}`
        : t("není potřeba")
      : f.nextAtHeight <= f.tipHeight
        ? t("teď")
        : when(f.nextAtHeight - f.tipHeight);
  const { state, rounds } = overview;
  const running = state.batches.filter((b) => !b.released);
  const runningCoins = running.reduce((n, b) => n + b.ids.length, 0) + (state.submitting?.ids.length ?? 0);
  const firstState = running.map((b) => rounds.find((r) => r.id === b.roundId)?.state).find(Boolean);
  const now =
    runningCoins === 0
      ? null
      : `${coinsLabel(runningCoins, t)} · ${
          state.submitting && running.length === 0
            ? t("ověřuje se")
            : firstState
              ? t(ROUND_STATE[firstState] ?? firstState)
              : t("dokončuje se")
        }`;
  return { next, now };
}

// Both sections are built the same way: a heading with its answer on the
// right, one muted line of facts, the coins, and the four numbers as tiles.
function SectionHead({ title, value }: { title: string; value?: string }) {
  return (
    <div className="engine-head">
      <span className="engine-coinlist-title">{title}</span>
      {value && <strong>{value}</strong>}
    </div>
  );
}

function Plan({ overview, waitUntil }: { overview: EngineOverview; waitUntil: string | null }) {
  const { t, sats, when } = useFmt();
  const [showAll, setShowAll] = useState(false);
  const f = overview.forecast;
  const soonest = f.coins.find((c) => c.fate === "later");
  const next =
    f.nextAtHeight === null
      ? t("není potřeba")
      : f.nextAtHeight <= f.tipHeight
        ? (waitUntil ?? t("teď"))
        : when(f.nextAtHeight - f.tipHeight);
  const facts: string[] = [];
  if (f.nextAtHeight !== null && f.nextAtHeight > f.tipHeight) {
    facts.push(tf(t("blok {height}"), { height: f.nextAtHeight.toLocaleString() }), t("jen s otevřenou appkou"));
  }
  if (f.nextAtHeight === null && soonest?.dueAtHeight != null) {
    facts.push(tf(t("nejbližší {amount} za {when}"), { amount: sats(soonest.amountSats), when: when(soonest.dueAtHeight - f.tipHeight) }));
  }

  return (
    <section className="engine-section">
      <SectionHead title={t("Příští obnova")} value={next} />
      {facts.length > 0 && <p className="muted small engine-facts">{facts.join(" · ")}</p>}
      {f.batches.map((b, i) => (
        <div key={i} className="engine-batch">
          {b.group && <p className="muted small engine-facts">{t("hledání vadné mince")}</p>}
          <CoinList title={t("Spouštěč")} coins={b.due} tip={f.tipHeight} />
          {b.companions.length > 0 && <CoinList title={t("Přibrané")} coins={b.companions} tip={f.tipHeight} />}
          <Totals
            amountSats={b.amountSats}
            feeSats={b.feeSats}
            outputSats={b.outputSats}
            lifetimeBlocks={overview.lifetimeBlocks}
            estimate
          />
        </div>
      ))}

      <button type="button" className="engine-toggle" onClick={() => setShowAll((v) => !v)}>
        <span className="engine-coinlist-title">{tf(t("Všechny mince ({n})"), { n: f.coins.length })}</span>
        <span className="muted">{showAll ? "▾" : "▸"}</span>
      </button>
      {showAll && (
        <div className="engine-coins">
          {f.coins.map((c) => (
            <div key={c.id} className="engine-coin">
              <div className="engine-coin-main">
                <strong>{sats(c.amountSats)}</strong>
                <span>{t(FATE[c.fate])}</span>
              </div>
              <div className="muted small">
                {c.blocksLeft > 0 ? tf(t("vyprší {when}"), { when: when(c.blocksLeft) }) : t("vypršela")}
                {c.fate === "later" && c.dueAtHeight !== null && (
                  <> · {tf(t("obnova {when}"), { when: when(c.dueAtHeight - f.tipHeight) })}</>
                )}
                {" · "}
                {tf(t("hloubka {n}"), { n: c.exitDepth })}
              </div>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

export function CoinList({ title, coins, tip }: { title: string; coins: readonly PlannedVtxo[]; tip: number }) {
  const { t, sats, when } = useFmt();
  return (
    <div className="engine-coinlist">
      <div className="engine-coinlist-title">{title}</div>
      {coins.map((c) => (
        <div key={c.id} className="engine-coin">
          <div className="engine-coin-main">
            <strong>{sats(c.amountSats)}</strong>
            <span className="muted">
              {c.expiryHeight - tip > 0 ? tf(t("vyprší {when}"), { when: when(c.expiryHeight - tip) }) : t("vypršela")}
            </span>
          </div>
          <div className="muted small">
            {c.reasons.map((r) => t(REASON[r] ?? r)).join(" · ")} · {tf(t("hloubka {n}"), { n: c.exitDepth })}
          </div>
        </div>
      ))}
    </div>
  );
}

export function Totals({
  amountSats,
  feeSats,
  outputSats,
  lifetimeBlocks,
  estimate,
}: {
  amountSats: number;
  feeSats: number;
  outputSats: number;
  lifetimeBlocks: number;
  estimate?: boolean;
}) {
  const { t, sats, when } = useFmt();
  const tiles: [string, string][] = [
    [t("Celkem"), sats(amountSats)],
    [estimate ? t("Poplatek (odhad)") : t("Poplatek"), feeSats === 0 ? t("zdarma") : sats(feeSats)],
    [t("Nová mince"), sats(outputSats)],
    [t("Platnost"), when(lifetimeBlocks)],
  ];
  return (
    <div className="engine-tiles">
      {tiles.map(([label, value]) => (
        <div key={label} className="engine-tile">
          <span className="muted small">{label}</span>
          <strong>{value}</strong>
        </div>
      ))}
    </div>
  );
}

function InProgress({ overview }: { overview: EngineOverview }) {
  const { t, clock } = useFmt();
  const { state, rounds } = overview;
  const groupCoins = state.groups.reduce((n, g) => n + g.length, 0);
  if (state.batches.length === 0 && !state.submitting && groupCoins === 0) return null;
  const facts: string[] = [];
  if (state.submitting) {
    facts.push(tf(t("ověřuje se odeslání {coins} z {time}"), { coins: coinsLabel(state.submitting.ids.length, t), time: clock(state.submitting.at) }));
  }
  if (groupCoins > 0) facts.push(tf(t("hledání vadné mince: {coins}"), { coins: coinsLabel(groupCoins, t) }));
  return (
    <section className="engine-section">
      <SectionHead title={t("Právě probíhá")} />
      {facts.length > 0 && <p className="muted small engine-facts">{facts.join(" · ")}</p>}
      {state.batches.map((b, i) => (
        <RunningBatch
          key={i}
          batch={b}
          roundState={rounds.find((r) => r.id === b.roundId)?.state}
          now={overview.at}
          lifetimeBlocks={overview.lifetimeBlocks}
        />
      ))}
    </section>
  );
}

function RunningBatch({
  batch,
  roundState,
  now,
  lifetimeBlocks,
}: {
  batch: TrackedBatch;
  roundState: string | undefined;
  now: number;
  lifetimeBlocks: number;
}) {
  const { t, clock } = useFmt();
  const stuck = !batch.released && now - batch.at > 24 * 60 * 60_000;
  const state = `${roundState ? t(ROUND_STATE[roundState] ?? roundState) : t("dokončuje se")}${stuck ? ` ${t("přes 24 h")}` : ""}`;
  const facts = [
    tf(t("odesláno {time}"), { time: clock(batch.at) }),
    batch.manual ? t("ručně") : t("automaticky"),
    batch.released ? t("uvolněno") : batch.locked ? t("v kole") : t("čeká na kolo"),
  ];
  return (
    <div className="engine-batch">
      <div className="engine-batch-status">
        <strong className={stuck ? "error" : undefined}>{state}</strong>
        <span className="muted small">{facts.join(" · ")}</span>
      </div>
      {batch.coins && <LoggedCoins coins={batch.coins} total={batch.ids.length} />}
      <Totals
        amountSats={batch.amountSats}
        feeSats={batch.feeSats}
        outputSats={batch.amountSats - batch.feeSats}
        lifetimeBlocks={lifetimeBlocks}
      />
    </div>
  );
}

// 1 mince, 2-4 mince, 5+ mincí.
export function coinsLabel(n: number, t: T): string {
  if (n === 1) return t("1 mince");
  return tf(t(n <= 4 ? "{n} mince" : "{n} mincí"), { n });
}

// `total` > coins.length when the log kept only the first few (engine.ts,
// LOG_COIN_DETAIL_MAX).
function LoggedCoins({ coins, total }: { coins: readonly LoggedCoin[]; total: number }) {
  const { t, sats, when } = useFmt();
  const groups: [string, LoggedCoin[]][] = [
    [t("Spouštěč"), coins.filter((c) => c.role === "due")],
    [t("Přibrané"), coins.filter((c) => c.role === "companion")],
  ];
  return (
    <>
      {groups
        .filter(([, list]) => list.length > 0)
        .map(([title, list]) => (
          <div key={title} className="engine-coinlist">
            <div className="engine-coinlist-title">{title}</div>
            {list.map((c) => (
              <div key={c.id} className="engine-coin">
                <div className="engine-coin-main">
                  <strong>{sats(c.amountSats)}</strong>
                  <span className="muted">
                    {c.blocksLeft > 0 ? tf(t("vyprší {when}"), { when: when(c.blocksLeft) }) : t("vypršela")}
                  </span>
                </div>
                <div className="muted small">
                  {c.reasons.map((r) => t(REASON[r] ?? r)).join(" · ")} · {tf(t("hloubka {n}"), { n: c.exitDepth })}
                </div>
              </div>
            ))}
          </div>
        ))}
      {total > coins.length && (
        <p className="muted small">{tf(t("+ {n} dalších"), { n: total - coins.length })}</p>
      )}
    </>
  );
}

// One log entry: label, time, the numbers; the coins behind it on tap.
// Short outcome of a check (a "check" log entry's note).
const CHECK_OUTCOME: Record<string, string> = {
  idle: "nic k obnově",
  submitted: "odesláno",
  resubmitted: "odesláno znovu",
  "plan-changed": "plán se změnil",
  "dry-run": "zkušebně",
  "skip-foreign-pending": "čeká na jinou obnovu",
  "skip-unknown-round": "neznámý stav kola",
  "skip-uncertain": "ověřuje odeslání",
  "skip-breaker": "pojistka zastavena",
  "skip-backoff": "čeká po chybě",
  "skip-rate": "denní limit, čeká",
  "skip-network": "čeká na síť",
  partial: "zčásti",
  failed: "selhalo",
};

function CheckRow({ entry }: { entry: LogEntry }) {
  const { t, clock } = useFmt();
  const locale = localeFor(useLang());
  const count = entry.count ?? 1;
  const time = (at: number) => new Date(at).toLocaleTimeString(locale, { hour: "2-digit", minute: "2-digit" });
  const span = entry.until && entry.until !== entry.at ? `${clock(entry.at)}–${time(entry.until)}` : clock(entry.at);
  const outcome = entry.note ? t(CHECK_OUTCOME[entry.note] ?? entry.note) : "";
  return (
    <div className="engine-log-row">
      <div className="engine-log-head">
        <span>{count > 1 ? tf(t("Kontrola {n}×"), { n: count }) : t("Kontrola")}</span>
        <code>{span}</code>
      </div>
      {outcome && <p className="muted small">{outcome}</p>}
    </div>
  );
}

export function EngineLogRow({ entry }: { entry: LogEntry }) {
  if (entry.kind === "check") return <CheckRow entry={entry} />;
  return <EventLogRow entry={entry} />;
}

function EventLogRow({ entry }: { entry: LogEntry }) {
  const { t, sats, clock } = useFmt();
  const [open, setOpen] = useState(false);
  const parts: string[] = [];
  const coinCount = entry.coinCount ?? entry.ids?.length ?? 0;
  if (coinCount > 0) parts.push(coinsLabel(coinCount, t));
  if (entry.amountSats !== undefined) parts.push(sats(entry.amountSats));
  if (entry.feeSats !== undefined) parts.push(entry.feeSats === 0 ? t("zdarma") : tf(t("poplatek {fee}"), { fee: sats(entry.feeSats) }));
  if (entry.outputSats !== undefined && entry.kind !== "rejected") {
    parts.push(tf(t("nová {amount}"), { amount: sats(entry.outputSats) }));
  }
  const note = entry.note ? (NOTE[entry.note] ? t(NOTE[entry.note]) : null) : null;
  if (note) parts.push(note);
  const expandable = (entry.coins?.length ?? 0) > 0 || !!entry.error;
  return (
    <div className="engine-log-row">
      <button type="button" className="engine-log-head" onClick={() => expandable && setOpen((v) => !v)} disabled={!expandable}>
        <span>
          {t(LOG_TITLE[entry.kind])}
          {expandable ? (open ? " ▾" : " ▸") : ""}
        </span>
        <code>{clock(entry.at)}</code>
      </button>
      {parts.length > 0 && <p className="muted small">{parts.join(" · ")}</p>}
      {open && entry.coins && <LoggedCoins coins={entry.coins} total={coinCount} />}
      {open && entry.error && <p className="muted small engine-log-detail">{entry.error}</p>}
    </div>
  );
}
