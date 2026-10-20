// Messages between the main thread (chatClient.ts) and the chat worker. Types
// only, so the main thread can import it without pulling in any crypto.
import type { Rumor } from "./nostr";

export type ChatRequest =
  // keyPort receives the chat key from the wallet worker (bark.ts's
  // deliverChatKey); `since` is the unix time to resubscribe from.
  | { type: "init"; keyPort: MessagePort; since: number }
  // kind is 14 (a message) or 7 (a reaction).
  | { type: "send"; reqId: number; to: string; kind: number; content: string; tags: string[][] }
  // Publishes an already built rumor of ours again (a failed send). The same
  // rumor id lets the recipient drop it if the first attempt did arrive.
  | { type: "resend"; reqId: number; rumor: Rumor }
  // Contacts and schedules, encrypted to ourselves (chatBackup.ts).
  | { type: "saveState"; reqId: number; json: string }
  | { type: "bindProof"; reqId: number; mailboxId: string }
  // Fire and forget: a live signal (signals.ts) in an ephemeral wrap.
  | { type: "signal"; to: string; content: string }
  // A push control message (pushFormat.ts) to one contact.
  | { type: "control"; reqId: number; to: string; content: string }
  // The content of the newest kind 0 profile of `pubkey` (null: none found).
  | { type: "profile"; reqId: number; pubkey: string }
  | { type: "lock" };

export type ChatEvent =
  // storeKey encrypts what the chat keeps on this device (chatStore.ts):
  // AES-GCM, derived from the chat key, not extractable.
  | { type: "ready"; pubkey: string; storeKey: CryptoKey }
  // `sendReq` marks our own message the moment it is built, before any relay
  // has it: the bubble shows at once, the send's result settles its state.
  | { type: "rumor"; rumor: Rumor; sendReq?: number }
  | { type: "selfState"; json: string; createdAt: number }
  // A live signal from `from`, already authenticated by its seal.
  | { type: "signal"; from: string; content: string; createdAt: number }
  // A push control message from `from`, authenticated by its seal.
  | { type: "control"; from: string; content: string; createdAt: number }
  // The relays had their chance to return the stored state; writing is safe.
  | { type: "selfSynced" }
  | { type: "result"; reqId: number; ok: true; value: unknown }
  | { type: "result"; reqId: number; ok: false; error: string }
  | { type: "relays"; connected: number; total: number }
  | { type: "error"; error: string };
