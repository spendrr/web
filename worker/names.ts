// @handle registry: name -> Ark address, one global Durable Object.
//
// Why a Durable Object and not KV: names must be unique, and KV is eventually
// consistent, so two people claiming the same name at once could both win. A
// single DO serialises every operation. Nothing in here awaits anything but
// its own storage (proof of mailbox ownership is checked in index.ts BEFORE a
// request gets here), so each operation runs without another one interleaving.
//
// The logic lives in NameRegistryCore over a tiny storage interface so it can
// be unit-tested in memory; NameRegistry below is only the DO shell.
//
// Storage layout:
//   n:<name>       NameRecord      the name and where it points
//   m:<mailboxId>  MailboxRecord   the mailbox's current name (or null after a
//                                  release) and when it last changed things
//   q:<name>       Quarantine      a released or renamed-away name, held back
//
// Beyond that, three rules keep the directory honest over time:
//   - Inactivity. Every authorized call from a mailbox (set, mine) counts as a
//     sign of life and refreshes `lastSeenAt`; the app sends one by itself about
//     once a week while the wallet has a name. A name whose owner has shown
//     nothing for NAME_INACTIVITY_MS may be taken over by someone else. It is
//     never deleted or made unresolvable: it keeps resolving to its owner until
//     someone actually takes it, so a quiet but alive wallet is not cut off.
//   - Reserved names (handle.ts) belong to nobody, except that a name can be
//     handed to one specific mailbox through RESERVED_NAME_OWNERS.
//   - Moderation. An admin can remove a name and block it for good, and can ban
//     the mailbox that held it. A blocked name reads as reserved; a banned
//     mailbox can no longer register anything.
//   - Aliases. A mailbox owns one name, so an admin can also `assign` extra
//     names ("spendrr", "donate") that resolve to a given address. An alias is
//     not the mailbox's name: it does not count as it, never lapses, and cannot
//     be changed from the app, only by the admin.
//
// A mailbox owns at most one name. Changing the name or the address counts
// against NAME_MAX_CHANGES per NAME_CHANGE_WINDOW_MS, and so does releasing,
// so release + claim can't be used to hop names around the limit. A name a
// mailbox gives up is quarantined for NAME_QUARANTINE_MS: nobody else can take
// it, so a payment meant for the old owner never lands with a stranger. The
// mailbox that gave it up may take it back.
import { encodeNameSnapshot } from "./nameSnapshot";
import { checkHandle, isReservedName, type HandleProblem } from "../src/lib/names/handle";

export const NAME_QUARANTINE_MS = 30 * 24 * 60 * 60 * 1000;
export const NAME_CHANGE_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;
export const NAME_MAX_CHANGES = 5;
// A name nobody has vouched for in this long may be taken over. Long on
// purpose: a taken-over name pays whoever now holds it, so this is about
// abandoned names, not sleepy ones.
export const NAME_INACTIVITY_MS = 365 * 24 * 60 * 60 * 1000;
// Sign-of-life writes are throttled to this, so the weekly touch (or a busy
// profile screen) is not a storage write every time.
export const NAME_TOUCH_MIN_INTERVAL_MS = 24 * 60 * 60 * 1000;

// Same shape the client already accepts for a payment-request address
// (src/lib/send/paymentRequest.ts), plus a floor so "ark1" alone isn't a record.
export const ARK_ADDRESS_PATTERN = /^ark1[02-9ac-hj-np-z]+$/;
export const ARK_ADDRESS_MIN_CHARS = 20;
export const ARK_ADDRESS_MAX_CHARS = 200;

export function isPlausibleArkAddress(address: string): boolean {
  return (
    address.length >= ARK_ADDRESS_MIN_CHARS &&
    address.length <= ARK_ADDRESS_MAX_CHARS &&
    ARK_ADDRESS_PATTERN.test(address)
  );
}

// A mailbox authorization is 105 bytes: the mailbox public key (33), an expiry
// as a little-endian i64 of unix seconds (8), and a Schnorr signature (64)
// (bark's MailboxAuthorization). The server does the signature check; these
// two comparisons are the cheap ones we can do first and, for the id match,
// don't have to take on trust.
const MAILBOX_ID_HEX_CHARS = 66;
const MAILBOX_AUTH_HEX_CHARS = 210;

export type MailboxProofProblem = "malformed" | "mismatch" | "expired";

// A name proof is an authorization the app signs for exactly this long
// (src/lib/names/names.ts NAME_PROOF_LIFETIME_S), so the moment of signing can
// be recovered from its expiry (the SDK truncates to whole seconds: measured
// 2026-09-21, expiry minus the call was lifetime - 0.1 .. 0.9 s), which is
// what makes a freshness check possible without the SDK's help. It is longer
// than any push authorization a shard accepts (mailboxShared.ts
// PUSH_AUTH_MAX_LIFETIME_SECONDS): those are handed to the push backend and
// the relay, and one must never look freshly signed here, not even near the
// end of its life. A 24 h proof from an app before SDK 0.25.0 reads as stale.
export const NAME_PROOF_LIFETIME_S = 31 * 24 * 60 * 60;
// How far from "now" the moment of signing may lie, in either direction (the
// other side's clock is not ours). A name request signs right before it is
// sent, so a legitimate one is seconds old.
export const NAME_PROOF_MAX_AGE_S = 300;
export const NAME_PROOF_MAX_FUTURE_S = 300;
// How long a used authorization is remembered: past the point it could still
// pass the freshness check, with some margin.
export const NAME_PROOF_MEMORY_MS = (NAME_PROOF_MAX_AGE_S + NAME_PROOF_MAX_FUTURE_S + 60) * 1000;

function authorizationExpiry(authorization: string): bigint {
  const expiryHex = authorization.slice(MAILBOX_ID_HEX_CHARS, MAILBOX_ID_HEX_CHARS + 16);
  let expiry = 0n;
  for (let i = 7; i >= 0; i--) expiry = (expiry << 8n) | BigInt(parseInt(expiryHex.slice(i * 2, i * 2 + 2), 16));
  return expiry;
}

// Whether an authorization was signed recently enough to be used for a name
// change. On its own one would let whoever ever saw it change that mailbox's
// name for as long as it is valid. Assumes the well-formed shape checked by mailboxAuthorizationProblem.
export function mailboxAuthorizationFreshness(authorization: string, nowSeconds: number): "stale" | "future" | null {
  const signedAt = Number(authorizationExpiry(authorization)) - NAME_PROOF_LIFETIME_S;
  if (signedAt < nowSeconds - NAME_PROOF_MAX_AGE_S) return "stale";
  if (signedAt > nowSeconds + NAME_PROOF_MAX_FUTURE_S) return "future";
  return null;
}

export function mailboxAuthorizationProblem(
  mailboxId: string,
  authorization: string,
  nowSeconds: number,
): MailboxProofProblem | null {
  const hex = /^[0-9a-f]+$/;
  if (
    mailboxId.length !== MAILBOX_ID_HEX_CHARS ||
    authorization.length !== MAILBOX_AUTH_HEX_CHARS ||
    !hex.test(mailboxId) ||
    !hex.test(authorization)
  ) {
    return "malformed";
  }
  if (!authorization.startsWith(mailboxId)) return "mismatch";
  if (authorizationExpiry(authorization) <= BigInt(Math.floor(nowSeconds))) return "expired";
  return null;
}

export interface NameStorage {
  get<T>(key: string): Promise<T | undefined>;
  put(key: string, value: unknown): Promise<void>;
  delete(key: string): Promise<boolean>;
  // Keys come back in ascending order; `startAfter` is exclusive.
  list<T>(options: { prefix: string; limit?: number; startAfter?: string }): Promise<Map<string, T>>;
}

export interface NameRecord {
  name: string;
  mailboxId: string;
  address: string;
  createdAt: number;
  updatedAt: number;
  // Last sign of life from the owner. Records written before this existed have
  // none, and fall back to updatedAt.
  lastSeenAt?: number;
  // Set by an admin `assign`. Not linked to the mailbox's own name (no `m:`
  // record points at it), never abandoned, immune to `set`.
  alias?: boolean;
  // Opt-in: whether `<name>@spendrr.app` accepts Lightning payments (beta,
  // see lnurl.ts/lnLedger.ts). Only the owner sets this (POST /api/names/ln,
  // proven the same way as `set`). Never carried over: `set`'s takeover path
  // and `release` both write/delete a fresh record without this field, and
  // `adminRemove` deletes the record outright — so a name that changes hands
  // always starts with Lightning payments off until the new owner turns it
  // on themselves.
  lnAddress?: boolean;
  // The owner's money chat key (x-only secp256k1, hex), also served as the
  // name's NIP-05 identity. Set only by the owner with a signature by that key
  // (index.ts checks it). Never carried over, same as lnAddress: a name that
  // changes hands starts without one, and the app publishes its own again.
  chatPubkey?: string;
}

interface Blocked {
  at: number;
  reason?: string;
}

interface Banned {
  at: number;
}

interface MailboxRecord {
  name: string | null;
  // Timestamps (ms) of name/address changes and releases, pruned to the window.
  changes: number[];
}

interface Quarantine {
  until: number;
  mailboxId: string;
}

export type LookupResult =
  | { status: "taken"; name: string; address: string; lnAddress: boolean; chatPubkey?: string }
  | { status: "free" }
  | { status: "quarantined" }
  | { status: "reserved" }
  | { status: "invalid"; problem: HandleProblem };

export type SetResult =
  | { ok: true; action: "claimed" | "renamed" | "address-updated" | "unchanged"; name: string; address: string }
  | {
      ok: false;
      error: "invalid" | "reserved" | "bad-address" | "taken" | "quarantined" | "rate-limited" | "banned" | "closed";
    };

export type ReleaseResult = { ok: true; name: string } | { ok: false; error: "not-found" | "rate-limited" };

export type MineResult = { name: string; address: string; lnAddress: boolean; chatPubkey?: string } | null;

export type SetChatPubkeyResult = { ok: true; chatPubkey: string } | { ok: false; error: "no-name" | "invalid" };

export type SetLnAddressResult = { ok: true; lnAddress: boolean } | { ok: false; error: "no-name" };

const nameKey = (name: string) => `n:${name}`;
const mailboxKey = (mailboxId: string) => `m:${mailboxId}`;
const quarantineKey = (name: string) => `q:${name}`;
const blockedKey = (name: string) => `b:${name}`;
const bannedKey = (mailboxId: string) => `x:${mailboxId}`;

// RESERVED_NAME_OWNERS is a JSON object {"spendrr": "<mailbox id>", ...}. It is
// configuration typed by a person, so it is read defensively: anything that is
// not a well-formed entry is dropped rather than trusted or thrown on.
export function parseReservedOwners(raw: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!raw) return out;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return out;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return out;
  for (const [key, value] of Object.entries(parsed)) {
    const check = checkHandle(key, { allowReserved: true });
    if (!check.ok || !isReservedName(check.handle)) continue;
    if (typeof value !== "string" || !/^[0-9a-f]{66}$/.test(value)) continue;
    out[check.handle] = value;
  }
  return out;
}

export class NameRegistryCore {
  private readonly storage: NameStorage;
  private readonly now: () => number;
  private readonly reservedOwners: Record<string, string>;

  constructor(
    storage: NameStorage,
    now: () => number = Date.now,
    reservedOwners: Record<string, string> = {},
  ) {
    this.storage = storage;
    this.now = now;
    this.reservedOwners = reservedOwners;
  }

  private recentChanges(m: MailboxRecord | undefined): number[] {
    if (!m) return [];
    const cutoff = this.now() - NAME_CHANGE_WINDOW_MS;
    return m.changes.filter((t) => t > cutoff);
  }

  private lastSeen(record: NameRecord): number {
    return record.lastSeenAt ?? record.updatedAt;
  }

  // Someone else may take this name over: its owner has shown no sign of life
  // for NAME_INACTIVITY_MS. A name handed out through RESERVED_NAME_OWNERS never
  // lapses, the configuration is what says who holds it.
  private isAbandoned(record: NameRecord): boolean {
    if (record.alias || isReservedName(record.name)) return false;
    return this.now() - this.lastSeen(record) > NAME_INACTIVITY_MS;
  }

  async lookup(raw: string): Promise<LookupResult> {
    const check = checkHandle(raw, { allowReserved: true });
    if (!check.ok) return { status: "invalid", problem: check.problem };
    const name = check.handle;
    // A record wins over everything below: a name registered before it became
    // reserved or blocked keeps resolving until an admin removes it.
    const record = await this.storage.get<NameRecord>(nameKey(name));
    if (record) {
      return {
        status: "taken",
        name: record.name,
        address: record.address,
        lnAddress: record.lnAddress === true,
        ...(record.chatPubkey ? { chatPubkey: record.chatPubkey } : {}),
      };
    }
    if (await this.storage.get<Blocked>(blockedKey(name))) return { status: "reserved" };
    if (isReservedName(name)) return { status: "reserved" };
    const q = await this.storage.get<Quarantine>(quarantineKey(name));
    if (q && q.until > this.now()) return { status: "quarantined" };
    return { status: "free" };
  }

  // Every name a lookup would answer with anything but a plain "free" (or a
  // reserved-list "reserved"): records (aliases included), admin blocks and
  // quarantines still running. The edge keeps only hashes of these
  // (nameSnapshot.ts): a name outside the set needs no Durable Object request.
  async snapshotNames(): Promise<string[]> {
    const now = this.now();
    const names: string[] = [];
    const collect = async (prefix: string, keep: (value: unknown) => boolean) => {
      let after: string | undefined;
      for (;;) {
        const page = await this.storage.list<unknown>({ prefix, limit: SNAPSHOT_LIST_PAGE, startAfter: after });
        for (const [key, value] of page) {
          after = key;
          if (keep(value)) names.push(key.slice(prefix.length));
        }
        if (page.size < SNAPSHOT_LIST_PAGE) return;
      }
    };
    await collect("n:", () => true);
    await collect("b:", () => true);
    await collect("q:", (value) => typeof value === "object" && value !== null && (value as Quarantine).until > now);
    return names;
  }

  // Claim a name, rename, or change the address behind the current one, in a
  // single call. `mailboxId` must already have been proven by the caller.
  // `allowNewName: false` (the caller's daily budget for taking names is spent)
  // still lets a mailbox change the address behind the name it already holds,
  // but refuses claiming, renaming and taking over: "closed".
  async set(input: { name: string; mailboxId: string; address: string; allowNewName?: boolean }): Promise<SetResult> {
    const check = checkHandle(input.name, { allowReserved: true });
    if (!check.ok) return { ok: false, error: "invalid" };
    const name = check.handle;
    if (!isPlausibleArkAddress(input.address)) return { ok: false, error: "bad-address" };

    const { mailboxId, address } = input;
    const now = this.now();

    if (await this.storage.get<Banned>(bannedKey(mailboxId))) return { ok: false, error: "banned" };
    if (await this.storage.get<Blocked>(blockedKey(name))) return { ok: false, error: "reserved" };
    // Reserved: only the mailbox the configuration names may hold it.
    if (isReservedName(name) && this.reservedOwners[name] !== mailboxId) return { ok: false, error: "reserved" };

    const m = await this.storage.get<MailboxRecord>(mailboxKey(mailboxId));
    const existing = await this.storage.get<NameRecord>(nameKey(name));
    const recent = this.recentChanges(m);

    // An alias is the admin's: nobody changes or takes it from the app, not
    // even the mailbox it was assigned to (that would tie it to the mailbox's
    // own name).
    if (existing?.alias) return { ok: false, error: "taken" };
    if (existing && existing.mailboxId !== mailboxId && !this.isAbandoned(existing)) {
      return { ok: false, error: "taken" };
    }

    if (existing && existing.mailboxId === mailboxId) {
      // Already this mailbox's name: at most the address changes.
      if (existing.address === address) {
        await this.touchRecord(existing);
        return { ok: true, action: "unchanged", name, address };
      }
      if (recent.length >= NAME_MAX_CHANGES) return { ok: false, error: "rate-limited" };
      await Promise.all([
        this.storage.put(nameKey(name), { ...existing, address, updatedAt: now, lastSeenAt: now }),
        this.storage.put(mailboxKey(mailboxId), { name, changes: [...recent, now] }),
      ]);
      return { ok: true, action: "address-updated", name, address };
    }

    if (input.allowNewName === false) return { ok: false, error: "closed" };

    const q = await this.storage.get<Quarantine>(quarantineKey(name));
    const quarantined = q !== undefined && q.until > now;
    if (!existing && quarantined && q.mailboxId !== mailboxId) return { ok: false, error: "quarantined" };

    // Anything past the very first claim is a change and is limited.
    if (m && recent.length >= NAME_MAX_CHANGES) return { ok: false, error: "rate-limited" };

    const previousName = m?.name ?? null;
    const writes: Promise<unknown>[] = [
      this.storage.put(nameKey(name), {
        name,
        mailboxId,
        address,
        createdAt: now,
        updatedAt: now,
        lastSeenAt: now,
      } satisfies NameRecord),
      this.storage.put(mailboxKey(mailboxId), { name, changes: m ? [...recent, now] : [] } satisfies MailboxRecord),
    ];
    if (q) writes.push(this.storage.delete(quarantineKey(name)));
    if (existing) {
      // A takeover of an abandoned name: the previous owner's mailbox just
      // stops owning it. No quarantine, it was already unclaimed by them.
      const old = await this.storage.get<MailboxRecord>(mailboxKey(existing.mailboxId));
      if (old && old.name === name) {
        writes.push(this.storage.put(mailboxKey(existing.mailboxId), { name: null, changes: old.changes }));
      }
    }
    if (previousName) {
      writes.push(
        this.storage.delete(nameKey(previousName)),
        this.storage.put(quarantineKey(previousName), {
          until: now + NAME_QUARANTINE_MS,
          mailboxId,
        } satisfies Quarantine),
      );
    }
    await Promise.all(writes);
    return { ok: true, action: m ? "renamed" : "claimed", name, address };
  }

  async release(mailboxId: string): Promise<ReleaseResult> {
    const m = await this.storage.get<MailboxRecord>(mailboxKey(mailboxId));
    if (!m || !m.name) return { ok: false, error: "not-found" };
    const now = this.now();
    const recent = this.recentChanges(m);
    if (recent.length >= NAME_MAX_CHANGES) return { ok: false, error: "rate-limited" };
    await Promise.all([
      this.storage.delete(nameKey(m.name)),
      this.storage.put(quarantineKey(m.name), { until: now + NAME_QUARANTINE_MS, mailboxId } satisfies Quarantine),
      // Keep the history: releasing must count toward the change limit.
      this.storage.put(mailboxKey(mailboxId), { name: null, changes: [...recent, now] } satisfies MailboxRecord),
    ]);
    return { ok: true, name: m.name };
  }

  // Also the weekly sign of life: reading your own name refreshes lastSeenAt.
  async mine(mailboxId: string): Promise<MineResult> {
    const m = await this.storage.get<MailboxRecord>(mailboxKey(mailboxId));
    if (!m || !m.name) return null;
    const record = await this.storage.get<NameRecord>(nameKey(m.name));
    if (!record) return null;
    await this.touchRecord(record);
    return {
      name: record.name,
      address: record.address,
      lnAddress: record.lnAddress === true,
      ...(record.chatPubkey ? { chatPubkey: record.chatPubkey } : {}),
    };
  }

  // Owner-only. `mailboxId` is proven and the key's signature checked by the
  // caller. A no-op when unchanged, so the app can re-publish on every unlock
  // without a storage write.
  async setChatPubkey(mailboxId: string, chatPubkey: string): Promise<SetChatPubkeyResult> {
    if (!/^[0-9a-f]{64}$/.test(chatPubkey)) return { ok: false, error: "invalid" };
    const m = await this.storage.get<MailboxRecord>(mailboxKey(mailboxId));
    if (!m || !m.name) return { ok: false, error: "no-name" };
    const record = await this.storage.get<NameRecord>(nameKey(m.name));
    if (!record || record.mailboxId !== mailboxId) return { ok: false, error: "no-name" };
    if (record.chatPubkey === chatPubkey) return { ok: true, chatPubkey };
    await this.storage.put(nameKey(record.name), { ...record, chatPubkey, updatedAt: this.now() });
    return { ok: true, chatPubkey };
  }

  // Owner-only opt-in/opt-out for the Lightning address. `mailboxId` must
  // already have been proven by the caller (same proveNameMailbox as `set`).
  // A no-op if already in that state, so a repeated toggle from a slow UI
  // doesn't burn a name-change-limit slot or anything else.
  async setLnAddress(mailboxId: string, enabled: boolean): Promise<SetLnAddressResult> {
    const m = await this.storage.get<MailboxRecord>(mailboxKey(mailboxId));
    if (!m || !m.name) return { ok: false, error: "no-name" };
    const record = await this.storage.get<NameRecord>(nameKey(m.name));
    if (!record || record.mailboxId !== mailboxId) return { ok: false, error: "no-name" };
    if ((record.lnAddress === true) === enabled) return { ok: true, lnAddress: enabled };
    await this.storage.put(nameKey(record.name), { ...record, lnAddress: enabled, updatedAt: this.now() });
    return { ok: true, lnAddress: enabled };
  }

  // Read-only, used by the LNURL callback: is this name both taken and
  // opted in? Never touches lastSeenAt — a payer resolving the address is
  // not a sign of life from the owner.
  // `mailboxId` is who the payment is for at this moment: the ledger files the
  // invoice under it, so its receipts stay with this owner even if the name
  // later changes hands.
  async lnAddressTarget(raw: string): Promise<{ name: string; address: string; mailboxId: string } | null> {
    const check = checkHandle(raw, { allowReserved: true });
    if (!check.ok) return null;
    const record = await this.storage.get<NameRecord>(nameKey(check.handle));
    if (!record || record.lnAddress !== true) return null;
    return { name: record.name, address: record.address, mailboxId: record.mailboxId };
  }

  private async touchRecord(record: NameRecord): Promise<void> {
    if (record.alias) return;
    const now = this.now();
    if (now - this.lastSeen(record) < NAME_TOUCH_MIN_INTERVAL_MS) return;
    await this.storage.put(nameKey(record.name), { ...record, lastSeenAt: now });
  }

  // One-time use of an authorization. `hash` is the digest of the authorization
  // string; the first call for it succeeds and every later one, until it could no
  // longer pass the freshness check anyway, fails. With freshness this turns the
  // proof into a token that is good for one request in a few minutes, so a copy
  // that leaks (a log, a proxy) is dead as soon as the real request has used it.
  // The DO runs one request at a time, so the check and the write cannot race.
  async consumeProof(hash: string): Promise<boolean> {
    const now = this.now();
    const key = `p:${hash}`;
    const seen = await this.storage.get<number>(key);
    if (seen !== undefined && seen > now) return false;
    await this.storage.put(key, now + NAME_PROOF_MEMORY_MS);
    // Keep the memory bounded: drop a few expired entries on every use.
    const page = await this.storage.list<number>({ prefix: "p:", limit: 50 });
    let dropped = 0;
    for (const [k, until] of page) {
      if (until <= now && dropped < 20) {
        await this.storage.delete(k);
        dropped++;
      }
    }
    return true;
  }

  // ---- admin -------------------------------------------------------------

  async adminGet(raw: string): Promise<{ record: NameRecord | null; blocked: boolean; abandoned: boolean }> {
    const check = checkHandle(raw, { allowReserved: true });
    if (!check.ok) return { record: null, blocked: false, abandoned: false };
    const record = (await this.storage.get<NameRecord>(nameKey(check.handle))) ?? null;
    const blocked = (await this.storage.get<Blocked>(blockedKey(check.handle))) !== undefined;
    return { record, blocked, abandoned: record ? this.isAbandoned(record) : false };
  }

  // Pages through the registry in name order. `after` is the last name of the
  // previous page.
  async adminList(options: { after?: string; limit?: number } = {}): Promise<{ names: NameRecord[]; next?: string }> {
    const limit = Math.min(Math.max(Math.floor(options.limit ?? 100), 1), 500);
    const startAfter = options.after ? nameKey(options.after) : undefined;
    const page = await this.storage.list<NameRecord>({ prefix: "n:", limit: limit + 1, startAfter });
    const all = [...page.values()];
    const names = all.slice(0, limit);
    return { names, next: all.length > limit ? names[names.length - 1].name : undefined };
  }

  // Take a name away and block it for good, so neither the holder nor anyone
  // else can register it again. `ban` also bars the holder's mailbox from
  // registering anything.
  async adminRemove(
    raw: string,
    options: { ban?: boolean; reason?: string } = {},
  ): Promise<{ ok: true; removed: NameRecord | null } | { ok: false; error: "invalid" }> {
    const check = checkHandle(raw, { allowReserved: true });
    if (!check.ok) return { ok: false, error: "invalid" };
    const name = check.handle;
    const now = this.now();
    const record = (await this.storage.get<NameRecord>(nameKey(name))) ?? null;
    const writes: Promise<unknown>[] = [
      this.storage.put(blockedKey(name), { at: now, reason: options.reason } satisfies Blocked),
      this.storage.delete(quarantineKey(name)),
    ];
    if (record) {
      writes.push(this.storage.delete(nameKey(name)));
      const m = await this.storage.get<MailboxRecord>(mailboxKey(record.mailboxId));
      if (m && m.name === name) {
        writes.push(this.storage.put(mailboxKey(record.mailboxId), { name: null, changes: m.changes }));
      }
      if (options.ban) writes.push(this.storage.put(bannedKey(record.mailboxId), { at: now } satisfies Banned));
    }
    await Promise.all(writes);
    return { ok: true, removed: record };
  }

  // Point an extra name at an address, on behalf of a mailbox, without going
  // through that mailbox's single-name rule. Assigning again to an existing alias
  // just changes where it points. It will not overwrite a name an ordinary user
  // holds or one that is blocked: remove or unblock first, on purpose.
  // `lnAddress` lets an admin-assigned alias (e.g. "spendrr", "donate", or a
  // throwaway test name) opt into Lightning payments at creation time,
  // without the owner-proof `setLnAddress` needs — an alias has no owning
  // mailbox in the normal sense anyway (see the field's own comment on
  // NameRecord). Omitted or false keeps the previous behavior exactly.
  async adminAssign(input: {
    name: string;
    mailboxId: string;
    address: string;
    lnAddress?: boolean;
  }): Promise<
    | { ok: true; record: NameRecord }
    | { ok: false; error: "invalid" | "bad-address" | "bad-mailbox" | "taken" | "blocked" }
  > {
    const check = checkHandle(input.name, { allowReserved: true });
    if (!check.ok) return { ok: false, error: "invalid" };
    const name = check.handle;
    if (!isPlausibleArkAddress(input.address)) return { ok: false, error: "bad-address" };
    if (!/^[0-9a-f]{66}$/.test(input.mailboxId)) return { ok: false, error: "bad-mailbox" };
    if (await this.storage.get<Blocked>(blockedKey(name))) return { ok: false, error: "blocked" };
    const existing = await this.storage.get<NameRecord>(nameKey(name));
    if (existing && !existing.alias) return { ok: false, error: "taken" };
    const now = this.now();
    const record: NameRecord = {
      name,
      mailboxId: input.mailboxId,
      address: input.address,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
      lastSeenAt: now,
      alias: true,
      ...(input.lnAddress !== undefined ? { lnAddress: input.lnAddress } : {}),
    };
    await Promise.all([this.storage.put(nameKey(name), record), this.storage.delete(quarantineKey(name))]);
    return { ok: true, record };
  }

  async adminBlock(raw: string, reason?: string): Promise<{ ok: boolean }> {
    const check = checkHandle(raw, { allowReserved: true });
    if (!check.ok) return { ok: false };
    await this.storage.put(blockedKey(check.handle), { at: this.now(), reason } satisfies Blocked);
    return { ok: true };
  }

  async adminUnblock(raw: string): Promise<{ ok: boolean }> {
    const check = checkHandle(raw, { allowReserved: true });
    if (!check.ok) return { ok: false };
    await this.storage.delete(blockedKey(check.handle));
    return { ok: true };
  }

  async adminUnban(mailboxId: string): Promise<{ ok: boolean }> {
    return { ok: await this.storage.delete(bannedKey(mailboxId)) };
  }
}

// The slice of Durable Object state this uses, typed by hand like bump.ts
// (this project has no workers-types dependency).
interface NameState {
  storage: NameStorage;
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

const SNAPSHOT_LIST_PAGE = 1000;
// A snapshot is rebuilt when a name, block or quarantine was written, and
// otherwise at most this often: the writes are tracked at the storage layer, so
// this only bounds the damage of a write path that ever bypasses it.
const SNAPSHOT_MAX_AGE_MS = 10 * 60 * 1000;

// Tells the snapshot that something it holds may have changed: any write to a
// name (`n:`), an admin block (`b:`) or a quarantine (`q:`). At the storage
// layer on purpose, so a new write path in the core cannot forget it.
function trackNameChanges(storage: NameStorage, onChange: () => void): NameStorage {
  const relevant = (key: string) => key.startsWith("n:") || key.startsWith("b:") || key.startsWith("q:");
  return {
    get: (key) => storage.get(key),
    list: (options) => storage.list(options),
    async put(key, value) {
      if (relevant(key)) onChange();
      await storage.put(key, value);
      if (relevant(key)) onChange();
    },
    async delete(key) {
      if (relevant(key)) onChange();
      const existed = await storage.delete(key);
      if (relevant(key)) onChange();
      return existed;
    },
  };
}

export class NameRegistry {
  private readonly core: NameRegistryCore;
  private snapshotDirty = true;
  private snapshot: { wire: ReturnType<typeof encodeNameSnapshot>; builtAt: number } | null = null;

  constructor(state: NameState, env: { RESERVED_NAME_OWNERS?: string } | null) {
    const tracked = trackNameChanges(state.storage, () => {
      this.snapshotDirty = true;
    });
    this.core = new NameRegistryCore(tracked, Date.now, parseReservedOwners(env?.RESERVED_NAME_OWNERS));
  }

  // Internal only: index.ts is the one caller, and has already validated and
  // authorised the request. It still re-checks types here since this is the
  // last line before storage.
  async fetch(request: Request): Promise<Response> {
    if (request.method !== "POST") return json({ error: "Not found" }, 404);
    let body: Record<string, unknown>;
    try {
      const parsed: unknown = await request.json();
      if (typeof parsed !== "object" || parsed === null) return json({ error: "Invalid body" }, 400);
      body = parsed as Record<string, unknown>;
    } catch {
      return json({ error: "Invalid body" }, 400);
    }
    const str = (k: string) => (typeof body[k] === "string" ? (body[k] as string) : null);
    const path = new URL(request.url).pathname;

    if (path === "/lookup") {
      const name = str("name");
      if (name === null) return json({ error: "Invalid body" }, 400);
      return json(await this.core.lookup(name));
    }
    if (path === "/snapshot") {
      const now = Date.now();
      if (this.snapshot === null || this.snapshotDirty || now - this.snapshot.builtAt > SNAPSHOT_MAX_AGE_MS) {
        // Cleared before reading: a write that lands meanwhile marks it again.
        this.snapshotDirty = false;
        this.snapshot = { wire: encodeNameSnapshot(await this.core.snapshotNames(), now), builtAt: now };
      }
      return json(this.snapshot.wire);
    }
    if (path === "/set") {
      const name = str("name");
      const mailboxId = str("mailboxId");
      const address = str("address");
      if (name === null || mailboxId === null || address === null) return json({ error: "Invalid body" }, 400);
      return json(await this.core.set({ name, mailboxId, address, allowNewName: body.allowNewName !== false }));
    }
    if (path === "/release") {
      const mailboxId = str("mailboxId");
      if (mailboxId === null) return json({ error: "Invalid body" }, 400);
      return json(await this.core.release(mailboxId));
    }
    if (path === "/mine") {
      const mailboxId = str("mailboxId");
      if (mailboxId === null) return json({ error: "Invalid body" }, 400);
      return json(await this.core.mine(mailboxId));
    }
    if (path === "/ln-address/set") {
      const mailboxId = str("mailboxId");
      if (mailboxId === null || typeof body.enabled !== "boolean") return json({ error: "Invalid body" }, 400);
      return json(await this.core.setLnAddress(mailboxId, body.enabled));
    }
    if (path === "/chat/set") {
      const mailboxId = str("mailboxId");
      const chatPubkey = str("chatPubkey");
      if (mailboxId === null || chatPubkey === null) return json({ error: "Invalid body" }, 400);
      return json(await this.core.setChatPubkey(mailboxId, chatPubkey));
    }
    if (path === "/ln-address/target") {
      const name = str("name");
      if (name === null) return json({ error: "Invalid body" }, 400);
      return json(await this.core.lnAddressTarget(name));
    }
    if (path === "/consume") {
      const hash = str("hash");
      if (hash === null || !/^[0-9a-f]{64}$/.test(hash)) return json({ error: "Invalid body" }, 400);
      return json({ ok: await this.core.consumeProof(hash) });
    }
    // Admin routes. index.ts checks the admin token before forwarding here.
    if (path === "/admin/get") {
      const name = str("name");
      if (name === null) return json({ error: "Invalid body" }, 400);
      return json(await this.core.adminGet(name));
    }
    if (path === "/admin/list") {
      const after = str("after") ?? undefined;
      const limit = typeof body.limit === "number" ? body.limit : undefined;
      return json(await this.core.adminList({ after, limit }));
    }
    if (path === "/admin/remove") {
      const name = str("name");
      if (name === null) return json({ error: "Invalid body" }, 400);
      return json(
        await this.core.adminRemove(name, { ban: body.ban === true, reason: str("reason") ?? undefined }),
      );
    }
    if (path === "/admin/assign") {
      const name = str("name");
      const mailboxId = str("mailboxId");
      const address = str("address");
      if (name === null || mailboxId === null || address === null) return json({ error: "Invalid body" }, 400);
      const lnAddress = typeof body.lnAddress === "boolean" ? body.lnAddress : undefined;
      return json(await this.core.adminAssign({ name, mailboxId, address, lnAddress }));
    }
    if (path === "/admin/block") {
      const name = str("name");
      if (name === null) return json({ error: "Invalid body" }, 400);
      return json(await this.core.adminBlock(name, str("reason") ?? undefined));
    }
    if (path === "/admin/unblock") {
      const name = str("name");
      if (name === null) return json({ error: "Invalid body" }, 400);
      return json(await this.core.adminUnblock(name));
    }
    if (path === "/admin/unban") {
      const mailboxId = str("mailboxId");
      if (mailboxId === null) return json({ error: "Invalid body" }, 400);
      return json(await this.core.adminUnban(mailboxId));
    }
    return json({ error: "Not found" }, 404);
  }
}
