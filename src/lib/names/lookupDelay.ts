// How long the send field waits before asking about the typed @handle.
//
// A name this wallet has paid, or one just answered, shows at once. A name that
// is the beginning of a name this wallet has paid ("goa" on the way to "goat")
// is almost certainly not finished: the full name appears as a local suggestion
// under the field, so asking the registry about every prefix would be a request
// for an answer nobody wants. It waits for a longer pause instead; if more
// letters follow, the wait starts over and nothing is sent. Anything else waits
// for the ordinary short pause.
export function nameLookupDelayMs(
  c: { answeredLocally: boolean; prefixOfPaidName: boolean },
  pauseMs: number,
  prefixPauseMs: number,
): number {
  if (c.answeredLocally) return 0;
  return c.prefixOfPaidName ? prefixPauseMs : pauseMs;
}
