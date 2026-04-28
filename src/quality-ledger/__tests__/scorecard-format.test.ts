// Q3: scorecard table renderer tests. Pure-string output — no fs.

import { test } from "node:test";
import assert from "node:assert/strict";

import { formatScorecardTable } from "../scorecard-format.ts";
import type {
  BuilderModelScore,
  ModelScore,
  ReviewerModelScore,
} from "../model-score.ts";

function builder(over: Partial<BuilderModelScore> = {}): BuilderModelScore {
  return {
    modelKey: "nim:k1",
    role: "builder",
    taskClass: "patch_builder",
    candidates: 4,
    collected: 3,
    arbiterSelected: 1,
    orchestrationsParticipated: 2,
    orchestrationsWon: 1,
    phases: { collected: 3, apply_failed: 1 },
    collectedRate: 0.75,
    selectionRate: 0.5,
    highBugFindingsAgainst: 1,
    meanRubricScore: 0.81,
    meanRubricCoverage: 0.66,
    applyRetriesUsed: 0,
    applyRetryRescues: 0,
    applyRetryRescueRate: null,
    verifyRetriesUsed: 0,
    verifyRetryRescues: 0,
    verifyRetryRescueRate: null,
    ...over,
  };
}

function reviewer(over: Partial<ReviewerModelScore> = {}): ReviewerModelScore {
  return {
    modelKey: "nim:rev",
    role: "reviewer",
    taskClass: "adversarial_review",
    runs: 10,
    validRuns: 9,
    findings: 14,
    findingsByCategory: { bug: 5, style: 9 },
    findingsBySeverity: { high: 3, medium: 4, low: 7 },
    validityRate: 0.9,
    highImpactFindings: 3,
    ...over,
  };
}

test("formatScorecardTable: builders section renders headers + per-packet selectionRate", () => {
  const out = formatScorecardTable([builder()]);
  assert.match(out, /BUILDERS/);
  assert.match(out, /modelKey/);
  // collRate, selRate columns present
  assert.match(out, /collRate/);
  assert.match(out, /selRate/);
  // Per-packet won/part column present (Q3 surfaces the new fields).
  assert.match(out, /won\/part/);
  // 0.50 rendering for selectionRate=0.5
  assert.match(out, /0\.50/);
  // 1/2 won/participated
  assert.match(out, /1\/2/);
});

test("formatScorecardTable: reviewers section renders headers + validity", () => {
  const out = formatScorecardTable([reviewer()]);
  assert.match(out, /REVIEWERS/);
  assert.match(out, /validRate/);
  assert.match(out, /highImpact/);
  assert.match(out, /0\.90/); // validityRate
});

test("formatScorecardTable: both sections present with builder-then-reviewer order", () => {
  const out = formatScorecardTable([builder(), reviewer()]);
  const builderIdx = out.indexOf("BUILDERS");
  const reviewerIdx = out.indexOf("REVIEWERS");
  assert.ok(builderIdx >= 0);
  assert.ok(reviewerIdx > builderIdx);
});

test("formatScorecardTable: empty input returns empty string by default", () => {
  assert.equal(formatScorecardTable([]), "");
});

test("formatScorecardTable: includeEmptyRoles=true renders both sections with (none)", () => {
  const out = formatScorecardTable([], { includeEmptyRoles: true });
  assert.match(out, /BUILDERS\n\s*\(none\)/);
  assert.match(out, /REVIEWERS\n\s*\(none\)/);
});

test("formatScorecardTable: meanRubricScore=null renders as em-dash, not 'null'", () => {
  const out = formatScorecardTable([builder({ meanRubricScore: null })]);
  assert.match(out, /—/);
  assert.equal(out.includes("null"), false);
});

test("formatScorecardTable: column widths grow to fit longest cell", () => {
  // A model with a very long key forces the column wider than the
  // header. The header line should still align with data lines.
  const out = formatScorecardTable([
    builder({ modelKey: "nim:very-long-model-name-here-please" }),
  ]);
  const lines = out.split("\n");
  // Find the header row and the first data row.
  const headerLine = lines.find((l) => l.includes("modelKey"));
  const dataLine = lines.find((l) =>
    l.includes("nim:very-long-model-name-here-please"),
  );
  assert.ok(headerLine);
  assert.ok(dataLine);
  // Both lines should be the same length (right-padded).
  assert.equal(headerLine!.length, dataLine!.length);
});

test("formatScorecardTable: filtered-to-builder input does not emit REVIEWERS section", () => {
  const scores: ModelScore[] = [builder()];
  const out = formatScorecardTable(scores);
  assert.equal(out.includes("REVIEWERS"), false);
});

// --- Patch FF: retry-rescue columns ------------------------------------

test("formatScorecardTable (Patch FF): apRescue / vfRescue columns render as rescues/used composite cells", () => {
  // The composite shape mirrors won/part — "1/2" reads at-a-glance
  // as "rescued 1 of 2 attempts" without forcing the operator to
  // hold ratios in their head. fmtRate(rescueRate) was the
  // alternative; rejected because seeing "0.50" without the
  // denominator hides whether the sample is meaningful (1/2 is much
  // weaker signal than 50/100 even though both render the same rate).
  const out = formatScorecardTable([
    builder({
      applyRetriesUsed: 2,
      applyRetryRescues: 1,
      applyRetryRescueRate: 0.5,
      verifyRetriesUsed: 3,
      verifyRetryRescues: 2,
      verifyRetryRescueRate: 2 / 3,
    }),
  ]);
  assert.match(out, /apRescue/);
  assert.match(out, /vfRescue/);
  assert.match(out, /1\/2/);
  assert.match(out, /2\/3/);
});

test("formatScorecardTable (Patch FF): retry path never tripped → cells render as em-dash, not 0/0", () => {
  // 0/0 would imply "had attempts, none rescued" which is the wrong
  // signal. Em-dash matches the rubric=null rendering — same "no
  // signal yet" grammar across the table.
  const out = formatScorecardTable([
    builder({
      applyRetriesUsed: 0,
      applyRetryRescues: 0,
      applyRetryRescueRate: null,
      verifyRetriesUsed: 0,
      verifyRetryRescues: 0,
      verifyRetryRescueRate: null,
    }),
  ]);
  assert.equal(out.includes("0/0"), false);
  // Should still show em-dash somewhere (rubric or rescue cells).
  assert.match(out, /—/);
});

test("formatScorecardTable (Patch FF): apply-retry tripped but never rescued renders 0/N (not em-dash)", () => {
  // Distinct signal from "never tripped". 0/5 is actionable: this
  // model trips the retry path but the retry never works for it.
  const out = formatScorecardTable([
    builder({
      applyRetriesUsed: 5,
      applyRetryRescues: 0,
      applyRetryRescueRate: 0,
    }),
  ]);
  assert.match(out, /0\/5/);
});

test("formatScorecardTable: selectionRate=0 (participated, never won) renders as 0.00", () => {
  const out = formatScorecardTable([
    builder({
      orchestrationsParticipated: 5,
      orchestrationsWon: 0,
      selectionRate: 0,
      arbiterSelected: 0,
    }),
  ]);
  assert.match(out, /0\.00/);
  assert.match(out, /0\/5/);
});
