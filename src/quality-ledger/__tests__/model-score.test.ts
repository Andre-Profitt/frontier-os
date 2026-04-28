// Quality ledger model-score tests. Pure-function math over a
// LedgerSnapshot — no fs.

import { test } from "node:test";
import assert from "node:assert/strict";

import { computeFromSnapshot, type ModelScore } from "../model-score.ts";
import type {
  ArbiterDecisionEvent,
  ModelEvent,
  ReviewFindingEvent,
  WorkerRunEvent,
} from "../types.ts";

const TS = "2026-04-26T22:00:00.000Z";

function wr(opts: {
  workerId: string;
  modelKey?: string;
  phase: string;
  ok?: boolean;
  arbiterOutcome: "selected" | "not_selected" | "excluded";
  taskClass?: string;
  rubricScore?: number;
  rubricCoverage?: number;
  reviewFindings?: WorkerRunEvent["reviewFindings"];
  packetId?: string;
  applyAttempts?: number;
  verifyAttempts?: number;
  builderVerificationPhase?: string;
}): WorkerRunEvent {
  const result: WorkerRunEvent = {
    eventId: `e-${opts.workerId}`,
    taskId: "t",
    packetId: opts.packetId ?? "p",
    ts: TS,
    kind: "worker_run",
    workerId: opts.workerId,
    role: "builder",
    taskClass: opts.taskClass ?? "patch_builder",
    phase: opts.phase,
    ok: opts.ok ?? opts.phase === "collected",
    arbiterOutcome: opts.arbiterOutcome,
  };
  if (opts.modelKey !== undefined) result.modelKey = opts.modelKey;
  if (opts.rubricScore !== undefined) result.rubricScore = opts.rubricScore;
  if (opts.rubricCoverage !== undefined)
    result.rubricCoverage = opts.rubricCoverage;
  if (opts.reviewFindings !== undefined)
    result.reviewFindings = opts.reviewFindings;
  if (opts.applyAttempts !== undefined)
    result.applyAttempts = opts.applyAttempts;
  if (opts.verifyAttempts !== undefined)
    result.verifyAttempts = opts.verifyAttempts;
  if (opts.builderVerificationPhase !== undefined)
    result.builderVerificationPhase = opts.builderVerificationPhase;
  return result;
}

function rf(opts: {
  reviewerId: string;
  modelKey?: string;
  category: ReviewFindingEvent["category"];
  severity: ReviewFindingEvent["severity"];
  reviewedBuilderId: string;
  taskClass?: string;
}): ReviewFindingEvent {
  const result: ReviewFindingEvent = {
    eventId: `e-${opts.reviewerId}-${opts.category}-${opts.severity}`,
    taskId: "t",
    packetId: "p",
    ts: TS,
    kind: "review_finding",
    reviewerId: opts.reviewerId,
    reviewerRole: "reviewer",
    taskClass: opts.taskClass ?? "adversarial_review",
    category: opts.category,
    severity: opts.severity,
    claim: "x",
    reviewedBuilderId: opts.reviewedBuilderId,
  };
  if (opts.modelKey !== undefined) result.modelKey = opts.modelKey;
  return result;
}

function ad(opts: {
  decision: ArbiterDecisionEvent["decision"];
  anyCandidateVerified?: boolean;
  selectedCandidateVerified?: boolean;
}): ArbiterDecisionEvent {
  return {
    eventId: "e-ad",
    taskId: "t",
    packetId: "p",
    ts: TS,
    kind: "arbiter_decision",
    decision: opts.decision,
    candidatesEvaluated: 1,
    anyCandidateVerified: opts.anyCandidateVerified ?? true,
    selectedCandidateVerified: opts.selectedCandidateVerified ?? true,
  };
}

function me(opts: {
  modelKey: string;
  role: "builder" | "reviewer";
  taskClass?: string;
  callsTotal: number;
  callsOk: number;
  callsFailed: number;
  arbiterSelectedCount?: number;
}): ModelEvent {
  const result: ModelEvent = {
    eventId: `e-${opts.modelKey}-${opts.role}`,
    taskId: "t",
    packetId: "p",
    ts: TS,
    kind: "model_event",
    modelKey: opts.modelKey,
    role: opts.role,
    taskClass:
      opts.taskClass ??
      (opts.role === "builder" ? "patch_builder" : "adversarial_review"),
    callsTotal: opts.callsTotal,
    callsOk: opts.callsOk,
    callsFailed: opts.callsFailed,
  };
  if (opts.arbiterSelectedCount !== undefined)
    result.arbiterSelectedCount = opts.arbiterSelectedCount;
  return result;
}

// --- builder scoring -----------------------------------------------------

test("computeFromSnapshot: builder all collected → collectedRate=1, per-packet selectionRate", () => {
  // Both candidates in the same packetId="p", so this model
  // participated in 1 orchestration and won it.
  // selectionRate is per-packet (not per-candidate) because the arbiter
  // only picks one candidate per packet — see BuilderModelScore docs.
  const scores = computeFromSnapshot({
    workerRuns: [
      wr({
        workerId: "b1",
        modelKey: "nim:k1",
        phase: "collected",
        arbiterOutcome: "selected",
      }),
      wr({
        workerId: "b2",
        modelKey: "nim:k1",
        phase: "collected",
        arbiterOutcome: "not_selected",
      }),
    ],
    reviewFindings: [],
    arbiterDecisions: [ad({ decision: "accept" })],
    modelEvents: [],
    humanDecisions: [],
  });
  const k1 = scores.find((s) => s.modelKey === "nim:k1") as Extract<
    ModelScore,
    { role: "builder" }
  >;
  assert.equal(k1.candidates, 2);
  assert.equal(k1.collected, 2);
  assert.equal(k1.collectedRate, 1);
  assert.equal(k1.arbiterSelected, 1);
  assert.equal(k1.orchestrationsParticipated, 1);
  assert.equal(k1.orchestrationsWon, 1);
  assert.equal(k1.selectionRate, 1);
});

// Patch H — B1: selectionRate denominator must be packets, not collected
// candidates. Otherwise a model that produces N candidates per packet
// has a structural ceiling of 1/N, which conflates "candidates per
// packet" with "model quality."
test("computeFromSnapshot: selectionRate is per-packet (not per-candidate)", () => {
  // Same model produces 3 collected candidates each across 2 packets;
  // the arbiter picks one of its candidates in BOTH packets.
  // Per-candidate math would say 2/6 = 0.33. Correct math: 2/2 = 1.0.
  const scores = computeFromSnapshot({
    workerRuns: [
      // packet p1: 3 candidates, b1 wins
      wr({
        workerId: "b1",
        modelKey: "nim:k1",
        phase: "collected",
        arbiterOutcome: "selected",
        packetId: "p1",
      }),
      wr({
        workerId: "b2",
        modelKey: "nim:k1",
        phase: "collected",
        arbiterOutcome: "not_selected",
        packetId: "p1",
      }),
      wr({
        workerId: "b3",
        modelKey: "nim:k1",
        phase: "collected",
        arbiterOutcome: "not_selected",
        packetId: "p1",
      }),
      // packet p2: 3 candidates, b4 wins
      wr({
        workerId: "b4",
        modelKey: "nim:k1",
        phase: "collected",
        arbiterOutcome: "selected",
        packetId: "p2",
      }),
      wr({
        workerId: "b5",
        modelKey: "nim:k1",
        phase: "collected",
        arbiterOutcome: "not_selected",
        packetId: "p2",
      }),
      wr({
        workerId: "b6",
        modelKey: "nim:k1",
        phase: "collected",
        arbiterOutcome: "not_selected",
        packetId: "p2",
      }),
    ],
    reviewFindings: [],
    arbiterDecisions: [ad({ decision: "accept" })],
    modelEvents: [],
    humanDecisions: [],
  });
  const k1 = scores.find((s) => s.modelKey === "nim:k1") as Extract<
    ModelScore,
    { role: "builder" }
  >;
  assert.equal(k1.candidates, 6);
  assert.equal(k1.collected, 6);
  assert.equal(k1.arbiterSelected, 2);
  assert.equal(k1.orchestrationsParticipated, 2);
  assert.equal(k1.orchestrationsWon, 2);
  assert.equal(k1.selectionRate, 1); // not 2/6 = 0.33
});

test("computeFromSnapshot: builder with mixed phases → phases breakdown + collectedRate", () => {
  const scores = computeFromSnapshot({
    workerRuns: [
      wr({
        workerId: "b1",
        modelKey: "nim:k1",
        phase: "collected",
        arbiterOutcome: "selected",
      }),
      wr({
        workerId: "b2",
        modelKey: "nim:k1",
        phase: "apply_failed",
        ok: false,
        arbiterOutcome: "excluded",
      }),
      wr({
        workerId: "b3",
        modelKey: "nim:k1",
        phase: "no_diff_extracted",
        ok: false,
        arbiterOutcome: "excluded",
      }),
    ],
    reviewFindings: [],
    arbiterDecisions: [ad({ decision: "accept" })],
    modelEvents: [],
    humanDecisions: [],
  });
  const k1 = scores.find((s) => s.modelKey === "nim:k1") as Extract<
    ModelScore,
    { role: "builder" }
  >;
  assert.equal(k1.candidates, 3);
  assert.equal(k1.collected, 1);
  assert.equal(Math.abs(k1.collectedRate - 1 / 3) < 1e-6, true);
  assert.deepEqual(k1.phases, {
    collected: 1,
    apply_failed: 1,
    no_diff_extracted: 1,
  });
});

test("computeFromSnapshot: builder mean rubric score + coverage over collected candidates", () => {
  const scores = computeFromSnapshot({
    workerRuns: [
      wr({
        workerId: "b1",
        modelKey: "nim:k1",
        phase: "collected",
        arbiterOutcome: "selected",
        rubricScore: 0.8,
        rubricCoverage: 0.6,
      }),
      wr({
        workerId: "b2",
        modelKey: "nim:k1",
        phase: "collected",
        arbiterOutcome: "not_selected",
        rubricScore: 0.4,
        rubricCoverage: 0.4,
      }),
    ],
    reviewFindings: [],
    arbiterDecisions: [ad({ decision: "accept" })],
    modelEvents: [],
    humanDecisions: [],
  });
  const k1 = scores.find((s) => s.modelKey === "nim:k1") as Extract<
    ModelScore,
    { role: "builder" }
  >;
  assert.ok(Math.abs((k1.meanRubricScore ?? 0) - 0.6) < 1e-6);
  assert.ok(Math.abs((k1.meanRubricCoverage ?? 0) - 0.5) < 1e-6);
});

test("computeFromSnapshot: highBugFindingsAgainst counts only when high-severity AND bug/contract", () => {
  const scores = computeFromSnapshot({
    workerRuns: [
      wr({
        workerId: "b1",
        modelKey: "nim:k1",
        phase: "collected",
        arbiterOutcome: "not_selected",
        reviewFindings: {
          high: 2,
          bug: 1,
          contract_violation: 1,
          low: 0,
          medium: 0,
          false_green: 0,
          risk: 0,
          style: 0,
        },
      }),
      wr({
        workerId: "b2",
        modelKey: "nim:k2",
        phase: "collected",
        arbiterOutcome: "not_selected",
        // High severity but no bug or contract — conservative scorer ignores.
        reviewFindings: {
          high: 3,
          bug: 0,
          contract_violation: 0,
          low: 0,
          medium: 0,
          false_green: 0,
          risk: 0,
          style: 3,
        },
      }),
    ],
    reviewFindings: [],
    arbiterDecisions: [ad({ decision: "escalate_to_human" })],
    modelEvents: [],
    humanDecisions: [],
  });
  const k1 = scores.find((s) => s.modelKey === "nim:k1") as Extract<
    ModelScore,
    { role: "builder" }
  >;
  const k2 = scores.find((s) => s.modelKey === "nim:k2") as Extract<
    ModelScore,
    { role: "builder" }
  >;
  assert.equal(k1.highBugFindingsAgainst, 2);
  assert.equal(k2.highBugFindingsAgainst, 0);
});

test("computeFromSnapshot: candidates without modelKey are skipped", () => {
  const scores = computeFromSnapshot({
    workerRuns: [
      wr({
        workerId: "anon",
        phase: "collected",
        arbiterOutcome: "not_selected",
      }),
    ],
    reviewFindings: [],
    arbiterDecisions: [ad({ decision: "escalate_to_human" })],
    modelEvents: [],
    humanDecisions: [],
  });
  assert.equal(scores.length, 0);
});

// --- reviewer scoring ----------------------------------------------------

test("computeFromSnapshot: reviewer findings aggregated by category and severity", () => {
  const scores = computeFromSnapshot({
    workerRuns: [],
    reviewFindings: [
      rf({
        reviewerId: "r1",
        modelKey: "nim:rev",
        category: "bug",
        severity: "high",
        reviewedBuilderId: "b1",
      }),
      rf({
        reviewerId: "r1",
        modelKey: "nim:rev",
        category: "bug",
        severity: "low",
        reviewedBuilderId: "b1",
      }),
      rf({
        reviewerId: "r1",
        modelKey: "nim:rev",
        category: "style",
        severity: "low",
        reviewedBuilderId: "b1",
      }),
    ],
    arbiterDecisions: [],
    modelEvents: [
      me({
        modelKey: "nim:rev",
        role: "reviewer",
        callsTotal: 3,
        callsOk: 3,
        callsFailed: 0,
      }),
    ],
    humanDecisions: [],
  });
  const rev = scores.find(
    (s) => s.modelKey === "nim:rev" && s.role === "reviewer",
  ) as Extract<ModelScore, { role: "reviewer" }>;
  assert.equal(rev.findings, 3);
  assert.equal(rev.findingsByCategory["bug"], 2);
  assert.equal(rev.findingsByCategory["style"], 1);
  assert.equal(rev.findingsBySeverity["high"], 1);
  assert.equal(rev.findingsBySeverity["low"], 2);
  // High-impact = high-severity + bug or contract_violation. Only the
  // high-bug counts. The low-bug and low-style do not.
  assert.equal(rev.highImpactFindings, 1);
});

test("computeFromSnapshot: reviewer validityRate = validRuns / runs", () => {
  const scores = computeFromSnapshot({
    workerRuns: [],
    reviewFindings: [],
    arbiterDecisions: [],
    modelEvents: [
      me({
        modelKey: "nim:rev",
        role: "reviewer",
        callsTotal: 10,
        callsOk: 7,
        callsFailed: 3,
      }),
    ],
    humanDecisions: [],
  });
  const rev = scores.find((s) => s.modelKey === "nim:rev") as Extract<
    ModelScore,
    { role: "reviewer" }
  >;
  assert.ok(Math.abs(rev.validityRate - 0.7) < 1e-6);
});

// --- filters --------------------------------------------------------------

test("computeFromSnapshot: role=builder filter excludes reviewers", () => {
  const scores = computeFromSnapshot(
    {
      workerRuns: [
        wr({
          workerId: "b1",
          modelKey: "nim:k1",
          phase: "collected",
          arbiterOutcome: "selected",
        }),
      ],
      reviewFindings: [
        rf({
          reviewerId: "r1",
          modelKey: "nim:rev",
          category: "bug",
          severity: "high",
          reviewedBuilderId: "b1",
        }),
      ],
      arbiterDecisions: [],
      modelEvents: [
        me({
          modelKey: "nim:rev",
          role: "reviewer",
          callsTotal: 1,
          callsOk: 1,
          callsFailed: 0,
        }),
      ],
      humanDecisions: [],
    },
    { role: "builder" },
  );
  assert.equal(scores.length, 1);
  assert.equal(scores[0]?.role, "builder");
});

test("computeFromSnapshot: taskClass filter narrows to one class", () => {
  const scores = computeFromSnapshot(
    {
      workerRuns: [
        wr({
          workerId: "b1",
          modelKey: "nim:k1",
          phase: "collected",
          arbiterOutcome: "selected",
          taskClass: "patch_builder",
        }),
        wr({
          workerId: "b2",
          modelKey: "nim:k1",
          phase: "collected",
          arbiterOutcome: "selected",
          taskClass: "research_extraction",
        }),
      ],
      reviewFindings: [],
      arbiterDecisions: [],
      modelEvents: [],
      humanDecisions: [],
    },
    { taskClass: "patch_builder" },
  );
  assert.equal(scores.length, 1);
  assert.equal(scores[0]?.taskClass, "patch_builder");
});

// --- ordering -----------------------------------------------------------

test("computeFromSnapshot: builder scores sorted before reviewer scores", () => {
  const scores = computeFromSnapshot({
    workerRuns: [
      wr({
        workerId: "b1",
        modelKey: "nim:k1",
        phase: "collected",
        arbiterOutcome: "selected",
      }),
    ],
    reviewFindings: [],
    arbiterDecisions: [],
    modelEvents: [
      me({
        modelKey: "nim:rev",
        role: "reviewer",
        callsTotal: 1,
        callsOk: 1,
        callsFailed: 0,
      }),
    ],
    humanDecisions: [],
  });
  assert.equal(scores.length, 2);
  assert.equal(scores[0]?.role, "builder");
  assert.equal(scores[1]?.role, "reviewer");
});

// --- Patch EE: apply-retry + verify-retry yield -------------------------
//
// Each retry costs broker calls. The scorecard must surface the actual
// rescue rate per (model, class) so an operator can decide whether the
// budget is paying off — a model with rescueRate=0.0 is just burning
// retries, while rescueRate=0.5+ proves the retry is doing meaningful
// work for that model.

test("computeFromSnapshot (Patch EE): applyRetry stats — used = applyAttempts > 1, rescued = used AND phase=collected", () => {
  const scores = computeFromSnapshot({
    workerRuns: [
      // Model k1: 2 candidates triggered apply-retry; 1 was rescued
      // (collected after the retry), 1 wasn't (apply_failed even
      // after retry).
      wr({
        workerId: "b1",
        modelKey: "nim:k1",
        phase: "collected",
        arbiterOutcome: "selected",
        applyAttempts: 2,
      }),
      wr({
        workerId: "b2",
        modelKey: "nim:k1",
        phase: "apply_failed",
        ok: false,
        arbiterOutcome: "excluded",
        applyAttempts: 2,
      }),
      // First-shot success — applyAttempts=1, NOT counted as "used".
      wr({
        workerId: "b3",
        modelKey: "nim:k1",
        phase: "collected",
        arbiterOutcome: "not_selected",
        applyAttempts: 1,
      }),
    ],
    reviewFindings: [],
    arbiterDecisions: [],
    modelEvents: [],
    humanDecisions: [],
  });
  const k1 = scores.find((s) => s.modelKey === "nim:k1") as Extract<
    ModelScore,
    { role: "builder" }
  >;
  assert.equal(k1.applyRetriesUsed, 2, "two candidates had applyAttempts > 1");
  assert.equal(k1.applyRetryRescues, 1, "only one of those reached collected");
  assert.equal(k1.applyRetryRescueRate, 0.5);
});

test("computeFromSnapshot (Patch EE): verifyRetry stats — rescued = used AND builderVerificationPhase ∈ {passed, passed_typecheck_only}", () => {
  const scores = computeFromSnapshot({
    workerRuns: [
      // k1: verify-retry triggered; final verifier verdict was passed.
      wr({
        workerId: "b1",
        modelKey: "nim:k1",
        phase: "collected",
        arbiterOutcome: "selected",
        verifyAttempts: 2,
        builderVerificationPhase: "passed",
      }),
      // k1: verify-retry triggered; final verdict was passed_typecheck_only
      // (test command not supplied, but typecheck rescued). Counts as rescue.
      wr({
        workerId: "b2",
        modelKey: "nim:k1",
        phase: "collected",
        arbiterOutcome: "not_selected",
        verifyAttempts: 2,
        builderVerificationPhase: "passed_typecheck_only",
      }),
      // k1: verify-retry triggered; final verdict still tests_failed.
      // Not a rescue — the retry didn't fix the failure.
      wr({
        workerId: "b3",
        modelKey: "nim:k1",
        phase: "collected",
        arbiterOutcome: "not_selected",
        verifyAttempts: 2,
        builderVerificationPhase: "tests_failed",
      }),
      // k1: first-shot pass — verifyAttempts=1, NOT counted as "used".
      wr({
        workerId: "b4",
        modelKey: "nim:k1",
        phase: "collected",
        arbiterOutcome: "not_selected",
        verifyAttempts: 1,
        builderVerificationPhase: "passed",
      }),
    ],
    reviewFindings: [],
    arbiterDecisions: [],
    modelEvents: [],
    humanDecisions: [],
  });
  const k1 = scores.find((s) => s.modelKey === "nim:k1") as Extract<
    ModelScore,
    { role: "builder" }
  >;
  assert.equal(k1.verifyRetriesUsed, 3);
  assert.equal(k1.verifyRetryRescues, 2);
  assert.ok(
    k1.verifyRetryRescueRate !== null &&
      Math.abs(k1.verifyRetryRescueRate - 2 / 3) < 1e-9,
  );
});

test("computeFromSnapshot (Patch EE): rescueRate is null (not 0) when the retry path was never tripped", () => {
  // Distinguishing "never tripped" from "always failed to rescue" is
  // important for the operator: rescueRate=0.0 means "the retry tool
  // is not earning its cost for this model" (actionable), while null
  // means "no signal yet" (don't act on it).
  const scores = computeFromSnapshot({
    workerRuns: [
      wr({
        workerId: "b1",
        modelKey: "nim:k1",
        phase: "collected",
        arbiterOutcome: "selected",
        applyAttempts: 1,
        verifyAttempts: 1,
        builderVerificationPhase: "passed",
      }),
    ],
    reviewFindings: [],
    arbiterDecisions: [],
    modelEvents: [],
    humanDecisions: [],
  });
  const k1 = scores.find((s) => s.modelKey === "nim:k1") as Extract<
    ModelScore,
    { role: "builder" }
  >;
  assert.equal(k1.applyRetriesUsed, 0);
  assert.equal(k1.verifyRetriesUsed, 0);
  assert.equal(k1.applyRetryRescueRate, null);
  assert.equal(k1.verifyRetryRescueRate, null);
});

test("computeFromSnapshot (Patch EE): pre-Patch-EE rows (no applyAttempts/verifyAttempts) → counts stay at 0 (regression)", () => {
  // Backwards-compat: ledger rows written before Patch Y / BB don't
  // carry these fields. Treat them as "retry never tripped" rather
  // than crashing or counting them against the model.
  const scores = computeFromSnapshot({
    workerRuns: [
      wr({
        workerId: "b1",
        modelKey: "nim:k1",
        phase: "collected",
        arbiterOutcome: "selected",
        // applyAttempts / verifyAttempts / builderVerificationPhase all undefined
      }),
    ],
    reviewFindings: [],
    arbiterDecisions: [],
    modelEvents: [],
    humanDecisions: [],
  });
  const k1 = scores.find((s) => s.modelKey === "nim:k1") as Extract<
    ModelScore,
    { role: "builder" }
  >;
  assert.equal(k1.applyRetriesUsed, 0);
  assert.equal(k1.verifyRetriesUsed, 0);
  assert.equal(k1.applyRetryRescueRate, null);
  assert.equal(k1.verifyRetryRescueRate, null);
});
