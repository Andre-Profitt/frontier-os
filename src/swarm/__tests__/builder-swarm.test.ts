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

// Stub inputs may pass `assistantText` or `body` (test convenience); the
// stub constructs a proper BrokerCallResult including selectedResponse.
// modelOverride is captured per-call so tests can assert pinning works.
interface StubResponse {
  ok?: boolean;
  status?: number;
  modelKey?: string;
  durationMs?: number;
  assistantText?: string;
  body?: unknown;
}

class StubBroker implements Pick<InferenceBroker, "callClass"> {
  private queue: Array<StubResponse | { throw: Error } | "empty"> = [];
  private modelKey = "stub:m1";
  // Per-call snapshot of (taskClass, modelOverride) — used by Patch C
  // tests to assert each builder routed to its pinned model.
  public callLog: Array<{ taskClass: string; modelOverride?: string }> = [];

  enqueue(
    ...responses: Array<StubResponse | { throw: Error } | "empty">
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
    const logEntry: { taskClass: string; modelOverride?: string } = {
      taskClass: opts.taskClass,
    };
    if (opts.modelOverride !== undefined) {
      logEntry.modelOverride = opts.modelOverride;
    }
    this.callLog.push(logEntry);
    const next = this.queue.shift();
    if (next === undefined || next === "empty") {
      return {
        ok: false,
        taskClass: opts.taskClass,
        attempts: [],
        selected: null,
        selectedResponse: null,
        totalDurationMs: 1,
        rejected: "all-attempts-failed",
      };
    }
    if (typeof next === "object" && next !== null && "throw" in next) {
      throw next.throw;
    }
    const r = next as StubResponse;
    // When modelOverride is set, the broker would echo that back as the
    // selected.modelKey. Mirror that in the stub so tests asserting
    // pinning see the right value.
    const effectiveModelKey = opts.modelOverride ?? r.modelKey ?? this.modelKey;
    const record: AttemptRecord = {
      modelKey: effectiveModelKey,
      provider: "stub",
      model: "m1",
      attemptNumber: 1,
      bucketGranted: true,
      bucketWaitedMs: 0,
      status: r.status ?? 200,
      ok: r.ok ?? true,
      durationMs: r.durationMs ?? 5,
      retryAfterMs: null,
    };
    let selectedResponse = null;
    if (record.ok) {
      const text =
        r.assistantText ??
        (r.body !== undefined && r.body !== null ? JSON.stringify(r.body) : "");
      selectedResponse = { text, rawBody: r.body ?? null };
    }
    return {
      ok: record.ok,
      taskClass: opts.taskClass,
      attempts: [record],
      selected: record.ok ? record : null,
      selectedResponse,
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
        // Patch E2: scope the diff explicitly so we exercise the
        // apply_failed path (not the new pre-apply scope_rejected).
        touchList: ["missing.ts"],
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
        // Patch E2: SAMPLE_DIFF touches added.ts, so scope to that.
        touchList: ["added.ts"],
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
        // Patch E2: scope explicitly so b1's diff applies and b3's
        // no-diff path still surfaces.
        touchList: ["added.ts"],
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

// --- model pinning (Patch C / GPT Pro Issue #1) --------------------------

test("runBuilderSwarm: pinned modelKeys are passed to broker.callClass({modelOverride}) per builder", async () => {
  const broker = new StubBroker();
  // The stub now echoes back the modelOverride as selected.modelKey,
  // which is exactly what the real broker does with modelOverride. So
  // each candidate's modelKey should match the pinned key.
  for (let i = 0; i < 3; i++) {
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
        taskId: "pin",
        taskDescription: "pinning test",
        builderCount: 3,
        baseBranch: "main",
        modelKeys: ["pinned:k1", "pinned:k2", "pinned:k3"],
        loadSkillImpl: () => syntheticSkill(),
        loadPromptTemplateImpl: () => TEMPLATE,
      },
    );
    // The broker received modelOverride for each builder.
    const overrides = broker.callLog
      .map((c) => c.modelOverride)
      .filter((m): m is string => m !== undefined)
      .sort();
    assert.deepEqual(overrides, ["pinned:k1", "pinned:k2", "pinned:k3"]);
    // The candidates' modelKey reflects the pinned model (echoed by stub).
    const modelKeys = packet.candidates.map((c) => c.modelKey).sort();
    assert.deepEqual(modelKeys, ["pinned:k1", "pinned:k2", "pinned:k3"]);
    // The packet's modelsUsed roster also reflects the pinned models.
    assert.deepEqual(packet.modelsUsed, [
      "pinned:k1",
      "pinned:k2",
      "pinned:k3",
    ]);
  } finally {
    cleanup();
  }
});

test("runBuilderSwarm: when modelKeys is omitted, broker is called WITHOUT modelOverride", async () => {
  // Sanity check: if the caller doesn't pin, the broker is free to pick
  // any model in the class (the legacy behavior). Asserts that
  // modelOverride is not silently set.
  const broker = new StubBroker();
  broker.enqueue({
    ok: true,
    assistantText: `\`\`\`diff\n${SAMPLE_DIFF}\`\`\``,
  });
  const { repoRoot, cleanup } = makeRepo();
  try {
    await runBuilderSwarm(
      {
        broker: broker as unknown as InferenceBroker,
        worktreeManager: buildManager(repoRoot),
      },
      {
        taskId: "nopin",
        taskDescription: "no pin",
        builderCount: 1,
        baseBranch: "main",
        loadSkillImpl: () => syntheticSkill(),
        loadPromptTemplateImpl: () => TEMPLATE,
      },
    );
    assert.equal(broker.callLog.length, 1);
    assert.equal(broker.callLog[0]?.modelOverride, undefined);
  } finally {
    cleanup();
  }
});

// --- scope gate (Patch C / GPT Pro Issue #4) -----------------------------

test("runBuilderSwarm: diff outside touchList → phase=scope_rejected, git apply not called, rawText preserved", async () => {
  const broker = new StubBroker();
  // Diff touches added.ts; touchList only allows lib/foo.ts.
  broker.enqueue({
    ok: true,
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
        taskId: "scope",
        taskDescription: "model patches the wrong file",
        touchList: ["lib/foo.ts"], // SAMPLE_DIFF touches added.ts, NOT in scope
        builderCount: 1,
        baseBranch: "main",
        loadSkillImpl: () => syntheticSkill(),
        loadPromptTemplateImpl: () => TEMPLATE,
      },
    );
    const c = packet.candidates[0];
    assert.equal(c?.phase, "scope_rejected");
    assert.equal(c?.ok, false);
    assert.match(c?.errorMessage ?? "", /scope rejected|outside_touch_list/);
    assert.match(c?.rawText ?? "", /added\.ts/);
    // No patch attempted — worktree stays empty.
    assert.equal(c?.patch, undefined);
  } finally {
    cleanup();
  }
});

test("runBuilderSwarm: diff inside touchList → applies, commits, collects (scope gate is permissive when allowed)", async () => {
  const broker = new StubBroker();
  broker.enqueue({
    ok: true,
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
        taskId: "scope-ok",
        taskDescription: "model patches the right file",
        touchList: ["added.ts"],
        builderCount: 1,
        baseBranch: "main",
        loadSkillImpl: () => syntheticSkill(),
        loadPromptTemplateImpl: () => TEMPLATE,
      },
    );
    assert.equal(packet.candidates[0]?.phase, "collected");
    assert.equal(packet.candidates[0]?.ok, true);
  } finally {
    cleanup();
  }
});

// --- Patch E2 / GPT Pro Blocker #2: explicit unscoped-diff opt-in ----

test("runBuilderSwarm: empty touchList without allowUnscopedDiff → scope_rejected (default deny)", async () => {
  // Pre-Patch-E2 the gate silently disabled itself on empty touchList,
  // making the swarm look scope-controlled when it wasn't. v2 default-
  // denies; operator must explicitly choose allowUnscopedDiff: true.
  const broker = new StubBroker();
  broker.enqueue({
    ok: true,
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
        taskId: "no-scope-default",
        taskDescription: "no touchList, no allowUnscopedDiff → must reject",
        builderCount: 1,
        baseBranch: "main",
        // touchList omitted, allowUnscopedDiff omitted → default false
        loadSkillImpl: () => syntheticSkill(),
        loadPromptTemplateImpl: () => TEMPLATE,
      },
    );
    const c = packet.candidates[0];
    assert.equal(c?.phase, "scope_rejected");
    assert.equal(c?.ok, false);
    assert.match(c?.errorMessage ?? "", /allowUnscopedDiff/);
    // rawText preserved so a human can salvage the model's response.
    assert.match(c?.rawText ?? "", /diff --git/);
  } finally {
    cleanup();
  }
});

test("runBuilderSwarm: empty touchList WITH allowUnscopedDiff=true → allowed (operator opted out)", async () => {
  // Explicit operator choice: unscoped is OK for this run. Evidence
  // shows it via allowUnscopedDiff in the packet input — humans can
  // see whether the gate was active.
  const broker = new StubBroker();
  broker.enqueue({
    ok: true,
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
        taskId: "explicit-unscoped",
        taskDescription: "operator explicitly opted out of scope",
        builderCount: 1,
        baseBranch: "main",
        allowUnscopedDiff: true, // ← explicit opt-out
        loadSkillImpl: () => syntheticSkill(),
        loadPromptTemplateImpl: () => TEMPLATE,
      },
    );
    assert.equal(packet.candidates[0]?.phase, "collected");
    assert.equal(packet.candidates[0]?.ok, true);
  } finally {
    cleanup();
  }
});

test("runBuilderSwarm: non-empty touchList ignores allowUnscopedDiff (gate runs as normal)", async () => {
  // Sanity check: the flag only takes effect when touchList is empty.
  // A populated touchList keeps the per-file scope check enforced.
  const broker = new StubBroker();
  broker.enqueue({
    ok: true,
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
        taskId: "scoped-with-flag",
        taskDescription: "touchList populated; flag should be inert",
        builderCount: 1,
        baseBranch: "main",
        touchList: ["wrong-file.ts"], // diff touches added.ts → mismatch
        allowUnscopedDiff: true, // does NOT relax per-file scope
        loadSkillImpl: () => syntheticSkill(),
        loadPromptTemplateImpl: () => TEMPLATE,
      },
    );
    assert.equal(packet.candidates[0]?.phase, "scope_rejected");
    assert.match(
      packet.candidates[0]?.errorMessage ?? "",
      /outside_touch_list/,
    );
  } finally {
    cleanup();
  }
});

test("runBuilderSwarm: scope_rejected packet still validates against builder-swarm-packet schema (phase enum updated)", async () => {
  const { validateBuilderSwarmPacket } = await import("../../schemas.ts");
  const broker = new StubBroker();
  broker.enqueue({
    ok: true,
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
        taskId: "scope-schema",
        taskDescription: "x",
        touchList: ["never-matches.ts"],
        builderCount: 1,
        baseBranch: "main",
        loadSkillImpl: () => syntheticSkill(),
        loadPromptTemplateImpl: () => TEMPLATE,
      },
    );
    assert.equal(packet.candidates[0]?.phase, "scope_rejected");
    const valid = validateBuilderSwarmPacket(packet);
    if (!valid) {
      console.error(JSON.stringify(validateBuilderSwarmPacket.errors, null, 2));
    }
    assert.equal(valid, true);
  } finally {
    cleanup();
  }
});
