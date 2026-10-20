// Reads the SDK's recovery report for one gift (see giftScan.ts for what it means). No imports on purpose:
// bark.ts uses it, and giftScan.ts pulls in giftReclaim.ts, which imports bark.ts.

// What one look found. "unknown": the scan did not finish, errored or was incomplete. That is "I do not know",
// never "claimed".
export type GiftScan = "waiting" | "opened" | "claimed" | "unknown";

interface Bucket {
  vtxoIds?: unknown;
}

// Reads the SDK's RecoveryStatus structurally (it crosses the worker boundary as plain data).
export function classifyGiftScan(status: unknown): GiftScan {
  const s = status as { type?: unknown; report?: Record<string, Bucket | undefined> } | null;
  if (!s || s.type !== "completed" || !s.report) return "unknown";
  const r = s.report as Record<string, unknown>;
  const count = (k: string): number => {
    const ids = (r[k] as Bucket | undefined)?.vtxoIds;
    return Array.isArray(ids) ? ids.length : -1;
  };
  const recovered = count("recovered");
  const skipped = count("skipped");
  const exited = count("exited");
  const failed = count("failed");
  const foreign = count("foreign");
  if ([recovered, skipped, exited, failed, foreign].some((n) => n < 0)) return "unknown";
  // A bucket we could not decide, or ids beyond the key scan: not a claim, not a "nothing there" either.
  if (failed > 0 || foreign > 0 || r.isComplete !== true) return "unknown";
  if (recovered > 0) return "opened";
  if (skipped > 0 || exited > 0) return "claimed";
  return "waiting";
}
