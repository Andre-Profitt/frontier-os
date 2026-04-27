// Type contracts for the builder swarm. Mirrors schemas/builder-run.schema.json.
// Kept in sync manually — the loader test asserts the schema validates the
// runtime shape, so drift surfaces in CI.

export type BuilderStatus = "spawned" | "collected" | "cleaned" | "failed";

export type BuilderErrorPhase = "spawn" | "collect" | "clean";

export interface BuilderPatch {
  // Unified diff captured at collect time. Includes commits between
  // baseCommit and the worktree's HEAD.
  diff: string;
  // Files changed in the diff. Sorted, deduplicated.
  files: string[];
  sizeBytes: number;
  addedLines: number;
  deletedLines: number;
  // Number of commits the builder made on top of baseCommit. 0 means the
  // builder's edits are uncommitted in the worktree at collect time.
  commitCount: number;
}

export interface BuilderError {
  phase: BuilderErrorPhase;
  message: string;
  stderr?: string;
}

export interface BuilderRun {
  runId: string;
  taskId: string;
  builderId: string;
  taskClass: string;
  modelKey?: string;
  baseBranch: string;
  // SHA at spawn time; the diff is taken against this exact commit, not the
  // current tip of baseBranch (which may have moved).
  baseCommit: string;
  branchName: string;
  // Absolute path to the worktree dir.
  worktreePath: string;
  createdAt: string;
  status: BuilderStatus;
  collectedAt?: string;
  cleanedAt?: string;
  patch?: BuilderPatch;
  error?: BuilderError;
}
