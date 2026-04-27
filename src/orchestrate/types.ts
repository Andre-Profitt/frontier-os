// R6 orchestrator types. Mirrors schemas/orchestration-packet.schema.json.
//
// Two roles for these types:
//   1. The runtime shape of the orchestrator's input/output (used by
//      runOrchestration in src/orchestrate/orchestrator.ts).
//   2. The persisted-artifact contract (validated against the schema on
//      write so PR Q1 can ingest one cleanly).

export interface OrchestrationInput {
  taskId: string;
  taskDescription: string;
  // Files the builder is scoped to edit. See builder-swarm.ts /
  // diff-scope-checker.ts for the gate semantics. Empty list requires
  // allowUnscopedDiff: true.
  touchList?: string[];
  allowUnscopedDiff?: boolean;
  baseBranch?: string;
  // Number of parallel builders. Defaults to 3.
  builderCount?: number;
  // Number of reviewers PER candidate. Defaults to 3.
  reviewerCount?: number;
  // Override the broker task class for builders / reviewers.
  builderTaskClass?: string;
  reviewerTaskClass?: string;
  // Per-builder pinned modelKey list (length should equal builderCount;
  // shorter lists wrap). Forwarded to BuilderSwarmInput.modelKeys.
  builderModelKeys?: string[];
  // Patch P: per-reviewer pinned modelKey list. When undefined, the
  // orchestrator derives this from the policy's
  // adversarial_review.models[] (filtered to enabled providers).
  // Distributed round-robin: reviewer i uses
  // reviewerModelKeys[i % reviewerModelKeys.length]. Pre-Patch-P,
  // reviewers all funneled to the policy primary regardless of how
  // many alternate models the class listed.
  reviewerModelKeys?: string[];
  // Required: rubric for the arbiter.
  rubricPath: string;
  // Arbiter gates — defaults match arbiter.ts.
  qualityFloor?: number;
  minRubricCoverage?: number;
  minReviewCoverage?: number;
  requireTests?: boolean;
  antiExamplePaths?: string[];
  // Optional context-pack lane. When set, the orchestrator runs the
  // context pack first and writes the markdown to artifacts. When
  // unset, no context pack is generated.
  contextPackLane?: string;
  // Per-arbiter-rerun verification commands. Same defaults as
  // ArbiterInput.
  typecheckCommand?: string[] | null;
  testCommand?: string[] | null;
  // Output dir. Defaults to artifacts/orchestrations/<taskId>/.
  artifactsDir?: string;
  // When true, the orchestrator removes builder worktrees after the
  // arbiter has produced a decision. Default false (keep worktrees so
  // the operator can inspect / re-run).
  cleanup?: boolean;
}

// What gets persisted at artifacts/orchestrations/<taskId>/orchestration-packet.json.
// PR Q1 (quality ledger writer) ingests one of these per run.
export interface OrchestrationPacket {
  packetId: string;
  taskId: string;
  scannedAt: string;
  // Subset of OrchestrationInput recorded for the audit trail. Omits
  // test-seam fields and the rubricPath argument is preserved.
  input: {
    taskDescription: string;
    touchList?: string[];
    allowUnscopedDiff?: boolean;
    baseBranch?: string;
    builderCount: number;
    reviewerCount: number;
    builderTaskClass?: string;
    reviewerTaskClass?: string;
    builderModelKeys?: string[];
    reviewerModelKeys?: string[];
    rubricPath?: string;
    qualityFloor?: number;
    minRubricCoverage?: number;
    minReviewCoverage?: number;
    requireTests?: boolean;
    antiExamplePaths?: string[];
    contextPackLane?: string;
    cleanup?: boolean;
  };
  // Path to the context pack markdown if generated.
  contextPackPath?: string;
  builderPacketPath: string;
  reviewPacketPaths: Array<{ builderId: string; path: string }>;
  arbiterDecisionPath: string;
  finalReportPath: string;
  artifactsDir: string;
  summary?: {
    buildersSpawned: number;
    buildersCollected: number;
    reviewSwarmsRun: number;
    arbiterDecision: "accept" | "combine" | "reject" | "escalate_to_human";
    selectedBuilderId?: string;
    modelsUsed: string[];
  };
  // Matches the arbiter CLI exit codes:
  //   0 = accept
  //   1 = reject
  //   2 = escalate_to_human
  exitCode: 0 | 1 | 2;
  elapsedMs: number;
}

export class OrchestrationError extends Error {
  constructor(
    message: string,
    public details?: unknown,
  ) {
    super(message);
    this.name = "OrchestrationError";
  }
}
