// Patch J: auto-ingest after `frontier orchestrate`. Tests use a stub
// ingestImpl so we don't need a full artifactsDir on disk.

import { test } from "node:test";
import assert from "node:assert/strict";

import { autoIngestOrchestration } from "../auto-ingest.ts";
import type { OrchestrationPacket } from "../../orchestrate/types.ts";
import type { IngestResult } from "../writer.ts";

function packet(over: Partial<OrchestrationPacket> = {}): OrchestrationPacket {
  return {
    packetId: "orch-x",
    taskId: "t1",
    scannedAt: "2026-04-27T00:00:00.000Z",
    input: { taskDescription: "x", builderCount: 1, reviewerCount: 1 },
    builderPacketPath: "/tmp/b.json",
    reviewPacketPaths: [],
    arbiterDecisionPath: "/tmp/a.json",
    finalReportPath: "/tmp/f.md",
    artifactsDir: "/tmp/arts",
    exitCode: 0,
    elapsedMs: 1,
    ...over,
  };
}

function fakeResult(): IngestResult {
  return {
    workerRuns: 3,
    reviewFindings: 2,
    arbiterDecisions: 1,
    modelEvents: 2,
    appendedAt: "2026-04-27T00:00:00.000Z",
    events: [],
  };
}

// --- happy path ----------------------------------------------------------

test("autoIngestOrchestration: success → attempted=true, ok=true, counts populated", () => {
  let called = 0;
  const status = autoIngestOrchestration(packet(), {
    ingestImpl: () => {
      called++;
      return fakeResult();
    },
  });
  assert.equal(called, 1);
  assert.equal(status.attempted, true);
  assert.equal(status.ok, true);
  assert.deepEqual(status.counts, {
    workerRuns: 3,
    reviewFindings: 2,
    arbiterDecisions: 1,
    modelEvents: 2,
  });
});

// --- skip paths (operator opt-out, failed run) ---------------------------

test("autoIngestOrchestration: skip=true → not attempted, reason explains", () => {
  let called = 0;
  const status = autoIngestOrchestration(packet(), {
    skip: true,
    ingestImpl: () => {
      called++;
      return fakeResult();
    },
  });
  assert.equal(called, 0);
  assert.equal(status.attempted, false);
  assert.equal(status.ok, false);
  assert.match(status.reason ?? "", /skip-ingest/);
});

test("autoIngestOrchestration: exitCode != 0 → not attempted, ledger stays clean of failed runs", () => {
  let called = 0;
  const status = autoIngestOrchestration(packet({ exitCode: 1 }), {
    ingestImpl: () => {
      called++;
      return fakeResult();
    },
  });
  assert.equal(called, 0);
  assert.equal(status.attempted, false);
  assert.equal(status.ok, false);
  assert.match(status.reason ?? "", /exitCode=1/);
});

// --- failure trap --------------------------------------------------------

test("autoIngestOrchestration: ingest throw is caught — does NOT propagate to caller", () => {
  const status = autoIngestOrchestration(packet(), {
    ingestImpl: () => {
      throw new Error("duplicate packetId");
    },
  });
  assert.equal(status.attempted, true);
  assert.equal(status.ok, false);
  assert.match(status.reason ?? "", /duplicate packetId/);
});

test("autoIngestOrchestration: non-Error throw is normalized to string reason", () => {
  const status = autoIngestOrchestration(packet(), {
    ingestImpl: () => {
      throw "string-thrown";
    },
  });
  assert.equal(status.ok, false);
  assert.equal(status.reason, "string-thrown");
});

// --- ledgerDir override --------------------------------------------------

test("autoIngestOrchestration: ledgerDir option is forwarded to ingest", () => {
  let seenDir: string | undefined;
  autoIngestOrchestration(packet(), {
    ledgerDir: "/custom/ledger",
    ingestImpl: (artifactsDir, opts) => {
      seenDir = opts?.ledgerDir;
      assert.equal(artifactsDir, "/tmp/arts");
      return fakeResult();
    },
  });
  assert.equal(seenDir, "/custom/ledger");
});

test("autoIngestOrchestration: ledgerDir absent → ingest called without override", () => {
  let optsSeen: { ledgerDir?: string } | undefined;
  autoIngestOrchestration(packet(), {
    ingestImpl: (_artifactsDir, opts) => {
      optsSeen = opts;
      return fakeResult();
    },
  });
  assert.equal(optsSeen?.ledgerDir, undefined);
});

// --- order of guards -----------------------------------------------------

test("autoIngestOrchestration: skip=true wins over exitCode=0 (operator opt-out is sticky)", () => {
  const status = autoIngestOrchestration(packet({ exitCode: 0 }), {
    skip: true,
    ingestImpl: () => fakeResult(),
  });
  assert.equal(status.attempted, false);
  assert.match(status.reason ?? "", /skip-ingest/);
});

test("autoIngestOrchestration: skip=false + exitCode=2 → still skipped (failed-run guard)", () => {
  const status = autoIngestOrchestration(packet({ exitCode: 2 }), {
    skip: false,
    ingestImpl: () => fakeResult(),
  });
  assert.equal(status.attempted, false);
  assert.match(status.reason ?? "", /exitCode=2/);
});
