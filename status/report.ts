// The app's status report: worker/statusReport.ts signs it every 5 minutes,
// status/worker.ts verifies it. Shared by both Workers, so no imports.
//
// Ed25519, not a shared secret: only the app account holds the private key
// (secret STATUS_REPORT_KEY), the status account holds just the public key in
// code (status/reportKey.ts). Taking the status account over yields nothing
// that could speak for the app.

export interface StatusReport {
  v: 1;
  at: number;
  // Lightning address: the node answered its last check, a kill switch is
  // on, real invoices keep failing (LnLedger).
  lnNode: boolean;
  lnRefusing: boolean;
  lnInvoicesFailing: boolean;
  // Payment push: the relay is up and warm; VAPID is configured at all.
  relay: boolean;
  pushConfigured: boolean;
  // Names registry and wallet backups answered a read.
  names: boolean;
  backups: boolean;
}

export const REPORT_SIGNATURE_HEADER = "x-spendrr-signature";
// Clock skew plus delivery time; anything older is a replay or a stuck queue.
export const REPORT_MAX_AGE_MS = 3 * 60 * 1000;

const BOOLEAN_FIELDS = ["lnNode", "lnRefusing", "lnInvoicesFailing", "relay", "pushConfigured", "names", "backups"] as const;

// Exactly the expected fields, nothing more: the report is data, never text.
export function parseReport(value: unknown): StatusReport | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const o = value as Record<string, unknown>;
  const keys = Object.keys(o).sort();
  const expected = ["at", "v", ...BOOLEAN_FIELDS].sort();
  if (keys.length !== expected.length || keys.some((k, i) => k !== expected[i])) return null;
  if (o.v !== 1 || typeof o.at !== "number" || !Number.isSafeInteger(o.at) || o.at <= 0) return null;
  if (BOOLEAN_FIELDS.some((f) => typeof o[f] !== "boolean")) return null;
  return o as unknown as StatusReport;
}

const toB64 = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes));
function fromB64(s: string): Uint8Array | null {
  try {
    return Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
  } catch {
    return null;
  }
}

export async function signReport(report: StatusReport, privateKeyPkcs8B64: string): Promise<{ body: string; signature: string }> {
  const der = fromB64(privateKeyPkcs8B64);
  if (!der) throw new Error("STATUS_REPORT_KEY is not base64");
  const key = await crypto.subtle.importKey("pkcs8", der, { name: "Ed25519" }, false, ["sign"]);
  const body = JSON.stringify(report);
  const sig = new Uint8Array(await crypto.subtle.sign("Ed25519", key, new TextEncoder().encode(body)));
  return { body, signature: toB64(sig) };
}

// The report, or null for a bad signature, a malformed body or a stale time.
export async function verifyReport(
  body: string,
  signature: string,
  publicKeyRawB64: string,
  now: number,
): Promise<StatusReport | null> {
  const raw = fromB64(publicKeyRawB64);
  const sig = fromB64(signature);
  if (!raw || raw.length !== 32 || !sig || sig.length !== 64) return null;
  const key = await crypto.subtle.importKey("raw", raw, { name: "Ed25519" }, false, ["verify"]);
  if (!(await crypto.subtle.verify("Ed25519", key, sig, new TextEncoder().encode(body)))) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return null;
  }
  const report = parseReport(parsed);
  if (!report || Math.abs(now - report.at) > REPORT_MAX_AGE_MS) return null;
  return report;
}
