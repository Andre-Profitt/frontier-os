// Lease tests — fixture lock files under tmpdir; no production state touched.

import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  acquireLease,
  isProcessAlive,
  readActiveLease,
  releaseLease,
} from "../lease.ts";

function withTempLock<T>(fn: (lockPath: string) => T): T {
  const dir = mkdtempSync(join(tmpdir(), "lease-"));
  const lockPath = join(dir, "lock.json");
  try {
    return fn(lockPath);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("acquireLease: no lock file → acquired, fresh, lock written", () => {
  withTempLock((lockPath) => {
    const r = acquireLease({
      factoryId: "f",
      runId: "run-1",
      ttlSeconds: 60,
      lockPath,
    });
    assert.equal(r.acquired, true);
    assert.equal(r.staleRecovered, false);
    assert.equal(r.blockedBy, null);
    assert.ok(r.lease);
    assert.ok(existsSync(lockPath));
    const written = JSON.parse(readFileSync(lockPath, "utf8"));
    assert.equal(written.factoryId, "f");
    assert.equal(written.runId, "run-1");
    assert.equal(written.pid, process.pid);
  });
});

test("acquireLease: live unexpired lock → refused, blockedBy populated", () => {
  withTempLock((lockPath) => {
    const r1 = acquireLease({
      factoryId: "f",
      runId: "run-1",
      ttlSeconds: 60,
      lockPath,
      isAlive: () => true,
    });
    assert.equal(r1.acquired, true);
    const r2 = acquireLease({
      factoryId: "f",
      runId: "run-2",
      ttlSeconds: 60,
      lockPath,
      isAlive: () => true,
    });
    assert.equal(r2.acquired, false);
    assert.equal(r2.staleRecovered, false);
    assert.ok(r2.blockedBy);
    assert.equal(r2.blockedBy?.runId, "run-1");
  });
});

test("acquireLease: dead-pid lock → taken over with staleRecovered=true", () => {
  withTempLock((lockPath) => {
    acquireLease({
      factoryId: "f",
      runId: "run-1",
      ttlSeconds: 60,
      lockPath,
      isAlive: () => true,
    });
    const r = acquireLease({
      factoryId: "f",
      runId: "run-2",
      ttlSeconds: 60,
      lockPath,
      isAlive: () => false,
    });
    assert.equal(r.acquired, true);
    assert.equal(r.staleRecovered, true);
    assert.equal(r.lease?.runId, "run-2");
  });
});

test("acquireLease: expired lock with live pid → taken over with staleRecovered=true", () => {
  withTempLock((lockPath) => {
    const past = new Date("2020-01-01T00:00:00Z");
    acquireLease({
      factoryId: "f",
      runId: "run-1",
      ttlSeconds: 60,
      lockPath,
      isAlive: () => true,
      now: () => past,
    });
    const r = acquireLease({
      factoryId: "f",
      runId: "run-2",
      ttlSeconds: 60,
      lockPath,
      isAlive: () => true,
      now: () => new Date(),
    });
    assert.equal(r.acquired, true);
    assert.equal(r.staleRecovered, true);
  });
});

test("releaseLease: matching runId removes lock", () => {
  withTempLock((lockPath) => {
    acquireLease({
      factoryId: "f",
      runId: "run-1",
      ttlSeconds: 60,
      lockPath,
    });
    const r = releaseLease(lockPath, "run-1");
    assert.equal(r.released, true);
    assert.equal(existsSync(lockPath), false);
  });
});

test("releaseLease: mismatched runId is a no-op (defensive)", () => {
  withTempLock((lockPath) => {
    acquireLease({
      factoryId: "f",
      runId: "run-1",
      ttlSeconds: 60,
      lockPath,
    });
    const r = releaseLease(lockPath, "run-2");
    assert.equal(r.released, false);
    assert.match(r.reason, /different runId/);
    assert.ok(existsSync(lockPath));
  });
});

test("releaseLease: missing lock returns released=false", () => {
  withTempLock((lockPath) => {
    const r = releaseLease(lockPath, "run-1");
    assert.equal(r.released, false);
    assert.match(r.reason, /no lock present/);
  });
});

test("readActiveLease: returns parsed lease or null", () => {
  withTempLock((lockPath) => {
    assert.equal(readActiveLease(lockPath), null);
    acquireLease({
      factoryId: "f",
      runId: "run-1",
      ttlSeconds: 60,
      lockPath,
    });
    const lease = readActiveLease(lockPath);
    assert.ok(lease);
    assert.equal(lease?.runId, "run-1");
  });
});

test("isProcessAlive: own pid is alive", () => {
  assert.equal(isProcessAlive(process.pid), true);
});

test("isProcessAlive: tiny invalid pid is dead", () => {
  // Pid 0 / negative / non-integer should return false defensively.
  assert.equal(isProcessAlive(0), false);
  assert.equal(isProcessAlive(-1), false);
});
