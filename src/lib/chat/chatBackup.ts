// Contacts and schedules, kept on the relays as one event encrypted to our own
// chat key (NIP-78, written by chatWorkerImpl.ts), so a restore or a second
// device gets them back with the seed. Pure, unit-tested.
//
// Addresses are deliberately not stored: the pay sheet trusts a contact's
// address, and on a fresh device there are no name pins to flag a changed one.
// A restored contact gets its address again from the registry, and only when
// the name still publishes that contact's chat key (chatClient's
// verifyClaimedName).
import { checkHandle } from "../names/handle";
import { isInterval, type Interval } from "./messages";

// Shape only: the backup is signed by our own key, and the worker checks a
// recipient key properly before anything is sent to it.
function isPublicKeyHex(v: unknown): v is string {
  return typeof v === "string" && /^[0-9a-f]{64}$/.test(v);
}

export interface BackupContact {
  pubkey: string;
  name?: string;
  accepted: boolean;
  blocked?: boolean;
  verified?: boolean;
  updatedAt: number;
}

export interface BackupSchedule {
  id: string;
  peer: string;
  kind: "send" | "pay-request";
  sats: number;
  every: Interval;
  nextDue: number;
  note?: string;
}

export interface ChatBackup {
  v: 1;
  contacts: BackupContact[];
  schedules: BackupSchedule[];
  schedulesAt: number;
}

// NIP-44 caps the plaintext at 64 KiB; strangers we blocked are the part that
// can grow without the user doing anything, so they are trimmed first.
const MAX_JSON_CHARS = 60_000;
const MAX_BLOCKED = 200;
const MAX_SCHEDULES = 100;
const MAX_NOTE_CHARS = 80;

function isTime(v: unknown): v is number {
  return typeof v === "number" && Number.isSafeInteger(v) && v >= 0;
}

function parseContact(raw: unknown): BackupContact | null {
  if (typeof raw !== "object" || raw === null) return null;
  const r = raw as Record<string, unknown>;
  if (!isPublicKeyHex(r.pubkey) || typeof r.accepted !== "boolean" || !isTime(r.updatedAt)) return null;
  const name = typeof r.name === "string" && checkHandle(r.name).ok ? r.name : undefined;
  return {
    pubkey: r.pubkey,
    accepted: r.accepted,
    updatedAt: r.updatedAt,
    ...(name ? { name } : {}),
    ...(r.blocked === true ? { blocked: true } : {}),
    ...(r.verified === true ? { verified: true } : {}),
  };
}

function parseSchedule(raw: unknown): BackupSchedule | null {
  if (typeof raw !== "object" || raw === null) return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.id !== "string" || r.id.length === 0 || r.id.length > 64) return null;
  if (!isPublicKeyHex(r.peer) || (r.kind !== "send" && r.kind !== "pay-request")) return null;
  if (typeof r.sats !== "number" || !Number.isSafeInteger(r.sats) || r.sats <= 0) return null;
  if (!isInterval(r.every) || !isTime(r.nextDue)) return null;
  const note = typeof r.note === "string" ? [...r.note].slice(0, MAX_NOTE_CHARS).join("") : undefined;
  return { id: r.id, peer: r.peer, kind: r.kind, sats: r.sats, every: r.every, nextDue: r.nextDue, ...(note ? { note } : {}) };
}

export function parseBackup(json: string): ChatBackup | null {
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch {
    return null;
  }
  if (typeof raw !== "object" || raw === null) return null;
  const r = raw as Record<string, unknown>;
  if (r.v !== 1 || !Array.isArray(r.contacts) || !Array.isArray(r.schedules) || !isTime(r.schedulesAt)) return null;
  const contacts = r.contacts.map(parseContact).filter((c): c is BackupContact => c !== null);
  const schedules = r.schedules.map(parseSchedule).filter((s): s is BackupSchedule => s !== null).slice(0, MAX_SCHEDULES);
  return { v: 1, contacts, schedules, schedulesAt: r.schedulesAt };
}

// What gets stored: the people the user chose (accepted or blocked), never a
// stranger merely waiting in Žádosti.
export function buildBackup(
  contacts: readonly (BackupContact & { address?: string })[],
  schedules: readonly BackupSchedule[],
  schedulesAt: number,
): ChatBackup {
  const keep = (c: BackupContact): BackupContact => ({
    pubkey: c.pubkey,
    accepted: c.accepted,
    updatedAt: c.updatedAt,
    ...(c.name ? { name: c.name } : {}),
    ...(c.blocked ? { blocked: true } : {}),
    ...(c.verified ? { verified: true } : {}),
  });
  const accepted = contacts.filter((c) => c.accepted && !c.blocked).map(keep);
  let blocked = contacts
    .filter((c) => c.blocked)
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .slice(0, MAX_BLOCKED)
    .map(keep);
  const kept = schedules.slice(0, MAX_SCHEDULES).map((s) => parseSchedule(s)).filter((s): s is BackupSchedule => s !== null);
  let backup: ChatBackup = { v: 1, contacts: [...accepted, ...blocked], schedules: kept, schedulesAt };
  while (JSON.stringify(backup).length > MAX_JSON_CHARS && blocked.length > 0) {
    blocked = blocked.slice(0, Math.floor(blocked.length / 2));
    backup = { ...backup, contacts: [...accepted, ...blocked] };
  }
  while (JSON.stringify(backup).length > MAX_JSON_CHARS && backup.contacts.length > 0) {
    backup = { ...backup, contacts: backup.contacts.slice(0, Math.floor(backup.contacts.length * 0.9)) };
  }
  // A fixed order, so an unchanged state serializes to the same text and the
  // caller can skip a write that would change nothing.
  return { ...backup, contacts: [...backup.contacts].sort((x, y) => (x.pubkey < y.pubkey ? -1 : 1)) };
}

export interface MergeContact extends Omit<BackupContact, "updatedAt"> {
  updatedAt?: number;
  address?: string;
  keyChanged?: boolean;
}

// Per contact, the newer edit wins; local fields the backup does not carry
// stay, except an address whose name the backup changed. Schedules are one
// list, the newer list wins. `needsAddress` are the contacts to look up again.
export function mergeBackup(
  local: Readonly<Record<string, MergeContact>>,
  localSchedules: readonly BackupSchedule[],
  localSchedulesAt: number,
  remote: ChatBackup,
): {
  contacts: Record<string, MergeContact>;
  schedules: BackupSchedule[];
  schedulesAt: number;
  needsAddress: { pubkey: string; name: string }[];
} {
  const contacts: Record<string, MergeContact> = { ...local };
  const needsAddress: { pubkey: string; name: string }[] = [];
  for (const r of remote.contacts) {
    const l = local[r.pubkey];
    if (l && (l.updatedAt ?? 0) >= r.updatedAt) continue;
    const sameName = l?.name !== undefined && l.name === r.name;
    const next: MergeContact = {
      ...(l ?? {}),
      pubkey: r.pubkey,
      accepted: r.accepted,
      updatedAt: r.updatedAt,
      name: r.name,
      blocked: r.blocked,
      verified: r.verified,
      address: sameName ? l?.address : undefined,
    };
    if (!next.name) delete next.name;
    if (!next.blocked) delete next.blocked;
    if (!next.verified) delete next.verified;
    if (!next.address) delete next.address;
    contacts[r.pubkey] = next;
    if (next.name && !next.address && next.accepted) needsAddress.push({ pubkey: r.pubkey, name: next.name });
  }
  const remoteWins = remote.schedulesAt > localSchedulesAt;
  return {
    contacts,
    schedules: remoteWins ? remote.schedules.map((s) => ({ ...s })) : [...localSchedules],
    schedulesAt: remoteWins ? remote.schedulesAt : localSchedulesAt,
    needsAddress,
  };
}
