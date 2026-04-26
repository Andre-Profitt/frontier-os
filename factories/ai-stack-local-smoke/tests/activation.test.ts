// activation tests — fixture plists under tmpdir; no real ~/Library plist
// is ever read or written by these tests.

import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

import {
  applyActivation,
  planActivation,
  rollbackActivation,
  writeFixturePlist,
} from "../activation.ts";

function withTempDir<T>(fn: (dir: string) => T): T {
  const dir = mkdtempSync(join(tmpdir(), "activation-"));
  try {
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function readPlistAsJson(plistPath: string): Record<string, unknown> {
  const r = spawnSync("plutil", ["-convert", "json", "-o", "-", plistPath], {
    encoding: "utf8",
    timeout: 5_000,
  });
  if (r.status !== 0) {
    throw new Error(`plutil read failed: ${r.stderr}`);
  }
  return JSON.parse(r.stdout ?? "{}");
}

test("planActivation: reads current plist, computes proposed + diff + rollback", () => {
  withTempDir((dir) => {
    const plistPath = join(dir, "fixture.plist");
    const backupDir = join(dir, "backups");
    writeFixturePlist(plistPath, {
      Label: "fixture",
      ProgramArguments: ["/old/path/script.sh"],
      RunAtLoad: true,
    });
    const plan = planActivation({
      plistPath,
      factoryWrapperPath: "/path/to/wrapper.sh",
      backupDir,
      now: () => new Date("2026-04-26T19:30:00Z"),
    });
    assert.equal(plan.current.exists, true);
    assert.deepEqual(plan.current.programArguments, ["/old/path/script.sh"]);
    assert.deepEqual(plan.proposed.programArguments, [
      "/bin/bash",
      "/path/to/wrapper.sh",
    ]);
    assert.match(plan.diff, /ProgramArguments:.*\/old\/path\/script\.sh/);
    assert.match(plan.diff, /\+ ProgramArguments:.*\/path\/to\/wrapper\.sh/);
    assert.match(plan.rollbackCommand, /--rollback 20260426T193000Z/);
    assert.equal(plan.alreadyActivated, false);
  });
});

test("planActivation: detects already-activated plist", () => {
  withTempDir((dir) => {
    const plistPath = join(dir, "fixture.plist");
    writeFixturePlist(plistPath, {
      Label: "fixture",
      ProgramArguments: ["/bin/bash", "/path/to/wrapper.sh"],
    });
    const plan = planActivation({
      plistPath,
      factoryWrapperPath: "/path/to/wrapper.sh",
      backupDir: join(dir, "backups"),
    });
    assert.equal(plan.alreadyActivated, true);
  });
});

test("applyActivation dryRun=true: no files modified", () => {
  withTempDir((dir) => {
    const plistPath = join(dir, "fixture.plist");
    const backupDir = join(dir, "backups");
    writeFixturePlist(plistPath, {
      Label: "fixture",
      ProgramArguments: ["/old/path/script.sh"],
    });
    const plan = planActivation({
      plistPath,
      factoryWrapperPath: "/path/to/wrapper.sh",
      backupDir,
    });
    const result = applyActivation(plan, { dryRun: true });
    assert.equal(result.applied, false);
    assert.equal(result.dryRun, true);
    // No backup written.
    assert.equal(existsSync(backupDir), false);
    // Plist unchanged.
    const current = readPlistAsJson(plistPath);
    assert.deepEqual(current["ProgramArguments"], ["/old/path/script.sh"]);
  });
});

test("applyActivation dryRun=false: backs up plist + rewrites ProgramArguments", () => {
  withTempDir((dir) => {
    const plistPath = join(dir, "fixture.plist");
    const backupDir = join(dir, "backups");
    writeFixturePlist(plistPath, {
      Label: "fixture",
      ProgramArguments: ["/old/path/script.sh"],
      RunAtLoad: true,
    });
    const plan = planActivation({
      plistPath,
      factoryWrapperPath: "/path/to/wrapper.sh",
      backupDir,
    });
    const result = applyActivation(plan, { dryRun: false });
    assert.equal(result.applied, true);
    assert.ok(existsSync(plan.backupPath), "backup file should exist");
    // Backup matches the original.
    const backedUp = readPlistAsJson(plan.backupPath);
    assert.deepEqual(backedUp["ProgramArguments"], ["/old/path/script.sh"]);
    // Live plist now points at the wrapper.
    const live = readPlistAsJson(plistPath);
    assert.deepEqual(live["ProgramArguments"], [
      "/bin/bash",
      "/path/to/wrapper.sh",
    ]);
    // Other keys preserved.
    assert.equal(live["Label"], "fixture");
    assert.equal(live["RunAtLoad"], true);
  });
});

test("applyActivation: already-activated plist short-circuits without backup", () => {
  withTempDir((dir) => {
    const plistPath = join(dir, "fixture.plist");
    const backupDir = join(dir, "backups");
    writeFixturePlist(plistPath, {
      Label: "fixture",
      ProgramArguments: ["/bin/bash", "/path/to/wrapper.sh"],
    });
    const plan = planActivation({
      plistPath,
      factoryWrapperPath: "/path/to/wrapper.sh",
      backupDir,
    });
    const result = applyActivation(plan, { dryRun: false });
    assert.equal(result.applied, false);
    assert.equal(existsSync(backupDir), false);
    assert.match(result.detail, /already points/);
  });
});

test("rollbackActivation: restores plist from named backup", () => {
  withTempDir((dir) => {
    const plistPath = join(dir, "fixture.plist");
    const backupDir = join(dir, "backups");
    writeFixturePlist(plistPath, {
      Label: "fixture",
      ProgramArguments: ["/old/path/script.sh"],
    });
    const plan = planActivation({
      plistPath,
      factoryWrapperPath: "/path/to/wrapper.sh",
      backupDir,
      now: () => new Date("2026-04-26T19:30:00Z"),
    });
    applyActivation(plan, { dryRun: false });
    // Confirm activated.
    const live = readPlistAsJson(plistPath);
    assert.deepEqual(live["ProgramArguments"], [
      "/bin/bash",
      "/path/to/wrapper.sh",
    ]);
    // Roll back.
    const rb = rollbackActivation({
      plistPath,
      backupDir,
      backupId: "20260426T193000Z",
      dryRun: false,
    });
    assert.equal(rb.restored, true);
    const restored = readPlistAsJson(plistPath);
    assert.deepEqual(restored["ProgramArguments"], ["/old/path/script.sh"]);
  });
});

test("rollbackActivation dryRun=true: no files modified", () => {
  withTempDir((dir) => {
    const plistPath = join(dir, "fixture.plist");
    const backupDir = join(dir, "backups");
    writeFixturePlist(plistPath, {
      Label: "fixture",
      ProgramArguments: ["/old/path/script.sh"],
    });
    const plan = planActivation({
      plistPath,
      factoryWrapperPath: "/path/to/wrapper.sh",
      backupDir,
      now: () => new Date("2026-04-26T19:30:00Z"),
    });
    applyActivation(plan, { dryRun: false });
    const liveAfterApply = readPlistAsJson(plistPath);
    const rb = rollbackActivation({
      plistPath,
      backupDir,
      backupId: "20260426T193000Z",
      dryRun: true,
    });
    assert.equal(rb.restored, false);
    assert.equal(rb.dryRun, true);
    // Plist unchanged from post-apply state.
    const liveAfterDryRun = readPlistAsJson(plistPath);
    assert.deepEqual(liveAfterDryRun, liveAfterApply);
  });
});

test("rollbackActivation: missing backup throws clearly", () => {
  withTempDir((dir) => {
    assert.throws(
      () =>
        rollbackActivation({
          plistPath: join(dir, "fixture.plist"),
          backupDir: join(dir, "backups"),
          backupId: "no-such-id",
          dryRun: false,
        }),
      /backup not found/,
    );
  });
});

test("backups dir collects multiple stamped files for repeated apply", () => {
  withTempDir((dir) => {
    const plistPath = join(dir, "fixture.plist");
    const backupDir = join(dir, "backups");
    writeFixturePlist(plistPath, {
      Label: "fixture",
      ProgramArguments: ["/old/v1.sh"],
    });
    const plan1 = planActivation({
      plistPath,
      factoryWrapperPath: "/wrapper.sh",
      backupDir,
      now: () => new Date("2026-04-26T19:30:00Z"),
    });
    applyActivation(plan1, { dryRun: false });

    // Roll back, then re-apply with a different timestamp.
    rollbackActivation({
      plistPath,
      backupDir,
      backupId: "20260426T193000Z",
      dryRun: false,
    });
    const plan2 = planActivation({
      plistPath,
      factoryWrapperPath: "/wrapper.sh",
      backupDir,
      now: () => new Date("2026-04-26T20:00:00Z"),
    });
    applyActivation(plan2, { dryRun: false });

    const files = readdirSync(backupDir).filter((f) => f.endsWith(".plist"));
    assert.equal(
      files.length,
      2,
      `expected 2 backups, got: ${files.join(", ")}`,
    );
  });
});
