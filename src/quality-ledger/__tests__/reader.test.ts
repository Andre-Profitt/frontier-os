// Quality ledger reader tests. Cover empty dir, malformed rows,
// and kind-mismatch tolerance.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { readLedger } from "../reader.ts";

function withTempDir<T>(fn: (dir: string) => T): T {
  const dir = mkdtempSync(join(tmpdir(), "qreader-test-"));
  try {
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("readLedger: empty/missing dir → empty snapshot, no throw", () => {
  withTempDir((dir) => {
    const snap = readLedger({ ledgerDir: dir });
    assert.deepEqual(snap.workerRuns, []);
    assert.deepEqual(snap.reviewFindings, []);
    assert.deepEqual(snap.arbiterDecisions, []);
    assert.deepEqual(snap.modelEvents, []);
  });
});

test("readLedger: skips blank lines without calling onMalformed", () => {
  withTempDir((dir) => {
    const f = resolve(dir, "worker-runs.jsonl");
    writeFileSync(
      f,
      // valid row, blank line, blank line with whitespace, valid row
      JSON.stringify({
        eventId: "e1",
        taskId: "t",
        packetId: "p",
        ts: "2026-04-26T22:00:00.000Z",
        kind: "worker_run",
        workerId: "b1",
        role: "builder",
        taskClass: "patch_builder",
        phase: "collected",
        ok: true,
        arbiterOutcome: "selected",
      }) +
        "\n\n   \n" +
        JSON.stringify({
          eventId: "e2",
          taskId: "t",
          packetId: "p",
          ts: "2026-04-26T22:00:00.000Z",
          kind: "worker_run",
          workerId: "b2",
          role: "builder",
          taskClass: "patch_builder",
          phase: "apply_failed",
          ok: false,
          arbiterOutcome: "excluded",
        }) +
        "\n",
    );
    const malformed: string[] = [];
    const snap = readLedger({
      ledgerDir: dir,
      onMalformed: (_file, _ln, raw) => malformed.push(raw),
    });
    assert.equal(snap.workerRuns.length, 2);
    assert.equal(malformed.length, 0);
  });
});

test("readLedger: malformed JSON → onMalformed callback fires, row skipped", () => {
  withTempDir((dir) => {
    const f = resolve(dir, "worker-runs.jsonl");
    writeFileSync(
      f,
      "{not json}\n" +
        JSON.stringify({
          eventId: "e1",
          taskId: "t",
          packetId: "p",
          ts: "2026-04-26T22:00:00.000Z",
          kind: "worker_run",
          workerId: "b1",
          role: "builder",
          taskClass: "patch_builder",
          phase: "collected",
          ok: true,
          arbiterOutcome: "selected",
        }) +
        "\n",
    );
    const malformed: Array<{ raw: string; error: string }> = [];
    const snap = readLedger({
      ledgerDir: dir,
      onMalformed: (_f, _ln, raw, error) => malformed.push({ raw, error }),
    });
    assert.equal(snap.workerRuns.length, 1);
    assert.equal(malformed.length, 1);
    assert.match(malformed[0]!.raw, /not json/);
  });
});

test("readLedger: row with wrong kind for the file → callback, row skipped", () => {
  withTempDir((dir) => {
    // Put an arbiter_decision row in worker-runs.jsonl by mistake.
    const f = resolve(dir, "worker-runs.jsonl");
    writeFileSync(
      f,
      JSON.stringify({
        eventId: "e1",
        taskId: "t",
        packetId: "p",
        ts: "2026-04-26T22:00:00.000Z",
        kind: "arbiter_decision",
        decision: "accept",
        candidatesEvaluated: 1,
        rerunVerificationOk: true,
      }) + "\n",
    );
    const malformed: string[] = [];
    const snap = readLedger({
      ledgerDir: dir,
      onMalformed: (_f, _ln, _raw, err) => malformed.push(err),
    });
    assert.equal(snap.workerRuns.length, 0);
    assert.equal(malformed.length, 1);
    assert.match(malformed[0]!, /kind mismatch/);
  });
});

test("readLedger: silently skips when onMalformed not provided", () => {
  withTempDir((dir) => {
    const f = resolve(dir, "worker-runs.jsonl");
    writeFileSync(f, "{not json}\n");
    const snap = readLedger({ ledgerDir: dir });
    assert.equal(snap.workerRuns.length, 0);
  });
});
