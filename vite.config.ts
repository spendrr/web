import { execSync } from 'node:child_process'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import react from '@vitejs/plugin-react'
import mkcert from 'vite-plugin-mkcert'
import { defineConfig, loadEnv, type Connect, type PluginOption } from 'vite'

// Surfaced in Settings ("O peněžence") so a deployed build can be matched
// back to the commit it came from — there's no other versioning in this repo
// (package.json stays at 0.0.0). There are no release tags to derive a "real"
// semver from, but a monotonically increasing number people can compare ("did
// I update?") is more useful in the UI than a raw hash, which stays around as
// the "Sestaveno" build info for actually pinpointing a deploy.
//
// Odometer-style major.minor, rolling over every 100 commits (1.99 -> 2.00,
// not 1.100 — the original "1.<count>" scheme was replaced once it actually
// hit that rollover). major = 1 + floor(count / 100), minor = count % 100,
// zero-padded to 2 digits.
//
// build-meta.json (repo root, optional) pins commit, date and version for a tree
// that is not the repo they came from: the public source snapshot is exported
// from the private repo as a single commit, whose git history yields different
// values and therefore a different bundle. The export writes the values the
// private build used, so both trees build byte-identical output. Absent in the
// private repo, which always reads git.
type BuildMeta = { commit: string; date: string; version: string }
function readBuildMeta(): BuildMeta | null {
  if (!existsSync('build-meta.json')) return null
  const m = JSON.parse(readFileSync('build-meta.json', 'utf8')) as Partial<BuildMeta>
  if (!/^[0-9a-f]{40}$/.test(m.commit ?? '') || !/^\d+\.\d{2}$/.test(m.version ?? '') || typeof m.date !== 'string') {
    throw new Error('build-meta.json: need commit (40 hex), date and version (N.NN)')
  }
  return m as BuildMeta
}

function gitInfo(): { commit: string; hash: string; date: string; version: string; dirty: boolean } {
  const meta = readBuildMeta()
  if (meta) {
    // Dirty still comes from the tree, so an edited snapshot cannot pass for the release.
    let dirty = false
    try {
      dirty = execSync('git status --porcelain').toString().trim().length > 0
    } catch {
      // A source archive without .git: nothing to compare against.
    }
    return { commit: meta.commit, hash: meta.commit.slice(0, 7), date: meta.date, version: `${meta.version}${dirty ? '+dirty' : ''}`, dirty }
  }
  try {
    const commit = execSync('git rev-parse HEAD').toString().trim()
    // Not `--short`: its length grows with the objects in the local clone, so
    // this laptop and a fresh CI checkout could bake different strings into
    // the bundle and scripts/verify-deploy.mjs would see a false mismatch.
    const hash = commit.slice(0, 7)
    const date = execSync('git log -1 --format=%cI').toString().trim()
    const commitCount = Number(execSync('git rev-list --count HEAD').toString().trim())
    const major = 1 + Math.floor(commitCount / 100)
    const minor = String(commitCount % 100).padStart(2, '0')
    // Version is purely a function of commit count, so building from a dirty
    // tree (uncommitted changes) silently ships whatever's on disk under the
    // *same* version number as the last real build of this commit — which
    // also means shouldShowWhatsNew() (src/lib/whatsNew.ts) sees no version
    // change and never re-shows the "what's new" popup, even though the
    // changelog content did change. Surfacing "+dirty" here doesn't fix that
    // (there's no commit to derive a new number from), but at least makes an
    // uncommitted deploy visible in Settings instead of looking identical to
    // a clean one — a prompt to go commit before relying on version-based
    // behavior like the changelog popup.
    const dirty = execSync('git status --porcelain').toString().trim().length > 0
    return { commit, hash, date, version: `${major}.${minor}${dirty ? '+dirty' : ''}`, dirty }
  } catch {
    return { commit: 'unknown', hash: 'unknown', date: '', version: 'unknown', dirty: true }
  }
}

const { commit, hash, date, version, dirty } = gitInfo()

// Served as /build-info.json so scripts/verify-deploy.mjs (run hourly by
// .github/workflows/deploy-watch.yml) knows which commit to rebuild and
// compare against what spendrr.app actually serves.
function buildInfoPlugin(): PluginOption {
  return {
    name: 'build-info',
    apply: 'build',
    generateBundle() {
      this.emitFile({
        type: 'asset',
        fileName: 'build-info.json',
        source: JSON.stringify({ commit, version, dirty }) + '\n',
      })
    },
  }
}

// Served as /third-party-licenses.txt (linked from Settings). The minified
// bundle carries no license comments, yet MIT/BSD/ISC/Apache all require the
// notice to travel with every copy, and the site hands out a copy on every
// load. Covers every non-dev package in the lockfile (the wallet worker is a
// separate bundle, so the main bundle's module graph would miss bark) plus
// the self-hosted fonts. Sorted, no timestamps: the build stays reproducible.
function thirdPartyLicensesPlugin(): PluginOption {
  return {
    name: 'third-party-licenses',
    apply: 'build',
    generateBundle() {
      const lock = JSON.parse(readFileSync('package-lock.json', 'utf8')) as {
        packages: Record<string, { version?: string; license?: string; dev?: boolean }>
      }
      const sections = Object.entries(lock.packages)
        .filter(([dir, pkg]) => dir !== '' && !pkg.dev)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([dir, pkg]) => {
          const name = dir.slice(dir.lastIndexOf('node_modules/') + 'node_modules/'.length)
          const file = readdirSync(dir).find((f) => /^(licen[cs]e|mit-licen[cs]e|copying)/i.test(f))
          if (!file) throw new Error(`third-party-licenses: no license file in ${dir}`)
          const text = readFileSync(join(dir, file), 'utf8').trim()
          return `${name} ${pkg.version} (${pkg.license})\n\n${text}`
        })
      sections.push(
        `Fonts: Space Grotesk, Space Mono, Unbounded (OFL-1.1)\n\n${readFileSync('public/fonts/OFL.txt', 'utf8').trim()}`,
      )
      const rule = '\n\n' + '='.repeat(72) + '\n\n'
      this.emitFile({
        type: 'asset',
        fileName: 'third-party-licenses.txt',
        source: 'Third-party software included in Spendrr' + rule + sections.join(rule) + '\n',
      })
    },
  }
}

const ALLOWED_CURRENCIES = new Set(['czk', 'eur', 'usd'])
const ALLOWED_DAYS = new Set(['1', '7', '30', '90', '365'])

// Mirrors worker/index.ts's CoinGecko proxy for `npm run dev` (plain Vite,
// no Worker layer). Keeps the API key attached here, server-side in the Vite
// dev process, rather than reading it as a VITE_-prefixed client env var —
// the point of moving it server-side in production is defeated if local dev
// puts it back in the browser bundle.
function devPriceProxyPlugin(apiKey: string | undefined): PluginOption {
  return {
    name: 'dev-price-proxy',
    configureServer(server) {
      const proxyTo = (target: string): Connect.NextHandleFunction => {
        return async (_req, res) => {
          const r = await fetch(target, { headers: apiKey ? { 'x-cg-demo-api-key': apiKey } : {} })
          res.statusCode = r.status
          res.setHeader('content-type', 'application/json')
          res.end(await r.text())
        }
      }
      server.middlewares.use('/api/price/simple', (req, res, next) => {
        if (req.method !== 'GET') return next()
        proxyTo('https://api.coingecko.com/api/v3/simple/price?ids=bitcoin&vs_currencies=czk,eur,usd&include_last_updated_at=true')(req, res, next)
      })
      server.middlewares.use('/api/price/history', (req, res, next) => {
        if (req.method !== 'GET') return next()
        const url = new URL(req.url ?? '', 'http://localhost')
        const currency = url.searchParams.get('vs_currency') ?? ''
        const days = url.searchParams.get('days') ?? ''
        if (!ALLOWED_CURRENCIES.has(currency) || !ALLOWED_DAYS.has(days)) {
          res.statusCode = 400
          res.end('Bad request')
          return
        }
        // Same granularity as worker/index.ts: hourly (CoinGecko's default)
        // up to 90 days, daily only for 365. Forcing daily everywhere left
        // the 7-day chart with 8 points in dev, unlike production.
        const interval = days === '365' ? '&interval=daily' : ''
        proxyTo(
          `https://api.coingecko.com/api/v3/coins/bitcoin/market_chart?vs_currency=${currency}&days=${days}${interval}`,
        )(req, res, next)
      })
    },
  }
}

// The dev relays below forward to a `wrangler dev` instance running on its
// default port, so `npm run dev`'s hot-reloading Vite server can still
// exercise the real Worker locally. Requires `npx wrangler dev` running
// separately; if it isn't, these requests just fail with a connection error,
// same as any other unavailable local dependency.
const WRANGLER_DEV_ORIGIN = 'http://127.0.0.1:8787'

// Relay to `wrangler dev` for the btcmap.org merchant map (worker/btcmap.ts)
// — no access token to inject here, both routes are public reads. Without
// this, `npm run dev` alone falls through to the SPA's index.html for these
// paths (a 200 with HTML, not a clean error) since nothing else matches
// /api/btcmap/* — still
// harmless (BtcMapPanel's fetch/img error handling swallows the bad
// response either way) but means tiles/pins never actually render without
// `wrangler dev` also running.
function devBtcMapProxyPlugin(): PluginOption {
  return {
    name: 'dev-btcmap-proxy',
    configureServer(server) {
      // Connect's mount-path matching strips the matched prefix off
      // req.url, leaving only what came after it (a query string for the
      // exact '/api/btcmap/elements' mount, a "13/4424/2775.png"-shaped
      // remainder for the '/api/btcmap/tile/' prefix mount) — `mountPath`
      // reconstructs the real upstream path.
      const relay = (mountPath: string): Connect.NextHandleFunction => {
        return async (req, res) => {
          try {
            const r = await fetch(`${WRANGLER_DEV_ORIGIN}${mountPath}${req.url ?? ''}`)
            res.statusCode = r.status
            res.setHeader('content-type', r.headers.get('content-type') ?? 'application/json')
            res.end(Buffer.from(await r.arrayBuffer()))
          } catch {
            res.statusCode = 502
            res.setHeader('content-type', 'application/json')
            res.end(JSON.stringify({ error: 'wrangler dev not reachable on :8787' }))
          }
        }
      }
      server.middlewares.use('/api/btcmap/elements', relay('/api/btcmap/elements'))
      server.middlewares.use('/api/btcmap/tile/', relay('/api/btcmap/tile/'))
    },
  }
}

// Same relay-to-`wrangler dev` pattern, for /bump-lab.html's pairing backend
// (worker/bump.ts) — no access token, both routes are unauthenticated (only
// same-origin + rate-limited). Without this, `npm run dev` alone can serve
// the static bump-lab.html/js/css fine (they're plain files under public/)
// but every fetch() to /api/bump/* 404s against Vite's own dev server.
function devBumpProxyPlugin(): PluginOption {
  return {
    name: 'dev-bump-proxy',
    configureServer(server) {
      const relay = (mountPath: string): Connect.NextHandleFunction => {
        return async (req, res) => {
          // Connect's exact-path mount strips the matched prefix off
          // req.url, leaving "/" (not "") when there's nothing left. Blindly
          // appending req.url here would send the query-less requests below
          // to ".../sync/" with a trailing slash, which worker/index.ts's
          // exact `url.pathname === "/api/bump/sync"` check doesn't match,
          // silently falling through to the SPA's index.html instead of a
          // clean error.
          const suffix = req.url?.includes('?') ? req.url.slice(req.url.indexOf('?')) : ''
          // Forward the browser's real headers through, notably
          // Sec-Fetch-Site — worker/index.ts's checkSameOrigin accepts
          // "same-origin" at face value without cross-checking it against
          // Origin, so this is what lets a same-origin fetch() against the
          // Vite dev origin pass the Worker's same-origin gate even though
          // it's being relayed to a different origin (127.0.0.1:8787)
          // underneath.
          const headers: Record<string, string> = { 'content-type': 'application/json' }
          for (const [key, value] of Object.entries(req.headers)) {
            // Excludes HTTP/2 pseudo-headers (":method", ":path", ...) too —
            // mkcert's dev server can negotiate h2, whose pseudo-headers
            // aren't valid fetch() header names and throw if passed through.
            if (typeof value === 'string' && !key.startsWith(':') && key !== 'host' && key !== 'connection' && key !== 'content-length') {
              headers[key] = value
            }
          }
          const chunks: Buffer[] = []
          for await (const chunk of req) chunks.push(chunk as Buffer)
          const body = chunks.length > 0 ? Buffer.concat(chunks) : undefined
          try {
            const r = await fetch(`${WRANGLER_DEV_ORIGIN}${mountPath}${suffix}`, {
              method: req.method,
              headers,
              body,
            })
            res.statusCode = r.status
            res.setHeader('content-type', r.headers.get('content-type') ?? 'application/json')
            res.end(Buffer.from(await r.arrayBuffer()))
          } catch {
            res.statusCode = 502
            res.setHeader('content-type', 'application/json')
            res.end(JSON.stringify({ error: 'wrangler dev not reachable on :8787' }))
          }
        }
      }
      server.middlewares.use('/api/bump/sync', relay('/api/bump/sync'))
      server.middlewares.use('/api/bump/tap', relay('/api/bump/tap'))
      server.middlewares.use('/api/bump/status', relay('/api/bump/status'))
      server.middlewares.use('/api/bump/choose', relay('/api/bump/choose'))
    },
  }
}

// Money chat POC (`npm run dev -- --mode chat`): the @name registry, its chat
// key, NIP-05 and chat push come from a local `wrangler dev` instead of nowhere, so two
// dev origins (localhost and 127.0.0.1) can find each other by name. Off in
// every other mode: plain dev keeps answering these paths as it always did.
function devChatNamesProxyPlugin(): PluginOption {
  return {
    name: 'dev-chat-names-proxy',
    configureServer(server) {
      const relay: Connect.NextHandleFunction = async (req, res) => {
        const headers: Record<string, string> = {}
        for (const [key, value] of Object.entries(req.headers)) {
          if (typeof value === 'string' && !key.startsWith(':') && key !== 'host' && key !== 'connection' && key !== 'content-length') {
            headers[key] = value
          }
        }
        const chunks: Buffer[] = []
        for await (const chunk of req) chunks.push(chunk as Buffer)
        try {
          const r = await fetch(`${WRANGLER_DEV_ORIGIN}${req.originalUrl ?? req.url ?? ''}`, {
            method: req.method,
            headers,
            body: chunks.length > 0 ? Buffer.concat(chunks) : undefined,
          })
          res.statusCode = r.status
          res.setHeader('content-type', r.headers.get('content-type') ?? 'application/json')
          res.end(Buffer.from(await r.arrayBuffer()))
        } catch {
          res.statusCode = 502
          res.setHeader('content-type', 'application/json')
          res.end(JSON.stringify({ error: 'wrangler dev not reachable on :8787' }))
        }
      }
      server.middlewares.use('/api/names', relay)
      // Chat push tokens and pokes (worker/chatPush.ts).
      server.middlewares.use('/api/chat/', relay)
      server.middlewares.use('/.well-known/nostr.json', relay)
    },
  }
}

// Signet dev mode (src/lib/network.ts): the app's own /api (cloud backup,
// push, @handles) belongs to the mainnet Worker and must never see a signet
// wallet. Plain Vite would answer those paths with index.html (a 200 that
// the backup restore reads as a corrupt backup); a 404 reads as "nothing
// there". Mounted after the dev proxies above, so the price, map and bump
// relays still work.
function signetApiStubPlugin(): PluginOption {
  const stub: Connect.NextHandleFunction = (_req, res) => {
    res.statusCode = 404
    res.setHeader('content-type', 'application/json')
    res.end(JSON.stringify({ error: 'not available in signet dev mode' }))
  }
  return {
    name: 'signet-api-stub',
    configureServer(server) {
      server.middlewares.use('/api/', stub)
    },
    // The regtest E2E serves a built bundle with `vite preview`.
    configurePreviewServer(server) {
      server.middlewares.use('/api/', stub)
    },
  }
}

// https://vite.dev/config/
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '')
  return {
    plugins: [
      react(),
      // Web Crypto (crypto.subtle) — which vaultCrypto.ts/backupCrypto.ts
      // build the whole vault/backup key derivation on — only exists in a
      // secure context: https://, or the special-cased http://localhost.
      // Vite's --host flag exposes the dev server on the LAN as plain http,
      // which a phone on that LAN sees as neither, so crypto.subtle is
      // undefined there and e.g. "Nastavit heslo" fails on
      // "Cannot read properties of undefined (reading 'importKey')". mkcert
      // generates a locally-trusted cert (once you trust its root CA) so the
      // dev server can actually serve https:// on the LAN IP too. Harmless
      // for a plain localhost dev session — that was already a secure
      // context either way.
      mkcert(),
      devPriceProxyPlugin(env.VITE_COINGECKO_API_KEY),
      devBtcMapProxyPlugin(),
      devBumpProxyPlugin(),
      ...(mode === 'chat' ? [devChatNamesProxyPlugin()] : []),
      ...(mode === 'signet' || mode === 'regtest' ? [signetApiStubPlugin()] : []),
      buildInfoPlugin(),
      thirdPartyLicensesPlugin(),
    ],
    build: {
      // tip.html is the standalone tip/donate page (src/tip/), served at /tip by
      // the asset layer; it shares no code with the wallet bundle.
      rollupOptions: { input: { main: 'index.html', tip: 'tip.html' } },
    },
    define: {
      __APP_COMMIT__: JSON.stringify(hash),
      __APP_COMMIT_DATE__: JSON.stringify(date),
      __APP_VERSION__: JSON.stringify(version),
      // src/lib/network.ts. Only `--mode signet` changes it; `vite build`
      // (mode "production") is always mainnet.
      __NETWORK__: JSON.stringify(mode === 'signet' ? 'signet' : mode === 'regtest' ? 'regtest' : 'bitcoin'),
      // Only read by a regtest build (src/lib/wallet/walletWorkerGuard.ts): the
      // harness picks the ports per run and exports them before vite starts.
      __REGTEST_ARK_URL__: JSON.stringify(mode === 'regtest' ? env.REGTEST_ARK_URL ?? '' : ''),
      __REGTEST_ESPLORA_URL__: JSON.stringify(mode === 'regtest' ? env.REGTEST_ESPLORA_URL ?? '' : ''),
    },
  }
})
