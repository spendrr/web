# Lightning address `name@spendrr.app`: implementation plan

Status: design, written 2026-09-22. Details have changed during the build, the code is authoritative.

## 0. Summary

Every @name can (opt-in, beta) also work as a Lightning address `name@spendrr.app`, payable from any
Lightning wallet. Non-custodial: a small service wallet (`barkd`) receives the payment through
`bolt11_invoice_for_address`, signs the claim directly onto the policy of the recipient's Ark address
and delivers it to the recipient's mailbox. The service never holds a key that could spend the money.

Checked against the `bark-0.7.0` sources (`6188e2d`), the upstream test
`bark_can_receive_lightning_for_offline_address` and a live `GetArkInfo` from the Ark server
(2026-09-22): no anti-DoS token required, LN receive fee 0, `max_vtxo_amount` 10M sats, the needed
CLTV delta 188 <= 250.

**The one open compatibility risk:** the invoice carries only a text description, not a
`description_hash` (the Ark server passes only `Description::Memo` to the hold plugin). The current
LUD-06 does not require the hash, but some wallets still check it. It is measured in phase 0.

## 1. Architecture

```
 payer (any LN wallet)
   │ 1. GET /.well-known/lnurlp/pavel
   │ 3. GET /api/lnurlp/pavel/cb?amount=…
   ▼
 Cloudflare Worker (spendrr.app)
   ├─ NameRegistry DO   name → Ark address, flag lnAddress
   ├─ LnLedger DO       invoice records, limits, receipts
   │ 4. POST /receives/invoice/for-address   (authenticated tunnel)
   ▼
 service node
   ├─ Caddy             lets through 3 paths only, everything else 404
   ├─ barkd             127.0.0.1, daemon running, SQLite
   └─ Litestream        continuous replication of SQLite to object storage
   │ 5. StartLightningReceive / Claim / mailbox post
   ▼
 Ark server ──(ArkoorMessage into the recipient's mailbox)──► recipient's app + push
```

## 2. Payment flow

1. Payer: `GET /.well-known/lnurlp/pavel`. The Worker checks that the name exists, is not abandoned
   and has `lnAddress` on. It returns a `payRequest` (callback, min/max, metadata, `commentAllowed`).
2. The payer chooses an amount and calls the callback `?amount=<msat>&comment=…`.
3. The Worker checks the amount (whole sats, within bounds) and the limits (IP, open invoices per
   name, global), writes a `pending` record into `LnLedger` and calls the service `for-address` with
   the address from `NameRegistry` (never from the request).
4. `barkd` generates the preimage, the Ark server issues a hold invoice, the Worker returns it as
   `pr` (+ a `verify` URL per LUD-21).
5. The payer pays. The Ark server sends `IncomingLightningPayment` to the mailbox of the **service**
   wallet, the daemon (`run_mailbox_messages_process` → `try_claim_lightning_receive`) prepares the
   HTLC VTXO, reveals the preimage and gets the claim signed onto the policy of the recipient's
   address. The payment completes for the payer.
6. `barkd` sends the claim to the recipient's mailbox (`post_arkoor_to_mailboxes`). The `Delivering`
   state recovers by itself after a crash (parked action), backup: `sync()` calls
   `try_claim_all_lightning_receives`.
7. The push path sees the `ArkoorMessage` in the recipient's mailbox and sends a notification
   (no code change).
8. At the next open the app takes over the VTXO through `maintenance()`. The recipient can be offline
   for any length of time.

## 3. Trust model (and what the user is told)

- **The service cannot redirect or spend a payment**, if it gets the right address.
- **It can get it stuck:** between the preimage reveal and the delivery there is a VTXO for the
  recipient that only the service knows about. Losing its database at exactly that moment loses the
  payment. Hence Litestream and alerts.
- **A compromised Worker or service** can issue an invoice to itself instead of `for-address`, and the
  payer cannot tell. The same as with any Lightning address provider. Mitigation: a minimal surface of
  the service (section 5), an audit of receipts in the app (phase 5).
- **Privacy:** the service and the Worker see the amount, the time and the comment of every incoming
  LN payment to a name. The payer's network (IP or /64) is not stored (only an HMAC for 10 minutes for
  the limit of open invoices) and is not given to the recipient.

Copy at the switch (stated as openly as for push): Lightning payments are received by the Spendrr
service and sent on to your wallet at once. It cannot spend or redirect them, but it sees their
amounts, and if it did not work, payments to the address would not go through.

## 4. Components

### 4.1 Service node

- **barkd**: built from the tag `bark-0.7.0` (`6188e2d`), the binary built off the server (Mac,
  cross-compile or CI), its SHA-256 recorded in the repo. It runs as a systemd service under its own
  user, `BARKD_BIND_HOST=127.0.0.1`, auth on (a bearer from `barkd auth`), `--expose-mnemonic` NOT set.
- **Service wallet**: created directly on the server (`bark create`). The seed leaves the server only
  by the operator copying it by hand into a password manager over SSH. It holds no funds, anti-DoS does
  not need it. Should the server start requiring anti-DoS: it gets one small VTXO through arkoor
  (no boarding).
- **Caddy** in front of `barkd` as an allowlist: `POST /api/v1/lightning/receives/invoice/for-address`,
  `GET /api/v1/lightning/receives/{hash}`, `GET /api/v1/lightning/receives` (health only). Anything
  else 404. A compromise of the tunnel therefore does not open `send`, `offboard` or `mnemonic`.
  Caddy adds the bearer for `barkd`; from the Worker it requires its own shared secret.
- **Authenticated tunnel** to an internal hostname, protected by a service token. No inbound port is
  open, SSH by key only.
- **Backstop timer**: a systemd timer every minute calls `POST /api/v1/wallet/sync` (locally), so
  parked receives do not wait only for the mailbox stream.
- **Updates**: unattended-upgrades for the OS; `barkd` by hand only, always a version checked against
  the Ark server.

### 4.2 Worker

New files: `worker/lnurl.ts` (pure logic, testable without a network, modelled on `NameRegistryCore`),
`worker/lnLedger.ts` (DO), changes to `worker/index.ts`, `worker/names.ts`, `wrangler.toml`.

**Routes** (add `"/.well-known/lnurlp/*"` to `run_worker_first`):

| Method | Path | What it does |
|---|---|---|
| GET | `/.well-known/lnurlp/:name` | LUD-06/16 `payRequest` |
| GET | `/api/lnurlp/:name/cb` | issues the invoice, returns `{pr, routes: [], verify}` |
| GET | `/api/lnurlp/verify/:hash` | LUD-21 `{status, settled, preimage, pr}` |
| POST | `/api/names/ln` | opt-in / opt-out, proven by a mailbox authorization (`proveNameMailbox`) |
| POST | `/api/lnaddr/receipts` | receipts for the owner of the name (mailbox authorization) |
| POST | `/api/lnaddr/admin/*` | kill switch, status, manual intervention (`NAMES_ADMIN_TOKEN`) |

**`payRequest`**:
- `tag: "payRequest"`, `callback: https://spendrr.app/api/lnurlp/<name>/cb`
- `minSendable: 100_000` msat (100 sats), `maxSendable`: in the beta `1_000_000_000` msat (1M sats),
  later up to `max_vtxo_amount`.
- `metadata`: `[["text/plain","Payment for @pavel (Spendrr)"],["text/identifier","pavel@spendrr.app"]]`;
  the same text goes into the invoice memo.
- `commentAllowed: 140` (LUD-12), the comment is stored only in `LnLedger`, it does not go into the
  invoice.
- Headers: `Access-Control-Allow-Origin: *`, `Cache-Control: no-store`.
- Errors are always `{status: "ERROR", reason}` with HTTP 200 (as wallets expect), short, in Czech and
  English.

**Callback, checks in this order**: kill switch → the name (lowercase, `handle.ts`) exists, is not
abandoned, has `lnAddress` → `amount` a whole number, divisible by 1000, within bounds → IP rate limit
(`LNURL_RATE_LIMITER`) → `LnLedger.reserve(name)`: a cap on open invoices per name and a global cap on
open ones → a call to the service with a timeout → storing `{hash, name, address, amountSats, comment,
createdAt, state: "pending"}`.

**`LnLedger` DO**: one global (the load is small), SQLite. An invoice goes `pending → settled |
expired`. A Worker cron goes through `pending` records every minute, asks the service for the state,
switches them and cleans up the expired ones. The same cron is the health check: the service
unreachable for a few minutes, or a receive in `Delivering` / `PreimageRevealed` for too long → an
admin push and, automatically, the kill switch for new invoices (only for unavailability, not for a
stuck delivery).

**`NameRecord`**: a new `lnAddress?: boolean`. Set only by the owner (`/api/names/ln`). Cleared on
`release`, on takeover of an abandoned name and on `adminRemove`. Aliases (`spendrr`, `donate`) are
switched on by the admin. A change of the address through `set` leaves the flag (the LN address goes
where the name points).

### 4.3 App (beta, `designVersion` v2)

- **ProfileSheet**: a "Lightning address" switch with the trust explanation (section 3), shows
  `pavel@spendrr.app` + copy. The state is read from `/api/names/mine` (the response is extended with
  `lnAddress`).
- **ProfilePage** (`/@pavel`, public): when on, shows the Lightning address and a QR with the LNURL
  (bech32, LUD-01) for wallets that cannot do Ark. Link preview (`profileMeta.ts`) unchanged.
- **SendPanel**: `x@spendrr.app` is translated to `@x` in the beta (a direct Ark transfer, cheaper,
  the pin check from `namePins.ts` works). Outside the beta an ordinary Lightning address stays (it
  works too, just over LN).
- **History**: in the beta, fetch the receipts (`/api/lnaddr/receipts`) and match them with incoming
  Ark movements by amount and time → a label "Lightning · pavel@spendrr.app" + the comment.
  Best-effort, it must never block loading the history.

## 5. Security and abuse

| Threat | Mitigation |
|---|---|
| A compromised tunnel/Worker issues an invoice to itself | Caddy allowlist (no `pay`/`send`), two independent secrets, a service token; an audit of receipts in the app (phase 5) |
| Someone turns on the LN address on a foreign name | `/api/names/ln` only with a fresh one-time mailbox authorization (the same `proveNameMailbox` as `set`) |
| Invoice spam (each is a hold invoice on the Ark server + a key index + polling) | IP limit, a cap on open invoices per name, a global cap, the kill switch |
| Loss of the service DB during a delivery | Litestream (second-level RPO), an alert on a stuck `Delivering`, a rehearsed restore |
| Takeover of an abandoned name | `lnAddress` is cleared on takeover, the new holder has to turn it on |
| Abuse for laundering / anonymous receiving | amount limits in the beta, no free entry without a registered name |
| Leak of the service seed | the seed nowhere outside the server and a password manager; the service holds no funds anyway |

## 6. Failures and what people see

| Situation | Payer | Recipient |
|---|---|---|
| Service unavailable | `ERROR` "temporarily unavailable", nothing is paid | nothing |
| Service crashes after payment, before the claim | the HTLC waits, the claim happens after a restart; after a long outage it expires and returns to the payer | nothing |
| Service crashes after the claim, before delivery | paid | the money arrives after the service restarts |
| DB lost in that window without a backup | paid | **loss** (hence Litestream) |
| The payer's wallet requires `description_hash` | rejects the invoice | nothing |
| Ark server unavailable | `ERROR` | nothing |


## 8. Testing

- **Unit (Vitest)**: `worker/lnurl.ts` (parsing amounts, metadata, error responses, the order of
  checks), `LnLedger` over in-memory storage (limits, expiry, states, random sequences of operations
  as in `tests/names.test.ts`), `NameRegistryCore` (opt-in, clearing the flag on release/takeover).
- **Locally**: `wrangler dev` + `barkd` against mainnet, real small payments.
- **Compatibility** (phase 4), each with a small payment: Phoenix, Wallet of Satoshi, Breez (Misty),
  Zeus, Alby, Blink, Muun, Aqua, Strike, Cash App. The result goes into a table here.
- **Failures**: `kill -9 barkd` repeatedly during payments and verify delivery; rehearse restoring the
  DB from Litestream on a clean machine; disconnect the service and verify `ERROR` + alert + the kill
  switch.
- **Soak**: two weeks of real use on the maintainer's own name before the beta for others.

