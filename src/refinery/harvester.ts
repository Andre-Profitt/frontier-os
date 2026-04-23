// Failure Refinery — Harvester (Phase 6.4).
//
// Per `frontier-os-v1.md` §13.3, the Refinery is the moat: it compounds by
// promoting repeated failure traces into eval cases, policy rules, and
// routing updates. The harvester is step one — scan the ledger for
// failure/rejection events, group them by a stable cause signature, and
// emit one HarvestedSignal per unique cause.
//
// Source event kinds (emitted elsewhere, NEVER produced by this module):
//   - work.node_failed           (executor.ts)
//   - work.verifier_fail         (executor.ts)
//   - work.verifier_check        (executor.ts) — filtered to payload.passed === false
//   - work.node_skipped          (executor.ts)
//   - ghost.graph_rejected       (shift.ts)
//   - command.failed             (command worker terminal event)
//   - agent.review               (hook) — filtered to payload.verdict === "reject"
//
// Signature formula:  `${kind}::${check_name_if_any}::${firstLineOfReasonNormalized}`
//
// "Normalized" means: lowercased, collapsed whitespace, stripped of
// run-specific tokens (session/graph/node ids, ISO timestamps, temp paths,
// exit codes, absolute home dirs) so that two runs with the same underlying
// cause land in the same bucket.
//
// We open ~/.frontier/ledger.db read-only via better-sqlite3 so that running
// the refinery NEVER takes a write lock on the live ledger. The LedgerStore
// singleton in src/ledger/index.ts opens a writer connection; we deliberately
// avoid it — the refinery is an analyzer, not a writer.

import Database from "better-sqlite3";
import { homedir } from "node:os";
import { resolve } from "node:path";

export interface HarvestOptions {
  /** Only scan events with ts >= sinceIso. */
  sinceIso: string;
  /** Hard cap on rows pulled from the ledger. Default 1000. */
  limit?: number;
  /** Override DB path — tests + non-default homes. */
  dbPath?: string;
}

export interface HarvestedSignal {
  /** Stable id derived from the cause signature. */
  signature: string;
  /** Kind of the underlying source event ("work.verifier_fail", ...). */
  sourceKind: string;
  /** Optional check/rejection name extracted from the payload. */
  checkName: string | null;
  /** Normalized first line of the reason that feeds the signature. */
  reasonNormalized: string;
  /** Number of source events rolled into this signal. */
  count: number;
  /** ISO timestamp of the earliest contributing event. */
  firstSeen: string;
  /** ISO timestamp of the latest contributing event. */
  lastSeen: string;
  /** Up to 5 eventIds that hashed into this signature (oldest first). */
  exampleEventIds: string[];
  /** Up to 3 example raw reason strings, for human inspection. */
  exampleReasons: string[];
}

const DEFAULT_LIMIT = 1000;
const MAX_EXAMPLE_IDS = 5;
const MAX_EXAMPLE_REASONS = 3;

/** Kinds we treat as "something failed" — paired with an optional payload filter. */
const FAILURE_KINDS: Array<{
  kind: string;
  payloadFilter?: (p: Record<string, unknown>) => boolean;
}> = [
  { kind: "work.node_failed" },
  { kind: "work.verifier_fail" },
  {
    kind: "work.verifier_check",
    payloadFilter: (p) => p.passed === false,
  },
  { kind: "work.node_skipped" },
  { kind: "ghost.graph_rejected" },
  { kind: "command.failed" },
  {
    kind: "agent.review",
    payloadFilter: (p) => p.verdict === "reject",
  },
];

/** Scan the ledger, group failures by cause signature, return one record per group. */
export async function harvestFailures(
  opts: HarvestOptions,
): Promise<HarvestedSignal[]> {
  const limit = opts.limit ?? DEFAULT_LIMIT;
  const dbPath = opts.dbPath ?? defaultLedgerPath();

  // Open read-only so a concurrent writer in the same process is fine.
  // `fileMustExist: true` surfaces a clear error if the ledger hasn't been
  // created yet, rather than silently returning zero signals.
  const db = new Database(dbPath, { readonly: true, fileMustExist: true });
  try {
    const kinds = FAILURE_KINDS.map((k) => k.kind);
    const placeholders = kinds.map(() => "?").join(",");
    const sql = `
      SELECT event_id as eventId, ts, kind, payload
      FROM events
      WHERE kind IN (${placeholders}) AND ts >= ?
      ORDER BY ts ASC
      LIMIT ?
    `;
    const rows = db.prepare(sql).all(...kinds, opts.sinceIso, limit) as Array<{
      eventId: string;
      ts: string;
      kind: string;
      payload: string;
    }>;

    const groups = new Map<string, HarvestedSignal>();
    for (const row of rows) {
      let payload: Record<string, unknown>;
      try {
        payload = JSON.parse(row.payload) as Record<string, unknown>;
      } catch {
        continue;
      }

      const kindCfg = FAILURE_KINDS.find((k) => k.kind === row.kind);
      if (!kindCfg) continue;
      if (kindCfg.payloadFilter && !kindCfg.payloadFilter(payload)) continue;

      const checkName = extractCheckName(row.kind, payload);
      const rawReason = extractReason(row.kind, payload);
      const reasonNormalized = normalizeReason(rawReason);
      const signature = buildSignature(row.kind, checkName, reasonNormalized);

      const existing = groups.get(signature);
      if (existing) {
        existing.count++;
        existing.lastSeen = row.ts;
        if (existing.exampleEventIds.length < MAX_EXAMPLE_IDS) {
          existing.exampleEventIds.push(row.eventId);
        }
        if (
          existing.exampleReasons.length < MAX_EXAMPLE_REASONS &&
          !existing.exampleReasons.includes(rawReason)
        ) {
          existing.exampleReasons.push(rawReason);
        }
      } else {
        groups.set(signature, {
          signature,
          sourceKind: row.kind,
          checkName,
          reasonNormalized,
          count: 1,
          firstSeen: row.ts,
          lastSeen: row.ts,
          exampleEventIds: [row.eventId],
          exampleReasons: [rawReason],
        });
      }
    }

    return [...groups.values()].sort((a, b) =>
      a.count === b.count
        ? a.lastSeen < b.lastSeen
          ? 1
          : -1
        : b.count - a.count,
    );
  } finally {
    db.close();
  }
}

/** Default path for the live ledger — matches `src/ledger/index.ts#defaultLedgerPath`. */
export function defaultLedgerPath(): string {
  return resolve(homedir(), ".frontier", "ledger.db");
}

/**
 * Extract the check/rejection name from a payload. Different event kinds
 * stash this field under different keys, so a small kind-specific switch
 * keeps the signature stable across producers.
 */
function extractCheckName(
  kind: string,
  payload: Record<string, unknown>,
): string | null {
  if (kind === "work.verifier_check") {
    const v = payload.check;
    return typeof v === "string" ? v : null;
  }
  if (kind === "work.verifier_fail") {
    const checks = payload.checks;
    if (
      Array.isArray(checks) &&
      checks.length > 0 &&
      typeof checks[0] === "string"
    ) {
      return checks[0] as string;
    }
    return null;
  }
  if (kind === "ghost.graph_rejected") {
    const rej = payload.rejections;
    if (Array.isArray(rej) && rej.length > 0) {
      const first = rej[0] as Record<string, unknown>;
      if (typeof first.code === "string") return first.code;
    }
    const reason = payload.reason;
    if (typeof reason === "string") return reason;
    return null;
  }
  if (kind === "work.node_skipped") {
    const r = payload.reason;
    // The reason here is a short enum-like token; treat it as the check name.
    if (typeof r === "string") return r;
    return null;
  }
  if (kind === "agent.review") {
    const findings = payload.findings;
    if (
      Array.isArray(findings) &&
      findings.length > 0 &&
      typeof findings[0] === "string"
    ) {
      return findings[0] as string;
    }
    return "review_reject";
  }
  if (kind === "command.failed") {
    const verb = payload.verb;
    if (typeof verb === "string" && verb.length > 0) return verb;
    const lane = payload.lane;
    if (typeof lane === "string" && lane.length > 0) return lane;
    return "command_failed";
  }
  return null;
}

/** Extract the human-readable failure reason from a payload. */
function extractReason(kind: string, payload: Record<string, unknown>): string {
  if (typeof payload.reason === "string" && payload.reason.length > 0) {
    return payload.reason;
  }
  if (typeof payload.summary === "string" && payload.summary.length > 0) {
    return payload.summary;
  }
  if (typeof payload.error === "string" && payload.error.length > 0) {
    return payload.error;
  }
  if (typeof payload.message === "string" && payload.message.length > 0) {
    return payload.message;
  }
  if (kind === "command.failed") {
    const result = payload.result;
    if (isRecord(result)) {
      const summary = result.summary;
      if (typeof summary === "string" && summary.length > 0) return summary;
      const output = result.output;
      if (isRecord(output)) {
        const outputError = output.error;
        if (typeof outputError === "string" && outputError.length > 0) {
          return outputError;
        }
        const outputSummary = output.summary;
        if (typeof outputSummary === "string" && outputSummary.length > 0) {
          return outputSummary;
        }
      }
    }
  }
  if (kind === "ghost.graph_rejected") {
    const rej = payload.rejections;
    if (Array.isArray(rej) && rej.length > 0) {
      const first = rej[0] as Record<string, unknown>;
      if (typeof first.message === "string") return first.message;
    }
  }
  if (kind === "agent.review") {
    const ev = payload.evidence;
    if (typeof ev === "string" && ev.length > 0) return ev;
  }
  return "(no reason)";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Normalize a reason string so two runs of the same underlying failure
 * collapse to the same bucket. Trade-off: we deliberately stay lossy on
 * identifiers (hashes, ids, timestamps, paths, exit codes) and lossless on
 * the diagnostic text. A signature that over-collapses is fine — the
 * exampleEventIds let operators drill back to specific runs.
 */
export function normalizeReason(reason: string): string {
  // Single-line slice first so regex replacements aren't hunting across lines.
  let s = reason.split(/\r?\n/)[0] ?? "";
  s = s.toLowerCase().trim();

  // ISO-ish timestamps.
  s = s.replace(/\d{4}-\d{2}-\d{2}t[\d:.\-+z]+/g, "<ts>");
  // Absolute paths under home.
  s = s.replace(/\/users\/[^\s:]+/g, "<path>");
  s = s.replace(/\/tmp\/[^\s:]+/g, "<path>");
  // 8+ char hex/base32ish tokens (event ids, session ids, uuids).
  s = s.replace(/\b[a-f0-9]{8,}\b/g, "<id>");
  s = s.replace(/\b[0-9a-z]{10,}\b/g, (m) => (/\d/.test(m) ? "<id>" : m));
  // "exit N" / "exited N" / "exit code N".
  s = s.replace(/exit(?:ed)?(?:\s+code)?\s+\d+/g, "exit <n>");
  // Bare numbers that are probably counts/offsets.
  s = s.replace(/\b\d{3,}\b/g, "<n>");
  // Collapse whitespace.
  s = s.replace(/\s+/g, " ").trim();
  // Hard length cap so pathological reasons don't bloat the signature table.
  if (s.length > 200) s = s.slice(0, 200);
  return s;
}

function buildSignature(
  kind: string,
  checkName: string | null,
  reasonNormalized: string,
): string {
  return `${kind}::${checkName ?? ""}::${reasonNormalized}`;
}

/** Exposed for tests. */
export const __test__ = {
  extractCheckName,
  extractReason,
  normalizeReason,
  buildSignature,
};
