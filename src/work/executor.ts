// Orchestrate a work graph end-to-end.
//
// Phase 6 (MVP): sequential topo walk, per-node verifier check, approval gate.
// Phase 6.1: wave-based parallel execution with a concurrency cap + per-node
// retry loop driven by node.retryPolicy or the run-level --max-retries flag.
//
// Wave-based scheduling at each step:
//   1. Find all nodes whose dependencies are all completed → "ready set".
//   2. Dispatch up to `maxConcurrent` of them via Promise.all.
//   3. Mark any remaining ready nodes that didn't fit into a follow-up wave.
//   4. Independent branches keep progressing even when one branch fails —
//      only direct descendants of a failed node are marked skipped.
//
// Retry behavior is attached per node. A node whose dispatch.status === "failed"
// is re-dispatched up to `retryPolicy.maxAttempts` times with `backoffMs` delay.
// Retry events land in the ledger as `work.node_retry` so the trail is
// reconstructable. Approval nodes are never retried (auto-approve or token).

import { getLedger } from "../ledger/index.ts";
import { newSessionId } from "../ledger/events.ts";
import {
  effectiveApprovalClass,
  prepare,
  type PreparedGraph,
  type RetryPolicy,
  type WorkGraph,
  type WorkNode,
} from "./graph.ts";
import {
  dispatchNode,
  type DispatchContext,
  type DispatchResult,
} from "./dispatcher.ts";
import { runVerifier, type CheckResult } from "./verifier.ts";

export interface RunOptions {
  autoApprove?: boolean;
  sessionIdOverride?: string;
  dryRun?: boolean;
  /** Max parallel nodes within a single wave. Default 4. */
  maxConcurrent?: number;
  /** Fallback retry count for nodes without an explicit retryPolicy. Default 0 (no retry). */
  maxRetries?: number;
  /** Millisecond backoff between retries when the node lacks its own backoffMs. Default 500. */
  defaultBackoffMs?: number;
}

export interface RunResult {
  graphId: string;
  sessionId: string;
  status: "completed" | "failed" | "awaiting_approval";
  nodeCount: number;
  succeeded: number;
  failed: number;
  skipped: number;
  awaitingApproval: number;
  startedAt: string;
  endedAt: string;
  nodeResults: NodeRunRecord[];
  /** Observed peak number of concurrent dispatches during the run. */
  peakConcurrency: number;
}

export interface NodeRunRecord {
  nodeId: string;
  kind: string;
  approvalClassEffective: number;
  dispatch: DispatchResult | null;
  verifier: {
    required: boolean;
    passed: boolean;
    reason: string;
    checks?: CheckResult[];
  };
  status: "completed" | "failed" | "skipped" | "awaiting_approval";
  attempts: number;
  startedAt: string;
  endedAt: string;
}

const DEFAULT_MAX_CONCURRENT = 4;
const DEFAULT_BACKOFF_MS = 500;

/** Run a work graph end-to-end. */
export async function runGraph(
  graph: WorkGraph,
  options: RunOptions = {},
): Promise<RunResult> {
  const prepared = prepare(graph);
  const startedAt = nowIso();
  const sessionId =
    options.sessionIdOverride ?? newSessionId(`workgraph-${graph.graphId}`);
  const maxConcurrent = Math.max(
    1,
    options.maxConcurrent ?? DEFAULT_MAX_CONCURRENT,
  );

  const ledger = getLedger();
  ledger.ensureSession({
    sessionId,
    label: `workgraph:${graph.graphId}`,
    tags: ["workgraph", graph.graphId, ...(graph.labels ?? [])],
  });
  ledger.appendEvent({
    sessionId,
    kind: "work.graph_start",
    actor: "work.executor",
    payload: {
      graphId: graph.graphId,
      goal: graph.goal,
      nodeCount: graph.nodes.length,
      topoOrder: prepared.order,
      autoApprove: Boolean(options.autoApprove),
      dryRun: Boolean(options.dryRun),
      maxConcurrent,
      maxRetries: options.maxRetries ?? 0,
    },
  });

  const nodeStatus = new Map<string, NodeRunRecord["status"]>();
  const resultsById = new Map<string, NodeRunRecord>();
  let peakConcurrency = 0;

  while (resultsById.size < prepared.graph.nodes.length) {
    const ready = prepared.graph.nodes.filter((n) => {
      if (resultsById.has(n.nodeId)) return false;
      return n.dependencies.every((d) => resultsById.has(d));
    });

    if (ready.length === 0) {
      // Remaining nodes have unmet dependencies (some dep failed/skipped) —
      // mark them all as skipped and exit the wave loop.
      for (const n of prepared.graph.nodes) {
        if (resultsById.has(n.nodeId)) continue;
        resultsById.set(n.nodeId, markUpstreamSkip(n, sessionId));
        nodeStatus.set(n.nodeId, "skipped");
      }
      break;
    }

    // Execute the ready set in concurrency-capped waves.
    for (let i = 0; i < ready.length; i += maxConcurrent) {
      const batch = ready.slice(i, i + maxConcurrent);
      peakConcurrency = Math.max(peakConcurrency, batch.length);
      const records = await Promise.all(
        batch.map((n) => runOne(prepared, n, sessionId, options, nodeStatus)),
      );
      for (const r of records) {
        resultsById.set(r.nodeId, r);
        nodeStatus.set(r.nodeId, r.status);
      }
    }
  }

  // Preserve topological ordering in the output regardless of run concurrency.
  const nodeResults = prepared.order
    .map((id) => resultsById.get(id))
    .filter((r): r is NodeRunRecord => r !== undefined);

  const counts = tally(nodeResults);
  const status: RunResult["status"] =
    counts.failed > 0
      ? "failed"
      : counts.awaitingApproval > 0
        ? "awaiting_approval"
        : "completed";
  const endedAt = nowIso();

  ledger.appendEvent({
    sessionId,
    kind: "work.graph_end",
    actor: "work.executor",
    payload: {
      graphId: graph.graphId,
      status,
      nodeCount: graph.nodes.length,
      succeeded: counts.succeeded,
      failed: counts.failed,
      skipped: counts.skipped,
      awaitingApproval: counts.awaitingApproval,
      peakConcurrency,
    },
  });
  // Intentionally do NOT closeLedger() here — callers that run multiple
  // graphs in sequence (e.g. Ghost Shift) rely on the ledger staying open.
  // The CLI entrypoint handles the final close.

  return {
    graphId: graph.graphId,
    sessionId,
    status,
    nodeCount: graph.nodes.length,
    succeeded: counts.succeeded,
    failed: counts.failed,
    skipped: counts.skipped,
    awaitingApproval: counts.awaitingApproval,
    startedAt,
    endedAt,
    nodeResults,
    peakConcurrency,
  };
}

async function runOne(
  prepared: PreparedGraph,
  node: WorkNode,
  sessionId: string,
  options: RunOptions,
  nodeStatus: Map<string, NodeRunRecord["status"]>,
): Promise<NodeRunRecord> {
  const startedAt = nowIso();
  const ledger = getLedger();
  const approvalClassEffective = effectiveApprovalClass(prepared.graph, node);

  // Check dependency completion; any non-completed dep → skip.
  const blockingDep = node.dependencies.find(
    (d) => nodeStatus.get(d) !== "completed",
  );
  if (blockingDep) {
    ledger.appendEvent({
      sessionId,
      kind: "work.node_skipped",
      actor: "work.executor",
      payload: {
        nodeId: node.nodeId,
        reason: "dependency_incomplete",
        blockingDep,
      },
    });
    return {
      nodeId: node.nodeId,
      kind: node.kind,
      approvalClassEffective,
      dispatch: null,
      verifier: { required: false, passed: false, reason: "not run" },
      status: "skipped",
      attempts: 0,
      startedAt,
      endedAt: nowIso(),
    };
  }

  ledger.appendEvent({
    sessionId,
    kind: "work.node_start",
    actor: "work.executor",
    payload: {
      nodeId: node.nodeId,
      kind: node.kind,
      title: node.title,
      runtime: node.runtime,
      approvalClassEffective,
      sideEffects: node.sideEffects ?? [],
    },
  });

  if (
    approvalClassEffective >= 2 &&
    node.kind !== "approval" &&
    !options.autoApprove
  ) {
    ledger.appendEvent({
      sessionId,
      kind: "work.awaiting_approval",
      actor: "work.executor",
      payload: {
        nodeId: node.nodeId,
        approvalClassEffective,
        note: "class>=2 requires --auto-approve or a preceding approval node",
      },
    });
    return {
      nodeId: node.nodeId,
      kind: node.kind,
      approvalClassEffective,
      dispatch: null,
      verifier: { required: false, passed: false, reason: "gated" },
      status: "awaiting_approval",
      attempts: 0,
      startedAt,
      endedAt: nowIso(),
    };
  }

  if (options.dryRun) {
    ledger.appendEvent({
      sessionId,
      kind: "work.node_end",
      actor: "work.executor",
      payload: { nodeId: node.nodeId, status: "completed", dryRun: true },
    });
    return {
      nodeId: node.nodeId,
      kind: node.kind,
      approvalClassEffective,
      dispatch: {
        status: "succeeded",
        summary: "dry-run: no dispatch",
        payload: {},
      },
      verifier: { required: false, passed: true, reason: "dry run" },
      status: "completed",
      attempts: 0,
      startedAt,
      endedAt: nowIso(),
    };
  }

  const ctx: DispatchContext = {
    graph: prepared.graph,
    sessionId,
    autoApprove: Boolean(options.autoApprove),
  };

  const retryPolicy = resolveRetryPolicy(node, options);
  const dispatch = await dispatchWithRetry(node, ctx, sessionId, retryPolicy);

  const verifier = await runVerifier(node, dispatch.result, {
    graph: prepared.graph,
    autoApprove: Boolean(options.autoApprove),
  });
  const recordStatus: NodeRunRecord["status"] = decideNodeStatus(
    dispatch.result,
    verifier,
  );

  if (verifier.required) {
    // Emit one work.verifier_check event per individual check for queryable
    // granularity, then the summary pass/fail event.
    for (const check of verifier.checks) {
      ledger.appendEvent({
        sessionId,
        kind: "work.verifier_check",
        actor: "work.executor",
        payload: {
          nodeId: node.nodeId,
          check: check.name,
          passed: check.passed,
          reason: check.reason,
          evidence: check.evidence ?? {},
        },
      });
    }
    ledger.appendEvent({
      sessionId,
      kind: verifier.passed ? "work.verifier_pass" : "work.verifier_fail",
      actor: "work.executor",
      payload: {
        nodeId: node.nodeId,
        checks: node.verifierPolicy.checks ?? [],
        reason: verifier.reason,
        checkCount: verifier.checks.length,
        passedCount: verifier.checks.filter((c) => c.passed).length,
      },
    });
  }

  if (recordStatus === "failed") {
    ledger.appendEvent({
      sessionId,
      kind: "work.node_failed",
      actor: "work.executor",
      payload: {
        nodeId: node.nodeId,
        attempts: dispatch.attempts,
        dispatchStatus: dispatch.result.status,
        summary: dispatch.result.summary,
        payload: dispatch.result.payload,
      },
    });
  } else if (recordStatus === "skipped") {
    ledger.appendEvent({
      sessionId,
      kind: "work.node_skipped",
      actor: "work.executor",
      payload: {
        nodeId: node.nodeId,
        attempts: dispatch.attempts,
        reason: dispatch.result.summary,
        dispatchStatus: dispatch.result.status,
      },
    });
  } else {
    ledger.appendEvent({
      sessionId,
      kind: "work.node_end",
      actor: "work.executor",
      payload: {
        nodeId: node.nodeId,
        attempts: dispatch.attempts,
        status: recordStatus,
        dispatchStatus: dispatch.result.status,
        summary: dispatch.result.summary,
        artifactRefs: dispatch.result.artifactRefs ?? [],
      },
    });
  }

  return {
    nodeId: node.nodeId,
    kind: node.kind,
    approvalClassEffective,
    dispatch: dispatch.result,
    verifier,
    status: recordStatus,
    attempts: dispatch.attempts,
    startedAt,
    endedAt: nowIso(),
  };
}

function resolveRetryPolicy(node: WorkNode, options: RunOptions): RetryPolicy {
  if (node.retryPolicy) return node.retryPolicy;
  const fallbackAttempts = (options.maxRetries ?? 0) + 1;
  return {
    maxAttempts: Math.max(1, fallbackAttempts),
    ...(options.defaultBackoffMs !== undefined
      ? { backoffMs: options.defaultBackoffMs }
      : { backoffMs: DEFAULT_BACKOFF_MS }),
    retryOnFailed: true,
  };
}

async function dispatchWithRetry(
  node: WorkNode,
  ctx: DispatchContext,
  sessionId: string,
  policy: RetryPolicy,
): Promise<{ result: DispatchResult; attempts: number }> {
  // Approval nodes never retry — either the token file exists or it doesn't.
  const maxAttempts = node.kind === "approval" ? 1 : policy.maxAttempts;
  const retryOnFailed = policy.retryOnFailed !== false;
  const backoffMs = policy.backoffMs ?? DEFAULT_BACKOFF_MS;

  let attempt = 0;
  let last: DispatchResult | null = null;
  while (attempt < maxAttempts) {
    attempt++;
    last = await dispatchNode(node, ctx);
    if (last.status === "succeeded") break;
    if (last.status !== "failed") break; // skipped / not_implemented → don't retry
    if (!retryOnFailed) break;
    if (attempt >= maxAttempts) break;

    getLedger().appendEvent({
      sessionId,
      kind: "work.node_retry",
      actor: "work.executor",
      payload: {
        nodeId: node.nodeId,
        attempt,
        maxAttempts,
        backoffMs,
        lastSummary: last.summary,
      },
    });
    if (backoffMs > 0) {
      await sleep(backoffMs);
    }
  }
  return { result: last!, attempts: attempt };
}

function markUpstreamSkip(node: WorkNode, sessionId: string): NodeRunRecord {
  getLedger().appendEvent({
    sessionId,
    kind: "work.node_skipped",
    actor: "work.executor",
    payload: {
      nodeId: node.nodeId,
      reason: "upstream_dependency_failed_or_skipped",
      dependencies: node.dependencies,
    },
  });
  const now = nowIso();
  return {
    nodeId: node.nodeId,
    kind: node.kind,
    approvalClassEffective: node.approvalClass,
    dispatch: null,
    verifier: { required: false, passed: false, reason: "upstream failed" },
    status: "skipped",
    attempts: 0,
    startedAt: now,
    endedAt: now,
  };
}

function decideNodeStatus(
  dispatch: DispatchResult,
  verifier: { required: boolean; passed: boolean },
): NodeRunRecord["status"] {
  if (dispatch.status === "failed") return "failed";
  if (verifier.required && !verifier.passed) return "failed";
  if (dispatch.status === "skipped" || dispatch.status === "not_implemented") {
    return "skipped";
  }
  return "completed";
}

function tally(rows: NodeRunRecord[]) {
  let succeeded = 0;
  let failed = 0;
  let skipped = 0;
  let awaitingApproval = 0;
  for (const r of rows) {
    if (r.status === "completed") succeeded++;
    else if (r.status === "failed") failed++;
    else if (r.status === "awaiting_approval") awaitingApproval++;
    else if (r.status === "skipped") skipped++;
  }
  return { succeeded, failed, skipped, awaitingApproval };
}

function nowIso(): string {
  return new Date().toISOString();
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
