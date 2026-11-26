// NIP-19 bech32 for a 32-byte Nostr key (npub, nsec). Self-contained on purpose:
// the wallet worker encodes the secret key (nsec) with it, and nothing in that
// realm may import the network-aware address code.

const CHARSET = "qpzry9x8gf2tvdw0s3jn54khce6mua7l";

function polymod(values: number[]): number {
  const GEN = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3];
  let chk = 1;
  for (const v of values) {
    const top = chk >>> 25;
    chk = ((chk & 0x1ffffff) << 5) ^ v;
    for (let i = 0; i < 5; i++) if ((top >>> i) & 1) chk ^= GEN[i];
  }
  return chk >>> 0;
}

function hrpExpand(hrp: string): number[] {
  const out: number[] = [];
  for (const c of hrp) out.push(c.charCodeAt(0) >>> 5);
  out.push(0);
  for (const c of hrp) out.push(c.charCodeAt(0) & 31);
  return out;
}

// Plain bech32 (checksum constant 1), not bech32m. Null unless `bytes` is 32 bytes.
export function encodeKey(hrp: "npub" | "nsec", bytes: ArrayLike<number>): string | null {
  if (bytes.length !== 32) return null;
  const words: number[] = [];
  let acc = 0;
  let bits = 0;
  for (let i = 0; i < bytes.length; i++) {
    acc = (acc << 8) | bytes[i];
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      words.push((acc >>> bits) & 31);
    }
  }
  if (bits > 0) words.push((acc << (5 - bits)) & 31);
  const mod = polymod([...hrpExpand(hrp), ...words, 0, 0, 0, 0, 0, 0]) ^ 1;
  const checksum = Array.from({ length: 6 }, (_, i) => (mod >>> (5 * (5 - i))) & 31);
  return `${hrp}1${[...words, ...checksum].map((w) => CHARSET[w]).join("")}`;
}

export function encodeNpubBytes(pub: ArrayLike<number>): string | null {
  return encodeKey("npub", pub);
}

export function encodeNsecBytes(secret: ArrayLike<number>): string | null {
  return encodeKey("nsec", secret);
}
