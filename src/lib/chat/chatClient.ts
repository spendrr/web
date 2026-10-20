// Main-thread side of the money chat (beta): starts the chat worker, gets it
// the chat key straight from the wallet worker, keeps the message history and
// contacts, and publishes the key behind the user's @name. The chat key never
// comes here: what arrives is already decrypted and authenticated. The one key
// this realm holds is the store key (not extractable, chatStore.ts), for
// sealing what the chat keeps on this device.
import { useSyncExternalStore } from "react";
import { deliverChatKey, type WalletClient } from "../wallet/bark";
import { checkHandle } from "../names/handle";
import { parseNostrPubkey } from "./npub";
import { profileNameFrom } from "./profile";
import { fetchMyName, lookupName, publishChatPubkey } from "../names/names";
import { buildBackup, mergeBackup, parseBackup } from "./chatBackup";
import { isReadReceiptsOn } from "./chatEnabled";
import { parseSignal, signalContent, type Signal } from "./signals";
import { isSealed, open, seal } from "./chatStore";
import type { ChatEvent, ChatRequest } from "./chatProtocol";
import {
  clampText,
  fallbackText,
  messageFromRumor,
  isInterval,
  payloadTags,
  reactionTags,
  replyTags,
  type Interval,
  type Payload,
} from "./messages";
import { KIND_CHAT, KIND_REACTION, type Rumor } from "./nostr";
import { nextDue } from "./recurrence";

// Rides on every outgoing message so the recipient can show who wrote, after
// checking that the name's published chat key really is the sender's.
const NAME_TAG = "spendrr-name";
// NIP-59 wraps are back-dated up to two days, so a resubscription has to reach
// that far behind the newest message already seen.
const WRAP_SKEW_S = 2 * 24 * 60 * 60;
const SINCE_KEY = "spendrr-chat-since-v1";

export interface StoredMessage {
  id: string;
  peer: string;
  from: string;
  createdAt: number;
  text: string;
  payload: Payload | null;
  outgoing: boolean;
  // See ChatMessage (messages.ts).
  reactTo?: string;
  replyTo?: string;
  // The @name the sender claims (NAME_TAG), unverified. Kept with the message
  // so a stranger's claim costs nothing until the user opens the request.
  claimedName?: string;
  // Our own message not yet accepted by any relay. While it is pending or
  // failed the rumor is kept, so a retry publishes the very same message.
  delivery?: "sending" | "failed";
  rumor?: Rumor;
}

export interface Contact {
  pubkey: string;
  name?: string;
  address?: string;
  // In the conversation list (we wrote first, paid them, or accepted them);
  // otherwise their messages wait in Žádosti.
  accepted: boolean;
  blocked?: boolean;
  // The name now points at a different chat key than the one we knew.
  keyChanged?: boolean;
  // The user compared the safety code (safety.ts) with this person. Bound to
  // this key: a new key behind the same name is a new, unverified contact.
  verified?: boolean;
  // The name in their Nostr profile (profile.ts), for a contact known only by
  // key. Unverified: shown with a "~", never as an @name. `profileAt` is when
  // it was last asked for, so a person without one is not asked again at once.
  profileName?: string;
  profileAt?: number;
  // When the user's choice about this contact last changed; the backup on the
  // relays merges per contact by it (chatBackup.ts).
  updatedAt?: number;
}

export interface Schedule {
  id: string;
  peer: string;
  kind: "send" | "pay-request";
  sats: number;
  every: Interval;
  nextDue: number;
  note?: string;
}

export interface ChatState {
  status: "off" | "starting" | "ready" | "error";
  error?: string;
  pubkey: string | null;
  myName: string | null;
  relays: { connected: number; total: number };
  // No relay for a while (not just still connecting): the UI says so.
  offline: boolean;
  // What a contact is doing right now (signals.ts), cleared when it stops or
  // goes quiet.
  activity: Record<string, "text" | "amount">;
  // The newest of our messages each contact has read, if they share it and
  // we do too (read receipts are both ways).
  readUpTo: Record<string, number>;
  // The newest message from each contact the user has seen here, for the
  // "Nové zprávy" divider. Stored sealed with the rest: it lists who you talk to.
  peerRead: Record<string, number>;
  messages: StoredMessage[];
  contacts: Record<string, Contact>;
  schedules: Schedule[];
}

let state: ChatState = {
  status: "off",
  pubkey: null,
  myName: null,
  relays: { connected: 0, total: 0 },
  offline: false,
  activity: {},
  readUpTo: {},
  peerRead: {},
  messages: [],
  contacts: {},
  schedules: [],
};
const listeners = new Set<() => void>();

function setState(patch: Partial<ChatState>): void {
  state = { ...state, ...patch };
  for (const l of listeners) l();
}

export function useChat(): ChatState {
  return useSyncExternalStore(
    (cb) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    () => state,
  );
}

// ---- persistence (per chat identity) ----------------------------------------

function lsKey(kind: string, pubkey: string): string {
  return `spendrr-chat-${kind}-v1-${pubkey.slice(0, 16)}`;
}

function readJson<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
}

function writeJson(key: string, value: unknown): void {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // storage blocked or full: the chat keeps working for this session
  }
}

// Everything below that belongs to one chat identity is stored sealed with its
// store key (chatStore.ts). Writes go through one chain, so two saves of the
// same record land in the order they were made.
let storeKey: CryptoKey | null = null;
let storeChain: Promise<void> = Promise.resolve();

function enqueueStore(task: () => Promise<void>): void {
  storeChain = storeChain.then(task).catch((e: unknown) => console.error("[chat] store", e));
}

function writeSealed(kind: string, value: unknown): void {
  const pubkey = state.pubkey;
  const key = storeKey;
  if (!pubkey || !key) return;
  enqueueStore(async () => {
    const sealed = await seal(key, kind, value);
    if (storeKey !== key) return;
    try {
      localStorage.setItem(lsKey(kind, pubkey), JSON.stringify(sealed));
    } catch {
      // storage blocked or full: the chat keeps working for this session
    }
  });
}

// `legacy` is a value still stored in the clear by an earlier version: used,
// and written back sealed by the caller.
async function readSealed<T>(kind: string, pubkey: string, key: CryptoKey, fallback: T): Promise<{ value: T; legacy: boolean }> {
  let parsed: unknown;
  try {
    const raw = localStorage.getItem(lsKey(kind, pubkey));
    if (!raw) return { value: fallback, legacy: false };
    parsed = JSON.parse(raw);
  } catch {
    return { value: fallback, legacy: false };
  }
  if (isSealed(parsed)) return { value: (await open<T>(key, kind, parsed)) ?? fallback, legacy: false };
  return { value: parsed as T, legacy: true };
}

let db: IDBDatabase | null = null;

function openDb(pubkey: string): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(`spendrr-chat-${pubkey.slice(0, 16)}`, 1);
    req.onupgradeneeded = () => req.result.createObjectStore("messages", { keyPath: "id" });
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

// Records are { id, iv, ct }. One that is a whole message in the clear comes
// from an earlier version: it is used and comes back as `legacy` to be sealed.
async function loadMessages(d: IDBDatabase, key: CryptoKey): Promise<{ messages: StoredMessage[]; legacy: StoredMessage[] }> {
  const records = await new Promise<unknown[]>((resolve, reject) => {
    const req = d.transaction("messages").objectStore("messages").getAll();
    req.onsuccess = () => resolve(req.result as unknown[]);
    req.onerror = () => reject(req.error);
  });
  const legacy: StoredMessage[] = [];
  const opened = await Promise.all(
    records.map(async (r) => {
      const rec = r as { id?: unknown } & Partial<StoredMessage>;
      if (typeof rec.id !== "string") return null;
      if (isSealed(rec)) return open<StoredMessage>(key, `msg:${rec.id}`, rec);
      if (typeof rec.text === "string" && typeof rec.peer === "string") {
        legacy.push(rec as StoredMessage);
        return rec as StoredMessage;
      }
      return null;
    }),
  );
  const messages = opened.filter((m): m is StoredMessage => m !== null).sort((a, b) => a.createdAt - b.createdAt);
  return { messages, legacy };
}

function deleteMessage(id: string): void {
  try {
    db?.transaction("messages", "readwrite").objectStore("messages").delete(id);
  } catch (e) {
    console.error("[chat] delete failed", e);
  }
  setState({ messages: state.messages.filter((m) => m.id !== id) });
}

function saveMessage(m: StoredMessage): void {
  const d = db;
  const key = storeKey;
  if (!d || !key) return;
  enqueueStore(async () => {
    const sealed = await seal(key, `msg:${m.id}`, m);
    if (db !== d) return;
    try {
      d.transaction("messages", "readwrite").objectStore("messages").put({ id: m.id, ...sealed });
    } catch (e) {
      console.error("[chat] save failed", e);
    }
  });
}

function sameContact(a: Contact, b: Contact): boolean {
  return a.name === b.name && a.accepted === b.accepted && !!a.blocked === !!b.blocked && !!a.verified === !!b.verified;
}

// `stamp` marks the contacts whose name or choice changed as edited now; a
// merge from the backup keeps the times it brings instead.
function saveContacts(contacts: Record<string, Contact>, stamp = true): void {
  let next = contacts;
  if (stamp) {
    const now = Date.now();
    next = { ...contacts };
    for (const [pk, c] of Object.entries(contacts)) {
      const prev = state.contacts[pk];
      if (!prev || !sameContact(prev, c)) next[pk] = { ...c, updatedAt: now };
    }
  }
  writeSealed("contacts", next);
  setState({ contacts: next });
  scheduleBackup();
  pushHooks?.onContactsChanged();
}

let schedulesAt = 0;

function saveSchedules(schedules: Schedule[], at = Date.now()): void {
  schedulesAt = at;
  writeSealed("schedules", schedules);
  writeSealed("schedules-at", at);
  setState({ schedules });
  scheduleBackup();
}

function updateMessage(id: string, patch: (m: StoredMessage) => StoredMessage): void {
  let changed: StoredMessage | null = null;
  const messages = state.messages.map((m) => {
    if (m.id !== id) return m;
    changed = patch(m);
    return changed;
  });
  if (!changed) return;
  saveMessage(changed);
  setState({ messages });
}

function setDelivered(id: string): void {
  updateMessage(id, (m) => {
    const { delivery: _delivery, rumor: _rumor, ...rest } = m;
    return rest;
  });
}

// ---- backup on the relays (chatBackup.ts) -----------------------------------

// A few seconds of quiet before writing, so accepting three requests in a row
// is one event, not three.
const BACKUP_DELAY_MS = 4000;
let backupTimer: number | null = null;
// Off until the worker says the relays returned the stored state (selfSynced).
let backupAllowed = false;
// The last state written or received, as text: an unchanged state is not
// written again.
let lastBackupJson: string | null = null;
// A state that arrived before onReady finished loading the local one.
let pendingSelfState: string | null = null;

function currentBackupJson(): string {
  const contacts = Object.values(state.contacts).map((c) => ({ ...c, updatedAt: c.updatedAt ?? 0 }));
  return JSON.stringify(buildBackup(contacts, state.schedules, schedulesAt));
}

function scheduleBackup(): void {
  if (!backupAllowed || !worker || state.status !== "ready") return;
  if (backupTimer !== null) window.clearTimeout(backupTimer);
  backupTimer = window.setTimeout(() => {
    backupTimer = null;
    void writeBackup();
  }, BACKUP_DELAY_MS);
}

async function writeBackup(): Promise<void> {
  const json = currentBackupJson();
  if (json === lastBackupJson) return;
  // Nothing chosen yet and nothing stored: no point creating an empty event.
  if (lastBackupJson === null && state.schedules.length === 0 && !Object.values(state.contacts).some((c) => c.accepted || c.blocked)) return;
  try {
    await call({ type: "saveState", reqId: nextReqId++, json });
    lastBackupJson = json;
  } catch (e) {
    console.error("[chat] saving contacts failed", e);
  }
}

function applySelfState(json: string): void {
  const remote = parseBackup(json);
  if (!remote) return;
  const merged = mergeBackup(state.contacts, state.schedules, schedulesAt, remote);
  lastBackupJson = JSON.stringify(buildBackup(remote.contacts, remote.schedules, remote.schedulesAt));
  saveContacts(merged.contacts, false);
  if (merged.schedulesAt !== schedulesAt) saveSchedules(merged.schedules, merged.schedulesAt);
  // Addresses are not in the backup: each restored contact gets its own again
  // from the registry, only if the name still publishes that contact's key.
  for (const c of merged.needsAddress) void verifyClaimedName(c.pubkey, c.name);
}

// ---- push hooks (chatPush.ts) -----------------------------------------------

// Chat push lives in its own module and hears about the chat through these;
// the chat itself works the same with nothing registered.
export interface ChatPushHooks {
  onReady(): void;
  onStop(): void;
  onContactsChanged(): void;
  onControl(from: string, content: string, createdAt: number): void;
  // Something live came from this contact (a message or a signal): they are
  // looking at the chat right now.
  onHeard(peer: string): void;
  // Our message reached a relay.
  onDelivered(message: StoredMessage): void;
}

let pushHooks: ChatPushHooks | null = null;

export function setChatPushHooks(hooks: ChatPushHooks | null): void {
  pushHooks = hooks;
}

export function getChatState(): ChatState {
  return state;
}

// Sealed records of the current identity for chat push. Only a sealed value
// counts: there is no older clear format to migrate.
export async function loadPushRecord<T>(kind: "push-slots" | "push-grants", fallback: T): Promise<T> {
  const pubkey = state.pubkey;
  const key = storeKey;
  if (!pubkey || !key) return fallback;
  try {
    const raw = localStorage.getItem(lsKey(kind, pubkey));
    const parsed: unknown = raw ? JSON.parse(raw) : null;
    if (!isSealed(parsed)) return fallback;
    return (await open<T>(key, kind, parsed)) ?? fallback;
  } catch {
    return fallback;
  }
}

export function savePushRecord(kind: "push-slots" | "push-grants", value: unknown): void {
  writeSealed(kind, value);
}

export async function sendControl(peer: string, content: string): Promise<void> {
  await call({ type: "control", reqId: nextReqId++, to: peer, content });
}

// ---- worker -----------------------------------------------------------------

let worker: Worker | null = null;
let nextReqId = 1;
const pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
let startedFor: WalletClient | null = null;

function call(req: ChatRequest & { reqId: number }): Promise<unknown> {
  return new Promise((resolve, reject) => {
    if (!worker) {
      reject(new Error("chat off"));
      return;
    }
    pending.set(req.reqId, { resolve, reject });
    worker.postMessage(req);
  });
}

function onWorkerEvent(e: ChatEvent): void {
  switch (e.type) {
    case "ready":
      void onReady(e.pubkey, e.storeKey);
      return;
    case "rumor":
      void onRumor(e.rumor, e.sendReq);
      return;
    case "selfState":
      if (state.status === "ready") applySelfState(e.json);
      else pendingSelfState = e.json;
      return;
    case "signal":
      onSignal(e.from, e.content, e.createdAt);
      return;
    case "control":
      if (state.status === "ready") pushHooks?.onControl(e.from, e.content, e.createdAt);
      return;
    case "selfSynced":
      backupAllowed = true;
      scheduleBackup();
      return;
    case "relays":
      setState({ relays: { connected: e.connected, total: e.total } });
      trackOffline(e.connected);
      return;
    case "result": {
      const p = pending.get(e.reqId);
      if (!p) return;
      pending.delete(e.reqId);
      if (e.ok) p.resolve(e.value);
      else p.reject(new Error(e.error));
      return;
    }
    case "error":
      setState({ status: "error", error: e.error });
      return;
  }
}

// Connecting is quiet: a relay that is still opening is not "offline". Only
// when none has been reachable for a while does the UI say so.
const OFFLINE_AFTER_MS = 8000;
let offlineTimer: number | null = null;

function trackOffline(connected: number): void {
  if (connected > 0) {
    if (offlineTimer !== null) window.clearTimeout(offlineTimer);
    offlineTimer = null;
    if (state.offline) setState({ offline: false });
    return;
  }
  if (offlineTimer !== null || state.offline) return;
  offlineTimer = window.setTimeout(() => {
    offlineTimer = null;
    if (worker && state.relays.connected === 0) setState({ offline: true });
  }, OFFLINE_AFTER_MS);
}

// Bumped by every start and stop, so an onReady still awaiting storage
// cannot hand its results to the next session.
let session = 0;

// The old per-browser, unsealed map of who was read up to when (chatRead.ts
// kept it before it moved in here).
const LEGACY_PEER_READ_KEY = "spendrr-chat-peer-read-v1";
// A wallet-to-chat-identity hint an earlier version kept to show stored
// conversations before the key arrived; the key now comes at once.
const LEGACY_IDENTITY_KEY = "spendrr-chat-identity-v1";

async function onReady(pubkey: string, key: CryptoKey): Promise<void> {
  const mine = session;
  storeKey = key;
  const [contactsR, schedulesR, schedulesAtR, readByR, peerReadR] = await Promise.all([
    readSealed<Record<string, Contact>>("contacts", pubkey, key, {}),
    readSealed<Schedule[]>("schedules", pubkey, key, []),
    readSealed<number>("schedules-at", pubkey, key, 0),
    readSealed<Record<string, number>>("read-by", pubkey, key, {}),
    readSealed<Record<string, number>>("peer-read", pubkey, key, {}),
  ]);
  let opened: IDBDatabase | null = null;
  try {
    opened = await openDb(pubkey);
  } catch (e) {
    console.error("[chat] IndexedDB unavailable", e);
  }
  const loaded = opened ? await loadMessages(opened, key) : { messages: [], legacy: [] };
  if (mine !== session) {
    opened?.close();
    return;
  }
  db = opened;
  const contacts = contactsR.value;
  const schedules = schedulesR.value;
  schedulesAt = schedulesAtR.value;
  let peerRead = peerReadR.value;
  let legacyPeerRead = false;
  try {
    const old = localStorage.getItem(LEGACY_PEER_READ_KEY);
    if (old) {
      peerRead = { ...(JSON.parse(old) as Record<string, number>), ...peerRead };
      legacyPeerRead = true;
    }
  } catch {
    // unreadable: the divider just starts fresh
  }
  // A send still pending from an earlier session died with that worker.
  const messages = loaded.messages.map((m) => (m.delivery === "sending" ? { ...m, delivery: "failed" as const } : m));
  knownIds = new Set(messages.map((m) => m.id));
  pendingCounts = new Map();
  for (const m of messages) {
    if (!m.outgoing && !contacts[m.peer]?.accepted) pendingCounts.set(m.peer, (pendingCounts.get(m.peer) ?? 0) + 1);
  }
  const readUpTo = readByR.value;
  setState({ status: "ready", pubkey, contacts, schedules, messages, readUpTo, peerRead });
  // What an earlier version left in the clear is sealed now and the clear
  // copy goes.
  for (const m of loaded.legacy) saveMessage(m);
  if (contactsR.legacy) writeSealed("contacts", contacts);
  if (schedulesR.legacy) writeSealed("schedules", schedules);
  if (schedulesAtR.legacy) writeSealed("schedules-at", schedulesAt);
  if (readByR.legacy) writeSealed("read-by", readUpTo);
  try {
    localStorage.removeItem(LEGACY_IDENTITY_KEY);
  } catch {
    // storage blocked: it stays, unused
  }
  if (peerReadR.legacy || legacyPeerRead) {
    writeSealed("peer-read", peerRead);
    try {
      localStorage.removeItem(LEGACY_PEER_READ_KEY);
    } catch {
      // storage blocked: it stays, unused
    }
  }
  if (pendingSelfState !== null) {
    applySelfState(pendingSelfState);
    pendingSelfState = null;
  }
  scheduleBackup();
  if (startedFor) void ensureNameBinding(startedFor, pubkey);
  pushHooks?.onReady();
}

function peerOf(rumor: Rumor, me: string): string | null {
  if (rumor.pubkey !== me) return rumor.pubkey;
  return rumor.tags.find((t) => t[0] === "p" && typeof t[1] === "string")?.[1] ?? null;
}

// A rumor's created_at is whatever its author wrote. Clamped to the moment it
// arrived (with a little clock slack) before it orders the conversation or
// moves `since`: a single message dated in the future would otherwise make
// every later session subscribe from that future and receive nothing.
const CLOCK_SLACK_S = 5 * 60;

// The ids already stored, so the dedupe is not a scan of every message; the
// messages themselves are merged in batches, so a backfill of hundreds of
// wraps is one sort and one render instead of one per message.
let knownIds = new Set<string>();
let incoming: StoredMessage[] = [];
let flushScheduled = false;

function flushIncoming(): void {
  flushScheduled = false;
  if (incoming.length === 0) return;
  const batch = incoming;
  incoming = [];
  setState({ messages: [...state.messages, ...batch].sort((a, b) => a.createdAt - b.createdAt) });
}

// Strangers (Žádosti) are bounded: anyone can mint keys and write, so without
// limits a flood of them would fill IndexedDB and memory. Past these caps their
// messages are simply not kept. Accepted contacts are not limited.
const MAX_PENDING_SENDERS = 50;
const MAX_PENDING_PER_SENDER = 20;
let pendingCounts = new Map<string, number>();

function admitPending(peer: string): boolean {
  const count = pendingCounts.get(peer) ?? 0;
  if (count === 0 && pendingCounts.size >= MAX_PENDING_SENDERS) return false;
  if (count >= MAX_PENDING_PER_SENDER) return false;
  pendingCounts.set(peer, count + 1);
  return true;
}

// ---- live signals (signals.ts) ----------------------------------------------

// A typing signal is repeated while the user types; without one for this long
// the indicator goes away on its own.
const ACTIVITY_TTL_MS = 6000;
const TYPING_REPEAT_MS = 2500;
const activityTimers = new Map<string, number>();
const lastTypingSent = new Map<string, number>();
const lastReadSent = new Map<string, number>();

function clearActivity(peer: string): void {
  const timer = activityTimers.get(peer);
  if (timer !== undefined) window.clearTimeout(timer);
  activityTimers.delete(peer);
  if (state.activity[peer] === undefined) return;
  const { [peer]: _gone, ...rest } = state.activity;
  setState({ activity: rest });
}

function onSignal(from: string, content: string, createdAt: number): void {
  // Only people in the conversation list; a stranger's "typing" is noise.
  const c = state.contacts[from];
  if (!c?.accepted || c.blocked) return;
  const nowS = Math.floor(Date.now() / 1000);
  if (Math.abs(nowS - createdAt) > 60) return;
  const signal = parseSignal(content);
  if (!signal) return;
  pushHooks?.onHeard(from);
  if (signal.t === "stop") {
    clearActivity(from);
    return;
  }
  if (signal.t === "typing") {
    const prev = activityTimers.get(from);
    if (prev !== undefined) window.clearTimeout(prev);
    activityTimers.set(from, window.setTimeout(() => clearActivity(from), ACTIVITY_TTL_MS));
    if (state.activity[from] !== signal.what) setState({ activity: { ...state.activity, [from]: signal.what } });
    return;
  }
  if (!isReadReceiptsOn()) return;
  // A read mark can only be about something that exists: never ahead of now.
  const upTo = Math.min(signal.upTo, nowS + CLOCK_SLACK_S);
  if ((state.readUpTo[from] ?? 0) >= upTo) return;
  const readUpTo = { ...state.readUpTo, [from]: upTo };
  writeSealed("read-by", readUpTo);
  setState({ readUpTo });
}

function postSignal(peer: string, signal: Signal): void {
  if (!worker || state.status !== "ready") return;
  worker.postMessage({ type: "signal", to: peer, content: signalContent(signal) } satisfies ChatRequest);
}

// Called on every keystroke (or while the pay sheet is open); sends at most
// one signal every couple of seconds per peer and kind.
export function sendTyping(peer: string, what: "text" | "amount"): void {
  const key = `${peer}|${what}`;
  const now = Date.now();
  if (now - (lastTypingSent.get(key) ?? 0) < TYPING_REPEAT_MS) return;
  lastTypingSent.set(key, now);
  postSignal(peer, { t: "typing", what });
}

export function sendTypingStop(peer: string): void {
  const recent = [...lastTypingSent.entries()].some(
    ([k, at]) => k.startsWith(`${peer}|`) && Date.now() - at < ACTIVITY_TTL_MS,
  );
  for (const k of [...lastTypingSent.keys()]) if (k.startsWith(`${peer}|`)) lastTypingSent.delete(k);
  if (recent) postSignal(peer, { t: "stop" });
}

// The conversation is on screen and its newest message from `peer` is
// `upTo`: tell them, if read receipts are on.
export function sendRead(peer: string, upTo: number): void {
  if (!isReadReceiptsOn() || (lastReadSent.get(peer) ?? 0) >= upTo) return;
  lastReadSent.set(peer, upTo);
  postSignal(peer, { t: "read", upTo });
}

export function peerLastRead(peer: string): number {
  return state.peerRead[peer] ?? 0;
}

export function markPeerRead(peer: string, upTo: number): void {
  if ((state.peerRead[peer] ?? 0) >= upTo) return;
  const peerRead = { ...state.peerRead, [peer]: upTo };
  setState({ peerRead });
  writeSealed("peer-read", peerRead);
}

// Our sends in flight: the worker's request id to the message it built.
const sendIds = new Map<number, string>();

async function onRumor(rumor: Rumor, sendReq?: number): Promise<void> {
  const me = state.pubkey;
  if (!me) return;
  const msg = messageFromRumor(rumor);
  const peer = peerOf(rumor, me);
  if (!msg || !peer) return;
  const outgoing = rumor.pubkey === me;
  if (knownIds.has(msg.id)) {
    // Our copy came back from a relay, and the worker sends that copy only
    // after the recipient's was accepted: a send we marked failed (a timeout
    // in an earlier session) did arrive.
    if (outgoing && sendReq === undefined) {
      const known = state.messages.find((m) => m.id === msg.id);
      if (known?.delivery) setDelivered(msg.id);
    }
    return;
  }
  const contact = state.contacts[peer];
  // Nothing from a blocked sender is kept, so spam cannot fill the device.
  if (!outgoing && contact?.blocked) return;
  if (!outgoing && !contact?.accepted && !admitPending(peer)) return;
  knownIds.add(msg.id);
  const nowS = Math.floor(Date.now() / 1000);
  const createdAt = Math.min(msg.createdAt, nowS + CLOCK_SLACK_S);
  const claimed = outgoing ? undefined : rumor.tags.find((t) => t[0] === NAME_TAG)?.[1];
  const claimedName = claimed && checkHandle(claimed).ok ? claimed : undefined;
  // Their message is here: whatever they were typing is done.
  if (!outgoing && !msg.reactTo) clearActivity(peer);
  // A message from the last moments (not a backfill) means they are here.
  if (!outgoing && sendReq === undefined && nowS - createdAt < 120) pushHooks?.onHeard(peer);
  const pending = sendReq !== undefined ? { delivery: "sending" as const, rumor } : {};
  const stored: StoredMessage = { ...msg, createdAt, peer, outgoing, ...(claimedName ? { claimedName } : {}), ...pending };
  saveMessage(stored);
  if (sendReq !== undefined) {
    // Our own message shows at once, not with the next batch.
    sendIds.set(sendReq, msg.id);
    setState({ messages: [...state.messages, stored].sort((a, b) => a.createdAt - b.createdAt) });
  } else {
    incoming.push(stored);
    if (!flushScheduled) {
      flushScheduled = true;
      setTimeout(flushIncoming, 0);
    }
  }
  writeJson(SINCE_KEY, Math.max(readJson<number>(SINCE_KEY, 0), Math.min(createdAt, nowS)));

  // A stranger's claim waits until the user opens the request
  // (verifyContactName); only accepted contacts are checked as messages come.
  if (!outgoing && contact?.accepted && claimedName && claimedName !== contact.name) {
    await verifyClaimedName(peer, claimedName);
  }
}

// Each check is a Worker request (and on a miss a Durable Object request) on
// the Free plan's account-wide budget, and the claim is chosen by whoever
// writes. So a (sender, name) pair is checked at most every few hours, failures
// included, and all checks share a small per-minute allowance.
const NAME_CHECK_TTL_MS = 6 * 60 * 60 * 1000;
const NAME_CHECKS_PER_MINUTE = 10;
const nameChecks = new Map<string, number>();
let checkWindowStart = 0;
let checksInWindow = 0;

function mayCheckName(peer: string, name: string): boolean {
  const now = Date.now();
  const key = `${peer}|${name}`;
  const last = nameChecks.get(key);
  if (last !== undefined && now - last < NAME_CHECK_TTL_MS) return false;
  if (now - checkWindowStart >= 60_000) {
    checkWindowStart = now;
    checksInWindow = 0;
  }
  if (checksInWindow >= NAME_CHECKS_PER_MINUTE) return false;
  checksInWindow++;
  nameChecks.set(key, now);
  if (nameChecks.size > 1000) nameChecks.delete(nameChecks.keys().next().value as string);
  return true;
}

// A name is shown for a sender only when that name's registry record publishes
// exactly the sender's key; anything else stays an unnamed key.
async function verifyClaimedName(peer: string, name: string): Promise<void> {
  if (!mayCheckName(peer, name)) return;
  const found = await lookupName(name);
  if (found.kind !== "found" || found.chatPubkey !== peer) return;
  const c = state.contacts[peer] ?? { pubkey: peer, accepted: false };
  saveContacts({ ...state.contacts, [peer]: { ...c, name: found.name, address: found.address } });
}

// Opening a conversation: a contact restored from the backup has its name but
// no address yet; a request gets the name its newest message claims checked.
export function verifyContactName(peer: string): void {
  const c = state.contacts[peer];
  if (c?.name && !c.address) {
    void verifyClaimedName(peer, c.name);
    return;
  }
  if (c?.name) return;
  const claimed = [...state.messages].reverse().find((m) => m.peer === peer && m.claimedName)?.claimedName;
  if (claimed) void verifyClaimedName(peer, claimed);
}

// Publishes our chat key behind our @name when the registry does not have it
// yet. Without a name there is nothing to publish; chat then only works with
// people we write to first.
// Every check is a mailbox proof, a Worker request, a Durable Object request
// and a call to the Ark server, all on the Free plan's daily budget. So the
// answer is remembered: a bound name is re-checked weekly (moderation, another
// device), no name every few minutes at most (the user may be registering one
// right now), and the profile screen drops the memory when the name changes
// (invalidateChatNameBinding).
const BINDING_KEY = "spendrr-chat-binding-v1";
const BOUND_RECHECK_MS = 7 * 24 * 60 * 60 * 1000;
const UNBOUND_RECHECK_MS = 10 * 60 * 1000;

type Binding = { pubkey: string; name: string | null; checkedAt: number };

// One check at a time: the first open after an unlock asks from both onReady
// and the panel, and two concurrent checks would both pay the full cost.
let bindingInFlight: Promise<void> | null = null;

function ensureNameBinding(wallet: WalletClient, pubkey: string, force = false): Promise<void> {
  if (bindingInFlight) return bindingInFlight;
  bindingInFlight = checkNameBinding(wallet, pubkey, force).finally(() => {
    bindingInFlight = null;
  });
  return bindingInFlight;
}

async function checkNameBinding(wallet: WalletClient, pubkey: string, force: boolean): Promise<void> {
  const cached = readJson<Binding | null>(BINDING_KEY, null);
  if (cached && cached.pubkey === pubkey) {
    setState({ myName: cached.name });
    const age = Date.now() - cached.checkedAt;
    if (!force && age >= 0 && age < (cached.name ? BOUND_RECHECK_MS : UNBOUND_RECHECK_MS)) return;
  }
  try {
    const mine = await fetchMyName(wallet);
    setState({ myName: mine?.name ?? null });
    if (mine && mine.chatPubkey !== pubkey) {
      const result = await publishChatPubkey(wallet, pubkey, async (mailboxId) => {
        const sig = await call({ type: "bindProof", reqId: nextReqId++, mailboxId });
        return sig as string;
      });
      if (!result.ok) {
        console.error("[chat] publishing chat key failed", result.error);
        return;
      }
    }
    writeJson(BINDING_KEY, { pubkey, name: mine?.name ?? null, checkedAt: Date.now() } satisfies Binding);
  } catch (e) {
    console.error("[chat] name binding failed", e);
  }
}

// Opening Zprávy re-checks the binding (within the limits above): a name
// registered after the chat started gets the key behind it without a relock.
export function refreshNameBinding(): void {
  if (startedFor && state.pubkey && state.status === "ready") void ensureNameBinding(startedFor, state.pubkey);
}

// The profile screen claimed, renamed or released the name: the remembered
// binding is stale, check now.
export function invalidateChatNameBinding(): void {
  try {
    localStorage.removeItem(BINDING_KEY);
  } catch {
    // storage blocked: the next check just happens on schedule
  }
  if (startedFor && state.pubkey && state.status === "ready") void ensureNameBinding(startedFor, state.pubkey, true);
}

export async function startChat(wallet: WalletClient): Promise<void> {
  if (worker) return;
  startedFor = wallet;
  setState({ status: "starting", error: undefined });
  session++;
  worker = new Worker(new URL("./chat.worker.ts", import.meta.url), { type: "module" });
  worker.onmessage = (e: MessageEvent<ChatEvent>) => onWorkerEvent(e.data);
  worker.onerror = (e) => setState({ status: "error", error: e.message || "worker error" });
  const channel = new MessageChannel();
  // The identity is not known before the key arrives, so `since` is one value
  // per browser: after a wallet switch the worst case is fetching a little
  // more history than needed, which onRumor dedupes.
  const lastSince = readJson<number>(SINCE_KEY, 0);
  const since = lastSince > 0 ? lastSince - WRAP_SKEW_S : 0;
  worker.postMessage({ type: "init", keyPort: channel.port2, since } satisfies ChatRequest, [channel.port2]);
  try {
    await deliverChatKey(channel.port1);
  } catch (e) {
    setState({ status: "error", error: e instanceof Error ? e.message : String(e) });
    stopChat();
  }
}

export function stopChat(): void {
  pushHooks?.onStop();
  if (worker) {
    worker.postMessage({ type: "lock" } satisfies ChatRequest);
    worker.terminate();
  }
  worker = null;
  startedFor = null;
  db?.close();
  db = null;
  for (const p of pending.values()) p.reject(new Error("chat off"));
  pending.clear();
  knownIds = new Set();
  incoming = [];
  pendingCounts = new Map();
  sendIds.clear();
  for (const timer of activityTimers.values()) window.clearTimeout(timer);
  activityTimers.clear();
  lastTypingSent.clear();
  lastReadSent.clear();
  session++;
  storeKey = null;
  if (offlineTimer !== null) window.clearTimeout(offlineTimer);
  offlineTimer = null;
  if (backupTimer !== null) window.clearTimeout(backupTimer);
  backupTimer = null;
  backupAllowed = false;
  lastBackupJson = null;
  pendingSelfState = null;
  schedulesAt = 0;
  // The next unlock may be another wallet: nothing of this identity may carry
  // over, the @name least of all (it rides on every outgoing message).
  setState({
    status: "off",
    pubkey: null,
    myName: null,
    messages: [],
    contacts: {},
    schedules: [],
    relays: { connected: 0, total: 0 },
    offline: false,
    activity: {},
    readUpTo: {},
    peerRead: {},
  });
}

// ---- actions ----------------------------------------------------------------

// Writing to someone accepts them. The message shows as soon as the worker
// builds it; a relay failure after that marks the bubble (retryMessage), it
// does not throw. Throws only when no message was built at all (chat off).
type SendOptions = { replyTo?: string; reactTo?: string };

async function sendRaw(peer: string, text: string, payload: Payload | null, opts: SendOptions = {}): Promise<void> {
  const reaction = opts.reactTo !== undefined;
  const tags = [
    ...(reaction ? reactionTags(opts.reactTo as string) : [...payloadTags(payload), ...replyTags(opts.replyTo)]),
    ...(state.myName ? [[NAME_TAG, state.myName]] : []),
  ];
  const c = state.contacts[peer];
  if (!c?.accepted) saveContacts({ ...state.contacts, [peer]: { ...(c ?? { pubkey: peer }), accepted: true } });
  const reqId = nextReqId++;
  const content = reaction ? text : clampText(text) || " ";
  try {
    await call({ type: "send", reqId, to: peer, kind: reaction ? KIND_REACTION : KIND_CHAT, content, tags });
    const id = sendIds.get(reqId);
    if (id) {
      setDelivered(id);
      const sent = state.messages.find((m) => m.id === id);
      if (sent && !reaction) pushHooks?.onDelivered(sent);
    }
  } catch (e) {
    const id = sendIds.get(reqId);
    if (!id) throw e;
    // A reaction has no bubble to carry a retry: it just goes away again.
    if (reaction) deleteMessage(id);
    else updateMessage(id, (m) => ({ ...m, delivery: "failed" }));
  } finally {
    sendIds.delete(reqId);
  }
}

export async function retryMessage(id: string): Promise<void> {
  const m = state.messages.find((x) => x.id === id);
  if (!m?.rumor || m.delivery !== "failed") return;
  updateMessage(id, (x) => ({ ...x, delivery: "sending" }));
  try {
    await call({ type: "resend", reqId: nextReqId++, rumor: m.rumor });
    setDelivered(id);
    if (!m.reactTo) pushHooks?.onDelivered(m);
  } catch {
    updateMessage(id, (x) => ({ ...x, delivery: "failed" }));
  }
}

export function sendText(peer: string, text: string, replyTo?: string): Promise<void> {
  return sendRaw(peer, text, null, replyTo ? { replyTo } : {});
}

// "" takes our reaction back (NIP-25 has no removal; other clients may show
// the empty one as a like).
export function sendReaction(peer: string, target: string, emoji: string): Promise<void> {
  return sendRaw(peer, emoji, null, { reactTo: target });
}

export function sendPayload(peer: string, payload: Payload): Promise<void> {
  return sendRaw(peer, fallbackText(payload), payload);
}

export type AddContactResult = { ok: true; contact: Contact } | { ok: false; error: "not-found" | "no-chat" | "network" };

// Starting a conversation by @name: the registry gives the chat key and the
// address. A known contact whose name now points at another key is flagged,
// not silently switched (trust on first use, like namePins.ts for addresses).
export async function addContactByName(name: string): Promise<AddContactResult> {
  const found = await lookupName(name);
  if (found.kind === "error") return { ok: false, error: "network" };
  if (found.kind !== "found") return { ok: false, error: "not-found" };
  if (!found.chatPubkey) return { ok: false, error: "no-chat" };
  const contacts = { ...state.contacts };
  for (const c of Object.values(contacts)) {
    if (c.name === found.name && c.pubkey !== found.chatPubkey) contacts[c.pubkey] = { ...c, keyChanged: true };
  }
  const prev = contacts[found.chatPubkey];
  const contact: Contact = { ...prev, pubkey: found.chatPubkey, name: found.name, address: found.address, accepted: true };
  contacts[found.chatPubkey] = contact;
  saveContacts(contacts);
  return { ok: true, contact };
}

export type AddKeyResult = { ok: true; contact: Contact } | { ok: false; error: "invalid" | "self" };

// Starting a conversation with any Nostr key (npub): there is no registry
// record, so no name and no address. Writing works; paying does not until the
// key is known behind an @name. Messages go to our own relays only.
export function addContactByKey(raw: string): AddKeyResult {
  const pubkey = parseNostrPubkey(raw);
  if (!pubkey) return { ok: false, error: "invalid" };
  if (pubkey === state.pubkey) return { ok: false, error: "self" };
  const prev = state.contacts[pubkey];
  const contact: Contact = { ...prev, pubkey, accepted: true, blocked: false };
  saveContacts({ ...state.contacts, [pubkey]: contact });
  return { ok: true, contact };
}

const PROFILE_RECHECK_MS = 24 * 60 * 60 * 1000;
const profileInFlight = new Set<string>();

// Opening a conversation with someone who has no @name: ask for their Nostr
// profile once a day at most. Only on open, not for every stranger who writes
// to us: each ask tells the indexer relays who we look at.
export async function loadContactProfile(peer: string): Promise<void> {
  const c = state.contacts[peer];
  if (!c || c.name || c.blocked || profileInFlight.has(peer)) return;
  if (c.profileAt !== undefined && Date.now() - c.profileAt < PROFILE_RECHECK_MS) return;
  profileInFlight.add(peer);
  try {
    const content = await call({ type: "profile", reqId: nextReqId++, pubkey: peer });
    const name = profileNameFrom(content);
    const cur = state.contacts[peer];
    if (!cur) return;
    const next: Contact = { ...cur, profileAt: Date.now() };
    if (name) next.profileName = name;
    else delete next.profileName;
    saveContacts({ ...state.contacts, [peer]: next });
  } catch {
    // No relay answered: asked again next time it is opened.
  } finally {
    profileInFlight.delete(peer);
  }
}

export function acceptContact(peer: string): void {
  const c = state.contacts[peer] ?? { pubkey: peer, accepted: false };
  pendingCounts.delete(peer);
  saveContacts({ ...state.contacts, [peer]: { ...c, accepted: true, blocked: false } });
  verifyContactName(peer);
}

export function setContactVerified(peer: string, verified: boolean): void {
  const c = state.contacts[peer];
  if (!c) return;
  const next: Contact = { ...c, verified };
  if (!verified) delete next.verified;
  saveContacts({ ...state.contacts, [peer]: next });
}

export function blockContact(peer: string): void {
  const c = state.contacts[peer] ?? { pubkey: peer, accepted: false };
  pendingCounts.delete(peer);
  saveContacts({ ...state.contacts, [peer]: { ...c, accepted: false, blocked: true } });
}

export function addSchedule(s: Omit<Schedule, "id" | "nextDue">, firstDue: number): Schedule {
  const schedule: Schedule = { ...s, id: crypto.randomUUID(), nextDue: firstDue };
  saveSchedules([...state.schedules, schedule]);
  return schedule;
}

// After a reminder was paid: one step forward, never a backlog of payments for
// the periods nobody opened the app in.
export function markSchedulePaid(id: string, now = Date.now()): void {
  saveSchedules(
    state.schedules.map((s) => {
      if (s.id !== id) return s;
      // Schedules come back from localStorage: a broken interval must not
      // turn into a loop that never ends.
      if (!isInterval(s.every)) return { ...s, nextDue: now + 86_400_000 };
      let due = s.nextDue;
      for (let i = 0; due <= now && i < 10_000; i++) due = nextDue(due, s.every);
      return { ...s, nextDue: Math.max(due, now + 60_000) };
    }),
  );
}

export function removeSchedule(id: string): void {
  saveSchedules(state.schedules.filter((s) => s.id !== id));
}
