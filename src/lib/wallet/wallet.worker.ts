// Entry point for the wallet worker — deliberately does nothing except
// install network guards and then dynamically import the real
// implementation (walletWorkerImpl.ts, which imports @secondts/bark/web).
//
// This ordering matters: ES module semantics evaluate a statically imported
// module's top-level code *before* the importing module's own code after
// the import statement runs. If this file statically imported the SDK and
// installed patches afterward, a compromised @secondts/bark release could
// capture the real self.fetch (or WebSocket, etc.) at its own module top
// level, before any patch installed later in this file would apply — the
// same class of bug the main-thread guard (public/fetch-guard.js) exists to
// avoid by loading as a classic <script> before the bundle. A dynamic
// import() only runs after this file's own top-level code has finished, so
// installNetworkGuards() below is guaranteed to run first.
import type { Request } from "./walletWorkerImpl";
import { installNetworkGuards } from "./walletWorkerGuard";
import { isNetProbeRequest, runNetProbe } from "../connectivity/netProbeWorker";

installNetworkGuards();

// Connectivity probes (netProbeWorker.ts) are answered right here, before the
// buffer below and outside walletWorkerImpl.ts's FIFO queue, in both phases:
// they matter precisely while a wallet call is hanging, and while the SDK
// chunk is still loading.
function handleNetProbe(data: unknown): boolean {
  if (!isNetProbeRequest(data)) return false;
  void runNetProbe(data).then((reply) => self.postMessage(reply));
  return true;
}

// bark.ts posts its first request (ensureWasm) immediately after
// constructing this worker, without waiting for any "ready" signal — and
// the dynamic import() below is asynchronous (a real module fetch+eval), so
// a message can arrive before walletWorkerImpl.ts has registered its real
// handler. Buffer anything that shows up in the meantime and replay it
// through the real handler, in order, once it's loaded — otherwise that
// first message would just be silently dropped (a message event with no
// listener isn't queued or retried).
const earlyMessages: MessageEvent<Request>[] = [];
self.onmessage = (e: MessageEvent<Request>) => {
  if (handleNetProbe(e.data)) return;
  earlyMessages.push(e);
};

void import("./walletWorkerImpl").then(({ handleMessage }) => {
  self.onmessage = (e: MessageEvent<Request>) => {
    if (handleNetProbe(e.data)) return;
    handleMessage(e.data);
  };
  for (const e of earlyMessages) handleMessage(e.data);
});
