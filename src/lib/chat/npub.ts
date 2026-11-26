// A Nostr public key typed or pasted in the new-conversation field: an `npub1…`
// (NIP-19, plain bech32), optionally behind `nostr:`, or the 64-hex key itself.
// Main thread only: it shares the bech32 decoder with the send flow.
import { BECH32_CHARSET, bech32HrpExpand, bech32Polymod, convertBits } from "../send/bitcoinAddress";
import { bech32Decode } from "../send/destinationCheck";
import { BECH32_CONST } from "../send/bitcoinAddress";
import { isPublicKeyHex } from "./nostr";

// Lower-case hex of the 32-byte key, or null for anything else (an nsec, an
// nprofile, a bad checksum, a key that is not on the curve).
export function parseNostrPubkey(raw: string): string | null {
  const s = raw.trim().replace(/^nostr:/i, "");
  if (/^[0-9a-f]{64}$/i.test(s)) {
    const hex = s.toLowerCase();
    return isPublicKeyHex(hex) ? hex : null;
  }
  if (!/^npub1/i.test(s)) return null;
  const d = bech32Decode(s, [BECH32_CONST]);
  if (!d || d.hrp !== "npub") return null;
  const bytes = convertBits(d.words.slice(0, -6), 5, 8, false);
  if (!bytes || bytes.length !== 32) return null;
  const hex = bytes.map((b) => b.toString(16).padStart(2, "0")).join("");
  return isPublicKeyHex(hex) ? hex : null;
}

// Whether the field's text is a key rather than an @name; a name never has
// this shape (names are short, `npub1` + 58 characters is not one).
export function looksLikeNostrKey(raw: string): boolean {
  return /^(nostr:)?(npub1|[0-9a-f]{64}$)/i.test(raw.trim());
}

// The `npub1…` form of a 64-hex public key (NIP-19, plain bech32), or null for
// anything that is not one. The checksum is bech32, not bech32m.
export function encodeNpub(hex: string): string | null {
  if (!/^[0-9a-f]{64}$/i.test(hex)) return null;
  const bytes = hex.match(/../g)!.map((h) => parseInt(h, 16));
  const words = convertBits(bytes, 8, 5, true);
  if (!words) return null;
  const mod = bech32Polymod([...bech32HrpExpand("npub"), ...words, 0, 0, 0, 0, 0, 0]) ^ BECH32_CONST;
  const checksum = Array.from({ length: 6 }, (_, i) => (mod >>> (5 * (5 - i))) & 31);
  return "npub1" + [...words, ...checksum].map((w) => BECH32_CHARSET[w]).join("");
}
