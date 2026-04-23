import { getLedger } from "../ledger/index.ts";
import type { SessionSummary } from "../ledger/events.ts";
import { commandArtifacts } from "./artifacts.ts";
import {
  analyzeCommandExecution,
  type CommandExecutionAnalysis,
} from "./execution.ts";
import { CommandStore, type CommandRecord } from "./store.ts";

export interface CommandResultPacket {
  generatedAt: string;
  packetVersion: "v1";
  command: {
    commandId: string;
    traceId: string;
    intent: string;
    status: string;
    lane: string | null;
    verb: string | null;
    projectId: string | null;
    actor: string;
    requestedAt: string;
    updatedAt: string;
  };
  execution: {
    kind: "process" | "work_graph" | "unknown";
    ok: boolean;
    summary: string | null;
    error: string | null;
  };
  executionPolicy: CommandExecutionAnalysis["policy"];
  failure: CommandExecutionAnalysis["failure"];
  verification: {
    required: boolean;
    passed: boolean | null;
    reason: string | null;
    nodeId: string | null;
    failedChecks: number;
    checks: Array<{
      nodeId?: string;
      name: string;
      passed: boolean;
      reason: string;
      evidence: Record<string, unknown> | null;
    }>;
  };
  route: CommandRecord["route"];
  policy: CommandRecord["policy"];
  outputs: {
    primary: Record<string, unknown> | null;
    structured: Array<{
      source: string;
      nodeId?: string;
      kind: string;
      data: Record<string, unknown>;
    }>;
    adapterDispatches: Array<{
      nodeId?: string;
      adapterId: string;
      command: string;
      status: string | null;
      resultSummary: string | null;
    }>;
  };
  evidence: {
    artifactDir: string | null;
    workGraphPath: string | null;
    files: number;
    dispatchArtifactRefs: string[];
    sessionIds: string[];
    sessions: SessionSummary[];
    ledgerEventCount: number;
    lastEventAt: string | null;
  };
}

export function commandResultPacket(commandId: string): CommandResultPacket {
  const store = new CommandStore();
  try {
    const command = store.get(commandId);
    if (!command) throw new Error(`unknown command: ${commandId}`);
    return packetFromRecord(command);
  } finally {
    store.close();
  }
}

export function packetFromRecord(command: CommandRecord): CommandResultPacket {
  const artifacts = commandArtifacts(command.commandId);
  const ledger = ledgerSummary(command);
  const normalizedOutputs = normalizeOutputs(command);
  const summary = extractSummary(command);
  const execution = analyzeCommandExecution(command);
  const verification = normalizeVerification(command);
  return {
    generatedAt: new Date().toISOString(),
    packetVersion: "v1",
    command: {
      commandId: command.commandId,
      traceId: command.traceId,
      intent: command.intent,
      status: command.status,
      lane: command.lane,
      verb: command.verb,
      projectId: command.projectId,
      actor: command.actor,
      requestedAt: command.requestedAt,
      updatedAt: command.updatedAt,
    },
    execution: {
      kind: executionKind(command),
      ok: command.status === "completed",
      summary,
      error: command.error,
    },
    executionPolicy: execution.policy,
    failure: execution.failure,
    verification,
    route: command.route,
    policy: command.policy,
    outputs: normalizedOutputs,
    evidence: {
      artifactDir: artifacts.artifactDir,
      workGraphPath: artifacts.workGraphPath,
      files: artifacts.files.length,
      dispatchArtifactRefs: artifacts.dispatchArtifactRefs,
      sessionIds: ledger.sessionIds,
      sessions: ledger.sessions,
      ledgerEventCount: ledger.eventCount,
      lastEventAt: ledger.lastEventAt,
    },
  };
}

function normalizeVerification(
  command: CommandRecord,
): CommandResultPacket["verification"] {
  const output = command.result?.output;
  const nodeResults = isRecord(output) && Array.isArray(output.nodeResults)
    ? output.nodeResults
    : [];
  const nodes = nodeResults
    .map((nodeResult) => {
      if (!isRecord(nodeResult)) return null;
      const verifier = isRecord(nodeResult.verifier) ? nodeResult.verifier : null;
      if (!verifier) return null;
      const nodeId =
        typeof nodeResult.nodeId === "string" ? nodeResult.nodeId : undefined;
      const checks = Array.isArray(verifier.checks)
        ? verifier.checks
            .map((check) => {
              if (!isRecord(check)) return null;
              const name = typeof check.name === "string" ? check.name : null;
              const passed = typeof check.passed === "boolean" ? check.passed : null;
              const reason = typeof check.reason === "string" ? check.reason : null;
              if (!name || passed === null || !reason) return null;
              return {
                ...(nodeId ? { nodeId } : {}),
                name,
                passed,
                reason,
                evidence: isRecord(check.evidence) ? check.evidence : null,
              };
            })
            .filter(
              (
                check,
              ): check is CommandResultPacket["verification"]["checks"][number] =>
                check !== null,
            )
        : [];
      return {
        nodeId: nodeId ?? null,
        required: verifier.required === true,
        passed:
          typeof verifier.passed === "boolean" ? verifier.passed : null,
        reason:
          typeof verifier.reason === "string" ? verifier.reason : null,
        checks,
      };
    })
    .filter(
      (
        node,
      ): node is {
        nodeId: string | null;
        required: boolean;
        passed: boolean | null;
        reason: string | null;
        checks: CommandResultPacket["verification"]["checks"];
      } => node !== null,
    );
  const requiredNodes = nodes.filter((node) => node.required);
  if (requiredNodes.length === 0) {
    return {
      required: false,
      passed: null,
      reason: null,
      nodeId: null,
      failedChecks: 0,
      checks: [],
    };
  }
  const primary =
    requiredNodes.find((node) => node.passed === false) ?? requiredNodes[0];
  if (!primary) {
    return {
      required: false,
      passed: null,
      reason: null,
      nodeId: null,
      failedChecks: 0,
      checks: [],
    };
  }
  const checks = requiredNodes.flatMap((node) => node.checks);
  return {
    required: true,
    passed: requiredNodes.every((node) => node.passed === true),
    reason: primary.reason,
    nodeId: primary.nodeId,
    failedChecks: checks.filter((check) => check.passed === false).length,
    checks,
  };
}

function normalizeOutputs(command: CommandRecord): CommandResultPacket["outputs"] {
  const structured: CommandResultPacket["outputs"]["structured"] = [];
  const adapterDispatches: CommandResultPacket["outputs"]["adapterDispatches"] = [];

  const output = command.result?.output;
  if (isRecord(output) && output.kind === "process") {
    const parsed = isRecord(output.parsedStdout)
      ? output.parsedStdout
      : parseMaybeJson(output.stdoutTail);
    if (parsed) {
      structured.push({
        source: "process.parsedStdout",
        kind: classifyStructuredOutput(parsed),
        data: parsed,
      });
    }
  }

  const nodeResults = isRecord(output) && Array.isArray(output.nodeResults)
    ? output.nodeResults
    : [];
  for (const nodeResult of nodeResults) {
    if (!isRecord(nodeResult)) continue;
    const nodeId =
      typeof nodeResult.nodeId === "string" ? nodeResult.nodeId : undefined;
    const dispatch = isRecord(nodeResult.dispatch) ? nodeResult.dispatch : null;
    if (!dispatch) continue;
    const payload = isRecord(dispatch.payload) ? dispatch.payload : null;
    if (payload) {
      const parsed = isRecord(payload.parsedStdout)
        ? payload.parsedStdout
        : parseMaybeJson(payload.stdout);
      if (parsed) {
        structured.push({
          source: "work_graph.dispatch.stdout",
          ...(nodeId ? { nodeId } : {}),
          kind: classifyStructuredOutput(parsed),
          data: parsed,
        });
      }
      const adapterId =
        typeof payload.adapterId === "string" ? payload.adapterId : null;
      const commandName =
        typeof payload.command === "string" ? payload.command : null;
      if (adapterId && commandName) {
        adapterDispatches.push({
          ...(nodeId ? { nodeId } : {}),
          adapterId,
          command: commandName,
          status: typeof payload.status === "string" ? payload.status : null,
          resultSummary:
            typeof payload.resultSummary === "string"
              ? payload.resultSummary
              : null,
        });
      }
    }
  }

  return {
    primary: structured[0]?.data ?? null,
    structured,
    adapterDispatches,
  };
}

function ledgerSummary(command: CommandRecord): {
  sessionIds: string[];
  sessions: SessionSummary[];
  eventCount: number;
  lastEventAt: string | null;
} {
  const ledger = getLedger();
  const sessionIds = [
    `command-${command.commandId}`,
    `command-worker-${command.commandId}`,
    ...(command.plan?.workGraphPath ? [`workgraph-wg_${command.commandId}`] : []),
  ];
  const sessions = sessionIds
    .map((sessionId) => ledger.getSessionSummary(sessionId))
    .filter((session): session is SessionSummary => session !== null);
  const events = sessionIds.flatMap((sessionId) =>
    ledger.getEvents(sessionId, { limit: 500 }),
  );
  events.sort((a, b) => a.ts.localeCompare(b.ts));
  return {
    sessionIds,
    sessions,
    eventCount: events.length,
    lastEventAt: events.at(-1)?.ts ?? null,
  };
}

function executionKind(command: CommandRecord): CommandResultPacket["execution"]["kind"] {
  const output = command.result?.output;
  if (isRecord(output) && output.kind === "process") return "process";
  if (isRecord(output) && output.kind === "work_graph") return "work_graph";
  return "unknown";
}

function extractSummary(command: CommandRecord): string | null {
  const summary = command.result?.summary;
  if (typeof summary === "string" && summary.length > 0) return summary;
  const output = command.result?.output;
  if (isRecord(output)) {
    const nested = output.summary;
    if (typeof nested === "string" && nested.length > 0) return nested;
    if (typeof output.status === "string" && output.status.length > 0) {
      return output.status;
    }
  }
  return null;
}

function classifyStructuredOutput(value: Record<string, unknown>): string {
  if (
    value.servedBy === "mlxw" ||
    typeof value.host_overall_status === "string" ||
    typeof value.default_model === "string"
  ) {
    return "mlx_output";
  }
  if (
    typeof value.adapterId === "string" &&
    typeof value.command === "string" &&
    typeof value.status === "string"
  ) {
    return "adapter_result";
  }
  if (typeof value.servedBy === "string") {
    if ("project" in value || "projects" in value) return "project_output";
    if ("command" in value || "commands" in value) return "command_output";
    if ("reachable" in value || "socketPath" in value) return "helper_output";
    return "frontier_cli_output";
  }
  if (typeof value.status === "string" && "platform" in value) return "mlx_output";
  return "json_output";
}

function parseMaybeJson(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  try {
    const parsed = JSON.parse(trimmed) as unknown;
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
