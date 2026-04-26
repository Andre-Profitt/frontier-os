// Tests for the commit-msg guard hook (Phase 4).
//
// The hook is a bash script under scripts/hooks/commit-msg. Tests spawn it
// as a subprocess against fixture commit-message files and assert on exit
// codes and stderr. Pure black-box.
//
// Run:
//   node --import tsx --test tests/hooks/commit-msg-guard.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = fileURLToPath(import.meta.url);
const REPO_ROOT = resolve(dirname(HERE), "..", "..");
const HOOK = resolve(REPO_ROOT, "scripts", "hooks", "commit-msg");

interface RunResult {
  status: number;
  stdout: string;
  stderr: string;
}

function runHook(message: string, env: Record<string, string> = {}): RunResult {
  const dir = mkdtempSync(join(tmpdir(), "commit-msg-"));
  const file = join(dir, "MSG");
  writeFileSync(file, message);
  try {
    const res = spawnSync(HOOK, [file], {
      encoding: "utf8",
      env: { ...process.env, ...env },
    });
    return {
      status: res.status ?? -1,
      stdout: res.stdout ?? "",
      stderr: res.stderr ?? "",
    };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const goodMsg = `feat(eval): add factory quality eval suite

Session: claude-factory-quality-eval-2026-04-26
Scope: Phase 3 eval suite for local-smoke factory quality
Verification: npm run typecheck; node --import tsx --test evals/factory-quality/tests/quality.test.ts
`;

// --- accept paths ---------------------------------------------------------

test("accepts: valid message with all three fields", () => {
  const r = runHook(goodMsg);
  assert.equal(r.status, 0, r.stderr);
});

test("accepts: extra whitespace and blank lines around fields", () => {
  const msg = `chore: update something

Session:    claude-x-2026-04-26
Scope:      something
Verification:    ran tests
`;
  const r = runHook(msg);
  assert.equal(r.status, 0, r.stderr);
});

test("accepts: fields appear among other body lines", () => {
  const msg = `fix: tweak X

Some prose explaining the change in detail across
multiple lines so the audit fields are sandwiched.

Session: claude-x
Scope: y
Verification: z

Co-authored-by: somebody
`;
  const r = runHook(msg);
  assert.equal(r.status, 0, r.stderr);
});

test("accepts: ignores git-comment lines starting with #", () => {
  const msg = `feat: do thing

# Please enter the commit message for your changes. Lines starting
# with '#' will be ignored, and an empty message aborts the commit.
Session: claude-x
Scope: y
Verification: z
`;
  const r = runHook(msg);
  assert.equal(r.status, 0, r.stderr);
});

// --- reject paths ---------------------------------------------------------

test("rejects: missing Session", () => {
  const msg = `feat: x

Scope: y
Verification: z
`;
  const r = runHook(msg);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /missing required field\(s\): Session/);
});

test("rejects: missing Scope", () => {
  const msg = `feat: x

Session: claude-x
Verification: z
`;
  const r = runHook(msg);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /missing required field\(s\): Scope/);
});

test("rejects: missing Verification", () => {
  const msg = `feat: x

Session: claude-x
Scope: y
`;
  const r = runHook(msg);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /missing required field\(s\): Verification/);
});

test("rejects: all three missing", () => {
  const r = runHook(`feat: just a subject and nothing else\n`);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /Session/);
  assert.match(r.stderr, /Scope/);
  assert.match(r.stderr, /Verification/);
});

test("rejects: empty Session value (whitespace only)", () => {
  const msg = `feat: x

Session:
Scope: y
Verification: z
`;
  const r = runHook(msg);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /Session/);
});

test("rejects: empty Scope value", () => {
  const msg = `feat: x

Session: claude-x
Scope:
Verification: z
`;
  const r = runHook(msg);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /Scope/);
});

test("rejects: empty Verification value", () => {
  const msg = `feat: x

Session: claude-x
Scope: y
Verification:
`;
  const r = runHook(msg);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /Verification/);
});

// --- bypass paths (visible only) ------------------------------------------

test("bypass: subject prefix [no-guard] is exempt", () => {
  const msg = `[no-guard] quick human fix

no audit fields needed
`;
  const r = runHook(msg);
  assert.equal(r.status, 0, r.stderr);
});

test("no env bypass: FRONTIER_HUMAN=1 does NOT exempt (auditability requires visible markers)", () => {
  // Regression test for the PR #4 v1 invisible bypass. Setting the env var
  // must not let a missing-fields commit through; the only acceptable
  // bypasses are visible in commit history.
  const msg = `feat: x without audit fields\n`;
  const r = runHook(msg, { FRONTIER_HUMAN: "1" });
  assert.equal(r.status, 1);
});

// --- exempt paths (git-generated) -----------------------------------------

test("exempt: merge commit subject (Git generates these)", () => {
  const msg = `Merge branch 'agent/2026-04-26/factory-quality-eval' into main\n`;
  const r = runHook(msg);
  assert.equal(r.status, 0, r.stderr);
});

// --- authored commits that USED to be auto-exempt are now guarded ---------

test("rejects: Revert commit without audit fields (no longer auto-exempt)", () => {
  const msg = `Revert "feat: bad change"

This reverts commit abc123.
`;
  const r = runHook(msg);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /missing required field\(s\):/);
});

test("rejects: fixup! commit without audit fields (no longer auto-exempt)", () => {
  const r = runHook(`fixup! feat: original commit\n`);
  assert.equal(r.status, 1);
});

test("rejects: squash! commit without audit fields (no longer auto-exempt)", () => {
  const r = runHook(`squash! feat: original commit\n`);
  assert.equal(r.status, 1);
});

test("rejects: amend! commit without audit fields (no longer auto-exempt)", () => {
  const r = runHook(`amend! feat: original commit\n`);
  assert.equal(r.status, 1);
});

test("accepts: Revert / fixup! / squash! / amend! when body includes the three audit fields", () => {
  const cases = [
    `Revert "feat: bad change"

This reverts commit abc123.

Session: claude-x
Scope: revert PR #99
Verification: ran tests after revert
`,
    `fixup! feat: original commit

Session: claude-x
Scope: fix typo in PR #99
Verification: re-ran the affected tests
`,
    `squash! feat: original commit

Session: claude-x
Scope: squash follow-up into PR #99
Verification: tests still pass after squash
`,
    `amend! feat: original commit

Session: claude-x
Scope: clarify commit message in PR #99
Verification: build still passes
`,
  ];
  for (const msg of cases) {
    const r = runHook(msg);
    assert.equal(
      r.status,
      0,
      `expected accept for ${msg.split("\n")[0]}; stderr=${r.stderr}`,
    );
  }
});

// --- error case: missing/invalid input file -------------------------------

test("error: no message file argument", () => {
  const res = spawnSync(HOOK, [], { encoding: "utf8" });
  assert.equal(res.status, 1);
  assert.match(res.stderr ?? "", /no message file provided/);
});

test("error: nonexistent message file", () => {
  const res = spawnSync(HOOK, ["/nonexistent/path/MSG"], { encoding: "utf8" });
  assert.equal(res.status, 1);
});

// --- error message quality -------------------------------------------------

test("error message includes the required template and visible-only bypass docs", () => {
  const r = runHook(`feat: x without anything\n`);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /Session: <agent session id>/);
  assert.match(r.stderr, /Scope: <what this commit covers>/);
  assert.match(r.stderr, /Verification: <exact commands run>/);
  assert.match(r.stderr, /\[no-guard\]/);
  // The error message MUST NOT advertise the removed env-var bypass.
  assert.doesNotMatch(r.stderr, /FRONTIER_HUMAN/);
});

// --- regression: case sensitivity (only canonical labels accepted) --------

test("rejects: lowercase session: is not accepted (canonical label required)", () => {
  const msg = `feat: x

session: claude-x
scope: y
verification: z
`;
  const r = runHook(msg);
  assert.equal(r.status, 1);
});
