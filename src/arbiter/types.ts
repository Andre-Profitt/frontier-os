// Arbiter type contracts. Mirror schemas/arbiter-decision.schema.json.
// Kept in sync manually; the loader test asserts the schema validates the
// runtime shape so drift surfaces in CI.

export type ArbiterDecisionKind =
  | "accept"
  | "combine"
  | "reject"
  | "escalate_to_human";

export type VerificationPhase =
  | "skipped"
  | "worktree_missing"
  | "typecheck_failed"
  | "tests_failed"
  // typecheck succeeded; tests were not run because no testCommand was
  // supplied. Distinct from "passed" so the arbiter can refuse to call
  // a candidate "verified" when only half the verification ran.
  // (GPT Pro review Issue #5.)
  | "passed_typecheck_only"
  | "passed";

export interface VerificationResult {
  builderId: string;
  worktreePath?: string;
  phase: VerificationPhase;
  typecheckExitCode?: number;
  testExitCode?: number;
  typecheckStderr?: string;
  testStderr?: string;
  ranAt: string;
  elapsedMs?: number;
}

export interface CriterionScore {
  id: string;
  // null when this criterion can't be scored heuristically. v1 leaves
  // soft criteria null rather than fabricating a number; an LLM judge
  // can fill them in a future pass.
  score: number | null;
  weight?: number;
  rationale: string;
}

export interface RubricScore {
  builderId: string;
  rubricId: string;
  // Weighted aggregate of non-null criterion scores. If every criterion
  // is null this is 0; arbiter handles that explicitly.
  score: number;
  // Sum of weights for criteria with non-null scores.
  scoredWeight: number;
  // Sum of weights across the entire rubric.
  totalWeight: number;
  // scoredWeight / totalWeight. Arbiter MUST gate on this in addition
  // to score so a candidate can't earn 1.0 from one criterion out of
  // ten. (GPT Pro review Issue #3.)
  coverage: number;
  // IDs of criteria that returned score=null (heuristic could not fire).
  // Surfaced so the operator sees which dimensions were not assessed.
  unsupportedCriteria: string[];
  criteria: CriterionScore[];
}

export interface AntiExampleMatch {
  builderId: string;
  antiExample: string;
  verdict: "matches" | "safe" | "unsure";
  evidence?: string;
}

export interface ArbiterDecision {
  decisionId: string;
  scannedAt: string;
  taskId: string;
  packetId?: string;
  decision: ArbiterDecisionKind;
  selectedBuilderId?: string;
  combineInstructions?: string[];
  rejectionReasons?: string[];
  escalationQuestion?: string;
  qualityFloor?: number;
  candidatesEvaluated: number;
  rerunVerification: {
    builderIds: string[];
    results: VerificationResult[];
  };
  rubricScores: RubricScore[];
  antiExampleMatches: AntiExampleMatch[];
  evidence: string;
  elapsedMs?: number;
}
