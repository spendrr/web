// Language choice for the Czech landing page (learn.html), made in the browser
// so /learn is a plain static asset and costs no Worker request. A browser
// whose most preferred language is neither Czech nor Slovak (Slovak readers
// understand Czech) goes to /learn/en. ?lang=cs means the reader chose Czech
// (the English page's "Česky" link and the wordmark point there), so it stays.
// Without JavaScript, or without a language list (crawlers, link unfurlers),
// the Czech page is shown. Loaded synchronously in <head> so nothing paints
// first.
(function () {
  "use strict";
  var CZECH_READABLE = { cs: true, sk: true };

  function prefersEnglish(languages) {
    var first = languages && languages.length > 0 && languages[0] ? String(languages[0]) : "";
    var tag = first.trim().toLowerCase();
    if (!tag || tag === "*") return false;
    return !CZECH_READABLE[tag.split("-")[0]];
  }

  try {
    if (/(^|[?&])lang=cs(&|$)/.test(window.location.search)) return;
    var langs = navigator.languages && navigator.languages.length > 0 ? navigator.languages : [navigator.language];
    if (prefersEnglish(langs)) window.location.replace("/learn/en");
  } catch {
    // stay on the Czech page
  }
})();
