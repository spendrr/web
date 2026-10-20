// Live signals between two chat clients: "typing", "entering an amount" and
// "read up to". They travel in ephemeral gift wraps (KIND_EPHEMERAL_WRAP), so
// relays forward them to whoever listens right now and store nothing; a signal
// nobody was there to receive is simply gone. Pure, unit-tested.

// The rumor kind inside the wrap. Spendrr's own, outside the ranges other
// clients would render as a message.
export const KIND_SIGNAL = 20014;
const MAX_SIGNAL_CHARS = 200;

export type Signal = { t: "typing"; what: "text" | "amount" } | { t: "stop" } | { t: "read"; upTo: number };

export function parseSignal(content: string): Signal | null {
  if (content.length > MAX_SIGNAL_CHARS) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(content);
  } catch {
    return null;
  }
  if (typeof raw !== "object" || raw === null) return null;
  const s = raw as Record<string, unknown>;
  if (s.t === "typing" && (s.what === "text" || s.what === "amount")) return { t: "typing", what: s.what };
  if (s.t === "stop") return { t: "stop" };
  if (s.t === "read" && typeof s.upTo === "number" && Number.isSafeInteger(s.upTo) && s.upTo > 0) {
    return { t: "read", upTo: s.upTo };
  }
  return null;
}

export function signalContent(s: Signal): string {
  return JSON.stringify(s);
}
