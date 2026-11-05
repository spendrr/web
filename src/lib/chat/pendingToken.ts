// A token fetched for a contact whose grant has not been sent yet (chatPush.ts,
// SlotRecord.pending). Kept for at most 14 days: the Worker honours a token for
// 60. `at` is the time of the run that fetched it, so a token fetched a moment
// ago in this very run has an age of zero, never a negative one.
export const PENDING_TOKEN_MAX_AGE_MS = 14 * 24 * 60 * 60 * 1000;

export interface PendingToken {
  token: string;
  endpoint: string;
  at: number;
}

// The token to send, or null when there is none for this subscription, it is too
// old, or the clock went back past it.
export function usablePendingToken(pending: PendingToken | undefined, endpoint: string, now: number): string | null {
  if (!pending || pending.endpoint !== endpoint) return null;
  const age = now - pending.at;
  return age >= 0 && age < PENDING_TOKEN_MAX_AGE_MS ? pending.token : null;
}
