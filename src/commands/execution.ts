import type { WorkGraph, WorkNode } from "../work/graph.ts";
import { adapterCommandSpec, findManifest } from "../registry.ts";
import type { CommandEnvelope } from "./envelope.ts";
import type { CommandPlan, CommandRecord, CommandRoute } from "./store.ts";

export interface CommandExecutionPolicy {
  maxAttempts: number;
  backoffMs: number;
  retryOnFailed: boolean;
  maxRuntimeMs: number;
  maxRuntimeSeconds: number;
  requireVerification: boolean;
  verifierMode: WorkNode["verifierPolicy"]["mode"];
  verifierChecks: string[];
  allowSideEffects: boolean | null;
  sideEffects: string[];
}

export type CommandFailureKind =
  | "none"
  | "active"
  | "awaiting_approval"
  | "policy_blocked"
  | "canceled"
  | "runtime_exceeded"
  | "retry_exhausted"
  | "verifier_failed"
  | "dispatch_failed";

export interface CommandFailureAnalysis {
  kind: CommandFailureKind;
  summary: string | null;
  nodeId: string | null;
  attempts: number | null;
  maxAttempts: number | null;
  timedOut: boolean;
  verifierRequired: boolean;
  verifierPassed: boolean | null;
}

export interface CommandExecutionAnalysis {
  policy: CommandExecutionPolicy;
  failure: CommandFailureAnalysis;
}

export function buildCommandExecutionPolicy(input: {
  envelope: CommandEnvelope;
  route: CommandRoute;
  plan: CommandPlan;
}): CommandExecutionPolicy {
  const retry = retryPolicyForCommand(input);
  const verifier = verifierPolicyForCommand(input.plan, input.envelope);
  const sideEffects = [...input.route.sideEffects];
  const timeoutInput: Parameters<typeof budgetedTimeoutMs>[0] = {
    verb: input.route.verb,
  };
  if (typeof input.envelope.policy?.maxRuntimeSeconds === "number") {
    timeoutInput.maxRuntimeSeconds = input.envelope.policy.maxRuntimeSeconds;
  }
  const maxRuntimeMs = budgetedTimeoutMs(timeoutInput);
  return {
    ...retry,
    maxRuntimeMs,
    maxRuntimeSeconds: Math.max(1, Math.ceil(maxRuntimeMs / 1000)),
    requireVerification: verificationRequired(verifier.mode, sideEffects),
    verifierMode: verifier.mode,
    verifierChecks: [...(verifier.checks ?? [])],
    allowSideEffects:
      input.envelope.policy?.allowSideEffects === true
        ? true
        : input.envelope.policy?.allowSideEffects === false
          ? false
          : null,
    sideEffects,
  };
}

export function commandExecutionPolicy(
  command: CommandRecord,
): CommandExecutionPolicy {
  const stored = asRecord(command.retryPolicy);
  const fallback = fallbackExecutionPolicy(command);
  const maxAttempts =
    positiveInteger(stored?.maxAttempts, fallback.maxAttempts) ??
    fallback.maxAttempts;
  const backoffMs = nonNegativeInteger(stored?.backoffMs, fallback.backoffMs);
  return {
    maxAttempts,
    backoffMs,
    retryOnFailed:
      typeof stored?.retryOnFailed === "boolean"
        ? stored.retryOnFailed
        : fallback.retryOnFailed,
    maxRuntimeMs: nonNegativeInteger(
      stored?.maxRuntimeMs,
      fallback.maxRuntimeMs,
    ),
    maxRuntimeSeconds:
      positiveInteger(stored?.maxRuntimeSeconds, fallback.maxRuntimeSeconds) ??
      fallback.maxRuntimeSeconds,
    requireVerification:
      typeof stored?.requireVerification === "boolean"
        ? stored.requireVerification
        : fallback.requireVerification,
    verifierMode: verifierModeFromUnknown(
      stored?.verifierMode,
      fallback.verifierMode,
    ),
    verifierChecks: stringArray(
      stored?.verifierChecks,
      fallback.verifierChecks,
    ),
    allowSideEffects:
      typeof stored?.allowSideEffects === "boolean"
        ? stored.allowSideEffects
        : fallback.allowSideEffects,
    sideEffects: stringArray(stored?.sideEffects, fallback.sideEffects),
  };
}

export function analyzeCommandExecution(
  command: CommandRecord,
): CommandExecutionAnalysis {
  const policy = commandExecutionPolicy(command);
  return {
    policy,
    failure: classifyCommandFailure(command, policy),
  };
}

export function applyCommandExecutionPolicyToGraph(
  graph: WorkGraph,
  policy: CommandExecutionPolicy,
): WorkGraph {
  return {
    ...graph,
    budgets: {
      ...(graph.budgets ?? {}),
      maxRuntimeMs: policy.maxRuntimeMs,
      maxAttempts: policy.maxAttempts,
      backoffMs: policy.backoffMs,
    },
    nodes: graph.nodes.map((node) => applyPolicyToNode(node, policy)),
  };
}

export function verifierPolicyForCommand(
  plan: CommandPlan,
  envelope?: Pick<CommandEnvelope, "policy">,
): WorkNode["verifierPolicy"] {
  let base: WorkNode["verifierPolicy"];
  if (!plan.action) {
    base = { mode: "required", checks: ["artifact_schema"] };
  } else if (
    plan.action.family === "project" &&
    ["verify", "smoke"].includes(plan.action.subcommand)
  ) {
    base = {
      mode: "required",
      checks: ["artifact_schema", "trace_grade"],
    };
  } else {
    base = {
      mode: "required_before_side_effect",
      checks: ["artifact_schema"],
    };
  }
  const adapterPolicy = adapterVerifierPolicyForPlan(plan, base);
  if (adapterPolicy) {
    base = adapterPolicy;
  }

  if (envelope?.policy?.requireVerification === true) {
    return {
      ...base,
      mode: "required",
      checks:
        base.checks && base.checks.length > 0
          ? [...base.checks]
          : ["artifact_schema"],
    };
  }
  return base;
}

export function retryPolicyForCommand(input: {
  envelope: Pick<CommandEnvelope, "policy">;
  route: Pick<CommandRoute, "sideEffects">;
  plan: Pick<CommandPlan, "action">;
}): Pick<
  CommandExecutionPolicy,
  "maxAttempts" | "backoffMs" | "retryOnFailed"
> {
  const explicitRetries = input.envelope.policy?.maxRetries;
  const safeDefaultRetries =
    input.plan.action?.dryRunSafe === true || input.route.sideEffects.length === 0
      ? 1
      : 0;
  const maxRetries =
    typeof explicitRetries === "number" && explicitRetries >= 0
      ? explicitRetries
      : safeDefaultRetries;
  const backoffMs =
    typeof input.envelope.policy?.retryBackoffMs === "number" &&
    input.envelope.policy.retryBackoffMs >= 0
      ? input.envelope.policy.retryBackoffMs
      : 500;
  return {
    maxAttempts: Math.min(10, Math.max(1, Math.floor(maxRetries) + 1)),
    backoffMs: Math.floor(backoffMs),
    retryOnFailed: true,
  };
}

export function budgetedTimeoutMs(input: {
  verb: string;
  maxRuntimeSeconds?: number | undefined;
}): number {
  const defaultTimeoutMs = timeoutForVerb(input.verb);
  const maxRuntimeSeconds = input.maxRuntimeSeconds;
  if (
    typeof maxRuntimeSeconds !== "number" ||
    !Number.isFinite(maxRuntimeSeconds) ||
    maxRuntimeSeconds <= 0
  ) {
    return defaultTimeoutMs;
  }
  return Math.min(defaultTimeoutMs, Math.max(1_000, maxRuntimeSeconds * 1000));
}

export function timeoutForVerb(verb: string): number {
  if (verb.startsWith("project.")) return 10 * 60_000;
  if (verb.startsWith("ops.")) return 3 * 60_000;
  return 60_000;
}

function fallbackExecutionPolicy(command: CommandRecord): CommandExecutionPolicy {
  const fallbackRetry = {
    maxAttempts: positiveInteger(command.retryPolicy?.maxAttempts, 1) ?? 1,
    backoffMs: nonNegativeInteger(command.retryPolicy?.backoffMs, 500),
    retryOnFailed:
      typeof command.retryPolicy?.retryOnFailed === "boolean"
        ? command.retryPolicy.retryOnFailed
        : true,
  };
  const verifier = verifierPolicyForCommand(command.plan ?? emptyPlan());
  const maxRuntimeMs = budgetedTimeoutMs({
    verb: command.verb ?? "",
  });
  const sideEffects = [...(command.route?.sideEffects ?? [])];
  return {
    ...fallbackRetry,
    maxRuntimeMs,
    maxRuntimeSeconds: Math.max(1, Math.ceil(maxRuntimeMs / 1000)),
    requireVerification: verificationRequired(verifier.mode, sideEffects),
    verifierMode: verifier.mode,
    verifierChecks: [...(verifier.checks ?? [])],
    allowSideEffects: null,
    sideEffects,
  };
}

function classifyCommandFailure(
  command: CommandRecord,
  policy: CommandExecutionPolicy,
): CommandFailureAnalysis {
  if (command.status === "completed") {
    return {
      kind: "none",
      summary: null,
      nodeId: null,
      attempts: null,
      maxAttempts: policy.maxAttempts,
      timedOut: false,
      verifierRequired: policy.requireVerification,
      verifierPassed: policy.requireVerification ? true : null,
    };
  }
  if (command.status === "queued" || command.status === "running") {
    return {
      kind: "active",
      summary: command.error ?? null,
      nodeId: null,
      attempts: null,
      maxAttempts: policy.maxAttempts,
      timedOut: false,
      verifierRequired: policy.requireVerification,
      verifierPassed: null,
    };
  }
  if (command.status === "blocked_approval") {
    return {
      kind: "awaiting_approval",
      summary: command.error ?? "approval required",
      nodeId: null,
      attempts: null,
      maxAttempts: policy.maxAttempts,
      timedOut: false,
      verifierRequired: policy.requireVerification,
      verifierPassed: null,
    };
  }
  if (command.status === "blocked_policy") {
    return {
      kind: "policy_blocked",
      summary: command.error ?? "policy denied command",
      nodeId: null,
      attempts: null,
      maxAttempts: policy.maxAttempts,
      timedOut: false,
      verifierRequired: policy.requireVerification,
      verifierPassed: null,
    };
  }
  if (command.status === "canceled") {
    return {
      kind: "canceled",
      summary: command.error ?? "command canceled",
      nodeId: null,
      attempts: null,
      maxAttempts: policy.maxAttempts,
      timedOut: false,
      verifierRequired: policy.requireVerification,
      verifierPassed: null,
    };
  }

  const graphFailure = graphFailureAnalysis(command, policy);
  if (graphFailure) return graphFailure;

  const output = asRecord(command.result?.output);
  const timedOut =
    output?.timedOut === true ||
    processLikeTimedOut(
      typeof output?.signal === "string" ? output.signal : null,
      command.error,
    );
  return {
    kind: timedOut ? "runtime_exceeded" : "dispatch_failed",
    summary: command.error ?? extractSummary(command),
    nodeId: null,
    attempts: null,
    maxAttempts: policy.maxAttempts,
    timedOut,
    verifierRequired: policy.requireVerification,
    verifierPassed: null,
  };
}

function graphFailureAnalysis(
  command: CommandRecord,
  policy: CommandExecutionPolicy,
): CommandFailureAnalysis | null {
  const output = asRecord(command.result?.output);
  const nodeResults = Array.isArray(output?.nodeResults) ? output.nodeResults : [];
  for (const nodeResult of nodeResults) {
    const record = asRecord(nodeResult);
    if (!record) continue;
    const nodeId = typeof record.nodeId === "string" ? record.nodeId : null;
    const attempts = positiveInteger(record.attempts, null);
    const verifier = asRecord(record.verifier);
    const dispatch = asRecord(record.dispatch);
    const verifierRequired = verifier?.required === true;
    const verifierPassed =
      typeof verifier?.passed === "boolean" ? verifier.passed : null;
    if (verifierRequired && verifierPassed === false) {
      return {
        kind: "verifier_failed",
        summary:
          (typeof verifier?.reason === "string" ? verifier.reason : null) ??
          command.error ??
          extractSummary(command),
        nodeId,
        attempts,
        maxAttempts: policy.maxAttempts,
        timedOut: false,
        verifierRequired: true,
        verifierPassed: false,
      };
    }
    const timedOut = dispatchTimedOut(dispatch);
    if (timedOut) {
      return {
        kind: "runtime_exceeded",
        summary:
          dispatchSummary(dispatch) ??
          command.error ??
          extractSummary(command) ??
          "command exceeded runtime budget",
        nodeId,
        attempts,
        maxAttempts: policy.maxAttempts,
        timedOut: true,
        verifierRequired,
        verifierPassed,
      };
    }
    if (dispatch?.status === "failed") {
      const exhausted =
        attempts !== null &&
        attempts >= policy.maxAttempts &&
        policy.retryOnFailed &&
        policy.maxAttempts > 1;
      return {
        kind: exhausted ? "retry_exhausted" : "dispatch_failed",
        summary:
          dispatchSummary(dispatch) ??
          command.error ??
          extractSummary(command) ??
          "command dispatch failed",
        nodeId,
        attempts,
        maxAttempts: policy.maxAttempts,
        timedOut: false,
        verifierRequired,
        verifierPassed,
      };
    }
  }
  return null;
}

function applyPolicyToNode(
  node: WorkNode,
  policy: CommandExecutionPolicy,
): WorkNode {
  const next: WorkNode = {
    ...node,
    retryPolicy: node.retryPolicy ?? {
      maxAttempts: policy.maxAttempts,
      backoffMs: policy.backoffMs,
      retryOnFailed: policy.retryOnFailed,
    },
    verifierPolicy: applyVerifierPolicy(node.verifierPolicy, policy),
    inputs: node.inputs.map((input) => {
      const value = asRecord(input.value);
      if (
        input.type !== "structured_payload" ||
        !value ||
        !asRecord(value.cli)
      ) {
        return input;
      }
      const cli = asRecord(value.cli);
      if (!cli) return input;
      const existingTimeout = nonNegativeInteger(cli.timeoutMs, policy.maxRuntimeMs);
      return {
        ...input,
        value: {
          ...value,
          cli: {
            ...cli,
            timeoutMs: Math.min(existingTimeout, policy.maxRuntimeMs),
          },
        },
      };
    }),
  };
  return next;
}

function applyVerifierPolicy(
  verifierPolicy: WorkNode["verifierPolicy"],
  policy: CommandExecutionPolicy,
): WorkNode["verifierPolicy"] {
  if (!policy.requireVerification) return verifierPolicy;
  if (verifierPolicy.mode === "required") return verifierPolicy;
  return {
    ...verifierPolicy,
    mode: "required",
    checks:
      verifierPolicy.checks && verifierPolicy.checks.length > 0
        ? [...verifierPolicy.checks]
        : [...policy.verifierChecks],
  };
}

function extractSummary(command: CommandRecord): string | null {
  const summary = command.result?.summary;
  if (typeof summary === "string" && summary.length > 0) return summary;
  const output = asRecord(command.result?.output);
  if (typeof output?.summary === "string" && output.summary.length > 0) {
    return output.summary;
  }
  if (typeof output?.status === "string" && output.status.length > 0) {
    return output.status;
  }
  return null;
}

function dispatchTimedOut(dispatch: Record<string, unknown> | null): boolean {
  if (dispatch?.timedOut === true) return true;
  const payload = asRecord(dispatch?.payload);
  if (payload?.timedOut === true) return true;
  return processLikeTimedOut(
    typeof payload?.signal === "string" ? payload.signal : null,
    dispatchSummary(dispatch),
  );
}

function dispatchSummary(dispatch: Record<string, unknown> | null): string | null {
  return typeof dispatch?.summary === "string" ? dispatch.summary : null;
}

function processLikeTimedOut(
  signal: string | null | undefined,
  summary: string | null | undefined,
): boolean {
  if (signal === "SIGTERM" || signal === "SIGKILL") return true;
  return typeof summary === "string" && /timeout/i.test(summary);
}

function emptyPlan(): CommandPlan {
  return {
    planId: "plan_unknown",
    type: "blocked",
    summary: "unknown",
    action: null,
    activities: [],
    artifactDir: ".",
    workGraphPath: null,
  };
}

function adapterVerifierPolicyForPlan(
  plan: CommandPlan,
  fallback: WorkNode["verifierPolicy"],
): WorkNode["verifierPolicy"] | null {
  const action = parseAdapterAction(plan);
  if (!action) return null;
  try {
    const spec = adapterCommandSpec(findManifest(action.adapterId), action.command);
    const hints = Array.isArray(spec.verifierHints)
      ? spec.verifierHints.filter(isSupportedVerifierHint)
      : [];
    const checks = uniqueChecks([...(fallback.checks ?? []), ...hints]);
    return {
      mode: adapterVerificationMode(action.mode, spec.sideEffectClass, fallback.mode),
      checks,
    };
  } catch {
    return null;
  }
}

function parseAdapterAction(
  plan: CommandPlan,
): { adapterId: string; command: string; mode: string } | null {
  if (
    !plan.action ||
    plan.action.family !== "adapter" ||
    plan.action.subcommand !== "invoke"
  ) {
    return null;
  }
  const [adapterId, command, ...args] = plan.action.args;
  if (typeof adapterId !== "string" || typeof command !== "string") {
    return null;
  }
  const modeIndex = args.indexOf("--mode");
  const modeValue = modeIndex >= 0 ? args[modeIndex + 1] : undefined;
  const mode =
    typeof modeValue === "string"
      ? modeValue
      : "read";
  return { adapterId, command, mode };
}

function adapterVerificationMode(
  mode: string,
  sideEffectClass: string,
  fallback: WorkNode["verifierPolicy"]["mode"],
): WorkNode["verifierPolicy"]["mode"] {
  if (
    sideEffectClass === "none" ||
    mode === "read" ||
    mode === "propose"
  ) {
    return "required";
  }
  return fallback;
}

function isSupportedVerifierHint(value: string): boolean {
  return [
    "tests",
    "lint",
    "policy",
    "trace_grade",
    "artifact_schema",
    "human_review",
  ].includes(value);
}

function uniqueChecks(checks: string[]): string[] {
  return [...new Set(checks.map((check) => check.trim()).filter(Boolean))];
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function positiveInteger(
  value: unknown,
  fallback: number | null,
): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  const normalized = Math.max(1, Math.floor(value));
  return normalized;
}

function nonNegativeInteger(value: unknown, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.max(0, Math.floor(value));
}

function stringArray(value: unknown, fallback: string[]): string[] {
  if (!Array.isArray(value)) return [...fallback];
  return value
    .filter((entry): entry is string => typeof entry === "string")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

function verifierModeFromUnknown(
  value: unknown,
  fallback: WorkNode["verifierPolicy"]["mode"],
): WorkNode["verifierPolicy"]["mode"] {
  if (
    value === "none" ||
    value === "required" ||
    value === "required_before_side_effect"
  ) {
    return value;
  }
  return fallback;
}

function verificationRequired(
  mode: WorkNode["verifierPolicy"]["mode"],
  sideEffects: string[],
): boolean {
  if (mode === "required") return true;
  if (mode === "required_before_side_effect") return sideEffects.length > 0;
  return false;
}
