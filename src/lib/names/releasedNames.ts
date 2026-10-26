// Names given up from this browser, kept for the registry's quarantine (30
// days), each with the wallet that gave it up (its receive address, the key
// nameTouch.ts uses too): after a wallet reset and import, another wallet must
// not be told a name is its own. The public lookup can only say "quarantined";
// the server lets the mailbox that gave a name up take it back, so the edit
// screen uses this to tell that case from a stranger's quarantine. A hint only:
// the server decides.
const KEY = "spendrr.releasedNames";
const QUARANTINE_MS = 30 * 24 * 60 * 60 * 1000;

type Released = Record<string, { at: number; by: string }>;

function read(storage: Storage, now: number): Released {
  try {
    const parsed: unknown = JSON.parse(storage.getItem(KEY) ?? "{}");
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return {};
    const out: Released = {};
    for (const [name, entry] of Object.entries(parsed)) {
      if (typeof entry !== "object" || entry === null) continue;
      const { at, by } = entry as { at?: unknown; by?: unknown };
      if (typeof at === "number" && typeof by === "string" && now - at < QUARANTINE_MS) out[name] = { at, by };
    }
    return out;
  } catch {
    return {};
  }
}

export function rememberReleasedName(
  name: string,
  wallet: string,
  storage: Storage = localStorage,
  now = Date.now(),
): void {
  try {
    storage.setItem(KEY, JSON.stringify({ ...read(storage, now), [name]: { at: now, by: wallet } }));
  } catch {
    // private window or blocked storage: the hint is optional
  }
}

export function forgetReleasedName(name: string, storage: Storage = localStorage, now = Date.now()): void {
  try {
    const { [name]: _gone, ...rest } = read(storage, now);
    storage.setItem(KEY, JSON.stringify(rest));
  } catch {
    // see rememberReleasedName
  }
}

export function wasReleasedBy(
  name: string,
  wallet: string | null,
  storage: Storage = localStorage,
  now = Date.now(),
): boolean {
  if (wallet === null) return false;
  try {
    return read(storage, now)[name]?.by === wallet;
  } catch {
    return false;
  }
}
