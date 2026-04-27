import { test } from "node:test";
import assert from "node:assert/strict";

import {
  scoreCandidate,
  loadRubric,
  type Rubric,
  type ReviewerFindingSummary,
} from "../rubric-scorer.ts";
import type { VerificationResult } from "../types.ts";

const PASSED_VERIFICATION: VerificationResult = {
  builderId: "b1",
  worktreePath: "/tmp/wt-1",
  phase: "passed",
  typecheckExitCode: 0,
  testExitCode: 0,
  ranAt: "2026-04-26T22:00:00.000Z",
};

const FAILED_VERIFICATION: VerificationResult = {
  ...PASSED_VERIFICATION,
  phase: "typecheck_failed",
  typecheckExitCode: 1,
};

function syntheticRubric(): Rubric {
  return {
    rubricId: "test_rubric",
    version: "v1",
    summary: "test",
    criteria: [
      {
        id: "R1",
        title: "passed implies invariants",
        rationale: "verification re-run drives this",
        weight: 2,
      },
      {
        id: "R2",
        title: "no false-green repair",
        rationale: "reviewers must not flag false_green",
        weight: 1,
      },
      {
        id: "R3",
        title: "reads well to a human",
        rationale: "subjective taste call about clarity",
        weight: 1,
      },
    ],
  };
}

// --- scoreCandidate -------------------------------------------------------

test("scoreCandidate: passed verification → R1 score=1", () => {
  const score = scoreCandidate({
    builderId: "b1",
    rubric: syntheticRubric(),
    verification: PASSED_VERIFICATION,
    reviewerFindings: {},
  });
  const r1 = score.criteria.find((c) => c.id === "R1");
  assert.equal(r1?.score, 1);
});

test("scoreCandidate: failed verification → R1 score=0", () => {
  const score = scoreCandidate({
    builderId: "b1",
    rubric: syntheticRubric(),
    verification: FAILED_VERIFICATION,
    reviewerFindings: {},
  });
  const r1 = score.criteria.find((c) => c.id === "R1");
  assert.equal(r1?.score, 0);
});

test("scoreCandidate: false_green=2 → R2 score=0", () => {
  const score = scoreCandidate({
    builderId: "b1",
    rubric: syntheticRubric(),
    verification: PASSED_VERIFICATION,
    reviewerFindings: { false_green: 2 } satisfies ReviewerFindingSummary,
  });
  const r2 = score.criteria.find((c) => c.id === "R2");
  assert.equal(r2?.score, 0);
});

test("scoreCandidate: no false_green → R2 score=1", () => {
  const score = scoreCandidate({
    builderId: "b1",
    rubric: syntheticRubric(),
    verification: PASSED_VERIFICATION,
    reviewerFindings: { false_green: 0 },
  });
  const r2 = score.criteria.find((c) => c.id === "R2");
  assert.equal(r2?.score, 1);
});

test("scoreCandidate: subjective criterion → score=null", () => {
  const score = scoreCandidate({
    builderId: "b1",
    rubric: syntheticRubric(),
    verification: PASSED_VERIFICATION,
    reviewerFindings: {},
  });
  const r3 = score.criteria.find((c) => c.id === "R3");
  assert.equal(r3?.score, null);
  assert.match(r3?.rationale ?? "", /soft criterion/);
});

test("scoreCandidate: aggregate weights only non-null criteria", () => {
  // R1 (weight 2) → 1, R2 (weight 1) → 1, R3 (weight 1) → null
  // Aggregate = (1*2 + 1*1) / (2 + 1) = 3/3 = 1.0
  const score = scoreCandidate({
    builderId: "b1",
    rubric: syntheticRubric(),
    verification: PASSED_VERIFICATION,
    reviewerFindings: {},
  });
  assert.equal(score.score, 1);
});

test("scoreCandidate: aggregate is 0 when every criterion is null", () => {
  const rubric: Rubric = {
    rubricId: "x",
    version: "v1",
    summary: "x",
    criteria: [
      {
        id: "X1",
        title: "subjective vibe",
        rationale: "vibe check",
        weight: 1,
      },
    ],
  };
  const score = scoreCandidate({
    builderId: "b1",
    rubric,
    verification: PASSED_VERIFICATION,
    reviewerFindings: {},
  });
  assert.equal(score.score, 0);
  assert.equal(score.criteria[0]?.score, null);
});

test("scoreCandidate: weighted aggregate handles partial pass", () => {
  // R1 (weight 2) → 0 (fail), R2 (weight 1) → 1, R3 → null
  // Aggregate = (0*2 + 1*1) / (2 + 1) = 1/3 ≈ 0.333
  const score = scoreCandidate({
    builderId: "b1",
    rubric: syntheticRubric(),
    verification: FAILED_VERIFICATION,
    reviewerFindings: {},
  });
  assert.ok(Math.abs(score.score - 1 / 3) < 1e-6);
});

// --- loadRubric -----------------------------------------------------------

test("loadRubric: loads the real factory_run rubric without throwing", () => {
  const r = loadRubric(
    `${process.cwd()}/taste/rubrics/factory_run_rubric.json`,
  );
  assert.equal(r.rubricId, "factory_run");
  assert.ok(r.criteria.length > 0);
});

test("loadRubric: missing file throws", () => {
  assert.throws(() => loadRubric("/nonexistent.json"), /not found/);
});
