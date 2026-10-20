# Regtest E2E

Drives the real UI of a `vite build --mode regtest` bundle served by `vite preview` (real WASM worker, FIFO queue, send plan) against a
local Ark server, esplora and bitcoind. Nothing touches mainnet. Manual, not part of `build`/`test`/`ship`.

```bash
npm run e2e
```

`run.sh` gives every `e2e/*.test.mjs` its own fresh harness and a regtest build and stops everything
afterwards. Tests run in parallel, `E2E_JOBS` at a time (default 3, preview ports 5190 and up). The refresh test is
the longest (~2 min, the engine ticks once a minute), so more than 3 slots do not make the suite faster. Blocks and Ark rounds are driven by the tests (`/generate_blocks`, `/trigger_round`,
`/fund_address` on the harness control server), so nothing waits on a clock.

## What it needs

Matching the SDK: `@secondts/bark` 0.25.0 is bark 0.7.1, so build the server side from the tag `bark-0.7.1`.
Binaries go in `~/.cache/spendrr-e2e/bin` (override with `E2E_HOME`).

```bash
brew install postgresql@16 bitcoin          # bitcoind 31.x, Postgres 16

git clone https://gitlab.com/ark-bitcoin/bark.git && cd bark && git checkout bark-0.7.1
cp /path/to/btc-wallet/e2e/harness/regtest_env.rs wasm-testing/src/bin/regtest_env.rs
# add to wasm-testing/Cargo.toml, before the wasm-test-suite bin:
#   [[bin]]
#   name = "regtest-env"
#   path = "src/bin/regtest_env.rs"
#   required-features = [ "bin" ]
cargo build --release -p bark-server --bin captaind                      # ~6 min
cargo build --release -p wasm-testing --features bin --bin regtest-env   # ~3 min

git clone https://github.com/Blockstream/electrs.git && cd electrs
git checkout ef4417921511610fe8c9663020ce7b835cb1f14a                    # esplora-electrs, rev from bark's nix/dev-shell.nix
cargo build --release --bin electrs                                      # ~4 min

mkdir -p ~/.cache/spendrr-e2e/bin    # copy captaind, regtest-env, electrs into it
```

Bumping the SDK means rebuilding these from the matching bark tag.

## Notes

- The regtest build is a build-time mode like signet (`src/lib/network.ts`). Its Ark and esplora URLs come
  from `REGTEST_ARK_URL` / `REGTEST_ESPLORA_URL`, set by `run.sh`. The only guard change is accepting
  `http://127.0.0.1` in `walletWorkerGuard.ts`, behind `IS_REGTEST`. A production build contains none of it:
  check with `grep -rE "Regtest|127\.0\.0\.1" dist/` after `npm run build` (must print nothing).
- macOS: Postgres 16 aborts at startup ("postmaster became multithreaded") unless a locale is set, which
  `run.sh` does with `LC_ALL=C`.
- The harness has no Lightning node, so LN, push and the Worker are not covered.
- Run one file: `sh e2e/run.sh e2e/unlock-restore.test.mjs`. `E2E_JOBS=1` runs one at a time. On failure a test prints the page's buttons and text (`debugDump`) and saves `/tmp/e2e-fail.png`.
- v2 hides the header lock button, so `lockWallet` double-clicks the lock gesture area instead.
- Balance checks are anchored (`/Spendrr 5 000 sats/`): the header text is `Spendrr <balance> sats`, and an unanchored `5 000 sats` also matches `125 000 sats`.
- The refresh engine is a V2 beta feature: `newWallet(browser, label, { v2: true })` sets `btc-wallet-design-version` before the page runs. The test server's VTXO lifetime is 432 blocks and the engine's threshold 250, so mining 200 blocks makes a coin due; the engine ticks about once a minute, which is most of that test's 2 minutes.
- A regtest build polls the on-chain balance every 2 s instead of 30 s (`Dashboard.tsx`), otherwise every test would wait half a minute for its deposit.
- Parallel environments are told apart by their temp dir (`E2E_WORK`, exported by `run.sh`): `killArkServer` and `mineDirect` only touch their own daemons. The daemons report the resolved path (`/private/var/...`), so match on the unique `tmp.XXXX` name, not the whole path.
- Each test gets a fresh environment because the exit test stops the Ark server (that is the point of an
  emergency exit) and the refresh test mines 200 blocks. While the server is down the control server's
  `/generate_blocks` hangs, so those tests mine with `mineDirect` (bitcoin-cli against the central bitcoind).
- Negative checks (`assertStays`) refresh the page and require the old state to hold for several seconds. A single
  read right after an error proves nothing, because the page may not have noticed a payment yet. After an
  on-chain "refused" step, trigger a round and mine before asserting the chain, since an offboard only shows then.
- Every test ends with `failOnPageProblems()`: an uncaught page error or WASM panic fails it even if the numbers
  are right.
- Why a built bundle and not the dev server: Vite's dev client reloads the page when its HMR socket drops (seen
  under heavy CPU load) and probes through a `SharedWorker`, which `fetch-guard.js` blocks, so a test died with a
  `pageerror` and a dead wallet. A built bundle has no dev client, no HMR and no dependency re-optimization, and it
  is what ships (minified, production worker guard). The Ark and esplora URLs are baked in at build time, so
  `run.sh` builds once per environment (under a second).
- What this does NOT prove: the worker-level spend gate (`walletSpendPolicy.ts`, a compromised page), restore of
  keys past the gap limit, the Cloudflare layer (`_headers`/CSP and the Worker are not served by `vite preview`), or
  the production esplora (the harness uses Blockstream's electrs, so fee estimates are unknown and some package
  calls fail).
- UI selectors are the Czech labels (the context sets `locale: "cs-CZ"`), so a copy change breaks a test.
