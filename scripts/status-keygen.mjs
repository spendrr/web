#!/usr/bin/env node
// Makes the Ed25519 key pair for the app's status report (status/report.ts).
// `npm run status:keygen`, while logged in to the APP account (wrangler login):
//
//   - the private half goes straight into the app's STATUS_REPORT_KEY secret
//     over wrangler's stdin, never to disk or the terminal;
//   - the public half is written to status/reportKey.ts, to be committed and
//     deployed to the status account (npm run ship:status).
//
// Until both are deployed, reports are rejected (wrong key) and the status page
// shows push and the Lightning address from its own probes only. Refuses to
// replace an existing key unless run with --rotate.

import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const KEY_FILE = join("status", "reportKey.ts");
const WRANGLER = join("node_modules", ".bin", "wrangler");

const current = readFileSync(KEY_FILE, "utf8");
if (!/REPORT_PUBLIC_KEY: string = "";/.test(current) && !process.argv.includes("--rotate")) {
  console.error(`✗ ${KEY_FILE} už klíč má. Nový jen s --rotate.`);
  process.exit(1);
}

const { publicKey, privateKey } = await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"]);
const pub = Buffer.from(await crypto.subtle.exportKey("raw", publicKey)).toString("base64");
const priv = Buffer.from(await crypto.subtle.exportKey("pkcs8", privateKey)).toString("base64");

// The app's wrangler.toml (repo root), so the secret lands on the app account.
const put = spawnSync(WRANGLER, ["secret", "put", "STATUS_REPORT_KEY"], { input: priv, encoding: "utf8" });
if (put.status !== 0) {
  console.error(`${put.stdout ?? ""}${put.stderr ?? ""}`.trimEnd());
  console.error("\n✗ Secret se neuložil, status/reportKey.ts beze změny. Jsi přihlášený k hlavnímu účtu (npx wrangler login)?");
  process.exit(1);
}

writeFileSync(KEY_FILE, current.replace(/REPORT_PUBLIC_KEY: string = "[^"]*";/, `REPORT_PUBLIC_KEY: string = "${pub}";`));
console.log(`✓ STATUS_REPORT_KEY uložený na hlavním účtu\n✓ ${KEY_FILE}: ${pub}\n  Commitni, nasaď oba Workery a odhlas se (npx wrangler logout).`);
