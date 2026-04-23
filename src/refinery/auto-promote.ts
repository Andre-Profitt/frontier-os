// Refinery — auto-promote loop (Phase 19).
//
// Closes the final automation gap: proposals that survive `frontier eval run`
// for N consecutive days graduate to active rules without a human touching
// them. Operator still sees every promotion in the ledger (via
// refinery.rule_auto_promoted) and can revoke at any time.
//
// State:
//   ~/.frontier/refinery/eval-passes.jsonl   append-only
//     Each line: { dateIso, ruleId, passed, items }
//     One line per (dateIso, ruleId) per call site. Idempotent per day —
//     calling recordEvalPasses twice on the same calendar date is a no-op.
//
// Promotion rule:
//   countConsecutivePassesEndingOnToday(ruleId) ≥ threshold  AND
//   proposal exists in proposals.jsonl  AND  not already in rules.jsonl

import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";

import { getLedger } from "../ledger/index.ts";
import { newSessionId } from "../ledger/events.ts";
import { loadProposals, loadRules, promoteProposal } from "./registry.ts";
import { runEvalDataset, type EvalRunSummary } from "../eval/runner.ts";

const PASSES_LOG = resolve(
  homedir(),
  ".frontier",
  "refinery",
  "eval-passes.jsonl",
);

export interface EvalPassRow {
  dateIso: string; // YYYY-MM-DD (local day — matches operator intuition)
  ruleId: string;
  passed: boolean;
  items: number;
}

export function recordEvalPasses(
  summary: EvalRunSummary,
  now: Date = new Date(),
): { appended: number; skippedAlreadyRecordedToday: number } {
  const today = isoDate(now);
  const existingToday = new Set<string>();
  for (const row of readPasses()) {
    if (row.dateIso === today) existingToday.add(row.ruleId);
  }

  const newRows: EvalPassRow[] = [];
  let skipped = 0;
  for (const [ruleId, stats] of Object.entries(summary.perRule)) {
    if (existingToday.has(ruleId)) {
      skipped++;
      continue;
    }
    // "Passed this round" = no regressions on any example for this rule.
    const passed = stats.regressed === 0 && stats.total > 0;
    newRows.push({ dateIso: today, ruleId, passed, items: stats.total });
  }

  if (newRows.length > 0) {
    mkdirSync(dirname(PASSES_LOG), { recursive: true });
    const body = newRows.map((r) => JSON.stringify(r)).join("\n") + "\n";
    appendFileSync(PASSES_LOG, body);
    const ledger = getLedger();
    const sessionId = newSessionId("refinery-auto-promote");
    ledger.ensureSession({
      sessionId,
      label: "refinery:auto-promote",
      tags: ["refinery", "auto-promote", today],
    });
    ledger.appendEvent({
      sessionId,
      kind: "refinery.eval_pass_recorded" as Parameters<
        typeof ledger.appendEvent
      >[0]["kind"],
      actor: "refinery.auto-promote",
      payload: {
        dateIso: today,
        recorded: newRows.length,
        passed: newRows.filter((r) => r.passed).length,
        failed: newRows.filter((r) => !r.passed).length,
      },
    });
  }
  return { appended: newRows.length, skippedAlreadyRecordedToday: skipped };
}

export interface ConsecutivePassCount {
  ruleId: string;
  consecutive: number;
  lastPassDate: string | null;
  lastFailDate: string | null;
}

/**
 * Trailing-consecutive count of passes for ruleId, ending at the most recent
 * recorded date. A failure anywhere in the history between today and the
 * earliest pass resets the counter from that point.
 */
export function consecutivePasses(ruleId: string): ConsecutivePassCount {
  // Build date-ordered pass history (most recent first).
  const rows = readPasses()
    .filter((r) => r.ruleId === ruleId)
    .sort((a, b) =>
      a.dateIso < b.dateIso ? 1 : a.dateIso > b.dateIso ? -1 : 0,
    );

  let consecutive = 0;
  let lastPassDate: string | null = null;
  let lastFailDate: string | null = null;
  for (const r of rows) {
    if (r.passed) {
      if (consecutive === 0 || r.dateIso !== lastFailDate) {
        // Still walking the "trailing passes" segment from most-recent.
      }
      consecutive++;
      if (lastPassDate === null) lastPassDate = r.dateIso;
    } else {
      lastFailDate = r.dateIso;
      break; // stop at first fail (walking from newest to oldest)
    }
  }
  return { ruleId, consecutive, lastPassDate, lastFailDate };
}

export interface AutoPromoteOptions {
  /** Consecutive passing days before a proposal is auto-promoted. Default 3. */
  threshold?: number;
  /** If true, evaluate and log but don't actually promote. */
  dryRun?: boolean;
  /** Inject a pre-computed eval summary (for tests). Default: call runEvalDataset(). */
  evalSummary?: EvalRunSummary;
}

export interface AutoPromoteResult {
  threshold: number;
  dateIso: string;
  evalItemsConsidered: number;
  evalPassed: number;
  evalRegressed: number;
  passesAppended: number;
  candidatesConsidered: number;
  alreadyPromoted: number;
  underThreshold: number;
  promoted: Array<{
    ruleId: string;
    consecutive: number;
    suggestedAction: string;
    result: ReturnType<typeof promoteProposal>;
  }>;
  dryRun: boolean;
}

export function autoPromote(
  options: AutoPromoteOptions = {},
): AutoPromoteResult {
  const threshold = Math.max(1, options.threshold ?? 3);
  const dryRun = Boolean(options.dryRun);
  const summary = options.evalSummary ?? runEvalDataset({});
  const record = recordEvalPasses(summary);

  const proposals = loadProposals();
  const promotedIds = new Set(loadRules().map((r) => r.ruleId));
  const promoted: AutoPromoteResult["promoted"] = [];
  let underThreshold = 0;

  for (const proposal of proposals) {
    if (promotedIds.has(proposal.ruleId)) continue;
    const cp = consecutivePasses(proposal.ruleId);
    if (cp.consecutive < threshold) {
      underThreshold++;
      continue;
    }
    if (dryRun) {
      promoted.push({
        ruleId: proposal.ruleId,
        consecutive: cp.consecutive,
        suggestedAction: proposal.suggestedAction,
        result: { status: "would_promote" } as unknown as ReturnType<
          typeof promoteProposal
        >,
      });
      continue;
    }
    const result = promoteProposal(proposal.ruleId);
    promoted.push({
      ruleId: proposal.ruleId,
      consecutive: cp.consecutive,
      suggestedAction: proposal.suggestedAction,
      result,
    });
    if (result.status === "ok") {
      const ledger = getLedger();
      const sid = newSessionId("refinery-auto-promote");
      ledger.ensureSession({
        sessionId: sid,
        label: `refinery:auto-promote:${proposal.ruleId}`,
        tags: ["refinery", "auto-promote", "rule_auto_promoted"],
      });
      ledger.appendEvent({
        sessionId: sid,
        kind: "refinery.rule_auto_promoted" as Parameters<
          typeof ledger.appendEvent
        >[0]["kind"],
        actor: "refinery.auto-promote",
        payload: {
          ruleId: proposal.ruleId,
          suggestedAction: proposal.suggestedAction,
          consecutivePasses: cp.consecutive,
          threshold,
          reason: proposal.reason,
        },
      });
    }
  }

  return {
    threshold,
    dateIso: isoDate(),
    evalItemsConsidered: summary.itemsConsidered,
    evalPassed: summary.passed,
    evalRegressed: summary.regressed,
    passesAppended: record.appended,
    candidatesConsidered: proposals.length - promotedIds.size,
    alreadyPromoted: promotedIds.size,
    underThreshold,
    promoted,
    dryRun,
  };
}

// ---- helpers ----

function readPasses(): EvalPassRow[] {
  if (!existsSync(PASSES_LOG)) return [];
  const lines = readFileSync(PASSES_LOG, "utf8").split(/\r?\n/);
  const out: EvalPassRow[] = [];
  for (const line of lines) {
    if (!line.trim()) continue;
    try {
      const row = JSON.parse(line) as Partial<EvalPassRow>;
      if (
        typeof row.dateIso === "string" &&
        typeof row.ruleId === "string" &&
        typeof row.passed === "boolean" &&
        typeof row.items === "number"
      ) {
        out.push(row as EvalPassRow);
      }
    } catch {
      /* skip malformed */
    }
  }
  return out;
}

function isoDate(d: Date = new Date()): string {
  return d.toISOString().slice(0, 10);
}

export function passesLogPath(): string {
  return PASSES_LOG;
}
