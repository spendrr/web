#!/usr/bin/env node
// Moderation of @handles (worker/names.ts). Talks to /api/names/admin/*, which
// the Worker only answers to `Authorization: Bearer $NAMES_ADMIN_TOKEN`.
//
//   NAMES_ADMIN_TOKEN=...  node scripts/names-admin.mjs <command> [args]
//
//   get <name>                      the record (owner mailbox, address, last seen), plus blocked / abandoned
//   list [--after <name>] [--limit <n>]   every registered name, in order, page by page
//   assign <name> --mailbox <id> --address <ark address> [--ln-address]   an extra name (an alias) pointing at an address, outside the one-name-per-mailbox rule; --ln-address also opts it into Lightning payments
//   remove <name> [--ban] [--reason <text>]   take a name away and block it for good; --ban also bars its holder's mailbox
//   block <name> [--reason <text>]  block a name that nobody holds yet
//   unblock <name>                  lift a block (also undoes a remove)
//   unban <mailboxId>               let a banned mailbox register names again
//
// Lightning address (worker/lnLedger.ts, /api/lnaddr/admin/*, same token):
//   ln-status                       manual and automatic kill switch, node health (lastOkAt, downSince)
//   ln-kill                         refuse new Lightning invoices until ln-unkill
//   ln-unkill                       lift the manual switch, and the automatic one if set (it re-trips if the node is still down)
//
// NAMES_BASE_URL overrides the target (default https://spendrr.app), e.g.
// http://localhost:8799 against `wrangler dev`.
//
// The token is set once with `npx wrangler secret put NAMES_ADMIN_TOKEN`.

const base = (process.env.NAMES_BASE_URL ?? "https://spendrr.app").replace(/\/+$/, "");
const token = process.env.NAMES_ADMIN_TOKEN;

function fail(message) {
  console.error(message);
  process.exit(1);
}

if (!token) fail("Set NAMES_ADMIN_TOKEN (the same value as the Worker secret).");

const [command, ...rest] = process.argv.slice(2);
const positional = [];
const flags = {};
for (let i = 0; i < rest.length; i++) {
  const a = rest[i];
  if (a === "--ban") flags.ban = true;
  else if (a === "--ln-address") flags.lnAddress = true;
  else if (["--reason", "--after", "--limit", "--mailbox", "--address"].includes(a)) flags[a.slice(2)] = rest[++i];
  else positional.push(a);
}

// command -> [route, body]
const lnCommands = {
  "ln-status": ["/api/lnaddr/admin/status", {}],
  "ln-kill": ["/api/lnaddr/admin/kill", { killed: true }],
  "ln-unkill": ["/api/lnaddr/admin/kill", { killed: false }],
};

const bodies = {
  get: () => ({ name: need(positional[0], "name") }),
  list: () => ({ after: flags.after, limit: flags.limit ? Number(flags.limit) : undefined }),
  assign: () => ({
    name: need(positional[0], "name"),
    mailboxId: need(flags.mailbox, "--mailbox"),
    address: need(flags.address, "--address"),
    lnAddress: flags.lnAddress === true ? true : undefined,
  }),
  remove: () => ({ name: need(positional[0], "name"), ban: flags.ban === true, reason: flags.reason }),
  block: () => ({ name: need(positional[0], "name"), reason: flags.reason }),
  unblock: () => ({ name: need(positional[0], "name") }),
  unban: () => ({ mailboxId: need(positional[0], "mailboxId") }),
};

function need(value, what) {
  if (!value) fail(`Missing <${what}>. Run with no command for usage.`);
  return value;
}

if (!command || !(command in bodies || command in lnCommands)) {
  fail(
    "Usage: node scripts/names-admin.mjs <get|list|assign|remove|block|unblock|unban|ln-status|ln-kill|ln-unkill> [args]  (see the top of this file)",
  );
}

const [route, body] = command in lnCommands ? lnCommands[command] : [`/api/names/admin/${command}`, bodies[command]()];
const res = await fetch(`${base}${route}`, {
  method: "POST",
  headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
  body: JSON.stringify(body),
});
const text = await res.text();
let out = text;
try {
  out = JSON.stringify(JSON.parse(text), null, 2);
} catch {
  // not JSON: print as is
}
console.log(out);
if (!res.ok) process.exit(1);
