// SQLite-backed append-only event log for Frontier OS.
//
// Database lives at ~/.frontier/ledger.db by default. The directory is
// auto-created on first write. Each event is append-only — the ledger
// exposes no update or delete APIs beyond explicit archival (not yet built).
//
// Schema migrations are managed via a meta.schema_version row. Bumping
// the version means writing a migration function, not rewriting the store.

import Database from "better-sqlite3";
import type { Database as SqliteDb, Statement } from "better-sqlite3";
import {
  closeSync,
  fstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  statSync,
  writeSync,
  fsyncSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { homedir } from "node:os";
import { gzipSync, gunzipSync } from "node:zlib";

import {
  newEventId,
  type EventInput,
  type LedgerEvent,
  type SessionInit,
  type SessionSummary,
} from "./events.ts";

const CURRENT_SCHEMA_VERSION = 1;

const SCHEMA_DDL = `
CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  session_id   TEXT PRIMARY KEY,
  started_at   TEXT NOT NULL,
  label        TEXT,
  tags         TEXT NOT NULL DEFAULT '[]',
  last_event_at TEXT
);

CREATE TABLE IF NOT EXISTS events (
  event_id   TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  offset     INTEGER NOT NULL,
  ts         TEXT NOT NULL,
  kind       TEXT NOT NULL,
  actor      TEXT,
  trace_id   TEXT,
  payload    TEXT NOT NULL,
  FOREIGN KEY (session_id) REFERENCES sessions(session_id),
  UNIQUE (session_id, offset)
);

CREATE INDEX IF NOT EXISTS idx_events_session ON events(session_id, offset);
CREATE INDEX IF NOT EXISTS idx_events_ts ON events(ts);
CREATE INDEX IF NOT EXISTS idx_events_kind ON events(kind);
CREATE INDEX IF NOT EXISTS idx_sessions_started ON sessions(started_at DESC);
`;

export function defaultLedgerPath(): string {
  return resolve(homedir(), ".frontier", "ledger.db");
}

export function defaultArchiveDir(): string {
  return resolve(homedir(), ".frontier", "archive");
}

const FRONTIER_VERSION = "0.1.0";
const ARCHIVE_HEADER_VERSION = 1;

export interface ArchiveOptions {
  /** Archive events strictly older than this ISO 8601 timestamp. */
  beforeTs: string;
  /** Directory to write the sidecar file. Default: ~/.frontier/archive/ */
  archiveDir?: string;
  /** If true, compute counts + write sidecar but DO NOT delete anything. */
  dryRun?: boolean;
}

export interface ArchiveResult {
  beforeTs: string;
  archiveFile: string | null; // null in dry-run
  archivedSessionIds: string[]; // sessions whose ALL events were archived (can be cleaned up)
  archivedEventCount: number;
  deletedEventCount: number; // 0 in dry-run
  deletedSessionCount: number; // 0 in dry-run
  bytesWritten: number; // 0 in dry-run
  durationMs: number;
  dryRun: boolean;
}

interface ArchiveSessionRow {
  sessionId: string;
  startedAt: string;
  label: string | null;
  tags: string;
  lastEventAt: string | null;
}

/**
 * Sidecar file format (JSONL, gzipped):
 *   line 1         : header        { version, createdAt, beforeTs, frontierVersion }
 *   lines 2..N     : events        { eventId, sessionId, offset, ts, kind, actor, traceId, payload }
 *                    one per event, chronological (ORDER BY ts, offset)
 *   lines N+1..M   : fully-archived session rows, one per line as
 *                    { _session: { sessionId, startedAt, label, tags, lastEventAt } }
 *
 * Sessions are written as a dedicated trailing section (rather than
 * interleaved with their events) so the reader can stream events
 * chronologically without having to filter session markers out of the
 * event stream.
 */
function slugIsoTs(iso: string): string {
  return iso.replace(/[^a-zA-Z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}

function archiveFileName(beforeTs: string, nowIso: string): string {
  return `frontier-archive-${slugIsoTs(beforeTs)}-${slugIsoTs(nowIso)}.jsonl.gz`;
}

export class LedgerStore {
  private db: SqliteDb;
  private insertSession!: Statement;
  private touchSession!: Statement;
  private getSession!: Statement;
  private listSessionsStmt!: Statement;
  private insertEvent!: Statement;
  private nextOffset!: Statement;
  private appendEventTx!: (evt: EventInput) => LedgerEvent;
  private selectEvents!: Statement;
  private selectEventsByKind!: Statement;
  private selectRecentEvents!: Statement;
  private selectEventsInRange!: Statement;
  private selectEventsByKindInRange!: Statement;

  constructor(dbPath: string = defaultLedgerPath()) {
    mkdirSync(dirname(dbPath), { recursive: true });
    this.db = new Database(dbPath);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("synchronous = NORMAL");
    this.db.pragma("foreign_keys = ON");
    this.db.pragma("busy_timeout = 5000");
    this.db.exec(SCHEMA_DDL);
    this.ensureSchemaVersion();
    this.prepareStatements();
  }

  private ensureSchemaVersion(): void {
    const row = this.db
      .prepare("SELECT value FROM meta WHERE key = 'schema_version'")
      .get() as { value: string } | undefined;
    if (!row) {
      this.db
        .prepare("INSERT INTO meta(key, value) VALUES ('schema_version', ?)")
        .run(String(CURRENT_SCHEMA_VERSION));
      return;
    }
    const current = Number(row.value);
    if (current > CURRENT_SCHEMA_VERSION) {
      throw new Error(
        `ledger schema version ${current} is newer than supported (${CURRENT_SCHEMA_VERSION}); upgrade frontier-os`,
      );
    }
    // Future migrations go here when CURRENT_SCHEMA_VERSION > current.
  }

  private prepareStatements(): void {
    this.insertSession = this.db.prepare(
      `INSERT OR IGNORE INTO sessions(session_id, started_at, label, tags)
       VALUES (?, ?, ?, ?)`,
    );
    this.touchSession = this.db.prepare(
      `UPDATE sessions SET last_event_at = ? WHERE session_id = ?`,
    );
    this.getSession = this.db.prepare(
      `SELECT session_id as sessionId, started_at as startedAt,
              label, tags, last_event_at as lastEventAt,
              (SELECT COUNT(*) FROM events e WHERE e.session_id = sessions.session_id) as eventCount
       FROM sessions WHERE session_id = ?`,
    );
    this.listSessionsStmt = this.db.prepare(
      `SELECT session_id as sessionId, started_at as startedAt,
              label, tags, last_event_at as lastEventAt,
              (SELECT COUNT(*) FROM events e WHERE e.session_id = sessions.session_id) as eventCount
       FROM sessions
       ORDER BY started_at DESC
       LIMIT ?`,
    );
    this.insertEvent = this.db.prepare(
      `INSERT INTO events(event_id, session_id, offset, ts, kind, actor, trace_id, payload)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    this.nextOffset = this.db.prepare(
      `SELECT COALESCE(MAX(offset), -1) + 1 as next FROM events WHERE session_id = ?`,
    );
    this.selectEvents = this.db.prepare(
      `SELECT event_id as eventId, session_id as sessionId, offset, ts, kind,
              actor, trace_id as traceId, payload
       FROM events
       WHERE session_id = ? AND offset >= ?
       ORDER BY offset ASC
       LIMIT ?`,
    );
    this.selectEventsByKind = this.db.prepare(
      `SELECT event_id as eventId, session_id as sessionId, offset, ts, kind,
              actor, trace_id as traceId, payload
       FROM events
       WHERE kind = ?
       ORDER BY ts DESC
       LIMIT ?`,
    );
    this.selectRecentEvents = this.db.prepare(
      `SELECT event_id as eventId, session_id as sessionId, offset, ts, kind,
              actor, trace_id as traceId, payload
       FROM events
       ORDER BY ts DESC
       LIMIT ?`,
    );
    this.selectEventsInRange = this.db.prepare(
      `SELECT event_id as eventId, session_id as sessionId, offset, ts, kind,
              actor, trace_id as traceId, payload
       FROM events
       WHERE ts >= ? AND ts < ?
       ORDER BY ts ASC`,
    );
    this.selectEventsByKindInRange = this.db.prepare(
      `SELECT event_id as eventId, session_id as sessionId, offset, ts, kind,
              actor, trace_id as traceId, payload
       FROM events
       WHERE kind = ? AND ts >= ? AND ts < ?
       ORDER BY ts ASC`,
    );

    const appendEventTx = this.db.transaction((evt: EventInput): LedgerEvent => {
      const row = this.nextOffset.get(evt.sessionId) as { next: number };
      const offset = row.next;
      const eventId = newEventId();
      const ts = new Date().toISOString();
      const payload = JSON.stringify(evt.payload);
      this.insertEvent.run(
        eventId,
        evt.sessionId,
        offset,
        ts,
        evt.kind,
        evt.actor ?? null,
        evt.traceId ?? null,
        payload,
      );
      this.touchSession.run(ts, evt.sessionId);
      return {
        eventId,
        sessionId: evt.sessionId,
        offset,
        ts,
        kind: evt.kind,
        actor: evt.actor ?? null,
        traceId: evt.traceId ?? null,
        payload: evt.payload,
      };
    });
    this.appendEventTx = appendEventTx.immediate;
  }

  ensureSession(init: SessionInit): void {
    const startedAt = new Date().toISOString();
    const tagsJson = JSON.stringify(init.tags ?? []);
    this.insertSession.run(
      init.sessionId,
      startedAt,
      init.label ?? null,
      tagsJson,
    );
  }

  appendEvent(evt: EventInput): LedgerEvent {
    return this.appendEventTx(evt);
  }

  getEvents(
    sessionId: string,
    opts: { offset?: number; limit?: number } = {},
  ): LedgerEvent[] {
    const offset = opts.offset ?? 0;
    const limit = opts.limit ?? 1000;
    const rows = this.selectEvents.all(sessionId, offset, limit) as Array<{
      eventId: string;
      sessionId: string;
      offset: number;
      ts: string;
      kind: string;
      actor: string | null;
      traceId: string | null;
      payload: string;
    }>;
    return rows.map((r) => ({
      ...r,
      kind: r.kind as LedgerEvent["kind"],
      payload: JSON.parse(r.payload),
    }));
  }

  getSessionSummary(sessionId: string): SessionSummary | null {
    const row = this.getSession.get(sessionId) as
      | {
          sessionId: string;
          startedAt: string;
          label: string | null;
          tags: string;
          lastEventAt: string | null;
          eventCount: number;
        }
      | undefined;
    if (!row) return null;
    return {
      sessionId: row.sessionId,
      startedAt: row.startedAt,
      label: row.label,
      tags: JSON.parse(row.tags),
      lastEventAt: row.lastEventAt,
      eventCount: row.eventCount,
    };
  }

  listSessions(limit: number = 50): SessionSummary[] {
    const rows = this.listSessionsStmt.all(limit) as Array<{
      sessionId: string;
      startedAt: string;
      label: string | null;
      tags: string;
      lastEventAt: string | null;
      eventCount: number;
    }>;
    return rows.map((r) => ({
      sessionId: r.sessionId,
      startedAt: r.startedAt,
      label: r.label,
      tags: JSON.parse(r.tags),
      lastEventAt: r.lastEventAt,
      eventCount: r.eventCount,
    }));
  }

  findEventsByKind(kind: string, limit: number = 100): LedgerEvent[] {
    const rows = this.selectEventsByKind.all(kind, limit) as Array<{
      eventId: string;
      sessionId: string;
      offset: number;
      ts: string;
      kind: string;
      actor: string | null;
      traceId: string | null;
      payload: string;
    }>;
    return rows.map((r) => ({
      ...r,
      kind: r.kind as LedgerEvent["kind"],
      payload: JSON.parse(r.payload),
    }));
  }

  recentEvents(limit: number = 100): LedgerEvent[] {
    const rows = this.selectRecentEvents.all(limit) as Array<{
      eventId: string;
      sessionId: string;
      offset: number;
      ts: string;
      kind: string;
      actor: string | null;
      traceId: string | null;
      payload: string;
    }>;
    return rows.map((r) => ({
      ...r,
      kind: r.kind as LedgerEvent["kind"],
      payload: JSON.parse(r.payload),
    }));
  }

  /** All events with `since <= ts < until`, ordered chronologically. */
  findEventsInRange(since: string, until: string): LedgerEvent[] {
    const rows = this.selectEventsInRange.all(since, until) as Array<{
      eventId: string;
      sessionId: string;
      offset: number;
      ts: string;
      kind: string;
      actor: string | null;
      traceId: string | null;
      payload: string;
    }>;
    return rows.map((r) => ({
      ...r,
      kind: r.kind as LedgerEvent["kind"],
      payload: JSON.parse(r.payload),
    }));
  }

  /** All events of a specific kind within a time range, chronological. */
  findEventsByKindInRange(
    kind: string,
    since: string,
    until: string,
  ): LedgerEvent[] {
    const rows = this.selectEventsByKindInRange.all(
      kind,
      since,
      until,
    ) as Array<{
      eventId: string;
      sessionId: string;
      offset: number;
      ts: string;
      kind: string;
      actor: string | null;
      traceId: string | null;
      payload: string;
    }>;
    return rows.map((r) => ({
      ...r,
      kind: r.kind as LedgerEvent["kind"],
      payload: JSON.parse(r.payload),
    }));
  }

  stats(): {
    totalSessions: number;
    totalEvents: number;
    byKind: Record<string, number>;
  } {
    const { c: sessions } = this.db
      .prepare("SELECT COUNT(*) as c FROM sessions")
      .get() as { c: number };
    const { c: events } = this.db
      .prepare("SELECT COUNT(*) as c FROM events")
      .get() as { c: number };
    const byKindRows = this.db
      .prepare(
        "SELECT kind, COUNT(*) as c FROM events GROUP BY kind ORDER BY c DESC",
      )
      .all() as Array<{ kind: string; c: number }>;
    const byKind: Record<string, number> = {};
    for (const r of byKindRows) byKind[r.kind] = r.c;
    return { totalSessions: sessions, totalEvents: events, byKind };
  }

  /**
   * Move events strictly older than `beforeTs` into a gzipped JSONL sidecar
   * file, then delete the archived rows from the live database.
   *
   * Ordering:
   *   1. SELECT rows to archive.
   *   2. Write sidecar file synchronously, fsync it.
   *   3. In a transaction: DELETE events, DELETE fully-emptied sessions.
   *   4. wal_checkpoint(TRUNCATE) to compact the WAL file.
   *
   * If the sidecar write fails we throw before deleting anything. If the
   * delete transaction fails, better-sqlite3 rolls it back atomically —
   * the sidecar is still on disk as a safe snapshot.
   */
  archive(opts: ArchiveOptions): ArchiveResult {
    const startedAt = Date.now();
    const beforeTs = opts.beforeTs;
    const dryRun = opts.dryRun ?? false;
    const archiveDir = opts.archiveDir ?? defaultArchiveDir();

    // 1. Collect events to archive (chronological order).
    const eventRows = this.db
      .prepare(
        `SELECT event_id as eventId, session_id as sessionId, offset, ts, kind,
                actor, trace_id as traceId, payload
         FROM events
         WHERE ts < ?
         ORDER BY ts ASC, offset ASC`,
      )
      .all(beforeTs) as Array<{
      eventId: string;
      sessionId: string;
      offset: number;
      ts: string;
      kind: string;
      actor: string | null;
      traceId: string | null;
      payload: string;
    }>;

    const archivedEventCount = eventRows.length;

    // 2. Identify sessions whose *all* events would be archived. A session
    // is a cleanup candidate if its total event count equals the number of
    // events in the archive set for that session.
    const archivedPerSession = new Map<string, number>();
    for (const r of eventRows) {
      archivedPerSession.set(
        r.sessionId,
        (archivedPerSession.get(r.sessionId) ?? 0) + 1,
      );
    }
    const archivedSessionIds: string[] = [];
    const cleanableSessionRows: ArchiveSessionRow[] = [];
    if (archivedPerSession.size > 0) {
      const sessionCountStmt = this.db.prepare(
        `SELECT COUNT(*) as c FROM events WHERE session_id = ?`,
      );
      const sessionRowStmt = this.db.prepare(
        `SELECT session_id as sessionId, started_at as startedAt,
                label, tags, last_event_at as lastEventAt
         FROM sessions WHERE session_id = ?`,
      );
      for (const [sessionId, archivedN] of archivedPerSession) {
        const { c: totalN } = sessionCountStmt.get(sessionId) as { c: number };
        if (totalN === archivedN) {
          archivedSessionIds.push(sessionId);
          const row = sessionRowStmt.get(sessionId) as
            | ArchiveSessionRow
            | undefined;
          if (row) cleanableSessionRows.push(row);
        }
      }
    }

    // 3. Dry run short-circuits before touching the filesystem.
    if (dryRun) {
      return {
        beforeTs,
        archiveFile: null,
        archivedSessionIds,
        archivedEventCount,
        deletedEventCount: 0,
        deletedSessionCount: 0,
        bytesWritten: 0,
        durationMs: Date.now() - startedAt,
        dryRun: true,
      };
    }

    // Nothing to archive — return early with a null archive file so callers
    // can cheaply poll for work.
    if (archivedEventCount === 0) {
      return {
        beforeTs,
        archiveFile: null,
        archivedSessionIds: [],
        archivedEventCount: 0,
        deletedEventCount: 0,
        deletedSessionCount: 0,
        bytesWritten: 0,
        durationMs: Date.now() - startedAt,
        dryRun: false,
      };
    }

    // 4. Build sidecar JSONL content.
    mkdirSync(archiveDir, { recursive: true });
    const nowIso = new Date().toISOString();
    const header = {
      version: ARCHIVE_HEADER_VERSION,
      createdAt: nowIso,
      beforeTs,
      frontierVersion: FRONTIER_VERSION,
    };
    const lines: string[] = [];
    lines.push(JSON.stringify(header));
    for (const r of eventRows) {
      lines.push(
        JSON.stringify({
          eventId: r.eventId,
          sessionId: r.sessionId,
          offset: r.offset,
          ts: r.ts,
          kind: r.kind,
          actor: r.actor,
          traceId: r.traceId,
          payload: JSON.parse(r.payload),
        }),
      );
    }
    for (const s of cleanableSessionRows) {
      lines.push(
        JSON.stringify({
          _session: {
            sessionId: s.sessionId,
            startedAt: s.startedAt,
            label: s.label,
            tags: JSON.parse(s.tags),
            lastEventAt: s.lastEventAt,
          },
        }),
      );
    }
    const jsonl = lines.join("\n") + "\n";
    const gzipped = gzipSync(Buffer.from(jsonl, "utf8"));

    // 5. Write + fsync the sidecar before touching the DB.
    const archiveFile = join(archiveDir, archiveFileName(beforeTs, nowIso));
    const fd = openSync(archiveFile, "w");
    try {
      writeSync(fd, gzipped, 0, gzipped.length, 0);
      fsyncSync(fd);
      const stat = fstatSync(fd);
      if (stat.size !== gzipped.length) {
        throw new Error(
          `archive sidecar byte count mismatch: wrote ${gzipped.length}, on-disk ${stat.size}`,
        );
      }
    } finally {
      closeSync(fd);
    }
    const bytesWritten = gzipped.length;

    // 6. Delete archived events + emptied sessions atomically.
    const deleteEventStmt = this.db.prepare(`DELETE FROM events WHERE ts < ?`);
    const deleteSessionStmt = this.db.prepare(
      `DELETE FROM sessions WHERE session_id = ?`,
    );
    const tx = this.db.transaction((sessionIds: string[]) => {
      const info = deleteEventStmt.run(beforeTs);
      let deletedSessions = 0;
      for (const sid of sessionIds) {
        const r = deleteSessionStmt.run(sid);
        deletedSessions += Number(r.changes);
      }
      return { deletedEvents: Number(info.changes), deletedSessions };
    });
    const { deletedEvents, deletedSessions } = tx(archivedSessionIds);

    // 7. Compact the WAL now that we've freed pages.
    this.db.pragma("wal_checkpoint(TRUNCATE)");

    return {
      beforeTs,
      archiveFile,
      archivedSessionIds,
      archivedEventCount,
      deletedEventCount: deletedEvents,
      deletedSessionCount: deletedSessions,
      bytesWritten,
      durationMs: Date.now() - startedAt,
      dryRun: false,
    };
  }

  /** List sidecar archive files in the archive directory, sorted newest first. */
  listArchives(
    archiveDir: string = defaultArchiveDir(),
  ): Array<{ path: string; beforeTs: string; bytes: number; mtime: string }> {
    let entries: string[];
    try {
      entries = readdirSync(archiveDir);
    } catch {
      return [];
    }
    const out: Array<{
      path: string;
      beforeTs: string;
      bytes: number;
      mtime: string;
    }> = [];
    for (const name of entries) {
      if (!name.startsWith("frontier-archive-") || !name.endsWith(".jsonl.gz"))
        continue;
      const full = join(archiveDir, name);
      let bytes = 0;
      let mtime = "";
      try {
        const st = statSync(full);
        bytes = st.size;
        mtime = st.mtime.toISOString();
      } catch {
        continue;
      }
      // Try to parse the header for authoritative beforeTs; fall back to
      // the filename slug if the read fails.
      let beforeTs = "";
      try {
        const buf = readFileSync(full);
        const text = gunzipSync(buf).toString("utf8");
        const firstNl = text.indexOf("\n");
        if (firstNl > 0) {
          const header = JSON.parse(text.slice(0, firstNl)) as {
            beforeTs?: string;
          };
          beforeTs = header.beforeTs ?? "";
        }
      } catch {
        // leave beforeTs empty on read failure
      }
      out.push({ path: full, beforeTs, bytes, mtime });
    }
    out.sort((a, b) => (a.mtime < b.mtime ? 1 : a.mtime > b.mtime ? -1 : 0));
    return out;
  }

  close(): void {
    this.db.close();
  }
}

// Module-level singleton so every CLI invocation shares one connection.
// Opened lazily on first use; closed explicitly via closeLedger() for
// processes that care about clean shutdown.
let singleton: LedgerStore | null = null;

export function getLedger(): LedgerStore {
  if (!singleton) singleton = new LedgerStore();
  return singleton;
}

export function closeLedger(): void {
  if (singleton) {
    singleton.close();
    singleton = null;
  }
}

/**
 * Read a gzipped JSONL sidecar file back into memory. Returns the header
 * and the reconstructed events. Session marker lines (`_session`) are
 * skipped — the reader is primarily for replaying events; session
 * metadata is preserved in the file for operators who need it but is
 * exposed via `readArchiveFileRaw` if/when that's needed.
 */
export function readArchiveFile(path: string): {
  header: object;
  events: LedgerEvent[];
} {
  const text = gunzipSync(readFileSync(path)).toString("utf8");
  const lines = text.split("\n").filter((l) => l.length > 0);
  if (lines.length === 0) {
    throw new Error(`archive file ${path} is empty`);
  }
  const header = JSON.parse(lines[0]!) as object;
  const events: LedgerEvent[] = [];
  for (let i = 1; i < lines.length; i++) {
    const obj = JSON.parse(lines[i]!) as Record<string, unknown>;
    if ("_session" in obj) continue; // skip session markers
    events.push(obj as unknown as LedgerEvent);
  }
  return { header, events };
}

/**
 * Tiny entrypoint for ad-hoc runs:
 *   npx tsx -e "import('./src/ledger/index.ts').then(m => m.runArchiveCli('2026-04-08T00:00:00Z', {dryRun: true}))"
 */
export function runArchiveCli(
  beforeTs: string,
  opts: { dryRun?: boolean } = {},
): void {
  const ledger = getLedger();
  const result = ledger.archive({ beforeTs, dryRun: opts.dryRun ?? false });
  console.log(JSON.stringify(result, null, 2));
  closeLedger();
}
