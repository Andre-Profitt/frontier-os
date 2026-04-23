import { analyzeCommandExecution } from "./execution.ts";
import {
  assessCommandDebt,
  commandDebtFromCommands,
  commandOperatorAction,
  type CommandDebtReport,
} from "./debt.ts";
import { CommandStore, type CommandRecord, type CommandStoreStatus } from "./store.ts";

export interface CommandBriefOptions {
  hours?: number;
  limit?: number;
}

export interface CommandBriefItem {
  commandId: string;
  traceId: string;
  status: string;
  intent: string;
  projectId: string | null;
  lane: string | null;
  verb: string | null;
  actor: string;
  requestedAt: string;
  updatedAt: string;
  error: string | null;
  executionPolicy: {
    maxRuntimeSeconds: number;
    maxAttempts: number;
    requireVerification: boolean;
    allowSideEffects: boolean | null;
  };
  failureKind: string;
  ageMinutes: number;
  debtKind: string;
  debtSummary: string | null;
  operatorAction: string | null;
  operatorCommand: string | null;
}

export interface ResolvedCommandBriefItem extends CommandBriefItem {
  resolvedBy: CommandBriefItem;
}

export interface CommandBrief {
  generatedAt: string;
  windowHours: number;
  since: string;
  summary: string[];
  worker: CommandStoreStatus;
  debt: CommandDebtReport;
  countsInWindow: Record<string, number>;
  active: CommandBriefItem[];
  blockers: CommandBriefItem[];
  recentCompleted: CommandBriefItem[];
  recentFailed: CommandBriefItem[];
  unresolvedFailures: CommandBriefItem[];
  resolvedFailures: ResolvedCommandBriefItem[];
  unresolvedFailureKinds: Record<string, number>;
}

export function commandBrief(options: CommandBriefOptions = {}): CommandBrief {
  const hours =
    typeof options.hours === "number" && Number.isFinite(options.hours) && options.hours > 0
      ? options.hours
      : 24;
  const limit =
    typeof options.limit === "number" && Number.isFinite(options.limit) && options.limit > 0
      ? Math.min(Math.floor(options.limit), 500)
      : 100;
  const since = new Date(Date.now() - hours * 60 * 60 * 1000).toISOString();
  const store = new CommandStore();
  try {
    const worker = store.status();
    const commands = store.list({ limit });
    const debt = commandDebtFromCommands(commands);
    const windowCommands = commands.filter(
      (command) => command.updatedAt >= since || command.requestedAt >= since,
    );
    const active = commands.filter((command) =>
      ["queued", "running"].includes(command.status),
    );
    const blockers = commands.filter((command) =>
      ["blocked_approval", "blocked_policy"].includes(command.status),
    );
    const recentCompleted = windowCommands
      .filter((command) => command.status === "completed")
      .slice(0, 10)
      .map(commandBriefItem);
    const recentFailed = windowCommands
      .filter((command) => command.status === "failed")
      .slice(0, 10)
      .map(commandBriefItem);
    const resolvedFailures = recentFailed
      .map((failure) => {
        const resolvedBy = findLaterSuccess(failure, windowCommands);
        return resolvedBy ? { ...failure, resolvedBy: commandBriefItem(resolvedBy) } : null;
      })
      .filter((failure): failure is ResolvedCommandBriefItem => failure !== null);
    const resolvedFailureIds = new Set(
      resolvedFailures.map((failure) => failure.commandId),
    );
    const unresolvedFailures = recentFailed.filter(
      (failure) => !resolvedFailureIds.has(failure.commandId),
    );
    const unresolvedFailureKinds = countFailureKinds(unresolvedFailures);
    return {
      generatedAt: new Date().toISOString(),
      windowHours: hours,
      since,
      summary: [
        active.length === 0
          ? "queue clear"
          : debt.counts.staleActive === 0
            ? `${active.length} active command${active.length === 1 ? "" : "s"} (healthy)`
            : `${active.length} active command${active.length === 1 ? "" : "s"} / ${
                debt.counts.staleActive
              } stale`,
        blockers.length === 0
          ? "no approval/policy blockers"
          : `${blockers.length} blocked command${blockers.length === 1 ? "" : "s"}${
              debt.counts.staleApproval + debt.counts.stalePolicy > 0
                ? ` / ${debt.counts.staleApproval + debt.counts.stalePolicy} stale`
                : ""
            }`,
        debt.counts.staleTotal === 0
          ? "no stale queue/approval debt"
          : `${debt.counts.staleTotal} stale queue/approval debt item${
              debt.counts.staleTotal === 1 ? "" : "s"
            }`,
        unresolvedFailures.length === 0
          ? "no unresolved recent failures"
          : `${unresolvedFailures.length} unresolved recent failure${
              unresolvedFailures.length === 1 ? "" : "s"
            }`,
        unresolvedFailureKinds.verifier_failed
          ? `${unresolvedFailureKinds.verifier_failed} verifier failure${
              unresolvedFailureKinds.verifier_failed === 1 ? "" : "s"
            }`
          : "no verifier failures",
        unresolvedFailureKinds.retry_exhausted || unresolvedFailureKinds.runtime_exceeded
          ? `${
              (unresolvedFailureKinds.retry_exhausted ?? 0) +
              (unresolvedFailureKinds.runtime_exceeded ?? 0)
            } retry/budget failure${
              (unresolvedFailureKinds.retry_exhausted ?? 0) +
                (unresolvedFailureKinds.runtime_exceeded ?? 0) ===
              1
                ? ""
                : "s"
            }`
          : "no retry/budget failures",
      ],
      worker,
      debt,
      countsInWindow: countCommandStatuses(windowCommands),
      active: active.map(commandBriefItem),
      blockers: blockers.map(commandBriefItem),
      recentCompleted,
      recentFailed,
      unresolvedFailures,
      resolvedFailures,
      unresolvedFailureKinds,
    };
  } finally {
    store.close();
  }
}

function countCommandStatuses(commands: CommandRecord[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const command of commands) {
    counts[command.status] = (counts[command.status] ?? 0) + 1;
  }
  return counts;
}

function commandBriefItem(command: CommandRecord): CommandBriefItem {
  const execution = analyzeCommandExecution(command);
  const debt = assessCommandDebt(command);
  const operator = commandOperatorAction(command, debt);
  return {
    commandId: command.commandId,
    traceId: command.traceId,
    status: command.status,
    intent: command.intent,
    projectId: command.projectId,
    lane: command.lane,
    verb: command.verb,
    actor: command.actor,
    requestedAt: command.requestedAt,
    updatedAt: command.updatedAt,
    error: command.error,
    executionPolicy: {
      maxRuntimeSeconds: execution.policy.maxRuntimeSeconds,
      maxAttempts: execution.policy.maxAttempts,
      requireVerification: execution.policy.requireVerification,
      allowSideEffects: execution.policy.allowSideEffects,
    },
    failureKind: execution.failure.kind,
    ageMinutes: debt.ageMinutes,
    debtKind: debt.kind,
    debtSummary: debt.summary,
    operatorAction: operator.action,
    operatorCommand: operator.command,
  };
}

function countFailureKinds(items: CommandBriefItem[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const item of items) {
    counts[item.failureKind] = (counts[item.failureKind] ?? 0) + 1;
  }
  return counts;
}

function findLaterSuccess(
  failure: CommandBriefItem,
  commands: CommandRecord[],
): CommandRecord | null {
  const candidates = commands
    .filter((command) => command.status === "completed")
    .filter((command) => command.updatedAt > failure.updatedAt)
    .filter((command) => command.lane === failure.lane)
    .filter((command) => command.verb === failure.verb)
    .filter((command) => command.projectId === failure.projectId)
    .sort((a, b) => a.updatedAt.localeCompare(b.updatedAt));
  return candidates[0] ?? null;
}
