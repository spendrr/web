// The money chat's own opt-in, on top of the V2 beta toggle (Settings →
// "Zprávy (beta)"). Off by default: nothing connects to any relay, no key is
// requested and no button shows until the user turns it on.
import { useSyncExternalStore } from "react";

const KEY = "spendrr-chat-enabled-v1";
const CHANGE_EVENT = "spendrr-chat-enabled-change";

export function isChatEnabled(): boolean {
  try {
    return localStorage.getItem(KEY) === "1";
  } catch {
    return false;
  }
}

export function setChatEnabled(enabled: boolean): void {
  try {
    if (enabled) localStorage.setItem(KEY, "1");
    else localStorage.removeItem(KEY);
  } catch {
    // storage blocked: the switch just does not stick across reloads
  }
  window.dispatchEvent(new Event(CHANGE_EVENT));
}

export function useChatEnabled(): boolean {
  return useSyncExternalStore((cb) => {
    window.addEventListener(CHANGE_EVENT, cb);
    return () => window.removeEventListener(CHANGE_EVENT, cb);
  }, isChatEnabled);
}

// Read receipts, also off by default and both ways (as in most messengers):
// off means this device tells nobody it read their message and shows nobody's
// "Přečteno" either.
const RECEIPTS_KEY = "spendrr-chat-read-receipts-v1";
const RECEIPTS_EVENT = "spendrr-chat-read-receipts-change";

export function isReadReceiptsOn(): boolean {
  try {
    return localStorage.getItem(RECEIPTS_KEY) === "1";
  } catch {
    return false;
  }
}

export function setReadReceiptsOn(on: boolean): void {
  try {
    if (on) localStorage.setItem(RECEIPTS_KEY, "1");
    else localStorage.removeItem(RECEIPTS_KEY);
  } catch {
    // storage blocked: the switch just does not stick across reloads
  }
  window.dispatchEvent(new Event(RECEIPTS_EVENT));
}

export function useReadReceiptsOn(): boolean {
  return useSyncExternalStore((cb) => {
    window.addEventListener(RECEIPTS_EVENT, cb);
    return () => window.removeEventListener(RECEIPTS_EVENT, cb);
  }, isReadReceiptsOn);
}

// Chat notifications (chatPush.ts), per device, off by default; and what they
// show: the text, only who wrote, or nothing about the sender.
const PUSH_KEY = "spendrr-chat-push-v1";
const PREVIEW_KEY = "spendrr-chat-push-preview-v1";
const PUSH_EVENT = "spendrr-chat-push-change";

export type ChatPushPreview = "text" | "name" | "none";

export function isChatPushOn(): boolean {
  try {
    return localStorage.getItem(PUSH_KEY) === "1";
  } catch {
    return false;
  }
}

export function chatPushPreview(): ChatPushPreview {
  try {
    const v = localStorage.getItem(PREVIEW_KEY);
    return v === "name" || v === "none" ? v : "text";
  } catch {
    return "text";
  }
}

export function setChatPushSettings(on: boolean, preview: ChatPushPreview = chatPushPreview()): void {
  try {
    if (on) localStorage.setItem(PUSH_KEY, "1");
    else localStorage.removeItem(PUSH_KEY);
    if (preview === "text") localStorage.removeItem(PREVIEW_KEY);
    else localStorage.setItem(PREVIEW_KEY, preview);
  } catch {
    // storage blocked: the switch just does not stick across reloads
  }
  window.dispatchEvent(new Event(PUSH_EVENT));
}

export function onChatPushSettingsChange(cb: () => void): () => void {
  window.addEventListener(PUSH_EVENT, cb);
  return () => window.removeEventListener(PUSH_EVENT, cb);
}

export function useChatPushOn(): boolean {
  return useSyncExternalStore(onChatPushSettingsChange, isChatPushOn);
}

export function useChatPushPreview(): ChatPushPreview {
  return useSyncExternalStore(onChatPushSettingsChange, chatPushPreview);
}
