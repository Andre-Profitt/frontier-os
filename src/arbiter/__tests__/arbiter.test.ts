import { test } from "node:test";
import assert from "node:assert/strict";

import { decide, matchAntiExample } from "../arbiter.ts";
import type { Rubric } from "../rubric-scorer.ts";
import type { VerificationResult } from "../types.ts";
import type { CandidateInput, ReviewerFindingInput } from "../arbiter.ts";

// --- helpers --------------------------------------------------------------

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
    ],
  };
}

function candidate(
  builderId: string,
  ok = true,
  phase = "collected",
): CandidateInput {
  return {
    builderId,
    modelKey: `stub:${builderId}`,
    worktreePath: `/tmp/${builderId}`,
    ok,
    phase,
    patch: {
      diff: `diff --git a/x b/x\n--- a/x\n+++ b/x\n@@ -1 +1,2 @@\n a\n+b\n`,
      files: ["x"],
      sizeBytes: 60,
      addedLines: 1,
      deletedLines: 0,
      commitCount: 1,
    },
  };
}

function passedVerification(builderId: string): VerificationResult {
  return {
    builderId,
    worktreePath: `/tmp/${builderId}`,
    phase: "passed",
    typecheckExitCode: 0,
    testExitCode: 0,
    ranAt: "2026-04-26T22:00:00.000Z",
  };
}

function failedVerification(builderId: string): VerificationResult {
  return {
    ...passedVerification(builderId),
    phase: "typecheck_failed",
    typecheckExitCode: 1,
  };
}

const COMMON_OPTS = {
  rubricPath: "/synthetic/rubric.json",
  loadRubricImpl: () => syntheticRubric(),
  loadAntiExampleImpl: () => "",
};

// --- decision: accept -----------------------------------------------------

test("decide: one candidate passes verification + rubric + reviews → accept", async () => {
  const verifierImpl = () => passedVerification("b1");
  const dec = await decide({
    taskId: "t1",
    candidates: [candidate("b1")],
    reviewerFindings: [
      {
        builderId: "b1",
        findingsBySeverity: { high: 0 },
        findingsByCategory: {},
      },
    ],
    ...COMMON_OPTS,
    verifierImpl,
    qualityFloor: 0.5,
  });
  assert.equal(dec.decision, "accept");
  assert.equal(dec.selectedBuilderId, "b1");
  assert.equal(dec.candidatesEvaluated, 1);
  assert.equal(dec.rerunVerification.results.length, 1);
  assert.match(dec.evidence, /Decision: accept/);
});

// --- decision: reject (verification) --------------------------------------

test("decide: only candidate fails verification → reject", async () => {
  const verifierImpl = () => failedVerification("b1");
  const dec = await decide({
    taskId: "t1",
    candidates: [candidate("b1")],
    ...COMMON_OPTS,
    verifierImpl,
  });
  assert.equal(dec.decision, "reject");
  assert.match(dec.rejectionReasons?.join(" ") ?? "", /verification/);
});

// --- decision: reject (high-severity bug in review) -----------------------

test("decide: high-severity bug in review → exclude → reject", async () => {
  const verifierImpl = () => passedVerification("b1");
  const dec = await decide({
    taskId: "t1",
    candidates: [candidate("b1")],
    reviewerFindings: [
      {
        builderId: "b1",
        findingsBySeverity: { high: 2 },
        findingsByCategory: { bug: 1, contract_violation: 1 },
      },
    ],
    ...COMMON_OPTS,
    verifierImpl,
  });
  assert.equal(dec.decision, "reject");
  assert.match(dec.rejectionReasons?.join(" ") ?? "", /high-severity/);
});

// --- decision: reject (no candidates collected) ---------------------------

test("decide: no candidates reached collected → reject with that reason", async () => {
  const dec = await decide({
    taskId: "t1",
    candidates: [
      candidate("b1", false, "broker_failed"),
      candidate("b2", false, "no_diff_extracted"),
    ],
    ...COMMON_OPTS,
    verifierImpl: () => passedVerification("nope"), // never called
  });
  assert.equal(dec.decision, "reject");
  assert.match(dec.rejectionReasons?.[0] ?? "", /no candidate reached/);
  assert.equal(dec.candidatesEvaluated, 0);
  assert.equal(dec.rerunVerification.results.length, 0);
});

// --- decision: reject (below qualityFloor) --------------------------------

test("decide: rubric score below qualityFloor → reject", async () => {
  const verifierImpl = () => failedVerification("b1");
  const dec = await decide({
    taskId: "t1",
    candidates: [candidate("b1")],
    reviewerFindings: [
      { builderId: "b1", findingsBySeverity: {}, findingsByCategory: {} },
    ],
    ...COMMON_OPTS,
    verifierImpl,
    // R1=0 (typecheck failed), R2=1 (no false_green) → aggregate = 1/3
    // qualityFloor 0.7 → reject
    qualityFloor: 0.7,
  });
  assert.equal(dec.decision, "reject");
  assert.match(dec.rejectionReasons?.join(" ") ?? "", /rubric|qualityFloor/);
});

// --- decision: escalate_to_human (multiple eligible) ----------------------

test("decide: multiple eligible candidates → escalate_to_human, ranked by score", async () => {
  const verifierImpl = (opts: { builderId: string }) =>
    passedVerification(opts.builderId);
  const dec = await decide({
    taskId: "t1",
    candidates: [candidate("b1"), candidate("b2"), candidate("b3")],
    reviewerFindings: [
      { builderId: "b1", findingsBySeverity: {}, findingsByCategory: {} },
      { builderId: "b2", findingsBySeverity: {}, findingsByCategory: {} },
      { builderId: "b3", findingsBySeverity: {}, findingsByCategory: {} },
    ],
    ...COMMON_OPTS,
    verifierImpl,
    qualityFloor: 0.5,
  });
  assert.equal(dec.decision, "escalate_to_human");
  assert.match(dec.escalationQuestion ?? "", /pick one/);
  assert.equal(dec.candidatesEvaluated, 3);
});

// --- decision: skips non-collected candidates -----------------------------

test("decide: skips candidates with phase != collected", async () => {
  const verifierImpl = (opts: { builderId: string }) =>
    passedVerification(opts.builderId);
  const dec = await decide({
    taskId: "t1",
    candidates: [
      candidate("b1"),
      candidate("b2", false, "apply_failed"),
      candidate("b3", false, "broker_failed"),
    ],
    reviewerFindings: [
      { builderId: "b1", findingsBySeverity: {}, findingsByCategory: {} },
    ],
    ...COMMON_OPTS,
    verifierImpl,
    qualityFloor: 0.5,
  });
  assert.equal(dec.decision, "accept");
  assert.equal(dec.selectedBuilderId, "b1");
  assert.equal(dec.candidatesEvaluated, 1);
  assert.equal(dec.rerunVerification.results.length, 1);
  assert.match(dec.evidence, /Excluded.*b2: phase=apply_failed/s);
});

// --- decision: schema validation -----------------------------------------

test("decide: output validates against arbiter-decision.schema.json", async () => {
  const { validateArbiterDecision } = await import("../../schemas.ts");
  const verifierImpl = () => passedVerification("b1");
  const dec = await decide({
    taskId: "t1",
    packetId: "build-xyz",
    candidates: [candidate("b1")],
    reviewerFindings: [
      { builderId: "b1", findingsBySeverity: {}, findingsByCategory: {} },
    ],
    ...COMMON_OPTS,
    verifierImpl,
    qualityFloor: 0.5,
  });
  const valid = validateArbiterDecision(dec);
  if (!valid) {
    console.error(JSON.stringify(validateArbiterDecision.errors, null, 2));
  }
  assert.equal(valid, true);
});

// --- matchAntiExample -----------------------------------------------------

test("matchAntiExample: heading text appears in diff → matches", () => {
  const body = `# False-green repair pattern\n\nWhen the repair...`;
  const diff = `diff --git a/x b/x\n+// false-green repair pattern\n`;
  assert.equal(matchAntiExample(diff, body), "matches");
});

test("matchAntiExample: heading text NOT in diff → safe", () => {
  const body = `# False-green repair pattern\n\nWhen the repair...`;
  const diff = `diff --git a/x b/x\n+console.log("hello")\n`;
  assert.equal(matchAntiExample(diff, body), "safe");
});

test("matchAntiExample: empty diff → safe", () => {
  assert.equal(matchAntiExample("", "# heading\n"), "safe");
});

test("matchAntiExample: empty anti-example body → safe", () => {
  assert.equal(matchAntiExample("diff --git a/x b/x\n@@", ""), "safe");
});

// --- decision: anti-example match excludes candidate ----------------------

test("decide: candidate matches anti-example → excluded → reject if only one", async () => {
  const verifierImpl = () => passedVerification("b1");
  // The candidate's diff contains "false-green repair pattern" verbatim,
  // matching the anti-example heading.
  const cand: CandidateInput = {
    ...candidate("b1"),
    patch: {
      diff: `diff --git a/x b/x\n+// false-green repair pattern\n`,
      files: ["x"],
      sizeBytes: 50,
      addedLines: 1,
      deletedLines: 0,
      commitCount: 1,
    },
  };
  const dec = await decide({
    taskId: "t1",
    candidates: [cand],
    reviewerFindings: [
      { builderId: "b1", findingsBySeverity: {}, findingsByCategory: {} },
    ],
    rubricPath: "/x.json",
    loadRubricImpl: () => syntheticRubric(),
    loadAntiExampleImpl: () => `# False-green repair pattern\n`,
    antiExamplePaths: ["/synthetic/false-green.md"],
    verifierImpl,
    qualityFloor: 0.5,
  });
  assert.equal(dec.decision, "reject");
  assert.equal(dec.antiExampleMatches.length, 1);
  assert.equal(dec.antiExampleMatches[0]?.verdict, "matches");
});
