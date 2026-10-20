# Architecture and invariants

For contributors and coding agents.
This file keeps only what must be true on every change.

## What this is

Non-custodial Bitcoin web wallet on the **Ark protocol** (mainnet, `ark.second.tech`) via the
`@secondts/bark` WASM SDK. React 19 + Vite, static assets + a Cloudflare Worker at `spendrr.app`.
UI copy and errors are **Czech**, keyword-style and short; no em dash character in copy or chat.

**This handles real mainnet funds.** Treat `src/lib/vault/vaultCrypto.ts`, `crypto.ts`, `walletSession.ts`,
`walletSpendPolicy.ts`, `walletWorkerImpl.ts`, `webauthn.ts`, seed handling and the send flow as
security-sensitive. `tests/` covers pure logic only. `npm run e2e` (manual, local regtest, see `e2e/README.md`) drives the real UI for board and send; nothing else of the wallet flows has E2E.

## Commands

```bash
npm run dev      # Vite on :5173 (signet: npm run dev -- --mode signet)
npm run build    # typecheck:worker + tsc -b + vite build. Run before claiming anything compiles
npm run lint     # oxlint
npm run test     # vitest
```

The build must stay reproducible (no timestamps or machine values).

## Invariants (do not break)

**WASM bridge**
- Every `wallet.*` call goes through the worker's single FIFO queue (`walletWorkerImpl.ts`); only the
  `chatKey` request is answered outside it (no wallet, no WASM, just the session's key). Do not add
  concurrency. Keep the `busyRef` style guards in `Dashboard.tsx` (coalescing and UI state, not crash guards).
- One hung call wedges the queue: `bark.ts` watchdog (two phases: queued vs running, `workerWatchdog.ts`)
  resets the worker and forces unlock. Do not remove without an equivalent recovery path.
- Wrap UI wallet calls in `withTimeout`. A timeout is NOT a failure (the call may still complete): never
  turn it into a fallback that has side effects (see `src/lib/send/arkAddress.ts`, `newAddress()` burns a key index).
- Import runtime values from `@secondts/bark/web`, never the bare package.
- `refresh()` calls both `sync()` and `maintenance*()`; maintenance must not block first render.
- The wallet DB is keyed by name, not mnemonic. The stale-DB wipe retry happens only on the import path and
  only for "incorrect mnemonic"; it now quarantines a copy first (`quarantineWalletDbs`). Never widen it.
- One open wallet per browser profile (`walletTabLock.ts`, Web Lock).

**Seed and spend authority**
- The plaintext mnemonic lives only in the wallet worker (`prepareSession` then `openHeldWallet`). Sentinels
  live in `walletSession.ts` (importing runtime values from `walletWorkerImpl.ts` on the main thread pulls in
  the 7.7 MB SDK). Main-thread callers needing a yes/no use `verifyVaultPassword`; re-encrypt with `*VaultBytes`.
- `walletSpendPolicy.ts` is an ALLOWLIST. A new wallet method must be classified there (a test enumerates the
  interfaces). Sends at or above `PASSWORD_REQUIRED_THRESHOLD_SATS` need a `SpendAuth`; below it the rolling
  no-password cap applies, charged before the call and never refunded. Exit start/cancel/drain/broadcast always
  need auth. `progressExits` args are sanitized in the worker.
- The confirm screen renders a frozen `SendPlan`; `send(plan)` uses exactly that. Do not re-derive inside `send()`.
- Vault `iterations` is clamped; changing KDF/HKDF info strings or salts silently orphans data (vault, backup
  keys, write token). New derivation = new versioned info string plus migration.

**Network hardening**
- Worker guard (`wallet.worker.ts` bootstrap, `walletWorkerGuard.ts`) and `public/fetch-guard.js` install
  before any other code. Allowlist: Ark + esplora hosts, same-origin GET/HEAD under `/assets/` only. No
  same-origin write from the worker ever. The main thread is same-origin only, except one exact URL, GET only
  (`PUBLIC_PRICE_URL`, the public price copy); never widen that to a host or a prefix. New arbitrary-domain methods go in `ARBITRARY_DOMAIN_METHODS`, not
  the host allowlist. Derive the checked URL via `new Request(input, init).url`.
- Dependencies are pinned exactly, `.npmrc` has `ignore-scripts=true`; read diffs on bumps. An SDK bump means
  rebuilding the E2E server from the matching bark tag (`e2e/README.md`).
- bark locks an issued delegated round's inputs itself (checked lock): never leave a lock of ours on a
  submitted coin. A name proof (31 d) must outlive any push authorization a shard accepts (30 d), or a push
  one would pass as a fresh name proof (`worker/names.ts`, `PUSH_AUTH_MAX_LIFETIME_SECONDS`).

**Refresh engine, exit, backup**
- Refresh engine thresholds were agreed with the maintainers: do not change one without asking
  (`src/lib/refreshEngine/`). Locks, submit and completion semantics are in the full notes.
- Exit: one model (`exitModel.ts`), locks via `exitLocks.ts`, coins in pending rounds stay out of a new exit,
  claim needs the destination tag. An exit that is still partly off-chain at VTXO expiry loses the coin.
- Cloud backup: two-phase upload, sha256 of the UNCOMPRESSED JSON, version CAS, write token, serialized
  uploads. A failed restore latches uploads off; `liftConflictLatchIfCovered` lifts it (also for failed
  restores) only when nothing on the server is missing locally. Test with realistic data volume.
- Headline balance is `spendableSats` only, never `+ pendingInRoundSats` (delegated rounds overlap it).

**Worker (Cloudflare Free plan limits shape everything)**
- 100k Worker requests/day (even 429s count), 10 ms CPU, 50 subrequests, KV 1000 writes/day, Durable Objects
  100k requests/day for the whole account. Every active push shard costs 96 DO requests/day (15-min sweep); a shard
  holds up to 200 mailboxes and spends at most 30 mailbox reads per invocation (rotating slice; a mailbox
  still reading its history counts as 5).
- Limiters: per-IP keys go through `bumpRateLimitKey` (IPv6 /64); abuse-sensitive per-source counters use
  `guardPrefix` (IPv6 /48). New-wallet daily caps have a per-source share (`allowNewUnderCaps`). Read bodies
  with `readBodyCapped`; spend the limiter before reading a large body. Every uncaught exception is a 503.
- Mailbox authorizations are proven by `probeMailboxAuthorization` (status header, not the body). Name writes
  use `proveNameMailbox` (fresh, one-time); `mine` does not count against the KV-backed daily write cap.
- @handles: owner = mailbox key. Avatar `SEED_PREFIX` must not change for a given address. Reserved names are
  decided by the registry, not the HTTP handler. `worker/avatarPng.ts` is a second renderer of the avatar.
- Payment push relay (`relay/`, `worker/pushRelay.ts`, docs/payment-push-relay.md): the VPS relay only pokes
  (signed `/api/push/hook`); the shard DO reads the mailbox and sends the push, one check per mailbox at a time.
  Never let the relay send pushes or hold push subscriptions. Shards sweep every 15 min, relay up or down (a 1-minute
  fallback made a relay outage cost the whole DO budget); a relay outage alerts via `RELAY_HEALTHCHECK_PING_URL`.
  `worker/mailboxProto.ts` is shared with the relay: no imports.
- Chat push (`worker/chatPush.ts`, docs/chat-push-design.md) stores nothing: per-contact tokens sealed with
  `CHAT_PUSH_SEAL_KEY`, revoked only by the recipient rotating its push subscription. Changing that key or
  `TOKEN_AAD` invalidates every token handed out. `public/sw-chat.js` mirrors `src/lib/chat/pushFormat.ts`.
- Lightning address: callback order is syntax, amount, comment, limiter, cached lookup, registry target, ledger
  precheck, node. Payment hash and amount come from the invoice itself; the ledger keeps only an HMAC of the
  payer's /48 network.

## Conventions

- Verify visual changes in the browser before a mainnet deploy; the desktop pane is not touch verification.
- Do not trade the design for performance; diagnose with a trace instead.
- Comments explain invariants and non-obvious why, not history. Do not add "used to" narratives; keep incident
  history out of comments.
- Give calibrated confidence before a mainnet deploy: say what is actually verified.
