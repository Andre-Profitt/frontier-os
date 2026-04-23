import {
  buildActionEnvelope,
  evaluatePolicyAction,
  parseApprovalClass,
  type ApprovalClass,
} from "../policy/evaluator.ts";

export interface RouteExplanation {
  verb: string;
  projectId: string | null;
  traceId: string;
  lane: "frontierd" | "mcp" | "helper" | "local-cli" | "blocked";
  fallbackLane: "local-cli" | "none";
  policy: ReturnType<typeof evaluatePolicyAction>;
  reason: string;
}

export function explainRoute(input: {
  verb: string;
  projectId?: string | null;
  approvalClass?: ApprovalClass | null;
  traceId?: string;
}): RouteExplanation {
  const action = buildActionEnvelope({
    actor: "router",
    source: "route",
    projectId: input.projectId ?? null,
    verb: input.verb,
    arguments: {},
    approvalClass: input.approvalClass ?? null,
    ...(input.traceId !== undefined ? { traceId: input.traceId } : {}),
  });
  const policy = evaluatePolicyAction(action);
  if (policy.decision.status === "deny") {
    return {
      verb: input.verb,
      projectId: input.projectId ?? null,
      traceId: action.traceId,
      lane: "blocked",
      fallbackLane: "none",
      policy,
      reason: policy.decision.reason,
    };
  }
  if (input.verb.startsWith("mcp.") || input.verb.startsWith("frontier.")) {
    return route("mcp", "local-cli", action, policy, "agent tool boundary");
  }
  if (
    input.verb.startsWith("helper.") ||
    input.verb.startsWith("launchd.") ||
    input.verb.startsWith("service.") ||
    input.verb.startsWith("logs.") ||
    input.verb.startsWith("network.") ||
    input.verb.startsWith("port.") ||
    input.verb.startsWith("fs.")
  ) {
    return route("helper", "none", action, policy, "helper allowlist boundary");
  }
  if (
    input.verb.startsWith("project.") ||
    input.verb.startsWith("ops.") ||
    input.verb.startsWith("overnight.") ||
    input.verb.startsWith("daemon.") ||
    input.verb.startsWith("ledger.") ||
    input.verb.startsWith("watcher.") ||
    input.verb.startsWith("ghost.")
  ) {
    return route("frontierd", "local-cli", action, policy, "resident daemon read path");
  }
  return route("local-cli", "none", action, policy, "default local CLI lane");
}

export function parseRouteApprovalClass(value: unknown): ApprovalClass | null {
  return parseApprovalClass(value);
}

function route(
  lane: RouteExplanation["lane"],
  fallbackLane: RouteExplanation["fallbackLane"],
  action: ReturnType<typeof buildActionEnvelope>,
  policy: ReturnType<typeof evaluatePolicyAction>,
  reason: string,
): RouteExplanation {
  return {
    verb: action.verb,
    projectId: action.projectId,
    traceId: action.traceId,
    lane,
    fallbackLane,
    policy,
    reason,
  };
}
