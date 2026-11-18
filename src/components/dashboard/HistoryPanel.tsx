import {
  memo,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from "react";
import type { Movement } from "@secondts/bark";
import { type WalletClient } from "../../lib/wallet/bark";
import { isRefreshMovement } from "../../lib/maintenance/refreshHistory";
import { fetchBtcPriceHistory, fetchBtcRates, formatFiat, satsToFiat, type PriceRange } from "../../lib/price";
import { type FiatCurrency } from "../../lib/currency";
import { useMotionOn } from "../../lib/ui/motion";
import { localeFor, tf, useLang, useT, type Lang } from "../../lib/i18n";
import { formatAddressValue } from "../../lib/send/movementAddress";
import {
  withTimeout,
  WALLET_CALL_TIMEOUT_MS,
  TIMEOUT_MESSAGE,
} from "../../lib/wallet/walletCall";
import { useDesignVersion } from "../../lib/ui/designVersion";
import { Screen, Sheet, useSheetClose } from "../sheet/PaySheet";
import { amountScaleClass } from "../../lib/ui/amountScale";
import { useLnComment, type LnMovement } from "../../lib/names/lnComments";
import { useChatPayments, type ChatPaymentInfo } from "../../lib/chat/chatHistory";
import Avatar from "../Avatar";
import { NAME_DOMAIN } from "../../lib/names/handle";
import { nameForPayment } from "../../lib/names/namePins";
import {
  HistoryReceiveIcon,
  HistorySendIcon,
  HistoryIcon,
  CloseIcon,
  ClockIcon,
  StatusCheckIcon,
  HistoryIconRing,
  ConfirmCheckIcon,
} from "../dashboard/icons";
import { CopyRow } from "../dashboard/CopyRow";

/* ---------- History ---------- */

const KIND_NAMES: Record<string, string> = {
  receive: "Přijato",
  send: "Odesláno",
  send_onchain: "Odesláno on-chain",
  arkoor: "Ark platba",
  lightning: "Lightning",
  lightning_send: "Lightning platba",
  lightning_receive: "Lightning příjem",
  board: "Vklad na Ark",
  round: "Refresh",
  refresh: "Refresh",
  offboard: "Výstup na chain",
  exit: "Nouzový exit",
};

// Kinds titled by direction in the v2 detail. Board is how an on-chain
// receive reaches the balance ("Přijmout onchain platbu"), so it counts;
// offboard, exit and refresh move the user's own money and keep their name.
const PAYMENT_KINDS = new Set([
  "receive",
  "send",
  "send_onchain",
  "arkoor",
  "lightning",
  "lightning_send",
  "lightning_receive",
  "board",
]);

// The kind the history classifies a movement by. bark's subsystemKind is only
// unique within its subsystem: an exit is `bark.exit` / "start" (bark-0.7.0
// subsystem/mod.rs, ExitMovement::Exit), so it used to show as "start".
function movementKind(m: { subsystemName: string; subsystemKind: string }): string {
  if (m.subsystemName === "bark.exit") return "exit";
  return m.subsystemKind;
}

function historyKindName(kind: string, t: (cs: string) => string): string {
  const cs = KIND_NAMES[kind];
  return cs ? t(cs) : kind;
}

// Confirmed/pending only means anything for movements that actually involve
// a real on-chain broadcast — arkoor/Lightning/round/refresh settle
// off-chain, near-instantly, and have no comparable "waiting for
// confirmations" state a user would recognize. board is included alongside
// the obviously-onchain kinds because it's an on-chain funding tx too (the
// SDK's ArkInfo.feeSchedule carries requiredBoardConfirmations for exactly
// this wait).
const ONCHAIN_STATUS_KINDS = new Set(["send_onchain", "board", "offboard", "exit"]);

// Movement.status is a bare, undocumented `string` in the SDK's own
// .d.ts (same situation as metadataJson below). The three values here
// aren't documented anywhere either, but they're the only ones present as
// adjacent string constants in the WASM binary next to "Invalid
// MovementStatus: " — i.e. the Rust side's serde enum itself only ever
// produces one of these three, so defaulting anything else to "confirmed"
// isn't actually reachable in practice.
type OnchainStatusTone = "pending" | "confirmed" | "failed";

function onchainStatusTone(status: string): OnchainStatusTone {
  if (status === "pending") return "pending";
  if (status === "failed") return "failed";
  return "confirmed";
}

// Every other movement's status, which used to be shown as the SDK's raw
// English string ("successful"). bark-0.7.0 has exactly these four.
function movementStatusLabel(status: string, t: (cs: string) => string): string {
  if (status === "pending") return t("Probíhá");
  if (status === "successful") return t("Dokončeno");
  if (status === "failed") return t("Selhalo");
  if (status === "canceled") return t("Zrušeno");
  return status;
}

// The tone a history row shows. A failed or canceled movement of ANY kind is
// "failed": its effective balance change is 0, so without this a failed send
// reads as a green "+0 sats" receive. Pending/confirmed only exist for the
// on-chain kinds (ONCHAIN_STATUS_KINDS).
function movementRowTone(m: { subsystemName: string; subsystemKind: string; status: string }): OnchainStatusTone | null {
  if (m.status === "failed" || m.status === "canceled") return "failed";
  return ONCHAIN_STATUS_KINDS.has(movementKind(m)) ? onchainStatusTone(m.status) : null;
}

function onchainStatusLabel(tone: OnchainStatusTone, t: (cs: string) => string): string {
  if (tone === "pending") return t("Čeká na potvrzení");
  if (tone === "failed") return t("Selhalo");
  return t("Potvrzeno");
}

// Memoized so this doesn't redo its work (and its own `selected` detail
// modal doesn't get remounted) every time Dashboard re-renders for an
// unrelated reason (e.g. the syncing spinner toggling) — only when the
// `history` array reference actually changes, which fetchBalanceAndHistory
// now only does when the fetched data is actually different.
// Buckets a movement's createdAt into its local calendar day — used only by
// the grouped "Zobrazit vše" view (groupByDate), never the recent-activity
// list on the home screen, so each date's card matches what a person would
// call "today"/"yesterday" in their own timezone rather than UTC.
function dayBucketKey(d: Date): string {
  return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
}

// label is the bold left side of the day-card header, sub the lighter right
// side (next to the transaction count) — for Dnes/Včera, sub is the plain
// date; otherwise the date itself becomes the label and sub is the weekday.
function dayGroupHeader(d: Date, t: (cs: string) => string, lang: Lang): { label: string; sub: string } {
  const startOfDay = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const diffDays = Math.round((startOfDay(new Date()) - startOfDay(d)) / 86_400_000);
  const dateStr = d.toLocaleDateString(localeFor(lang), { day: "numeric", month: "numeric", year: "numeric" });
  if (diffDays === 0) return { label: t("Dnes"), sub: dateStr };
  if (diffDays === 1) return { label: t("Včera"), sub: dateStr };
  return { label: dateStr, sub: d.toLocaleDateString(localeFor(lang), { weekday: "long" }) };
}

const HISTORY_ROW_HANDLE_MAX = 5;

// Motion design: the home list staggers in only on the first history read of
// a page load, not every time Home is shown again.
let homeListStaggered = false;

export const HistoryPanel = memo(function HistoryPanel({
  history,
  currency,
  balanceHidden,
  wallet,
  groupByDate = false,
  stagger,
}: {
  history: Movement[];
  currency: FiatCurrency;
  balanceHidden: boolean;
  wallet: WalletClient;
  groupByDate?: boolean;
  // Motion design: the home list's rows come in one after another, once per
  // page load, when the first history read lands.
  stagger?: "first-load";
}) {
  const t = useT();
  const lang = useLang();
  const isBeta = useDesignVersion() === "v2";
  const [selected, setSelected] = useState<Movement | null>(null);
  const chatPayments = useChatPayments(history);
  const [flyingIds, setFlyingIds] = useState<Set<number>>(() => new Set());
  const seenIdsRef = useRef<Set<number>>(new Set());
  // history starts as [] before the first fetch resolves, so the first
  // *non-empty* history is still an initial load settling in, not a fresh
  // arrival — stays false until that happens, so nothing flies in on mount.
  const settledRef = useRef(false);

  useEffect(() => {
    if (!settledRef.current) {
      seenIdsRef.current = new Set(history.map((m) => m.id));
      if (history.length > 0) settledRef.current = true;
      return;
    }
    const freshlyArrived = history.filter((m) => !seenIdsRef.current.has(m.id)).map((m) => m.id);
    seenIdsRef.current = new Set(history.map((m) => m.id));
    if (freshlyArrived.length > 0) {
      setFlyingIds((prev) => new Set([...prev, ...freshlyArrived]));
    }
  }, [history]);

  // Plays the arrow -> checkmark (holds 2s) -> arrow flourish exactly once,
  // the moment a row's own onchain status flips pending -> confirmed while
  // this list is mounted — never on initial load (toneSettledRef mirrors
  // settledRef above) and never for a row that loads already confirmed.
  const [justConfirmedIds, setJustConfirmedIds] = useState<Set<number>>(() => new Set());
  const prevToneRef = useRef<Map<number, OnchainStatusTone | null>>(new Map());
  const toneSettledRef = useRef(false);

  useEffect(() => {
    const toneFor = (m: Movement): OnchainStatusTone | null => movementRowTone(m);

    if (!toneSettledRef.current) {
      prevToneRef.current = new Map(history.map((m) => [m.id, toneFor(m)]));
      if (history.length > 0) toneSettledRef.current = true;
      return;
    }
    const nextTones = new Map<number, OnchainStatusTone | null>();
    const newlyConfirmed: number[] = [];
    for (const m of history) {
      const tone = toneFor(m);
      if (prevToneRef.current.get(m.id) === "pending" && tone === "confirmed") {
        newlyConfirmed.push(m.id);
      }
      nextTones.set(m.id, tone);
    }
    prevToneRef.current = nextTones;
    if (newlyConfirmed.length > 0) {
      setJustConfirmedIds((prev) => new Set([...prev, ...newlyConfirmed]));
    }
  }, [history]);

  const motionOn = useMotionOn();
  const [staggering, setStaggering] = useState(false);
  const staggerCheckedRef = useRef(false);
  // Layout effect: the class has to be on before the rows' first paint, or
  // they flash in fully and then jump back to invisible.
  useLayoutEffect(() => {
    if (staggerCheckedRef.current || !stagger || !motionOn || history.length === 0) return;
    staggerCheckedRef.current = true;
    if (homeListStaggered) return;
    homeListStaggered = true;
    setStaggering(true);
  }, [stagger, motionOn, history.length]);
  // Dropped once played, so a row that arrives later gets its own fly-in only.
  useEffect(() => {
    if (!staggering) return;
    const timer = window.setTimeout(() => setStaggering(false), 1200);
    return () => window.clearTimeout(timer);
  }, [staggering]);

  // history arrives newest-first (see fetchBalanceAndHistory's ordering
  // comment) — bucketing in a single pass over it preserves that order
  // instead of re-sorting, so the day groups themselves stay newest-first too.
  const dayGroups = useMemo(() => {
    if (!groupByDate) return null;
    const groups: { key: string; label: string; sub: string; items: Movement[] }[] = [];
    const indexByKey = new Map<string, number>();
    for (const m of history) {
      const d = new Date(m.createdAt);
      const key = dayBucketKey(d);
      let idx = indexByKey.get(key);
      if (idx === undefined) {
        idx = groups.length;
        indexByKey.set(key, idx);
        const { label, sub } = dayGroupHeader(d, t, lang);
        groups.push({ key, label, sub, items: [] });
      }
      groups[idx].items.push(m);
    }
    return groups;
  }, [groupByDate, history, t, lang]);

  if (history.length === 0) {
    return (
      <div className="panel history-empty">
        <HistoryIcon />
        <p className="muted">{t("Zatím žádné transakce.")}</p>
      </div>
    );
  }
  // Shared per-movement row, used both by the flat list and inside a day
  // group — dateInHeader drops the date from the row's own timestamp (the
  // group header already shows it) and just leaves the time.
  let rowIndex = 0;
  const renderRow = (m: Movement, { dateInHeader }: { dateInHeader: boolean }) => {
    const staggerIndex = rowIndex++;
    const positive = m.effectiveBalanceSats >= 0;
    const flying = flyingIds.has(m.id);
    // Confirmed/pending only rendered for movements where it means
    // something (see ONCHAIN_STATUS_KINDS) — showing it on Ark/Lightning
    // rows would just be noise since those settle off-chain with nothing
    // resembling a confirmation wait.
    const statusTone = movementRowTone(m);
    const failed = statusTone === "failed";
    const canceled = m.status === "canceled";
    // The whole-row tint is for on-chain movements; a failed Ark/Lightning payment
    // is already marked by its cross, struck amount and tag.
    const tinted = statusTone && statusTone !== "confirmed" && ONCHAIN_STATUS_KINDS.has(movementKind(m));
    // A paid refresh still waiting for its round gets a "Probíhá" tag.
    const refreshPending = isRefreshMovement(m) && m.status === "pending";
    const justConfirmed = justConfirmedIds.has(m.id);
    // A failed movement moved nothing: show what was attempted, struck out, or
    // nothing when that is unknown.
    const attemptedSats = failed ? m.intendedBalanceSats : 0;
    const amountEl = balanceHidden ? (
      <div className="amount amount-dots">• • • •</div>
    ) : failed ? (
      attemptedSats !== 0 ? (
        <div className="amount amount-failed">
          {attemptedSats > 0 ? "+" : ""}
          {attemptedSats.toLocaleString(localeFor(lang))} sats
        </div>
      ) : null
    ) : (
      <div className={positive ? "amount positive" : "amount negative"}>
        {positive ? "+" : ""}
        {m.effectiveBalanceSats.toLocaleString(localeFor(lang))} sats
      </div>
    );
    const createdAt = new Date(m.createdAt);
    const timeLabel = dateInHeader
      ? createdAt.toLocaleTimeString(localeFor(lang), { hour: "2-digit", minute: "2-digit", second: "2-digit" })
      : createdAt.toLocaleString(localeFor(lang), {
          day: "numeric",
          month: "numeric",
          year: "numeric",
          hour: "2-digit",
          minute: "2-digit",
        });
    return (
      <button
        key={m.id}
        type="button"
        className={`history-item${tinted ? ` history-item--${statusTone}` : ""}`}
        style={staggering ? ({ "--i": staggerIndex } as CSSProperties) : undefined}
        onClick={() => setSelected(m)}
      >
        <div
          className={`history-icon ${positive && !failed ? "in" : "out"}${flying ? " fly-in" : ""}${justConfirmed ? " just-confirmed" : ""}`}
          onAnimationEnd={() =>
            setFlyingIds((prev) => {
              if (!prev.has(m.id)) return prev;
              const next = new Set(prev);
              next.delete(m.id);
              return next;
            })
          }
        >
          <span className="history-icon-arrow-layer">
            {failed ? <CloseIcon /> : positive ? <HistoryReceiveIcon /> : <HistorySendIcon />}
          </span>
          {statusTone && (
            <span className="history-icon-check-layer">
              <ConfirmCheckIcon
                onAnimationEnd={() =>
                  setJustConfirmedIds((prev) => {
                    if (!prev.has(m.id)) return prev;
                    const next = new Set(prev);
                    next.delete(m.id);
                    return next;
                  })
                }
              />
            </span>
          )}
          {statusTone && !failed && <HistoryIconRing tone={statusTone} />}
        </div>
        <div className="history-info">
          <div className="history-kind">
            {isRefreshMovement(m)
              ? t("Obnova mincí")
              : failed && PAYMENT_KINDS.has(movementKind(m))
                ? canceled
                  ? t("Platba zrušena")
                  : t("Platba selhala")
                : historyKindName(movementKind(m), t)}
            {!isRefreshMovement(m) && !LIGHTNING_KINDS.has(movementKind(m)) && !m.lightningInvoice && (() => {
              const n = (positive ? null : nameForPayment(m)) ?? (isBeta ? chatPayments.get(m.id)?.name : null) ?? null;
              // A long name would crowd the amount out of the row; the detail still shows it.
              return n && n.length <= HISTORY_ROW_HANDLE_MAX ? <span className="history-handle"> @{n}</span> : null;
            })()}
          </div>
          <div className="muted small history-sub">
            {isBeta && chatPayments.get(m.id)?.note && (
              <>
                <span className="history-note">{chatPayments.get(m.id)?.note}</span>
                {" · "}
              </>
            )}
            {timeLabel}
          </div>
        </div>
        {statusTone ? (
          <div className="history-amount-col">
            {amountEl}
            <span className={`onchain-status-tag onchain-status-tag--${statusTone}`}>
              {statusTone === "confirmed" && <StatusCheckIcon />}
              {statusTone === "pending" && <ClockIcon />}
              {statusTone === "failed" && <CloseIcon />}
              {canceled ? t("Zrušeno") : onchainStatusLabel(statusTone, t)}
            </span>
          </div>
        ) : refreshPending ? (
          <div className="history-amount-col">
            {amountEl}
            <span className="onchain-status-tag onchain-status-tag--pending">
              <ClockIcon />
              {t("Probíhá")}
            </span>
          </div>
        ) : (
          amountEl
        )}
      </button>
    );
  };

  // Home-screen recent-activity list (not groupByDate): wrap the pre-sliced
  // rows in ONE bordered box — same outer look as the grouped "Zobrazit vše"
  // view — but with no day-header and no per-row date (time only). The rows
  // keep the full standalone chunky-card size: the .history-home-bundle
  // rules deliberately do NOT shrink their padding the way
  // .history-day-group does.
  const mergedCard = !groupByDate;

  return (
    <div
      className={`panel history-list${dayGroups ? " history-list--grouped" : ""}${staggering ? " history-list--stagger" : ""}`}
    >
      {dayGroups ? (
        dayGroups.map((g) => (
          <div className="history-day-group" key={g.key}>
            <div className="history-day-header">
              <span className="history-day-label">{g.label}</span>
              <span className="history-day-count">
                {g.sub} · {tf(t("{n} transakce"), { n: g.items.length })}
              </span>
            </div>
            {g.items.map((m) => renderRow(m, { dateInHeader: true }))}
          </div>
        ))
      ) : mergedCard ? (
        <div className="history-home-bundle">
          {history.map((m) => renderRow(m, { dateInHeader: true }))}
        </div>
      ) : (
        history.map((m) => renderRow(m, { dateInHeader: false }))
      )}
      {selected && (
        <TxDetailModal
          movement={selected}
          currency={currency}
          balanceHidden={balanceHidden}
          wallet={wallet}
          chatInfo={chatPayments.get(selected.id)}
          history={history}
          onClose={() => setSelected(null)}
        />
      )}
    </div>
  );
});

// Lightning movements settle through internal Ark VTXOs, not a real
// on-chain/Ark counterparty address — sentToAddresses/receivedOnAddresses
// for these kinds hold that internal plumbing, not anything meaningful to
// show the user (the Faktura/Payment hash rows already cover it). Checking
// subsystemKind alone isn't enough — a payment made to a Lightning address
// or LNURL can come back with a kind outside this set (e.g. "arkoor") while
// still carrying the invoice in sentToAddresses, duplicating the Faktura
// row with the same value under "Adresa" too. Whether m.lightningInvoice is
// populated is the more reliable signal, so it's checked alongside the kind.
// An incoming Ark receive with no Lightning hash of its own: how a payment to
// the wallet's Lightning address reaches it (docs/ln-address-plan.md, flow).
function isLnAddressCandidate(m: Movement): boolean {
  const kind = movementKind(m);
  return (
    m.effectiveBalanceSats > 0 && (kind === "arkoor" || kind === "receive") && !m.paymentHash && !m.lightningInvoice && !isRefreshMovement(m)
  );
}

function lnMovementOf(m: Movement): LnMovement {
  return { id: m.id, sats: m.effectiveBalanceSats, atMs: new Date(m.completedAt ?? m.createdAt).getTime() };
}

const LIGHTNING_KINDS = new Set(["lightning", "lightning_send", "lightning_receive"]);

// Best-effort, decorative context, not a precise accounting figure — finds
// the closest point in a price-history series (range picked below by the
// movement's age) to when the movement happened and compares it to the
// series' own most recent point (rather than a separate live rates() call,
// so both sides come from the same CoinGecko series and can't disagree due
// to timing/source differences). Null whenever there's nothing useful to
// show: still loading, the fetch failed, or the movement predates the
// oldest point the chosen range actually has (more than a day past the
// edge, so a movement from yesterday doesn't get compared against a much
// older price just because that happened to be the closest sample).
// `undefined` while still loading, so the v2 sheet can hold the row's place
// instead of it popping in late; `null` once there is nothing to show.
// `then` is the price at the payment (the same closest point), which the v2
// sheet uses to show what the payment was worth at the time.
type BtcSincePayment = { pct: number; then: number };

function useBtcSincePayment(txTimeMs: number, currency: FiatCurrency): BtcSincePayment | null | undefined {
  const [pct, setPct] = useState<BtcSincePayment | null | undefined>(undefined);
  useEffect(() => {
    let cancelled = false;
    setPct(undefined);
    // Pick the shortest range that still comfortably covers the transaction,
    // not always "1y" — CoinGecko only returns daily buckets above 90 days
    // (see price.ts's RANGE_DAYS/interval comment), so for a payment from the
    // last few hours the "closest" and "latest" daily points collapse into
    // the same day and the comparison is either ~0% or not ready in time.
    // 7d/3m stay inside CoinGecko's <=90-day auto-hourly bucketing, giving a
    // real nearby comparison point instead. Thresholds sit a few days inside
    // each range's edge so a payment doesn't land right at the boundary
    // where the oldest-point guard below could reject it.
    const ageMs = Date.now() - txTimeMs;
    const range: PriceRange = ageMs < 6 * 24 * 60 * 60 * 1000 ? "7d" : ageMs < 80 * 24 * 60 * 60 * 1000 ? "3m" : "1y";
    fetchBtcPriceHistory(currency, range)
      .then((points) => {
        if (cancelled) return;
        const oldest = points[0];
        if (!oldest || txTimeMs < oldest.t - 24 * 60 * 60 * 1000) return setPct(null);
        let closest = points[0];
        for (const p of points) {
          if (Math.abs(p.t - txTimeMs) < Math.abs(closest.t - txTimeMs)) closest = p;
        }
        const latest = points[points.length - 1];
        if (closest.v <= 0) return setPct(null);
        setPct({ pct: ((latest.v - closest.v) / closest.v) * 100, then: closest.v });
      })
      .catch(() => {
        // Best-effort — just don't show the badge.
        if (!cancelled) setPct(null);
      });
    return () => {
      cancelled = true;
    };
  }, [txTimeMs, currency]);
  return pct;
}

// Movement.metadataJson is undocumented by the SDK (bare `string` in
// bark_ffi_wasm.d.ts, one opaque shape per subsystem) and unparsed anywhere
// else in this app. Rather than committing to one exact field name we can't
// verify against a real mainnet Movement, this tries every plausible key
// name found in the WASM binary's own Rust struct field strings
// (offboard_txid for send-onchain, funding_txid for board/incoming, plus
// generic fallbacks) and only returns a value that's actually
// txid-shaped (64 hex chars) — so a wrong/missing key just means nothing
// shows, never a wrong or garbage value labeled as a txid.
const ONCHAIN_TXID_KEYS = ["offboard_txid", "funding_txid", "broadcast_txid", "exit_txid", "txid"];

function extractOnchainTxid(metadataJson: string): string | null {
  try {
    const data: unknown = JSON.parse(metadataJson);
    if (typeof data !== "object" || data === null) return null;
    for (const key of ONCHAIN_TXID_KEYS) {
      const value = (data as Record<string, unknown>)[key];
      if (typeof value === "string" && /^[0-9a-f]{64}$/i.test(value)) return value;
    }
  } catch {
    // Not JSON, or a shape this doesn't recognize — degrade silently.
  }
  return null;
}

// Movement (from wallet.history()) carries no block height, confirmation
// count, or on-chain fee — those live in a different subsystem entirely
// (wallet.onchainWallet, the BDK-backed sub-wallet), keyed by txid rather
// than by movement id. This looks up the matching WalletTransaction (via the
// txid recovered from metadataJson) to fill that gap for onchain-kind
// movements (board/send_onchain/offboard/exit) — same data Settings →
// "Onchain transakce" already shows, just surfaced where a user actually
// looks for it. Scoped to onchain-kind movements like the rest of
// ONCHAIN_STATUS_KINDS handling.
// `undefined` while looking, `null` when this wallet's own on-chain history
// doesn't have the transaction (an on-chain send is built by the Ark server,
// so it usually isn't there) or the lookup failed.
type OnchainTxDetail = { inBlock: boolean; confirmations: number | null; onchainFeeSats: number | undefined };

function useOnchainTxDetail(
  wallet: WalletClient,
  txid: string | null,
  enabled: boolean,
): OnchainTxDetail | null | undefined {
  const active = enabled && txid !== null;
  const [detail, setDetail] = useState<OnchainTxDetail | null | undefined>(active ? undefined : null);
  useEffect(() => {
    setDetail(active ? undefined : null);
    if (!active) return;
    let cancelled = false;
    (async () => {
      try {
        const [txs, tip] = await Promise.all([
          withTimeout(wallet.onchainWallet.transactions(), WALLET_CALL_TIMEOUT_MS, TIMEOUT_MESSAGE),
          withTimeout(wallet.onchainWallet.tipHeight(), WALLET_CALL_TIMEOUT_MS, TIMEOUT_MESSAGE).catch(() => null),
        ]);
        if (cancelled) return;
        const tx = txs.find((candidate) => candidate.txid === txid);
        if (!tx) return setDetail(null);
        const confirmations = tx.confirmation && tip !== null ? Math.max(1, tip - tx.confirmation.height + 1) : null;
        setDetail({ inBlock: !!tx.confirmation, confirmations, onchainFeeSats: tx.onchainFeeSats });
      } catch {
        // Best-effort diagnostic detail — just don't show it.
        if (!cancelled) setDetail(null);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [wallet, txid, active]);
  return detail;
}

// A payment opened from its chat bubble: the same detail, with what the chat
// knows about it worked out against the whole history.
export function ChatTxDetail({ history, ...props }: Parameters<typeof TxDetailModal>[0] & { history: readonly Movement[] }) {
  const chatPayments = useChatPayments(history);
  return <TxDetailModal {...props} history={history} chatInfo={chatPayments.get(props.movement.id)} />;
}

function TxDetailModal({
  movement: m,
  currency,
  balanceHidden,
  wallet,
  chatInfo,
  history,
  onClose,
}: {
  movement: Movement;
  currency: FiatCurrency;
  balanceHidden: boolean;
  wallet: WalletClient;
  chatInfo?: ChatPaymentInfo;
  history?: readonly Movement[];
  onClose: () => void;
}) {
  const t = useT();
  const lang = useLang();
  const isBeta = useDesignVersion() === "v2";
  // A failed or canceled movement moved nothing (effective change 0), so its
  // direction is the attempted one, as in the history row.
  const failed = m.status === "failed" || m.status === "canceled";
  const positive = (failed ? m.intendedBalanceSats : m.effectiveBalanceSats) >= 0;
  // A message the payer attached to a Lightning-address payment (beta). That
  // payment arrives as a plain Ark receive, so it is found by amount and time
  // among the incoming ones, and asked once per movement.
  const lnCandidates = useMemo(() => (history ?? []).filter(isLnAddressCandidate).map(lnMovementOf), [history]);
  const lnComment = useLnComment(wallet, isBeta && isLnAddressCandidate(m) ? lnMovementOf(m) : undefined, lnCandidates);
  const noAddresses = LIGHTNING_KINDS.has(movementKind(m)) || !!m.lightningInvoice;
  const sentTo = noAddresses ? [] : m.sentToAddresses;
  // This wallet's own address, not the sender's.
  const receivedOn = noAddresses ? [] : m.receivedOnAddresses;
  const txTimeMs = new Date(m.completedAt ?? m.createdAt).getTime();
  const sincePayment = useBtcSincePayment(txTimeMs, currency);
  const btcChangePct = sincePayment === undefined ? undefined : (sincePayment?.pct ?? null);
  const onchainTxid = extractOnchainTxid(m.metadataJson);
  const isOnchainKind = ONCHAIN_STATUS_KINDS.has(movementKind(m));
  const onchainDetail = useOnchainTxDetail(wallet, onchainTxid, isOnchainKind);
  // A payment is titled by its direction (PAYMENT_KINDS).
  const isPayment = PAYMENT_KINDS.has(movementKind(m)) && !isRefreshMovement(m);
  const title =
    isRefreshMovement(m)
      ? t("Obnova mincí")
      : isPayment
        ? failed
          ? m.status === "canceled"
            ? t("Platba zrušena")
            : t("Platba selhala")
          : positive
            ? t("Příchozí platba")
            : t("Odchozí platba")
        : historyKindName(movementKind(m), t);
  // What the status row may honestly claim about an on-chain movement. The
  // SDK calling it "successful" doesn't say whether the transaction is in a
  // block, so "Potvrzeno" is only shown when this wallet's own on-chain
  // history confirms it. A send the Ark server built isn't in that history:
  // it reads "Odesláno", which is all that is known.
  const onchainTone = onchainStatusTone(m.status);
  const statusCell = (() => {
    if (!isOnchainKind) return <code>{movementStatusLabel(m.status, t)}</code>;
    if (onchainTone !== "confirmed") return <code>{onchainStatusLabel(onchainTone, t)}</code>;
    if (onchainDetail === undefined) return <span className="txd-skeleton" aria-label={t("Načítám…")} />;
    if (onchainDetail === null) {
      return <code>{m.effectiveBalanceSats < 0 ? t("Odesláno") : movementStatusLabel(m.status, t)}</code>;
    }
    if (!onchainDetail.inBlock) return <code>{onchainStatusLabel("pending", t)}</code>;
    if (onchainDetail.confirmations !== null) {
      return (
        <code>{tf(t("{n} potvrzení"), { n: onchainDetail.confirmations.toLocaleString(localeFor(lang)) })}</code>
      );
    }
    return <code>{onchainStatusLabel("confirmed", t)}</code>;
  })();
  const summary = (
    <div className="confirm-summary">
      <div className="info-row">
        <span>{t("Stav")}</span>
        {statusCell}
      </div>
      {m.offchainFeeSats > 0 ? (
        <div className="info-row">
          <span>{t("Poplatek")}</span>
          <strong>{m.offchainFeeSats.toLocaleString(localeFor(lang))} sats</strong>
        </div>
      ) : (
        isOnchainKind &&
        onchainDetail?.onchainFeeSats !== undefined && (
          <div className="info-row">
            <span>{t("Poplatek")}</span>
            <strong>{onchainDetail.onchainFeeSats.toLocaleString(localeFor(lang))} sats</strong>
          </div>
        )
      )}
      {/* An arkoor payment is instant and a Lightning one usually settles
          within seconds, so both times would read the same. Its subsystem is
          "bark.arkoor", the kind is just send/receive. */}
      {!(
        m.completedAt &&
        (m.subsystemName === "bark.arkoor" ||
          m.subsystemKind === "arkoor" ||
          Math.abs(new Date(m.completedAt).getTime() - new Date(m.createdAt).getTime()) < 60_000)
      ) && (
        <div className="info-row">
          <span>{t("Vytvořeno")}</span>
          <strong>{new Date(m.createdAt).toLocaleString(localeFor(lang))}</strong>
        </div>
      )}
      {m.completedAt && (
        <div className="info-row">
          <span>{t("Dokončeno")}</span>
          <strong>{new Date(m.completedAt).toLocaleString(localeFor(lang))}</strong>
        </div>
      )}
      {!balanceHidden && !failed && btcChangePct !== null && (
        <div className="info-row">
          <span>{t("Cena BTC od té doby")}</span>
          {btcChangePct === undefined ? (
            <span className="txd-skeleton" aria-label={t("Načítám…")} />
          ) : (
            <strong className={`txd-value-in ${btcChangePct >= 0 ? "txd-up" : "txd-down"}`}>
              {btcChangePct >= 0 ? "+" : "\u2212"}
              {Math.abs(btcChangePct).toLocaleString(localeFor(lang), {
                minimumFractionDigits: 1,
                maximumFractionDigits: 1,
              })}
              {" %"}
            </strong>
          )}
        </div>
      )}
      {(() => {
        const n = m.effectiveBalanceSats < 0 ? nameForPayment(m) : null;
        if (!n) return null;
        // The avatar is a checksum of the address, so it is drawn from where the
        // money actually went, never from what the name points at today.
        const paidTo = m.sentToAddresses.map(formatAddressValue).find((a) => /^t?ark1/i.test(a));
        return (
          <div className="info-row">
            <span>{t("Příjemce")}</span>
            <span className="recipient-chip">
              {paidTo && <Avatar seed={paidTo} size={32} />}
              <strong className="recipient-chip-name">
                {n}
                <span className="recipient-chip-domain">@{NAME_DOMAIN}</span>
              </strong>
            </span>
          </div>
        );
      })()}
      {isBeta && positive && chatInfo?.name && (
        <div className="info-row">
          <span>{t("Odesílatel")}</span>
          <strong>@{chatInfo.name}</strong>
        </div>
      )}
      {isBeta && chatInfo?.note && (
        <div className="info-row txd-note-row">
          <span>{t("Zpráva")}</span>
          <strong className="txd-note">{chatInfo.note}</strong>
        </div>
      )}
      {isBeta && !chatInfo?.note && lnComment && (
        <div className="info-row txd-note-row">
          <span>{t("Zpráva")}</span>
          <strong className="txd-note">{lnComment}</strong>
        </div>
      )}
      {sentTo.map((addr, i) => (
        <CopyRow key={`s${i}`} label={t("Adresa")} value={formatAddressValue(addr)} />
      ))}
      {receivedOn.map((addr, i) => (
        <CopyRow key={`r${i}`} label={t("Přijato na")} value={formatAddressValue(addr)} />
      ))}
      {m.paymentHash && <CopyRow label="Payment hash" value={m.paymentHash} />}
      {m.lightningInvoice && <CopyRow label={t("Faktura")} value={m.lightningInvoice} />}
      {onchainTxid && <CopyRow label="Txid" value={onchainTxid} />}
    </div>
  );
  return (
    <TxDetailSheet
      movement={m}
      title={title}
      currency={currency}
      balanceHidden={balanceHidden}
      sincePayment={sincePayment}
      summary={summary}
      onClose={onClose}
    />
  );
}

// The payment detail in the shared sheet. The amount is the headline;
// everything else sits in the card under it.
function TxDetailSheet({
  movement: m,
  title,
  currency,
  balanceHidden,
  sincePayment,
  summary,
  onClose,
}: {
  movement: Movement;
  title: string;
  currency: FiatCurrency;
  balanceHidden: boolean;
  sincePayment: BtcSincePayment | null | undefined;
  summary: ReactNode;
  onClose: () => void;
}) {
  const t = useT();
  const lang = useLang();
  const { closing, closeThen } = useSheetClose();
  const close = () => closeThen(onClose);
  const [rate, setRate] = useState<number | null>(null);
  useEffect(() => {
    let cancelled = false;
    fetchBtcRates()
      .then((r) => {
        if (!cancelled) setRate(r[currency]);
      })
      .catch(() => {
        // Best-effort, the fiat line just stays hidden.
      });
    return () => {
      cancelled = true;
    };
  }, [currency]);
  const failed = m.status === "failed" || m.status === "canceled";
  // A failed movement moved nothing: the headline is what was attempted, struck out.
  const sats = failed ? m.intendedBalanceSats : m.effectiveBalanceSats;
  const sign = sats > 0 ? "+" : sats < 0 ? "\u2212" : "";
  // Worth at the time of the payment when the price history has it, else
  // today's value, and the line says which: under a historical amount a bare
  // "≈ 224 Kč" reads as what it was worth then.
  const fiat =
    sats === 0 || failed || sincePayment === undefined
      ? null
      : sincePayment !== null
        ? { text: formatFiat(satsToFiat(Math.abs(sats), sincePayment.then), currency), note: t("v době platby") }
        : rate !== null
          ? { text: formatFiat(satsToFiat(Math.abs(sats), rate), currency), note: t("dnes") }
          : null;
  return (
    <Sheet closing={closing} onBackdrop={close} screenKey="tx">
      <Screen>
        <h2 className="txd-kind">{title}</h2>
        {balanceHidden ? (
          <div className="balance-value balance-dots txd-dots">• • • • • •</div>
        ) : (
          <div className="txd-hero">
            <div className={`txd-amount ${failed ? "txd-amount--failed" : sats >= 0 ? "txd-amount--in" : "txd-amount--out"}${amountScaleClass(sats)}`}>
              <span className="txd-amount-num">
                {sign}
                {Math.abs(sats).toLocaleString(localeFor(lang))}
              </span>
              <span className="txd-amount-unit">sats</span>
            </div>
            {sats !== 0 && !failed && (
              <div className="balance-fiat txd-fiat">
                {fiat !== null && (
                  <span className="txd-value-in">
                    ≈ {fiat.text} <span className="txd-fiat-note">{fiat.note}</span>
                  </span>
                )}
              </div>
            )}
          </div>
        )}
        <div className="txd-card">{summary}</div>
        <button type="button" className="secondary sht-wide" onClick={close}>
          {t("Zavřít")}
        </button>
      </Screen>
    </Sheet>
  );
}
