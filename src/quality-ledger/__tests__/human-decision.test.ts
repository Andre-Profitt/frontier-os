// Q2 markHumanDecision tests.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { markHumanDecision } from "../writer.ts";
import { readLedger } from "../reader.ts";
import { QualityLedgerError } from "../types.ts";

function withTempDirs<T>(
  fn: (ledgerDir: string, artifactsDir: string) => T,
): T {
  const ledgerDir = mkdtempSync(join(tmpdir(), "qmark-ledger-"));
  const artifactsDir = mkdtempSync(join(tmpdir(), "qmark-artifacts-"));
  try {
    return fn(ledgerDir, artifactsDir);
  } finally {
    rmSync(ledgerDir, { recursive: true, force: true });
    rmSync(artifactsDir, { recursive: true, force: true });
  }
}

function writeArbiterDecision(
  artifactsDir: string,
  selectedBuilderId: string | undefined,
): void {
  writeFileSync(
    resolve(artifactsDir, "arbiter-decision.json"),
    JSON.stringify({
      decisionId: "arb-x",
      scannedAt: "2026-04-26T22:00:00.000Z",
      taskId: "t1",
      decision: selectedBuilderId ? "accept" : "escalate_to_human",
      ...(selectedBuilderId ? { selectedBuilderId } : {}),
      candidatesEvaluated: 1,
      rerunVerification: { builderIds: [], results: [] },
      rubricScores: [],
      antiExampleMatches: [],
      evidence: "x",
    }),
  );
}

function writeOrchestrationPacket(
  artifactsDir: string,
  packetId: string,
): void {
  writeFileSync(
    resolve(artifactsDir, "orchestration-packet.json"),
    JSON.stringify({
      packetId,
      taskId: "t1",
      scannedAt: "2026-04-26T22:00:00.000Z",
      input: { taskDescription: "x", builderCount: 1, reviewerCount: 1 },
      builderPacketPath: "/tmp/b.json",
      reviewPacketPaths: [],
      arbiterDecisionPath: resolve(artifactsDir, "arbiter-decision.json"),
      finalReportPath: "/tmp/f.md",
      artifactsDir,
      exitCode: 0,
      elapsedMs: 1,
    }),
  );
}

// --- input validation ----------------------------------------------------

test("markHumanDecision: decision=accepted requires acceptedBuilderId", () => {
  withTempDirs((ledgerDir) => {
    assert.throws(
      () =>
        markHumanDecision(
          { taskId: "t", decision: "accepted", reason: "x" },
          { ledgerDir },
        ),
      QualityLedgerError,
    );
  });
});

// --- write paths ---------------------------------------------------------

test("markHumanDecision: appends one row to human-decisions.jsonl", () => {
  withTempDirs((ledgerDir) => {
    const r = markHumanDecision(
      {
        taskId: "t1",
        decision: "rejected",
        reason: "patch too broad",
        decidedBy: "andre@host",
      },
      { ledgerDir },
    );
    assert.equal(r.event.kind, "human_decision");
    assert.equal(r.event.decision, "rejected");
    assert.equal(r.event.decidedBy, "andre@host");
    assert.ok(existsSync(r.ledgerPath));
    const lines = readFileSync(r.ledgerPath, "utf8").trim().split("\n");
    assert.equal(lines.length, 1);
    const parsed = JSON.parse(lines[0]!);
    assert.equal(parsed.kind, "human_decision");
    assert.equal(parsed.decision, "rejected");
  });
});

test("markHumanDecision: dryRun=true → no fs write, event still returned", () => {
  withTempDirs((ledgerDir) => {
    const r = markHumanDecision(
      {
        taskId: "t1",
        decision: "deferred",
        reason: "will revisit after Q3",
      },
      { ledgerDir, dryRun: true },
    );
    assert.equal(r.event.decision, "deferred");
    assert.equal(existsSync(r.ledgerPath), false);
  });
});

// --- arbiterAgreed resolution from artifactsDir --------------------------

test("markHumanDecision: arbiterAgreed=true when human accepted same builder as arbiter selected", () => {
  withTempDirs((ledgerDir, artifactsDir) => {
    writeArbiterDecision(artifactsDir, "b2");
    writeOrchestrationPacket(artifactsDir, "orch-pkt-1");
    const r = markHumanDecision(
      {
        taskId: "t1",
        artifactsDir,
        decision: "accepted",
        acceptedBuilderId: "b2",
        reason: "matches arbiter pick",
      },
      { ledgerDir },
    );
    assert.equal(r.arbiterAgreedComputed, true);
    assert.equal(r.event.arbiterAgreed, true);
    assert.equal(r.event.humanOutcomeRelation, "accepted_selected");
    assert.equal(r.event.packetId, "orch-pkt-1");
  });
});

test("markHumanDecision: arbiterAgreed=false when human overrode arbiter pick", () => {
  withTempDirs((ledgerDir, artifactsDir) => {
    writeArbiterDecision(artifactsDir, "b1");
    writeOrchestrationPacket(artifactsDir, "orch-pkt-2");
    const r = markHumanDecision(
      {
        taskId: "t1",
        artifactsDir,
        decision: "accepted",
        acceptedBuilderId: "b3",
        reason: "arbiter wrong; b3 cleaner",
      },
      { ledgerDir },
    );
    assert.equal(r.arbiterAgreedComputed, true);
    assert.equal(r.event.arbiterAgreed, false);
    // Patch K: the highest-value flywheel signal — human accepted a
    // candidate the arbiter did NOT pick. arbiterAgreed=false collapses
    // this with "rejected_all" and "accepted_manual"; the relation
    // distinguishes them.
    assert.equal(r.event.humanOutcomeRelation, "accepted_non_selected");
  });
});

test("markHumanDecision: arbiterAgreedComputed=false when no artifactsDir + no arbiter to compare", () => {
  withTempDirs((ledgerDir) => {
    const r = markHumanDecision(
      {
        taskId: "t1",
        decision: "accepted",
        acceptedBuilderId: "b1",
        reason: "manual apply, no orchestration",
      },
      { ledgerDir },
    );
    assert.equal(r.arbiterAgreedComputed, false);
    assert.equal(r.event.arbiterAgreed, undefined);
    // No artifactsDir → arbiter relation is "accepted_manual" (the
    // operator hand-applied a patch off-loop).
    assert.equal(r.event.humanOutcomeRelation, "accepted_manual");
    // Synthetic packetId (manual-prefix) when no orchestration linked.
    assert.match(r.event.packetId, /^manual-/);
  });
});

test("markHumanDecision: missing arbiter-decision.json under artifactsDir → no throw, arbiterAgreed undefined", () => {
  withTempDirs((ledgerDir, artifactsDir) => {
    // artifactsDir exists but has no arbiter-decision.json.
    const r = markHumanDecision(
      {
        taskId: "t1",
        artifactsDir,
        decision: "accepted",
        acceptedBuilderId: "b1",
        reason: "x",
      },
      { ledgerDir },
    );
    assert.equal(r.arbiterAgreedComputed, false);
    assert.equal(r.event.arbiterAgreed, undefined);
  });
});

// --- reader integration --------------------------------------------------

test("readLedger: humanDecisions[] populated from human-decisions.jsonl", () => {
  withTempDirs((ledgerDir) => {
    markHumanDecision(
      { taskId: "t1", decision: "rejected", reason: "x" },
      { ledgerDir },
    );
    markHumanDecision(
      {
        taskId: "t2",
        decision: "escalation_resolved",
        reason: "manual fix",
      },
      { ledgerDir },
    );
    const snap = readLedger({ ledgerDir });
    assert.equal(snap.humanDecisions.length, 2);
    assert.deepEqual(snap.humanDecisions.map((e) => e.decision).sort(), [
      "escalation_resolved",
      "rejected",
    ]);
  });
});

test("readLedger: humanDecisions empty when no human-decisions.jsonl", () => {
  withTempDirs((ledgerDir) => {
    mkdirSync(ledgerDir, { recursive: true });
    const snap = readLedger({ ledgerDir });
    assert.deepEqual(snap.humanDecisions, []);
  });
});

// --- schema validation ---------------------------------------------------

test("markHumanDecision: empty reason fails schema validation", () => {
  withTempDirs((ledgerDir) => {
    assert.throws(
      () =>
        markHumanDecision(
          { taskId: "t1", decision: "rejected", reason: "" },
          { ledgerDir },
        ),
      QualityLedgerError,
    );
  });
});

// Q2-B2 fix: schema (not just JS guard) enforces acceptedBuilderId when
// decision=accepted. Pin both layers to prevent silent integrity holes
// if a future caller writes events without going through markHumanDecision.
test("markHumanDecision: empty acceptedBuilderId fails schema (minLength: 1)", () => {
  withTempDirs((ledgerDir) => {
    assert.throws(
      () =>
        markHumanDecision(
          {
            taskId: "t1",
            decision: "accepted",
            acceptedBuilderId: "",
            reason: "x",
          },
          { ledgerDir },
        ),
      QualityLedgerError,
    );
  });
});

// Q2-B3 fix: synthetic packetId + eventId use crypto.randomUUID, so
// many parallel marks on the same task in the same millisecond produce
// distinct events.
test("markHumanDecision: 100 parallel marks on same task produce distinct event/packet IDs", () => {
  withTempDirs((ledgerDir) => {
    const fixedNow = () => 1714060800000;
    const eventIds = new Set<string>();
    const packetIds = new Set<string>();
    for (let i = 0; i < 100; i++) {
      const r = markHumanDecision(
        { taskId: "t-parallel", decision: "rejected", reason: "x" },
        { ledgerDir, dryRun: true, now: fixedNow },
      );
      eventIds.add(r.event.eventId);
      packetIds.add(r.event.packetId);
    }
    assert.equal(eventIds.size, 100);
    assert.equal(packetIds.size, 100);
  });
});

// --- Patch K: humanOutcomeRelation enum ---------------------------------

// Cover every branch of computeHumanOutcomeRelation. arbiterAgreed is
// also captured here when relevant so the relationship between the
// boolean and the new enum is pinned (richer always when artifactsDir
// is provided + decision=accepted; otherwise the boolean is undefined).

test("markHumanDecision relation: rejected → 'rejected_all' (regardless of arbiter file)", () => {
  withTempDirs((ledgerDir, artifactsDir) => {
    writeArbiterDecision(artifactsDir, "b1");
    writeOrchestrationPacket(artifactsDir, "orch-pkt-rej");
    const r = markHumanDecision(
      {
        taskId: "t1",
        artifactsDir,
        decision: "rejected",
        reason: "all candidates broke the contract",
      },
      { ledgerDir },
    );
    assert.equal(r.event.humanOutcomeRelation, "rejected_all");
    assert.equal(r.event.arbiterAgreed, undefined);
  });
});

test("markHumanDecision relation: escalation_resolved → 'escalation_resolved'", () => {
  withTempDirs((ledgerDir) => {
    const r = markHumanDecision(
      {
        taskId: "t1",
        decision: "escalation_resolved",
        reason: "fixed manually after escalation",
      },
      { ledgerDir },
    );
    assert.equal(r.event.humanOutcomeRelation, "escalation_resolved");
  });
});

// Patch K self-review NB-3: edge case — arbiter file present but
// arbiter chose escalate (no selectedBuilderId), then operator
// accepts a specific builder out of band. The relation must be
// "accepted_non_selected" (operator picked a builder the arbiter
// explicitly DID NOT select), not "accepted_manual" (which is reserved
// for "no arbiter to compare against").
test("markHumanDecision relation: arbiter escalated (no selectedBuilderId) + human accepts → 'accepted_non_selected'", () => {
  withTempDirs((ledgerDir, artifactsDir) => {
    writeArbiterDecision(artifactsDir, undefined); // arbiter chose escalate
    writeOrchestrationPacket(artifactsDir, "orch-pkt-esc");
    const r = markHumanDecision(
      {
        taskId: "t1",
        artifactsDir,
        decision: "accepted",
        acceptedBuilderId: "b7",
        reason: "human resolved escalation by picking b7",
      },
      { ledgerDir },
    );
    assert.equal(r.event.humanOutcomeRelation, "accepted_non_selected");
    // arbiterAgreed=false (selectedBuilderId is undefined, !== "b7").
    assert.equal(r.event.arbiterAgreed, false);
    assert.equal(r.arbiterAgreedComputed, true);
  });
});

test("markHumanDecision relation: deferred → 'deferred'", () => {
  withTempDirs((ledgerDir) => {
    const r = markHumanDecision(
      {
        taskId: "t1",
        decision: "deferred",
        reason: "revisit after Q3 close",
      },
      { ledgerDir },
    );
    assert.equal(r.event.humanOutcomeRelation, "deferred");
  });
});
