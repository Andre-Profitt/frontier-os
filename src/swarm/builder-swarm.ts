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

import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve as resolvePath } from "node:path";

import type { InferenceBroker } from "../inference/broker.ts";
import type { WorktreeManager } from "../builders/worktree-manager.ts";
import type { BuilderRun, BuilderPatch } from "../builders/types.ts";
import { defaultGitRunner, type GitRunner } from "../builders/git.ts";
import { loadPromptTemplate, loadSkill, type Skill } from "../skills/loader.ts";
import { extractDiffs } from "./diff-extractor.ts";
import { checkDiffScope } from "./diff-scope-checker.ts";
import { renderPrompt } from "./review-swarm.ts";

export type CandidatePhase =
  | "spawn_failed"
  | "broker_failed"
  | "no_diff_extracted"
  | "scope_rejected"
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
  // Files the builder is scoped to edit. When non-empty, the diff-scope
  // gate rejects any diff touching files outside this list. When EMPTY
  // (or omitted), the swarm requires `allowUnscopedDiff: true` —
  // otherwise every candidate is scope_rejected up front. Pre-Patch-E2,
  // an empty touchList silently disabled the gate, which let the
  // builder swarm look scope-controlled when it wasn't. (GPT Pro
  // second-pass blocker #2.)
  touchList?: string[];
  // Required to opt out of scope checking when touchList is empty.
  // Operator must explicitly choose unrestricted; the packet evidence
  // records this choice. Default: false.
  allowUnscopedDiff?: boolean;
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
        allowUnscopedDiff: input.allowUnscopedDiff ?? false,
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
  allowUnscopedDiff: boolean;
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
  // Inline current contents of every file in the touch list, read from
  // the builder's worktree. Without this a non-agentic LLM (chat
  // completion only) has no way to see existing code and ends up
  // hallucinating function names / line numbers — the diff applies
  // against an imagined file rather than the real one.
  // First-real-orchestration finding (2026-04-27): qwen2.5:72b
  // produced syntactically valid diffs against fictitious code; both
  // builders failed at apply_failed because the patches referenced
  // functions that don't exist in the real file.
  const touchListFiles = renderTouchListFiles(
    run.worktreePath,
    input.touchList,
  );
  const filledPrompt = renderPrompt(promptTemplate, {
    builderId,
    builderCount: String(input.builderCount),
    taskId: input.taskId,
    taskDescription: input.taskDescription,
    worktreePath: run.worktreePath,
    branchName: run.branchName,
    touchList: input.touchList.join(", "),
    touchListFiles,
  });

  let brokerResult;
  try {
    brokerResult = await deps.broker.callClass({
      taskClass: input.taskClass,
      messages: [{ role: "user", content: filledPrompt }],
      // Pin to the assigned model when caller specified one. Without this
      // pass-through, the broker is free to pick the same model for every
      // builder, defeating the purpose of parallel multi-model attempts.
      // (GPT Pro review Issue #1.)
      ...(input.pinnedModelKey !== undefined
        ? { modelOverride: input.pinnedModelKey }
        : {}),
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
  const rawText = brokerResult.selectedResponse?.text ?? "";

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

  // ---- 4.5 scope check (Patch C / GPT Pro Issue #4 + E2 blocker #2) ----
  // The model was prompted with a touchList, but it is free to ignore
  // that and patch unrelated files. The arbiter would otherwise see an
  // overbroad patch as if it were the requested change. We reject before
  // git apply so the worktree stays clean.
  //
  // E2: empty touchList without allowUnscopedDiff → reject up front.
  // Pre-E2 this silently disabled the gate, which made the swarm look
  // scope-controlled when it wasn't. Operator MUST opt out explicitly
  // (BuilderSwarmInput.allowUnscopedDiff = true) and the evidence
  // records that choice via the errorMessage / phase combination.
  const diffText = diffs[0]!.diff;
  if (input.touchList.length === 0 && !input.allowUnscopedDiff) {
    return {
      builderId,
      modelKey,
      runId: run.runId,
      worktreePath: run.worktreePath,
      ok: false,
      phase: "scope_rejected",
      elapsedMs: now() - tStart,
      errorMessage:
        "no touchList supplied and allowUnscopedDiff=false — unscoped diffs are rejected by default; pass allowUnscopedDiff: true to opt out (operator's explicit choice)",
      rawText,
    };
  }
  const scopeCheck = checkDiffScope(diffText, {
    touchList: input.touchList,
  });
  if (!scopeCheck.allowed) {
    return {
      builderId,
      modelKey,
      runId: run.runId,
      worktreePath: run.worktreePath,
      ok: false,
      phase: "scope_rejected",
      elapsedMs: now() - tStart,
      errorMessage: `diff scope rejected — ${scopeCheck.reason}`,
      rawText,
    };
  }

  // ---- 5. git apply --check then apply ----
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

// Note: previous extractAssistantText helper removed; broker now exposes
// callRes.selectedResponse?.text (NormalizedModelResponse) directly.

function newPacketId(nowMs: number): string {
  const ts = Math.floor(nowMs / 1000).toString(36);
  const rand = Math.random().toString(36).slice(2, 8);
  return `build-${ts}-${rand}`;
}

// Render the contents of every file in the touch list as a fenced
// markdown block keyed by relative path. Files that don't exist in the
// worktree are surfaced as `(new file — does not exist yet)` so the
// model can produce a correct create-file diff. Files larger than the
// soft cap are truncated with a clear marker — diffs against truncated
// files will still apply IF the target lines are within the truncation
// window, but at least the model sees that the file is large.
const TOUCH_FILE_SOFT_CAP_BYTES = 64_000;
function renderTouchListFiles(
  worktreePath: string,
  touchList: string[],
): string {
  if (touchList.length === 0) return "(no touch list provided)";
  const blocks: string[] = [];
  for (const rel of touchList) {
    const abs = resolvePath(worktreePath, rel);
    if (!existsSync(abs)) {
      blocks.push(
        `### ${rel}\n\n(new file — does not exist yet in the worktree)\n`,
      );
      continue;
    }
    let content: string;
    try {
      content = readFileSync(abs, "utf8");
    } catch (e) {
      blocks.push(
        `### ${rel}\n\n(could not read: ${e instanceof Error ? e.message : String(e)})\n`,
      );
      continue;
    }
    let truncatedNote = "";
    if (content.length > TOUCH_FILE_SOFT_CAP_BYTES) {
      content = content.slice(0, TOUCH_FILE_SOFT_CAP_BYTES);
      truncatedNote = `\n\n(file truncated at ${TOUCH_FILE_SOFT_CAP_BYTES} bytes — full file is longer)\n`;
    }
    // Pick a fence that won't collide with content (rare but possible
    // for files containing markdown). Use 4 backticks; if the content
    // contains 4-backtick fences, use 5.
    let fence = "````";
    if (content.includes(fence)) fence = "`````";
    blocks.push(`### ${rel}\n\n${fence}\n${content}\n${fence}${truncatedNote}`);
  }
  return blocks.join("\n\n");
}
