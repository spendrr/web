import { BECH32M_CONST } from "./bitcoinAddress";
import { bech32Decode } from "./destinationCheck";

// Reads the one shape of Ark address this app and the SDK produce, without the
// wallet worker: bech32m, hrp ark/tark, version 1, then
//   ark_id (4) | len 34 | 0x00 + user pubkey (33) | len 34 | 0x01 + mailbox id (33)
// (bark 0.7.1 lib/src/address.rs; checked against real mainnet addresses).
// ark_id is the first 4 bytes of sha256(server pubkey), so it says which Ark
// server the address is for, which is what validateArkoorAddress compares.
//
// This is a strict subset of what the SDK accepts: any other shape (another
// policy, an extra or unknown delivery, a point off the curve) is null here and
// goes to the SDK, never to a rejection. It exists only to skip the wallet
// queue for the common address, and decides nothing about a payment.
const PAYLOAD_BYTES = 4 + 1 + 34 + 1 + 34;
const POLICY_PUBKEY = 0x00;
const DELIVERY_MAILBOX = 0x01;
const FIELD_LEN = 34;

const P = 0xfffffffffffffffffffffffffffffffffffffffffffffffffffffffefffffc2fn;

function modPow(base: bigint, exp: bigint, mod: bigint): bigint {
  let result = 1n;
  let b = base % mod;
  let e = exp;
  while (e > 0n) {
    if (e & 1n) result = (result * b) % mod;
    b = (b * b) % mod;
    e >>= 1n;
  }
  return result;
}

// A compressed secp256k1 key: 02/03 and an x whose x^3 + 7 is a square mod p.
function isCompressedPoint(bytes: Uint8Array): boolean {
  if (bytes.length !== 33 || (bytes[0] !== 2 && bytes[0] !== 3)) return false;
  let x = 0n;
  for (let i = 1; i < 33; i++) x = (x << 8n) | BigInt(bytes[i]);
  if (x >= P) return false;
  const rhs = (modPow(x, 3n, P) + 7n) % P;
  return modPow(rhs, (P - 1n) / 2n, P) === 1n;
}

export type ArkAddressId = { testnet: boolean; arkId: string };

export function parseCanonicalArkAddress(address: string): ArkAddressId | null {
  const d = bech32Decode(address, [BECH32M_CONST]);
  if (!d || (d.hrp !== "ark" && d.hrp !== "tark")) return null;
  const words = d.words.slice(0, -6);
  if (words[0] !== 1) return null;
  const out: number[] = [];
  let acc = 0;
  let bits = 0;
  for (const w of words.slice(1)) {
    acc = (acc << 5) | w;
    bits += 5;
    while (bits >= 8) {
      bits -= 8;
      out.push((acc >> bits) & 0xff);
      acc &= (1 << bits) - 1;
    }
  }
  // Trailing padding must be short and zero, as the encoder writes it.
  if (bits >= 5 || acc !== 0) return null;
  if (out.length !== PAYLOAD_BYTES) return null;
  const bytes = Uint8Array.from(out);
  if (bytes[4] !== FIELD_LEN || bytes[5] !== POLICY_PUBKEY) return null;
  if (bytes[39] !== FIELD_LEN || bytes[40] !== DELIVERY_MAILBOX) return null;
  if (!isCompressedPoint(bytes.subarray(6, 39)) || !isCompressedPoint(bytes.subarray(41, 74))) return null;
  const arkId = Array.from(bytes.subarray(0, 4), (b) => b.toString(16).padStart(2, "0")).join("");
  return { testnet: d.hrp === "tark", arkId };
}
