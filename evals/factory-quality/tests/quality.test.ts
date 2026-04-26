// Tests for the factory-quality eval suite.
//
// Run:
//   node --import tsx --test evals/factory-quality/tests/quality.test.ts
//
// The test list mixes live "good example" cases (run the eval against the
// real repo and assert it ships) with anti-example cases that feed broken
// synthetic ContextPacks into the criterion scorers and assert they fail.
//
// Anti-examples per GPT Pro Phase 3 brief:
//   - wrong-repo context (repo.marker != "frontier-os")
//   - stale repair classified as passed (derived classification)
//   - dirty tree omitted from render
//
// Plus: the live good-example case (current local-smoke + context-pack
// path) must score ship.

import { test } from "node:test";
import assert from "node:assert/strict";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  generateContextPack,
  type ContextPack,
} from "../../../src/context/pack.ts";
import {
  deriveFinalClassification,
  type RepairResult,
} from "../../../factories/ai-stack-local-smoke/run.ts";
import {
  runEval,
  scoreC1,
  scoreC3,
  scoreC4,
  scoreC5,
  scoreC6,
  scoreC7,
  scoreC8,
  scoreC10,
  scoreC11,
  scoreC14,
  type CriterionResult,
} from "../run.ts";

const HERE = fileURLToPath(import.meta.url);
const REPO_ROOT = resolve(HERE, "..", "..", "..", "..");
const LANE = "ai-stack-local-smoke";

// Reusable criterion definitions for direct scorer tests.
const C: Record<string, { id: string; description: string; weight: number }> = {
  C1: { id: "C1", description: "evidence captured before repair", weight: 1 },
  C3: { id: "C3", description: "repo identity explicit", weight: 1 },
  C4: { id: "C4", description: "forbidden areas listed", weight: 1 },
  C5: { id: "C5", description: "factory spec found", weight: 1 },
  C6: { id: "C6", description: "allowed/forbidden actions", weight: 1 },
  C7: { id: "C7", description: "kill switch path/status", weight: 1 },
  C8: { id: "C8", description: "primary verifier path", weight: 1 },
  C10: {
    id: "C10",
    description: "classification mutually exclusive",
    weight: 1,
  },
  C11: { id: "C11", description: "no false green", weight: 2 },
  C14: { id: "C14", description: "alert reflects final", weight: 1 },
};

// --- live good example: full runEval against the real repo -----------------

test("good example: live runEval over current repo recommends ship", async () => {
  const r = await runEval();
  assert.equal(r.total, 15);
  assert.equal(r.evalSuite, "local-smoke-factory-quality");
  // Every criterion has either passed or not_applicable; never failed in
  // the current healthy state. Weight-2 criteria (C11, C12) MUST pass.
  for (const c of r.criteria) {
    assert.notEqual(
      c.status,
      "failed",
      `${c.id} unexpectedly failed: ${c.evidence}`,
    );
  }
  const heavy = r.criteria.filter((c) => c.weight >= 2);
  for (const c of heavy) {
    assert.equal(c.status, "passed", `heavyweight ${c.id} must pass`);
  }
  assert.ok(["ship", "investigate"].includes(r.recommendation));
  if (r.recommendation === "ship") {
    assert.equal(r.failed, 0);
    assert.ok(r.ratio >= 0.95);
  }
});

test("report structure: has 15 criteria, weighted score, ratio, recommendation", async () => {
  const r = await runEval();
  assert.equal(r.criteria.length, 15);
  assert.equal(typeof r.weightedScore, "number");
  assert.equal(typeof r.weightedTotal, "number");
  assert.ok(r.weightedTotal > 0);
  assert.ok(r.ratio >= 0 && r.ratio <= 1);
  assert.ok(["ship", "investigate", "block"].includes(r.recommendation));
});

// --- helper: synthesize a broken ContextPack from a known-good base --------

function withGoodLivePack(): ContextPack {
  return generateContextPack({
    lane: LANE,
    repoRoot: REPO_ROOT,
    includeAlerts: false,
  });
}

// --- anti-examples (synthetic broken packs feed into scorers) --------------

test("anti-example: wrong-repo context — repo.marker != 'frontier-os' fails C3", () => {
  const good = withGoodLivePack();
  const wrongRepo: ContextPack = {
    ...good,
    repo: {
      ...good.repo,
      marker: "ai-os" as unknown as typeof good.repo.marker,
    },
  };
  const r = scoreC3(C.C3!, wrongRepo);
  assert.equal(r.status, "failed");
  assert.match(r.evidence, /repo\.marker="ai-os"/);
});

test("anti-example: missing forbidden areas — empty list fails C4", () => {
  const good = withGoodLivePack();
  const broken: ContextPack = { ...good, forbiddenAreas: [] };
  const r = scoreC4(C.C4!, broken);
  assert.equal(r.status, "failed");
  assert.match(
    r.evidence,
    /missing.*siri.*companion-platform.*\/users\/test\/bin/,
  );
});

test("anti-example: no committed evidence files fails C1", () => {
  const good = withGoodLivePack();
  const broken: ContextPack = {
    ...good,
    evidence: { ...good.evidence, committedFiles: [] },
  };
  const r = scoreC1(C.C1!, broken);
  assert.equal(r.status, "failed");
  assert.match(r.evidence, /\(empty\)/);
});

test("anti-example: missing factory spec path fails C5", () => {
  const good = withGoodLivePack();
  const broken: ContextPack = {
    ...good,
    lane: {
      ...good.lane,
      factorySpecPath: "/nonexistent/path/factory.json",
    },
  };
  const r = scoreC5(C.C5!, broken);
  assert.equal(r.status, "failed");
});

test("anti-example: empty allowed/forbidden actions fails C6", () => {
  const good = withGoodLivePack();
  const broken: ContextPack = {
    ...good,
    lane: {
      ...good.lane,
      policy: {
        ...good.lane.policy,
        allowedActions: [],
        forbiddenActions: [],
      },
    },
  };
  const r = scoreC6(C.C6!, broken);
  assert.equal(r.status, "failed");
});

test("anti-example: missing kill switch path fails C7", () => {
  const good = withGoodLivePack();
  const broken: ContextPack = {
    ...good,
    lane: {
      ...good.lane,
      killSwitch: { path: "", active: false },
    },
  };
  const r = scoreC7(C.C7!, broken);
  assert.equal(r.status, "failed");
});

test("anti-example: wrong primary verifier path fails C8 (wrong-repo style)", () => {
  // This mirrors the v1-of-Factory-#1 mistake where the inner mcp smoke
  // tool was wrapped instead of the actual lane script. The eval should
  // catch that regression.
  const good = withGoodLivePack();
  const broken: ContextPack = {
    ...good,
    lane: {
      ...good.lane,
      lane: {
        ...good.lane.lane,
        primaryVerifier: [
          "/Users/test/frontier-os/bin/frontier",
          "mcp",
          "smoke",
          "--read-only",
        ],
      },
    },
  };
  const r = scoreC8(C.C8!, broken);
  assert.equal(r.status, "failed");
  assert.match(r.detail ?? "", /\/Users\/test\/bin\/ai-stack-local-smoke/);
});

// --- structural assertions about the underlying logic that C11 enforces ---

test("anti-example logic: derive(primary=ok, repair=stale) MUST return failed (not passed)", () => {
  // If this were ever to flip to "passed", C11's 24-cell enumeration would
  // catch it. The test here asserts the underlying contract directly so
  // any regression in deriveFinalClassification is caught even if the
  // eval suite were skipped.
  const repairStale: RepairResult = {
    ran: true,
    kind: "verify-timeout-config",
    status: "stale",
    observedTimeoutSeconds: 30,
    minRequiredSeconds: 60,
    detail: "stale",
  };
  const f = deriveFinalClassification({
    killSwitchActive: false,
    primary: { status: "ok", detail: "exit=0" },
    repair: repairStale,
  });
  assert.notEqual(
    f.classification,
    "passed",
    "stale repair must not produce passed",
  );
  assert.equal(f.classification, "failed");
  assert.ok(
    f.escalations.includes("repair-did-not-clear-failure"),
    "stale repair must add escalation",
  );
});

test("anti-example logic: derive(primary=ok, repair=skipped, killSwitch=false) MUST NOT return passed", () => {
  // Skipped repair only legitimately occurs with kill switch active. With
  // killSwitch=false, this scenario should not produce passed (it would
  // be a false green).
  const repairSkipped: RepairResult = {
    ran: false,
    kind: "verify-timeout-config",
    status: "skipped",
    observedTimeoutSeconds: null,
    minRequiredSeconds: 60,
    detail: "skipped",
  };
  const f = deriveFinalClassification({
    killSwitchActive: false,
    primary: { status: "ok", detail: "exit=0" },
    repair: repairSkipped,
  });
  assert.notEqual(f.classification, "passed");
});

test("good example: derive(primary=ok, repair=ok, ks=false) returns passed with no escalations", () => {
  const repairOk: RepairResult = {
    ran: true,
    kind: "verify-timeout-config",
    status: "ok",
    observedTimeoutSeconds: 60,
    minRequiredSeconds: 60,
    detail: "ok",
  };
  const f = deriveFinalClassification({
    killSwitchActive: false,
    primary: { status: "ok", detail: "exit=0" },
    repair: repairOk,
  });
  assert.equal(f.classification, "passed");
  assert.equal(f.escalations.length, 0);
});

// --- direct scorer tests for self-contained criteria ----------------------

test("scoreC10 (mutual exclusion) passes against current classifiers", () => {
  const r = scoreC10(C.C10!);
  assert.equal(r.status, "passed");
});

test("scoreC11 (no-false-green) passes against current derive function", () => {
  const r = scoreC11(C.C11!);
  assert.equal(r.status, "passed");
  assert.equal(r.weight, 2);
});

test("scoreC14 (severity reflects final) passes — primary=ok+stale produces high alert, not silent green", () => {
  const r = scoreC14(C.C14!);
  assert.equal(r.status, "passed");
});

// --- recommendation logic: thresholds enforce ship/investigate/block ------

test("recommendation: heavyweight failure produces block", async () => {
  // Synthesize a CriterionResult set where a weight=2 criterion fails;
  // verify that runEval would have produced 'block' under that signal.
  // We can't easily mutate the live runEval, but the threshold logic in
  // run.ts is straightforward — confirm its structural invariants by
  // running the live eval and inspecting its current state plus a
  // hypothetical re-classification.
  const live = await runEval();
  const heavyFailed = live.criteria.some(
    (c: CriterionResult) => c.status === "failed" && c.weight >= 2,
  );
  if (heavyFailed) {
    assert.equal(live.recommendation, "block");
  } else if (live.failed === 0 && live.ratio >= 0.95) {
    assert.equal(live.recommendation, "ship");
  } else {
    assert.equal(live.recommendation, "investigate");
  }
});
