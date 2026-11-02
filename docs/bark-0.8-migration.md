# Migrating to bark 0.8 (SDK `@secondts/bark` 0.26.0)

Plan only, no code change. The wallet stays on SDK 0.25.0 (bark 0.7.1) until bark 0.8.1 is out;
this document is what the bump has to cover, so it can be done in one pass when that happens.

Source: the bark 0.8.0 changelog and the typings of `@secondts/bark@0.26.0`. What the new SDK methods do at
run time has not been read yet, only their types.

## What a trial bump showed

A throwaway copy of the repo with only the SDK swapped to 0.26.0: `tsc -b`, `typecheck:worker` and all 1633
tests pass without a single source change. That says little about safety. `Wallet` in `src/lib/wallet/bark.ts`
is a hand-written projection of the SDK, so the compiler does not check that the real shape under it still
matches, and the changes that matter are in behaviour.

## Compatible on the type level

- `Balance` gains `needsRefreshSats`, `pendingArkoorSendSats`, `pendingOffboardSats`; nothing is removed.
- `sendArkoorPayment` returns the movement id (`number`) instead of `void`; `sendOnchain` returns
  `OffboardResult` instead of a txid string. Callers that ignore the result are unaffected; check that none
  uses the string.
- `estimateEmergencyExitFee` takes an optional `feeMargin` (default 1.2); `fundable` is deprecated.
- New methods and types (BIP 321 URI, payment request parsing, BOLT11 decoding, `BalanceSummary`, `DebugInfo`).

## Work needed

### 1. Refresh engine and locks (largest risk)

Today we rely on bark locking the inputs of an issued delegated round itself, and we never leave a lock of
ours on a submitted coin (ARCHITECTURE, "Network hardening"). In 0.8.0 registering for a round only records
the intent and the inputs are locked when a round attempt starts. A participation also shrinks or cancels
itself when another operation takes its inputs, and `RoundFlowState` has a new `Redelegating` variant.

To re-read and re-test against the new semantics: `refreshSubmit.ts`, `exitLocks.ts`, `refreshEngine/engine.ts`,
`exitModel.ts`. The refresh engine thresholds are agreed with the owner and are not changed by the bump;
only the lock handling may need to.

### 2. Balance

- `spendableSats` no longer includes VTXOs that cannot be sent in an arkoor payment (expired, or exit depth at
  the server limit); they move to `needsRefreshSats`. The headline balance would drop for such coins. Decide
  how to show them (a refresh hint, not silently hidden).
- `pendingInRoundSats` now counts the locked inputs of a round, not its requested outputs, so the overlap with
  `spendableSats` that the "never add `pendingInRoundSats`" rule exists for probably goes away. Re-measure
  before changing that rule.
- Uses of the field: `Dashboard.tsx`, `ExitSheet.tsx`, `refreshEngine/engine.ts`, `maintenance/refreshingBalance.ts`.
- New `pendingArkoorSendSats` and `pendingOffboardSats` count sats that were missing from every field before;
  check the balance and history views for double counting.

### 3. Spend policy

`walletSpendPolicy.ts` is an allowlist and a test enumerates the interfaces, but that enumeration comes from
our own `Wallet` interface, so a new SDK method is not caught by it. Add only what is needed to the interface
and classify each; anything that moves funds needs a `SpendAuth`. Check that the new return values of
`sendArkoorPayment`, `sendOnchain`, `offboardAll` and `offboardVtxos` do not change the charge-before-call
accounting of the no-password cap.

### 4. Exit

- New `vtxo-swept` exit state and error; handle it in `exitModel.ts` and the exit UI (an exit that ends because
  an output its chain needed was spent on chain).
- Fee estimate: `fundable` goes away and the estimate is a funding target to compare against the onchain
  balance. Review how Nouzovy exit shows affordability.
- Exit status now always carries `transactions` (empty unless `include_transactions`).

### 5. Test infrastructure

Rebuild the E2E server from the matching bark tag (`e2e/README.md`), run `npm run e2e` (board and send),
then the signet exit flow (`docs/signet-exit-test.md`). Server config has breaking changes
(`min_trusted_confs` at least 1, new `cln_xpay_max_retry_for`).

### 6. Supply chain

Pinned exact version, read the diff of the new package before the bump. The WASM binary differs, as with
every release; the check from the earlier reproducible-build comparison (exports and imports identical) can
be repeated.

## Worth taking from 0.8.0

- Movement id from sends: link a payment to its history row exactly instead of matching by destination,
  amount and time.
- `needsRefresh` in the balance: stop showing coins as spendable that cannot be paid with.
- Faster and more complete recovery from seed (server-side status per VTXO, xpub lookup that no longer depends
  on the key gap limit); relevant for restore and the cloud backup flow.
- Lightning: `retry_for` for the server's retry window, `inputs-locked` progress phase.
- Exit: proper error for swept VTXOs, deterministic fee estimate that needs no onchain wallet.

## Not in 0.8.0

Nothing there makes `sync()` or `maintenance()` faster or interruptible. The worker queue latency (a user
action waiting behind a running background call) is not solved by the bump and needs its own change.

## Order

1. Wait for bark 0.8.1.
2. Bump on its own branch, nothing else in it.
3. Locks and balance (items 1 and 2) first, with the E2E and signet runs.
4. Spend policy, exit.
5. Behind the V2 toggle first, V1 only on an explicit decision.
