import { describe, expect, it } from "vitest";
import { handleAppRelease, parseRange, releaseKeyFor, type ReleaseBucket } from "../worker/appRelease";

function bucket(files: Record<string, string>): ReleaseBucket & { asked: string[] } {
  const asked: string[] = [];
  return {
    asked,
    async get(key: string, options?: { range?: { offset: number; length?: number } }) {
      asked.push(key);
      const text = files[key];
      if (text === undefined) return null;
      if (options?.range) {
        const { offset, length } = options.range;
        // what R2 does: a range that starts past the end is an error
        if (offset >= text.length) throw new Error("10039: range not satisfiable");
        const part = text.slice(offset, length === undefined ? undefined : offset + length);
        return { body: new Blob([part]).stream(), size: text.length, httpEtag: '"abc"', range: { offset, length: part.length } };
      }
      return { body: new Blob([text]).stream(), size: text.length, httpEtag: '"abc"' };
    },
  };
}

const req = (method = "GET") => new Request("https://spendrr.app/app/x", { method });

describe("releaseKeyFor", () => {
  it("maps only the manifest and apk names", () => {
    expect(releaseKeyFor("/app/update.json")).toEqual({ key: "update.json", kind: "manifest" });
    expect(releaseKeyFor("/app/apk/spendrr-0.3.7.apk")).toEqual({ key: "apk/spendrr-0.3.7.apk", kind: "apk" });
  });

  it("refuses everything else, including ways out of the folder", () => {
    for (const p of [
      "/app", "/app/", "/app/update.json/", "/app/apk/", "/app/apk/x", "/app/apk/x.apk/y", "/app/apk/../update.json", "/app/apk/..%2fupdate.json.apk", "/app/apk/a b.apk",
      "/app/apk/" + "a".repeat(90) + ".apk", "/app/apk/.apk", "/app/apk/x.zip", "/app/other.json", "/APP/update.json", "/app/apk/a/b.apk", "/app/apk/a\\b.apk",
    ]) expect(releaseKeyFor(p), p).toBeNull();
  });
});

describe("parseRange", () => {
  it("reads only open-ended and closed byte ranges", () => {
    expect(parseRange("bytes=0-")).toEqual({ offset: 0 });
    expect(parseRange("bytes=100-199")).toEqual({ offset: 100, length: 100 });
    for (const bad of [null, "", "bytes=-5", "bytes=5-2", "bytes=1-2,3-4", "bytes=0-1000000000000000", "x"]) expect(parseRange(bad), String(bad)).toBeNull();
  });
});

describe("handleAppRelease", () => {
  it("serves the manifest with a short cache", async () => {
    const b = bucket({ "update.json": '{"versionCode":19}' });
    const r = await handleAppRelease(req(), b, "/app/update.json");
    expect(r.status).toBe(200);
    expect(await r.text()).toBe('{"versionCode":19}');
    expect(r.headers.get("content-type")).toBe("application/json");
    expect(r.headers.get("cache-control")).toBe("public, max-age=300");
    expect(r.headers.get("x-content-type-options")).toBe("nosniff");
  });

  it("serves an apk as an immutable download", async () => {
    const b = bucket({ "apk/spendrr-0.3.7.apk": "PK" });
    const r = await handleAppRelease(req(), b, "/app/apk/spendrr-0.3.7.apk");
    expect(r.status).toBe(200);
    expect(r.headers.get("content-type")).toBe("application/vnd.android.package-archive");
    expect(r.headers.get("content-disposition")).toBe('attachment; filename="spendrr-0.3.7.apk"');
    expect(r.headers.get("cache-control")).toContain("immutable");
    expect(r.headers.get("content-length")).toBe("2");
    expect(r.headers.get("accept-ranges")).toBe("bytes");
  });

  it("serves the rest of a file from where a broken download stopped", async () => {
    const b = bucket({ "apk/spendrr-0.3.7.apk": "0123456789" });
    const r = await handleAppRelease(new Request("https://spendrr.app/app/apk/x.apk", { headers: { range: "bytes=4-" } }), b, "/app/apk/spendrr-0.3.7.apk");
    expect(r.status).toBe(206);
    expect(await r.text()).toBe("456789");
    expect(r.headers.get("content-range")).toBe("bytes 4-9/10");
    expect(r.headers.get("content-length")).toBe("6");
    const mid = await handleAppRelease(new Request("https://spendrr.app/app/apk/x.apk", { headers: { range: "bytes=2-4" } }), b, "/app/apk/spendrr-0.3.7.apk");
    expect(mid.status).toBe(206);
    expect(await mid.text()).toBe("234");
    expect(mid.headers.get("content-range")).toBe("bytes 2-4/10");
  });

  it("answers 416 for a range past the end and ignores a range it does not understand", async () => {
    const b = bucket({ "apk/spendrr-0.3.7.apk": "0123456789", "update.json": "{}" });
    const past = await handleAppRelease(new Request("https://spendrr.app/x", { headers: { range: "bytes=10-" } }), b, "/app/apk/spendrr-0.3.7.apk");
    expect(past.status).toBe(416);
    for (const odd of ["bytes=-5", "bytes=1-2,4-5", "items=1-2", "bytes=5-2", "bytes=a-b"]) {
      const r = await handleAppRelease(new Request("https://spendrr.app/x", { headers: { range: odd } }), b, "/app/apk/spendrr-0.3.7.apk");
      expect(r.status, odd).toBe(200);
      expect(await r.text(), odd).toBe("0123456789");
    }
    // the manifest is never served in parts
    const m = await handleAppRelease(new Request("https://spendrr.app/x", { headers: { range: "bytes=1-" } }), b, "/app/update.json");
    expect(m.status).toBe(200);
    expect(await m.text()).toBe("{}");
  });

  it("answers HEAD without a body", async () => {
    const b = bucket({ "update.json": "{}" });
    const r = await handleAppRelease(req("HEAD"), b, "/app/update.json");
    expect(r.status).toBe(200);
    expect(await r.text()).toBe("");
  });

  it("never reads a key it was not asked for, and says 404 for anything missing", async () => {
    const b = bucket({ "update.json": "{}", secret: "x" });
    for (const p of ["/app/apk/../secret", "/app/secret", "/app/apk/missing.apk"]) {
      const r = await handleAppRelease(req(), b, p);
      expect(r.status, p).toBe(404);
    }
    expect(b.asked).toEqual(["apk/missing.apk"]);
  });

  it("is a 404 while the bucket is not set up, and only GET and HEAD are allowed", async () => {
    expect((await handleAppRelease(req(), undefined, "/app/update.json")).status).toBe(404);
    const b = bucket({ "update.json": "{}" });
    for (const m of ["POST", "PUT", "DELETE"]) expect((await handleAppRelease(req(m), b, "/app/update.json")).status).toBe(405);
    expect(b.asked).toEqual([]);
  });
});
