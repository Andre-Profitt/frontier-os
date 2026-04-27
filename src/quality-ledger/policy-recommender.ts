// Q4: model policy recommender. Pure analysis — NEVER writes the
// policy file. The CLI wraps this in `frontier quality recommend` and
// emits a JSON blob the operator reviews + applies by hand.
//
// Why no auto-apply: routing decisions move budget. The recommender's
// job is to surface evidence ("nim:k2 selectionRate=0.10 across 5
// orchestrations vs nim:k1 at 0.55") so the operator picks; it does
// not pick for them. Q5 (LLM judge) might propose patches, but even
// there, never auto-apply config changes.

import type { ModelScore } from "./model-score.ts";
import type { BuilderModelScore, ReviewerModelScore } from "./model-score.ts";

export interface ModelPolicyEntry {
  provider: string;
  model: string;
}

export interface ModelPolicyClass {
  summary?: string;
  models: ModelPolicyEntry[];
  maxParallel?: number;
}

export interface ModelPolicy {
  version?: string;
  classes: Record<string, ModelPolicyClass>;
  // Plus other top-level fields we ignore for recommendation purposes.
}

export interface RecommendationEvidence {
  // The modelKey the recommendation is about (provider:model).
  modelKey: string;
  // Per-packet selection rate for builders, validity rate for reviewers.
  rate: number;
  // packets / runs the rate is computed over. Recommendations with
  // small samples are flagged "low_confidence" via minSamples below.
  samples: number;
}

export interface PolicyRecommendation {
  // The taskClass the recommendation applies to.
  taskClass: string;
  // What the recommender thinks should happen. Categories:
  //   add_candidate     — new model in the ledger outperforms current set
  //   promote_alternate — listed alternate scores higher than primary
  //   demote_primary    — primary's rate is below the set's median; no
  //                       better alternate currently listed
  //   no_evidence       — class has < minSamples for any listed model
  action:
    | "add_candidate"
    | "promote_alternate"
    | "demote_primary"
    | "no_evidence";
  // Rationale text for the operator (one sentence).
  rationale: string;
  // The current primary entry (provider:model) for this class.
  currentPrimary: string | null;
  // The recommended primary entry (provider:model) — same as
  // currentPrimary when action=demote_primary or no_evidence.
  recommendedPrimary: string | null;
  // Evidence: each candidate the recommender considered, sorted by rate
  // descending. The operator can sanity-check the math.
  evidence: RecommendationEvidence[];
}

export interface RecommendOptions {
  // Minimum samples to consider a model's rate trustworthy.
  // Below this, the model is omitted from rankings.
  minSamples?: number;
  // The improvement margin required to recommend a swap. Default 0.10
  // = a candidate must beat the primary by at least 10 percentage
  // points before we say "swap." Prevents thrashing on noise.
  improvementMargin?: number;
}

export function recommendPolicy(
  policy: ModelPolicy,
  scores: ModelScore[],
  opts: RecommendOptions = {},
): PolicyRecommendation[] {
  const minSamples = opts.minSamples ?? 3;
  const improvementMargin = opts.improvementMargin ?? 0.1;

  const out: PolicyRecommendation[] = [];

  for (const [taskClass, klass] of Object.entries(policy.classes)) {
    const primary = klass.models[0] ?? null;
    const currentPrimary = primary ? entryKey(primary) : null;

    // Filter scores to this taskClass.
    const classScores = scores.filter((s) => s.taskClass === taskClass);
    // Build evidence list: every model with rate + samples.
    const evidence: RecommendationEvidence[] = classScores
      .map((s) => ({
        modelKey: s.modelKey,
        rate: rateOf(s),
        samples: samplesOf(s),
      }))
      .filter((e) => e.samples >= minSamples)
      .sort((a, b) => b.rate - a.rate);

    if (evidence.length === 0) {
      out.push({
        taskClass,
        action: "no_evidence",
        rationale: `No model has ≥${minSamples} samples in taskClass='${taskClass}'.`,
        currentPrimary,
        recommendedPrimary: currentPrimary,
        evidence: [],
      });
      continue;
    }

    const top = evidence[0]!;
    const policyKeys = new Set(klass.models.map(entryKey));
    const primaryEvidence = currentPrimary
      ? evidence.find((e) => e.modelKey === currentPrimary)
      : undefined;

    // 1. Top scorer is in the policy as an alternate (not primary):
    //    promote_alternate.
    if (
      top.modelKey !== currentPrimary &&
      policyKeys.has(top.modelKey) &&
      primaryEvidence !== undefined &&
      top.rate >= primaryEvidence.rate + improvementMargin
    ) {
      out.push({
        taskClass,
        action: "promote_alternate",
        rationale: `Listed alternate ${top.modelKey} (rate=${fmt(top.rate)}, n=${top.samples}) beats current primary ${currentPrimary} (rate=${fmt(primaryEvidence.rate)}, n=${primaryEvidence.samples}) by ≥${fmt(improvementMargin)}.`,
        currentPrimary,
        recommendedPrimary: top.modelKey,
        evidence,
      });
      continue;
    }

    // 2. Top scorer is NOT in the policy at all: add_candidate.
    if (!policyKeys.has(top.modelKey)) {
      const beatsPrimary =
        primaryEvidence === undefined ||
        top.rate >= primaryEvidence.rate + improvementMargin;
      if (beatsPrimary) {
        out.push({
          taskClass,
          action: "add_candidate",
          rationale: primaryEvidence
            ? `Unlisted model ${top.modelKey} (rate=${fmt(top.rate)}, n=${top.samples}) outperforms current primary ${currentPrimary} (rate=${fmt(primaryEvidence.rate)}, n=${primaryEvidence.samples}) by ≥${fmt(improvementMargin)}. Consider adding to policy.`
            : `Unlisted model ${top.modelKey} (rate=${fmt(top.rate)}, n=${top.samples}) is the only model with sufficient evidence. Consider adding to policy.`,
          currentPrimary,
          recommendedPrimary: top.modelKey,
          evidence,
        });
        continue;
      }
    }

    // 3. Primary exists in evidence and rate is the worst among
    //    candidates with sufficient evidence: demote_primary.
    if (
      primaryEvidence !== undefined &&
      evidence.length > 1 &&
      primaryEvidence.modelKey === evidence[evidence.length - 1]!.modelKey
    ) {
      out.push({
        taskClass,
        action: "demote_primary",
        rationale: `Current primary ${currentPrimary} (rate=${fmt(primaryEvidence.rate)}, n=${primaryEvidence.samples}) ranks last among ${evidence.length} candidates with ≥${minSamples} samples — worth investigating even if no clear replacement exists yet.`,
        currentPrimary,
        recommendedPrimary: currentPrimary,
        evidence,
      });
      continue;
    }

    // Otherwise: no recommendation (primary is good or evidence is
    // ambiguous within the improvement margin). Skip — silent
    // non-recommendation is correct; we don't want to spam.
  }

  return out;
}

function entryKey(e: ModelPolicyEntry): string {
  return `${e.provider}:${e.model}`;
}

function rateOf(s: ModelScore): number {
  return s.role === "builder"
    ? (s as BuilderModelScore).selectionRate
    : (s as ReviewerModelScore).validityRate;
}

function samplesOf(s: ModelScore): number {
  return s.role === "builder"
    ? (s as BuilderModelScore).orchestrationsParticipated
    : (s as ReviewerModelScore).runs;
}

function fmt(n: number): string {
  return n.toFixed(2);
}
