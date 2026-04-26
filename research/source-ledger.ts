// research/source-ledger.ts
//
// Append-only source records. A source is a citable artifact (paper,
// repo, web page, doc, internal note) that one or more claims rest
// on. The source ledger keeps the bibliographic + provenance metadata
// in one place so multiple claims can reference the same `sourceId`
// instead of duplicating citations.
//
// Storage: NDJSON file, one source per line. Append-only — corrections
// add a new record with a `supersedes` pointer; old records stay.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export type SourceKind =
  | "paper"
  | "preprint"
  | "repo"
  | "web"
  | "doc"
  | "internal"
  | "tool-output";

export interface SourceRecord {
  schema: "frontier_os.research.source_record.v1";
  sourceId: string;
  kind: SourceKind;
  /** Title or short identifier. */
  title: string;
  /** Canonical URL or DOI when available. */
  url?: string;
  /**
   * Authors / org / vendor / repo owner. Free-form string list — the
   * dark factory uses this for provenance, not for academic citation.
   */
  authors: string[];
  /** ISO date if known. */
  publishedAt?: string;
  /** When the factory captured this source. */
  retrievedAt: string;
  /**
   * One-paragraph (≤80 words) factual summary of what the source says
   * — NOT what we think it implies. Implications belong in claims.
   */
  summary: string;
  /**
   * SHA-256 of the canonical content if it was fetched and snapshotted.
   * Optional — many sources are URL-only.
   */
  contentHash?: string;
  /** Optional path to a local snapshot under research/sources/. */
  snapshotPath?: string;
  supersedes?: string;
  tags: string[];
}

export interface AppendSourceInput {
  ledgerPath: string;
  kind: SourceKind;
  title: string;
  authors: string[];
  retrievedAt?: string;
  summary: string;
  url?: string;
  publishedAt?: string;
  contentHash?: string;
  snapshotPath?: string;
  supersedes?: string;
  tags?: string[];
  clock?: () => Date;
  idGenerator?: (now: Date) => string;
}

export function newSourceId(now: Date): string {
  const ts = now
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d+Z$/, "Z");
  const r = Math.random().toString(36).slice(2, 6);
  return `src_${ts}_${r}`;
}

export function appendSource(input: AppendSourceInput): SourceRecord {
  if (input.title.trim().length < 4) {
    throw new Error("source title must be non-trivial (>=4 chars)");
  }
  if (input.summary.split(/\s+/).filter(Boolean).length > 80) {
    throw new Error(
      "source summary too long (>80 words) — keep it factual and terse",
    );
  }
  if (input.summary.split(/\s+/).filter(Boolean).length < 5) {
    throw new Error(
      "source summary too short — at least one sentence (≥5 words)",
    );
  }

  const clock = input.clock ?? (() => new Date());
  const idGen = input.idGenerator ?? newSourceId;
  const now = clock();
  const record: SourceRecord = {
    schema: "frontier_os.research.source_record.v1",
    sourceId: idGen(now),
    kind: input.kind,
    title: input.title,
    authors: input.authors,
    retrievedAt: input.retrievedAt ?? now.toISOString(),
    summary: input.summary,
    ...(input.url !== undefined ? { url: input.url } : {}),
    ...(input.publishedAt !== undefined
      ? { publishedAt: input.publishedAt }
      : {}),
    ...(input.contentHash !== undefined
      ? { contentHash: input.contentHash }
      : {}),
    ...(input.snapshotPath !== undefined
      ? { snapshotPath: input.snapshotPath }
      : {}),
    ...(input.supersedes !== undefined ? { supersedes: input.supersedes } : {}),
    tags: input.tags ?? [],
  };

  mkdirSync(dirname(input.ledgerPath), { recursive: true });
  const line = JSON.stringify(record) + "\n";
  if (existsSync(input.ledgerPath)) {
    const prior = readFileSync(input.ledgerPath, "utf8");
    writeFileSync(input.ledgerPath, prior + line, "utf8");
  } else {
    writeFileSync(input.ledgerPath, line, "utf8");
  }
  return record;
}

export function readSources(ledgerPath: string): SourceRecord[] {
  if (!existsSync(ledgerPath)) return [];
  const raw = readFileSync(ledgerPath, "utf8");
  const out: SourceRecord[] = [];
  for (const line of raw.split("\n")) {
    if (line.trim() === "") continue;
    try {
      out.push(JSON.parse(line) as SourceRecord);
    } catch (err) {
      throw new Error(
        `source ledger ${ledgerPath} has malformed line: ${(err as Error).message}`,
      );
    }
  }
  return out;
}

export function findSource(
  sources: SourceRecord[],
  sourceId: string,
): SourceRecord | null {
  for (const s of sources) {
    if (s.sourceId === sourceId) return s;
  }
  return null;
}
