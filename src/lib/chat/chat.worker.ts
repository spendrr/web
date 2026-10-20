// Chat worker entry: installs the network guard, then loads the real
// implementation with a dynamic import so the guard runs before any dependency
// is evaluated (same pattern and reasoning as wallet.worker.ts).
import { installChatNetworkGuards } from "./chatWorkerGuard";
import type { ChatRequest } from "./chatProtocol";

installChatNetworkGuards();

const early: ChatRequest[] = [];
self.onmessage = (e: MessageEvent<ChatRequest>) => {
  early.push(e.data);
};

void import("./chatWorkerImpl").then(({ handleChatRequest }) => {
  self.onmessage = (e: MessageEvent<ChatRequest>) => handleChatRequest(e.data);
  for (const req of early) handleChatRequest(req);
});
