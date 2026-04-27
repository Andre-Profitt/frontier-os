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
}): WorkerRunEvent {
  const result: WorkerRunEvent = {
    eventId: `e-${opts.workerId}`,
    taskId: "t",
    packetId: "p",
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
  rerunVerificationOk?: boolean;
}): ArbiterDecisionEvent {
  return {
    eventId: "e-ad",
    taskId: "t",
    packetId: "p",
    ts: TS,
    kind: "arbiter_decision",
    decision: opts.decision,
    candidatesEvaluated: 1,
    rerunVerificationOk: opts.rerunVerificationOk ?? true,
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

test("computeFromSnapshot: builder with all collected → collectedRate=1, selectionRate=selected/collected", () => {
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
  });
  const k1 = scores.find((s) => s.modelKey === "nim:k1") as Extract<
    ModelScore,
    { role: "builder" }
  >;
  assert.equal(k1.candidates, 2);
  assert.equal(k1.collected, 2);
  assert.equal(k1.collectedRate, 1);
  assert.equal(k1.arbiterSelected, 1);
  assert.equal(k1.selectionRate, 0.5);
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
  });
  assert.equal(scores.length, 2);
  assert.equal(scores[0]?.role, "builder");
  assert.equal(scores[1]?.role, "reviewer");
});
