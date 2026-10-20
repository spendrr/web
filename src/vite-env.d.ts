/// <reference types="vite/client" />

declare const __APP_COMMIT__: string;
declare const __APP_COMMIT_DATE__: string;
declare const __APP_VERSION__: string;
// "bitcoin" in every deployed build; "signet" only under `vite --mode signet` (src/lib/network.ts).
declare const __NETWORK__: string;
declare const __REGTEST_ARK_URL__: string;
declare const __REGTEST_ESPLORA_URL__: string;
