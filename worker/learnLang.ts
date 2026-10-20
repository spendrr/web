// Language choice for the /learn landing page (public/learn.html, Czech;
// public/learn/en.html, English). Pure so it can be unit-tested
// (tests/learnLang.test.ts); the redirect itself is handleLearnPage in index.ts.
//
// Czech stays the default: a request without Accept-Language (search engine
// crawlers, link unfurlers) or with a wildcard gets the Czech page. Only a
// browser whose most preferred language is something other than Czech or
// Slovak (Slovak readers understand Czech) is sent to English.

const CZECH_READABLE = new Set(["cs", "sk"]);

export function prefersEnglishLearn(acceptLanguage: string | null): boolean {
  if (!acceptLanguage) return false;
  let best: { tag: string; q: number } | null = null;
  for (const part of acceptLanguage.split(",")) {
    const [rawTag, ...params] = part.trim().split(";");
    const tag = rawTag.trim().toLowerCase();
    if (!tag) continue;
    let q = 1;
    for (const p of params) {
      const [k, v] = p.trim().split("=");
      if (k === "q") {
        const n = Number(v);
        q = Number.isFinite(n) ? n : 0;
      }
    }
    if (q <= 0) continue;
    // Strictly greater: among equal weights the first listed wins, which is
    // how browsers order them.
    if (best === null || q > best.q) best = { tag, q };
  }
  if (best === null || best.tag === "*") return false;
  return !CZECH_READABLE.has(best.tag.split("-")[0]);
}
