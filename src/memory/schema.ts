// SQLite schema for the typed memory store.
//
// Per vision §8.5 and the lift manifest (docs/lift-manifests/agent-memory-
// and-multi-agent.md), we keep the four classes physically distinct so one
// class's retention policy or write discipline can't bleed into another.
//
// Fields are lifted from Letta's Block schema
// (https://github.com/letta-ai/letta/blob/main/letta/schemas/block.py):
//   - label        canonical name under a namespace
//   - description  short operator-facing summary
//   - value        full content (markdown or text)
//   - char_limit   Letta calls this `limit` but it's char-count, not tokens
//   - metadata     JSON; arbitrary operator/agent annotations
//
// The namespace column is a slash-separated path under the memory_class,
// chosen so the LangGraph BaseStore "namespace: tuple[str,...]" surface maps
// cleanly: `("procedural", "salesforce", "audit")` → class=procedural,
// namespace="salesforce/audit".

export const MEMORY_CLASSES = [
  "run",
  "operational",
  "procedural",
  "evaluative",
] as const;

export type MemoryClass = (typeof MEMORY_CLASSES)[number];

export const MEMORY_SCHEMA_DDL = `
CREATE TABLE IF NOT EXISTS memory_blocks (
  block_id     TEXT PRIMARY KEY,
  memory_class TEXT NOT NULL CHECK(memory_class IN ('run','operational','procedural','evaluative')),
  namespace    TEXT NOT NULL DEFAULT '',
  label        TEXT NOT NULL,
  description  TEXT,
  value        TEXT NOT NULL,
  char_limit   INTEGER,
  metadata     TEXT NOT NULL DEFAULT '{}',
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL,
  UNIQUE (memory_class, namespace, label)
);

CREATE INDEX IF NOT EXISTS idx_memory_class_label
  ON memory_blocks(memory_class, label);
CREATE INDEX IF NOT EXISTS idx_memory_namespace
  ON memory_blocks(memory_class, namespace);
CREATE INDEX IF NOT EXISTS idx_memory_updated
  ON memory_blocks(updated_at DESC);

CREATE VIRTUAL TABLE IF NOT EXISTS memory_blocks_fts USING fts5(
  label, description, value,
  content='memory_blocks',
  content_rowid='rowid',
  tokenize='porter unicode61'
);

-- Keep FTS5 virtual table in sync with the main table via triggers.
CREATE TRIGGER IF NOT EXISTS memory_blocks_ai AFTER INSERT ON memory_blocks BEGIN
  INSERT INTO memory_blocks_fts(rowid, label, description, value)
  VALUES (new.rowid, new.label, COALESCE(new.description, ''), new.value);
END;

CREATE TRIGGER IF NOT EXISTS memory_blocks_ad AFTER DELETE ON memory_blocks BEGIN
  INSERT INTO memory_blocks_fts(memory_blocks_fts, rowid, label, description, value)
  VALUES ('delete', old.rowid, old.label, COALESCE(old.description, ''), old.value);
END;

CREATE TRIGGER IF NOT EXISTS memory_blocks_au AFTER UPDATE ON memory_blocks BEGIN
  INSERT INTO memory_blocks_fts(memory_blocks_fts, rowid, label, description, value)
  VALUES ('delete', old.rowid, old.label, COALESCE(old.description, ''), old.value);
  INSERT INTO memory_blocks_fts(rowid, label, description, value)
  VALUES (new.rowid, new.label, COALESCE(new.description, ''), new.value);
END;
`;
