// WorktreeManager — exercises real `git worktree` against a temp git
// repo. Slower than mocked tests but the only credible way to verify
// branch creation, base-commit pinning, and diff/numstat parsing.
//
// Each test mints a fresh repo via mkdtempSync + `git init`, so the
// suite is hermetic — no leakage into the host repo's worktrees or
// branches. Cleanup is best-effort via rmSync; if a test crashes the
// temp dir leaks but won't break later runs.

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { WorktreeManager, BuilderRunError } from "../worktree-manager.ts";

// --- helpers --------------------------------------------------------------

function git(
  args: string[],
  cwd: string,
): { ok: boolean; stdout: string; stderr: string } {
  const r = spawnSync("git", args, { cwd, encoding: "utf8" });
  return {
    ok: r.status === 0,
    stdout: typeof r.stdout === "string" ? r.stdout : "",
    stderr: typeof r.stderr === "string" ? r.stderr : "",
  };
}

function makeRepo(): { repoRoot: string; cleanup: () => void } {
  const repoRoot = mkdtempSync(join(tmpdir(), "wtmgr-test-"));
  // Quiet, isolated config so the test doesn't depend on the host's
  // ~/.gitconfig (commit signing, default branch, etc.)
  const init = git(["init", "-q", "-b", "main"], repoRoot);
  if (!init.ok) throw new Error(`git init failed: ${init.stderr}`);
  git(["config", "user.email", "test@example.com"], repoRoot);
  git(["config", "user.name", "Test"], repoRoot);
  git(["config", "commit.gpgsign", "false"], repoRoot);
  writeFileSync(resolve(repoRoot, "README.md"), "# test repo\n");
  git(["add", "README.md"], repoRoot);
  const commit = git(["commit", "-q", "-m", "initial"], repoRoot);
  if (!commit.ok) throw new Error(`initial commit failed: ${commit.stderr}`);
  return {
    repoRoot,
    cleanup: () => rmSync(repoRoot, { recursive: true, force: true }),
  };
}

function buildManager(repoRoot: string): WorktreeManager {
  return new WorktreeManager({
    repoRoot,
    worktreesDir: resolve(repoRoot, ".worktrees"),
    stateDir: resolve(repoRoot, "state", "builders"),
  });
}

// --- spawn ----------------------------------------------------------------

test("spawn: creates worktree at expected path with new branch off baseBranch", () => {
  const { repoRoot, cleanup } = makeRepo();
  try {
    const mgr = buildManager(repoRoot);
    const run = mgr.spawn({
      taskId: "task-1",
      builderId: "b1",
      taskClass: "patch_builder",
      baseBranch: "main",
    });
    assert.equal(run.taskId, "task-1");
    assert.equal(run.builderId, "b1");
    assert.equal(run.taskClass, "patch_builder");
    assert.equal(run.baseBranch, "main");
    assert.equal(run.status, "spawned");
    assert.match(run.branchName, /^builders\//);
    assert.ok(existsSync(run.worktreePath));
    assert.ok(existsSync(resolve(run.worktreePath, "README.md")));

    // git sees the new branch + worktree.
    const branches = git(["branch"], repoRoot).stdout;
    assert.ok(branches.includes(run.branchName));
    const worktrees = git(["worktree", "list"], repoRoot).stdout;
    assert.ok(worktrees.includes(run.worktreePath));

    // baseCommit matches main's HEAD at spawn time.
    const mainHead = git(["rev-parse", "main"], repoRoot).stdout.trim();
    assert.equal(run.baseCommit, mainHead);
  } finally {
    cleanup();
  }
});

test("spawn: persists state file readable by get()", () => {
  const { repoRoot, cleanup } = makeRepo();
  try {
    const mgr = buildManager(repoRoot);
    const run = mgr.spawn({
      taskId: "task-1",
      builderId: "b1",
      taskClass: "patch_builder",
    });
    const reloaded = mgr.get(run.runId);
    assert.deepEqual(reloaded, run);
  } finally {
    cleanup();
  }
});

test("spawn: rejects unsafe taskId / builderId", () => {
  const { repoRoot, cleanup } = makeRepo();
  try {
    const mgr = buildManager(repoRoot);
    assert.throws(
      () =>
        mgr.spawn({
          taskId: "../etc/passwd",
          builderId: "b1",
          taskClass: "patch_builder",
        }),
      BuilderRunError,
    );
    assert.throws(
      () =>
        mgr.spawn({
          taskId: "task-1",
          builderId: "with spaces",
          taskClass: "patch_builder",
        }),
      BuilderRunError,
    );
  } finally {
    cleanup();
  }
});

test("spawn: detects current branch when baseBranch is omitted", () => {
  const { repoRoot, cleanup } = makeRepo();
  try {
    const mgr = buildManager(repoRoot);
    const run = mgr.spawn({
      taskId: "task-1",
      builderId: "b1",
      taskClass: "patch_builder",
    });
    assert.equal(run.baseBranch, "main");
  } finally {
    cleanup();
  }
});

test("spawn: includes modelKey when provided", () => {
  const { repoRoot, cleanup } = makeRepo();
  try {
    const mgr = buildManager(repoRoot);
    const run = mgr.spawn({
      taskId: "task-1",
      builderId: "b1",
      taskClass: "patch_builder",
      modelKey: "nvidia-nim:openai/gpt-oss-120b",
    });
    assert.equal(run.modelKey, "nvidia-nim:openai/gpt-oss-120b");
  } finally {
    cleanup();
  }
});

// --- list -----------------------------------------------------------------

test("list: returns all spawned runs sorted by createdAt desc", async () => {
  const { repoRoot, cleanup } = makeRepo();
  try {
    const mgr = buildManager(repoRoot);
    const r1 = mgr.spawn({
      taskId: "t1",
      builderId: "b1",
      taskClass: "patch_builder",
    });
    // Sleep 10ms to ensure distinct timestamps.
    await new Promise((res) => setTimeout(res, 10));
    const r2 = mgr.spawn({
      taskId: "t2",
      builderId: "b2",
      taskClass: "patch_builder",
    });
    const runs = mgr.list();
    assert.equal(runs.length, 2);
    assert.equal(runs[0]!.runId, r2.runId);
    assert.equal(runs[1]!.runId, r1.runId);
  } finally {
    cleanup();
  }
});

test("list: empty when no runs spawned", () => {
  const { repoRoot, cleanup } = makeRepo();
  try {
    const mgr = buildManager(repoRoot);
    assert.deepEqual(mgr.list(), []);
  } finally {
    cleanup();
  }
});

// --- collect --------------------------------------------------------------

test("collect: captures unified diff, files, addedLines/deletedLines, commitCount", () => {
  const { repoRoot, cleanup } = makeRepo();
  try {
    const mgr = buildManager(repoRoot);
    const run = mgr.spawn({
      taskId: "t1",
      builderId: "b1",
      taskClass: "patch_builder",
    });
    // Make a 2-line addition + commit inside the worktree.
    writeFileSync(
      resolve(run.worktreePath, "added.ts"),
      "export const x = 1;\nexport const y = 2;\n",
    );
    git(["add", "added.ts"], run.worktreePath);
    const commitRes = git(
      ["commit", "-q", "-m", "add x and y"],
      run.worktreePath,
    );
    assert.ok(commitRes.ok, `commit failed: ${commitRes.stderr}`);

    const collected = mgr.collect(run.runId);
    assert.equal(collected.status, "collected");
    assert.ok(collected.collectedAt);
    assert.ok(collected.patch);
    assert.deepEqual(collected.patch?.files, ["added.ts"]);
    assert.equal(collected.patch?.addedLines, 2);
    assert.equal(collected.patch?.deletedLines, 0);
    assert.equal(collected.patch?.commitCount, 1);
    assert.ok((collected.patch?.sizeBytes ?? 0) > 0);
    assert.ok(collected.patch?.diff.includes("export const x"));
  } finally {
    cleanup();
  }
});

test("collect: empty diff when no edits made", () => {
  const { repoRoot, cleanup } = makeRepo();
  try {
    const mgr = buildManager(repoRoot);
    const run = mgr.spawn({
      taskId: "t1",
      builderId: "b1",
      taskClass: "patch_builder",
    });
    const collected = mgr.collect(run.runId);
    assert.equal(collected.status, "collected");
    assert.deepEqual(collected.patch?.files, []);
    assert.equal(collected.patch?.addedLines, 0);
    assert.equal(collected.patch?.commitCount, 0);
  } finally {
    cleanup();
  }
});

test("collect: throws BuilderRunError on unknown runId", () => {
  const { repoRoot, cleanup } = makeRepo();
  try {
    const mgr = buildManager(repoRoot);
    assert.throws(() => mgr.collect("does-not-exist"), BuilderRunError);
  } finally {
    cleanup();
  }
});

// --- remove ---------------------------------------------------------------

test("remove: deletes worktree dir and branch, marks status=cleaned, keeps state file", () => {
  const { repoRoot, cleanup } = makeRepo();
  try {
    const mgr = buildManager(repoRoot);
    const run = mgr.spawn({
      taskId: "t1",
      builderId: "b1",
      taskClass: "patch_builder",
    });
    const removed = mgr.remove(run.runId);
    assert.equal(removed.status, "cleaned");
    assert.ok(removed.cleanedAt);
    assert.equal(existsSync(run.worktreePath), false);
    const branches = git(["branch"], repoRoot).stdout;
    assert.ok(!branches.includes(run.branchName));
    // State file still exists for the audit trail.
    const reloaded = mgr.get(run.runId);
    assert.equal(reloaded?.status, "cleaned");
  } finally {
    cleanup();
  }
});

test("remove: force=true removes worktree with uncommitted changes", () => {
  const { repoRoot, cleanup } = makeRepo();
  try {
    const mgr = buildManager(repoRoot);
    const run = mgr.spawn({
      taskId: "t1",
      builderId: "b1",
      taskClass: "patch_builder",
    });
    writeFileSync(
      resolve(run.worktreePath, "dirty.ts"),
      "// uncommitted edit\n",
    );
    // Without --force this would fail. With --force it succeeds.
    const removed = mgr.remove(run.runId, { force: true });
    assert.equal(removed.status, "cleaned");
    assert.equal(existsSync(run.worktreePath), false);
  } finally {
    cleanup();
  }
});

test("remove: throws BuilderRunError on unknown runId", () => {
  const { repoRoot, cleanup } = makeRepo();
  try {
    const mgr = buildManager(repoRoot);
    assert.throws(() => mgr.remove("does-not-exist"), BuilderRunError);
  } finally {
    cleanup();
  }
});

// --- end-to-end -----------------------------------------------------------

test("end-to-end: spawn → edit → commit → collect → remove", () => {
  const { repoRoot, cleanup } = makeRepo();
  try {
    const mgr = buildManager(repoRoot);
    const run = mgr.spawn({
      taskId: "e2e",
      builderId: "b1",
      taskClass: "patch_builder",
      modelKey: "nvidia-nim:openai/gpt-oss-120b",
    });
    writeFileSync(
      resolve(run.worktreePath, "feature.ts"),
      "export function add(a: number, b: number) { return a + b; }\n",
    );
    git(["add", "feature.ts"], run.worktreePath);
    git(["commit", "-q", "-m", "add(): scalar addition"], run.worktreePath);

    const collected = mgr.collect(run.runId);
    assert.equal(collected.status, "collected");
    assert.deepEqual(collected.patch?.files, ["feature.ts"]);
    assert.equal(collected.patch?.commitCount, 1);

    const removed = mgr.remove(collected.runId);
    assert.equal(removed.status, "cleaned");
    assert.equal(existsSync(removed.worktreePath), false);

    // Final state still has the patch captured.
    const final = mgr.get(removed.runId);
    assert.equal(final?.status, "cleaned");
    assert.equal(final?.patch?.commitCount, 1);
  } finally {
    cleanup();
  }
});
