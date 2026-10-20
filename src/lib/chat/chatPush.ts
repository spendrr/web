// Chat notifications (docs/chat-push-design.md), both sides of them.
//
// As a recipient: for every accepted contact a slot and a preview key, kept
// sealed with the chat (push-slots) and given to the Service Worker
// (pushSlots.ts); a token from the Worker for each slot; and a grant with the
// token and key sent to the contact inside the chat. Blocking a contact or
// turning notifications off replaces the browser's push subscription, which
// is what makes the tokens already handed out stop working.
//
// As a sender: the grants contacts sent us (push-grants), and after each of
// our messages a poke with a preview encrypted to that contact's key, unless
// the contact is here right now or was poked less than a minute ago.
import {
  getChatState,
  loadPushRecord,
  savePushRecord,
  sendControl,
  setChatPushHooks,
  type StoredMessage,
} from "./chatClient";
import { chatPushPreview, isChatPushOn, onChatPushSettingsChange } from "./chatEnabled";
import {
  b64urlDecode,
  b64urlEncode,
  clampPreviewText,
  controlContent,
  importPreviewKey,
  parseControl,
  pokeDelay,
  previewFor,
  randomSlot,
  sealBlob,
  type PreviewLevel,
  type Preview,
} from "./pushFormat";
import { deleteSlot, hasSlot, markSlotSeen, putSlot, setPreviewLevel, setSlotName } from "./pushSlots";
import { browserPushSubscription, isNotifyEnabled, isPushSupported, notificationPermission, rotatePushSubscription } from "../notifications";

// ---- records -----------------------------------------------------------------

// What we handed one contact. `endpoint` is a hash of the subscription the
// token was made for: a different one means the grant is stale.
type SlotRecord = { slot: string; key: string; sentAt: number; endpoint: string; level: PreviewLevel };

// A contact's grant to us, plus per contact the newest control message
// applied (relays return them in any order), the last counter used, and when
// we last asked for a grant.
type Grant = { token: string; key: string; preview: PreviewLevel };
type Grants = {
  grants: Record<string, Grant>;
  at: Record<string, number>;
  n: Record<string, number>;
  asked: Record<string, number>;
};

const RENEW_AFTER_MS = 30 * 24 * 60 * 60 * 1000;
const ASK_EVERY_MS = 7 * 24 * 60 * 60 * 1000;
// Answering an "ask" costs a Worker request and a message: once an hour per
// contact at most, whatever they send.
const ANSWER_ASK_EVERY_MS = 60 * 60 * 1000;
const SYNC_DELAY_MS = 2000;
const RETRY_AFTER_MS = 5 * 60 * 1000;
const TOKENS_PER_REQUEST = 50;

let slots: Record<string, SlotRecord> = {};
let grants: Grants = { grants: {}, at: {}, n: {}, asked: {} };
let loaded = false;
// Slots known to be in IndexedDB this session, with the name written there.
const written = new Map<string, string | null>();
const asks = new Set<string>();
const answeredAsk = new Map<string, number>();
const lastHeard = new Map<string, number>();
const lastPoke = new Map<string, number>();
const queued = new Map<string, { preview: Preview; count: number; timer: number }>();
const keyCache = new Map<string, Promise<CryptoKey>>();

function saveSlots(): void {
  savePushRecord("push-slots", slots);
}

function saveGrants(): void {
  savePushRecord("push-grants", grants);
}

async function endpointHash(endpoint: string): Promise<string> {
  const d = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(endpoint)));
  return b64urlEncode(d).slice(0, 22);
}

// ---- recipient: grants to our contacts ---------------------------------------

let syncTimer: number | null = null;
let syncing = false;
let syncAgain = false;

function scheduleSync(delay = SYNC_DELAY_MS): void {
  if (!loaded) return;
  if (syncTimer !== null) window.clearTimeout(syncTimer);
  syncTimer = window.setTimeout(() => {
    syncTimer = null;
    void runSync();
  }, delay);
}

async function runSync(): Promise<void> {
  if (syncing) {
    syncAgain = true;
    return;
  }
  syncing = true;
  try {
    await sync();
  } catch (e) {
    console.error("[chat] push sync", e);
    scheduleSync(RETRY_AFTER_MS);
  } finally {
    syncing = false;
    if (syncAgain) {
      syncAgain = false;
      scheduleSync();
    }
  }
}

function nameFor(peer: string, level: PreviewLevel): string | null {
  return level === "none" ? null : (getChatState().contacts[peer]?.name ?? null);
}

async function ensureWritten(rec: SlotRecord, name: string | null): Promise<void> {
  if (!written.has(rec.slot)) {
    if (await hasSlot(rec.slot)) await setSlotName(rec.slot, name);
    else await putSlot(rec.slot, b64urlDecode(rec.key), name);
  } else if (written.get(rec.slot) !== name) {
    await setSlotName(rec.slot, name);
  }
  written.set(rec.slot, name);
}

async function fetchTokens(subscription: PushSubscription, slotIds: string[]): Promise<string[]> {
  const res = await fetch("/api/chat/push/tokens", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ subscription: subscription.toJSON(), slots: slotIds }),
  });
  if (!res.ok) throw new Error(`tokens ${res.status}`);
  const body = (await res.json()) as { tokens?: unknown };
  if (!Array.isArray(body.tokens) || body.tokens.length !== slotIds.length || !body.tokens.every((t) => typeof t === "string")) {
    throw new Error("bad tokens");
  }
  return body.tokens as string[];
}

async function sync(): Promise<void> {
  const chat = getChatState();
  if (!loaded || chat.status !== "ready") return;
  const on = isChatPushOn() && isPushSupported() && notificationPermission() === "granted";
  const level = chatPushPreview();
  const wanted = new Set(Object.values(chat.contacts).filter((c) => c.accepted && !c.blocked).map((c) => c.pubkey));

  // Slots that should no longer exist: their key leaves the Service Worker,
  // and a contact who had a grant hears that it is gone.
  let rotate = false;
  let changed = false;
  for (const [peer, rec] of Object.entries(slots)) {
    if (on && wanted.has(peer)) continue;
    await deleteSlot(rec.slot);
    written.delete(rec.slot);
    if (rec.sentAt > 0) {
      if (on) rotate = true;
      else if (!chat.contacts[peer]?.blocked) await sendControl(peer, controlContent({ t: "revoke" })).catch(() => {});
    }
    delete slots[peer];
    changed = true;
  }
  if (!on) {
    if (changed) saveSlots();
    return;
  }
  await setPreviewLevel(level);

  const subscription = rotate ? await rotatePushSubscription() : await browserPushSubscription();
  if (!subscription) return;
  const endpoint = await endpointHash(subscription.endpoint);
  const now = Date.now();
  const due: string[] = [];
  for (const peer of wanted) {
    let rec = slots[peer];
    if (!rec) {
      rec = { slot: randomSlot(), key: b64urlEncode(crypto.getRandomValues(new Uint8Array(32))), sentAt: 0, endpoint: "", level };
      slots[peer] = rec;
      changed = true;
    }
    await ensureWritten(rec, nameFor(peer, level));
    if (asks.has(peer) || rec.endpoint !== endpoint || rec.level !== level || now - rec.sentAt > RENEW_AFTER_MS) due.push(peer);
  }
  if (changed) saveSlots();

  for (let i = 0; i < due.length; i += TOKENS_PER_REQUEST) {
    const batch = due.slice(i, i + TOKENS_PER_REQUEST);
    const tokens = await fetchTokens(subscription, batch.map((p) => slots[p].slot));
    for (let j = 0; j < batch.length; j++) {
      const peer = batch[j];
      const rec = slots[peer];
      // A contact blocked or a setting changed meanwhile: the next run sorts it out.
      if (!rec || !isChatPushOn()) continue;
      try {
        await sendControl(peer, controlContent({ t: "grant", token: tokens[j], key: rec.key, preview: level }));
      } catch {
        continue;
      }
      slots[peer] = { ...rec, sentAt: Date.now(), endpoint, level };
      asks.delete(peer);
      saveSlots();
    }
  }
}

// Turning notifications off takes the tokens back at once, even with the chat
// not running: a new subscription (payment notifications keep working on it),
// or none at all. The revokes and the slot cleanup follow with the next sync.
async function turnedOff(): Promise<void> {
  if (!isPushSupported()) return;
  try {
    if (isNotifyEnabled()) {
      await rotatePushSubscription();
    } else {
      const reg = await navigator.serviceWorker.getRegistration("/sw.js");
      await (await reg?.pushManager.getSubscription())?.unsubscribe();
    }
  } catch (e) {
    console.error("[chat] push off", e);
  }
}

// ---- sender: pokes ------------------------------------------------------------

function previewOf(m: StoredMessage): Preview {
  const p = m.payload;
  if (p?.t === "payment") return { k: "payment", s: p.sats, ...(p.note ? { o: p.note } : {}), c: 1 };
  if (p?.t === "request") return { k: "request", s: p.sats, ...(p.note ? { o: p.note } : {}), c: 1 };
  if (p?.t === "schedule") return { k: "schedule", s: p.sats, ...(p.note ? { o: p.note } : {}), c: 1 };
  if (p?.t === "request-reply") return { k: "reply", c: 1 };
  return { k: "text", x: clampPreviewText(m.text), c: 1 };
}

function previewKey(raw: string): Promise<CryptoKey> {
  let key = keyCache.get(raw);
  if (!key) {
    key = importPreviewKey(b64urlDecode(raw), "encrypt");
    keyCache.set(raw, key);
  }
  return key;
}

function maybeAsk(peer: string): void {
  const c = getChatState().contacts[peer];
  if (!c?.accepted || c.blocked) return;
  if (Date.now() - (grants.asked[peer] ?? 0) < ASK_EVERY_MS) return;
  grants.asked[peer] = Date.now();
  saveGrants();
  void sendControl(peer, controlContent({ t: "ask" })).catch(() => {});
}

async function poke(peer: string, preview: Preview): Promise<void> {
  const grant = grants.grants[peer];
  if (!grant) return;
  lastPoke.set(peer, Date.now());
  const n = Math.max((grants.n[peer] ?? 0) + 1, Date.now());
  grants.n[peer] = n;
  saveGrants();
  const blob = await sealBlob(await previewKey(grant.key), {
    v: 1,
    n,
    t: Math.floor(Date.now() / 1000),
    ...previewFor(grant.preview, preview),
  });
  let res: Response;
  try {
    res = await fetch("/api/chat/poke", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token: grant.token, blob }),
      // The page may be on its way to the background.
      keepalive: true,
    });
  } catch {
    return;
  }
  if (res.status === 410 && grants.grants[peer]?.token === grant.token) {
    delete grants.grants[peer];
    grants.asked[peer] = 0;
    saveGrants();
    maybeAsk(peer);
  }
}

function flush(peer: string): void {
  const q = queued.get(peer);
  if (!q) return;
  window.clearTimeout(q.timer);
  queued.delete(peer);
  if (pokeDelay(Date.now(), lastHeard.get(peer) ?? 0, 0) === null) return;
  void poke(peer, { ...q.preview, c: q.count });
}

function flushAll(): void {
  for (const peer of [...queued.keys()]) flush(peer);
}

function onDelivered(m: StoredMessage): void {
  if (!m.outgoing) return;
  const peer = m.peer;
  const c = getChatState().contacts[peer];
  if (!c?.accepted || c.blocked) return;
  if (!grants.grants[peer]) {
    maybeAsk(peer);
    return;
  }
  const wait = pokeDelay(Date.now(), lastHeard.get(peer) ?? 0, lastPoke.get(peer) ?? 0);
  if (wait === null) return;
  const prev = queued.get(peer);
  const preview = previewOf(m);
  const count = (prev?.count ?? 0) + 1;
  if (prev) window.clearTimeout(prev.timer);
  const timer = window.setTimeout(() => flush(peer), wait);
  queued.set(peer, { preview, count, timer });
}

function onControl(from: string, content: string, createdAt: number): void {
  const control = parseControl(content);
  if (!control || !loaded) return;
  const contact = getChatState().contacts[from];
  if (contact?.blocked) return;
  if (control.t === "ask") {
    if (!isChatPushOn() || !contact?.accepted) return;
    if (Date.now() - (answeredAsk.get(from) ?? 0) < ANSWER_ASK_EVERY_MS) return;
    // Old asks come back with every resubscription: only recent ones count.
    if (Date.now() / 1000 - createdAt > 2 * 24 * 60 * 60) return;
    answeredAsk.set(from, Date.now());
    asks.add(from);
    scheduleSync();
    return;
  }
  if ((grants.at[from] ?? 0) > createdAt) return;
  grants.at[from] = createdAt;
  if (control.t === "revoke") delete grants.grants[from];
  else grants.grants[from] = { token: control.token, key: control.key, preview: control.preview };
  saveGrants();
}

// ---- lifecycle ---------------------------------------------------------------

let session = 0;

async function onReady(): Promise<void> {
  const mine = ++session;
  const [s, g] = await Promise.all([
    loadPushRecord<Record<string, SlotRecord>>("push-slots", {}),
    loadPushRecord<Grants>("push-grants", { grants: {}, at: {}, n: {}, asked: {} }),
  ]);
  if (mine !== session) return;
  slots = s;
  grants = { grants: g.grants ?? {}, at: g.at ?? {}, n: g.n ?? {}, asked: g.asked ?? {} };
  loaded = true;
  scheduleSync(500);
}

function onStop(): void {
  flushAll();
  session++;
  loaded = false;
  if (syncTimer !== null) window.clearTimeout(syncTimer);
  syncTimer = null;
  slots = {};
  grants = { grants: {}, at: {}, n: {}, asked: {} };
  written.clear();
  asks.clear();
  answeredAsk.clear();
  lastHeard.clear();
  lastPoke.clear();
  keyCache.clear();
}

// The slot of a conversation, for the notification a tap opened (or to clear).
export function peerForSlot(slot: string): string | null {
  for (const [peer, rec] of Object.entries(slots)) if (rec.slot === slot) return peer;
  return null;
}

// Waits for the chat to load its records after an unlock.
export async function whenSlotPeer(slot: string, timeoutMs = 20_000): Promise<string | null> {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    const peer = loaded ? peerForSlot(slot) : null;
    if (peer) return peer;
    if (loaded && getChatState().status === "ready") return null;
    await new Promise((r) => setTimeout(r, 300));
  }
  return null;
}

export function markConversationSeen(peer: string): void {
  const rec = slots[peer];
  if (rec) void markSlotSeen(rec.slot);
}

let installed = false;

// Once per page: registers with the chat client and follows the settings.
export function installChatPush(): void {
  if (installed) return;
  installed = true;
  setChatPushHooks({
    onReady: () => void onReady(),
    onStop,
    onContactsChanged: () => scheduleSync(),
    onControl,
    onHeard: (peer) => lastHeard.set(peer, Date.now()),
    onDelivered,
  });
  let wasOn = isChatPushOn();
  onChatPushSettingsChange(() => {
    const on = isChatPushOn();
    if (wasOn && !on) void turnedOff();
    wasOn = on;
    scheduleSync(0);
  });
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") flushAll();
  });
}
