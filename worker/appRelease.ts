// The Android app's own update channel, outside any store: GET /app/update.json (a few hundred bytes the app polls once a day) and GET /app/apk/<name>.apk (the file it
// names). Both live in the APP_RELEASES R2 bucket, put there by hand after a release (spendrr-android-kotlin's tools/publish-update.mjs prints the commands); this
// route only serves them. It is NOT what makes an update safe: Android installs an update only if it carries the app's own signing certificate and a higher version
// code, and the app checks the size, SHA-256 and signer before it ever starts the installer. A bucket that someone else could write to would cost an update
// (withheld, or an older signed build served), never the wallet; keep it writable only by the Cloudflare account.

// What is read of an R2 object (the real one has all of it; the Worker's own minimal R2 types only declare the body, hence the optionals).
interface ReleaseObject {
  body: ReadableStream;
  /** The WHOLE object's size, also for a ranged read. */
  size?: number;
  httpEtag?: string;
  /** Set when the read was ranged: what was actually returned. */
  range?: { offset?: number; length?: number };
}

export interface ReleaseBucket {
  get(key: string, options?: { range?: { offset: number; length?: number } }): Promise<ReleaseObject | null>;
}

/**
 * `Range: bytes=N-` or `bytes=N-M`, the only forms the app sends when it picks a broken download up again. Anything else (suffix ranges, several ranges, nonsense) is
 * ignored, and the whole file is served, which the protocol allows.
 */
export function parseRange(header: string | null): { offset: number; length?: number } | null {
  const m = /^bytes=(\d{1,12})-(\d{0,12})$/.exec((header ?? "").trim());
  if (!m) return null;
  const offset = Number(m[1]);
  if (m[2] === "") return { offset };
  const last = Number(m[2]);
  return last >= offset ? { offset, length: last - offset + 1 } : null;
}

const APK_NAME = /^[A-Za-z0-9._-]{1,80}\.apk$/;

/** The R2 key for a request path, or null when it is not one of the two files this serves. Nothing else in the bucket is reachable, whatever the path says. */
export function releaseKeyFor(pathname: string): { key: string; kind: "manifest" | "apk" } | null {
  if (pathname === "/app/update.json") return { key: "update.json", kind: "manifest" };
  if (pathname.startsWith("/app/apk/")) {
    const name = pathname.slice("/app/apk/".length);
    if (APK_NAME.test(name) && !name.includes("..")) return { key: `apk/${name}`, kind: "apk" };
  }
  return null;
}

const COMMON = { "x-content-type-options": "nosniff" };

function describe(object: ReleaseObject): Record<string, string> {
  const h: Record<string, string> = {};
  if (object.httpEtag) h.etag = object.httpEtag;
  if (typeof object.size === "number") h["content-length"] = String(object.size);
  return h;
}

export async function handleAppRelease(request: Request, bucket: ReleaseBucket | undefined, pathname: string): Promise<Response> {
  if (request.method !== "GET" && request.method !== "HEAD") return new Response("method not allowed", { status: 405, headers: { allow: "GET, HEAD" } });
  const target = releaseKeyFor(pathname);
  if (!target || !bucket) return new Response("not found", { status: 404, headers: { "cache-control": "no-store" } });
  const head = request.method === "HEAD";
  // only a file can be read in parts; the manifest is a few hundred bytes
  const range = target.kind === "apk" && !head ? parseRange(request.headers.get("range")) : null;
  let object: ReleaseObject | null;
  try {
    object = await bucket.get(target.key, range ? { range } : undefined);
  } catch (e) {
    // a range past the end of the file
    if (range) return new Response("range not satisfiable", { status: 416, headers: { "cache-control": "no-store" } });
    throw e;
  }
  if (!object) return new Response("not found", { status: 404, headers: { "cache-control": "no-store" } });
  if (target.kind === "manifest") {
    // short cache: a new release should reach phones within minutes, not a day
    return new Response(head ? null : object.body, {
      headers: { ...COMMON, ...describe(object), "accept-ranges": "none", "content-type": "application/json", "cache-control": "public, max-age=300" },
    });
  }
  const headers: Record<string, string> = {
    ...COMMON,
    "accept-ranges": "bytes",
    "content-type": "application/vnd.android.package-archive",
    "content-disposition": `attachment; filename="${pathname.slice("/app/apk/".length)}"`,
    // a published file never changes (its name carries the version), so it can be cached for good
    "cache-control": "public, max-age=31536000, immutable",
  };
  if (object.httpEtag) headers.etag = object.httpEtag;
  const total = object.size;
  if (range && object.range && typeof total === "number") {
    const offset = object.range.offset ?? range.offset;
    const length = object.range.length ?? total - offset;
    headers["content-range"] = `bytes ${offset}-${offset + length - 1}/${total}`;
    headers["content-length"] = String(length);
    return new Response(object.body, { status: 206, headers });
  }
  if (typeof total === "number") headers["content-length"] = String(total);
  return new Response(head ? null : object.body, { headers });
}
