# Push pro chat: návrh

Stav: postavené za V2 a chatovým přepínačem (`worker/chatPush.ts`, `src/lib/chat/chatPush.ts`,
`pushFormat.ts`, `pushSlots.ts`, `public/sw-chat.js`). Doručení na skutečném telefonu zatím neověřené.
Nahrazuje odstavec „Push u nové jednorázové žádosti“ v [money-chat-design.md](money-chat-design.md).

## Cíl

- Oznámení o nové zprávě, žádosti a platbě z chatu i se zavřenou appkou.
- V oznámení **jméno odesílatele a text**. Server nevidí ani jedno.
- Odesílatele nejde podvrhnout: kontakt se v oznámení nemůže vydávat za někoho jiného.
- **Žádný Durable Object, žádné KV, žádný alarm.** Cena roste s počtem oznámení, ne s časem.
- Pro uživatele jeden přepínač. Výměna klíčů a obnova běží samy.

## Shrnutí

```
Příjemce (Alice)                         Worker                     Odesílatel (Pepa)
 zapne oznámení
 ── POST /api/chat/push/tokens ───────▶  zapečetí endpoint+slot
 ◀── tokeny ──────────────────────────   (nic neukládá)
 pozvánka v chatu (gift wrap): token + klíč náhledu ───────────────▶ uloží u kontaktu
                                                                     napíše zprávu, Alice není přítomen
                                         ◀── POST /api/chat/poke {token, blob} ──
                                         otevře token, limit,
 ◀── web push {slot, blob} ────────────  RFC 8291, VAPID
 sw.js: klíč slotu → dešifruje blob
 „@pepa: platíš dnes ten oběd?“
```

Blob šifruje odesílatel klíčem, který zná jen on a příjemce. Worker přepošle bajty, které neumí přečíst.

## 1. Token (worker)

- Nový secret `CHAT_PUSH_SEAL_KEY` (32 B), AES-256-GCM, náhodný nonce 12 B, prefix verze `c1.`.
- Obsah: `{endpoint, p256dh, auth, slot (16 B), iat (den)}`. U Android appky endpoint `fcm:<token>` jako dnes.
  Base64url ~350 znaků. AAD `spendrr-chat-push-token-v1`: změna klíče nebo AAD zneplatní všechny vydané
  tokeny (klienti se zotaví přes `ask`).
- **Vydání:** `POST /api/chat/push/tokens {subscription, slots: [...]}`, nejvýš 50 slotů. Same-origin,
  per-IP limit, `readBodyCapped`. Vrátí tokeny a nic neuloží. Jeden request na zapnutí, rotaci nebo dávku
  nových kontaktů.
- **Platnost 60 dní** (worker starší odmítne). Příjemce posílá novou pozvánku po 30 dnech, přibaleno k běžné
  aktivitě v konverzaci. Zapomenutý kontakt tak po čase přijde o možnost pushovat sám.
- **Proč zapečetit a ne jen podepsat:** kontakt nemá vidět push endpoint. Ten prozradí výrobce telefonu
  (Apple, Google, Mozilla) a je to stálý identifikátor zařízení.
- **Proč bez KV:** zrušení tokenu řeší rotace endpointu (oddíl 8), ne seznam v úložišti. Push pak nepotřebuje
  žádné čtení.

## 2. Klíč náhledu (jeden na kontakt)

- Příjemce vygeneruje pro každý přijatý kontakt náhodný `slot` (16 B) a klíč `K` (AES-256-GCM, 32 B).
- **U příjemce:** IndexedDB `spendrr-push`, kterou čte `sw.js`: `slot → {key: CryptoKey (non-extractable),
  name?, n}`. Zapečetěný záznam kontaktu v chatu drží slot, aby appka po kliknutí věděla, kterou konverzaci
  otevřít.
- **U odesílatele:** `{token, key, preview}` v záznamu kontaktu, zapečetěné úložným klíčem jako ostatní
  kontakty. Do zálohy NIP-78 nejde (velikost). Nové zařízení si řekne o novou pozvánku (oddíl 3).
- **Proč odesílatele nejde podvrhnout:** slot přečte worker ze zapečetěného tokenu, odesílatel ho nezmění.
  Blob jde otevřít jen klíčem toho slotu (klíč je pro každý kontakt jiný, AAD je proto jen konstanta). Jméno bere `sw.js` z vlastního seznamu příjemce, nikdy z blobu.
  Kontakt tak může v oznámení mluvit jen sám za sebe.
- **Proč ne jeden klíč pro všechny:** každý kontakt by pak uměl vyrobit oznámení „od“ kohokoli jiného.

## 3. Výměna v chatu

Řídicí zprávy jdou v běžném gift wrapu (kind 1059, doručí se i offline), ale s **vlastním kindem rumoru**
(`KIND_PUSH_CONTROL`), ne jako kind 14. Starší verze Spendrr (`messageFromRumor` vrací `null` pro jiný kind) i
cizí Nostr klienti je tiše ignorují, nikde se neukáže prázdná bublina.

| zpráva | kdo a kdy |
|---|---|
| `{t:"grant", token, key, preview}` | příjemce: zapnutí, přijetí kontaktu, obnova po 30 dnech, rotace, změna úrovně náhledu |
| `{t:"revoke"}` | příjemce: vypnutí oznámení. Odesílatel smaže grant. |
| `{t:"ask"}` | odesílatel bez grantu (starý kontakt, nové zařízení, token vypršel nebo vrátil 410). Nejvýš jednou za 7 dní na kontakt. Příjemce odpoví grantem, jen když má oznámení zapnutá, nejvýš jednou za hodinu na kontakt a jen na ask mladší 2 dní. |

- **Jen přijaté kontakty.** Žádost o kontakt od cizího pozvánku nedostane, takže cizí nemůže pushovat vůbec.
  Daň: první zpráva od neznámého oznámení nespustí. Ukáže se při dalším otevření appky.
- `preview` je `"text" | "name" | "none"`, aby odesílatel neposílal text, který příjemce nechce zobrazit.

## 4. Kdy odesílatel ťukne

- **Ano:** text, žádost, odpověď na žádost, platba, plán.
- **Ne:** reakce, signály (píše, přečteno), řídicí zprávy.
- **Ne, když je druhá strana přítomná:** za posledních 90 s od ní přišla zpráva nebo živý signál. Konverzace
  naživo tak stojí nula pushů.
- **Nejvýš 1 ťuknutí za 60 s na konverzaci.** Zprávy uvnitř okna dají jedno ťuknutí na jeho konci s posledním
  náhledem a počtem. Když se appka dřív skryje, odejde hned (`visibilitychange`, `fetch` s `keepalive`).
- Ťuká se až po potvrzeném doručení na relay, ne při optimistickém odeslání.
- **410 od workeru** (mrtvý endpoint nebo starý token): smazat grant, poslat `ask`.
- Selhání ťuknutí nic neblokuje a neukazuje chybu. Zpráva je doručená tak jako tak.

## 5. Blob

```
{v:1, n, k:"text"|"request"|"payment"|"reply"|"schedule", x?, sats?, note?, c, t}
 → doplnit nulami na 256 B (512 B pro dlouhý text)
 → AES-256-GCM(K, nonce 12 B, AAD = "spendrr-push-v1:" + slot)
```

- `x` je text zkrácený na 120 znaků, jen při `preview: "text"`. Při `"name"` jde jen druh zprávy a částka, při
  `"none"` jen druh.
- `n` je monotónní čítač na kontakt (`max(předchozí + 1, Date.now())`, takže přežije i nový grant se stejným
  slotem). `sw-chat.js` zahodí blob s `n` nižším nebo rovným poslednímu, takže přehraný starý request nic
  neukáže.
- `t` je čas odeslání. Blob starší než 24 h dostane obecný text.
- Padding: délka pushe neprozradí délku zprávy.

## 6. Worker: `POST /api/chat/poke`

1. Same-origin, tělo nejvýš 2 KB (`readBodyCapped`).
2. `CHAT_POKE_IP_LIMITER` přes `bumpRateLimitKey` (návrh 30 za minutu).
3. Otevřít token (AES-GCM), kontrola verze a stáří. Chyba vrátí 410.
4. `CHAT_POKE_SLOT_LIMITER` podle slotu (návrh 3 za minutu). Rate Limiting binding se nepočítá do KV ani DO.
5. Payload `{type:"chat", s: slot, b: blob}`, šifrování RFC 8291 přes stávající `encryptPushPayload`. VAPID JWT
   se drží v cache izolátu na origin push služby (12 h), takže podpis neběží při každém pushi.
   Hlavičky: `TTL: 86400`, `Urgency: high`, `Topic` = 32 znaků z SHA-256 slotu. Push služba pak pro offline
   telefon drží jen poslední push na konverzaci.
6. Odpověď po odeslání pushe: 204, nebo 410 když push služba vrátí 404/410.

- FCM (Android appka): data zpráva se stejným `{s, b}`. Google vidí slot a šifrovaný blob, ne text.
- Nic se neukládá ani neloguje. Cena: 1 request a 1 subrequest na push.

## 7. `sw.js`

- `type: "chat"`: najít slot v IndexedDB, dešifrovat, zkontrolovat `n` a `t`. Úroveň náhledu je menší z
  lokálního nastavení a z blobu.
- Neznámý slot nebo selhané dešifrování: „Nová zpráva“ bez jména.
- Titulek je jméno kontaktu (z IndexedDB příjemce). Tělo podle druhu:
  - text: `x`
  - žádost: „Chce 500 sats · oběd“
  - platba: „Poslal ti 500 sats · oběd“
  - plán: „Posílá 500 sats měsíčně“
- `tag: spendrr-chat-<slot>`: jedno oznámení na konverzaci. Další push ho nahradí, při `c > 1` ukáže
  „@pepa (3)“ s posledním textem.
- **Platba z chatu a platební push:** oba by ukázaly totéž. Chatová verze dostane tag `spendrr-payment`. Když
  přijde obecný push z mailboxu do 2 minut po chatové platbě (`getNotifications`), zahodí se. Kdo nemá
  platební push zapnutý, dostane jen chatový.
- `navigator.setAppBadge(počet)` tam, kde je podporovaný.
- Appka v popředí: nic se neukáže (stávající pravidlo). Kvůli přítomnosti (oddíl 4) takový push skoro
  nepřijde.
- `notificationclick`: fokus nebo otevření appky. Slot jde přes `postMessage`, při novém okně přes IndexedDB
  (nic osobního v URL). Appka podle slotu otevře konverzaci, zavře její oznámení a sníží odznak.
- `sw.js` dál nemá síť, peněženku ani klíče chatu. Přibude jen čtení IndexedDB a AES-GCM. Malá, čitelná
  změna citlivého souboru.

## 8. Blokování a vypnutí

- **Blokování:**
  1. smazat slot z IndexedDB (blokovaný hned ukazuje jen obecný text)
  2. nová push subscription (`unsubscribe` + `subscribe`)
  3. znovu zaregistrovat platební push stávající obnovou
  4. jedním requestem nové tokeny pro zbylé kontakty, rozeslat granty

  Starý endpoint je mrtvý, blokovaný už nic nepošle. Synchronizace se odkládá o 2 s, takže víc blokování
  za sebou dá jednu rotaci.
- **Vypnutí:** stejná rotace (subscription sdílí platební push, nejde ji jen zrušit) a `revoke` všem.
  Když není zapnutý ani platební push, subscription se zruší.
- Do rotace hlídá zneužití limit na slot (3 za minutu).

## 9. Nastavení

- V Nastavení u chatu: přepínač **„Oznámení o zprávách“** a pod ním **„Náhled: Text / Jméno / Nic“**,
  výchozí Text.
- Změna úrovně pošle nové granty (pole `preview`), `sw.js` ji navíc vynucuje sám.
- Popis u přepínače, krátce: náhledy se ukazují i na zamčené obrazovce, klíče náhledů jsou v telefonu mimo
  heslo.
- iOS: push jen u appky přidané na plochu. Bez ní přepínač řekne, co udělat.

## 10. Co kdo vidí

| kdo | vidí | nevidí |
|---|---|---|
| Worker | IP odesílatele, čas, endpoint příjemce (z tokenu), slot, paddovanou velikost | text, jména, Nostr klíče, kdo je odesílatel |
| Push služba (Apple, Google, Mozilla) | že náš server pushuje na endpoint, čas, velikost | obsah (RFC 8291) |
| Google u FCM | slot a šifrovaný blob | text, jméno |
| Relaye | běžné gift wrapy | že jde o pozvánku |
| Telefon příjemce | klíče náhledů a jména kontaktů v IndexedDB, mimo trezor | |

- **Propojení:** endpoint je stejný jako u platebního pushe, takže worker by mohl spojit „tahle peněženka
  dostává zprávy v tyhle časy“. Stejná úroveň důvěry jako u platebních oznámení, přibývá časování zpráv.
- **Zbytkové riziko:** kdo má odemčený telefon nebo profil prohlížeče, přečte jména kontaktů a otevře budoucí
  náhledy. Historii chatu, seed ani Nostr klíč tím nezíská.

## 11. Cena

- 0 Kč, Free plán. 1 Worker request a 1 subrequest na oznámení, vydání tokenů výjimečně. 0 KV, 0 DO.
- Díky přítomnosti a oknu 60 s se platí za zahájené konverzace, ne za zprávy. Při 3 až 5 ťuknutích na člověka
  denně: 2 500 lidí = 7,5k až 12,5k requestů (8 až 13 % ze 100k), 10 000 lidí = 30 až 50 %.
- Strop počtu uživatelů dál drží platební push v DO (~2 500), ne chat.
- CPU: otevření tokenu, šifrování RFC 8291 a topic dohromady pod 1 ms (měřeno v Node se stejným WebCrypto,
  ne přímo ve workerd). VAPID podpis se drží v cache izolátu hodinu na push službu.

## 12. Zvažované a zamítnuté

- **Worker poslouchá relaye** (DO s WebSocketem 24/7): nemůže usnout, cena za čas. No go.
- **Polling relayí v push shardech:** cena za čas, subrequesty, CPU na parsování.
- **KV záznam na token se seznamem zrušených:** zápisy a čtení na každý push. Rotace je zdarma.
- **Jeden klíč náhledu pro všechny / jméno posílá odesílatel:** podvrh odesílatele.
- **Klíč odvozený z Nostr klíče:** `sw.js` ho nemá, je za heslem.
- **Vlastní relay na VPS:** server navíc a propojí Nostr klíč s endpointem.
- **Druhý service worker s vlastním scope** (endpoint oddělený od plateb, worker by je nespojil): nejistá
  podpora na iOS. Možné později.

## 13. Testy a ověření

- **Unit:**
  - token: zapečetění, otevření, stáří, změněný slot
  - blob: padding, šifrování, čítač `n`, AAD
  - pravidla ťuknutí: přítomnost, okno 60 s, 410
  - řídicí zprávy: parsování, ignorování ve starém `messageFromRumor`
- **`wrangler dev`:** poke až do skutečné subscription v Chrome, odmítnutí (cizí origin, starý token,
  limity), měření CPU.
- **Prohlížeč:** dvě testovací peněženky, oznámení se zavřenou záložkou (Chrome desktop), blokování
  a rotace.
- **Uživatel na telefonu:** Android Chrome PWA, iOS PWA na ploše, zamčená obrazovka, klik do konverzace.
- **Android appka (Capacitor):** obecný text, dokud nativní kód neumí dešifrovat.

## 14. Fáze

1. Worker: vydání tokenů, `/api/chat/poke`, limity, testy, CPU.
2. Chat: řídicí zprávy, granty, pravidla ťuknutí u odesílatele.
3. `sw.js` a nastavení: dešifrování, texty, tagy, klik do konverzace, odznak.
4. Blokování a vypnutí s rotací.
5. Sloučení s platebním pushem.

Celé za V2 a chatovým přepínačem jako zbytek chatu.
