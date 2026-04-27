// Q4 policy recommender tests. Pure-function math over a synthesized
// (policy, scores) pair — no fs, no CLI.

import { test } from "node:test";
import assert from "node:assert/strict";

import { recommendPolicy, type ModelPolicy } from "../policy-recommender.ts";
import type {
  BuilderModelScore,
  ReviewerModelScore,
  ModelScore,
} from "../model-score.ts";

function builderScore(over: Partial<BuilderModelScore>): BuilderModelScore {
  return {
    modelKey: "ollama-local:qwen2.5-coder:14b",
    role: "builder",
    taskClass: "patch_builder",
    candidates: 0,
    collected: 0,
    arbiterSelected: 0,
    orchestrationsParticipated: 0,
    orchestrationsWon: 0,
    phases: {},
    collectedRate: 0,
    selectionRate: 0,
    highBugFindingsAgainst: 0,
    meanRubricScore: null,
    meanRubricCoverage: null,
    ...over,
  };
}

function reviewerScore(over: Partial<ReviewerModelScore>): ReviewerModelScore {
  return {
    modelKey: "ollama-local:deepseek-coder:33b",
    role: "reviewer",
    taskClass: "adversarial_review",
    runs: 0,
    validRuns: 0,
    findings: 0,
    findingsByCategory: {},
    findingsBySeverity: {},
    validityRate: 0,
    highImpactFindings: 0,
    ...over,
  };
}

function policyWith(
  classes: Record<string, ModelPolicy["classes"][string]>,
): ModelPolicy {
  return { version: "v1", classes };
}

// --- no_evidence ---------------------------------------------------------

test("recommendPolicy: no_evidence when class has < minSamples for any model", () => {
  const policy = policyWith({
    patch_builder: {
      models: [{ provider: "ollama-local", model: "qwen2.5-coder:14b" }],
    },
  });
  const recs = recommendPolicy(
    policy,
    [
      builderScore({
        modelKey: "ollama-local:qwen2.5-coder:14b",
        orchestrationsParticipated: 1,
        selectionRate: 0.9,
      }),
    ],
    { minSamples: 3 },
  );
  assert.equal(recs.length, 1);
  assert.equal(recs[0]!.action, "no_evidence");
  assert.equal(recs[0]!.taskClass, "patch_builder");
});

// --- promote_alternate ---------------------------------------------------

test("recommendPolicy: promote_alternate when listed alternate beats primary by margin", () => {
  const policy = policyWith({
    patch_builder: {
      models: [
        { provider: "ollama-local", model: "qwen2.5-coder:14b" },
        { provider: "nvidia-nim", model: "qwen3-coder-480b" },
      ],
    },
  });
  const scores: ModelScore[] = [
    builderScore({
      modelKey: "ollama-local:qwen2.5-coder:14b",
      orchestrationsParticipated: 5,
      selectionRate: 0.2,
    }),
    builderScore({
      modelKey: "nvidia-nim:qwen3-coder-480b",
      orchestrationsParticipated: 5,
      selectionRate: 0.8,
    }),
  ];
  const recs = recommendPolicy(policy, scores, {
    minSamples: 3,
    improvementMargin: 0.1,
  });
  assert.equal(recs[0]!.action, "promote_alternate");
  assert.equal(recs[0]!.recommendedPrimary, "nvidia-nim:qwen3-coder-480b");
  assert.equal(recs[0]!.currentPrimary, "ollama-local:qwen2.5-coder:14b");
});

// --- add_candidate -------------------------------------------------------

test("recommendPolicy: add_candidate when unlisted model outperforms primary", () => {
  const policy = policyWith({
    patch_builder: {
      models: [{ provider: "ollama-local", model: "qwen2.5-coder:14b" }],
    },
  });
  const scores: ModelScore[] = [
    builderScore({
      modelKey: "ollama-local:qwen2.5-coder:14b",
      orchestrationsParticipated: 5,
      selectionRate: 0.3,
    }),
    builderScore({
      modelKey: "nvidia-nim:kimi-k2",
      orchestrationsParticipated: 5,
      selectionRate: 0.85,
    }),
  ];
  const recs = recommendPolicy(policy, scores, {
    minSamples: 3,
    improvementMargin: 0.1,
  });
  assert.equal(recs[0]!.action, "add_candidate");
  assert.equal(recs[0]!.recommendedPrimary, "nvidia-nim:kimi-k2");
  assert.match(recs[0]!.rationale, /Consider adding to policy/);
});

// --- demote_primary ------------------------------------------------------

test("recommendPolicy: demote_primary when primary ranks last but no clear winner", () => {
  // Primary scores worse than all listed alternates, but no alternate
  // beats it by ≥ margin (clustered around the primary).
  const policy = policyWith({
    patch_builder: {
      models: [
        { provider: "ollama-local", model: "qwen2.5-coder:14b" }, // primary
        { provider: "ollama-local", model: "qwen2.5-coder:32b" },
        { provider: "ollama-local", model: "deepseek-coder:33b" },
      ],
    },
  });
  const scores: ModelScore[] = [
    builderScore({
      modelKey: "ollama-local:qwen2.5-coder:14b",
      orchestrationsParticipated: 10,
      selectionRate: 0.3,
    }),
    builderScore({
      modelKey: "ollama-local:qwen2.5-coder:32b",
      orchestrationsParticipated: 10,
      selectionRate: 0.35, // beats primary but not by 0.1 margin
    }),
    builderScore({
      modelKey: "ollama-local:deepseek-coder:33b",
      orchestrationsParticipated: 10,
      selectionRate: 0.38, // also within margin
    }),
  ];
  const recs = recommendPolicy(policy, scores, {
    minSamples: 3,
    improvementMargin: 0.1,
  });
  assert.equal(recs[0]!.action, "demote_primary");
  assert.equal(recs[0]!.currentPrimary, "ollama-local:qwen2.5-coder:14b");
  assert.equal(recs[0]!.recommendedPrimary, "ollama-local:qwen2.5-coder:14b");
});

// --- no recommendation when primary is fine -----------------------------

test("recommendPolicy: silent (no row) when primary leads or ties within margin", () => {
  const policy = policyWith({
    patch_builder: {
      models: [
        { provider: "ollama-local", model: "qwen2.5-coder:14b" },
        { provider: "ollama-local", model: "qwen2.5-coder:32b" },
      ],
    },
  });
  const scores: ModelScore[] = [
    builderScore({
      modelKey: "ollama-local:qwen2.5-coder:14b",
      orchestrationsParticipated: 10,
      selectionRate: 0.7,
    }),
    builderScore({
      modelKey: "ollama-local:qwen2.5-coder:32b",
      orchestrationsParticipated: 10,
      selectionRate: 0.65,
    }),
  ];
  const recs = recommendPolicy(policy, scores, {
    minSamples: 3,
    improvementMargin: 0.1,
  });
  assert.equal(recs.length, 0);
});

// --- reviewer scoring ----------------------------------------------------

test("recommendPolicy: reviewers use validityRate as the rate signal", () => {
  const policy = policyWith({
    adversarial_review: {
      models: [{ provider: "ollama-local", model: "deepseek-coder:33b" }],
    },
  });
  const scores: ModelScore[] = [
    reviewerScore({
      modelKey: "ollama-local:deepseek-coder:33b",
      runs: 8,
      validityRate: 0.5,
    }),
    reviewerScore({
      modelKey: "nvidia-nim:glm-5.1",
      runs: 8,
      validityRate: 0.95,
    }),
  ];
  const recs = recommendPolicy(policy, scores, {
    minSamples: 3,
    improvementMargin: 0.1,
  });
  assert.equal(recs[0]!.action, "add_candidate");
  assert.equal(recs[0]!.recommendedPrimary, "nvidia-nim:glm-5.1");
});

// --- multi-class ---------------------------------------------------------

test("recommendPolicy: returns one row per class with evidence", () => {
  const policy = policyWith({
    patch_builder: {
      models: [{ provider: "ollama-local", model: "qwen2.5-coder:14b" }],
    },
    adversarial_review: {
      models: [{ provider: "ollama-local", model: "deepseek-coder:33b" }],
    },
  });
  const scores: ModelScore[] = [
    builderScore({
      modelKey: "ollama-local:qwen2.5-coder:14b",
      orchestrationsParticipated: 4,
      selectionRate: 0.5,
    }),
    // adversarial_review has no evidence
  ];
  const recs = recommendPolicy(policy, scores, { minSamples: 3 });
  assert.equal(recs.length, 1); // patch_builder is silent (primary leads); review is no_evidence
  assert.equal(recs[0]!.action, "no_evidence");
  assert.equal(recs[0]!.taskClass, "adversarial_review");
});

// --- evidence content ----------------------------------------------------

test("recommendPolicy: evidence list is sorted by rate descending", () => {
  const policy = policyWith({
    patch_builder: {
      models: [{ provider: "ollama-local", model: "qwen2.5-coder:14b" }],
    },
  });
  const scores: ModelScore[] = [
    builderScore({
      modelKey: "ollama-local:qwen2.5-coder:14b",
      orchestrationsParticipated: 5,
      selectionRate: 0.4,
    }),
    builderScore({
      modelKey: "nvidia-nim:kimi-k2",
      orchestrationsParticipated: 5,
      selectionRate: 0.9,
    }),
    builderScore({
      modelKey: "nvidia-nim:deepseek-v4",
      orchestrationsParticipated: 5,
      selectionRate: 0.6,
    }),
  ];
  const recs = recommendPolicy(policy, scores, { minSamples: 3 });
  assert.equal(recs[0]!.evidence.length, 3);
  // Sorted: kimi-k2 (0.9), deepseek-v4 (0.6), qwen (0.4)
  assert.equal(recs[0]!.evidence[0]!.modelKey, "nvidia-nim:kimi-k2");
  assert.equal(recs[0]!.evidence[1]!.modelKey, "nvidia-nim:deepseek-v4");
  assert.equal(
    recs[0]!.evidence[2]!.modelKey,
    "ollama-local:qwen2.5-coder:14b",
  );
});

// --- never auto-applies --------------------------------------------------

test("recommendPolicy: input policy object is not mutated", () => {
  // Defensive — a recommender that mutates its input would surprise
  // any caller composing it with config-write code.
  const policy = policyWith({
    patch_builder: {
      models: [{ provider: "ollama-local", model: "qwen2.5-coder:14b" }],
    },
  });
  const before = JSON.stringify(policy);
  recommendPolicy(
    policy,
    [
      builderScore({
        modelKey: "nvidia-nim:kimi-k2",
        orchestrationsParticipated: 10,
        selectionRate: 0.95,
      }),
    ],
    { minSamples: 3 },
  );
  assert.equal(JSON.stringify(policy), before);
});

// --- empty scores --------------------------------------------------------

test("recommendPolicy: empty scores → no_evidence for every class", () => {
  const policy = policyWith({
    patch_builder: { models: [] },
    adversarial_review: { models: [] },
  });
  const recs = recommendPolicy(policy, []);
  assert.equal(recs.length, 2);
  assert.ok(recs.every((r) => r.action === "no_evidence"));
});
