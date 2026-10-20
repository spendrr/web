// When the user last looked at Zprávy, for the unread badge. Per browser, not
// per identity: it only decides whether a number shows on a button.
const LAST_READ_KEY = "spendrr-chat-last-read-v1";

export function chatLastRead(): number {
  try {
    return Number(localStorage.getItem(LAST_READ_KEY)) || 0;
  } catch {
    return 0;
  }
}

// Whether this browser has ever opened Zprávy. Together with having a @name it
// decides whether the chat connects at unlock: three relay sockets for someone
// who never uses the chat would only cost battery and data.
const USED_KEY = "spendrr-chat-used-v1";

export function chatUsed(): boolean {
  try {
    return localStorage.getItem(USED_KEY) === "1";
  } catch {
    return false;
  }
}

export function markChatUsed(): void {
  try {
    localStorage.setItem(USED_KEY, "1");
  } catch {
    // storage blocked: the chat then connects when Zprávy is opened
  }
}

export function markChatRead(): void {
  try {
    localStorage.setItem(LAST_READ_KEY, String(Math.floor(Date.now() / 1000)));
  } catch {
    // storage blocked: the badge just stays
  }
}
