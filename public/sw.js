// Minimal Service Worker — its only job is receiving Web Push events and
// showing a notification, plus focusing/opening the app when that
// notification is tapped. It has no access to the wallet's decrypted
// mnemonic (that only exists in memory inside the open, unlocked app), so it
// cannot settle a payment itself — this is a wake-up, not a background
// claim. See ARCHITECTURE.md's push notifications section. Chat pushes are opened
// by sw-chat.js (keys from IndexedDB, no network).

importScripts("/sw-chat.js");

self.addEventListener("push", (event) => {
  let data = { title: "Spendrr", body: "Přišla ti platba." };
  try {
    if (event.data) data = { ...data, ...event.data.json() };
  } catch {
    // Malformed/unexpected payload — fall back to the generic copy above
    // rather than showing nothing.
  }
  event.waitUntil(
    (async () => {
      // The server used to guess "was this tab probably already handled
      // in-app?" from a stale last-seen timestamp — wrong whenever the tab
      // was opened and then closed again, which silently swallowed real
      // payment pushes for up to 90s after every single app open. The
      // Service Worker can ask the real, current state instead: is there an
      // actually visible+focused window right now? Mirrors notifyPayment()'s
      // own in-app rule (src/lib/notifications.ts) exactly, so the two paths
      // agree on when the toast alone is enough.
      const windows = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
      const appIsForeground = windows.some((c) => c.visibilityState === "visible" && c.focused);
      if (appIsForeground) return;
      if (data.type === "chat") {
        const n = await self.spendrrChatPush.chatNotification(data, Date.now());
        if (!n) return;
        await self.registration.showNotification(n.title, {
          body: n.body,
          icon: "/icon-192.png",
          badge: "/badge-96.png",
          tag: n.tag,
          renotify: true,
          data: n.data,
        });
        if ("setAppBadge" in self.navigator) {
          await self.navigator.setAppBadge(await self.spendrrChatPush.unreadTotal()).catch(() => {});
        }
        return;
      }
      // The same payment told by a chat push a moment ago, with the name and
      // the note: the generic one adds nothing.
      if (data.type !== "expiry") {
        const shown = await self.registration.getNotifications({ tag: "spendrr-payment" });
        if (shown.some((x) => x.data && x.data.chat && Date.now() - x.data.at < 2 * 60 * 1000)) return;
      }
      // A running unilateral exit: the server only sent its generic nudge
      // (it isn't told about the exit); the words come from the app's own
      // hint on this device. See src/lib/exit/exitNudge.ts.
      let tag = data.type === "expiry" ? "spendrr-expiry" : "spendrr-payment";
      if (data.type === "expiry") {
        try {
          const cache = await caches.open("spendrr-exit-hint");
          const res = await cache.match("/__exit-hint");
          const hint = res ? await res.json() : null;
          if (
            hint &&
            typeof hint.title === "string" &&
            typeof hint.body === "string" &&
            typeof hint.at === "number" &&
            Date.now() - hint.at < 40 * 24 * 60 * 60 * 1000
          ) {
            data = { ...data, title: hint.title, body: hint.body };
            tag = "spendrr-exit";
          }
        } catch {
          // No hint: the generic text.
        }
      }
      // Not an exit: word the nudge in the app's language from the copy it left
      // on this device (src/lib/expiryCopy.ts). Without it the Worker's Czech
      // body stays.
      if (data.type === "expiry" && tag === "spendrr-expiry" && data.data && typeof data.data.stage === "string") {
        try {
          const cache = await caches.open("spendrr-expiry-copy");
          const res = await cache.match("/__expiry-copy");
          const copy = res ? await res.json() : null;
          const base = copy && typeof copy[data.data.stage] === "string" ? copy[data.data.stage] : null;
          if (base) {
            let body = base;
            const pct = Number(data.data.pct);
            const move = pct > 0 ? copy.up : pct < 0 ? copy.down : null;
            if (data.data.stage === "first" && data.data.pct !== undefined && Number.isFinite(pct) && typeof move === "string") {
              const shown = Math.abs(pct).toLocaleString(typeof copy.lang === "string" ? copy.lang : undefined, {
                minimumFractionDigits: 1,
                maximumFractionDigits: 1,
              });
              body = move.replace("{pct}", shown) + " " + base;
            }
            data = { ...data, body };
          }
        } catch {
          // No copy: the Worker's text.
        }
      }
      await self.registration.showNotification(data.title, {
        body: data.body,
        icon: "/icon-192.png",
        // A separate transparent, single-shape asset — Android's status-bar
        // badge ignores color and masks by alpha channel, so the full-color
        // opaque-background app icon rendered as a solid square there. See
        // scripts/gen-icons.mjs / public/badge.svg.
        badge: "/badge-96.png",
        // A distinct tag per push kind — same tag would let an expiry nudge
        // silently replace (or get replaced by) an unrelated payment
        // notification in the OS tray instead of both showing.
        tag,
      });
    })(),
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const slot = event.notification.data && event.notification.data.chatSlot;
  event.waitUntil(
    (async () => {
      // A chat notification opens its conversation: the slot goes to the app
      // by message, and through IndexedDB for an app that is not running yet
      // (nothing about the contact in the URL).
      if (typeof slot === "string") await self.spendrrChatPush.rememberOpen(slot);
      const clientsList = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
      for (const client of clientsList) {
        if ("focus" in client) {
          if (typeof slot === "string") client.postMessage({ type: "spendrr-open-chat", slot });
          return client.focus();
        }
      }
      return self.clients.openWindow("/");
    })(),
  );
});
