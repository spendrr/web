// Wording for the unilateral exit, shared by the home card and the exit
// screen in Settings so the two never describe the same state differently.
// Everything here reads exitModel.ts's view; nothing guesses on its own.
import { blocksToApproxDuration } from "../lib/ui/blocks";
import { localeFor, tf, type Lang } from "../lib/i18n";
import type { ExitCoinView, ExitOverview } from "../lib/exit/exitModel";
import type { ExitActionErrorCode } from "../lib/exit/exitActions";

type T = (s: string) => string;

export function formatSats(n: number, lang: Lang): string {
  return `${n.toLocaleString(localeFor(lang))} sats`;
}

// Czech count forms: 1, 2 to 4, and the rest (0, 5+).
export function czechCountForm(n: number): "one" | "few" | "many" {
  return n === 1 ? "one" : n >= 2 && n <= 4 ? "few" : "many";
}

export function blocksLabel(blocks: number, t: T, lang: Lang): string {
  const form = czechCountForm(blocks);
  const key = form === "one" ? "{blocks} blok, {duration}" : form === "few" ? "{blocks} bloky, {duration}" : "{blocks} bloků, {duration}";
  return tf(t(key), {
    blocks: blocks.toLocaleString(localeFor(lang)),
    duration: blocksToApproxDuration(blocks, lang),
  });
}

// Confirmed / all distinct exit transactions of this exit (exitModel.ts).
export function txProgress(o: ExitOverview): { confirmed: number; total: number } {
  return o.txProgress;
}

// One short line for the home card, under the "Nouzový exit" title.
export function homeHeadline(o: ExitOverview, t: T, lang: Lang): string {
  switch (o.stage) {
    case "ready":
      return tf(t("{amount} k vyzvednutí"), { amount: formatSats(o.claimableSats, lang) });
    case "preparing":
      return t("Chystám první transakci");
    case "broadcasting": {
      const p = txProgress(o);
      return tf(t("Na blockchain: potvrzeno {done} z {total}"), { done: p.confirmed, total: p.total });
    }
    case "timelock":
      return o.lastReadyInBlocks !== null && o.lastReadyInBlocks > 0
        ? tf(t("Časový zámek, zbývá {left}"), { left: blocksToApproxDuration(o.lastReadyInBlocks, lang) })
        : t("Zámek skončil, čekám na blok");
    case "claiming":
      return t("Vyzvednutí čeká na potvrzení");
    default:
      return "";
  }
}

export function waitingForLabel(c: ExitCoinView, t: T): string {
  switch (c.waitingFor) {
    case "fee":
      return t("čeká na zaplacení poplatku z on-chain zůstatku");
    case "previous-step":
      return t("čeká na potvrzení předchozí transakce");
    case "verify":
      return t("ověřuje předchozí transakce");
    default:
      return t("odesláno, čeká na potvrzení v bloku");
  }
}

// One line per coin in the details list.
export function coinLine(c: ExitCoinView, t: T, lang: Lang): string {
  switch (c.phase) {
    case "preparing":
      return t("Připravuje se první transakce");
    case "broadcasting":
      return tf(t("Transakce {done} z {total} potvrzeno · {waiting}"), {
        done: c.txConfirmed ?? 0,
        total: c.txTotal ?? 0,
        waiting: waitingForLabel(c, t),
      });
    case "timelock":
      return c.blocksLeft !== null && c.blocksLeft > 0
        ? tf(t("Časový zámek: zbývá {left}"), { left: blocksLabel(c.blocksLeft, t, lang) })
        : t("Časový zámek skončil, peněženka to potvrdí s dalším blokem");
    case "claimable":
      return t("Připraveno k vyzvednutí");
    case "claim-sent":
      return t("Vyzvednutí odesláno, peněženka ho zatím nevidí");
    case "claiming":
      return t("Vyzvednutí čeká na potvrzení v bloku");
    case "claimed":
      return c.claimBlock !== null
        ? tf(t("Vyzvednuto v bloku {height}"), { height: c.claimBlock.toLocaleString(localeFor(lang)) })
        : t("Vyzvednuto");
    case "aborted":
      return t("Přerušeno: mince byla utracena jinak, než se exit dostal na blockchain");
    case "canceled":
      return t("Zrušeno, mince zůstala v Ark");
  }
}

export function exitActionErrorText(code: ExitActionErrorCode, t: T): string {
  switch (code) {
    case "no-vault":
      return t("Trezor nenalezen.");
    case "wrong-password":
      return t("Nesprávné heslo.");
    case "no-address":
      return t("Není nastavená cílová adresa. Nastav ji níž v „Cílová adresa“.");
    case "unverified-address":
      return t(
        "Cílová adresa není potvrzená heslem, takže nejde ověřit, že ji nikdo nezměnil. Zadej ji prosím znovu.",
      );
    case "address-mismatch":
      return t(
        "Uložená cílová adresa neodpovídá té, kterou jsi potvrdil heslem. Mohla být změněna mimo appku. NEODESÍLEJ a nastav ji prosím znovu.",
      );
    case "tag-failed":
      return t("Adresu se nepodařilo zabezpečit heslem. Zkus to prosím znovu.");
    case "nothing-to-claim":
      return t("Teď není co vyzvednout.");
    case "round-inputs-unknown":
      return t("Nepodařilo se zjistit, které mince jsou právě v obnově, tak exit nespouštím. Zkus to za chvíli znovu.");
  }
}

export { explorerTxUrl } from "../lib/network";
