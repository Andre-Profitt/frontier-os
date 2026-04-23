// Eval regression runner (Phase 15) — closes the trace→eval loop from Phase 12.
//
// Reads refined failure proposals + their example events, replays each
// `pattern` against the example event payload, and reports whether the rule
// still catches the failure it was refined from. A failure here = regression:
// the code path that used to produce this failure now produces something
// different, so the learned rule no longer fires.
//
// Exit code 2 when --fail-on-regression is set and any item regresses —
// wire into pre-push / CI so a stealth behavior change can't silently
// invalidate accumulated refinery knowledge.

import Database from "better-sqlite3";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";

import { normalizeReason } from "../refinery/harvester.ts";
import { loadProposals } from "../refinery/registry.ts";
import type { PolicyRuleProposal } from "../refinery/rules.ts";

const LEDGER_DB = resolve(homedir(), ".frontier", "ledger.db");

export interface EvalRunOptions {
  sinceIso?: string;
  maxItems?: number;
  /** Restrict to a single ruleId (handy when debugging one pattern). */
  ruleId?: string;
}

export interface EvalItemResult {
  ruleId: string;
  eventId: string;
  kind: string;
  status:
    | "pass"
    | "fail_regression"
    | "skipped_missing_event"
    | "skipped_no_regex";
  reasonMatched: string | null;
  regexPattern: string;
  expectedKind: string;
  actualKind: string | null;
  details?: string;
}

export interface EvalRunSummary {
  sinceIso: string;
  proposalsConsidered: number;
  itemsConsidered: number;
  passed: number;
  regressed: number;
  skippedMissing: number;
  skippedNoRegex: number;
  regressionRate: number;
  firstFailures: EvalItemResult[];
  perRule: Record<
    string,
    { total: number; passed: number; regressed: number; pattern: string }
  >;
}

const DEFAULT_MAX_ITEMS = 500;

export function runEvalDataset(opts: EvalRunOptions = {}): EvalRunSummary {
  const sinceIso = opts.sinceIso ?? "1970-01-01T00:00:00Z";
  const maxItems = Math.max(
    1,
    Math.min(5000, opts.maxItems ?? DEFAULT_MAX_ITEMS),
  );

  let proposals = loadProposals().filter((p) => p.proposedAt >= sinceIso);
  if (opts.ruleId) {
    proposals = proposals.filter((p) => p.ruleId === opts.ruleId);
  }

  const results: EvalItemResult[] = [];
  const perRule: EvalRunSummary["perRule"] = {};

  outer: for (const proposal of proposals) {
    const slot =
      perRule[proposal.ruleId] ??
      (perRule[proposal.ruleId] = {
        total: 0,
        passed: 0,
        regressed: 0,
        pattern: proposal.pattern.reasonRegex,
      });
    for (const eventId of proposal.evidence.exampleEventIds) {
      if (results.length >= maxItems) break outer;
      const item = replayOne(proposal, eventId);
      results.push(item);
      slot.total++;
      if (item.status === "pass") slot.passed++;
      if (item.status === "fail_regression") slot.regressed++;
    }
  }

  const passed = results.filter((r) => r.status === "pass").length;
  const regressed = results.filter(
    (r) => r.status === "fail_regression",
  ).length;
  const skippedMissing = results.filter(
    (r) => r.status === "skipped_missing_event",
  ).length;
  const skippedNoRegex = results.filter(
    (r) => r.status === "skipped_no_regex",
  ).length;
  const regressionRate =
    results.length > 0 ? regressed / (passed + regressed || 1) : 0;

  return {
    sinceIso,
    proposalsConsidered: proposals.length,
    itemsConsidered: results.length,
    passed,
    regressed,
    skippedMissing,
    skippedNoRegex,
    regressionRate,
    firstFailures: results
      .filter((r) => r.status === "fail_regression")
      .slice(0, 5),
    perRule,
  };
}

function replayOne(
  proposal: PolicyRuleProposal,
  eventId: string,
): EvalItemResult {
  const event = fetchEvent(eventId);
  if (!event) {
    return {
      ruleId: proposal.ruleId,
      eventId,
      kind: proposal.pattern.kind,
      status: "skipped_missing_event",
      reasonMatched: null,
      regexPattern: proposal.pattern.reasonRegex,
      expectedKind: proposal.pattern.kind,
      actualKind: null,
      details: `event ${eventId} not found in ledger; archived or cleared`,
    };
  }

  // The proposal's regex was derived from a NORMALIZED reason string (see
  // harvester.normalizeReason — collapses exit codes, ids, timestamps, paths).
  // Match on the same normalized form, not the raw payload reason, or the
  // regex /exit \S+/ never matches an actual exit digit — this was the
  // 20% regression we saw on first eval run.
  const rawReason = extractReason(event);
  const reason = rawReason !== null ? normalizeReason(rawReason) : null;

  let regex: RegExp;
  try {
    regex = new RegExp(proposal.pattern.reasonRegex, "i");
  } catch {
    return {
      ruleId: proposal.ruleId,
      eventId,
      kind: event.kind,
      status: "skipped_no_regex",
      reasonMatched: null,
      regexPattern: proposal.pattern.reasonRegex,
      expectedKind: proposal.pattern.kind,
      actualKind: event.kind,
      details: `rule regex did not compile`,
    };
  }

  const kindMatches = proposal.pattern.kind === event.kind;
  const reasonMatches = reason !== null && regex.test(reason);

  if (kindMatches && reasonMatches) {
    return {
      ruleId: proposal.ruleId,
      eventId,
      kind: event.kind,
      status: "pass",
      reasonMatched: reason,
      regexPattern: proposal.pattern.reasonRegex,
      expectedKind: proposal.pattern.kind,
      actualKind: event.kind,
    };
  }
  return {
    ruleId: proposal.ruleId,
    eventId,
    kind: event.kind,
    status: "fail_regression",
    reasonMatched: reason,
    regexPattern: proposal.pattern.reasonRegex,
    expectedKind: proposal.pattern.kind,
    actualKind: event.kind,
    details: !kindMatches
      ? `kind diverged: expected ${proposal.pattern.kind}, got ${event.kind}`
      : `regex ${proposal.pattern.reasonRegex} no longer matches reason "${reason?.slice(0, 160) ?? ""}"`,
  };
}

interface FetchedEvent {
  eventId: string;
  ts: string;
  kind: string;
  payload: Record<string, unknown>;
}

function fetchEvent(eventId: string): FetchedEvent | null {
  if (!existsSync(LEDGER_DB)) return null;
  const db = new Database(LEDGER_DB, { readonly: true, fileMustExist: true });
  try {
    const row = db
      .prepare(
        `SELECT event_id, ts, kind, payload FROM events WHERE event_id = ?`,
      )
      .get(eventId) as
      | { event_id: string; ts: string; kind: string; payload: string }
      | undefined;
    if (!row) return null;
    let payload: Record<string, unknown> = {};
    try {
      payload = JSON.parse(row.payload) as Record<string, unknown>;
    } catch {
      payload = { _raw: row.payload };
    }
    return { eventId: row.event_id, ts: row.ts, kind: row.kind, payload };
  } finally {
    db.close();
  }
}

function extractReason(event: FetchedEvent): string | null {
  const p = event.payload;
  // Match the normalization order used by the harvester so patterns fire
  // on the same substring across both sides.
  if (typeof p["reason"] === "string") return p["reason"] as string;
  if (typeof p["summary"] === "string") return p["summary"] as string;

  if (
    Array.isArray(p["rejections"]) &&
    (p["rejections"] as unknown[]).length > 0
  ) {
    const first = (p["rejections"] as unknown[])[0];
    if (
      typeof first === "object" &&
      first !== null &&
      "message" in (first as Record<string, unknown>) &&
      typeof (first as Record<string, unknown>)["message"] === "string"
    ) {
      return (first as Record<string, unknown>)["message"] as string;
    }
  }
  if (typeof p["error"] === "string") return p["error"] as string;
  if (typeof p["stdout"] === "string") return p["stdout"] as string;
  return null;
}

export interface EvalStatsSummary {
  proposals: number;
  proposalsByAction: Record<string, number>;
  exampleEventCount: number;
}

export function evalStats(): EvalStatsSummary {
  const proposals = loadProposals();
  const proposalsByAction: Record<string, number> = {};
  let exampleEventCount = 0;
  for (const p of proposals) {
    proposalsByAction[p.suggestedAction] =
      (proposalsByAction[p.suggestedAction] ?? 0) + 1;
    exampleEventCount += p.evidence.exampleEventIds.length;
  }
  return {
    proposals: proposals.length,
    proposalsByAction,
    exampleEventCount,
  };
}
