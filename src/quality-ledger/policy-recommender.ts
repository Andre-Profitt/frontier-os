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
  // This is the raw point estimate — surfaced for the operator's eyes
  // but NOT what promotion/demotion decisions are made on.
  rate: number;
  // packets / runs the rate is computed over.
  samples: number;
  // Wilson 95% lower bound of `rate` over `samples`. This is the
  // confidence-aware signal the recommender uses for ranking. A model
  // that wins 2/3 packets has a much lower lowerBound than a model
  // that wins 20/30 even though both have rate=0.67 — the latter has
  // earned the rate through evidence.
  lowerBound: number;
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
  // = a candidate's Wilson lower bound must beat the primary's by at
  // least 10 percentage points before we say "swap." Patch I changed
  // this from comparing raw rates to comparing lower bounds so a
  // small-sample lucky streak can't trigger promotion.
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
    // Build evidence list: every model with rate + samples + lowerBound.
    // Sort by lowerBound (the decision signal), not raw rate, so the
    // top-of-list and "ranks last" comparisons agree with the
    // promotion/demotion math below.
    const evidence: RecommendationEvidence[] = classScores
      .map((s) => {
        const rate = rateOf(s);
        const samples = samplesOf(s);
        return {
          modelKey: s.modelKey,
          rate,
          samples,
          lowerBound: wilsonLowerBound(rate, samples),
        };
      })
      .filter((e) => e.samples >= minSamples)
      .sort((a, b) => b.lowerBound - a.lowerBound);

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
    //    promote_alternate. Comparison is on Wilson lowerBound, not
    //    raw rate, so a 2-of-3 small-sample win can't displace a
    //    20-of-30 well-evidenced primary.
    if (
      top.modelKey !== currentPrimary &&
      policyKeys.has(top.modelKey) &&
      primaryEvidence !== undefined &&
      top.lowerBound >= primaryEvidence.lowerBound + improvementMargin
    ) {
      out.push({
        taskClass,
        action: "promote_alternate",
        rationale: `Listed alternate ${top.modelKey} (rate=${fmt(top.rate)}, lower=${fmt(top.lowerBound)}, n=${top.samples}) beats current primary ${currentPrimary} (rate=${fmt(primaryEvidence.rate)}, lower=${fmt(primaryEvidence.lowerBound)}, n=${primaryEvidence.samples}) on Wilson lower bound by ≥${fmt(improvementMargin)}.`,
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
        top.lowerBound >= primaryEvidence.lowerBound + improvementMargin;
      if (beatsPrimary) {
        out.push({
          taskClass,
          action: "add_candidate",
          rationale: primaryEvidence
            ? `Unlisted model ${top.modelKey} (rate=${fmt(top.rate)}, lower=${fmt(top.lowerBound)}, n=${top.samples}) outperforms current primary ${currentPrimary} (rate=${fmt(primaryEvidence.rate)}, lower=${fmt(primaryEvidence.lowerBound)}, n=${primaryEvidence.samples}) on Wilson lower bound by ≥${fmt(improvementMargin)}. Consider adding to policy.`
            : `Unlisted model ${top.modelKey} (rate=${fmt(top.rate)}, lower=${fmt(top.lowerBound)}, n=${top.samples}) is the only model with sufficient evidence. Consider adding to policy.`,
          currentPrimary,
          recommendedPrimary: top.modelKey,
          evidence,
        });
        continue;
      }
    }

    // 3. Primary exists in evidence and ranks last by lowerBound among
    //    candidates with sufficient evidence: demote_primary.
    if (
      primaryEvidence !== undefined &&
      evidence.length > 1 &&
      primaryEvidence.modelKey === evidence[evidence.length - 1]!.modelKey
    ) {
      out.push({
        taskClass,
        action: "demote_primary",
        rationale: `Current primary ${currentPrimary} (rate=${fmt(primaryEvidence.rate)}, lower=${fmt(primaryEvidence.lowerBound)}, n=${primaryEvidence.samples}) ranks last by Wilson lower bound among ${evidence.length} candidates with ≥${minSamples} samples — worth investigating even if no clear replacement exists yet.`,
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

// Wilson score interval lower bound at 95% confidence. Standard
// formulation:
//
//   z      = 1.96
//   p̂      = wins / n
//   denom  = 1 + z² / n
//   center = (p̂ + z² / (2n)) / denom
//   spread = z * sqrt((p̂(1-p̂) + z²/(4n)) / n) / denom
//   lower  = center - spread
//
// Why this and not raw rate: small-sample wins (e.g. 2/3) have wide
// uncertainty bands. Wilson collapses to raw p as n grows but heavily
// penalises low-n high-p outliers, which is exactly the behaviour we
// want for routing decisions: don't demote the well-evidenced primary
// because a new model got lucky for two orchestrations.
//
// Edge cases:
//   n=0      → lowerBound=0 (the recommender filters by minSamples
//               before this is called, so n>=1 in practice)
//   p=0, n=k → lowerBound=0 (can't get below the floor)
//   p=1, n=k → lowerBound < 1, approaches 1 as n grows
export function wilsonLowerBound(rate: number, samples: number): number {
  if (samples <= 0) return 0;
  const z = 1.96;
  const z2 = z * z;
  const phat = rate;
  const denom = 1 + z2 / samples;
  const center = (phat + z2 / (2 * samples)) / denom;
  const spread =
    (z * Math.sqrt((phat * (1 - phat) + z2 / (4 * samples)) / samples)) / denom;
  const lower = center - spread;
  return Math.max(0, Math.min(1, lower));
}
