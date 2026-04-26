// Builder swarm tests — orchestration with stubs + one real-git e2e.

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { runBuilderSwarm, BuilderSwarmError } from "../builder-swarm.ts";
import type {
  AttemptRecord,
  BrokerCallOptions,
  BrokerCallResult,
  InferenceBroker,
} from "../../inference/broker.ts";
import { WorktreeManager } from "../../builders/worktree-manager.ts";
import type { BuilderRun } from "../../builders/types.ts";
import type { Skill } from "../../skills/loader.ts";

// --- helpers --------------------------------------------------------------

function syntheticSkill(): Skill {
  return {
    skillId: "patch_builder",
    version: "v1",
    taskClass: "patch_builder",
    summary: "test",
    allowedRoles: ["builder"],
    allowedTools: ["read.file", "write.worktree", "exec.test"],
    forbiddenTools: ["exec.git.push", "launchd.apply"],
    maxParallel: 4,
    sideEffects: ["local_write"],
    verifierMode: "required",
    promptTemplate: "SKILL.md",
    antiExamples: [],
    skillDir: "/tmp/synthetic-skill",
    promptTemplatePath: "/tmp/synthetic-skill/SKILL.md",
  };
}

const TEMPLATE = [
  "Builder {{builderId}} of {{builderCount}} for {{taskId}}.",
  "Worktree: {{worktreePath}}",
  "Task:",
  "{{taskDescription}}",
  "Touch list: {{touchList}}",
].join("\n");

const SAMPLE_DIFF = `diff --git a/added.ts b/added.ts
new file mode 100644
index 0000000..ce01362
--- /dev/null
+++ b/added.ts
@@ -0,0 +1 @@
+export const v = 42;
`;

class StubBroker implements Pick<InferenceBroker, "callClass"> {
  private queue: Array<Partial<AttemptRecord> | { throw: Error } | "empty"> =
    [];
  private modelKey = "stub:m1";

  enqueue(
    ...responses: Array<Partial<AttemptRecord> | { throw: Error } | "empty">
  ): void {
    this.queue.push(...responses);
  }

  setModelKey(k: string): void {
    this.modelKey = k;
  }

  queueRemaining(): number {
    return this.queue.length;
  }

  async callClass(opts: BrokerCallOptions): Promise<BrokerCallResult> {
    const next = this.queue.shift();
    if (next === undefined || next === "empty") {
      return {
        ok: false,
        taskClass: opts.taskClass,
        attempts: [],
        selected: null,
        totalDurationMs: 1,
        rejected: "all-attempts-failed",
      };
    }
    if (typeof next === "object" && next !== null && "throw" in next) {
      throw next.throw;
    }
    const r = next as Partial<AttemptRecord>;
    const record: AttemptRecord = {
      modelKey: r.modelKey ?? this.modelKey,
      provider: "stub",
      model: "m1",
      attemptNumber: 1,
      bucketGranted: true,
      bucketWaitedMs: 0,
      status: r.status ?? 200,
      ok: r.ok ?? true,
      durationMs: r.durationMs ?? 5,
      retryAfterMs: null,
      ...(r.assistantText !== undefined
        ? { assistantText: r.assistantText }
        : {}),
      ...(r.body !== undefined ? { body: r.body } : {}),
    };
    return {
      ok: record.ok,
      taskClass: opts.taskClass,
      attempts: [record],
      selected: record.ok ? record : null,
      totalDurationMs: record.durationMs,
      rejected: record.ok ? null : "all-attempts-failed",
    };
  }
}

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
  const repoRoot = mkdtempSync(join(tmpdir(), "swarm-test-"));
  git(["init", "-q", "-b", "main"], repoRoot);
  git(["config", "user.email", "test@example.com"], repoRoot);
  git(["config", "user.name", "Test"], repoRoot);
  git(["config", "commit.gpgsign", "false"], repoRoot);
  writeFileSync(resolve(repoRoot, "README.md"), "# test\n");
  git(["add", "README.md"], repoRoot);
  git(["commit", "-q", "-m", "initial"], repoRoot);
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

// --- input validation ----------------------------------------------------

test("runBuilderSwarm: builderCount < 1 throws BuilderSwarmError", async () => {
  const broker = new StubBroker();
  const { repoRoot, cleanup } = makeRepo();
  try {
    await assert.rejects(
      () =>
        runBuilderSwarm(
          {
            broker: broker as unknown as InferenceBroker,
            worktreeManager: buildManager(repoRoot),
          },
          {
            taskId: "t1",
            taskDescription: "do thing",
            builderCount: 0,
            loadSkillImpl: () => syntheticSkill(),
            loadPromptTemplateImpl: () => TEMPLATE,
          },
        ),
      BuilderSwarmError,
    );
  } finally {
    cleanup();
  }
});

test("runBuilderSwarm: missing skill throws", async () => {
  const broker = new StubBroker();
  const { repoRoot, cleanup } = makeRepo();
  try {
    await assert.rejects(
      () =>
        runBuilderSwarm(
          {
            broker: broker as unknown as InferenceBroker,
            worktreeManager: buildManager(repoRoot),
          },
          {
            taskId: "t1",
            taskDescription: "do thing",
            builderCount: 1,
            taskClass: "no_such",
            loadSkillImpl: () => null,
            loadPromptTemplateImpl: () => TEMPLATE,
          },
        ),
      /no skill found/,
    );
  } finally {
    cleanup();
  }
});

// --- failure paths -------------------------------------------------------

test("runBuilderSwarm: broker rejection → candidate.phase=broker_failed", async () => {
  const broker = new StubBroker();
  broker.enqueue("empty");
  const { repoRoot, cleanup } = makeRepo();
  try {
    const packet = await runBuilderSwarm(
      {
        broker: broker as unknown as InferenceBroker,
        worktreeManager: buildManager(repoRoot),
      },
      {
        taskId: "t1",
        taskDescription: "do thing",
        builderCount: 1,
        loadSkillImpl: () => syntheticSkill(),
        loadPromptTemplateImpl: () => TEMPLATE,
      },
    );
    assert.equal(packet.candidates.length, 1);
    assert.equal(packet.candidates[0]?.ok, false);
    assert.equal(packet.candidates[0]?.phase, "broker_failed");
    assert.match(packet.candidates[0]?.errorMessage ?? "", /broker rejected/);
  } finally {
    cleanup();
  }
});

test("runBuilderSwarm: broker exception → candidate.phase=broker_failed with exception text", async () => {
  const broker = new StubBroker();
  broker.enqueue({ throw: new Error("network down") });
  const { repoRoot, cleanup } = makeRepo();
  try {
    const packet = await runBuilderSwarm(
      {
        broker: broker as unknown as InferenceBroker,
        worktreeManager: buildManager(repoRoot),
      },
      {
        taskId: "t1",
        taskDescription: "do thing",
        builderCount: 1,
        loadSkillImpl: () => syntheticSkill(),
        loadPromptTemplateImpl: () => TEMPLATE,
      },
    );
    assert.equal(packet.candidates[0]?.phase, "broker_failed");
    assert.match(packet.candidates[0]?.errorMessage ?? "", /network down/);
  } finally {
    cleanup();
  }
});

test("runBuilderSwarm: broker text without a diff → candidate.phase=no_diff_extracted, rawText preserved", async () => {
  const broker = new StubBroker();
  broker.enqueue({
    ok: true,
    assistantText: "I would change the function but I'm not sure how.",
  });
  const { repoRoot, cleanup } = makeRepo();
  try {
    const packet = await runBuilderSwarm(
      {
        broker: broker as unknown as InferenceBroker,
        worktreeManager: buildManager(repoRoot),
      },
      {
        taskId: "t1",
        taskDescription: "do thing",
        builderCount: 1,
        loadSkillImpl: () => syntheticSkill(),
        loadPromptTemplateImpl: () => TEMPLATE,
      },
    );
    const c = packet.candidates[0];
    assert.equal(c?.phase, "no_diff_extracted");
    assert.equal(c?.ok, false);
    assert.match(c?.rawText ?? "", /not sure how/);
  } finally {
    cleanup();
  }
});

test("runBuilderSwarm: diff that doesn't apply → candidate.phase=apply_failed", async () => {
  const broker = new StubBroker();
  // A diff that touches a file that doesn't exist with the expected
  // content — git apply will reject.
  const badDiff = `\`\`\`diff
diff --git a/missing.ts b/missing.ts
index aaa..bbb 100644
--- a/missing.ts
+++ b/missing.ts
@@ -1 +1,2 @@
 already-here
+new-line
\`\`\``;
  broker.enqueue({ ok: true, assistantText: badDiff });
  const { repoRoot, cleanup } = makeRepo();
  try {
    const packet = await runBuilderSwarm(
      {
        broker: broker as unknown as InferenceBroker,
        worktreeManager: buildManager(repoRoot),
      },
      {
        taskId: "t1",
        taskDescription: "do thing",
        builderCount: 1,
        loadSkillImpl: () => syntheticSkill(),
        loadPromptTemplateImpl: () => TEMPLATE,
      },
    );
    assert.equal(packet.candidates[0]?.phase, "apply_failed");
    assert.equal(packet.candidates[0]?.ok, false);
    assert.match(packet.candidates[0]?.errorMessage ?? "", /git apply/);
  } finally {
    cleanup();
  }
});

// --- happy path (real git) -----------------------------------------------

test("runBuilderSwarm: end-to-end one builder applies + commits + collects", async () => {
  const broker = new StubBroker();
  broker.enqueue({
    ok: true,
    assistantText: `Here's the patch:\n\n\`\`\`diff\n${SAMPLE_DIFF}\`\`\``,
  });
  const { repoRoot, cleanup } = makeRepo();
  try {
    const packet = await runBuilderSwarm(
      {
        broker: broker as unknown as InferenceBroker,
        worktreeManager: buildManager(repoRoot),
      },
      {
        taskId: "t1",
        taskDescription: "add v=42",
        builderCount: 1,
        baseBranch: "main",
        loadSkillImpl: () => syntheticSkill(),
        loadPromptTemplateImpl: () => TEMPLATE,
      },
    );
    const c = packet.candidates[0];
    assert.equal(c?.ok, true);
    assert.equal(c?.phase, "collected");
    assert.ok(c?.patch);
    assert.deepEqual(c?.patch?.files, ["added.ts"]);
    assert.equal(c?.patch?.commitCount, 1);
    assert.equal(c?.patch?.addedLines, 1);
    assert.equal(packet.modelsUsed.length, 1);
  } finally {
    cleanup();
  }
});

test("runBuilderSwarm: end-to-end three builders, mixed success", async () => {
  const broker = new StubBroker();
  // Builder 1: real diff → succeeds
  broker.enqueue({
    ok: true,
    modelKey: "stub:fast",
    assistantText: `\`\`\`diff\n${SAMPLE_DIFF}\`\`\``,
  });
  // Builder 2: broker rejects (empty queue → all-attempts-failed)
  broker.enqueue("empty");
  // Builder 3: text without diff
  broker.enqueue({
    ok: true,
    modelKey: "stub:slow",
    assistantText: "I cannot determine the right change.",
  });
  const { repoRoot, cleanup } = makeRepo();
  try {
    const packet = await runBuilderSwarm(
      {
        broker: broker as unknown as InferenceBroker,
        worktreeManager: buildManager(repoRoot),
      },
      {
        taskId: "t1",
        taskDescription: "add v=42",
        builderCount: 3,
        baseBranch: "main",
        loadSkillImpl: () => syntheticSkill(),
        loadPromptTemplateImpl: () => TEMPLATE,
      },
    );
    assert.equal(packet.candidates.length, 3);
    const collected = packet.candidates.filter((c) => c.phase === "collected");
    const brokerFailed = packet.candidates.filter(
      (c) => c.phase === "broker_failed",
    );
    const noDiff = packet.candidates.filter(
      (c) => c.phase === "no_diff_extracted",
    );
    assert.equal(collected.length, 1);
    assert.equal(brokerFailed.length, 1);
    assert.equal(noDiff.length, 1);
    // Two reviewers had a model assigned; one was empty (no model).
    assert.deepEqual(packet.modelsUsed, ["stub:fast", "stub:slow"]);
  } finally {
    cleanup();
  }
});

// --- packet shape --------------------------------------------------------

test("runBuilderSwarm: packet validates against builder-swarm-packet schema", async () => {
  const { validateBuilderSwarmPacket } = await import("../../schemas.ts");
  const broker = new StubBroker();
  for (let i = 0; i < 2; i++) {
    broker.enqueue({
      ok: true,
      assistantText: `\`\`\`diff\n${SAMPLE_DIFF}\`\`\``,
    });
  }
  const { repoRoot, cleanup } = makeRepo();
  try {
    const packet = await runBuilderSwarm(
      {
        broker: broker as unknown as InferenceBroker,
        worktreeManager: buildManager(repoRoot),
      },
      {
        taskId: "t1",
        taskDescription: "add v=42",
        builderCount: 2,
        baseBranch: "main",
        loadSkillImpl: () => syntheticSkill(),
        loadPromptTemplateImpl: () => TEMPLATE,
      },
    );
    const valid = validateBuilderSwarmPacket(packet);
    if (!valid) {
      console.error(JSON.stringify(validateBuilderSwarmPacket.errors, null, 2));
    }
    assert.equal(valid, true);
  } finally {
    cleanup();
  }
});

test("runBuilderSwarm: pinned modelKeys carry through to BuilderRun", async () => {
  const broker = new StubBroker();
  broker.enqueue({
    ok: true,
    modelKey: "stub:m1",
    assistantText: `\`\`\`diff\n${SAMPLE_DIFF}\`\`\``,
  });
  broker.enqueue({
    ok: true,
    modelKey: "stub:m2",
    assistantText: `\`\`\`diff\n${SAMPLE_DIFF}\`\`\``,
  });
  const { repoRoot, cleanup } = makeRepo();
  try {
    const mgr = buildManager(repoRoot);
    const packet = await runBuilderSwarm(
      {
        broker: broker as unknown as InferenceBroker,
        worktreeManager: mgr,
      },
      {
        taskId: "t1",
        taskDescription: "add v=42",
        builderCount: 2,
        baseBranch: "main",
        modelKeys: ["pinned:k1", "pinned:k2"],
        loadSkillImpl: () => syntheticSkill(),
        loadPromptTemplateImpl: () => TEMPLATE,
      },
    );
    // Each candidate's BuilderRun (loaded from state) should have the
    // pinned modelKey, even though the broker reported a different key.
    const runs = packet.candidates.map((c) => mgr.get(c.runId ?? ""));
    assert.equal(runs[0]?.modelKey, "pinned:k1");
    assert.equal(runs[1]?.modelKey, "pinned:k2");
  } finally {
    cleanup();
  }
});

test("runBuilderSwarm: spawn failure surfaces as candidate.phase=spawn_failed without crashing the swarm", async () => {
  const broker = new StubBroker();
  broker.enqueue({
    ok: true,
    assistantText: `\`\`\`diff\n${SAMPLE_DIFF}\`\`\``,
  });
  const { repoRoot, cleanup } = makeRepo();
  try {
    const mgr = buildManager(repoRoot);
    // Force spawn() to throw by passing an invalid taskId at the swarm
    // level — slug-safety check rejects it before any worktree work.
    const packet = await runBuilderSwarm(
      {
        broker: broker as unknown as InferenceBroker,
        worktreeManager: mgr,
      },
      {
        taskId: "../etc/passwd", // unsafe — WorktreeManager.spawn will throw
        taskDescription: "x",
        builderCount: 1,
        loadSkillImpl: () => syntheticSkill(),
        loadPromptTemplateImpl: () => TEMPLATE,
      },
    );
    assert.equal(packet.candidates[0]?.phase, "spawn_failed");
    assert.equal(packet.candidates[0]?.ok, false);
    // No worktree path because spawn never returned.
    assert.equal(packet.candidates[0]?.worktreePath, undefined);
    // Broker was never queried — queue still full.
    assert.equal(broker.queueRemaining(), 1);
  } finally {
    cleanup();
  }
});

// --- aggregation ---------------------------------------------------------

test("runBuilderSwarm: modelsUsed dedupes and sorts", async () => {
  const broker = new StubBroker();
  broker.enqueue({
    ok: true,
    modelKey: "z:m",
    assistantText: `\`\`\`diff\n${SAMPLE_DIFF}\`\`\``,
  });
  broker.enqueue({
    ok: true,
    modelKey: "a:m",
    assistantText: `\`\`\`diff\n${SAMPLE_DIFF}\`\`\``,
  });
  broker.enqueue({
    ok: true,
    modelKey: "z:m",
    assistantText: `\`\`\`diff\n${SAMPLE_DIFF}\`\`\``,
  });
  const { repoRoot, cleanup } = makeRepo();
  try {
    const packet = await runBuilderSwarm(
      {
        broker: broker as unknown as InferenceBroker,
        worktreeManager: buildManager(repoRoot),
      },
      {
        taskId: "t1",
        taskDescription: "x",
        builderCount: 3,
        loadSkillImpl: () => syntheticSkill(),
        loadPromptTemplateImpl: () => TEMPLATE,
      },
    );
    assert.deepEqual(packet.modelsUsed, ["a:m", "z:m"]);
  } finally {
    cleanup();
  }
});
