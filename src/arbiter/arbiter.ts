// Arbiter — final ship/block decision over a BuilderSwarmPacket.
//
// Inputs:
//   - BuilderSwarmPacket (PR R5) — N candidate patches with phase/patch
//   - ReviewPacket[] (PR R3, optional) — one per candidate
//   - Rubric path (taste/rubrics/<id>.json)
//   - Anti-example paths (taste/anti_examples/*.md)
//   - qualityFloor — reject candidates below this aggregate rubric score
//
// Decision logic (v1):
//   1. Filter out candidates where phase != "collected" (no patch to ship)
//   2. Re-run verification (typecheck + test) in each candidate's worktree
//   3. Score each candidate against the rubric heuristically
//   4. Match against anti-examples (text-level grep on diff)
//   5. Pick decision:
//        - 0 candidates pass verification → reject
//        - 0 candidates above qualityFloor → reject
//        - exactly 1 candidate qualifies → accept that one
//        - >1 candidate qualifies → escalate_to_human (no auto-tiebreaking)
//   6. Render evidence string for the operator
//
// `combine` is a valid decision in the schema but v1 never picks it
// automatically — combining diffs requires per-hunk reasoning. An
// operator can pick combine after reading the evidence.

import { readFileSync, existsSync } from "node:fs";

import type {
  ArbiterDecision,
  ArbiterDecisionKind,
  AntiExampleMatch,
  RubricScore,
  VerificationResult,
} from "./types.ts";
import { verifyCandidate, type VerifierOptions } from "./verifier.ts";
import {
  loadRubric,
  scoreCandidate,
  type Rubric,
  type ReviewerFindingSummary,
} from "./rubric-scorer.ts";

// Subset of the BuilderSwarmPacket shape we need. Importing the type
// directly would make this depend on src/swarm/builder-swarm.ts — the
// arbiter should be loosely coupled to where the candidates came from.
export interface CandidateInput {
  builderId: string;
  modelKey?: string;
  worktreePath?: string;
  ok: boolean;
  phase: string;
  patch?: {
    diff: string;
    files: string[];
    sizeBytes: number;
    addedLines: number;
    deletedLines: number;
    commitCount: number;
  };
}

export interface ReviewerFindingInput {
  builderId: string;
  // Loose shape — matches ReviewPacket.findingsBySeverity / findingsByCategory.
  findingsBySeverity?: { high?: number; medium?: number; low?: number };
  findingsByCategory?: Record<string, number>;
  antiExampleMatched?: boolean;
  // From ReviewPacket.reviewCoverage. The arbiter requires this is at or
  // above minReviewCoverage before treating an empty findings list as
  // "reviewClean" — otherwise N reviewers returning unparseable text
  // aggregates to totalFindings=0 (false clean, GPT Pro Issue #2).
  reviewCoverage?: number;
}

export interface ArbiterInput {
  taskId: string;
  packetId?: string;
  candidates: CandidateInput[];
  reviewerFindings?: ReviewerFindingInput[];
  rubricPath: string;
  qualityFloor?: number;
  // Minimum scoredWeight/totalWeight a rubric score must have before it
  // counts. Without this gate a candidate could earn score=1.0 from one
  // criterion out of ten — false confidence. (GPT Pro Issue #3.)
  minRubricCoverage?: number;
  // Minimum validReviewerCount/reviewerCount before reviews count as
  // "clean" when there are no findings. (GPT Pro Issue #2.)
  minReviewCoverage?: number;
  antiExamplePaths?: string[];
  // Per-candidate verification commands. Defaults to npm run typecheck.
  // testCommand has no default — repo has no `npm test`. Set both to null
  // to skip verification entirely; in that case requireTests is forced
  // false so verPassed can still be true.
  typecheckCommand?: string[] | null;
  testCommand?: string[] | null;
  // When true (default), a candidate is only verPassed if BOTH typecheck
  // and tests ran successfully. Set false (or pass --skip-verify on the
  // CLI) to allow typecheck-only verification. (GPT Pro Issue #5.)
  requireTests?: boolean;
  // Test seams.
  loadRubricImpl?: (path: string) => Rubric;
  verifierImpl?: (opts: VerifierOptions) => VerificationResult;
  loadAntiExampleImpl?: (path: string) => string;
  now?: () => number;
}

const DEFAULT_QUALITY_FLOOR = 0.7;
const DEFAULT_MIN_RUBRIC_COVERAGE = 0.5;
const DEFAULT_MIN_REVIEW_COVERAGE = 0.66;

export async function decide(input: ArbiterInput): Promise<ArbiterDecision> {
  const now = input.now ?? Date.now;
  const t0 = now();
  const qualityFloor = input.qualityFloor ?? DEFAULT_QUALITY_FLOOR;
  const minRubricCoverage =
    input.minRubricCoverage ?? DEFAULT_MIN_RUBRIC_COVERAGE;
  const minReviewCoverage =
    input.minReviewCoverage ?? DEFAULT_MIN_REVIEW_COVERAGE;
  // Default true. The CLI's --skip-verify flag flips this to false; the
  // verifier returns phase="passed_typecheck_only" when no testCommand
  // is supplied and that ONLY counts as verPassed when requireTests is
  // explicitly false. (GPT Pro Issue #5.)
  const requireTests = input.requireTests ?? true;
  const loadRubricFn = input.loadRubricImpl ?? loadRubric;
  const verifyFn = input.verifierImpl ?? verifyCandidate;
  const loadAntiExampleFn = input.loadAntiExampleImpl ?? defaultLoadAntiExample;

  const decisionId = newDecisionId(now());
  const rubric = loadRubricFn(input.rubricPath);

  // Index reviewer findings by builderId for O(1) lookup.
  const findingsByBuilder = new Map<string, ReviewerFindingInput>();
  for (const r of input.reviewerFindings ?? []) {
    findingsByBuilder.set(r.builderId, r);
  }

  // Only candidates that successfully collected a patch are eligible to
  // be shipped. spawn_failed / broker_failed / no_diff_extracted /
  // scope_rejected / apply_failed candidates surface in evidence but
  // are excluded.
  const collected = input.candidates.filter(
    (c) => c.ok && c.phase === "collected" && c.patch && c.worktreePath,
  );

  // Load anti-example bodies once for diff matching. Track which paths
  // failed to load — the arbiter must NOT silently skip them. A missing
  // anti-example is a config error worth escalating. (GPT Pro Issue #6.)
  const antiExampleBodies: Array<{ path: string; body: string }> = [];
  const missingAntiExamplePaths: string[] = [];
  for (const path of input.antiExamplePaths ?? []) {
    try {
      antiExampleBodies.push({ path, body: loadAntiExampleFn(path) });
    } catch {
      missingAntiExamplePaths.push(path);
    }
  }

  // --- per-candidate verification + scoring + anti-example match ----
  const verificationResults: VerificationResult[] = [];
  const rubricScores: RubricScore[] = [];
  const antiExampleMatches: AntiExampleMatch[] = [];

  for (const c of collected) {
    const verification = verifyFn({
      builderId: c.builderId,
      worktreePath: c.worktreePath!,
      ...(input.typecheckCommand !== undefined
        ? { typecheckCommand: input.typecheckCommand }
        : {}),
      ...(input.testCommand !== undefined
        ? { testCommand: input.testCommand }
        : {}),
    });
    verificationResults.push(verification);

    const findings = summarizeFindings(findingsByBuilder.get(c.builderId));
    // Anti-example match — text-level signal (case-insensitive substring
    // or filename match in diff). v1 is conservative: only flag when an
    // anti-example KEY PHRASE appears verbatim in the candidate's diff.
    let candidateMatchedAnti = false;
    for (const { path, body } of antiExampleBodies) {
      const verdict = matchAntiExample(c.patch?.diff ?? "", body);
      if (verdict !== "safe") candidateMatchedAnti = true;
      antiExampleMatches.push({
        builderId: c.builderId,
        antiExample: path,
        verdict,
      });
    }
    if (candidateMatchedAnti) findings.antiExampleMatched = true;

    rubricScores.push(
      scoreCandidate({
        builderId: c.builderId,
        rubric,
        verification,
        reviewerFindings: findings,
      }),
    );
  }

  // --- decision -----------------------------------------------------
  //
  // Eligibility breakdown (GPT Pro Issues #2/#3/#5/#6):
  //   - verPassed: phase==="passed" always counts; "passed_typecheck_only"
  //     only counts when requireTests === false (caller explicitly
  //     opted out of tests).
  //   - rubricScoreOk: score >= qualityFloor
  //   - rubricCoverageOk: coverage >= minRubricCoverage. Without this,
  //     score=1.0 from one criterion of ten still passes — false rigor.
  //   - reviewCoverageOk: when reviewerFindings provided, reviewCoverage
  //     must be >= minReviewCoverage. Skipped when no findings provided
  //     (caller chose not to gate on reviews).
  //   - noBlockingReviewIssue: zero bug + zero contract_violation +
  //     zero high-severity findings. ANY of these flips the candidate
  //     from accept-eligible to escalate-only (operator decides whether
  //     the finding is a true positive). Renamed from
  //     noBlockingReviewIssue (Patch E4 / GPT third-pass note):
  //     the field treats any bug or contract_violation as blocking
  //     regardless of severity, so the old name lied.
  //   - antiExampleGateOk: no matched anti-example AND all configured
  //     anti-example paths loaded.
  //
  // The eligibility predicate is a hard AND of objective gates plus a
  // separate set of "uncertain" signals that escalate. A candidate that
  // fails an objective gate is reject-eligible; a candidate that fails
  // only an uncertain gate is escalate-eligible.

  const eligibility = collected.map((c) => {
    const ver = verificationResults.find((v) => v.builderId === c.builderId);
    const score = rubricScores.find((s) => s.builderId === c.builderId);
    const findings = findingsByBuilder.get(c.builderId);
    const findingsSeverityHigh = findings?.findingsBySeverity?.high ?? 0;
    const findingsBugs = findings?.findingsByCategory?.["bug"] ?? 0;
    const findingsContract =
      findings?.findingsByCategory?.["contract_violation"] ?? 0;
    const matchedAnti = antiExampleMatches.some(
      (m) => m.builderId === c.builderId && m.verdict === "matches",
    );

    // verPassed: typecheck-only counts only when caller waived tests.
    let verPassed: boolean;
    if (ver?.phase === "passed") {
      verPassed = true;
    } else if (ver?.phase === "passed_typecheck_only") {
      verPassed = !requireTests;
    } else {
      verPassed = false;
    }

    const rubricScore = score?.score ?? 0;
    const rubricCoverage = score?.coverage ?? 0;
    const rubricScoreOk = rubricScore >= qualityFloor;
    const rubricCoverageOk = rubricCoverage >= minRubricCoverage;

    // Review coverage gate is skipped when the caller didn't pass any
    // findings for this builder (no review packet → no opinion on
    // reviewClean either way). When findings ARE provided, require
    // coverage above floor before treating absence-of-findings as
    // "clean."
    let reviewCoverageOk = true;
    if (findings !== undefined) {
      const cov = findings.reviewCoverage ?? 0;
      reviewCoverageOk = cov >= minReviewCoverage;
    }

    const noBlockingReviewIssue =
      findingsBugs === 0 &&
      findingsContract === 0 &&
      findingsSeverityHigh === 0;
    const antiExampleGateOk =
      !matchedAnti && missingAntiExamplePaths.length === 0;

    // Hard eligibility: every gate must pass.
    const eligible =
      verPassed &&
      rubricScoreOk &&
      rubricCoverageOk &&
      reviewCoverageOk &&
      noBlockingReviewIssue &&
      antiExampleGateOk;

    const out: Eligibility = {
      builderId: c.builderId,
      verPassed,
      rubricScoreOk,
      rubricCoverageOk,
      rubricScore,
      rubricCoverage,
      reviewCoverageOk,
      noBlockingReviewIssue,
      antiExampleGateOk,
      eligible,
      score: rubricScore,
    };
    if (findings?.reviewCoverage !== undefined) {
      out.reviewCoverage = findings.reviewCoverage;
    }
    return out;
  });

  const eligible = eligibility.filter((e) => e.eligible);

  let decision: ArbiterDecisionKind;
  let selectedBuilderId: string | undefined;
  let rejectionReasons: string[] | undefined;
  let escalationQuestion: string | undefined;

  if (collected.length === 0) {
    decision = "reject";
    rejectionReasons = ["no candidate reached phase=collected"];
  } else if (missingAntiExamplePaths.length > 0) {
    // Config-error escalation: the caller asked us to gate on
    // anti-examples we couldn't load. Don't silently drop the gate.
    decision = "escalate_to_human";
    escalationQuestion = `arbiter could not load ${missingAntiExamplePaths.length} configured anti-example file(s): ${missingAntiExamplePaths.join(", ")}. Fix paths or re-run with corrected --anti-examples.`;
  } else if (eligible.length === 0) {
    // Reject vs escalate (Patch E3 / GPT Pro second-pass blocker #1):
    // Pre-E3, "any candidate has an objective failure" → whole-run
    // reject. That threw away viable uncertainty-only candidates: if
    // candidate B failed verification but candidate A only failed
    // rubric COVERAGE, A is still worth a human's eye.
    //
    // E3 rule: if ANY candidate passed every objective gate (verPassed
    // && rubricScoreOk && antiExampleGateOk) and failed only on
    // uncertainty (rubric coverage, review coverage, or a confirmed
    // high-severity finding that might be a true positive), escalate.
    // Reject only when EVERY candidate has at least one objective
    // failure.
    const uncertaintyOnly = eligibility.filter(
      (e) =>
        e.verPassed &&
        e.rubricScoreOk &&
        e.antiExampleGateOk &&
        (!e.rubricCoverageOk ||
          !e.reviewCoverageOk ||
          !e.noBlockingReviewIssue),
    );
    if (uncertaintyOnly.length > 0) {
      decision = "escalate_to_human";
      escalationQuestion = collectEscalationReasons(
        uncertaintyOnly,
        qualityFloor,
        minRubricCoverage,
        minReviewCoverage,
      );
    } else {
      decision = "reject";
      rejectionReasons = collectRejectionReasons(
        eligibility,
        qualityFloor,
        minRubricCoverage,
        minReviewCoverage,
      );
    }
  } else if (eligible.length === 1) {
    decision = "accept";
    selectedBuilderId = eligible[0]!.builderId;
  } else {
    decision = "escalate_to_human";
    const ranked = [...eligible].sort((a, b) => b.score - a.score);
    escalationQuestion = `${eligible.length} candidates pass verification + rubric + reviews; pick one: ${ranked.map((r) => `${r.builderId}(${r.score.toFixed(2)})`).join(", ")}`;
  }

  const evidence = renderEvidence({
    decision,
    ...(selectedBuilderId !== undefined ? { selectedBuilderId } : {}),
    ...(rejectionReasons !== undefined ? { rejectionReasons } : {}),
    ...(escalationQuestion !== undefined ? { escalationQuestion } : {}),
    eligibility,
    qualityFloor,
    minRubricCoverage,
    minReviewCoverage,
    requireTests,
    missingAntiExamplePaths,
    candidates: input.candidates,
    verificationResults,
    rubricScores,
    antiExampleMatches,
  });

  const result: ArbiterDecision = {
    decisionId,
    scannedAt: new Date(now()).toISOString(),
    taskId: input.taskId,
    ...(input.packetId !== undefined ? { packetId: input.packetId } : {}),
    decision,
    ...(selectedBuilderId !== undefined ? { selectedBuilderId } : {}),
    ...(rejectionReasons !== undefined ? { rejectionReasons } : {}),
    ...(escalationQuestion !== undefined ? { escalationQuestion } : {}),
    qualityFloor,
    candidatesEvaluated: collected.length,
    rerunVerification: {
      builderIds: verificationResults.map((v) => v.builderId),
      results: verificationResults,
    },
    rubricScores,
    antiExampleMatches,
    evidence,
    elapsedMs: now() - t0,
  };
  return result;
}

// --- helpers -------------------------------------------------------------

function summarizeFindings(
  input: ReviewerFindingInput | undefined,
): ReviewerFindingSummary {
  if (!input) return {};
  const cat = input.findingsByCategory ?? {};
  const sev = input.findingsBySeverity ?? {};
  return {
    bug: cat["bug"] ?? 0,
    contract_violation: cat["contract_violation"] ?? 0,
    false_green: cat["false_green"] ?? 0,
    risk: cat["risk"] ?? 0,
    style: cat["style"] ?? 0,
    high: sev.high ?? 0,
    medium: sev.medium ?? 0,
    low: sev.low ?? 0,
    ...(input.antiExampleMatched !== undefined
      ? { antiExampleMatched: input.antiExampleMatched }
      : {}),
  };
}

// Look for the anti-example's KEY PHRASE in the diff. v1 strategy: extract
// the first heading from the anti-example markdown as the key phrase.
// Match is case-insensitive. False positives are bad here — when in doubt
// we return "safe" so the arbiter doesn't reject good work over a
// superficial keyword match.
export function matchAntiExample(
  diff: string,
  antiExampleBody: string,
): "matches" | "safe" | "unsure" {
  if (!diff || !antiExampleBody) return "safe";
  // Heading lines starting with `# ` or `## ` are candidate key phrases.
  const headings = antiExampleBody
    .split("\n")
    .filter((l) => /^#{1,3}\s/.test(l))
    .map((l) => l.replace(/^#+\s+/, "").trim())
    .filter((l) => l.length >= 6);
  const diffLower = diff.toLowerCase();
  for (const heading of headings) {
    if (diffLower.includes(heading.toLowerCase())) return "matches";
  }
  return "safe";
}

function defaultLoadAntiExample(path: string): string {
  if (!existsSync(path)) {
    throw new Error(`anti-example not found: ${path}`);
  }
  return readFileSync(path, "utf8");
}

// Per-builder Eligibility shape used by both decision logic and the
// evidence renderer. Pulled out so the helper signatures stay honest.
interface Eligibility {
  builderId: string;
  verPassed: boolean;
  rubricScoreOk: boolean;
  rubricCoverageOk: boolean;
  rubricScore: number;
  rubricCoverage: number;
  reviewCoverageOk: boolean;
  reviewCoverage?: number;
  noBlockingReviewIssue: boolean;
  antiExampleGateOk: boolean;
  eligible: boolean;
  score: number;
}

// Reject reasons: only emit objective failures here. Uncertain failures
// (coverage, confirmed-high-severity, anti-example match) go to
// collectEscalationReasons. Single-call from decide() decides which.
function collectRejectionReasons(
  eligibility: Eligibility[],
  qualityFloor: number,
  minRubricCoverage: number,
  minReviewCoverage: number,
): string[] {
  const reasons: string[] = [];
  for (const e of eligibility) {
    const why: string[] = [];
    if (!e.verPassed)
      why.push(
        "verification did not pass (typecheck or test failed; or testCommand omitted with requireTests=true)",
      );
    if (!e.rubricScoreOk)
      why.push(
        `rubric score ${e.rubricScore.toFixed(2)} < qualityFloor ${qualityFloor}`,
      );
    if (!e.rubricCoverageOk)
      why.push(
        `rubric coverage ${e.rubricCoverage.toFixed(2)} < minRubricCoverage ${minRubricCoverage}`,
      );
    if (!e.reviewCoverageOk && e.reviewCoverage !== undefined)
      why.push(
        `review coverage ${e.reviewCoverage.toFixed(2)} < minReviewCoverage ${minReviewCoverage}`,
      );
    if (!e.noBlockingReviewIssue)
      why.push("reviewer flagged high-severity bug or contract_violation");
    if (!e.antiExampleGateOk) why.push("matched a taste/anti_examples pattern");
    if (why.length > 0) reasons.push(`${e.builderId}: ${why.join("; ")}`);
  }
  return reasons;
}

// Escalation when no candidate is fully eligible but the only blockers
// are uncertain (low coverage, contested high-severity, anti-example
// pattern that might be a true positive). Operator decides.
function collectEscalationReasons(
  eligibility: Eligibility[],
  qualityFloor: number,
  minRubricCoverage: number,
  minReviewCoverage: number,
): string {
  const lines: string[] = [];
  for (const e of eligibility) {
    const blockers: string[] = [];
    if (!e.rubricCoverageOk)
      blockers.push(
        `rubric coverage ${e.rubricCoverage.toFixed(2)} < ${minRubricCoverage} (heuristic could not score enough criteria)`,
      );
    if (!e.reviewCoverageOk && e.reviewCoverage !== undefined)
      blockers.push(
        `review coverage ${e.reviewCoverage.toFixed(2)} < ${minReviewCoverage} (too many reviewers returned unparseable text)`,
      );
    if (!e.noBlockingReviewIssue)
      blockers.push(
        "reviewer flagged a high-severity bug or contract_violation — operator confirms or rejects the finding",
      );
    if (blockers.length > 0)
      lines.push(`${e.builderId}: ${blockers.join("; ")}`);
  }
  void qualityFloor;
  if (lines.length === 0) {
    return "no candidate cleared all gates; nothing concrete to escalate (this is a bug — please report)";
  }
  return `no candidate fully eligible; uncertainty on each — operator decides:\n  - ${lines.join("\n  - ")}`;
}

function renderEvidence(opts: {
  decision: ArbiterDecisionKind;
  selectedBuilderId?: string;
  rejectionReasons?: string[];
  escalationQuestion?: string;
  eligibility: Eligibility[];
  qualityFloor: number;
  minRubricCoverage: number;
  minReviewCoverage: number;
  requireTests: boolean;
  missingAntiExamplePaths: string[];
  candidates: CandidateInput[];
  verificationResults: VerificationResult[];
  rubricScores: RubricScore[];
  antiExampleMatches: AntiExampleMatch[];
}): string {
  const lines: string[] = [];
  lines.push(`Decision: ${opts.decision}`);
  if (opts.selectedBuilderId) lines.push(`Selected: ${opts.selectedBuilderId}`);
  if (opts.escalationQuestion)
    lines.push(`Escalation: ${opts.escalationQuestion}`);
  if (opts.rejectionReasons?.length) {
    lines.push(`Rejection reasons:`);
    for (const r of opts.rejectionReasons) lines.push(`  - ${r}`);
  }
  lines.push(``);
  lines.push(
    `Gates: qualityFloor=${opts.qualityFloor}, minRubricCoverage=${opts.minRubricCoverage}, minReviewCoverage=${opts.minReviewCoverage}, requireTests=${opts.requireTests}`,
  );
  if (opts.missingAntiExamplePaths.length > 0) {
    lines.push(
      `Anti-example config error: ${opts.missingAntiExamplePaths.length} path(s) failed to load → ${opts.missingAntiExamplePaths.join(", ")}`,
    );
  }
  lines.push(``);
  lines.push(`Eligibility per candidate:`);
  for (const e of opts.eligibility) {
    const reviewPart =
      e.reviewCoverage !== undefined
        ? ` reviewCovOk=${e.reviewCoverageOk}(${e.reviewCoverage.toFixed(2)})`
        : ` reviewCovOk=skipped`;
    lines.push(
      `  ${e.builderId}: eligible=${e.eligible} | verPassed=${e.verPassed} rubricScoreOk=${e.rubricScoreOk}(${e.rubricScore.toFixed(2)}) rubricCovOk=${e.rubricCoverageOk}(${e.rubricCoverage.toFixed(2)})${reviewPart} noBlockingReview=${e.noBlockingReviewIssue} antiOk=${e.antiExampleGateOk}`,
    );
  }
  const skipped = opts.candidates.filter(
    (c) => !(c.ok && c.phase === "collected"),
  );
  if (skipped.length > 0) {
    lines.push(``);
    lines.push(`Excluded (did not collect a patch):`);
    for (const c of skipped) {
      lines.push(`  ${c.builderId}: phase=${c.phase}`);
    }
  }
  return lines.join("\n");
}

function newDecisionId(nowMs: number): string {
  const ts = Math.floor(nowMs / 1000).toString(36);
  const rand = Math.random().toString(36).slice(2, 8);
  return `arb-${ts}-${rand}`;
}
