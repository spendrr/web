// The SDK's declared string[] type for a movement's sentToAddresses and
// receivedOnAddresses doesn't always hold: some entries come back as a
// JSON-serialized tagged object (e.g. {"type":"ark","address":"ark1..."})
// instead of a bare string. Unwrap it so callers see the actual address.
export function formatAddressValue(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed.startsWith("{")) return raw;
  try {
    const parsed = JSON.parse(trimmed) as Record<string, unknown>;
    const candidate = parsed.address ?? parsed.addr ?? parsed.value ?? parsed.invoice;
    if (typeof candidate === "string") return candidate;
  } catch {
    // Not JSON after all — fall through to the raw value.
  }
  return raw;
}
