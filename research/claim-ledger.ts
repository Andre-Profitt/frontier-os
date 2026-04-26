// research/claim-ledger.ts
//
// Append-only claim records. A claim is the smallest reusable unit of
// research output: one assertion, the sources that support it, the
// sources that contradict it (if any), confidence, status, and where
// the claim was used.
//
// Per Andre's brief: normal AI research gives you a report; a dark
// factory needs claim-level memory so later factories can reuse
// findings without re-reading the whole report.
//
// Storage: one JSON Lines (NDJSON) file per research run, plus an
// optional per-namespace consolidated file. Files are append-only —
// edits create a new claim entry referencing the prior `claimId` via
// `supersedes`, never mutate in place.
//
// This module is the artifact-format layer. Upstream tool integration
// (STORM, GPT Researcher, PaperQA2, Agent Laboratory) lands later;
// the format must be stable first.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export type ClaimStatus =
  | "supported"
  | "contradicted"
  | "mixed"
  | "uncertain"
  | "superseded";

export type ClaimConfidence = "high" | "medium" | "low";

export interface ClaimSupport {
  /** sourceId from source-ledger.ts (or an inline reference). */
  sourceId: string;
  /**
   * The shortest possible quote (≤25 words) or summary that
   * substantiates the claim. Avoid pulling long passages — claim
   * records are reusable artifacts, not transcripts.
   */
  quoteOrSummary: string;
  /** "supports" | "contradicts" — direction of evidence. */
  stance: "supports" | "contradicts";
  /** Per-source confidence; aggregate confidence is on the claim. */
  confidence: ClaimConfidence;
}

export interface ClaimRecord {
  schema: "frontier_os.research.claim_record.v1";
  claimId: string;
  text: string;
  status: ClaimStatus;
  confidence: ClaimConfidence;
  support: ClaimSupport[];
  /**
   * Where this claim was applied. Concrete examples:
   *   "research-factory.scope-design"
   *   "factory-supervisor.invariant.I1"
   *   "skills/research-factory/SKILL.md"
   * Empty list = the claim is captured but not yet load-bearing.
   */
  usedFor: string[];
  /**
   * If a later run revises a claim, the new record's `supersedes`
   * points to the prior claimId. The old record is NEVER deleted.
   * Reading code computes the current view by scanning the chain.
   */
  supersedes?: string;
  createdAt: string;
  /** Free-form tags for retrieval. */
  tags: string[];
}

export interface AppendClaimInput {
  ledgerPath: string;
  text: string;
  status: ClaimStatus;
  confidence: ClaimConfidence;
  support: ClaimSupport[];
  usedFor?: string[];
  supersedes?: string;
  tags?: string[];
  /** Test seam. */
  clock?: () => Date;
  idGenerator?: (now: Date) => string;
}

export function newClaimId(now: Date): string {
  const ts = now
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d+Z$/, "Z");
  const r = Math.random().toString(36).slice(2, 6);
  return `claim_${ts}_${r}`;
}

export function appendClaim(input: AppendClaimInput): ClaimRecord {
  if (input.text.length < 8) {
    throw new Error(
      "claim text too short — claims must be self-contained assertions",
    );
  }
  if (input.support.length === 0) {
    throw new Error(
      "claim must have at least one ClaimSupport entry (a sourceless claim is rumor)",
    );
  }
  for (const s of input.support) {
    if (s.quoteOrSummary.split(/\s+/).filter(Boolean).length > 35) {
      throw new Error(
        `claim support quoteOrSummary too long (>35 words) for source=${s.sourceId} — keep it terse`,
      );
    }
  }

  const clock = input.clock ?? (() => new Date());
  const idGen = input.idGenerator ?? newClaimId;
  const now = clock();
  const record: ClaimRecord = {
    schema: "frontier_os.research.claim_record.v1",
    claimId: idGen(now),
    text: input.text,
    status: input.status,
    confidence: input.confidence,
    support: input.support,
    usedFor: input.usedFor ?? [],
    ...(input.supersedes !== undefined ? { supersedes: input.supersedes } : {}),
    createdAt: now.toISOString(),
    tags: input.tags ?? [],
  };

  // Append-only: never rewrite. Create the file if missing.
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

export function readClaims(ledgerPath: string): ClaimRecord[] {
  if (!existsSync(ledgerPath)) return [];
  const raw = readFileSync(ledgerPath, "utf8");
  const out: ClaimRecord[] = [];
  for (const line of raw.split("\n")) {
    if (line.trim() === "") continue;
    try {
      out.push(JSON.parse(line) as ClaimRecord);
    } catch (err) {
      throw new Error(
        `claim ledger ${ledgerPath} has malformed line: ${(err as Error).message}`,
      );
    }
  }
  return out;
}

/**
 * The "current" view: collapses supersedes chains so each logical
 * claim appears only once (as the latest version). Use this when a
 * downstream consumer wants the up-to-date status without manually
 * walking the chain.
 */
export function currentView(claims: ClaimRecord[]): ClaimRecord[] {
  const supersededBy = new Map<string, string>();
  for (const c of claims) {
    if (c.supersedes) {
      supersededBy.set(c.supersedes, c.claimId);
    }
  }
  // Walk the chain forward — keep claims that nobody supersedes.
  return claims.filter((c) => !supersededBy.has(c.claimId));
}
