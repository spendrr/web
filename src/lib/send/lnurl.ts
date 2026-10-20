// Decodes a raw LNURL-pay link (`lnurl1…`, per LUD-01/BIP173 bech32) far
// enough to read the host it points at — nothing else about it. This exists
// solely to narrow the wallet worker's network-allowlist exception for
// payLnurl (see walletWorkerGuard.ts's arbitraryDomain) to the one host the
// call actually needs, instead of the "any host" bypass that used to apply
// for the whole call.
//
// Not a general bech32 decoder: LUD-01 explicitly lifts BIP173's 90-character
// length cap (a real LNURL routinely exceeds it) and only ever uses plain
// bech32 (BECH32_CONST), never bech32m — so this deliberately doesn't share
// isValidBech32SegwitAddress()'s length/version checks, only its checksum
// primitives.
import { BECH32_CHARSET, BECH32_CONST, bech32HrpExpand, bech32Polymod, convertBits } from "./bitcoinAddress";

// Returns the host the LNURL decodes to, or null for anything that isn't a
// well-formed `lnurl1…` string — including a checksum mismatch, a non-UTF8
// payload, or a payload that isn't a URL. Callers must treat null as "no
// host known", never as "allow anything": see arbitraryDomain.allow()'s own
// comment for why an empty exception fails the call closed instead of
// falling back to a blanket bypass.
export function decodeLnurlHost(lnurl: string): string | null {
  const trimmed = lnurl.trim();
  // Mixed case is invalid per BIP173 — work on the lowercase form for the
  // charset/checksum, but reject anything that isn't consistently cased.
  const lower = trimmed.toLowerCase();
  if (trimmed !== lower && trimmed !== trimmed.toUpperCase()) return null;
  const pos = lower.lastIndexOf("1");
  if (pos < 1 || pos + 7 > lower.length) return null;
  const hrp = lower.slice(0, pos);
  if (hrp !== "lnurl") return null;
  const dataPart = lower.slice(pos + 1);
  const data: number[] = [];
  for (const c of dataPart) {
    const v = BECH32_CHARSET.indexOf(c);
    if (v === -1) return null;
    data.push(v);
  }
  if (data.length < 6) return null;
  const values = bech32HrpExpand(hrp).concat(data);
  if (bech32Polymod(values) !== BECH32_CONST) return null;
  // Drop the 6-word checksum, then repack the 5-bit words into bytes — no
  // witness-version word here, unlike a segwit address, so the whole
  // remainder is payload.
  const words = data.slice(0, data.length - 6);
  const bytes = convertBits(words, 5, 8, false);
  if (bytes === null) return null;
  let url: string;
  try {
    url = new TextDecoder("utf-8", { fatal: true }).decode(new Uint8Array(bytes));
  } catch {
    return null;
  }
  try {
    return new URL(url).host;
  } catch {
    return null;
  }
}

// The inverse of decodeLnurlHost above: bech32-encodes a payRequest URL as
// `lnurl1…`, for a wallet that doesn't understand Ark and needs a QR to pay
// this app's own Lightning address the ordinary LNURL way (ProfilePage.tsx,
// docs/ln-address-plan.md section 4.3). Plain bech32 (BECH32_CONST), same as
// decodeLnurlHost and unlike a Bitcoin address — LUD-01 never uses bech32m.
function bech32CreateChecksum(hrp: string, data: number[]): number[] {
  const values = bech32HrpExpand(hrp).concat(data, [0, 0, 0, 0, 0, 0]);
  const mod = bech32Polymod(values) ^ BECH32_CONST;
  const checksum: number[] = [];
  for (let p = 0; p < 6; p++) checksum.push((mod >> (5 * (5 - p))) & 31);
  return checksum;
}

export function encodeLnurl(url: string): string {
  const bytes = [...new TextEncoder().encode(url)];
  const words = convertBits(bytes, 8, 5, true);
  if (words === null) throw new Error("encodeLnurl: bad input");
  const checksum = bech32CreateChecksum("lnurl", words);
  const data = words.concat(checksum).map((w) => BECH32_CHARSET[w]).join("");
  return `lnurl1${data}`.toUpperCase();
}
