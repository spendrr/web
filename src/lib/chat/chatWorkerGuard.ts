// Network guard for the chat worker realm, installed by chat.worker.ts before
// any other module (the Nostr code and @noble) is evaluated. Same reasoning as
// walletWorkerGuard.ts: a compromised dependency must not be able to capture an
// unpatched network primitive at its own top level.
//
// The chat key lives here for the session. It cannot move money, but it can
// speak as the user, so this realm may reach exactly the chat relays (relays.ts) over
// WebSocket and nothing else: no fetch at all, no other socket, no nested realm.
import { ALL_CHAT_RELAYS } from "./relays";

const ALLOWED = new Set(ALL_CHAT_RELAYS.map((u) => new URL(u).href));

function blocked(name: string): () => never {
  return () => {
    console.error(`[chat.worker] blocked ${name}`);
    throw new Error(`${name} is not used by the chat worker`);
  };
}

function replace(name: string, value: unknown): void {
  (self as unknown as Record<string, unknown>)[name] = value;
  for (let proto = Object.getPrototypeOf(self) as object | null; proto; proto = Object.getPrototypeOf(proto) as object | null) {
    const descriptor = Object.getOwnPropertyDescriptor(proto, name);
    if (descriptor === undefined) continue;
    if (descriptor.configurable) Object.defineProperty(proto, name, { value, writable: true, configurable: true });
    break;
  }
}

export function installChatNetworkGuards(): void {
  replace("fetch", blocked("fetch"));
  // Cache.add()/addAll() fetch on their own, never through self.fetch, so the
  // patch above does not see them (same hole walletWorkerGuard.ts closes).
  const cacheProto = (self as unknown as { Cache?: { prototype: Record<string, unknown> } }).Cache?.prototype;
  if (cacheProto !== undefined) {
    cacheProto.add = () => Promise.reject(new Error("Cache.add is not used by the chat worker"));
    cacheProto.addAll = () => Promise.reject(new Error("Cache.addAll is not used by the chat worker"));
  }
  if ("XMLHttpRequest" in self) replace("XMLHttpRequest", blocked("XMLHttpRequest"));
  if ("EventSource" in self) replace("EventSource", blocked("EventSource"));
  if ("importScripts" in self) replace("importScripts", blocked("importScripts"));
  if ("Worker" in self) replace("Worker", blocked("Worker"));
  if ("SharedWorker" in self) replace("SharedWorker", blocked("SharedWorker"));
  if (typeof (self as unknown as { WebTransport?: unknown }).WebTransport === "function") {
    const Real = (self as unknown as { WebTransport: { prototype: object } }).WebTransport;
    const guard = blocked("WebTransport");
    replace("WebTransport", guard);
    Object.defineProperty(Real.prototype, "constructor", { value: guard, writable: true, configurable: true });
  }

  const RealWebSocket = self.WebSocket;
  const guardedWebSocket = new Proxy(RealWebSocket, {
    construct(target, args) {
      let href = "";
      try {
        href = new URL(String(args[0])).href;
      } catch {
        href = "";
      }
      if (!ALLOWED.has(href)) {
        console.error(`[chat.worker] blocked WebSocket to ${String(args[0])}`);
        throw new Error("WebSocket host not allowed");
      }
      return new target(href);
    },
  });
  replace("WebSocket", guardedWebSocket);
  // A Proxy forwards `.prototype` to its target, so close the
  // `WebSocket.prototype.constructor` route back to the unguarded original.
  Object.defineProperty(RealWebSocket.prototype, "constructor", {
    value: guardedWebSocket,
    writable: true,
    configurable: true,
  });
}
