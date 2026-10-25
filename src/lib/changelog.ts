// Manually curated, user-facing changelog. Not generated from git log: commit
// messages are internal, this is read by people who aren't developers.
//
// Where it shows:
// - WhatsNewModal: once, right after the app updates, ONLY CHANGELOG[0]. In
//   the v2 sheet the title is the big headline under the app icon and the
//   items sit below it as a short list.
// - Settings → O peněžence → Zobrazit changelog: every entry, newest first.
//
// Rules for a new entry (add it at the top, as part of the ship, before the
// commit; see ARCHITECTURE.md "Default ship order"):
// - Only changes a non-developer would notice or care about. Skip cosmetic,
//   internal, refactor and perf-only changes entirely.
// - One entry per ship. Several user-visible changes in one ship go into ONE
//   entry (the update sheet shows only the top one); pick the two that matter.
// - date: Czech format without leading zeros, "4. 10. 2026".
// - title: 1-4 words, a headline naming what the user sees ("Zpět v appce",
//   "Nový skener QR kódů"). No trailing period, no "(beta)", no generic
//   "Opravy" / "Vylepšení". For a series about one area use "Oblast: co"
//   ("Zprávy: oznámení").
// - items: 1-2, each one sentence of roughly 8-12 words ending with a period.
//   Say what the user can do now or what changed for them, not how it works.
//   No jargon (VTXO, Ark, round, mailbox) unless there is no plain word.
//   Address the user as "ty" ("tvůj telefon"), never "vy".
// - beta: an item whose change is only behind the V2 toggle is written as
//   { text, beta: true }. The UI renders the "V betě" label from the flag;
//   never put "V betě:" into the text itself.
// - Copy rules of the whole app apply: Czech, terse, no em dash, no emoji.
// - Every title and item text needs an English entry in src/lib/i18n.ts
//   (tests/i18n.fuzz.test.ts fails otherwise).

export type ChangelogItem = string | { text: string; beta: true };

export interface ChangelogEntry {
  date: string;
  title: string;
  items: ChangelogItem[];
}

export function changelogItemText(item: ChangelogItem): string {
  return typeof item === "string" ? item : item.text;
}

export function isBetaChangelogItem(item: ChangelogItem): boolean {
  return typeof item !== "string" && item.beta;
}

export const CHANGELOG: ChangelogEntry[] = [
  {
    date: "25. 10. 2026",
    title: "Aktualizované podmínky",
    items: ["Zásady soukromí a podmínky teď popisují i Zprávy a dárkové odkazy."],
  },
  {
    date: "24. 10. 2026",
    title: "Nové potvrzení platby",
    items: [
      { text: "Potvrzení platby je přehlednější, s velkou částkou a příjemcem.", beta: true },
      { text: "U Lightning adresy vidíš před odesláním, komu platíš.", beta: true },
    ],
  },
  {
    date: "20. 10. 2026",
    title: "Otevřený zdrojový kód",
    items: [
      "Zdrojový kód peněženky je teď veřejný, odkaz najdeš v Nastavení.",
      "Kdokoli si může ověřit, že web běží přesně tento kód.",
    ],
  },
  {
    date: "19. 10. 2026",
    title: "Odeslání: částka z faktury",
    items: [
      "Faktura s částkou ti vyplní pole částky sama.",
      { text: "Skener přečte QR kód i z obrázku v galerii.", beta: true },
    ],
  },
  {
    date: "18. 10. 2026",
    title: "Jemnější vzhled",
    items: [
      "Tlačítka, pole a přepínače mají lehčí obrys, okna jsou bez rozmazání.",
      "Dárek jde po odeslání hned zrušit a seznam ukazuje skutečný stav.",
    ],
  },
  {
    date: "17. 10. 2026",
    title: "Automatická obnova mincí",
    items: ["Mince se obnovují samy, včas a co nejlevněji.", "Bezplatné obnovy už nezaplňují historii plateb."],
  },
  {
    date: "16. 10. 2026",
    title: "Zůstatek: velká čísla",
    items: [
      "Velký zůstatek se vejde na displej i s jednotkou.",
      { text: "Odemknutí tě občas přivítá pozdravem.", beta: true },
    ],
  },
  {
    date: "14. 10. 2026",
    title: "Dárky: přehled a heslo",
    items: [
      { text: "Dárek jde po odeslání hned zrušit a seznam ukazuje skutečný stav.", beta: true },
      { text: "Příjemce dárku si heslo nastaví až při dalším otevření.", beta: true },
    ],
  },
  {
    date: "13. 10. 2026",
    title: "Vzhled: jemnější prvky",
    items: [
      { text: "Tlačítka, pole a přepínače mají lehčí obrys.", beta: true },
      { text: "Zaostřené pole je na první pohled poznat.", beta: true },
    ],
  },
  {
    date: "13. 10. 2026",
    title: "Profil: čistší vzhled",
    items: [
      { text: "Tvoje adresa je v profilu větší a bez zbytečností.", beta: true },
      { text: "Zapnutí Lightning adresy se zeptá hned pod adresou.", beta: true },
    ],
  },
  {
    date: "12. 10. 2026",
    title: "Donate stránka",
    items: [
      { text: "Kdokoli ti může poslat bitcoin na stránce s tvým jménem.", beta: true },
      { text: "V profilu zkopíruješ odkaz na stránku pro donate.", beta: true },
    ],
  },
  {
    date: "7. 10. 2026",
    title: "Oznámení o obnově mincí",
    items: [
      "Upozornění na obnovu mincí přijde včas, abys ji stihl.",
      "Po obnově už zbytečně nepřipomíná a staré upozornění zmizí.",
    ],
  },
  {
    date: "7. 10. 2026",
    title: "Platby při obnově mincí",
    items: [
      "Platit můžeš i během obnovy mincí, nic se nezablokuje.",
      "Oznámení o příchozích platbách fungují až 30 dní bez otevření appky.",
    ],
  },
  {
    date: "7. 10. 2026",
    title: "Nouzový exit: přesné údaje",
    items: ["Průběh, poplatky i vyzvednutá částka teď odpovídají skutečnosti."],
  },
  {
    date: "6. 10. 2026",
    title: "Nouzový exit: oprava",
    items: ["Při přetíženém blockchain serveru se peněženka už nerestartuje a exit pokračuje."],
  },
  {
    date: "5. 10. 2026",
    title: "Nový vzhled",
    items: [
      "Přijmout a Odeslat jsou dvě tlačítka, skener QR a detaily se otevírají zespodu.",
      "Platby v historii mají nové ikony a detail se zobrazením potvrzení.",
    ],
  },
  {
    date: "5. 10. 2026",
    title: "Nové Přijmout",
    items: [
      { text: "Přijmout ukazuje tvou adresu jmeno@spendrr.app, zaplatí ji každá peněženka.", beta: true },
    ],
  },
  {
    date: "5. 10. 2026",
    title: "Oznámení o platbě hned",
    items: [
      "Oznámení o přijaté platbě přijde během pár sekund, ne až po minutě.",
    ],
  },
  {
    date: "4. 10. 2026",
    title: "Zpět v appce",
    items: [
      "Systémové zpět zavře okno nebo obrazovku, ne celou appku.",
    ],
  },
  {
    date: "3. 10. 2026",
    title: "Zprávy: oznámení",
    items: [
      { text: "Oznámení o nové zprávě i se zavřenou appkou, se jménem a textem.", beta: true },
      "Text vidí jen tvůj telefon, náš server ne. Náhled jde vypnout.",
    ],
  },
  {
    date: "3. 10. 2026",
    title: "Zprávy: přehled a opravy",
    items: [
      { text: "Přehlednější seznam konverzací s nepřečtenými, zprávu jde zkopírovat.", beta: true },
      "Odkazy ze zpráv se otevírají a tap-to-pay v chatu nereaguje.",
    ],
  },
  {
    date: "3. 10. 2026",
    title: "Zprávy: soukromí",
    items: [
      { text: "Zprávy a kontakty jsou v telefonu šifrované, zamčená peněženka je nečitelná.", beta: true },
      "Bezpečnostní kód v profilu kontaktu: porovnejte ho a označte kontakt jako ověřený.",
    ],
  },
  {
    date: "3. 10. 2026",
    title: "Zprávy: odkazy",
    items: [
      { text: "Faktura, adresa nebo dárek ve zprávě jde zaplatit či vyzvednout jedním klepnutím.", beta: true },
      "Cizí odkaz se otevře až po potvrzení, s doménou velkým písmem.",
    ],
  },
  {
    date: "3. 10. 2026",
    title: "Zprávy: profil a živé psaní",
    items: [
      { text: "Profil kontaktu se společnými platbami, delší zprávy, odpověď swipem.", beta: true },
      "Vidíš, když druhý píše nebo zadává částku; potvrzení o přečtení v Nastavení.",
    ],
  },
  {
    date: "3. 10. 2026",
    title: "Zprávy: reakce a odpovědi",
    items: [
      { text: "Podrž zprávu a reaguj emoji, nebo na ni odpověz.", beta: true },
      "Uložené zprávy se ukážou hned, i před připojením.",
    ],
  },
  {
    date: "3. 10. 2026",
    title: "Zprávy: kontakty a historie",
    items: [
      { text: "Kontakty se obnoví se seedem, zprávy odcházejí hned.", beta: true },
      "Poznámka z chatu je u platby v historii, platba z chatu otevře detail.",
    ],
  },
  {
    date: "3. 10. 2026",
    title: "Zprávy (beta)",
    items: [
      "V betě, zapnutí v Nastavení: šifrované zprávy s @jmény, platby a žádosti v konverzaci.",
      "Opakované platby a žádosti s připomínkou při otevření appky.",
    ],
  },
  {
    date: "2. 10. 2026",
    title: "Podmínky a soukromí",
    items: [
      "Podmínky užívání a zásady ochrany soukromí najdeš v Nastavení.",
      "Tamtéž jsou i licence knihoven, které peněženka používá.",
    ],
  },
  {
    date: "30. 9. 2026",
    title: "Dárky, oznámení a mazání",
    items: [
      "Odeslané dárky v Nastavení se načtou hned a ukazují skutečný stav.",
      { text: "Oznámení vysvětlí soukromí, smazání peněženky se potvrzuje podržením.", beta: true },
    ],
  },
  {
    date: "28. 9. 2026",
    title: "Rychlejší a přesnější odesílání",
    items: [
      "Adresa, faktura i QR se rozpoznají hned a překlep se ukáže před potvrzením.",
      "Jména @ se ověřují rychleji a při výpadku to zkusí znovu.",
    ],
  },
  {
    date: "28. 9. 2026",
    title: "Úpravy nastavení",
    items: [
      "„Obnovit teď“ ukazuje načítání a přehlednější potvrzení.",
      "Zatřesení pro skrytí zůstatku se zapíná přímo přepínačem.",
    ],
  },
  {
    date: "28. 9. 2026",
    title: "Automatická obnova mincí zapnutá (beta)",
    items: [
      "V betě obnovuje mince vlastní engine, přehled a deník jsou v Nastavení.",
      "Přehlednější obrazovka VTXO mince, detail a deník v samostatných oknech.",
    ],
  },
  {
    date: "28. 9. 2026",
    title: "Bezpečnější nouzový exit",
    items: [
      "Exit posílá transakce přes nezávislý uzel, ne přes servery Arku.",
      "Přesun on-chain do zůstatku ukáže i poplatek síti.",
    ],
  },
  {
    date: "28. 9. 2026",
    title: "Nový nouzový exit",
    items: [
      "Nouzový exit je teď jedno okno s průběhem, poplatky a vyzvednutím.",
      "Mince v exitu se zamknou, aby je nic jiného neutratilo.",
      "Mince, které se právě obnovují, přidáš do exitu po obnově. Když Ark server nefunguje, jdou do něj hned.",
      "Upozorní, když by mince vypršely dřív, než se exit dostane na blockchain.",
      "Zrušení exitu teď chce heslo.",
    ],
  },
  {
    date: "27. 9. 2026",
    title: "Drobné opravy",
    items: [
      "Po zavření detailu platby zůstane historie na stejném místě.",
      "Skener QR ztmaví celou obrazovku najednou, včetně tlačítek nahoře.",
      "Zatřesení pro skrytí zůstatku reaguje o trochu snáz.",
    ],
  },
  {
    date: "27. 9. 2026",
    title: "Klepnutí bez označování textu",
    items: ["Klepnutí na logo nebo zůstatek už v některých prohlížečích neoznačí text a nenabídne kopírování."],
  },
  {
    date: "27. 9. 2026",
    title: "Nový detail platby (beta)",
    items: [
      "Detail platby v historii má nové okno s velkou částkou.",
      "Přepočet na měnu je z doby platby, u jména je i avatar.",
    ],
  },
  {
    date: "27. 9. 2026",
    title: "Přesnější detail platby",
    items: [
      "On-chain platba je potvrzená, až když ji appka opravdu vidí v bloku.",
      "Jméno příjemce se už nepřiřadí k cizí platbě se stejnou částkou.",
    ],
  },
  {
    date: "26. 9. 2026",
    title: "Nové ikonky v historii (beta)",
    items: ["Přijaté a odeslané platby mají výraznější barevné ikonky."],
  },
  {
    date: "26. 9. 2026",
    title: "Nové poplatky v síti (beta)",
    items: [
      "Poplatky v Nastavení teď vypadají jako bloky na mempool.space.",
      "Uvidíš poslední vytěžený blok i cenu běžné platby.",
    ],
  },
  {
    date: "26. 9. 2026",
    title: "Nový skener QR kódů (beta)",
    items: [
      "Skener vypadá stejně jako ostatní okna v appce.",
      "Ve tmě poradí, že blesk rozsvítíš dvojitým klepnutím.",
    ],
  },
  {
    date: "26. 9. 2026",
    title: "Převodník v Utility (beta)",
    items: [
      "Převodník měn je nově první záložka v Utility.",
      "Trojklik na logo už nic nedělá, Bitrefill z Utility zmizel.",
    ],
  },
  {
    date: "26. 9. 2026",
    title: "Automatická obnova mincí (beta)",
    items: [
      "V Nastavení → VTXO mince uvidíš plán, průběh i deník obnov.",
      "Mince, kterou nejde obnovit, uvidíš přímo pod zůstatkem.",
    ],
  },
  {
    date: "26. 9. 2026",
    title: "Spolehlivější oznámení o platbách",
    items: ["Přijatá platba se oznámí, i když zároveň běží obnova mincí."],
  },
  {
    date: "25. 9. 2026",
    title: "Nová tlačítka na úvodní obrazovce",
    items: ["Přijmout a Odeslat tvoří jednu lištu, skener QR kódů je uprostřed."],
  },
  {
    date: "25. 9. 2026",
    title: "Obnova mincí bez odhlašování",
    items: [
      "Mince před vypršením se obnoví na pozadí, stačí appku jednou otevřít.",
      "Appka tě kvůli čekání na obnovu už po minutě neodhlásí.",
    ],
  },
  {
    date: "25. 9. 2026",
    title: "Motion design (beta)",
    items: [
      "Přechody mezi obrazovkami: tlačítko, na které klepneš, se promění v to, co otevírá.",
      "Tlačítko pro potvrzení platby se před odesláním plní barvou a během odesílání přes něj přejíždí odlesk. Po odeslání tě appka vrátí domů.",
      "Když přijde platba na obrazovce Přijmout, QR kód se rozplyne a appka tě vrátí domů.",
      "Rámeček skeneru se přicvakne na nalezený kód.",
      "Chybová hláška se zatřese, řádky aktivity naskočí postupně.",
      "Vypneš to v Nastavení → Vzhled → Motion design.",
    ],
  },
  {
    date: "25. 9. 2026",
    title: "Pokladna pro tablet a počítač (beta)",
    items: [
      "Na velké obrazovce je účtenka vedle ceníku a QR kód je větší.",
      "Klávesa C smaže celý nákup, částku napíšeš i na klávesnici.",
    ],
  },
  {
    date: "25. 9. 2026",
    title: "Přesnější skrytí zůstatku zatřesením",
    items: ["Zůstatek se už neskryje po položení telefonu nebo jednom mávnutí."],
  },
  {
    date: "25. 9. 2026",
    title: "Spolehlivější poznání výpadku sítě (beta)",
    items: [
      "Appka pozná i Wi-Fi bez internetu, nejen vypnutou Wi-Fi.",
      "Když neodpovídá server Arku, řekne to a neodhlásí tě.",
    ],
  },
  {
    date: "24. 9. 2026",
    title: "Nová ikona",
    items: [
      "Spendrr má novou ikonu: „s.“ s fialovou tečkou.",
      "Ikona v prohlížeči se přizpůsobí světlému i tmavému režimu.",
    ],
  },
  {
    date: "24. 9. 2026",
    title: "Dárkové odkazy a bezpečnější úložiště pro všechny",
    items: [
      "Podržením Odeslat pošleš bitcoin jako dárkový odkaz.",
      "Peněženka je otevřená vždy jen v jedné kartě prohlížeče.",
    ],
  },
  {
    date: "24. 9. 2026",
    title: "Požadavek k platbě a offline režim pro všechny",
    items: [
      "Podržením Přijmout vytvoříš odkaz s požadavkem na platbu.",
      "Bez internetu tě appka neodhlásí, počká na připojení.",
    ],
  },
  {
    date: "24. 9. 2026",
    title: "Peněženka jen v jednom okně (beta)",
    items: [
      "Odemknout jde jen v jednom okně nebo aplikaci najednou.",
      "Druhé okno napíše, že je peněženka otevřená jinde.",
    ],
  },
  {
    date: "24. 9. 2026",
    title: "Appka na ploše a ochrana dat (beta)",
    items: [
      "Na iPhonu a iPadu poradí, jak si přidat Spendrr na plochu.",
      "Požádá prohlížeč, aby data peněženky nemazal při nedostatku místa.",
    ],
  },
  {
    date: "23. 9. 2026",
    title: "Dárek a odemykání otiskem",
    items: [
      "Heslo k peněžence z dárku je kratší a snáz se opisuje.",
      "Odemykání otiskem se zkouší i tam, kde dřív hlásilo nepodporu.",
    ],
  },
  {
    date: "23. 9. 2026",
    title: "Jména: rychlejší a s profilovkou (beta)",
    items: [
      "Jméno v poli Odeslat se najde hned a nabízí dříve placené.",
      "Odkaz na profil ukáže v chatu tvoji profilovku místo loga.",
    ],
  },
  {
    date: "22. 9. 2026",
    title: "Lightning adresa k @jménu (beta)",
    items: [
      "V profilu jde zapnout jmeno@spendrr.app, platí i peněženky bez Ark.",
      "Platbu přeposílá Spendrr, sám ji nemůže utratit ani přesměrovat.",
    ],
  },
  {
    date: "22. 9. 2026",
    title: "Rychlejší skenování QR na Androidu",
    items: ["Čtečka QR kódů teď na Androidu využívá rychlejší vestavěný modul."],
  },
  {
    date: "21. 9. 2026",
    title: "Pokladna (beta): celá na jedné obrazovce",
    items: [
      "Nahoře vždy celková částka, tlačítko Účtovat vždy na očích.",
      "Zákazník vidí jen QR kód, po zaplacení velkou fajfku.",
    ],
  },
  {
    date: "21. 9. 2026",
    title: "Odolnější jména a platba ťuknutím",
    items: [
      "Registrace jmen má denní strop proti hromadnému zabírání.",
      "Zdroj rušící cizí ťuknutí se dočasně zablokuje.",
    ],
  },
  {
    date: "21. 9. 2026",
    title: "Historie ukazuje @jméno příjemce",
    items: ["Platba na @jméno teď v historii ukáže jméno příjemce."],
  },
  {
    date: "21. 9. 2026",
    title: "Odkaz na profil: spendrr.app/@jméno",
    items: [
      "Odkaz na @jméno otevře profil s adresou a QR kódem.",
      "Ve Spendrru zaplatíš klepnutím, jinde adresu zkopíruješ.",
    ],
  },
  {
    date: "21. 9. 2026",
    title: "Jména @ (beta): registrace a platba na @jméno",
    items: [
      "V profilu si zaregistruješ veřejné jméno, třeba @pavel.",
      "Platbu pak pošleš na jméno místo dlouhé adresy.",
    ],
  },
  {
    date: "20. 9. 2026",
    title: "Nové (beta): požadavek k platbě a přepracované dárky",
    items: [
      "Podržením Přijmout vytvoříš odkaz s požadavkem na platbu.",
      "Dárky a požadavky mají nové, plynulejší okno.",
    ],
  },
  {
    date: "20. 9. 2026",
    title: "Nová obrazovka odemčení pro všechny",
    items: ["Plynulý zámek, odhalení hesla ikonou oka, odemčení otiskem."],
  },
  {
    date: "19. 9. 2026",
    title: "Log peněženky pro všechny",
    items: ["Log peněženky v Nastavení pomáhá dohledat zaseklou platbu."],
  },
  {
    date: "19. 9. 2026",
    title: "Nové (beta): platba ťuknutím telefonů o sebe",
    items: [
      "Ťukni telefony o sebe a zaplať bez zadávání adresy.",
      "Zatím spolehlivě funguje jen na některých telefonech.",
    ],
  },
  {
    date: "18. 9. 2026",
    title: "Bezpečnost: zpřísněné ověření push notifikací",
    items: ["Zapnutí upozornění teď ověří schránku přímo u Ark serveru."],
  },
  {
    date: "18. 9. 2026",
    title: "Bezpečnost: odkazy a obrázky u voucherů",
    items: ["Odkazy a obrázky voucherů mají přísnější kontrolu proti zneužití."],
  },
  {
    date: "18. 9. 2026",
    title: "Bezpečnost: dárkový odkaz mizí z adresního řádku okamžitě",
    items: ["Dárkový odkaz mizí z historie prohlížeče hned po otevření."],
  },
  {
    date: "17. 9. 2026",
    title: "Bezpečnost: zúžena síťová výjimka pro Lightning adresu/LNURL",
    items: ["Platba na Lightning adresu nebo LNURL komunikuje jen s příjemcem."],
  },
  {
    date: "16. 9. 2026",
    title: "Point of Sale: ceník položek a vylepšená klávesnice",
    items: [
      "Pokladna má ceník: naťukej zboží místo psaní ceny.",
      "Kalkulačka umí sečíst víc položek do jedné faktury.",
    ],
  },
  {
    date: "15. 9. 2026",
    title: "Nouzový přepínač: potlačit automatickou obnovu VTXO",
    items: ["Nastavení: nouzově lze potlačit automatickou obnovu VTXO."],
  },
  {
    date: "15. 9. 2026",
    title: "Oprava: výpadek Ark serveru blokoval Odeslat i VTXO mince",
    items: ["Výpadek Ark serveru už neblokuje Odeslat ani VTXO mince."],
  },
  {
    date: "14. 9. 2026",
    title: "Beta: Utility hub — Point of Sale",
    items: ["Nová Pokladna: zadej cenu, appka vytvoří fakturu a QR kód."],
  },
  {
    date: "14. 9. 2026",
    title: "Beta: Utility hub — mapa bitcoinových podniků (btcmap.org)",
    items: ["Nová Mapa: bitcoinové podniky poblíž tebe."],
  },
  {
    date: "14. 9. 2026",
    title: "Nová adresa: spendrr.app",
    items: [
      "Peněženka má nový název domény: spendrr.app.",
    ],
  },
  {
    date: "14. 9. 2026",
    title: "Beta: Utility hub — poukázky a dobití kreditu přes Bitrefill",
    items: [
      "Nové: nákup poukázek a dobití kreditu přes Bitrefill.",
      "Platíš přímo z peněženky přes Lightning.",
    ],
  },
  {
    date: "13. 9. 2026",
    title: "Oprava zálohy: nová peněženka mohla ztratit viditelnost prostředků",
    items: ["Neúplná záloha po otevření nové peněženky opravena."],
  },
  {
    date: "12. 9. 2026",
    title: "Bezpečnost: dárkové odkazy a záloha",
    items: [
      "Nevyzvednuté dárky se už nemažou předčasně i s penězi.",
      "Nahrání zálohy teď server ověří proti souběžnému zápisu.",
    ],
  },
  {
    date: "12. 9. 2026",
    title: "Bezpečnostní audit: síťová ochrana, faktury a záloha",
    items: [
      "Uzavřena skulina v síťové ochraně u XHR a WebSocketu.",
      "Opraveny chyby zálohy, dvojího odeslání a limitu startu appky.",
    ],
  },
  {
    date: "12. 9. 2026",
    title: "Bezpečnost a spolehlivost zálohy",
    items: [
      "Heslo dárkové peněženky se už neukládá čitelné napořád.",
      "Obnova ze zálohy teď spolehlivě obnoví i chybějící části.",
    ],
  },
  {
    date: "11. 9. 2026",
    title: "Beta: Přísnější kontrola adresy nebo faktury při odeslání",
    items: ["Adresa nebo faktura v poli Komu se kontroluje před odesláním."],
  },
  {
    date: "11. 9. 2026",
    title: "Beta: Animovaný pojezd číslic u zůstatku",
    items: ["Nová animace: číslice zůstatku při platbě najíždí jako počítadlo."],
  },
  {
    date: "11. 9. 2026",
    title: "Přehlednější Nastavení",
    items: ["Nastavení má nově přehledné sekce místo dlouhého seznamu."],
  },
  {
    date: "11. 9. 2026",
    title: "Odeslané dárky se teď zálohují",
    items: ["Klíče k nevyzvednutým dárkům jsou teď součástí zálohy."],
  },
  {
    date: "10. 9. 2026",
    title: "Pošli bitcoin odkazem",
    items: [
      "Nový dárkový odkaz: pošli bitcoin komukoliv jedním odkazem.",
      "Nevyzvednutý dárek se sám vrátí po 7 dnech.",
    ],
  },
  {
    date: "10. 9. 2026",
    title: "Platby povoluje izolovaná část appky, ne rozhraní",
    items: ["Heslo pro platbu se teď ověřuje v izolované části appky."],
  },
  {
    date: "9. 9. 2026",
    title: "Seed phrase se rozšifruje mimo hlavní vlákno",
    items: [
      "Seed phrase se rozšifrovává mimo hlavní vlákno appky.",
      "Síla hesla se teď počítá podle odhadu uhodnutelnosti.",
    ],
  },
  {
    date: "9. 9. 2026",
    title: "Bezpečnostní opravy z auditu",
    items: ["Opraveny chyby z bezpečnostního auditu: faktury, záloha, síť."],
  },
  {
    date: "9. 9. 2026",
    title: "Beta funkce jsou teď pro všechny",
    items: ["Nová historie plateb, poplatky v síti a graf ceny pro všechny."],
  },
  {
    date: "9. 9. 2026",
    title: "Přehlednější a bezpečnější zadávání seed phrase při importu",
    items: ["Import seed phrase: vlastní políčko na slovo s kontrolou."],
  },
  {
    date: "8. 9. 2026",
    title: "Méně zbytečných odhlášení po zamčení telefonu",
    items: ["Appka se po zamčení telefonu už neodhlašuje zbytečně."],
  },
  {
    date: "8. 9. 2026",
    title: "Upozornění na blížící se obnovu VTXO",
    items: ["Push upozornění, když se blíží obnova VTXO a appka je zavřená."],
  },
  {
    date: "7. 9. 2026",
    title: "Aktualizace peněžního jádra (bark 0.7.0)",
    items: ["Platba offline příjemci se doručí po jeho opětovném připojení."],
  },
  {
    date: "7. 9. 2026",
    title: "Automatická šifrovaná záloha peněženky",
    items: [
      "Nová automatická šifrovaná záloha peněženky na server.",
      "Server nevidí obsah, jen zašifrovaná data.",
    ],
  },
  {
    date: "6. 9. 2026",
    title: "Možnost úplně vypnout automatické uzamčení",
    items: ["Nastavení: jde úplně vypnout automatické uzamčení appky."],
  },
  {
    date: "3. 9. 2026",
    title: "Ochrana cílové adresy nouzového výstupu",
    items: ["Odeslání nouzového výstupu teď vyžaduje heslo."],
  },
  {
    date: "3. 9. 2026",
    title: "Bezpečnější potvrzení on-chain plateb",
    items: ["On-chain platba teď vždy projde potvrzovací obrazovkou."],
  },
  {
    date: "3. 9. 2026",
    title: "Záložní zdroj dat pro případ výpadku second.tech",
    items: ["Appka umí dočasně přepnout na záložní zdroj dat při výpadku."],
  },
  {
    date: "2. 9. 2026",
    title: "Nouzový výstup: ochrana proti dvojímu odeslání",
    items: ["Nouzový výstup je chráněný proti dvojímu odeslání transakce."],
  },
  {
    date: "2. 9. 2026",
    title: "Externí audit: opravy nouzového výstupu",
    items: ["Externí audit: opraveno několik chyb nouzového výstupu."],
  },
  {
    date: "2. 9. 2026",
    title: "Odesílání na Lightning offer (BOLT12)",
    items: ["Do pole Komu teď jde vložit i Lightning offer (BOLT12)."],
  },
  {
    date: "2. 9. 2026",
    title: "Bezpečnostní vylepšení po externím auditu",
    items: [
      "Externí bezpečnostní audit: opraveny nalezené chyby preventivně.",
      "Žádná z nich neohrozila skutečné prostředky.",
    ],
  },
  {
    date: "1. 9. 2026",
    title: "Zjednodušená hlavička a nové gesto zamykání (jen V2)",
    items: ["Dvojklik pod historií transakcí peněženku rychle zamkne."],
  },
  {
    date: "1. 9. 2026",
    title: "Smazání peněženky teď vyžaduje dvojí potvrzení",
    items: ["Smazání peněženky teď vyžaduje dvoukrokové potvrzení."],
  },
  {
    date: "1. 9. 2026",
    title: "Oznámení o platbách fungují i se zavřenou appkou",
    items: [
      "Push oznámení o platbě fungují i se zavřenou appkou.",
      "Server nakoukne jen do schránky, klíč peněženky nevidí.",
    ],
  },
  {
    date: "1. 9. 2026",
    title: "Nouzový výstup z Ark",
    items: ["Nová funkce: nouzový výstup z Ark bez součinnosti serveru."],
  },
  {
    date: "31. 8. 2026",
    title: "Síťové zabezpečení proti kompromitované závislosti",
    items: [
      "Appka omezuje, na jaké servery smí knihovny posílat data.",
      "Chrání proti kompromitované závislosti odesílající data ven.",
    ],
  },
  {
    date: "31. 8. 2026",
    title: "On-chain příjem plateb",
    items: ["Nová záložka On-chain v Přijmout pro klasickou bitcoinovou adresu."],
  },
  {
    date: "30. 8. 2026",
    title: "Bezpečnostní vylepšení",
    items: [
      "Odeslání 100 000+ sats vyžaduje na potvrzení znovu heslo.",
      "Šifrování trezoru zesíleno na 600 000 PBKDF2 iterací.",
    ],
  },
  {
    date: "30. 8. 2026",
    title: "Anglické rozhraní",
    items: ["Appku jde přepnout mezi češtinou a angličtinou."],
  },
  {
    date: "30. 8. 2026",
    title: "Auto-lock, odeslání celého zůstatku, více měn",
    items: [
      "Peněženka se po 5 minutách nečinnosti sama zamkne.",
      "Tlačítko Poslat vše odešle celý zůstatek najednou.",
    ],
  },
  {
    date: "29. 8. 2026",
    title: "Rebrand na Spendrr",
    items: ["Nové jméno a logo: Spendrr."],
  },
];
