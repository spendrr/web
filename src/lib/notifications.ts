// Two layers, both best-effort:
//
// - The Browser Notification API, fired from inside the open tab by the
//   background receive watchers in Dashboard.tsx. Only works while some tab
//   has the app open.
// - Real Web Push (this file's subscribeToPush/refreshPushAuthorization),
//   which works even with the browser fully closed. This does NOT need a
//   server holding the wallet's mnemonic (the previously-rejected idea) —
//   wallet.mailboxIdentifier()/mailboxAuthorization() produce a public id and
//   an expiring signed *read* authorization (PUSH_AUTH_LIFETIME_S), documented by the
//   bark SDK as safe to hand to a third party, which our own Worker uses to
//   poll the Ark mailbox and relay a push when a payment arrives. See
//   ARCHITECTURE.md's push notifications section for the real tradeoff this
//   involves (our Worker briefly sees payment amounts) and what was verified
//   before this shipped.
//
// Push can only wake the app up ("you got paid, open Spendrr") — a Service
// Worker has no access to the decrypted mnemonic, so it can't settle the
// payment itself.
import type { WalletClient } from "./wallet/bark";
import { effectiveEngineMode } from "./refreshEngine/mode";
import { watchedExpiryHeight } from "./refreshEngine/plan";
import { localStorageStore } from "./refreshEngine/runner";
import { readVtxosShared } from "./wallet/vtxoSnapshot";
import { isChatPushOn } from "./chat/chatEnabled";

const STORAGE_KEY = "btc-wallet-notify-enabled";
// How long the push backend may read the mailbox with one authorization:
// payment pushes keep coming for this long after the app was last opened (a
// new one is signed then). A month: a wallet not opened for longer is already
// losing coins to expiry, and the expiry nudge needs no authorization. The
// Worker refuses longer ones (worker/mailboxShared.ts
// PUSH_AUTH_MAX_LIFETIME_SECONDS) and a name proof must stay longer
// (names/names.ts NAME_PROOF_LIFETIME_S).
export const PUSH_AUTH_LIFETIME_S = 30 * 24 * 60 * 60;

// Public VAPID key (safe to ship — it's the public half of the keypair the
// Worker uses to sign push requests). Generated once out of band; see
// ARCHITECTURE.md's push notifications section for how to rotate it.
const VAPID_PUBLIC_KEY = "BJC6rFgeWdYbvL0yiHdCZtabhpCaFgmHb75QO9BvE5m_ps68dHDGpmVapOVIfQIkmO7z9GCavu8PcusvKC-McCA";

export function isNotificationSupported(): boolean {
  return typeof window !== "undefined" && "Notification" in window;
}

export function isPushSupported(): boolean {
  return typeof window !== "undefined" && "serviceWorker" in navigator && "PushManager" in window;
}

export function notificationPermission(): NotificationPermission | "unsupported" {
  return isNotificationSupported() ? Notification.permission : "unsupported";
}

export function isNotifyEnabled(): boolean {
  return isNotificationSupported() && Notification.permission === "granted" && localStorage.getItem(STORAGE_KEY) === "1";
}

function urlBase64ToUint8Array(base64Url: string): Uint8Array {
  const base64 = base64Url.replace(/-/g, "+").replace(/_/g, "/");
  const padded = base64 + "=".repeat((4 - (base64.length % 4)) % 4);
  const binary = atob(padded);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

/**
 * Registers the Service Worker, subscribes it to push, and hands the
 * subscription + this wallet's mailbox credentials to our Worker. Best-effort
 * throughout: any failure here just means push doesn't work this session —
 * the existing in-tab Notification path is unaffected, and enableNotifications()
 * below doesn't fail the whole toggle because of it.
 */
async function subscribeToPush(
  wallet: WalletClient,
  priceUsd?: number,
  exitWatch?: number | null,
  force = false,
): Promise<void> {
  const subscription = await browserPushSubscription();
  if (subscription) await postSubscription(wallet, subscription, priceUsd, exitWatch, force);
}

// The browser's one push subscription, shared by payment and chat
// notifications (chat/chatPush.ts). Created if missing; needs the
// notification permission already granted.
export async function browserPushSubscription(): Promise<PushSubscription | null> {
  if (!isPushSupported()) return null;
  const registration = await navigator.serviceWorker.register("/sw.js");
  return (
    (await registration.pushManager.getSubscription()) ??
    registration.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToUint8Array(VAPID_PUBLIC_KEY) as BufferSource,
    })
  );
}

// Fired when the subscription was replaced: the payment push registration has
// to follow the new endpoint (Dashboard re-posts it with what it knows).
export const PUSH_SUBSCRIPTION_EVENT = "spendrr-push-subscription-change";

// A new endpoint, so every chat token made for the old one stops working: how
// blocking a contact or turning chat notifications off takes back what was
// handed out (no server keeps a list).
export async function rotatePushSubscription(): Promise<PushSubscription | null> {
  if (!isPushSupported()) return null;
  const registration = await navigator.serviceWorker.getRegistration("/sw.js");
  const old = await registration?.pushManager.getSubscription();
  forgetSentSubscribe();
  if (old) {
    if (isNotifyEnabled()) {
      await fetch("/api/push/unsubscribe", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ endpoint: old.endpoint }),
      }).catch(() => {});
    }
    await old.unsubscribe().catch(() => false);
  }
  const fresh = await browserPushSubscription();
  if (isNotifyEnabled()) window.dispatchEvent(new Event(PUSH_SUBSCRIPTION_EVENT));
  return fresh;
}

// firstExpiringVtxoBlockheight/priceUsd feed the expiry-nudge push (see
// ARCHITECTURE.md's push section): the server compares that blockheight against
// chain tip to decide when to nudge the user to reopen the app before the
// SDK's own refresh window closes, and priceUsd lets it fold in "bitcoin
// moved X% since you last looked" instead of a bare "open the app". Both are
// best-effort snapshots, not authoritative — a stale or missing value just
// means a slightly late/generic nudge, never a broken one.
// exitWatch: a height a running unilateral exit wants a nudge by, folded into
// the same field so the server can't tell the two apart (exitNudge.ts).
async function postSubscription(
  wallet: WalletClient,
  subscription: PushSubscription,
  priceUsd?: number,
  exitWatch?: number | null,
  force = false,
): Promise<void> {
  const [mailboxId, expiringVtxoResult] = await Promise.all([
    wallet.mailboxIdentifier(),
    // Distinguishes "the call succeeded and there's genuinely nothing to
    // watch" (resolves undefined) from "couldn't tell" (rejects) — the
    // server needs that distinction to know whether to clear a previously
    // reported watch point or just leave it alone. Collapsing both into the
    // same "field omitted" shape was a real bug: a wallet that spent its
    // last VTXO would never clear the server's stale watch, and could get a
    // nudge for funds that no longer exist.
    // Beta, refresh engine live: the soonest expiry among coins we hold,
    // counting ones inside a refresh (it may still fail) and leaving out
    // quarantined ones (a nudge about a coin the server rejects is one the
    // user can't act on, and it would repeat).
    (effectiveEngineMode() === "live"
      ? readVtxosShared(wallet)
          .then((v) => watchedExpiryHeight(v, new Set(Object.keys(localStorageStore(wallet.fingerprint).load().quarantine))))
      : wallet.getFirstExpiringVtxoBlockheight()
    ).then(
      (value) => ({ ok: true as const, value }),
      () => ({ ok: false as const }),
    ),
  ]);
  const watch = combineWatch(expiringVtxoResult, exitWatch ?? null);
  const heightToken = pushHeightToken();
  const key = subscribeKey({ mailboxId, endpoint: subscription.endpoint, watch, heightToken });
  if (!force && !isSubscribeDue(readSentSubscribe(), key, priceUsd, Date.now())) return;
  const mailboxAuthorization = await wallet.mailboxAuthorization(PUSH_AUTH_LIFETIME_S);
  const res = await fetch("/api/push/subscribe", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      mailboxId,
      mailboxAuthorization,
      subscription: subscription.toJSON(),
      // ok + undefined value -> explicit null (clear); ok + a number -> that
      // number; not ok (SDK call failed) -> field omitted entirely, so the
      // server preserves whatever it last knew.
      ...(watch.ok ? { firstExpiringVtxoBlockheight: watch.value } : {}),
      ...(priceUsd !== undefined ? { priceUsd } : {}),
      ...(heightToken ? { heightToken } : {}),
    }),
  }).catch(() => null);
  // Forgotten on any failure, so the next unlock or balance change tries again.
  // So is a 202: stored, but the push relay did not take it (worker/pushRelay.ts).
  if (res?.status === 204) {
    writeSentSubscribe({ key, at: Date.now(), priceUsd });
    if (watch.ok) {
      const previous = lastSentWatch;
      lastSentWatch = { fingerprint: wallet.fingerprint, value: watch.value };
      // The watch moved later (or was cleared): the coin behind a push already
      // shown has been refreshed, so the push no longer asks for anything.
      if (previous?.fingerprint === wallet.fingerprint && (watch.value === null || (previous.value !== null && watch.value > previous.value))) {
        void closeExpiryNotifications();
      }
    }
  } else forgetSentSubscribe();
  // The Worker checks every subscribe against the live Ark server, so while
  // that server is down the write is refused, and with it the one thing a
  // running exit needs: a new wake-up height. This path updates only the
  // height of the record a verified subscribe already stored, proven by the
  // token sent along with it (worker/pushHeight.ts, external audit
  // 2026-09-27, N1).
  if ((!res || !res.ok) && watch.ok && heightToken) {
    await fetch("/api/push/height", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ mailboxId, heightToken, firstExpiringVtxoBlockheight: watch.value }),
    }).catch(() => {});
  }
}

// --- Sending a subscribe only when it changes something ---------------------
// Every subscribe costs a Worker request, KV reads, a Durable Object request
// and a check against the Ark server, and it used to go out on every unlock
// and every balance change with the same content. The server needs it again
// only when something it holds would change (mailbox, endpoint, watched
// height, the height token), when the price it compares against for the
// "bitcoin moved" nudge has drifted, or before the authorization it holds
// runs out (24 h after signing; resent from 2 h on, at the next unlock or
// balance change, as before). The authorization's 24 h run from the last
// subscribe sent, not the last unlock, so this is also how much earlier
// than before payment pushes can stop for someone who left the app closed.
// The drift is what the nudge's "since your last look" percentage can be
// off by.
const SENT_KEY = "btc-wallet-push-sent";
export const SUBSCRIBE_RESEND_AFTER_MS = 2 * 60 * 60 * 1000;
export const SUBSCRIBE_PRICE_DRIFT = 0.005;

export interface SentSubscribe {
  key: string;
  at: number;
  priceUsd?: number;
}

// Pure, exported for tests. A watch that could not be read is sent as "keep
// what you have", so it is its own value here.
export function subscribeKey(parts: {
  mailboxId: string;
  endpoint: string;
  watch: { ok: true; value: number | null } | { ok: false };
  heightToken: string | null;
}): string {
  return JSON.stringify([parts.mailboxId, parts.endpoint, parts.watch.ok ? parts.watch.value : "?", parts.heightToken !== null]);
}

// Pure, exported for tests.
export function isSubscribeDue(sent: SentSubscribe | null, key: string, priceUsd: number | undefined, now: number): boolean {
  if (!sent || sent.key !== key) return true;
  if (!(now - sent.at >= 0) || now - sent.at >= SUBSCRIBE_RESEND_AFTER_MS) return true;
  if (priceUsd === undefined) return false;
  if (sent.priceUsd === undefined || !(sent.priceUsd > 0)) return true;
  return Math.abs(priceUsd - sent.priceUsd) / sent.priceUsd > SUBSCRIBE_PRICE_DRIFT;
}

function readSentSubscribe(): SentSubscribe | null {
  try {
    const parsed = JSON.parse(localStorage.getItem(SENT_KEY) ?? "null") as SentSubscribe | null;
    return parsed && typeof parsed.key === "string" && typeof parsed.at === "number" ? parsed : null;
  } catch {
    return null;
  }
}

function writeSentSubscribe(sent: SentSubscribe): void {
  try {
    localStorage.setItem(SENT_KEY, JSON.stringify(sent));
  } catch {
    // Storage blocked: every trigger just sends again, as before.
  }
}

function forgetSentSubscribe(): void {
  try {
    localStorage.removeItem(SENT_KEY);
  } catch {
    // Ignored.
  }
}

// A random secret per browser, sent with every subscribe; the Worker keeps
// only its hash and accepts it later as proof for /api/push/height. null
// when storage or crypto isn't available (the fallback just doesn't exist).
const HEIGHT_TOKEN_KEY = "btc-wallet-push-height-token";

function pushHeightToken(): string | null {
  try {
    const stored = localStorage.getItem(HEIGHT_TOKEN_KEY);
    if (stored && /^[0-9a-f]{64}$/.test(stored)) return stored;
    const bytes = crypto.getRandomValues(new Uint8Array(32));
    const token = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
    localStorage.setItem(HEIGHT_TOKEN_KEY, token);
    return token;
  } catch {
    return null;
  }
}

export function clearPushHeightToken(): void {
  forgetSentSubscribe();
  try {
    localStorage.removeItem(HEIGHT_TOKEN_KEY);
  } catch {
    // Ignored.
  }
}

// The soonest of the VTXO expiry and the exit's own height. When the VTXO read
// failed, the exit's height alone still goes out: an exit that needs the app
// matters more than keeping an older watch the server might already hold.
function combineWatch(
  vtxo: { ok: true; value: number | undefined } | { ok: false },
  exitWatch: number | null,
): { ok: true; value: number | null } | { ok: false } {
  if (!vtxo.ok) return exitWatch !== null ? { ok: true, value: exitWatch } : { ok: false };
  const heights = [vtxo.value, exitWatch].filter((h): h is number => typeof h === "number" && h > 0);
  return { ok: true, value: heights.length > 0 ? Math.min(...heights) : null };
}

// The watch the server last took, per wallet. Session-only on purpose: it only
// tells a refresh that finished meanwhile from a first report.
let lastSentWatch: { fingerprint: string; value: number | null } | null = null;
let lastWatchCheckAt = 0;
const WATCH_CHECK_INTERVAL_MS = 60_000;

// Takes the OS tray's expiry notifications away. The exit reminder has its own
// tag (sw.js) and stays.
async function closeExpiryNotifications(): Promise<void> {
  try {
    const registration = await navigator.serviceWorker.getRegistration("/sw.js");
    for (const n of (await registration?.getNotifications({ tag: "spendrr-expiry" })) ?? []) n.close();
  } catch {
    // Best-effort.
  }
}

/**
 * Re-reports the watched height after a refresh cycle: a finished refresh moves
 * the soonest expiry without moving the balance, so the balance/history trigger
 * never reports it. Throttled to once a minute (it reads the coin list) unless
 * `force` (an engine batch just finished); the subscribe gate above sends
 * nothing while the watch is unchanged.
 */
export async function reportExpiryIfMoved(
  wallet: WalletClient,
  priceUsd?: number,
  exitWatch?: number | null,
  opts: { force?: boolean } = {},
): Promise<void> {
  if (!isNotifyEnabled() || !isPushSupported()) return;
  const now = Date.now();
  if (!opts.force && now - lastWatchCheckAt < WATCH_CHECK_INTERVAL_MS) return;
  lastWatchCheckAt = now;
  await refreshPushAuthorization(wallet, priceUsd, exitWatch);
}

/**
 * Re-signs and re-sends this wallet's mailbox authorization while push is
 * enabled. An authorization is only valid PUSH_AUTH_LIFETIME_S from when it
 * was signed, so the background watch quietly lapses if the app isn't opened
 * within that — this is what keeps it alive for as long as you do open the
 * app periodically. Called opportunistically (on unlock),
 * not on its own timer — same "re-check on a natural opportunity" pattern as
 * Dashboard's exit-vtxos-on-Settings-close check.
 */
export async function refreshPushAuthorization(
  wallet: WalletClient,
  priceUsd?: number,
  exitWatch?: number | null,
): Promise<void> {
  if (!isNotifyEnabled() || !isPushSupported()) return;
  try {
    const registration = await navigator.serviceWorker.getRegistration("/sw.js");
    const subscription = await registration?.pushManager.getSubscription();
    if (subscription) {
      await postSubscription(wallet, subscription, priceUsd, exitWatch);
    } else {
      await subscribeToPush(wallet, priceUsd, exitWatch);
    }
  } catch {
    // Best-effort — the next unlock, or the existing in-tab path, covers it.
  }
}

export async function enableNotifications(wallet: WalletClient): Promise<boolean> {
  if (!isNotificationSupported()) return false;
  const permission = await Notification.requestPermission();
  if (permission !== "granted") {
    localStorage.removeItem(STORAGE_KEY);
    return false;
  }
  localStorage.setItem(STORAGE_KEY, "1");
  try {
    // Forced: turning push on must reach the server even if this browser
    // sent the same content before (it may have been unsubscribed since).
    await subscribeToPush(wallet, undefined, undefined, true);
  } catch {
    // Push setup failed (unsupported browser, network hiccup, etc.) — the
    // existing in-tab Notification path still works, so the toggle stays on.
  }
  return true;
}

export async function disableNotifications(): Promise<void> {
  localStorage.removeItem(STORAGE_KEY);
  forgetSentSubscribe();
  if (!isPushSupported()) return;
  try {
    const registration = await navigator.serviceWorker.getRegistration("/sw.js");
    const subscription = await registration?.pushManager.getSubscription();
    if (subscription) {
      await fetch("/api/push/unsubscribe", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ endpoint: subscription.endpoint }),
      });
      // Chat notifications still use the same subscription.
      if (!isChatPushOn()) await subscription.unsubscribe();
    }
  } catch {
    // Best-effort — worst case a stale subscription lingers server-side
    // until the push service itself reports it gone (404/410).
  }
}

export function notifyPayment(body: string): void {
  if (!isNotifyEnabled()) return;
  // The in-app toast already covers a focused, visible tab — only bother
  // with an OS notification when the user isn't actually looking at it.
  if (document.visibilityState === "visible" && document.hasFocus()) return;
  try {
    new Notification("Spendrr", { body, icon: "/favicon.svg" });
  } catch {
    // best-effort only
  }
}
