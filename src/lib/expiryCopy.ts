// The words of the expiry nudge, in the app's language, left on the device for
// public/sw.js (same pattern as the exit hint, exitNudge.ts): the Worker sends
// only the stage and the price move, so it never needs to know the language.
// Keep the keys in step with sw.js and the stages in worker/mailboxShared.ts.
import { localeFor, getLang } from "./i18n";

const COPY_CACHE = "spendrr-expiry-copy";
const COPY_PATH = "/__expiry-copy";

export interface ExpiryCopy {
  lang: string;
  first: string;
  reminder: string;
  urgent: string;
  up: string;
  down: string;
}

export function expiryCopy(t: (s: string) => string, locale: string): ExpiryCopy {
  return {
    lang: locale,
    first: t("Mince čekají na obnovu. Otevři Spendrr."),
    reminder: t("Obnova mincí pořád čeká. Otevři Spendrr."),
    urgent: t("Mince brzy vyprší. Otevři Spendrr hned."),
    up: t("BTC mezitím vyrostl o {pct} % 📈."),
    down: t("BTC mezitím spadl o {pct} % 📉."),
  };
}

// Best-effort: without the Cache API the push keeps the Worker's Czech text.
export async function writeExpiryCopy(t: (s: string) => string): Promise<void> {
  try {
    if (typeof caches === "undefined") return;
    const cache = await caches.open(COPY_CACHE);
    await cache.put(
      COPY_PATH,
      new Response(JSON.stringify(expiryCopy(t, localeFor(getLang()))), { headers: { "content-type": "application/json" } }),
    );
  } catch {
    // Ignored.
  }
}
