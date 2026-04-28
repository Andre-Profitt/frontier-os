// Builder swarm tests — orchestration with stubs + one real-git e2e.

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
  readFileSync,
} from "node:fs";
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
  // Per-call snapshot of (taskClass, modelOverride, prompt) — used by
  // Patch C tests to assert each builder routed to its pinned model,
  // and by Patch Y tests to inspect the retry prompt's appended
  // feedback (previous rawText + apply error).
  public callLog: Array<{
    taskClass: string;
    modelOverride?: string;
    prompt?: string;
  }> = [];

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
    const logEntry: {
      taskClass: string;
      modelOverride?: string;
      prompt?: string;
    } = {
      taskClass: opts.taskClass,
    };
    if (opts.modelOverride !== undefined) {
      logEntry.modelOverride = opts.modelOverride;
    }
    // Capture the user-message prompt text so retry tests can assert
    // the structured feedback (previous response + apply error) was
    // appended on the second call.
    const userMsg = opts.messages?.find((m) => m.role === "user");
    if (userMsg && typeof userMsg.content === "string") {
      logEntry.prompt = userMsg.content;
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

// --- Patch T: builder modelKey parity on broker_failed ----------------

test("runBuilderSwarm (Patch T): pinned builder + broker rejection → modelKey=pinnedModelKey on failed candidate", async () => {
  // Symmetric fix to Patch R blocker #3 for reviewers. When
  // modelKeys is set, the round-robin model assignment must survive
  // even when the broker call is rejected. Without this, the quality
  // ledger's model_event aggregation drops failures for the pinned
  // model entirely (the writer's "if (!c.modelKey) continue;" skips
  // the row), making pinned-builder failure rates invisible in the
  // scorecard — exactly the gap GPT Pro flagged for reviewers.
  const broker = new StubBroker();
  broker.enqueue("empty"); // builder 1 → broker rejection
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
        taskId: "patch-t-rejection",
        taskDescription: "x",
        builderCount: 2,
        baseBranch: "main",
        touchList: ["added.ts"],
        modelKeys: ["pinned:k1", "pinned:k2"],
        loadSkillImpl: () => syntheticSkill(),
        loadPromptTemplateImpl: () => TEMPLATE,
      },
    );
    const failed = packet.candidates.find((c) => c.phase === "broker_failed");
    assert.ok(failed, "expected one broker_failed candidate");
    assert.equal(
      failed?.modelKey,
      "pinned:k1",
      "failed pinned builder must carry its assigned modelKey for ledger attribution",
    );
  } finally {
    cleanup();
  }
});

test("runBuilderSwarm (Patch T): pinned builder + broker exception → modelKey=pinnedModelKey on failed candidate", async () => {
  // Same parity rule for the exception path.
  const broker = new StubBroker();
  broker.enqueue({ throw: new Error("network down") });
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
        taskId: "patch-t-exception",
        taskDescription: "x",
        builderCount: 2,
        baseBranch: "main",
        touchList: ["added.ts"],
        modelKeys: ["pinned:k1", "pinned:k2"],
        loadSkillImpl: () => syntheticSkill(),
        loadPromptTemplateImpl: () => TEMPLATE,
      },
    );
    const failed = packet.candidates.find((c) => c.phase === "broker_failed");
    assert.ok(failed, "expected one broker_failed candidate");
    assert.equal(
      failed?.modelKey,
      "pinned:k1",
      "failed pinned builder (exception) must carry its assigned modelKey",
    );
    assert.match(failed?.errorMessage ?? "", /network down/);
  } finally {
    cleanup();
  }
});

test("runBuilderSwarm (Patch T): unpinned builder + broker rejection → modelKey undefined (no regression)", async () => {
  // Non-regression: when no modelKeys is set, failed candidates still
  // leave modelKey undefined. The fix only attributes failures to the
  // *known* pinned key — it must NOT invent one for unpinned calls.
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
        taskId: "patch-t-unpinned",
        taskDescription: "x",
        builderCount: 1,
        baseBranch: "main",
        touchList: ["added.ts"],
        loadSkillImpl: () => syntheticSkill(),
        loadPromptTemplateImpl: () => TEMPLATE,
      },
    );
    const c = packet.candidates[0];
    assert.equal(c?.phase, "broker_failed");
    assert.equal(c?.modelKey, undefined);
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

// --- Patch X: phase included in builderVerification -------------------

test("runBuilderSwarm (Patch X): verifier phase is captured on builderVerification", async () => {
  // Patch V captured exit codes + ranAt but dropped the verifier's
  // `phase` field. Phase carries critical nuance — e.g.
  // "passed_typecheck_only" vs "passed" — that the reviewer needs
  // to know whether runtime tests actually executed. Patch X adds
  // phase to the structure so the formatter (and the reviewer
  // prompt) can render it.
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
        taskId: "patch-x-phase",
        taskDescription: "x",
        builderCount: 1,
        baseBranch: "main",
        touchList: ["added.ts"],
        typecheckCommand: ["echo", "stub"],
        // testCommand omitted → verifier returns "passed_typecheck_only"
        // (the realistic signal for a typecheck-only run that the
        // reviewer needs to distinguish from full pass).
        loadSkillImpl: () => syntheticSkill(),
        loadPromptTemplateImpl: () => TEMPLATE,
        verifierImpl: ({ builderId }) => ({
          builderId,
          worktreePath: "/tmp/stub",
          phase: "passed_typecheck_only" as const,
          typecheckExitCode: 0,
          ranAt: "2026-04-27T13:00:00.000Z",
        }),
      },
    );
    const c = packet.candidates[0];
    assert.equal(c?.builderVerification?.phase, "passed_typecheck_only");
    assert.equal(c?.builderVerification?.typecheckExitCode, 0);
    assert.equal(c?.builderVerification?.testExitCode, undefined);
  } finally {
    cleanup();
  }
});

// --- Patch V: builder self-verification populates builderVerification --

test("runBuilderSwarm (Patch V): typecheckCommand runs in worktree and exit code lands on candidate", async () => {
  // Pre-Patch-V, candidate.builderVerification was always undefined
  // (the field existed in the type but was never populated). Reviewer
  // template's {{builderVerificationRecord}} therefore always rendered
  // empty. Now the builder swarm runs typecheck (and optionally test)
  // commands inside the worktree and stores exit codes on the
  // candidate so the orchestrator can format them into the reviewer
  // prompt.
  const broker = new StubBroker();
  broker.enqueue({
    ok: true,
    assistantText: `\`\`\`diff\n${SAMPLE_DIFF}\`\`\``,
  });
  const { repoRoot, cleanup } = makeRepo();
  try {
    // Stub verifierImpl returns deterministic exit codes — keeps the
    // test fast (real `npm run typecheck` would take seconds) and
    // hermetic (no dependency on the test repo having a tsconfig).
    const packet = await runBuilderSwarm(
      {
        broker: broker as unknown as InferenceBroker,
        worktreeManager: buildManager(repoRoot),
      },
      {
        taskId: "verify-pass",
        taskDescription: "x",
        builderCount: 1,
        baseBranch: "main",
        touchList: ["added.ts"],
        typecheckCommand: ["echo", "typecheck-stub"],
        testCommand: ["echo", "test-stub"],
        loadSkillImpl: () => syntheticSkill(),
        loadPromptTemplateImpl: () => TEMPLATE,
        verifierImpl: ({ builderId }) => ({
          builderId,
          worktreePath: "/tmp/stub",
          phase: "passed" as const,
          typecheckExitCode: 0,
          testExitCode: 0,
          ranAt: "2026-04-27T00:00:00.000Z",
        }),
      },
    );
    const c = packet.candidates[0];
    assert.equal(c?.phase, "collected");
    assert.ok(c?.builderVerification, "expected builderVerification populated");
    assert.equal(c?.builderVerification?.typecheckExitCode, 0);
    assert.equal(c?.builderVerification?.testExitCode, 0);
    assert.equal(c?.builderVerification?.ranAt, "2026-04-27T00:00:00.000Z");
  } finally {
    cleanup();
  }
});

test("runBuilderSwarm (Patch V): no typecheck/test commands → builderVerification stays undefined (regression)", async () => {
  // When the orchestrator doesn't ask for self-verification, the
  // builder must not invent it. Preserves the prior default behavior.
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
        taskId: "no-verify",
        taskDescription: "x",
        builderCount: 1,
        baseBranch: "main",
        touchList: ["added.ts"],
        // typecheckCommand / testCommand omitted
        loadSkillImpl: () => syntheticSkill(),
        loadPromptTemplateImpl: () => TEMPLATE,
      },
    );
    const c = packet.candidates[0];
    assert.equal(c?.phase, "collected");
    assert.equal(c?.builderVerification, undefined);
  } finally {
    cleanup();
  }
});

test("runBuilderSwarm (Patch V): typecheck failure recorded on candidate but phase stays 'collected' (verification is informational)", async () => {
  // Builder verification is informational — it tells the reviewer
  // what the builder *claims*. The arbiter's verifier independently
  // re-runs verification later. So a failed self-verification doesn't
  // fail the candidate; phase remains collected.
  //
  // Patch BB: pin maxVerifyRetries=0 to preserve the pre-Patch-BB
  // single-shot verify behavior this test asserts. With the new
  // default of 1, verify failure now triggers a retry — that path is
  // covered by the Patch BB tests below.
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
        taskId: "verify-fail",
        taskDescription: "x",
        builderCount: 1,
        baseBranch: "main",
        touchList: ["added.ts"],
        typecheckCommand: ["echo", "stub"],
        maxVerifyRetries: 0,
        loadSkillImpl: () => syntheticSkill(),
        loadPromptTemplateImpl: () => TEMPLATE,
        verifierImpl: ({ builderId }) => ({
          builderId,
          worktreePath: "/tmp/stub",
          phase: "typecheck_failed" as const,
          typecheckExitCode: 1,
          ranAt: "2026-04-27T00:00:00.000Z",
        }),
      },
    );
    const c = packet.candidates[0];
    assert.equal(c?.phase, "collected", "verification doesn't change phase");
    assert.equal(c?.ok, true);
    assert.equal(c?.builderVerification?.typecheckExitCode, 1);
  } finally {
    cleanup();
  }
});

// --- Patch R blocker #1: S/R pre-scope check (no worktree mutation) ----

test("runBuilderSwarm: out-of-scope S/R block → scope_rejected BEFORE apply (worktree NOT mutated)", async () => {
  // Pin the contract: a search/replace block whose filePath is outside
  // the touchList must be rejected BEFORE applySearchReplaceBlocks
  // mutates the worktree. Pre-Patch-R the apply ran first, then the
  // diff-scope check rejected — leaving evil.ts on disk in the
  // worktree. We assert worktree state explicitly.
  const broker = new StubBroker();
  broker.enqueue({
    ok: true,
    assistantText: `Here's the change:

evil.ts
<<<<<<< SEARCH
=======
malicious payload
>>>>>>> REPLACE
`,
  });
  const { repoRoot, cleanup } = makeRepo();
  try {
    const packet = await runBuilderSwarm(
      {
        broker: broker as unknown as InferenceBroker,
        worktreeManager: buildManager(repoRoot),
      },
      {
        taskId: "sr-scope",
        taskDescription: "model targets out-of-scope file via S/R",
        touchList: ["allowed.ts"],
        builderCount: 1,
        baseBranch: "main",
        loadSkillImpl: () => syntheticSkill(),
        loadPromptTemplateImpl: () => TEMPLATE,
      },
    );
    const c = packet.candidates[0];
    assert.equal(c?.phase, "scope_rejected");
    assert.equal(c?.ok, false);
    assert.match(
      c?.errorMessage ?? "",
      /S\/R scope rejected|outside_touch_list/,
    );
    // The whole point of this fix: the worktree must be clean. Pre-fix,
    // applySearchReplaceBlocks would have created evil.ts before the
    // scope check ran.
    assert.ok(c?.worktreePath, "expected worktreePath on candidate");
    assert.equal(
      existsSync(resolve(c!.worktreePath!, "evil.ts")),
      false,
      "evil.ts must NOT exist — apply should not have run before scope check",
    );
  } finally {
    cleanup();
  }
});

test("runBuilderSwarm: S/R + empty touchList + no allowUnscopedDiff → scope_rejected (worktree clean)", async () => {
  // Parallel to the unified-diff "default deny" test, for the S/R path.
  const broker = new StubBroker();
  broker.enqueue({
    ok: true,
    assistantText: `Here's the change:

added.ts
<<<<<<< SEARCH
=======
export const v = 42;
>>>>>>> REPLACE
`,
  });
  const { repoRoot, cleanup } = makeRepo();
  try {
    const packet = await runBuilderSwarm(
      {
        broker: broker as unknown as InferenceBroker,
        worktreeManager: buildManager(repoRoot),
      },
      {
        taskId: "sr-no-scope-default",
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
    assert.ok(c?.worktreePath);
    assert.equal(
      existsSync(resolve(c!.worktreePath!, "added.ts")),
      false,
      "added.ts must NOT exist — apply should not have run",
    );
  } finally {
    cleanup();
  }
});

test("runBuilderSwarm: in-scope S/R block (modify existing file) → applies, commits, collects", async () => {
  // Sanity check that the S/R happy path still works after pre-scope
  // gate is added — a touchList match should NOT be rejected. Modify
  // README.md (seeded by makeRepo) so the change shows in `git diff`
  // (untracked-new-file via S/R is a separate, tracked issue — not
  // what this test is pinning).
  const broker = new StubBroker();
  broker.enqueue({
    ok: true,
    assistantText: `README.md
<<<<<<< SEARCH
# test
=======
# replaced via S/R
>>>>>>> REPLACE
`,
  });
  const { repoRoot, cleanup } = makeRepo();
  try {
    const packet = await runBuilderSwarm(
      {
        broker: broker as unknown as InferenceBroker,
        worktreeManager: buildManager(repoRoot),
      },
      {
        taskId: "sr-allowed",
        taskDescription: "S/R inside scope",
        touchList: ["README.md"],
        builderCount: 1,
        baseBranch: "main",
        loadSkillImpl: () => syntheticSkill(),
        loadPromptTemplateImpl: () => TEMPLATE,
      },
    );
    const c = packet.candidates[0];
    assert.equal(
      c?.ok,
      true,
      `expected collected, got ${c?.phase}: ${c?.errorMessage}`,
    );
    assert.equal(c?.phase, "collected");
    assert.deepEqual(c?.patch?.files, ["README.md"]);
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

// --- Patch Y: S/R apply retry with structured feedback -----------------
//
// When the model emits S/R blocks whose SEARCH text does not match the
// real file content, applySearchReplaceBlocks fails with a structured
// error ("SEARCH text not found", "matches N locations", etc). Pre-Patch-Y
// this terminated the candidate as apply_failed — a wasted broker call
// for what is often a recoverable hallucination (model paraphrased a
// line from the rendered touchList instead of copying it verbatim).
//
// Patch Y gives the builder ONE retry: re-prompt with the original user
// message + the previous response + the apply error, and re-run the S/R
// pipeline. If the retry succeeds, the candidate is applied normally
// (applyAttempts=2). If it fails again, we surface apply_failed with the
// combined transcript in rawText.
//
// Default maxApplyRetries=1 (one retry). maxApplyRetries=0 disables the
// loop entirely (legacy behavior preserved for callers that want it).
//
// Retry covers ONLY the S/R apply path, not unified-diff apply. S/R
// hallucination is the dominant local-70B failure mode this addresses;
// unified-diff line drift has its own resolution path (Patch M).

test("runBuilderSwarm (Patch Y): S/R apply fails on attempt 1, succeeds on attempt 2 → collected, applyAttempts=2, retry prompt carries feedback", async () => {
  const broker = new StubBroker();
  // Attempt 1: SEARCH text NOT in README.md (real content is "# test\n").
  broker.enqueue({
    ok: true,
    assistantText: `README.md
<<<<<<< SEARCH
# this exact line does not exist in the file
=======
# replaced
>>>>>>> REPLACE
`,
  });
  // Attempt 2: correct SEARCH.
  broker.enqueue({
    ok: true,
    assistantText: `README.md
<<<<<<< SEARCH
# test
=======
# replaced via Patch Y retry
>>>>>>> REPLACE
`,
  });
  const { repoRoot, cleanup } = makeRepo();
  try {
    const packet = await runBuilderSwarm(
      {
        broker: broker as unknown as InferenceBroker,
        worktreeManager: buildManager(repoRoot),
      },
      {
        taskId: "patch-y-retry-success",
        taskDescription: "Patch Y retry path",
        touchList: ["README.md"],
        builderCount: 1,
        baseBranch: "main",
        loadSkillImpl: () => syntheticSkill(),
        loadPromptTemplateImpl: () => TEMPLATE,
      },
    );
    const c = packet.candidates[0];
    assert.equal(
      c?.ok,
      true,
      `expected collected on retry, got ${c?.phase}: ${c?.errorMessage}`,
    );
    assert.equal(c?.phase, "collected");
    assert.equal(
      c?.applyAttempts,
      2,
      "applyAttempts must reflect the retry count",
    );
    // Two broker calls observed; the second's prompt includes the
    // previous response + the apply error.
    assert.equal(broker.callLog.length, 2);
    const retryPrompt = broker.callLog[1]?.prompt ?? "";
    assert.match(
      retryPrompt,
      /PREVIOUS ATTEMPT FAILED/i,
      "retry prompt should call out that the previous attempt failed",
    );
    assert.match(
      retryPrompt,
      /SEARCH text not found/i,
      "retry prompt should include the structured apply error",
    );
    assert.match(
      retryPrompt,
      /this exact line does not exist in the file/,
      "retry prompt should include the previous response so the model can correct it",
    );
  } finally {
    cleanup();
  }
});

test("runBuilderSwarm (Patch Y): S/R apply fails on both attempts → apply_failed with applyAttempts=2 and combined rawText", async () => {
  const broker = new StubBroker();
  broker.enqueue({
    ok: true,
    assistantText: `README.md
<<<<<<< SEARCH
# nope-1
=======
# r1
>>>>>>> REPLACE
`,
  });
  broker.enqueue({
    ok: true,
    assistantText: `README.md
<<<<<<< SEARCH
# nope-2
=======
# r2
>>>>>>> REPLACE
`,
  });
  const { repoRoot, cleanup } = makeRepo();
  try {
    const packet = await runBuilderSwarm(
      {
        broker: broker as unknown as InferenceBroker,
        worktreeManager: buildManager(repoRoot),
      },
      {
        taskId: "patch-y-retry-fail",
        taskDescription: "both attempts hallucinate SEARCH",
        touchList: ["README.md"],
        builderCount: 1,
        baseBranch: "main",
        loadSkillImpl: () => syntheticSkill(),
        loadPromptTemplateImpl: () => TEMPLATE,
      },
    );
    const c = packet.candidates[0];
    assert.equal(c?.ok, false);
    assert.equal(c?.phase, "apply_failed");
    assert.equal(
      c?.applyAttempts,
      2,
      "applyAttempts must reflect both attempts",
    );
    assert.match(
      c?.errorMessage ?? "",
      /search\/replace apply failed/,
      "errorMessage surfaces the final apply failure",
    );
    // Combined transcript captures both broker responses for human
    // salvage.
    assert.match(c?.rawText ?? "", /Attempt 1/);
    assert.match(c?.rawText ?? "", /Attempt 2/);
    assert.match(c?.rawText ?? "", /# nope-1/);
    assert.match(c?.rawText ?? "", /# nope-2/);
    assert.equal(broker.callLog.length, 2, "broker called twice");
  } finally {
    cleanup();
  }
});

test("runBuilderSwarm (Patch Y): S/R apply succeeds on first attempt → applyAttempts=1, no retry (regression)", async () => {
  const broker = new StubBroker();
  broker.enqueue({
    ok: true,
    assistantText: `README.md
<<<<<<< SEARCH
# test
=======
# replaced first try
>>>>>>> REPLACE
`,
  });
  // No second response queued — if the swarm calls broker twice, the
  // second call will return "all-attempts-failed" and the candidate
  // would surface as broker_failed. The assertion below catches that
  // regression path.
  const { repoRoot, cleanup } = makeRepo();
  try {
    const packet = await runBuilderSwarm(
      {
        broker: broker as unknown as InferenceBroker,
        worktreeManager: buildManager(repoRoot),
      },
      {
        taskId: "patch-y-no-retry-needed",
        taskDescription: "happy path; no retry",
        touchList: ["README.md"],
        builderCount: 1,
        baseBranch: "main",
        loadSkillImpl: () => syntheticSkill(),
        loadPromptTemplateImpl: () => TEMPLATE,
      },
    );
    const c = packet.candidates[0];
    assert.equal(c?.ok, true, `unexpected: ${c?.phase} ${c?.errorMessage}`);
    assert.equal(c?.phase, "collected");
    assert.equal(c?.applyAttempts, 1);
    assert.equal(
      broker.callLog.length,
      1,
      "broker must NOT be called twice when first attempt applied",
    );
  } finally {
    cleanup();
  }
});

test("runBuilderSwarm (Patch Y): maxApplyRetries=0 → no retry on apply failure (legacy behavior preserved)", async () => {
  const broker = new StubBroker();
  broker.enqueue({
    ok: true,
    assistantText: `README.md
<<<<<<< SEARCH
# never-matches
=======
# r
>>>>>>> REPLACE
`,
  });
  // Second response queued so we can prove the swarm did NOT consume it
  // (queueRemaining > 0 after the run).
  broker.enqueue({
    ok: true,
    assistantText: `(would-be-retry — must not be sent)`,
  });
  const { repoRoot, cleanup } = makeRepo();
  try {
    const packet = await runBuilderSwarm(
      {
        broker: broker as unknown as InferenceBroker,
        worktreeManager: buildManager(repoRoot),
      },
      {
        taskId: "patch-y-disable-retry",
        taskDescription: "retry disabled",
        touchList: ["README.md"],
        builderCount: 1,
        baseBranch: "main",
        maxApplyRetries: 0,
        loadSkillImpl: () => syntheticSkill(),
        loadPromptTemplateImpl: () => TEMPLATE,
      },
    );
    const c = packet.candidates[0];
    assert.equal(c?.phase, "apply_failed");
    assert.equal(c?.ok, false);
    assert.equal(
      c?.applyAttempts,
      1,
      "with retries disabled, applyAttempts stays at 1",
    );
    assert.equal(broker.callLog.length, 1, "no retry broker call");
    assert.equal(
      broker.queueRemaining(),
      1,
      "second queued response must remain unconsumed",
    );
  } finally {
    cleanup();
  }
});

test("runBuilderSwarm (Patch Y): packet with applyAttempts validates against builder-swarm-packet schema", async () => {
  const { validateBuilderSwarmPacket } = await import("../../schemas.ts");
  const broker = new StubBroker();
  broker.enqueue({
    ok: true,
    assistantText: `README.md
<<<<<<< SEARCH
# test
=======
# replaced
>>>>>>> REPLACE
`,
  });
  const { repoRoot, cleanup } = makeRepo();
  try {
    const packet = await runBuilderSwarm(
      {
        broker: broker as unknown as InferenceBroker,
        worktreeManager: buildManager(repoRoot),
      },
      {
        taskId: "patch-y-schema",
        taskDescription: "schema check",
        touchList: ["README.md"],
        builderCount: 1,
        baseBranch: "main",
        loadSkillImpl: () => syntheticSkill(),
        loadPromptTemplateImpl: () => TEMPLATE,
      },
    );
    assert.equal(packet.candidates[0]?.applyAttempts, 1);
    const valid = validateBuilderSwarmPacket(packet);
    if (!valid) {
      console.error(JSON.stringify(validateBuilderSwarmPacket.errors, null, 2));
    }
    assert.equal(valid, true);
  } finally {
    cleanup();
  }
});

// --- Patch Z: READ_FILE tool for the builder ---------------------------
//
// Patch Y added retry-with-feedback as the smallest tool-flavored
// increment. Patch Z adds a genuine tool: the builder may emit
// `READ_FILE: <relative-path>` (alone, no S/R or diff in the response)
// to request the contents of a file outside its touch list. The runner
// reads it (after path safety checks), appends it to the original
// prompt, and re-calls the broker. The model then proceeds with S/R as
// normal. This unblocks the case where the touch list isn't sufficient
// context — e.g. the model needs to inspect a sibling test file or a
// type definition to write a correct patch.
//
// Default `maxReadFiles` = 1 (one read per builder). Path safety:
// no absolute paths, no traversal, file must exist in worktree, size
// capped at 64KB (truncated with note if larger).
//
// READ_FILE detection only fires when the response contains NEITHER
// S/R blocks NOR a unified-diff header — the model shouldn't be
// emitting both code AND a tool request, and if it does we prefer the
// actual delivery.
//
// READ_FILE budget and Patch Y's apply-retry budget are independent:
// using the read tool does not cost retry headroom, and vice versa.
// A hard total iteration cap (1 + maxReadFiles + maxApplyRetries + 2)
// catches pathological loops as a safety net.

test("runBuilderSwarm (Patch Z): builder emits READ_FILE → file content provided in followup → S/R succeeds", async () => {
  const broker = new StubBroker();
  // Attempt 1: model asks for a file outside the touch list.
  broker.enqueue({
    ok: true,
    assistantText: `I need to inspect the helper module first.

READ_FILE: helper.txt
`,
  });
  // Attempt 2: model produces correct S/R against README.md.
  broker.enqueue({
    ok: true,
    assistantText: `README.md
<<<<<<< SEARCH
# test
=======
# replaced via Patch Z (read helper.txt first)
>>>>>>> REPLACE
`,
  });
  const { repoRoot, cleanup } = makeRepo();
  // Seed an extra file the model will request — outside touchList.
  writeFileSync(
    resolve(repoRoot, "helper.txt"),
    "helper content the model needs\n",
  );
  git(["add", "helper.txt"], repoRoot);
  git(["commit", "-q", "-m", "add helper"], repoRoot);
  try {
    const packet = await runBuilderSwarm(
      {
        broker: broker as unknown as InferenceBroker,
        worktreeManager: buildManager(repoRoot),
      },
      {
        taskId: "patch-z-read-file-success",
        taskDescription: "use the read tool to inspect helper.txt",
        touchList: ["README.md"],
        builderCount: 1,
        baseBranch: "main",
        loadSkillImpl: () => syntheticSkill(),
        loadPromptTemplateImpl: () => TEMPLATE,
      },
    );
    const c = packet.candidates[0];
    assert.equal(
      c?.ok,
      true,
      `expected collected after read+S/R, got ${c?.phase}: ${c?.errorMessage}`,
    );
    assert.equal(c?.phase, "collected");
    assert.equal(c?.applyAttempts, 1, "S/R applied first try after read");
    assert.deepEqual(
      c?.readFiles,
      ["helper.txt"],
      "readFiles should record the satisfied read",
    );
    assert.equal(
      broker.callLog.length,
      2,
      "broker called twice (read + apply)",
    );
    // Followup prompt must contain the file content the model requested.
    const followupPrompt = broker.callLog[1]?.prompt ?? "";
    assert.match(
      followupPrompt,
      /helper content the model needs/,
      "followup must include the requested file's contents",
    );
    assert.match(
      followupPrompt,
      /helper\.txt/,
      "followup must reference the path",
    );
  } finally {
    cleanup();
  }
});

test("runBuilderSwarm (Patch Z): READ_FILE for path with .. traversal → denied, model recovers with S/R on next turn", async () => {
  const broker = new StubBroker();
  broker.enqueue({
    ok: true,
    assistantText: `READ_FILE: ../../../etc/passwd`,
  });
  // After error feedback the model produces a valid S/R.
  broker.enqueue({
    ok: true,
    assistantText: `README.md
<<<<<<< SEARCH
# test
=======
# recovered
>>>>>>> REPLACE
`,
  });
  const { repoRoot, cleanup } = makeRepo();
  try {
    const packet = await runBuilderSwarm(
      {
        broker: broker as unknown as InferenceBroker,
        worktreeManager: buildManager(repoRoot),
      },
      {
        taskId: "patch-z-traversal",
        taskDescription: "model misuses tool then recovers",
        touchList: ["README.md"],
        builderCount: 1,
        baseBranch: "main",
        loadSkillImpl: () => syntheticSkill(),
        loadPromptTemplateImpl: () => TEMPLATE,
      },
    );
    const c = packet.candidates[0];
    assert.equal(
      c?.ok,
      true,
      `expected recovery, got ${c?.phase}: ${c?.errorMessage}`,
    );
    assert.equal(c?.phase, "collected");
    // Denied request does NOT land in readFiles.
    assert.deepEqual(c?.readFiles ?? [], []);
    assert.equal(broker.callLog.length, 2);
    const followup = broker.callLog[1]?.prompt ?? "";
    assert.match(
      followup,
      /traversal|outside|denied|invalid/i,
      "followup must explain why the read was denied",
    );
    // The traversal target must NOT appear inlined as content (the
    // whole point of denying it).
    assert.doesNotMatch(
      followup,
      /root:.*:0:0/,
      "denied path's contents must not appear in the followup",
    );
  } finally {
    cleanup();
  }
});

test("runBuilderSwarm (Patch Z): maxReadFiles=0 → READ_FILE response is treated as no_diff_extracted (tool disabled)", async () => {
  const broker = new StubBroker();
  broker.enqueue({
    ok: true,
    assistantText: `READ_FILE: README.md`,
  });
  // Second response queued; should not be consumed if tool disabled.
  broker.enqueue({
    ok: true,
    assistantText: `(would-be-followup — should not be sent)`,
  });
  const { repoRoot, cleanup } = makeRepo();
  try {
    const packet = await runBuilderSwarm(
      {
        broker: broker as unknown as InferenceBroker,
        worktreeManager: buildManager(repoRoot),
      },
      {
        taskId: "patch-z-disabled",
        taskDescription: "read tool disabled",
        touchList: ["README.md"],
        builderCount: 1,
        baseBranch: "main",
        maxReadFiles: 0,
        loadSkillImpl: () => syntheticSkill(),
        loadPromptTemplateImpl: () => TEMPLATE,
      },
    );
    const c = packet.candidates[0];
    assert.equal(c?.phase, "no_diff_extracted");
    assert.equal(c?.ok, false);
    assert.equal(broker.callLog.length, 1, "no followup broker call");
    assert.equal(broker.queueRemaining(), 1);
  } finally {
    cleanup();
  }
});

test("runBuilderSwarm (Patch Z): READ_FILE for non-existent file → denied with feedback, model recovers", async () => {
  const broker = new StubBroker();
  broker.enqueue({
    ok: true,
    assistantText: `READ_FILE: does-not-exist.md`,
  });
  broker.enqueue({
    ok: true,
    assistantText: `README.md
<<<<<<< SEARCH
# test
=======
# fixed after missing-file feedback
>>>>>>> REPLACE
`,
  });
  const { repoRoot, cleanup } = makeRepo();
  try {
    const packet = await runBuilderSwarm(
      {
        broker: broker as unknown as InferenceBroker,
        worktreeManager: buildManager(repoRoot),
      },
      {
        taskId: "patch-z-missing-file",
        taskDescription: "request missing file",
        touchList: ["README.md"],
        builderCount: 1,
        baseBranch: "main",
        loadSkillImpl: () => syntheticSkill(),
        loadPromptTemplateImpl: () => TEMPLATE,
      },
    );
    const c = packet.candidates[0];
    assert.equal(c?.ok, true);
    assert.equal(c?.phase, "collected");
    assert.deepEqual(c?.readFiles ?? [], []);
    const followup = broker.callLog[1]?.prompt ?? "";
    assert.match(
      followup,
      /not exist|not found|missing/i,
      "followup must explain that the file is missing",
    );
  } finally {
    cleanup();
  }
});

test("runBuilderSwarm (Patch Z): packet with readFiles validates against builder-swarm-packet schema", async () => {
  const { validateBuilderSwarmPacket } = await import("../../schemas.ts");
  const broker = new StubBroker();
  broker.enqueue({ ok: true, assistantText: `READ_FILE: helper.txt` });
  broker.enqueue({
    ok: true,
    assistantText: `README.md
<<<<<<< SEARCH
# test
=======
# done
>>>>>>> REPLACE
`,
  });
  const { repoRoot, cleanup } = makeRepo();
  writeFileSync(resolve(repoRoot, "helper.txt"), "x\n");
  git(["add", "helper.txt"], repoRoot);
  git(["commit", "-q", "-m", "add helper"], repoRoot);
  try {
    const packet = await runBuilderSwarm(
      {
        broker: broker as unknown as InferenceBroker,
        worktreeManager: buildManager(repoRoot),
      },
      {
        taskId: "patch-z-schema",
        taskDescription: "schema validation",
        touchList: ["README.md"],
        builderCount: 1,
        baseBranch: "main",
        loadSkillImpl: () => syntheticSkill(),
        loadPromptTemplateImpl: () => TEMPLATE,
      },
    );
    assert.deepEqual(packet.candidates[0]?.readFiles, ["helper.txt"]);
    const valid = validateBuilderSwarmPacket(packet);
    if (!valid) {
      console.error(JSON.stringify(validateBuilderSwarmPacket.errors, null, 2));
    }
    assert.equal(valid, true);
  } finally {
    cleanup();
  }
});

// --- Patch BB: verification-aware retry --------------------------------
//
// Patch V populated builderVerification (typecheck/test exit codes after
// commit) but the result was strictly informational — a typecheck or
// test failure didn't change the candidate's phase. Patch BB makes
// verification actionable for the builder: when verify fails AND the
// retry budget allows, the runner rolls back the candidate's commit
// (`git reset --hard HEAD~1` inside the worktree), augments the prompt
// with the verifier's stderr, and re-prompts the model. The second
// attempt's apply+commit+verify runs from a clean base.
//
// Default `maxVerifyRetries` = 1 (one retry). Set to 0 to preserve the
// pre-Patch-BB legacy: a failed verify stays informational and does not
// trigger a re-prompt. Independent budget from `maxApplyRetries` and
// `maxReadFiles` — verify-retry resets the inner state for a fresh
// broker → apply → commit cycle.
//
// `verifyAttempts` = number of times the verifier ran (= number of
// post-commit cycles attempted). Set only when verification ran;
// undefined when typecheckCommand/testCommand were both absent.

test("runBuilderSwarm (Patch BB): verify fails on attempt 1, succeeds on attempt 2 → collected, verifyAttempts=2, retry prompt carries verifier stderr", async () => {
  const broker = new StubBroker();
  // Attempt 1: a valid S/R that applies + commits cleanly. The verifier
  // (stub) will pretend typecheck failed for this commit.
  broker.enqueue({
    ok: true,
    assistantText: `README.md
<<<<<<< SEARCH
# test
=======
# attempt-1 (will fail typecheck per the stub verifier)
>>>>>>> REPLACE
`,
  });
  // Attempt 2: a different S/R; verifier will pretend typecheck passes.
  broker.enqueue({
    ok: true,
    assistantText: `README.md
<<<<<<< SEARCH
# test
=======
# attempt-2 (passes typecheck)
>>>>>>> REPLACE
`,
  });
  let verifierCalls = 0;
  const { repoRoot, cleanup } = makeRepo();
  try {
    const packet = await runBuilderSwarm(
      {
        broker: broker as unknown as InferenceBroker,
        worktreeManager: buildManager(repoRoot),
      },
      {
        taskId: "patch-bb-verify-retry-success",
        taskDescription: "Patch BB verify-retry path",
        touchList: ["README.md"],
        builderCount: 1,
        baseBranch: "main",
        typecheckCommand: ["echo", "stub"],
        loadSkillImpl: () => syntheticSkill(),
        loadPromptTemplateImpl: () => TEMPLATE,
        verifierImpl: ({ builderId, worktreePath }) => {
          verifierCalls++;
          if (verifierCalls === 1) {
            return {
              builderId,
              worktreePath,
              phase: "typecheck_failed" as const,
              typecheckExitCode: 1,
              typecheckStderr:
                "src/foo.ts:42:8 - error TS2304: Cannot find name 'undefinedSymbol'.",
              ranAt: "2026-04-27T00:00:00.000Z",
            };
          }
          return {
            builderId,
            worktreePath,
            phase: "passed_typecheck_only" as const,
            typecheckExitCode: 0,
            ranAt: "2026-04-27T00:00:01.000Z",
          };
        },
      },
    );
    const c = packet.candidates[0];
    assert.equal(
      c?.ok,
      true,
      `expected collected after verify-retry, got ${c?.phase}: ${c?.errorMessage}`,
    );
    assert.equal(c?.phase, "collected");
    assert.equal(
      c?.verifyAttempts,
      2,
      "verifyAttempts must reflect both verifier runs",
    );
    assert.equal(
      c?.builderVerification?.phase,
      "passed_typecheck_only",
      "final builderVerification reflects the SECOND (passing) verifier call",
    );
    // Two broker calls; second prompt carries verifier feedback.
    assert.equal(broker.callLog.length, 2);
    const retryPrompt = broker.callLog[1]?.prompt ?? "";
    assert.match(
      retryPrompt,
      /VERIFICATION FAILED/i,
      "retry prompt must call out verification failure",
    );
    assert.match(
      retryPrompt,
      /typecheck_failed/,
      "retry prompt must include the verifier phase",
    );
    assert.match(
      retryPrompt,
      /Cannot find name 'undefinedSymbol'/,
      "retry prompt must surface the verifier stderr so the model can fix the actual error",
    );
    assert.match(
      retryPrompt,
      /attempt-1 \(will fail typecheck per the stub verifier\)/,
      "retry prompt must include the previous response so the model can correct it",
    );
    assert.match(
      retryPrompt,
      /rolled back/i,
      "retry prompt must tell the model the prior commit was rolled back",
    );
    // Worktree state: the final committed README must reflect attempt 2,
    // not attempt 1 — proves rollback worked and second commit landed.
    const worktreeRoot = c?.worktreePath ?? "";
    const finalReadme = readFileSync(
      resolve(worktreeRoot, "README.md"),
      "utf8",
    );
    assert.match(finalReadme, /attempt-2 \(passes typecheck\)/);
    assert.doesNotMatch(
      finalReadme,
      /attempt-1/,
      "rollback must wipe attempt-1's content",
    );
  } finally {
    cleanup();
  }
});

test("runBuilderSwarm (Patch BB): verify fails on both attempts → collected with final failed verification, verifyAttempts=2 (informational fail preserved)", async () => {
  // Patch V semantic: verification failures don't fail the candidate.
  // Patch BB layers retry on top — but if the retry ALSO fails verify,
  // we land back in the Patch-V state: collected + ok:true + the final
  // failed verification recorded for the reviewer to chew on. The
  // arbiter independently re-verifies; the operator can disagree.
  const broker = new StubBroker();
  broker.enqueue({
    ok: true,
    assistantText: `README.md
<<<<<<< SEARCH
# test
=======
# attempt-1
>>>>>>> REPLACE
`,
  });
  broker.enqueue({
    ok: true,
    assistantText: `README.md
<<<<<<< SEARCH
# test
=======
# attempt-2
>>>>>>> REPLACE
`,
  });
  let verifierCalls = 0;
  const { repoRoot, cleanup } = makeRepo();
  try {
    const packet = await runBuilderSwarm(
      {
        broker: broker as unknown as InferenceBroker,
        worktreeManager: buildManager(repoRoot),
      },
      {
        taskId: "patch-bb-verify-retry-fail",
        taskDescription: "both attempts fail verify",
        touchList: ["README.md"],
        builderCount: 1,
        baseBranch: "main",
        typecheckCommand: ["echo", "stub"],
        testCommand: ["echo", "stub"],
        loadSkillImpl: () => syntheticSkill(),
        loadPromptTemplateImpl: () => TEMPLATE,
        verifierImpl: ({ builderId, worktreePath }) => {
          verifierCalls++;
          return {
            builderId,
            worktreePath,
            phase: "tests_failed" as const,
            typecheckExitCode: 0,
            testExitCode: 1,
            testStderr: `failure on call #${verifierCalls}`,
            ranAt: `2026-04-27T00:00:0${verifierCalls}.000Z`,
          };
        },
      },
    );
    const c = packet.candidates[0];
    assert.equal(c?.phase, "collected", "Patch V semantic preserved");
    assert.equal(c?.ok, true);
    assert.equal(c?.verifyAttempts, 2);
    assert.equal(
      c?.builderVerification?.phase,
      "tests_failed",
      "final builderVerification reflects the second (still-failing) call",
    );
    assert.equal(c?.builderVerification?.testExitCode, 1);
    assert.equal(broker.callLog.length, 2, "broker called twice (one retry)");
  } finally {
    cleanup();
  }
});

test("runBuilderSwarm (Patch BB): verify passes on first attempt → verifyAttempts=1, no retry (regression)", async () => {
  const broker = new StubBroker();
  broker.enqueue({
    ok: true,
    assistantText: `README.md
<<<<<<< SEARCH
# test
=======
# happy path
>>>>>>> REPLACE
`,
  });
  // No second response queued; if the swarm calls broker twice the
  // second call returns "all-attempts-failed" which would surface
  // differently. The assertion below catches that regression.
  let verifierCalls = 0;
  const { repoRoot, cleanup } = makeRepo();
  try {
    const packet = await runBuilderSwarm(
      {
        broker: broker as unknown as InferenceBroker,
        worktreeManager: buildManager(repoRoot),
      },
      {
        taskId: "patch-bb-no-retry-needed",
        taskDescription: "verify passes first time",
        touchList: ["README.md"],
        builderCount: 1,
        baseBranch: "main",
        typecheckCommand: ["echo", "stub"],
        loadSkillImpl: () => syntheticSkill(),
        loadPromptTemplateImpl: () => TEMPLATE,
        verifierImpl: ({ builderId, worktreePath }) => {
          verifierCalls++;
          return {
            builderId,
            worktreePath,
            phase: "passed_typecheck_only" as const,
            typecheckExitCode: 0,
            ranAt: "2026-04-27T00:00:00.000Z",
          };
        },
      },
    );
    const c = packet.candidates[0];
    assert.equal(c?.ok, true);
    assert.equal(c?.phase, "collected");
    assert.equal(c?.verifyAttempts, 1);
    assert.equal(
      verifierCalls,
      1,
      "verifier called exactly once on the happy path",
    );
    assert.equal(broker.callLog.length, 1, "no extra broker call");
  } finally {
    cleanup();
  }
});

test("runBuilderSwarm (Patch BB): maxVerifyRetries=0 → no retry on verify failure (legacy Patch V behavior preserved)", async () => {
  const broker = new StubBroker();
  broker.enqueue({
    ok: true,
    assistantText: `README.md
<<<<<<< SEARCH
# test
=======
# attempt-1 only
>>>>>>> REPLACE
`,
  });
  // Queue a second response we should NOT consume.
  broker.enqueue({
    ok: true,
    assistantText: `(would-be-retry — must not be sent)`,
  });
  let verifierCalls = 0;
  const { repoRoot, cleanup } = makeRepo();
  try {
    const packet = await runBuilderSwarm(
      {
        broker: broker as unknown as InferenceBroker,
        worktreeManager: buildManager(repoRoot),
      },
      {
        taskId: "patch-bb-disable-verify-retry",
        taskDescription: "verify-retry disabled",
        touchList: ["README.md"],
        builderCount: 1,
        baseBranch: "main",
        typecheckCommand: ["echo", "stub"],
        maxVerifyRetries: 0,
        loadSkillImpl: () => syntheticSkill(),
        loadPromptTemplateImpl: () => TEMPLATE,
        verifierImpl: ({ builderId, worktreePath }) => {
          verifierCalls++;
          return {
            builderId,
            worktreePath,
            phase: "typecheck_failed" as const,
            typecheckExitCode: 1,
            typecheckStderr: "stub failure",
            ranAt: "2026-04-27T00:00:00.000Z",
          };
        },
      },
    );
    const c = packet.candidates[0];
    assert.equal(
      c?.phase,
      "collected",
      "Patch V: failed verify is informational",
    );
    assert.equal(c?.ok, true);
    assert.equal(
      c?.verifyAttempts,
      1,
      "with verify-retry disabled, verifyAttempts stays at 1",
    );
    assert.equal(c?.builderVerification?.phase, "typecheck_failed");
    assert.equal(verifierCalls, 1, "verifier ran exactly once");
    assert.equal(broker.callLog.length, 1, "broker called exactly once");
    assert.equal(
      broker.queueRemaining(),
      1,
      "second queued response must remain unconsumed",
    );
  } finally {
    cleanup();
  }
});

test("runBuilderSwarm (Patch BB): no typecheck/test command → verifyAttempts undefined (regression)", async () => {
  // When the orchestrator doesn't ask for verification, verifyAttempts
  // must NOT appear on the candidate. Symmetric to the Patch V
  // regression test — a quiet new field can't pollute legacy callers.
  const broker = new StubBroker();
  broker.enqueue({
    ok: true,
    assistantText: `README.md
<<<<<<< SEARCH
# test
=======
# replaced
>>>>>>> REPLACE
`,
  });
  const { repoRoot, cleanup } = makeRepo();
  try {
    const packet = await runBuilderSwarm(
      {
        broker: broker as unknown as InferenceBroker,
        worktreeManager: buildManager(repoRoot),
      },
      {
        taskId: "patch-bb-no-verifier",
        taskDescription: "no verifier",
        touchList: ["README.md"],
        builderCount: 1,
        baseBranch: "main",
        // typecheckCommand / testCommand omitted
        loadSkillImpl: () => syntheticSkill(),
        loadPromptTemplateImpl: () => TEMPLATE,
      },
    );
    const c = packet.candidates[0];
    assert.equal(c?.phase, "collected");
    assert.equal(c?.builderVerification, undefined);
    assert.equal(
      c?.verifyAttempts,
      undefined,
      "verifyAttempts must be undefined when verification did not run",
    );
  } finally {
    cleanup();
  }
});

test("runBuilderSwarm (Patch BB): packet with verifyAttempts validates against builder-swarm-packet schema", async () => {
  const { validateBuilderSwarmPacket } = await import("../../schemas.ts");
  const broker = new StubBroker();
  broker.enqueue({
    ok: true,
    assistantText: `README.md
<<<<<<< SEARCH
# test
=======
# attempt-1
>>>>>>> REPLACE
`,
  });
  broker.enqueue({
    ok: true,
    assistantText: `README.md
<<<<<<< SEARCH
# test
=======
# attempt-2
>>>>>>> REPLACE
`,
  });
  let verifierCalls = 0;
  const { repoRoot, cleanup } = makeRepo();
  try {
    const packet = await runBuilderSwarm(
      {
        broker: broker as unknown as InferenceBroker,
        worktreeManager: buildManager(repoRoot),
      },
      {
        taskId: "patch-bb-schema",
        taskDescription: "schema check",
        touchList: ["README.md"],
        builderCount: 1,
        baseBranch: "main",
        typecheckCommand: ["echo", "stub"],
        loadSkillImpl: () => syntheticSkill(),
        loadPromptTemplateImpl: () => TEMPLATE,
        verifierImpl: ({ builderId, worktreePath }) => {
          verifierCalls++;
          if (verifierCalls === 1) {
            return {
              builderId,
              worktreePath,
              phase: "typecheck_failed" as const,
              typecheckExitCode: 1,
              ranAt: "2026-04-27T00:00:00.000Z",
            };
          }
          return {
            builderId,
            worktreePath,
            phase: "passed_typecheck_only" as const,
            typecheckExitCode: 0,
            ranAt: "2026-04-27T00:00:01.000Z",
          };
        },
      },
    );
    assert.equal(packet.candidates[0]?.verifyAttempts, 2);
    const valid = validateBuilderSwarmPacket(packet);
    if (!valid) {
      console.error(JSON.stringify(validateBuilderSwarmPacket.errors, null, 2));
    }
    assert.equal(valid, true);
  } finally {
    cleanup();
  }
});
