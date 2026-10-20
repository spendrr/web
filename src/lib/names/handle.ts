// Pure helpers for @handles ("jména"): what a valid one looks like, and the
// deterministic suggestion a wallet starts with.
//
// Rules are deliberately narrow. Ascii only, no diacritics: characters like
// "a" and the Cyrillic look-alike make spoofed names that read identically to
// a real one, and for a payment destination that is a phishing surface, not a
// nicety. The charset also stays inside what a Lightning address local part
// (LUD-16) allows, so a handle can become "name@spendrr.app" later without
// anyone being renamed.

export const HANDLE_MIN_LENGTH = 3;
export const HANDLE_MAX_LENGTH = 20;

const HANDLE_CHARS = /^[a-z0-9_-]+$/;
const HANDLE_EDGE = /^[a-z0-9](.*[a-z0-9])?$/;

// Not claimable by anyone, unless the Worker is configured to give a specific
// name to a specific mailbox (RESERVED_NAME_OWNERS, see worker/names.ts). Four
// kinds: names that speak for the project, names of the ecosystem, names that
// would be used to pose as somebody else's service, and words that are only
// trouble in a payment field.
//
// A name already registered before it landed here keeps working: the registry
// looks the record up first, so reserving is never a takedown. Taking a name
// away is the admin tool's job.
const RESERVED = new Set([
  // the project and its roles
  "spendrr", "spendr", "official", "team", "staff", "mod", "moderator", "admin", "administrator", "root",
  "system", "support", "help", "helpdesk", "security", "abuse", "contact", "info", "hello", "noreply",
  "postmaster", "webmaster", "billing", "payment", "payments", "pay", "dev", "developer", "api", "app",
  "www", "mail", "status", "news", "blog", "docs", "legal", "privacy", "terms", "press", "sales", "service",
  "feedback", "bugs", "test", "testing", "wallet",
  // the app's own features and partners
  "donate", "gift", "shop", "store", "voucher", "bitrefill",
  // the ecosystem
  "ark", "arkade", "arklabs", "ark-labs", "second", "bark", "bitcoin", "btc", "satoshi", "nakamoto",
  "lightning", "ln", "lnurl", "onchain", "bank", "exchange",
  // posing as other services
  "binance", "coinbase", "kraken", "bitfinex", "trezor", "ledger", "blockstream", "mempool", "strike",
  "cashapp", "paypal", "revolut", "stripe", "google", "apple", "microsoft", "amazon", "telegram", "whatsapp",
  "signal", "csob", "moneta", "fio", "airbank", "raiffeisen",
  // only trouble in a payment field
  "null", "undefined", "anonymous", "unknown", "nobody",
]);

export function isReservedName(name: string): boolean {
  return RESERVED.has(name);
}

export type HandleProblem = "empty" | "too-short" | "too-long" | "chars" | "edge" | "reserved";

export type HandleCheck = { ok: true; handle: string } | { ok: false; problem: HandleProblem };

// Accepts what a person might type: a leading "@" and any casing.
export function normalizeHandle(raw: string): string {
  return raw.trim().replace(/^@/, "").toLowerCase();
}

// `allowReserved` skips only the reserved-name rule, everything else still
// applies. The server uses it to decide for itself whether the mailbox asking
// is the configured owner; the profile screen uses it so the owner is not
// stopped before the request even leaves the phone.
export function checkHandle(raw: string, options: { allowReserved?: boolean } = {}): HandleCheck {
  const handle = normalizeHandle(raw);
  if (handle.length === 0) return { ok: false, problem: "empty" };
  if (handle.length < HANDLE_MIN_LENGTH) return { ok: false, problem: "too-short" };
  if (handle.length > HANDLE_MAX_LENGTH) return { ok: false, problem: "too-long" };
  if (!HANDLE_CHARS.test(handle)) return { ok: false, problem: "chars" };
  if (!HANDLE_EDGE.test(handle)) return { ok: false, problem: "edge" };
  if (!options.allowReserved && RESERVED.has(handle)) return { ok: false, problem: "reserved" };
  return { ok: true, handle };
}

// Suggested handles are "<adjective>-<noun>", both picked from short hand-made
// lists, so no random pairing can come out offensive and neither word needs a
// grammatical gender. The nouns are round, edible and harmless; the adjectives
// are mild and positive. "anonymous" is one of the adjectives on purpose: it is
// what the first handles were called (anonymous-pea) and it still reads well.
//
// Length budget: the longest adjective (10, "mysterious") + "-" + the longest
// noun (5) plus a "-123" suffix is exactly 20, the limit. There is no slack
// left: a longer adjective or noun has to shorten another word, and the tests
// enforce it.
export const SUGGESTION_ADJECTIVES = [
  "anonymous",
  "mysterious",
  "quiet",
  "brave",
  "calm",
  "clever",
  "cosmic",
  "cozy",
  "crisp",
  "curious",
  "eager",
  "fancy",
  "fuzzy",
  "gentle",
  "golden",
  "happy",
  "jolly",
  "lucky",
  "mellow",
  "mighty",
  "nimble",
  "noble",
  "plucky",
  "proud",
  "rapid",
  "shiny",
  "silent",
  "sleepy",
  "smooth",
  "snappy",
  "steady",
  "sunny",
  "swift",
  "tiny",
  "witty",
  "zesty",
  "bold",
  "breezy",
  "chill",
  "merry",
  "spry",
] as const;

export const SUGGESTION_NOUNS = [
  "pea",
  "bean",
  "nut",
  "seed",
  "plum",
  "fig",
  "oat",
  "rye",
  "corn",
  "kale",
  "leek",
  "lime",
  "yam",
  "kiwi",
  "date",
  "pear",
  "okra",
  "sage",
  "mint",
  "basil",
  "chive",
  "apple",
  "berry",
  "melon",
  "lemon",
  "olive",
  "peach",
  "mango",
  "onion",
  "grape",
  "thyme",
  "clove",
  "beet",
  "taro",
  "pecan",
] as const;

// Same idea as avatar.ts: display-grade hashing, not a security primitive.
function hash(seed: string): number {
  let h = 2166136261;
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  h ^= h >>> 15;
  h = Math.imul(h, 2246822507);
  h ^= h >>> 13;
  return h >>> 0;
}

// The first attempts differ in the words themselves ("quiet-fig", then
// "golden-plum", ...); only after that does a three-digit suffix appear. A busy
// bare name is far nicer than one with a number on it, so the numbers are the
// last resort, not the first reaction to a collision. Everything is derived from
// the seed, so the same wallet always proposes the same sequence.
export const SUGGESTION_BARE_ATTEMPTS = 3;

export function suggestHandle(seed: string, attempt = 0): string {
  const n = Math.max(0, Math.floor(attempt));
  const adjective = SUGGESTION_ADJECTIVES[hash(`${seed}|adjective|${n}`) % SUGGESTION_ADJECTIVES.length];
  const noun = SUGGESTION_NOUNS[hash(`${seed}|noun|${n}`) % SUGGESTION_NOUNS.length];
  if (n < SUGGESTION_BARE_ATTEMPTS) return `${adjective}-${noun}`;
  const digits = String(hash(`${seed}|digits|${n}`) % 1000).padStart(3, "0");
  return `${adjective}-${noun}-${digits}`;
}

// What the QR encodes. A normal web link, so a phone without Spendrr lands on
// a page instead of dead-ending, and Spendrr's own scanner can recognise it.
export function handleUrl(origin: string, handle: string): string {
  return `${origin}/@${handle}`;
}

// The domain a handle becomes a Lightning address at ("pavel@spendrr.app").
// Fixed, not the page's own host: that is the address that works for a payer,
// whatever origin (dev, a preview) the app happens to be running on.
export const NAME_DOMAIN = "spendrr.app";

// What a person can type into the send field to pay a handle: "@pavel" or
// "pavel@spendrr.app". Returns the lowercased name, or null when the text is
// neither form. Deliberately loose about the name itself (only "no whitespace,
// no @"): a bad name is answered by the registry lookup, not silently treated
// as some other kind of destination, which is what "x@spendrr.app" would
// otherwise fall into (a Lightning address at a domain that has no LNURL).
const HANDLE_DESTINATION = /^(?:@([^\s@]+)|([^\s@]+)@spendrr\.app)$/i;

export function parseHandleDestination(input: string): string | null {
  const m = HANDLE_DESTINATION.exec(input.trim());
  if (!m) return null;
  return (m[1] ?? m[2]).toLowerCase();
}

// A scanned QR of a profile link ("https://spendrr.app/@pavel"). Accepted from
// this app's own origin (dev, previews) or the real domain, never an arbitrary
// site, and only the exact "/@name" path with nothing after it.
export function handleFromProfileUrl(raw: string, ownOrigin: string): string | null {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    return null;
  }
  if (url.origin !== ownOrigin && url.origin !== "https://spendrr.app") return null;
  if (url.search !== "" || url.hash !== "") return null;
  const m = /^\/@([^/\s@]+)$/.exec(url.pathname);
  return m ? m[1].toLowerCase() : null;
}

// The path of a profile link: "/@pavel" (a trailing slash is fine). Read by
// App.tsx before the screen machine boots, like the gift and request paths.
// The name is lowercased but not validated here: the registry lookup answers
// for a bad one, and the page says so.
//
// The "@" also arrives percent-encoded: Cloudflare's asset layer redirects
// "/@name" to "/%40name" (found on a local `wrangler dev`, 2026-09-21), so the
// path this reads at boot is usually the encoded one.
export function handleFromPath(pathname: string): string | null {
  const m = /^\/(?:@|%40)([^/\s@%]+(?:%[0-9a-f]{2}[^/\s@%]*)*)\/?$/i.exec(pathname);
  if (!m) return null;
  try {
    const name = decodeURIComponent(m[1]).toLowerCase();
    // An escape must not smuggle back in what the pattern above kept out.
    return /[/\s@]/.test(name) ? null : name;
  } catch {
    return null;
  }
}
