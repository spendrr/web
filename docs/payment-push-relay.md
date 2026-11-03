# Payment push through a relay with streams

Status: in progress.

## Why

Today every shard (`worker/mailboxWatcher.ts`, a Durable Object) reads the Ark mailbox of every
registered user on a timer:
- a push arrives up to a minute after the payment
- the Ark server is asked once a minute per user

The Ark server offers `SubscribeMailbox`: a stream that delivers a message the moment it arrives
(`mailbox_server.proto`, one mailbox per stream, resumes from a checkpoint). Workers cannot hold a
stream (the DO would never sleep), a small separate process can.

## How

```
app ─ /api/push/subscribe ─▶ Worker ─▶ shard DO (verifies the authorization as today)
                                          │ registration {mailboxId, authorization, checkpoint}
                                          ▼  (authenticated tunnel)
                            relay ══ SubscribeMailbox, 1 stream per mailbox ══▶ Ark server
                                          │ payment arrived (Arkoor / IncomingLightningPayment)
                                          ▼  batch within ~1 s, HMAC
                            Worker /api/push/hook ─▶ shard DO: reads the mailbox itself ─▶ push
```

- **The relay only pokes.** It does not send pushes and does not know any push subscription. The
  mailbox is read and the push is sent by the shard DO as it is today (`checkMailboxForPayments`,
  unchanged). A compromised relay therefore cannot send a false payment notification, at most it
  triggers a pointless mailbox read. Deduplication and checkpoints stay in the DO.
- **Concurrency in the DO:** a poke and the alarm could read the same mailbox at once and push twice.
  The DO therefore serializes the checks of one mailbox (a promise chain per mailbox).
- **Safety net:** the shard alarm keeps reading all mailboxes on a slow timer whether the relay is up
  or not. A relay outage means a later push, not no push.
- **Warm relay:** registrations arrive when the app is opened and the authorization is valid for 30
  days. A registration the relay did not accept is reported to the app as 202 and the app sends it
  again at the next open. Users the relay does not know yet are covered by the safety net.
- **Registration:** after a successful subscribe the shard sends it to the relay together with its own
  checkpoint (so the relay does not replay history the DO has already processed). Unsubscribe and
  deletion of the record (TTL, 404/410) unregister it at the relay. The relay itself closes a stream
  whose authorization has expired (the expiry is in the authorization, bytes 33..41).
- **Off by default:** until the Worker has `PUSH_RELAY_URL`, everything runs as it does today.

## Relay (`relay/`)

- Node, no dependencies: `node:http2` (gRPC), `node:sqlite` (registrations and checkpoints),
  `node:http` (internal API on 127.0.0.1 behind the tunnel). Protobuf encoding is shared with the
  Worker (`worker/mailboxProto.ts`).
- Streams are multiplexed over HTTP/2 connections according to the server's
  `SETTINGS_MAX_CONCURRENT_STREAMS`.
- A dropped stream resumes from the last checkpoint, with a growing delay and jitter.
- API: `POST /register`, `POST /unregister`, `GET /health` (bearer `PUSH_RELAY_TOKEN`).
- Poke: `POST {worker}/api/push/hook` `{shards: {"shard-3": [ids]}}`, headers with a timestamp and
  HMAC-SHA256 (`PUSH_RELAY_HOOK_SECRET`), a window of +-60 s. The shard DO sends the shard on
  registration, so the Worker does not read KV for every id and only checks that the shard exists
  (the shard itself checks only its own mailboxes).
- Unregistering with a shard deletes the registration only at the shard that holds the mailbox.
- Data on the machine: the authorization to read mailboxes (30 days), the same as in the Worker. No
  money, no push subscriptions.

## What changes for users

A payment push arrives at once. Coverage: whoever opened the app in the last 30 days (every open
signs a new authorization). Whoever does not open it for longer is about to lose coins to expiry
anyway; the expiry notice does not need the authorization. The shard accepts an authorization for at
most 30 days (`PUSH_AUTH_MAX_LIFETIME_SECONDS`) and the proof for an @name is valid for 31 days, so a
push authorization can never pass as a fresh name proof.
