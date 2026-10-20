// spendrr.app/tip/<name>, and /donate for the project's own name `donate`.
//
// `donate` is an alias of `lubos` (same Ark address) without a Lightning address
// of its own, so the page shows `donate` but takes the invoice from `lubos`, the
// way the app resolves an alias to its holder's address. Add a pair here only
// for an alias that really points at the same wallet.
export const PAYS_AS: Record<string, string> = { donate: "lubos" };

export function payName(name: string): string {
  return Object.hasOwn(PAYS_AS, name) ? PAYS_AS[name] : name;
}

export function tipNameFromPath(pathname: string): string {
  if (/^\/donate\/?$/.test(pathname)) return "donate";
  const m = /^\/tip\/([^/]+)\/?$/.exec(pathname);
  if (!m) return "";
  try {
    return decodeURIComponent(m[1]).replace(/^@/, "").toLowerCase();
  } catch {
    return "";
  }
}
