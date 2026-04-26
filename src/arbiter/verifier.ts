// Re-runs typecheck + test inside a candidate's worktree so the arbiter
// has ground-truth evidence rather than trusting the builder's own
// verification record.
//
// Why re-run: the builder's exit codes are hearsay. The skill's
// adversarial_review SKILL.md anti-pattern A3 says "re-run is mandatory"
// — same principle here, applied at the arbiter boundary.
//
// Defaults match the repo convention (`npm run typecheck`, no `npm
// test` because the repo has none — caller passes a test command). For
// v1 we accept caller-provided commands so the arbiter is not coupled
// to one specific test runner.

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";

import type { VerificationPhase, VerificationResult } from "./types.ts";

export interface VerifierOptions {
  builderId: string;
  worktreePath: string;
  // Defaults to ["npm", "run", "typecheck"]. Set to null to skip.
  typecheckCommand?: string[] | null;
  // No default — repo has no `npm test`. Caller may pass e.g.
  // ["node", "--import", "tsx", "--test", "src/**/__tests__/*.test.ts"].
  // Set to null to skip the test phase.
  testCommand?: string[] | null;
  // Per-command timeout in ms.
  timeoutMs?: number;
  // Test seam.
  exec?: (
    cmd: string,
    args: string[],
    cwd: string,
    timeoutMs: number,
  ) => { status: number | null; stderr: string; signal: NodeJS.Signals | null };
  now?: () => number;
}

const DEFAULT_TIMEOUT_MS = 120_000;
const DEFAULT_TYPECHECK = ["npm", "run", "typecheck"];

export function verifyCandidate(opts: VerifierOptions): VerificationResult {
  const now = opts.now ?? Date.now;
  const exec = opts.exec ?? defaultExec;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const ranAt = new Date(now()).toISOString();
  const tStart = now();

  if (!existsSync(opts.worktreePath)) {
    return {
      builderId: opts.builderId,
      worktreePath: opts.worktreePath,
      phase: "worktree_missing",
      ranAt,
      elapsedMs: now() - tStart,
    };
  }

  const tcCmd =
    opts.typecheckCommand === undefined
      ? DEFAULT_TYPECHECK
      : opts.typecheckCommand;
  const testCmd = opts.testCommand ?? null;

  let phase: VerificationPhase = "passed";
  let typecheckExitCode: number | undefined;
  let typecheckStderr: string | undefined;
  let testExitCode: number | undefined;
  let testStderr: string | undefined;

  if (tcCmd && tcCmd.length > 0) {
    const [cmd, ...args] = tcCmd;
    if (!cmd) {
      // Misconfigured — caller passed an empty command array.
      phase = "skipped";
    } else {
      const r = exec(cmd, args, opts.worktreePath, timeoutMs);
      typecheckExitCode = r.status ?? -1;
      typecheckStderr = truncate(r.stderr, 2000);
      if (r.status !== 0) phase = "typecheck_failed";
    }
  } else if (tcCmd === null && testCmd === null) {
    phase = "skipped";
  }

  if (phase === "passed" && testCmd && testCmd.length > 0) {
    const [cmd, ...args] = testCmd;
    if (cmd) {
      const r = exec(cmd, args, opts.worktreePath, timeoutMs);
      testExitCode = r.status ?? -1;
      testStderr = truncate(r.stderr, 2000);
      if (r.status !== 0) phase = "tests_failed";
    }
  }

  const result: VerificationResult = {
    builderId: opts.builderId,
    worktreePath: opts.worktreePath,
    phase,
    ranAt,
    elapsedMs: now() - tStart,
  };
  if (typecheckExitCode !== undefined)
    result.typecheckExitCode = typecheckExitCode;
  if (typecheckStderr) result.typecheckStderr = typecheckStderr;
  if (testExitCode !== undefined) result.testExitCode = testExitCode;
  if (testStderr) result.testStderr = testStderr;
  return result;
}

function defaultExec(
  cmd: string,
  args: string[],
  cwd: string,
  timeoutMs: number,
): { status: number | null; stderr: string; signal: NodeJS.Signals | null } {
  const r = spawnSync(cmd, args, { cwd, encoding: "utf8", timeout: timeoutMs });
  return {
    status: r.status ?? null,
    stderr: typeof r.stderr === "string" ? r.stderr : "",
    signal: (r.signal as NodeJS.Signals | null) ?? null,
  };
}

function truncate(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n)}...(+${s.length - n} chars)` : s;
}
