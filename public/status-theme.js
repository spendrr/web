// Applies the saved light/dark choice before first paint (no inline script:
// the site's CSP allows only 'self'). Without a choice the system setting
// decides, and without JS the media query in learn.css/status.css does.
"use strict";
(function () {
  var theme = null;
  try {
    theme = localStorage.getItem("spendrr-status-theme");
  } catch {}
  if (theme !== "light" && theme !== "dark") {
    theme = matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
  }
  document.documentElement.setAttribute("data-theme", theme);
})();
