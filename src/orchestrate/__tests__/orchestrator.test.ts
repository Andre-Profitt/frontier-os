// R6 orchestrator tests. The orchestrator composes broker + worktree
// manager + skill loader + rubric scorer + arbiter. Tests use:
//   - real WorktreeManager against a mkdtempSync git repo (so the
//     `git worktree` + `git apply` paths actually run)
//   - a stub broker that branches on taskClass: returns canned diffs
//     for patch_builder calls and canned JSON for adversarial_review
//   - injected loaders (skill/rubric/anti-example/verifier) so tests
//     don't depend on the on-disk skills/ or taste/ tree
//
// The acceptance criteria from GPT's R6 spec are pinned by name in
// the test descriptions.

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { runOrchestration } from "../orchestrator.ts";
import { OrchestrationError } from "../types.ts";
import { WorktreeManager } from "../../builders/worktree-manager.ts";
import type {
  AttemptRecord,
  BrokerCallOptions,
  BrokerCallResult,
  InferenceBroker,
} from "../../inference/broker.ts";
import type { Skill } from "../../skills/loader.ts";
import type { Rubric } from "../../arbiter/rubric-scorer.ts";

// --- helpers --------------------------------------------------------------

function git(args: string[], cwd: string) {
  const r = spawnSync("git", args, { cwd, encoding: "utf8" });
  return {
    ok: r.status === 0,
    stdout: typeof r.stdout === "string" ? r.stdout : "",
    stderr: typeof r.stderr === "string" ? r.stderr : "",
  };
}

function makeRepo(): { repoRoot: string; cleanup: () => void } {
  const repoRoot = mkdtempSync(join(tmpdir(), "orch-test-"));
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

function syntheticSkill(taskClass: string): Skill {
  return {
    skillId: taskClass,
    version: "v1",
    taskClass,
    summary: `synthetic ${taskClass}`,
    allowedRoles: taskClass === "patch_builder" ? ["builder"] : ["reviewer"],
    allowedTools: ["read.file"],
    forbiddenTools: ["exec.git.push", "launchd.apply"],
    maxParallel: 4,
    sideEffects: ["local_write"],
    verifierMode: "none",
    promptTemplate: "SKILL.md",
    antiExamples: [],
    skillDir: "/tmp/synthetic",
    promptTemplatePath: "/tmp/synthetic/SKILL.md",
  };
}

function syntheticRubric(): Rubric {
  return {
    rubricId: "test_rubric",
    version: "v1",
    summary: "test",
    criteria: [
      {
        id: "R1",
        title: "passed implies invariants",
        rationale: "verification",
        weight: 1,
      },
      {
        id: "R2",
        title: "no false-green repair",
        rationale: "reviewer",
        weight: 1,
      },
    ],
  };
}

const TEMPLATE_BUILDER = "B {{builderId}} task {{taskId}} wt {{worktreePath}}";
const TEMPLATE_REVIEWER = "R {{reviewerId}}/{{reviewerCount}} {{patchId}}";

const SAMPLE_DIFF = `diff --git a/added.ts b/added.ts
new file mode 100644
index 0000000..ce01362
--- /dev/null
+++ b/added.ts
@@ -0,0 +1 @@
+export const v = 42;
`;

function builderResponse(): string {
  return `\`\`\`diff\n${SAMPLE_DIFF}\`\`\``;
}

function reviewerOk(category = "style", severity = "low"): string {
  return JSON.stringify({
    findings: [{ category, severity, claim: "synthetic finding" }],
    summary: "ok",
  });
}

function reviewerClean(): string {
  return JSON.stringify({ findings: [], summary: "no findings" });
}

// Stub broker that branches by taskClass. Lets a single test feed
// different responses to builders vs reviewers.
interface StubResponse {
  ok?: boolean;
  status?: number;
  modelKey?: string;
  durationMs?: number;
  text?: string;
}

class StubBroker implements Pick<InferenceBroker, "callClass"> {
  private byClass = new Map<string, StubResponse[]>();
  private defaultByClass = new Map<string, StubResponse>();
  public callLog: Array<{
    taskClass: string;
    modelOverride: string | undefined;
  }> = [];
  // Patch V: capture the rendered prompt content per call so
  // integration tests can assert that orchestrator-supplied template
  // variables (e.g. builderVerificationRecord) reach the model. Empty
  // when message content is not a plain string.
  public promptLog: Array<{ taskClass: string; content: string }> = [];

  enqueueFor(taskClass: string, ...responses: StubResponse[]): void {
    const arr = this.byClass.get(taskClass) ?? [];
    arr.push(...responses);
    this.byClass.set(taskClass, arr);
  }

  setDefaultFor(taskClass: string, response: StubResponse): void {
    this.defaultByClass.set(taskClass, response);
  }

  async callClass(opts: BrokerCallOptions): Promise<BrokerCallResult> {
    this.callLog.push({
      taskClass: opts.taskClass,
      modelOverride: opts.modelOverride,
    });
    const msgContent = opts.messages?.[0]?.content;
    this.promptLog.push({
      taskClass: opts.taskClass,
      content: typeof msgContent === "string" ? msgContent : "",
    });
    const queue = this.byClass.get(opts.taskClass) ?? [];
    const next = queue.shift() ?? this.defaultByClass.get(opts.taskClass);
    if (!next) {
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
    const ok = next.ok ?? true;
    const record: AttemptRecord = {
      modelKey: opts.modelOverride ?? next.modelKey ?? `stub:${opts.taskClass}`,
      provider: "stub",
      model: opts.taskClass,
      attemptNumber: 1,
      bucketGranted: true,
      bucketWaitedMs: 0,
      status: next.status ?? 200,
      ok,
      durationMs: next.durationMs ?? 5,
      retryAfterMs: null,
    };
    return {
      ok,
      taskClass: opts.taskClass,
      attempts: [record],
      selected: ok ? record : null,
      selectedResponse: ok ? { text: next.text ?? "", rawBody: null } : null,
      totalDurationMs: record.durationMs,
      rejected: ok ? null : "all-attempts-failed",
    };
  }
}

const COMMON_DEPS_OVERRIDES = {
  loadSkillImpl: (tc: string) => syntheticSkill(tc),
  loadPromptTemplateImpl: (skill: Skill) =>
    skill.taskClass === "patch_builder" ? TEMPLATE_BUILDER : TEMPLATE_REVIEWER,
  loadRubricImpl: () => syntheticRubric(),
  loadAntiExampleImpl: () => "",
};

// --- input validation ----------------------------------------------------

test("runOrchestration: rejects unsafe taskId", async () => {
  const { repoRoot, cleanup } = makeRepo();
  try {
    await assert.rejects(
      () =>
        runOrchestration(
          {
            broker: new StubBroker() as unknown as InferenceBroker,
            worktreeManager: buildManager(repoRoot),
            artifactsRoot: resolve(repoRoot, "artifacts"),
            ...COMMON_DEPS_OVERRIDES,
          },
          {
            taskId: "../etc/passwd",
            taskDescription: "x",
            rubricPath: "/x.json",
          },
        ),
      OrchestrationError,
    );
  } finally {
    cleanup();
  }
});

// --- builder → review → arbiter ordering (acceptance test #1) ------------

test("runOrchestration: runs builder → review → arbiter in order with the right inputs", async () => {
  const broker = new StubBroker();
  // 2 builder calls (both produce diff) → 2 collected candidates
  broker.enqueueFor("patch_builder", { text: builderResponse() });
  broker.enqueueFor("patch_builder", { text: builderResponse() });
  // 6 reviewer calls (3 per candidate × 2 candidates), all clean
  broker.setDefaultFor("adversarial_review", { text: reviewerClean() });

  const { repoRoot, cleanup } = makeRepo();
  try {
    const packet = await runOrchestration(
      {
        broker: broker as unknown as InferenceBroker,
        worktreeManager: buildManager(repoRoot),
        artifactsRoot: resolve(repoRoot, "artifacts"),
        verifierImpl: ({ builderId }) => ({
          builderId,
          worktreePath: `/tmp/${builderId}`,
          phase: "passed" as const,
          typecheckExitCode: 0,
          testExitCode: 0,
          ranAt: "2026-04-26T22:00:00.000Z",
        }),
        ...COMMON_DEPS_OVERRIDES,
      },
      {
        taskId: "ordered",
        taskDescription: "x",
        builderCount: 2,
        reviewerCount: 3,
        baseBranch: "main",
        touchList: ["added.ts"],
        rubricPath: "/x.json",
        qualityFloor: 0.5,
        // Two eligible candidates → arbiter escalates (no auto-tiebreak).
      },
    );

    // Call ordering: 2 builder calls first, then 6 reviewer calls.
    const builderCalls = broker.callLog.filter(
      (c) => c.taskClass === "patch_builder",
    );
    const reviewerCalls = broker.callLog.filter(
      (c) => c.taskClass === "adversarial_review",
    );
    assert.equal(builderCalls.length, 2);
    assert.equal(reviewerCalls.length, 6); // 3 reviewers × 2 candidates
    // First builder call must come before first reviewer call.
    const firstBuilderIdx = broker.callLog.findIndex(
      (c) => c.taskClass === "patch_builder",
    );
    const firstReviewerIdx = broker.callLog.findIndex(
      (c) => c.taskClass === "adversarial_review",
    );
    assert.ok(firstBuilderIdx < firstReviewerIdx);

    // Two collected candidates with no findings → arbiter sees both as
    // eligible → escalate_to_human.
    assert.equal(packet.summary?.buildersCollected, 2);
    assert.equal(packet.summary?.reviewSwarmsRun, 2);
    assert.equal(packet.summary?.arbiterDecision, "escalate_to_human");
    assert.equal(packet.exitCode, 2);
  } finally {
    cleanup();
  }
});

// --- builder partial failure (acceptance test #2) ------------------------

test("runOrchestration: builder partial failure → arbiter still runs over surviving candidates", async () => {
  const broker = new StubBroker();
  // b1 produces a diff; b2 returns text without a diff.
  broker.enqueueFor("patch_builder", { text: builderResponse() });
  broker.enqueueFor("patch_builder", { text: "I cannot determine the change" });
  broker.setDefaultFor("adversarial_review", { text: reviewerClean() });

  const { repoRoot, cleanup } = makeRepo();
  try {
    const packet = await runOrchestration(
      {
        broker: broker as unknown as InferenceBroker,
        worktreeManager: buildManager(repoRoot),
        artifactsRoot: resolve(repoRoot, "artifacts"),
        verifierImpl: ({ builderId }) => ({
          builderId,
          worktreePath: `/tmp/${builderId}`,
          phase: "passed" as const,
          typecheckExitCode: 0,
          testExitCode: 0,
          ranAt: "2026-04-26T22:00:00.000Z",
        }),
        ...COMMON_DEPS_OVERRIDES,
      },
      {
        taskId: "partial-builder",
        taskDescription: "x",
        builderCount: 2,
        reviewerCount: 1,
        baseBranch: "main",
        touchList: ["added.ts"],
        rubricPath: "/x.json",
        qualityFloor: 0.5,
      },
    );

    assert.equal(packet.summary?.buildersSpawned, 2);
    assert.equal(packet.summary?.buildersCollected, 1);
    assert.equal(packet.summary?.reviewSwarmsRun, 1);
    // Exactly one eligible → accept.
    assert.equal(packet.summary?.arbiterDecision, "accept");
    assert.equal(packet.exitCode, 0);
  } finally {
    cleanup();
  }
});

// --- reviewer partial failure (acceptance test #3) -----------------------

test("runOrchestration: reviewer partial failure (low coverage) → arbiter escalates", async () => {
  const broker = new StubBroker();
  broker.enqueueFor("patch_builder", { text: builderResponse() });
  // 3 reviewers — 1 valid, 2 garbage. reviewCoverage = 1/3 ≈ 0.33,
  // below the default 0.66 floor → reviewCoverageOk=false →
  // uncertainty-only → escalate.
  broker.enqueueFor("adversarial_review", { text: reviewerClean() });
  broker.enqueueFor("adversarial_review", { text: "garbage 1" });
  broker.enqueueFor("adversarial_review", { text: "garbage 2" });

  const { repoRoot, cleanup } = makeRepo();
  try {
    const packet = await runOrchestration(
      {
        broker: broker as unknown as InferenceBroker,
        worktreeManager: buildManager(repoRoot),
        artifactsRoot: resolve(repoRoot, "artifacts"),
        verifierImpl: ({ builderId }) => ({
          builderId,
          worktreePath: `/tmp/${builderId}`,
          phase: "passed" as const,
          typecheckExitCode: 0,
          testExitCode: 0,
          ranAt: "2026-04-26T22:00:00.000Z",
        }),
        ...COMMON_DEPS_OVERRIDES,
      },
      {
        taskId: "partial-rev",
        taskDescription: "x",
        builderCount: 1,
        reviewerCount: 3,
        baseBranch: "main",
        touchList: ["added.ts"],
        rubricPath: "/x.json",
        qualityFloor: 0.5,
      },
    );
    assert.equal(packet.summary?.arbiterDecision, "escalate_to_human");
    assert.equal(packet.exitCode, 2);
  } finally {
    cleanup();
  }
});

// --- all-builder failure → reject (no reviewers invoked) -----------------

test("runOrchestration: zero collected builders → reject, no reviewer calls", async () => {
  const broker = new StubBroker();
  // Both builders return non-diff text → no_diff_extracted phase.
  broker.enqueueFor("patch_builder", { text: "no diff" });
  broker.enqueueFor("patch_builder", { text: "still no diff" });

  const { repoRoot, cleanup } = makeRepo();
  try {
    const packet = await runOrchestration(
      {
        broker: broker as unknown as InferenceBroker,
        worktreeManager: buildManager(repoRoot),
        artifactsRoot: resolve(repoRoot, "artifacts"),
        ...COMMON_DEPS_OVERRIDES,
      },
      {
        taskId: "all-fail",
        taskDescription: "x",
        builderCount: 2,
        reviewerCount: 1,
        baseBranch: "main",
        touchList: ["added.ts"],
        rubricPath: "/x.json",
      },
    );
    assert.equal(packet.summary?.buildersCollected, 0);
    assert.equal(packet.summary?.reviewSwarmsRun, 0);
    assert.equal(packet.summary?.arbiterDecision, "reject");
    assert.equal(packet.exitCode, 1);
    // No reviewer calls were issued.
    const reviewerCalls = broker.callLog.filter(
      (c) => c.taskClass === "adversarial_review",
    );
    assert.equal(reviewerCalls.length, 0);
  } finally {
    cleanup();
  }
});

// --- artifact dir structure (acceptance test #4) -------------------------

test("runOrchestration: writes the expected artifact tree", async () => {
  const broker = new StubBroker();
  broker.enqueueFor("patch_builder", { text: builderResponse() });
  broker.setDefaultFor("adversarial_review", { text: reviewerClean() });

  const { repoRoot, cleanup } = makeRepo();
  try {
    const artifactsRoot = resolve(repoRoot, "artifacts");
    const packet = await runOrchestration(
      {
        broker: broker as unknown as InferenceBroker,
        worktreeManager: buildManager(repoRoot),
        artifactsRoot,
        verifierImpl: ({ builderId }) => ({
          builderId,
          worktreePath: `/tmp/${builderId}`,
          phase: "passed" as const,
          typecheckExitCode: 0,
          testExitCode: 0,
          ranAt: "2026-04-26T22:00:00.000Z",
        }),
        ...COMMON_DEPS_OVERRIDES,
      },
      {
        taskId: "art-tree",
        taskDescription: "x",
        builderCount: 1,
        reviewerCount: 2,
        baseBranch: "main",
        touchList: ["added.ts"],
        rubricPath: "/x.json",
        qualityFloor: 0.5,
      },
    );

    const dir = packet.artifactsDir;
    assert.ok(existsSync(resolve(dir, "builder-swarm-packet.json")));
    assert.ok(existsSync(resolve(dir, "arbiter-decision.json")));
    assert.ok(existsSync(resolve(dir, "final-report.md")));
    assert.ok(existsSync(resolve(dir, "orchestration-packet.json")));
    // Per-candidate review packet exists.
    assert.equal(packet.reviewPacketPaths.length, 1);
    assert.ok(existsSync(packet.reviewPacketPaths[0]!.path));
    // No context-pack file when no lane provided.
    assert.equal(packet.contextPackPath, undefined);
    assert.ok(!existsSync(resolve(dir, "context-pack.md")));

    // Final report contains the decision and rubric coverage line.
    const report = readFileSync(resolve(dir, "final-report.md"), "utf8");
    assert.match(report, /\*\*Decision:\*\* `accept`/);
    assert.match(report, /Rubric scoring/);
  } finally {
    cleanup();
  }
});

// --- schema validation invariant -----------------------------------------

test("runOrchestration: persisted orchestration-packet.json validates against schema", async () => {
  const { validateOrchestrationPacket } = await import("../../schemas.ts");
  const broker = new StubBroker();
  broker.enqueueFor("patch_builder", { text: builderResponse() });
  broker.setDefaultFor("adversarial_review", { text: reviewerClean() });

  const { repoRoot, cleanup } = makeRepo();
  try {
    const packet = await runOrchestration(
      {
        broker: broker as unknown as InferenceBroker,
        worktreeManager: buildManager(repoRoot),
        artifactsRoot: resolve(repoRoot, "artifacts"),
        verifierImpl: ({ builderId }) => ({
          builderId,
          worktreePath: `/tmp/${builderId}`,
          phase: "passed" as const,
          typecheckExitCode: 0,
          testExitCode: 0,
          ranAt: "2026-04-26T22:00:00.000Z",
        }),
        ...COMMON_DEPS_OVERRIDES,
      },
      {
        taskId: "schema-check",
        taskDescription: "x",
        builderCount: 1,
        reviewerCount: 1,
        baseBranch: "main",
        touchList: ["added.ts"],
        rubricPath: "/x.json",
        qualityFloor: 0.5,
      },
    );
    const onDisk = JSON.parse(
      readFileSync(
        resolve(packet.artifactsDir, "orchestration-packet.json"),
        "utf8",
      ),
    );
    const valid = validateOrchestrationPacket(onDisk);
    if (!valid) {
      console.error(
        JSON.stringify(validateOrchestrationPacket.errors, null, 2),
      );
    }
    assert.equal(valid, true);
  } finally {
    cleanup();
  }
});

// --- no-auto-merge invariant (acceptance test #5) ------------------------

test("runOrchestration: never invokes any merge / push / launchd path (only reads + builder-local writes)", async () => {
  // We can't grep every code path, but we CAN assert the side-effect
  // surface stays inside the expected directories: artifactsDir,
  // worktreesDir, and the arbiter's verifier (which we stub). No write
  // to repoRoot/main, no write to ~/.frontier/, no spawn of `git push`.
  const broker = new StubBroker();
  broker.enqueueFor("patch_builder", { text: builderResponse() });
  broker.setDefaultFor("adversarial_review", { text: reviewerClean() });

  const { repoRoot, cleanup } = makeRepo();
  try {
    const headBefore = git(["rev-parse", "main"], repoRoot).stdout.trim();
    const packet = await runOrchestration(
      {
        broker: broker as unknown as InferenceBroker,
        worktreeManager: buildManager(repoRoot),
        artifactsRoot: resolve(repoRoot, "artifacts"),
        verifierImpl: ({ builderId }) => ({
          builderId,
          worktreePath: `/tmp/${builderId}`,
          phase: "passed" as const,
          typecheckExitCode: 0,
          testExitCode: 0,
          ranAt: "2026-04-26T22:00:00.000Z",
        }),
        ...COMMON_DEPS_OVERRIDES,
      },
      {
        taskId: "no-merge",
        taskDescription: "x",
        builderCount: 1,
        reviewerCount: 1,
        baseBranch: "main",
        touchList: ["added.ts"],
        rubricPath: "/x.json",
        qualityFloor: 0.5,
      },
    );
    // Main is unchanged (the orchestrator never merges).
    const headAfter = git(["rev-parse", "main"], repoRoot).stdout.trim();
    assert.equal(headBefore, headAfter);
    // Builder branch exists (created by WorktreeManager) but main wasn't touched.
    const branches = git(["branch"], repoRoot).stdout;
    assert.match(branches, /builders\//);
    assert.match(branches, /\* main/);
    void packet;
  } finally {
    cleanup();
  }
});

// --- cleanup flag --------------------------------------------------------

test("runOrchestration: --cleanup PRESERVES the accepted candidate's worktree (Patch G B2)", async () => {
  // Pre-Patch-G this deleted the accepted candidate's worktree before
  // the operator could apply its patch — final report's "apply from
  // worktree X" instruction would point at a missing directory.
  // Patch G keeps the selected candidate's worktree and only removes
  // the others.
  const broker = new StubBroker();
  broker.enqueueFor("patch_builder", { text: builderResponse() });
  broker.setDefaultFor("adversarial_review", { text: reviewerClean() });

  const { repoRoot, cleanup } = makeRepo();
  try {
    const mgr = buildManager(repoRoot);
    const packet = await runOrchestration(
      {
        broker: broker as unknown as InferenceBroker,
        worktreeManager: mgr,
        artifactsRoot: resolve(repoRoot, "artifacts"),
        verifierImpl: ({ builderId }) => ({
          builderId,
          worktreePath: `/tmp/${builderId}`,
          phase: "passed" as const,
          typecheckExitCode: 0,
          testExitCode: 0,
          ranAt: "2026-04-26T22:00:00.000Z",
        }),
        ...COMMON_DEPS_OVERRIDES,
      },
      {
        taskId: "cleanup-accept",
        taskDescription: "x",
        builderCount: 1,
        reviewerCount: 1,
        baseBranch: "main",
        touchList: ["added.ts"],
        rubricPath: "/x.json",
        qualityFloor: 0.5,
        cleanup: true,
      },
    );
    // Single candidate accepted → worktree PRESERVED for the operator
    // to apply the patch.
    assert.equal(packet.summary?.arbiterDecision, "accept");
    const builderPacket = JSON.parse(
      readFileSync(packet.builderPacketPath, "utf8"),
    );
    const wt = builderPacket.candidates[0]?.worktreePath;
    assert.ok(typeof wt === "string");
    assert.equal(existsSync(wt), true);
  } finally {
    cleanup();
  }
});

test("runOrchestration: --cleanup removes NON-selected candidates' worktrees (Patch G B2)", async () => {
  // With multiple eligible candidates, arbiter escalates and there is
  // no selectedBuilderId. In that case --cleanup removes everything
  // (operator has no specific patch to apply). When one is selected,
  // only the others are removed.
  const broker = new StubBroker();
  // Builder b1 collects with valid diff; builder b2 also collects.
  broker.enqueueFor("patch_builder", {
    text: builderResponse(),
    modelKey: "stub:m1",
  });
  broker.enqueueFor("patch_builder", {
    text: builderResponse(),
    modelKey: "stub:m2",
  });
  broker.setDefaultFor("adversarial_review", { text: reviewerClean() });

  const { repoRoot, cleanup } = makeRepo();
  try {
    const mgr = buildManager(repoRoot);
    const packet = await runOrchestration(
      {
        broker: broker as unknown as InferenceBroker,
        worktreeManager: mgr,
        artifactsRoot: resolve(repoRoot, "artifacts"),
        verifierImpl: ({ builderId }) => ({
          builderId,
          worktreePath: `/tmp/${builderId}`,
          phase: "passed" as const,
          typecheckExitCode: 0,
          testExitCode: 0,
          ranAt: "2026-04-26T22:00:00.000Z",
        }),
        ...COMMON_DEPS_OVERRIDES,
      },
      {
        taskId: "cleanup-multi",
        taskDescription: "x",
        builderCount: 2,
        reviewerCount: 1,
        baseBranch: "main",
        touchList: ["added.ts"],
        rubricPath: "/x.json",
        qualityFloor: 0.5,
        cleanup: true,
      },
    );
    // Two eligible → escalate (no selectedBuilderId) → all removed.
    assert.equal(packet.summary?.arbiterDecision, "escalate_to_human");
    const builderPacket = JSON.parse(
      readFileSync(packet.builderPacketPath, "utf8"),
    );
    for (const c of builderPacket.candidates) {
      if (typeof c.worktreePath === "string") {
        assert.equal(existsSync(c.worktreePath), false);
      }
    }
  } finally {
    cleanup();
  }
});

// --- context pack --------------------------------------------------------

test("runOrchestration: context pack runs when --lane provided and writes context-pack.md", async () => {
  const broker = new StubBroker();
  broker.enqueueFor("patch_builder", { text: builderResponse() });
  broker.setDefaultFor("adversarial_review", { text: reviewerClean() });

  const { repoRoot, cleanup } = makeRepo();
  try {
    const packet = await runOrchestration(
      {
        broker: broker as unknown as InferenceBroker,
        worktreeManager: buildManager(repoRoot),
        artifactsRoot: resolve(repoRoot, "artifacts"),
        contextPackImpl: (lane) => `# Context for ${lane}\n\nstub markdown\n`,
        verifierImpl: ({ builderId }) => ({
          builderId,
          worktreePath: `/tmp/${builderId}`,
          phase: "passed" as const,
          typecheckExitCode: 0,
          testExitCode: 0,
          ranAt: "2026-04-26T22:00:00.000Z",
        }),
        ...COMMON_DEPS_OVERRIDES,
      },
      {
        taskId: "with-lane",
        taskDescription: "x",
        builderCount: 1,
        reviewerCount: 1,
        baseBranch: "main",
        touchList: ["added.ts"],
        rubricPath: "/x.json",
        contextPackLane: "test-lane",
        qualityFloor: 0.5,
      },
    );
    assert.ok(packet.contextPackPath);
    const md = readFileSync(packet.contextPackPath!, "utf8");
    assert.match(md, /Context for test-lane/);
  } finally {
    cleanup();
  }
});

test("runOrchestration: context pack failure is non-fatal — error file written, run continues", async () => {
  const broker = new StubBroker();
  broker.enqueueFor("patch_builder", { text: builderResponse() });
  broker.setDefaultFor("adversarial_review", { text: reviewerClean() });

  const { repoRoot, cleanup } = makeRepo();
  try {
    const packet = await runOrchestration(
      {
        broker: broker as unknown as InferenceBroker,
        worktreeManager: buildManager(repoRoot),
        artifactsRoot: resolve(repoRoot, "artifacts"),
        contextPackImpl: () => {
          throw new Error("lane probe failed");
        },
        verifierImpl: ({ builderId }) => ({
          builderId,
          worktreePath: `/tmp/${builderId}`,
          phase: "passed" as const,
          typecheckExitCode: 0,
          testExitCode: 0,
          ranAt: "2026-04-26T22:00:00.000Z",
        }),
        ...COMMON_DEPS_OVERRIDES,
      },
      {
        taskId: "ctx-fail",
        taskDescription: "x",
        builderCount: 1,
        reviewerCount: 1,
        baseBranch: "main",
        touchList: ["added.ts"],
        rubricPath: "/x.json",
        contextPackLane: "broken-lane",
        qualityFloor: 0.5,
      },
    );
    // Run still completed.
    assert.equal(packet.summary?.arbiterDecision, "accept");
    // Error file written.
    assert.ok(
      existsSync(resolve(packet.artifactsDir, "context-pack-error.txt")),
    );
    assert.equal(packet.contextPackPath, undefined);
  } finally {
    cleanup();
  }
});

// --- Patch V: end-to-end builderVerificationRecord wiring -------------

test("runOrchestration (Patch V): typecheckCommand → builder runs verifier → reviewer prompt sees formatted record", async () => {
  // End-to-end pin: the orchestrator forwards typecheckCommand to
  // the builder swarm; the builder runs the verifier (here a stub);
  // the candidate's builderVerification is formatted; the reviewer
  // prompt contains the formatted string.
  const broker = new StubBroker();
  broker.enqueueFor("patch_builder", { text: builderResponse() });
  broker.setDefaultFor("adversarial_review", { text: reviewerClean() });

  const { repoRoot, cleanup } = makeRepo();
  try {
    await runOrchestration(
      {
        broker: broker as unknown as InferenceBroker,
        worktreeManager: buildManager(repoRoot),
        artifactsRoot: resolve(repoRoot, "artifacts"),
        // Reviewer template includes the verification slot so we can
        // assert end-to-end rendering.
        loadSkillImpl: (tc: string) => syntheticSkill(tc),
        loadPromptTemplateImpl: (skill: Skill) =>
          skill.taskClass === "patch_builder"
            ? TEMPLATE_BUILDER
            : "R {{reviewerId}} verification: {{builderVerificationRecord}}",
        loadRubricImpl: () => syntheticRubric(),
        loadAntiExampleImpl: () => "",
        // verifierImpl is shared between builder self-verification
        // (Patch V) and arbiter re-verification.
        verifierImpl: ({ builderId }) => ({
          builderId,
          worktreePath: `/tmp/${builderId}`,
          phase: "passed" as const,
          typecheckExitCode: 0,
          testExitCode: 0,
          ranAt: "2026-04-27T12:00:00.000Z",
        }),
      },
      {
        taskId: "patch-v-e2e",
        taskDescription: "x",
        builderCount: 1,
        reviewerCount: 1,
        baseBranch: "main",
        touchList: ["added.ts"],
        rubricPath: "/x.json",
        // Setting either command opts the builder into self-verification.
        typecheckCommand: ["echo", "stub-typecheck"],
        testCommand: ["echo", "stub-test"],
        qualityFloor: 0.5,
      },
    );
    const reviewerPrompts = broker.promptLog.filter(
      (p) => p.taskClass === "adversarial_review",
    );
    assert.ok(reviewerPrompts.length > 0, "expected reviewer call");
    const prompt = reviewerPrompts[0]!.content;
    assert.match(prompt, /typecheck: exit_code=0 \(passed\)/);
    assert.match(prompt, /tests: exit_code=0 \(passed\)/);
    assert.match(prompt, /ran_at: 2026-04-27T12:00:00\.000Z/);
    // Slot fully substituted — no literal placeholder leaked.
    assert.doesNotMatch(prompt, /\{\{builderVerificationRecord\}\}/);
  } finally {
    cleanup();
  }
});

test("runOrchestration (Patch V): no typecheck/test commands → reviewer prompt slot stays empty (regression)", async () => {
  // When the operator doesn't ask for self-verification, the
  // reviewer prompt's verification slot renders empty. The literal
  // `{{builderVerificationRecord}}` must NOT leak into the prompt.
  const broker = new StubBroker();
  broker.enqueueFor("patch_builder", { text: builderResponse() });
  broker.setDefaultFor("adversarial_review", { text: reviewerClean() });

  const { repoRoot, cleanup } = makeRepo();
  try {
    await runOrchestration(
      {
        broker: broker as unknown as InferenceBroker,
        worktreeManager: buildManager(repoRoot),
        artifactsRoot: resolve(repoRoot, "artifacts"),
        loadSkillImpl: (tc: string) => syntheticSkill(tc),
        loadPromptTemplateImpl: (skill: Skill) =>
          skill.taskClass === "patch_builder"
            ? TEMPLATE_BUILDER
            : "R {{reviewerId}} verification: {{builderVerificationRecord}}",
        loadRubricImpl: () => syntheticRubric(),
        loadAntiExampleImpl: () => "",
        verifierImpl: ({ builderId }) => ({
          builderId,
          worktreePath: `/tmp/${builderId}`,
          phase: "passed" as const,
          typecheckExitCode: 0,
          testExitCode: 0,
          ranAt: "2026-04-27T12:00:00.000Z",
        }),
      },
      {
        taskId: "patch-v-no-verify",
        taskDescription: "x",
        builderCount: 1,
        reviewerCount: 1,
        baseBranch: "main",
        touchList: ["added.ts"],
        rubricPath: "/x.json",
        // typecheckCommand / testCommand omitted → builder skips verification
        qualityFloor: 0.5,
      },
    );
    const reviewerPrompts = broker.promptLog.filter(
      (p) => p.taskClass === "adversarial_review",
    );
    assert.ok(reviewerPrompts.length > 0);
    const prompt = reviewerPrompts[0]!.content;
    assert.doesNotMatch(prompt, /\{\{builderVerificationRecord\}\}/);
    // Slot empty — "verification: " followed by nothing useful.
    assert.match(prompt, /verification:\s*$/);
  } finally {
    cleanup();
  }
});

// --- Patch V: formatBuilderVerificationRecord pure function ----------

test("formatBuilderVerificationRecord: full success", async () => {
  const { formatBuilderVerificationRecord } =
    await import("../orchestrator.ts");
  const out = formatBuilderVerificationRecord({
    typecheckExitCode: 0,
    testExitCode: 0,
    ranAt: "2026-04-27T12:00:00.000Z",
  });
  assert.match(out, /typecheck: exit_code=0 \(passed\)/);
  assert.match(out, /tests: exit_code=0 \(passed\)/);
  assert.match(out, /ran_at: 2026-04-27T12:00:00\.000Z/);
});

test("formatBuilderVerificationRecord: typecheck failed, tests not run", async () => {
  const { formatBuilderVerificationRecord } =
    await import("../orchestrator.ts");
  const out = formatBuilderVerificationRecord({
    typecheckExitCode: 1,
    ranAt: "2026-04-27T12:00:00.000Z",
  });
  assert.match(out, /typecheck: exit_code=1 \(failed\)/);
  assert.match(out, /tests: not_run/);
});

test("formatBuilderVerificationRecord: undefined → empty string", async () => {
  const { formatBuilderVerificationRecord } =
    await import("../orchestrator.ts");
  assert.equal(formatBuilderVerificationRecord(undefined), "");
});

// --- Patch S non-blocker: requireContextPack=true makes failure fatal --

test("runOrchestration (Patch S): requireContextPack=true → context-pack failure throws OrchestrationError", async () => {
  // GPT Pro non-blocker: for repo/factory tasks, a context-pack
  // failure used to be silently logged and the orchestration ran
  // anyway — but that's exactly the workflow that surfaced a wrong-
  // repo hallucination earlier. Operators on those task classes need
  // a hard stop when the context pack can't be assembled. Default
  // remains non-fatal (regression test below pins this).
  const broker = new StubBroker();
  broker.enqueueFor("patch_builder", { text: builderResponse() });
  broker.setDefaultFor("adversarial_review", { text: reviewerClean() });

  const { repoRoot, cleanup } = makeRepo();
  try {
    await assert.rejects(
      () =>
        runOrchestration(
          {
            broker: broker as unknown as InferenceBroker,
            worktreeManager: buildManager(repoRoot),
            artifactsRoot: resolve(repoRoot, "artifacts"),
            contextPackImpl: () => {
              throw new Error("lane probe failed");
            },
            ...COMMON_DEPS_OVERRIDES,
          },
          {
            taskId: "ctx-fail-strict",
            taskDescription: "x",
            builderCount: 1,
            reviewerCount: 1,
            baseBranch: "main",
            touchList: ["added.ts"],
            rubricPath: "/x.json",
            contextPackLane: "broken-lane",
            requireContextPack: true,
            qualityFloor: 0.5,
          },
        ),
      /context pack/i,
    );
    // Error file should still be written for forensics, even though
    // the orchestrator aborted.
    assert.ok(
      existsSync(
        resolve(
          repoRoot,
          "artifacts",
          "ctx-fail-strict",
          "context-pack-error.txt",
        ),
      ),
    );
  } finally {
    cleanup();
  }
});

test("runOrchestration (Patch S): requireContextPack default false → failure remains non-fatal (regression)", async () => {
  // Default behavior preserved: context-pack failure is logged and
  // the run continues. Existing test ("context pack failure is non-
  // fatal") covers this, but pinning it here under the Patch S
  // umbrella so future changes to the strict path don't accidentally
  // flip the default.
  const broker = new StubBroker();
  broker.enqueueFor("patch_builder", { text: builderResponse() });
  broker.setDefaultFor("adversarial_review", { text: reviewerClean() });

  const { repoRoot, cleanup } = makeRepo();
  try {
    const packet = await runOrchestration(
      {
        broker: broker as unknown as InferenceBroker,
        worktreeManager: buildManager(repoRoot),
        artifactsRoot: resolve(repoRoot, "artifacts"),
        contextPackImpl: () => {
          throw new Error("lane probe failed");
        },
        verifierImpl: ({ builderId }) => ({
          builderId,
          worktreePath: `/tmp/${builderId}`,
          phase: "passed" as const,
          typecheckExitCode: 0,
          testExitCode: 0,
          ranAt: "2026-04-26T22:00:00.000Z",
        }),
        ...COMMON_DEPS_OVERRIDES,
      },
      {
        taskId: "ctx-fail-default",
        taskDescription: "x",
        builderCount: 1,
        reviewerCount: 1,
        baseBranch: "main",
        touchList: ["added.ts"],
        rubricPath: "/x.json",
        contextPackLane: "broken-lane",
        // requireContextPack omitted → default false
        qualityFloor: 0.5,
      },
    );
    assert.equal(packet.summary?.arbiterDecision, "accept");
    assert.equal(packet.contextPackPath, undefined);
  } finally {
    cleanup();
  }
});

// --- model pinning flows through orchestrator → builder swarm → broker --

test("runOrchestration: builderModelKeys forwarded as broker.callClass({modelOverride}) per builder", async () => {
  const broker = new StubBroker();
  broker.enqueueFor("patch_builder", { text: builderResponse() });
  broker.enqueueFor("patch_builder", { text: builderResponse() });
  broker.setDefaultFor("adversarial_review", { text: reviewerClean() });

  const { repoRoot, cleanup } = makeRepo();
  try {
    await runOrchestration(
      {
        broker: broker as unknown as InferenceBroker,
        worktreeManager: buildManager(repoRoot),
        artifactsRoot: resolve(repoRoot, "artifacts"),
        verifierImpl: ({ builderId }) => ({
          builderId,
          worktreePath: `/tmp/${builderId}`,
          phase: "passed" as const,
          typecheckExitCode: 0,
          testExitCode: 0,
          ranAt: "2026-04-26T22:00:00.000Z",
        }),
        // Patch P regression: this test pre-dates reviewer auto-
        // distribution. Disable the policy-driven derivation so the
        // test's "no reviewer modelOverride" assertion stays meaningful
        // (separate Patch P tests cover the new auto-derive path).
        reviewerModelsImpl: () => undefined,
        ...COMMON_DEPS_OVERRIDES,
      },
      {
        taskId: "pin",
        taskDescription: "x",
        builderCount: 2,
        reviewerCount: 1,
        baseBranch: "main",
        touchList: ["added.ts"],
        rubricPath: "/x.json",
        builderModelKeys: ["pinned:k1", "pinned:k2"],
        qualityFloor: 0.5,
      },
    );
    const builderOverrides = broker.callLog
      .filter((c) => c.taskClass === "patch_builder")
      .map((c) => c.modelOverride)
      .filter((m): m is string => m !== undefined)
      .sort();
    assert.deepEqual(builderOverrides, ["pinned:k1", "pinned:k2"]);
    // Reviewer calls: with reviewerModelsImpl returning undefined,
    // no modelOverrides should be passed.
    const reviewerOverrides = broker.callLog
      .filter((c) => c.taskClass === "adversarial_review")
      .map((c) => c.modelOverride);
    assert.ok(reviewerOverrides.every((m) => m === undefined));
  } finally {
    cleanup();
  }
});

// --- exit codes match arbiter (acceptance test #6) ----------------------

test("runOrchestration: exit code matches arbiter decision (0/1/2 = accept/reject/escalate)", async () => {
  // accept already covered by the artifact-tree test.
  // reject covered by the all-fail test.
  // escalate covered by the partial-reviewer-failure test.
  // This test pins the explicit mapping.
  const broker = new StubBroker();
  broker.enqueueFor("patch_builder", { text: builderResponse() });
  broker.enqueueFor("patch_builder", { text: builderResponse() });
  broker.setDefaultFor("adversarial_review", { text: reviewerClean() });

  const { repoRoot, cleanup } = makeRepo();
  try {
    const packet = await runOrchestration(
      {
        broker: broker as unknown as InferenceBroker,
        worktreeManager: buildManager(repoRoot),
        artifactsRoot: resolve(repoRoot, "artifacts"),
        verifierImpl: ({ builderId }) => ({
          builderId,
          worktreePath: `/tmp/${builderId}`,
          phase: "passed" as const,
          typecheckExitCode: 0,
          testExitCode: 0,
          ranAt: "2026-04-26T22:00:00.000Z",
        }),
        ...COMMON_DEPS_OVERRIDES,
      },
      {
        taskId: "exit-codes",
        taskDescription: "x",
        builderCount: 2,
        reviewerCount: 1,
        baseBranch: "main",
        touchList: ["added.ts"],
        rubricPath: "/x.json",
        qualityFloor: 0.5,
      },
    );
    // Two eligible → escalate → exit 2.
    assert.equal(packet.summary?.arbiterDecision, "escalate_to_human");
    assert.equal(packet.exitCode, 2);
  } finally {
    cleanup();
  }
});

// --- Patch P: reviewer auto-distribution from policy class models ------

test("runOrchestration (Patch P): reviewerModelsImpl returns keys → reviewers distribute round-robin", async () => {
  const broker = new StubBroker();
  broker.enqueueFor("patch_builder", { text: builderResponse() });
  broker.enqueueFor("patch_builder", { text: builderResponse() });
  broker.setDefaultFor("adversarial_review", { text: reviewerClean() });
  const { repoRoot, cleanup } = makeRepo();
  try {
    await runOrchestration(
      {
        broker: broker as unknown as InferenceBroker,
        worktreeManager: buildManager(repoRoot),
        artifactsRoot: resolve(repoRoot, "artifacts"),
        verifierImpl: ({ builderId }) => ({
          builderId,
          worktreePath: `/tmp/${builderId}`,
          phase: "passed" as const,
          typecheckExitCode: 0,
          testExitCode: 0,
          ranAt: "2026-04-26T22:00:00.000Z",
        }),
        // Two reviewer models per Patch P diversity intent.
        reviewerModelsImpl: () => ["nim:reviewerA", "nim:reviewerB"],
        ...COMMON_DEPS_OVERRIDES,
      },
      {
        taskId: "patch-p-reviewer-distribute",
        taskDescription: "x",
        builderCount: 2,
        reviewerCount: 4, // 4 reviewers, 2 models → 2× round-robin
        baseBranch: "main",
        touchList: ["added.ts"],
        rubricPath: "/x.json",
        qualityFloor: 0.5,
      },
    );
    const reviewerOverrides = broker.callLog
      .filter((c) => c.taskClass === "adversarial_review")
      .map((c) => c.modelOverride);
    // 2 builders collected → 2 review-swarms × 4 reviewers each = 8
    // calls, each round-robining nim:reviewerA / nim:reviewerB.
    const counts = reviewerOverrides.reduce<Record<string, number>>(
      (acc, k) => {
        const key = k ?? "<undefined>";
        acc[key] = (acc[key] ?? 0) + 1;
        return acc;
      },
      {},
    );
    assert.ok(counts["nim:reviewerA"] && counts["nim:reviewerA"]! >= 2);
    assert.ok(counts["nim:reviewerB"] && counts["nim:reviewerB"]! >= 2);
    // No reviewer call left without an override.
    assert.equal(counts["<undefined>"] ?? 0, 0);
  } finally {
    cleanup();
  }
});

test("runOrchestration (Patch P): input.reviewerModelKeys overrides policy auto-derive", async () => {
  const broker = new StubBroker();
  broker.enqueueFor("patch_builder", { text: builderResponse() });
  broker.setDefaultFor("adversarial_review", { text: reviewerClean() });
  const { repoRoot, cleanup } = makeRepo();
  try {
    await runOrchestration(
      {
        broker: broker as unknown as InferenceBroker,
        worktreeManager: buildManager(repoRoot),
        artifactsRoot: resolve(repoRoot, "artifacts"),
        verifierImpl: ({ builderId }) => ({
          builderId,
          worktreePath: `/tmp/${builderId}`,
          phase: "passed" as const,
          typecheckExitCode: 0,
          testExitCode: 0,
          ranAt: "2026-04-26T22:00:00.000Z",
        }),
        // Policy says nim:fromPolicy, but operator passes
        // input.reviewerModelKeys explicitly — input wins.
        reviewerModelsImpl: () => ["nim:fromPolicy"],
        ...COMMON_DEPS_OVERRIDES,
      },
      {
        taskId: "patch-p-input-wins",
        taskDescription: "x",
        builderCount: 1,
        reviewerCount: 2,
        baseBranch: "main",
        touchList: ["added.ts"],
        rubricPath: "/x.json",
        reviewerModelKeys: ["nim:fromInput"],
        qualityFloor: 0.5,
      },
    );
    const reviewerOverrides = broker.callLog
      .filter((c) => c.taskClass === "adversarial_review")
      .map((c) => c.modelOverride);
    // All reviewers should use the input override, not the policy.
    assert.ok(reviewerOverrides.every((m) => m === "nim:fromInput"));
  } finally {
    cleanup();
  }
});

// --- Patch O: per-class gate defaults from policy ----------------------

test("runOrchestration (Patch O): policy class gates apply when CLI flag absent", async () => {
  // Pin the resolution order: when input.qualityFloor is undefined,
  // the orchestrator looks up policy class gates via classGatesImpl.
  // Test seam injects a known gates object; the arbiter decision file
  // (written by the orchestrator) records the qualityFloor that was
  // applied, which is what we assert against.
  const broker = new StubBroker();
  broker.enqueueFor("patch_builder", { text: builderResponse() });
  broker.enqueueFor("patch_builder", { text: builderResponse() });
  broker.setDefaultFor("adversarial_review", { text: reviewerClean() });
  const { repoRoot, cleanup } = makeRepo();
  try {
    const packet = await runOrchestration(
      {
        broker: broker as unknown as InferenceBroker,
        worktreeManager: buildManager(repoRoot),
        artifactsRoot: resolve(repoRoot, "artifacts"),
        verifierImpl: ({ builderId }) => ({
          builderId,
          worktreePath: `/tmp/${builderId}`,
          phase: "passed" as const,
          typecheckExitCode: 0,
          testExitCode: 0,
          ranAt: "2026-04-26T22:00:00.000Z",
        }),
        // Class gates: qualityFloor 0.42 (a sentinel value the test
        // checks for in the arbiter-decision.json).
        classGatesImpl: () => ({
          qualityFloor: 0.42,
          minRubricCoverage: 0.31,
          minReviewCoverage: 0.41,
        }),
        ...COMMON_DEPS_OVERRIDES,
      },
      {
        taskId: "patch-o-class-gates",
        taskDescription: "x",
        builderCount: 2,
        reviewerCount: 1,
        baseBranch: "main",
        touchList: ["added.ts"],
        rubricPath: "/x.json",
        // NO qualityFloor / minRubricCoverage / minReviewCoverage set
        // — class gates from the seam should win.
      },
    );
    const decisionPath = resolve(packet.artifactsDir, "arbiter-decision.json");
    const { readFileSync } = await import("node:fs");
    const decision = JSON.parse(readFileSync(decisionPath, "utf8"));
    // qualityFloor is the only gate field the arbiter persists to the
    // decision file. minRubricCoverage / minReviewCoverage are applied
    // by the arbiter's eligibility math but aren't recorded — the
    // decision's per-candidate `eligibility` line is the audit trail
    // for those.
    assert.equal(decision.qualityFloor, 0.42);
  } finally {
    cleanup();
  }
});

test("runOrchestration (Patch O): CLI flag wins over policy class gates", async () => {
  const broker = new StubBroker();
  broker.enqueueFor("patch_builder", { text: builderResponse() });
  broker.enqueueFor("patch_builder", { text: builderResponse() });
  broker.setDefaultFor("adversarial_review", { text: reviewerClean() });
  const { repoRoot, cleanup } = makeRepo();
  try {
    const packet = await runOrchestration(
      {
        broker: broker as unknown as InferenceBroker,
        worktreeManager: buildManager(repoRoot),
        artifactsRoot: resolve(repoRoot, "artifacts"),
        verifierImpl: ({ builderId }) => ({
          builderId,
          worktreePath: `/tmp/${builderId}`,
          phase: "passed" as const,
          typecheckExitCode: 0,
          testExitCode: 0,
          ranAt: "2026-04-26T22:00:00.000Z",
        }),
        // Class gates would say qualityFloor=0.42, but the operator
        // passed --quality-floor 0.99 explicitly. CLI must win.
        classGatesImpl: () => ({
          qualityFloor: 0.42,
        }),
        ...COMMON_DEPS_OVERRIDES,
      },
      {
        taskId: "patch-o-cli-wins",
        taskDescription: "x",
        builderCount: 2,
        reviewerCount: 1,
        baseBranch: "main",
        touchList: ["added.ts"],
        rubricPath: "/x.json",
        qualityFloor: 0.99, // operator override
      },
    );
    const decisionPath = resolve(packet.artifactsDir, "arbiter-decision.json");
    const { readFileSync } = await import("node:fs");
    const decision = JSON.parse(readFileSync(decisionPath, "utf8"));
    assert.equal(decision.qualityFloor, 0.99);
  } finally {
    cleanup();
  }
});

// --- regression: high-severity reviewer finding routes through correctly --

test("runOrchestration (Patch G B3): missing anti-example surfaces in final report ABOVE the decision line", async () => {
  // Pre-Patch-G the missing-anti-example escalation was buried in the
  // arbiter evidence code-fence; an operator skimming the top of the
  // report could conflate "config error" with "tied eligible candidates."
  // Patch G adds a top-level Config error block above Decision.
  const broker = new StubBroker();
  broker.enqueueFor("patch_builder", { text: builderResponse() });
  broker.setDefaultFor("adversarial_review", { text: reviewerClean() });

  const { repoRoot, cleanup } = makeRepo();
  try {
    const packet = await runOrchestration(
      {
        broker: broker as unknown as InferenceBroker,
        worktreeManager: buildManager(repoRoot),
        artifactsRoot: resolve(repoRoot, "artifacts"),
        verifierImpl: ({ builderId }) => ({
          builderId,
          worktreePath: `/tmp/${builderId}`,
          phase: "passed" as const,
          typecheckExitCode: 0,
          testExitCode: 0,
          ranAt: "2026-04-26T22:00:00.000Z",
        }),
        ...COMMON_DEPS_OVERRIDES,
        loadAntiExampleImpl: () => {
          throw new Error("ENOENT");
        },
      },
      {
        taskId: "missing-ae",
        taskDescription: "x",
        builderCount: 1,
        reviewerCount: 1,
        baseBranch: "main",
        touchList: ["added.ts"],
        rubricPath: "/x.json",
        antiExamplePaths: ["/never/exists.md"],
        qualityFloor: 0.5,
      },
    );
    // Decision is escalate_to_human due to config error.
    assert.equal(packet.summary?.arbiterDecision, "escalate_to_human");
    // The final report renders the config error ABOVE Decision.
    const report = readFileSync(packet.finalReportPath, "utf8");
    const configErrorIdx = report.indexOf("⚠️ Config error");
    const decisionIdx = report.indexOf("**Decision:**");
    assert.ok(configErrorIdx >= 0, "Config error block missing from report");
    assert.ok(
      configErrorIdx < decisionIdx,
      "Config error block must appear ABOVE Decision (operator-readability)",
    );
    assert.match(report, /never\/exists\.md/);
  } finally {
    cleanup();
  }
});

test("runOrchestration (Patch G N7): --lane wires real generateContextPack via deps", async () => {
  // Pre-Patch-G the CLI parsed --lane but never wired contextPackImpl,
  // so the orchestrator's lane guard fell through and the flag was a
  // silent no-op. This test pins that the orchestrator USES whatever
  // contextPackImpl the caller passes; the CLI fix is verified by
  // composition (the CLI now imports generateContextPack and forwards
  // a wrapper).
  const broker = new StubBroker();
  broker.enqueueFor("patch_builder", { text: builderResponse() });
  broker.setDefaultFor("adversarial_review", { text: reviewerClean() });

  const { repoRoot, cleanup } = makeRepo();
  try {
    let laneSeen: string | undefined;
    const packet = await runOrchestration(
      {
        broker: broker as unknown as InferenceBroker,
        worktreeManager: buildManager(repoRoot),
        artifactsRoot: resolve(repoRoot, "artifacts"),
        verifierImpl: ({ builderId }) => ({
          builderId,
          worktreePath: `/tmp/${builderId}`,
          phase: "passed" as const,
          typecheckExitCode: 0,
          testExitCode: 0,
          ranAt: "2026-04-26T22:00:00.000Z",
        }),
        contextPackImpl: (lane) => {
          laneSeen = lane;
          return `# generated for ${lane}\n`;
        },
        ...COMMON_DEPS_OVERRIDES,
      },
      {
        taskId: "lane-wired",
        taskDescription: "x",
        builderCount: 1,
        reviewerCount: 1,
        baseBranch: "main",
        touchList: ["added.ts"],
        rubricPath: "/x.json",
        contextPackLane: "test-lane-name",
        qualityFloor: 0.5,
      },
    );
    assert.equal(laneSeen, "test-lane-name");
    assert.ok(packet.contextPackPath);
    const md = readFileSync(packet.contextPackPath!, "utf8");
    assert.match(md, /generated for test-lane-name/);
  } finally {
    cleanup();
  }
});

test("runOrchestration: high-severity reviewer finding makes arbiter escalate (not accept)", async () => {
  const broker = new StubBroker();
  broker.enqueueFor("patch_builder", { text: builderResponse() });
  // Reviewer flags a high-severity bug.
  broker.setDefaultFor("adversarial_review", {
    text: reviewerOk("bug", "high"),
  });

  const { repoRoot, cleanup } = makeRepo();
  try {
    const packet = await runOrchestration(
      {
        broker: broker as unknown as InferenceBroker,
        worktreeManager: buildManager(repoRoot),
        artifactsRoot: resolve(repoRoot, "artifacts"),
        verifierImpl: ({ builderId }) => ({
          builderId,
          worktreePath: `/tmp/${builderId}`,
          phase: "passed" as const,
          typecheckExitCode: 0,
          testExitCode: 0,
          ranAt: "2026-04-26T22:00:00.000Z",
        }),
        ...COMMON_DEPS_OVERRIDES,
      },
      {
        taskId: "high-sev",
        taskDescription: "x",
        builderCount: 1,
        reviewerCount: 1,
        baseBranch: "main",
        touchList: ["added.ts"],
        rubricPath: "/x.json",
        qualityFloor: 0.5,
      },
    );
    assert.equal(packet.summary?.arbiterDecision, "escalate_to_human");
    assert.equal(packet.exitCode, 2);
  } finally {
    cleanup();
  }
});
