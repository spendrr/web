// DNSSEC chain validation for one TXT RRset, from the root trust anchor down.
//
// Input is a proof: the DNSKEY, DS and TXT RRsets (with their RRSIGs) for the
// path root -> ... -> signer zone -> target name. Whoever delivered it (our
// Worker, a DoH resolver) is untrusted transport: everything is checked here.
//
// What is accepted, deliberately narrow:
//  - algorithms 8, 10 (RSA SHA-2), 13, 14 (ECDSA), 15 (Ed25519); never SHA-1
//  - DS digests SHA-256 and SHA-384
//  - positive answers only. Absence (NSEC/NSEC3) is not proven; a missing record
//    simply fails, which can only deny a payment, never redirect one
//  - no wildcard expansion (RRSIG labels must equal the owner's label count)
//  - signature window checked against the caller's clock
import { Bip353Error } from "./errors";
import {
  CLASS_IN,
  TYPE_DNSKEY,
  TYPE_DS,
  TYPE_RRSIG,
  TYPE_TXT,
  concat,
  decodeProof,
  encodeName,
  isAtOrBelow,
  labelCount,
  putU16,
  putU32,
  readName,
  type Rr,
} from "./dnsWire";
import { ROOT_ANCHORS, type TrustAnchor } from "./trustAnchors";

export interface VerifiedTxt {
  // One string per TXT record, the record's character-strings concatenated.
  records: string[];
  // Zone that signed the TXT RRset.
  signer: string;
  // Earliest signature expiry along the whole chain, unix seconds. A cached
  // result must not outlive it.
  validUntil: number;
}

export interface VerifyOptions {
  nowSeconds: number;
  anchors?: readonly TrustAnchor[];
}

interface Dnskey {
  rr: Rr;
  flags: number;
  algorithm: number;
  key: Uint8Array;
  keyTag: number;
}

interface Rrsig {
  covered: number;
  algorithm: number;
  labels: number;
  origTtl: number;
  expiration: number;
  inception: number;
  keyTag: number;
  signer: string;
  signature: Uint8Array;
  // rdata up to (not including) the signature: the head of the signed data.
  head: Uint8Array;
}

const SUPPORTED_ALGS = new Set([8, 10, 13, 14, 15]);
const FLAG_ZONE = 0x0100;
const FLAG_REVOKE = 0x0080;

function u16(b: Uint8Array, o: number): number {
  return (b[o]! << 8) | b[o + 1]!;
}
function u32(b: Uint8Array, o: number): number {
  return ((b[o]! << 24) | (b[o + 1]! << 16) | (b[o + 2]! << 8) | b[o + 3]!) >>> 0;
}

function hex(b: Uint8Array): string {
  let s = "";
  for (const x of b) s += x.toString(16).padStart(2, "0");
  return s;
}

// RFC 4034 appendix B.
export function keyTagOf(dnskeyRdata: Uint8Array): number {
  let ac = 0;
  for (let i = 0; i < dnskeyRdata.length; i++) ac += i & 1 ? dnskeyRdata[i]! : dnskeyRdata[i]! << 8;
  ac += (ac >>> 16) & 0xffff;
  return ac & 0xffff;
}

function parseDnskey(rr: Rr): Dnskey | null {
  const r = rr.rdata;
  if (r.length < 5 || r[2] !== 3) return null;
  return { rr, flags: u16(r, 0), algorithm: r[3]!, key: r.slice(4), keyTag: keyTagOf(r) };
}

function parseRrsig(rr: Rr): Rrsig | null {
  const r = rr.rdata;
  if (r.length < 19) return null;
  let signer: { name: string; next: number };
  try {
    signer = readName(r, 18);
  } catch {
    return null;
  }
  // Signer names are never compressed (RFC 4034 3.1.7): a pointer here would
  // have been resolved against the RRSIG rdata itself, so insist on none.
  if (signer.next - 18 !== encodeName(signer.name).length) return null;
  return {
    covered: u16(r, 0),
    algorithm: r[2]!,
    labels: r[3]!,
    origTtl: u32(r, 4),
    expiration: u32(r, 8),
    inception: u32(r, 12),
    keyTag: u16(r, 16),
    signer: signer.name,
    signature: r.slice(signer.next),
    // The signed form has the signer name lowercase, whatever case was sent.
    head: concat([r.slice(0, 18), encodeName(signer.name)]),
  };
}

// RFC 1982 serial comparison on 32 bits.
function serialLte(a: number, b: number): boolean {
  return a === b || (((b - a) >>> 0) & 0x80000000) === 0;
}

function sigInWindow(sig: Rrsig, now: number): boolean {
  const n = now >>> 0;
  return serialLte(sig.inception, n) && serialLte(n, sig.expiration);
}

function compareBytes(a: Uint8Array, b: Uint8Array): number {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) if (a[i] !== b[i]) return a[i]! - b[i]!;
  return a.length - b.length;
}

// Signed data of RFC 4034 3.1.8.1 for an RRset of types without names inside
// their rdata (DNSKEY, DS, TXT), which is all this module ever verifies.
function signedData(sig: Rrsig, rrset: Rr[]): Uint8Array {
  const sorted = [...rrset].sort((a, b) => compareBytes(a.rdata, b.rdata));
  const parts: Uint8Array[] = [sig.head];
  let prev: Uint8Array | null = null;
  for (const rr of sorted) {
    if (prev && compareBytes(prev, rr.rdata) === 0) continue;
    prev = rr.rdata;
    parts.push(
      encodeName(rr.name),
      Uint8Array.from([...putU16(rr.type), ...putU16(rr.class), ...putU32(sig.origTtl), ...putU16(rr.rdata.length)]),
      rr.rdata,
    );
  }
  return concat(parts);
}

function b64u(b: Uint8Array): string {
  let s = "";
  for (const x of b) s += String.fromCharCode(x);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function importKey(k: Dnskey): Promise<{ key: CryptoKey; verify: AlgorithmIdentifier | RsaPssParams | EcdsaParams } | null> {
  const subtle = globalThis.crypto.subtle;
  const raw = k.key;
  try {
    if (k.algorithm === 8 || k.algorithm === 10) {
      // RFC 3110: exponent length (1 byte, or 0 + 2 bytes), exponent, modulus.
      let o = 0;
      let elen = raw[0]!;
      o = 1;
      if (elen === 0) {
        elen = u16(raw, 1);
        o = 3;
      }
      const e = raw.slice(o, o + elen);
      const n = raw.slice(o + elen);
      if (e.length !== elen || n.length < 128 || n.length > 512) return null;
      const hash = k.algorithm === 8 ? "SHA-256" : "SHA-512";
      const key = await subtle.importKey("jwk", { kty: "RSA", n: b64u(n), e: b64u(e), ext: true }, { name: "RSASSA-PKCS1-v1_5", hash }, false, ["verify"]);
      return { key, verify: { name: "RSASSA-PKCS1-v1_5" } };
    }
    if (k.algorithm === 13 || k.algorithm === 14) {
      const size = k.algorithm === 13 ? 32 : 48;
      if (raw.length !== size * 2) return null;
      const curve = k.algorithm === 13 ? "P-256" : "P-384";
      const key = await subtle.importKey("raw", concat([Uint8Array.from([4]), raw]) as BufferSource, { name: "ECDSA", namedCurve: curve }, false, ["verify"]);
      return { key, verify: { name: "ECDSA", hash: k.algorithm === 13 ? "SHA-256" : "SHA-384" } };
    }
    if (k.algorithm === 15) {
      if (raw.length !== 32) return null;
      const key = await subtle.importKey("raw", raw as BufferSource, { name: "Ed25519" }, false, ["verify"]);
      return { key, verify: { name: "Ed25519" } };
    }
  } catch {
    return null;
  }
  return null;
}

async function verifySig(sig: Rrsig, rrset: Rr[], key: Dnskey): Promise<boolean> {
  const imp = await importKey(key);
  if (!imp) return false;
  try {
    return await globalThis.crypto.subtle.verify(imp.verify, imp.key, sig.signature as BufferSource, signedData(sig, rrset) as BufferSource);
  } catch {
    return false;
  }
}

async function dsDigest(owner: string, key: Dnskey, digestType: number): Promise<string | null> {
  const alg = digestType === 2 ? "SHA-256" : digestType === 4 ? "SHA-384" : null;
  if (!alg) return null;
  const input = concat([encodeName(owner), key.rr.rdata]);
  return hex(new Uint8Array(await globalThis.crypto.subtle.digest(alg, input as BufferSource)));
}

interface Rrsets {
  sets: Map<string, Rr[]>;
  sigs: Map<string, Rrsig[]>;
}

const k = (name: string, type: number) => `${name}|${type}`;

function index(rrs: Rr[]): Rrsets {
  const sets = new Map<string, Rr[]>();
  const sigs = new Map<string, Rrsig[]>();
  for (const rr of rrs) {
    if (rr.class !== CLASS_IN) continue;
    if (rr.type === TYPE_RRSIG) {
      const s = parseRrsig(rr);
      if (!s) continue;
      const key = k(rr.name, s.covered);
      (sigs.get(key) ?? sigs.set(key, []).get(key)!).push(s);
    } else if (rr.type === TYPE_DNSKEY || rr.type === TYPE_DS || rr.type === TYPE_TXT) {
      const key = k(rr.name, rr.type);
      (sets.get(key) ?? sets.set(key, []).get(key)!).push(rr);
    }
  }
  return { sets, sigs };
}

interface Chain {
  validUntil: number;
}

// Verifies `rrset` (at `name`, `type`) has a valid signature from `signer`
// using one of `keys`. Returns the signature's expiry, or null.
async function verifiedBy(ix: Rrsets, name: string, type: number, signer: string, keys: Dnskey[], now: number): Promise<{ expiration: number } | { error: Bip353Error }> {
  const rrset = ix.sets.get(k(name, type));
  const sigs = ix.sigs.get(k(name, type));
  if (!rrset || !sigs) return { error: new Bip353Error("untrusted", "missing records or signature") };
  let sawExpired = false;
  let sawUnsupported = false;
  for (const sig of sigs) {
    if (sig.signer !== signer || !isAtOrBelow(name, signer)) continue;
    // Wildcard expansion would need a proof that the exact name does not exist.
    if (sig.labels !== labelCount(name)) continue;
    if (!SUPPORTED_ALGS.has(sig.algorithm)) {
      sawUnsupported = true;
      continue;
    }
    if (!sigInWindow(sig, now)) {
      sawExpired = true;
      continue;
    }
    for (const key of keys) {
      if (key.keyTag !== sig.keyTag || key.algorithm !== sig.algorithm) continue;
      if (await verifySig(sig, rrset, key)) return { expiration: sig.expiration };
    }
  }
  if (sawExpired) return { error: new Bip353Error("expired", `signature expired for ${name}`) };
  if (sawUnsupported) return { error: new Bip353Error("unsupported", `unsupported algorithm for ${name}`) };
  return { error: new Bip353Error("untrusted", `no valid signature for ${name}`) };
}

// The zone's DNSKEY RRset, proven by one key a DS (or anchor) vouches for.
async function zoneKeys(ix: Rrsets, zone: string, entries: readonly TrustAnchor[], now: number, chain: Chain): Promise<Dnskey[]> {
  const rrs = ix.sets.get(k(zone, TYPE_DNSKEY));
  if (!rrs) throw new Bip353Error("untrusted", `no DNSKEY for ${zone}`);
  const keys = rrs.map(parseDnskey).filter((x): x is Dnskey => x !== null && (x.flags & FLAG_ZONE) !== 0 && (x.flags & FLAG_REVOKE) === 0);
  const entry: Dnskey[] = [];
  for (const key of keys) {
    for (const ds of entries) {
      if (ds.keyTag !== key.keyTag || ds.algorithm !== key.algorithm || !SUPPORTED_ALGS.has(key.algorithm)) continue;
      const d = await dsDigest(zone, key, ds.digestType);
      if (d !== null && d === ds.digestHex) entry.push(key);
    }
  }
  if (entry.length === 0) throw new Bip353Error("untrusted", `no DNSKEY of ${zone} matches its DS`);
  const res = await verifiedBy(ix, zone, TYPE_DNSKEY, zone, entry, now);
  if ("error" in res) throw res.error;
  chain.validUntil = Math.min(chain.validUntil, res.expiration);
  return keys;
}

function dsEntries(rrs: Rr[]): TrustAnchor[] {
  const out: TrustAnchor[] = [];
  for (const rr of rrs) {
    if (rr.rdata.length < 5) continue;
    out.push({ keyTag: u16(rr.rdata, 0), algorithm: rr.rdata[2]!, digestType: rr.rdata[3]!, digestHex: hex(rr.rdata.slice(4)) });
  }
  return out;
}

// One TXT record as text, or null when it is not text. BIP 353 tells a reader to
// ignore records that are not a bitcoin: URI, so a binary decoy next to the real
// one must not fail the lookup.
function txtStrings(rdata: Uint8Array): string | null {
  const parts: Uint8Array[] = [];
  let o = 0;
  while (o < rdata.length) {
    const len = rdata[o]!;
    if (o + 1 + len > rdata.length) return null;
    parts.push(rdata.slice(o + 1, o + 1 + len));
    o += 1 + len;
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(concat(parts));
  } catch {
    return null;
  }
}

export async function verifyTxtProof(proof: Uint8Array | Rr[], target: string, opts: VerifyOptions): Promise<VerifiedTxt> {
  const rrs = proof instanceof Uint8Array ? decodeProof(proof) : proof;
  const ix = index(rrs);
  const anchors = opts.anchors ?? ROOT_ANCHORS;
  const now = opts.nowSeconds;

  const txt = ix.sets.get(k(target, TYPE_TXT));
  const txtSigs = ix.sigs.get(k(target, TYPE_TXT));
  if (!txt) throw new Bip353Error("no_record", "no TXT record in proof");
  // A record in an unsigned zone is not "no record": it is one we refuse.
  if (!txtSigs) throw new Bip353Error("untrusted", "TXT record is not signed");

  // The zone the TXT claims to be signed by. Each candidate is tried in full;
  // the chain below decides, this only chooses where to look.
  const signers = [...new Set(txtSigs.map((s) => s.signer))].filter((s) => isAtOrBelow(target, s));
  if (signers.length === 0) throw new Bip353Error("untrusted", "no usable signer");

  let lastError: Bip353Error | null = null;
  for (const signer of signers) {
    try {
      const chain: Chain = { validUntil: Number.MAX_SAFE_INTEGER };
      let zone = ".";
      let keys = await zoneKeys(ix, ".", anchors, now, chain);
      while (zone !== signer) {
        // Nearest DS strictly below `zone` and at or above `signer`: the next
        // zone cut. A name in between with no DS is not a cut.
        let next: string | null = null;
        for (const key of ix.sets.keys()) {
          const [name, type] = key.split("|") as [string, string];
          if (Number(type) !== TYPE_DS || name === zone || !isAtOrBelow(name, zone) || !isAtOrBelow(signer, name)) continue;
          if (next === null || labelCount(name) < labelCount(next)) next = name;
        }
        if (next === null) throw new Bip353Error("untrusted", `no delegation from ${zone} toward ${signer}`);
        const ds = await verifiedBy(ix, next, TYPE_DS, zone, keys, now);
        if ("error" in ds) throw ds.error;
        chain.validUntil = Math.min(chain.validUntil, ds.expiration);
        keys = await zoneKeys(ix, next, dsEntries(ix.sets.get(k(next, TYPE_DS))!), now, chain);
        zone = next;
      }
      const res = await verifiedBy(ix, target, TYPE_TXT, signer, keys, now);
      if ("error" in res) throw res.error;
      chain.validUntil = Math.min(chain.validUntil, res.expiration);
      // Identical records are one record (the signature covers the set, not repeats).
      const records = [...new Set(txt.map((rr) => txtStrings(rr.rdata)).filter((r): r is string => r !== null))];
      return { records, signer, validUntil: chain.validUntil };
    } catch (e) {
      if (!(e instanceof Bip353Error)) throw e;
      lastError = e;
    }
  }
  throw lastError ?? new Bip353Error("untrusted", "no valid chain");
}
