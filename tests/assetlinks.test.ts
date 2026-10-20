// Android App Links: /.well-known/assetlinks.json must name every app that may open spendrr.app links, each with the SHA-256 of the certificate its APK is signed with.
import { describe, expect, it } from "vitest";
import worker from "../worker/index";

const ctx = { waitUntil() {}, passThroughOnException() {} } as never;

describe("assetlinks.json", () => {
  it("lists the Capacitor app and the native Kotlin app", async () => {
    const res = await worker.fetch(new Request("https://spendrr.app/.well-known/assetlinks.json"), {} as never, ctx);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { relation: string[]; target: { namespace: string; package_name: string; sha256_cert_fingerprints: string[] } }[];
    const byPackage = new Map(body.map((s) => [s.target.package_name, s]));
    expect([...byPackage.keys()].sort()).toEqual(["app.spendrr.kotlin", "app.spendrr.wallet"]);
    for (const s of body) {
      expect(s.relation).toEqual(["delegate_permission/common.handle_all_urls"]);
      expect(s.target.namespace).toBe("android_app");
      for (const fp of s.target.sha256_cert_fingerprints) expect(fp).toMatch(/^([0-9A-F]{2}:){31}[0-9A-F]{2}$/);
    }
    // the Kotlin app's release certificate (apksigner verify --print-certs, 0.0.6)
    const expected = "0997f356930c7031a8d5eb01a1fc59a091fe77aba8a935742866d7035062e53b".toUpperCase().match(/../g)!.join(":");
    expect(byPackage.get("app.spendrr.kotlin")!.target.sha256_cert_fingerprints).toEqual([expected]);
  });
});
