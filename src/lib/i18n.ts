// Simple translation layer: components call t("Český text") with the literal
// Czech string used as the lookup key, so existing JSX doesn't need invented
// key names — just wrap the string. Missing entries fall back to the Czech
// original, so partial coverage never breaks anything.
import { useCallback, useSyncExternalStore } from "react";

export type Lang = "cs" | "en";

const KEY = "btc-wallet-lang";

function detectDefault(): Lang {
  return navigator.language.toLowerCase().startsWith("cs") ? "cs" : "en";
}

function readStored(): Lang | null {
  const v = localStorage.getItem(KEY);
  return v === "cs" || v === "en" ? v : null;
}

// First-run default follows the browser locale: a Czech browser starts in
// Czech, anything else in English. The fiat currency default does NOT track
// this — it's always EUR until the user picks otherwise (see currency.ts).
let current: Lang = readStored() ?? detectDefault();
const listeners = new Set<() => void>();

export function getLang(): Lang {
  return current;
}

export function setLang(lang: Lang) {
  if (lang === current) return;
  current = lang;
  localStorage.setItem(KEY, lang);
  listeners.forEach((l) => l());
}

function subscribe(cb: () => void) {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

export function useLang(): Lang {
  return useSyncExternalStore(subscribe, getLang);
}

export function useT() {
  const lang = useLang();
  // Memoized so its identity only changes when the language actually does —
  // callers pass this into useCallback/useEffect dependency arrays, and an
  // unstable identity there would defeat that memoization on every render
  // (e.g. re-running the wallet.sync()/balance()/history()/maintenance()
  // effect on every single Dashboard render instead of only when it should).
  return useCallback((cs: string): string => (lang === "en" ? (DICT[cs] ?? cs) : cs), [lang]);
}

export function localeFor(lang: Lang): string {
  return lang === "en" ? "en-US" : "cs-CZ";
}

// English translations, keyed by the Czech source string.
const DICT: Record<string, string> = {
  // App.tsx
  "Načítám": "Loading",
  "SELF CUSTODIAL": "SELF CUSTODIAL",
  "Bitcoin.": "Bitcoin.",
  "Bez prostředníka.": "No middleman.",
  "Klíče k penězům držíš jen ty, v telefonu.": "Only you hold the keys, right on your phone.",
  "Mám seed phrase": "I have a seed phrase",
  "Jak to funguje": "How it works",
  "Zapiš si seed phrase": "Write down your seed phrase",
  "Těchto {n} slov je jediný způsob, jak obnovit peněženku. ": "These {n} words are the only way to recover your wallet. ",
  "Napiš si je na papír a ulož na bezpečné místo. Nikdy je nikomu nesděluj.":
    "Write them on paper and keep them somewhere safe. Never share them with anyone.",
  "Zapsal jsem si to, pokračovat": "I've written it down, continue",
  "Import peněženky": "Import wallet",
  "Zadej svou seed phrase — každé slovo do vlastního políčka.":
    "Enter your seed phrase — one word per box.",
  "{n} slov": "{n} words",
  "Slovo {n}": "Word {n}",
  "Vyplněno {filled}/{total}": "Filled {filled}/{total}",
  "Zobrazit/skrýt slova": "Show/hide words",
  "Pokračovat": "Continue",
  "Zpět": "Back",
  "Nastav heslo": "Set a password",
  "Heslo šifruje seed phrase v tomto prohlížeči. Neposílá se nikam a nikdo ho nemůže obnovit za tebe.":
    "The password encrypts your seed phrase in this browser. It's never sent anywhere and no one can recover it for you.",
  "Heslo": "Password",
  "Heslo znovu": "Password again",
  "Hesla se neshodují.": "Passwords don't match.",
  // Password-strength hints (lib/password.ts's passwordProblem) — one per
  // weakness the estimator can name.
  "Heslo musí mít alespoň 8 znaků.": "The password must be at least 8 characters.",
  "Tohle heslo obsahuje běžné slovo, které crackery zkoušejí jako první. Přidej něco nečekaného.":
    "This contains a common word that cracking tools try first. Add something unexpected.",
  "Tohle je souvislá cesta po klávesnici — crackery ji projdou během chvilky. Zkus něco jiného.":
    "This is a path along the keyboard — cracking tools walk those in moments. Try something else.",
  "Tohle je posloupnost (abc, 1234) — patří k prvním věcem, které se zkoušejí.":
    "This is a sequence (abc, 1234) — one of the first things anyone tries.",
  "Opakující se část heslo prakticky neprodlouží. Zkus víc různých slov.":
    "A repeated part barely lengthens a password. Try several different words.",
  "Datum nebo rok je jen pár tisíc možností. Nespoléhej se na něj.":
    "A date or year is only a few thousand possibilities. Don't rely on it.",
  "Heslo je pořád příliš snadno uhodnutelné. Nejlépe funguje několik nesouvisejících slov.":
    "This is still too easy to guess. Several unrelated words works best.",
  "Otisk se ověřil, ale trezor se nepodařilo rozšifrovat. Odemkni heslem.":
    "The fingerprint was verified, but the vault could not be decrypted. Unlock with your password.",
  "Odemykání bylo přerušeno. Zkus to prosím znovu.": "Unlocking was interrupted. Please try again.",
  "Zakládám peněženku…": "Creating wallet…",
  "Vytvořit peněženku": "Create wallet",
  "Odemknout peněženku": "Unlock wallet",
  "Vítej zpět": "Welcome back",
  "Dobré ráno": "Good morning",
  "Dobrý večer": "Good evening",
  "Odemykám…": "Unlocking…",
  "Odemknout": "Unlock",
  "Odemknout otiskem": "Unlock with fingerprint",
  "Skrýt heslo": "Hide password",
  "Zobrazit heslo": "Show password",
  "Máš zapnutý Caps Lock.": "Caps Lock is on.",
  "Použít heslo": "Use password",
  "Smazat peněženku z prohlížeče": "Delete wallet from this browser",
  "Zapomenuté heslo": "Forgot your password",
  "Tohle nevratně smaže zašifrovanou peněženku (a otisk prstu, pokud je nastavený) z tohoto prohlížeče. Prostředky samotné nezmizí — zůstanou dostupné přes seed phrase odkudkoli — ale bez zapsané seed phrase k nim ztratíš přístup.":
    "This irreversibly deletes the encrypted wallet (and fingerprint unlock, if set up) from this browser. The funds themselves aren't going anywhere — they stay accessible via the seed phrase from anywhere — but without a written-down seed phrase you'll lose access to them.",
  "Rozumím, chci pokračovat": "I understand, continue",
  "Opravdu chceš peněženku z tohoto prohlížeče definitivně smazat?": "Do you really want to permanently delete the wallet from this browser?",
  "Ano, smazat peněženku": "Yes, delete the wallet",
  "Nesprávné heslo nebo poškozený trezor.": "Incorrect password or corrupted vault.",
  "Peněženka je otevřená v jiném okně": "The wallet is open in another window",
  "Najednou může být otevřená jen na jednom místě. Zamkni ji v tom druhém okně nebo ho zavři a pak ji odemkni tady.":
    "It can only be open in one place at a time. Lock it in the other window or close that window, then unlock it here.",
  "Peněženka se restartovala. Data jsou v pořádku, stačí se přihlásit.":
    "The wallet restarted. Your data is fine, just log in.",
  "Nedokončeno": "Unfinished",
  "Čeká na vyzvednutí": "Awaiting claim",
  "Čeká, neověřeno": "Waiting, unverified",
  "Nejspíš vyzvednuto": "Probably claimed",
  "Vráceno tobě": "Returned to you",
  "Ověřit vše": "Check all",
  "Ověřit": "Check",
  "čeká na ověření": "waiting to be checked",
  "Dárky se nepodařilo načíst.": "Could not load gifts.",
  "Platba se nejspíš neodeslala.": "The payment probably never went out.",
  "Ověření nedoběhlo.": "The check did not finish.",
  "vrátí se za {span}": "returns in {span}",
  "vypršelo, vrátí se při otevření appky": "expired, returns when the app is opened",
  "ověřeno {when}": "checked {when}",
  "před {n} d": "{n} d ago",
  "Dokončené ({n})": "Finished ({n})",
  "V tomhle nedokončeném dárku nic nezůstalo. Platba se nejspíš nikdy neodeslala.": "Nothing was left in this unfinished gift. The payment was probably never sent.",
  "Zálohy jsou pro tuto relaci nedostupné. Správu dárků nelze zobrazit.": "Backups are unavailable for this session. Gifts cannot be managed.",
  "Neplatná seed phrase.": "Invalid seed phrase.",

  // MnemonicGrid.tsx
  "Slovo {n} skryté": "Word {n} hidden",
  "Zobrazit další ({shown}/{total})": "Show more ({shown}/{total})",

  // Settings.tsx
  "Zpět do peněženky": "Back to wallet",
  "Nastavení": "Settings",
  "Poplatky v síti": "Network fees",
  "Nízká": "Low",
  "Střední": "Medium",
  "Vysoká": "High",
  "~ hodiny": "~ hours",
  "~ 30 min": "~ 30 minutes",
  "příští blok": "next block",
  "~hodiny": "~hours",
  "před {n} h": "{n} h ago",
  "Běžná platba": "Typical payment",
  "Zdroj": "Source",
  "Nepodařilo se načíst poplatky.": "Couldn't load fees.",
  "Heslo, otisk, uzamčení, seed phrase": "Password, fingerprint, lock, seed phrase",
  "Záloha, VTXO mince, onchain transakce": "Backup, VTXO coins, onchain transactions",
  "Motiv, jazyk, měna, oznámení": "Theme, language, currency, notifications",
  "Obě akce níž mají vážné a těžko vratné důsledky. Než se cokoli stane, ukáže se ještě obrazovka s vysvětlením a potvrzením.":
    "Both actions below have serious, hard-to-undo consequences. Before anything happens you'll still get a screen explaining it and asking for confirmation.",
  "Převede prostředky on-chain bez součinnosti Ark serveru": "Moves funds on-chain without the Ark server's cooperation",
  "Odstraní zašifrovanou peněženku z tohoto zařízení": "Removes the encrypted wallet from this device",
  "Poslední commit": "Last commit",
  "Zabezpečení": "Security",
  "Peněženka": "Wallet",
  "Vzhled a chování": "Appearance & behaviour",
  "Odhalí slova na obrazovce": "Shows the words on screen",
  "Zálohuj si seed frázi": "Back up your seed phrase",
  "Zálohovat": "Back up",
  "Záloha peněženky": "Wallet backup",
  "Poslední záloha": "Last backup",
  "zatím žádná": "none yet",
  "Zálohování se dlouho nedaří.": "Backups have been failing for a while.",
  "Obnovu zálohy se nepodařilo dokončit, takže zálohování je až do dalšího otevření aplikace vypnuté.":
    "The backup could not be fully restored, so backing up is switched off until you reopen the app.",
  "před {seconds} s": "{seconds}s ago",
  "Síť": "Network",
  "Vzhled": "Appearance",
  "Jazyk": "Language",
  "Měna": "Currency",
  "Barevné téma": "Color theme",
  "Haptická odezva": "Haptic feedback",
  "Automatické uzamčení": "Auto-lock",
  "Vyzkoušet beta verzi": "Try the beta version",
  "Zapne rozpracované funkce, které ještě nejsou hotové pro každého — najdeš je označené jako beta.":
    "Turns on in-progress features that aren't ready for everyone yet — you'll find them marked as beta.",
  "Přepnout zpět na V1": "Switch back to V1",
  "Vyzkoušet V2": "Try V2",
  "VTXO mince": "VTXO coins",
  "Zobrazit seed phrase": "Show seed phrase",
  "Změnit heslo": "Change password",
  "Odemykání otiskem": "Fingerprint unlock",
  "zapnuto": "on",
  "Oznámení o platbách": "Payment notifications",
  "O peněžence": "About the wallet",
  "Verze": "Version",
  "Sestaveno": "Built",
  "Zobrazit changelog": "Show changelog",
  "Co je nového": "What's new",
  "Tohle je beta verze bez nezávislého auditu. Používej ji na vlastní riziko a nedrž v ní větší prostředky, než jsi ochotný ztratit.":
    "This is a beta version without an independent audit. Use it at your own risk and don't keep more funds in it than you're willing to lose.",
  "Nebezpečná zóna": "Danger zone",
  "Systém": "System",
  "Světlý": "Light",
  "Tmavý": "Dark",
  "Vypnuto": "Off",
  "Zapnuto": "On",
  "Zavřít": "Close",
  "Cena BTC od té doby": "BTC price since then",
  "Příchozí platba": "Incoming payment",
  "{n} potvrzení": "{n} confirmations",
  "Přijato na": "Received at",
  "v době platby": "at the time",
  "Odchozí platba": "Outgoing payment",
  "Načítám…": "Loading…",
  "Žádné VTXO.": "No VTXOs.",
  "Částka": "Amount",
  "Stav": "State",
  "Druh": "Kind",
  "Původ": "Origin",
  "Arkoor (hloubka {depth})": "Arkoor (depth {depth})",
  "In-round": "Created in a round",
  "Expiruje v bloku": "Expires at block",
  "Obnovit všechna VTXO": "Refresh all VTXOs",
  "Čeká na kolo serveru, do ~1 hodiny.": "Waiting for the server's round, up to ~1 hour.",
  "Appka je obnovuje sama před expirací. Tady to spustíš hned.":
    "The app refreshes them on its own before they expire. This starts it now.",
  "Proběhne v příštím kole serveru, do ~1 hodiny. Do té doby jde zrušit.":
    "Happens in the server's next round, within ~1 hour. Can be canceled until then.",
  "Obnova už čeká na kolo serveru.": "A refresh is already waiting for the server's round.",
  "Server nevrátil žádnou odpověď.": "The server returned no response.",
  "Obnovení VTXO dokončeno.": "VTXO refresh complete.",
  "Potvrdit": "Confirm",
  "Trezor nenalezen.": "Vault not found.",
  "Nesprávné heslo.": "Incorrect password.",
  "Ruším…": "Canceling…",
  "Zkusit znovu": "Try again",
  "Onchain transakce": "Onchain transactions",
  "Žádné onchain transakce.": "No onchain transactions.",
  "Změna zůstatku": "Balance change",
  "Potvrzeno v bloku {block}": "Confirmed at block {block}",
  "Potvrzení": "Confirmations",
  "V mempoolu (nepotvrzeno)": "In mempool (unconfirmed)",
  "Ano": "Yes",
  "Nikomu tato slova neukazuj. Kdokoliv je uvidí, může ti ukrást prostředky.":
    "Don't show these words to anyone. Anyone who sees them can steal your funds.",
  "Pro zobrazení seed phrase potvrď své heslo.": "Confirm your password to reveal the seed phrase.",
  "Ověřuji…": "Verifying…",
  "Zobrazit": "Reveal",
  "Skrýt": "Hide",
  "Nesprávné současné heslo.": "Incorrect current password.",
  "Heslo bylo změněno.": "Password changed.",
  "Zpět do nastavení": "Back to settings",
  "Současné heslo": "Current password",
  "Nové heslo": "New password",
  "Nové heslo znovu": "New password again",
  "Nová hesla se neshodují.": "New passwords don't match.",
  "Měním…": "Changing…",
  "Odemykání otiskem je zapnuté.": "Fingerprint unlock is on.",
  "Na tomto zařízení je zapnuté odemykání otiskem. Heslo pořád funguje jako záloha, pokud otisk selže.":
    "Fingerprint unlock is on for this device. The password still works as a fallback if the fingerprint fails.",
  "Vypnout odemykání otiskem": "Turn off fingerprint unlock",
  "Pro zapnutí odemykání otiskem potvrď své heslo. Otisk pak bude sloužit k rychlému odemčení místo hesla; heslo zůstává funkční jako záloha.":
    "Confirm your password to turn on fingerprint unlock. Your fingerprint will then unlock the wallet quickly instead of the password; the password stays working as a fallback.",
  "Nastavuji…": "Setting up…",
  "Zapnout odemykání otiskem": "Turn on fingerprint unlock",
  "Heslo k peněžence": "Wallet password",
  "Pokud prohlížeč nabídl uložení hesla, potvrď ho. Jinak si heslo zkopíruj.":
    "If your browser offered to save the password, confirm it. Otherwise copy the password.",
  "Appka ti pošle systémové oznámení, když dorazí platba — funguje i se zavřenou appkou nebo vypnutým telefonem/prohlížečem (na Androidu a desktopu; na iPhonu jen po přidání appky na plochu).":
    "The app will send a system notification when a payment arrives — works even with the app closed or the phone/browser off (on Android and desktop; on iPhone only after adding the app to your home screen).",
  "Aby to fungovalo i zavřené, náš vlastní server (ne cizí firma) občas nakoukne do tvé Ark schránky, jestli nedorazila platba — dočasně tak uvidí částku příchozí platby, ne obsah zprávy ani tvůj klíč. Samotné doručení oznámení je end-to-end šifrované, tohle vidí jen náš server.":
    "For this to work while closed, our own server (not a third party) occasionally checks your Ark mailbox for a payment — it briefly sees the incoming amount, not the message content or your key. The notification delivery itself is end-to-end encrypted; only our server sees this.",
  "Oznámení zapnutá": "Notifications on",
  "Vypneš je kdykoli v Nastavení.": "Turn them off anytime in Settings.",
  "Dá vědět o příchozí platbě, i se zavřenou appkou. Připíše se po otevření.": "Tells you about an incoming payment, even with the app closed. It settles once you open the app.",
  "Server Spendrru uvidí, že a kolik ti přišlo. Zprávy ani klíč ne.": "The Spendrr server sees that and how much arrived. Not messages or your key.",
  "Blokováno v prohlížeči. Povol oznámení v jeho nastavení.": "Blocked in the browser. Allow notifications in its settings.",
  "Nevratně smaže zašifrovanou peněženku (i otisk prstu) z tohoto prohlížeče. Bez zapsané seed phrase ztratíš přístup k prostředkům.": "Permanently deletes the encrypted wallet (and fingerprint unlock) from this browser. Without your written seed phrase you lose access to the funds.",
  "Nevratně smaže zašifrovanou peněženku (i otisk prstu) z tohoto prohlížeče. Prostředky zůstanou dostupné přes seed phrase, bez ní ne.": "Permanently deletes the encrypted wallet (and fingerprint unlock) from this browser. Funds stay reachable via your seed phrase, not without it.",
  "POZOR: běží nouzový exit. Jeho rozpracovaný stav existuje jen tady a obnova ze seed phrase ho nevrátí. Počkej, až doběhne.": "WARNING: an emergency exit is running. Its in-progress state exists only here and restoring from the seed phrase will not bring it back. Wait until it finishes.",
  "Podrž pro smazání": "Hold to delete",
  "Smažeš peněženku i s rozpracovaným exitem a riskuješ prostředky v něm.": "You delete the wallet along with the in-progress exit and risk the funds in it.",
  "Podrž tlačítko 2 sekundy. Pustíš-li dřív, nic se nestane.": "Hold the button for 2 seconds. Let go earlier and nothing happens.",
  "Drž…": "Keep holding…",
  "Vypínám…": "Turning off…",
  "Vypnout oznámení": "Turn off notifications",
  "Appka ti může posílat systémové oznámení o příchozích platbách — i se zavřenou appkou (na Androidu a desktopu; na iPhonu jen po přidání appky na plochu). Jde o probuzení, ne dokončení platby: appku si stejně musíš otevřít, aby se platba doopravdy vyřídila.":
    "The app can send system notifications about incoming payments — even with the app closed (on Android and desktop; on iPhone only after adding the app to your home screen). This is a wake-up, not a completed payment: you still have to open the app for the payment to actually settle.",
  "Vyžaduje, aby náš vlastní server (ne cizí firma) mohl občas zkontrolovat, jestli do tvé Ark schránky nedorazila platba — dočasně tak uvidí částku, ne obsah zprávy ani tvůj klíč peněženky.":
    "Requires our own server (not a third party) to occasionally check whether a payment arrived in your Ark mailbox — it briefly sees the amount, not the message content or your wallet key.",
  "Oznámení jsou blokovaná v nastavení prohlížeče. Povol je tam a zkus to znovu.":
    "Notifications are blocked in the browser settings. Allow them there and try again.",
  "Povoluji…": "Requesting…",
  "Zapnout oznámení": "Turn on notifications",
  "Zatřesením skrýt zůstatek": "Shake to hide balance",
  "Zatřesením telefonem teď zůstatek skryješ nebo zase zobrazíš — stejně jako přejetím prstem přes zůstatek.":
    "Shaking your phone now hides or reveals the balance — same as swiping across it.",
  "Vypnout zatřesení": "Turn off shake to hide",
  "Zatřesením telefonem půjde rychle skrýt zůstatek, kdyby se ti někdo díval přes rameno — stejný přepínač jako přejetí prstem přes zůstatek, jen navíc.":
    "Shaking your phone will quickly hide the balance if someone's looking over your shoulder — the same toggle as swiping across the balance, just with another trigger.",
  "Přístup k pohybovým senzorům byl zamítnut. Povol ho v nastavení prohlížeče a zkus to znovu.":
    "Access to motion sensors was denied. Allow it in the browser settings and try again.",
  "Zapnout zatřesení": "Turn on shake to hide",

  // Dashboard.tsx
  "ark.second.tech byl při odemykání nedosažitelný — appka teď pro tuhle relaci používá záložní zdroj dat mempool.space. Příště se zkusí připojit normálně.":
    "ark.second.tech was unreachable while unlocking — the app is using the fallback data source mempool.space for this session. It'll try connecting normally again next time.",
  "Počkej chvíli…": "Hold on a moment…",
  "Nejsi online.": "You're offline.",
  "Faktura zaplacena: +{amount} sats": "Invoice paid: +{amount} sats",
  "Platba přijata: +{amount} sats": "Payment received: +{amount} sats",
  "Platba odeslána: -{amount} sats": "Payment sent: -{amount} sats",
  "Obnovit": "Refresh",
  "Zůstatek skrytý, přejeď pro zobrazení": "Balance hidden, swipe to reveal",
  "Načítám zůstatek": "Loading balance",
  "Přijmout": "Receive",
  "Odeslat": "Send",
  "Nedávná aktivita": "Recent activity",
  "Zobrazit vše": "Show all",
  "Dnes": "Today",
  "Včera": "Yesterday",
  "{n} transakce": "{n} transactions",
  "Čeká na potvrzení": "Awaiting confirmation",
  "Potvrzeno": "Confirmed",
  "Selhalo": "Failed",
  "Ark adresa": "Ark address",
  "Generuji adresu…": "Generating address…",
  "Zkouším znovu… ({error})": "Retrying… ({error})",
  "Kopírovat adresu s částkou": "Copy address with amount",
  "Kopírovat adresu": "Copy address",
  "Požadovaná částka (nepovinné)": "Requested amount (optional)",
  "Zadej platnou částku v satoshi (celé číslo).": "Enter a valid amount in satoshis (a whole number).",
  "Kopírovat fakturu": "Copy invoice",
  "Zkopírováno do schránky": "Copied to clipboard",
  "Faktura zaplacena": "Invoice paid",
  "Platba přijata": "Payment received",
  "Platba odeslána": "Payment sent",
  "čeká se na platbu…": "waiting for payment…",
  "Nová faktura": "New invoice",
  "Zrušit": "Cancel",
  "Aktivní kola serveru": "Active server rounds",
  "Kolo #{id}": "Round #{id}",
  "Načítám… (pokud je kolo na serveru zaseknuté, může to trvat i několik minut)":
    "Loading… (if a round is stuck on the server, this can take several minutes)",
  "Zrušit všechna": "Cancel all",
  "blok {height}": "block {height}",
  // roundFlowKindLabel (Settings.tsx) — a round's own state, distinct from
  // the emergency-exit state labels above.
  "Čeká na naplánovanou výšku bloku": "Waiting for the scheduled block height",
  "Čeká na start kola": "Waiting for the round to start",
  "Probíhá": "In progress",
  "Čeká na potvrzení na blockchainu": "Waiting for blockchain confirmation",
  "Zrušeno": "Canceled",
  // VtxoConsolidate's own round-outcome toast (Settings.tsx)
  "Kolo selhalo. Zkus to znovu.": "The round failed. Try again.",
  "Kolo bylo zrušeno.": "The round was canceled.",
  "Kolo skončilo. Novou expiraci uvidíš v seznamu níže.": "The round is over. The new expiry shows in the list below.",
  "Synchronizovat": "Sync",
  "Synchronizuji (může trvat déle)…": "Syncing (may take a while)…",
  "čeká…": "pending…",
  "Popis (nepovinné)": "Description (optional)",
  "Za kávu": "For coffee",
  "Vytvářím fakturu…": "Creating invoice…",
  "Vytvořit Lightning fakturu": "Create Lightning invoice",
  "Lightning platba zaplacena. Preimage: {preimage}…": "Lightning payment paid. Preimage: {preimage}…",
  "Platba se zpracovává ({amount} sats)…": "Payment is processing ({amount} sats)…",
  "Stav platby se nepodařilo zjistit.": "Couldn't determine the payment status.",
  "Platba přes Ark odeslána.": "Payment sent via Ark.",
  "On-chain transakce odeslána.": "On-chain transaction sent.",
  "Komu": "To",
  "Typ": "Type",
  "Odhadovaný poplatek": "Estimated fee",
  "Platbu nelze po odeslání vzít zpět. Zkontroluj adresu a částku.":
    "A payment can't be undone once sent. Double-check the address and amount.",
  "Odesílám…": "Sending…",
  "Potvrdit a odeslat": "Confirm and send",
  "Potvrď heslo pro odeslání velké částky": "Confirm your password to send a large amount",
  "Zkontroluj platbu": "Review the payment",
  "Doručení": "Delivery",
  "hned": "instant",
  "desítky minut": "tens of minutes",
  "Odeslanou platbu nelze vzít zpět.": "A sent payment can't be undone.",
  "Heslo pro velkou částku": "Password for a large amount",
  "Adresa, faktura nebo Lightning adresa": "Address, invoice, or Lightning address",
  "Naskenovat QR kód": "Scan QR code",
  "nepovinné, pokud je ve faktuře": "optional if included in the invoice",
  "Počítám…": "Calculating…",
  "Poslat vše": "Send all",
  "Zatím žádné transakce.": "No transactions yet.",
  "Poplatek": "Fee",
  "Vytvořeno": "Created",
  "Dokončeno": "Completed",
  "Adresa": "Address",
  "Příjemce": "Recipient",
  "Zpráva od žadatele, Spendrr ji neověřuje": "A message from the requester, not checked by Spendrr",
  "Faktura": "Invoice",
  "Zůstatek nepokryje ani poplatek za odeslání.": "The balance doesn't even cover the sending fee.",
  "Ještě ověřuji cílovou adresu, chvíli počkej.": "Still verifying the destination address, please wait a moment.",
  "Neplatná adresa nebo faktura": "Invalid address or invoice",
  "Neplatná adresa nebo faktura. Zkontroluj, že jsi ji zkopíroval/a celou a bez překlepu.":
    "Invalid address or invoice. Check that you copied it in full and without a typo.",
  "Faktura už obsahuje částku {amount} sats — smaž zadanou částku, aby se použila ta z faktury.":
    "The invoice already has an amount of {amount} sats — clear the amount you typed so the invoice's own amount is used.",
  "Nevíme, jestli platba prošla. Zkontroluj historii — pokud tam platba není, zkus to za chvíli znovu.":
    "We don't know if the payment went through. Check your history — if it's not there, try again in a moment.",
  "On-chain": "On-chain",
  "Lightning faktura": "Lightning invoice",
  "Lightning adresa": "Lightning address",
  "Lightning offer (BOLT12)": "BOLT12 Lightning offer",
  "LNURL platba": "LNURL payment",
  "On-chain (bitcoin) adresa": "On-chain (bitcoin) address",
  "Přijato": "Received",
  "Odesláno": "Sent",
  "Odesláno on-chain": "Sent on-chain",
  "Ark platba": "Ark payment",
  "Lightning platba": "Lightning payment",
  "Lightning příjem": "Lightning receive",
  "Vklad na Ark": "Ark deposit",
  "Výstup na chain": "Exit to chain",

  // BtcPriceModal.tsx
  "Cenu se nepodařilo načíst.": "Couldn't load the price.",
  "Historii ceny se nepodařilo načíst.": "Couldn't load the price history.",
  "Načítám cenu": "Loading price",
  "Načítám graf": "Loading chart",
  "Graf se nepodařilo načíst. Zkusit znovu.": "Couldn't load the chart. Try again.",
  "Převodník": "Converter",
  "Částka v {unit}": "Amount in {unit}",
  "Prohodit měny": "Swap currencies",
  "Nová verze!": "New version!",
  "Nová verze": "New version",
  "V betě": "In beta",
  "Chápu": "Got it",
  "Načítám kurz": "Loading rate",
  "{pct} % za období": "{pct}% for the period",
  "7 dní": "7 days",
  "30 dní": "30 days",
  "3 měsíce": "3 months",
  "1 rok": "1 year",
  "od té doby": "since then",
  "Zdroj:": "Source:",
  "Cenová data": "Price data",
  "Licence": "Licenses",
  "Třetí strany": "Third party",
  "Zdrojový kód": "Source code",
  "Podmínky a soukromí": "Terms and privacy",
  "Podmínky": "Terms",
  "Soukromí": "Privacy",
  "3m": "3mo",
  "právě teď": "just now",
  "před {n} s": "{n}s ago",
  "před {n} min": "{n} min ago",
  "1r": "1y",
  "teď": "now",
  "dnes": "today",

  // Coachmark.tsx / onboarding tour
  "Rozumím": "Got it",
  "Dvojklikem na logo zobrazíš aktuální kurz bitcoinu.": "Double-tap the logo to see the current bitcoin price.",
  "Přejetím zůstatek skryješ, klepnutím přepneš měnu.": "Swipe the balance to hide it, tap to switch currency.",
  "Dvojitým klepnutím sem peněženku zamkneš.": "Double-tap here to lock the wallet.",
  "Klepnutím na QR kód zkopíruješ adresu do schránky.": "Tap the QR code to copy the address to your clipboard.",

  // QrScanner.tsx
  "Tento prohlížeč neumí číst QR kódy z kamery.": "This browser can't read QR codes from the camera.",
  "Přístup ke kameře byl zamítnut. Povol ho v nastavení prohlížeče a zkus to znovu.":
    "Camera access was denied. Allow it in the browser settings and try again.",
  "Nebyla nalezena žádná kamera.": "No camera was found.",
  "Kameru se nepodařilo spustit.": "Couldn't start the camera.",
  "Namiř kameru na QR kód s adresou nebo fakturou.": "Point the camera at a QR code with an address or invoice.",
  "Zapnout blesk": "Turn on flash",
  "Vypnout blesk": "Turn off flash",
  "Kamera nejde spustit": "Can't start the camera",
  "Spouštím kameru…": "Starting camera…",
  "Dvojitým klepnutím rozsvítíš blesk": "Double-tap to turn on the flash",

  // Onchain receive + boarding (Dashboard.tsx)
  "Příchozí onchain platba: {amount} sats": "Incoming onchain payment: {amount} sats",
  "Z galerie": "From gallery",
  "Fotoaparát": "Camera",
  "QR v obrázku nenalezen": "No QR code in the image",
  "Nepotvrzená onchain platba: {amount} sats · čeká na potvrzení": "Unconfirmed onchain payment: {amount} sats · awaiting confirmation",
  "Přijmout onchain platbu": "Receive onchain payment",
  "Poplatek síti": "Network fee",
  "Přijde na zůstatek": "Arrives in balance",
  "Přijmout do zůstatku": "Receive into balance",
  "Přijmout on-chain": "Receive on-chain",
  "Nezávislý uzel neodpovídá, exit teď běží přes servery Second.": "The independent node isn't answering, so the exit now runs through Second's servers.",
  "On-chain navíc: {amount}": "On-chain besides: {amount}",
  "On-chain na poplatky: {amount}": "On-chain for fees: {amount}",
  "{amount} čeká": "{amount} pending",
  "On-chain navíc: {amount} čeká": "On-chain besides: {amount} pending",
  "On-chain na poplatky: {amount} čeká": "On-chain for fees: {amount} pending",
  "Běží nouzový exit a tyhle peníze můžou být potřeba na jeho poplatky. Po přesunu je exit nepoužije.":
    "An emergency exit is running and it may need this money for fees. Once moved, the exit can't use it.",
  "Přesunou se do zůstatku, kde je normálně utratíš.": "They move to your balance, where you spend them as usual.",
  "Rozumím, přesto přesunout": "I understand, move it anyway",
  "Prostředky se přesunou z on-chain adresy do tvého Ark zůstatku, odkud je můžeš normálně používat na odesílání i Lightning platby.":
    "Funds will move from the on-chain address into your Ark balance, where you can use them normally for sending and Lightning payments.",
  "Přesouvám": "Moving",
  "Potvrdit a přijmout": "Confirm and receive",
  "Prostředky přesunuty do Ark": "Funds moved into Ark",
  "Platbu je nutné ručně přijmout, než se přičte k tvému zůstatku.":
    "You need to manually accept the payment before it's added to your balance.",
  "Částka je pod minimem pro přesun do Ark ({min} sats). Počkej, až on-chain zůstatek naroste, a zkus to znovu.":
    "The amount is below the minimum for moving into Ark ({min} sats). Wait for the on-chain balance to grow and try again.",
  "Příchozí onchain platba: {amount} sats · pod minimem pro přesun ({min} sats), čeká se na doplnění":
    "Incoming on-chain payment: {amount} sats · below the minimum to move ({min} sats), waiting for more",

  // EmergencyExit.tsx
  "Nouzový výstup z Ark": "Emergency exit from Ark",
  "Cílová adresa": "Destination address",
  "Zahajuji…": "Starting…",
  "Změnit cílovou adresu": "Change destination address",
  "Tohle nevypadá jako platná bitcoinová adresa.": "This doesn't look like a valid Bitcoin address.",

  // Dashboard.tsx exit progress toast + ExitDrainConfirmModal
  "Počet VTXO": "Number of VTXOs",
  "Cílová adresa se ztratila. Zkus to prosím znovu z Nastavení.": "The destination address was lost. Please try again from Settings.",

  // Unconfirmed-broadcast recovery (Dashboard.tsx confirmExitDrain)

  // On-chain funds held back as exit fee budget (Dashboard.tsx board toast)
  "+ {amount} sats v obnově VTXO": "+ {amount} sats refreshing VTXOs",
  "+ {amount} sats v obnově mincí": "+ {amount} sats refreshing coins",
  "z toho {amount} sats je v obnově VTXO": "of which {amount} sats is refreshing VTXOs",
  "Nový nouzový exit": "New emergency exit",
  "Nouzový exit je teď jedno okno s průběhem, poplatky a vyzvednutím.": "The emergency exit is now one window with progress, fees and claiming.",
  "Mince v exitu se zamknou, aby je nic jiného neutratilo.": "Coins in the exit are locked so nothing else can spend them.",
  "Mince, které se právě obnovují, přidáš do exitu po obnově. Když Ark server nefunguje, jdou do něj hned.":
    "Coins in a refresh right now join the exit once it ends. If the Ark server is down, they go in straight away.",
  "Upozorní, když by mince vypršely dřív, než se exit dostane na blockchain.":
    "Warns you when coins would expire before the exit gets on-chain.",
  "Zrušení exitu teď chce heslo.": "Canceling an exit now asks for your password.",
  // Unilateral exit (ExitSheet.tsx, ExitHomeCard.tsx, exitCopy.ts, exitActions.ts)
  "Tvoje bitcoinová adresa ({prefix}…)": "Your bitcoin address ({prefix}…)",
  "Tohle není platná bitcoinová adresa.": "This isn't a valid bitcoin address.",
  "Nouzový exit z Ark": "Emergency exit from Ark",
  "na tvou bitcoinovou adresu, bez Ark serveru": "to your bitcoin address, without the Ark server",
  "Nepodařilo se načíst stav peněženky: {error}": "Couldn't load the wallet state: {error}",
  "V Ark teď nemáš žádné mince, které by šly takhle vystoupit.": "You have no coins in Ark that can exit this way right now.",
  "Poplatky teď": "Fees now",
  "{have} z ~{fee}": "{have} of ~{fee}",
  "neznámé": "unknown",
  "Za vyzvednutí": "To claim",
  "Trvání": "Duration",
  "{steps} bl. + zámek {lock}": "{steps} blocks + lock {lock}",
  "hodiny až dny": "hours to days",
  "Mince se zamknou. Exit běží, jen když je appka otevřená.": "The coins get locked. The exit only moves while the app is open.",
  "Méně": "Less",
  "Víc": "More",
  "Poplatky teď jdou z on-chain zůstatku, za vyzvednutí se strhnou z částky.": "Fees now come from your on-chain balance; the claim fee is taken from the amount.",
  "Když Ark server funguje, je obyčejné odeslání na on-chain adresu levnější.": "While the Ark server works, an ordinary send to an on-chain address is cheaper.",
  "Zrušit jde, dokud neodejde poslední transakce mince. Odeslané kroky i jejich poplatky zůstanou.": "It can be canceled until a coin's last transaction goes out. Steps already sent, and their fees, stay.",
  "{amount} v drobných mincích zůstane v Ark (pod minimem pro blockchain).": "{amount} in tiny coins stays in Ark (below the blockchain minimum).",
  "Poplatky nejde spočítat: {error}": "Can't work out the fees: {error}",
  "Na poplatky chybí ~{amount} on-chain. Pošli je přes Přijmout → On-chain a nepřesouvej do Ark.": "~{amount} on-chain is missing for fees. Send it via Receive → On-chain and don't move it into Ark.",
  "Na poplatky nemáš dost on-chain. Pošli si pár tisíc sats přes Přijmout → On-chain.": "Not enough on-chain for fees. Send yourself a few thousand sats via Receive → On-chain.",
  "Spustit i tak, počká na doplnění": "Start anyway, it waits for the top-up",
  "Exit se nespustil pro žádnou minci.": "The exit didn't start for any coin.",
  "Spouštím": "Starting",
  "Spustit nouzový exit": "Start emergency exit",
  "Připraveno k vyzvednutí": "Ready to claim",
  "Posílám na blockchain": "Sending to the blockchain",
  "Běží časový zámek": "Timelock running",
  "Vyzvednutí je na cestě": "Claim on its way",
  "Nouzový exit": "Emergency exit",
  "Pošli je na svou adresu.": "Send them to your address.",
  "Chystám první transakci.": "Preparing the first transaction.",
  "Potvrzeno {done} z {total} transakcí.": "{done} of {total} transactions confirmed.",
  "Potvrzeno {done} z {total} transakce.": "{done} of {total} transaction confirmed.",
  "Vyzvednout půjde za {left}.": "Claimable in {left}.",
  "Zámek skončil, čekám na další blok.": "Lock over, waiting for the next block.",
  "Čeká na potvrzení v bloku.": "Waiting for confirmation in a block.",
  "poslední transakce už odešla": "the last transaction already went out",
  "exit je už dál": "the exit is further along",
  "žádný exit neprobíhá": "no exit in progress",
  "počítám…": "calculating…",
  "Dorazí": "Arrives",
  "Na adresu": "To address",
  "není nastavená": "not set",
  "Adresa není potvrzená heslem, nastav ji znovu v „Změnit adresu“.": "The address isn't confirmed with your password; set it again under “Change address”.",
  "Síť transakci odmítla, nic neodešlo: {error}": "The network rejected the transaction, nothing was sent: {error}",
  "Odesílám": "Sending",
  "Poslat {amount} na moji adresu": "Send {amount} to my address",
  "v síti, čeká na potvrzení v bloku": "on the network, waiting for a block",
  "odesláno, peněženka ho brzy uvidí": "sent, the wallet will see it shortly",
  "síť neodpověděla; když neodešla, do 15 min půjde poslat znovu": "no answer from the network; if it didn't go out, you can send again within 15 min",
  "Zobrazit transakci": "View transaction",
  "Platí pro to, co ještě neodešlo.": "Applies to whatever hasn't been sent yet.",
  "Uložit adresu": "Save address",
  "Mimo exit máš {amount} (třeba nové platby). Přidají se na stejnou adresu, poplatky jdou z on-chain.": "You have {amount} outside the exit (new payments, say). They join it to the same address; fees come from on-chain.",
  "Přidat {amount} do exitu": "Add {amount} to the exit",
  "Zrušit jde {count} mincí ({amount}). Vrátí se do Ark, už zaplacené poplatky ne.": "{count} coins ({amount}) can be canceled. They go back to Ark; fees already paid don't.",
  "Některé mince zrušit nešlo: {reasons}": "Some coins couldn't be canceled: {reasons}",
  "Zrušit exit těchto mincí": "Cancel the exit for these coins",
  "Exit stojí": "Exit stalled",
  "Běží, jen když je appka otevřená.": "Only moves while the app is open.",
  "Běží, jen když je appka otevřená. Na blockchain musí doběhnout do {left}.":
    "Only moves while the app is open. It has to be fully on-chain within {left}.",
  "Spěchá: {amount} vyprší za {left}. Do té doby musí být celý exit na blockchainu, jinak si mince vezme Ark server. Nech appku otevřenou a měj on-chain na poplatky.":
    "Urgent: {amount} expires in {left}. The whole exit has to be on-chain by then, or the Ark server can take the coins. Keep the app open and keep on-chain funds for fees.",
  "{amount} už vypršelo, než se exit dostal na blockchain. Ark server si ty mince teď může vzít; exit se o ně dál pokouší.":
    "{amount} expired before the exit got on-chain. The Ark server can now take those coins; the exit keeps trying.",
  "Na blockchain se exit musí dostat, než mince vyprší (nejbližší za {left}). Pak si je může vzít Ark server.":
    "The exit has to get on-chain before the coins expire (the first in {left}). After that the Ark server can take them.",
  "Některé mince vyprší za {left}. Exit je musí do té doby dostat celé na blockchain, jinak si je vezme Ark server. Když server funguje, pošli peníze radši běžně na on-chain adresu.":
    "Some coins expire in {left}. The exit has to get them fully on-chain before then, or the Ark server takes them. While the server works, a normal send to an on-chain address is the safer way out.",
  "Některé mince už vypršely. Exitem je nejspíš nezachráníš: Ark server si je může vzít dřív, než se dostanou na blockchain.":
    "Some coins have already expired. An exit probably won't save them: the Ark server can take them before they get on-chain.",
  "Spěchá: mince vyprší za {left}": "Urgent: coins expire in {left}",
  "Nemáš on-chain peníze na poplatky.": "No on-chain funds for the fees.",
  "Na poplatky chybí on-chain peníze. Pošli je přes Přijmout → On-chain, exit pak pokračuje sám.":
    "The on-chain balance can't pay the fees. Send some via Receive → On-chain and the exit carries on by itself.",
  "Poplatky teď: {count} transakce na blockchain při ~{rate} sat/vB, rychlé sazbě sítě, která se mění.":
    "Fees now: {count} on-chain transaction(s) at ~{rate} sat/vB, the network's fast rate, which moves.",
  "Poplatky teď: {count} transakcí na blockchain při ~{rate} sat/vB, rychlé sazbě sítě, která se mění.":
    "Fees now: {count} on-chain transactions at ~{rate} sat/vB, the network's fast rate, which moves.",
  "Posun exitu minule nedoběhl, další pokus v {time}. Hned ho spustí „Zkontrolovat teď“.":
    "Moving the exit forward didn't finish last time; next try at {time}. “Check now” runs it right away.",
  "Nepodařilo se zjistit, které mince jsou právě v obnově, tak exit nespouštím. Zkus to za chvíli znovu.":
    "Couldn't tell which coins are in a refresh right now, so the exit isn't started. Try again in a moment.",
  "Ark server neodpovídá, takže obnova mincí nedoběhne. {amount} z ní jde do exitu taky.":
    "The Ark server isn't answering, so the coin refresh won't finish. {amount} from it goes into the exit too.",
  "{amount} je právě v obnově mincí. Do exitu je přidáš, až obnova skončí, obvykle do hodiny.":
    "{amount} is in a coin refresh right now. You can add it to the exit once the refresh ends, usually within an hour.",
  "Přidat i mince z obnovy":
    "Add the coins in the refresh too",
  "Přidat je hned":
    "Add them now",
  "Jen když server nefunguje. Pokud obnovu dokončí, exit těchto mincí skončí a poplatky za ně propadnou.":
    "Only if the server is down. If it completes the refresh, the exit of these coins ends and their fees are lost.",
  "Načítám mince":
    "Loading coins",
  "Mimo exit teď nemáš žádné mince, které by šly přidat.":
    "You have no coins outside the exit that could be added.",
  "{amount} mimo exit, můžeš je přidat":
    "{amount} outside the exit, you can add it",
  "Mince v exitu brzy vyprší. Otevři appku, ať se exit dostane na blockchain včas.":
    "Coins in your exit expire soon. Open the app so the exit gets on-chain in time.",
  "Oznámení o obnově mincí": "Coin refresh notifications",
  "Upozornění na obnovu mincí přijde včas, abys ji stihl.": "The coin refresh reminder arrives in time for you to act on it.",
  "Po obnově už zbytečně nepřipomíná a staré upozornění zmizí.": "It no longer nags after a refresh, and the old notification goes away.",
  "Mince čekají na obnovu. Otevři Spendrr.": "Your coins are due for a refresh. Open Spendrr.",
  "Obnova mincí pořád čeká. Otevři Spendrr.": "Your coins are still waiting for a refresh. Open Spendrr.",
  "Mince brzy vyprší. Otevři Spendrr hned.": "Your coins expire soon. Open Spendrr now.",
  "BTC mezitím vyrostl o {pct} % 📈.": "BTC is up {pct}% in the meantime 📈.",
  "BTC mezitím spadl o {pct} % 📉.": "BTC is down {pct}% in the meantime 📉.",
  "Mince jsou připravené k vyzvednutí. Otevři appku a pošli je na svou adresu.":
    "Your coins are ready to claim. Open the app and send them to your address.",
  "Časový zámek končí. Otevři appku a vyzvedni mince.": "The timelock is ending. Open the app and claim your coins.",
  "Exit stojí: chybí on-chain na poplatky. Pošli je a otevři appku.":
    "The exit is stalled: no on-chain funds for fees. Send some and open the app.",
  "Exit čeká na další krok na blockchainu. Mrkni do appky.": "The exit is waiting for its next on-chain step. Take a look in the app.",
  "Mince vypršely, exit nestihl blockchain": "Coins expired before the exit got on-chain",
  "Na poplatky chybí on-chain peníze (potřeba ~{amount}). Pošli je přes Přijmout → On-chain, exit pak pokračuje sám.": "On-chain funds for fees are missing (~{amount} needed). Send them via Receive → On-chain and the exit carries on by itself.",
  "Na poplatky máš dost (~{amount}).": "You have enough for fees (~{amount}).",
  "Poplatky jsou zaplacené, čeká se na potvrzení.": "Fees are paid, waiting for confirmation.",
  "Nepodařilo se ověřit, jestli zůstatek stačí na poplatky: {error}": "Couldn't check whether your balance covers the fees: {error}",
  "Chybí cílová adresa. Nastav ji v „Změnit adresu“.": "No destination address. Set it under “Change address”.",
  "nepotvrzená heslem": "not confirmed with password",
  "Mince ({count})": "Coins ({count})",
  "Změnit adresu": "Change address",
  "Přidat mince": "Add coins",
  "Peněženka hlásí: {error}": "The wallet reports: {error}",
  "Poslední kontrola selhala ({error}), zkouším znovu.": "The last check failed ({error}), retrying.",
  "Zkontrolováno v {time}.": "Checked at {time}.",
  "Zkontrolovat teď": "Check now",
  "Nouzový exit dokončen": "Emergency exit complete",
  "{amount} je na {address}.": "{amount} is at {address}.",
  "Poplatek {amount}.": "Fee {amount}.",
  "Platby při obnově mincí": "Payments during coin renewal",
  "Platit můžeš i během obnovy mincí, nic se nezablokuje.": "You can pay during coin renewal, nothing gets blocked.",
  "Oznámení o příchozích platbách fungují až 30 dní bez otevření appky.": "Incoming payment notifications work for up to 30 days without opening the app.",
  "Nouzový exit: přesné údaje": "Emergency exit: accurate figures",
  "Průběh, poplatky i vyzvednutá částka teď odpovídají skutečnosti.": "Progress, fees and the claimed amount now match what happened.",
  "Zobrazit transakce ({count})": "Show transactions ({count})",
  "tvé adrese": "your address",
  "Spustit další exit": "Start another exit",
  "Zjišťuji stav exitu": "Checking the exit",
  "Nepodařilo se to: {error}. Zkouším znovu.": "That failed: {error}. Retrying.",
  "{amount} je na tvé adrese": "{amount} is at your address",
  "Detail": "Details",
  "Stojí: chybí on-chain na poplatky": "Stalled: no on-chain funds for fees",
  "Kontrola selhala, zkouším znovu": "Check failed, retrying",
  "Vyzvednout": "Claim",
  "{blocks} bloků, {duration}": "{blocks} blocks, {duration}",
  "{blocks} blok, {duration}": "{blocks} block, {duration}",
  "{blocks} bloky, {duration}": "{blocks} blocks, {duration}",
  "{amount} k vyzvednutí": "{amount} ready to claim",
  "Chystám první transakci": "Preparing the first transaction",
  "Na blockchain: potvrzeno {done} z {total}": "To the blockchain: {done} of {total} confirmed",
  "Časový zámek, zbývá {left}": "Timelock, {left} left",
  "Zámek skončil, čekám na blok": "Lock over, waiting for a block",
  "Vyzvednutí čeká na potvrzení": "Claim waiting for confirmation",
  "čeká na zaplacení poplatku z on-chain zůstatku": "waiting to pay its fee from the on-chain balance",
  "čeká na potvrzení předchozí transakce": "waiting for the previous transaction to confirm",
  "ověřuje předchozí transakce": "checking the previous transactions",
  "odesláno, čeká na potvrzení v bloku": "sent, waiting for a block",
  "Připravuje se první transakce": "Preparing the first transaction",
  "Transakce {done} z {total} potvrzeno · {waiting}": "{done} of {total} transactions confirmed · {waiting}",
  "Časový zámek: zbývá {left}": "Timelock: {left} left",
  "Časový zámek skončil, peněženka to potvrdí s dalším blokem": "Timelock over, the wallet confirms it with the next block",
  "Vyzvednutí odesláno, peněženka ho zatím nevidí": "Claim sent, the wallet doesn't see it yet",
  "Vyzvednutí čeká na potvrzení v bloku": "Claim waiting for a block",
  "Vyzvednuto v bloku {height}": "Claimed in block {height}",
  "Vyzvednuto": "Claimed",
  "Přerušeno: mince byla utracena jinak, než se exit dostal na blockchain": "Aborted: the coin was spent some other way before its exit reached the blockchain",
  "Zrušeno, mince zůstala v Ark": "Canceled, the coin stayed in Ark",
  "Není nastavená cílová adresa. Nastav ji níž v „Cílová adresa“.": "No destination address set. Set it under “Change address”.",
  "Cílová adresa není potvrzená heslem, takže nejde ověřit, že ji nikdo nezměnil. Zadej ji prosím znovu.":
    "The destination address isn't confirmed with your password, so there's no way to tell nobody changed it. Please enter it again.",
  "Uložená cílová adresa neodpovídá té, kterou jsi potvrdil heslem. Mohla být změněna mimo appku. NEODESÍLEJ a nastav ji prosím znovu.": "The stored destination address doesn't match the one you confirmed with your password. It may have been changed outside the app. DON'T SEND — set it again.",
  "Adresu se nepodařilo zabezpečit heslem. Zkus to prosím znovu.": "Couldn't secure the address with your password. Please try again.",
  "Teď není co vyzvednout.": "Nothing to claim right now.",
  "Probíhá nouzový exit — tyhle on-chain sats se drží na jeho poplatky a nejde je teď přesunout.": "An emergency exit is running — these on-chain sats are held for its fees and can't be moved now.",
  "+ {amount} sats v nouzovém exitu": "+ {amount} sats in the emergency exit",
  "Nouzový exit, smazání peněženky": "Emergency exit, deleting the wallet",
  "POZOR: právě probíhá nouzový exit z Ark. Jeho rozpracovaný stav (které transakce už byly postavené a odeslané) existuje jen v tomhle prohlížeči a smazáním o něj přijdeš — obnova ze seed phrase ho nevrátí, protože ta se ptá Ark serveru, tedy přesně toho, bez kterého má nouzový exit fungovat. Prostředky v probíhajícím exitu můžeš tímhle krokem nenávratně ztratit. Počkej prosím, až exit doběhne.": "WARNING: an emergency exit from Ark is running. Its in-progress state (which transactions were built and sent) exists only in this browser and deleting it loses that — restoring from the seed phrase won't bring it back, because that asks the Ark server, exactly what the emergency exit is meant to work without. You can irreversibly lose the funds in the running exit with this step. Please wait for the exit to finish.",
  "Opravdu chceš peněženku smazat i s rozpracovaným nouzovým exitem, a riskovat ztrátu prostředků v něm?": "Do you really want to delete the wallet along with the running emergency exit, and risk losing the funds in it?",
  // VTXO refresh info card (RefreshInfoSheet.tsx, v2 beta)
  "Obnovuji mince": "Refreshing coins",
  "Prodlužuji platnost {amount}\u00a0sats.": "Extending the validity of {amount}\u00a0sats.",
  "Pak se vrátí do zůstatku.": "Then it returns to your balance.",
  "Nemusíš nic dělat.": "Nothing for you to do.",

  // Exit state diagnostics (Dashboard.tsx describeExitState)
  "čeká na potvrzení předchozího kroku": "waiting for the previous step to confirm",
  "připraveno k vyzvednutí": "ready to claim",
  "vyzvednutí probíhá": "claim in progress",
  "vyzvednuto": "claimed",
  "nejspíš vyzvednuto": "probably claimed",
  "Rozpracované odeslání míří na adresu {old}, ale teď je nastavená {new}. Podepsanou transakci už přesměrovat nejde. Vrať prosím cílovou adresu zpět na {old} a odešli, nebo počkej — pokud ta původní transakce v síti uvízne, půjde po jejím vypršení postavit novou.":
    "The pending send pays to {old}, but {new} is set now. A signed transaction can't be redirected. Please set the destination back to {old} and send, or wait — if that original transaction stalls on the network, a new one can be built once it expires.",

  // Reset-wallet warning while an exit is mid-flight (App.tsx)
  "Tohle nevratně smaže zašifrovanou peněženku (a otisk prstu, pokud je nastavený) z tohoto prohlížeče. Bez zapsané seed phrase k prostředkům ztratíš přístup.":
    "This irreversibly deletes the encrypted wallet (and the fingerprint, if set up) from this browser. Without your written-down seed phrase you lose access to the funds.",

  // Spend authorization enforced by the wallet worker (walletSession.ts)
  "Potvrď prosím platbu heslem.": "Please confirm this payment with your password.",
  "Denní limit plateb bez hesla je vyčerpaný. Potvrď prosím platbu heslem.":
    "The daily limit for payments without a password is used up. Please confirm this payment with your password.",

  // Gift links: the recipient side (GiftClaimModal.tsx) — the one screen in
  // this app someone can see without ever having chosen to install it, so
  // this coverage matters more than its line count suggests.
  "Dostal jsi dárek": "You got a gift",
  "Bitcoin na tebe čeká": "Bitcoin is waiting for you",
  "vzkaz": "message",
  "Něco se nepovedlo.": "Something went wrong.",
  "Na tomhle zařízení už peněženku máš. Odemkni ji a dárek se do ní připíše.":
    "You already have a wallet on this device. Unlock it and the gift will be added to it.",
  "Odemknout a přijmout": "Unlock and accept",
  "Přijímám…": "Accepting…",
  "Přijmout dárek": "Accept the gift",
  "Vytvoří se ti vlastní peněženka. Klíče má jen tvoje zařízení.":
    "Your own wallet will be created. Only your device holds the keys.",

  // Gift links: the one-time "save your password" prompt for a fresh
  // recipient wallet (GiftPasswordModal.tsx) — not dismissible except by
  // confirming, so this is the whole screen, not a caption on some other one.
  "Ulož si heslo k peněžence": "Save your wallet's password",
  "Peněženka ti vznikla přes dárkový odkaz, heslo jsme ti vytvořili automaticky. Bez něj se do ní nedostaneš na jiném zařízení ani nezobrazíš seed frázi. Ulož si ho do správce hesel.":
    "Your wallet was created through a gift link, and we generated its password for you automatically. Without it you won't be able to open the wallet on another device or reveal the seed phrase. Save it in a password manager.",
  "Heslo zadávej přesně i s pomlčkami.": "Enter the password exactly, dashes included.",
  "Prohlížeč uložení nenabídl — zkopíruj si heslo ručně.": "The browser didn't offer to save it — copy the password manually.",
  "Uložit do správce hesel": "Save to password manager",
  "Uloženo": "Saved",
  "Zkopírovat heslo": "Copy password",
  "Zkopírováno": "Copied",
  "Nelze zkopírovat": "Could not copy",
  "Přispět": "Donate",
  "Donate stránka": "Donate page",
  "Kdokoli ti může poslat bitcoin na stránce s tvým jménem.": "Anyone can send you bitcoin on a page with your name.",
  "V profilu zkopíruješ odkaz na stránku pro donate.": "In your profile you can copy the link to your donate page.",
  "Zvolit částku": "Choose an amount",
  "Podpora vývoje": "Support development",
  "Zkopírovat donate odkaz": "Copy donate link",
  "Otevřít v peněžence": "Open in wallet",
  "Díky!": "Thanks!",
  "Pro": "For",
  "až": "to",
  "Poslat bitcoin": "Send bitcoin",
  "Tahle adresa nepřijímá Lightning platby.": "This address does not accept Lightning payments.",
  "Vyber částku v sat": "Pick an amount in sats",
  "Vlastní částka": "Custom amount",
  "Vlastní částka v sat": "Custom amount in sats",
  "Vytvořit": "Create",
  "Fakturu se nepodařilo vytvořit.": "Could not create the invoice.",
  "Čekám na platbu": "Waiting for payment",
  "Zaplaceno. Díky!": "Paid. Thanks!",
  "Poslat znovu": "Send again",
  "Uložil/a jsem si ho": "I've saved it",

  // Gift links: the sender side, "send bitcoin as a link" (GiftComposeModal.tsx)
  "Poslat dárkem": "Send as a gift",
  "Částka (sats)": "Amount (sats)",
  "Maximum je 100 000 sats.": "The maximum is 100,000 sats.",
  "Víc, než máš k dispozici.": "More than you have available.",
  "Zadej částku.": "Enter an amount.",
  "Vzkaz (nepovinné)": "Message (optional)",
  "Všechno nejlepší!": "All the best!",
  "Vytvořit odkaz": "Create link",
  "Vytvořit odkaz na": "Create a link for",
  "Částka teď opustí tvůj zůstatek. Nevyzvednutý dárek se ti sám vrátí po 7 dnech.":
    "The amount leaves your balance right away. An unclaimed gift returns to you automatically after 7 days.",
  "Vytvářím odkaz…": "Creating the link…",
  "Nevíme, jestli se dárek odeslal. Zkontroluj historii peněženky, než to zkusíš znovu — druhý pokus by mohl poslat bitcoiny podruhé.":
    "We don't know if the gift was sent. Check your wallet history before trying again — a second attempt could send the bitcoin twice.",
  "Dárkový odkaz vytvořen": "Gift link created",
  "Zkopírovat odkaz": "Copy link",
  "Odkaz zkopírován": "Link copied",
  "Poslal jsem ti bitcoin 🎁": "I sent you some bitcoin 🎁",
  "Sdílet": "Share",
  "Kopírovat": "Copy",
  "Kopírování selhalo — zkopíruj odkaz ručně.": "Copying failed — copy the link manually.",
  "Hotovo": "Done",

  // Gift links: sender-side management, Settings → Peněženka → Odeslané dárky
  "Odeslané dárky": "Sent gifts",
  "nedokončeno": "unfinished",
  "čeká na vyzvednutí": "awaiting claim",
  "vráceno tobě": "returned to you",
  "stav": "status",
  "ověřuji…": "checking…",
  "Vracím…": "Returning…",
  // Sent gifts list rebuilt on the recovery scan (beta, SentGiftsView)
  "Čeká": "Waiting",
  "Otevřeno": "Opened",
  "Vráceno": "Returned",
  "platba se nejspíš neodeslala": "payment most likely did not go out",
  "vrací se": "returning",
  // Gift sheet: cancel right after creating (beta)
  "Zrušit dárek": "Cancel gift",
  "Dárek se vrátí na tvůj zůstatek a odkaz přestane fungovat.": "The gift returns to your balance and the link stops working.",
  "Ne": "No",
  "Ano, zrušit": "Yes, cancel",
  "Dárek je zpět": "Gift is back",
  // Passwordless gift wallet (beta): PasswordSetupSheet, App.tsx
  "Tahle peněženka vznikla z dárku. Zatím ji nic nechrání.": "This wallet came from a gift. Nothing protects it yet.",
  "Větší platby se potvrzují heslem. Nastav si ho a platbu pak zopakuj.": "Larger payments are confirmed with a password. Set one, then repeat the payment.",
  "Heslo (min. 8 znaků)": "Password (min. 8 characters)",
  "Heslo se nepodařilo nastavit.": "Could not set the password.",
  "Zapiš si seed": "Write down the seed",
  "Na papír, v tomhle pořadí. Bez něj o peníze přijdeš.": "On paper, in this order. Without it you lose the money.",
  "Zapsal/a jsem si ho": "I wrote it down",
  "Nejdřív si nastav heslo k peněžence.": "Set a wallet password first.",
  "Peněženku se na tomhle zařízení nepodařilo otevřít. Obnov ji ze seed fráze.": "The wallet could not be opened on this device. Restore it from the seed phrase.",
  "Smazat peněženku": "Delete wallet",
  "Otevírám…": "Opening…",
  "Vzít zpět": "Take back",
  "Kopírovat odkaz": "Copy link",
  "Zálohy jsou pro tuto relaci nedostupné — správu dárků nelze zobrazit.":
    "Backups are unavailable for this session — gift management can't be shown.",
  "Zatím jsi žádný dárkový odkaz nevytvořil.": "You haven't created any gift links yet.",
  "V tomhle nedokončeném dárku nic nezůstalo — platba se nejspíš nikdy neodeslala.":
    "Nothing is left in this unfinished gift — the payment most likely never went through.",
  "Tento dárek už byl mezitím vyzvednut.": "This gift has already been claimed in the meantime.",
  "Kopírování selhalo.": "Copying failed.",
  "Beta": "Beta",

  // Diagnostics, Settings → Peněženka → Log peněženky
  "Log peněženky": "Wallet log",
  "Počet záznamů": "Number of entries",
  "Nejstarší záznam": "Oldest entry",
  "Chyby": "Errors",
  "Exportovat": "Export",
  "Exportuji…": "Exporting…",
  "Vymazat": "Clear",
  "Zatím žádná volání.": "No calls yet.",
  "Neznámá chyba": "Unknown error",

  // Payment-notification consent copy (Settings.tsx) — read this alongside
  // src/lib/notifications.ts and ARCHITECTURE.md's push-notifications section: the
  // wording is deliberately specific about what this app's own server can
  // and can't see, so it shouldn't drift from what the code actually does.
  "Aby oznámení fungovala i zavřené, náš server (ne cizí firma) čas od času nakoukne do tvé Ark schránky — uvidí jen to, že a kolik ti přišlo, ne obsah zprávy ani tvůj klíč. Samotné oznámení je pak šifrované až k tobě.":
    "For notifications to work even while the app is closed, our own server (not a third party) occasionally peeks into your Ark mailbox — it only ever sees that a payment arrived and how much, never the message content or your key. The notification itself is then encrypted all the way to you.",
  "Náš server (ne cizí firma) k tomu čas od času nakoukne do tvé Ark schránky — uvidí jen to, že a kolik ti přišlo, ne obsah zprávy ani tvůj klíč.":
    "Our own server (not a third party) occasionally peeks into your Ark mailbox for this — it only ever sees that a payment arrived and how much, never the message content or your key.",

  // UtilityHub.tsx — the tab switcher (Převodník / Mapa / Pokladna) and its
  // own Point-of-Sale panel. This whole section was missing until 2026-09-17
  // — every t() call here fell back to Czech regardless of language, and
  // the Pokladna tab label itself was hardcoded English ("Point of Sale")
  // instead of routed through t() at all.
  "Pokladna": "Point of Sale",
  "Mapa": "Map",
  "Zaplaceno": "Paid",
  "Čekám na platbu…": "Waiting for payment…",
  "Název položky": "Item name",
  "Cena ({symbol})": "Price ({symbol})",
  "Nová položka": "New item",
  "Zadej název položky.": "Enter an item name.",
  "Zadej platnou cenu.": "Enter a valid price.",
  "Smazat položku": "Delete item",
  "Ubrat kus": "Remove one",
  "Přidat položku": "Add item",
  "Smazat": "Delete",
  "Zaplatit": "Pay",
  "Uložit": "Save",
  "Upravit ceník": "Edit price list",
  "Ceník": "Price list",
  "Upravit": "Edit",
  "Ceník je prázdný. Přidej zboží, které prodáváš, a pak ho jen ťukáš.":
    "Your price list is empty. Add what you sell, then just tap it.",
  "Přidat položky": "Add items",
  "{count} ks na účtence": "{count} on the receipt",
  "+ Další částka": "+ Another amount",
  "Přidat kus": "Add one",
  "Odebrat z účtenky": "Remove from receipt",
  "Vymazat účtenku": "Clear receipt",
  "Účtovat {amount}": "Charge {amount}",
  "Účtovat": "Charge",
  "Faktura zkopírována": "Invoice copied",
  "Opravdu zrušit platbu?": "Really cancel the payment?",
  "Zrušit platbu": "Cancel payment",
  "Další zákazník": "Next customer",
  "Upravit položku": "Edit item",
  "Zatím žádné položky.": "No items yet.",
  "Účtenka": "Receipt",
  "Celkem": "Total",
  "Účtenka je prázdná. Ťukni na položku nebo zadej částku.": "The receipt is empty. Tap an item or enter an amount.",
  "Částku můžeš psát i na klávesnici, Enter účtuje.": "You can type the amount on your keyboard, Enter charges.",
  "Naskenuj a zaplať přes Lightning": "Scan and pay with Lightning",

  // BtcMapPanel.tsx — the "Mapa" tab (btcmap.org businesses).
  "Hledám polohu…": "Finding your location…",
  "Jste tady": "You are here",
  "Karta": "Card",
  "Lightning": "Lightning",
  "Najít podniky poblíž": "Find nearby businesses",
  "Nepodařilo se načíst podniky. Zkontroluj připojení.": "Couldn't load businesses. Check your connection.",
  "Poloha není v tomto prohlížeči podporována.": "Location isn't supported in this browser.",
  "Polohu se nepodařilo zjistit. Zkontroluj oprávnění v prohlížeči.":
    "Couldn't determine your location. Check the browser's permission.",
  "Přibližte mapu pro zobrazení podniků.": "Zoom in on the map to see businesses.",
  "Skrýt podniky": "Hide businesses",
  "V okolí nejsou v datech žádné podniky.": "There are no businesses in the data nearby.",
  "Zobrazit na btcmap.org": "View on btcmap.org",

  // Left over from the Bitrefill section; its own strings are archived in
  // archive/bitrefill/i18n.snippet.ts.
  "Doručeno": "Delivered",
  "Zadej platnou částku.": "Enter a valid amount.",
  "Nad limitem pro Lightning (max {limitSats} sats).":
    "Over the Lightning limit (max {limitSats} sats).",
  "Fakturu se nepodařilo vytvořit. Zkus to prosím znovu.": "Couldn't create the invoice. Please try again.",
  "Kurz měny není momentálně dostupný.": "The exchange rate isn't available right now.",

  // Bump-to-pay (src/lib/bump/bump.ts, src/components/BumpOverlay.tsx) — beta,
  // gated behind the v2 toggle + its own Settings switch. Passive: no
  // button, so there's no "Přijmout ťuknutím"/"Zaplatit ťuknutím" entry
  // point string here — the overlay only ever appears once a tap already
  // happened.
  "Platby ťuknutím (beta)": "Tap-to-pay (beta)",
  "Potlačit maintenance": "Suppress maintenance",
  // Settings → Záznamník ťuknutí (BumpRecorderPage.tsx)
  "Záznamník ťuknutí": "Tap recorder",
  "Nastavení zpráv": "Message settings",
  "Ťuknutí bočními hranami": "Tap with side edges",
  "Ťuknutí horními hranami": "Tap with top edges",
  "Jemné ťuknutí": "Gentle tap",
  "Ťuknutí jinak (popiš v poznámce)": "Other kind of tap (describe in note)",
  "Zvednutí obou telefonů ze stolu": "Picking both phones up from a table",
  "Položení na stůl": "Putting down on a table",
  "Ťuknutí o stůl (telefony leží)": "Knocking the table (phones lying on it)",
  "Mávání telefonem": "Waving the phone",
  "Oba telefony v jedné ruce": "Both phones in one hand",
  "Chůze, kapsa, taška": "Walking, pocket, bag",
  "Běžné ovládání displeje": "Normal screen use",
  "Jiné (popiš v poznámce)": "Other (describe in note)",
  "silných": "strong",
  "slabých": "weak",
  "Ťukej v klidném tempu, mezi ťuknutími vždy aspoň vteřinu počkej.": "Tap at a calm pace, waiting at least a second between taps.",
  "Opakuj pohyb v klidném tempu, klidně i víckrát za sebou.": "Repeat the movement at a calm pace, several times in a row is fine.",
  "Vzorkování": "Sample rate",
  "Zrychlení bez gravitace": "Linear acceleration",
  "Gyroskop": "Gyroscope",
  "Kompas": "Compass",
  "{sent} částí, {pending} čeká": "{sent} parts, {pending} waiting",
  "ano": "yes",
  "ne": "no",
  "Záznam odeslán": "Recording sent",
  "Část záznamu se nepodařilo odeslat": "Part of the recording couldn't be sent",
  "{gesture}: detektor zachytil {hard} silných a {soft} slabých.": "{gesture}: the detector caught {hard} strong and {soft} weak.",
  "Kolikrát jsi to doopravdy udělal?": "How many times did you actually do it?",
  "Nejcennější údaj: podle něj poznám, kolik skutečných ťuknutí detektor minul nebo si přimyslel.": "The most valuable number: it shows how many real taps the detector missed or imagined.",
  "Ukládám…": "Saving…",
  "Nepodařilo se uložit, zkus to znovu.": "Couldn't save, try again.",
  "Nahrát další": "Record another",
  "Pomoz naladit rozpoznávání ťuknutí. Záznamník nahrává jen data z pohybových senzorů, nic z peněženky. Nahrávej vždy na obou telefonech současně.": "Help tune tap detection. The recorder captures motion sensor data only, nothing from the wallet. Always record on both phones at once.",
  "Tento telefon": "This phone",
  "Název, třeba iPhone 13": "Name, e.g. iPhone 13",
  "Telefon je v obalu": "The phone is in a case",
  "Co budeš dělat": "What you'll do",
  "Poznámka (nepovinné)": "Note (optional)",
  "Třeba: druhý telefon leží na stole": "E.g.: the other phone is lying on the table",
  "Spusť nahrávání na obou telefonech, pak ťukni 10 až 20krát. Nakonec zadej, kolikrát jsi ťukl.": "Start recording on both phones, then tap 10 to 20 times. At the end, enter how many times you tapped.",
  "Spusť nahrávání na obou telefonech, pak pohyb 10 až 20krát zopakuj. Nakonec zadej, kolikrát.": "Start recording on both phones, then repeat the movement 10 to 20 times. At the end, enter how many times.",
  "Začít nahrávat": "Start recording",
  "Senzory pohybu se nepodařilo povolit.": "Couldn't enable motion sensors.",
  "Příliš mnoho pokusů, zkus to za chvíli znovu.": "Too many attempts, try again in a moment.",
  "Spojeno": "Connected",
  "Svítí na druhém telefonu stejné symboly?": "Does the other phone show the same symbols?",
  "Platím": "I'm paying",
  "Přijímám": "I'm receiving",
  "Symboly nesedí": "Symbols don't match",
  "Platíš": "You're paying",
  "Přijímáš": "You're receiving",
  "Zůstatek {amount} sats": "Balance {amount} sats",
  "Nedostatek prostředků": "Insufficient funds",
  "Nedostatek prostředků.": "Insufficient funds.",
  "Platbu se nepodařilo odeslat.": "The payment couldn't be sent.",
  "Nepodařilo se spojit s druhým telefonem. Zkus to znovu.": "Couldn't reach the other phone. Try again.",
  "Čekám na potvrzení od příjemce": "Waiting for the recipient to confirm",
  "Příjemce potvrdil přijetí.": "The recipient confirmed it arrived.",
  "Příjemce zatím nepotvrdil přijetí. Platba se objeví v historii.": "The recipient hasn't confirmed yet. The payment will show up in your history.",
  "Nevíme jistě, jestli platba prošla": "We can't be sure the payment went through",
  "Než to zkusíš znovu, zkontroluj prosím historii.": "Please check your history before trying again.",
  "Druhý telefon zadává částku": "The other phone is entering an amount",
  "Druhý telefon neodpovídá": "The other phone isn't responding",
  "Přichází": "Incoming",
  "Platba je na cestě": "The payment is on its way",
  "Objeví se v historii, jakmile dorazí.": "It will show up in your history once it arrives.",
  "Druhá strana platbu zrušila": "The other side cancelled the payment",
  "Nejednoznačné": "Ambiguous",
  "Síť nestíhá": "Network too slow",
  "Ťuknutí dorazilo pozdě. Zkus to znovu.": "The tap arrived too late. Try again.",
  "Poblíž ťuklo víc telefonů najednou. Zkus to znovu.": "Several phones tapped nearby at once. Try again.",
  "Druhý telefon se nenašel": "Couldn't find the other phone",
  "Vypršel čas na výběr": "Time to choose ran out",
  "Platba vypršela": "The payment timed out",
  "Ťukněte telefony o sebe znovu.": "Tap the phones together again.",
  "Něco se pokazilo": "Something went wrong",
  "Spojit s telefonem poblíž?": "Connect with a phone nearby?",
  "Telefon poblíž ti posílá platbu": "A phone nearby is sending you a payment",
  "Telefon poblíž od tebe čeká platbu": "A phone nearby is waiting for your payment",
  "Spojení s druhým telefonem se přerušilo.": "Lost the connection to the other phone.",
  "Tuto platbu je potřeba potvrdit heslem.": "This payment needs to be confirmed with your password.",
  "Ověření spojení selhalo. Ťukněte telefony o sebe znovu.": "Couldn't verify the connection. Tap the phones together again.",
  "Příjemce hlásí přijetí": "The recipient reports it arrived",
  "Tahle peněženka ale platbu nepotvrdila. Než zaplatíš znovu, zkontroluj historii.":
    "But this wallet didn't confirm the payment. Check your history before paying again.",
  // Gift links: the claim/compose screens' new shared-sheet wording
  "Dárek je připravený": "Your gift is ready",
  "Kdo odkaz otevře, ten si dárek vyzvedne. Posílej ho jen komu věříš.":
    "Whoever opens the link claims the gift. Only send it to someone you trust.",
  "Dárek se nepodařilo vytvořit": "The gift couldn't be created",
  "Tenhle dárek už je vyzvednutý": "This gift has already been claimed",
  "Dárek se nepodařilo vyzvednout": "The gift couldn't be claimed",
  "Je tvůj": "It's yours",
  "Připisuju dárek do peněženky": "Adding the gift to your wallet",

  // The Home buttons' hold-menus (ActionMenu.tsx)
  "Odkaz, který si příjemce vyzvedne": "A link the recipient claims",
  "Odkaz s částkou, stačí zaplatit": "A link with the amount, ready to pay",
  "Podrž tlačítko a objeví se víc možností.": "Hold the button for more options.",

  // Payment requests: the asking side (PaymentRequestModal.tsx)
  "Požadavek k platbě": "Payment request",
  "Kolik chceš, aby ti poslali": "How much you're asking for",
  "Za co? (nepovinné)": "What for? (optional)",
  "Připravuju odkaz…": "Preparing the link…",
  "Požadavek je připravený": "Your request is ready",
  "Požadavek k platbě vytvořen": "Payment request created",
  "Odkaz se nepodařilo vytvořit": "The link couldn't be created",
  "Pošli mi prosím bitcoin": "Please send me some bitcoin",
  "pošli mi prosím bitcoin": "please send me some bitcoin",
  "Komu odkaz pošleš, tomu se všechno předvyplní. Bez Spendrru zaplatí Lightning fakturou.":
    "Whoever you send the link to gets everything filled in. Without Spendrr they can pay the Lightning invoice.",
  "Komu odkaz pošleš, tomu se všechno předvyplní. Lightning fakturu se teď nepodařilo vytvořit, takže odkaz zaplatí jen Spendrr.":
    "Whoever you send the link to gets everything filled in. The Lightning invoice couldn't be created just now, so only Spendrr can pay this link.",
  "Vytvoření Lightning faktury trvalo příliš dlouho.": "Creating the Lightning invoice took too long.",
  "Zatím nemáme tvoji adresu ani Lightning fakturu. Zkus to za chvíli znovu.":
    "We have neither your address nor a Lightning invoice yet. Try again in a moment.",

  // Payment requests: the paying side (PaymentRequestPage.tsx)
  "Žádost o platbu": "Payment request",
  "Odemknout a zaplatit": "Unlock and pay",
  "Nejdřív odemkni peněženku, pak se platba předvyplní sama.":
    "Unlock your wallet first and the payment fills itself in.",
  "Tenhle odkaz umí Spendrr zaplatit na jedno ťuknutí. Nemáš ho? Zaplať Lightningem níž.":
    "Spendrr pays this link in one tap. Don't have it? Pay with Lightning below.",
  "Tenhle požadavek jde zaplatit jen Lightningem.": "This request can only be paid with Lightning.",
  "Zaplatit Lightningem": "Pay with Lightning",
  "faktura vypršela": "invoice expired",
  "Otevřít v Lightning peněžence": "Open in a Lightning wallet",
  "Otevřít": "Open",
  "Požádej o nový odkaz, nebo zaplať ve Spendrru. Adresa nad ní platí dál.":
    "Ask for a new link, or pay in Spendrr. The address above still works.",
  "Požádej o nový odkaz.": "Ask for a new link.",
  "Teď ne": "Not now",

  // Profile sheet (ProfileSheet.tsx) and paying a @handle (Dashboard SendPanel), beta
  "Profil": "Profile",
  "Zatím nemáme tvoji adresu. Zkus to za chvíli znovu.": "We don't have your address yet. Try again in a moment.",
  "Změnit jméno": "Change name",
  "Uložit jméno": "Save name",
  "Napiš jméno.": "Enter a name.",
  "Jméno má mít aspoň 3 znaky.": "The name needs at least 3 characters.",
  "Jméno může mít nejvýš 20 znaků.": "The name can be at most 20 characters.",
  "Použij jen malá písmena bez diakritiky, čísla, _ a -.": "Use only lowercase letters without accents, digits, _ and -.",
  "Jméno nesmí začínat ani končit znakem _ nebo -.": "The name can't start or end with _ or -.",
  "Tohle jméno je vyhrazené.": "This name is reserved.",
  "3 až 20 znaků: malá písmena, čísla, _ a -. Bez diakritiky.": "3 to 20 characters: lowercase letters, digits, _ and -. No accents.",
  "Pošli mi bitcoin ve Spendrru": "Send me bitcoin on Spendrr",
  "Tohle jméno už má někdo jiný.": "Someone else already has this name.",
  "Tohle jméno se teď nedá použít. Zkus jiné.": "This name can't be used right now. Try another.",
  "Jméno jsi měnil/a příliš často. Zkus to později, limit je 5 změn za 30 dní.":
    "You've changed your name too often. Try later, the limit is 5 changes per 30 days.",
  "Moc požadavků najednou. Zkus to za chvíli.": "Too many requests at once. Try again shortly.",
  "Neplatné jméno.": "Invalid name.",
  "Adresa peněženky není platná.": "The wallet address isn't valid.",
  "Server neuznal ověření peněženky. Zkus to za chvíli znovu.": "The server didn't accept the wallet's proof. Try again shortly.",
  "Server nedostupný": "Server unavailable",
  "Nepodařilo se najít volné jméno. Zvol si vlastní.": "Couldn't find a free name. Pick your own.",
  "Odebrat jméno?": "Remove name?",
  "Odebrat jméno": "Remove name",
  "Odebírám…": "Removing…",
  "Lidé ti přes @jméno přestanou moct platit. Jméno se 30 dní nikomu jinému nepřidělí a ty si ho můžeš vzít zpět.":
    "People will no longer be able to pay you via @name. The name won't go to anyone else for 30 days and you can take it back.",
  "Jméno je volné.": "The name is free.",
  "Tohle jméno už máš.": "You already have this name.",
  "Tohle jméno se teď nedá použít.": "This name can't be used right now.",
  "Dostupnost neověřena": "Availability not checked",
  "Jméno je veřejné. Staré jméno se 30 dní nikomu jinému nepřidělí a platby na něj přestanou fungovat.":
    "The name is public. Your old name won't go to anyone else for 30 days and payments to it will stop working.",
  "Jméno se nepodařilo načíst. Zkontroluj připojení a zkus to znovu.":
    "Couldn't load your name. Check your connection and try again.",
  "Zatím nemáš jméno": "You don't have a name yet",
  "S veřejným @jménem ti kdokoli ve Spendrru pošle platbu, aniž by potřeboval tvoji adresu.":
    "With a public @name anyone on Spendrr can pay you without needing your address.",
  "Zaregistrovat": "Register",
  "Registruji…": "Registering…",
  "Vybrat vlastní jméno": "Pick your own name",
  "Jméno ukazuje na jinou adresu, než má tahle peněženka. Lidé by ti platili jinam.":
    "The name points to a different address than this wallet has. People would pay you elsewhere.",
  "Opravit adresu": "Fix address",
  "Ověřuji jméno, chvíli počkej.": "Checking the name, one moment.",
  "Ověřuji jméno…": "Checking name…",
  "Dříve placená jména": "Names you paid before",
  "Tvoje adresa": "Your address",
  "Zapnout Lightning adresu": "Turn on Lightning address",
  "Ve Spendrru stačí napsat": "In Spendrr, just type",
  "Pošli mi bitcoin na": "Send me bitcoin at",
  "ve Spendrru stačí": "in Spendrr just",
  "S Lightning adresou ti může poslat bitcoin kdokoli, z jakékoli peněženky.":
    "With a Lightning address, anyone can send you bitcoin from any wallet.",
  "Aby ti mohl poslat bitcoin kdokoli, i bez Spendrru.": "So anyone can send you bitcoin, even without Spendrr.",
  "Zapnout Lightning adresu?": "Turn on Lightning address?",
  "Platby procházejí službou Spendrr. Vidí výši, utratit je nemůže.":
    "Payments go through the Spendrr service. It sees the amount, it cannot spend it.",
  "Zůstatek: velká čísla": "Balance: large numbers",
  "Velký zůstatek se vejde na displej i s jednotkou.": "A large balance fits the screen with its unit.",
  "Automatická obnova mincí": "Automatic coin refresh",
  "Mince se obnovují samy, včas a co nejlevněji.": "Your coins refresh on their own, on time and as cheaply as possible.",
  "Bezplatné obnovy už nezaplňují historii plateb.": "Free refreshes no longer clutter your payment history.",
  "Odemknutí tě občas přivítá pozdravem.": "Unlocking sometimes greets you.",
  "Jemnější vzhled": "A softer look",
  "Otevřený zdrojový kód": "Open source",
  "Zdrojový kód peněženky je teď veřejný, odkaz najdeš v Nastavení.": "The wallet's source code is now public, with a link in Settings.",
  "Kdokoli si může ověřit, že web běží přesně tento kód.": "Anyone can check that the site runs exactly this code.",
  "Nové potvrzení platby": "New payment confirmation",
  "Potvrzení platby je přehlednější, s velkou částkou a příjemcem.": "The payment confirmation is clearer, with a large amount and the recipient.",
  "U Lightning adresy vidíš před odesláním, komu platíš.": "For a Lightning address you see who you are paying before you send.",
  "Odeslání: částka z faktury": "Send: amount from invoice",
  "Faktura s částkou ti vyplní pole částky sama.": "An invoice with an amount fills the amount field for you.",
  "Skener přečte QR kód i z obrázku v galerii.": "The scanner also reads a QR code from a gallery image.",
  "Tlačítka, pole a přepínače mají lehčí obrys, okna jsou bez rozmazání.": "Buttons, fields and switches have a lighter outline, and sheets no longer blur the page.",
  "Dárky: přehled a heslo": "Gifts: overview and password",
  "Dárek jde po odeslání hned zrušit a seznam ukazuje skutečný stav.": "A gift can be cancelled right after sending and the list shows its real status.",
  "Příjemce dárku si heslo nastaví až při dalším otevření.": "A gift recipient sets a password at the next open.",
  "Vzhled: jemnější prvky": "Look: softer elements",
  "Tlačítka, pole a přepínače mají lehčí obrys.": "Buttons, fields and switches have a lighter outline.",
  "Zaostřené pole je na první pohled poznat.": "A focused field is easy to spot.",
  "Profil: čistší vzhled": "Profile: cleaner look",
  "Tvoje adresa je v profilu větší a bez zbytečností.": "Your address is bigger in the profile, with less clutter.",
  "Zapnutí Lightning adresy se zeptá hned pod adresou.": "Turning on the Lightning address asks right under the address.",
  "Zapnout": "Turn on",
  "Zaplatit můžeš z jakékoli Lightning peněženky.": "You can pay from any Lightning wallet.",
  "Platíš z Ark peněženky? Ukázat Ark adresu": "Paying from an Ark wallet? Show Ark address",
  "Tohle jméno ukazuje na neplatnou adresu. Platbu jsem zastavil.":
    "This name points to an invalid address. I stopped the payment.",
  "Jméno se nepodařilo ověřit. Zkus to za chvíli znovu.": "Couldn't verify the name. Try again shortly.",
  "Takové jméno nikdo nemá. Zkontroluj překlepy.": "Nobody has that name. Check for typos.",
  "Adresa u tohoto jména je jiná než při tvé poslední platbě. Než pošleš, ověř s příjemcem, že si ji opravdu změnil/a.":
    "The address behind this name differs from your last payment. Before you send, check with the recipient that they really changed it.",
  "Platit můžeš ze Spendrru nebo z jiné Ark peněženky.": "You can pay from Spendrr or another Ark wallet.",
  "Lightning tahle adresa zatím neumí.": "This address doesn't support Lightning yet.",
  "Kopírování selhalo. Označ adresu a zkopíruj ji ručně.": "Copying failed. Select the address and copy it by hand.",
  "Čas na tomhle zařízení se liší od skutečného. Zapni v nastavení telefonu automatický čas a zkus to znovu.":
    "This device's clock is off. Turn on automatic time in your phone's settings and try again.",
  "Zkopírovat chybu": "Copy error",
  "Peněženka neodpovídá. Zkus to za chvíli znovu.": "The wallet isn't responding. Try again in a moment.",
  "On-chain prostředky ještě nemají dost potvrzení. Zkus to později.": "Your on-chain funds don't have enough confirmations yet. Try again later.",
  "Nemáš dost prostředků (včetně poplatku).": "Not enough funds (including the fee).",
  "Poplatek by byl vyšší než samotná částka.": "The fee would be higher than the amount itself.",
  "Částka je příliš malá.": "The amount is too small.",
  "Tahle faktura už je zaplacená.": "This invoice has already been paid.",
  "Platba téhle faktury už probíhá. Počkej na výsledek v historii.": "A payment of this invoice is already in progress. Watch the history for the result.",
  "Faktura je na 0 sats, takovou zaplatit nejde.": "The invoice is for 0 sats and can't be paid.",
  "Faktura už vypršela. Požádej o novou.": "The invoice has expired. Ask for a new one.",
  "Částka nesedí s částkou ve faktuře.": "The amount doesn't match the invoice.",
  "Adresa nebo faktura je pro jinou bitcoinovou síť.": "The address or invoice is for a different Bitcoin network.",
  "Tahle Ark adresa patří k jinému Ark serveru.": "This Ark address belongs to a different Ark server.",
  "Neplatná Lightning adresa.": "Invalid Lightning address.",
  "Neplatný LNURL odkaz.": "Invalid LNURL link.",
  "Neplatná faktura. Zkontroluj, že je celá.": "Invalid invoice. Check that it's complete.",
  "Některé tvoje mince (VTXO) nejsou aktuální. Počkej chvíli, až se data obnoví, a zkus to znovu.": "Some of your coins (VTXOs) are out of date. Wait for the data to refresh and try again.",
  "Lightning platbu se nepodařilo doručit. Zkus to později nebo s menší částkou.": "The Lightning payment couldn't be delivered. Try again later or with a smaller amount.",
  "Aplikace je zastaralá. Obnov stránku.": "The app is out of date. Reload the page.",
  "Nepodařilo se připojit. Zkontroluj internet a zkus to znovu.": "Couldn't connect. Check your internet and try again.",
  "Jsi offline": "You're offline",
  "Jsi zase online": "You're back online",
  "Server Arku neodpovídá": "The Ark server isn't responding",
  "Platby se můžou zdržet.": "Payments may be delayed.",
  "Server zase odpovídá": "The server is responding again",
  "Zůstatek se obnoví, až se připojíš.": "Your balance will update once you reconnect.",
  "Obnovuji zůstatek…": "Updating balance…",
  "Jsi offline. Dárek vytvoříš, až se připojíš.": "You're offline. You can create the gift once you reconnect.",
  "Jsi offline. Dárek vrátíš, až se připojíš.": "You're offline. You can take the gift back once you reconnect.",
  "Jsi offline. Platbu pošleš, až se připojíš.": "You're offline. You can send once you reconnect.",
  "Tahle peněženka nemůže registrovat jména.":
    "This wallet can't register names.",

  // Add to Home Screen sheet (InstallAppSheet.tsx) and Settings → Peněženka →
  // Trvalé úložiště, beta
  "Přidej si Spendrr na plochu": "Add Spendrr to your Home Screen",
  "iOS maže data webů, které týden neotevřeš. Appka na ploše tohle omezení nemá, tak si peněženku založ rovnou v ní.":
    "iOS deletes the data of websites you don't open for a week. The Home Screen app doesn't have this limit, so create your wallet right there.",
  "iOS maže data webů, které týden neotevřeš, a s nimi i tuhle peněženku. Appka na ploše tohle omezení nemá.":
    "iOS deletes the data of websites you don't open for a week, and this wallet with it. The Home Screen app doesn't have this limit.",
  "Klepni na Sdílet": "Tap Share",
  "V Safari dole, případně pod •••": "At the bottom of Safari, or under •••",
  "V Safari nahoře, případně pod •••": "At the top of Safari, or under •••",
  "Vyber Přidat na plochu": "Choose Add to Home Screen",
  "Když ji nevidíš, sjeď v nabídce níž": "If you can't see it, scroll down the menu",
  "Otevři Spendrr z plochy": "Open Spendrr from your Home Screen",
  "Peněženku si založ až tam": "Create your wallet there",
  "Tam zvol Mám seed phrase": "There, choose I have a seed phrase",
  "Přidat na plochu": "Add to Home Screen",
  "Appka na ploše má vlastní úložiště a začne prázdná. Peněženku v ní obnovíš seed phrase.":
    "The Home Screen app has its own storage and starts empty. You restore your wallet in it with your seed phrase.",
  "Appka na ploše začne prázdná a peněženku v ní obnovíš jen seed phrase. Tu ještě nemáš zálohovanou.":
    "The Home Screen app starts empty and you can only restore your wallet in it with your seed phrase, which you haven't backed up yet.",
  "Zobrazit seed": "Show seed",
  "Pokračovat v prohlížeči": "Continue in browser",
  "Nepřipomínat": "Don't remind me",
  "Trvalé úložiště": "Persistent storage",
  "vypnuto": "off",
  "nepodporováno": "not supported",
  "Přidat appku na plochu": "Add the app to your Home Screen",
  "V prohlížeči iOS smaže data webu, který týden neotevřeš.":
    "In the browser, iOS deletes the data of a website you don't open for a week.",
  "Požádat o trvalé úložiště": "Request persistent storage",
  "Prohlížeč zatím nevyhověl. Pomůže nainstalovat appku nebo zapnout oznámení o platbách.":
    "The browser hasn't granted it yet. Installing the app or turning on payment notifications helps.",
  "Bez něj může prohlížeč data peněženky smazat, když v zařízení dojde místo.":
    "Without it, the browser may delete the wallet's data when the device runs out of space.",

  // changelog.ts — WhatsNewModal / Settings → O peněžence → Zobrazit changelog.
  // Every title/item string used there needs an entry here; the changelog's
  // own header comment ("keep it short, permanently") is what keeps this
  // list from becoming its own maintenance burden.
  "Automatická obnova mincí zapnutá (beta)": "Automatic coin refresh switched on (beta)",
  "V betě obnovuje mince vlastní engine, přehled a deník jsou v Nastavení.": "In the beta our own engine refreshes coins; overview and log are in Settings.",
  "Přehlednější obrazovka VTXO mince, detail a deník v samostatných oknech.": "A clearer VTXO coins screen, with details and log in their own sheets.",
  "Bezpečnější nouzový exit": "Safer emergency exit",
  "Exit posílá transakce přes nezávislý uzel, ne přes servery Arku.": "The exit sends its transactions through an independent node, not Ark's servers.",
  "Přesun on-chain do zůstatku ukáže i poplatek síti.": "Moving on-chain money into your balance also shows the network fee.",
  "Drobné opravy": "Small fixes",
  "Po zavření detailu platby zůstane historie na stejném místě.": "Closing a payment detail keeps the history at the same spot.",
  "Skener QR ztmaví celou obrazovku najednou, včetně tlačítek nahoře.": "The QR scanner dims the whole screen at once, the buttons at the top included.",
  "Zatřesení pro skrytí zůstatku reaguje o trochu snáz.": "Shake to hide the balance triggers a little more easily.",
  "Klepnutí bez označování textu": "Taps no longer select text",
  "Klepnutí na logo nebo zůstatek už v některých prohlížečích neoznačí text a nenabídne kopírování.": "Tapping the logo or the balance no longer selects text and offers to copy it in some browsers.",
  "Nový detail platby (beta)": "New payment detail (beta)",
  "Detail platby v historii má nové okno s velkou částkou.": "Payment details in the history open in a new window with a big amount.",
  "Přepočet na měnu je z doby platby, u jména je i avatar.": "The fiat value is from the time of the payment; names show their avatar.",
  "Přesnější detail platby": "More accurate payment details",
  "On-chain platba je potvrzená, až když ji appka opravdu vidí v bloku.": "An on-chain payment shows as confirmed only once the app sees it in a block.",
  "Jméno příjemce se už nepřiřadí k cizí platbě se stejnou částkou.": "A recipient's name no longer attaches to someone else's payment of the same amount.",
  "Nové ikonky v historii (beta)": "New history icons (beta)",
  "Přijaté a odeslané platby mají výraznější barevné ikonky.": "Received and sent payments have bolder coloured icons.",
  "Nové poplatky v síti (beta)": "New network fees (beta)",
  "Poplatky v Nastavení teď vypadají jako bloky na mempool.space.": "Fees in Settings now look like blocks on mempool.space.",
  "Uvidíš poslední vytěžený blok i cenu běžné platby.": "You'll see the last mined block and the cost of a typical payment.",
  "Nový skener QR kódů (beta)": "New QR scanner (beta)",
  "Skener vypadá stejně jako ostatní okna v appce.": "The scanner now looks like the rest of the app's windows.",
  "Ve tmě poradí, že blesk rozsvítíš dvojitým klepnutím.": "In the dark it tells you to double-tap for the flash.",
  "Automatická obnova mincí (beta)": "Automatic coin refresh (beta)",
  "V Nastavení → VTXO mince uvidíš plán, průběh i deník obnov.":
    "Settings → VTXO coins shows the plan, progress and a refresh log.",
  "Spolehlivější oznámení o platbách": "More reliable payment notifications",
  "Přijatá platba se oznámí, i když zároveň běží obnova mincí.":
    "A received payment is announced even while coin refresh is running.",
  "Nová tlačítka na úvodní obrazovce": "New buttons on the home screen",
  "Přijmout a Odeslat tvoří jednu lištu, skener QR kódů je uprostřed.":
    "Receive and Send now form one bar, with the QR scanner in the middle.",
  "Obnova mincí bez odhlašování": "Coin refresh without getting logged out",
  "Mince před vypršením se obnoví na pozadí, stačí appku jednou otevřít.":
    "Coins near expiry now refresh in the background, just open the app once.",
  "Appka tě kvůli čekání na obnovu už po minutě neodhlásí.":
    "The app no longer logs you out after a minute of waiting for a refresh.",
  "Motion design (beta)": "Motion design (beta)",
  "Přechody mezi obrazovkami: tlačítko, na které klepneš, se promění v to, co otevírá.":
    "Screen transitions: the button you tap morphs into what it opens.",
  "Tlačítko pro potvrzení platby se před odesláním plní barvou a během odesílání přes něj přejíždí odlesk. Po odeslání tě appka vrátí domů.":
    "The confirm button fills with colour before sending and gets a sheen while sending. After sending, the app takes you home.",
  "Když přijde platba na obrazovce Přijmout, QR kód se rozplyne a appka tě vrátí domů.":
    "When a payment arrives on the Receive screen, the QR code dissolves and the app takes you home.",
  "Rámeček skeneru se přicvakne na nalezený kód.": "The scanner frame snaps onto the code it found.",
  "Chybová hláška se zatřese, řádky aktivity naskočí postupně.":
    "Error messages now shake, and activity rows stagger in.",
  "Vypneš to v Nastavení → Vzhled → Motion design.":
    "Turn it off in Settings → Appearance → Motion design.",
  "Pokladna pro tablet a počítač (beta)": "Point of Sale for tablet and computer (beta)",
  "Na velké obrazovce je účtenka vedle ceníku a QR kód je větší.":
    "On a large screen the receipt sits beside the price list and the QR code is bigger.",
  "Klávesa C smaže celý nákup, částku napíšeš i na klávesnici.":
    "The C key clears the whole purchase, and you can type the amount on a keyboard too.",
  "Přesnější skrytí zůstatku zatřesením": "More precise shake-to-hide balance",
  "Zůstatek se už neskryje po položení telefonu nebo jednom mávnutí.":
    "The balance no longer hides when you put the phone down or wave it once.",
  "Nová ikona": "New icon",
  "Spendrr má novou ikonu: „s.“ s fialovou tečkou.": "Spendrr has a new icon: an “s.” with a purple dot.",
  "Ikona v prohlížeči se přizpůsobí světlému i tmavému režimu.":
    "The browser icon now adapts to light and dark mode.",
  "Peněženka jen v jednom okně (beta)": "One window at a time (beta)",
  "Odemknout jde jen v jednom okně nebo aplikaci najednou.":
    "Unlocking is only possible in one window or app at a time.",
  "Druhé okno napíše, že je peněženka otevřená jinde.":
    "A second window is told the wallet is already open elsewhere.",
  "Dárek a odemykání otiskem": "Gifts and fingerprint unlock",
  "Heslo k peněžence z dárku je kratší a snáz se opisuje.":
    "A gift wallet's password is now shorter and easier to copy by hand.",
  "Odemykání otiskem se zkouší i tam, kde dřív hlásilo nepodporu.":
    "Fingerprint unlock is now tried in more places that used to report it unsupported.",
  "Jména: rychlejší a s profilovkou (beta)": "Names: faster and with an avatar (beta)",
  "Jméno v poli Odeslat se najde hned a nabízí dříve placené.":
    "A name in the Send field resolves instantly and suggests ones you've paid before.",
  "Odkaz na profil ukáže v chatu tvoji profilovku místo loga.":
    "A profile link now shows your avatar in chat previews instead of the logo.",
  "Lightning adresa k @jménu (beta)": "Lightning address for your @name (beta)",
  "V profilu jde zapnout jmeno@spendrr.app, platí i peněženky bez Ark.":
    "Your profile can turn on name@spendrr.app, which any wallet without Ark can pay too.",
  "Platbu přeposílá Spendrr, sám ji nemůže utratit ani přesměrovat.":
    "Spendrr just forwards the payment, it can't spend or redirect it itself.",
  "Rychlejší skenování QR na Androidu": "Faster QR scanning on Android",
  "Čtečka QR kódů teď na Androidu využívá rychlejší vestavěný modul.":
    "The QR scanner now uses a faster built-in module on Android.",
  "Mince, kterou nejde obnovit, uvidíš přímo pod zůstatkem.":
    "A coin that cannot be refreshed shows right under the balance.",
  "Převodník v Utility (beta)": "Converter in Utility (beta)",
  "Převodník měn je nově první záložka v Utility.": "The currency converter is now the first tab in Utility.",
  "Trojklik na logo už nic nedělá, Bitrefill z Utility zmizel.":
    "Triple-clicking the logo no longer does anything, and Bitrefill is gone from Utility.",
  "Spolehlivější poznání výpadku sítě (beta)": "Better detection of network outages (beta)",
  "Appka pozná i Wi-Fi bez internetu, nejen vypnutou Wi-Fi.":
    "The app now notices Wi-Fi without internet, not just Wi-Fi turned off.",
  "Když neodpovídá server Arku, řekne to a neodhlásí tě.":
    "When the Ark server isn't responding, it says so and keeps you logged in.",
  "Dárkové odkazy a bezpečnější úložiště pro všechny": "Gift links and safer storage for everyone",
  "Podržením Odeslat pošleš bitcoin jako dárkový odkaz.": "Hold Send to send bitcoin as a gift link.",
  "Peněženka je otevřená vždy jen v jedné kartě prohlížeče.": "The wallet is only ever open in one browser tab.",
  "Požadavek k platbě a offline režim pro všechny": "Payment requests and offline mode for everyone",
  "Bez internetu tě appka neodhlásí, počká na připojení.":
    "Without internet the app no longer logs you out, it waits to reconnect.",
  "Pokladna (beta): celá na jedné obrazovce": "Point of Sale (beta): all on one screen",
  "Nahoře vždy celková částka, tlačítko Účtovat vždy na očích.":
    "The full total always on top, the Charge button always in view.",
  "Zákazník vidí jen QR kód, po zaplacení velkou fajfku.":
    "The customer sees only the QR code, then a big tick once paid.",
  "Odolnější jména a platba ťuknutím": "More resilient names and tap-to-pay",
  "Registrace jmen má denní strop proti hromadnému zabírání.":
    "Registering names now has a daily cap against mass squatting.",
  "Zdroj rušící cizí ťuknutí se dočasně zablokuje.":
    "A source repeatedly canceling others' taps gets temporarily blocked.",
  "Historie ukazuje @jméno příjemce": "History shows the recipient's @name",
  "Platba na @jméno teď v historii ukáže jméno příjemce.":
    "A payment to @name now shows the recipient's name in history.",
  "Odkaz na profil: spendrr.app/@jméno": "Profile link: spendrr.app/@name",
  "Odkaz na @jméno otevře profil s adresou a QR kódem.":
    "An @name link opens a profile with the address and a QR code.",
  "Ve Spendrru zaplatíš klepnutím, jinde adresu zkopíruješ.":
    "Pay with one tap in Spendrr, or copy the address elsewhere.",
  "Jména @ (beta): registrace a platba na @jméno": "Names @ (beta): register and pay by @name",
  "V profilu si zaregistruješ veřejné jméno, třeba @pavel.":
    "Register a public name in your profile, like @pavel.",
  "Platbu pak pošleš na jméno místo dlouhé adresy.":
    "Send payments to the name instead of a long address.",
  "Nové (beta): požadavek k platbě a přepracované dárky":
    "New (beta): payment requests and redesigned gifts",
  "Podržením Přijmout vytvoříš odkaz s požadavkem na platbu.":
    "Hold down Receive to create a payment-request link.",
  "Dárky a požadavky mají nové, plynulejší okno.":
    "Gifts and requests now use a smoother new window.",
  "Nová obrazovka odemčení pro všechny": "New unlock screen for everyone",
  "Plynulý zámek, odhalení hesla ikonou oka, odemčení otiskem.":
    "A smooth lock, a password reveal icon, fingerprint unlock.",
  "Log peněženky pro všechny": "Wallet log for everyone",
  "Log peněženky v Nastavení pomáhá dohledat zaseklou platbu.":
    "The wallet log in Settings helps trace a stuck payment.",
  "Nové (beta): platba ťuknutím telefonů o sebe": "New (beta): pay by tapping phones together",
  "Ťukni telefony o sebe a zaplať bez zadávání adresy.":
    "Tap two phones together and pay with no address needed.",
  "Zatím spolehlivě funguje jen na některých telefonech.":
    "Still only reliable on some phones for now.",
  "Bezpečnost: zpřísněné ověření push notifikací": "Security: stricter push notification checks",
  "Zapnutí upozornění teď ověří schránku přímo u Ark serveru.":
    "Turning on notifications now verifies the mailbox with the Ark server.",
  "Bezpečnost: odkazy a obrázky u voucherů": "Security: voucher links and images",
  "Odkazy a obrázky voucherů mají přísnější kontrolu proti zneužití.":
    "Voucher links and images now have stricter abuse checks.",
  "Bezpečnost: dárkový odkaz mizí z adresního řádku okamžitě":
    "Security: gift link clears from the address bar instantly",
  "Dárkový odkaz mizí z historie prohlížeče hned po otevření.":
    "A gift link now clears from browser history right after opening.",
  "Bezpečnost: zúžena síťová výjimka pro Lightning adresu/LNURL":
    "Security: narrowed network exception for Lightning address/LNURL",
  "Platba na Lightning adresu nebo LNURL komunikuje jen s příjemcem.":
    "Paying a Lightning address or LNURL now only talks to the recipient.",
  "Point of Sale: ceník položek a vylepšená klávesnice":
    "Point of Sale: item price list and improved keypad",
  "Pokladna má ceník: naťukej zboží místo psaní ceny.":
    "Point of Sale has a price list: tap items instead of typing a price.",
  "Kalkulačka umí sečíst víc položek do jedné faktury.":
    "The keypad can now add several items into one invoice.",
  "Nouzový přepínač: potlačit automatickou obnovu VTXO":
    "Emergency toggle: suppress automatic VTXO refresh",
  "Nastavení: nouzově lze potlačit automatickou obnovu VTXO.":
    "Settings: automatic VTXO refresh can be suppressed in an emergency.",
  "Oprava: výpadek Ark serveru blokoval Odeslat i VTXO mince":
    "Fix: an Ark server outage blocked Send and VTXO coins",
  "Výpadek Ark serveru už neblokuje Odeslat ani VTXO mince.":
    "An Ark server outage no longer blocks Send or VTXO coins.",
  "Beta: Utility hub — Point of Sale": "Beta: Utility hub — Point of Sale",
  "Nová Pokladna: zadej cenu, appka vytvoří fakturu a QR kód.":
    "New Point of Sale: enter a price, the app makes an invoice and QR code.",
  "Beta: Utility hub — mapa bitcoinových podniků (btcmap.org)":
    "Beta: Utility hub — map of bitcoin businesses (btcmap.org)",
  "Nová Mapa: bitcoinové podniky poblíž tebe.":
    "New Map: bitcoin-accepting businesses near you.",
  "Nová adresa: spendrr.app": "New address: spendrr.app",
  "Peněženka má nový název domény: spendrr.app.":
    "The wallet has a new domain name: spendrr.app.",
  "Beta: Utility hub — poukázky a dobití kreditu přes Bitrefill":
    "Beta: Utility hub — gift cards and top-ups via Bitrefill",
  "Nové: nákup poukázek a dobití kreditu přes Bitrefill.":
    "New: buy gift cards and phone top-ups via Bitrefill.",
  "Platíš přímo z peněženky přes Lightning.":
    "Pay directly from the wallet over Lightning.",
  "Oprava zálohy: nová peněženka mohla ztratit viditelnost prostředků":
    "Backup fix: a new wallet could lose visibility of funds",
  "Neúplná záloha po otevření nové peněženky opravena.":
    "An incomplete backup right after opening a new wallet was fixed.",
  "Bezpečnost: dárkové odkazy a záloha": "Security: gift links and backup",
  "Nevyzvednuté dárky se už nemažou předčasně i s penězi.":
    "Unclaimed gifts no longer get deleted early along with their funds.",
  "Nahrání zálohy teď server ověří proti souběžnému zápisu.":
    "The server now checks a backup upload against a concurrent write.",
  "Bezpečnostní audit: síťová ochrana, faktury a záloha":
    "Security audit: network protection, invoices and backup",
  "Uzavřena skulina v síťové ochraně u XHR a WebSocketu.":
    "Closed a gap in network protection around XHR and WebSocket.",
  "Opraveny chyby zálohy, dvojího odeslání a limitu startu appky.":
    "Fixed backup, double-send, and app-startup timeout bugs.",
  "Bezpečnost a spolehlivost zálohy": "Backup security and reliability",
  "Heslo dárkové peněženky se už neukládá čitelné napořád.":
    "A gift wallet's password no longer stays stored in the clear forever.",
  "Obnova ze zálohy teď spolehlivě obnoví i chybějící části.":
    "Restoring from backup now reliably recreates missing parts too.",
  "Beta: Přísnější kontrola adresy nebo faktury při odeslání":
    "Beta: stricter address/invoice validation when sending",
  "Adresa nebo faktura v poli Komu se kontroluje před odesláním.":
    "The address or invoice in the To field is now checked before sending.",
  "Beta: Animovaný pojezd číslic u zůstatku": "Beta: animated rolling digits on the balance",
  "Nová animace: číslice zůstatku při platbě najíždí jako počítadlo.":
    "New animation: the balance digits roll like an odometer on a payment.",
  "Přehlednější Nastavení": "Clearer Settings",
  "Nastavení má nově přehledné sekce místo dlouhého seznamu.":
    "Settings now has clear sections instead of one long list.",
  "Odeslané dárky se teď zálohují": "Sent gifts are now backed up",
  "Klíče k nevyzvednutým dárkům jsou teď součástí zálohy.":
    "Keys to unclaimed gifts are now part of the backup.",
  "Pošli bitcoin odkazem": "Send bitcoin as a link",
  "Nový dárkový odkaz: pošli bitcoin komukoliv jedním odkazem.":
    "New gift link: send bitcoin to anyone with a single link.",
  "Nevyzvednutý dárek se sám vrátí po 7 dnech.":
    "An unclaimed gift automatically returns to you after 7 days.",
  "Platby povoluje izolovaná část appky, ne rozhraní":
    "Payments are authorized by an isolated part of the app, not the UI",
  "Heslo pro platbu se teď ověřuje v izolované části appky.":
    "The payment password is now verified in an isolated part of the app.",
  "Seed phrase se rozšifruje mimo hlavní vlákno":
    "The seed phrase is now decrypted off the main thread",
  "Seed phrase se rozšifrovává mimo hlavní vlákno appky.":
    "The seed phrase is now decrypted outside the app's main thread.",
  "Síla hesla se teď počítá podle odhadu uhodnutelnosti.":
    "Password strength is now estimated by how guessable it is.",
  "Bezpečnostní opravy z auditu": "Security fixes from the audit",
  "Opraveny chyby z bezpečnostního auditu: faktury, záloha, síť.":
    "Fixed audit findings: invoices, backup, and network handling.",
  "Beta funkce jsou teď pro všechny": "Beta features are now for everyone",
  "Nová historie plateb, poplatky v síti a graf ceny pro všechny.":
    "New payment history, network fees and price chart for everyone.",
  "Přehlednější a bezpečnější zadávání seed phrase při importu":
    "Clearer, safer seed phrase entry when importing",
  "Import seed phrase: vlastní políčko na slovo s kontrolou.":
    "Seed phrase import: one checked box per word.",
  "Méně zbytečných odhlášení po zamčení telefonu":
    "Fewer unnecessary sign-outs after locking the phone",
  "Appka se po zamčení telefonu už neodhlašuje zbytečně.":
    "The app no longer signs you out unnecessarily after locking the phone.",
  "Upozornění na blížící se obnovu VTXO": "Alert for an upcoming VTXO refresh",
  "Push upozornění, když se blíží obnova VTXO a appka je zavřená.":
    "A push notification when a VTXO refresh is near and the app is closed.",
  "Aktualizace peněžního jádra (bark 0.7.0)": "Wallet core update (bark 0.7.0)",
  "Platba offline příjemci se doručí po jeho opětovném připojení.":
    "A payment to an offline recipient now delivers once they reconnect.",
  "Automatická šifrovaná záloha peněženky": "Automatic encrypted wallet backup",
  "Nová automatická šifrovaná záloha peněženky na server.":
    "New automatic encrypted wallet backup to the server.",
  "Server nevidí obsah, jen zašifrovaná data.":
    "The server never sees the contents, only encrypted data.",
  "Možnost úplně vypnout automatické uzamčení": "Option to fully disable auto-lock",
  "Nastavení: jde úplně vypnout automatické uzamčení appky.":
    "Settings: the app's auto-lock can now be turned off entirely.",
  "Ochrana cílové adresy nouzového výstupu": "Protection for the emergency exit's destination",
  "Odeslání nouzového výstupu teď vyžaduje heslo.":
    "Sending the emergency exit now requires a password.",
  "Bezpečnější potvrzení on-chain plateb": "Safer on-chain payment confirmation",
  "On-chain platba teď vždy projde potvrzovací obrazovkou.":
    "An on-chain payment now always goes through a confirmation screen.",
  "Záložní zdroj dat pro případ výpadku second.tech":
    "A fallback data source for a second.tech outage",
  "Appka umí dočasně přepnout na záložní zdroj dat při výpadku.":
    "The app can temporarily switch to a fallback data source during an outage.",
  "Nouzový výstup: ochrana proti dvojímu odeslání":
    "Emergency exit: protection against double-sending",
  "Nouzový výstup je chráněný proti dvojímu odeslání transakce.":
    "The emergency exit is now protected against sending a transaction twice.",
  "Externí audit: opravy nouzového výstupu": "External audit: emergency exit fixes",
  "Externí audit: opraveno několik chyb nouzového výstupu.":
    "External audit: fixed several emergency exit bugs.",
  "Odesílání na Lightning offer (BOLT12)": "Sending to a Lightning offer (BOLT12)",
  "Do pole Komu teď jde vložit i Lightning offer (BOLT12).":
    "You can now paste a Lightning offer (BOLT12) into the To field.",
  "Bezpečnostní vylepšení po externím auditu": "Security improvements from an external audit",
  "Externí bezpečnostní audit: opraveny nalezené chyby preventivně.":
    "External security audit: findings were fixed as a precaution.",
  "Žádná z nich neohrozila skutečné prostředky.":
    "None of them put real funds at risk.",
  "Zjednodušená hlavička a nové gesto zamykání (jen V2)":
    "Simplified header and a new lock gesture (V2 only)",
  "Dvojklik pod historií transakcí peněženku rychle zamkne.":
    "Double-tapping below the transaction history quickly locks the wallet.",
  "Smazání peněženky teď vyžaduje dvojí potvrzení": "Deleting the wallet now needs double confirmation",
  "Smazání peněženky teď vyžaduje dvoukrokové potvrzení.":
    "Deleting the wallet now requires a two-step confirmation.",
  "Oznámení o platbách fungují i se zavřenou appkou":
    "Payment notifications work even with the app closed",
  "Push oznámení o platbě fungují i se zavřenou appkou.":
    "Push payment notifications now work even with the app closed.",
  "Server nakoukne jen do schránky, klíč peněženky nevidí.":
    "The server only peeks into the mailbox, never the wallet key.",
  "Nová funkce: nouzový výstup z Ark bez součinnosti serveru.":
    "New feature: emergency exit from Ark without the server's cooperation.",
  "Síťové zabezpečení proti kompromitované závislosti":
    "Network protection against a compromised dependency",
  "Appka omezuje, na jaké servery smí knihovny posílat data.":
    "The app restricts which servers its libraries may send data to.",
  "Chrání proti kompromitované závislosti odesílající data ven.":
    "Guards against a compromised dependency exfiltrating data.",
  "On-chain příjem plateb": "On-chain payment receiving",
  "Nová záložka On-chain v Přijmout pro klasickou bitcoinovou adresu.":
    "New On-chain tab in Receive for a classic Bitcoin address.",
  "Bezpečnostní vylepšení": "Security improvements",
  "Odeslání 100 000+ sats vyžaduje na potvrzení znovu heslo.":
    "Sending 100,000+ sats now requires the password again to confirm.",
  "Šifrování trezoru zesíleno na 600 000 PBKDF2 iterací.":
    "Vault encryption was strengthened to 600,000 PBKDF2 iterations.",
  "Anglické rozhraní": "English interface",
  "Appku jde přepnout mezi češtinou a angličtinou.":
    "The app can now be switched between Czech and English.",
  "Auto-lock, odeslání celého zůstatku, více měn": "Auto-lock, send-all, more currencies",
  "Peněženka se po 5 minutách nečinnosti sama zamkne.":
    "The wallet now locks itself after 5 minutes of inactivity.",
  "Tlačítko Poslat vše odešle celý zůstatek najednou.":
    "A Send All button sends the entire balance at once.",
  "Appka na ploše a ochrana dat (beta)": "Home Screen app and data protection (beta)",
  "Na iPhonu a iPadu poradí, jak si přidat Spendrr na plochu.":
    "On iPhone and iPad it shows how to add Spendrr to your Home Screen.",
  "Požádá prohlížeč, aby data peněženky nemazal při nedostatku místa.":
    "Asks the browser not to delete wallet data when storage runs low.",
  "Rebrand na Spendrr": "Rebrand to Spendrr",
  "Nové jméno a logo: Spendrr.": "New name and logo: Spendrr.",
  // RefreshEnginePanel.tsx / RefreshEngineOverview.tsx
  "1 mince": "1 coin",
  "10 min uplynulo": "10 min passed",
  "5 neúspěchů": "5 failures",
  "Hledání vadné mince": "Finding the bad coin",
  "Kdy": "When",
  "Kolo selhalo": "Round failed",
  "Nejbližší": "Next up",
  "Nejisté odeslání": "Uncertain submit",
  "Nejisté vzdáno": "Uncertain submit given up",
  "Není co obnovit.": "Nothing to refresh.",
  "Nová mince": "New coin",
  "Obnovuje": "Refreshed by",
  "Odmítnuto": "Rejected",
  "Ověřuje se odeslání": "Checking submit",
  "Platnost": "Valid for",
  "Plán nedostupný": "Plan unavailable",
  "Pojistka": "Safety stop",
  "Poplatek (odhad)": "Fee (estimate)",
  "Právě probíhá": "In progress",
  "Převzato": "Picked up",
  "Přibrané": "Riding along",
  "Přibrané vynechány": "Riding-along coins left out",
  "Příští obnova": "Next refresh",
  "SDK (jako V1)": "SDK (as on V1)",
  "SDK, engine jen zapisuje": "SDK, engine only logs",
  "Skrýt mince": "Hide coins",
  "Spouštěč": "Trigger",
  "Uvolněno": "Released",
  "Všechny mince ({n})": "All coins ({n})",
  "Z karantény": "Out of quarantine",
  "Zkušebně": "Dry run",
  "Změna platí": "Change applies",
  "Zámek": "Lock",
  "Zámek selhal": "Lock failed",
  "automaticky": "automatic",
  "bez přibraných": "without riding-along coins",
  "chyba kontroly": "check failed",
  "denní limit 6 pokusů": "daily limit of 6 attempts",
  "dokončuje se": "finishing",
  "drobná (do 330 sats)": "dust (up to 330 sats)",
  "důvod neznámý, znovu za 7 dní": "reason unknown, retried in 7 days",
  "hledání vadné mince": "finding the bad coin",
  "hledání čeká na limit": "search waits for the limit",
  "hloubka {n}": "depth {n}",
  "jen s otevřenou appkou": "only while the app is open",
  "karanténa": "quarantine",
  "kolo běží": "round running",
  "kolo začíná": "round starting",
  "malá, nejlevnější pásmo": "small, cheapest band",
  "malá, hloubka 60+": "small, depth 60+",
  "max. hloubka": "max depth",
  "mimo karanténu": "not quarantined",
  "mimo ostrý režim": "not live",
  "nad limitem serveru": "over the server limit",
  "není potřeba": "not needed",
  "nová {amount}": "new {amount}",
  "obnova {when}": "refresh {when}",
  "odemčení selhalo": "unlock failed",
  "odložená": "held back",
  "opakování": "retry",
  "osiřelý zámek": "orphaned lock",
  "plán se změnil": "plan changed",
  "mince se mezitím změnily": "coins changed meanwhile",
  "+ {n} dalších": "+ {n} more",
  "{amount} sats nejde obnovit": "{amount} sats can't be refreshed",
  "uvolněno": "released",
  "Uvízla v kole": "Stuck in a round",
  "Uvolněná obnova skončila": "Released refresh ended",
  "Skončilo bez potvrzení": "Ended unconfirmed",
  "Kontrola uvíznutí": "Stuck-coin check",
  "zkouší mince po jedné": "trying coins one by one",
  "mince prošla, neuvízly": "a coin went through, not stuck",
  "nejde rozhodnout, zpět v plánu": "can't tell, back in the plan",
  "odmítnuty po jedné, uvízly": "rejected one by one, stuck",
  "Server tyto mince započítal do kola, na které appka nedostala odpověď. Tahle verze peněženky je nevyzvedne; pomůže novější verze, nebo nouzový exit.": "The server counted these coins into a round the app never heard back from. This version of the wallet can't collect them; a newer version will, or an emergency exit.",
  "čeká na viditelnou appku a síť": "waits for the app in front and a network",
  "bez odpovědi 2 h, vzdáno": "no answer for 2 h, given up",
  "znovu v plánu": "planned again",
  "Uvolnit mince": "Release coins",
  "přes 24 h, uvolněno": "over 24 h, released",
  "Část mincí nejde obnovit a brzy vyprší. Klepni pro podrobnosti.": "Some coins can't be refreshed and expire soon. Tap for details.",
  "Mince nad limitem serveru obnovit nejde. Pošli část na svou adresu, rozdělí se na menší.": "A coin over the server's limit can't be refreshed. Send part of it to your own address to split it.",
  "po poplatku pod 330 sats": "under 330 sats after the fee",
  "po zamknutí a odemčení": "after lock and unlock",
  "pod 250 bloků": "under 250 blocks",
  "poplatek {fee}": "fee {fee}",
  "později": "later",
  "přes 24 h": "over 24 h",
  "přibere se": "rides along",
  "příští kolo, do ~1 h": "next round, within ~1 h",
  "ručně": "manual",
  "selhal, zkusí se znovu": "failed, will retry",
  "spustí příští": "triggers the next",
  "utracená": "spent",
  "utracená, jen ručně": "spent, manual only",
  "v obnově": "refreshing",
  "vypršela": "expired",
  "vyprší {when}": "expires {when}",
  "zamčeno": "locked",
  "zamčená (platba)": "locked (payment)",
  "zastavena, 5 neúspěchů": "stopped, 5 failures",
  "zdarma": "free",
  "znovu za 7 dní": "retry in 7 days",
  "~1 den": "~1 day",
  "~28 dní": "~28 days",
  "čeká na kolo": "waiting for a round",
  "v kole": "in a round",
  "čeká na potvrzení": "awaiting confirmation",
  "{n} mince": "{n} coins",
  "~{n} dny": "~{n} days",
  "~{n} dní": "~{n} days",
  "Denní limit pokusů, čeká": "Daily attempt limit, waiting",
  "Nejdřív se dokončilo dřívější odeslání. Zkus to znovu za chvíli.": "An earlier submission was finished first. Try again in a moment.",
  "Mezitím se změnily mince nebo poplatek. Otevři obnovu znovu.": "The coins or the fee changed in the meantime. Open the refresh again.",
  "Podezřelé mince vynechány": "Suspect coins left out",
  "Na tuhle platbu nestačí volné mince. Část je právě v obnově a uvolní se po kole serveru, do ~1 hodiny.": "Not enough free coins for this payment. Some are being refreshed and free up after the server's round, within ~1 hour.",
  "Obnova mincí trvá přes 24 hodin. Klepni pro podrobnosti.": "A coin refresh has been running for over 24 hours. Tap for details.",
  "Obnova mincí se zastavila a mince brzy vyprší. Klepni pro podrobnosti.": "Coin refresh has stopped and coins expire soon. Tap for details.",
  "Obnova mincí": "Coin refresh",
  "Automatická obnova": "Automatic refresh",
  "Zkušební": "Dry run",
  "Ostrý": "Live",
  "Obnovu řídí SDK jako na V1.": "Refresh is handled by the SDK, as on V1.",
  "Obnovu řídí SDK, engine jen zapisuje do deníku, co by udělal.": "The SDK handles refresh; the engine only logs what it would do.",
  "Obnovu řídí engine. Mince v obnově jsou zamčené a nejdou utratit.": "The engine handles refresh. Coins being refreshed are locked and can't be spent.",
  "Změna se projeví po zamknutí a odemčení peněženky.": "Takes effect after you lock and unlock the wallet.",
  "Poslední kontrola": "Last check",
  "Pojistka zastavila obnovu: 5 neúspěchů za sebou.": "The safety stop paused refresh: 5 failures in a row.",
  "Další pokus": "Next attempt",
  "Ověřuje se, jestli poslední odeslání prošlo.": "Checking whether the last submission went through.",
  "V obnově": "Refreshing",
  "déle než 24 h": "over 24 h",
  "Karanténa": "Quarantine",
  "(server ji hlásí jako utracenou)": "(the server reports it spent)",
  "(zkusí se znovu po 7 dnech)": "(retried after 7 days)",
  "Uvolnit": "Release",
  "Obnovit teď": "Refresh now",
  "Skrýt deník": "Hide log",
  "Deník ({n})": "Log ({n})",
  "Deník obnovy": "Refresh log",
  "Podmínky užívání a zásady ochrany soukromí najdeš v Nastavení.": "The terms of service and privacy policy are now in Settings.",
  "Tamtéž jsou i licence knihoven, které peněženka používá.": "So are the licenses of the libraries the wallet uses.",
  "Dárky, oznámení a mazání": "Gifts, notifications and deleting",
  "Odeslané dárky v Nastavení se načtou hned a ukazují skutečný stav.": "Sent gifts in Settings load instantly and show their real status.",
  "Oznámení vysvětlí soukromí, smazání peněženky se potvrzuje podržením.": "Notifications explain privacy, deleting the wallet is confirmed by holding.",
  "Rychlejší a přesnější odesílání": "Faster, more accurate sending",
  "Adresa, faktura i QR se rozpoznají hned a překlep se ukáže před potvrzením.": "Addresses, invoices and QR codes are recognised at once, and a typo shows before you confirm.",
  "Jména @ se ověřují rychleji a při výpadku to zkusí znovu.": "@names are checked faster and retried after a hiccup.",
  "Úpravy nastavení": "Settings tweaks",
  "„Obnovit teď“ ukazuje načítání a přehlednější potvrzení.": "“Refresh now” shows it’s loading and a clearer confirmation.",
  "Zatřesení pro skrytí zůstatku se zapíná přímo přepínačem.": "Shake to hide the balance now has its own switch.",
  "Pohybové senzory zamítnuty v prohlížeči": "Motion sensors blocked in the browser",
  "Dávka {n}": "Batch {n}",
  "Čeká na síť": "Waiting for network",
  "čeká na síť": "waiting for network",
  "Odesláno zčásti": "Partly sent",
  "zčásti": "partly",
  "Dokončeno dřívější odeslání, zkus znovu": "Earlier send finished, try again",
  "Mince nebo poplatek se změnily": "Coins or fee changed",
  "denní limit": "daily limit",
  "po chybě": "after an error",
  "Kontrola": "Check",
  "Kontrola {n}×": "Check {n}×",
  "Starší": "Older",
  "nic k obnově": "nothing to refresh",
  "odesláno": "sent",
  "odesláno znovu": "sent again",
  "zkušebně": "dry run",
  "čeká na jinou obnovu": "waiting for another refresh",
  "neznámý stav kola": "unknown round state",
  "ověřuje odeslání": "confirming a send",
  "pojistka zastavena": "breaker tripped",
  "čeká po chybě": "waiting after an error",
  "denní limit, čeká": "daily limit, waiting",
  "selhalo": "failed",
  "nejbližší {amount} za {when}": "next: {amount} in {when}",
  "ověřuje se odeslání {coins} z {time}": "confirming the send of {coins} from {time}",
  "hledání vadné mince: {coins}": "looking for a bad coin: {coins}",
  "odesláno {time}": "sent {time}",
  "zámek selhal, zkusí se znovu": "lock failed, will retry",
  "Zapne se": "Turns on",
  "ověřuje se": "being confirmed",
  "Zatím nic.": "Nothing yet.",
  "Obnovit všechny mince": "Refresh all coins",
  "Teď není co obnovit.": "Nothing to refresh right now.",
  "Proběhne v příštím kole serveru, do ~1 hodiny. Mince budou do té doby zamčené.": "Happens in the server's next round, within ~1 hour. The coins stay locked until then.",
  "Mince": "Coins",
  "k dispozici": "available",
  "zamčená": "locked",
  "v exitu": "exiting",
  "{n} mincí": "{n} coins",
  "poplatek": "fee",
  "Zkušebně by obnovil": "Dry run: would refresh",
  "Odesláno do kola": "Submitted to a round",
  "Placená obnova": "Paid refresh",
  "Server odmítl": "Rejected by the server",
  "Výsledek odeslání neznámý": "Submission outcome unknown",
  "Odesláno znovu": "Submitted again",
  "Převzato nedokončené odeslání": "Picked up an unfinished submission",
  "Nejisté odeslání zahozeno": "Uncertain submission dropped",
  "Zámek se nepovedl": "Lock failed",
  "Obnova dokončena": "Refresh completed",
  "Kolo neproběhlo": "Round did not go through",
  "Mince uvolněny": "Coins released",
  "Mince v karanténě": "Coins quarantined",
  "Karanténa zrušena": "Quarantine lifted",
  "Pojistka zastavila obnovu": "Safety stop paused refresh",
  "Pojistka obnovena": "Safety stop reset",
  "Přeskočeno": "Skipped",
  "Nic k obnově": "Nothing to refresh",
  "Zkušebně naplánováno": "Planned (dry run)",
  "Čeká na jinou obnovu": "Waiting for another refresh",
  "Neznámý stav kola, čeká": "Unknown round state, waiting",
  "Ověřuje předchozí odeslání": "Checking the previous submission",
  "Zastaveno pojistkou": "Stopped by the safety stop",
  "Čeká po chybě": "Waiting after an error",
  "Chyba při kontrole": "Check failed",
  // Zprávy (money chat, beta)
  "Zprávy": "Messages",
  "Zprávy teď nejdou načíst.": "Messages can't load right now.",
  "Bez @jména ti nikdo nenapíše.": "Without a @name nobody can message you.",
  "Vybrat jméno": "Pick a name",
  "Žádosti": "Requests",
  "Napiš @jméno a začni.": "Type a @name to start.",
  "Ty": "You",
  "Napiš první zprávu": "Write the first message",
  "Jméno neexistuje.": "Name doesn't exist.",
  "Toto jméno zatím nemá zprávy.": "This name has no messages yet.",
  "Nepodařilo se spojit.": "Couldn't connect.",
  "jméno": "name",
  "jméno nebo npub": "name or npub",
  "To je tvůj klíč.": "That is your key.",
  "Neplatný klíč.": "Invalid key.",
  "Jméno": "Name",
  "Napsat": "Write",
  "Zprávu se nepodařilo odeslat.": "Message not sent.",
  "Odpověď se nepodařilo odeslat.": "Reply not sent.",
  "Klíč tohoto jména se změnil. Ověř si, s kým píšeš.": "This name's key changed. Check who you're talking to.",
  "Nový kontakt": "New contact",
  "Neznámý odesílatel": "Unknown sender",
  "Blokovat": "Block",
  "Posílám": "Sending",
  "Napiš první zprávu.": "Write the first message.",
  "Opakovaná platba": "Recurring payment",
  "Opakovaný požadavek": "Recurring request",
  "Poslat nebo chtít peníze": "Send or request money",
  "Zpráva": "Message",
  "Poslat": "Send",
  "Posláno": "Sent",
  "Platba": "Payment",
  "Neodesláno": "Not sent",
  "Odpovědět": "Reply",
  "zadává částku…": "entering an amount…",
  "píše…": "typing…",
  "{n} nepřečtené": "{n} unread",
  "Kopírování se nepovedlo.": "Could not copy.",
  "Posláno {sats} sats": "Sent {sats} sats",
  "Ověřeno": "Verified",
  "Neověřeno": "Not verified",
  "Bezpečnostní kód": "Safety code",
  "Stejný kód musí vidět i druhý telefon.": "The other phone must show the same code.",
  "Zrušit ověření": "Remove verification",
  "Kód sedí, ověřit": "Code matches, verify",
  "Dárek": "Gift",
  "Opouštíš Spendrr": "Leaving Spendrr",
  "Šifrováno mezi vámi": "Encrypted between you",
  "Jak šifrování funguje": "How encryption works",
  "Zprávy a platby v chatu přečtete jen vy dva. Relaye ani Spendrr ne.": "Only the two of you can read messages and payments in the chat. Not the relays, not Spendrr.",
  "Klíč je ze seedu, obnoví se s ním. Vidět je jen, že si píšete.": "The key comes from your seed and returns with it. Only the fact that you talk is visible.",
  "Poslal jsi {sent} · Dostal jsi {received} sats": "You sent {sent} · You got {received} sats",
  "Odblokovat": "Unblock",
  "Profil kontaktu": "Contact profile",
  "Nové zprávy": "New messages",
  "Přečteno": "Read",
  "Na nejnovější": "To the newest",
  "Zadává částku": "Entering an amount",
  "Píše…": "Typing…",
  "Potvrzení o přečtení": "Read receipts",
  "Oznámení o zprávách": "Message notifications",
  "Jen v appce přidané na plochu.": "Only in the app added to the home screen.",
  "Oznámení jsou v prohlížeči zakázaná.": "Notifications are blocked in the browser.",
  "Náhled": "Preview",
  "Nic": "Nothing",
  "Vidět i na zamčené obrazovce.": "Shown on the lock screen too.",
  "Platil jsi": "You paid",
  "Hledám…": "Looking up…",
  "Odesílatel": "From",
  "Žádost {when}": "Request {when}",
  "Žádost": "Request",
  "Odmítnout": "Decline",
  "Žádost přijata": "Request accepted",
  "Žádost odmítnuta": "Request declined",
  "Bude posílat {sats} sats {when}": "Will send {sats} sats {when}",
  "Žádost se nepodařilo poslat.": "Request not sent.",
  "Kontakt nemá adresu.": "Contact has no address.",
  "Chci": "Request",
  "Opakovat": "Repeat",
  "Opakovaně {when}. Druhá strana musí přijmout.": "Repeats {when}. The other side has to accept.",
  "Teď a pak připomínka {when}.": "Now, then a reminder {when}.",
  "Adresa tohoto jména se od minulé platby změnila.": "This name's address changed since your last payment.",
  "Poslat žádost": "Send request",
  "Platím…": "Paying…",
  "Posílám…": "Sending…",
  "Zkontroluj historii, než zaplatíš znovu.": "Check your history before paying again.",
  "Denně": "Daily",
  "Týdně": "Weekly",
  "Měsíčně": "Monthly",
  "Nový vzhled": "New look",
  "Přijmout a Odeslat jsou dvě tlačítka, skener QR a detaily se otevírají zespodu.": "Receive and Send are two buttons, the QR scanner and details open from the bottom.",
  "Platby v historii mají nové ikony a detail se zobrazením potvrzení.": "Payments in the history have new icons and a detail with confirmations.",
  "Nové Přijmout": "New Receive",
  "Přijmout ukazuje tvou adresu jmeno@spendrr.app, zaplatí ji každá peněženka.": "Receive shows your address name@spendrr.app, any wallet can pay it.",
  "Jen z Ark peněženky": "Ark wallets only",
  "Připíše se po ručním přijetí": "Credited once you accept it",
  "Lightning adresa teď nejde": "Lightning address is down right now",
  "Vytvořit fakturu": "Create invoice",
  "Nastavit": "Set up",
  "jmeno": "name",
  "Jiná částka": "Other amount",
  "Jiný formát": "Other format",
  "Oznámení o platbě hned": "Instant payment alerts",
  "Oznámení o přijaté platbě přijde během pár sekund, ne až po minutě.": "A received payment alert arrives within seconds, not after a minute.",
  "Zpět v appce": "Back inside the app",
  "Nouzový exit: oprava": "Emergency exit: fix",
  "Při přetíženém blockchain serveru se peněženka už nerestartuje a exit pokračuje.":
    "With an overloaded blockchain server the wallet no longer restarts and the exit continues.",
  "Systémové zpět zavře okno nebo obrazovku, ne celou appku.": "System back closes a sheet or screen, not the whole app.",
  "Zprávy: oznámení": "Messages: notifications",
  "Oznámení o nové zprávě i se zavřenou appkou, se jménem a textem.": "New message notifications even with the app closed, with name and text.",
  "Text vidí jen tvůj telefon, náš server ne. Náhled jde vypnout.": "Only your phone sees the text, not our server. The preview can be turned off.",
  "Zprávy: přehled a opravy": "Messages: overview and fixes",
  "Přehlednější seznam konverzací s nepřečtenými, zprávu jde zkopírovat.": "A clearer conversation list with unread counts; messages can be copied.",
  "Odkazy ze zpráv se otevírají a tap-to-pay v chatu nereaguje.": "Links from messages open, and tap-to-pay stays quiet while the chat is open.",
  "Zprávy: soukromí": "Messages: privacy",
  "Zprávy a kontakty jsou v telefonu šifrované, zamčená peněženka je nečitelná.": "Messages and contacts are encrypted on the phone; a locked wallet is unreadable.",
  "Bezpečnostní kód v profilu kontaktu: porovnejte ho a označte kontakt jako ověřený.": "A safety code in the contact profile: compare it and mark the contact as verified.",
  "Zprávy: odkazy": "Messages: links",
  "Faktura, adresa nebo dárek ve zprávě jde zaplatit či vyzvednout jedním klepnutím.": "An invoice, address or gift in a message can be paid or claimed with one tap.",
  "Cizí odkaz se otevře až po potvrzení, s doménou velkým písmem.": "A foreign link opens only after you confirm, with its domain in large type.",
  "Zprávy: profil a živé psaní": "Messages: profile and live typing",
  "Profil kontaktu se společnými platbami, delší zprávy, odpověď swipem.": "A contact profile with shared payments, longer messages, swipe to reply.",
  "Vidíš, když druhý píše nebo zadává částku; potvrzení o přečtení v Nastavení.": "See when the other side types or enters an amount; read receipts in Settings.",
  "Zprávy: reakce a odpovědi": "Messages: reactions and replies",
  "Podrž zprávu a reaguj emoji, nebo na ni odpověz.": "Hold a message to react with an emoji or reply to it.",
  "Uložené zprávy se ukážou hned, i před připojením.": "Saved messages show at once, even before connecting.",
  "Zprávy: kontakty a historie": "Messages: contacts and history",
  "Kontakty se obnoví se seedem, zprávy odcházejí hned.": "Contacts come back with the seed, messages go out instantly.",
  "Poznámka z chatu je u platby v historii, platba z chatu otevře detail.": "A chat note shows on the payment in history; a chat payment opens its detail.",
  "Zprávy (beta)": "Messages (beta)",
  "V betě, zapnutí v Nastavení: šifrované zprávy s @jmény, platby a žádosti v konverzaci.": "In beta, turn on in Settings: encrypted messages with @names, payments and requests in the chat.",
  "Opakované platby a žádosti s připomínkou při otevření appky.": "Recurring payments and requests, with a reminder when you open the app.",
};

export function tf(template: string, vars: Record<string, string | number>): string {
  return template.replace(/\{(\w+)\}/g, (_, k) => String(vars[k] ?? ""));
}

export { DICT as __I18N_DICT };

