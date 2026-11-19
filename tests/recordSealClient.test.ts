// The sheet asks for the password only where the worker says it is a boundary, and the page asks the worker for the
// list of held-back records only when its refused-read count changes (so a normal session adds no request).
import { beforeEach, describe, expect, it, vi } from "vitest";

const unverified = [{ store: "bark.v1.14", id: "ln_pay.abc", kind: "LightningSend" }];
let status = { enabled: true, unverified, needsPassword: true };
const getStatus = vi.fn(async () => status);
let sealListener: ((n: number) => void) | null = null;
vi.mock("../src/lib/wallet/bark", () => ({
  getRecordSealStatus: () => getStatus(),
  setSealCountListener: (fn: ((n: number) => void) | null) => {
    sealListener = fn;
  },
}));

const client = await import("../src/lib/wallet/recordSealClient");
const tick = () => new Promise((r) => setTimeout(r, 0));

beforeEach(() => {
  client.clearRecordSeal();
  getStatus.mockClear();
  status = { enabled: true, unverified, needsPassword: true };
});

describe("recordSealClient", () => {
  it("keeps the password requirement the worker reports", async () => {
    await client.checkRecordSeal();
    expect(client.sealNeedsPassword()).toBe(true);
    status = { ...status, needsPassword: false };
    await client.checkRecordSeal();
    expect(client.sealNeedsPassword()).toBe(false);
  });

  it("asks only when the refused-read count changes, and never for zero", async () => {
    sealListener!(0);
    await tick();
    expect(getStatus).not.toHaveBeenCalled();
    sealListener!(2);
    await tick();
    expect(getStatus).toHaveBeenCalledTimes(1);
    sealListener!(2);
    await tick();
    expect(getStatus).toHaveBeenCalledTimes(1);
    sealListener!(3);
    await tick();
    expect(getStatus).toHaveBeenCalledTimes(2);
  });

  it("a new wallet starts the count over", async () => {
    sealListener!(2);
    await tick();
    client.clearRecordSeal();
    getStatus.mockClear();
    sealListener!(2);
    await tick();
    expect(getStatus).toHaveBeenCalledTimes(1);
  });
});
