#!/bin/sh
# Runs the E2E tests in parallel, each against its own fresh local regtest
# (bitcoind, esplora, Postgres, Ark server) and a `--mode regtest` production
# build served by `vite preview`, so a test may stop the Ark server or mine hundreds of blocks without
# touching the others. Everything is stopped afterwards. One-time setup
# (binaries into $E2E_HOME/bin): e2e/README.md.
#
#   sh e2e/run.sh                       all e2e/*.test.mjs, E2E_JOBS at a time (default 3)
#   sh e2e/run.sh e2e/exit.test.mjs     one file
#   E2E_JOBS=1 sh e2e/run.sh            one at a time
#   E2E_HOLD=1 sh e2e/run.sh            start one environment and keep it up
set -eu
cd "$(dirname "$0")/.."

E2E_HOME="${E2E_HOME:-$HOME/.cache/spendrr-e2e}"
BIN="$E2E_HOME/bin"
PORT_BASE="${E2E_VITE_PORT:-5190}"
JOBS="${E2E_JOBS:-3}"

for f in captaind electrs regtest-env; do
  [ -x "$BIN/$f" ] || { echo "missing $BIN/$f (see e2e/README.md)"; exit 2; }
done

# macOS Postgres 16 aborts at startup ("postmaster became multithreaded")
# unless a locale is set.
export LC_ALL=C
export BITCOIND_EXEC="${BITCOIND_EXEC:-$(command -v bitcoind)}"
export POSTGRES_BINS="${POSTGRES_BINS:-$(dirname "$(command -v postgres 2>/dev/null || echo /opt/homebrew/opt/postgresql@16/bin/postgres)")}"
export ESPLORA_ELECTRS_EXEC="$BIN/electrs"
export CAPTAIND_EXEC="$BIN/captaind"
export CHAIN_SOURCE=esplora
export RUST_LOG=warn

# start_env PORT: sets WORK, PIDS and the URLs the tests read. Runs inside a
# worker subshell, so several environments never share variables.
start_env() {
  port="$1"
  WORK="$(mktemp -d)"
  export E2E_WORK="$WORK"
  export TEST_DIRECTORY="$WORK/data"
  mkdir -p "$TEST_DIRECTORY"

  # The harness finds its scratch dir with `cargo locate-project`, so it must
  # run inside some cargo workspace; an empty one in the temp dir will do.
  printf '[workspace]\n' > "$WORK/Cargo.toml"
  (cd "$WORK" && exec "$BIN/regtest-env") > "$WORK/env.log" 2>&1 &
  PIDS="$!"
  i=0
  until grep -q '^READY' "$WORK/env.log"; do
    i=$((i + 1))
    [ "$i" -gt 120 ] && { echo "regtest harness did not start:"; tail -20 "$WORK/env.log"; return 1; }
    sleep 1
  done

  export REGTEST_ARK_URL="$(sed -n 's/^ARK_SERVER_URL=//p' "$WORK/env.log")"
  export REGTEST_ESPLORA_URL="$(sed -n 's/^ARK_ESPLORA_URL=//p' "$WORK/env.log")"
  export ARK_CONTROL_URL="$(sed -n 's/^ARK_CONTROL_URL=//p' "$WORK/env.log")"
  # Serve a production build (`vite build` + `vite preview`), not the dev
  # server: no HMR socket or dev client that could reload the page under a
  # test, and it is the bundle that ships (minified, the production worker
  # guard). The Ark and esplora URLs are baked in at build time.
  npx vite build --mode regtest --outDir "$WORK/dist" --emptyOutDir > "$WORK/build.log" 2>&1 \
    || { echo "vite build failed:"; tail -20 "$WORK/build.log"; return 1; }
  npx vite preview --mode regtest --outDir "$WORK/dist" --port "$port" --strictPort > "$WORK/vite.log" 2>&1 &
  PIDS="$PIDS $!"
  i=0
  until grep -q 'Local:' "$WORK/vite.log"; do
    i=$((i + 1))
    [ "$i" -gt 60 ] && { echo "vite preview did not start:"; tail -20 "$WORK/vite.log"; return 1; }
    sleep 1
  done
  export WALLET_URL="$(sed -n 's/.*Local: *\(https\{0,1\}:\/\/[^ ]*\).*/\1/p' "$WORK/vite.log" | head -1 | sed 's#/$##')"
}

stop_env() {
  for p in ${PIDS:-}; do kill "$p" 2>/dev/null || true; wait "$p" 2>/dev/null || true; done
  PIDS=""
  if [ -n "${WORK:-}" ]; then
    # the harness stops its daemons only on SIGINT; sweep what is left
    sleep 1
    pkill -f "$(basename "$WORK")" 2>/dev/null || true
    # daemons need a moment to release their datadirs: wait until none is left
    n=0
    while pgrep -f "$(basename "$WORK")" >/dev/null 2>&1 && [ "$n" -lt 15 ]; do
      n=$((n + 1))
      sleep 1
    done
    rm -rf "$WORK" 2>/dev/null || { sleep 3; rm -rf "$WORK" 2>/dev/null || true; }
    WORK=""
  fi
}

if [ -n "${E2E_HOLD:-}" ]; then
  WORK=""; PIDS=""
  trap stop_env EXIT INT TERM
  start_env "$PORT_BASE"
  echo "HOLD: environment is up. Run a test with:"
  echo "WALLET_URL=$WALLET_URL ARK_CONTROL_URL=$ARK_CONTROL_URL E2E_WORK=$E2E_WORK node e2e/<name>.test.mjs"
  while true; do sleep 60; done
fi

# The refresh test is the longest (the engine ticks once a minute), so it goes
# first; the rest fill the other slots as they free up.
if [ $# -gt 0 ]; then
  TESTS="$*"
else
  TESTS="$(ls e2e/refresh.test.mjs; ls e2e/*.test.mjs | grep -v refresh)"
fi

OUT="$(mktemp -d)"
CLAIMS="$OUT/claims"
mkdir -p "$CLAIMS"
WORKER_PIDS=""
trap 'for p in $WORKER_PIDS; do kill $p 2>/dev/null || true; done; wait; rm -rf "$OUT"' INT TERM

# A worker owns one slot (and so one Vite port) and claims tests by creating a
# directory, which is atomic, until none are left.
worker() {
  slot="$1"
  port=$((PORT_BASE + slot))
  WORK=""; PIDS=""
  trap stop_env EXIT
  for t in $TESTS; do
    name="$(basename "$t" .test.mjs)"
    mkdir "$CLAIMS/$name" 2>/dev/null || continue
    {
      start_env "$port" && node "$t"
    } > "$OUT/$name.log" 2>&1 && echo ok > "$OUT/$name.status" || echo fail > "$OUT/$name.status"
    stop_env
  done
}

n=0
while [ "$n" -lt "$JOBS" ]; do
  worker "$n" &
  WORKER_PIDS="$WORKER_PIDS $!"
  n=$((n + 1))
done
wait

status=0
for t in $TESTS; do
  name="$(basename "$t" .test.mjs)"
  echo "== $t"
  cat "$OUT/$name.log" 2>/dev/null || true
  [ "$(cat "$OUT/$name.status" 2>/dev/null)" = "ok" ] || status=1
done
rm -rf "$OUT"
exit $status
