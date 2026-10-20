import { createRoot } from 'react-dom/client'
// Before index.css so the @font-face rules are declared ahead of the rules
// that reference them — see src/fonts.css for why these are self-hosted.
import './fonts.css'
import './index.css'
import './design-v2.css'
import App from './App.tsx'
import ErrorBoundary from './components/ErrorBoundary.tsx'
import { applyTheme, getThemePreference } from './lib/ui/theme.ts'
import { applyColorTheme, getColorTheme } from './lib/ui/colorTheme.ts'
import { applyBgGlow, getBgGlowEnabled } from './lib/ui/bgGlow.ts'
import { hapticTap } from './lib/ui/haptics.ts'
import { applyDesignVersion, getDesignVersion } from './lib/ui/designVersion.ts'
import { initMotionDesign } from './lib/ui/motion.ts'
import { IS_SIGNET } from './lib/network.ts'

// Applied before render so a stored manual theme choice doesn't flash the
// system-default colors first.
applyTheme(getThemePreference())
applyColorTheme(getColorTheme())
applyBgGlow(getBgGlowEnabled())
applyDesignVersion(getDesignVersion())
initMotionDesign()

// Signet dev mode (src/lib/network.ts): impossible to mistake for the real
// wallet. Never in a deployed build (IS_SIGNET is false there).
if (IS_SIGNET) {
  document.title = `SIGNET · ${document.title}`
  const badge = document.createElement('div')
  badge.className = 'signet-badge'
  badge.textContent = 'SIGNET · testovací síť, žádné skutečné peníze'
  document.body.appendChild(badge)
}

// A tab left open across a deploy has a JS bundle whose lazy-loaded chunks
// (Settings, QrScanner, the price modal, …) are hashed filenames from the
// build it loaded — if a later deploy's build graph shifts those hashes,
// the next `import()` for one 404s with "Failed to fetch dynamically
// imported module", which React (via ErrorBoundary) previously turned into
// a full "Něco se pokazilo" screen, hiding the whole wallet UI over what's
// really just a stale asset reference. Vite fires `vite:preloadError` on
// `window` specifically for this case, before the error ever reaches
// React — reload once to pick up the current build instead of crashing.
// Guarded against looping forever if reloading doesn't actually fix it
// (e.g. genuinely offline): the flag clears again a few seconds after a
// clean mount, so a *later* deploy's stale-chunk error still gets its own
// fresh reload rather than being silently swallowed by an old guard.
const PRELOAD_ERROR_RELOADED_KEY = 'btc-wallet-preload-reloaded'
window.addEventListener('vite:preloadError', (event) => {
  if (sessionStorage.getItem(PRELOAD_ERROR_RELOADED_KEY) === '1') return
  event.preventDefault()
  sessionStorage.setItem(PRELOAD_ERROR_RELOADED_KEY, '1')
  window.location.reload()
})
window.setTimeout(() => sessionStorage.removeItem(PRELOAD_ERROR_RELOADED_KEY), 5000)

// A single delegated listener, not one per button — every tappable element
// in the app is a <button>, so this gives every one of them a light tick
// for free. Must be a plain click listener (not wired into individual
// handlers) so it fires synchronously within the user gesture, which is
// what the Vibration API requires — anything after an `await` (like a send
// completing) or from a background timer (like a payment arriving) misses
// that window and silently does nothing, which is why those two get their
// own explicit, more deliberate haptic calls instead of relying on this.
document.addEventListener(
  'click',
  (e) => {
    if ((e.target as HTMLElement | null)?.closest('button')) hapticTap()
  },
  { capture: true },
)

createRoot(document.getElementById('root')!).render(
  <ErrorBoundary>
    <App />
  </ErrorBoundary>,
)
