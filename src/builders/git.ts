// Thin git command runner used by the worktree manager. The pattern
// matches src/context/pack.ts (spawnSync, encoding utf-8, capped timeout).
// A custom runner can be injected for tests so we can either drive a real
// temp git repo OR stub specific git commands without subprocess overhead.

import { spawnSync } from "node:child_process";

const DEFAULT_TIMEOUT_MS = 30_000;

export interface GitResult {
  ok: boolean;
  stdout: string;
  stderr: string;
  status: number | null;
  signal: NodeJS.Signals | null;
}

export type GitRunner = (
  args: string[],
  cwd?: string,
  timeoutMs?: number,
) => GitResult;

export const defaultGitRunner: GitRunner = (
  args,
  cwd,
  timeoutMs = DEFAULT_TIMEOUT_MS,
) => {
  const opts: Parameters<typeof spawnSync>[2] = {
    encoding: "utf8",
    timeout: timeoutMs,
  };
  if (cwd !== undefined) opts.cwd = cwd;
  const res = spawnSync("git", args, opts);
  if (res.error) {
    return {
      ok: false,
      stdout: "",
      stderr: res.error.message,
      status: null,
      signal: null,
    };
  }
  return {
    ok: res.status === 0,
    stdout: typeof res.stdout === "string" ? res.stdout : "",
    stderr: typeof res.stderr === "string" ? res.stderr : "",
    status: res.status ?? null,
    signal: (res.signal as NodeJS.Signals | null) ?? null,
  };
};

// Convenience: throw on non-zero, return stdout. Used by worktree-manager
// for read-only commands where any failure should abort.
export function gitOrThrow(
  runner: GitRunner,
  args: string[],
  cwd?: string,
): string {
  const res = runner(args, cwd);
  if (!res.ok) {
    throw new GitCommandError(
      `git ${args.join(" ")} failed (status=${res.status})`,
      res,
    );
  }
  return res.stdout;
}

export class GitCommandError extends Error {
  constructor(
    message: string,
    public result: GitResult,
  ) {
    super(message);
    this.name = "GitCommandError";
  }
}
