// Dispatch a prepared node to the right runtime and return a normalized result.
//
// For the Phase 6 MVP we support:
//   - structured_payload inputs targeting an adapter (calls the registry)
//   - structured_payload inputs with `cli.command` + args on the linux plane
//   - approval nodes (honor autoApprove flag or a file token)
// Every other combination yields a "not_implemented" result so graphs keep
// moving — explicitly marked skipped rather than failed.

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { homedir } from "node:os";

import type { WorkNode, WorkGraph } from "./graph.ts";
import { resolveAdapter } from "../registry.ts";
import { newInvocationId } from "../result.ts";

export type DispatchStatus =
  | "succeeded"
  | "failed"
  | "skipped"
  | "not_implemented";

export interface DispatchResult {
  status: DispatchStatus;
  summary: string;
  payload: Record<string, unknown>;
  artifactRefs?: string[];
}

export interface DispatchContext {
  graph: WorkGraph;
  sessionId: string;
  autoApprove: boolean;
  approvalTokenDir?: string;
}

export async function dispatchNode(
  node: WorkNode,
  ctx: DispatchContext,
): Promise<DispatchResult> {
  try {
    // --- Approval nodes: gate on autoApprove or token file ---
    if (node.kind === "approval") {
      return resolveApproval(node, ctx);
    }

    // --- structured_payload with adapter invocation ---
    const adapterInput = node.inputs.find(
      (i) =>
        i.type === "structured_payload" &&
        isRecord(i.value) &&
        typeof i.value.adapterId === "string" &&
        typeof i.value.command === "string",
    );
    if (adapterInput && isRecord(adapterInput.value)) {
      return invokeAdapter(node, adapterInput.value);
    }

    // --- structured_payload with native CLI command ---
    const cliInput = node.inputs.find(
      (i) =>
        i.type === "structured_payload" &&
        isRecord(i.value) &&
        isRecord(i.value.cli) &&
        typeof (i.value.cli as Record<string, unknown>).command === "string",
    );
    if (cliInput && isRecord(cliInput.value)) {
      return runNativeCli(cliInput.value.cli as Record<string, unknown>);
    }

    return {
      status: "not_implemented",
      summary: `no dispatcher for kind=${node.kind} executor=${node.runtime.executor}`,
      payload: { nodeKind: node.kind, executor: node.runtime.executor },
    };
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    return {
      status: "failed",
      summary: `dispatch error: ${message}`,
      payload: { error: message },
    };
  }
}

function resolveApproval(node: WorkNode, ctx: DispatchContext): DispatchResult {
  if (ctx.autoApprove) {
    return {
      status: "succeeded",
      summary: "approval auto-granted via --auto-approve",
      payload: { mode: "auto_approve", nodeId: node.nodeId },
    };
  }
  const dir =
    ctx.approvalTokenDir ?? resolve(homedir(), ".frontier", "approvals");
  const token = resolve(dir, `${ctx.graph.graphId}.${node.nodeId}.approved`);
  if (existsSync(token)) {
    return {
      status: "succeeded",
      summary: `approval token present: ${token}`,
      payload: { mode: "token_file", token },
    };
  }
  return {
    status: "skipped",
    summary: `awaiting approval — touch ${token} or re-run with --auto-approve`,
    payload: { mode: "awaiting", expectedToken: token },
  };
}

async function invokeAdapter(
  _node: WorkNode,
  payload: Record<string, unknown>,
): Promise<DispatchResult> {
  const adapterId = String(payload.adapterId);
  const command = String(payload.command);
  const mode = typeof payload.mode === "string" ? payload.mode : "read";
  const args = isRecord(payload.arguments)
    ? payload.arguments
    : ({} as Record<string, unknown>);

  const adapter = await resolveAdapter(adapterId);
  const invocation = {
    invocationId: newInvocationId(),
    adapterId,
    command,
    mode,
    arguments: args,
  } as Parameters<typeof adapter.invoke>[0];

  const result = await adapter.invoke(invocation);
  const succeeded = result.status === "success" || result.status === "partial";
  return {
    status: succeeded ? "succeeded" : "failed",
    summary: `${adapterId}:${command} -> ${result.status}`,
    payload: {
      invocationId: invocation.invocationId,
      adapterId,
      command,
      mode,
      status: result.status,
      resultSummary: result.summary,
    },
    artifactRefs: (result.artifacts ?? []).map((a) => a.ref),
  };
}

function runNativeCli(
  payload: Record<string, unknown>,
): Promise<DispatchResult> {
  const command = String(payload.command);
  const args = Array.isArray(payload.args)
    ? (payload.args as unknown[]).map((a) => String(a))
    : [];
  const stdinText =
    typeof payload.stdin === "string" ? payload.stdin : undefined;
  const cwd = typeof payload.cwd === "string" ? payload.cwd : process.cwd();
  const timeoutMs =
    typeof payload.timeoutMs === "number" ? payload.timeoutMs : 60_000;
  const envOverrides = isStringRecord(payload.env) ? payload.env : {};

  // Async spawn so sibling nodes in the same wave actually run in parallel.
  // spawnSync blocks the event loop and silently serialises Promise.all waves.
  return new Promise<DispatchResult>((resolve) => {
    const proc = spawn(command, args, {
      cwd,
      env: { ...process.env, ...envOverrides },
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    let timedOut = false;
    let killTimer: NodeJS.Timeout | null = null;
    let hardKillTimer: NodeJS.Timeout | null = null;
    if (timeoutMs > 0) {
      killTimer = setTimeout(() => {
        timedOut = true;
        try {
          proc.kill("SIGTERM");
        } catch {
          // Best effort.
        }
        hardKillTimer = setTimeout(() => {
          try {
            proc.kill("SIGKILL");
          } catch {
            // Best effort.
          }
        }, 5_000);
        hardKillTimer.unref?.();
      }, timeoutMs);
      killTimer.unref?.();
    }
    const clearTimers = () => {
      if (killTimer) clearTimeout(killTimer);
      if (hardKillTimer) clearTimeout(hardKillTimer);
    };
    const finish = (result: DispatchResult) => {
      if (!settled) {
        clearTimers();
        settled = true;
        resolve(result);
      }
    };
    proc.stdout?.on("data", (chunk: Buffer | string) => {
      stdout += typeof chunk === "string" ? chunk : chunk.toString("utf8");
    });
    proc.stderr?.on("data", (chunk: Buffer | string) => {
      stderr += typeof chunk === "string" ? chunk : chunk.toString("utf8");
    });
    proc.on("error", (err) => {
      finish({
        status: "failed",
        summary: `cli spawn failed: ${err.message}`,
        payload: { command, args, error: err.message, timedOut },
      });
    });
    proc.on("close", (code, signal) => {
      const exitCode = code ?? -1;
      const ok = !timedOut && exitCode === 0;
      finish({
        status: ok ? "succeeded" : "failed",
        summary: timedOut
          ? `${command} ${args.join(" ")} -> timeout after ${timeoutMs}ms`
          : `${command} ${args.join(" ")} -> exit ${exitCode}${signal ? ` (signal ${signal})` : ""}`,
        payload: {
          command,
          args,
          exitCode: code ?? null,
          signal: signal ?? null,
          timedOut,
          stdout: truncate(stdout, 4000),
          stderr: truncate(stderr, 2000),
        },
      });
    });
    if (proc.stdin) {
      if (stdinText !== undefined) {
        proc.stdin.write(stdinText);
      }
      proc.stdin.end();
    }
  });
}

function truncate(s: string, n: number): string {
  return s.length > n ? s.slice(0, n) + `...(+${s.length - n} chars)` : s;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function isStringRecord(v: unknown): v is Record<string, string> {
  if (!isRecord(v)) return false;
  return Object.values(v).every((value) => typeof value === "string");
}
