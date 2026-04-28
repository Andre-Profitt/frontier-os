// Render a model-score array as a human-readable table.
// Pure functions — the CLI handles fs/stdout. Output goes through
// `frontier quality scorecard --format table`. JSON output is just
// JSON.stringify(scores) and lives in the CLI handler.
//
// One table per role (builders, then reviewers). Columns chosen so an
// operator can answer "which model do I trust for this taskClass?" at
// a glance: rate columns (selectionRate, validityRate) lead, raw counts
// follow.

import type {
  BuilderModelScore,
  ModelScore,
  ReviewerModelScore,
} from "./model-score.ts";

export interface FormatOptions {
  // When false (default), suppress the empty-section header for a role
  // with no rows. When true, include "BUILDERS\n  (none)" placeholders.
  includeEmptyRoles?: boolean;
}

export function formatScorecardTable(
  scores: ModelScore[],
  opts: FormatOptions = {},
): string {
  const builders = scores.filter(
    (s): s is BuilderModelScore => s.role === "builder",
  );
  const reviewers = scores.filter(
    (s): s is ReviewerModelScore => s.role === "reviewer",
  );

  const sections: string[] = [];
  if (builders.length > 0 || opts.includeEmptyRoles) {
    sections.push(formatBuildersSection(builders));
  }
  if (reviewers.length > 0 || opts.includeEmptyRoles) {
    sections.push(formatReviewersSection(reviewers));
  }
  return sections.join("\n\n");
}

function formatBuildersSection(rows: BuilderModelScore[]): string {
  const headers = [
    "modelKey",
    "taskClass",
    "cands",
    "collRate",
    "selRate",
    "won/part",
    "rubric",
    "highBugs",
    // Patch FF: retry-yield columns. "rescues/used" composite cells
    // (e.g. "1/2") or "—" when the retry path was never tripped — same
    // grammar as won/part. Lets an operator spot at-a-glance whether
    // the retry budget is paying off per (model, class).
    "apRescue",
    "vfRescue",
  ];
  const data: string[][] = rows.map((r) => [
    r.modelKey,
    r.taskClass,
    String(r.candidates),
    fmtRate(r.collectedRate),
    fmtRate(r.selectionRate),
    `${r.orchestrationsWon}/${r.orchestrationsParticipated}`,
    fmtNullable(r.meanRubricScore),
    String(r.highBugFindingsAgainst),
    fmtRescue(r.applyRetryRescues, r.applyRetriesUsed),
    fmtRescue(r.verifyRetryRescues, r.verifyRetriesUsed),
  ]);
  if (data.length === 0) {
    return "BUILDERS\n  (none)";
  }
  return "BUILDERS\n" + renderTable(headers, data);
}

function formatReviewersSection(rows: ReviewerModelScore[]): string {
  const headers = [
    "modelKey",
    "taskClass",
    "runs",
    "validRate",
    "findings",
    "highImpact",
  ];
  const data: string[][] = rows.map((r) => [
    r.modelKey,
    r.taskClass,
    String(r.runs),
    fmtRate(r.validityRate),
    String(r.findings),
    String(r.highImpactFindings),
  ]);
  if (data.length === 0) {
    return "REVIEWERS\n  (none)";
  }
  return "REVIEWERS\n" + renderTable(headers, data);
}

function renderTable(headers: string[], data: string[][]): string {
  const widths = headers.map((h, col) =>
    Math.max(h.length, ...data.map((row) => (row[col] ?? "").length)),
  );
  const sep = widths.map((w) => "-".repeat(w)).join("  ");
  const headerLine = headers.map((h, col) => h.padEnd(widths[col]!)).join("  ");
  const dataLines = data.map((row) =>
    row.map((cell, col) => cell.padEnd(widths[col]!)).join("  "),
  );
  return [headerLine, sep, ...dataLines].map((l) => "  " + l).join("\n");
}

function fmtRate(n: number): string {
  return n.toFixed(2);
}

function fmtNullable(n: number | null): string {
  return n === null ? "—" : n.toFixed(2);
}

// Patch FF: format a rescue cell as "rescues/used" (e.g. "1/2"), or
// "—" when the retry path was never tripped. The em-dash matches
// fmtNullable's "no signal" convention so the table reads consistently
// — a 0 here would be ambiguous (zero rescues out of zero attempts vs.
// zero rescues out of N attempts).
function fmtRescue(rescues: number, used: number): string {
  if (used === 0) return "—";
  return `${rescues}/${used}`;
}
