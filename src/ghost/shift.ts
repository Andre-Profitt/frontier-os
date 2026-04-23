// Ghost Shift — overnight safe-mode runner.
//
// Scans ~/.frontier/ghost-shift/queue/*.json, moves each graph through the
// work-graph executor with class ≤ 1 autonomy (no --auto-approve), and routes
// outputs to completed/ | failed/ | blocked/ | rejected/ based on run result
// and a pre-flight safety assessment.
//
// Design choices:
//   - One-shot by default: `frontier ghost run` processes the current queue
//     and exits. Scheduling is launchd's job, not ours.
//   - Idempotent per file: move-on-complete means if the process dies mid-run,
//     the next shift picks it up again (it's still in running/).
//   - Kill-switch: touch ~/.frontier/ghost-shift/.disabled and the next shift
//     exits immediately with a single ghost.shift_end event.
//   - Time budget: --max-runtime caps how long one shift may spend; we only
//     check between graphs, never interrupt mid-graph.

import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, resolve } from "node:path";

import { closeLedger, getLedger } from "../ledger/index.ts";
import { newSessionId } from "../ledger/events.ts";
import { loadGraph, type WorkGraph } from "../work/graph.ts";
import { runGraph, type RunResult } from "../work/executor.ts";
import { assessGraph, type Rejection } from "./safety.ts";

export interface ShiftOptions {
  queueDir?: string;
  /** Max total runtime budget for this shift, in seconds. Default 3600. */
  maxRuntimeSeconds?: number;
  /** Max parallel nodes within each graph. Default 4. */
  maxConcurrent?: number;
  /** Retries for flaky nodes without their own policy. Default 1. */
  maxRetries?: number;
  /** If true, validate + assess but don't run or move files. */
  dryRun?: boolean;
}

export interface ShiftSummary {
  shiftId: string;
  queueDir: string;
  startedAt: string;
  endedAt: string;
  processed: number;
  completed: number;
  failed: number;
  blocked: number;
  rejected: number;
  skippedTimeBudget: number;
  disabledSwitch: boolean;
  results: GraphRunRecord[];
}

export interface GraphRunRecord {
  file: string;
  graphId: string | null;
  lane: string | null;
  projectId: string | null;
  verb: string | null;
  status:
    | "completed"
    | "failed"
    | "blocked_awaiting_approval"
    | "rejected_unsafe"
    | "invalid";
  durationMs: number;
  rejections?: Rejection[];
  runResult?: Pick<
    RunResult,
    | "status"
    | "sessionId"
    | "succeeded"
    | "failed"
    | "skipped"
    | "awaitingApproval"
    | "peakConcurrency"
  >;
  error?: string;
}

const DEFAULT_QUEUE_DIR = resolve(homedir(), ".frontier", "ghost-shift");

export function defaultQueueDir(): string {
  return DEFAULT_QUEUE_DIR;
}

/** Convenience: enqueue a graph file into the queue/ subdir by COPY (source preserved). */
export function enqueue(graphPath: string, queueDir?: string): string {
  const root = ensureLayout(queueDir ?? DEFAULT_QUEUE_DIR);
  const src = resolve(graphPath);
  if (!existsSync(src)) {
    throw new Error(`graph file not found: ${src}`);
  }
  const ts = isoSlug();
  const dest = resolve(root.queue, `${ts}-${basename(src)}`);
  copyFileSync(src, dest);
  return dest;
}

/** Enumerate queue + state counts for `ghost status`. */
export function queueStatus(queueDir?: string): Record<string, number> {
  const root = ensureLayout(queueDir ?? DEFAULT_QUEUE_DIR);
  return {
    queue: countJson(root.queue),
    running: countJson(root.running),
    completed: countJson(root.completed),
    failed: countJson(root.failed),
    blocked: countJson(root.blocked),
    rejected: countJson(root.rejected),
  };
}

/** Process the queue once and return a summary. */
export async function runShift(
  options: ShiftOptions = {},
): Promise<ShiftSummary> {
  const root = ensureLayout(options.queueDir ?? DEFAULT_QUEUE_DIR);
  const maxRuntimeMs = (options.maxRuntimeSeconds ?? 3600) * 1000;
  const startedAt = nowIso();
  const startMs = Date.now();
  const shiftId = newSessionId("ghost-shift");

  const disabledPath = resolve(root.root, ".disabled");
  const disabled = existsSync(disabledPath);

  const ledger = getLedger();
  ledger.ensureSession({
    sessionId: shiftId,
    label: "ghost-shift",
    tags: ["ghost-shift", "overnight"],
  });
  ledger.appendEvent({
    sessionId: shiftId,
    kind: "ghost.shift_start",
    actor: "ghost.shift",
    payload: {
      queueDir: root.root,
      maxRuntimeSeconds: options.maxRuntimeSeconds ?? 3600,
      maxConcurrent: options.maxConcurrent ?? 4,
      maxRetries: options.maxRetries ?? 1,
      dryRun: Boolean(options.dryRun),
      disabled,
    },
  });

  const results: GraphRunRecord[] = [];
  let skippedTimeBudget = 0;

  if (!disabled) {
    const files = listJson(root.queue).sort(); // chronological-ish via the ts prefix
    for (const file of files) {
      const elapsed = Date.now() - startMs;
      if (elapsed >= maxRuntimeMs) {
        skippedTimeBudget = files.length - results.length;
        break;
      }
      const record = await processOne(file, root, shiftId, options);
      results.push(record);
    }
  }

  const counts = tallyResults(results);
  const endedAt = nowIso();

  ledger.appendEvent({
    sessionId: shiftId,
    kind: "ghost.shift_end",
    actor: "ghost.shift",
    payload: {
      processed: results.length,
      completed: counts.completed,
      failed: counts.failed,
      blocked: counts.blocked,
      rejected: counts.rejected,
      skippedTimeBudget,
      disabledSwitch: disabled,
      durationMs: Date.now() - startMs,
    },
  });
  closeLedger();

  return {
    shiftId,
    queueDir: root.root,
    startedAt,
    endedAt,
    processed: results.length,
    completed: counts.completed,
    failed: counts.failed,
    blocked: counts.blocked,
    rejected: counts.rejected,
    skippedTimeBudget,
    disabledSwitch: disabled,
    results,
  };
}

async function processOne(
  queueFile: string,
  root: QueueLayout,
  shiftId: string,
  options: ShiftOptions,
): Promise<GraphRunRecord> {
  const started = Date.now();
  const ledger = getLedger();

  // Load + validate. On schema failure, move to rejected/ with the ajv errors.
  let graph: WorkGraph;
  try {
    graph = loadGraph(queueFile);
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    const moved = options.dryRun
      ? queueFile
      : moveFile(queueFile, root.rejected);
    ledger.appendEvent({
      sessionId: shiftId,
      kind: "ghost.graph_rejected",
      actor: "ghost.shift",
      payload: {
        file: basename(queueFile),
        destination: basename(moved),
        reason: "schema_invalid",
        error: message,
      },
    });
    return {
      file: basename(queueFile),
      graphId: null,
      lane: null,
      projectId: null,
      verb: null,
      status: "invalid",
      durationMs: Date.now() - started,
      error: message,
    };
  }

  const meta = graphEventMeta(graph);

  // Safety assessment: refuse class > 1 or dangerous side effects.
  const verdict = assessGraph(graph);
  if (!verdict.safe) {
    const moved = options.dryRun
      ? queueFile
      : moveFile(queueFile, root.rejected);
    ledger.appendEvent({
      sessionId: shiftId,
      kind: "ghost.graph_rejected",
      actor: "ghost.shift",
      payload: {
        file: basename(queueFile),
        destination: basename(moved),
        graphId: graph.graphId,
        rejections: verdict.rejections,
        warnings: verdict.warnings,
        lane: meta.lane,
        projectId: meta.projectId,
        verb: meta.verb,
      },
    });
    return {
      file: basename(queueFile),
      graphId: graph.graphId,
      lane: meta.lane,
      projectId: meta.projectId,
      verb: meta.verb,
      status: "rejected_unsafe",
      durationMs: Date.now() - started,
      rejections: verdict.rejections,
    };
  }

  if (options.dryRun) {
    ledger.appendEvent({
      sessionId: shiftId,
      kind: "ghost.graph_started",
      actor: "ghost.shift",
      payload: {
        file: basename(queueFile),
        graphId: graph.graphId,
        dryRun: true,
        lane: meta.lane,
        projectId: meta.projectId,
        verb: meta.verb,
      },
    });
    return {
      file: basename(queueFile),
      graphId: graph.graphId,
      lane: meta.lane,
      projectId: meta.projectId,
      verb: meta.verb,
      status: "completed",
      durationMs: Date.now() - started,
    };
  }

  // Move into running/ before execution so concurrent shifts skip it.
  const runningPath = moveFile(queueFile, root.running);
  ledger.appendEvent({
    sessionId: shiftId,
    kind: "ghost.graph_started",
    actor: "ghost.shift",
    payload: {
      file: basename(runningPath),
      graphId: graph.graphId,
      goal: graph.goal,
      lane: meta.lane,
      projectId: meta.projectId,
      verb: meta.verb,
    },
  });

  let runResult: RunResult;
  try {
    runResult = await runGraph(graph, {
      ...(options.maxConcurrent !== undefined
        ? { maxConcurrent: options.maxConcurrent }
        : {}),
      ...(options.maxRetries !== undefined
        ? { maxRetries: options.maxRetries }
        : {}),
      // Never auto-approve in Ghost Shift — class ≥ 2 blocks by design.
      autoApprove: false,
    });
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    const moved = moveFile(runningPath, root.failed);
    ledger.appendEvent({
      sessionId: shiftId,
      kind: "ghost.graph_failed",
      actor: "ghost.shift",
      payload: {
        file: basename(moved),
        graphId: graph.graphId,
        error: message,
        lane: meta.lane,
        projectId: meta.projectId,
        verb: meta.verb,
      },
    });
    return {
      file: basename(queueFile),
      graphId: graph.graphId,
      lane: meta.lane,
      projectId: meta.projectId,
      verb: meta.verb,
      status: "failed",
      durationMs: Date.now() - started,
      error: message,
    };
  }

  // Route based on run result.
  const summary = writeRunSummary(graph, runResult, root.logs);
  let status: GraphRunRecord["status"];
  let destFile: string;
  if (runResult.status === "completed") {
    destFile = moveFile(runningPath, root.completed);
    status = "completed";
    ledger.appendEvent({
      sessionId: shiftId,
      kind: "ghost.graph_completed",
      actor: "ghost.shift",
      payload: {
        file: basename(destFile),
        graphId: graph.graphId,
        sessionId: runResult.sessionId,
        succeeded: runResult.succeeded,
        skipped: runResult.skipped,
        peakConcurrency: runResult.peakConcurrency,
        summaryPath: summary,
        lane: meta.lane,
        projectId: meta.projectId,
        verb: meta.verb,
      },
    });
  } else if (runResult.status === "awaiting_approval") {
    destFile = moveFile(runningPath, root.blocked);
    status = "blocked_awaiting_approval";
    ledger.appendEvent({
      sessionId: shiftId,
      kind: "ghost.graph_blocked",
      actor: "ghost.shift",
      payload: {
        file: basename(destFile),
        graphId: graph.graphId,
        sessionId: runResult.sessionId,
        awaitingApproval: runResult.awaitingApproval,
        summaryPath: summary,
        lane: meta.lane,
        projectId: meta.projectId,
        verb: meta.verb,
      },
    });
  } else {
    destFile = moveFile(runningPath, root.failed);
    status = "failed";
    ledger.appendEvent({
      sessionId: shiftId,
      kind: "ghost.graph_failed",
      actor: "ghost.shift",
      payload: {
        file: basename(destFile),
        graphId: graph.graphId,
        sessionId: runResult.sessionId,
        failed: runResult.failed,
        skipped: runResult.skipped,
        summaryPath: summary,
        lane: meta.lane,
        projectId: meta.projectId,
        verb: meta.verb,
      },
    });
  }

  return {
    file: basename(queueFile),
    graphId: graph.graphId,
    lane: meta.lane,
    projectId: meta.projectId,
    verb: meta.verb,
    status,
    durationMs: Date.now() - started,
    runResult: {
      status: runResult.status,
      sessionId: runResult.sessionId,
      succeeded: runResult.succeeded,
      failed: runResult.failed,
      skipped: runResult.skipped,
      awaitingApproval: runResult.awaitingApproval,
      peakConcurrency: runResult.peakConcurrency,
    },
  };
}

function graphEventMeta(graph: WorkGraph): {
  lane: string | null;
  projectId: string | null;
  verb: string | null;
} {
  const action =
    graph.context &&
    typeof graph.context === "object" &&
    !Array.isArray(graph.context) &&
    graph.context.action &&
    typeof graph.context.action === "object" &&
    !Array.isArray(graph.context.action)
      ? (graph.context.action as Record<string, unknown>)
      : null;
  const labels = Array.isArray(graph.labels) ? graph.labels : [];
  return {
    lane: stringFrom(action?.lane) ?? labelValue(labels, "lane"),
    projectId: stringFrom(action?.projectId) ?? labelValue(labels, "project"),
    verb: stringFrom(action?.verb) ?? labelValue(labels, "verb"),
  };
}

// ---- Filesystem helpers ----

interface QueueLayout {
  root: string;
  queue: string;
  running: string;
  completed: string;
  failed: string;
  blocked: string;
  rejected: string;
  logs: string;
}

function ensureLayout(rootDir: string): QueueLayout {
  const root = resolve(rootDir);
  const layout: QueueLayout = {
    root,
    queue: resolve(root, "queue"),
    running: resolve(root, "running"),
    completed: resolve(root, "completed"),
    failed: resolve(root, "failed"),
    blocked: resolve(root, "blocked"),
    rejected: resolve(root, "rejected"),
    logs: resolve(root, "logs"),
  };
  for (const p of Object.values(layout)) {
    mkdirSync(p, { recursive: true });
  }
  return layout;
}

function listJson(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith(".json") && !f.startsWith("."))
    .map((f) => resolve(dir, f));
}

function countJson(dir: string): number {
  return listJson(dir).length;
}

function moveFile(src: string, destDir: string): string {
  mkdirSync(destDir, { recursive: true });
  const dest = resolve(destDir, basename(src));
  try {
    renameSync(src, dest);
  } catch {
    // Fall back to copy+unlink-ish semantics when renameSync crosses filesystems.
    renameOrCopy(src, dest);
  }
  return dest;
}

function renameOrCopy(src: string, dest: string): void {
  try {
    renameSync(src, dest);
  } catch {
    copyFileSync(src, dest);
    try {
      unlinkSync(src);
    } catch {
      /* best effort */
    }
  }
}

function writeRunSummary(
  graph: WorkGraph,
  runResult: RunResult,
  logsDir: string,
): string {
  const path = resolve(logsDir, `${isoSlug()}-${graph.graphId}.json`);
  writeFileSync(
    path,
    JSON.stringify(
      { graph: { graphId: graph.graphId, goal: graph.goal }, runResult },
      null,
      2,
    ),
  );
  return path;
}

function tallyResults(rows: GraphRunRecord[]) {
  let completed = 0;
  let failed = 0;
  let blocked = 0;
  let rejected = 0;
  for (const r of rows) {
    if (r.status === "completed") completed++;
    else if (r.status === "failed") failed++;
    else if (r.status === "blocked_awaiting_approval") blocked++;
    else if (r.status === "rejected_unsafe" || r.status === "invalid")
      rejected++;
  }
  return { completed, failed, blocked, rejected };
}

function isoSlug(): string {
  return new Date()
    .toISOString()
    .replace(/[^0-9]/g, "")
    .slice(0, 14); // YYYYMMDDhhmmss
}

function nowIso(): string {
  return new Date().toISOString();
}

function stringFrom(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function labelValue(labels: string[], prefix: string): string | null {
  const match = labels.find((label) => label.startsWith(`${prefix}:`));
  if (!match) return null;
  const value = match.slice(prefix.length + 1);
  return value.length > 0 ? value : null;
}

function statIsFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

// Expose for tests and diagnostics.
export const __test__ = { ensureLayout, listJson, moveFile, statIsFile };
