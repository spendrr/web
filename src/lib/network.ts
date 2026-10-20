// Which Bitcoin network this build talks to, fixed at build time from the
// Vite mode (vite.config.ts defines __NETWORK__). `vite build` runs in mode
// "production", so every deployed build is mainnet and the signet branches
// below are dead code there (checked: no signet host string in dist/).
// `npm run dev -- --mode signet` (launch config "btc-wallet-signet", its own
// port, so its own localStorage and IndexedDB) talks to Second's public
// signet instead: ark.signet.2nd.dev, esplora.signet.2nd.dev, faucet at
// signet.2nd.dev. It is the standard global signet (same blocks as
// blockstream.info/signet), so mempool.space/signet shows its transactions.
//
// `--mode regtest` (E2E only, tests/e2e) talks to a local Ark server and
// esplora started by the harness, over plain http on 127.0.0.1. Like signet
// it is fixed at build time, so it is dead code in a deployed build.
export type AppNetwork = "bitcoin" | "signet" | "regtest";

export const APP_NETWORK: AppNetwork =
  __NETWORK__ === "signet" ? "signet" : __NETWORK__ === "regtest" ? "regtest" : "bitcoin";

export const IS_SIGNET = APP_NETWORK === "signet";

export const IS_REGTEST = APP_NETWORK === "regtest";

export function explorerTxUrl(txid: string): string {
  return IS_SIGNET ? `https://mempool.space/signet/tx/${txid}` : `https://mempool.space/tx/${txid}`;
}
