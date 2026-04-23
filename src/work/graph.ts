// Load, validate, and topo-sort a work graph per schemas/work-graph.schema.json.
//
// The executor (src/work/executor.ts) consumes the `PreparedGraph` produced
// here. Keeping load/validation/topological analysis in one place means the
// executor can assume it's operating on a well-formed DAG.

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { validateWorkGraph } from "../schemas.ts";

export type ApprovalClass = 0 | 1 | 2 | 3;

export type NodeKind =
  | "research"
  | "repo_analysis"
  | "code_change"
  | "test_run"
  | "review"
  | "approval"
  | "browser_task"
  | "mac_task"
  | "incident_packet"
  | "document_generation"
  | "publish"
  | "dispatch";

export type NodeStatus =
  | "queued"
  | "running"
  | "blocked"
  | "awaiting_approval"
  | "completed"
  | "failed"
  | "skipped"
  | "canceled";

export type RuntimePlane = "linux" | "mac" | "browser" | "remote_api";

export type RuntimeExecutor =
  | "codex_app_server"
  | "codex_exec"
  | "claude_code"
  | "native_cli"
  | "mcp_tool"
  | "playwright"
  | "custom_worker";

export type VerifierMode = "none" | "required" | "required_before_side_effect";

export type SideEffectClass =
  // Unified superset (Phase 18c) — keep in sync with schemas.ts and the
  // 12-value enum in schemas/work-graph.schema.json.
  | "auth_change"
  | "billable_action"
  | "deploy"
  | "destructive_action"
  | "external_message"
  | "financial_action"
  | "local_write"
  | "none"
  | "pr_open"
  | "repo_write"
  | "shared_write"
  | "ticket_write";

export interface WorkNodeInput {
  type:
    | "text"
    | "url"
    | "repo_ref"
    | "ticket_ref"
    | "file_ref"
    | "artifact_ref"
    | "structured_payload";
  value: unknown;
}

export interface WorkNodeOutput {
  type: string;
  location: string;
  summary?: string;
}

export interface RetryPolicy {
  maxAttempts: number;
  backoffMs?: number;
  retryOnFailed?: boolean;
}

export interface WorkNode {
  nodeId: string;
  kind: NodeKind;
  title: string;
  description?: string;
  status: NodeStatus;
  priority: string;
  runtime: {
    plane: RuntimePlane;
    executor: RuntimeExecutor;
    model?: string;
    worktreeStrategy?: string;
  };
  approvalClass: ApprovalClass;
  dependencies: string[];
  allowedTools: string[];
  verifierPolicy: {
    mode: VerifierMode;
    checks?: string[];
    config?: Record<string, unknown>;
  };
  sideEffects?: SideEffectClass[];
  inputs: WorkNodeInput[];
  outputs?: WorkNodeOutput[];
  budgets?: Record<string, number>;
  retryPolicy?: RetryPolicy;
  owner?: string;
  traceId?: string;
}

export interface WorkGraph {
  graphId: string;
  version: string;
  goal: string;
  tenantId: string;
  createdAt: string;
  updatedAt?: string;
  priority: string;
  status: string;
  approvalPolicy: {
    defaultClass: ApprovalClass;
    requireHumanFor: string[];
  };
  budgets?: Record<string, number>;
  labels?: string[];
  entryIntent?: {
    intentId: string;
    intentType: string;
    surfaceChannel:
      | "cli"
      | "siri_shortcut"
      | "apple_app_intent"
      | "mobile_app"
      | "menu_bar"
      | "web"
      | "api"
      | "automation";
  };
  successCriteria?: string[];
  context?: Record<string, unknown>;
  nodes: WorkNode[];
}

export interface PreparedGraph {
  graph: WorkGraph;
  /** Node IDs in topological execution order. */
  order: string[];
  /** Fast lookup from nodeId to node. */
  byId: Map<string, WorkNode>;
}

export class WorkGraphError extends Error {
  constructor(
    message: string,
    public details?: unknown,
  ) {
    super(message);
    this.name = "WorkGraphError";
  }
}

/** Load a work graph JSON file from disk and return the validated document. */
export function loadGraph(path: string): WorkGraph {
  const absolute = resolve(path);
  const raw = JSON.parse(readFileSync(absolute, "utf8"));
  if (!validateWorkGraph(raw)) {
    throw new WorkGraphError("work graph failed schema validation", {
      path: absolute,
      errors: validateWorkGraph.errors,
    });
  }
  return raw as WorkGraph;
}

/** Prepare a loaded graph for execution: lookup map + topo-sorted order. */
export function prepare(graph: WorkGraph): PreparedGraph {
  const byId = new Map<string, WorkNode>();
  for (const node of graph.nodes) {
    if (byId.has(node.nodeId)) {
      throw new WorkGraphError(`duplicate nodeId: ${node.nodeId}`);
    }
    byId.set(node.nodeId, node);
  }
  for (const node of graph.nodes) {
    for (const dep of node.dependencies) {
      if (!byId.has(dep)) {
        throw new WorkGraphError(
          `node ${node.nodeId} depends on unknown node ${dep}`,
        );
      }
    }
  }
  return { graph, order: topologicalSort(graph.nodes), byId };
}

/** Kahn's algorithm. Throws WorkGraphError on cycle. */
export function topologicalSort(nodes: WorkNode[]): string[] {
  const indegree = new Map<string, number>();
  const adj = new Map<string, string[]>();
  for (const node of nodes) {
    indegree.set(node.nodeId, 0);
    adj.set(node.nodeId, []);
  }
  for (const node of nodes) {
    for (const dep of node.dependencies) {
      indegree.set(node.nodeId, (indegree.get(node.nodeId) ?? 0) + 1);
      adj.get(dep)?.push(node.nodeId);
    }
  }
  const queue: string[] = [];
  for (const [id, deg] of indegree) if (deg === 0) queue.push(id);
  queue.sort(); // stable order for deterministic runs
  const order: string[] = [];
  while (queue.length > 0) {
    const current = queue.shift()!;
    order.push(current);
    for (const next of adj.get(current) ?? []) {
      const newDegree = (indegree.get(next) ?? 0) - 1;
      indegree.set(next, newDegree);
      if (newDegree === 0) {
        // Insert in sorted position for deterministic run order.
        let i = 0;
        while (i < queue.length && queue[i]! < next) i++;
        queue.splice(i, 0, next);
      }
    }
  }
  if (order.length !== nodes.length) {
    throw new WorkGraphError(
      "work graph has a cycle; cannot produce topological order",
    );
  }
  return order;
}

/** Effective approval class for a node: max(graph default, node explicit). */
export function effectiveApprovalClass(
  graph: WorkGraph,
  node: WorkNode,
): ApprovalClass {
  const graphDefault = graph.approvalPolicy.defaultClass ?? 0;
  return Math.max(graphDefault, node.approvalClass) as ApprovalClass;
}
