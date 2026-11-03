# Push for chat: design

Status: built behind V2 and the chat switch (`worker/chatPush.ts`, `src/lib/chat/chatPush.ts`,
`pushFormat.ts`, `pushSlots.ts`, `public/sw-chat.js`). Delivery on a real phone is not verified yet.

## Goal

- A notification for a new message, request or payment from the chat, also with the app closed.
- The notification shows the **sender's name and the text**. The server sees neither.
- The sender cannot be forged: a contact cannot pose as someone else in a notification.
- **No Durable Object, no KV, no alarm.** The cost grows with the number of notifications, not with time.
- One switch for the user. Key exchange and renewal run by themselves.

## Summary

```
Recipient (Alice)                        Worker                     Sender (Bob)
 turns notifications on
 ── POST /api/chat/push/tokens ───────▶  seals endpoint+slot
 ◀── tokens ──────────────────────────   (stores nothing)
 invitation in the chat (gift wrap): token + preview key ──────────▶ stored with the contact
                                                                     writes a message, Alice is away
                                         ◀── POST /api/chat/poke {token, blob} ──
                                         opens the token, limit,
 ◀── web push {slot, blob} ────────────  RFC 8291, VAPID
 sw.js: slot key → decrypts the blob
 "@bob: are you paying for lunch today?"
```

The sender encrypts the blob with a key that only the sender and the recipient know. The Worker
forwards bytes it cannot read.

## 1. Token (Worker)

- A secret `CHAT_PUSH_SEAL_KEY` (32 B), AES-256-GCM, random 12 B nonce, version prefix `c1.`.
- Content: `{endpoint, p256dh, auth, slot (16 B), iat (day)}`. For the Android app the endpoint is
  `fcm:<token>`. About 350 characters in base64url. AAD `spendrr-chat-push-token-v1`: changing the key
  or the AAD invalidates every issued token (clients recover through `ask`).
- **Issue:** `POST /api/chat/push/tokens {subscription, slots: [...]}`, at most 50 slots. Same-origin,
  per-IP limit, `readBodyCapped`. It returns tokens and stores nothing. One request to turn on, rotate
  or for a batch of new contacts.
- **Valid for 60 days** (the Worker rejects older ones). The recipient sends a new invitation after 30
  days, bundled with ordinary activity in the conversation. A forgotten contact therefore loses the
  ability to push after a while.
- **Why seal and not only sign:** the contact must not see the push endpoint. It reveals the phone
  maker (Apple, Google, Mozilla) and is a stable identifier of the device.
- **Why no KV:** revoking a token is done by rotating the endpoint (section 8), not by a list in
  storage. A push then needs no read.

## 2. Preview key (one per contact)

- For every accepted contact the recipient generates a random `slot` (16 B) and a key `K`
  (AES-256-GCM, 32 B).
- **At the recipient:** the IndexedDB `spendrr-push`, read by `sw.js`: `slot → {key: CryptoKey
  (non-extractable), name?, n}`. The sealed contact record in the chat holds the slot, so the app
  knows which conversation to open after a click.
- **At the sender:** `{token, key, preview}` in the contact record, sealed with the storage key like
  the other contacts. It does not go into the NIP-78 backup (size). A new device asks for a new
  invitation (section 3).
- **Why the sender cannot be forged:** the Worker reads the slot from the sealed token, the sender
  cannot change it. The blob can be opened only with the key of that slot (the key differs per
  contact, so the AAD is just a constant). `sw.js` takes the name from the recipient's own list, never
  from the blob. A contact can therefore speak in a notification only for itself.
- **Why not one key for everyone:** every contact could then produce a notification "from" anyone else.

## 3. Exchange in the chat

Control messages travel in an ordinary gift wrap (kind 1059, delivered also offline), but with their
**own rumor kind** (`KIND_PUSH_CONTROL`), not as kind 14. Older Spendrr versions (`messageFromRumor`
returns `null` for another kind) and foreign Nostr clients ignore them silently, no empty bubble
shows up.

| message | who and when |
|---|---|
| `{t:"grant", token, key, preview}` | recipient: turning on, accepting a contact, renewal after 30 days, rotation, a change of the preview level |
| `{t:"revoke"}` | recipient: turning notifications off. The sender deletes the grant. |
| `{t:"ask"}` | sender without a grant (an old contact, a new device, the token expired or returned 410). At most once per 7 days per contact. The recipient answers with a grant only when notifications are on, at most once per hour per contact and only to an ask younger than 2 days. |

- **Accepted contacts only.** A contact request from a stranger gets no invitation, so a stranger
  cannot push at all. The price: the first message from an unknown person does not trigger a
  notification. It shows at the next open of the app.
- `preview` is `"text" | "name" | "none"`, so the sender does not send text the recipient does not
  want shown.

## 4. When the sender pokes

- **Yes:** text, request, reply to a request, payment, schedule.
- **No:** reactions, signals (typing, read), control messages.
- **No when the other side is present:** a message or a live signal from them in the last 90 s. A live
  conversation therefore costs zero pushes.
- **At most 1 poke per 60 s per conversation.** Messages inside the window give one poke at its end
  with the latest preview and a count. When the app hides earlier, it goes out at once
  (`visibilitychange`, `fetch` with `keepalive`).
- A poke goes out only after delivery to the relay is confirmed, not at the optimistic send.
- **410 from the Worker** (a dead endpoint or an old token): delete the grant, send `ask`.
- A failed poke blocks nothing and shows no error. The message is delivered anyway.

## 5. Blob

```
{v:1, n, k:"text"|"request"|"payment"|"reply"|"schedule", x?, sats?, note?, c, t}
 → pad with zeros to 256 B (512 B for a long text)
 → AES-256-GCM(K, nonce 12 B, AAD = "spendrr-push-v1:" + slot)
```

- `x` is the text cut to 120 characters, only with `preview: "text"`. With `"name"` only the kind of
  message and the amount go, with `"none"` only the kind.
- `n` is a monotonic counter per contact (`max(previous + 1, Date.now())`, so it survives a new grant
  with the same slot). `sw-chat.js` drops a blob whose `n` is lower than or equal to the last one, so
  a replayed old request shows nothing.
- `t` is the send time. A blob older than 24 h gets a generic text.
- Padding: the length of the push does not reveal the length of the message.

## 6. Worker: `POST /api/chat/poke`

1. Same-origin, body at most 2 KB (`readBodyCapped`).
2. `CHAT_POKE_IP_LIMITER` through `bumpRateLimitKey`.
3. Open the token (AES-GCM), check the version and the age. An error returns 410.
4. `CHAT_POKE_SLOT_LIMITER` per slot. A Rate Limiting binding is not counted against KV or DO.
5. Payload `{type:"chat", s: slot, b: blob}`, RFC 8291 encryption through the existing
   `encryptPushPayload`. The VAPID JWT is cached in the isolate per push-service origin (12 h), so the
   signature is not computed for every push. Headers: `TTL: 86400`, `Urgency: high`, `Topic` = 32
   characters of the SHA-256 of the slot. For an offline phone the push service then keeps only the
   latest push per conversation.
6. Response after the push is sent: 204, or 410 when the push service returns 404/410.

- FCM (the Android app): a data message with the same `{s, b}`. Google sees the slot and the encrypted
  blob, not the text.
- Nothing is stored or logged. Cost: 1 request and 1 subrequest per push.

## 7. `sw.js`

- `type: "chat"`: find the slot in IndexedDB, decrypt, check `n` and `t`. The preview level is the
  smaller of the local setting and the blob.
- Unknown slot or a failed decryption: "New message" without a name.
- The title is the contact's name (from the recipient's IndexedDB). The body by kind:
  - text: `x`
  - request: "Wants 500 sats · lunch"
  - payment: "Sent you 500 sats · lunch"
  - schedule: "Sends 500 sats monthly"
- `tag: spendrr-chat-<slot>`: one notification per conversation. The next push replaces it, with
  `c > 1` it shows "@bob (3)" with the latest text.
- **A payment from the chat and the payment push:** both would show the same thing. The chat version
  gets the tag `spendrr-payment`. When a generic push from the mailbox arrives within 2 minutes after
  a chat payment (`getNotifications`), it is dropped. Whoever has no payment push turned on gets only
  the chat one.
- `navigator.setAppBadge(count)` where supported.
- App in the foreground: nothing is shown (the existing rule). Because of presence (section 4) such a
  push hardly arrives.
- `notificationclick`: focus or open the app. The slot goes through `postMessage`, for a new window
  through IndexedDB (nothing personal in the URL). The app opens the conversation by the slot, closes
  its notification and lowers the badge.
- `sw.js` still has no network, no wallet and no chat keys. Only an IndexedDB read and AES-GCM are
  added. A small, readable change to a sensitive file.

## 8. Blocking and turning off

- **Blocking:**
  1. delete the slot from IndexedDB (a blocked contact shows only a generic text at once)
  2. a new push subscription (`unsubscribe` + `subscribe`)
  3. register the payment push again through the existing renewal
  4. one request for new tokens for the remaining contacts, send out the grants

  The old endpoint is dead, the blocked contact can no longer push anything. Synchronization is
  deferred by 2 s, so several blocks in a row give one rotation.
- **Turning off:** the same rotation (the subscription is shared with the payment push, it cannot just
  be cancelled) and `revoke` to everyone. When no payment push is on either, the subscription is
  cancelled.
- Until the rotation, abuse is held back by the per-slot limit.

## 9. Settings

- In the chat settings: a switch **"Message notifications"** and under it **"Preview: Text / Name /
  None"**, default Text.
- A change of the level sends new grants (the `preview` field), `sw.js` also enforces it itself.
- A short description at the switch: previews are also shown on the lock screen, the preview keys are
  on the phone outside the password.
- iOS: push only for an app added to the home screen. Without it the switch says what to do.

## 10. Who sees what

| who | sees | does not see |
|---|---|---|
| Worker | the sender's IP, time, the recipient's endpoint (from the token), slot, padded size | text, names, Nostr keys, who the sender is |
| Push service (Apple, Google, Mozilla) | that our server pushes to the endpoint, time, size | content (RFC 8291) |
| Google with FCM | slot and encrypted blob | text, name |
| Relays | ordinary gift wraps | that it is an invitation |
| Recipient's phone | preview keys and contact names in IndexedDB, outside the vault | |

- **Linkage:** the endpoint is the same as for the payment push, so the Worker could link "this wallet
  receives messages at these times". The same level of trust as for payment notifications, plus the
  timing of messages.
- **Residual risk:** whoever has the unlocked phone or the browser profile reads the contact names and
  can open future previews. They do not get the chat history, the seed or the Nostr key.


## 11. Considered and rejected

- **The Worker listens to relays** (a DO with a WebSocket 24/7): it cannot sleep, cost per time. No go.
- **Polling relays in push shards:** cost per time, subrequests, CPU for parsing.
- **A KV record per token with a revocation list:** writes and reads on every push. Rotation is free.
- **One preview key for all / the sender sends the name:** sender forgery.
- **A key derived from the Nostr key:** `sw.js` does not have it, it is behind the password.
- **A relay of our own on a VPS:** an extra server, and it links the Nostr key to the endpoint.
- **A second service worker with its own scope** (an endpoint separated from payments, the Worker
  would not link them): uncertain support on iOS. Possible later.

## 12. Tests and verification

- **Unit:**
  - token: sealing, opening, age, a changed slot
  - blob: padding, encryption, the counter `n`, AAD
  - poke rules: presence, the 60 s window, 410
  - control messages: parsing, being ignored by the old `messageFromRumor`
- **`wrangler dev`:** a poke all the way to a real subscription in Chrome, rejections (foreign origin,
  old token, limits), CPU measurement.
- **Browser:** two test wallets, a notification with the tab closed (Chrome desktop), blocking and
  rotation.
- **On a phone:** Android Chrome PWA, iOS PWA on the home screen, a locked screen, a click into the
  conversation.
- **Android app (Capacitor):** a generic text until the native code can decrypt.

## 13. Phases

1. Worker: issuing tokens, `/api/chat/poke`, limits, tests, CPU.
2. Chat: control messages, grants, poke rules at the sender.
3. `sw.js` and settings: decryption, texts, tags, a click into the conversation, the badge.
4. Blocking and turning off with rotation.
5. Merging with the payment push.

All of it behind V2 and the chat switch, like the rest of the chat.
