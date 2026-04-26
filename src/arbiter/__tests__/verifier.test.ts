import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { verifyCandidate } from "../verifier.ts";

interface ExecCall {
  cmd: string;
  args: string[];
  cwd: string;
}

function stubExec(
  results: Array<{ status: number | null; stderr?: string }>,
  log: ExecCall[],
): NonNullable<Parameters<typeof verifyCandidate>[0]["exec"]> {
  let i = 0;
  return (cmd, args, cwd) => {
    log.push({ cmd, args, cwd });
    const next = results[i++] ?? { status: 0, stderr: "" };
    return {
      status: next.status,
      stderr: next.stderr ?? "",
      signal: null,
    };
  };
}

function withTempDir<T>(fn: (path: string) => T): T {
  const dir = mkdtempSync(join(tmpdir(), "verifier-test-"));
  try {
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("verifyCandidate: missing worktree → phase=worktree_missing", () => {
  const log: ExecCall[] = [];
  const r = verifyCandidate({
    builderId: "b1",
    worktreePath: "/nonexistent/path",
    exec: stubExec([], log),
  });
  assert.equal(r.phase, "worktree_missing");
  assert.equal(log.length, 0); // no commands ran
});

test("verifyCandidate: typecheck pass + no test command → phase=passed_typecheck_only (Patch D)", () => {
  // Pre-Patch-D returned "passed", masking the fact tests were not run.
  // Patch D distinguishes the case so the arbiter can refuse to call
  // this "verified" unless the caller opted out of tests via
  // requireTests=false.
  withTempDir((dir) => {
    const log: ExecCall[] = [];
    const r = verifyCandidate({
      builderId: "b1",
      worktreePath: dir,
      typecheckCommand: ["npm", "run", "typecheck"],
      testCommand: null,
      exec: stubExec([{ status: 0 }], log),
    });
    assert.equal(r.phase, "passed_typecheck_only");
    assert.equal(r.typecheckExitCode, 0);
    assert.equal(log.length, 1);
    assert.deepEqual(log[0]?.args, ["run", "typecheck"]);
  });
});

test("verifyCandidate: typecheck fail → phase=typecheck_failed, test not run", () => {
  withTempDir((dir) => {
    const log: ExecCall[] = [];
    const r = verifyCandidate({
      builderId: "b1",
      worktreePath: dir,
      typecheckCommand: ["npm", "run", "typecheck"],
      testCommand: ["node", "--test"],
      exec: stubExec([{ status: 1, stderr: "TS2339" }], log),
    });
    assert.equal(r.phase, "typecheck_failed");
    assert.equal(r.typecheckExitCode, 1);
    assert.match(r.typecheckStderr ?? "", /TS2339/);
    assert.equal(log.length, 1); // test was NOT run
  });
});

test("verifyCandidate: typecheck pass + test fail → phase=tests_failed", () => {
  withTempDir((dir) => {
    const log: ExecCall[] = [];
    const r = verifyCandidate({
      builderId: "b1",
      worktreePath: dir,
      typecheckCommand: ["npm", "run", "typecheck"],
      testCommand: ["node", "--test", "src/x.test.ts"],
      exec: stubExec(
        [{ status: 0 }, { status: 1, stderr: "AssertionError: expected" }],
        log,
      ),
    });
    assert.equal(r.phase, "tests_failed");
    assert.equal(r.typecheckExitCode, 0);
    assert.equal(r.testExitCode, 1);
    assert.match(r.testStderr ?? "", /AssertionError/);
    assert.equal(log.length, 2);
  });
});

test("verifyCandidate: typecheckCommand=null + testCommand=null → phase=skipped", () => {
  withTempDir((dir) => {
    const log: ExecCall[] = [];
    const r = verifyCandidate({
      builderId: "b1",
      worktreePath: dir,
      typecheckCommand: null,
      testCommand: null,
      exec: stubExec([], log),
    });
    assert.equal(r.phase, "skipped");
    assert.equal(log.length, 0);
  });
});

test("verifyCandidate: both pass → phase=passed", () => {
  withTempDir((dir) => {
    const log: ExecCall[] = [];
    const r = verifyCandidate({
      builderId: "b1",
      worktreePath: dir,
      typecheckCommand: ["npm", "run", "typecheck"],
      testCommand: ["node", "--test"],
      exec: stubExec([{ status: 0 }, { status: 0 }], log),
    });
    assert.equal(r.phase, "passed");
    assert.equal(r.typecheckExitCode, 0);
    assert.equal(r.testExitCode, 0);
    assert.equal(log.length, 2);
  });
});

test("verifyCandidate: stderr is truncated to 2000 chars", () => {
  withTempDir((dir) => {
    const log: ExecCall[] = [];
    const huge = "x".repeat(5000);
    const r = verifyCandidate({
      builderId: "b1",
      worktreePath: dir,
      typecheckCommand: ["npm", "run", "typecheck"],
      testCommand: null,
      exec: stubExec([{ status: 1, stderr: huge }], log),
    });
    assert.ok((r.typecheckStderr?.length ?? 0) <= 2200);
    assert.match(r.typecheckStderr ?? "", /\.\.\.\(\+/);
  });
});

test("verifyCandidate: records ranAt + elapsedMs", () => {
  withTempDir((dir) => {
    const log: ExecCall[] = [];
    let t = 1_700_000_000_000;
    const r = verifyCandidate({
      builderId: "b1",
      worktreePath: dir,
      typecheckCommand: ["npm", "run", "typecheck"],
      testCommand: null,
      exec: stubExec([{ status: 0 }], log),
      now: () => (t += 50),
    });
    assert.ok(r.ranAt.startsWith("20"));
    assert.ok((r.elapsedMs ?? 0) >= 50);
  });
});
