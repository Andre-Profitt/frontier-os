// Per-(model, role) scorecard computed from the quality ledger.
//
// The router's long-term job is to pick the right model for the right
// task. To do that empirically (not by vibes) it needs aggregate stats
// per model per role. This module computes them from the worker_run +
// review_finding + model_event rows.
//
// Output is pure data; the CLI formats it. Tests assert the math.

import type { LedgerSnapshot } from "./reader.ts";
import { readLedger, type ReadOptions } from "./reader.ts";

export interface BuilderModelScore {
  modelKey: string;
  role: "builder";
  taskClass: string;
  // Total candidates this model produced across all observed orchestrations.
  candidates: number;
  // Of those, how many reached phase=collected.
  collected: number;
  // Of the collected, how many the arbiter selected.
  arbiterSelected: number;
  // Distinct packetIds this model produced any candidate for. The
  // arbiter picks at most one candidate per packet, so this is the
  // honest denominator for "how often did this model win" — see
  // selectionRate below.
  orchestrationsParticipated: number;
  // Distinct packetIds where one of this model's candidates was the
  // arbiter's pick. arbiterSelected counts candidates; this counts
  // packets, which is what selectionRate divides by.
  orchestrationsWon: number;
  // Distribution of phases across all candidates.
  phases: Record<string, number>;
  // Phase fractions:
  //   collectedRate   = collected / candidates
  //   selectionRate   = orchestrationsWon / orchestrationsParticipated
  // selectionRate uses per-packet math (not arbiterSelected/collected)
  // because the arbiter only picks one per packet — using collected as
  // the denominator would penalise models that produce more candidates
  // per packet (their structural ceiling drops below 1.0).
  collectedRate: number;
  selectionRate: number;
  // How often a high-severity bug or contract_violation was raised
  // against THIS model's candidates by reviewers (signal: noisy patches
  // attract real findings).
  highBugFindingsAgainst: number;
  // Mean rubric score across collected candidates (NaN if none).
  meanRubricScore: number | null;
  meanRubricCoverage: number | null;
  // Patch EE: retry-tool yield. Each retry costs broker calls; these
  // stats let an operator decide whether the cost is paying off per
  // model. "Used" = the candidate triggered a retry (Patch Y or BB).
  // "Rescues" = used AND ended up in a healthy terminal state — for
  // apply-retry, that's phase=collected (Patch Y only sets
  // applyAttempts on the S/R path, and phase=collected proves apply
  // ultimately succeeded); for verify-retry, that's
  // builderVerificationPhase ∈ {passed, passed_typecheck_only}.
  // RescueRate = rescues / used; null when used=0 (the model never
  // tripped the retry path, so its yield is undefined — distinct from
  // a 0% rate which means "always tripped, never rescued").
  applyRetriesUsed: number;
  applyRetryRescues: number;
  applyRetryRescueRate: number | null;
  verifyRetriesUsed: number;
  verifyRetryRescues: number;
  verifyRetryRescueRate: number | null;
}

export interface ReviewerModelScore {
  modelKey: string;
  role: "reviewer";
  taskClass: string;
  // Reviewer runs (one per reviewer per swarm).
  runs: number;
  // Reviewer runs that returned a parseable, schema-valid output.
  validRuns: number;
  // Total findings produced by this reviewer.
  findings: number;
  // Findings broken down by category and severity.
  findingsByCategory: Record<string, number>;
  findingsBySeverity: Record<string, number>;
  // Validity rate = validRuns / runs.
  validityRate: number;
  // High-severity bug + contract_violation count — what an adversarial
  // reviewer SHOULD be producing if it's earning its job.
  highImpactFindings: number;
}

export type ModelScore = BuilderModelScore | ReviewerModelScore;

export interface ScoreOptions extends ReadOptions {
  // Filter to a specific role; default both.
  role?: "builder" | "reviewer";
  // Filter to a specific task class.
  taskClass?: string;
}

export function computeModelScores(opts: ScoreOptions = {}): ModelScore[] {
  const snapshot = readLedger(opts);
  return computeFromSnapshot(snapshot, opts);
}

// Pure: takes a snapshot, returns scores. Useful for tests.
export function computeFromSnapshot(
  snapshot: LedgerSnapshot,
  opts: { role?: "builder" | "reviewer"; taskClass?: string } = {},
): ModelScore[] {
  const out: ModelScore[] = [];
  if (opts.role === undefined || opts.role === "builder") {
    out.push(...computeBuilderScores(snapshot, opts.taskClass));
  }
  if (opts.role === undefined || opts.role === "reviewer") {
    out.push(...computeReviewerScores(snapshot, opts.taskClass));
  }
  return out.sort(scoreSort);
}

// --- builder scoring -----------------------------------------------------

function computeBuilderScores(
  snapshot: LedgerSnapshot,
  taskClassFilter?: string,
): BuilderModelScore[] {
  type Acc = {
    modelKey: string;
    taskClass: string;
    candidates: number;
    collected: number;
    arbiterSelected: number;
    // packetIds where this model produced any candidate.
    packetIdsParticipated: Set<string>;
    // packetIds where this model's candidate was the arbiter's pick.
    packetIdsWon: Set<string>;
    phases: Record<string, number>;
    highBugFindingsAgainst: number;
    rubricScores: number[];
    rubricCoverages: number[];
    // Patch EE: retry-yield accumulators.
    applyRetriesUsed: number;
    applyRetryRescues: number;
    verifyRetriesUsed: number;
    verifyRetryRescues: number;
  };
  const accs = new Map<string, Acc>();

  for (const wr of snapshot.workerRuns) {
    if (wr.role !== "builder") continue;
    if (!wr.modelKey) continue;
    if (taskClassFilter && wr.taskClass !== taskClassFilter) continue;
    const key = `${wr.modelKey}::${wr.taskClass}`;
    const acc = accs.get(key) ?? {
      modelKey: wr.modelKey,
      taskClass: wr.taskClass,
      candidates: 0,
      collected: 0,
      arbiterSelected: 0,
      packetIdsParticipated: new Set<string>(),
      packetIdsWon: new Set<string>(),
      phases: {},
      highBugFindingsAgainst: 0,
      rubricScores: [],
      rubricCoverages: [],
      applyRetriesUsed: 0,
      applyRetryRescues: 0,
      verifyRetriesUsed: 0,
      verifyRetryRescues: 0,
    };
    acc.candidates += 1;
    acc.packetIdsParticipated.add(wr.packetId);
    acc.phases[wr.phase] = (acc.phases[wr.phase] ?? 0) + 1;
    if (wr.phase === "collected") acc.collected += 1;
    if (wr.arbiterOutcome === "selected") {
      acc.arbiterSelected += 1;
      acc.packetIdsWon.add(wr.packetId);
    }
    if (wr.reviewFindings) {
      // High-impact = high severity + bug or contract_violation. Use
      // worker_run's reviewFindings aggregate (already keyed to the
      // reviewers of THIS candidate).
      const high = wr.reviewFindings.high ?? 0;
      const bug = wr.reviewFindings.bug ?? 0;
      const cv = wr.reviewFindings.contract_violation ?? 0;
      // Conservative: count high-severity findings only when the
      // candidate also had bug or contract_violation findings (avoids
      // counting a high-severity style finding as load-bearing).
      if (high > 0 && (bug > 0 || cv > 0)) {
        acc.highBugFindingsAgainst += high;
      }
    }
    if (typeof wr.rubricScore === "number")
      acc.rubricScores.push(wr.rubricScore);
    if (typeof wr.rubricCoverage === "number")
      acc.rubricCoverages.push(wr.rubricCoverage);
    // Patch EE: tally retry usage / rescue. A "rescue" requires the
    // retry to have actually rescued the run; we use the cleanest
    // observable proof per retry kind:
    //   - Apply-retry: phase=collected (Patch Y only sets applyAttempts
    //     on the S/R path, and phase=collected requires successful
    //     apply + commit + collect).
    //   - Verify-retry: builderVerificationPhase ∈ {passed,
    //     passed_typecheck_only} (the builder's own verifier ended in a
    //     healthy state). passed_typecheck_only counts because Patch BB
    //     retry only fires for typecheck_failed/tests_failed; reaching
    //     passed_typecheck_only after a retry means typecheck no longer
    //     fails, which is the rescue we wanted.
    if (typeof wr.applyAttempts === "number" && wr.applyAttempts > 1) {
      acc.applyRetriesUsed += 1;
      if (wr.phase === "collected") acc.applyRetryRescues += 1;
    }
    if (typeof wr.verifyAttempts === "number" && wr.verifyAttempts > 1) {
      acc.verifyRetriesUsed += 1;
      if (
        wr.builderVerificationPhase === "passed" ||
        wr.builderVerificationPhase === "passed_typecheck_only"
      ) {
        acc.verifyRetryRescues += 1;
      }
    }
    accs.set(key, acc);
  }

  return [...accs.values()].map((acc) => {
    const participated = acc.packetIdsParticipated.size;
    const won = acc.packetIdsWon.size;
    return {
      modelKey: acc.modelKey,
      role: "builder",
      taskClass: acc.taskClass,
      candidates: acc.candidates,
      collected: acc.collected,
      arbiterSelected: acc.arbiterSelected,
      orchestrationsParticipated: participated,
      orchestrationsWon: won,
      phases: acc.phases,
      collectedRate: acc.candidates > 0 ? acc.collected / acc.candidates : 0,
      selectionRate: participated > 0 ? won / participated : 0,
      highBugFindingsAgainst: acc.highBugFindingsAgainst,
      meanRubricScore: mean(acc.rubricScores),
      meanRubricCoverage: mean(acc.rubricCoverages),
      applyRetriesUsed: acc.applyRetriesUsed,
      applyRetryRescues: acc.applyRetryRescues,
      applyRetryRescueRate:
        acc.applyRetriesUsed > 0
          ? acc.applyRetryRescues / acc.applyRetriesUsed
          : null,
      verifyRetriesUsed: acc.verifyRetriesUsed,
      verifyRetryRescues: acc.verifyRetryRescues,
      verifyRetryRescueRate:
        acc.verifyRetriesUsed > 0
          ? acc.verifyRetryRescues / acc.verifyRetriesUsed
          : null,
    };
  });
}

// --- reviewer scoring ----------------------------------------------------

function computeReviewerScores(
  snapshot: LedgerSnapshot,
  taskClassFilter?: string,
): ReviewerModelScore[] {
  type Acc = {
    modelKey: string;
    taskClass: string;
    runs: number;
    validRuns: number;
    findings: number;
    findingsByCategory: Record<string, number>;
    findingsBySeverity: Record<string, number>;
    highImpactFindings: number;
  };
  const accs = new Map<string, Acc>();

  // Reviewer runs come from model_events with role=reviewer (one per
  // model per packet aggregate).
  for (const me of snapshot.modelEvents) {
    if (me.role !== "reviewer") continue;
    if (taskClassFilter && me.taskClass !== taskClassFilter) continue;
    const key = `${me.modelKey}::${me.taskClass}`;
    const acc = accs.get(key) ?? {
      modelKey: me.modelKey,
      taskClass: me.taskClass,
      runs: 0,
      validRuns: 0,
      findings: 0,
      findingsByCategory: {},
      findingsBySeverity: {},
      highImpactFindings: 0,
    };
    acc.runs += me.callsTotal;
    acc.validRuns += me.callsOk;
    accs.set(key, acc);
  }

  // Findings come from review_finding events. They don't carry taskClass
  // directly per finding, so we trust the reviewer's reviewerRole/taskClass
  // pair on each row.
  for (const rf of snapshot.reviewFindings) {
    if (!rf.modelKey) continue;
    if (taskClassFilter && rf.taskClass !== taskClassFilter) continue;
    const key = `${rf.modelKey}::${rf.taskClass}`;
    let acc = accs.get(key);
    if (!acc) {
      // Reviewer produced a finding but no corresponding model_event —
      // possible if the orchestration ingestion was partial. Create on
      // the fly.
      acc = {
        modelKey: rf.modelKey,
        taskClass: rf.taskClass,
        runs: 0,
        validRuns: 0,
        findings: 0,
        findingsByCategory: {},
        findingsBySeverity: {},
        highImpactFindings: 0,
      };
      accs.set(key, acc);
    }
    acc.findings += 1;
    acc.findingsByCategory[rf.category] =
      (acc.findingsByCategory[rf.category] ?? 0) + 1;
    acc.findingsBySeverity[rf.severity] =
      (acc.findingsBySeverity[rf.severity] ?? 0) + 1;
    if (
      rf.severity === "high" &&
      (rf.category === "bug" || rf.category === "contract_violation")
    ) {
      acc.highImpactFindings += 1;
    }
  }

  return [...accs.values()].map((acc) => ({
    modelKey: acc.modelKey,
    role: "reviewer",
    taskClass: acc.taskClass,
    runs: acc.runs,
    validRuns: acc.validRuns,
    findings: acc.findings,
    findingsByCategory: acc.findingsByCategory,
    findingsBySeverity: acc.findingsBySeverity,
    validityRate: acc.runs > 0 ? acc.validRuns / acc.runs : 0,
    highImpactFindings: acc.highImpactFindings,
  }));
}

// --- helpers --------------------------------------------------------------

function mean(xs: number[]): number | null {
  if (xs.length === 0) return null;
  let sum = 0;
  for (const x of xs) sum += x;
  return sum / xs.length;
}

// Builders before reviewers; within role, by taskClass then modelKey.
function scoreSort(a: ModelScore, b: ModelScore): number {
  if (a.role !== b.role) return a.role === "builder" ? -1 : 1;
  if (a.taskClass !== b.taskClass)
    return a.taskClass.localeCompare(b.taskClass);
  return a.modelKey.localeCompare(b.modelKey);
}
