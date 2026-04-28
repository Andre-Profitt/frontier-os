// Quality ledger writer tests. Build synthetic OrchestrationPacket +
// sub-packets and exercise:
//   - buildEvents shape (worker_run per candidate, review_finding per
//     finding, one arbiter_decision, model_event aggregates)
//   - schema validation (invalid event throws QualityLedgerError)
//   - dryRun (no fs writes)
//   - ingest → reader roundtrip
//   - arbiterOutcome mapping (selected | not_selected | excluded)

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import {
  buildEvents,
  ingestOrchestration,
  type IngestInput,
} from "../writer.ts";
import { readLedger } from "../reader.ts";
import { QualityLedgerError } from "../types.ts";
import type { ArbiterDecision } from "../../arbiter/types.ts";
import type { BuilderSwarmPacket } from "../../swarm/builder-swarm.ts";
import type { ReviewPacket } from "../../swarm/review-swarm.ts";
import type { OrchestrationPacket } from "../../orchestrate/types.ts";

// --- fixture builders -----------------------------------------------------

function makePacket(): OrchestrationPacket {
  return {
    packetId: "orch-test-1",
    taskId: "task-1",
    scannedAt: "2026-04-26T22:00:00.000Z",
    input: {
      taskDescription: "x",
      builderCount: 2,
      reviewerCount: 2,
      rubricPath: "/x.json",
    },
    builderPacketPath: "/tmp/builder.json",
    reviewPacketPaths: [
      { builderId: "b1", path: "/tmp/r-b1.json" },
      { builderId: "b2", path: "/tmp/r-b2.json" },
    ],
    arbiterDecisionPath: "/tmp/arb.json",
    finalReportPath: "/tmp/final.md",
    artifactsDir: "/tmp/arts",
    summary: {
      buildersSpawned: 2,
      buildersCollected: 2,
      reviewSwarmsRun: 2,
      arbiterDecision: "accept",
      selectedBuilderId: "b1",
      modelsUsed: ["nim:k1", "nim:k2"],
    },
    exitCode: 0,
    elapsedMs: 100,
  };
}

function makeBuilderPacket(opts: {
  candidates: Array<{
    builderId: string;
    modelKey?: string;
    phase: string;
    ok?: boolean;
    withPatch?: boolean;
    applyAttempts?: number;
    readFiles?: string[];
  }>;
  taskClass?: string;
}): BuilderSwarmPacket {
  return {
    packetId: "build-test-1",
    scannedAt: "2026-04-26T22:00:00.000Z",
    taskId: "task-1",
    taskClass: opts.taskClass ?? "patch_builder",
    builderCount: opts.candidates.length,
    modelsUsed: [
      ...new Set(
        opts.candidates
          .map((c) => c.modelKey)
          .filter((m): m is string => typeof m === "string"),
      ),
    ].sort(),
    candidates: opts.candidates.map((c) => ({
      builderId: c.builderId,
      ...(c.modelKey ? { modelKey: c.modelKey } : {}),
      ok: c.ok ?? c.phase === "collected",
      phase: c.phase as "collected" | "no_diff_extracted" | "apply_failed",
      ...(c.withPatch
        ? {
            patch: {
              diff: `diff --git a/${c.builderId}.ts b/${c.builderId}.ts\n@@ +1 @@\n+x\n`,
              files: [`${c.builderId}.ts`],
              sizeBytes: 60,
              addedLines: 1,
              deletedLines: 0,
              commitCount: 1,
            },
          }
        : {}),
      ...(c.applyAttempts !== undefined
        ? { applyAttempts: c.applyAttempts }
        : {}),
      ...(c.readFiles !== undefined ? { readFiles: c.readFiles } : {}),
    })),
    elapsedMs: 100,
  };
}

function makeReviewPacket(opts: {
  reviewerCount: number;
  findings?: Array<{ category: string; severity: string }>;
  modelKey?: string;
}): ReviewPacket {
  const findings = opts.findings ?? [];
  const findingsBySeverity = { high: 0, medium: 0, low: 0 };
  const findingsByCategory: Record<string, number> = {};
  for (const f of findings) {
    findingsBySeverity[f.severity as "high" | "medium" | "low"] += 1;
    findingsByCategory[f.category] = (findingsByCategory[f.category] ?? 0) + 1;
  }
  return {
    packetId: "rev-test-1",
    scannedAt: "2026-04-26T22:00:00.000Z",
    taskClass: "adversarial_review",
    diffSource: { kind: "inline" },
    reviewerCount: opts.reviewerCount,
    validReviewerCount: 1,
    invalidReviewerCount: 0,
    failedReviewerCount: 0,
    reviewCoverage: 1,
    modelsUsed: opts.modelKey ? [opts.modelKey] : [],
    reviewers: [
      {
        reviewerId: "r1",
        ...(opts.modelKey ? { modelKey: opts.modelKey } : {}),
        ok: true,
        elapsedMs: 1,
        output: {
          reviewerId: "r1",
          findings: findings.map((f) => ({
            category: f.category as "bug",
            severity: f.severity as "high",
            claim: "x",
          })),
          summary: "x",
        },
      },
    ],
    totalFindings: findings.length,
    findingsBySeverity,
    findingsByCategory,
    elapsedMs: 1,
  };
}

function makeArbiterDecision(opts: {
  decision: "accept" | "reject" | "escalate_to_human";
  selectedBuilderId?: string;
  candidatesEvaluated: number;
  rerunPhases?: Record<
    string,
    "passed" | "typecheck_failed" | "passed_typecheck_only"
  >;
  rubricByBuilder?: Record<string, { score: number; coverage: number }>;
}): ArbiterDecision {
  return {
    decisionId: "arb-test-1",
    scannedAt: "2026-04-26T22:00:00.000Z",
    taskId: "task-1",
    decision: opts.decision,
    ...(opts.selectedBuilderId !== undefined
      ? { selectedBuilderId: opts.selectedBuilderId }
      : {}),
    candidatesEvaluated: opts.candidatesEvaluated,
    rerunVerification: {
      builderIds: Object.keys(opts.rerunPhases ?? {}),
      results: Object.entries(opts.rerunPhases ?? {}).map(([id, phase]) => ({
        builderId: id,
        worktreePath: `/tmp/${id}`,
        phase,
        typecheckExitCode: phase === "passed" ? 0 : 1,
        ranAt: "2026-04-26T22:00:00.000Z",
      })),
    },
    rubricScores: Object.entries(opts.rubricByBuilder ?? {}).map(
      ([builderId, { score, coverage }]) => ({
        builderId,
        rubricId: "test",
        score,
        scoredWeight: 1,
        totalWeight: 1,
        coverage,
        unsupportedCriteria: [],
        criteria: [],
      }),
    ),
    antiExampleMatches: [],
    evidence: "test evidence",
  };
}

function withTempLedger<T>(fn: (ledgerDir: string) => T): T {
  const dir = mkdtempSync(join(tmpdir(), "qledger-test-"));
  try {
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// --- buildEvents shape ---------------------------------------------------

test("buildEvents: one worker_run per builder candidate (any phase)", () => {
  const events = buildEvents({
    packet: makePacket(),
    builderPacket: makeBuilderPacket({
      candidates: [
        {
          builderId: "b1",
          modelKey: "nim:k1",
          phase: "collected",
          withPatch: true,
        },
        { builderId: "b2", modelKey: "nim:k2", phase: "apply_failed" },
        { builderId: "b3", phase: "no_diff_extracted" },
      ],
    }),
    reviewPackets: [],
    arbiterDecision: makeArbiterDecision({
      decision: "reject",
      candidatesEvaluated: 1,
    }),
  });
  const wr = events.filter((e) => e.kind === "worker_run");
  assert.equal(wr.length, 3);
  assert.deepEqual(wr.map((e) => ("phase" in e ? e.phase : "")).sort(), [
    "apply_failed",
    "collected",
    "no_diff_extracted",
  ]);
});

test("buildEvents: one review_finding per finding (denormalized across reviewers)", () => {
  const builderPacket = makeBuilderPacket({
    candidates: [
      {
        builderId: "b1",
        modelKey: "nim:k1",
        phase: "collected",
        withPatch: true,
      },
    ],
  });
  const reviewPacket = makeReviewPacket({
    reviewerCount: 1,
    findings: [
      { category: "bug", severity: "high" },
      { category: "style", severity: "low" },
    ],
    modelKey: "nim:reviewer",
  });
  const events = buildEvents({
    packet: makePacket(),
    builderPacket,
    reviewPackets: [{ builderId: "b1", packet: reviewPacket }],
    arbiterDecision: makeArbiterDecision({
      decision: "accept",
      selectedBuilderId: "b1",
      candidatesEvaluated: 1,
    }),
  });
  const rf = events.filter((e) => e.kind === "review_finding");
  assert.equal(rf.length, 2);
  assert.equal(
    rf.every((e) => "reviewedBuilderId" in e && e.reviewedBuilderId === "b1"),
    true,
  );
});

test("buildEvents: arbiterOutcome — selected | not_selected | excluded", () => {
  const events = buildEvents({
    packet: makePacket(),
    builderPacket: makeBuilderPacket({
      candidates: [
        {
          builderId: "b1",
          modelKey: "nim:k1",
          phase: "collected",
          withPatch: true,
        },
        {
          builderId: "b2",
          modelKey: "nim:k2",
          phase: "collected",
          withPatch: true,
        },
        { builderId: "b3", phase: "no_diff_extracted" },
      ],
    }),
    reviewPackets: [],
    arbiterDecision: makeArbiterDecision({
      decision: "accept",
      selectedBuilderId: "b1",
      candidatesEvaluated: 2,
    }),
  });
  const wr = events.filter((e) => e.kind === "worker_run");
  const outcomeMap = new Map(
    wr.map((e) => [
      "workerId" in e ? e.workerId : "?",
      "arbiterOutcome" in e ? e.arbiterOutcome : "?",
    ]),
  );
  assert.equal(outcomeMap.get("b1"), "selected");
  assert.equal(outcomeMap.get("b2"), "not_selected");
  assert.equal(outcomeMap.get("b3"), "excluded");
});

test("buildEvents: model_event aggregates per (modelKey, role, taskClass)", () => {
  const events = buildEvents({
    packet: makePacket(),
    builderPacket: makeBuilderPacket({
      candidates: [
        {
          builderId: "b1",
          modelKey: "nim:k1",
          phase: "collected",
          withPatch: true,
        },
        {
          builderId: "b2",
          modelKey: "nim:k1",
          phase: "collected",
          withPatch: true,
        },
        { builderId: "b3", modelKey: "nim:k2", phase: "no_diff_extracted" },
      ],
    }),
    reviewPackets: [
      {
        builderId: "b1",
        packet: makeReviewPacket({
          reviewerCount: 2,
          findings: [{ category: "bug", severity: "high" }],
          modelKey: "nim:reviewer-a",
        }),
      },
    ],
    arbiterDecision: makeArbiterDecision({
      decision: "accept",
      selectedBuilderId: "b1",
      candidatesEvaluated: 2,
    }),
  });
  const me = events.filter((e) => e.kind === "model_event");
  // 2 builder model_events (nim:k1, nim:k2) + 1 reviewer model_event (nim:reviewer-a)
  assert.equal(me.length, 3);
  const k1 = me.find((e) => "modelKey" in e && e.modelKey === "nim:k1");
  assert.ok(k1);
  if (k1 && "callsTotal" in k1) {
    assert.equal(k1.callsTotal, 2);
    assert.equal(k1.arbiterSelectedCount, 1);
  }
  const reviewer = me.find(
    (e) => "modelKey" in e && e.modelKey === "nim:reviewer-a",
  );
  assert.ok(reviewer);
  if (reviewer && "role" in reviewer) {
    assert.equal(reviewer.role, "reviewer");
  }
});

test("buildEvents: one arbiter_decision per orchestration", () => {
  const events = buildEvents({
    packet: makePacket(),
    builderPacket: makeBuilderPacket({
      candidates: [
        {
          builderId: "b1",
          modelKey: "nim:k1",
          phase: "collected",
          withPatch: true,
        },
      ],
    }),
    reviewPackets: [],
    arbiterDecision: makeArbiterDecision({
      decision: "accept",
      selectedBuilderId: "b1",
      candidatesEvaluated: 1,
      rerunPhases: { b1: "passed" },
    }),
  });
  const ad = events.filter((e) => e.kind === "arbiter_decision");
  assert.equal(ad.length, 1);
  if (ad[0] && "selectedCandidateVerified" in ad[0]) {
    // Selected candidate (b1) reached phase=passed → both signals true.
    assert.equal(ad[0].anyCandidateVerified, true);
    assert.equal(ad[0].selectedCandidateVerified, true);
  }
});

test("buildEvents: both verification flags false when no candidate verified pass", () => {
  const events = buildEvents({
    packet: makePacket(),
    builderPacket: makeBuilderPacket({
      candidates: [
        {
          builderId: "b1",
          modelKey: "nim:k1",
          phase: "collected",
          withPatch: true,
        },
      ],
    }),
    reviewPackets: [],
    arbiterDecision: makeArbiterDecision({
      decision: "reject",
      candidatesEvaluated: 1,
      rerunPhases: { b1: "typecheck_failed" },
    }),
  });
  const ad = events.find((e) => e.kind === "arbiter_decision");
  if (ad && "selectedCandidateVerified" in ad) {
    assert.equal(ad.anyCandidateVerified, false);
    assert.equal(ad.selectedCandidateVerified, false);
  }
});

// GPT Pro Patch I — fix #4 regression: any-candidate passed but the
// SELECTED candidate did not. Old `rerunVerificationOk = .some(passed)`
// would have returned true here, overstating the arbiter decision.
test("buildEvents: anyCandidateVerified=true but selectedCandidateVerified=false when picked candidate failed verifier", () => {
  const events = buildEvents({
    packet: makePacket(),
    builderPacket: makeBuilderPacket({
      candidates: [
        {
          builderId: "b1",
          modelKey: "nim:k1",
          phase: "collected",
          withPatch: true,
        },
        {
          builderId: "b2",
          modelKey: "nim:k2",
          phase: "collected",
          withPatch: true,
        },
      ],
    }),
    reviewPackets: [],
    arbiterDecision: makeArbiterDecision({
      decision: "accept",
      selectedBuilderId: "b1",
      candidatesEvaluated: 2,
      // b1 is selected but FAILED verifier; b2 passed but wasn't picked.
      rerunPhases: { b1: "typecheck_failed", b2: "passed" },
    }),
  });
  const ad = events.find((e) => e.kind === "arbiter_decision");
  if (ad && "selectedCandidateVerified" in ad) {
    assert.equal(ad.anyCandidateVerified, true);
    assert.equal(ad.selectedCandidateVerified, false);
  }
});

// Escalate / reject paths: no candidate selected → selectedCandidateVerified
// must be false even if some candidate passed verifier.
test("buildEvents: selectedCandidateVerified=false when no candidate selected", () => {
  const events = buildEvents({
    packet: makePacket(),
    builderPacket: makeBuilderPacket({
      candidates: [
        {
          builderId: "b1",
          modelKey: "nim:k1",
          phase: "collected",
          withPatch: true,
        },
      ],
    }),
    reviewPackets: [],
    arbiterDecision: makeArbiterDecision({
      decision: "escalate_to_human",
      candidatesEvaluated: 1,
      rerunPhases: { b1: "passed" }, // candidate passed but arbiter escalated
    }),
  });
  const ad = events.find((e) => e.kind === "arbiter_decision");
  if (ad && "selectedCandidateVerified" in ad) {
    assert.equal(ad.anyCandidateVerified, true);
    assert.equal(ad.selectedCandidateVerified, false);
  }
});

// --- buildEvents: applyAttempts (Patch Z) -------------------------------

test("buildEvents: applyAttempts surfaces from candidate to worker_run row", () => {
  const events = buildEvents({
    packet: makePacket(),
    builderPacket: makeBuilderPacket({
      candidates: [
        {
          builderId: "b1",
          modelKey: "nim:k1",
          phase: "collected",
          withPatch: true,
          applyAttempts: 2, // succeeded after one Patch Y retry
        },
        {
          builderId: "b2",
          modelKey: "nim:k2",
          phase: "collected",
          withPatch: true,
          applyAttempts: 1, // first-shot success
        },
        {
          builderId: "b3",
          modelKey: "nim:k3",
          phase: "apply_failed",
          applyAttempts: 2, // retried, still failed
        },
      ],
    }),
    reviewPackets: [],
    arbiterDecision: makeArbiterDecision({
      decision: "accept",
      selectedBuilderId: "b1",
      candidatesEvaluated: 2,
    }),
  });
  const wrByBuilder = new Map(
    events
      .filter((e) => e.kind === "worker_run")
      .map((e) => [
        "workerId" in e ? e.workerId : "",
        "applyAttempts" in e ? e.applyAttempts : undefined,
      ]),
  );
  assert.equal(wrByBuilder.get("b1"), 2);
  assert.equal(wrByBuilder.get("b2"), 1);
  assert.equal(wrByBuilder.get("b3"), 2);
});

test("buildEvents: applyAttempts omitted when candidate took unified-diff path (no field set)", () => {
  // Pre-Patch-Y candidates and unified-diff-path candidates (Patch Y
  // explicitly does NOT set applyAttempts on the unified-diff branch)
  // must not get a phantom integer in the ledger row — undefined stays
  // undefined so downstream stats can distinguish "S/R retry never
  // ran" from "S/R first-shot success".
  const events = buildEvents({
    packet: makePacket(),
    builderPacket: makeBuilderPacket({
      candidates: [
        {
          builderId: "b1",
          modelKey: "nim:k1",
          phase: "collected",
          withPatch: true,
          // applyAttempts omitted on purpose
        },
      ],
    }),
    reviewPackets: [],
    arbiterDecision: makeArbiterDecision({
      decision: "accept",
      selectedBuilderId: "b1",
      candidatesEvaluated: 1,
    }),
  });
  const wr = events.find(
    (e) => e.kind === "worker_run" && "workerId" in e && e.workerId === "b1",
  );
  assert.ok(wr);
  assert.equal(
    "applyAttempts" in wr ? wr.applyAttempts : "field-absent",
    "field-absent",
  );
});

// --- buildEvents: readFiles (Patch AA) ----------------------------------
//
// Patch Z (50f1b7b) added the READ_FILE tool — model can request one
// file outside its touch list per attempt. The successfully-read paths
// land on candidate.readFiles. Patch AA plumbs that into the
// worker_run row so downstream queries can compute the tool's actual
// yield: P(applied | readFiles.length > 0) vs P(applied |
// readFiles.length === 0) per (model, class). Without this field the
// READ_FILE tool's value is unmeasurable.

test("buildEvents (Patch AA): readFiles surfaces from candidate to worker_run row", () => {
  const events = buildEvents({
    packet: makePacket(),
    builderPacket: makeBuilderPacket({
      candidates: [
        {
          builderId: "b1",
          modelKey: "nim:k1",
          phase: "collected",
          withPatch: true,
          readFiles: ["src/helper.ts", "src/types.ts"],
        },
        {
          builderId: "b2",
          modelKey: "nim:k2",
          phase: "collected",
          withPatch: true,
          readFiles: ["lib/util.ts"],
        },
        {
          builderId: "b3",
          modelKey: "nim:k3",
          phase: "apply_failed",
          // Even apply_failed candidates can carry readFiles — the
          // model used the tool but still botched the S/R afterward.
          // That's important signal: high readFiles + high
          // apply_failed = the tool isn't helping THIS model.
          readFiles: ["src/foo.ts"],
        },
      ],
    }),
    reviewPackets: [],
    arbiterDecision: makeArbiterDecision({
      decision: "accept",
      selectedBuilderId: "b1",
      candidatesEvaluated: 2,
    }),
  });
  const wrByBuilder = new Map(
    events
      .filter((e) => e.kind === "worker_run")
      .map((e) => [
        "workerId" in e ? e.workerId : "",
        "readFiles" in e ? e.readFiles : undefined,
      ]),
  );
  assert.deepEqual(wrByBuilder.get("b1"), ["src/helper.ts", "src/types.ts"]);
  assert.deepEqual(wrByBuilder.get("b2"), ["lib/util.ts"]);
  assert.deepEqual(wrByBuilder.get("b3"), ["src/foo.ts"]);
});

test("buildEvents (Patch AA): readFiles omitted when candidate did not use READ_FILE tool", () => {
  // Candidates that didn't invoke the READ_FILE tool (the common case
  // when the touch list is sufficient) must not get an empty array
  // in the ledger row — undefined stays undefined so downstream stats
  // can distinguish "tool not used" from "tool used but no successful
  // reads" (the latter currently surfaces as `readFiles: []` from
  // builder-swarm only when the model tried and was denied; pre-Patch-Z
  // candidates have no readFiles field at all).
  const events = buildEvents({
    packet: makePacket(),
    builderPacket: makeBuilderPacket({
      candidates: [
        {
          builderId: "b1",
          modelKey: "nim:k1",
          phase: "collected",
          withPatch: true,
          // readFiles omitted on purpose
        },
      ],
    }),
    reviewPackets: [],
    arbiterDecision: makeArbiterDecision({
      decision: "accept",
      selectedBuilderId: "b1",
      candidatesEvaluated: 1,
    }),
  });
  const wr = events.find(
    (e) => e.kind === "worker_run" && "workerId" in e && e.workerId === "b1",
  );
  assert.ok(wr);
  assert.equal(
    "readFiles" in wr ? "field-present" : "field-absent",
    "field-absent",
  );
});

// --- ingestOrchestration: dry run + write -------------------------------

test("ingestOrchestration: dryRun=true → no fs writes, events still computed", () => {
  withTempLedger((ledgerDir) => {
    const result = ingestOrchestration(buildSampleInput(), {
      ledgerDir,
      dryRun: true,
    });
    assert.equal(result.workerRuns, 1);
    // 1 builder model_event (nim:k1) + 1 reviewer model_event (nim:reviewer)
    assert.equal(result.modelEvents, 2);
    // No JSONL files were created.
    assert.equal(existsSync(resolve(ledgerDir, "worker-runs.jsonl")), false);
    assert.equal(existsSync(resolve(ledgerDir, "model-events.jsonl")), false);
    assert.equal(result.events.length > 0, true);
  });
});

test("ingestOrchestration: writes JSONL files, reader roundtrips", () => {
  withTempLedger((ledgerDir) => {
    const written = ingestOrchestration(buildSampleInput(), { ledgerDir });
    const snapshot = readLedger({ ledgerDir });
    assert.equal(snapshot.workerRuns.length, written.workerRuns);
    assert.equal(snapshot.modelEvents.length, written.modelEvents);
    assert.equal(snapshot.arbiterDecisions.length, written.arbiterDecisions);
    // Roundtrip preserves the kind discriminator and packet IDs.
    for (const wr of snapshot.workerRuns) {
      assert.equal(wr.kind, "worker_run");
      assert.equal(wr.packetId, "orch-test-1");
    }
  });
});

test("ingestOrchestration: re-ingesting same packetId throws (no double-counting)", () => {
  // Patch H deliberate decision: writer fails loud on duplicate
  // packetId rather than silently double every downstream aggregate.
  withTempLedger((ledgerDir) => {
    ingestOrchestration(buildSampleInput(), { ledgerDir });
    assert.throws(
      () => ingestOrchestration(buildSampleInput(), { ledgerDir }),
      QualityLedgerError,
    );
    // First ingest's rows survive; no partial second write.
    const snapshot = readLedger({ ledgerDir });
    assert.equal(snapshot.workerRuns.length, 1);
  });
});

test("ingestOrchestration: force=true allows re-ingest of same packetId", () => {
  // Escape hatch: operator may re-ingest after manually editing
  // upstream artifacts. Opt-in only; defaults to safe.
  // Patch R note: with reader-side dedup-by-eventId, identical inputs
  // produce identical eventIds → reader collapses to ONE row even
  // after a force re-ingest. The manifest still records both
  // ingests, proving the writer didn't throw.
  withTempLedger((ledgerDir) => {
    ingestOrchestration(buildSampleInput(), { ledgerDir });
    ingestOrchestration(buildSampleInput(), { ledgerDir, force: true });
    const manifestLines = readFileSync(
      resolve(ledgerDir, "packets-index.jsonl"),
      "utf8",
    )
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l));
    const completes = manifestLines.filter(
      (r: { status: string }) => r.status === "complete",
    );
    assert.equal(
      completes.length,
      2,
      "manifest must record both ingests as complete",
    );
    // Reader dedupes byte-identical events from the duplicate write.
    const snapshot = readLedger({ ledgerDir });
    assert.equal(snapshot.workerRuns.length, 1);
  });
});

test("ingestOrchestration: schema-invalid event throws QualityLedgerError, no partial write", () => {
  withTempLedger((ledgerDir) => {
    // Build a packet that violates the schema: missing taskClass on
    // builder packet means worker_run will lack required field.
    const badInput = buildSampleInput();
    // Tamper with the builder packet's taskClass to violate the schema:
    // the schema requires taskClass minLength 1 on worker_run rows.
    (badInput.builderPacket as { taskClass: string }).taskClass = "";
    assert.throws(
      () => ingestOrchestration(badInput, { ledgerDir }),
      QualityLedgerError,
    );
    // No files written.
    assert.equal(existsSync(resolve(ledgerDir, "worker-runs.jsonl")), false);
  });
});

// --- helpers -------------------------------------------------------------

function buildSampleInput(): IngestInput {
  return {
    packet: makePacket(),
    builderPacket: makeBuilderPacket({
      candidates: [
        {
          builderId: "b1",
          modelKey: "nim:k1",
          phase: "collected",
          withPatch: true,
        },
      ],
    }),
    reviewPackets: [
      {
        builderId: "b1",
        packet: makeReviewPacket({
          reviewerCount: 1,
          findings: [{ category: "bug", severity: "high" }],
          modelKey: "nim:reviewer",
        }),
      },
    ],
    arbiterDecision: makeArbiterDecision({
      decision: "accept",
      selectedBuilderId: "b1",
      candidatesEvaluated: 1,
      rerunPhases: { b1: "passed" },
      rubricByBuilder: { b1: { score: 0.85, coverage: 0.7 } },
    }),
  };
}

// --- contents check ------------------------------------------------------

test("ingestOrchestration: written JSONL is line-delimited valid JSON", () => {
  withTempLedger((ledgerDir) => {
    ingestOrchestration(buildSampleInput(), { ledgerDir });
    const text = readFileSync(resolve(ledgerDir, "worker-runs.jsonl"), "utf8");
    // No trailing comma, valid line-by-line JSON.
    const lines = text.trim().split("\n");
    assert.ok(lines.length >= 1);
    for (const line of lines) {
      const parsed = JSON.parse(line);
      assert.equal(parsed.kind, "worker_run");
    }
  });
});

// GPT Pro Patch I — fix #1: dedup is now via packets-index.jsonl, not
// a substring scan over worker-runs.jsonl. Pin three behaviors:
//   1. The index file appears after first ingest.
//   2. Re-ingest is detected via the index even if worker-runs.jsonl
//      is empty (e.g. a packet that produced no candidates).
//   3. A pre-existing worker-runs.jsonl with no manifest gets a
//      one-shot backfill, then dedup works against the manifest.
test("ingestOrchestration: writes packets-index.jsonl on first ingest", () => {
  withTempLedger((ledgerDir) => {
    ingestOrchestration(buildSampleInput(), { ledgerDir });
    const indexPath = resolve(ledgerDir, "packets-index.jsonl");
    assert.equal(existsSync(indexPath), true);
    const lines = readFileSync(indexPath, "utf8")
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l));
    // Patch R: two manifest rows per ingest (in_progress, complete).
    assert.equal(lines.length, 2);
    for (const row of lines) {
      assert.equal(row.packetId, "orch-test-1");
      assert.equal(row.taskId, "task-1");
      assert.equal(typeof row.ingestedAt, "string");
    }
  });
});

test("ingestOrchestration: backfills packets-index.jsonl from worker-runs.jsonl on first ingest after upgrade", () => {
  withTempLedger((ledgerDir) => {
    // Simulate a pre-Patch-I ledger directory: worker-runs.jsonl has
    // rows but no manifest exists.
    mkdirSync(ledgerDir, { recursive: true });
    writeFileSync(
      resolve(ledgerDir, "worker-runs.jsonl"),
      JSON.stringify({
        eventId: "old-1-wr-0",
        taskId: "old-task",
        packetId: "old-packet-1",
        ts: "2026-04-01T00:00:00.000Z",
        kind: "worker_run",
        workerId: "b1",
        role: "builder",
        taskClass: "patch_builder",
        phase: "collected",
        ok: true,
        arbiterOutcome: "selected",
      }) + "\n",
    );
    // Re-ingesting the OLD packetId should now throw, because the
    // backfill path picked it up from worker-runs.jsonl.
    const oldInput = buildSampleInput();
    (oldInput.packet as { packetId: string }).packetId = "old-packet-1";
    assert.throws(
      () => ingestOrchestration(oldInput, { ledgerDir }),
      QualityLedgerError,
    );
    // And the manifest now exists.
    assert.equal(existsSync(resolve(ledgerDir, "packets-index.jsonl")), true);
  });
});

// --- Patch I v2 (PR #25 re-review) — dryRun must NOT mutate disk ---------
//
// GPT Pro flagged: dryRun ingestion against a pre-Patch-I ledger
// silently created packets-index.jsonl via the backfill path. dryRun
// must compute the in-memory packet set so dedup detection still
// works, but write nothing.

function seedPrePatchILedger(ledgerDir: string): void {
  // Simulate a pre-Patch-I ledger: worker-runs.jsonl exists, no manifest.
  mkdirSync(ledgerDir, { recursive: true });
  writeFileSync(
    resolve(ledgerDir, "worker-runs.jsonl"),
    JSON.stringify({
      eventId: "old-1-wr-0",
      taskId: "old-task",
      packetId: "old-packet-1",
      ts: "2026-04-01T00:00:00.000Z",
      kind: "worker_run",
      workerId: "b1",
      role: "builder",
      taskClass: "patch_builder",
      phase: "collected",
      ok: true,
      arbiterOutcome: "selected",
    }) + "\n",
  );
}

test("ingestOrchestration dryRun=true: NEW packet on pre-Patch-I ledger does NOT create packets-index.jsonl", () => {
  withTempLedger((ledgerDir) => {
    seedPrePatchILedger(ledgerDir);
    const input = buildSampleInput();
    // packetId "orch-test-1" is NOT in the pre-Patch-I ledger.
    const result = ingestOrchestration(input, { ledgerDir, dryRun: true });
    // Returns events as if it would have written.
    assert.ok(result.events.length > 0);
    // But the manifest was NEVER created.
    assert.equal(existsSync(resolve(ledgerDir, "packets-index.jsonl")), false);
  });
});

test("ingestOrchestration dryRun=true: DUPLICATE packet on pre-Patch-I ledger throws AND does NOT create packets-index.jsonl", () => {
  withTempLedger((ledgerDir) => {
    seedPrePatchILedger(ledgerDir);
    const input = buildSampleInput();
    (input.packet as { packetId: string }).packetId = "old-packet-1";
    // Duplicate detection still works in dryRun (computed in memory).
    assert.throws(
      () => ingestOrchestration(input, { ledgerDir, dryRun: true }),
      QualityLedgerError,
    );
    // But the manifest was NEVER created — no disk mutation under dryRun.
    assert.equal(existsSync(resolve(ledgerDir, "packets-index.jsonl")), false);
  });
});

test("ingestOrchestration dryRun=false: NEW packet on pre-Patch-I ledger DOES backfill packets-index.jsonl", () => {
  withTempLedger((ledgerDir) => {
    seedPrePatchILedger(ledgerDir);
    const input = buildSampleInput();
    ingestOrchestration(input, { ledgerDir });
    // Backfill ran (manifest now exists, contains both old + new packets).
    // Patch R: backfilled row carries status="complete"; new ingest
    // adds in_progress + complete rows.
    const indexPath = resolve(ledgerDir, "packets-index.jsonl");
    assert.equal(existsSync(indexPath), true);
    const lines = readFileSync(indexPath, "utf8")
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l));
    const ids = Array.from(
      new Set(lines.map((r: { packetId: string }) => r.packetId)),
    ).sort();
    assert.deepEqual(ids, ["old-packet-1", "orch-test-1"]);
    // New packet's ingest produced both in_progress and complete rows.
    const newPacketRows = lines.filter(
      (r: { packetId: string }) => r.packetId === "orch-test-1",
    );
    const statuses = newPacketRows
      .map((r: { status?: string }) => r.status)
      .sort();
    assert.deepEqual(statuses, ["complete", "in_progress"]);
  });
});

test("ingestOrchestration dryRun=true: ZERO disk mutation — no manifest, no event files, no mkdir on a fresh dir", async () => {
  // Strongest version of the dryRun contract: starting from a directory
  // that doesn't even exist, dryRun must not create the directory or
  // any file. (Pre-Patch-I ledger seeded above already creates the
  // directory; here we test the cold-start path.)
  const { mkdtempSync, rmSync, readdirSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const parent = mkdtempSync(join(tmpdir(), "dryrun-zero-"));
  const ledgerDir = resolve(parent, "ledger-that-does-not-exist-yet");
  try {
    const input = buildSampleInput();
    const result = ingestOrchestration(input, { ledgerDir, dryRun: true });
    assert.ok(result.events.length > 0);
    // ledgerDir must not have been created.
    assert.equal(existsSync(ledgerDir), false);
    // Parent dir is unchanged (just the ledgerDir entry was never made).
    const entries = readdirSync(parent);
    assert.deepEqual(entries, []);
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});

// --- Patch R blocker #4: ingest transaction integrity --------------------
//
// GPT Pro flagged: the manifest is written LAST, so a process crash
// between event-row writes and the manifest row leaves event JSONL
// content on disk for a packet that has no manifest entry. Re-ingest
// passes the dedup check (no manifest row), appends events again →
// downstream aggregates double-count the partial-crash events.
//
// Fix: write an "in_progress" manifest row BEFORE event writes, and a
// "complete" row AFTER. Dedup treats only "complete" packetIds as
// already-ingested, so a crashed-mid-ingest packet is retryable.
// Reader dedupes by eventId so the duplicated event rows from the
// retry don't double-count in scorecards. Legacy manifest rows
// without `status` are treated as "complete" (backwards compat).

test("ingestOrchestration: writes in_progress row BEFORE events, complete row AFTER (Patch R)", () => {
  withTempLedger((ledgerDir) => {
    ingestOrchestration(buildSampleInput(), { ledgerDir });
    const indexPath = resolve(ledgerDir, "packets-index.jsonl");
    const lines = readFileSync(indexPath, "utf8")
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l));
    // Two rows per ingest: in_progress, complete (in that order).
    assert.equal(lines.length, 2);
    assert.equal(lines[0].packetId, "orch-test-1");
    assert.equal(lines[0].status, "in_progress");
    assert.equal(lines[1].packetId, "orch-test-1");
    assert.equal(lines[1].status, "complete");
  });
});

test("ingestOrchestration: only-in_progress manifest row (crash-replay) is retryable, NOT a dedup hit (Patch R)", () => {
  withTempLedger((ledgerDir) => {
    // Simulate a process crash mid-ingest: in_progress row written,
    // some event rows written, then crash (no complete row).
    mkdirSync(ledgerDir, { recursive: true });
    writeFileSync(
      resolve(ledgerDir, "packets-index.jsonl"),
      JSON.stringify({
        packetId: "orch-test-1",
        taskId: "task-1",
        ts: "2026-04-26T22:00:00.000Z",
        ingestedAt: "2026-04-26T22:00:01.000Z",
        status: "in_progress",
      }) + "\n",
    );
    // Partial event row from the crashed run.
    writeFileSync(
      resolve(ledgerDir, "worker-runs.jsonl"),
      JSON.stringify({
        eventId: "orch-test-1-wr-0",
        taskId: "task-1",
        packetId: "orch-test-1",
        ts: "2026-04-26T22:00:00.000Z",
        kind: "worker_run",
        workerId: "b1",
        role: "builder",
        modelKey: "nim:k1",
        taskClass: "patch_builder",
        phase: "collected",
        ok: true,
        arbiterOutcome: "selected",
      }) + "\n",
    );

    // Re-ingest the same packet — must NOT throw on dedup, because
    // the previous attempt never completed.
    assert.doesNotThrow(() =>
      ingestOrchestration(buildSampleInput(), { ledgerDir }),
    );

    // After the retry, the manifest has the crash's in_progress row
    // PLUS a fresh in_progress + complete pair.
    const lines = readFileSync(
      resolve(ledgerDir, "packets-index.jsonl"),
      "utf8",
    )
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l));
    const completeForPacket = lines.filter(
      (r: { packetId: string; status: string }) =>
        r.packetId === "orch-test-1" && r.status === "complete",
    );
    assert.equal(completeForPacket.length, 1);
  });
});

test("ingestOrchestration: completed packet still throws on re-ingest (regression check, Patch R)", () => {
  // Pre-Patch-R: ANY manifest row blocked re-ingest. Post-fix: only
  // a "complete" row blocks. This test pins the post-fix dedup against
  // a fully-ingested packet.
  withTempLedger((ledgerDir) => {
    ingestOrchestration(buildSampleInput(), { ledgerDir });
    assert.throws(
      () => ingestOrchestration(buildSampleInput(), { ledgerDir }),
      QualityLedgerError,
    );
  });
});

test("ingestOrchestration: legacy manifest row without `status` field counts as complete (backwards compat, Patch R)", () => {
  withTempLedger((ledgerDir) => {
    // Pre-Patch-R manifest row — no `status` field. Reader must treat
    // these as fully ingested so existing ledger directories don't
    // suddenly accept duplicate ingests.
    mkdirSync(ledgerDir, { recursive: true });
    writeFileSync(
      resolve(ledgerDir, "packets-index.jsonl"),
      JSON.stringify({
        packetId: "orch-test-1",
        taskId: "task-1",
        ts: "2026-04-26T22:00:00.000Z",
        ingestedAt: "2026-04-26T22:00:01.000Z",
      }) + "\n",
    );
    assert.throws(
      () => ingestOrchestration(buildSampleInput(), { ledgerDir }),
      QualityLedgerError,
    );
  });
});

// --- Patch S non-blocker: malformed manifest fail-loud (writer.ts) -------

test("ingestOrchestration: malformed packets-index.jsonl line throws QualityLedgerError (Patch S)", () => {
  // GPT Pro non-blocker: pre-Patch-S, the manifest reader silently
  // skipped malformed JSON lines. That hid duplicate-ingest protection
  // failures (an operator hand-edit could brick dedup without warning).
  // Now: explicit throw with file/line context.
  withTempLedger((ledgerDir) => {
    mkdirSync(ledgerDir, { recursive: true });
    writeFileSync(
      resolve(ledgerDir, "packets-index.jsonl"),
      // Valid first line, invalid JSON second line.
      JSON.stringify({
        packetId: "p1",
        taskId: "t1",
        ts: "2026-04-01T00:00:00.000Z",
        ingestedAt: "2026-04-01T00:00:01.000Z",
        status: "complete",
      }) + "\n{this is not json}\n",
    );
    assert.throws(
      () => ingestOrchestration(buildSampleInput(), { ledgerDir }),
      (err: Error) =>
        err instanceof QualityLedgerError &&
        /packets-index\.jsonl/.test(err.message) &&
        /line 2/.test(err.message),
    );
  });
});

test("ingestOrchestration: manifest row missing packetId throws QualityLedgerError (Patch S)", () => {
  withTempLedger((ledgerDir) => {
    mkdirSync(ledgerDir, { recursive: true });
    writeFileSync(
      resolve(ledgerDir, "packets-index.jsonl"),
      // Valid JSON but missing required packetId.
      JSON.stringify({
        taskId: "t1",
        ts: "2026-04-01T00:00:00.000Z",
        ingestedAt: "2026-04-01T00:00:01.000Z",
        status: "complete",
      }) + "\n",
    );
    assert.throws(
      () => ingestOrchestration(buildSampleInput(), { ledgerDir }),
      (err: Error) =>
        err instanceof QualityLedgerError &&
        /missing packetId/.test(err.message),
    );
  });
});

test("readLedger: dedupes event rows by eventId across crash-replay duplicates (Patch R)", async () => {
  // After a crash + retry, the same eventId may appear twice in the
  // worker-runs.jsonl (once from the crashed attempt, once from the
  // successful retry). The reader must collapse these so model_event
  // aggregates don't double-count partial-crash rows.
  withTempLedger((ledgerDir) => {
    mkdirSync(ledgerDir, { recursive: true });
    const row = {
      eventId: "orch-1-wr-0",
      taskId: "task-1",
      packetId: "orch-1",
      ts: "2026-04-26T22:00:00.000Z",
      kind: "worker_run",
      workerId: "b1",
      role: "builder",
      modelKey: "nim:k1",
      taskClass: "patch_builder",
      phase: "collected",
      ok: true,
      arbiterOutcome: "selected",
    };
    // Same row appended twice — simulates partial-crash + complete-retry.
    writeFileSync(
      resolve(ledgerDir, "worker-runs.jsonl"),
      JSON.stringify(row) + "\n" + JSON.stringify(row) + "\n",
    );
    const snapshot = readLedger({ ledgerDir });
    assert.equal(
      snapshot.workerRuns.length,
      1,
      "duplicate eventIds must be collapsed on read",
    );
  });
});

// GPT Pro Patch I — fix #2: ingestArtifactsDir used to silently skip a
// declared review-packet path that wasn't on disk. Now it throws so the
// ledger can't end up with fewer reviewer rows than the orchestration
// promised (which would otherwise inflate reviewer validityRate).
test("ingestArtifactsDir: throws when a declared review packet path is missing", async () => {
  const { ingestArtifactsDir } = await import("../writer.ts");
  const { mkdtempSync, writeFileSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const dir = mkdtempSync(join(tmpdir(), "ingest-missing-"));
  try {
    const builderPath = resolve(dir, "builder-packet.json");
    const arbPath = resolve(dir, "arbiter-decision.json");
    writeFileSync(
      resolve(dir, "orchestration-packet.json"),
      JSON.stringify({
        packetId: "orch-missing-rev",
        taskId: "t1",
        scannedAt: "2026-04-27T00:00:00.000Z",
        input: { taskDescription: "x", builderCount: 1, reviewerCount: 2 },
        builderPacketPath: builderPath,
        // Reference 2 review-packet paths; only one will exist on disk.
        reviewPacketPaths: [
          { builderId: "b1", path: resolve(dir, "review-packet-b1.json") },
          { builderId: "b2", path: resolve(dir, "review-packet-b2.json") },
        ],
        arbiterDecisionPath: arbPath,
        finalReportPath: resolve(dir, "final.md"),
        artifactsDir: dir,
        exitCode: 0,
        elapsedMs: 1,
      }),
    );
    writeFileSync(
      builderPath,
      JSON.stringify({
        packetId: "build-1",
        scannedAt: "2026-04-27T00:00:00.000Z",
        taskId: "t1",
        taskClass: "patch_builder",
        builderCount: 1,
        modelsUsed: [],
        candidates: [],
        elapsedMs: 1,
      }),
    );
    // Only b1's review packet exists; b2's is missing on disk.
    writeFileSync(
      resolve(dir, "review-packet-b1.json"),
      JSON.stringify({
        packetId: "rev-b1",
        scannedAt: "2026-04-27T00:00:00.000Z",
        taskClass: "adversarial_review",
        diffSource: { kind: "inline" },
        reviewerCount: 1,
        validReviewerCount: 1,
        invalidReviewerCount: 0,
        failedReviewerCount: 0,
        reviewCoverage: 1,
        modelsUsed: [],
        reviewers: [],
        totalFindings: 0,
        findingsBySeverity: { high: 0, medium: 0, low: 0 },
        findingsByCategory: {},
        elapsedMs: 1,
      }),
    );
    writeFileSync(
      arbPath,
      JSON.stringify({
        decisionId: "arb-1",
        scannedAt: "2026-04-27T00:00:00.000Z",
        taskId: "t1",
        decision: "escalate_to_human",
        candidatesEvaluated: 0,
        rerunVerification: { builderIds: [], results: [] },
        rubricScores: [],
        antiExampleMatches: [],
        evidence: "x",
      }),
    );
    withTempLedger((ledgerDir) => {
      assert.throws(
        () => ingestArtifactsDir(dir, { ledgerDir }),
        (e: unknown) => {
          if (!(e instanceof QualityLedgerError)) return false;
          assert.match(e.message, /missing on disk/);
          assert.match(e.message, /b2/);
          return true;
        },
      );
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
