// The relay's registrations: per mailbox its read authorization (a day or so
// of validity), that authorization's expiry, the last checkpoint seen and the
// shard that carries it, so a restart resumes every stream where it stopped.
// SQLite (node:sqlite), one file. Losing it costs nothing permanent: every app
// open registers again.
//
// node:sqlite is synchronous and runs on the event loop, so the statements are
// prepared once and WAL runs with synchronous=NORMAL (no fsync per checkpoint:
// a power cut can lose the last few, which only replays a few messages).
import { DatabaseSync, type StatementSync } from "node:sqlite";

export interface Registration {
  mailboxId: string;
  authorization: string;
  expiresAt: number;
  checkpoint: string;
  shard: string;
}

type Row = { id: string; auth: string; expires: number; checkpoint: string; shard: string };

const toRegistration = (row: Row): Registration => ({
  mailboxId: row.id,
  authorization: row.auth,
  expiresAt: Number(row.expires),
  checkpoint: row.checkpoint,
  shard: row.shard,
});

export class Store {
  private db: DatabaseSync;
  private q: Record<"get" | "all" | "put" | "checkpoint" | "remove" | "expired" | "prune" | "count", StatementSync>;
  // When this database was created: the relay is "warm" (knows every active
  // subscriber) only once it has existed longer than an authorization lives.
  readonly createdAt: number;

  constructor(path: string, nowS = Math.floor(Date.now() / 1000)) {
    this.db = new DatabaseSync(path);
    this.db.exec("PRAGMA journal_mode = WAL");
    this.db.exec("PRAGMA synchronous = NORMAL");
    this.db.exec(`CREATE TABLE IF NOT EXISTS mailboxes (
      id TEXT PRIMARY KEY,
      auth TEXT NOT NULL,
      expires INTEGER NOT NULL,
      checkpoint TEXT NOT NULL,
      shard TEXT NOT NULL
    )`);
    this.db.exec("CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
    this.db.prepare("INSERT OR IGNORE INTO meta (key, value) VALUES ('created', ?)").run(String(nowS));
    const row = this.db.prepare("SELECT value FROM meta WHERE key = 'created'").get() as { value: string } | undefined;
    this.createdAt = Number(row?.value ?? nowS);
    this.q = {
      get: this.db.prepare("SELECT id, auth, expires, checkpoint, shard FROM mailboxes WHERE id = ?"),
      all: this.db.prepare("SELECT id, auth, expires, checkpoint, shard FROM mailboxes"),
      put: this.db.prepare("INSERT OR REPLACE INTO mailboxes (id, auth, expires, checkpoint, shard) VALUES (?, ?, ?, ?, ?)"),
      checkpoint: this.db.prepare("UPDATE mailboxes SET checkpoint = ? WHERE id = ?"),
      remove: this.db.prepare("DELETE FROM mailboxes WHERE id = ?"),
      expired: this.db.prepare("SELECT id FROM mailboxes WHERE expires < ?"),
      prune: this.db.prepare("DELETE FROM mailboxes WHERE expires < ?"),
      count: this.db.prepare("SELECT COUNT(*) AS n FROM mailboxes"),
    };
  }

  // A newer registration replaces the authorization and the shard; the
  // checkpoint only moves forward (the shard may still be behind what this
  // relay already saw).
  upsert(r: Registration): Registration {
    const prev = this.get(r.mailboxId);
    const checkpoint = prev && BigInt(prev.checkpoint) > BigInt(r.checkpoint) ? prev.checkpoint : r.checkpoint;
    const keepOld = prev && prev.expiresAt > r.expiresAt;
    const next: Registration = {
      mailboxId: r.mailboxId,
      authorization: keepOld ? prev.authorization : r.authorization,
      expiresAt: keepOld ? prev.expiresAt : r.expiresAt,
      checkpoint,
      shard: r.shard,
    };
    this.q.put.run(next.mailboxId, next.authorization, next.expiresAt, next.checkpoint, next.shard);
    return next;
  }

  get(mailboxId: string): Registration | null {
    const row = this.q.get.get(mailboxId) as Row | undefined;
    return row ? toRegistration(row) : null;
  }

  all(): Registration[] {
    return (this.q.all.all() as Row[]).map(toRegistration);
  }

  count(): number {
    return Number((this.q.count.get() as { n: number }).n);
  }

  // Compared as uint64 in JS: SQLite's integers are signed 64-bit.
  setCheckpoint(mailboxId: string, checkpoint: string): void {
    const prev = this.get(mailboxId);
    if (!prev || BigInt(prev.checkpoint) >= BigInt(checkpoint)) return;
    this.q.checkpoint.run(checkpoint, mailboxId);
  }

  // Without a shard, unconditionally; with one, only while that shard owns it.
  remove(mailboxId: string, shard?: string): boolean {
    if (shard !== undefined && this.get(mailboxId)?.shard !== shard) return false;
    return Number(this.q.remove.run(mailboxId).changes) > 0;
  }

  // Registrations whose authorization ran out long ago: nobody renewed them.
  prune(olderThanS: number): { count: number; ids: string[] } {
    const ids = (this.q.expired.all(olderThanS) as { id: string }[]).map((r) => r.id);
    this.q.prune.run(olderThanS);
    return { count: ids.length, ids };
  }

  close(): void {
    this.db.close();
  }
}
