import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";

export const MONITOR_MODES = ["text_changed", "text_appears", "text_disappears"] as const;
export type MonitorMode = (typeof MONITOR_MODES)[number];

/** Health of the last check. News (a detected change) lives in the changes table. */
export type WatchStatus = "pending" | "ok" | "error";
export type ChangeKind = "changed" | "appeared" | "disappeared";

export type Watch = {
  id: number;
  label: string;
  url: string;
  cssSelector: string | null;
  monitorMode: MonitorMode;
  targetText: string;
  intervalMinutes: number;
  webhookUrl: string | null;
  isActive: boolean;
  lastStatus: WatchStatus;
  lastError: string | null;
  lastPreview: string | null;
  consecutiveErrors: number;
  lastCheckedAt: string | null;
  lastChangedAt: string | null;
  lastManualCheckAt: string | null;
  nextCheckAt: string;
  createdAt: string;
};

export type WatchSummary = Watch & { unseenChanges: number; totalChanges: number };

export type Snapshot = {
  id: number;
  watchId: number;
  contentHash: string;
  contentText: string;
  httpStatus: number | null;
  fetchedAt: string;
};

export type Change = {
  id: number;
  watchId: number;
  kind: ChangeKind;
  beforeText: string;
  afterText: string;
  summary: string;
  diff: string;
  createdAt: string;
  seenAt: string | null;
};

export type ChangeWithWatch = Change & { watchLabel: string; watchUrl: string; monitorMode: MonitorMode };

export type NewWatch = {
  label: string;
  url: string;
  cssSelector: string | null;
  monitorMode: MonitorMode;
  targetText: string;
  intervalMinutes: number;
  webhookUrl: string | null;
  isActive: boolean;
};

export type WatchPatch = Partial<
  NewWatch & {
    lastStatus: WatchStatus;
    lastError: string | null;
    lastPreview: string | null;
    consecutiveErrors: number;
    lastCheckedAt: string | null;
    lastChangedAt: string | null;
    lastManualCheckAt: string | null;
    nextCheckAt: string;
  }
>;

/**
 * Each entry runs once, in order; PRAGMA user_version remembers how far we got.
 * Append new migrations, never edit old ones.
 */
const MIGRATIONS = [
  `
  CREATE TABLE watches (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    label TEXT NOT NULL,
    url TEXT NOT NULL,
    css_selector TEXT,
    monitor_mode TEXT NOT NULL DEFAULT 'text_changed',
    target_text TEXT NOT NULL,
    interval_minutes INTEGER NOT NULL DEFAULT 60,
    webhook_url TEXT,
    is_active INTEGER NOT NULL DEFAULT 1,
    last_status TEXT NOT NULL DEFAULT 'pending',
    last_error TEXT,
    last_preview TEXT,
    consecutive_errors INTEGER NOT NULL DEFAULT 0,
    last_checked_at TEXT,
    last_changed_at TEXT,
    last_manual_check_at TEXT,
    next_check_at TEXT NOT NULL,
    created_at TEXT NOT NULL
  );
  CREATE INDEX watches_due_idx ON watches (is_active, next_check_at);

  CREATE TABLE snapshots (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    watch_id INTEGER NOT NULL REFERENCES watches(id) ON DELETE CASCADE,
    content_hash TEXT NOT NULL,
    content_text TEXT NOT NULL,
    http_status INTEGER,
    fetched_at TEXT NOT NULL
  );
  CREATE INDEX snapshots_watch_idx ON snapshots (watch_id, id);

  CREATE TABLE changes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    watch_id INTEGER NOT NULL REFERENCES watches(id) ON DELETE CASCADE,
    kind TEXT NOT NULL,
    before_text TEXT NOT NULL,
    after_text TEXT NOT NULL,
    summary TEXT NOT NULL,
    diff TEXT NOT NULL,
    created_at TEXT NOT NULL,
    seen_at TEXT
  );
  CREATE INDEX changes_watch_idx ON changes (watch_id, id);
  CREATE INDEX changes_unseen_idx ON changes (seen_at);
  `,
];

type Row = Record<string, unknown>;

const WATCH_COLUMNS: Record<keyof WatchPatch, string> = {
  label: "label",
  url: "url",
  cssSelector: "css_selector",
  monitorMode: "monitor_mode",
  targetText: "target_text",
  intervalMinutes: "interval_minutes",
  webhookUrl: "webhook_url",
  isActive: "is_active",
  lastStatus: "last_status",
  lastError: "last_error",
  lastPreview: "last_preview",
  consecutiveErrors: "consecutive_errors",
  lastCheckedAt: "last_checked_at",
  lastChangedAt: "last_changed_at",
  lastManualCheckAt: "last_manual_check_at",
  nextCheckAt: "next_check_at",
};

function toWatch(row: Row): Watch {
  return {
    id: Number(row.id),
    label: String(row.label),
    url: String(row.url),
    cssSelector: (row.css_selector as string | null) ?? null,
    monitorMode: row.monitor_mode as MonitorMode,
    targetText: String(row.target_text),
    intervalMinutes: Number(row.interval_minutes),
    webhookUrl: (row.webhook_url as string | null) ?? null,
    isActive: Number(row.is_active) === 1,
    lastStatus: row.last_status as WatchStatus,
    lastError: (row.last_error as string | null) ?? null,
    lastPreview: (row.last_preview as string | null) ?? null,
    consecutiveErrors: Number(row.consecutive_errors),
    lastCheckedAt: (row.last_checked_at as string | null) ?? null,
    lastChangedAt: (row.last_changed_at as string | null) ?? null,
    lastManualCheckAt: (row.last_manual_check_at as string | null) ?? null,
    nextCheckAt: String(row.next_check_at),
    createdAt: String(row.created_at),
  };
}

function toSnapshot(row: Row): Snapshot {
  return {
    id: Number(row.id),
    watchId: Number(row.watch_id),
    contentHash: String(row.content_hash),
    contentText: String(row.content_text),
    httpStatus: row.http_status == null ? null : Number(row.http_status),
    fetchedAt: String(row.fetched_at),
  };
}

function toChange(row: Row): Change {
  return {
    id: Number(row.id),
    watchId: Number(row.watch_id),
    kind: row.kind as ChangeKind,
    beforeText: String(row.before_text),
    afterText: String(row.after_text),
    summary: String(row.summary),
    diff: String(row.diff),
    createdAt: String(row.created_at),
    seenAt: (row.seen_at as string | null) ?? null,
  };
}

function toSql(value: unknown): SQLInputValue {
  if (typeof value === "boolean") return value ? 1 : 0;
  if (value === undefined) return null;
  return value as SQLInputValue;
}

/**
 * All persistence in one place, over the SQLite that ships with Node (node:sqlite).
 * node:sqlite is synchronous, and the whole app is one process, so every
 * method here runs to completion without interleaving with another.
 */
export class Store {
  readonly db: DatabaseSync;

  constructor(path: string) {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;");
    this.migrate();
  }

  private migrate(): void {
    const { user_version: current } = this.db.prepare("PRAGMA user_version").get() as { user_version: number };
    for (let v = current; v < MIGRATIONS.length; v++) {
      this.transaction(() => {
        this.db.exec(MIGRATIONS[v]);
        this.db.exec(`PRAGMA user_version = ${v + 1}`);
      });
    }
  }

  transaction<T>(fn: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = fn();
      this.db.exec("COMMIT");
      return result;
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }
  }

  close(): void {
    this.db.close();
  }

  // Watches

  insertWatch(input: NewWatch, now = new Date()): Watch {
    const row = this.db
      .prepare(
        `INSERT INTO watches (label, url, css_selector, monitor_mode, target_text, interval_minutes,
           webhook_url, is_active, next_check_at, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING *`
      )
      .get(
        input.label,
        input.url,
        input.cssSelector,
        input.monitorMode,
        input.targetText,
        input.intervalMinutes,
        input.webhookUrl,
        input.isActive ? 1 : 0,
        now.toISOString(),
        now.toISOString()
      ) as Row;
    return toWatch(row);
  }

  getWatch(id: number): Watch | null {
    const row = this.db.prepare("SELECT * FROM watches WHERE id = ?").get(id) as Row | undefined;
    return row ? toWatch(row) : null;
  }

  listWatches(): WatchSummary[] {
    const rows = this.db
      .prepare(
        `SELECT w.*,
           (SELECT COUNT(*) FROM changes c WHERE c.watch_id = w.id AND c.seen_at IS NULL) AS unseen_changes,
           (SELECT COUNT(*) FROM changes c WHERE c.watch_id = w.id) AS total_changes
         FROM watches w
         ORDER BY w.id DESC`
      )
      .all() as Row[];
    return rows.map((row) => ({
      ...toWatch(row),
      unseenChanges: Number(row.unseen_changes),
      totalChanges: Number(row.total_changes),
    }));
  }

  updateWatch(id: number, patch: WatchPatch): Watch | null {
    const entries = Object.entries(patch).filter(([, v]) => v !== undefined) as [keyof WatchPatch, unknown][];
    if (!entries.length) return this.getWatch(id);
    const sets = entries.map(([key]) => `${WATCH_COLUMNS[key]} = ?`).join(", ");
    const row = this.db
      .prepare(`UPDATE watches SET ${sets} WHERE id = ? RETURNING *`)
      .get(...entries.map(([, v]) => toSql(v)), id) as Row | undefined;
    return row ? toWatch(row) : null;
  }

  deleteWatch(id: number): boolean {
    return Number(this.db.prepare("DELETE FROM watches WHERE id = ?").run(id).changes) > 0;
  }

  /**
   * Picks up to `limit` due watches and pushes their next_check_at forward by
   * a lease in the same statement. A single UPDATE is atomic in SQLite, so two
   * callers can never get the same watch; if the process dies mid-check, the
   * watch becomes due again when the lease runs out instead of being lost.
   * The check itself then writes the real next_check_at.
   */
  claimDue(limit: number, leaseSeconds: number, now = new Date(), exclude: number[] = []): Watch[] {
    if (limit <= 0) return [];
    const lease = new Date(now.getTime() + leaseSeconds * 1000).toISOString();
    const skip = exclude.length ? `AND id NOT IN (${exclude.map(() => "?").join(",")})` : "";
    const rows = this.db
      .prepare(
        `UPDATE watches SET next_check_at = ?
         WHERE id IN (
           SELECT id FROM watches
           WHERE is_active = 1 AND next_check_at <= ? ${skip}
           ORDER BY next_check_at ASC
           LIMIT ?
         )
         RETURNING *`
      )
      .all(lease, now.toISOString(), ...exclude, limit) as Row[];
    return rows.map(toWatch);
  }

  // Snapshots

  latestSnapshot(watchId: number): Snapshot | null {
    const row = this.db
      .prepare("SELECT * FROM snapshots WHERE watch_id = ? ORDER BY id DESC LIMIT 1")
      .get(watchId) as Row | undefined;
    return row ? toSnapshot(row) : null;
  }

  insertSnapshot(input: Omit<Snapshot, "id">): Snapshot {
    const row = this.db
      .prepare(
        `INSERT INTO snapshots (watch_id, content_hash, content_text, http_status, fetched_at)
         VALUES (?, ?, ?, ?, ?) RETURNING *`
      )
      .get(input.watchId, input.contentHash, input.contentText, input.httpStatus, input.fetchedAt) as Row;
    return toSnapshot(row);
  }

  deleteSnapshots(watchId: number): void {
    this.db.prepare("DELETE FROM snapshots WHERE watch_id = ?").run(watchId);
  }

  /** Keeps only the newest `keep` rows of a watch in snapshots or changes. */
  prune(table: "snapshots" | "changes", watchId: number, keep: number): void {
    this.db
      .prepare(
        `DELETE FROM ${table} WHERE watch_id = ? AND id NOT IN (
           SELECT id FROM ${table} WHERE watch_id = ? ORDER BY id DESC LIMIT ?
         )`
      )
      .run(watchId, watchId, keep);
  }

  // Changes

  insertChange(input: Omit<Change, "id" | "seenAt">): Change {
    const row = this.db
      .prepare(
        `INSERT INTO changes (watch_id, kind, before_text, after_text, summary, diff, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?) RETURNING *`
      )
      .get(
        input.watchId,
        input.kind,
        input.beforeText,
        input.afterText,
        input.summary,
        input.diff,
        input.createdAt
      ) as Row;
    return toChange(row);
  }

  /** Newest first. `afterId` turns it into a feed: only changes newer than what the caller already has. */
  listChanges(opts: { watchId?: number; afterId?: number; limit?: number } = {}): ChangeWithWatch[] {
    const where: string[] = [];
    const params: SQLInputValue[] = [];
    if (opts.watchId !== undefined) {
      where.push("c.watch_id = ?");
      params.push(opts.watchId);
    }
    if (opts.afterId !== undefined) {
      where.push("c.id > ?");
      params.push(opts.afterId);
    }
    const rows = this.db
      .prepare(
        `SELECT c.*, w.label AS watch_label, w.url AS watch_url, w.monitor_mode AS watch_mode
         FROM changes c JOIN watches w ON w.id = c.watch_id
         ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
         ORDER BY c.id DESC LIMIT ?`
      )
      .all(...params, Math.min(opts.limit ?? 50, 200)) as Row[];
    return rows.map((row) => ({
      ...toChange(row),
      watchLabel: String(row.watch_label),
      watchUrl: String(row.watch_url),
      monitorMode: row.watch_mode as MonitorMode,
    }));
  }

  latestChangeId(): number {
    const row = this.db.prepare("SELECT COALESCE(MAX(id), 0) AS id FROM changes").get() as Row;
    return Number(row.id);
  }

  unseenCount(): number {
    const row = this.db.prepare("SELECT COUNT(*) AS n FROM changes WHERE seen_at IS NULL").get() as Row;
    return Number(row.n);
  }

  markSeen(watchId?: number, now = new Date()): number {
    const result =
      watchId === undefined
        ? this.db.prepare("UPDATE changes SET seen_at = ? WHERE seen_at IS NULL").run(now.toISOString())
        : this.db
            .prepare("UPDATE changes SET seen_at = ? WHERE seen_at IS NULL AND watch_id = ?")
            .run(now.toISOString(), watchId);
    return Number(result.changes);
  }
}
