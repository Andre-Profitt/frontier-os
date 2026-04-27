// latest-run tests — heartbeat read/write + staleness assessment.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  assessStaleness,
  readLatestRun,
  writeLatestRun,
  type LatestRun,
} from "../latest-run.ts";

function sample(overrides: Partial<LatestRun> = {}): LatestRun {
  return {
    factoryId: "f",
    runId: "run-1",
    mode: "active",
    trigger: "launchd",
    startedAt: "2026-04-26T00:00:00Z",
    finishedAt: "2026-04-26T00:00:30Z",
    classification: "passed",
    primaryStatus: "ok",
    repairStatus: "ok",
    escalations: [],
    ledgerSessionId: "ses_x",
    alertId: null,
    evidencePath: "factories/f/evidence/run-1.json",
    ...overrides,
  };
}

test("writeLatestRun + readLatestRun roundtrip", () => {
  const dir = mkdtempSync(join(tmpdir(), "lr-"));
  const path = join(dir, "latest-run.json");
  try {
    const r = sample();
    writeLatestRun(path, r);
    const back = readLatestRun(path);
    assert.deepEqual(back, r);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("readLatestRun: missing file returns null", () => {
  assert.equal(readLatestRun("/no/such/file.json"), null);
});

test("assessStaleness: kill switch active → disabled (highest precedence)", () => {
  const r = assessStaleness({
    latestRun: sample(),
    now: new Date("2026-04-26T00:01:00Z"),
    staleWindowSeconds: 3600,
    killSwitchActive: true,
    lockHeld: true,
  });
  assert.equal(r.status, "disabled");
});

test("assessStaleness: lock held → locked (when kill switch off)", () => {
  const r = assessStaleness({
    latestRun: sample(),
    now: new Date("2026-04-26T00:01:00Z"),
    staleWindowSeconds: 3600,
    killSwitchActive: false,
    lockHeld: true,
  });
  assert.equal(r.status, "locked");
});

test("assessStaleness: missing latest run → missing", () => {
  const r = assessStaleness({
    latestRun: null,
    now: new Date(),
    staleWindowSeconds: 3600,
    killSwitchActive: false,
    lockHeld: false,
  });
  assert.equal(r.status, "missing");
});

test("assessStaleness: latest run older than window → stale", () => {
  const r = assessStaleness({
    latestRun: sample({ finishedAt: "2026-04-25T00:00:00Z" }),
    now: new Date("2026-04-26T05:00:00Z"),
    staleWindowSeconds: 3600,
    killSwitchActive: false,
    lockHeld: false,
  });
  assert.equal(r.status, "stale");
  assert.ok(r.ageSeconds! > 3600);
});

test("assessStaleness: latest classification=failed → failed", () => {
  const now = new Date("2026-04-26T00:01:00Z");
  const r = assessStaleness({
    latestRun: sample({ classification: "failed" }),
    now,
    staleWindowSeconds: 3600,
    killSwitchActive: false,
    lockHeld: false,
  });
  assert.equal(r.status, "failed");
});

test("assessStaleness: latest classification=ambiguous → ambiguous", () => {
  const now = new Date("2026-04-26T00:01:00Z");
  const r = assessStaleness({
    latestRun: sample({ classification: "ambiguous" }),
    now,
    staleWindowSeconds: 3600,
    killSwitchActive: false,
    lockHeld: false,
  });
  assert.equal(r.status, "ambiguous");
});

test("assessStaleness: fresh + passed → fresh", () => {
  const r = assessStaleness({
    latestRun: sample(),
    now: new Date("2026-04-26T00:01:00Z"),
    staleWindowSeconds: 3600,
    killSwitchActive: false,
    lockHeld: false,
  });
  assert.equal(r.status, "fresh");
});

test("assessStaleness: precedence — killSwitch > lock > missing > stale > failed > ambiguous > fresh", () => {
  // killSwitch wins over lock + missing + stale.
  const a = assessStaleness({
    latestRun: null,
    now: new Date(),
    staleWindowSeconds: 1,
    killSwitchActive: true,
    lockHeld: true,
  });
  assert.equal(a.status, "disabled");
  // lock wins over missing + stale (no kill switch).
  const b = assessStaleness({
    latestRun: null,
    now: new Date(),
    staleWindowSeconds: 1,
    killSwitchActive: false,
    lockHeld: true,
  });
  assert.equal(b.status, "locked");
  // failed beats stale only if not stale.
  const c = assessStaleness({
    latestRun: sample({
      classification: "failed",
      finishedAt: "2020-01-01T00:00:00Z",
    }),
    now: new Date(),
    staleWindowSeconds: 60,
    killSwitchActive: false,
    lockHeld: false,
  });
  assert.equal(c.status, "stale", "stale beats failed when finishedAt is old");
});
