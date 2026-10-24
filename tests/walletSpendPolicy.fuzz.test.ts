// Tests for src/lib/wallet/walletSpendPolicy.ts — the wallet worker's per-target
// method allowlist and send-amount classification.
//
// The threat model this defends (see the module header and walletSession.ts):
// the main thread is treated as compromisable, and anything running there can
// post a `{type:"call", target, method, args}` message straight to the wallet
// worker, naming ANY method on the live WASM Wallet / OnchainWallet. The gate
// must therefore be an allowlist — these tests pin that it actually is one,
// and that the money-moving methods the app never calls stay unreachable.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { PASSWORD_REQUIRED_THRESHOLD_SATS } from "../src/lib/wallet/walletSession";
import {
  classifyOnchainCall,
  classifyWalletCall,
  createRefreshSubmitBudget,
  createUnauthorizedSpendBudget,
  isCallTarget,
  isGiftMethodAllowed,
  sendAmountSats,
  WALLET_ALWAYS_AUTH_METHODS,
  sanitizeWalletCallArgs,
  MAILBOX_AUTH_MAX_SECS,
  WALLET_OWN_FUNDS_METHODS,
  WALLET_READ_METHODS,
  WALLET_SEND_METHODS,
} from "../src/lib/wallet/walletSpendPolicy";

// Mirrors the WalletClient interface in src/lib/wallet/bark.ts — every wallet.*
// method the app is allowed to invoke. The bark.ts client proxy can only
// forward methods this interface declares, so this list is the complete set
// of legitimate callers. Keep in sync with bark.ts; the "every method is
// classified" test below is what catches drift.
const WALLET_CLIENT_METHODS = [
  "balance",
  "sync",
  "maintenance",
  "maintenanceDelegated",
  "history",
  "allVtxos",
  "vtxos",
  "peekAddress",
  "newAddress",
  "bolt11Invoice",
  "cancelLightningReceive",
  "payLightningInvoice",
  "payLightningAddress",
  "payLightningOffer",
  "payLnurl",
  "validateArkoorAddress",
  "sendArkoorPayment",
  "sendOnchain",
  "estimateArkoorPaymentFee",
  "estimateSendOnchainFee",
  "estimateLightningSendFee",
  "estimateBoardFee",
  "boardAll",
  "boardAmount",
  "estimateRefreshFee",
  "refreshVtxosDelegated",
  "pendingRoundStates",
  "pendingRoundInputVtxos",
  "progressPendingRounds",
  "cancelPendingRound",
  "cancelAllPendingRounds",
  "nextRoundStartTime",
  "arkInfo",
  "startExitForEntireWallet",
  "startExitForCoins",
  "progressExits",
  "getExitVtxos",
  "listClaimableExits",
  "hasPendingExits",
  "pendingExitsTotalSats",
  "cancelExit",
  "estimateEmergencyExitFee",
  "syncExitLocks",
  "drainExits",
  "signExitClaimInputs",
  "broadcastTx",
  "mailboxIdentifier",
  "mailboxAuthorization",
  "getFirstExpiringVtxoBlockheight",
  "refreshServer",
  "lockVtxos",
  "unlockVtxos",
  "refreshVtxosDelegatedAndLock",
];

// A well-formed call for the lock methods, which are only allowed under the
// refresh engine's own holder.
const ENGINE_LOCK_ARGS: Record<string, unknown[]> = {
  lockVtxos: [{ vtxoIds: ["a:0"], holder: { type: "action", id: "spendrr-refresh" } }],
  unlockVtxos: [{ vtxoIds: ["a:0"], expectedHolder: { type: "action", id: "spendrr-refresh" } }],
  refreshVtxosDelegatedAndLock: [["a:0"], "spendrr-refresh"],
};

// Mirrors the OnchainWalletClient interface in src/lib/wallet/bark.ts.
const ONCHAIN_CLIENT_METHODS = ["balance", "sync", "newAddress", "initialScan", "transactions", "tipHeight", "utxos", "feeRates"];

// SDK methods that are NOT on any client interface — reachable only by a
// crafted message. Each moves funds to a caller-chosen address in one step,
// or wrecks the WASM instance. These must never classify as anything but
// "denied".
const FORBIDDEN_WALLET_METHODS = [
  "offboardAll",
  "offboardVtxos",
  "startExitForVtxos",
  "startExitForVtxosIncludingNonStandard",
  "free",
  "boardPsbt",
  "boardFundingAddress",
  "constructor",
  "toString",
];

const FORBIDDEN_ONCHAIN_METHODS = ["send", "free", "evictTx"];

// Reads the method names straight out of bark.ts's interface declarations.
//
// The two lists above are hand-written mirrors, and a mirror cannot catch the
// one thing it most needs to: a method ADDED to the client interface and left
// unclassified, which the worker then refuses at runtime. That happened with
// pendingRoundInputVtxos (2026-09-20) and the suite stayed green, because the
// mirror simply didn't mention it — the module header's promise that these
// tests "fail if one is left unclassified" was not actually true. Parsing the
// source makes it true. Deliberately crude: it only needs to find method
// names in a block of TypeScript, and a parse that silently found nothing is
// caught by the non-empty assertion below.
function declaredMethods(interfaceName: string): string[] {
  const src = readFileSync(new URL("../src/lib/wallet/bark.ts", import.meta.url), "utf8");
  const start = src.indexOf(`export interface ${interfaceName} {`);
  if (start === -1) throw new Error(`${interfaceName} not found in bark.ts`);
  const open = src.indexOf("{", start);
  let depth = 0;
  let end = -1;
  for (let i = open; i < src.length; i++) {
    if (src[i] === "{") depth++;
    else if (src[i] === "}" && --depth === 0) {
      end = i;
      break;
    }
  }
  if (end === -1) throw new Error(`unterminated ${interfaceName} in bark.ts`);
  const body = src.slice(open + 1, end);
  const names = new Set<string>();
  for (const line of body.split("\n")) {
    const m = /^\s{2}(?:readonly\s+)?([A-Za-z_$][\w$]*)\s*\(/.exec(line);
    if (m) names.add(m[1]);
  }
  return [...names];
}

describe("client interface mirrors stay in sync with bark.ts", () => {
  it("covers every method declared on WalletClient", () => {
    const declared = declaredMethods("WalletClient");
    expect(declared.length).toBeGreaterThan(30);
    // withAuth is the one declared method that is not a forwarded wallet.*
    // call — it returns a decorated client on this side of the boundary.
    expect(declared.filter((m) => m !== "withAuth").sort()).toEqual([...WALLET_CLIENT_METHODS].sort());
  });

  it("covers every method declared on OnchainWalletClient", () => {
    const declared = declaredMethods("OnchainWalletClient");
    expect(declared.length).toBeGreaterThan(5);
    expect(declared.sort()).toEqual([...ONCHAIN_CLIENT_METHODS].sort());
  });
});

describe("classifyWalletCall — allowlist", () => {
  it("refuses SDK methods the app doesn't use (new in 0.25.0 included)", () => {
    for (const method of ["importVtxo", "importVtxos", "recoverVtxos"]) {
      expect(classifyWalletCall(method, []).kind, method).toBe("denied");
    }
  });

  it("classifies every WalletClient interface method (none left denied)", () => {
    for (const method of WALLET_CLIENT_METHODS) {
      const verdict = classifyWalletCall(method, ENGINE_LOCK_ARGS[method] ?? []);
      expect(verdict.kind, `${method} should be on the allowlist`).not.toBe("denied");
    }
  });

  it("allows VTXO locks only under the refresh engine's holders", () => {
    const ok = (method: string, arg: unknown) => classifyWalletCall(method, [arg]).kind;
    expect(ok("lockVtxos", { vtxoIds: ["x:0"], holder: { type: "action", id: "spendrr-refresh-quarantine" } })).toBe("allow");
    // No holder / someone else's holder / no expectedHolder (which would
    // release ANY lock, e.g. an in-flight Lightning send's) / junk.
    expect(ok("lockVtxos", { vtxoIds: ["x:0"] })).toBe("denied");
    expect(ok("unlockVtxos", { vtxoIds: ["x:0"] })).toBe("denied");
    expect(ok("unlockVtxos", { vtxoIds: ["x:0"], expectedHolder: { type: "movement", id: 3 } })).toBe("denied");
    expect(ok("unlockVtxos", { vtxoIds: ["x:0"], expectedHolder: { type: "action", id: "lightning-send" } })).toBe("denied");
    expect(ok("unlockVtxos", { vtxoIds: [1], expectedHolder: { type: "action", id: "spendrr-refresh" } })).toBe("denied");
    expect(ok("unlockVtxos", null)).toBe("denied");
    fc.assert(
      fc.property(fc.anything(), (arg) => {
        const v = classifyWalletCall("unlockVtxos", [arg]).kind;
        if (v === "allow") {
          const h = (arg as { expectedHolder: { type: string; id: string } }).expectedHolder;
          expect(h.type).toBe("action");
          expect(h.id.startsWith("spendrr-refresh")).toBe(true);
        }
      }),
    );
  });

  it("refreshVtxosDelegatedAndLock only locks under the engine's refresh holder", () => {
    expect(classifyWalletCall("refreshVtxosDelegatedAndLock", [["a:0"], "spendrr-refresh"]).kind).toBe("allow");
    expect(classifyWalletCall("refreshVtxosDelegatedAndLock", [["a:0"], "spendrr-refresh-quarantine"]).kind).toBe("denied");
    expect(classifyWalletCall("refreshVtxosDelegatedAndLock", [["a:0"], "lightning"]).kind).toBe("denied");
    expect(classifyWalletCall("refreshVtxosDelegatedAndLock", [[1], "spendrr-refresh"]).kind).toBe("denied");
    expect(classifyWalletCall("refreshVtxosDelegatedAndLock", []).kind).toBe("denied");
  });

  it("denies SDK methods the app never calls", () => {
    for (const method of FORBIDDEN_WALLET_METHODS) {
      expect(classifyWalletCall(method, ["bc1qattacker", 1_000_000_000]).kind, method).toBe("denied");
    }
  });

  it("denies arbitrary unknown method names", () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 40 }), fc.array(fc.anything(), { maxLength: 4 }), (method, args) => {
        const known =
          WALLET_READ_METHODS.has(method) ||
          WALLET_OWN_FUNDS_METHODS.has(method) ||
          WALLET_SEND_METHODS.has(method) ||
          WALLET_ALWAYS_AUTH_METHODS.has(method);
        if (known) return;
        expect(classifyWalletCall(method, args).kind).toBe("denied");
      }),
    );
  });

  it("never throws for arbitrary input", () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 60 }), fc.array(fc.anything(), { maxLength: 6 }), (method, args) => {
        expect(() => classifyWalletCall(method, args)).not.toThrow();
      }),
    );
  });
});

describe("classifyWalletCall — spend authorization", () => {
  it("always requires auth for the sign/broadcast/whole-wallet-exit methods", () => {
    for (const method of ["broadcastTx", "signExitClaimInputs", "startExitForEntireWallet", "startExitForCoins", "drainExits", "cancelExit"]) {
      expect(classifyWalletCall(method, []).kind, method).toBe("needs-auth");
    }
  });

  it("requires auth for a send at or above the password threshold", () => {
    expect(classifyWalletCall("sendArkoorPayment", ["ark1x", PASSWORD_REQUIRED_THRESHOLD_SATS]).kind).toBe("needs-auth");
    expect(classifyWalletCall("sendOnchain", ["bc1x", PASSWORD_REQUIRED_THRESHOLD_SATS + 1]).kind).toBe("needs-auth");
    expect(classifyWalletCall("payLightningAddress", [{ amountSats: 5_000_000 }]).kind).toBe("needs-auth");
  });

  it("requires auth for a send whose amount cannot be read from the arguments", () => {
    // No amountSats and no decodable invoice — treated as large, never as zero.
    expect(classifyWalletCall("sendArkoorPayment", ["ark1x"]).kind).toBe("needs-auth");
    expect(classifyWalletCall("payLightningInvoice", [{}]).kind).toBe("needs-auth");
    expect(classifyWalletCall("payLnurl", [{}]).kind).toBe("needs-auth");
  });

  it("caps (does not free-pass) a sub-threshold send", () => {
    const verdict = classifyWalletCall("sendArkoorPayment", ["ark1x", 10_000]);
    expect(verdict).toEqual({ kind: "capped", amountSats: 10_000 });
  });

  it("treats board/refresh (own-funds moves) as allow", () => {
    expect(classifyWalletCall("boardAll", []).kind).toBe("allow");
    expect(classifyWalletCall("boardAmount", [50_000]).kind).toBe("allow");
    expect(classifyWalletCall("refreshVtxosDelegated", [["v1"]]).kind).toBe("allow");
  });

  it("requires auth for drainExits: bark returns it already signed", () => {
    // Exit::drain_exits signs the claim itself (exit/mod.rs, create_psbt), so
    // the result is a spendable transaction to whatever address was asked.
    expect(classifyWalletCall("drainExits", [{ vtxoIds: ["v1"], address: "bc1qattacker" }]).kind).toBe("needs-auth");
    expect(classifyWalletCall("drainExits", [{ vtxoIds: [], address: "bc1qattacker" }]).kind).toBe("needs-auth");
  });

  it("allows the exit bookkeeping reads", () => {
    expect(classifyWalletCall("estimateEmergencyExitFee", [[], null, null]).kind).toBe("allow");
    expect(classifyWalletCall("syncExitLocks", []).kind).toBe("allow");
  });

  it("negative / NaN / non-number amounts are unreadable ⇒ needs-auth, never capped low", () => {
    for (const bad of [-1, NaN, Infinity, "100", null, undefined, {}]) {
      expect(classifyWalletCall("sendArkoorPayment", ["ark1x", bad]).kind, String(bad)).toBe("needs-auth");
    }
  });
});

describe("isCallTarget", () => {
  it("accepts exactly the two real targets", () => {
    expect(isCallTarget("wallet")).toBe(true);
    expect(isCallTarget("onchain")).toBe(true);
  });

  it("refuses everything else, so the target-keyed controls cannot be skipped", () => {
    for (const t of ["x", "", "Wallet", "wallet ", "__proto__", "constructor", undefined, null, 0, {}, ["wallet"]]) {
      expect(isCallTarget(t)).toBe(false);
    }
    fc.assert(fc.property(fc.anything().filter((v) => v !== "wallet" && v !== "onchain"), (t) => !isCallTarget(t)));
  });
});

describe("classifyOnchainCall", () => {
  it("allows every OnchainWalletClient interface method", () => {
    for (const method of ONCHAIN_CLIENT_METHODS) {
      expect(classifyOnchainCall(method).kind, method).toBe("allow");
    }
  });

  it("denies OnchainWallet.send and every other non-read method", () => {
    for (const method of FORBIDDEN_ONCHAIN_METHODS) {
      expect(classifyOnchainCall(method).kind, method).toBe("denied");
    }
  });

  it("denies arbitrary unknown names", () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 40 }), (method) => {
        if (ONCHAIN_CLIENT_METHODS.includes(method)) return;
        expect(classifyOnchainCall(method).kind).toBe("denied");
      }),
    );
  });
});

describe("isGiftMethodAllowed", () => {
  it("allows exactly the claim/reclaim flow's five methods", () => {
    for (const method of ["newAddress", "sync", "maintenance", "balance", "sendArkoorPayment"]) {
      expect(isGiftMethodAllowed(method), method).toBe(true);
    }
  });

  it("denies offboardAll / free / everything else", () => {
    for (const method of ["offboardAll", "offboardVtxos", "free", "broadcastTx", "drainExits", "sendOnchain", "xyz"]) {
      expect(isGiftMethodAllowed(method), method).toBe(false);
    }
  });
});

describe("sendAmountSats", () => {
  it("reads the positional amount for ark/onchain sends", () => {
    expect(sendAmountSats("sendArkoorPayment", ["addr", 1234])).toBe(1234);
    expect(sendAmountSats("sendOnchain", ["addr", 1234])).toBe(1234);
  });

  it("reads amountSats from the options object for lightning address/lnurl/offer", () => {
    expect(sendAmountSats("payLightningAddress", [{ amountSats: 999 }])).toBe(999);
    expect(sendAmountSats("payLnurl", [{ amountSats: 999 }])).toBe(999);
  });

  it("returns null (⇒ treated as large) for a non-send method or unreadable args", () => {
    expect(sendAmountSats("balance", [])).toBeNull();
    expect(sendAmountSats("sendArkoorPayment", ["addr"])).toBeNull();
    expect(sendAmountSats("sendArkoorPayment", ["addr", -5])).toBeNull();
  });

  it("never throws for arbitrary input", () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 30 }), fc.array(fc.anything(), { maxLength: 4 }), (method, args) => {
        expect(() => sendAmountSats(method, args)).not.toThrow();
      }),
    );
  });
});

describe("createUnauthorizedSpendBudget", () => {
  const DAY = 24 * 60 * 60 * 1000;

  it("charges up front and refuses past the cap", () => {
    const b = createUnauthorizedSpendBudget(100_000, DAY);
    b.bindToSeed("a");
    expect(b.tryReserve(60_000, 1)).toBe(true);
    expect(b.tryReserve(40_000, 2)).toBe(true);
    expect(b.tryReserve(1, 3)).toBe(false);
  });

  it("keeps the budget when the same wallet is reopened", () => {
    const b = createUnauthorizedSpendBudget(100_000, DAY);
    b.bindToSeed("a");
    expect(b.tryReserve(100_000, 1)).toBe(true);
    b.bindToSeed("a");
    expect(b.tryReserve(1, 2)).toBe(false);
  });

  it("starts from zero for a different wallet and after the window", () => {
    const b = createUnauthorizedSpendBudget(100_000, DAY);
    b.bindToSeed("a");
    expect(b.tryReserve(100_000, 1)).toBe(true);
    b.bindToSeed("b");
    expect(b.tryReserve(100_000, 2)).toBe(true);
    expect(b.tryReserve(1, 3)).toBe(false);
    expect(b.tryReserve(100_000, 3 + DAY)).toBe(true);
  });

  it("never lets the total inside one window exceed the cap", () => {
    fc.assert(
      fc.property(fc.array(fc.integer({ min: 0, max: 150_000 }), { maxLength: 50 }), (amounts) => {
        const b = createUnauthorizedSpendBudget(100_000, DAY);
        b.bindToSeed("a");
        let total = 0;
        amounts.forEach((a, i) => {
          if (b.tryReserve(a, 1 + i)) total += a;
        });
        return total <= 100_000;
      }),
    );
  });
});

describe("createRefreshSubmitBudget", () => {
  it("allows 6 submissions per rolling 24 h, per seed", () => {
    const day = 24 * 60 * 60 * 1000;
    const b = createRefreshSubmitBudget(6, day);
    b.bindToSeed("a");
    for (let i = 0; i < 6; i++) expect(b.tryCharge(1000 + i)).toBe(true);
    expect(b.tryCharge(2000)).toBe(false);
    expect(b.tryCharge(1000 + day)).toBe(true);
    // Rebinding the same seed keeps the count (a relock can't refill it).
    b.bindToSeed("a");
    expect(b.tryCharge(1000 + day)).toBe(false);
    b.bindToSeed("b");
    expect(b.tryCharge(1000 + day)).toBe(true);
  });
});

describe("sanitizeWalletCallArgs (external audit 2026-09-27, H1)", () => {
  it("drops any fee rate a caller passes to progressExits", () => {
    expect(sanitizeWalletCallArgs("progressExits", [{ feeRateSatPerVb: 5000 }])).toEqual([{}]);
    expect(sanitizeWalletCallArgs("progressExits", [])).toEqual([{}]);
  });
  it("leaves other calls alone", () => {
    const args = [{ vtxoIds: ["a"] }];
    expect(sanitizeWalletCallArgs("getExitVtxos", args)).toBe(args);
  });

  it("caps a mailbox authorization's lifetime", () => {
    expect(sanitizeWalletCallArgs("mailboxAuthorization", [86_400])).toEqual([86_400]);
    expect(sanitizeWalletCallArgs("mailboxAuthorization", [600.7])).toEqual([600]);
    expect(sanitizeWalletCallArgs("mailboxAuthorization", [365 * 86_400])).toEqual([MAILBOX_AUTH_MAX_SECS]);
    for (const bad of [undefined, 0, -5, Number.NaN, Number.POSITIVE_INFINITY, "86400", null]) {
      expect(sanitizeWalletCallArgs("mailboxAuthorization", [bad])).toEqual([MAILBOX_AUTH_MAX_SECS]);
    }
  });

  it("drainExits never sweeps every exit", () => {
    expect(sanitizeWalletCallArgs("drainExits", [{ vtxoIds: [], drainAll: true, address: "bc1q" }])).toEqual([
      { vtxoIds: [], address: "bc1q" },
    ]);
    expect(sanitizeWalletCallArgs("drainExits", [{ vtxoIds: ["a"], address: "bc1q" }])).toEqual([{ vtxoIds: ["a"], address: "bc1q" }]);
  });
});

// The worker indexes the live WASM object with the method name after the gate
// (`target[msg.method]`). A name the gate waves through that exists on every
// object (constructor, toString, __proto__, ...) would reach that lookup, so
// every inherited name must be refused by all three allowlists, not just the
// two the wallet list happens to spell out.
describe("inherited property names never pass an allowlist", () => {
  const inherited = [
    ...new Set([
      ...Object.getOwnPropertyNames(Object.prototype),
      ...Object.getOwnPropertyNames(Function.prototype),
      "__proto__",
      "prototype",
      "then",
    ]),
  ];

  it("has names to check", () => {
    expect(inherited.length).toBeGreaterThan(8);
  });

  it("wallet calls are denied, with no arguments and with an amount", () => {
    for (const name of inherited) {
      expect(classifyWalletCall(name, []), name).toEqual({ kind: "denied" });
      expect(classifyWalletCall(name, [1]), name).toEqual({ kind: "denied" });
    }
  });

  it("onchain calls are denied", () => {
    for (const name of inherited) expect(classifyOnchainCall(name), name).toEqual({ kind: "denied" });
  });

  it("gift calls are not allowed", () => {
    for (const name of inherited) expect(isGiftMethodAllowed(name), name).toBe(false);
  });
});

