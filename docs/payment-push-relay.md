# Push plateb přes relay se streamy

Stav: rozpracované. Navazuje na „Background push notifications“ v [claude-notes-full.md](claude-notes-full.md).

## Proč

Dnes každý shard (`worker/mailboxWatcher.ts`, Durable Object) čte každou minutu Ark mailbox každého
přihlášeného uživatele:
- push přijde až do minuty po platbě
- 1440 DO requestů denně na shard a 1440 čtení mailboxu u Second denně na uživatele
- strop ~2 500 lidí (64 shardů × 40 mailboxů, a DO requesty na Free plánu); od 2026-10-06 64 × 200 = 12 800, viz níže

Ark server umí `SubscribeMailbox`: stream, který zprávu pošle ve chvíli, kdy přijde
(`mailbox_server.proto`, jeden mailbox na stream, pokračuje od checkpointu). Workers stream držet
nemůžou (DO by nikdy neusnul), malý proces na VPS ano.

## Jak

```
appka ─ /api/push/subscribe ─▶ Worker ─▶ shard DO (ověří autorizaci jako dnes)
                                            │ registrace {mailboxId, autorizace, checkpoint}
                                            ▼  (Cloudflare Tunnel + Access + bearer)
                              relay (A1) ══ SubscribeMailbox, 1 stream na mailbox ══▶ ark.second.tech
                                            │ přišla platba (Arkoor / IncomingLightningPayment)
                                            ▼  dávka za ~1 s, HMAC
                              Worker /api/push/hook ─▶ shard DO: přečte mailbox sám ─▶ push
```

- **Relay jen ťuká.** Neposílá push a nezná push subscription. Mailbox si přečte a push pošle dnešní
  shard DO (`checkMailboxForPayments`, beze změny). Napadený relay tak neumí poslat falešné oznámení
  o platbě, nanejvýš vyvolá zbytečné čtení mailboxu. Deduplikace a checkpointy zůstávají v DO.
- **Souběh v DO:** ťuknutí a alarm by mohly číst stejný mailbox naráz a poslat push dvakrát. DO proto
  řadí kontroly jednoho mailboxu za sebe (řetěz slibů na mailbox).
- **Pojistka:** alarm shardu dál čte všechny mailboxy jednou za 15 minut, ať relay běží, nebo ne.
  Výpadek relaye tedy znamená push až o 15 minut později, ne žádný. Minutový režim při výpadku byl
  zrušen (2026-10-06): každý aktivní shard by stál 1 440 DO requestů denně a při desítkách shardů by
  výpadek jedné VPS vyčerpal denní DO limit celého účtu. Výpadek hlásí `RELAY_HEALTHCHECK_PING_URL`
  (healthchecks.io, ping každých 5 minut, `/fail` když relay není ok a zahřátý).
- **Kontrola po částech:** alarm i ťuknutí kontrolují nejvýš 30 mailboxů na invokaci (limit 50 subrequestů na
  Free plánu; mailbox, který teprve načítá historii, se počítá za 5). Alarm bere rotující výřez, takže shard až
  s 200 mailboxy projde všechny jednou za ~1 h 45 min. Přebytek z ťuknutí čeká ve frontě na alarm za 1 s. Pro
  platby mailboxu, který relay zná, se s běžícím relayem nic nemění; mailbox, který nezná, čeká na svůj výřez.
  Upozornění na expiraci mincí a probuzení exitu relay nehlídá: ta chodí jen z výřezu, u plného shardu tedy až
  o ~1 h 45 min později i s běžícím relayem (urgentní upozornění 24 bloků před expirací tím ztratí až polovinu
  rezervy). Dnes se to neprojeví (shardy mají jednotky mailboxů); před růstem řešit přednostní kontrolou mailboxů
  s blížící se výškou.
- **Zahřátý relay:** registrace přicházejí s otevřením appky (nejvýš jednou za 2 h při stejném obsahu)
  a autorizace platí 30 dní. Registraci, kterou relay nepřijal, shard hlásí appce jako 202 a appka ji
  pošle znovu při dalším otevření. Relay
  s databází mladší než 25 hodin ještě nemusí znát všechny aktivní uživatele: do té doby hlásí, že není
  zahřátý (alert), a push pro uživatele, které ještě nezná, chodí jen z 15minutové pojistky.
- **Registrace:** shard ji po úspěšném subscribe pošle relayi i s vlastním checkpointem (relay tak
  nepřehrává historii, kterou už DO zpracoval). Odhlášení a smazání záznamu (TTL, 404/410) relay
  odregistrují. Relay sám zavře stream s prošlou autorizací (expirace je v autorizaci, bajty 33..41).
- **Bez přepínače nic:** dokud ve workeru není `PUSH_RELAY_URL`, všechno běží jako dnes.

## Relay (`relay/`)

- Node 24 LTS, bez závislostí: `node:http2` (gRPC), `node:sqlite` (registrace a checkpointy),
  `node:http` (interní API na 127.0.0.1 za `cloudflared`). Kódování protobufu sdílí s workerem
  (`worker/mailboxProto.ts`).
- Streamy multiplexuje přes HTTP/2 spojení podle `SETTINGS_MAX_CONCURRENT_STREAMS` serveru.
- Spadlý stream: znovu s posledním checkpointem, rostoucí prodleva s náhodou.
- API: `POST /register`, `POST /unregister`, `GET /health` (bearer `PUSH_RELAY_TOKEN`).
- Ťuknutí: `POST {worker}/api/push/hook` `{shards: {"shard-3": [ids]}}`, hlavičky s časem a HMAC-SHA256
  (`PUSH_RELAY_HOOK_SECRET`), okno ±60 s. Shard posílá shard DO při registraci, worker tak nečte KV
  na každé id a jen ověří, že shard existuje (shard sám kontroluje jen svoje mailboxy).
- Odregistrace se shardem smaže registraci jen tomu shardu, který mailbox drží.
- **Rozpočty ťuknutí** (každé stojí Worker request a DO request na shard, z 100k denně na celý účet):
  mailbox max 5 hned, pak 1 za minutu (zbytek počká, neztratí se); celkově ~0,25 jednotky/s
  (jednotka = request), při vyčerpání se ťuknutí slévají do větších dávek. Zahlcení = zpoždění, ne
  vyčerpaný účet.
- **Zdraví** (`/health` `ok`): aspoň 80 % živých registrací má stream, který server přijal (odmítnuté
  se počítají proti), a poslední doručení ťuknutí neselhalo (15 min). Worker vrací 503, když některý
  shard ťuknutí nepřijal. Jinak shardy zpátky na minutu.
- **Mrtvé spojení:** HTTP/2 ping každých 30 s, bez odpovědi do dalšího se spojení zruší a streamy
  se otevřou znovu; spojení bez SETTINGS do 15 s taky. Odmítnutou autorizaci zkusí znovu po 30 min.
- Události streamů se počítají do minutového řádku v logu, nelogují se po jednom.
- Data na stroji: autorizace pro čtení mailboxů (30 dní), stejné jako ve workeru. Žádné peníze,
  žádné push subscription.

## Co se mění pro uživatele

Push o platbě přijde hned. Pokrytí: kdo appku otevřel za posledních 30 dní (každé otevření podepíše
novou autorizaci). Kdo ji neotevře déle, tomu už propadají mince; upozornění na expiraci autorizaci
nepotřebuje. Shard přijme autorizaci nejvýš na 30 dní (`PUSH_AUTH_MAX_LIFETIME_SECONDS`), doklad
pro @jméno je 31denní, aby push autorizace nikdy neprošla jako čerstvý doklad. Kapacita: mainnet
2026-10-06 přijal 1 000 současných streamů z jedné IP bez chyby, výš se netestovalo (signet ~1 950).

## Otevřené

- Kolik streamů z jedné IP Ark server dovolí (dotaz na Second).
