import { analyzeCommandExecution } from "./execution.ts";
import { CommandStore, type CommandRecord } from "./store.ts";

export type CommandDebtKind =
  | "none"
  | "stale_queued"
  | "stale_running"
  | "stale_approval"
  | "stale_policy";

export interface CommandDebtAssessment {
  kind: CommandDebtKind;
  stale: boolean;
  ageMinutes: number;
  thresholdMinutes: number | null;
  summary: string | null;
}

export interface CommandDebtOperator {
  action: "resume" | "retry" | "requeue" | "cancel" | "inspect" | null;
  command: string | null;
}

export interface CommandDebtItem extends CommandDebtAssessment {
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
  failureKind: string;
  operatorAction: CommandDebtOperator["action"];
  operatorCommand: string | null;
}

export interface CommandDebtCounts {
  healthyQueued: number;
  healthyRunning: number;
  staleQueued: number;
  staleRunning: number;
  staleApproval: number;
  stalePolicy: number;
  staleActive: number;
  staleTotal: number;
  blockedTotal: number;
}

export interface CommandDebtReport {
  generatedAt: string;
  summary: string[];
  counts: CommandDebtCounts;
  commands: CommandDebtItem[];
}

const STALE_QUEUED_MS = 15 * 60_000;
const STALE_RUNNING_FLOOR_MS = 10 * 60_000;
const STALE_APPROVAL_MS = 30 * 60_000;
const STALE_POLICY_MS = 60 * 60_000;

export function commandDebt(options: { limit?: number } = {}): CommandDebtReport {
  const store = new CommandStore();
  try {
    return commandDebtFromCommands(store.list({ limit: options.limit ?? 100 }));
  } finally {
    store.close();
  }
}

export function commandDebtFromCommands(
  commands: CommandRecord[],
  now: Date = new Date(),
): CommandDebtReport {
  const items = commands
    .filter((command) =>
      ["queued", "running", "blocked_approval", "blocked_policy"].includes(
        command.status,
      ),
    )
    .map((command) => commandDebtItem(command, now));
  const counts = countDebt(items);
  return {
    generatedAt: now.toISOString(),
    summary: debtSummary(counts),
    counts,
    commands: items.filter((item) => item.stale),
  };
}

export function assessCommandDebt(
  command: CommandRecord,
  now: Date = new Date(),
): CommandDebtAssessment {
  const ageMs = commandAgeMs(command, now);
  const ageMinutes = minutes(ageMs);
  if (command.status === "queued") {
    const thresholdMinutes = minutes(STALE_QUEUED_MS);
    if (ageMs >= STALE_QUEUED_MS) {
      return {
        kind: "stale_queued",
        stale: true,
        ageMinutes,
        thresholdMinutes,
        summary: `queued ${durationLabel(ageMinutes)} (threshold ${durationLabel(
          thresholdMinutes,
        )})`,
      };
    }
    return {
      kind: "none",
      stale: false,
      ageMinutes,
      thresholdMinutes,
      summary: null,
    };
  }

  if (command.status === "running") {
    const execution = analyzeCommandExecution(command);
    const thresholdMs = Math.max(
      execution.policy.maxRuntimeMs * 2,
      STALE_RUNNING_FLOOR_MS,
    );
    const thresholdMinutes = minutes(thresholdMs);
    const leaseExpired =
      command.lease?.until !== null &&
      command.lease?.until !== undefined &&
      command.lease.until <= now.toISOString();
    if (leaseExpired || ageMs >= thresholdMs) {
      return {
        kind: "stale_running",
        stale: true,
        ageMinutes,
        thresholdMinutes,
        summary: leaseExpired
          ? `running lease expired after ${durationLabel(ageMinutes)}`
          : `running ${durationLabel(ageMinutes)} (threshold ${durationLabel(
              thresholdMinutes,
            )})`,
      };
    }
    return {
      kind: "none",
      stale: false,
      ageMinutes,
      thresholdMinutes,
      summary: null,
    };
  }

  if (command.status === "blocked_approval") {
    const thresholdMinutes = minutes(STALE_APPROVAL_MS);
    if (ageMs >= STALE_APPROVAL_MS) {
      return {
        kind: "stale_approval",
        stale: true,
        ageMinutes,
        thresholdMinutes,
        summary: `awaiting approval ${durationLabel(ageMinutes)} (threshold ${durationLabel(
          thresholdMinutes,
        )})`,
      };
    }
    return {
      kind: "none",
      stale: false,
      ageMinutes,
      thresholdMinutes,
      summary: null,
    };
  }

  if (command.status === "blocked_policy") {
    const thresholdMinutes = minutes(STALE_POLICY_MS);
    if (ageMs >= STALE_POLICY_MS) {
      return {
        kind: "stale_policy",
        stale: true,
        ageMinutes,
        thresholdMinutes,
        summary: `policy blocked ${durationLabel(ageMinutes)}`,
      };
    }
    return {
      kind: "none",
      stale: false,
      ageMinutes,
      thresholdMinutes,
      summary: null,
    };
  }

  return {
    kind: "none",
    stale: false,
    ageMinutes,
    thresholdMinutes: null,
    summary: null,
  };
}

export function commandOperatorAction(
  command: CommandRecord,
  debt: CommandDebtAssessment = assessCommandDebt(command),
): CommandDebtOperator {
  if (command.status === "failed" || command.status === "canceled") {
    return {
      action: "retry",
      command: `frontier command retry ${command.commandId} --json`,
    };
  }
  if (command.status === "blocked_approval") {
    if (debt.stale) {
      return {
        action: "requeue",
        command: `frontier command requeue ${command.commandId} --json`,
      };
    }
    return {
      action: "resume",
      command:
        command.interrupt?.resume.cli ??
        `frontier command resume ${command.commandId} --approval ${command.traceId} --json`,
    };
  }
  if (command.status === "queued" || command.status === "running") {
    if (debt.stale) {
      return {
        action: "requeue",
        command: `frontier command requeue ${command.commandId} --json`,
      };
    }
    return {
      action: "cancel",
      command: `frontier command cancel ${command.commandId} --json`,
    };
  }
  if (command.status === "blocked_policy") {
    return {
      action: "inspect",
      command: `frontier command submit --intent ${JSON.stringify(command.intent)} --dry-run --json --local`,
    };
  }
  return { action: null, command: null };
}

function commandDebtItem(
  command: CommandRecord,
  now: Date,
): CommandDebtItem {
  const debt = assessCommandDebt(command, now);
  const execution = analyzeCommandExecution(command);
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
    failureKind: execution.failure.kind,
    operatorAction: operator.action,
    operatorCommand: operator.command,
    ...debt,
  };
}

function countDebt(items: CommandDebtItem[]): CommandDebtCounts {
  const counts: CommandDebtCounts = {
    healthyQueued: 0,
    healthyRunning: 0,
    staleQueued: 0,
    staleRunning: 0,
    staleApproval: 0,
    stalePolicy: 0,
    staleActive: 0,
    staleTotal: 0,
    blockedTotal: 0,
  };
  for (const item of items) {
    if (item.status === "queued") {
      if (item.kind === "stale_queued") counts.staleQueued += 1;
      else counts.healthyQueued += 1;
    }
    if (item.status === "running") {
      if (item.kind === "stale_running") counts.staleRunning += 1;
      else counts.healthyRunning += 1;
    }
    if (item.status === "blocked_approval") {
      counts.blockedTotal += 1;
      if (item.kind === "stale_approval") counts.staleApproval += 1;
    }
    if (item.status === "blocked_policy") {
      counts.blockedTotal += 1;
      if (item.kind === "stale_policy") counts.stalePolicy += 1;
    }
  }
  counts.staleActive = counts.staleQueued + counts.staleRunning;
  counts.staleTotal =
    counts.staleQueued +
    counts.staleRunning +
    counts.staleApproval +
    counts.stalePolicy;
  return counts;
}

function debtSummary(counts: CommandDebtCounts): string[] {
  return [
    counts.staleTotal === 0
      ? "no stale queue or blocker debt"
      : `${counts.staleTotal} stale command debt item${
          counts.staleTotal === 1 ? "" : "s"
        }`,
    counts.staleActive === 0
      ? `healthy active backlog queued=${counts.healthyQueued} running=${counts.healthyRunning}`
      : `stale active backlog queued=${counts.staleQueued} running=${counts.staleRunning}`,
    counts.staleApproval + counts.stalePolicy === 0
      ? "no stale approval/policy blockers"
      : `stale blockers approval=${counts.staleApproval} policy=${counts.stalePolicy}`,
  ];
}

function commandAgeMs(command: CommandRecord, now: Date): number {
  const updatedAt = Date.parse(command.updatedAt);
  if (Number.isNaN(updatedAt)) return 0;
  return Math.max(0, now.getTime() - updatedAt);
}

function minutes(valueMs: number): number {
  return Math.max(0, Math.round(valueMs / 60_000));
}

function durationLabel(valueMinutes: number): string {
  if (valueMinutes >= 60) {
    const hours = Number((valueMinutes / 60).toFixed(1));
    return `${hours}h`;
  }
  return `${valueMinutes}m`;
}
