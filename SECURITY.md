# Security

Spendrr handles real Bitcoin on mainnet. Reports are taken seriously.

## Report a vulnerability

Use [GitHub private vulnerability reporting](../../security/advisories/new). If that is not an option,
write to help@spendrr.app with "SECURITY" in the subject. Please do not open a public issue and do not
post details before a fix is out.

Useful in a report: what is affected, steps to reproduce (a signet or regtest wallet is fine, see
`e2e/README.md`), and what an attacker gains.

## Most interesting

- Anything that exposes the seed phrase or lets someone spend without the password above the threshold
  (`src/lib/vault`, `src/lib/wallet/walletSpendPolicy.ts`, `walletWorkerImpl.ts`).
- Ways around the network allowlists (`public/fetch-guard.js`, `src/lib/wallet/walletWorkerGuard.ts`) or
  the Content Security Policy.
- Ways to make the send flow pay somewhere other than what the confirm screen showed.
- A served file that does not match its tagged build (see [VERIFY.md](VERIFY.md)).
- The Worker: authorization of @names and mailboxes, the backup store, the Lightning address callback.

## Out of scope

Missing security headers on static pages without impact, rate limits, social engineering, physical
access to an unlocked device, a user's own compromised browser, and bugs in third-party services
(Ark server, Cloudflare, esplora hosts) unless Spendrr makes them worse.

## What to expect

There is no bounty and no formal SLA. Reports are answered as soon as practical, and a reporter who
acts in good faith (no access to other people's funds or data, no disruption of the service) will not be
pursued. Credit in the fix notes is given if you want it.

## Supported versions

Only the release currently served at spendrr.app.
