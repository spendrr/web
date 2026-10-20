// Client for the @handle registry (worker/names.ts). Reads are public; every
// write proves control of the wallet's mailbox with a fresh mailbox
// authorization, the same self-signed 24h proof the push subscription sends.
//
// The address a handle points at is the wallet's own peekAddress(0), the one
// Dashboard already shows for receiving: index 0, so it stays inside the
// recovery scan's gap limit and is the same address after a re-import.
import type { WalletClient } from "../wallet/bark";
import { checkHandle, normalizeHandle } from "./handle";
import { withTimeout } from "../wallet/walletCall";

const PROOF_TIMEOUT_MS = 20_000;
const PROOF_TIMEOUT_MESSAGE = "Počkej chvíli…";

export type NameAbsentStatus = "free" | "quarantined" | "reserved" | "invalid";

export type LookupOutcome =
  | { kind: "found"; name: string; address: string; lnAddress: boolean; chatPubkey?: string }
  | { kind: "absent"; status: NameAbsentStatus }
  | { kind: "error" };

const ABSENT_STATUSES: readonly string[] = ["free", "quarantined", "reserved", "invalid"];

// A short memory of definite answers, so retyping or backspacing over a name
// in the send field shows who it is at once instead of after a round trip.
// Only a hint: SendPanel still fetches fresh right away and the fresh answer
// wins, and the window is no longer than the send form's own refresh interval,
// so a payment can never freeze an address older than it already could.
const LOOKUP_CACHE_MS = 30_000;
const LOOKUP_CACHE_MAX = 200;
const lookupCache = new Map<string, { at: number; outcome: LookupOutcome }>();

export function cachedLookup(name: string, now = Date.now()): LookupOutcome | null {
  const hit = lookupCache.get(name);
  if (!hit) return null;
  if (now - hit.at > LOOKUP_CACHE_MS) {
    lookupCache.delete(name);
    return null;
  }
  return hit.outcome;
}

function remember(name: string, outcome: LookupOutcome): LookupOutcome {
  if (outcome.kind === "error") return outcome;
  lookupCache.delete(name);
  lookupCache.set(name, { at: Date.now(), outcome });
  if (lookupCache.size > LOOKUP_CACHE_MAX) lookupCache.delete(lookupCache.keys().next().value as string);
  return outcome;
}

// A lookup that has not answered by now never will (the Worker answers in well
// under a second): without a bound a stalled connection left the send form on
// "checking" until something else happened to refresh it.
const LOOKUP_TIMEOUT_MS = 8_000;

// One request per name at a time: a refresh landing on a retry, or a form
// reopened, shares the call. The request has its own controller and is
// cancelled only when every caller has left, so one caller aborting never
// fails another's lookup.
type Inflight = { promise: Promise<LookupOutcome>; controller: AbortController; waiters: number };
const inflight = new Map<string, Inflight>();

export async function lookupName(name: string, signal?: AbortSignal): Promise<LookupOutcome> {
  // The server runs the very same checkHandle before it looks anything up and
  // answers "invalid" for a name that fails it, so asking it is a round trip
  // (and a slot in the per-IP limiter, and a call into the one global registry)
  // for an answer already known here. Reserved names are NOT turned away: some
  // have an owner and resolve, which only the registry knows.
  if (!checkHandle(name, { allowReserved: true }).ok) return remember(name, { kind: "absent", status: "invalid" });
  if (signal?.aborted) return { kind: "error" };
  let entry = inflight.get(name);
  if (!entry) {
    const controller = new AbortController();
    const created: Inflight = {
      controller,
      waiters: 0,
      promise: fetchLookup(name, controller.signal)
        .then((outcome) => remember(name, outcome))
        .finally(() => {
          if (inflight.get(name) === created) inflight.delete(name);
        }),
    };
    inflight.set(name, created);
    entry = created;
  }
  const joined = entry;
  joined.waiters += 1;
  let left = false;
  const leave = () => {
    if (left) return;
    left = true;
    joined.waiters -= 1;
    if (joined.waiters > 0) return;
    if (inflight.get(name) === joined) inflight.delete(name);
    joined.controller.abort();
  };
  signal?.addEventListener("abort", leave, { once: true });
  try {
    return await joined.promise;
  } finally {
    signal?.removeEventListener("abort", leave);
    leave();
  }
}

async function fetchLookup(name: string, signal?: AbortSignal): Promise<LookupOutcome> {
  // The caller's signal plus our own deadline, on one controller (no
  // AbortSignal.any / .timeout: older Safari and Android WebViews lack them).
  const controller = new AbortController();
  const onAbort = () => controller.abort();
  if (signal?.aborted) return { kind: "error" };
  signal?.addEventListener("abort", onAbort, { once: true });
  const timer = setTimeout(onAbort, LOOKUP_TIMEOUT_MS);
  try {
    const res = await fetch(`/api/names/${encodeURIComponent(name)}`, { signal: controller.signal, cache: "no-store" });
    if (res.status === 200) {
      const body: unknown = await res.json();
      if (
        typeof body === "object" &&
        body !== null &&
        typeof (body as { name?: unknown }).name === "string" &&
        typeof (body as { address?: unknown }).address === "string"
      ) {
        const { name: n, address, lnAddress, chatPubkey } = body as {
          name: string;
          address: string;
          lnAddress?: unknown;
          chatPubkey?: unknown;
        };
        // An answer for a different name than the one asked is not an answer:
        // its address must never be shown as this name's.
        if (n !== normalizeHandle(name)) return { kind: "error" };
        return {
          kind: "found",
          name: n,
          address,
          lnAddress: lnAddress === true,
          ...(typeof chatPubkey === "string" && /^[0-9a-f]{64}$/.test(chatPubkey) ? { chatPubkey } : {}),
        };
      }
      return { kind: "error" };
    }
    if (res.status === 404) {
      const body: unknown = await res.json().catch(() => null);
      const status = (body as { status?: unknown } | null)?.status;
      if (typeof status === "string" && ABSENT_STATUSES.includes(status)) {
        return { kind: "absent", status: status as NameAbsentStatus };
      }
    }
    return { kind: "error" };
  } catch {
    return { kind: "error" };
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", onAbort);
  }
}

export type NameError =
  | "taken"
  | "quarantined"
  | "rate-limited" // this wallet changed its name/address too often
  | "throttled" // the server's per-IP or daily limit
  | "invalid"
  | "reserved"
  | "bad-address"
  | "banned" // this wallet was barred from registering names
  | "clock" // this device's clock is too far from the server's for the proof to count
  | "auth"
  | "network";

export type NameResult<T> = ({ ok: true } & T) | { ok: false; error: NameError };

// worker/names.ts tells a fresh name proof by its expiry alone (signed-at =
// expiry - this, within minutes of now), so it expects exactly this lifetime.
// Longer than a push authorization (notifications.ts PUSH_AUTH_LIFETIME_S): a
// push one is held by the push backend and the relay, and must never look
// like a freshly signed name proof, not even near the end of its life.
export const NAME_PROOF_LIFETIME_S = 31 * 24 * 60 * 60;

async function mailboxProof(wallet: WalletClient): Promise<{ mailboxId: string; mailboxAuthorization: string }> {
  const [mailboxId, mailboxAuthorization] = await withTimeout(
    Promise.all([wallet.mailboxIdentifier(), wallet.mailboxAuthorization(NAME_PROOF_LIFETIME_S)]),
    PROOF_TIMEOUT_MS,
    PROOF_TIMEOUT_MESSAGE,
  );
  return { mailboxId, mailboxAuthorization };
}

function errorFrom(status: number, body: unknown): NameError {
  const message = typeof (body as { error?: unknown } | null)?.error === "string" ? (body as { error: string }).error : "";
  if (status === 403) return message === "banned" ? "banned" : message === "clock" ? "clock" : "auth";
  if (status === 409) return message === "quarantined" ? "quarantined" : "taken";
  if (status === 429) return message === "rate-limited" ? "rate-limited" : "throttled";
  if (status === 400) {
    if (message === "Reserved name." || message === "reserved") return "reserved";
    if (message === "Invalid address.") return "bad-address";
    return "invalid";
  }
  return "network";
}

async function post(path: string, body: unknown): Promise<{ status: number; json: unknown }> {
  const res = await fetch(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const json: unknown = await res.json().catch(() => null);
  return { status: res.status, json };
}

// The name this wallet owns, or null when it has none. Throws when the answer
// is unknown (network, auth, server), so a failed read is never mistaken for
// "you have no name" and offered a fresh registration on top of a real one.
export async function fetchMyName(
  wallet: WalletClient,
): Promise<{ name: string; address: string; lnAddress: boolean; chatPubkey?: string } | null> {
  const { status, json } = await post("/api/names/mine", await mailboxProof(wallet));
  if (status === 404) return null;
  const j = json as { name?: unknown; address?: unknown; lnAddress?: unknown; chatPubkey?: unknown } | null;
  if (status === 200 && typeof j?.name === "string" && typeof j.address === "string") {
    return {
      name: j.name,
      address: j.address,
      lnAddress: j.lnAddress === true,
      ...(typeof j.chatPubkey === "string" ? { chatPubkey: j.chatPubkey } : {}),
    };
  }
  throw new Error(`names/mine ${status}`);
}

// Lightning-address opt-in/opt-out (docs/ln-address-plan.md section 4.3),
// proven the same way as every other write here. A no-op on the server if
// already in the requested state (see names.ts's setLnAddress), so calling
// this twice in a row from a slow UI never burns a proof for nothing beyond
// the network round trip.
export async function setMyLnAddress(
  wallet: WalletClient,
  enabled: boolean,
): Promise<{ ok: true; lnAddress: boolean } | { ok: false; error: NameError }> {
  try {
    const { status, json } = await post("/api/names/ln", { ...(await mailboxProof(wallet)), enabled });
    const j = json as { lnAddress?: unknown } | null;
    if (status === 200 && typeof j?.lnAddress === "boolean") return { ok: true, lnAddress: j.lnAddress };
    return { ok: false, error: errorFrom(status, json) };
  } catch {
    return { ok: false, error: "network" };
  }
}

// `action` mirrors what the registry actually did (worker/names.ts's
// SetResult): "claimed"/"renamed" start a fresh record with lnAddress off,
// "address-updated"/"unchanged" leave it exactly as it was. Callers that
// track lnAddress locally (ProfileSheet.tsx) use this to know whether to
// reset their own copy instead of guessing.
export async function saveName(
  wallet: WalletClient,
  name: string,
  address: string,
): Promise<NameResult<{ name: string; address: string; action: string }>> {
  try {
    const { status, json } = await post("/api/names/set", { ...(await mailboxProof(wallet)), name, address });
    const j = json as { name?: unknown; address?: unknown; action?: unknown } | null;
    if (status === 200 && typeof j?.name === "string" && typeof j.address === "string") {
      return { ok: true, name: j.name, address: j.address, action: typeof j.action === "string" ? j.action : "" };
    }
    return { ok: false, error: errorFrom(status, json) };
  } catch {
    return { ok: false, error: "network" };
  }
}

export async function releaseMyName(wallet: WalletClient): Promise<{ ok: true } | { ok: false; error: NameError }> {
  try {
    const { status, json } = await post("/api/names/release", await mailboxProof(wallet));
    if (status === 204) return { ok: true };
    if (status === 404) return { ok: true };
    return { ok: false, error: errorFrom(status, json) };
  } catch {
    return { ok: false, error: "network" };
  }
}

// Money chat (beta): publishes this wallet's chat key behind its name, which
// also makes it the name's NIP-05 identity. `sign` produces the chat key's
// signature over the mailbox id (the chat worker holds the key), proving to the
// registry that the name owns the key it claims.
export async function publishChatPubkey(
  wallet: WalletClient,
  chatPubkey: string,
  sign: (mailboxId: string) => Promise<string>,
): Promise<{ ok: true } | { ok: false; error: NameError | "no-name" }> {
  try {
    const proof = await mailboxProof(wallet);
    const chatSig = await sign(proof.mailboxId);
    const { status, json } = await post("/api/names/chat", { ...proof, chatPubkey, chatSig });
    if (status === 200) return { ok: true };
    if (status === 404) return { ok: false, error: "no-name" };
    return { ok: false, error: errorFrom(status, json) };
  } catch {
    return { ok: false, error: "network" };
  }
}
