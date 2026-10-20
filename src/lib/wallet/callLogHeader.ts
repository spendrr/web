// The lines that open an exported call log, so a log somebody sends can be
// tied to a build and a device without asking. Nothing here identifies the
// wallet: no addresses, keys, names or balances.

export interface CallLogHeaderInput {
  version: string;
  commit: string;
  network: string;
  design: string;
  userAgent: string;
  language: string;
  timeZone: string;
  online: boolean | null;
  visibility: string;
  exportedAt: number;
  firstAt: number | null;
  lastAt: number | null;
  count: number;
  errors: number;
}

export function formatCallLogHeader(h: CallLogHeaderInput): string {
  const iso = (t: number | null) => (t === null ? "-" : new Date(t).toISOString());
  return [
    "Spendrr call log",
    `app: ${h.version} (${h.commit.slice(0, 7)})`,
    `network: ${h.network}, design: ${h.design}`,
    `exported: ${iso(h.exportedAt)}`,
    `entries: ${h.count} (errors ${h.errors}), ${iso(h.firstAt)} to ${iso(h.lastAt)}`,
    `device: ${h.userAgent}`,
    `locale: ${h.language}, timezone: ${h.timeZone}, online: ${h.online === null ? "?" : h.online}, page: ${h.visibility}`,
    "---",
  ].join("\n");
}
