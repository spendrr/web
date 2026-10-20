import { createRoot } from "react-dom/client";
import "../fonts.css";
import "../index.css";
import "../design-v2.css";
import "./tip.css";
import { applyTheme, getThemePreference } from "../lib/ui/theme";
import { applyColorTheme } from "../lib/ui/colorTheme";
import TipPage from "./TipPage";
import { tipNameFromPath } from "./path";

applyTheme(getThemePreference());
// Purple for every visitor: this page is shown to people who have not picked a color in the app.
applyColorTheme("purple");

createRoot(document.getElementById("root")!).render(<TipPage name={tipNameFromPath(window.location.pathname)} />);
