export type ColorTheme = "orange" | "purple" | "red" | "blue" | "teal";

const STORAGE_KEY = "btc-wallet-color-theme";
const DEFAULT: ColorTheme = "orange";
const VALID: ColorTheme[] = ["orange", "purple", "red", "blue", "teal"];

export function getColorTheme(): ColorTheme {
  const v = localStorage.getItem(STORAGE_KEY);
  return (VALID as string[]).includes(v ?? "") ? (v as ColorTheme) : DEFAULT;
}

export function applyColorTheme(theme: ColorTheme): void {
  document.documentElement.setAttribute("data-color-theme", theme);
}

export function setColorTheme(theme: ColorTheme): void {
  localStorage.setItem(STORAGE_KEY, theme);
  applyColorTheme(theme);
}
