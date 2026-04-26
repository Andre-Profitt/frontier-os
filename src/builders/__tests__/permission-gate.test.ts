// PermissionGate — pure logic, no fs/subprocess.
//
// Test inputs use synthetic Skill objects rather than reading from
// skills/ — keeps the gate test orthogonal to the loader test, so a
// loader bug doesn't cascade into gate failures.

import { test } from "node:test";
import assert from "node:assert/strict";
import { resolve } from "node:path";

import { PermissionGate } from "../permission-gate.ts";
import type { Skill } from "../../skills/loader.ts";

function syntheticSkill(overrides: Partial<Skill> = {}): Skill {
  return {
    skillId: "test_skill",
    version: "v1",
    taskClass: "test_class",
    summary: "synthetic skill for unit testing the gate",
    allowedRoles: ["builder"],
    allowedTools: ["read.file", "write.worktree", "exec.test"],
    forbiddenTools: ["exec.git.push", "launchd.apply"],
    maxParallel: 1,
    sideEffects: ["local_write"],
    verifierMode: "required",
    promptTemplate: "SKILL.md",
    antiExamples: [],
    skillDir: "/tmp/synthetic",
    promptTemplatePath: "/tmp/synthetic/SKILL.md",
    ...overrides,
  };
}

// --- forbiddenTools wins ---------------------------------------------------

test("forbidden tool denies even if also in allowedTools (defense in depth)", () => {
  const gate = new PermissionGate({
    skill: syntheticSkill({
      // Note: the loader rejects this overlap at load time, but the gate
      // must still defend against a hand-constructed skill.
      allowedTools: ["read.file", "exec.git.push"],
      forbiddenTools: ["exec.git.push"],
    }),
    worktreePath: "/tmp/worker-1",
  });
  const decision = gate.check({ tool: "exec.git.push" });
  assert.equal(decision.allowed, false);
  assert.match(decision.reason, /forbiddenTools/);
});

test("forbidden tool denies before allow-list check", () => {
  const gate = new PermissionGate({
    skill: syntheticSkill(),
    worktreePath: "/tmp/worker-1",
  });
  const decision = gate.check({ tool: "launchd.apply" });
  assert.equal(decision.allowed, false);
  assert.match(decision.reason, /forbiddenTools/);
});

// --- closed-by-default ----------------------------------------------------

test("tool not in either list is denied (closed-by-default)", () => {
  const gate = new PermissionGate({
    skill: syntheticSkill(),
    worktreePath: "/tmp/worker-1",
  });
  const decision = gate.check({ tool: "imaginary.tool" });
  assert.equal(decision.allowed, false);
  assert.match(decision.reason, /not in allowedTools/);
});

// --- allowed tool ---------------------------------------------------------

test("allowed tool returns allowed=true", () => {
  const gate = new PermissionGate({
    skill: syntheticSkill(),
    worktreePath: "/tmp/worker-1",
  });
  const decision = gate.check({ tool: "read.file" });
  assert.equal(decision.allowed, true);
});

// --- write.worktree fs-scope check ----------------------------------------

test("write.worktree without path is denied", () => {
  const gate = new PermissionGate({
    skill: syntheticSkill(),
    worktreePath: "/tmp/worker-1",
  });
  const decision = gate.check({ tool: "write.worktree" });
  assert.equal(decision.allowed, false);
  assert.match(decision.reason, /requires a path/);
});

test("write.worktree path inside worktree is allowed", () => {
  const root = resolve("/tmp/worker-1");
  const gate = new PermissionGate({
    skill: syntheticSkill(),
    worktreePath: root,
  });
  const decision = gate.check({
    tool: "write.worktree",
    path: `${root}/src/foo.ts`,
  });
  assert.equal(decision.allowed, true);
});

test("write.worktree path outside worktree is denied", () => {
  const gate = new PermissionGate({
    skill: syntheticSkill(),
    worktreePath: "/tmp/worker-1",
  });
  const decision = gate.check({
    tool: "write.worktree",
    path: "/tmp/elsewhere/foo.ts",
  });
  assert.equal(decision.allowed, false);
  assert.match(decision.reason, /outside/);
});

test("write.worktree path equal to worktreePath is allowed", () => {
  const root = resolve("/tmp/worker-1");
  const gate = new PermissionGate({
    skill: syntheticSkill(),
    worktreePath: root,
  });
  const decision = gate.check({ tool: "write.worktree", path: root });
  assert.equal(decision.allowed, true);
});

test("write.worktree under extraWritablePaths is allowed", () => {
  const gate = new PermissionGate({
    skill: syntheticSkill(),
    worktreePath: "/tmp/worker-1",
    extraWritablePaths: ["/tmp/scratch"],
  });
  const decision = gate.check({
    tool: "write.worktree",
    path: "/tmp/scratch/notes.md",
  });
  assert.equal(decision.allowed, true);
});

// --- prefix-substring guard (no /tmp/worker-1-other false-allow) ----------

test("write.worktree path that is a prefix-substring of worktreePath is denied", () => {
  // Without the trailing-sep guard, /tmp/worker-1-other would startsWith
  // /tmp/worker-1 and falsely allow.
  const gate = new PermissionGate({
    skill: syntheticSkill(),
    worktreePath: "/tmp/worker-1",
  });
  const decision = gate.check({
    tool: "write.worktree",
    path: "/tmp/worker-1-other/file.ts",
  });
  assert.equal(decision.allowed, false);
});

// --- isInsideWritablePath helper ------------------------------------------

test("isInsideWritablePath: worktree root → true", () => {
  const gate = new PermissionGate({
    skill: syntheticSkill(),
    worktreePath: "/tmp/worker-1",
  });
  assert.equal(gate.isInsideWritablePath("/tmp/worker-1"), true);
});

test("isInsideWritablePath: nested file → true", () => {
  const gate = new PermissionGate({
    skill: syntheticSkill(),
    worktreePath: "/tmp/worker-1",
  });
  assert.equal(
    gate.isInsideWritablePath("/tmp/worker-1/src/builders/foo.ts"),
    true,
  );
});

test("isInsideWritablePath: parent dir → false", () => {
  const gate = new PermissionGate({
    skill: syntheticSkill(),
    worktreePath: "/tmp/worker-1",
  });
  assert.equal(gate.isInsideWritablePath("/tmp"), false);
});
