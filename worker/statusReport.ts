// Every 5 minutes (on the minute cron, see scheduled() in index.ts) the app
// tells the status Worker (status/, a separate Cloudflare account) what only
// it can see: Lightning address node and invoices, push relay, names, backups.
// Pushed and signed rather than a public endpoint here: a public probe could be
// called by anyone and spend this account's Durable Object budget. A report
// that stops arriving is itself the signal that this cron stopped.

import { REPORT_SIGNATURE_HEADER, signReport, type StatusReport } from "../status/report.ts";

export const STATUS_REPORT_URL = "https://spendrr-status.spendrr-info.workers.dev/v1/report";
const SEND_TIMEOUT_MS = 10_000;

export interface StatusReportInputs {
  // null: the ledger did not answer, so the Lightning address can't work.
  ledger: { lnNode: boolean; lnRefusing: boolean; lnInvoicesFailing: boolean } | null;
  relay: boolean;
  pushConfigured: boolean;
  names: boolean;
  backups: boolean;
}

export function buildStatusReport(i: StatusReportInputs, now: number): StatusReport {
  return {
    v: 1,
    at: now,
    lnNode: i.ledger?.lnNode ?? false,
    lnRefusing: i.ledger?.lnRefusing ?? false,
    lnInvoicesFailing: i.ledger?.lnInvoicesFailing ?? false,
    relay: i.relay,
    pushConfigured: i.pushConfigured,
    names: i.names,
    backups: i.backups,
  };
}

// Never throws: the status page going stale is the right outcome of a failure.
export async function sendStatusReport(privateKey: string, report: StatusReport, url = STATUS_REPORT_URL): Promise<boolean> {
  try {
    const { body, signature } = await signReport(report, privateKey);
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", [REPORT_SIGNATURE_HEADER]: signature },
      body,
      signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
    });
    return res.status === 204;
  } catch {
    return false;
  }
}
