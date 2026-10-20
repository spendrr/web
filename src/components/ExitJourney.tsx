// Where the money is on its way out of Ark, as one picture: Ark ->
// blockchain -> timelock -> your address, with a coin that moves when the
// exit really moves (exitModel.ts's stage), never on a timer. Pure CSS
// motion (ExitSheet.css), off under prefers-reduced-motion.
import { useT } from "../lib/i18n";
import { BTC_PATH } from "./BitcoinMark";
import type { ExitStage } from "../lib/exit/exitModel";

// 0: at Ark (nothing started), 1: on its way to the blockchain, 2: in the
// timelock, 3: on its way to your address, 4: arrived.
export type JourneyStep = 0 | 1 | 2 | 3 | 4;

export function journeyStepFor(stage: ExitStage): JourneyStep {
  switch (stage) {
    case "preparing":
    case "broadcasting":
      return 1;
    case "timelock":
    case "ready":
      return 2;
    case "claiming":
      return 3;
    case "done":
      return 4;
    default:
      return 0;
  }
}

// Coin position along the track, in % of its width.
const COIN_AT: Record<JourneyStep, number> = { 0: 0, 1: 16.67, 2: 66.67, 3: 83.33, 4: 100 };

export default function ExitJourney({ step, idle = false, ready = false }: { step: JourneyStep; idle?: boolean; ready?: boolean }) {
  const t = useT();
  const stations = [t("Ark"), t("Blockchain"), t("Zámek"), t("Tvoje adresa")];
  // Which station the coin has reached (or passed).
  const reached = step === 0 ? 0 : step === 1 ? 0 : step === 2 ? 2 : step === 3 ? 2 : 3;
  const moving = step === 1 || step === 3;
  return (
    <div
      className={`ex-journey ex-journey--step${step}${idle ? " is-idle" : ""}${ready ? " is-ready" : ""}`}
      style={{ ["--ex-coin" as string]: `${COIN_AT[step]}%` }}
      aria-hidden="true"
    >
      <div className="ex-track">
        <div className="ex-track-done" />
        {moving && <div className={`ex-track-flow ex-track-flow--seg${step === 1 ? 0 : 2}`} />}
        {stations.map((_, i) => (
          <span key={i} className={`ex-station${i <= reached ? " is-reached" : ""}`} style={{ left: `${(i / 3) * 100}%` }} />
        ))}
        <span className={`ex-coin${moving ? " is-moving" : ""}${step === 2 ? " is-locked" : ""}${step === 4 ? " is-home" : ""}`}>
          <svg viewBox="-0.5 -0.5 25 25">
            <path d={BTC_PATH} />
          </svg>
          {step === 2 && <span className="ex-coin-ring" />}
        </span>
      </div>
      <div className="ex-labels">
        {stations.map((label, i) => (
          <span key={label} className={i <= reached ? "is-reached" : undefined} style={{ left: `${(i / 3) * 100}%` }}>
            {label}
          </span>
        ))}
      </div>
    </div>
  );
}
