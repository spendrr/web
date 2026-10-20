// Pure local, network-independent validation for mainnet Bitcoin on-chain
// addresses (bech32/bech32m segwit + base58check legacy/P2SH). This exists
// specifically for the emergency-exit destination address: the rest of this
// app is fine relying on the SDK to reject a bad on-chain address (see
// wallet.sendOnchain's own validation), but the exit flow's whole point is
// working when the Ark server/network can't be trusted to cooperate —
// gating "is this address well-formed" on a network call
// (estimateSendOnchainFee) defeats that, since it also fails whenever the
// wallet has insufficient balance or the server is unreachable, exactly the
// conditions an emergency exit needs to survive. No bitcoin library is a
// dependency of this project (see ARCHITECTURE.md), so this is a minimal,
// hand-verified implementation of BIP173/BIP350 (bech32/bech32m) and
// base58check — checksum verification only, not full script decoding.

// Exported (not just used locally) so lnurl.ts can decode a raw LNURL bech32
// string without a second hand-rolled copy of the same checksum algorithm —
// see that file for why it needs to (narrowing the wallet worker's network
// allowlist exception for payLnurl to the host the LNURL actually encodes).
import { IS_REGTEST, IS_SIGNET } from "../network";

// bech32 human-readable part of this build's network.
const ADDRESS_HRP = IS_REGTEST ? "bcrt" : IS_SIGNET ? "tb" : "bc";

export const BECH32_CHARSET = "qpzry9x8gf2tvdw0s3jn54khce6mua7l";
export const BECH32_CONST = 1;
export const BECH32M_CONST = 0x2bc830a3;

export function bech32Polymod(values: number[]): number {
  const GEN = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3];
  let chk = 1;
  for (const v of values) {
    const top = chk >>> 25;
    chk = ((chk & 0x1ffffff) << 5) ^ v;
    for (let i = 0; i < 5; i++) {
      if ((top >>> i) & 1) chk ^= GEN[i];
    }
  }
  return chk >>> 0;
}

export function bech32HrpExpand(hrp: string): number[] {
  const out: number[] = [];
  for (const c of hrp) out.push(c.charCodeAt(0) >>> 5);
  out.push(0);
  for (const c of hrp) out.push(c.charCodeAt(0) & 31);
  return out;
}

function isValidBech32SegwitAddress(address: string): boolean {
  // Mixed case is invalid per BIP173; work on the lowercase form for the
  // charset/checksum, but reject if the original had mixed case.
  const lower = address.toLowerCase();
  if (address !== lower && address !== address.toUpperCase()) return false;
  const pos = lower.lastIndexOf("1");
  if (pos < 1 || pos + 7 > lower.length || lower.length > 90) return false;
  const hrp = lower.slice(0, pos);
  if (hrp !== ADDRESS_HRP) return false; // this build's network only
  const dataPart = lower.slice(pos + 1);
  const data: number[] = [];
  for (const c of dataPart) {
    const v = BECH32_CHARSET.indexOf(c);
    if (v === -1) return false;
    data.push(v);
  }
  if (data.length < 6) return false;
  const values = bech32HrpExpand(hrp).concat(data);
  const polymod = bech32Polymod(values);
  const isBech32 = polymod === BECH32_CONST;
  const isBech32m = polymod === BECH32M_CONST;
  if (!isBech32 && !isBech32m) return false;

  const witnessVersion = data[0];
  if (witnessVersion > 16) return false;
  if (witnessVersion === 0 && !isBech32) return false;
  if (witnessVersion !== 0 && !isBech32m) return false;

  // Convert the remaining 5-bit words (minus the 6-word checksum) to bytes.
  const words = data.slice(1, data.length - 6);
  const program = convertBits(words, 5, 8, false);
  if (program === null) return false;
  if (program.length < 2 || program.length > 40) return false;
  if (witnessVersion === 0 && program.length !== 20 && program.length !== 32) return false;
  return true;
}

export function convertBits(data: number[], fromBits: number, toBits: number, pad: boolean): number[] | null {
  let acc = 0;
  let bits = 0;
  const ret: number[] = [];
  const maxv = (1 << toBits) - 1;
  for (const value of data) {
    if (value < 0 || value >>> fromBits !== 0) return null;
    acc = (acc << fromBits) | value;
    bits += fromBits;
    while (bits >= toBits) {
      bits -= toBits;
      ret.push((acc >>> bits) & maxv);
    }
  }
  if (pad) {
    if (bits > 0) ret.push((acc << (toBits - bits)) & maxv);
  } else if (bits >= fromBits || ((acc << (toBits - bits)) & maxv) !== 0) {
    return null;
  }
  return ret;
}

const BASE58_ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

function base58Decode(input: string): Uint8Array | null {
  let num = 0n;
  for (const c of input) {
    const digit = BASE58_ALPHABET.indexOf(c);
    if (digit === -1) return null;
    num = num * 58n + BigInt(digit);
  }
  let bytes: number[] = [];
  while (num > 0n) {
    bytes.unshift(Number(num & 0xffn));
    num >>= 8n;
  }
  // Leading '1's encode leading zero bytes.
  for (const c of input) {
    if (c !== "1") break;
    bytes.unshift(0);
  }
  return new Uint8Array(bytes);
}

async function sha256(data: Uint8Array): Promise<Uint8Array> {
  const digest = await crypto.subtle.digest("SHA-256", data.buffer as ArrayBuffer);
  return new Uint8Array(digest);
}

async function isValidBase58CheckAddress(address: string): Promise<boolean> {
  if (!/^[1-9A-HJ-NP-Za-km-z]+$/.test(address) || address.length < 26 || address.length > 35) return false;
  const decoded = base58Decode(address);
  if (!decoded || decoded.length < 5) return false;
  const payload = decoded.slice(0, decoded.length - 4);
  const checksum = decoded.slice(decoded.length - 4);
  const hash1 = await sha256(payload);
  const hash2 = await sha256(hash1);
  for (let i = 0; i < 4; i++) {
    if (checksum[i] !== hash2[i]) return false;
  }
  // P2PKH or P2SH version byte of this build's network only (mainnet 0x00 /
  // 0x05; signet and testnet 0x6f / 0xc4).
  return IS_SIGNET || IS_REGTEST ? payload[0] === 0x6f || payload[0] === 0xc4 : payload[0] === 0x00 || payload[0] === 0x05;
}

// Purely local — no network/SDK call. Returns true only for a well-formed
// on-chain address of this build's network (mainnet in every deployed build;
// tb1… in signet dev mode, src/lib/network.ts). The name predates that: a
// mainnet on-chain address (bech32/bech32m segwit, or base58check legacy/
// P2SH); anything else, including testnet/other-network addresses, is
// rejected.
export async function isValidMainnetBitcoinAddress(address: string): Promise<boolean> {
  const trimmed = address.trim();
  if (!trimmed) return false;
  if (trimmed.toLowerCase().startsWith(`${ADDRESS_HRP}1`)) return isValidBech32SegwitAddress(trimmed);
  return isValidBase58CheckAddress(trimmed);
}
