// Typed memory store — SQLite-backed.
//
// Four classes (§8.5): run | operational | procedural | evaluative.
// Surface matches LangGraph's BaseStore (4-method put/get/search/list) plus
// a delete for operational hygiene. Search uses FTS5 by default; callers can
// fall back to "list all in a namespace" by omitting `query`.
//
// Write discipline:
//   - evaluative blocks are ADD-only (Mem0 rule) — updates throw
//   - procedural blocks are mutable (A-Mem evolution pattern)
//   - operational + run blocks are mutable and expected to churn
//
// These rules are enforced in put() rather than schema so operators can
// emergency-patch via direct SQL if needed.

import Database from "better-sqlite3";
import type { Database as SqliteDb, Statement } from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { homedir } from "node:os";
import { randomUUID } from "node:crypto";

import { MEMORY_SCHEMA_DDL, type MemoryClass } from "./schema.ts";

export interface MemoryBlockValue {
  value: string;
  description?: string;
  charLimit?: number;
  metadata?: Record<string, unknown>;
}

export interface MemoryBlock {
  blockId: string;
  memoryClass: MemoryClass;
  namespace: string; // slash-separated under the class, "" if class-root
  label: string;
  description: string | null;
  value: string;
  charLimit: number | null;
  metadata: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

export interface SearchOptions {
  query?: string;
  namespacePrefix?: string;
  limit?: number;
  offset?: number;
}

export class MemoryWriteViolation extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MemoryWriteViolation";
  }
}

export function defaultMemoryDbPath(): string {
  return resolve(homedir(), ".frontier", "memory.db");
}

export class MemoryStore {
  private db: SqliteDb;
  private putInsert!: Statement;
  private putUpdate!: Statement;
  private getStmt!: Statement;
  private deleteStmt!: Statement;
  private listByClassStmt!: Statement;
  private listByNamespaceStmt!: Statement;
  private searchFtsStmt!: Statement;

  constructor(dbPath: string = defaultMemoryDbPath()) {
    mkdirSync(dirname(dbPath), { recursive: true });
    this.db = new Database(dbPath);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("synchronous = NORMAL");
    this.db.pragma("foreign_keys = ON");
    this.db.exec(MEMORY_SCHEMA_DDL);
    this.prepare();
  }

  close(): void {
    this.db.close();
  }

  private prepare(): void {
    this.putInsert = this.db.prepare(
      `INSERT INTO memory_blocks
       (block_id, memory_class, namespace, label, description, value,
        char_limit, metadata, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    this.putUpdate = this.db.prepare(
      `UPDATE memory_blocks
       SET description = ?, value = ?, char_limit = ?, metadata = ?, updated_at = ?
       WHERE memory_class = ? AND namespace = ? AND label = ?`,
    );
    this.getStmt = this.db.prepare(
      `SELECT block_id, memory_class, namespace, label, description, value,
              char_limit, metadata, created_at, updated_at
       FROM memory_blocks
       WHERE memory_class = ? AND namespace = ? AND label = ?`,
    );
    this.deleteStmt = this.db.prepare(
      `DELETE FROM memory_blocks
       WHERE memory_class = ? AND namespace = ? AND label = ?`,
    );
    this.listByClassStmt = this.db.prepare(
      `SELECT block_id, memory_class, namespace, label, description, value,
              char_limit, metadata, created_at, updated_at
       FROM memory_blocks
       WHERE memory_class = ?
       ORDER BY updated_at DESC
       LIMIT ? OFFSET ?`,
    );
    this.listByNamespaceStmt = this.db.prepare(
      `SELECT block_id, memory_class, namespace, label, description, value,
              char_limit, metadata, created_at, updated_at
       FROM memory_blocks
       WHERE memory_class = ? AND (namespace = ? OR namespace LIKE ?)
       ORDER BY updated_at DESC
       LIMIT ? OFFSET ?`,
    );
    this.searchFtsStmt = this.db.prepare(
      `SELECT b.block_id, b.memory_class, b.namespace, b.label, b.description,
              b.value, b.char_limit, b.metadata, b.created_at, b.updated_at
       FROM memory_blocks_fts f
       JOIN memory_blocks b ON b.rowid = f.rowid
       WHERE memory_blocks_fts MATCH ?
         AND b.memory_class = ?
         AND (? = '' OR b.namespace = ? OR b.namespace LIKE ?)
       ORDER BY rank
       LIMIT ? OFFSET ?`,
    );
  }

  /**
   * Upsert a block. Obeys per-class write discipline:
   *   - evaluative → ADD-only; updating an existing (class,ns,label) throws.
   *   - procedural / operational / run → mutable.
   */
  put(
    memoryClass: MemoryClass,
    namespace: string,
    label: string,
    value: MemoryBlockValue,
  ): MemoryBlock {
    const ns = normalizeNamespace(namespace);
    const existing = this.get(memoryClass, ns, label);
    const now = new Date().toISOString();
    const description = value.description ?? null;
    const charLimit = value.charLimit ?? null;
    const metadata = JSON.stringify(value.metadata ?? {});

    if (existing) {
      if (memoryClass === "evaluative") {
        throw new MemoryWriteViolation(
          `evaluative memory is ADD-only; ${memoryClass}:${ns}:${label} already exists (blockId=${existing.blockId})`,
        );
      }
      this.putUpdate.run(
        description,
        value.value,
        charLimit,
        metadata,
        now,
        memoryClass,
        ns,
        label,
      );
      return {
        ...existing,
        value: value.value,
        description,
        charLimit,
        metadata: value.metadata ?? {},
        updatedAt: now,
      };
    }

    const blockId = `mem_${randomUUID().replace(/-/g, "")}`;
    this.putInsert.run(
      blockId,
      memoryClass,
      ns,
      label,
      description,
      value.value,
      charLimit,
      metadata,
      now,
      now,
    );
    return {
      blockId,
      memoryClass,
      namespace: ns,
      label,
      description,
      value: value.value,
      charLimit,
      metadata: value.metadata ?? {},
      createdAt: now,
      updatedAt: now,
    };
  }

  get(
    memoryClass: MemoryClass,
    namespace: string,
    label: string,
  ): MemoryBlock | null {
    const row = this.getStmt.get(
      memoryClass,
      normalizeNamespace(namespace),
      label,
    ) as Record<string, unknown> | undefined;
    return row ? rowToBlock(row) : null;
  }

  delete(memoryClass: MemoryClass, namespace: string, label: string): boolean {
    if (memoryClass === "evaluative") {
      throw new MemoryWriteViolation(
        `evaluative memory is ADD-only; deletes are forbidden`,
      );
    }
    const r = this.deleteStmt.run(
      memoryClass,
      normalizeNamespace(namespace),
      label,
    );
    return r.changes > 0;
  }

  list(
    memoryClass: MemoryClass,
    opts: { namespacePrefix?: string; limit?: number; offset?: number } = {},
  ): MemoryBlock[] {
    const limit = Math.max(1, Math.min(500, opts.limit ?? 100));
    const offset = Math.max(0, opts.offset ?? 0);
    const nsPrefix = opts.namespacePrefix
      ? normalizeNamespace(opts.namespacePrefix)
      : null;
    const rows = nsPrefix
      ? (this.listByNamespaceStmt.all(
          memoryClass,
          nsPrefix,
          `${nsPrefix}/%`,
          limit,
          offset,
        ) as Record<string, unknown>[])
      : (this.listByClassStmt.all(memoryClass, limit, offset) as Record<
          string,
          unknown
        >[]);
    return rows.map(rowToBlock);
  }

  search(memoryClass: MemoryClass, opts: SearchOptions = {}): MemoryBlock[] {
    const limit = Math.max(1, Math.min(100, opts.limit ?? 20));
    const offset = Math.max(0, opts.offset ?? 0);
    const nsPrefix = opts.namespacePrefix
      ? normalizeNamespace(opts.namespacePrefix)
      : "";

    // No query = list mode (stable, non-FTS).
    if (!opts.query || !opts.query.trim()) {
      return this.list(memoryClass, {
        ...(nsPrefix ? { namespacePrefix: nsPrefix } : {}),
        limit,
        offset,
      });
    }

    // FTS5 MATCH treats punctuation like "-" as syntax. Quote each plain term
    // so project ids such as "frontier-os" stay searchable.
    const match = buildFtsQuery(opts.query);
    const rows = this.searchFtsStmt.all(
      match,
      memoryClass,
      nsPrefix,
      nsPrefix,
      `${nsPrefix}/%`,
      limit,
      offset,
    ) as Record<string, unknown>[];
    return rows.map(rowToBlock);
  }

  stats(): Record<string, number> {
    const row = this.db
      .prepare(
        `SELECT memory_class, COUNT(*) as n FROM memory_blocks GROUP BY memory_class`,
      )
      .all() as Array<{ memory_class: string; n: number }>;
    const totals: Record<string, number> = {
      run: 0,
      operational: 0,
      procedural: 0,
      evaluative: 0,
    };
    for (const r of row) totals[r.memory_class] = r.n;
    const total = (
      this.db.prepare(`SELECT COUNT(*) as n FROM memory_blocks`).get() as {
        n: number;
      }
    ).n;
    return { ...totals, total };
  }
}

// ---- helpers ----

function normalizeNamespace(ns: string): string {
  // empty, "/", or "//" all collapse to "". Trim leading/trailing slashes.
  return ns.replace(/^\/+|\/+$/g, "").replace(/\/{2,}/g, "/");
}

function buildFtsQuery(query: string): string {
  return query
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .map((term) => `"${term.replace(/"/g, '""')}"`)
    .join(" ");
}

function rowToBlock(row: Record<string, unknown>): MemoryBlock {
  let metadata: Record<string, unknown> = {};
  try {
    metadata = JSON.parse(String(row.metadata ?? "{}"));
  } catch {
    metadata = { _raw: String(row.metadata ?? "") };
  }
  return {
    blockId: String(row.block_id),
    memoryClass: String(row.memory_class) as MemoryClass,
    namespace: String(row.namespace ?? ""),
    label: String(row.label),
    description: row.description === null ? null : String(row.description),
    value: String(row.value),
    charLimit: row.char_limit === null ? null : Number(row.char_limit),
    metadata,
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

// Singleton for CLI use — one connection per process, lazy-opened.
let _singleton: MemoryStore | null = null;

export function getMemoryStore(): MemoryStore {
  if (!_singleton) _singleton = new MemoryStore();
  return _singleton;
}

export function closeMemoryStore(): void {
  if (_singleton) {
    _singleton.close();
    _singleton = null;
  }
}
