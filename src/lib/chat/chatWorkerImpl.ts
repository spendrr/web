// The chat worker proper: holds the session's chat key, keeps one WebSocket per
// relay, publishes gift wraps and unwraps what arrives for us. The main thread
// only ever sees decrypted rumors (already authenticated by their seal) and
// results; the key stays here and is zeroed on lock.
import { schnorr } from "@noble/curves/secp256k1.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import type { ChatEvent, ChatRequest } from "./chatProtocol";
import {
  KIND_CHAT,
  KIND_DM_RELAYS,
  KIND_EPHEMERAL_WRAP,
  KIND_PROFILE,
  KIND_GIFT_WRAP,
  KIND_REACTION,
  conversationKey,
  eventId,
  giftWrap,
  isRumorShape,
  makeRumor,
  nip44Decrypt,
  nip44Encrypt,
  publicKeyOf,
  signEvent,
  unwrapGift,
  verifyEvent,
  isPublicKeyHex,
  type NostrEvent,
  type Rumor,
} from "./nostr";
import { MAX_PROFILE_JSON_CHARS } from "./profile";
import { CHAT_BIND_PREFIX, CHAT_EXTRA_RELAYS, CHAT_INDEX_RELAYS, CHAT_RELAYS, dmRelaysFromTags } from "./relays";
import { KIND_SIGNAL } from "./signals";
import { KIND_PUSH_CONTROL } from "./pushFormat";

const SUB_ID = "spendrr-dm";
const SELF_SUB_ID = "spendrr-self";
const LIVE_SUB_ID = "spendrr-live";
// The same signal reaches us from every relay; these ids are short-lived, so
// a small window is enough to drop the copies.
const LIVE_SEEN_MAX = 300;
// NIP-78 application data: one replaceable event per identity holding the
// contacts and schedules, encrypted to ourselves (chatBackup.ts).
const KIND_APP_DATA = 30078;
const STATE_D_TAG = "spendrr-chat-state-v1";
const MAX_STATE_CHARS = 120_000;
const KIND_RELAY_AUTH = 22242;
const PUBLISH_TIMEOUT_MS = 8000;
const MAX_BACKOFF_MS = 30_000;
const SEEN_MAX = 5000;

let secretKey: Uint8Array | null = null;
let myPubkey = "";
let since = 0;
// created_at of the newest state event seen or written. Replaceable events are
// ordered by it, so a write must be newer than anything a relay holds.
let stateAt = 0;
const seen = new Set<string>();
const liveSeen = new Set<string>();

function post(e: ChatEvent): void {
  self.postMessage(e);
}

// `targets` get the event; it counts as published once one of `required` has it
// (for a contact's message: a relay they read, not just one of ours).
type PendingPublish = {
  event: NostrEvent;
  targets: Set<string>;
  required: Set<string>;
  acks: Set<string>;
  resolve: (n: number) => void;
  timer: number;
};
const pendingPublishes = new Map<string, PendingPublish>();

class RelayConnection {
  private socket: WebSocket | null = null;
  private backoff = 1000;
  private closedForGood = false;
  open = false;
  private authRequired = false;
  private authed = false;
  selfEose = false;
  readonly url: string;
  // A relay we listen on all session (reconnecting, subscribed) or one opened
  // on demand to publish to a contact's inbox or look up their relay list.
  private readonly persistent: boolean;
  private waiters: Array<(ok: boolean) => void> = [];

  constructor(url: string, persistent = true) {
    this.url = url;
    this.persistent = persistent;
  }

  // Resolves true once the socket is open (connecting it if needed), false
  // after `ms` or when it closes first.
  opened(ms: number): Promise<boolean> {
    if (this.open) return Promise.resolve(true);
    this.connect();
    return new Promise((resolve) => {
      const done = (ok: boolean) => {
        clearTimeout(timer);
        this.waiters = this.waiters.filter((w) => w !== done);
        resolve(ok);
      };
      const timer = setTimeout(() => done(false), ms);
      this.waiters.push(done);
    });
  }

  private flushWaiters(ok: boolean): void {
    for (const w of [...this.waiters]) w(ok);
  }

  private resendPending(): void {
    for (const p of pendingPublishes.values()) {
      if (p.targets.has(this.url) && !p.acks.has(this.url)) this.send(["EVENT", p.event]);
    }
  }

  connect(): void {
    if (this.closedForGood || this.socket) return;
    let ws: WebSocket;
    try {
      ws = new WebSocket(this.url);
    } catch (e) {
      console.error(`[chat.worker] ${this.url}`, e);
      this.scheduleReconnect();
      return;
    }
    this.socket = ws;
    ws.onopen = () => {
      this.open = true;
      this.backoff = 1000;
      this.authed = false;
      this.authRequired = false;
      this.selfEose = false;
      if (this.persistent) {
        reportRelays();
        this.subscribe();
      }
      this.resendPending();
      this.flushWaiters(true);
    };
    ws.onmessage = (m) => this.onMessage(m.data);
    ws.onclose = () => {
      this.open = false;
      this.socket = null;
      this.flushWaiters(false);
      if (this.persistent) {
        reportRelays();
        this.scheduleReconnect();
      }
    };
    ws.onerror = () => {
      // onclose follows and handles the retry.
    };
  }

  private scheduleReconnect(): void {
    if (this.closedForGood || !this.persistent) {
      this.flushWaiters(false);
      return;
    }
    const delay = this.backoff;
    this.backoff = Math.min(this.backoff * 2, MAX_BACKOFF_MS);
    setTimeout(() => this.connect(), delay);
  }

  send(frame: unknown[]): void {
    if (this.open && this.socket) this.socket.send(JSON.stringify(frame));
  }

  close(): void {
    this.closedForGood = true;
    this.socket?.close();
  }

  // NIP-42: proves to the relay that we hold the key our gift wraps are
  // addressed to, which some relays require before they serve kind 1059. It
  // signs only the relay URL and its challenge, nothing a message depends on.
  private authenticate(challenge: string): void {
    if (!secretKey) return;
    const event = signEvent(
      {
        kind: KIND_RELAY_AUTH,
        created_at: Math.floor(Date.now() / 1000),
        tags: [
          ["relay", this.url],
          ["challenge", challenge],
        ],
        content: "",
      },
      secretKey,
    );
    this.send(["AUTH", event]);
    this.authed = true;
    // What the relay refused before we proved who we are goes out again.
    this.resendPending();
    if (this.authRequired) {
      this.authRequired = false;
      this.subscribe();
    }
  }

  private subscribe(): void {
    if (!this.persistent) return;
    this.send(["REQ", SUB_ID, { kinds: [KIND_GIFT_WRAP], "#p": [myPubkey], since }]);
    this.send(["REQ", SELF_SUB_ID, { kinds: [KIND_APP_DATA], authors: [myPubkey], "#d": [STATE_D_TAG], limit: 3 }]);
    // Live only: anything older than a moment ago is no longer true.
    this.send(["REQ", LIVE_SUB_ID, { kinds: [KIND_EPHEMERAL_WRAP], "#p": [myPubkey], since: Math.floor(Date.now() / 1000) - 30 }]);
  }

  private onMessage(data: unknown): void {
    if (typeof data !== "string" || data.length > 200_000) return;
    let frame: unknown;
    try {
      frame = JSON.parse(data);
    } catch {
      return;
    }
    if (!Array.isArray(frame)) return;
    if (typeof frame[1] === "string" && frame[1].startsWith(LOOKUP_PREFIX)) lookups.get(frame[1])?.(this.url, frame);
    else if (frame[0] === "EVENT" && frame[1] === SUB_ID) onWrap(frame[2]);
    else if (frame[0] === "EVENT" && frame[1] === SELF_SUB_ID) onSelfState(frame[2]);
    else if (frame[0] === "EVENT" && frame[1] === LIVE_SUB_ID) onLiveWrap(frame[2]);
    else if (frame[0] === "EOSE" && frame[1] === SELF_SUB_ID) {
      this.selfEose = true;
      maybeSelfSynced();
    }
    else if (frame[0] === "AUTH" && typeof frame[1] === "string" && frame[1].length <= 512) this.authenticate(frame[1]);
    else if (frame[0] === "CLOSED" && frame[1] === SUB_ID && typeof frame[2] === "string" && frame[2].startsWith("auth-required")) {
      // The relay refused the subscription until we authenticate. Its AUTH
      // challenge may have come first (resubscribe now) or is still to come
      // (authenticate() resubscribes).
      if (this.authed) this.subscribe();
      else this.authRequired = true;
    }
    else if (frame[0] === "OK" && typeof frame[1] === "string") {
      const p = pendingPublishes.get(frame[1]);
      if (p && frame[2] === true) {
        p.acks.add(this.url);
        const n = requiredAcks(p);
        if (n > 0) p.resolve(n);
      }
    }
  }
}

const relays = CHAT_RELAYS.map((url) => new RelayConnection(url));
const coreUrls = relays.map((r) => r.url);
const extraRelays = new Map(CHAT_EXTRA_RELAYS.map((url) => [url, new RelayConnection(url, false)]));

function connectionFor(url: string): RelayConnection | undefined {
  return relays.find((r) => r.url === url) ?? extraRelays.get(url);
}

function requiredAcks(p: PendingPublish): number {
  let n = 0;
  for (const u of p.required) if (p.acks.has(u)) n++;
  return n;
}

// Opens the relays among `urls` that are not yet open; the ones that do not
// answer in time are simply left out of what gets the event now.
async function ensureOpen(urls: readonly string[]): Promise<void> {
  await Promise.all(urls.map((u) => connectionFor(u)?.opened(OPEN_TIMEOUT_MS)));
}

// Lookups of a contact's kind 10050 run as one-shot subscriptions whose ids
// carry this prefix; replies are routed to the lookup that asked.
const LOOKUP_PREFIX = "spendrr-dmr-";
const lookups = new Map<string, (url: string, frame: unknown[]) => void>();
const OPEN_TIMEOUT_MS = 4000;
const LOOKUP_TIMEOUT_MS = 5000;
const DM_RELAYS_TTL_MS = 60 * 60 * 1000;
const DM_RELAYS_MISS_TTL_MS = 5 * 60 * 1000;
const DM_RELAYS_CACHE_MAX = 500;
const dmRelaysCache = new Map<string, { at: number; urls: string[] }>();

// The newest event of `kind` by `pubkey`, asked of the indexers and the chat
// relays that are open; null when none answered in time or none has one.
async function newestEvent(pubkey: string, kind: number): Promise<NostrEvent | null> {
  await ensureOpen(CHAT_INDEX_RELAYS);
  const asked = [...relays, ...CHAT_INDEX_RELAYS.map((u) => extraRelays.get(u)!)].filter((r) => r.open);
  if (asked.length === 0) return null;
  const subId = LOOKUP_PREFIX + bytesToHex(crypto.getRandomValues(new Uint8Array(6)));
  let newest: NostrEvent | null = null;
  await new Promise<void>((resolve) => {
    const pending = new Set(asked.map((r) => r.url));
    const finish = () => {
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(finish, LOOKUP_TIMEOUT_MS);
    lookups.set(subId, (url, frame) => {
      if (frame[0] === "EVENT") {
        const e = frame[2];
        if (verifyEvent(e) && e.kind === kind && e.pubkey === pubkey && (!newest || e.created_at > newest.created_at)) newest = e;
      } else if (frame[0] === "EOSE" || frame[0] === "CLOSED") {
        pending.delete(url);
        if (pending.size === 0) finish();
      }
    });
    for (const r of asked) r.send(["REQ", subId, { kinds: [kind], authors: [pubkey], limit: 1 }]);
  });
  lookups.delete(subId);
  for (const r of asked) r.send(["CLOSE", subId]);
  return newest;
}

// The relays a contact reads their DMs from (their kind 10050), restricted to
// the ones we may use. Empty when they publish none, none we know, or no relay
// answered.
async function theirRelays(pubkey: string): Promise<string[]> {
  const hit = dmRelaysCache.get(pubkey);
  if (hit && Date.now() - hit.at < (hit.urls.length ? DM_RELAYS_TTL_MS : DM_RELAYS_MISS_TTL_MS)) return hit.urls;
  const event = await newestEvent(pubkey, KIND_DM_RELAYS);
  const urls = event ? dmRelaysFromTags(event.tags) : [];
  dmRelaysCache.set(pubkey, { at: Date.now(), urls });
  if (dmRelaysCache.size > DM_RELAYS_CACHE_MAX) dmRelaysCache.delete(dmRelaysCache.keys().next().value as string);
  return urls;
}

// The content of a contact's kind 0 profile (the main thread reads the name out
// of it, profile.ts); only its size is checked here.
const profileCache = new Map<string, { at: number; content: string | null }>();

async function profileContent(pubkey: string): Promise<string | null> {
  if (!isPublicKeyHex(pubkey)) throw new Error("bad pubkey");
  const hit = profileCache.get(pubkey);
  if (hit && Date.now() - hit.at < (hit.content ? DM_RELAYS_TTL_MS : DM_RELAYS_MISS_TTL_MS)) return hit.content;
  const event = await newestEvent(pubkey, KIND_PROFILE);
  const content = event && event.content.length <= MAX_PROFILE_JSON_CHARS ? event.content : null;
  profileCache.set(pubkey, { at: Date.now(), content });
  if (profileCache.size > DM_RELAYS_CACHE_MAX) profileCache.delete(profileCache.keys().next().value as string);
  return content;
}

function reportRelays(): void {
  post({ type: "relays", connected: relays.filter((r) => r.open).length, total: relays.length });
}

function onWrap(event: unknown): void {
  if (!secretKey || typeof event !== "object" || event === null) return;
  const id = (event as { id?: unknown }).id;
  if (typeof id !== "string" || seen.has(id)) return;
  // Remembered only once the wrap verifies: a relay replaying a real wrap's id
  // with a junk signature first must not get the genuine copy from another
  // relay dropped as a duplicate.
  if (!verifyEvent(event) || event.kind !== KIND_GIFT_WRAP) return;
  seen.add(id);
  if (seen.size > SEEN_MAX) seen.delete(seen.values().next().value as string);
  try {
    const rumor = unwrapGift(event, secretKey);
    if (rumor.kind === KIND_PUSH_CONTROL) {
      if (rumor.pubkey !== myPubkey) post({ type: "control", from: rumor.pubkey, content: rumor.content, createdAt: rumor.created_at });
      return;
    }
    if (rumor.kind !== KIND_CHAT && rumor.kind !== KIND_REACTION) return;
    post({ type: "rumor", rumor });
  } catch {
    // Not for us, or forged: dropped silently, there is nobody to tell.
  }
}

// The main thread may write the state only after the relays had the chance to
// hand back the stored one: on a fresh device an early write of a near empty
// state would replace the real one. Once every open relay answered (or one did
// and a while passed), the stored state, if any, has been seen.
let selfSynced = false;
const SELF_SYNC_FALLBACK_MS = 15_000;

function maybeSelfSynced(force = false): void {
  if (selfSynced) return;
  const open = relays.filter((r) => r.open);
  const answered = open.filter((r) => r.selfEose);
  if (answered.length === 0) return;
  if (!force && answered.length < open.length) return;
  selfSynced = true;
  post({ type: "selfSynced" });
}

function onLiveWrap(event: unknown): void {
  if (!secretKey || typeof event !== "object" || event === null) return;
  const id = (event as { id?: unknown }).id;
  if (typeof id !== "string" || liveSeen.has(id)) return;
  if (!verifyEvent(event) || event.kind !== KIND_EPHEMERAL_WRAP) return;
  liveSeen.add(id);
  if (liveSeen.size > LIVE_SEEN_MAX) liveSeen.delete(liveSeen.values().next().value as string);
  try {
    const rumor = unwrapGift(event, secretKey);
    if (rumor.kind !== KIND_SIGNAL || rumor.pubkey === myPubkey) return;
    post({ type: "signal", from: rumor.pubkey, content: rumor.content, createdAt: rumor.created_at });
  } catch {
    // Not for us, or forged.
  }
}

// No acknowledgement and no retry: a signal is only worth anything now.
function sendSignal(to: string, content: string): void {
  if (!secretKey || !isPublicKeyHex(to) || content.length > 200) return;
  const rumor = makeRumor(myPubkey, KIND_SIGNAL, content, [["p", to]]);
  const wrap = giftWrap(rumor, secretKey, to, KIND_EPHEMERAL_WRAP);
  for (const r of relays) r.send(["EVENT", wrap]);
}

// Our own state event: signed by our key (so no relay can forge one), and
// passed on only when newer than what this session already has.
function onSelfState(event: unknown): void {
  if (!secretKey || !verifyEvent(event)) return;
  if (event.kind !== KIND_APP_DATA || event.pubkey !== myPubkey) return;
  if (!event.tags.some((t) => t[0] === "d" && t[1] === STATE_D_TAG)) return;
  if (event.created_at <= stateAt || event.content.length > MAX_STATE_CHARS) return;
  try {
    const json = nip44Decrypt(event.content, conversationKey(secretKey, myPubkey));
    stateAt = event.created_at;
    post({ type: "selfState", json, createdAt: event.created_at });
  } catch {
    // Not decryptable with our key: ignored.
  }
}

async function saveState(json: string): Promise<unknown> {
  if (!secretKey) throw new Error("locked");
  const createdAt = Math.max(Math.floor(Date.now() / 1000), stateAt + 1);
  const event = signEvent(
    {
      kind: KIND_APP_DATA,
      created_at: createdAt,
      tags: [["d", STATE_D_TAG]],
      content: nip44Encrypt(json, conversationKey(secretKey, myPubkey)),
    },
    secretKey,
  );
  stateAt = createdAt;
  const accepted = await publish(event);
  if (accepted === 0) throw new Error("no relay accepted the state");
  return { relays: accepted };
}

// Resolves as soon as one relay accepts the event (0 after the timeout). The
// entry stays until the timeout either way, so a relay that connects late
// still gets it on open.
function publish(event: NostrEvent, targets: readonly string[] = coreUrls, required: readonly string[] = targets): Promise<number> {
  return new Promise((resolve) => {
    let resolved = false;
    const entry: PendingPublish = {
      event,
      targets: new Set(targets),
      required: new Set(required),
      acks: new Set(),
      resolve: (n) => {
        if (resolved) return;
        resolved = true;
        resolve(n);
      },
      timer: setTimeout(() => {
        pendingPublishes.delete(event.id);
        entry.resolve(requiredAcks(entry));
      }, PUBLISH_TIMEOUT_MS) as unknown as number,
    };
    pendingPublishes.set(event.id, entry);
    for (const u of targets) connectionFor(u)?.send(["EVENT", event]);
  });
}

function recipientOf(rumor: Rumor): string | null {
  const to = rumor.tags.find((t) => t[0] === "p")?.[1];
  return isPublicKeyHex(to) ? to : null;
}

async function deliver(rumor: Rumor): Promise<unknown> {
  if (!secretKey) throw new Error("locked");
  const to = recipientOf(rumor);
  if (!to) throw new Error("bad recipient");
  // Their relays when we know them (a Nostr client's NIP-17 inbox), else ours.
  // The message counts as sent once a relay they read has it; ours get it too,
  // so it also reaches them if they read from one of those.
  const theirs = to === myPubkey ? [] : await theirRelays(to);
  const required = theirs.length > 0 ? theirs : coreUrls;
  const targets = [...new Set([...coreUrls, ...required])];
  await ensureOpen(targets.filter((u) => !coreUrls.includes(u)));
  const toThem = await publish(giftWrap(rumor, secretKey, to), targets, required);
  if (toThem === 0) throw new Error("no relay accepted the message");
  // The copy to ourselves (what puts the message on our other devices) goes
  // out only once theirs was accepted. Sent alongside, it would come back
  // through our own subscription and show as sent a message they never got.
  if (secretKey && to !== myPubkey) void publish(giftWrap(rumor, secretKey, myPubkey));
  return { id: rumor.id, relays: toThem };
}

function send(reqId: number, to: string, kind: number, content: string, tags: string[][]): Promise<unknown> {
  if (!secretKey) return Promise.reject(new Error("locked"));
  if (!isPublicKeyHex(to)) return Promise.reject(new Error("bad recipient"));
  if (kind !== KIND_CHAT && kind !== KIND_REACTION) return Promise.reject(new Error("bad kind"));
  const rumor = makeRumor(myPubkey, kind, content, [["p", to], ...tags]);
  post({ type: "rumor", rumor, sendReq: reqId });
  return deliver(rumor);
}

// A push control message (pushFormat.ts) in an ordinary gift wrap, so it waits
// on the relays for a recipient who is offline. No copy to ourselves: it only
// matters to the recipient.
async function sendControl(to: string, content: string): Promise<unknown> {
  if (!secretKey) throw new Error("locked");
  if (!isPublicKeyHex(to) || to === myPubkey || content.length > 2000) throw new Error("bad control");
  const rumor = makeRumor(myPubkey, KIND_PUSH_CONTROL, content, [["p", to]]);
  const acks = await publish(giftWrap(rumor, secretKey, to));
  if (acks === 0) throw new Error("no relay accepted the message");
  return acks;
}

// Only our own chat rumors, intact: the main thread could otherwise get this
// realm to wrap and sign anything under our name.
function resend(rumor: unknown): Promise<unknown> {
  const kindOk = isRumorShape(rumor) && (rumor.kind === KIND_CHAT || rumor.kind === KIND_REACTION);
  if (!kindOk || rumor.pubkey !== myPubkey || eventId(rumor) !== rumor.id) {
    return Promise.reject(new Error("bad rumor"));
  }
  return deliver(rumor);
}

function settle(reqId: number, work: Promise<unknown>): void {
  work.then(
    (value) => post({ type: "result", reqId, ok: true, value }),
    (e: unknown) => post({ type: "result", reqId, ok: false, error: String((e as Error)?.message ?? e) }),
  );
}

function bindProof(mailboxId: string): string {
  if (!secretKey) throw new Error("locked");
  if (!/^[0-9a-f]{66}$/.test(mailboxId)) throw new Error("bad mailbox id");
  const digest = sha256(new TextEncoder().encode(CHAT_BIND_PREFIX + mailboxId));
  return bytesToHex(schnorr.sign(digest, secretKey));
}

// The key for the chat's storage on this device. Its own versioned info
// string: changing it in place would make every stored conversation
// unreadable. Not extractable, so even the main thread, which uses it, cannot
// read it out.
const STORE_KEY_INFO = "spendrr-chat-store-v1";

async function deriveStoreKey(secret: Uint8Array): Promise<CryptoKey> {
  const base = await crypto.subtle.importKey("raw", secret as BufferSource, "HKDF", false, ["deriveKey"]);
  return crypto.subtle.deriveKey(
    { name: "HKDF", hash: "SHA-256", salt: new Uint8Array(0), info: new TextEncoder().encode(STORE_KEY_INFO) },
    base,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}

async function start(key: Uint8Array): Promise<void> {
  secretKey = key;
  myPubkey = publicKeyOf(key);
  let storeKey: CryptoKey;
  try {
    storeKey = await deriveStoreKey(key);
  } catch {
    post({ type: "error", error: "store key" });
    return;
  }
  post({ type: "ready", pubkey: myPubkey, storeKey });
  for (const r of relays) r.connect();
  setTimeout(() => maybeSelfSynced(true), SELF_SYNC_FALLBACK_MS);
  // NIP-17: where other clients should deliver our DMs.
  for (const u of CHAT_INDEX_RELAYS) void connectionFor(u)?.opened(OPEN_TIMEOUT_MS);
  void publish(
    signEvent(
      {
        kind: KIND_DM_RELAYS,
        created_at: Math.floor(Date.now() / 1000),
        tags: CHAT_RELAYS.map((r) => ["relay", r]),
        content: "",
      },
      key,
    ),
    [...coreUrls, ...CHAT_INDEX_RELAYS],
    coreUrls,
  );
}

export function handleChatRequest(req: ChatRequest): void {
  switch (req.type) {
    case "init": {
      since = Number.isSafeInteger(req.since) && req.since > 0 ? req.since : 0;
      req.keyPort.onmessage = (e: MessageEvent<unknown>) => {
        req.keyPort.close();
        if (secretKey) return;
        if (e.data instanceof Uint8Array && e.data.length === 32) void start(e.data);
        else post({ type: "error", error: "bad key" });
      };
      return;
    }
    case "send":
      settle(req.reqId, send(req.reqId, req.to, req.kind, req.content, req.tags));
      return;
    case "resend":
      settle(req.reqId, resend(req.rumor));
      return;
    case "saveState":
      settle(req.reqId, typeof req.json === "string" ? saveState(req.json) : Promise.reject(new Error("bad state")));
      return;
    case "bindProof":
      try {
        post({ type: "result", reqId: req.reqId, ok: true, value: bindProof(req.mailboxId) });
      } catch (e) {
        post({ type: "result", reqId: req.reqId, ok: false, error: String((e as Error)?.message ?? e) });
      }
      return;
    case "signal":
      sendSignal(req.to, req.content);
      return;
    case "control":
      settle(req.reqId, typeof req.content === "string" ? sendControl(req.to, req.content) : Promise.reject(new Error("bad control")));
      return;
    case "profile":
      settle(req.reqId, profileContent(req.pubkey));
      return;
    case "lock":
      secretKey?.fill(0);
      secretKey = null;
      for (const r of relays) r.close();
      for (const r of extraRelays.values()) r.close();
      return;
  }
}
