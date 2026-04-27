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
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
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
  assert.equal(
    "rerunVerificationOk" in ad[0]! && ad[0]!.rerunVerificationOk,
    true,
  );
});

test("buildEvents: rerunVerificationOk false when no candidate verified pass", () => {
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
  if (ad && "rerunVerificationOk" in ad) {
    assert.equal(ad.rerunVerificationOk, false);
  }
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

test("ingestOrchestration: appending the same packet twice doubles row counts", () => {
  // The writer is append-only; dedup is the reader's responsibility.
  // This test pins that contract so a future "no-op on duplicate
  // ingest" behavior is a deliberate decision, not an accident.
  withTempLedger((ledgerDir) => {
    ingestOrchestration(buildSampleInput(), { ledgerDir });
    ingestOrchestration(buildSampleInput(), { ledgerDir });
    const snapshot = readLedger({ ledgerDir });
    assert.equal(snapshot.workerRuns.length, 2); // 1 candidate × 2 ingests
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
