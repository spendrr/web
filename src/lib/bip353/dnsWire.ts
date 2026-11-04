// DNS wire format, only as far as the BIP 353 proof needs it: names, resource
// records, response messages, a DoH query. No network, no crypto.
//
// Names are lowercase dotted ASCII with a trailing dot ("." is the root). A
// label outside [a-z0-9_-] is refused instead of escaped: every name we handle
// is one we built from a validated address, so an odd label in a proof is
// evidence of garbage, not a record to be kept.
import { Bip353Error } from "./errors";

export const TYPE_TXT = 16;
export const TYPE_OPT = 41;
export const TYPE_DS = 43;
export const TYPE_RRSIG = 46;
export const TYPE_DNSKEY = 48;
export const CLASS_IN = 1;

export interface Rr {
  name: string;
  type: number;
  class: number;
  ttl: number;
  rdata: Uint8Array;
}

const LABEL_RE = /^[a-z0-9_-]{1,63}$/;
const MAX_NAME_WIRE = 255;
// A proof is a handful of records. These bound memory and CPU on a hostile
// response, well above any real chain (root, TLD, domain, a few sub-zones).
export const MAX_PROOF_BYTES = 48 * 1024;
export const MAX_PROOF_RRS = 160;

export function labelsOf(name: string): string[] {
  if (name === ".") return [];
  return name.slice(0, -1).split(".");
}

export function nameFromLabels(labels: string[]): string {
  return labels.length === 0 ? "." : labels.join(".") + ".";
}

// Lowercases and checks a name given as text ("a.b.com" or "a.b.com.").
export function normalizeName(input: string): string {
  const lower = input.toLowerCase();
  const name = lower === "." ? "." : lower.endsWith(".") ? lower : lower + ".";
  const labels = labelsOf(name);
  for (const l of labels) {
    if (!LABEL_RE.test(l)) throw new Bip353Error("malformed", "bad label");
  }
  if (encodeName(name).length > MAX_NAME_WIRE) throw new Bip353Error("malformed", "name too long");
  return name;
}

// True when `name` equals `zone` or lies below it.
export function isAtOrBelow(name: string, zone: string): boolean {
  if (zone === ".") return true;
  return name === zone || name.endsWith("." + zone);
}

export function labelCount(name: string): number {
  return labelsOf(name).length;
}

export function encodeName(name: string): Uint8Array {
  const labels = labelsOf(name);
  const out: number[] = [];
  for (const l of labels) {
    if (!LABEL_RE.test(l)) throw new Bip353Error("malformed", "bad label");
    out.push(l.length);
    for (let i = 0; i < l.length; i++) out.push(l.charCodeAt(i));
  }
  out.push(0);
  return Uint8Array.from(out);
}

// Reads a (possibly compressed) name at `off`. A pointer must point strictly
// before the pointer itself, which makes loops impossible; the hop count is a
// second bound.
export function readName(buf: Uint8Array, off: number): { name: string; next: number } {
  const labels: string[] = [];
  let pos = off;
  let next = -1;
  let hops = 0;
  let total = 1;
  for (;;) {
    if (pos >= buf.length) throw new Bip353Error("malformed", "name past end");
    const len = buf[pos]!;
    if ((len & 0xc0) === 0xc0) {
      if (pos + 1 >= buf.length) throw new Bip353Error("malformed", "pointer past end");
      const target = ((len & 0x3f) << 8) | buf[pos + 1]!;
      if (next < 0) next = pos + 2;
      if (target >= pos || ++hops > 64) throw new Bip353Error("malformed", "bad pointer");
      pos = target;
      continue;
    }
    if ((len & 0xc0) !== 0) throw new Bip353Error("malformed", "bad label type");
    if (len === 0) {
      if (next < 0) next = pos + 1;
      break;
    }
    if (pos + 1 + len > buf.length) throw new Bip353Error("malformed", "label past end");
    total += len + 1;
    if (total > MAX_NAME_WIRE) throw new Bip353Error("malformed", "name too long");
    let label = "";
    for (let i = 0; i < len; i++) label += String.fromCharCode(buf[pos + 1 + i]!);
    label = label.toLowerCase();
    if (!LABEL_RE.test(label)) throw new Bip353Error("malformed", "bad label");
    labels.push(label);
    pos += 1 + len;
  }
  return { name: nameFromLabels(labels), next };
}

function u16(buf: Uint8Array, off: number): number {
  if (off + 2 > buf.length) throw new Bip353Error("malformed", "short");
  return (buf[off]! << 8) | buf[off + 1]!;
}

function u32(buf: Uint8Array, off: number): number {
  if (off + 4 > buf.length) throw new Bip353Error("malformed", "short");
  return ((buf[off]! << 24) | (buf[off + 1]! << 16) | (buf[off + 2]! << 8) | buf[off + 3]!) >>> 0;
}

export function putU16(n: number): number[] {
  return [(n >>> 8) & 0xff, n & 0xff];
}

export function putU32(n: number): number[] {
  return [(n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff];
}

export function concat(parts: Uint8Array[]): Uint8Array {
  let n = 0;
  for (const p of parts) n += p.length;
  const out = new Uint8Array(n);
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

// One RR in the uncompressed form used inside a proof (RFC 9102 style) and
// inside the DNSSEC signed data.
export function encodeRr(rr: Rr): Uint8Array {
  return concat([encodeName(rr.name), Uint8Array.from([...putU16(rr.type), ...putU16(rr.class), ...putU32(rr.ttl), ...putU16(rr.rdata.length)]), rr.rdata]);
}

function readRr(buf: Uint8Array, off: number): { rr: Rr; next: number } {
  const { name, next } = readName(buf, off);
  const type = u16(buf, next);
  const cls = u16(buf, next + 2);
  const ttl = u32(buf, next + 4);
  const rdlen = u16(buf, next + 8);
  const start = next + 10;
  if (start + rdlen > buf.length) throw new Bip353Error("malformed", "rdata past end");
  return { rr: { name, type, class: cls, ttl, rdata: buf.slice(start, start + rdlen) }, next: start + rdlen };
}

// A proof is RRs back to back. Compression is not allowed there: a pointer
// would need the earlier bytes of a message that no longer exists.
export function decodeProof(bytes: Uint8Array): Rr[] {
  if (bytes.length > MAX_PROOF_BYTES) throw new Bip353Error("malformed", "proof too large");
  const out: Rr[] = [];
  let off = 0;
  while (off < bytes.length) {
    if (out.length >= MAX_PROOF_RRS) throw new Bip353Error("malformed", "too many records");
    // A pointer byte at a name start is refused: an uncompressed name never has one.
    if ((bytes[off]! & 0xc0) !== 0) throw new Bip353Error("malformed", "compressed name in proof");
    const { rr, next } = readRr(bytes, off);
    out.push(rr);
    off = next;
  }
  return out;
}

export function encodeProof(rrs: Rr[]): Uint8Array {
  return concat(rrs.map(encodeRr));
}

export interface DnsResponse {
  rcode: number;
  truncated: boolean;
  answers: Rr[];
}

export function parseResponse(buf: Uint8Array): DnsResponse {
  if (buf.length < 12 || buf.length > 64 * 1024) throw new Bip353Error("malformed", "bad message size");
  const flags = u16(buf, 2);
  if ((flags & 0x8000) === 0) throw new Bip353Error("malformed", "not a response");
  const qd = u16(buf, 4);
  const an = u16(buf, 6);
  if (qd > 4 || an > MAX_PROOF_RRS * 2) throw new Bip353Error("malformed", "bad counts");
  let off = 12;
  for (let i = 0; i < qd; i++) {
    off = readName(buf, off).next + 4;
    if (off > buf.length) throw new Bip353Error("malformed", "short question");
  }
  const answers: Rr[] = [];
  for (let i = 0; i < an; i++) {
    const { rr, next } = readRr(buf, off);
    answers.push(rr);
    off = next;
  }
  return { rcode: flags & 0xf, truncated: (flags & 0x0200) !== 0, answers };
}

// RFC 8484 query: id 0, RD set, one question, EDNS0 OPT with the DO bit so the
// resolver returns the RRSIG/DNSKEY/DS records.
export function buildQuery(name: string, type: number): Uint8Array {
  return concat([
    Uint8Array.from([0, 0, 0x01, 0x00, 0, 1, 0, 0, 0, 0, 0, 1]),
    encodeName(name),
    Uint8Array.from([...putU16(type), ...putU16(CLASS_IN)]),
    Uint8Array.from([0, ...putU16(TYPE_OPT), ...putU16(1232), 0, 0, 0x80, 0, 0, 0]),
  ]);
}
