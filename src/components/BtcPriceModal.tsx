import { useEffect, useId, useMemo, useRef, useState } from "react";
import { btcRatesUpdatedAt, fetchBtcPriceHistory, fetchBtcRates, formatFiat, type PriceRange, type PricePoint } from "../lib/price";
import type { FiatCurrency } from "../lib/currency";
import { tf, useT } from "../lib/i18n";
import { BTC_PATH } from "./BitcoinMark";
import { Screen, Sheet, useSheetClose } from "./sheet/PaySheet";

const CHART_WIDTH = 300;
const CHART_HEIGHT = 90;
// Headroom above the high and below the low, in viewBox units, so their
// labels fit inside the chart.
const CHART_PAD_Y = 22;
// Just past fetchBtcRates' own 60s cache: at exactly 60s the refresh can land
// a few ms before the cached rate expires and get the old one back.
const LIVE_PRICE_MS = 65_000;

const RANGES: { key: PriceRange; label: string }[] = [
  { key: "1d", label: "24h" },
  { key: "7d", label: "7d" },
  { key: "30d", label: "30d" },
  { key: "3m", label: "3m" },
  { key: "1y", label: "1r" },
];

function buildChart(points: PricePoint[]): { line: string; area: string; coords: (readonly [number, number])[] } {
  const values = points.map((p) => p.v);
  const min = Math.min(...values);
  const max = Math.max(...values);
  const range = max - min || 1;
  const coords = points.map((p, i) => {
    const x = (i / (points.length - 1)) * CHART_WIDTH;
    const y = CHART_HEIGHT - CHART_PAD_Y - ((p.v - min) / range) * (CHART_HEIGHT - CHART_PAD_Y * 2);
    return [x, y] as const;
  });
  const line = coords.map(([x, y], i) => `${i === 0 ? "M" : "L"}${x.toFixed(1)},${y.toFixed(1)}`).join(" ");
  const area = `${line} L${CHART_WIDTH},${CHART_HEIGHT} L0,${CHART_HEIGHT} Z`;
  return { line, area, coords };
}

// Short form for the chart's high/low labels: "1,82 mil. Kč", "72,3 tis. €".
function formatFiatCompact(amount: number, currency: FiatCurrency): string {
  return new Intl.NumberFormat("cs-CZ", {
    style: "currency",
    currency: currency.toUpperCase(),
    currencyDisplay: "narrowSymbol",
    notation: "compact",
    maximumFractionDigits: amount >= 1_000_000 ? 2 : 1,
  }).format(amount);
}

// Full date+time for 1d/7d (5-minute and hourly points), calendar date
// otherwise — matches the granularity CoinGecko actually returns per range.
function formatScrubDate(t: number, range: PriceRange): string {
  const d = new Date(t);
  if (range === "1d" || range === "7d") {
    return d.toLocaleString("cs-CZ", { day: "numeric", month: "numeric", hour: "2-digit", minute: "2-digit" });
  }
  return d.toLocaleDateString("cs-CZ", { day: "numeric", month: "long", year: range === "1y" ? "numeric" : undefined });
}

interface Props {
  currency: FiatCurrency;
  onClose: () => void;
}

// The price in the shared bottom sheet (PaySheet.tsx). The original centered
// modal it replaced was the v1 look until 2026-09-24.
export default function BtcPriceModal(props: Props) {
  return <PriceSheet {...props} />;
}

// Fetching, the chart geometry and the press-and-drag scrub.
//
// The scrub cursor follows the finger every frame. The line and dot are plain
// HTML overlays moved by `transform` straight from the pointer handler (one
// write per animation frame, no React render), and the dot glides along the
// curve between data points. React only re-renders when the nearest data
// point changes, which updates the price (RollingNumber) and the date.
function usePriceWidget(currency: FiatCurrency) {
  const t = useT();
  // For the gradient fill; useId's colons aren't safe inside url(#…).
  const gradId = `btc-grad-${useId().replace(/[^a-zA-Z0-9_-]/g, "")}`;
  const [range, setRange] = useState<PriceRange>("30d");
  const [price, setPrice] = useState<number | null>(null);
  const [priceError, setPriceError] = useState<string | null>(null);
  const [priceRetryTick, setPriceRetryTick] = useState(0);
  const [history, setHistory] = useState<PricePoint[] | null>(null);
  const [chartError, setChartError] = useState<string | null>(null);
  const [retryTick, setRetryTick] = useState(0);
  const [scrubIndex, setScrubIndex] = useState<number | null>(null);
  // Cached at drag start rather than re-measured on every pointermove:
  // getBoundingClientRect() forces a layout reflow, and calling it on each
  // move event (potentially dozens per second while dragging) was what made
  // the price readout visibly stutter instead of tracking the finger smoothly.
  const scrubRectRef = useRef<DOMRect | null>(null);
  const cursorLineRef = useRef<HTMLSpanElement | null>(null);
  const cursorDotRef = useRef<HTMLSpanElement | null>(null);
  const frameRef = useRef<number | null>(null);
  const latestXRef = useRef(0);
  const committedIndexRef = useRef<number | null>(null);
  useEffect(() => {
    return () => {
      if (frameRef.current !== null) cancelAnimationFrame(frameRef.current);
    };
  }, []);

  // Kept separate from the chart's history fetch below — the rate doesn't
  // depend on the selected range, so re-fetching it on every range switch
  // just burns extra calls against CoinGecko's free-tier rate limit for no
  // reason (and once that limit trips, its error responses drop CORS
  // headers, which shows up in the browser as an opaque "Failed to fetch").
  useEffect(() => {
    let cancelled = false;
    setPriceError(null);
    fetchBtcRates()
      .then((rates) => {
        if (!cancelled) setPrice(rates[currency]);
      })
      .catch((e) => {
        // Never surface e.message: CoinGecko's 429 response carries no CORS
        // headers, so a plain rate limit shows up here as the browser's own
        // opaque "Failed to fetch" TypeError, not a readable HTTP error.
        console.error("fetchBtcRates failed:", e);
        if (!cancelled) setPriceError(t("Cenu se nepodařilo načíst."));
      });
    return () => {
      cancelled = true;
    };
  }, [currency, priceRetryTick, t]);

  // Keep the price live while the sheet is open. A
  // change rolls in through RollingNumber like any other. fetchBtcRates
  // caches for 60s itself, so this is at most one request a minute, and none
  // while the tab is hidden. A failed refresh keeps the last price quietly.
  useEffect(() => {
    const id = window.setInterval(() => {
      if (document.hidden) return;
      fetchBtcRates()
        .then((rates) => setPrice(rates[currency]))
        .catch((e) => console.error("fetchBtcRates refresh failed:", e));
    }, LIVE_PRICE_MS);
    return () => window.clearInterval(id);
  }, [currency]);

  // A failed range switch must not clobber an already-loaded price/chart —
  // it only clears them for retriable *fetch* errors, not merely "still
  // loading", so the modal doesn't flash empty while the new range loads.
  useEffect(() => {
    let cancelled = false;
    setChartError(null);
    setScrubIndex(null);
    fetchBtcPriceHistory(currency, range)
      .then((points) => {
        if (!cancelled) setHistory(points);
      })
      .catch((e) => {
        if (cancelled) return;
        console.error("fetchBtcPriceHistory failed:", e);
        setChartError(t("Historii ceny se nepodařilo načíst."));
        setHistory(null);
      });
    return () => {
      cancelled = true;
    };
  }, [currency, range, retryTick, t]);

  const changePct =
    history && history.length > 1 ? ((history[history.length - 1].v - history[0].v) / history[0].v) * 100 : null;
  const isUp = changePct !== null && changePct >= 0;
  // Memoized: scrubbing re-renders on every new nearest point, and
  // rebuilding up to 400-point path strings each time is wasted work.
  const chart = useMemo(() => (history && history.length > 1 ? buildChart(history) : null), [history]);
  // Where the range's high and low sit, for their labels.
  const extremes = useMemo(() => {
    if (!history || history.length < 2) return null;
    let lo = 0;
    let hi = 0;
    history.forEach((p, i) => {
      if (p.v < history[lo].v) lo = i;
      if (p.v > history[hi].v) hi = i;
    });
    return { lo, hi };
  }, [history]);

  const scrubPoint = scrubIndex !== null && history ? history[scrubIndex] : null;

  // Scrubbing: press/drag the chart to see the price + date at a specific
  // point. Pointer events cover mouse and touch in one code path;
  // capturing the pointer keeps the drag tracking even if the finger slides
  // past the chart's own bounds.

  // Puts the cursor exactly under the finger (y interpolated
  // between the two neighbouring points) and commits the nearest index only
  // if it changed.
  function placeCursor(clientX: number) {
    const rect = scrubRectRef.current;
    if (!rect || !chart || !history) return;
    const fraction = rect.width > 0 ? Math.min(1, Math.max(0, (clientX - rect.left) / rect.width)) : 0;
    const pos = fraction * (chart.coords.length - 1);
    const i = Math.min(chart.coords.length - 2, Math.floor(pos));
    const yView = chart.coords[i][1] + (chart.coords[i + 1][1] - chart.coords[i][1]) * (pos - i);
    const x = fraction * rect.width;
    const y = (yView / CHART_HEIGHT) * rect.height;
    if (cursorLineRef.current) cursorLineRef.current.style.transform = `translateX(${x}px)`;
    if (cursorDotRef.current) cursorDotRef.current.style.transform = `translate(${x}px, ${y}px)`;
    const index = Math.round(pos);
    if (index !== committedIndexRef.current) {
      committedIndexRef.current = index;
      setScrubIndex(index);
    }
  }

  function handleChartPointerDown(e: React.PointerEvent<HTMLDivElement>) {
    if (!history || history.length < 2) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    const rect = e.currentTarget.getBoundingClientRect();
    scrubRectRef.current = rect;
    committedIndexRef.current = null;
    placeCursor(e.clientX);
  }

  function handleChartPointerMove(e: React.PointerEvent<HTMLDivElement>) {
    if (scrubIndex === null || !history || !scrubRectRef.current) return;
    // Several pointermoves can land in one frame; only the last matters.
    latestXRef.current = e.clientX;
    if (frameRef.current === null) {
      frameRef.current = requestAnimationFrame(() => {
        frameRef.current = null;
        placeCursor(latestXRef.current);
      });
    }
  }

  function handleChartPointerEnd() {
    if (frameRef.current !== null) {
      cancelAnimationFrame(frameRef.current);
      frameRef.current = null;
    }
    committedIndexRef.current = null;
    setScrubIndex(null);
    scrubRectRef.current = null;
  }

  const chartArea = (
    <div className="btc-price-chart-wrap is-smooth">
      {chartError ? (
        <button type="button" className="btc-price-chart-retry" onClick={() => setRetryTick((n) => n + 1)}>
          {t("Graf se nepodařilo načíst. Zkusit znovu.")}
        </button>
      ) : chart ? (
        <div
          className="btc-price-chart-frame scrubbable"
          key={range}
          onPointerDown={handleChartPointerDown}
          onPointerMove={handleChartPointerMove}
          onPointerUp={handleChartPointerEnd}
          onPointerCancel={handleChartPointerEnd}
          onPointerLeave={handleChartPointerEnd}
        >
          <svg className="btc-price-chart" viewBox={`0 0 ${CHART_WIDTH} ${CHART_HEIGHT}`} preserveAspectRatio="none">
            <defs>
              <linearGradient id={gradId} x1="0" y1="0" x2="0" y2="1">
                <stop offset="0" className={`btc-grad-stop ${isUp ? "up" : "down"}`} stopOpacity="0.28" />
                <stop offset="1" className={`btc-grad-stop ${isUp ? "up" : "down"}`} stopOpacity="0" />
              </linearGradient>
            </defs>
            {/* The fill fades out downward, so the bottom of the chart
                (where the low label and the time axis sit) stays clean. Inline
                style so it beats the class's solid fill. */}
            <path
              d={chart.area}
              className={`btc-price-area is-grad ${isUp ? "up" : "down"}`}
              style={{ fill: `url(#${gradId})` }}
            />
            <path d={chart.line} className={`btc-price-line ${isUp ? "up" : "down"}`} fill="none" />
          </svg>
          <span className="btc-price-chart-wipe" />
        </div>
      ) : (
        <span className="btc-price-chart-skeleton" aria-label={t("Načítám graf")} />
      )}
      {/* High/low labels at their points. HTML, not SVG text, which the
          stretched viewBox would distort. The translateX by the point's own
          fraction keeps a label at the chart's edge inside it. */}
      {chart && history && extremes && !chartError && (
        <div className="btc-chart-marks" key={`marks-${range}`} aria-hidden="true">
          {(["hi", "lo"] as const).map((which) => {
            const i = extremes[which];
            const [x, y] = chart.coords[i];
            const f = x / CHART_WIDTH;
            return (
              <span
                key={which}
                className={`btc-chart-mark btc-chart-mark--${which}`}
                style={{
                  left: `${f * 100}%`,
                  top: `${(y / CHART_HEIGHT) * 100}%`,
                  transform: `translate(${-f * 100}%, ${which === "hi" ? "calc(-100% - 8px)" : "12px"})`,
                }}
              >
                {formatFiatCompact(history[i].v, currency)}
              </span>
            );
          })}
        </div>
      )}
      {/* Outside the frame so the dot isn't clipped by its overflow:hidden
          at the chart's top/bottom edge. */}
      {chart && !chartError && (
        <div className={`btc-scrub-cursor${scrubIndex !== null ? " is-on" : ""}`} aria-hidden="true">
          <span className="btc-scrub-cursor-line" ref={cursorLineRef} />
          <span className={`btc-scrub-cursor-dot ${isUp ? "up" : "down"}`} ref={cursorDotRef} />
        </div>
      )}
    </div>
  );

  // When the chart starts, and that it ends now.
  const timeAxis =
    history && history.length > 1 && !chartError ? (
      <div className="btc-chart-axis" aria-hidden="true">
        <span>
          {range === "1d"
            ? new Date(history[0].t).toLocaleTimeString("cs-CZ", { hour: "2-digit", minute: "2-digit" })
            : new Date(history[0].t).toLocaleDateString("cs-CZ", {
                day: "numeric",
                month: "numeric",
                year: range === "1y" ? "numeric" : undefined,
              })}
        </span>
        <span>{range === "1d" ? t("teď") : t("dnes")}</span>
      </div>
    ) : null;

  // Segmented control: one accent thumb that slides to the chosen range
  // (transform only), instead of each button repainting its own background.
  const rangeIndex = RANGES.findIndex((r) => r.key === range);
  const rangeToggle = (
    <div
      className="btc-range"
      role="group"
      style={{ ["--n" as string]: RANGES.length, ["--i" as string]: rangeIndex }}
    >
      <span className="btc-range-thumb" aria-hidden="true" />
      {RANGES.map((r) => (
        <button
          key={r.key}
          type="button"
          className={r.key === range ? "is-active" : ""}
          aria-pressed={r.key === range}
          onClick={() => setRange(r.key)}
        >
          {t(r.label)}
        </button>
      ))}
    </div>
  );

  return {
    range,
    price,
    priceError,
    retryPrice: () => setPriceRetryTick((n) => n + 1),
    history,
    changePct,
    isUp,
    scrubPoint,
    chartArea,
    timeAxis,
    rangeToggle,
  };
}

function PriceSheet({ currency, onClose }: Props) {
  const t = useT();
  const { closing, closeThen } = useSheetClose();
  const w = usePriceWidget(currency);
  const close = () => closeThen(onClose);

  // A live refresh that moved the price: briefly tint the digits that
  // changed (green up, red down). Adjusted during render (React's "state
  // from a changed prop" pattern), not in an effect. Skipped mid-scrub, when
  // the number on screen is a historical one. The changed positions are
  // fixed here, so digits a later scrub changes never start the tint.
  const [flash, setFlash] = useState<Flash | null>(null);
  const [prevPrice, setPrevPrice] = useState(w.price);
  if (w.price !== prevPrice) {
    setPrevPrice(w.price);
    if (prevPrice !== null && w.price !== null && !w.scrubPoint) {
      const positions = changedPositions(formatFiat(prevPrice, currency), formatFiat(w.price, currency));
      if (positions.size > 0) {
        setFlash({ dir: w.price > prevPrice ? "up" : "down", positions, id: (flash?.id ?? 0) + 1 });
      }
    }
  }

  // "CoinGecko, před 3 min": the source (CoinGecko's API terms require
  // attributing it near the data) and how old the price really is, by
  // CoinGecko's own timestamp, so the Worker's edge cache (up to 6 min) and
  // ours count too. Re-rendered once a second.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, []);
  const updatedAt = btcRatesUpdatedAt();
  const freshness = (() => {
    if (updatedAt === null) return null;
    const secs = Math.max(0, Math.round((now - updatedAt) / 1000));
    if (secs < 10) return t("právě teď");
    if (secs < 60) return tf(t("před {n} s"), { n: secs });
    return tf(t("před {n} min"), { n: Math.floor(secs / 60) });
  })();

  // Scrubbing: how the price moved from that point to now.
  const sincePct = w.scrubPoint && w.price !== null ? ((w.price - w.scrubPoint.v) / w.scrubPoint.v) * 100 : null;

  return (
    <Sheet closing={closing} onBackdrop={close} screenKey="price">
      <Screen>
        <h2 className="sht-title btc-sheet-title">
          <BitcoinLogo />
          Bitcoin
        </h2>
        {w.priceError ? (
          <button type="button" className="btc-price-chart-retry btc-sheet-error" onClick={w.retryPrice}>
            {t("Cenu se nepodařilo načíst.")} {t("Zkusit znovu")}
          </button>
        ) : w.price === null ? (
          <span className="balance-skeleton" aria-label={t("Načítám cenu")} />
        ) : (
          <>
            <div className="btc-sheet-price">
              <RollingNumber
                className="btc-price-value"
                text={formatFiat(w.scrubPoint?.v ?? w.price, currency)}
                flash={flash}
              />
              {w.scrubPoint ? (
                <div className="btc-price-change btc-price-scrub-date">
                  {formatScrubDate(w.scrubPoint.t, w.range)}
                  {sincePct !== null && (
                    <>
                      {" · "}
                      <span className={`amount ${sincePct >= 0 ? "positive" : "negative"}`}>
                        {sincePct >= 0 ? "▲" : "▼"} {Math.abs(sincePct).toFixed(1).replace(".", ",")} % {t("od té doby")}
                      </span>
                    </>
                  )}
                </div>
              ) : (
                <div className="btc-price-change">
                  {w.changePct !== null ? (
                    <span className={`amount ${w.isUp ? "positive" : "negative"}`}>
                      {w.isUp ? "▲" : "▼"} {Math.abs(w.changePct).toFixed(1).replace(".", ",")} %
                    </span>
                  ) : (
                    "\u00a0"
                  )}
                  {w.changePct !== null && (
                    <span className="btc-sheet-fresh">
                      <span className="btc-sheet-dot" aria-hidden="true">
                        ·
                      </span>
                      <a href="https://www.coingecko.com" target="_blank" rel="noopener noreferrer">
                        CoinGecko
                      </a>
                      {freshness && `, ${freshness}`}
                    </span>
                  )}
                </div>
              )}
            </div>
            <div className="btc-sheet-chart">
              {w.chartArea}
              {w.timeAxis}
            </div>
            {w.rangeToggle}
          </>
        )}
        <button type="button" className="secondary sht-wide" onClick={close}>
          {t("Zavřít")}
        </button>
      </Screen>
    </Sheet>
  );
}

// The price as an odometer: every digit is a 0-9 strip in a one-digit
// window, and a new value just moves each strip (a CSS transform
// transition). The number is always the exact value at once; only the
// digits' motion takes time, and a change arriving mid-motion retargets it
// smoothly instead of queueing behind it, so fast scrubbing reads as fluid
// rather than lagging or flickering. Positions are keyed from the right, so
// units stay units when the length changes. Nothing remounts per value: in
// the old V1 modal (removed 2026-09-24) a key-based remount + CSS animation
// left stacked "ghost" copies of the price on fast drags.
//
// `flash` tints the given positions (counted from the right, like the keys)
// once per id. The animation name alternates between two identical
// keyframes so a second flash on the same digit restarts it without a
// remount, which would drop the strip's transition.
interface Flash {
  dir: "up" | "down";
  positions: Set<number>;
  id: number;
}

// Right-aligned positions (1 = last character) where two strings differ.
function changedPositions(a: string, b: string): Set<number> {
  const out = new Set<number>();
  const len = Math.max(a.length, b.length);
  for (let k = 1; k <= len; k++) {
    if (a[a.length - k] !== b[b.length - k]) out.add(k);
  }
  return out;
}

function RollingNumber({ text, className, flash }: { text: string; className?: string; flash?: Flash | null }) {
  const chars = [...text];
  return (
    <div className={`${className ?? ""} odo`} aria-label={text} role="img">
      {chars.map((c, i) => {
        const key = chars.length - i;
        if (c < "0" || c > "9") {
          return (
            <span key={`s${key}`} aria-hidden="true">
              {c}
            </span>
          );
        }
        return (
          <span
            key={`d${key}`}
            className="odo-col"
            aria-hidden="true"
            style={
              flash?.positions.has(key)
                ? { animationName: `odo-flash-${flash.dir}-${flash.id % 2 ? "a" : "b"}` }
                : undefined
            }
          >
            <span className="odo-strip" style={{ transform: `translateY(${-Number(c) * 10}%)` }}>
              {DIGITS.map((d) => (
                <span key={d}>{d}</span>
              ))}
            </span>
          </span>
        );
      })}
    </div>
  );
}

const DIGITS = ["0", "1", "2", "3", "4", "5", "6", "7", "8", "9"];

// The official mark: orange disc, white B. BTC_PATH is the disc with the B
// cut out, so filling it and laying a white disc underneath shows the B
// white on any sheet background.
function BitcoinLogo() {
  return (
    <svg className="btc-sheet-logo" viewBox="-1.3 -1.3 26.6 26.6" aria-hidden="true">
      <circle cx="12" cy="12" r="10" fill="#fff" />
      <path d={BTC_PATH} fill="#f7931a" />
    </svg>
  );
}
