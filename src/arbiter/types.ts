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
