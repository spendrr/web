// KV entries with a sliding TTL that are refreshed only when they are getting
// old, instead of on every request.
//
// The push subscribe path used to PUT `endpoint:<endpoint>` on every call: on
// mount/unlock and on every 30 s-debounced balance change, for every device.
// Workers KV on the Free plan allows 1,000 writes a day (and one write a
// second per key), so that write alone sets the ceiling for how many push
// users the app can have. A KV read is cheap (100k a day), so the age is kept
// in the entry's metadata, read together with the value, and the write happens
// once per REFRESH_AFTER_SECONDS per key instead of once per call.
//
// The shard assignment (`shard-assign:`) had the opposite bug: it was written
// once when a mailbox was placed and never refreshed, so it expired 40 days
// after the FIRST subscribe however active the user was (the code comment said
// "refreshed on every renewal"; it was not). See index.ts's
// subscribeToAssignedShard for what an expired one caused.

export interface SlidingKv {
  getWithMetadata<M = unknown>(key: string): Promise<{ value: string | null; metadata: M | null }>;
  put(key: string, value: string, options: { expirationTtl: number; metadata: { t: number } }): Promise<void>;
}

export interface SlidingRead {
  value: string | null;
  // Seconds since the entry was last written by putSliding; Infinity for a
  // missing entry or one written before ages were recorded (so it is rewritten
  // once and from then on carries one).
  ageSeconds: number;
}

export async function getSliding(kv: SlidingKv, key: string, nowMs: number = Date.now()): Promise<SlidingRead> {
  const { value, metadata } = await kv.getWithMetadata<{ t?: unknown }>(key);
  if (value === null) return { value: null, ageSeconds: Infinity };
  const t = metadata && typeof metadata.t === "number" ? metadata.t : null;
  return { value, ageSeconds: t === null ? Infinity : Math.max(0, (nowMs - t) / 1000) };
}

export async function putSliding(
  kv: SlidingKv,
  key: string,
  value: string,
  ttlSeconds: number,
  nowMs: number = Date.now(),
): Promise<void> {
  await kv.put(key, value, { expirationTtl: ttlSeconds, metadata: { t: nowMs } });
}

// Writes only when the stored value differs from `value` or is older than
// refreshAfterSeconds. Returns whether it wrote.
export async function touchSliding(
  kv: SlidingKv,
  key: string,
  value: string,
  current: SlidingRead,
  ttlSeconds: number,
  refreshAfterSeconds: number,
  nowMs: number = Date.now(),
): Promise<boolean> {
  if (current.value === value && current.ageSeconds < refreshAfterSeconds) return false;
  await putSliding(kv, key, value, ttlSeconds, nowMs);
  return true;
}
