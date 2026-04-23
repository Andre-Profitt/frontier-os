import { getLedger } from "../ledger/index.ts";
import type { LedgerEvent } from "../ledger/events.ts";
import {
  assessCommandDebt,
  commandOperatorAction,
  type CommandDebtAssessment,
  type CommandDebtOperator,
} from "./debt.ts";
import type { CommandRecord } from "./store.ts";

export interface CommandOperatorAuditEntry {
  ts: string;
  actor: string;
  action: string;
  summary: string;
  from: string | null;
  to: string | null;
  policyStatus: string | null;
  workerId: string | null;
  sourceCommandId: string | null;
  sourceTraceId: string | null;
  replacementCommandId: string | null;
  replacementTraceId: string | null;
}

export interface CommandOperatorAudit {
  recommendedAction: CommandDebtOperator["action"];
  recommendedCommand: string | null;
  sourceCommandId: string | null;
  sourceTraceId: string | null;
  replacementCommandId: string | null;
  replacementTraceId: string | null;
  actionCount: number;
  lastActionAt: string | null;
  lastActionSummary: string | null;
  recentActions: CommandOperatorAuditEntry[];
}

export function commandOperatorAudit(
  command: CommandRecord,
  options: {
    debt?: CommandDebtAssessment;
    limit?: number;
  } = {},
): CommandOperatorAudit {
  const debt = options.debt ?? assessCommandDebt(command);
  const recommended = commandOperatorAction(command, debt);
  const entries = operatorEvents(command, options.limit ?? 500)
    .map(operatorAuditEntry)
    .filter((entry): entry is CommandOperatorAuditEntry => entry !== null);
  let sourceCommandId: string | null = null;
  let sourceTraceId: string | null = null;
  let replacementCommandId: string | null = null;
  let replacementTraceId: string | null = null;
  for (const entry of entries) {
    if (entry.sourceCommandId) sourceCommandId = entry.sourceCommandId;
    if (entry.sourceTraceId) sourceTraceId = entry.sourceTraceId;
    if (entry.replacementCommandId) replacementCommandId = entry.replacementCommandId;
    if (entry.replacementTraceId) replacementTraceId = entry.replacementTraceId;
  }
  const latest = entries.at(-1) ?? null;
  return {
    recommendedAction: recommended.action,
    recommendedCommand: recommended.command,
    sourceCommandId,
    sourceTraceId,
    replacementCommandId,
    replacementTraceId,
    actionCount: entries.length,
    lastActionAt: latest?.ts ?? null,
    lastActionSummary: latest?.summary ?? null,
    recentActions: entries.slice(-8).reverse(),
  };
}

function operatorEvents(command: CommandRecord, limit: number): LedgerEvent[] {
  const ledger = getLedger();
  const sessionIds = [
    `command-${command.commandId}`,
    `command-worker-${command.commandId}`,
    ...(command.plan?.workGraphPath ? [`workgraph-wg_${command.commandId}`] : []),
  ];
  return sessionIds
    .flatMap((sessionId) => ledger.getEvents(sessionId, { limit }))
    .sort((a, b) => a.ts.localeCompare(b.ts));
}

function operatorAuditEntry(event: LedgerEvent): CommandOperatorAuditEntry | null {
  const actor = event.actor ?? "unknown";
  if (event.kind === "command.received") {
    return {
      ts: event.ts,
      actor,
      action: "received",
      summary: `received from ${actor}`,
      from: null,
      to: null,
      policyStatus: null,
      workerId: null,
      sourceCommandId: null,
      sourceTraceId: null,
      replacementCommandId: null,
      replacementTraceId: null,
    };
  }
  if (event.kind === "command.completed" || event.kind === "command.failed") {
    const payload = record(event.payload);
    const error = stringOrNull(payload.error);
    return {
      ts: event.ts,
      actor,
      action: event.kind === "command.completed" ? "completed" : "failed",
      summary:
        event.kind === "command.completed"
          ? "completed"
          : error
            ? `failed: ${error}`
            : "failed",
      from: null,
      to: stringOrNull(payload.status),
      policyStatus: null,
      workerId: null,
      sourceCommandId: null,
      sourceTraceId: null,
      replacementCommandId: null,
      replacementTraceId: null,
    };
  }
  if (event.kind !== "command.state_changed" && event.kind !== "command.queued") {
    return null;
  }
  const payload = record(event.payload);
  const from = stringOrNull(payload.from);
  const to = stringOrNull(payload.to) ?? stringOrNull(payload.status);
  const operatorAction = stringOrNull(payload.operatorAction);
  const reason = stringOrNull(payload.reason);
  const policyStatus = stringOrNull(payload.policyStatus);
  const workerId = stringOrNull(payload.workerId);
  const sourceCommandId = stringOrNull(payload.sourceCommandId);
  const sourceTraceId = stringOrNull(payload.sourceTraceId);
  const replacementCommandId = stringOrNull(payload.replacementCommandId);
  const replacementTraceId = stringOrNull(payload.replacementTraceId);
  const action =
    operatorAction ??
    normalizeStateAction({
      kind: event.kind,
      reason,
      from,
      to,
    });
  return {
    ts: event.ts,
    actor,
    action,
    summary: stateSummary({
      action,
      actor,
      from,
      to,
      policyStatus,
      workerId,
      sourceCommandId,
      replacementCommandId,
    }),
    from,
    to,
    policyStatus,
    workerId,
    sourceCommandId,
    sourceTraceId,
    replacementCommandId,
    replacementTraceId,
  };
}

function normalizeStateAction(input: {
  kind: string;
  reason: string | null;
  from: string | null;
  to: string | null;
}): string {
  if (input.kind === "command.queued") return "queued";
  if (input.reason === "claimed") return "claimed";
  if (input.reason === "resume") return "resume";
  if (input.reason === "canceled") return "cancel";
  if (input.to === "blocked_approval") return "blocked_approval";
  if (input.to === "blocked_policy") return "blocked_policy";
  if (input.to === "running") return "running";
  if (input.to === "queued") return "queued";
  return input.reason ?? "state_changed";
}

function stateSummary(input: {
  action: string;
  actor: string;
  from: string | null;
  to: string | null;
  policyStatus: string | null;
  workerId: string | null;
  sourceCommandId: string | null;
  replacementCommandId: string | null;
}): string {
  switch (input.action) {
    case "queued":
      if (input.from && input.to) return `state ${input.from} -> ${input.to}`;
      return "queued for worker";
    case "running":
      if (input.from && input.to) return `state ${input.from} -> ${input.to}`;
      return "running";
    case "claimed":
      return `claimed by ${input.workerId ?? input.actor}`;
    case "resume":
      return input.policyStatus
        ? `resumed (${input.policyStatus})`
        : "resumed";
    case "cancel":
      return "canceled";
    case "retry":
      return input.replacementCommandId
        ? `retry -> ${input.replacementCommandId}`
        : "retry submitted";
    case "requeue":
      if (input.replacementCommandId) {
        return `requeue -> ${input.replacementCommandId}`;
      }
      if (input.sourceCommandId) return `requeue from ${input.sourceCommandId}`;
      return "requeue submitted";
    case "blocked_approval":
      return "paused for approval";
    case "blocked_policy":
      return "blocked by policy";
    case "state_changed":
      if (input.from && input.to) return `state ${input.from} -> ${input.to}`;
      return "state changed";
    default:
      if (input.from && input.to) return `${input.action}: ${input.from} -> ${input.to}`;
      return input.action.replaceAll("_", " ");
  }
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function stringOrNull(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}
