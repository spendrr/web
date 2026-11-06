// Classic script in index.html's head: links the light or the dark manifest
// by the system colour scheme. The two files differ only in theme_color and
// background_color (an installed app's status bar and splash), and must stay
// in sync with src/index.css's light/dark --bg and src/lib/ui/theme.ts.
(function () {
  var dark = false;
  try {
    dark = window.matchMedia("(prefers-color-scheme: dark)").matches;
  } catch (e) {}
  var link = document.createElement("link");
  link.rel = "manifest";
  link.href = dark ? "/manifest-dark.json" : "/manifest.json";
  document.head.appendChild(link);
})();
