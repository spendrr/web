import { describe, expect, it } from "vitest";
import { CONFIG, MAX_FEE_RATE_SAT_VB, capFeeEstimates } from "../src/lib/wallet/walletWorkerGuard";

const url = `${CONFIG.esploraAddress}/fee-estimates`;

function answer(body: string, at = url): Response {
  const res = new Response(body, { status: 200, headers: { "content-type": "application/json" } });
  Object.defineProperty(res, "url", { value: at });
  return res;
}

describe("esplora fee estimates are capped", () => {
  it("lowers every rate above the cap and keeps the rest", async () => {
    const out = await capFeeEstimates("GET", url, answer(JSON.stringify({ "1": 5000, "3": 12.5, "6": 1001 })));
    expect(await out.json()).toEqual({ "1": MAX_FEE_RATE_SAT_VB, "3": 12.5, "6": MAX_FEE_RATE_SAT_VB });
    expect(out.url).toBe(url);
  });

  it("leaves other paths, methods, failures and non-JSON alone", async () => {
    const body = JSON.stringify({ "1": 5000 });
    const tip = `${CONFIG.esploraAddress}/blocks/tip/height`;
    expect(await (await capFeeEstimates("GET", tip, answer(body, tip))).text()).toBe(body);
    expect(await (await capFeeEstimates("POST", url, answer(body))).text()).toBe(body);
    expect(await (await capFeeEstimates("GET", url, answer("not json"))).text()).toBe("not json");
    const other = "https://example.com/fee-estimates";
    expect(await (await capFeeEstimates("GET", other, answer(body, other))).text()).toBe(body);
    const failed = new Response(body, { status: 502 });
    expect(await capFeeEstimates("GET", url, failed)).toBe(failed);
  });
});
