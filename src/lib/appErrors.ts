// One place that turns a thrown error into what the user reads. The SDK's own
// errors are English and technical ("bad user input: vtxo … is not
// spendable", gRPC dumps); showing those verbatim was the norm across the app.
//
// describeError() returns a Czech sentence for errors it recognises, and for
// everything else a generic one plus the raw text, which the toast offers
// behind a small "copy" button so it can still reach a bug report.
//
// The patterns are matched against strings actually present in the shipped
// @secondts/bark 0.23.0 WASM (`strings bark_ffi_wasm_bg.wasm`), not guessed.
// An SDK upgrade can reword them; an unmatched error then just falls back to
// the generic text with the raw one copyable, never to something wrong.
import { __I18N_DICT, localeFor, tf, type Lang } from "./i18n";
import { isWalletCallTimeout } from "./wallet/walletCall";

export interface DescribedError {
  text: string;
  // Raw message for the copy button. Only set when `text` is the generic
  // fallback: a recognised error already says what happened.
  raw: string | null;
}

type T = (cs: string) => string;

interface KnownError {
  test: RegExp;
  text: (m: RegExpMatchArray, t: T, lang: Lang) => string;
}

const btcToSats = (btc: string) => Math.round(Number(btc) * 1e8);

// Order matters: the first match wins, so narrower patterns come first.
const KNOWN: KnownError[] = [
  {
    test: /exceeds limit of ([\d.]+)\s*BTC/i,
    text: (m, t, lang) =>
      tf(t("Nad limitem pro Lightning (max {limitSats} sats)."), {
        limitSats: btcToSats(m[1]).toLocaleString(localeFor(lang)),
      }),
  },
  {
    test: /minimum board amount required by server \(([\d.]+) BTC\)/i,
    text: (m, t, lang) =>
      tf(t("Částka je pod minimem pro přesun do Ark ({min} sats). Počkej, až on-chain zůstatek naroste, a zkus to znovu."), {
        min: btcToSats(m[1]).toLocaleString(localeFor(lang)),
      }),
  },
  {
    test: /insufficient confirmed funds|more confirmations on your on-chain funds/i,
    text: (_m, t) => t("On-chain prostředky ještě nemají dost potvrzení. Zkus to později."),
  },
  {
    test: /insufficient (money|funds)|insufficientfunds|not enough money|inputs only amount to/i,
    text: (_m, t) => t("Nemáš dost prostředků (včetně poplatku)."),
  },
  {
    test: /fee \(.*\) exceeds amount|feeexceedsamount/i,
    text: (_m, t) => t("Poplatek by byl vyšší než samotná částka."),
  },
  {
    test: /below (the )?dust|dust limit|amountafterfeebelowdust/i,
    text: (_m, t) => t("Částka je příliš malá."),
  },
  {
    test: /invoice has already been paid/i,
    text: (_m, t) => t("Tahle faktura už je zaplacená."),
  },
  {
    test: /payment operation already in progress/i,
    text: (_m, t) => t("Platba téhle faktury už probíhá. Počkej na výsledek v historii."),
  },
  {
    test: /cannot pay invoice for 0 sats/i,
    text: (_m, t) => t("Faktura je na 0 sats, takovou zaplatit nejde."),
  },
  {
    test: /invoice.*expired|expired.*invoice/i,
    text: (_m, t) => t("Faktura už vypršela. Požádej o novou."),
  },
  {
    test: /invoiceamountmismatch/i,
    text: (_m, t) => t("Částka nesedí s částkou ve faktuře."),
  },
  {
    test: /wrong network|different network|networkmismatch/i,
    text: (_m, t) => t("Adresa nebo faktura je pro jinou bitcoinovou síť."),
  },
  {
    test: /different server|servermismatch/i,
    text: (_m, t) => t("Tahle Ark adresa patří k jinému Ark serveru."),
  },
  {
    test: /invalidlightningaddress/i,
    text: (_m, t) => t("Neplatná Lightning adresa."),
  },
  {
    test: /invalidlnurl/i,
    text: (_m, t) => t("Neplatný LNURL odkaz."),
  },
  {
    test: /invalidinvoice|invalid amount in hrp|bolt11|malformedhrp/i,
    text: (_m, t) => t("Neplatná faktura. Zkontroluj, že je celá."),
  },
  {
    test: /not spendable|already spent|must be refreshed|exit depth/i,
    text: (_m, t) => t("Některé tvoje mince (VTXO) nejsou aktuální. Počkej chvíli, až se data obnoví, a zkus to znovu."),
  },
  {
    test: /could not start lightning send|no route|route not found|routenotfound/i,
    text: (_m, t) => t("Lightning platbu se nepodařilo doručit. Zkus to později nebo s menší částkou."),
  },
  {
    test: /clienttooold|protocolversionmismatch/i,
    text: (_m, t) => t("Aplikace je zastaralá. Obnov stránku."),
  },
  {
    test: /failed to connect|communicating with the server|failed to fetch|networkerror|load failed|transport error|unavailable|timed out|connection (refused|reset|closed)/i,
    text: (_m, t) => t("Nepodařilo se připojit. Zkontroluj internet a zkus to znovu."),
  },
];

// Czech letters that don't occur in English: an error carrying them was
// written by this app (a Czech sentence thrown on purpose), not by the SDK.
const CZECH_LETTERS = /[ěščřžýáíéůúťďňĚŠČŘŽÝÁÍÉŮÚŤĎŇ]/;
const APP_KEYS = new Set(Object.keys(__I18N_DICT));
const APP_VALUES = new Set(Object.values(__I18N_DICT));

export function rawErrorMessage(e: unknown): string {
  if (e instanceof Error) return e.message;
  if (typeof e === "string") return e;
  try {
    return String(e);
  } catch {
    return "";
  }
}

export function describeError(e: unknown, t: T, lang: Lang): DescribedError {
  if (isWalletCallTimeout(e)) {
    return { text: t("Peněženka neodpovídá. Zkus to za chvíli znovu."), raw: null };
  }
  const raw = rawErrorMessage(e).trim();
  // Already a user-facing app message (a Czech key, or Czech text built with
  // tf()): translate if it's a key, pass through otherwise. Checked before
  // KNOWN so our own sentences are never rewritten by a pattern that happens
  // to match a word in them.
  if (APP_KEYS.has(raw)) return { text: t(raw), raw: null };
  if (CZECH_LETTERS.test(raw)) return { text: raw, raw: null };
  for (const known of KNOWN) {
    const m = raw.match(known.test);
    if (m) return { text: known.text(m, t, lang), raw: null };
  }
  // An English translation of an app message (thrown while the UI is in
  // English). After KNOWN, not before: some are worded exactly like the
  // SDK's own errors ("Insufficient funds").
  if (APP_VALUES.has(raw)) return { text: raw, raw: null };
  return { text: t("Něco se nepovedlo."), raw: raw || null };
}

// --- Error toast channel -----------------------------------------------------
//
// Errors come from all over (Settings, gift modals, the Utility hub) while the
// toast lives in Dashboard; a tiny event channel spares threading a callback
// through every component. Dashboard subscribes for as long as it's mounted.

export type ErrorToastEvent = { type: "show"; error: unknown } | { type: "dismiss" };
type Listener = (event: ErrorToastEvent) => void;
const listeners = new Set<Listener>();

export function onErrorToast(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

// Shows `e` as an error toast. False when nothing is listening (no Dashboard
// mounted), so the caller can fall back to showing it itself.
export function reportError(e: unknown): boolean {
  if (listeners.size === 0) return false;
  listeners.forEach((l) => l({ type: "show", error: e }));
  return true;
}

// Hides the current error toast early, e.g. once the user starts correcting
// the input that caused it. Leaves a payment toast alone.
export function dismissErrorToast(): void {
  listeners.forEach((l) => l({ type: "dismiss" }));
}

// The error goes to the island toast and the inline slot is cleared. With no
// Dashboard mounted to show a toast, it stays inline: `fallbackText` when the
// caller had its own (a translated or fallback message), the raw text
// otherwise.
export function surfaceError(e: unknown, setInline: (message: string | null) => void, fallbackText?: string): void {
  if (reportError(e)) {
    setInline(null);
    return;
  }
  setInline(fallbackText ?? rawErrorMessage(e));
}
