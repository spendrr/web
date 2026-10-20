// Push reminders for a running unilateral exit, without telling the server it
// is one (decided with the user, 2026-09-27).
//
// Timing: the app reports a block height through the SAME field as the
// ordinary VTXO-expiry nudge (notifications.ts, firstExpiringVtxoBlockheight),
// so to the Worker it looks like a coin nearing expiry and it sends its usual
// generic push.
// Wording: sw.js doesn't show the Worker's generic text while an exit runs.
// It reads the hint this module leaves in the Cache API (same origin, no
// network) and shows what the app last knew: "Nouzový exit: mince jdou
// vyzvednout", and so on. The words never leave the device.
//
// What the server can still see: a height that moves forward about once an
// hour while an exit is getting on-chain, unlike a real expiry, which stays
// put. It does not see "exit", amounts or the step.
import { exitExpiryHeight, exitWakeHeight, type ExitOverview } from "./exitModel";

// Mirrors worker/mailboxShared.ts's EXPIRY_NUDGE_THRESHOLD_BLOCKS: the Worker
// sends the first nudge once the tip is within this many blocks of the
// reported height. Reporting wake + this makes the push land at `wake`. The
// Worker's reminder (144 blocks before the reported height) then comes ~16
// hours later and the urgent one (24 blocks before) ~36 hours later, if the
// earlier ones went unanswered.
const EXPIRY_NUDGE_LEAD_BLOCKS = 240;

// The height to report for the exit, or null when it needs nothing.
export function exitPushWatchHeight(o: ExitOverview): number | null {
  const wake = exitWakeHeight(o);
  const expiry = exitExpiryHeight(o);
  const candidates = [wake !== null ? wake + EXPIRY_NUDGE_LEAD_BLOCKS : null, expiry].filter(
    (h): h is number => h !== null && h > 0,
  );
  return candidates.length > 0 ? Math.min(...candidates) : null;
}

// Read by public/sw.js; keep the names in step with it.
const HINT_CACHE = "spendrr-exit-hint";
const HINT_PATH = "/__exit-hint";

export interface ExitNotificationHint {
  title: string;
  body: string;
  at: number;
}

export function exitNotificationHint(
  o: ExitOverview,
  feesMissing: boolean,
  t: (s: string) => string,
  now: number,
): ExitNotificationHint | null {
  if (!o.live) return null;
  let body: string;
  if (o.expiryRiskSats > 0) {
    body = t("Mince v exitu brzy vyprší. Otevři appku, ať se exit dostane na blockchain včas.");
  } else {
    switch (o.stage) {
      case "ready":
        body = t("Mince jsou připravené k vyzvednutí. Otevři appku a pošli je na svou adresu.");
        break;
      case "timelock":
        body = t("Časový zámek končí. Otevři appku a vyzvedni mince.");
        break;
      case "preparing":
      case "broadcasting":
        body = feesMissing
          ? t("Exit stojí: chybí on-chain na poplatky. Pošli je a otevři appku.")
          : t("Exit čeká na další krok na blockchainu. Mrkni do appky.");
        break;
      default:
        return null;
    }
  }
  return { title: t("Nouzový exit"), body, at: now };
}

// Best-effort: without the Cache API the push just keeps the generic text.
export async function writeExitNotificationHint(hint: ExitNotificationHint | null): Promise<void> {
  try {
    if (typeof caches === "undefined") return;
    if (hint === null) {
      await caches.delete(HINT_CACHE);
      return;
    }
    const cache = await caches.open(HINT_CACHE);
    await cache.put(HINT_PATH, new Response(JSON.stringify(hint), { headers: { "content-type": "application/json" } }));
  } catch {
    // Ignored.
  }
}
