// Heuristic rubric scorer for v1.
//
// The arbiter loads a rubric from taste/rubrics/<id>.json and produces a
// CriterionScore[] per candidate. v1 scores ONLY criteria for which we
// have an objective signal:
//   - typecheck/test exit codes from the verifier
//   - reviewer findings (bug count, contract_violation count, severity)
//   - candidate phase (collected vs failed)
// Soft criteria (taste, rationale-quality) are left score=null with a
// rationale explaining why. A future PR can plumb an LLM judge here.
//
// The mapping from rubric criterion → signal is deliberately
// conservative: better to leave a criterion null than to fabricate a
// number that the operator might trust.

import { readFileSync, existsSync } from "node:fs";

import type {
  CriterionScore,
  RubricScore,
  VerificationResult,
} from "./types.ts";

export interface Rubric {
  rubricId: string;
  version: string;
  summary: string;
  criteria: Array<{
    id: string;
    title: string;
    rationale: string;
    weight: number;
  }>;
  non_goals?: string[];
  calibration?: Record<string, unknown>;
}

export interface ScorerInput {
  builderId: string;
  rubric: Rubric;
  verification: VerificationResult | null;
  reviewerFindings: ReviewerFindingSummary;
}

export interface ReviewerFindingSummary {
  // Per-category counts. Missing categories default to 0.
  bug?: number;
  contract_violation?: number;
  false_green?: number;
  risk?: number;
  style?: number;
  // Per-severity counts.
  high?: number;
  medium?: number;
  low?: number;
  // Whether any reviewer matched an anti-example pointer.
  antiExampleMatched?: boolean;
}

export function loadRubric(path: string): Rubric {
  if (!existsSync(path)) {
    throw new Error(`rubric not found: ${path}`);
  }
  const raw = JSON.parse(readFileSync(path, "utf8")) as Partial<Rubric>;
  if (
    typeof raw.rubricId !== "string" ||
    !Array.isArray(raw.criteria) ||
    raw.criteria.length === 0
  ) {
    throw new Error(
      `rubric ${path} missing required fields (rubricId, criteria)`,
    );
  }
  return raw as Rubric;
}

export function scoreCandidate(input: ScorerInput): RubricScore {
  const f = input.reviewerFindings;
  const v = input.verification;
  const criteria: CriterionScore[] = [];

  for (const c of input.rubric.criteria) {
    const result = scoreCriterion(c, v, f);
    criteria.push({
      id: c.id,
      score: result.score,
      weight: c.weight,
      rationale: result.rationale,
    });
  }

  // Weighted aggregate over non-null criteria.
  let totalWeight = 0;
  let weightedSum = 0;
  for (const c of criteria) {
    if (c.score === null) continue;
    const w = c.weight ?? 1;
    totalWeight += w;
    weightedSum += c.score * w;
  }
  const aggregate = totalWeight > 0 ? weightedSum / totalWeight : 0;

  return {
    builderId: input.builderId,
    rubricId: input.rubric.rubricId,
    score: aggregate,
    criteria,
  };
}

// Map rubric criterion to a heuristic signal. The criterion ID alone is
// not enough — we need to know what the rubric is FOR. v1 uses the
// title/rationale text to detect "passes", "tests", "verification",
// "false green", etc. and maps to objective signals.
//
// This is intentionally fragile: when the rubric author changes wording,
// the heuristic might drop a criterion to null. That's a feature — bad
// scoring is worse than no scoring.
function scoreCriterion(
  c: Rubric["criteria"][number],
  v: VerificationResult | null,
  f: ReviewerFindingSummary,
): { score: number | null; rationale: string } {
  const blob = `${c.title} ${c.rationale}`.toLowerCase();

  // Verification-derived signals.
  if (
    blob.includes("passed implies") ||
    blob.includes("classification") ||
    blob.includes("invariant")
  ) {
    if (!v)
      return { score: null, rationale: "no verification re-run available" };
    if (v.phase === "worktree_missing") {
      return { score: 0, rationale: "worktree missing — cannot verify" };
    }
    if (v.phase === "typecheck_failed" || v.phase === "tests_failed") {
      return {
        score: 0,
        rationale: `verification re-run ${v.phase}; passed-implies-invariants criterion not satisfied`,
      };
    }
    if (v.phase === "passed") {
      return {
        score: 1,
        rationale: "verification re-run passed (typecheck + test exit 0)",
      };
    }
    return {
      score: null,
      rationale: `verification phase=${v.phase} — not directly mapped`,
    };
  }

  // Reviewer-derived signals — false-green and contract-violation.
  if (blob.includes("false green") || blob.includes("false-green")) {
    const fg = f.false_green ?? 0;
    return fg > 0
      ? {
          score: 0,
          rationale: `reviewers flagged ${fg} false_green findings`,
        }
      : {
          score: 1,
          rationale: "no reviewer flagged false_green",
        };
  }
  if (blob.includes("invariant") || blob.includes("contract")) {
    const cv = f.contract_violation ?? 0;
    return cv > 0
      ? {
          score: 0,
          rationale: `reviewers flagged ${cv} contract_violation findings`,
        }
      : { score: 1, rationale: "no reviewer flagged contract_violation" };
  }

  // Anti-example matched? Penalize criteria mentioning "anti", "exemplar", "calibration".
  if (
    f.antiExampleMatched &&
    (blob.includes("anti") || blob.includes("exemplar"))
  ) {
    return {
      score: 0,
      rationale: "reviewer matched a taste/anti_examples/ pattern",
    };
  }

  // Generic high-severity bug penalty: if no specific match, the presence
  // of high-severity bugs is a signal that SOMETHING is wrong, but we
  // don't know which criterion fails — leave null with a note.
  return {
    score: null,
    rationale:
      "no objective heuristic for this criterion (soft criterion; LLM judge would help)",
  };
}
