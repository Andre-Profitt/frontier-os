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
import { isAbsolute, join, resolve as resolvePath } from "node:path";

import type { InferenceBroker } from "../inference/broker.ts";
import type { WorktreeManager } from "../builders/worktree-manager.ts";
import type { BuilderRun, BuilderPatch } from "../builders/types.ts";
import { defaultGitRunner, type GitRunner } from "../builders/git.ts";
import { loadPromptTemplate, loadSkill, type Skill } from "../skills/loader.ts";
import { extractDiffs } from "./diff-extractor.ts";
import {
  checkDiffScope,
  checkSearchReplaceScope,
} from "./diff-scope-checker.ts";
import { verifyCandidate } from "../arbiter/verifier.ts";
import type { VerificationResult } from "../arbiter/types.ts";
import {
  parseSearchReplaceBlocks,
  applySearchReplaceBlocks,
} from "./search-replace.ts";
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
    // Patch X: capture the verifier's phase verdict alongside raw
    // exit codes. Phase carries nuance the exit codes alone don't:
    // "passed_typecheck_only" tells the reviewer that runtime tests
    // never executed (so dynamic-behavior claims are unverified);
    // "skipped" / "worktree_missing" surface as their own signals
    // distinct from a clean pass.
    phase?:
      | "passed"
      | "passed_typecheck_only"
      | "typecheck_failed"
      | "tests_failed"
      | "skipped"
      | "worktree_missing";
    typecheckExitCode?: number;
    testExitCode?: number;
    ranAt?: string;
  };
  // Patch Y: number of S/R apply attempts the builder made for this
  // candidate. Set only on candidates that took the S/R path (applied,
  // committed, collected via S/R, or apply_failed after exhausting
  // retries). Undefined for unified-diff path and for candidates that
  // failed before reaching apply (broker_failed, no_diff_extracted on
  // first call, scope_rejected). 1 means one-shot success or one-shot
  // failure with retries disabled; >1 means a retry was triggered.
  applyAttempts?: number;
  // Patch Z: relative paths the builder successfully read via the
  // READ_FILE tool. Denied requests (path traversal, non-existent
  // file, budget exhausted) are NOT recorded here — only successful
  // reads. Empty/undefined means the model did not use the read tool
  // (or every request was denied).
  readFiles?: string[];
  // Patch BB: number of times the verifier ran for this candidate
  // (= number of post-commit verify cycles attempted). 1 = verified
  // once (no verify-retry); 2 = verify failed once, retried, verified
  // again. Set only when verification ran; undefined when neither
  // typecheckCommand nor testCommand was supplied. Surfaced into the
  // ledger so a downstream query can compute the verify-retry tool's
  // actual yield: P(builderVerification.phase=passed | verifyAttempts=2)
  // tells the operator whether the retry actually rescues failing
  // verifies vs. the model just regenerating the same broken patch.
  verifyAttempts?: number;
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
  // Patch V: builder self-verification commands. When either is set,
  // the builder swarm runs them inside the worktree AFTER commit and
  // populates `candidate.builderVerification` with exit codes + ranAt
  // so the reviewer prompt can show what the builder claims (the
  // arbiter independently re-verifies later). Both default to
  // undefined → no verification (prior behavior preserved).
  typecheckCommand?: string[] | null;
  testCommand?: string[] | null;
  // Patch Y: maximum extra broker calls per builder when an S/R apply
  // fails on a recoverable error (SEARCH text not found / ambiguous /
  // refusing to clobber). Each retry re-prompts with the original
  // user message + the previous response + the structured apply error
  // appended as feedback. Default 1 (one retry). Set to 0 to disable
  // retry entirely (legacy behavior). Retry covers ONLY the S/R path;
  // unified-diff apply failures never retry.
  maxApplyRetries?: number;
  // Patch Z: maximum READ_FILE tool invocations per builder. When the
  // model emits `READ_FILE: <relative-path>` (alone, no S/R or diff),
  // the runner reads it (after path safety checks: no absolute paths,
  // no `..` traversal, must exist in worktree, size capped) and
  // re-prompts with the file contents appended. Default 1. Set to 0
  // to disable the tool entirely — a READ_FILE response then surfaces
  // as no_diff_extracted. Independent budget from maxApplyRetries.
  maxReadFiles?: number;
  // Patch BB: maximum verify-retry cycles per builder. Pre-Patch-BB,
  // the builder ran verify once after commit and the result was strictly
  // informational (Patch V). Patch BB makes verification actionable: on
  // typecheck_failed/tests_failed, the runner rolls back the candidate's
  // commit (`git reset --hard HEAD~1` in the worktree), augments the
  // prompt with the verifier's stderr, and re-prompts the model for a
  // second apply+commit+verify cycle. Default 1 (one retry). Set to 0
  // to preserve pre-Patch-BB behavior: failed verify stays informational
  // with no rollback. Independent budget from maxApplyRetries and
  // maxReadFiles — each verify-retry cycle gets its own fresh apply
  // and read budgets. Verify-retry only fires for typecheck_failed /
  // tests_failed; passed / passed_typecheck_only / skipped /
  // worktree_missing don't trigger retry.
  maxVerifyRetries?: number;
  // Test seams.
  loadSkillImpl?: (taskClass: string) => Skill | null;
  loadPromptTemplateImpl?: (skill: Skill) => string;
  now?: () => number;
  // Patch V test seam: inject the verifier so tests don't need a real
  // tsconfig + node_modules in the synthetic worktree.
  verifierImpl?: typeof verifyCandidate;
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
        ...(input.typecheckCommand !== undefined
          ? { typecheckCommand: input.typecheckCommand }
          : {}),
        ...(input.testCommand !== undefined
          ? { testCommand: input.testCommand }
          : {}),
        ...(input.maxApplyRetries !== undefined
          ? { maxApplyRetries: input.maxApplyRetries }
          : {}),
        ...(input.maxReadFiles !== undefined
          ? { maxReadFiles: input.maxReadFiles }
          : {}),
        ...(input.maxVerifyRetries !== undefined
          ? { maxVerifyRetries: input.maxVerifyRetries }
          : {}),
        ...(input.verifierImpl !== undefined
          ? { verifierImpl: input.verifierImpl }
          : {}),
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
  // Patch V: self-verification commands threaded through from
  // BuilderSwarmInput. When either is set, run after commit to
  // populate candidate.builderVerification.
  typecheckCommand?: string[] | null;
  testCommand?: string[] | null;
  // Patch Y: retry budget for S/R apply failures (see BuilderSwarmInput).
  maxApplyRetries?: number;
  // Patch Z: READ_FILE budget (see BuilderSwarmInput).
  maxReadFiles?: number;
  // Patch BB: verify-retry budget (see BuilderSwarmInput).
  maxVerifyRetries?: number;
  verifierImpl?: typeof verifyCandidate;
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
  const baseFilledPrompt = renderPrompt(promptTemplate, {
    builderId,
    builderCount: String(input.builderCount),
    taskId: input.taskId,
    taskDescription: input.taskDescription,
    worktreePath: run.worktreePath,
    branchName: run.branchName,
    touchList: input.touchList.join(", "),
    touchListFiles,
  });

  // Patch Y: retry loop for the broker call + S/R apply.
  // The model commonly hallucinates SEARCH text on the first attempt
  // (paraphrases instead of copying verbatim from the rendered touch
  // list). When the apply rejects it with a structured error, one
  // re-prompt with that error appended typically produces a clean
  // apply. The loop ONLY retries on S/R apply failures; broker
  // failures and scope rejections short-circuit immediately.
  //
  // Patch Z: same loop now also handles READ_FILE tool requests. When
  // the model emits `READ_FILE: <path>` (alone, no S/R or diff in the
  // response), the runner reads the file (after path safety checks)
  // and re-prompts with the contents appended. Read budget and apply
  // retry budget are independent — using one does not consume the
  // other. Termination is guaranteed: each iteration either succeeds,
  // returns failure, or consumes one budget unit; once both budgets
  // are exhausted the next iteration falls into a return path.
  const maxApplyRetries = input.maxApplyRetries ?? 1;
  const maxReadFiles = input.maxReadFiles ?? 1;
  // Patch BB: verify-retry budget. Every iteration of verifyLoop is one
  // post-commit verify cycle; a verify failure consumes one budget unit
  // by rolling back the worktree and re-prompting with verifier feedback.
  const maxVerifyRetries = input.maxVerifyRetries ?? 1;

  let promptToSend = baseFilledPrompt;
  let attempt = 0;
  // Counts S/R apply executions specifically (success or failure).
  // READ_FILE responses don't bump this — only actual applies do.
  let applyCount = 0;
  // Counts every READ_FILE response we processed (including denied
  // requests). Shared budget — a denied path traversal still costs
  // a slot, so the model can't loop forever on bad paths.
  let readFileCalls = 0;
  // Set on first successful broker response and re-set on each retry.
  let modelKey: string | undefined;
  let rawText = "";
  // diffText / alreadyApplied / applyAttempts are populated once the
  // loop reaches a terminal state (success or unified-diff fall-
  // through). The post-loop code uses them unchanged from pre-Patch-Y.
  let diffText: string | undefined;
  let alreadyApplied = false;
  let applyAttempts: number | undefined;
  // Patch Z: relative paths the builder successfully read. Denied
  // requests are NOT recorded here; only successful reads.
  // Patch BB: was const, now let — verify-retry resets to a fresh array
  // for each verify cycle (each cycle gets its own read budget).
  let readFiles: string[] = [];
  // Combined transcript surfaced as rawText on multi-attempt apply
  // failure — operator/arbiter can salvage from any attempt.
  // Persists across verifyLoop iterations so a verify-retry's transcript
  // includes the original attempt + verifier output + the retry response.
  const transcript: string[] = [];

  // Patch BB: hoisted out of the post-loop verification block so the
  // verifyLoop can mutate them across iterations. builderVerification
  // ends up reflecting the FINAL verifier call (the one whose result
  // either passed or exhausted the retry budget). verifyAttempts
  // counts post-commit verifier runs; undefined when verification was
  // never requested.
  let builderVerification: CandidatePatch["builderVerification"];
  let verifyAttempts: number | undefined;
  // Set true once the FIRST verifyLoop iteration completes its post-
  // loop steps (commit + collect + verify). Used by the verify-retry
  // branch to tell `continue verifyLoop` apart from the initial entry
  // when reading state.
  let collected: BuilderRun | undefined;
  const verifierFn = input.verifierImpl ?? verifyCandidate;
  const wantsVerification =
    input.typecheckCommand !== undefined || input.testCommand !== undefined;

  // Patch BB: outer loop wraps the existing apply/commit/collect/verify
  // sequence. On a typecheck_failed/tests_failed verifier outcome with
  // budget remaining, this loop rolls back the worktree, re-prompts
  // with verifier feedback, and re-enters the inner retryLoop for a
  // fresh broker → S/R → apply → commit → verify cycle. Termination
  // is guaranteed: every continue verifyLoop consumes one verify-retry
  // budget unit, and once the budget is exhausted the verify decision
  // falls through to break verifyLoop.
  verifyLoop: while (true) {
    retryLoop: while (true) {
      attempt++;

      let brokerResult;
      try {
        brokerResult = await deps.broker.callClass({
          taskClass: input.taskClass,
          messages: [{ role: "user", content: promptToSend }],
          // Pin to the assigned model when caller specified one. Without
          // this pass-through, the broker is free to pick the same model
          // for every builder, defeating the purpose of parallel multi-
          // model attempts. (GPT Pro review Issue #1.)
          ...(input.pinnedModelKey !== undefined
            ? { modelOverride: input.pinnedModelKey }
            : {}),
        });
      } catch (e) {
        // Patch T: attribute the failure to the pinned model when
        // present. Symmetric to Patch R blocker #3 for reviewers —
        // without this, model_event aggregation drops pinned-builder
        // failures (writer's "if (!c.modelKey) continue;" skips the
        // row), making targeted-builder failure rates invisible in the
        // scorecard.
        if (attempt === 1) {
          return failureWithRun(
            run,
            "broker_failed",
            now() - tStart,
            e,
            input.pinnedModelKey,
          );
        }
        // Patch Y: a retry's broker call exception does not escalate to
        // broker_failed — the underlying problem was the prior apply
        // failure. Surface that with a note about the lost retry call.
        // Patch Z: applyAttempts is `applyCount` (number of actual S/R
        // apply executions), not `attempt - 1` — the latter would
        // wrongly count READ_FILE iterations toward apply attempts.
        return {
          builderId,
          ...(modelKey !== undefined ? { modelKey } : {}),
          runId: run.runId,
          worktreePath: run.worktreePath,
          ok: false,
          phase: "apply_failed",
          elapsedMs: now() - tStart,
          errorMessage: `search/replace apply failed on attempt ${applyCount}; retry broker call failed: ${e instanceof Error ? e.message : String(e)}`,
          rawText: transcript.join("\n\n"),
          applyAttempts: applyCount,
          ...(readFiles.length > 0 ? { readFiles } : {}),
        };
      }

      if (!brokerResult.ok || !brokerResult.selected) {
        if (attempt === 1) {
          return {
            builderId,
            ...(input.pinnedModelKey !== undefined
              ? { modelKey: input.pinnedModelKey }
              : {}),
            runId: run.runId,
            worktreePath: run.worktreePath,
            ok: false,
            phase: "broker_failed",
            elapsedMs: now() - tStart,
            errorMessage: `broker rejected: ${brokerResult.rejected ?? "unknown"}`,
          };
        }
        return {
          builderId,
          ...(modelKey !== undefined ? { modelKey } : {}),
          runId: run.runId,
          worktreePath: run.worktreePath,
          ok: false,
          phase: "apply_failed",
          elapsedMs: now() - tStart,
          errorMessage: `search/replace apply failed on attempt ${applyCount}; retry broker call rejected: ${brokerResult.rejected ?? "unknown"}`,
          rawText: transcript.join("\n\n"),
          applyAttempts: applyCount,
          ...(readFiles.length > 0 ? { readFiles } : {}),
        };
      }

      modelKey = brokerResult.selected.modelKey;
      rawText = brokerResult.selectedResponse?.text ?? "";
      transcript.push(`=== Attempt ${attempt} broker response ===\n${rawText}`);

      // ---- 4. extract changes ----
      // Patch M: prefer search/replace blocks over unified diff. First-
      // real-orchestration data showed line-number drift in unified
      // diffs is the dominant failure mode for general 70B models. S/R
      // sidesteps it by matching exact text instead of line numbers. If
      // the model emitted S/R blocks (Aider-style), apply them and
      // synthesize a unified diff from `git diff` for the scope check +
      // downstream pipeline. If no S/R blocks are present, fall back to
      // unified-diff extraction (kept for backwards compat / models
      // that prefer it). Unified-diff path does NOT participate in the
      // retry loop.
      const srParse = parseSearchReplaceBlocks(rawText);
      if (srParse.blocks.length > 0) {
        // ---- 4.4 PRE-APPLY scope check (Patch R blocker #1) ----
        // The S/R applier writes to disk during apply. If we deferred
        // the scope check until after apply (the way the unified-diff
        // path does), an out-of-scope candidate would mutate the
        // worktree before being rejected — leaving a dirty tree behind
        // even though the candidate is reported as scope_rejected.
        // Catch it here on the parsed block file paths so we never
        // write rejected blocks. Scope rejection is NOT retried; the
        // model picked the wrong file, not the wrong text.
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
        const srScope = checkSearchReplaceScope(srParse.blocks, {
          touchList: input.touchList,
        });
        if (!srScope.allowed) {
          return {
            builderId,
            modelKey,
            runId: run.runId,
            worktreePath: run.worktreePath,
            ok: false,
            phase: "scope_rejected",
            elapsedMs: now() - tStart,
            errorMessage: `S/R scope rejected — ${srScope.reason}`,
            rawText,
          };
        }

        const apply = applySearchReplaceBlocks(
          run.worktreePath,
          srParse.blocks,
        );
        // Patch Z: bump applyCount on every actual apply execution.
        // Pre-Patch-Z this was implicit in `attempt`; with READ_FILE
        // also bumping `attempt`, we need a separate counter for
        // applies so the retry budget stays scoped to apply failures.
        applyCount++;
        if (apply.ok) {
          // Synthesize a unified diff from the worktree state. The scope
          // checker + downstream metadata extraction (file list,
          // sizeBytes, line counts) consume unified diffs; rather than
          // duplicate that logic for S/R, generate the canonical form
          // once.
          const diffRes = exec(["diff", "--no-color"], run.worktreePath);
          if (!diffRes.ok) {
            return {
              builderId,
              modelKey,
              runId: run.runId,
              worktreePath: run.worktreePath,
              ok: false,
              phase: "apply_failed",
              elapsedMs: now() - tStart,
              errorMessage: `search/replace applied but git diff failed: ${diffRes.stderr.trim() || "unknown"}`,
              rawText,
              applyAttempts: applyCount,
              ...(readFiles.length > 0 ? { readFiles } : {}),
            };
          }
          diffText = diffRes.stdout;
          if (diffText.trim().length === 0) {
            // S/R applied but produced an empty diff — model said
            // "replace X with X" effectively. Treat as no-op rather
            // than success. Not retried (a syntactically-valid no-op
            // is not a recoverable failure mode; the model chose to
            // do nothing).
            return {
              builderId,
              modelKey,
              runId: run.runId,
              worktreePath: run.worktreePath,
              ok: false,
              phase: "no_diff_extracted",
              elapsedMs: now() - tStart,
              errorMessage:
                "search/replace blocks applied but resulted in zero net changes",
              rawText,
              applyAttempts: applyCount,
              ...(readFiles.length > 0 ? { readFiles } : {}),
            };
          }
          alreadyApplied = true;
          applyAttempts = applyCount;
          break retryLoop;
        }

        // Patch Y: S/R apply failed — retry if budget allows. The
        // structured error from applySearchReplaceBlocks ("SEARCH text
        // not found", "matches N locations", etc.) becomes the model-
        // facing feedback. This is the dominant local-70B failure
        // mode (model paraphrased a line instead of copying it
        // verbatim from the rendered touch list).
        const applyError = apply.error ?? "unknown";
        transcript.push(
          `=== Attempt ${attempt} apply error ===\n${applyError}`,
        );
        if (applyCount > maxApplyRetries) {
          return {
            builderId,
            modelKey,
            runId: run.runId,
            worktreePath: run.worktreePath,
            ok: false,
            phase: "apply_failed",
            elapsedMs: now() - tStart,
            errorMessage:
              applyCount > 1
                ? `search/replace apply failed (after ${applyCount} attempts): ${applyError}`
                : `search/replace apply failed: ${applyError}`,
            rawText: transcript.join("\n\n"),
            applyAttempts: applyCount,
            ...(readFiles.length > 0 ? { readFiles } : {}),
          };
        }
        promptToSend = buildRetryPrompt(baseFilledPrompt, rawText, applyError);
        continue retryLoop;
      }

      // No S/R blocks — try unified-diff extraction. Unified diff path
      // does NOT participate in apply retry (line-drift has its own
      // path; Patch M).
      const diffs = extractDiffs(rawText);
      if (diffs.length > 0) {
        diffText = diffs[0]!.diff;
        break retryLoop;
      }

      // Patch Z: no S/R, no diff — check for a READ_FILE tool request.
      // When the model emits `READ_FILE: <relative-path>` (alone) it's
      // asking for context outside its touch list. Read it (after path
      // safety checks) and re-prompt with the contents appended. Both
      // success and denial cost one slot of `maxReadFiles` budget.
      const readReq = parseReadFileRequest(rawText);
      if (
        readReq !== null &&
        maxReadFiles > 0 &&
        readFileCalls < maxReadFiles
      ) {
        readFileCalls++;
        const validation = validateReadPath(readReq.path, run.worktreePath);
        if (!validation.ok) {
          transcript.push(
            `=== Attempt ${attempt} READ_FILE: ${readReq.path} (denied: ${validation.error}) ===`,
          );
          promptToSend = buildReadFileErrorPrompt(
            baseFilledPrompt,
            readReq.path,
            validation.error,
          );
          continue retryLoop;
        }
        const fileResult = readFileForBuilder(validation.absolutePath);
        if (!fileResult.ok) {
          // Path validated but the read itself failed (rare — file
          // disappeared mid-flight, permissions). Treat as a denial.
          transcript.push(
            `=== Attempt ${attempt} READ_FILE: ${readReq.path} (read failed: ${fileResult.error}) ===`,
          );
          promptToSend = buildReadFileErrorPrompt(
            baseFilledPrompt,
            readReq.path,
            fileResult.error,
          );
          continue retryLoop;
        }
        readFiles.push(readReq.path);
        transcript.push(
          `=== Attempt ${attempt} READ_FILE: ${readReq.path} (granted, ${fileResult.contents.length} bytes${fileResult.truncated ? " — truncated" : ""}) ===`,
        );
        promptToSend = buildReadFileFollowup(
          baseFilledPrompt,
          readReq.path,
          fileResult.contents,
          fileResult.truncated,
        );
        continue retryLoop;
      }

      // No S/R, no diff, no usable READ_FILE — surface as no_diff_extracted.
      // Either the model didn't deliver any actionable content, or it
      // tried to use the read tool when the budget was already
      // exhausted (or disabled by maxReadFiles=0).
      return {
        builderId,
        modelKey,
        runId: run.runId,
        worktreePath: run.worktreePath,
        ok: false,
        phase: "no_diff_extracted",
        elapsedMs: now() - tStart,
        errorMessage:
          readReq !== null
            ? `READ_FILE requested but read budget exhausted (maxReadFiles=${maxReadFiles}, used=${readFileCalls})`
            : "broker returned text with no S/R blocks, no fenced diff, and no inline diff header",
        rawText,
        ...(readFiles.length > 0 ? { readFiles } : {}),
      };
    }

    // Loop exited via break — diffText is set; modelKey is set;
    // applyAttempts is set iff the S/R path completed.
    if (diffText === undefined || modelKey === undefined) {
      // Unreachable: every break above sets these. Defensive throw to
      // turn a future regression into a loud failure rather than a
      // silent undefined-deref downstream.
      throw new BuilderSwarmError(
        `runOneBuilder: invariant violated — loop exited without diffText/modelKey (builderId=${builderId})`,
      );
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
    // Skipped when search/replace already wrote the changes directly —
    // re-applying via `git apply` would fail with "patch already applied".
    if (!alreadyApplied) {
      const applyOutcome = applyDiffToWorktree({
        diffText,
        worktreePath: run.worktreePath,
        builderId,
        exec,
      });
      if (!applyOutcome.ok) {
        // Unified-diff path: applyAttempts intentionally NOT set —
        // retry only covers the S/R path (Patch Y).
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
        ...(applyAttempts !== undefined ? { applyAttempts } : {}),
        ...(readFiles.length > 0 ? { readFiles } : {}),
        ...(verifyAttempts !== undefined ? { verifyAttempts } : {}),
      };
    }

    // ---- 7. collect ----
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
        ...(applyAttempts !== undefined ? { applyAttempts } : {}),
        ...(readFiles.length > 0 ? { readFiles } : {}),
        ...(verifyAttempts !== undefined ? { verifyAttempts } : {}),
      };
    }

    // ---- 8. self-verification (Patch V) ----
    // Runs typecheck/test inside the worktree and stores exit codes
    // on the candidate so the orchestrator can format a structured
    // verification record for the reviewer prompt's
    // {{builderVerificationRecord}} slot. Pre-Patch-BB this was strictly
    // informational — verification failures did NOT change candidate.phase
    // or candidate.ok. Patch BB makes verification ACTIONABLE for the
    // builder: on typecheck_failed/tests_failed with retry budget, we
    // roll back the commit and re-prompt with verifier feedback. After
    // the retry budget is exhausted, the Patch V semantic is preserved:
    // a still-failing verify stays informational, the candidate is
    // collected with builderVerification reflecting the FINAL verifier
    // call. The arbiter independently re-verifies (defense in depth).
    // Skipped when neither command is set, preserving the prior behavior
    // for callers that don't ask for self-verification.
    if (wantsVerification) {
      const result = verifierFn({
        builderId,
        worktreePath: run.worktreePath,
        ...(input.typecheckCommand !== undefined
          ? { typecheckCommand: input.typecheckCommand }
          : {}),
        ...(input.testCommand !== undefined
          ? { testCommand: input.testCommand }
          : {}),
      });
      builderVerification = {
        // Patch X: include the verifier's phase verdict so the reviewer
        // sees "passed_typecheck_only" vs "passed" vs concrete failures
        // rather than having to infer from exit codes alone.
        ...(result.phase !== undefined ? { phase: result.phase } : {}),
        ...(result.typecheckExitCode !== undefined
          ? { typecheckExitCode: result.typecheckExitCode }
          : {}),
        ...(result.testExitCode !== undefined
          ? { testExitCode: result.testExitCode }
          : {}),
        ...(result.ranAt !== undefined ? { ranAt: result.ranAt } : {}),
      };
      verifyAttempts = (verifyAttempts ?? 0) + 1;

      // Patch BB: verification-aware retry. Only typecheck_failed and
      // tests_failed trigger retry — passed / passed_typecheck_only /
      // skipped / worktree_missing are terminal. The retry rolls the
      // worktree back to the pre-attempt state with `git reset --hard
      // HEAD~1` so the next iteration's apply runs against the SAME base
      // tree the model was prompted with. If reset fails (rare — git
      // crash mid-flight), we fall through to the Patch V semantic and
      // surface the failed verify on the collected candidate without
      // attempting the retry.
      const recoverable =
        result.phase === "typecheck_failed" || result.phase === "tests_failed";
      const hasBudget = verifyAttempts <= maxVerifyRetries;
      if (recoverable && hasBudget) {
        const reset = exec(["reset", "--hard", "HEAD~1"], run.worktreePath);
        if (reset.ok) {
          transcript.push(
            `=== Verify failed on attempt ${verifyAttempts} (phase=${result.phase}); rolled back HEAD~1 and re-prompting ===\n${formatVerifierFeedback(result)}`,
          );
          promptToSend = buildVerifyRetryPrompt(
            baseFilledPrompt,
            rawText,
            result,
          );
          // Reset inner-loop state for the next verify cycle. Each retry
          // gets a FRESH apply-retry budget and read budget — these are
          // per-cycle, not per-builder, by design (the verifier feedback
          // is a fundamentally different input than the prior cycle's
          // touch-list rendering, so the model deserves a clean slate).
          // transcript persists across cycles; verifyAttempts persists
          // (the running count).
          modelKey = undefined;
          rawText = "";
          diffText = undefined;
          alreadyApplied = false;
          applyAttempts = undefined;
          readFiles = [];
          attempt = 0;
          applyCount = 0;
          readFileCalls = 0;
          collected = undefined;
          continue verifyLoop;
        }
        // Reset failed — log it on the transcript so an operator can
        // see why the retry was abandoned, then fall through to break.
        transcript.push(
          `=== Verify failed on attempt ${verifyAttempts}, but rollback (\`git reset --hard HEAD~1\`) failed: ${reset.stderr.trim().slice(0, 400) || "unknown"}; abandoning verify-retry ===`,
        );
      }
    }
    break verifyLoop;
  } // end verifyLoop

  // collected is set above on the success path through verifyLoop.
  // The defensive throw turns any future restructure that breaks this
  // invariant into a loud failure rather than a silent undefined-deref.
  if (collected === undefined) {
    throw new BuilderSwarmError(
      `runOneBuilder: invariant violated — verifyLoop exited without collected (builderId=${builderId})`,
    );
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
    ...(builderVerification !== undefined ? { builderVerification } : {}),
    ...(applyAttempts !== undefined ? { applyAttempts } : {}),
    ...(readFiles.length > 0 ? { readFiles } : {}),
    ...(verifyAttempts !== undefined ? { verifyAttempts } : {}),
  };
}

// --- helpers --------------------------------------------------------------

// Patch Y: build the retry prompt by appending structured feedback
// (the model's previous response + the apply error) to the original
// user message. Concatenation rather than diff-only so the model
// still sees the original task description and rendered touch-list
// file contents — those are the source of truth the retry must
// match.
function buildRetryPrompt(
  originalPrompt: string,
  previousResponse: string,
  applyError: string,
): string {
  return [
    originalPrompt,
    "",
    "## PREVIOUS ATTEMPT FAILED",
    "",
    "Your previous response was:",
    "",
    previousResponse,
    "",
    "Applying it produced this error:",
    "",
    applyError,
    "",
    "Likely cause: the SEARCH text in one of your blocks does not match the file content character-for-character. The runner uses exact-string matching (no fuzzy match, no whitespace normalization), so paraphrased text, altered indentation, or content from an outdated mental model of the file all fail this way. Re-read the current file contents shown above, then emit corrected search/replace blocks. Copy the SEARCH text verbatim from the rendered file content; do NOT paraphrase or reformat.",
  ].join("\n");
}

// Patch Z: parse a `READ_FILE: <path>` request from a broker response.
// Detection rules:
//   - A non-empty line matches `^\s*READ_FILE:\s*(\S.*?)\s*$`
//   - The response contains NO S/R markers and NO unified-diff
//     header (caller checks both before invoking this) — otherwise
//     prefer the actual delivery
//   - Path is captured as-is (including any leading/trailing
//     whitespace stripped). Backticks around the path are stripped
//     too — models often quote it.
// Returns null if no READ_FILE directive is found.
const READ_FILE_RE = /^\s*READ_FILE:\s*(\S.*?)\s*$/m;
function parseReadFileRequest(text: string): { path: string } | null {
  const m = READ_FILE_RE.exec(text);
  if (!m) return null;
  const raw = (m[1] ?? "").trim();
  // Strip surrounding backticks (model often quotes the path).
  const stripped = raw.replace(/^`+|`+$/g, "").trim();
  if (stripped.length === 0) return null;
  return { path: stripped };
}

// Patch Z: validate a READ_FILE-requested path against the safety
// policy. Returns { ok: true, absolutePath } when the path is safe
// to read, otherwise { ok: false, error } with a model-facing reason.
//
// Safety policy:
//   - Reject absolute paths (only relative paths permitted)
//   - Reject any segment equal to ".." (no traversal out of worktree)
//   - Reject paths whose resolved absolute form escapes worktreePath
//     (defense-in-depth against symlinks, exotic separators)
//   - Reject if the file does not exist at the resolved path
//   - The path must point to a regular file (not directory or other)
function validateReadPath(
  relPath: string,
  worktreePath: string,
): { ok: true; absolutePath: string } | { ok: false; error: string } {
  if (relPath.length === 0) {
    return { ok: false, error: "empty path" };
  }
  if (isAbsolute(relPath)) {
    return {
      ok: false,
      error: `absolute path "${relPath}" — relative paths only`,
    };
  }
  // Reject `..` traversal at the segment level (catches `../etc`,
  // `a/../b`, etc. before resolve normalizes them).
  const segments = relPath.split(/[/\\]/);
  if (segments.some((s) => s === "..")) {
    return {
      ok: false,
      error: `path "${relPath}" contains ".." traversal — denied`,
    };
  }
  const absolute = resolvePath(worktreePath, relPath);
  // Defense-in-depth: ensure the resolved path is still inside the
  // worktree. resolve() handles symlink-free paths correctly; this
  // catches edge cases where segment splitting missed something.
  const worktreeAbs = resolvePath(worktreePath);
  const inWorktree =
    absolute === worktreeAbs ||
    absolute.startsWith(worktreeAbs + "/") ||
    absolute.startsWith(worktreeAbs + "\\");
  if (!inWorktree) {
    return {
      ok: false,
      error: `path "${relPath}" resolves outside the worktree — denied`,
    };
  }
  if (!existsSync(absolute)) {
    return {
      ok: false,
      error: `file "${relPath}" does not exist in the worktree`,
    };
  }
  return { ok: true, absolutePath: absolute };
}

// Patch Z: read a file for the builder with size cap + truncation.
// Reuses TOUCH_FILE_SOFT_CAP_BYTES so the read tool's footprint
// matches the touch-list rendering — operators tuning the prompt
// budget tune ONE constant.
function readFileForBuilder(
  absolutePath: string,
):
  | { ok: true; contents: string; truncated: boolean }
  | { ok: false; error: string } {
  let contents: string;
  try {
    contents = readFileSync(absolutePath, "utf8");
  } catch (e) {
    return {
      ok: false,
      error: `could not read file: ${e instanceof Error ? e.message : String(e)}`,
    };
  }
  let truncated = false;
  if (contents.length > TOUCH_FILE_SOFT_CAP_BYTES) {
    contents = contents.slice(0, TOUCH_FILE_SOFT_CAP_BYTES);
    truncated = true;
  }
  return { ok: true, contents, truncated };
}

// Patch Z: build the followup prompt after a successful READ_FILE.
// Original prompt + a section showing the requested file's contents.
// Explicit "do NOT issue another READ_FILE" instruction so the model
// doesn't burn its remaining attempts on more tool calls when the
// budget is gone (calling-side enforces the cap regardless, but the
// hint reduces wasted broker calls in the common case).
function buildReadFileFollowup(
  originalPrompt: string,
  path: string,
  contents: string,
  truncated: boolean,
): string {
  // Pick a fence that won't collide with content. Match
  // renderTouchListFiles's behavior so the formatting is consistent.
  let fence = "````";
  if (contents.includes(fence)) fence = "`````";
  return [
    originalPrompt,
    "",
    "## ADDITIONAL FILE — READ_FILE response",
    "",
    `You requested to read \`${path}\`. Contents follow${truncated ? ` (truncated at ${TOUCH_FILE_SOFT_CAP_BYTES} bytes — full file is longer)` : ""}:`,
    "",
    `### ${path}`,
    "",
    fence,
    contents,
    fence,
    "",
    "Now produce the search/replace blocks for the touch-list files. Do NOT issue another READ_FILE — you have used your read budget.",
  ].join("\n");
}

// Patch Z: build the followup prompt after a denied READ_FILE.
// Surfaces the structured denial reason so the model can either pick
// a valid path on its remaining read budget OR proceed with S/R.
function buildReadFileErrorPrompt(
  originalPrompt: string,
  requestedPath: string,
  reason: string,
): string {
  return [
    originalPrompt,
    "",
    "## READ_FILE DENIED",
    "",
    `You requested to read \`${requestedPath}\`, but the runner rejected it: ${reason}.`,
    "",
    "Either request a different file (must be a relative path inside the worktree, no `..` traversal, must exist) OR proceed directly with your search/replace blocks for the touch-list files.",
  ].join("\n");
}

// Patch BB: format the verifier result for the verify-retry prompt and
// transcript. The model needs the phase + the actual stderr from the
// failing tool — exit codes alone are not enough to fix a typecheck or
// test failure. Output is plain-text; the caller wraps it in a fenced
// section.
function formatVerifierFeedback(result: VerificationResult): string {
  const lines: string[] = [`phase: ${result.phase}`];
  if (result.typecheckExitCode !== undefined) {
    lines.push(`typecheckExitCode: ${result.typecheckExitCode}`);
  }
  if (result.testExitCode !== undefined) {
    lines.push(`testExitCode: ${result.testExitCode}`);
  }
  if (result.typecheckStderr) {
    lines.push("typecheckStderr:", result.typecheckStderr);
  }
  if (result.testStderr) {
    lines.push("testStderr:", result.testStderr);
  }
  return lines.join("\n");
}

// Patch BB: build the verify-retry prompt by appending verifier
// feedback to the original user message. The previous commit has
// already been rolled back via `git reset --hard HEAD~1`, so the model
// is producing S/R against the SAME base tree the touch-list rendering
// reflects. We tell the model that explicitly so it doesn't try to
// account for a phantom prior change.
function buildVerifyRetryPrompt(
  originalPrompt: string,
  previousResponse: string,
  verifierResult: VerificationResult,
): string {
  return [
    originalPrompt,
    "",
    "## PREVIOUS ATTEMPT BUILT-AND-COMMITTED, BUT VERIFICATION FAILED",
    "",
    "Your previous response was:",
    "",
    previousResponse,
    "",
    "When applied + committed to the worktree, the verifier reported:",
    "",
    formatVerifierFeedback(verifierResult),
    "",
    "The commit has been rolled back to the pre-attempt state, so the touch-list file contents shown above are the CURRENT tree state (not the post-attempt state). Re-read those contents, then emit corrected search/replace blocks that fix the verification failure. Address the actual error from the verifier output above; do not just regenerate the same patch.",
  ].join("\n");
}

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
  // Patch T: caller passes pinnedModelKey when present so failed
  // candidates carry the intended model in their CandidatePatch
  // record. Don't invent a modelKey when undefined — the writer
  // treats undefined as "unknown model" and skips aggregation, which
  // is correct for unpinned calls.
  pinnedModelKey?: string,
): CandidatePatch {
  return {
    builderId: run.builderId,
    ...(pinnedModelKey !== undefined ? { modelKey: pinnedModelKey } : {}),
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
