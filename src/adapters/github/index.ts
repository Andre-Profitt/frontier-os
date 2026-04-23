// GitHub adapter — wraps the `gh` CLI for read-only PR / issue / repo queries.
//
// All commands shell out to `/opt/homebrew/bin/gh` via child_process.spawn,
// capture stdout (JSON from `--json ...`), and return it verbatim under
// observedState. Auth is delegated to `gh` itself (keyring / env GH_TOKEN).
//
// Design notes:
// - spawn (async) — the executor fires adapter waves in parallel, so no
//   spawnSync.
// - If `gh` isn't on PATH we surface the ENOENT as a failed result with a
//   hint rather than crashing the executor.
// - JSON parse failures are treated as adapter failures (status=failed) with
//   the raw stdout truncated into observedState.rawStdout so the caller can
//   diagnose (e.g. when `gh` prompts interactively because auth lapsed).
// - The exact `gh` argv + exit metadata is echoed in observedState.invocation
//   for auditability — watchers replay those args deterministically.
// - No timeout by default. If invocation.policy.maxRuntimeSeconds is set we
//   honor it by killing the child; otherwise we rely on gh's own network
//   timeouts (the caller owns long-running behavior).

import { spawn } from "node:child_process";

import { adapterCommandSpec, type AdapterImpl } from "../../registry.ts";
import { buildResult, failedResult } from "../../result.ts";
import type {
  AdapterInvocation,
  AdapterManifest,
  AdapterResult,
} from "../../schemas.ts";

const GH_BIN = process.env["FRONTIER_GH_BIN"] ?? "gh";

interface GhRunResult {
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  argv: string[];
  spawnError?: Error;
}

/**
 * Spawn `gh` asynchronously, collecting stdout + stderr. Never throws; always
 * resolves with a GhRunResult so callers can translate to AdapterResult shape.
 */
function runGh(args: string[], timeoutMs?: number): Promise<GhRunResult> {
  return new Promise((resolve) => {
    const child = spawn(GH_BIN, args, {
      stdio: ["ignore", "pipe", "pipe"],
      // No shell; args are passed verbatim.
    });
    const argv = [GH_BIN, ...args];

    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let timer: NodeJS.Timeout | undefined;

    if (timeoutMs !== undefined && timeoutMs > 0) {
      timer = setTimeout(() => {
        timedOut = true;
        child.kill("SIGTERM");
      }, timeoutMs);
    }

    child.stdout?.on("data", (chunk) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr?.on("data", (chunk) => {
      stderr += chunk.toString("utf8");
    });

    child.on("error", (err) => {
      if (timer) clearTimeout(timer);
      resolve({
        code: null,
        signal: null,
        stdout,
        stderr: stderr || err.message,
        argv,
        spawnError: err,
      });
    });

    child.on("close", (code, signal) => {
      if (timer) clearTimeout(timer);
      const effectiveStderr =
        timedOut && !stderr ? `gh timed out after ${timeoutMs}ms` : stderr;
      resolve({
        code,
        signal,
        stdout,
        stderr: effectiveStderr,
        argv,
      });
    });
  });
}

/** Coerce `arguments.owner/repo` to non-empty strings or throw. */
function requireOwnerRepo(invocation: AdapterInvocation): {
  owner: string;
  repo: string;
} {
  const args = (invocation.arguments ?? {}) as Record<string, unknown>;
  const owner = args["owner"];
  const repo = args["repo"];
  if (typeof owner !== "string" || owner.trim() === "") {
    throw new Error(
      `${invocation.command} requires arguments.owner (non-empty string)`,
    );
  }
  if (typeof repo !== "string" || repo.trim() === "") {
    throw new Error(
      `${invocation.command} requires arguments.repo (non-empty string)`,
    );
  }
  return { owner: owner.trim(), repo: repo.trim() };
}

function requireNumber(invocation: AdapterInvocation, key: string): number {
  const args = (invocation.arguments ?? {}) as Record<string, unknown>;
  const raw = args[key];
  const n = typeof raw === "string" ? Number(raw) : raw;
  if (typeof n !== "number" || !Number.isInteger(n) || n <= 0) {
    throw new Error(
      `${invocation.command} requires arguments.${key} (positive integer)`,
    );
  }
  return n;
}

function optionalState(
  invocation: AdapterInvocation,
): "open" | "closed" | "all" | undefined {
  const args = (invocation.arguments ?? {}) as Record<string, unknown>;
  const raw = args["state"];
  if (raw === undefined || raw === null) return undefined;
  if (raw === "open" || raw === "closed" || raw === "all") return raw;
  throw new Error(
    `${invocation.command} arguments.state must be "open", "closed", or "all"`,
  );
}

function optionalLimit(invocation: AdapterInvocation): number | undefined {
  const args = (invocation.arguments ?? {}) as Record<string, unknown>;
  const raw = args["limit"];
  if (raw === undefined || raw === null) return undefined;
  const n = typeof raw === "string" ? Number(raw) : raw;
  if (typeof n !== "number" || !Number.isInteger(n) || n <= 0) {
    throw new Error(
      `${invocation.command} arguments.limit must be a positive integer`,
    );
  }
  return n;
}

function optionalLabels(invocation: AdapterInvocation): string[] | undefined {
  const args = (invocation.arguments ?? {}) as Record<string, unknown>;
  const raw = args["labels"];
  if (raw === undefined || raw === null) return undefined;
  if (
    !Array.isArray(raw) ||
    !raw.every((x) => typeof x === "string" && x.length > 0)
  ) {
    throw new Error(
      `${invocation.command} arguments.labels must be a string[] of non-empty labels`,
    );
  }
  return raw as string[];
}

/**
 * Finalize a gh invocation by translating its exit state + stdout into an
 * AdapterResult. `successSummary` formats the one-line status banner when
 * gh exits cleanly AND the stdout parses as JSON.
 */
function finalize(
  invocation: AdapterInvocation,
  run: GhRunResult,
  successSummary: (parsed: unknown) => string,
): AdapterResult {
  const invocationRecord = {
    argv: run.argv,
    exitCode: run.code,
    signal: run.signal,
  };

  if (run.spawnError) {
    const err = run.spawnError as NodeJS.ErrnoException;
    const hint =
      err.code === "ENOENT"
        ? ` (is '${GH_BIN}' installed and on PATH? set FRONTIER_GH_BIN to override)`
        : "";
    return failedResult(invocation, new Error(`gh: ${err.message}${hint}`), {
      observedState: {
        invocation: invocationRecord,
        error: err.message,
      },
    });
  }

  if (run.code !== 0) {
    const stderrTrim = run.stderr.trim();
    const msg = stderrTrim || `gh exited with code ${run.code}`;
    return failedResult(invocation, new Error(`gh: ${msg}`), {
      observedState: {
        invocation: invocationRecord,
        stderr: stderrTrim,
      },
    });
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(run.stdout);
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    return failedResult(
      invocation,
      new Error(`gh: failed to parse JSON stdout (${reason})`),
      {
        observedState: {
          invocation: invocationRecord,
          rawStdout: run.stdout.slice(0, 4000),
          stderr: run.stderr.trim(),
        },
      },
    );
  }

  return buildResult({
    invocation,
    status: "success",
    summary: successSummary(parsed),
    observedState: {
      invocation: invocationRecord,
      data: parsed,
    },
    verification: {
      status: "passed",
      checks: ["trace_grade"],
    },
  });
}

// ---- command handlers ----

async function listPrsCommand(
  invocation: AdapterInvocation,
  timeoutMs: number | undefined,
): Promise<AdapterResult> {
  const { owner, repo } = requireOwnerRepo(invocation);
  const state = optionalState(invocation) ?? "open";
  const limit = optionalLimit(invocation) ?? 30;
  const args = [
    "pr",
    "list",
    "-R",
    `${owner}/${repo}`,
    "--state",
    state,
    "--limit",
    String(limit),
    "--json",
    "number,title,state,author,createdAt,updatedAt,url",
  ];
  const run = await runGh(args, timeoutMs);
  return finalize(invocation, run, (parsed) => {
    const count = Array.isArray(parsed) ? parsed.length : 0;
    return `${owner}/${repo}: ${count} pr(s) state=${state}`;
  });
}

async function getPrCommand(
  invocation: AdapterInvocation,
  timeoutMs: number | undefined,
): Promise<AdapterResult> {
  const { owner, repo } = requireOwnerRepo(invocation);
  const number = requireNumber(invocation, "number");
  const args = [
    "pr",
    "view",
    String(number),
    "-R",
    `${owner}/${repo}`,
    "--json",
    "number,title,body,state,author,baseRefName,headRefName,files,additions,deletions,commits,url",
  ];
  const run = await runGh(args, timeoutMs);
  return finalize(invocation, run, (parsed) => {
    const obj = (parsed ?? {}) as Record<string, unknown>;
    const state = typeof obj["state"] === "string" ? obj["state"] : "?";
    const title = typeof obj["title"] === "string" ? obj["title"] : "";
    const trimmed = title.length > 80 ? `${title.slice(0, 77)}...` : title;
    return `${owner}/${repo}#${number} [${state}] ${trimmed}`;
  });
}

async function listIssuesCommand(
  invocation: AdapterInvocation,
  timeoutMs: number | undefined,
): Promise<AdapterResult> {
  const { owner, repo } = requireOwnerRepo(invocation);
  const state = optionalState(invocation) ?? "open";
  const limit = optionalLimit(invocation) ?? 30;
  const labels = optionalLabels(invocation);
  const args = [
    "issue",
    "list",
    "-R",
    `${owner}/${repo}`,
    "--state",
    state,
    "--limit",
    String(limit),
    "--json",
    "number,title,state,author,labels,createdAt,updatedAt,url",
  ];
  if (labels && labels.length > 0) {
    args.push("--label", labels.join(","));
  }
  const run = await runGh(args, timeoutMs);
  return finalize(invocation, run, (parsed) => {
    const count = Array.isArray(parsed) ? parsed.length : 0;
    const labelPart =
      labels && labels.length > 0 ? ` labels=${labels.join(",")}` : "";
    return `${owner}/${repo}: ${count} issue(s) state=${state}${labelPart}`;
  });
}

async function repoSummaryCommand(
  invocation: AdapterInvocation,
  timeoutMs: number | undefined,
): Promise<AdapterResult> {
  const { owner, repo } = requireOwnerRepo(invocation);
  // Note: `gh repo view` does not expose `openIssuesCount`; the closest
  // scalar is `issues` → `{ totalCount }` (total issues, open+closed). We
  // request that instead and alias it as `issueCount` in observedState so
  // downstream consumers (and the README example) see a stable key.
  const args = [
    "repo",
    "view",
    `${owner}/${repo}`,
    "--json",
    "name,description,defaultBranchRef,pushedAt,stargazerCount,issues,url",
  ];
  const run = await runGh(args, timeoutMs);
  return finalize(invocation, run, (parsed) => {
    const obj = (parsed ?? {}) as Record<string, unknown>;
    const stars =
      typeof obj["stargazerCount"] === "number" ? obj["stargazerCount"] : "?";
    const issuesObj = obj["issues"] as { totalCount?: unknown } | undefined;
    const total =
      issuesObj && typeof issuesObj.totalCount === "number"
        ? issuesObj.totalCount
        : "?";
    return `${owner}/${repo}: ${stars} star(s), ${total} total issue(s)`;
  });
}

type CommandHandler = (
  invocation: AdapterInvocation,
  timeoutMs: number | undefined,
) => Promise<AdapterResult>;

async function createPrCommentCommand(
  invocation: AdapterInvocation,
  timeoutMs: number | undefined,
): Promise<AdapterResult> {
  const { owner, repo } = requireOwnerRepo(invocation);
  const args = invocation.arguments as Record<string, unknown>;
  const number = typeof args["number"] === "number" ? args["number"] : NaN;
  if (!Number.isFinite(number) || number <= 0 || !Number.isInteger(number)) {
    return failedResult(
      invocation,
      new Error(
        `create-pr-comment requires arguments.number (positive integer)`,
      ),
    );
  }
  const body = typeof args["body"] === "string" ? args["body"].trim() : "";
  if (!body) {
    return failedResult(
      invocation,
      new Error(`create-pr-comment requires arguments.body (non-empty string)`),
    );
  }

  const ghArgs = [
    "pr",
    "comment",
    String(number),
    "-R",
    `${owner}/${repo}`,
    "--body",
    body,
  ];

  // Propose mode: NEVER call gh. Return the exact argv + body preview so the
  // caller (work-graph executor, Ghost Shift, human reviewer) can inspect the
  // side effect without mutating GitHub state. This is the primitive that
  // makes class-2 actions safe to schedule overnight — Ghost Shift can prove
  // intent without commit.
  if (invocation.mode === "propose") {
    return buildResult({
      invocation,
      status: "success",
      summary: `propose: would comment on ${owner}/${repo}#${number} (${body.length} chars)`,
      observedState: {
        mode: "propose",
        invocation: { argv: [GH_BIN, ...ghArgs] },
        target: { owner, repo, number },
        bodyPreview:
          body.length > 400
            ? body.slice(0, 400) + `…(+${body.length - 400})`
            : body,
        bodyBytes: body.length,
      },
      sideEffects: [
        {
          class: "shared_write",
          target: `${owner}/${repo}#${number}`,
          summary: "would post a PR comment",
        },
      ],
      verification: {
        status: "passed",
        checks: ["trace_grade"],
      },
    });
  }

  // Apply mode: real write. `gh pr comment` emits the comment URL to stdout
  // on success with exit 0 (non-JSON), so we can't use `finalize`'s JSON path.
  const run = await runGh(ghArgs, timeoutMs);
  const invocationRecord = {
    argv: run.argv,
    exitCode: run.code,
    signal: run.signal,
  };
  if (run.spawnError) {
    const e = run.spawnError as NodeJS.ErrnoException;
    const hint =
      e.code === "ENOENT"
        ? ` (is '${GH_BIN}' installed and on PATH? set FRONTIER_GH_BIN to override)`
        : "";
    return failedResult(invocation, new Error(`gh: ${e.message}${hint}`), {
      observedState: { invocation: invocationRecord, error: e.message },
    });
  }
  if (run.code !== 0) {
    const stderrTrim = run.stderr.trim();
    return failedResult(
      invocation,
      new Error(`gh: ${stderrTrim || `exited with code ${run.code}`}`),
      {
        observedState: { invocation: invocationRecord, stderr: stderrTrim },
      },
    );
  }
  const commentUrl = run.stdout.trim();
  return buildResult({
    invocation,
    status: "success",
    summary: `commented on ${owner}/${repo}#${number}: ${commentUrl}`,
    observedState: {
      mode: "apply",
      invocation: invocationRecord,
      target: { owner, repo, number },
      commentUrl,
      bodyBytes: body.length,
    },
    sideEffects: [
      {
        class: "shared_write",
        target: `${owner}/${repo}#${number}`,
        summary: `posted a comment: ${commentUrl}`,
      },
    ],
    artifacts: [
      {
        kind: "url",
        ref: commentUrl,
        note: `PR comment on ${owner}/${repo}#${number}`,
      },
    ],
    verification: {
      status: "passed",
      checks: ["trace_grade"],
    },
  });
}

const HANDLERS: Record<string, CommandHandler> = {
  "list-prs": listPrsCommand,
  "get-pr": getPrCommand,
  "list-issues": listIssuesCommand,
  "repo-summary": repoSummaryCommand,
  "create-pr-comment": createPrCommentCommand,
};

export async function createGithubAdapter(
  manifest: AdapterManifest,
): Promise<AdapterImpl> {
  return {
    manifest,
    async invoke(invocation: AdapterInvocation): Promise<AdapterResult> {
      // 1. Manifest sanity — command must be declared.
      const spec = adapterCommandSpec(manifest, invocation.command);
      // 2. Mode must be supported.
      if (!spec.supportedModes.includes(invocation.mode)) {
        return failedResult(
          invocation,
          new Error(
            `command "${invocation.command}" does not support mode "${invocation.mode}"`,
          ),
        );
      }
      // 3. Handler exists.
      const handler = HANDLERS[invocation.command];
      if (!handler) {
        return failedResult(
          invocation,
          new Error(
            `github adapter has no handler for command "${invocation.command}" yet`,
          ),
        );
      }
      const timeoutSec = invocation.policy?.maxRuntimeSeconds;
      const timeoutMs =
        typeof timeoutSec === "number" && timeoutSec > 0
          ? timeoutSec * 1000
          : undefined;
      try {
        return await handler(invocation, timeoutMs);
      } catch (err) {
        return failedResult(invocation, err);
      }
    },
  };
}
