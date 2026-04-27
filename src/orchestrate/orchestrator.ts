// R6 orchestrator — the loop GPT Pro asked for. Runs:
//   (optional) context pack
//   → builder swarm
//   → per-candidate review swarm
//   → merge arbiter
//
// Writes a coherent artifacts/orchestrations/<taskId>/ tree and emits a
// schema-validated OrchestrationPacket. Exit codes match the arbiter
// CLI (0 accept, 1 reject, 2 escalate_to_human).
//
// Hard invariants (mirroring AGENTS.md):
//   - Never auto-merges. Never edits main.
//   - Never pushes. Never invokes launchd.
//   - Always writes artifacts before returning, even on partial failure.
//   - Validates the OrchestrationPacket against the schema before writing
//     orchestration-packet.json — drift surfaces in tests.
//
// Test seams: every dependency is injectable (broker, worktreeManager,
// loadSkill, loadPromptTemplate, loadRubric, verifier, loadAntiExample,
// contextPack, now, randomId). The runtime composes the real defaults.

import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";

import type { InferenceBroker } from "../inference/broker.ts";
import type { WorktreeManager } from "../builders/worktree-manager.ts";
import { ModelRegistry, type ClassGates } from "../inference/model-registry.ts";
import {
  runBuilderSwarm,
  type BuilderSwarmPacket,
} from "../swarm/builder-swarm.ts";
import { runReviewSwarm, type ReviewPacket } from "../swarm/review-swarm.ts";
import {
  decide,
  type CandidateInput,
  type ReviewerFindingInput,
} from "../arbiter/arbiter.ts";
import type { ArbiterDecision } from "../arbiter/types.ts";
import { validateOrchestrationPacket } from "../schemas.ts";
import { renderFinalReport } from "./report.ts";
import {
  OrchestrationError,
  type OrchestrationInput,
  type OrchestrationPacket,
} from "./types.ts";

const HERE = fileURLToPath(import.meta.url);
const REPO_ROOT_DEFAULT = resolve(dirname(HERE), "..", "..");

export interface OrchestrationDeps {
  broker: InferenceBroker;
  worktreeManager: WorktreeManager;
  // Test seams (all forwarded to the underlying swarms / arbiter when
  // present). Defaults pull from the real loaders at runtime.
  loadSkillImpl?: Parameters<typeof runBuilderSwarm>[1]["loadSkillImpl"];
  loadPromptTemplateImpl?: Parameters<
    typeof runBuilderSwarm
  >[1]["loadPromptTemplateImpl"];
  loadRubricImpl?: Parameters<typeof decide>[0]["loadRubricImpl"];
  verifierImpl?: Parameters<typeof decide>[0]["verifierImpl"];
  loadAntiExampleImpl?: Parameters<typeof decide>[0]["loadAntiExampleImpl"];
  // Optional context-pack invoker. Receives the lane name; returns the
  // markdown to write. When undefined, context-pack is skipped.
  contextPackImpl?: (lane: string) => Promise<string> | string;
  // Patch O test seam: override the per-class gate lookup. Returns the
  // policy class's `gates` field (or undefined if no class entry / no
  // gates set). Production default is loadClassGates which reads
  // config/model-policy.json fresh each call.
  classGatesImpl?: (taskClass: string) => ClassGates | undefined;
  now?: () => number;
  // Override the artifacts root (default: <repo>/artifacts/orchestrations).
  artifactsRoot?: string;
}

const DEFAULT_BUILDER_COUNT = 3;
const DEFAULT_REVIEWER_COUNT = 3;
const DEFAULT_BUILDER_TASK_CLASS = "patch_builder";
const DEFAULT_REVIEWER_TASK_CLASS = "adversarial_review";

export async function runOrchestration(
  deps: OrchestrationDeps,
  input: OrchestrationInput,
): Promise<OrchestrationPacket> {
  const now = deps.now ?? Date.now;
  const t0 = now();

  if (!input.taskId.match(/^[a-zA-Z0-9_.-]+$/)) {
    throw new OrchestrationError(
      `taskId must be slug-safe ([a-zA-Z0-9_.-]+); got "${input.taskId}"`,
    );
  }

  const builderCount = input.builderCount ?? DEFAULT_BUILDER_COUNT;
  const reviewerCount = input.reviewerCount ?? DEFAULT_REVIEWER_COUNT;
  const builderTaskClass = input.builderTaskClass ?? DEFAULT_BUILDER_TASK_CLASS;
  const reviewerTaskClass =
    input.reviewerTaskClass ?? DEFAULT_REVIEWER_TASK_CLASS;

  // Patch O: resolve gate defaults from the policy's class entry when
  // the operator hasn't passed an explicit CLI flag. Resolution order:
  //   1. CLI flag (input.qualityFloor / input.minRubricCoverage / etc.)
  //   2. Policy class gates (config/model-policy.json classes[X].gates)
  //   3. Arbiter built-in defaults (decide() applies these if neither
  //      above is provided)
  // The arbiter receives the merged values; it can't tell which layer
  // they came from. Operator override always wins, no surprises.
  const classGates =
    deps.classGatesImpl?.(builderTaskClass) ??
    (await loadClassGates(builderTaskClass));
  const effectiveQualityFloor = input.qualityFloor ?? classGates?.qualityFloor;
  const effectiveMinRubricCoverage =
    input.minRubricCoverage ?? classGates?.minRubricCoverage;
  const effectiveMinReviewCoverage =
    input.minReviewCoverage ?? classGates?.minReviewCoverage;
  const effectiveRequireTests = input.requireTests ?? classGates?.requireTests;
  const artifactsRoot =
    deps.artifactsRoot ??
    resolve(REPO_ROOT_DEFAULT, "artifacts", "orchestrations");
  const artifactsDir =
    input.artifactsDir ?? resolve(artifactsRoot, input.taskId);
  const reviewPacketsDir = resolve(artifactsDir, "review-packets");

  mkdirSync(artifactsDir, { recursive: true });
  mkdirSync(reviewPacketsDir, { recursive: true });

  const packetId = newPacketId(input.taskId, now());

  // ---- 1. Context pack (optional) ----
  let contextPackPath: string | undefined;
  if (input.contextPackLane && deps.contextPackImpl) {
    try {
      const md = await deps.contextPackImpl(input.contextPackLane);
      const p = resolve(artifactsDir, "context-pack.md");
      writeFileSync(p, md);
      contextPackPath = p;
    } catch (e) {
      // Context pack failure is not fatal — log and continue. The
      // operator can re-run with a fixed lane.
      const msg = e instanceof Error ? e.message : String(e);
      writeFileSync(
        resolve(artifactsDir, "context-pack-error.txt"),
        `context pack lane=${input.contextPackLane} failed:\n${msg}\n`,
      );
    }
  }

  // ---- 2. Builder swarm ----
  const builderPacket = await runBuilderSwarm(
    {
      broker: deps.broker,
      worktreeManager: deps.worktreeManager,
    },
    {
      taskId: input.taskId,
      taskDescription: input.taskDescription,
      ...(input.touchList !== undefined ? { touchList: input.touchList } : {}),
      ...(input.allowUnscopedDiff !== undefined
        ? { allowUnscopedDiff: input.allowUnscopedDiff }
        : {}),
      ...(input.baseBranch !== undefined
        ? { baseBranch: input.baseBranch }
        : {}),
      builderCount,
      taskClass: builderTaskClass,
      ...(input.builderModelKeys !== undefined
        ? { modelKeys: input.builderModelKeys }
        : {}),
      ...(deps.loadSkillImpl !== undefined
        ? { loadSkillImpl: deps.loadSkillImpl }
        : {}),
      ...(deps.loadPromptTemplateImpl !== undefined
        ? { loadPromptTemplateImpl: deps.loadPromptTemplateImpl }
        : {}),
      ...(deps.now !== undefined ? { now: deps.now } : {}),
    },
  );
  const builderPacketPath = resolve(artifactsDir, "builder-swarm-packet.json");
  writeFileSync(
    builderPacketPath,
    JSON.stringify(builderPacket, null, 2) + "\n",
  );

  // ---- 3. Per-candidate review swarms ----
  // Only collected candidates have a diff to review. Candidates that
  // failed at any earlier phase get no reviewer call (their phase is
  // already in the builder packet).
  const collectedCandidates = builderPacket.candidates.filter(
    (c) => c.phase === "collected" && c.patch,
  );
  const reviewPackets: Array<{ builderId: string; packet: ReviewPacket }> = [];
  const reviewPacketPaths: Array<{ builderId: string; path: string }> = [];
  for (const candidate of collectedCandidates) {
    const rp = await runReviewSwarm(
      { broker: deps.broker },
      {
        diff: candidate.patch!.diff,
        diffSource: { kind: "inline", sizeBytes: candidate.patch!.sizeBytes },
        reviewerCount,
        taskClass: reviewerTaskClass,
        patchId: candidate.builderId,
        taskId: input.taskId,
        ...(deps.loadSkillImpl !== undefined
          ? { loadSkillImpl: deps.loadSkillImpl }
          : {}),
        ...(deps.loadPromptTemplateImpl !== undefined
          ? { loadPromptTemplateImpl: deps.loadPromptTemplateImpl }
          : {}),
        ...(deps.now !== undefined ? { now: deps.now } : {}),
      },
    );
    reviewPackets.push({ builderId: candidate.builderId, packet: rp });
    const path = resolve(reviewPacketsDir, `${candidate.builderId}.json`);
    writeFileSync(path, JSON.stringify(rp, null, 2) + "\n");
    reviewPacketPaths.push({ builderId: candidate.builderId, path });
  }

  // ---- 4. Arbiter ----
  // Map collected candidates → arbiter CandidateInput. Pass the review
  // findings keyed by builderId so the arbiter consumes the per-builder
  // reviewCoverage.
  const arbiterCandidates: CandidateInput[] = builderPacket.candidates.map(
    (c) => ({
      builderId: c.builderId,
      ...(c.modelKey !== undefined ? { modelKey: c.modelKey } : {}),
      ...(c.worktreePath !== undefined ? { worktreePath: c.worktreePath } : {}),
      ok: c.ok,
      phase: c.phase,
      ...(c.patch !== undefined ? { patch: c.patch } : {}),
    }),
  );
  const reviewerFindings: ReviewerFindingInput[] = reviewPackets.map(
    ({ builderId, packet }) => ({
      builderId,
      findingsBySeverity: packet.findingsBySeverity,
      findingsByCategory: packet.findingsByCategory,
      reviewCoverage: packet.reviewCoverage,
    }),
  );
  const arbiterDecision: ArbiterDecision = await decide({
    taskId: input.taskId,
    packetId,
    candidates: arbiterCandidates,
    reviewerFindings,
    rubricPath: input.rubricPath,
    ...(effectiveQualityFloor !== undefined
      ? { qualityFloor: effectiveQualityFloor }
      : {}),
    ...(effectiveMinRubricCoverage !== undefined
      ? { minRubricCoverage: effectiveMinRubricCoverage }
      : {}),
    ...(effectiveMinReviewCoverage !== undefined
      ? { minReviewCoverage: effectiveMinReviewCoverage }
      : {}),
    ...(effectiveRequireTests !== undefined
      ? { requireTests: effectiveRequireTests }
      : {}),
    ...(input.antiExamplePaths !== undefined
      ? { antiExamplePaths: input.antiExamplePaths }
      : {}),
    ...(input.typecheckCommand !== undefined
      ? { typecheckCommand: input.typecheckCommand }
      : {}),
    ...(input.testCommand !== undefined
      ? { testCommand: input.testCommand }
      : {}),
    ...(deps.loadRubricImpl !== undefined
      ? { loadRubricImpl: deps.loadRubricImpl }
      : {}),
    ...(deps.verifierImpl !== undefined
      ? { verifierImpl: deps.verifierImpl }
      : {}),
    ...(deps.loadAntiExampleImpl !== undefined
      ? { loadAntiExampleImpl: deps.loadAntiExampleImpl }
      : {}),
    ...(deps.now !== undefined ? { now: deps.now } : {}),
  });
  const arbiterDecisionPath = resolve(artifactsDir, "arbiter-decision.json");
  writeFileSync(
    arbiterDecisionPath,
    JSON.stringify(arbiterDecision, null, 2) + "\n",
  );

  // ---- 5. Optional cleanup of builder worktrees ----
  // After the arbiter has decided, the worktrees can usually be removed
  // unless the operator wants to inspect them. Default: keep.
  //
  // PATCH G B2: when the arbiter accepted a candidate, KEEP that
  // candidate's worktree even with --cleanup, because the operator
  // needs to apply its patch (final report points them at it). Removing
  // it before the operator can act would leave the report's "apply
  // from worktree X" instruction broken.
  if (input.cleanup) {
    const preserveBuilderId = arbiterDecision.selectedBuilderId;
    for (const c of builderPacket.candidates) {
      const runId = c.runId;
      if (!runId) continue;
      if (preserveBuilderId && c.builderId === preserveBuilderId) continue;
      try {
        deps.worktreeManager.remove(runId, { force: true });
      } catch {
        // Best-effort. Failure to clean a worktree is not fatal — the
        // operator can `frontier builder remove` later.
      }
    }
  }

  // ---- 6. Build + persist the orchestration packet + final report ----
  const exitCode: 0 | 1 | 2 =
    arbiterDecision.decision === "accept"
      ? 0
      : arbiterDecision.decision === "reject"
        ? 1
        : 2;
  const finalReportPath = resolve(artifactsDir, "final-report.md");

  const packet: OrchestrationPacket = {
    packetId,
    taskId: input.taskId,
    scannedAt: new Date(now()).toISOString(),
    input: buildInputSummary(input, builderCount, reviewerCount),
    ...(contextPackPath !== undefined ? { contextPackPath } : {}),
    builderPacketPath,
    reviewPacketPaths,
    arbiterDecisionPath,
    finalReportPath,
    artifactsDir,
    summary: {
      buildersSpawned: builderPacket.builderCount,
      buildersCollected: collectedCandidates.length,
      reviewSwarmsRun: reviewPackets.length,
      arbiterDecision: arbiterDecision.decision,
      ...(arbiterDecision.selectedBuilderId !== undefined
        ? { selectedBuilderId: arbiterDecision.selectedBuilderId }
        : {}),
      modelsUsed: builderPacket.modelsUsed,
    },
    exitCode,
    elapsedMs: now() - t0,
  };

  if (!validateOrchestrationPacket(packet)) {
    // Schema-validation failure means our types drifted. Surface loudly
    // so it gets fixed in tests.
    throw new OrchestrationError(
      "OrchestrationPacket failed schema validation — types/schema drift",
      { errors: validateOrchestrationPacket.errors },
    );
  }

  // Render the final report from the freshly-built packet + sub-packets.
  const finalReport = renderFinalReport({
    packet,
    input,
    builderPacket,
    reviewPackets,
    arbiterDecision,
  });
  writeFileSync(finalReportPath, finalReport);

  // Persist the orchestration packet itself last, after everything else
  // has written successfully.
  writeFileSync(
    resolve(artifactsDir, "orchestration-packet.json"),
    JSON.stringify(packet, null, 2) + "\n",
  );

  return packet;
}

// Build the input summary persisted in the packet. Drops test-seam
// fields and types that don't belong in the audit trail.
function buildInputSummary(
  input: OrchestrationInput,
  builderCount: number,
  reviewerCount: number,
): OrchestrationPacket["input"] {
  return {
    taskDescription: input.taskDescription,
    ...(input.touchList !== undefined ? { touchList: input.touchList } : {}),
    ...(input.allowUnscopedDiff !== undefined
      ? { allowUnscopedDiff: input.allowUnscopedDiff }
      : {}),
    ...(input.baseBranch !== undefined ? { baseBranch: input.baseBranch } : {}),
    builderCount,
    reviewerCount,
    ...(input.builderTaskClass !== undefined
      ? { builderTaskClass: input.builderTaskClass }
      : {}),
    ...(input.reviewerTaskClass !== undefined
      ? { reviewerTaskClass: input.reviewerTaskClass }
      : {}),
    ...(input.builderModelKeys !== undefined
      ? { builderModelKeys: input.builderModelKeys }
      : {}),
    rubricPath: input.rubricPath,
    ...(input.qualityFloor !== undefined
      ? { qualityFloor: input.qualityFloor }
      : {}),
    ...(input.minRubricCoverage !== undefined
      ? { minRubricCoverage: input.minRubricCoverage }
      : {}),
    ...(input.minReviewCoverage !== undefined
      ? { minReviewCoverage: input.minReviewCoverage }
      : {}),
    ...(input.requireTests !== undefined
      ? { requireTests: input.requireTests }
      : {}),
    ...(input.antiExamplePaths !== undefined
      ? { antiExamplePaths: input.antiExamplePaths }
      : {}),
    ...(input.contextPackLane !== undefined
      ? { contextPackLane: input.contextPackLane }
      : {}),
    ...(input.cleanup !== undefined ? { cleanup: input.cleanup } : {}),
  };
}

function newPacketId(taskId: string, nowMs: number): string {
  const ts = Math.floor(nowMs / 1000).toString(36);
  const rand = Math.random().toString(36).slice(2, 8);
  return `orch-${taskId}-${ts}-${rand}`;
}

// Patch O: load per-class gate defaults from the policy. Returns the
// class's `gates` object or undefined if (a) no class entry, (b) no
// gates set on the class, or (c) the policy file is unreadable. Errors
// are intentionally swallowed — gate defaults are a soft-fail concern
// (the arbiter has its own internal defaults). The orchestrator just
// doesn't get to use the policy's class-level overrides on a broken
// policy file; the run still proceeds.
async function loadClassGates(
  taskClass: string,
): Promise<ClassGates | undefined> {
  try {
    const registry = new ModelRegistry();
    return registry.classGates(taskClass);
  } catch {
    return undefined;
  }
}
