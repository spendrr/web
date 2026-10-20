// Public half of the app's status report key (status/report.ts), raw 32-byte
// Ed25519, base64. Written by scripts/status-keygen.mjs, which puts the
// private half straight into the app account's STATUS_REPORT_KEY secret.
// Empty: no key yet, so no report is expected and none is accepted.
export const REPORT_PUBLIC_KEY: string = "3c0a1S4DYglJx1hLH7GcwiY4LIJzvBVgGme1D8pgx78=";
