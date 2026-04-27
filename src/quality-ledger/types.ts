// Quality ledger event types. Mirror schemas/quality-ledger-event.schema.json.
// Discriminated union by `kind`. Persisted as one event per line in
// state/quality-ledger/<kind>s.jsonl (e.g. worker-runs.jsonl).
//
// PR Q1 writes these from an OrchestrationPacket. PR Q3 (scorecard) reads
// them to compute per-(model, role) success rates. PR Q4 (policy
// recommender) compares those scores against the current
// config/model-policy.json to suggest moves.

export type EventKind =
  | "worker_run"
  | "review_finding"
  | "arbiter_decision"
  | "model_event";

export interface BaseEvent {
  eventId: string;
  taskId: string;
  packetId: string;
  ts: string;
  kind: EventKind;
}

// One row per builder candidate (any phase). Joins the builder's
// rubric score, verification phase, and arbiter outcome so a downstream
// query like "which model produced apply_failed patches" needs only
// this file.
export interface WorkerRunEvent extends BaseEvent {
  kind: "worker_run";
  workerId: string;
  role: "builder";
  modelKey?: string;
  taskClass: string;
  phase: string;
  ok: boolean;
  patch?: {
    sizeBytes: number;
    addedLines: number;
    deletedLines: number;
    commitCount: number;
    files: string[];
  };
  rubricScore?: number;
  rubricCoverage?: number;
  verificationPhase?: string;
  // selected = arbiter chose this candidate
  // not_selected = arbiter evaluated but didn't pick (or escalated)
  // excluded = candidate didn't reach phase=collected, never evaluated
  arbiterOutcome: "selected" | "not_selected" | "excluded";
  // Aggregate from this candidate's review packet (if any).
  reviewFindings?: {
    high?: number;
    medium?: number;
    low?: number;
    bug?: number;
    contract_violation?: number;
    false_green?: number;
    risk?: number;
    style?: number;
  };
}

// One row per finding produced by a reviewer about a candidate.
// Denormalized — easy to query "how many bug-category findings did
// nim:deepseek produce in adversarial_review."
export interface ReviewFindingEvent extends BaseEvent {
  kind: "review_finding";
  reviewerId: string;
  modelKey?: string;
  reviewerRole: "reviewer";
  taskClass: string;
  category: "bug" | "contract_violation" | "false_green" | "risk" | "style";
  severity: "high" | "medium" | "low";
  file?: string;
  line?: number;
  claim: string;
  reviewedBuilderId: string;
}

// One row per orchestration's arbiter decision.
export interface ArbiterDecisionEvent extends BaseEvent {
  kind: "arbiter_decision";
  decision: "accept" | "combine" | "reject" | "escalate_to_human";
  selectedBuilderId?: string;
  qualityFloor?: number;
  candidatesEvaluated: number;
  // True iff at least one candidate's verifier re-run reached phase=passed.
  rerunVerificationOk: boolean;
}

// Per (modelKey, role, taskClass) aggregate within a single
// orchestration. Multiple rows possible per orchestration if more than
// one model was used per role.
export interface ModelEvent extends BaseEvent {
  kind: "model_event";
  modelKey: string;
  role: "builder" | "reviewer";
  taskClass: string;
  callsTotal: number;
  callsOk: number;
  callsFailed: number;
  arbiterSelectedCount?: number;
}

export type QualityLedgerEvent =
  | WorkerRunEvent
  | ReviewFindingEvent
  | ArbiterDecisionEvent
  | ModelEvent;

export class QualityLedgerError extends Error {
  constructor(
    message: string,
    public details?: unknown,
  ) {
    super(message);
    this.name = "QualityLedgerError";
  }
}
