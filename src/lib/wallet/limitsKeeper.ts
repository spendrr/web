// The user's spend limits and the hard-limit ledger, held in memory over an async store. Lives in the wallet
// worker (nothing here may import the SDK, so it is testable on its own). One place that settles, changes,
// checks and charges.
//
// Every operation runs under one lock (`exclusive`): a send's check-and-charge and a limits change can never
// interleave. A change is saved before it is adopted, so a failed save leaves the old limits in force.
import {
  DEFAULT_LIMITS,
  UNREADABLE_RECORD,
  applyChange,
  chargeLedger,
  checkHard,
  hardRemaining,
  pruneLedger,
  settle,
  type ChangeResult,
  type HardCheck,
  type LimitChange,
  type LimitsRecord,
  type SpendLimits,
  type SpendLimitsStatus,
} from "./spendLimits";

export type LimitsLoad = { kind: "none" } | { kind: "ok"; record: LimitsRecord } | { kind: "unreadable" };

export interface LimitsStore {
  load(): Promise<LimitsLoad>;
  save(record: LimitsRecord): Promise<void>;
}

export class SpendLimitsKeeper {
  private store: LimitsStore | null = null;
  // Open means a wallet session is active, whether or not its store could be read or even created.
  private opened = false;
  private record: LimitsRecord = UNREADABLE_RECORD;
  private unreadable = true;
  private tail: Promise<unknown> = Promise.resolve();

  // Serializes `fn` after everything already queued. A throw does not break the chain.
  exclusive<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.tail.then(fn, fn);
    this.tail = run.catch(() => undefined);
    return run;
  }

  get isOpen(): boolean {
    return this.opened;
  }

  // No store (the key could not be derived) or a store that cannot be read both end in the strict record:
  // the password for every send, no hard limit known. Never "no limits".
  open(store: LimitsStore | null): Promise<void> {
    return this.exclusive(async () => {
      this.opened = true;
      this.store = store;
      this.record = UNREADABLE_RECORD;
      this.unreadable = true;
      if (store === null) return;
      try {
        const loaded = await store.load();
        if (loaded.kind === "none") {
          this.record = { limits: DEFAULT_LIMITS, ledger: [] };
          this.unreadable = false;
        } else if (loaded.kind === "ok") {
          this.record = loaded.record;
          this.unreadable = false;
        }
      } catch (e) {
        console.error("[wallet.worker] spend limits could not be read", e);
      }
    });
  }

  close(): Promise<void> {
    return this.exclusive(async () => {
      this.opened = false;
      this.store = null;
      this.record = UNREADABLE_RECORD;
      this.unreadable = true;
    });
  }

  // The following read the record synchronously and must be called inside `exclusive`.

  limits(now: number): SpendLimits {
    return settle(this.record.limits, now);
  }

  status(now: number): SpendLimitsStatus {
    const limits = this.limits(now);
    return {
      limits,
      hardRemainingSats: limits.hardSats === null ? null : hardRemaining(this.record.ledger, limits.hardSats, now),
      oldestAt: limits.hardSats === null ? null : (pruneLedger(this.record.ledger, now)[0]?.at ?? null),
      unreadable: this.unreadable,
    };
  }

  checkHard(amountSats: number | null, now: number): HardCheck {
    return checkHard(this.record.limits, this.record.ledger, amountSats, now);
  }

  preview(change: LimitChange, now: number): ChangeResult {
    return applyChange(this.record.limits, change, now);
  }

  // Saved before adopted. Throws when the store fails or is missing: nothing changed.
  async commitLimits(next: SpendLimits, now: number): Promise<void> {
    await this.commit({ limits: next, ledger: pruneLedger(this.record.ledger, now) });
  }

  // Counts a send as made now. Before the SDK call and never refunded.
  async charge(chargeSats: number, now: number): Promise<void> {
    if (chargeSats <= 0) return;
    await this.commit({ limits: settle(this.record.limits, now), ledger: chargeLedger(this.record.ledger, chargeSats, now) });
  }

  private async commit(next: LimitsRecord): Promise<void> {
    if (this.store === null) throw new Error("limits store unavailable");
    await this.store.save(next);
    this.record = next;
    this.unreadable = false;
  }
}
