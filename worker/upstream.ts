// Deadline for every outbound call the push/mailbox path makes to a server we
// do not control (the Ark mailbox service, browsers' push services, FCM). None
// of them had one: a peer that accepts the connection and then goes quiet held
// its slot in a shard's alarm batch (Promise.all) until the platform cut it
// off, and every mailbox behind it in that shard waited too. A timeout reads
// as a network failure, which every caller already treats as "try next tick".
export const UPSTREAM_TIMEOUT_MS = 15_000;

export function upstreamSignal(ms: number = UPSTREAM_TIMEOUT_MS): AbortSignal {
  return AbortSignal.timeout(ms);
}
