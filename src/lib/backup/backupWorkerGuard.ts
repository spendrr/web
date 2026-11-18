// Network guard for the backup worker realm, installed by backup.worker.ts before any other module is
// evaluated (same reasoning as walletWorkerGuard.ts and chatWorkerGuard.ts). This realm holds the whole
// plaintext bundle and the backup encryption key for one cycle and has no legitimate network use at all: the
// main thread does every request. So every network primitive is blocked, not allowlisted.

function blocked(name: string): () => never {
  return () => {
    console.error(`[backup.worker] blocked ${name}`);
    throw new Error(`${name} is not used by the backup worker`);
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

export const BACKUP_WORKER_BLOCKED = [
  "fetch",
  "XMLHttpRequest",
  "WebSocket",
  "EventSource",
  "importScripts",
  "Worker",
  "SharedWorker",
  "WebTransport",
] as const;

export function installBackupNetworkGuards(): void {
  for (const name of BACKUP_WORKER_BLOCKED) {
    if (name in self) replace(name, blocked(name));
  }
  // Cache.add()/addAll() fetch on their own, never through self.fetch.
  const cacheProto = (self as unknown as { Cache?: { prototype: Record<string, unknown> } }).Cache?.prototype;
  if (cacheProto !== undefined) {
    cacheProto.add = () => Promise.reject(new Error("Cache.add is not used by the backup worker"));
    cacheProto.addAll = () => Promise.reject(new Error("Cache.addAll is not used by the backup worker"));
  }
}
