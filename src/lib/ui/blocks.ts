import type { Lang } from "../i18n";

// Czech counting nouns decline by quantity (1 / 2-4 / 5+) — a single form
// for every count reads as "~1 hodin" / "~2 hodin".
function czechCount(n: number, one: string, few: string, many: string): string {
  if (n === 1) return one;
  if (n >= 2 && n <= 4) return few;
  return many;
}

// Real Bitcoin block times vary, but ~10 min/block is the standard
// back-of-envelope figure already used elsewhere in this app — good enough
// for "roughly how long", not a promise. Shared by the emergency-exit
// education screen and the exit-progress toast so the two never disagree
// about what a block count means.
export function blocksToApproxDuration(blocks: number, lang: Lang): string {
  const hours = Math.round((blocks * 10) / 60);
  if (hours < 1) return lang === "en" ? "under an hour" : "necelou hodinu";
  if (hours < 48) {
    return lang === "en" ? `~${hours} ${hours === 1 ? "hour" : "hours"}` : `~${hours} ${czechCount(hours, "hodinu", "hodiny", "hodin")}`;
  }
  const days = Math.round(hours / 24);
  return lang === "en" ? `~${days} ${days === 1 ? "day" : "days"}` : `~${days} ${czechCount(days, "den", "dny", "dní")}`;
}
