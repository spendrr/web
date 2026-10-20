# Lightning adresa `jmeno@spendrr.app`: implementační plán

Stav: návrh, 2026-09-22. Nic z toho zatím není postavené.

## 0. Shrnutí

Každé @jméno může (opt-in, beta) fungovat i jako Lightning adresa `jmeno@spendrr.app`, kterou zaplatí
jakákoli Lightning peněženka. Nekustodiálně: platbu přijme malá servisní peněženka (`barkd`) přes
`bolt11_invoice_for_address`, claim podepíše rovnou na politiku Ark adresy příjemce a doručí ho do
jeho mailboxu. Servis nikdy nedrží klíč, kterým by šly peníze utratit.

Ověřeno proti zdrojákům `bark-0.7.0` (`6188e2d`), upstream testu
`bark_can_receive_lightning_for_offline_address` a živému `GetArkInfo` z `ark.second.tech`
(2026-09-22): anti-DoS token nevyžadován, poplatek za LN příjem 0, `max_vtxo_amount` 10M sats,
potřebná CLTV delta 188 ≤ 250.

**Jediné otevřené riziko kompatibility:** faktura nese jen textový popis, ne `description_hash`
(Ark server předává hold pluginu jen `Description::Memo`). Aktuální LUD-06 hash nevyžaduje, některé
peněženky ho ale pořád kontrolují. Měří se ve fázi 0.

## 1. Architektura

```
 plátce (libovolná LN peněženka)
   │ 1. GET /.well-known/lnurlp/pavel
   │ 3. GET /api/lnurlp/pavel/cb?amount=…
   ▼
 Cloudflare Worker (spendrr.app)
   ├─ NameRegistry DO   jméno → Ark adresa, příznak lnAddress
   ├─ LnLedger DO       evidence faktur, limity, účtenky
   │ 4. POST /receives/invoice/for-address   (Cloudflare Tunnel + Access token + bearer)
   ▼
 servisní uzel
   ├─ Caddy             propouští jen 3 cesty, vše ostatní 404
   ├─ barkd             127.0.0.1, daemon běží, SQLite
   └─ Litestream        průběžná replikace SQLite → R2
   │ 5. StartLightningReceive / Claim / mailbox post
   ▼
 ark.second.tech ──(ArkoorMessage do mailboxu příjemce)──► appka příjemce + push cron
```

## 2. Tok platby

1. Plátce: `GET /.well-known/lnurlp/pavel`. Worker ověří, že jméno existuje, není opuštěné a má
   zapnutý `lnAddress`. Vrátí `payRequest` (callback, min/max, metadata, `commentAllowed`).
2. Plátce zvolí částku a zavolá callback `?amount=<msat>&comment=…`.
3. Worker zkontroluje částku (celé sats, v mezích), limity (IP, otevřené faktury na jméno, globálně),
   zapíše do `LnLedger` záznam `pending` a zavolá servis `for-address` s adresou z `NameRegistry`
   (nikdy z požadavku).
4. `barkd` vygeneruje preimage, Ark server vystaví hold fakturu, Worker ji vrátí jako `pr`
   (+ `verify` URL podle LUD-21).
5. Plátce zaplatí. Ark server pošle do mailboxu **servisní** peněženky `IncomingLightningPayment`,
   daemon (`run_mailbox_messages_process` → `try_claim_lightning_receive`) připraví HTLC VTXO,
   odhalí preimage a dostane claim podepsaný na politiku adresy příjemce. Plátci se tím platba
   dokončí.
6. `barkd` odešle claim do mailboxu příjemce (`post_arkoor_to_mailboxes`). Stav `Delivering` se po
   pádu sám obnoví (parked action), záloha: `sync()` volá `try_claim_all_lightning_receives`.
7. Push cron uvidí `ArkoorMessage` v mailboxu příjemce a pošle notifikaci (beze změny kódu).
8. Appka při dalším otevření přes `maintenance()` VTXO převezme. Příjemce může být offline libovolně
   dlouho.

## 3. Model důvěry (a co se píše uživateli)

- **Servis nemůže platbu přesměrovat ani utratit**, pokud dostane správnou adresu.
- **Může ji zaseknout**: mezi odhalením preimage a doručením existuje VTXO pro příjemce, o kterém ví
  jen servis. Ztráta jeho databáze přesně v tu chvíli = ztráta platby. Proto Litestream a alerty.
- **Kompromitovaný Worker nebo servis** může místo `for-address` vystavit fakturu sám sobě a plátce
  to nepozná. Stejně jako u každého poskytovatele Lightning adres. Zmírnění: minimální plocha
  servisu (sekce 5), audit účtenek v appce (fáze 5).
- **Soukromí**: servis a Worker vidí částku, čas a komentář každé příchozí LN platby na jméno. Síť plátce (IP nebo /64) se neukládá (jen HMAC na 10 minut pro limit otevřených faktur) a příjemci se nevydává.

Copy v přepínači (česky, stejně otevřeně jako u push): Lightning platby přijímá služba Spendrr
a hned je posílá do tvé peněženky. Nemůže je utratit ani přesměrovat, ale vidí jejich výši a když
by nefungovala, platby na adresu nepůjdou.

## 4. Komponenty

### 4.1 Servisní uzel

- **barkd**: sestavený z tagu `bark-0.7.0` (`6188e2d`), binárka buildovaná mimo server (Mac,
  cross-compile nebo CI), SHA-256 zapsaný v repu. Běží jako systemd služba pod vlastním uživatelem,
  `BARKD_BIND_HOST=127.0.0.1`, auth zapnutá (bearer z `barkd auth`), `--expose-mnemonic` NE.
- **Servisní peněženka**: vytvořená přímo na serveru (`bark create`). Seed opustí server jen tak, že
  si ho uživatel sám přepíše do správce hesel přes SSH. Nedrží prostředky, anti-DoS ji nepotřebuje.
  Kdyby server začal anti-DoS vyžadovat: dostane jedno malé VTXO přes arkoor (bez boardingu).
- **Caddy** před `barkd` jako allowlist: `POST /api/v1/lightning/receives/invoice/for-address`,
  `GET /api/v1/lightning/receives/{hash}`, `GET /api/v1/lightning/receives` (jen pro health).
  Cokoli jiného 404. Tím kompromitace tunelu neotevře `send`, `offboard`, `mnemonic`.
  Caddy doplní bearer pro `barkd`; od Workeru vyžaduje vlastní sdílený secret.
- **Cloudflare Tunnel** (`cloudflared`) na interní hostname, chráněný Cloudflare Access service
  tokenem. Žádný otevřený port dovnitř, SSH jen klíčem (případně i přes tunnel).
- **Backstop timer**: systemd timer každou minutu `POST /api/v1/wallet/sync` (lokálně), aby parked
  příjmy nečekaly jen na mailbox stream.
- **Aktualizace**: unattended-upgrades pro OS; `barkd` jen ručně, vždy verze ověřená proti Ark serveru.

### 4.2 Worker

Nové soubory: `worker/lnurl.ts` (čistá logika, testovatelná bez sítě, po vzoru `NameRegistryCore`),
`worker/lnLedger.ts` (DO), úpravy `worker/index.ts`, `worker/names.ts`, `wrangler.toml`.

**Routy** (přidat `"/.well-known/lnurlp/*"` do `run_worker_first`):

| Metoda | Cesta | Co dělá |
|---|---|---|
| GET | `/.well-known/lnurlp/:name` | LUD-06/16 `payRequest` |
| GET | `/api/lnurlp/:name/cb` | vystaví fakturu, vrátí `{pr, routes: [], verify}` |
| GET | `/api/lnurlp/verify/:hash` | LUD-21 `{status, settled, preimage, pr}` |
| POST | `/api/names/ln` | opt-in / opt-out, dokázané mailbox autorizací (`proveNameMailbox`) |
| POST | `/api/lnaddr/receipts` | účtenky pro vlastníka jména (mailbox autorizace) |
| POST | `/api/lnaddr/admin/*` | kill switch, stav, ruční zásah (`NAMES_ADMIN_TOKEN`) |

**`payRequest`**:
- `tag: "payRequest"`, `callback: https://spendrr.app/api/lnurlp/<name>/cb`
- `minSendable: 100_000` msat (100 sats), `maxSendable`: v betě `1_000_000_000` msat (1M sats), později
  až `max_vtxo_amount`.
- `metadata`: `[["text/plain","Platba pro @pavel (Spendrr)"],["text/identifier","pavel@spendrr.app"]]`;
  stejný text jde do memo faktury.
- `commentAllowed: 140` (LUD-12), komentář uložen jen v `LnLedger`, nejde do faktury.
- Hlavičky: `Access-Control-Allow-Origin: *`, `Cache-Control: no-store`.
- Chyby vždy `{status: "ERROR", reason}` s HTTP 200 (tak to peněženky čekají), česky i anglicky
  stručně.

**Callback - kontroly v tomto pořadí**: kill switch → jméno (lowercase, `handle.ts`) existuje, není
opuštěné, má `lnAddress` → `amount` celé číslo, dělitelné 1000, v mezích → rate limit IP
(`LNURL_RATE_LIMITER`, např. 30/min) → `LnLedger.reserve(name)`: max 20 otevřených faktur na jméno,
globální strop otevřených (např. 2 000) → volání servisu s timeoutem 8 s → uložení `{hash, name,
address, amountSats, comment, createdAt, state: "pending"}`.

**`LnLedger` DO**: jeden globální (zátěž je malá), SQLite. Stav faktury `pending → settled |
expired`. Worker cron každou minutu projde `pending` starší 30 s, zeptá se servisu na stav, přepne
je a expirované uklidí. Tentýž cron = health check: servis nedostupný > 3 min, nebo příjem ve stavu
`Delivering` / `PreimageRevealed` déle než 5 min → admin push (na push subscription provozovatele) a automaticky
kill switch pro nové faktury (jen při nedostupnosti, ne při zaseknutém doručení).

**`NameRecord`**: nové `lnAddress?: boolean`. Nastavuje jen vlastník (`/api/names/ln`). Maže se při
`release`, při převzetí opuštěného jména a při `adminRemove`. Alias (`spendrr`, `donate`) zapíná
admin. Změna adresy přes `set` příznak nechává (LN adresa jde tam, kam ukazuje jméno).

### 4.3 Appka (beta, `designVersion` v2)

- **ProfileSheet**: přepínač „Lightning adresa“ s vysvětlením důvěry (sekce 3), zobrazení
  `pavel@spendrr.app` + kopírovat. Stav čte z `/api/names/mine` (rozšířit odpověď o `lnAddress`).
- **ProfilePage** (`/@pavel`, veřejná): když je zapnuto, ukázat Lightning adresu a QR s LNURL
  (bech32, LUD-01) pro peněženky, které Ark neumí. Link preview (`profileMeta.ts`) beze změny.
- **SendPanel**: `x@spendrr.app` v betě přeložit na `@x` (přímý Ark převod, levnější, funguje pin
  kontrola z `namePins.ts`). Mimo betu zůstává běžná Lightning adresa (funguje taky, jen přes LN).
- **Historie**: v betě stáhnout účtenky (`/api/lnaddr/receipts`) a spárovat s příchozími Ark
  pohyby podle částky a času → štítek „Lightning · pavel@spendrr.app“ + komentář. Best-effort,
  nikdy nesmí zablokovat načtení historie.
- **Changelog** (`CHANGELOG[0]`), všechny texty česky, bez dlouhých pomlček.

## 5. Bezpečnost a zneužití

| Hrozba | Opatření |
|---|---|
| Kompromitovaný tunel/Worker vystaví fakturu sám sobě | Caddy allowlist (nejde `pay`/`send`), dva nezávislé secrets, Access token; audit účtenek v appce (fáze 5) |
| Někdo zapne LN adresu na cizí jméno | `/api/names/ln` jen s čerstvou jednorázovou mailbox autorizací (stejný `proveNameMailbox` jako `set`) |
| Spam faktur (každá = hold faktura na Ark serveru + klíčový index + polling) | IP limit, 20 otevřených na jméno, globální strop, kill switch |
| Ztráta DB servisu během doručení | Litestream (sekundové RPO), alert na zaseknuté `Delivering`, nacvičená obnova |
| Převzetí opuštěného jména | `lnAddress` se při převzetí maže, nový držitel musí zapnout sám |
| Zneužití k praní / anonymní příjem | limity částek v betě, žádný volný vstup bez registrovaného jména |
| Únik seedu servisu | seed nikde mimo server a správce hesel; servis stejně nedrží prostředky |
| Růst DB / disku servisu | monitor velikosti, alert nad 5 GB |

## 6. Selhání a co uvidí lidé

| Situace | Plátce | Příjemce |
|---|---|---|
| Servis nedostupný | `ERROR` „dočasně nedostupné“, nic nezaplatí | nic |
| Servis spadne po zaplacení, před claimem | HTLC čeká, po restartu claim; při dlouhém výpadku vyprší a vrátí se plátci | nic |
| Servis spadne po claimu, před doručením | zaplaceno | peníze přijdou po restartu servisu |
| Ztráta DB v tom okně bez zálohy | zaplaceno | **ztráta** (proto Litestream) |
| Peněženka plátce vyžaduje `description_hash` | odmítne fakturu | nic |
| Ark server nedostupný | `ERROR` | nic |

## 7. Mimo kód

- Zeptat se Second: nevadí jim forwarding pro cizí adresy (ToS `https://second.tech/terms`),
  neplánují vlastní řešení, a navrhnout upstream `description_hash` v `StartLightningReceiveRequest`
  (hold plugin to už umí, `cln-rpc/protos/hold.proto`). To odemkne i NIP-57 zaps.
- Právní stránka: služba nic nedrží, ale ověřit si to (MiCA, AML) je věc tvého uvážení, ne kódu.
- Veřejná stránka / FAQ s modelem důvěry.

## 8. Testování

- **Unit (Vitest)**: `worker/lnurl.ts` (parsování částek, metadata, chybové odpovědi, pořadí
  kontrol), `LnLedger` nad in-memory storage (limity, expirace, stavy, náhodné sekvence operací jako
  u `tests/names.test.ts`), `NameRegistryCore` (opt-in, mazání příznaku při release/převzetí).
- **Lokálně**: `wrangler dev` + `barkd` na Macu proti mainnetu, reálné malé platby.
- **Kompatibilita** (fáze 4), každá malou platbou: Phoenix, Wallet of Satoshi, Breez (Misty),
  Zeus, Alby, Blink, Muun, Aqua, Strike, Cash App. Výsledek zapsat do tabulky tady.
- **Poruchy**: `kill -9 barkd` opakovaně během plateb a ověřit doručení; nacvičit obnovu DB
  z Litestreamu na čistém stroji; odpojit servis a ověřit `ERROR` + alert + kill switch.
- **Soak**: 2 týdny reálného používání na jednom jménu před betou pro ostatní.

