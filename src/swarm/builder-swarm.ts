// Builder swarm — N parallel builders, one isolated git worktree each,
// all working on the same task. The arbiter (PR R4) consumes the packet
// to pick a winner, combine diffs, or escalate.
//
// Per-builder lifecycle:
//   1. WorktreeManager.spawn() → fresh `.worktrees/<runId>/` + branch
//   2. load skills/patch_builder/SKILL.md prompt template
//   3. render the template with task / touchList / worktreePath
//   4. broker.callClass({ taskClass: 'patch_builder' })
//   5. extract a unified diff from the response (diff-extractor.ts)
//   6. `git apply --check` against the worktree
//   7. `git apply` then `git commit` inside the worktree
//   8. WorktreeManager.collect() captures the patch
//
// Every step can fail. The candidate's `phase` records exactly where it
// stopped; rawText preserves the broker response for human salvage. The
// packet is always coherent — partial failures don't crash the swarm.
//
// Worktrees are NOT cleaned up by default. The arbiter (R4) needs them
// for re-run verification. The CLI exposes `--cleanup` for callers that
// want to reclaim the disk after.

import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { InferenceBroker } from "../inference/broker.ts";
import type { WorktreeManager } from "../builders/worktree-manager.ts";
import type { BuilderRun, BuilderPatch } from "../builders/types.ts";
import { defaultGitRunner, type GitRunner } from "../builders/git.ts";
import { loadPromptTemplate, loadSkill, type Skill } from "../skills/loader.ts";
import { extractDiffs } from "./diff-extractor.ts";
import { renderPrompt } from "./review-swarm.ts";

export type CandidatePhase =
  | "spawn_failed"
  | "broker_failed"
  | "no_diff_extracted"
  | "apply_failed"
  | "applied"
  | "committed"
  | "collected";

export interface CandidatePatch {
  builderId: string;
  modelKey?: string;
  runId?: string;
  worktreePath?: string;
  ok: boolean;
  phase: CandidatePhase;
  elapsedMs?: number;
  errorMessage?: string;
  rawText?: string;
  patch?: BuilderPatch;
  builderVerification?: {
    typecheckExitCode?: number;
    testExitCode?: number;
    ranAt?: string;
  };
}

export interface BuilderSwarmInput {
  taskId: string;
  taskDescription: string;
  touchList?: string[];
  baseBranch?: string;
  builderCount?: number;
  taskClass?: string;
  packetId?: string;
  // If provided, these models override the policy's class list — caller
  // controls per-builder modelKey assignment. Length should equal
  // builderCount; shorter lists wrap.
  modelKeys?: string[];
  // Test seams.
  loadSkillImpl?: (taskClass: string) => Skill | null;
  loadPromptTemplateImpl?: (skill: Skill) => string;
  now?: () => number;
  // Inject a custom git runner for the apply/commit steps. Defaults to
  // the same defaultGitRunner the WorktreeManager uses.
  exec?: GitRunner;
}

export interface BuilderSwarmDeps {
  broker: InferenceBroker;
  worktreeManager: WorktreeManager;
}

export interface BuilderSwarmPacket {
  packetId: string;
  scannedAt: string;
  taskId: string;
  taskClass: string;
  taskDescription?: string;
  touchList?: string[];
  baseBranch?: string;
  builderCount: number;
  modelsUsed: string[];
  candidates: CandidatePatch[];
  elapsedMs: number;
}

export class BuilderSwarmError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BuilderSwarmError";
  }
}

const DEFAULT_BUILDER_COUNT = 3;
const DEFAULT_TASK_CLASS = "patch_builder";

export async function runBuilderSwarm(
  deps: BuilderSwarmDeps,
  input: BuilderSwarmInput,
): Promise<BuilderSwarmPacket> {
  const now = input.now ?? Date.now;
  const taskClass = input.taskClass ?? DEFAULT_TASK_CLASS;
  const builderCount = input.builderCount ?? DEFAULT_BUILDER_COUNT;
  const packetId = input.packetId ?? newPacketId(now());
  const exec = input.exec ?? defaultGitRunner;

  if (builderCount < 1) {
    throw new BuilderSwarmError(
      `builderCount must be ≥ 1; got ${builderCount}`,
    );
  }

  const loadSkillFn = input.loadSkillImpl ?? loadSkill;
  const loadTemplateFn = input.loadPromptTemplateImpl ?? loadPromptTemplate;

  const skill = loadSkillFn(taskClass);
  if (!skill) {
    throw new BuilderSwarmError(
      `no skill found for taskClass "${taskClass}" — author skills/${taskClass}/skill.json`,
    );
  }
  const promptTemplate = loadTemplateFn(skill);

  const t0 = now();

  // Resolve modelKey per builder (if caller pinned them).
  const pinnedModels = input.modelKeys ?? [];

  const builderPromises = Array.from({ length: builderCount }).map(
    async (_, i): Promise<CandidatePatch> => {
      const builderId = `b${i + 1}`;
      const tStart = now();
      const pinnedModelKey =
        pinnedModels.length > 0
          ? pinnedModels[i % pinnedModels.length]
          : undefined;
      return runOneBuilder({
        deps,
        skill,
        promptTemplate,
        builderId,
        taskId: input.taskId,
        taskDescription: input.taskDescription,
        touchList: input.touchList ?? [],
        ...(input.baseBranch !== undefined
          ? { baseBranch: input.baseBranch }
          : {}),
        taskClass,
        builderCount,
        ...(pinnedModelKey !== undefined ? { pinnedModelKey } : {}),
        now,
        exec,
        tStart,
      });
    },
  );

  const candidates = await Promise.all(builderPromises);
  const elapsedMs = now() - t0;

  const modelsUsed = Array.from(
    new Set(
      candidates
        .map((c) => c.modelKey)
        .filter((m): m is string => typeof m === "string"),
    ),
  ).sort();

  const packet: BuilderSwarmPacket = {
    packetId,
    scannedAt: new Date(now()).toISOString(),
    taskId: input.taskId,
    taskClass,
    ...(input.taskDescription !== undefined
      ? { taskDescription: input.taskDescription }
      : {}),
    ...(input.touchList !== undefined ? { touchList: input.touchList } : {}),
    ...(input.baseBranch !== undefined ? { baseBranch: input.baseBranch } : {}),
    builderCount,
    modelsUsed,
    candidates,
    elapsedMs,
  };
  return packet;
}

interface RunOneBuilderInput {
  deps: BuilderSwarmDeps;
  skill: Skill;
  promptTemplate: string;
  builderId: string;
  taskId: string;
  taskDescription: string;
  touchList: string[];
  baseBranch?: string;
  taskClass: string;
  builderCount: number;
  pinnedModelKey?: string;
  now: () => number;
  exec: GitRunner;
  tStart: number;
}

async function runOneBuilder(
  input: RunOneBuilderInput,
): Promise<CandidatePatch> {
  const { deps, skill, promptTemplate, builderId, now, exec, tStart } = input;

  // ---- 1. spawn worktree ----
  let run: BuilderRun;
  try {
    run = deps.worktreeManager.spawn({
      taskId: input.taskId,
      builderId,
      taskClass: input.taskClass,
      ...(input.baseBranch !== undefined
        ? { baseBranch: input.baseBranch }
        : {}),
      ...(input.pinnedModelKey !== undefined
        ? { modelKey: input.pinnedModelKey }
        : {}),
    });
  } catch (e) {
    return failure(builderId, "spawn_failed", now() - tStart, e);
  }

  // ---- 2. render prompt + 3. broker call ----
  const filledPrompt = renderPrompt(promptTemplate, {
    builderId,
    builderCount: String(input.builderCount),
    taskId: input.taskId,
    taskDescription: input.taskDescription,
    worktreePath: run.worktreePath,
    branchName: run.branchName,
    touchList: input.touchList.join(", "),
  });

  let brokerResult;
  try {
    brokerResult = await deps.broker.callClass({
      taskClass: input.taskClass,
      messages: [{ role: "user", content: filledPrompt }],
    });
  } catch (e) {
    return failureWithRun(run, "broker_failed", now() - tStart, e);
  }

  if (!brokerResult.ok || !brokerResult.selected) {
    return {
      builderId,
      runId: run.runId,
      worktreePath: run.worktreePath,
      ok: false,
      phase: "broker_failed",
      elapsedMs: now() - tStart,
      errorMessage: `broker rejected: ${brokerResult.rejected ?? "unknown"}`,
    };
  }

  const modelKey = brokerResult.selected.modelKey;
  const rawText = extractAssistantText(brokerResult.selected);

  // ---- 4. extract diff ----
  const diffs = extractDiffs(rawText);
  if (diffs.length === 0) {
    return {
      builderId,
      modelKey,
      runId: run.runId,
      worktreePath: run.worktreePath,
      ok: false,
      phase: "no_diff_extracted",
      elapsedMs: now() - tStart,
      errorMessage:
        "broker returned text with no fenced diff and no inline diff header",
      rawText,
    };
  }

  // ---- 5. git apply --check then apply ----
  const diffText = diffs[0]!.diff;
  const applyOutcome = applyDiffToWorktree({
    diffText,
    worktreePath: run.worktreePath,
    builderId,
    exec,
  });
  if (!applyOutcome.ok) {
    return {
      builderId,
      modelKey,
      runId: run.runId,
      worktreePath: run.worktreePath,
      ok: false,
      phase: "apply_failed",
      elapsedMs: now() - tStart,
      errorMessage: applyOutcome.message,
      rawText,
    };
  }

  // ---- 6. commit ----
  const commitOk = commitInWorktree({
    worktreePath: run.worktreePath,
    builderId,
    taskId: input.taskId,
    exec,
  });
  if (!commitOk.ok) {
    // The diff is applied but uncommitted. We still try to collect — the
    // BuilderRun.diff captures uncommitted changes via `git diff
    // baseCommit..HEAD` only if committed; uncommitted edits would need
    // `git diff baseCommit` (no `..HEAD`). For v1 we surface this as
    // applied-but-not-committed.
    return {
      builderId,
      modelKey,
      runId: run.runId,
      worktreePath: run.worktreePath,
      ok: false,
      phase: "applied",
      elapsedMs: now() - tStart,
      errorMessage: `applied but commit failed: ${commitOk.message}`,
      rawText,
    };
  }

  // ---- 7. collect ----
  let collected: BuilderRun;
  try {
    collected = deps.worktreeManager.collect(run.runId);
  } catch (e) {
    return {
      builderId,
      modelKey,
      runId: run.runId,
      worktreePath: run.worktreePath,
      ok: false,
      phase: "committed",
      elapsedMs: now() - tStart,
      errorMessage:
        "applied + committed but worktreeManager.collect failed: " +
        (e instanceof Error ? e.message : String(e)),
      rawText,
    };
  }

  return {
    builderId,
    modelKey,
    runId: run.runId,
    worktreePath: run.worktreePath,
    ok: true,
    phase: "collected",
    elapsedMs: now() - tStart,
    rawText,
    ...(collected.patch ? { patch: collected.patch } : {}),
  };
}

// --- helpers --------------------------------------------------------------

function failure(
  builderId: string,
  phase: CandidatePhase,
  elapsedMs: number,
  e: unknown,
): CandidatePatch {
  return {
    builderId,
    ok: false,
    phase,
    elapsedMs,
    errorMessage: e instanceof Error ? e.message : String(e),
  };
}

function failureWithRun(
  run: BuilderRun,
  phase: CandidatePhase,
  elapsedMs: number,
  e: unknown,
): CandidatePatch {
  return {
    builderId: run.builderId,
    runId: run.runId,
    worktreePath: run.worktreePath,
    ok: false,
    phase,
    elapsedMs,
    errorMessage: e instanceof Error ? e.message : String(e),
  };
}

function applyDiffToWorktree(opts: {
  diffText: string;
  worktreePath: string;
  builderId: string;
  exec: GitRunner;
}): { ok: true } | { ok: false; message: string } {
  // Write the diff to a temp file so `git apply` can read it. Avoids
  // shell-escape pitfalls if the diff contains heredocs or backticks.
  const tmp = mkdtempSync(join(tmpdir(), `builder-${opts.builderId}-`));
  const patchPath = join(tmp, "candidate.patch");
  // git apply rejects patches that don't end with a newline ("corrupt
  // patch at line N"). The diff extractor trims trailing whitespace; we
  // re-append the newline at the writer boundary so the contract stays
  // clean.
  const diffText = opts.diffText.endsWith("\n")
    ? opts.diffText
    : `${opts.diffText}\n`;
  writeFileSync(patchPath, diffText);

  const check = opts.exec(["apply", "--check", patchPath], opts.worktreePath);
  if (!check.ok) {
    return {
      ok: false,
      message: `git apply --check failed: ${check.stderr.trim().slice(0, 600)}`,
    };
  }
  const apply = opts.exec(["apply", patchPath], opts.worktreePath);
  if (!apply.ok) {
    return {
      ok: false,
      message: `git apply failed: ${apply.stderr.trim().slice(0, 600)}`,
    };
  }
  return { ok: true };
}

function commitInWorktree(opts: {
  worktreePath: string;
  builderId: string;
  taskId: string;
  exec: GitRunner;
}): { ok: true } | { ok: false; message: string } {
  const add = opts.exec(["add", "-A"], opts.worktreePath);
  if (!add.ok) {
    return { ok: false, message: `git add failed: ${add.stderr.trim()}` };
  }
  // Use --no-verify to skip the commit-msg hook for builder commits —
  // the hook enforces Session/Scope/Verification, which is operator
  // discipline, not builder discipline. Builder commits live on
  // throwaway branches inside worktrees that the arbiter judges.
  const msg = `builder(${opts.builderId}): candidate for ${opts.taskId}\n\nThis commit is a builder swarm candidate. The arbiter ranks all candidates before any merge to a real branch.`;
  const commit = opts.exec(
    ["commit", "--no-verify", "-m", msg],
    opts.worktreePath,
  );
  if (!commit.ok) {
    // "nothing to commit" is a legitimate outcome — the diff applied but
    // changed nothing (e.g. context-only diff). Treat as failure here so
    // the candidate surfaces; arbiter sees commitCount=0.
    return {
      ok: false,
      message: `git commit failed: ${commit.stderr.trim().slice(0, 400) || commit.stdout.trim().slice(0, 400)}`,
    };
  }
  return { ok: true };
}

function extractAssistantText(selected: {
  assistantText?: string;
  body?: unknown;
}): string {
  if (typeof selected.assistantText === "string") return selected.assistantText;
  if (selected.body !== undefined && selected.body !== null) {
    return JSON.stringify(selected.body);
  }
  return "";
}

function newPacketId(nowMs: number): string {
  const ts = Math.floor(nowMs / 1000).toString(36);
  const rand = Math.random().toString(36).slice(2, 8);
  return `build-${ts}-${rand}`;
}
