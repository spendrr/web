// The money chat's switch (Settings → Zprávy). On by default for everyone, no
// beta gate; "0" is the one stored value, written when the user turns it off.
// Being on does not connect anything by itself: a relay is only contacted for
// someone who has a @name or has opened Zprávy (Dashboard.tsx).
import { useSyncExternalStore } from "react";

const KEY = "spendrr-chat-enabled-v1";
const CHANGE_EVENT = "spendrr-chat-enabled-change";

export function isChatEnabled(): boolean {
  try {
    return localStorage.getItem(KEY) !== "0";
  } catch {
    return true;
  }
}

export function setChatEnabled(enabled: boolean): void {
  try {
    if (enabled) localStorage.removeItem(KEY);
    else localStorage.setItem(KEY, "0");
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

// Read receipts, on by default and both ways (as in most messengers): off
// means this device tells nobody it read their message and shows nobody's
// "Přečteno" either. "0" is the one stored value, written when turned off.
const RECEIPTS_KEY = "spendrr-chat-read-receipts-v1";
const RECEIPTS_EVENT = "spendrr-chat-read-receipts-change";

export function isReadReceiptsOn(): boolean {
  try {
    return localStorage.getItem(RECEIPTS_KEY) !== "0";
  } catch {
    return true;
  }
}

export function setReadReceiptsOn(on: boolean): void {
  try {
    if (on) localStorage.removeItem(RECEIPTS_KEY);
    else localStorage.setItem(RECEIPTS_KEY, "0");
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
