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
}

export interface ArbiterInput {
  taskId: string;
  packetId?: string;
  candidates: CandidateInput[];
  reviewerFindings?: ReviewerFindingInput[];
  rubricPath: string;
  qualityFloor?: number;
  antiExamplePaths?: string[];
  // Per-candidate verification commands. Defaults to npm typecheck only.
  typecheckCommand?: string[] | null;
  testCommand?: string[] | null;
  // Test seams.
  loadRubricImpl?: (path: string) => Rubric;
  verifierImpl?: (opts: VerifierOptions) => VerificationResult;
  loadAntiExampleImpl?: (path: string) => string;
  now?: () => number;
}

const DEFAULT_QUALITY_FLOOR = 0.7;

export async function decide(input: ArbiterInput): Promise<ArbiterDecision> {
  const now = input.now ?? Date.now;
  const t0 = now();
  const qualityFloor = input.qualityFloor ?? DEFAULT_QUALITY_FLOOR;
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
  // apply_failed candidates surface in evidence but are excluded.
  const collected = input.candidates.filter(
    (c) => c.ok && c.phase === "collected" && c.patch && c.worktreePath,
  );

  // Load anti-example bodies once for diff matching.
  const antiExampleBodies: Array<{ path: string; body: string }> = [];
  for (const path of input.antiExamplePaths ?? []) {
    try {
      antiExampleBodies.push({ path, body: loadAntiExampleFn(path) });
    } catch {
      // Skip unreadable anti-examples; rubric-level evidence will note.
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
    const verPassed = ver?.phase === "passed";
    const rubricOk = (score?.score ?? 0) >= qualityFloor;
    const reviewClean =
      findingsBugs === 0 &&
      findingsContract === 0 &&
      findingsSeverityHigh === 0;
    const antiClean = !matchedAnti;
    return {
      builderId: c.builderId,
      verPassed,
      rubricOk,
      reviewClean,
      antiClean,
      eligible: verPassed && rubricOk && reviewClean && antiClean,
      score: score?.score ?? 0,
    };
  });

  const eligible = eligibility.filter((e) => e.eligible);

  let decision: ArbiterDecisionKind;
  let selectedBuilderId: string | undefined;
  let rejectionReasons: string[] | undefined;
  let escalationQuestion: string | undefined;

  if (collected.length === 0) {
    decision = "reject";
    rejectionReasons = ["no candidate reached phase=collected"];
  } else if (eligible.length === 0) {
    decision = "reject";
    rejectionReasons = collectRejectionReasons(eligibility, qualityFloor);
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

function collectRejectionReasons(
  eligibility: Array<{
    builderId: string;
    verPassed: boolean;
    rubricOk: boolean;
    reviewClean: boolean;
    antiClean: boolean;
    score: number;
  }>,
  qualityFloor: number,
): string[] {
  const reasons: string[] = [];
  for (const e of eligibility) {
    const why: string[] = [];
    if (!e.verPassed) why.push("verification did not pass");
    if (!e.rubricOk)
      why.push(
        `rubric score ${e.score.toFixed(2)} < qualityFloor ${qualityFloor}`,
      );
    if (!e.reviewClean)
      why.push("reviewer flagged high-severity bug or contract_violation");
    if (!e.antiClean) why.push("matched a taste/anti_examples pattern");
    reasons.push(`${e.builderId}: ${why.join("; ")}`);
  }
  return reasons;
}

function renderEvidence(opts: {
  decision: ArbiterDecisionKind;
  selectedBuilderId?: string;
  rejectionReasons?: string[];
  escalationQuestion?: string;
  eligibility: Array<{
    builderId: string;
    verPassed: boolean;
    rubricOk: boolean;
    reviewClean: boolean;
    antiClean: boolean;
    eligible: boolean;
    score: number;
  }>;
  qualityFloor: number;
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
  lines.push(`Eligibility (qualityFloor=${opts.qualityFloor}):`);
  for (const e of opts.eligibility) {
    lines.push(
      `  ${e.builderId}: eligible=${e.eligible} | verPassed=${e.verPassed} rubricOk=${e.rubricOk}(score=${e.score.toFixed(2)}) reviewClean=${e.reviewClean} antiClean=${e.antiClean}`,
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
