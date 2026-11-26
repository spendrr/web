// Registers the soonest due payment reminder with the push shard,
// so a notification "pay @pavel 5 000 sats" arrives while the app is closed
// (worker/reminder.ts). The text is sealed here and never leaves the device in
// the clear. One request per change of the soonest reminder, not per schedule
// and not per app open.
//
// Off unless the chat is on, notifications are enabled and this browser has
// a push subscription: the shard only has a record to put it on then.
import type { WalletClient } from "../wallet/bark";
import { getPushHeightToken, isNotifyEnabled, isPushSupported, NOTIFY_ENABLED_EVENT, PUSH_SUBSCRIPTION_EVENT } from "../notifications";
import { isChatEnabled } from "./chatEnabled";
import { getChatState, subscribeChat, type Schedule } from "./chatClient";
import { getReminderKey, getReminderSigKey } from "./pushSlots";
import { withTimeout } from "../wallet/walletCall";
import { b64urlEncode } from "./pushFormat";
import { nextReminder, sealReminder } from "./reminderBlob";

const SENT_KEY = "spendrr-remind-sent-v2";
// The server keeps what it was sent; sending again only covers a lost record
// (a rotated subscription changes the signature anyway).
const RESEND_AFTER_MS = 20 * 60 * 60 * 1000;
const DEBOUNCE_MS = 2000;
// The shard sends from an alarm (every 15 min) and, when a push fails, tries again
// 30 min later. A registered reminder stays registered for this long past its
// time, so a change in between cannot take it back while a retry is still ahead.
const SEND_GRACE_MS = 2 * 60 * 60 * 1000;
// One alarm interval and a little more.
const FIRST_ALARM_MARGIN_MS = 16 * 60 * 1000;
// A failed registration is tried again a few times, then left to the next change.
const RETRY_DELAYS_MS = [10_000, 60_000, 5 * 60_000];
const MAX_WAKE_MS = RESEND_AFTER_MS;
const POST_TIMEOUT_MS = 20_000;
// A whole run, the wallet call for the mailbox id included. Late is not failed: the
// run is only given up on here, and a retry sends the same thing again.
const RUN_TIMEOUT_MS = 60_000;

// `sig` is a keyed digest of the reminder, never its text: this sits in
// localStorage, readable with the wallet locked. `id` and `due` say which
// schedule the server holds.
type Sent = { sig: string; at: number; id: string; due: number };

function readSent(): Sent | null {
  try {
    const v = JSON.parse(localStorage.getItem(SENT_KEY) ?? "null") as Sent | null;
    return v && typeof v.sig === "string" && typeof v.at === "number" && typeof v.id === "string" && typeof v.due === "number" ? v : null;
  } catch {
    return null;
  }
}

function writeSent(sent: Sent | null): void {
  try {
    if (sent) localStorage.setItem(SENT_KEY, JSON.stringify(sent));
    else localStorage.removeItem(SENT_KEY);
  } catch {
    // storage blocked: the next open sends again
  }
}

export async function reminderSignature(
  s: Pick<Schedule, "id" | "nextDue" | "sats" | "note" | "peer">,
  name: string | null,
  endpoint: string,
  key: CryptoKey,
): Promise<string> {
  const text = JSON.stringify([s.id, s.nextDue, s.sats, s.note ?? "", s.peer, name ?? "", endpoint]);
  return b64urlEncode(new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(text))));
}

async function post(body: unknown): Promise<boolean> {
  try {
    const res = await fetch("/api/push/remind", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      // A request that never answers would hold the queue below for good.
      signal: AbortSignal.timeout(POST_TIMEOUT_MS),
    });
    return res.status === 204;
  } catch {
    return false;
  }
}

interface Outcome {
  // The registration failed in a way a later try may fix.
  retry?: boolean;
  // Look again after this long even if nothing changes (a registered reminder's grace ends).
  wakeMs?: number;
}

async function sync(wallet: WalletClient, alive: () => boolean): Promise<Outcome> {
  if (!isChatEnabled() || !isNotifyEnabled() || !isPushSupported()) return {};
  const token = getPushHeightToken();
  if (!token) return {};
  const registration = await navigator.serviceWorker.getRegistration("/sw.js");
  const subscription = await registration?.pushManager.getSubscription();
  if (!subscription) return {};

  const chat = getChatState();
  if (chat.status !== "ready") return {};
  const now = Date.now();
  const previous = readSent();
  const usable = chat.schedules.filter((s) => chat.contacts[s.peer]);
  // What the server holds stays a candidate past its time, so a reminder a few
  // seconds from due is not replaced or cleared before it can go out, and a failed
  // push still has its retry. A reminder still ahead goes first: the shard holds
  // one, and the next payment must not wait for the last one's retries.
  const ahead = nextReminder(usable, now, 0);
  const held = usable.filter(
    (s) => previous !== null && s.id === previous.id && s.nextDue === previous.due && s.nextDue < now && now < s.nextDue + SEND_GRACE_MS,
  );
  const next = ahead ?? nextReminder(held, now, -SEND_GRACE_MS);
  const mailboxId = await wallet.mailboxIdentifier();
  if (!alive()) return {};

  if (!next) {
    // Nothing ahead: clear what the server holds, once.
    if (previous) {
      if (!alive()) return {};
      if (await post({ mailboxId, heightToken: token, remindAt: null, blob: null })) writeSent(null);
      else return { retry: true };
    }
    return {};
  }
  const contact = chat.contacts[next.peer];
  const name = contact?.name ?? null;
  const sig = await reminderSignature(next, name, subscription.endpoint, await getReminderSigKey());
  // Look again once the shard's first alarm after the time has passed (what it holds
  // may have gone out, so the next reminder can be registered); a held one past its
  // time is looked at again when its retries end.
  const wakeAt = next.nextDue >= now ? next.nextDue + FIRST_ALARM_MARGIN_MS : next.nextDue + SEND_GRACE_MS;
  const wakeMs = Math.min(Math.max(wakeAt - now + 1000, DEBOUNCE_MS), MAX_WAKE_MS);
  if (previous && previous.sig === sig && now - previous.at < RESEND_AFTER_MS) return { wakeMs };

  const blob = await sealReminder(await getReminderKey(), {
    v: 1,
    id: next.id,
    ...(name ? { n: name } : {}),
    s: next.sats,
    ...(next.note ? { o: next.note } : {}),
    t: Math.floor(now / 1000),
  });
  if (!alive()) return {};
  if (await post({ mailboxId, heightToken: token, remindAt: Math.floor(next.nextDue / 1000), blob })) {
    // Written even when stopped meanwhile: it says what the server holds, and the
    // next instance needs it to clear that if the schedule is gone.
    writeSent({ sig, at: Date.now(), id: next.id, due: next.nextDue });
    return { wakeMs };
  }
  return { retry: true };
}

// Runs of every instance go through one queue, so a stopped instance's request
// is over before the next one's starts and cannot land after it.
let queue: Promise<unknown> = Promise.resolve();

// Follows the chat state while the chat is on. Returns the stop function.
export function startReminderSync(wallet: WalletClient): () => void {
  let timer: number | undefined;
  let stopped = false;
  let running = false;
  // A change arrived since the current run began: its outcome is already out of
  // date, so the run that change scheduled must not be replaced by a wake-up.
  let dirty = false;
  let attempt = 0;
  const alive = () => !stopped;
  const schedule = (delay: number) => {
    window.clearTimeout(timer);
    timer = window.setTimeout(() => {
      if (stopped) return;
      if (running) return schedule(DEBOUNCE_MS);
      running = true;
      dirty = false;
      // A run given up on must not post later, behind the next one's back.
      let gaveUp = false;
      const run = queue
        .then(() => (stopped ? ({} as Outcome) : withTimeout(sync(wallet, () => alive() && !gaveUp), RUN_TIMEOUT_MS, "reminder sync")))
        .catch((): Outcome => {
          gaveUp = true;
          return { retry: true };
        });
      queue = run;
      void run.then((outcome) => {
        running = false;
        if (stopped || dirty) return;
        if (outcome.retry && attempt < RETRY_DELAYS_MS.length) schedule(RETRY_DELAYS_MS[attempt++]);
        else if (outcome.wakeMs) {
          attempt = 0;
          schedule(outcome.wakeMs);
        }
      });
    }, delay);
  };
  const onChange = () => {
    attempt = 0;
    dirty = true;
    schedule(DEBOUNCE_MS);
  };
  const unsubscribe = subscribeChat(onChange);
  // Notifications turned on, or the subscription replaced: neither changes the chat.
  window.addEventListener(NOTIFY_ENABLED_EVENT, onChange);
  window.addEventListener(PUSH_SUBSCRIPTION_EVENT, onChange);
  schedule(DEBOUNCE_MS);
  return () => {
    stopped = true;
    window.clearTimeout(timer);
    unsubscribe();
    window.removeEventListener(NOTIFY_ENABLED_EVENT, onChange);
    window.removeEventListener(PUSH_SUBSCRIPTION_EVENT, onChange);
  };
}
