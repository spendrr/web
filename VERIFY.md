# Verify that spendrr.app runs this code

A web wallet is only as trustworthy as the JavaScript the server hands you. This is how to check that
what `spendrr.app` serves is the build of a tagged release of this repository, file for file.

You need Node.js 26, `git`, `curl` and `jq`.

```bash
# 1. Which release is deployed?
curl -fsS https://spendrr.app/build-info.json
# {"commit":"<40 hex>","version":"12.90","dirty":false}
# dirty:true means the server runs a build nobody can reproduce. Treat it as a failure.

# 2. Build that release. The tag is "v" + version.
git clone https://github.com/spendrr/web && cd web
git checkout v12.90
npm ci && npm run build

# 3. Compare every served file with your build, byte for byte.
COMMIT=$(curl -fsS https://spendrr.app/build-info.json | jq -r .commit)
node scripts/verify-deploy.mjs manifest dist "$COMMIT" > manifest.json
node scripts/verify-deploy.mjs verify manifest.json
# OK: all N files on https://spendrr.app match the build of <commit>
```

`commit` is the identifier of the development tree the release was exported from. It is baked into the
build through `build-meta.json`, so it will not match any commit in this repository. The tag is what you
check out.

## What this proves

- The static files (HTML, JavaScript, WASM, CSS, images) served to you are the ones built from the tagged source.
- The build is reproducible: no timestamps, no machine values. A different result means the source,
  the lockfile or the toolchain differs, or the server serves something else.

## What it does not prove

- **The Cloudflare Worker's own code.** `worker/` is open, but only its static output is checked here,
  not what is running behind `/api`. The wallet does not depend on the Worker for custody: it never holds
  your seed or your funds.
- **The pages the Worker rewrites per request**, such as `/@name` profiles.
- **That the server answers you the same as everyone else.** A server could serve a clean build to a checker
  and a different one to a victim. Compare from a second network, and treat an unexpected update prompt
  with suspicion.
- **That the source is free of bugs.** There is no independent audit yet.

A mismatch is worth a report: see [SECURITY.md](SECURITY.md).
