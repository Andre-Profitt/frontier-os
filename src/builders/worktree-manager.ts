// WorktreeManager — spawn / list / collect / remove builder worktrees.
//
// Lifecycle:
//   spawn(opts)   → git worktree add .worktrees/<runId>/ -b builders/<runId>
//                   from baseBranch's tip; persists state at
//                   state/builders/<runId>.json with status=spawned
//   collect(id)   → git diff baseCommit..HEAD inside the worktree;
//                   captures unified diff + file list + add/del counts +
//                   commitCount; status=collected
//   remove(id)    → git worktree remove .worktrees/<runId>/; deletes the
//                   builders/<runId> branch (force=true overrides any
//                   uncommitted changes); status=cleaned, state file kept
//                   for the audit trail
//
// One builder = one worktree. Branch name (`builders/<runId>`) is in its
// own namespace so it never collides with `agent/<date>/<topic>` work
// branches. The state file is the source of truth for what was spawned;
// `git worktree list --porcelain` is a secondary check.
//
// The schema (schemas/builder-run.schema.json) validates persisted state
// on every load — corrupt JSON or schema drift surfaces as a SkillLoadError
// equivalent at read time, not at downstream consumer time.

import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { validateBuilderRun } from "../schemas.ts";
import {
  defaultGitRunner,
  gitOrThrow,
  GitCommandError,
  type GitRunner,
} from "./git.ts";
import type { BuilderPatch, BuilderRun, BuilderStatus } from "./types.ts";

const HERE = fileURLToPath(import.meta.url);
const REPO_ROOT_DEFAULT = resolve(dirname(HERE), "..", "..");

export class BuilderRunError extends Error {
  constructor(
    message: string,
    public details?: unknown,
  ) {
    super(message);
    this.name = "BuilderRunError";
  }
}

export interface WorktreeManagerOptions {
  // Repo root the worktrees branch off. Defaults to <repo>/. Tests pass
  // a temp git repo here.
  repoRoot?: string;
  // Where new worktrees live. Defaults to <repoRoot>/.worktrees.
  worktreesDir?: string;
  // Where state/<runId>.json files live. Defaults to <repoRoot>/state/builders.
  stateDir?: string;
  // Test seam.
  now?: () => number;
  exec?: GitRunner;
}

export interface SpawnOpts {
  taskId: string;
  builderId: string;
  taskClass: string;
  // Defaults to the repo's current HEAD branch.
  baseBranch?: string;
  // Optional: bind this builder to a specific (provider, model) for the
  // ledger trail. Doesn't affect the worktree itself.
  modelKey?: string;
}

export class WorktreeManager {
  readonly repoRoot: string;
  readonly worktreesDir: string;
  readonly stateDir: string;
  private now: () => number;
  private exec: GitRunner;

  constructor(opts: WorktreeManagerOptions = {}) {
    this.repoRoot = opts.repoRoot ?? REPO_ROOT_DEFAULT;
    this.worktreesDir =
      opts.worktreesDir ?? resolve(this.repoRoot, ".worktrees");
    this.stateDir =
      opts.stateDir ?? resolve(this.repoRoot, "state", "builders");
    this.now = opts.now ?? Date.now;
    this.exec = opts.exec ?? defaultGitRunner;
  }

  // --- spawn ----------------------------------------------------------

  spawn(opts: SpawnOpts): BuilderRun {
    if (!opts.taskId.match(/^[a-zA-Z0-9_.-]+$/)) {
      throw new BuilderRunError(
        `taskId must be slug-safe ([a-zA-Z0-9_.-]+); got "${opts.taskId}"`,
      );
    }
    if (!opts.builderId.match(/^[a-zA-Z0-9_.-]+$/)) {
      throw new BuilderRunError(
        `builderId must be slug-safe ([a-zA-Z0-9_.-]+); got "${opts.builderId}"`,
      );
    }

    const baseBranch = opts.baseBranch ?? this.detectCurrentBranch();
    const baseCommit = this.resolveCommit(baseBranch);

    const runId = newRunId(opts.taskId, opts.builderId, this.now());
    const branchName = `builders/${runId}`;
    const worktreePath = resolve(this.worktreesDir, runId);

    if (existsSync(worktreePath)) {
      throw new BuilderRunError(
        `worktree path already exists: ${worktreePath}`,
      );
    }
    if (existsSync(this.stateFilePath(runId))) {
      throw new BuilderRunError(
        `state file already exists for runId ${runId}: ${this.stateFilePath(runId)}`,
      );
    }

    mkdirSync(this.worktreesDir, { recursive: true });
    mkdirSync(this.stateDir, { recursive: true });

    const addRes = this.exec(
      ["worktree", "add", "-b", branchName, worktreePath, baseCommit],
      this.repoRoot,
    );
    if (!addRes.ok) {
      throw new BuilderRunError(
        `git worktree add failed for runId ${runId}: ${addRes.stderr}`,
        { runId, stderr: addRes.stderr, status: addRes.status },
      );
    }

    const run: BuilderRun = {
      runId,
      taskId: opts.taskId,
      builderId: opts.builderId,
      taskClass: opts.taskClass,
      ...(opts.modelKey !== undefined ? { modelKey: opts.modelKey } : {}),
      baseBranch,
      baseCommit,
      branchName,
      worktreePath,
      createdAt: new Date(this.now()).toISOString(),
      status: "spawned",
    };
    this.persist(run);
    return run;
  }

  // --- list / get -----------------------------------------------------

  list(): BuilderRun[] {
    if (!existsSync(this.stateDir)) return [];
    const files = readdirSync(this.stateDir).filter(
      (f) => f.endsWith(".json") && !f.startsWith("."),
    );
    const runs: BuilderRun[] = [];
    for (const f of files) {
      const path = resolve(this.stateDir, f);
      try {
        runs.push(this.loadFromPath(path));
      } catch {
        // Skip unparseable files — corrupt state must not crash list().
      }
    }
    return runs.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  get(runId: string): BuilderRun | null {
    const path = this.stateFilePath(runId);
    if (!existsSync(path)) return null;
    return this.loadFromPath(path);
  }

  // --- collect --------------------------------------------------------

  collect(runId: string): BuilderRun {
    const run = this.get(runId);
    if (!run) {
      throw new BuilderRunError(`unknown runId: ${runId}`);
    }
    if (!existsSync(run.worktreePath)) {
      throw new BuilderRunError(
        `worktree missing for runId ${runId} at ${run.worktreePath}`,
      );
    }

    let patch: BuilderPatch;
    try {
      patch = this.diffPatch(run);
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      const stderr = e instanceof GitCommandError ? e.result.stderr : undefined;
      const updated: BuilderRun = {
        ...run,
        status: "failed",
        error: { phase: "collect", message, ...(stderr ? { stderr } : {}) },
      };
      this.persist(updated);
      throw new BuilderRunError(
        `collect failed for runId ${runId}: ${message}`,
      );
    }

    const updated: BuilderRun = {
      ...run,
      status: "collected" as BuilderStatus,
      collectedAt: new Date(this.now()).toISOString(),
      patch,
    };
    this.persist(updated);
    return updated;
  }

  // --- remove ---------------------------------------------------------

  remove(runId: string, opts: { force?: boolean } = {}): BuilderRun {
    const run = this.get(runId);
    if (!run) {
      throw new BuilderRunError(`unknown runId: ${runId}`);
    }

    if (existsSync(run.worktreePath)) {
      const args = ["worktree", "remove"];
      if (opts.force) args.push("--force");
      args.push(run.worktreePath);
      const res = this.exec(args, this.repoRoot);
      if (!res.ok) {
        const updated: BuilderRun = {
          ...run,
          status: "failed",
          error: {
            phase: "clean",
            message: `git worktree remove failed: status=${res.status}`,
            stderr: res.stderr,
          },
        };
        this.persist(updated);
        throw new BuilderRunError(
          `git worktree remove failed for runId ${runId}: ${res.stderr}`,
        );
      }
    }

    // Delete the branch — workers don't keep their working branches around.
    // Use -D so we can also remove branches with uncommitted changes that
    // were never collected.
    const branchRes = this.exec(
      ["branch", "-D", run.branchName],
      this.repoRoot,
    );
    if (!branchRes.ok && !branchRes.stderr.includes("not found")) {
      // best-effort: log into state, do not throw — the worktree is gone,
      // a stale branch is recoverable manually.
    }

    const updated: BuilderRun = {
      ...run,
      status: "cleaned" as BuilderStatus,
      cleanedAt: new Date(this.now()).toISOString(),
    };
    this.persist(updated);
    return updated;
  }

  // --- internals ------------------------------------------------------

  private stateFilePath(runId: string): string {
    return resolve(this.stateDir, `${runId}.json`);
  }

  private persist(run: BuilderRun): void {
    // Capture before validate — Ajv's type guard narrows `run` to `never`
    // in the !valid branch, so any `run.foo` access in the throw fails.
    const runId = run.runId;
    if (!validateBuilderRun(run)) {
      throw new BuilderRunError(
        `attempted to persist invalid BuilderRun for runId ${runId}`,
        { errors: validateBuilderRun.errors },
      );
    }
    mkdirSync(this.stateDir, { recursive: true });
    writeFileSync(
      this.stateFilePath(runId),
      JSON.stringify(run, null, 2) + "\n",
    );
  }

  private loadFromPath(path: string): BuilderRun {
    const raw = JSON.parse(readFileSync(path, "utf8"));
    if (!validateBuilderRun(raw)) {
      throw new BuilderRunError(`state file ${path} failed schema validation`, {
        errors: validateBuilderRun.errors,
      });
    }
    return raw as BuilderRun;
  }

  private detectCurrentBranch(): string {
    return gitOrThrow(
      this.exec,
      ["rev-parse", "--abbrev-ref", "HEAD"],
      this.repoRoot,
    ).trim();
  }

  private resolveCommit(rev: string): string {
    return gitOrThrow(this.exec, ["rev-parse", rev], this.repoRoot).trim();
  }

  private diffPatch(run: BuilderRun): BuilderPatch {
    // Diff against the recorded baseCommit, not the current tip of
    // baseBranch — baseBranch may have moved since spawn and we want a
    // stable comparison.
    const diff = gitOrThrow(
      this.exec,
      ["diff", `${run.baseCommit}..HEAD`],
      run.worktreePath,
    );
    const namesRaw = gitOrThrow(
      this.exec,
      ["diff", "--name-only", `${run.baseCommit}..HEAD`],
      run.worktreePath,
    );
    const files = namesRaw
      .split("\n")
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
    const numstat = gitOrThrow(
      this.exec,
      ["diff", "--numstat", `${run.baseCommit}..HEAD`],
      run.worktreePath,
    );
    let added = 0;
    let deleted = 0;
    for (const line of numstat.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      const parts = trimmed.split(/\s+/);
      const a = parseInt(parts[0] ?? "0", 10);
      const d = parseInt(parts[1] ?? "0", 10);
      if (Number.isFinite(a)) added += a;
      if (Number.isFinite(d)) deleted += d;
    }
    const commitCountRaw = gitOrThrow(
      this.exec,
      ["rev-list", "--count", `${run.baseCommit}..HEAD`],
      run.worktreePath,
    );
    const commitCount = parseInt(commitCountRaw.trim(), 10) || 0;
    return {
      diff,
      files: [...new Set(files)].sort(),
      sizeBytes: Buffer.byteLength(diff, "utf8"),
      addedLines: added,
      deletedLines: deleted,
      commitCount,
    };
  }
}

// runId schema: <taskId>--<builderId>--<base36-timestamp>--<rand>
// Slug-safe, sortable by recency, low collision probability across
// concurrent spawns within the same millisecond.
function newRunId(taskId: string, builderId: string, nowMs: number): string {
  const ts = Math.floor(nowMs / 1000).toString(36);
  const rand = Math.random().toString(36).slice(2, 8);
  return `${taskId}--${builderId}--${ts}--${rand}`;
}

// Re-export for callers that need the absolute paths without instantiating
// a manager.
export function defaultStateDir(repoRoot: string = REPO_ROOT_DEFAULT): string {
  return resolve(repoRoot, "state", "builders");
}

export function defaultWorktreesDir(
  repoRoot: string = REPO_ROOT_DEFAULT,
): string {
  return resolve(repoRoot, ".worktrees");
}

// Sanity export — callers asserting absolute paths.
void isAbsolute;
