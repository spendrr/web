// handleBackupUploadTmp must spend the per-IP limiter BEFORE it reads the body:
// on the Workers Free plan (10 ms CPU) reading, parsing and validating up to
// 20 MB per request is what a flood would otherwise make us pay for.
import { describe, expect, it } from "vitest";
import worker from "../worker/index";

const ctx = { waitUntil() {}, passThroughOnException() {} } as never;

function upload(env: unknown, chunks: number) {
  let pulled = 0;
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      pulled++;
      if (pulled > chunks) controller.close();
      else controller.enqueue(new Uint8Array(64 * 1024).fill(65));
    },
  });
  const req = new Request("https://spendrr.app/api/backup/upload-tmp", {
    method: "POST",
    headers: { Origin: "https://spendrr.app", "CF-Connecting-IP": "203.0.113.20" },
    body,
    duplex: "half",
  } as RequestInit);
  return { res: worker.fetch(req, env as never, ctx), pulled: () => pulled };
}

describe("POST /api/backup/upload-tmp", () => {
  it("a refused IP is answered 429 without the body being read", async () => {
    const env = { BACKUP_RATE_LIMITER: { limit: async () => ({ success: false }) } };
    const { res, pulled } = upload(env, 300);
    expect((await res).status).toBe(429);
    // a ReadableStream pre-fills a chunk or two on construction; nothing like 300
    expect(pulled()).toBeLessThan(5);
  });

  it("an accepted IP has its body read (and is then judged on it)", async () => {
    const env = { BACKUP_RATE_LIMITER: { limit: async () => ({ success: true }) } };
    const { res, pulled } = upload(env, 20);
    expect((await res).status).toBe(400); // not JSON
    expect(pulled()).toBeGreaterThan(15);
  });
});
