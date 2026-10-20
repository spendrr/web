// Pure classification/parsing for Send destinations — split out of Dashboard.tsx
// so this logic can be unit/fuzz tested without dragging in the whole
// component tree (camera access, WASM wallet handle, etc).
//
// NO imports from network.ts / bitcoinAddress.ts / lnurl.ts here, on purpose:
// worker/lnLedger.ts (the Cloudflare Worker) imports this file, and the
// Worker is bundled by wrangler, which does not know Vite's `__NETWORK__`
// define. Anything network-aware lives in destinationCheck.ts.

// A "lightning:" URI-scheme prefix is legitimate input — QR codes and wallet
// links both carry it, and a user can paste one straight into the field.
// classifyStatic() has always stripped it *internally*, but every other
// consumer saw the still-prefixed string, and that split was a real hole:
// decodeBolt11Amount()'s anchored /^ln.../ regex returned null for
// "lightning:lnbc10m1…", so a 1,000,000-sat invoice read as "amount unknown"
// — which skipped the large-send password re-check entirely, showed no
// amount on the confirm screen, and shortened its arm delay. Normalize once,
// at the point the destination is read, so classification, the decoded
// amount, and the string handed to the SDK can never disagree again.
//
// Also here, for the same reason: a leading "₿" (the BIP 353 spelling of a
// payment address, "₿user@domain") is dropped, and a string that is entirely
// upper case and starts like a bech32 destination is lowered. QR codes for
// bech32 use the upper-case alphabet (it packs denser), BIP173 allows it, but
// nothing downstream should have to know that. Base58 addresses are never
// touched: they are case sensitive, and none of them starts with these
// prefixes.
const UPPER_BECH32_START = /^(?:LNBC|LNTB|LNO1|LNURL|ARK1|TARK1|BC1|TB1)/;

export function normalizeDestination(input: string): string {
  let v = input.trim();
  if (v.toLowerCase().startsWith("lightning:")) v = v.slice("lightning:".length).trim();
  if (v.startsWith("\u20bf")) v = v.slice(1).trim();
  if (v === v.toUpperCase() && UPPER_BECH32_START.test(v)) v = v.toLowerCase();
  return v;
}

// BOLT11 invoices encode their amount (when they have one — some are
// amountless, letting the payer choose) directly in the human-readable
// prefix, before the "1" separator: ln + network + [digits][multiplier].
// bech32's alphabet deliberately excludes the digit "1", so it can never
// appear in the data part that follows — the first "1" is unambiguously the
// separator, no need to decode the rest of the invoice to find it.
const BOLT11_AMOUNT_RE = /^ln(?:bc|tb|bcrt)(\d+)?([munp])?1/;
const BOLT11_MULTIPLIER_DIVISOR: Record<string, number> = { m: 1_000, u: 1_000_000, n: 1_000_000_000, p: 1_000_000_000_000 };

// Returns the invoice's embedded amount in sats, or null if it's amountless
// or not a recognizable BOLT11 invoice. Display-only — never used to
// override what's actually sent (the SDK decodes the real invoice itself).
export function decodeBolt11Amount(invoice: string): number | null {
  // normalizeDestination, not a bare trim(): the regex below is anchored at
  // ^ln, so a "lightning:"-prefixed invoice would otherwise silently decode
  // to null — see normalizeDestination's own comment for what that cost.
  const match = normalizeDestination(invoice).toLowerCase().match(BOLT11_AMOUNT_RE);
  if (!match || !match[1]) return null;
  const amount = Number(match[1]);
  const divisor = match[2] ? BOLT11_MULTIPLIER_DIVISOR[match[2]] : 1;
  const msat = (amount * 100_000_000_000) / divisor;
  // Rounded UP: 1400 msat is not "1 sat" to anything that prices a send by
  // it (the password threshold, walletSpendPolicy's cap), and a gate that
  // guesses low is the expensive mistake.
  return Number.isFinite(msat) && msat > 0 ? Math.ceil(msat / 1000) : null;
}

// bech32's data alphabet, index = the 5-bit value each character stands for.
const BECH32_CHARSET = "qpzry9x8gf2tvdw0s3jn54khce6mua7l";
// A BOLT11 signature is 520 bits = 104 base32 characters, and the bech32
// checksum a further 6 — both sit at the end, after the tagged fields.
const BOLT11_SIGNATURE_CHARS = 104;
const BECH32_CHECKSUM_CHARS = 6;
// The invoice timestamp is a fixed 35-bit field (7 characters) right after
// the separator, before the first tagged field.
const BOLT11_TIMESTAMP_CHARS = 7;
// BOLT11's own default when an invoice carries no `x` (expiry) field.
const BOLT11_DEFAULT_EXPIRY_SECS = 3600;

// When a BOLT11 invoice stops being payable, as unix milliseconds, or null
// if the string isn't a decodable invoice.
//
// Display-only, and deliberately so: the payer's own wallet is the authority
// on whether an invoice is still good, and a payment request always carries
// an Ark address alongside the invoice that this has no bearing on. It
// exists so a request page can say "faktura vypršela" instead of letting
// someone scan a QR that their wallet will reject with a raw error.
//
// Only the timestamp and the `x` field are read; the signature and the rest
// of the tagged fields are skipped by length, never verified.
export function decodeBolt11Expiry(invoice: string): number | null {
  const v = normalizeDestination(invoice).toLowerCase();
  // bech32 excludes "1" from its data alphabet, so the last "1" is the
  // separator — the human-readable part may contain others.
  const sep = v.lastIndexOf("1");
  if (sep < 0) return null;
  const data = v.slice(sep + 1);
  const bodyLength = data.length - BOLT11_SIGNATURE_CHARS - BECH32_CHECKSUM_CHARS;
  if (bodyLength < BOLT11_TIMESTAMP_CHARS) return null;

  const values: number[] = [];
  for (const c of data.slice(0, bodyLength)) {
    const i = BECH32_CHARSET.indexOf(c);
    if (i < 0) return null;
    values.push(i);
  }

  let timestamp = 0;
  for (let i = 0; i < BOLT11_TIMESTAMP_CHARS; i++) timestamp = timestamp * 32 + values[i];

  let expiry = BOLT11_DEFAULT_EXPIRY_SECS;
  const expiryTag = BECH32_CHARSET.indexOf("x");
  // Tagged fields: 1 character of type, 2 of big-endian length, then that
  // many characters of data. A field running past the end means the string
  // isn't the invoice it claims to be — stop rather than guess.
  let p = BOLT11_TIMESTAMP_CHARS;
  while (p + 3 <= values.length) {
    const tag = values[p];
    const length = values[p + 1] * 32 + values[p + 2];
    p += 3;
    if (p + length > values.length) break;
    if (tag === expiryTag) {
      let seconds = 0;
      for (let i = 0; i < length; i++) seconds = seconds * 32 + values[p + i];
      expiry = seconds;
    }
    p += length;
  }

  const ms = (timestamp + expiry) * 1000;
  return Number.isSafeInteger(ms) && ms > 0 ? ms : null;
}

// The payment hash of a BOLT11 invoice (tag `p`, 52 base32 characters = 256
// bits) as 64 lower-case hex, or null when the string is not a decodable
// invoice. Same lenient walk as decodeBolt11Expiry: no signature or checksum
// check, so it is for bookkeeping about an invoice we just got from our own
// service node, never for deciding what to pay.
export function decodeBolt11PaymentHash(invoice: string): string | null {
  const v = normalizeDestination(invoice).toLowerCase();
  const sep = v.lastIndexOf("1");
  if (sep < 0) return null;
  const data = v.slice(sep + 1);
  const bodyLength = data.length - BOLT11_SIGNATURE_CHARS - BECH32_CHECKSUM_CHARS;
  if (bodyLength < BOLT11_TIMESTAMP_CHARS) return null;
  const values: number[] = [];
  for (const c of data.slice(0, bodyLength)) {
    const i = BECH32_CHARSET.indexOf(c);
    if (i < 0) return null;
    values.push(i);
  }
  const hashTag = BECH32_CHARSET.indexOf("p");
  let p = BOLT11_TIMESTAMP_CHARS;
  while (p + 3 <= values.length) {
    const tag = values[p];
    const length = values[p + 1] * 32 + values[p + 2];
    p += 3;
    if (p + length > values.length) return null;
    if (tag === hashTag && length === 52) {
      // 52 x 5 bits = 260 bits; the last 4 are padding.
      let bits = "";
      for (let i = 0; i < length; i++) bits += values[p + i].toString(2).padStart(5, "0");
      let hex = "";
      for (let i = 0; i < 256; i += 4) hex += parseInt(bits.slice(i, i + 4), 2).toString(16);
      return hex;
    }
    p += length;
  }
  return null;
}
