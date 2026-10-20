// Hand-rolled protobuf encode/decode for the Ark server's mailbox service
// (mailbox_server.proto in gitlab.com/ark-bitcoin/bark, server-rpc/protos):
// exactly the messages this app needs, no protobuf library. Pure and without
// imports, so the Worker (mailbox.ts) and the push relay (relay/, Node) share
// one copy. Verified against the real ark.second.tech server with a live
// wallet's own mailboxIdentifier()/mailboxAuthorization() (see ARCHITECTURE.md).

function encodeVarint(n: number): Uint8Array {
  const bytes: number[] = [];
  while (n > 0x7f) {
    bytes.push((n & 0x7f) | 0x80);
    n >>>= 7;
  }
  bytes.push(n);
  return new Uint8Array(bytes);
}

// checkpoint is documented as "strictly ascending time-based number" — a
// real uint64, easily exceeding 32 bits. JS's bitwise operators (<<, |, >>>)
// only work on 32-bit ints, so the plain-number encodeVarint/readVarint
// above silently corrupt it (this shipped once and caused every cron tick
// to re-fetch and re-notify the *entire* mailbox history — see ARCHITECTURE.md).
// BigInt throughout for this one field fixes it for good.
function encodeVarintBig(n: bigint): Uint8Array {
  const bytes: number[] = [];
  while (n > 0x7fn) {
    bytes.push(Number(n & 0x7fn) | 0x80);
    n >>= 7n;
  }
  bytes.push(Number(n));
  return new Uint8Array(bytes);
}

function encodeTaggedBytes(fieldNumber: number, value: Uint8Array): Uint8Array {
  const tag = encodeVarint((fieldNumber << 3) | 2);
  const len = encodeVarint(value.length);
  const out = new Uint8Array(tag.length + len.length + value.length);
  out.set(tag, 0);
  out.set(len, tag.length);
  out.set(value, tag.length + len.length);
  return out;
}

function concatBytes(parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const p of parts) {
    out.set(p, offset);
    offset += p.length;
  }
  return out;
}

function encodeTaggedVarintBig(fieldNumber: number, value: bigint): Uint8Array {
  const tag = encodeVarint((fieldNumber << 3) | 0);
  const val = encodeVarintBig(value);
  const out = new Uint8Array(tag.length + val.length);
  out.set(tag, 0);
  out.set(val, tag.length);
  return out;
}

/** MailboxRequest { bytes mailbox_id = 1; optional bytes authorization = 2; uint64 checkpoint = 3; }, gRPC-framed. */
export function encodeMailboxRequest(mailboxId: Uint8Array, authorization: Uint8Array, checkpoint: bigint): Uint8Array {
  const payload = concatBytes([
    encodeTaggedBytes(1, mailboxId),
    encodeTaggedBytes(2, authorization),
    encodeTaggedVarintBig(3, checkpoint),
  ]);
  // gRPC wire framing: 1 byte (uncompressed) + 4 bytes big-endian length + payload.
  const frame = new Uint8Array(5 + payload.length);
  const view = new DataView(frame.buffer);
  view.setUint8(0, 0);
  view.setUint32(1, payload.length, false);
  frame.set(payload, 5);
  return frame;
}

class ProtoReader {
  private pos = 0;
  private readonly buf: Uint8Array;
  constructor(buf: Uint8Array) {
    this.buf = buf;
  }

  get done(): boolean {
    return this.pos >= this.buf.length;
  }

  /**
   * For fields this reader treats as plain (32-bit-safe) numbers: field
   * tags, wire types, and the have_more bool — none of which any real Ark
   * message needs more than a handful of bits for. Bounded to 4 bytes (28
   * bits), not the full 10-byte range a uint64 varint could use: JS's `<<`/
   * `|=` are 32-bit operations, so a 5th continuation byte (shift >= 28)
   * would silently wrap instead of producing the real value — the same bug
   * class encodeVarintBig's own comment already documents being fixed for
   * checkpoint/amount_msat via readVarint64 below. Silently wrapping here
   * would let a malformed/adversarial buffer misparse a tag or a
   * length-prefix into some other, smaller-looking value instead of failing
   * fast — readBytes()'s own bounds check would not reliably catch a wrapped
   * length, since wrapping can land back inside the buffer's real size.
   */
  readVarint(): number {
    let result = 0;
    let shift = 0;
    for (let i = 0; i < 4; i++) {
      if (this.pos >= this.buf.length) throw new Error("varint runs past end of buffer");
      const byte = this.buf[this.pos++];
      result |= (byte & 0x7f) << shift;
      if ((byte & 0x80) === 0) return result >>> 0;
      shift += 7;
    }
    throw new Error("varint too long for a 32-bit field — use readVarint64 for fields that can exceed it");
  }

  /** For uint64 fields (checkpoint, amount_msat) that can exceed 32 bits — see encodeVarintBig's comment. */
  readVarint64(): bigint {
    let result = 0n;
    let shift = 0n;
    for (let i = 0; i < 10; i++) {
      if (this.pos >= this.buf.length) throw new Error("varint runs past end of buffer");
      const byte = this.buf[this.pos++];
      result |= BigInt(byte & 0x7f) << shift;
      if ((byte & 0x80) === 0) return result;
      shift += 7n;
    }
    throw new Error("varint too long");
  }

  readTag(): { fieldNumber: number; wireType: number } {
    const tag = this.readVarint();
    return { fieldNumber: tag >>> 3, wireType: tag & 0x7 };
  }

  readBytes(): Uint8Array {
    const len = this.readVarint();
    // subarray() silently clamps an out-of-range end to the buffer's actual
    // length rather than throwing — without this check, a malformed/short
    // buffer would "succeed" with a truncated slice instead of surfacing
    // the corruption to the caller.
    if (len < 0 || this.pos + len > this.buf.length) throw new Error("length-prefixed field runs past end of buffer");
    const out = this.buf.subarray(this.pos, this.pos + len);
    this.pos += len;
    return out;
  }

  /** Advances past a field's value without interpreting it (unknown/uninteresting field). */
  skip(wireType: number): void {
    if (wireType === 0) this.readVarint();
    else if (wireType === 2) this.readBytes();
    else if (wireType === 1) this.pos += 8;
    else if (wireType === 5) this.pos += 4;
    else throw new Error(`unsupported wire type ${wireType}`);
  }
}

export type MailboxReceiveEvent =
  | { kind: "lightning"; paymentHash: Uint8Array; amountMsat: number }
  | { kind: "arkoor"; amountSat: number };

export interface ReadMailboxResult {
  events: MailboxReceiveEvent[];
  /** Highest checkpoint seen across every message, incoming-payment or not — always advance past all of them. */
  nextCheckpoint: bigint;
  haveMore: boolean;
}

/** IncomingLightningPaymentMessage { bytes payment_hash = 1; uint64 amount_msat = 2; } */
function decodeIncomingLightningPayment(bytes: Uint8Array): { paymentHash: Uint8Array; amountMsat: number } {
  const r = new ProtoReader(bytes);
  let paymentHash: Uint8Array = new Uint8Array();
  // uint64, not a plain 32-bit varint — a large invoice (roughly above
  // 4.29M msat, i.e. ~4,295 sats) would otherwise silently wrap via the
  // 32-bit readVarint(), the exact bug class the checkpoint field already
  // had fixed elsewhere in this file (see encodeVarintBig's comment).
  let amountMsat = 0n;
  while (!r.done) {
    const { fieldNumber, wireType } = r.readTag();
    if (fieldNumber === 1 && wireType === 2) paymentHash = r.readBytes();
    else if (fieldNumber === 2 && wireType === 0) amountMsat = r.readVarint64();
    else r.skip(wireType);
  }
  // Well within Number's exactly-representable range for any realistic
  // invoice (safe up to 2^53 msat, i.e. ~9 quadrillion sats) — Number()
  // here is just for the caller's convenience, not a precision cliff.
  return { paymentHash, amountMsat: Number(amountMsat) };
}

// The only wire-format version this offset-based read has been verified
// against (see the doc comment below) — a future format change would bump
// this, and readVtxoAmountSat must not guess an amount from bytes it
// doesn't recognize the layout of.
//
// This was wrong (hardcoded 0) until 2026-09-14: real Ark receive pushes
// never showed an amount because live VTXOs carry version 2, not 0. Fetched
// straight from the pinned bark-0.7.0 source (lib/src/vtxo/mod.rs):
// `const VTXO_ENCODING_VERSION: u16 = 2` (and `VTXO_NO_FEE_AMOUNT_VERSION: u16
// = 1` for the version right before it). Both 1 and 2 are accepted since the
// only difference between them is a fee-amount field added inside `genesis`,
// which is encoded *after* amount (see the layout comment below) — the first
// 10 bytes are identical either way.
const KNOWN_VTXO_WIRE_VERSIONS = [1, 2];
// Generous sanity ceiling, not a protocol constant — total bitcoin supply
// is 21e6 BTC = 2.1e15 sats, so any parsed amount above that is definitely
// corrupt/garbage, not a real VTXO value.
const MAX_PLAUSIBLE_SATS = 2_100_000_000_000_000n;

/**
 * Vtxo::serialize() wire format (lib/src/vtxo/mod.rs's vtxo_encode_inner in
 * gitlab.com/ark-bitcoin/bark, confirmed against the real source, including
 * its WriteExt::emit_u16/emit_u64 both being to_le_bytes): u16 LE version,
 * then u64 LE amount in sats, then further fields (expiry_height,
 * server_pubkey, exit_delta, anchor_point, genesis, policy, point) this
 * doesn't need. Only the first 10 bytes are read.
 *
 * Returns null (rather than a guessed amount) if the version doesn't match
 * what this was verified against, or the parsed amount is implausible — a
 * malformed or future-format VTXO must not surface a nonsensical figure
 * (e.g. near u64::MAX sats) directly in a push notification body.
 */
function readVtxoAmountSat(vtxoBytes: Uint8Array): bigint | null {
  if (vtxoBytes.length < 10) return null;
  const view = new DataView(vtxoBytes.buffer, vtxoBytes.byteOffset, vtxoBytes.byteLength);
  const version = view.getUint16(0, true);
  if (!KNOWN_VTXO_WIRE_VERSIONS.includes(version)) return null;
  const amount = view.getBigUint64(2, true);
  if (amount > MAX_PLAUSIBLE_SATS) return null;
  return amount;
}

/**
 * ArkoorMessage { repeated bytes vtxos = 1; } — sum the amount across every
 * VTXO in the message. Returns null (rather than an understated total) if
 * any single VTXO's amount couldn't be read — see readVtxoAmountSat.
 */
function decodeArkoorMessage(bytes: Uint8Array): bigint | null {
  const r = new ProtoReader(bytes);
  let totalSat = 0n;
  while (!r.done) {
    const { fieldNumber, wireType } = r.readTag();
    if (fieldNumber === 1 && wireType === 2) {
      const amount = readVtxoAmountSat(r.readBytes());
      if (amount === null) return null;
      totalSat += amount;
    } else {
      r.skip(wireType);
    }
  }
  return totalSat;
}

/**
 * MailboxMessage {
 *   oneof message {
 *     ArkoorMessage arkoor = 1;
 *     RoundParticipationCompleted round_participation_completed = 4;
 *     IncomingLightningPaymentMessage incoming_lightning_payment = 5;
 *     RecoveryVtxoIdsMessage recovery_vtxo_ids = 6;
 *     LightningSendFinishedMessage lightning_send_finished = 7;
 *   }
 *   uint64 checkpoint = 2;
 * }
 * Only field 1 (arkoor) and field 5 (incoming Lightning payment) mean "you
 * got paid" — everything else is routine protocol traffic (round
 * completions, your own sends finishing, recovery bookkeeping) and must be
 * skipped, or every background maintenance cycle would trigger a push.
 */
export function decodeMailboxMessage(bytes: Uint8Array): { checkpoint: bigint; event: MailboxReceiveEvent | null } {
  const r = new ProtoReader(bytes);
  let checkpoint = 0n;
  let event: MailboxReceiveEvent | null = null;
  while (!r.done) {
    const { fieldNumber, wireType } = r.readTag();
    if (fieldNumber === 2 && wireType === 0) {
      checkpoint = r.readVarint64();
    } else if (fieldNumber === 1 && wireType === 2) {
      const totalSat = decodeArkoorMessage(r.readBytes());
      // null means at least one VTXO's amount couldn't be read (unknown
      // wire version or implausible value) — 0 is mailboxShared.ts's
      // existing signal to fall back to the amount-less "Přijatá platba"
      // notification instead of showing a wrong or missing figure.
      event = { kind: "arkoor", amountSat: totalSat === null ? 0 : Number(totalSat) };
    } else if (fieldNumber === 5 && wireType === 2) {
      const { paymentHash, amountMsat } = decodeIncomingLightningPayment(r.readBytes());
      event = { kind: "lightning", paymentHash, amountMsat };
    } else {
      r.skip(wireType);
    }
  }
  return { checkpoint, event };
}

/** MailboxMessages { repeated MailboxMessage messages = 1; bool have_more = 2; } */
export function decodeMailboxMessages(bytes: Uint8Array): ReadMailboxResult {
  const r = new ProtoReader(bytes);
  const events: MailboxReceiveEvent[] = [];
  let nextCheckpoint = 0n;
  let haveMore = false;
  while (!r.done) {
    const { fieldNumber, wireType } = r.readTag();
    if (fieldNumber === 1 && wireType === 2) {
      const { checkpoint, event } = decodeMailboxMessage(r.readBytes());
      if (checkpoint > nextCheckpoint) nextCheckpoint = checkpoint;
      if (event) events.push(event);
    } else if (fieldNumber === 2 && wireType === 0) {
      haveMore = r.readVarint() !== 0;
    } else {
      r.skip(wireType);
    }
  }
  return { events, nextCheckpoint, haveMore };
}

export function hexToBytes(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

// A mailbox authorization is 33 bytes of mailbox key, an 8-byte little-endian
// unix expiry and a 64-byte signature (bark's MailboxAuthorization; names.ts
// reads it the same way, and tests/relay.test.ts holds the two together). The
// expiry, or null for anything not shaped like one.
export function authorizationExpiry(authorizationHex: string): number | null {
  if (!/^[0-9a-f]{210}$/.test(authorizationHex)) return null;
  const bytes = hexToBytes(authorizationHex);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const expiry = view.getBigUint64(33, true);
  return expiry > BigInt(Number.MAX_SAFE_INTEGER) ? null : Number(expiry);
}
