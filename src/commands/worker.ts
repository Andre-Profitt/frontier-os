import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  CommandStore,
  type CommandActivity,
  type CommandPlan,
  type CommandRecord,
  type CommandStoreStatus,
} from "./store.ts";
import {
  applyCommandExecutionPolicyToGraph,
  commandExecutionPolicy,
} from "./execution.ts";
import type { RunResult } from "../work/executor.ts";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const REPO_ROOT = resolve(__dirname, "..", "..");
const FRONTIER_BIN = resolve(REPO_ROOT, "bin", "frontier");

export interface CommandWorkerRunOptions {
  workerId?: string;
  leaseMs?: number;
  commandId?: string;
  frontierBin?: string;
  maxApprovalClass?: 0 | 1 | 2 | 3;
}

export interface CommandWorkerLoopOptions extends CommandWorkerRunOptions {
  intervalMs?: number;
  maxRuntimeMs?: number;
  idleExitMs?: number;
  maxCommands?: number;
  continueOnFailure?: boolean;
}

export interface CommandWorkerRunResult {
  status: "idle" | "completed" | "failed";
  workerId: string;
  claimedCommandId: string | null;
  command: CommandRecord | null;
  activity: CommandActivity | null;
  execution: "none" | "process" | "work_graph";
  process: CommandProcessOutput | null;
  graph: CommandGraphOutput | null;
  error: string | null;
}

export interface CommandWorkerLoopResult {
  status: "completed" | "failed" | "idle_timeout" | "runtime_exceeded";
  workerId: string;
  startedAt: string;
  endedAt: string;
  iterations: number;
  completed: number;
  failed: number;
  idle: number;
  recentResults: CommandWorkerRunResult[];
  finalStatus: CommandStoreStatus;
}

export interface CommandProcessOutput {
  argv: string[];
  cwd: string;
  exitCode: number | null;
  signal: string | null;
  timedOut: boolean;
  stdoutTail: string;
  stderrTail: string;
  parsedStdout: unknown;
}

export interface CommandGraphOutput {
  path: string;
  graphId: string;
  sessionId: string;
  status: RunResult["status"];
  nodeCount: number;
  succeeded: number;
  failed: number;
  skipped: number;
  awaitingApproval: number;
  peakConcurrency: number;
}

interface CommandExecutionResult {
  kind: "process" | "work_graph";
  ok: boolean;
  summary: string;
  output: Record<string, unknown>;
  process: CommandProcessOutput | null;
  graph: CommandGraphOutput | null;
  error: string | null;
}

export function commandWorkerStatus(): CommandStoreStatus {
  const store = new CommandStore();
  try {
    return store.status();
  } finally {
    store.close();
  }
}

export async function runCommandWorkerLoop(
  options: CommandWorkerLoopOptions = {},
): Promise<CommandWorkerLoopResult> {
  const workerId = options.workerId ?? `worker-loop-${process.pid}`;
  const startedAt = new Date();
  const maxRuntimeMs = options.maxRuntimeMs ?? 8 * 60 * 60 * 1000;
  const intervalMs = options.intervalMs ?? 5_000;
  const maxCommands = options.maxCommands ?? Number.POSITIVE_INFINITY;
  const recentResults: CommandWorkerRunResult[] = [];
  let iterations = 0;
  let completed = 0;
  let failed = 0;
  let idle = 0;
  let lastWorkAt = startedAt.getTime();
  let status: CommandWorkerLoopResult["status"] = "completed";

  while (Date.now() - startedAt.getTime() < maxRuntimeMs) {
    if (completed + failed >= maxCommands) {
      status = "completed";
      break;
    }
    iterations++;
    const result = await runCommandWorkerOnce({ ...options, workerId });
    recentResults.push(result);
    if (recentResults.length > 50) recentResults.shift();

    if (result.status === "idle") {
      idle++;
      const idleForMs = Date.now() - lastWorkAt;
      if (options.idleExitMs !== undefined && idleForMs >= options.idleExitMs) {
        status = "idle_timeout";
        break;
      }
      await sleep(intervalMs);
      continue;
    }

    lastWorkAt = Date.now();
    if (result.status === "completed") completed++;
    if (result.status === "failed") {
      failed++;
      if (options.continueOnFailure !== true) {
        status = "failed";
        break;
      }
    }
  }

  if (Date.now() - startedAt.getTime() >= maxRuntimeMs) {
    status = failed > 0 ? "failed" : "runtime_exceeded";
  }

  return {
    status,
    workerId,
    startedAt: startedAt.toISOString(),
    endedAt: new Date().toISOString(),
    iterations,
    completed,
    failed,
    idle,
    recentResults,
    finalStatus: commandWorkerStatus(),
  };
}

export async function runCommandWorkerOnce(
  options: CommandWorkerRunOptions = {},
): Promise<CommandWorkerRunResult> {
  const workerId = options.workerId ?? `worker-${process.pid}`;
  const leaseMs = options.leaseMs ?? 5 * 60_000;
  const store = new CommandStore();
  let heartbeat: NodeJS.Timeout | null = null;
  try {
    const claimed = store.claimNext({
      workerId,
      leaseMs,
      ...(options.commandId ? { commandId: options.commandId } : {}),
      ...(options.maxApprovalClass !== undefined
        ? { maxApprovalClass: options.maxApprovalClass }
        : {}),
    });
    if (!claimed) {
      return {
        status: "idle",
        workerId,
        claimedCommandId: null,
        command: null,
        activity: null,
        execution: "none",
        process: null,
        graph: null,
        error: null,
      };
    }

    const activity = firstRunnableActivity(claimed);
    if (!activity) {
      const error = "claimed command has no runnable activity";
      const failed = store.finishCommand({
        commandId: claimed.commandId,
        status: "failed",
        result: { summary: error },
        error,
      });
      return {
        status: "failed",
        workerId,
        claimedCommandId: claimed.commandId,
        command: failed,
        activity: null,
        execution: "none",
        process: null,
        graph: null,
        error,
      };
    }

    heartbeat = startLeaseHeartbeat(store, {
      commandId: claimed.commandId,
      workerId,
      leaseMs,
    });
    const executed = await executeCommandPlan(claimed, options.frontierBin);
    stopLeaseHeartbeat(heartbeat);
    heartbeat = null;
    const finishedActivity = store.finishActivity({
      activityId: activity.activityId,
      status: executed.ok ? "completed" : "failed",
      output: executed.output,
    });
    const final = store.finishCommand({
      commandId: claimed.commandId,
      status: executed.ok ? "completed" : "failed",
      result: {
        summary: executed.summary,
        activityId: finishedActivity.activityId,
        output: executed.output,
      },
      error: executed.error,
    });
    return {
      status: executed.ok ? "completed" : "failed",
      workerId,
      claimedCommandId: claimed.commandId,
      command: final,
      activity: finishedActivity,
      execution: executed.kind,
      process: executed.process,
      graph: executed.graph,
      error: executed.ok ? null : final.error,
    };
  } finally {
    stopLeaseHeartbeat(heartbeat);
    store.close();
  }
}

function startLeaseHeartbeat(
  store: CommandStore,
  input: {
    commandId: string;
    workerId: string;
    leaseMs: number;
  },
): NodeJS.Timeout {
  const intervalMs = Math.max(5_000, Math.min(60_000, Math.floor(input.leaseMs / 3)));
  const timer = setInterval(() => {
    try {
      store.extendLease(input);
    } catch {
      // Best effort. The final finish call is still authoritative.
    }
  }, intervalMs);
  timer.unref?.();
  return timer;
}

function stopLeaseHeartbeat(timer: NodeJS.Timeout | null): void {
  if (timer) clearInterval(timer);
}

function firstRunnableActivity(command: CommandRecord): CommandActivity | null {
  return command.activities.find((activity) => activity.status === "running") ?? null;
}

async function executeCommandPlan(
  command: CommandRecord,
  frontierBin = FRONTIER_BIN,
): Promise<CommandExecutionResult> {
  const graphPath = command.plan?.workGraphPath;
  if (graphPath && existsSync(graphPath)) {
    return executeWorkGraph(command, graphPath);
  }
  const process = await executeDirectAction(command, frontierBin);
  const ok = process.exitCode === 0;
  return {
    kind: "process",
    ok,
    summary: ok
      ? `${command.verb ?? "command"} completed`
      : `${command.verb ?? "command"} failed`,
    output: { kind: "process", ...process },
    process,
    graph: null,
    error: ok ? null : process.stderrTail || `exit ${process.exitCode}`,
  };
}

async function executeWorkGraph(
  command: CommandRecord,
  path: string,
): Promise<CommandExecutionResult> {
  try {
    const { loadGraph } = await import("../work/graph.ts");
    const { runGraph } = await import("../work/executor.ts");
    const policy = commandExecutionPolicy(command);
    const graph = applyCommandExecutionPolicyToGraph(loadGraph(path), policy);
    const result = await runGraph(graph, {
      autoApprove: (command.approvalClass ?? 0) >= 2,
      sessionIdOverride: `command-worker-${command.commandId}`,
      maxRetries: Math.max(0, policy.maxAttempts - 1),
      defaultBackoffMs: policy.backoffMs,
    });
    const graphOutput: CommandGraphOutput = {
      path,
      graphId: result.graphId,
      sessionId: result.sessionId,
      status: result.status,
      nodeCount: result.nodeCount,
      succeeded: result.succeeded,
      failed: result.failed,
      skipped: result.skipped,
      awaitingApproval: result.awaitingApproval,
      peakConcurrency: result.peakConcurrency,
    };
    const ok = result.status === "completed";
    return {
      kind: "work_graph",
      ok,
      summary: ok
        ? `${command.verb ?? "command"} completed via work graph`
        : `${command.verb ?? "command"} work graph ${result.status}`,
      output: {
        kind: "work_graph",
        ...graphOutput,
        nodeResults: result.nodeResults,
      },
      process: null,
      graph: graphOutput,
      error: ok ? null : `work graph ${result.status}`,
    };
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    return {
      kind: "work_graph",
      ok: false,
      summary: `${command.verb ?? "command"} work graph failed`,
      output: {
        kind: "work_graph",
        path,
        error: message,
      },
      process: null,
      graph: null,
      error: message,
    };
  }
}

async function executeDirectAction(
  command: CommandRecord,
  frontierBin = FRONTIER_BIN,
): Promise<CommandProcessOutput> {
  const action = command.plan?.action;
  const policy = commandExecutionPolicy(command);
  if (!isDirectAction(command.plan) || !action) {
    return {
      argv: [],
      cwd: REPO_ROOT,
      exitCode: 2,
      signal: null,
      timedOut: false,
      stdoutTail: "",
      stderrTail: `unsupported command plan type: ${command.plan?.type ?? "none"}`,
      parsedStdout: null,
    };
  }
  const argv = [
    frontierBin,
    action.family,
    action.subcommand,
    ...action.args,
    "--json",
    "--local",
  ];
  return runProcess(argv, REPO_ROOT, policy.maxRuntimeMs);
}

function isDirectAction(plan: CommandPlan | null): boolean {
  return plan?.type === "direct_action" && plan.action !== null;
}

function runProcess(
  argv: string[],
  cwd: string,
  timeoutMs: number,
): Promise<CommandProcessOutput> {
  return new Promise((resolveProcess) => {
    const [command, ...args] = argv;
    if (!command) {
      resolveProcess({
        argv,
        cwd,
        exitCode: 2,
        signal: null,
        timedOut: false,
        stdoutTail: "",
        stderrTail: "empty argv",
        parsedStdout: null,
      });
      return;
    }
    const proc = spawn(command, args, {
      cwd,
      env: process.env,
    });
    let stdout = "";
    let stderr = "";
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
    proc.stdout?.on("data", (chunk: Buffer | string) => {
      stdout += typeof chunk === "string" ? chunk : chunk.toString("utf8");
    });
    proc.stderr?.on("data", (chunk: Buffer | string) => {
      stderr += typeof chunk === "string" ? chunk : chunk.toString("utf8");
    });
    proc.on("error", (error) => {
      clearTimers();
      resolveProcess({
        argv,
        cwd,
        exitCode: 127,
        signal: null,
        timedOut,
        stdoutTail: tail(stdout, 4000),
        stderrTail: tail(error.message, 4000),
        parsedStdout: null,
      });
    });
    proc.on("close", (exitCode, signal) => {
      clearTimers();
      resolveProcess({
        argv,
        cwd,
        exitCode,
        signal: signal ?? null,
        timedOut,
        stdoutTail: tail(stdout, 8000),
        stderrTail: tail(stderr, 4000),
        parsedStdout: parseMaybeJson(stdout),
      });
    });
  });
}

function parseMaybeJson(value: string): unknown {
  const trimmed = value.trim();
  if (!trimmed) return null;
  try {
    return JSON.parse(trimmed);
  } catch {
    return null;
  }
}

function tail(value: string, max: number): string {
  return value.length > max ? value.slice(-max) : value;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
}
