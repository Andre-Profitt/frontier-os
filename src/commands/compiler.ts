import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import type {
  CommandExplainResult,
  CommandPlan,
  CommandRoute,
} from "./store.ts";
import type {
  ApprovalClass as WorkApprovalClass,
  NodeKind,
  SideEffectClass,
  WorkGraph,
  WorkNode,
} from "../work/graph.ts";
import {
  budgetedTimeoutMs,
  buildCommandExecutionPolicy,
  verifierPolicyForCommand,
} from "./execution.ts";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const REPO_ROOT = resolve(__dirname, "..", "..");
const FRONTIER_BIN = resolve(REPO_ROOT, "bin", "frontier");
const MLXW_BIN = "/Users/test/.frontier/mlx/bin/mlxw";
const MLXW_PYTHON_BIN = "/usr/local/bin/python3";

export interface CommandGraphArtifact {
  path: string;
  graph: WorkGraph;
}

export function compileCommandGraphFromExplain(
  explained: CommandExplainResult,
): WorkGraph {
  const approvalClass = asWorkApprovalClass(explained.route.approvalClass);
  const needsApprovalNode = approvalClass >= 2;
  const nodes: WorkNode[] = [];
  if (needsApprovalNode) nodes.push(approvalNode(explained, approvalClass));
  nodes.push(actionNode(explained, needsApprovalNode));

  return {
    graphId: `wg_${explained.envelope.commandId}`,
    version: "v1",
    goal: explained.envelope.intent,
    tenantId: explained.envelope.actor.tenantId ?? "personal",
    createdAt: explained.envelope.requestedAt,
    updatedAt: new Date().toISOString(),
    priority: "normal",
    status: graphStatusFor(explained.status),
    approvalPolicy: {
      defaultClass: 0,
      requireHumanFor: [],
    },
    labels: uniq([
      "command",
      explained.envelope.commandId,
      explained.route.lane,
      explained.route.verb,
      explained.route.projectId ?? null,
    ]),
    entryIntent: {
      intentId: explained.envelope.commandId,
      intentType: "frontier.command",
      surfaceChannel: explained.envelope.surface.channel,
    },
    successCriteria: [
      `Command ${explained.envelope.commandId} reaches completed status.`,
    ],
    context: {
      commandId: explained.envelope.commandId,
      traceId: explained.envelope.traceId,
      intent: explained.envelope.intent,
      route: explained.route,
      policy: explained.policy,
      plan: {
        planId: explained.plan.planId,
        type: explained.plan.type,
        summary: explained.plan.summary,
        action: explained.plan.action,
      },
      interrupt: explained.interrupt,
      checkpoint: explained.checkpoint,
    },
    nodes,
  };
}

export function writeCommandGraphFromExplain(
  explained: CommandExplainResult,
): CommandGraphArtifact {
  const path =
    explained.plan.workGraphPath ??
    resolve(explained.plan.artifactDir, "graph.json");
  const graph = compileCommandGraphFromExplain(explained);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(graph, null, 2) + "\n");
  return { path, graph };
}

function approvalNode(
  explained: CommandExplainResult,
  approvalClass: WorkApprovalClass,
): WorkNode {
  return {
    nodeId: "approval",
    kind: "approval",
    title: `Approve ${explained.route.verb}`,
    description: explained.policy.decision.reason,
    status:
      explained.status === "blocked_approval" ? "awaiting_approval" : "queued",
    priority: "normal",
    runtime: {
      plane: "linux",
      executor: "native_cli",
    },
    approvalClass,
    dependencies: [],
    allowedTools: ["frontier.command.resume", "frontier.work"],
    verifierPolicy: { mode: "none" },
    sideEffects: ["none"],
    inputs: [
      {
        type: "structured_payload",
        value: {
          commandId: explained.envelope.commandId,
          traceId: explained.envelope.traceId,
          approvalClass,
          resume: explained.interrupt?.resume ?? null,
          policyDecision: explained.policy.decision,
        },
      },
    ],
    traceId: explained.envelope.traceId,
  };
}

function actionNode(
  explained: CommandExplainResult,
  dependsOnApproval: boolean,
): WorkNode {
  const action = explained.plan.action;
  const executionPolicy = buildCommandExecutionPolicy({
    envelope: explained.envelope,
    route: explained.route,
    plan: explained.plan,
  });
  const sideEffects = workSideEffects(explained.route);
  const node: WorkNode = {
    nodeId: action ? "action" : "intent_review",
    kind: kindForPlan(explained.plan),
    title: action
      ? `${action.family} ${action.subcommand}`.trim()
      : `Review ${explained.route.verb}`,
    description: explained.plan.summary,
    status: "queued",
    priority: "normal",
    runtime: {
      plane: "linux",
      executor: "native_cli",
    },
    // Class-2+ approval is represented by the explicit approval node above.
    // Keeping the action node at class 1 prevents the current work executor
    // from double-gating the same command after the dependency has passed.
    approvalClass: dependsOnApproval
      ? 1
      : asWorkApprovalClass(explained.route.approvalClass),
    dependencies: dependsOnApproval ? ["approval"] : [],
    allowedTools: ["frontier"],
    verifierPolicy: verifierForPlan(explained.plan, explained),
    inputs: [
      {
        type: "structured_payload",
        value: {
          cli: cliPayloadForPlan(explained),
          commandId: explained.envelope.commandId,
          traceId: explained.envelope.traceId,
        },
      },
    ],
    retryPolicy: {
      maxAttempts: executionPolicy.maxAttempts,
      backoffMs: executionPolicy.backoffMs,
      retryOnFailed: executionPolicy.retryOnFailed,
    },
    traceId: explained.envelope.traceId,
  };
  if (sideEffects.length > 0) node.sideEffects = sideEffects;
  return node;
}

function cliPayloadForPlan(
  explained: CommandExplainResult,
): {
  command: string;
  args: string[];
  cwd: string;
  timeoutMs: number;
  env?: Record<string, string>;
} {
  const action = explained.plan.action;
  if (!action) {
    return {
      command: FRONTIER_BIN,
      args: [
        "command",
        "explain",
        "--intent",
        explained.envelope.intent,
        "--json",
        "--local",
      ],
      cwd: REPO_ROOT,
      timeoutMs: 60_000,
    };
  }
  if (action.family === "mlx") {
    const timeoutInput: Parameters<typeof budgetedTimeoutMs>[0] = {
      verb: explained.route.verb,
    };
    if (typeof explained.envelope.policy?.maxRuntimeSeconds === "number") {
      timeoutInput.maxRuntimeSeconds = explained.envelope.policy.maxRuntimeSeconds;
    }
    return {
      command: MLXW_PYTHON_BIN,
      args: [MLXW_BIN, action.subcommand, ...action.args],
      cwd: REPO_ROOT,
      timeoutMs: budgetedTimeoutMs(timeoutInput),
      env: launchdSafePythonEnv(),
    };
  }
  const timeoutInput: Parameters<typeof budgetedTimeoutMs>[0] = {
    verb: explained.route.verb,
  };
  if (typeof explained.envelope.policy?.maxRuntimeSeconds === "number") {
    timeoutInput.maxRuntimeSeconds = explained.envelope.policy.maxRuntimeSeconds;
  }
  return {
    command: FRONTIER_BIN,
    args: [
      action.family,
      action.subcommand,
      ...action.args,
      "--json",
      "--local",
    ],
    cwd: REPO_ROOT,
    timeoutMs: budgetedTimeoutMs(timeoutInput),
  };
}

function launchdSafePythonEnv(): Record<string, string> {
  return {
    FRONTIER_MLX_LAUNCHD_SAFE: "1",
    PYTHONPATH: "/Users/test/Library/Python/3.13/lib/python/site-packages",
    PYTHONNOUSERSITE: "1",
    PYTHONUNBUFFERED: "1",
  };
}

function verifierForPlan(
  plan: CommandPlan,
  explained: CommandExplainResult,
): WorkNode["verifierPolicy"] {
  return verifierPolicyForCommand(plan, explained.envelope);
}

function kindForPlan(plan: CommandPlan): NodeKind {
  if (!plan.action) return "review";
  if (plan.action.family === "project") {
    if (["verify", "smoke"].includes(plan.action.subcommand)) {
      return "test_run";
    }
    return "repo_analysis";
  }
  if (plan.action.family === "ops") return "mac_task";
  return "dispatch";
}

function workSideEffects(route: CommandRoute): SideEffectClass[] {
  const mapped = route.sideEffects
    .map((sideEffect): SideEffectClass | null => {
      if (sideEffect === "local_write") return "local_write";
      if (sideEffect === "local_service") return "local_write";
      if (sideEffect === "privileged_or_external") return "destructive_action";
      return null;
    })
    .filter((sideEffect): sideEffect is SideEffectClass => sideEffect !== null);
  return uniq(mapped);
}

function graphStatusFor(
  status: CommandExplainResult["status"],
): WorkGraph["status"] {
  if (status === "blocked_approval") return "awaiting_approval";
  if (status === "blocked_policy") return "blocked";
  if (status === "running") return "running";
  if (status === "completed") return "completed";
  if (status === "failed") return "failed";
  if (status === "canceled") return "canceled";
  return "planned";
}

function asWorkApprovalClass(value: number): WorkApprovalClass {
  if (value === 0 || value === 1 || value === 2 || value === 3) return value;
  return 1;
}

function uniq<T extends string>(values: Array<T | null | undefined>): T[] {
  return [...new Set(values.filter((v): v is T => Boolean(v)))];
}
