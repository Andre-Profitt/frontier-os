import { getLedger } from "../ledger/index.ts";
import type { LedgerEvent, SessionSummary } from "../ledger/events.ts";
import { commandArtifacts, type CommandArtifactFile } from "./artifacts.ts";
import { assessCommandDebt, type CommandDebtAssessment } from "./debt.ts";
import { analyzeCommandExecution } from "./execution.ts";
import { commandOperatorAudit, type CommandOperatorAudit } from "./operator.ts";
import { commandResultPacket, type CommandResultPacket } from "./packet.ts";
import { CommandStore, type CommandRecord } from "./store.ts";

export interface CommandFinalBriefOptions {
  eventLimit?: number;
}

export interface CommandFinalBrief {
  generatedAt: string;
  command: {
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
  };
  summary: string[];
  route: CommandRecord["route"];
  policy: CommandRecord["policy"];
  packet: CommandResultPacket;
  executionPolicy: CommandResultPacket["executionPolicy"];
  failure: CommandResultPacket["failure"];
  debt: CommandDebtAssessment;
  operator: CommandOperatorAudit;
  result: {
    status: string;
    summary: string | null;
    error: string | null;
  };
  activities: Array<{
    activityId: string;
    sequence: number;
    lane: string;
    verb: string;
    status: string;
    attempts: number;
    startedAt: string | null;
    finishedAt: string | null;
  }>;
  artifacts: {
    artifactDir: string | null;
    workGraphPath: string | null;
    files: CommandArtifactFile[];
    dispatchArtifactRefs: string[];
  };
  ledger: {
    sessionIds: string[];
    sessions: SessionSummary[];
    eventCount: number;
    lastEventAt: string | null;
    events: LedgerEvent[];
  };
  recovery: {
    needed: boolean;
    nextAction: string;
    commands: string[];
  };
}

export function commandFinalBrief(
  commandId: string,
  options: CommandFinalBriefOptions = {},
): CommandFinalBrief {
  const eventLimit =
    typeof options.eventLimit === "number" &&
    Number.isFinite(options.eventLimit) &&
    options.eventLimit > 0
      ? Math.min(Math.floor(options.eventLimit), 500)
      : 50;
  const store = new CommandStore();
  try {
    const command = store.get(commandId);
    if (!command) throw new Error(`unknown command: ${commandId}`);
    const ledger = ledgerSlice(command, eventLimit);
    const artifacts = commandArtifacts(commandId);
    const packet = commandResultPacket(commandId);
    const execution = analyzeCommandExecution(command);
    const debt = assessCommandDebt(command);
    const operator = commandOperatorAudit(command, { debt });
    const resultSummary = extractResultSummary(command);
    const recovery = recoveryFor(command, packet, debt);
    return {
      generatedAt: new Date().toISOString(),
      command: {
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
      },
      summary: [
        `${command.status}: ${command.intent}`,
        `${command.lane ?? "unknown"} lane / ${command.verb ?? "unknown verb"}`,
        command.policy
          ? `policy ${command.policy.decision.status}: ${command.policy.decision.reason}`
          : "policy unavailable",
        debt.summary ?? "no stale queue debt",
        operator.lastActionSummary
          ? `operator: ${operator.lastActionSummary}`
          : "operator audit unavailable",
        resultSummary ?? command.error ?? recovery.nextAction,
      ],
      route: command.route,
      policy: command.policy,
      packet,
      executionPolicy: packet.executionPolicy,
      failure: execution.failure,
      debt,
      operator,
      result: {
        status: command.status,
        summary: resultSummary,
        error: command.error,
      },
      activities: command.activities.map((activity) => ({
        activityId: activity.activityId,
        sequence: activity.sequence,
        lane: activity.lane,
        verb: activity.verb,
        status: activity.status,
        attempts: activity.attempts,
        startedAt: activity.startedAt,
        finishedAt: activity.finishedAt,
      })),
      artifacts: {
        artifactDir: artifacts.artifactDir,
        workGraphPath: artifacts.workGraphPath,
        files: artifacts.files,
        dispatchArtifactRefs: artifacts.dispatchArtifactRefs,
      },
      ledger,
      recovery,
    };
  } finally {
    store.close();
  }
}

function ledgerSlice(
  command: CommandRecord,
  limit: number,
): CommandFinalBrief["ledger"] {
  const ledger = getLedger();
  const sessionIds = [
    `command-${command.commandId}`,
    `command-worker-${command.commandId}`,
    ...(command.plan?.workGraphPath ? [`workgraph-wg_${command.commandId}`] : []),
  ];
  const sessions = sessionIds
    .map((sessionId) => ledger.getSessionSummary(sessionId))
    .filter((session): session is SessionSummary => session !== null);
  const events = sessionIds
    .flatMap((sessionId) => ledger.getEvents(sessionId, { limit }))
    .sort((a, b) => a.ts.localeCompare(b.ts))
    .slice(-limit);
  return {
    sessionIds,
    sessions,
    eventCount: events.length,
    lastEventAt: events.at(-1)?.ts ?? null,
    events,
  };
}

function extractResultSummary(command: CommandRecord): string | null {
  if (command.result === null) return null;
  const summary = command.result.summary;
  if (typeof summary === "string" && summary.length > 0) return summary;
  const output = command.result.output;
  if (isRecord(output)) {
    const outputSummary = output.summary;
    if (typeof outputSummary === "string" && outputSummary.length > 0) {
      return outputSummary;
    }
    const status = output.status;
    if (typeof status === "string" && status.length > 0) return status;
  }
  return null;
}

function recoveryFor(
  command: CommandRecord,
  packet: CommandResultPacket,
  debt: CommandDebtAssessment,
): CommandFinalBrief["recovery"] {
  if (command.status === "completed") {
    return {
      needed: false,
      nextAction: "No recovery needed.",
      commands: [`frontier command artifacts ${command.commandId} --json`],
    };
  }
  if (command.status === "blocked_approval") {
    if (command.verb === "ops.repair_launchagent") {
      const label = opsRepairLabel(command, packet);
      const resumeCommand =
        command.interrupt?.resume.cli ??
        `frontier command resume ${command.commandId} --approval ${command.traceId} --json`;
      return {
        needed: true,
        nextAction: debt.stale
          ? `LaunchAgent repair for ${label} is waiting on a stale approval trace; consume the grant if it exists or requeue the repair.`
          : `LaunchAgent repair for ${label} needs a class-2 approval before Frontier can restart the allowlisted service.`,
        commands: [
          "frontier approval list --json",
          resumeCommand,
          `frontier ops status --json`,
          ...(debt.stale
            ? [`frontier command requeue ${command.commandId} --json`]
            : []),
        ],
      };
    }
    const resumeCommand =
      command.interrupt?.resume.cli ??
      `frontier command resume ${command.commandId} --approval ${command.traceId} --json`;
    return {
      needed: true,
      nextAction: debt.stale
        ? "Approval wait is stale; consume the grant if it exists or requeue to mint a fresh trace."
        : "Approve the pending trace, then let the worker resume it.",
      commands: [
        "frontier approval list --json",
        resumeCommand,
        ...(debt.stale
          ? [`frontier command requeue ${command.commandId} --json`]
          : []),
      ],
    };
  }
  if (command.status === "blocked_policy") {
    return {
      needed: true,
      nextAction: "Policy denied this command; revise the intent or add an explicit approved policy path.",
      commands: [
        `frontier command events ${command.commandId} --limit 50 --json`,
        `frontier command submit --intent ${JSON.stringify(command.intent)} --dry-run --json --local`,
      ],
    };
  }
  if (command.status === "failed") {
    if (packet.failure.kind === "verifier_failed") {
      const verifierCheck = firstFailedVerificationCheck(packet);
      const verifierCommands = [
        `frontier command retry ${command.commandId} --json`,
        `frontier command final-brief ${command.commandId} --event-limit 100 --json`,
        `frontier command packet ${command.commandId} --json`,
        `frontier command events ${command.commandId} --limit 100 --json`,
      ];
      if (
        verifierCheck?.name === "human_review" &&
        typeof verifierCheck.evidence?.expectedToken === "string"
      ) {
        verifierCommands.splice(
          1,
          0,
          `touch ${shellQuote(verifierCheck.evidence.expectedToken)}`,
        );
      }
      verifierCommands.splice(
        verifierCommands.length - 2,
        0,
        ...laneDiagnosticCommands(command, packet),
      );
      return {
        needed: true,
        nextAction: verifierRecoveryAction(command, packet),
        commands: uniqueCommands(verifierCommands),
      };
    }
    if (command.lane === "mlx" && packet.failure.kind === "runtime_exceeded") {
      return {
        needed: true,
        nextAction:
          "The MLX workload exceeded its runtime budget; re-check shared workbench readiness and only increase the budget after the host passes doctor/status.",
        commands: [
          `frontier command retry ${command.commandId} --json`,
          "frontier mlx status --json --local",
          "frontier mlx doctor --json --local",
          `frontier command packet ${command.commandId} --json`,
          `frontier command events ${command.commandId} --limit 100 --json`,
        ],
      };
    }
    const laneSpecificRecovery = laneSpecificFailureRecovery(command, packet);
    if (laneSpecificRecovery) return laneSpecificRecovery;
    if (command.verb === "ops.repair_launchagent") {
      const opsStatus = packetPrimaryRecord(packet)?.status;
      const label = opsRepairLabel(command, packet);
      if (opsStatus === "not_installed") {
        return {
          needed: true,
          nextAction: `LaunchAgent repair for ${label} could not run because the plist is not installed; restore the plist before retrying the repair.`,
          commands: [
            `frontier command retry ${command.commandId} --json`,
            "frontier ops status --json",
            `frontier command packet ${command.commandId} --json`,
          ],
        };
      }
      if (opsStatus === "not_found") {
        return {
          needed: true,
          nextAction: `LaunchAgent repair for ${label} is outside the Frontier allowlist; revise the target instead of retrying blindly.`,
          commands: [
            "frontier ops status --json",
            `frontier command packet ${command.commandId} --json`,
            `frontier command show ${command.commandId} --json`,
          ],
        };
      }
      if (packet.failure.kind === "dispatch_failed") {
        return {
          needed: true,
          nextAction: `LaunchAgent repair for ${label} failed during execution; inspect the process tails and current ops status before retrying.`,
          commands: [
            `frontier command retry ${command.commandId} --json`,
            "frontier ops status --json",
            `frontier command packet ${command.commandId} --json`,
            `frontier command events ${command.commandId} --limit 100 --json`,
          ],
        };
      }
    }
    if (packet.failure.kind === "retry_exhausted") {
      return {
        needed: true,
        nextAction: "Retry budget was exhausted; inspect the failure cause before raising retries or requeueing the command.",
        commands: [
          `frontier command retry ${command.commandId} --json`,
          `frontier command packet ${command.commandId} --json`,
          `frontier command events ${command.commandId} --limit 100 --json`,
          `frontier command submit --intent ${JSON.stringify(command.intent)} --dry-run --json --local`,
        ],
      };
    }
    if (packet.failure.kind === "runtime_exceeded") {
      return {
        needed: true,
        nextAction: "The command exceeded its runtime budget; inspect the workload and increase the budget only if the work is healthy.",
        commands: [
          `frontier command retry ${command.commandId} --json`,
          `frontier command packet ${command.commandId} --json`,
          `frontier command events ${command.commandId} --limit 100 --json`,
          `frontier command final-brief ${command.commandId} --event-limit 100 --json`,
        ],
      };
    }
    return {
      needed: true,
      nextAction: "Inspect events/artifacts and feed repeated failures into Refinery.",
      commands: [
        `frontier command retry ${command.commandId} --json`,
        `frontier command events ${command.commandId} --limit 100 --json`,
        `frontier command artifacts ${command.commandId} --json`,
        "frontier refinery harvest --since 2026-04-21T00:00:00Z --limit 2000 --json",
      ],
    };
  }
  if (command.status === "canceled") {
    return {
      needed: true,
      nextAction: "Command was canceled by operator; retry if the work still matters.",
      commands: [
        `frontier command retry ${command.commandId} --json`,
        `frontier command show ${command.commandId} --json`,
      ],
    };
  }
  if (debt.stale) {
    return {
      needed: true,
      nextAction: "Active command is stale; requeue it or cancel it before the queue drifts.",
      commands: [
        `frontier command requeue ${command.commandId} --json`,
        `frontier command cancel ${command.commandId} --json`,
        `frontier command events ${command.commandId} --limit 50 --json`,
      ],
    };
  }
  return {
    needed: false,
    nextAction: "Command is active; wait for worker progress or inspect events.",
    commands: [
      `frontier command show ${command.commandId} --json`,
      `frontier command events ${command.commandId} --limit 50 --json`,
    ],
  };
}

function verifierRecoveryAction(
  command: CommandRecord,
  packet: CommandResultPacket,
): string {
  const check = firstFailedVerificationCheck(packet);
  if (!check) {
    return "Verifier failed; inspect the failing check evidence and rerun once the evidence path is fixed.";
  }
  const summary = failureSummary(command, packet).toLowerCase();
  if (command.lane === "salesforce") {
    if (
      summary.includes("no sf access resolved") ||
      summary.includes("sf_instance_url") ||
      summary.includes("sf_access_token")
    ) {
      return "Salesforce verification failed because no org access is resolved; set the Salesforce credentials or target org before retrying.";
    }
  }
  if (command.lane === "browser") {
    if (summary.includes("9222") || summary.includes("econnrefused")) {
      return "Browser verification failed because Frontier could not reach the CDP endpoint; attach Chrome or Atlas before retrying.";
    }
  }
  if (command.lane === "helper" && command.verb === "logs.read") {
    const path = helperLogPath(packet);
    if (path) {
      return `Verifier rejected the helper log read for ${path}; confirm the target path and helper socket before retrying.`;
    }
  }
  if (
    check.name === "human_review" &&
    typeof check.evidence?.expectedToken === "string"
  ) {
    return `Human review is still missing; create the review token at ${check.evidence.expectedToken} and rerun the command.`;
  }
  if (check.name === "artifact_schema") {
    return "Verifier expected structured output or declared artifacts that were missing; inspect the dispatch payload and artifact paths before retrying.";
  }
  if (check.name === "trace_grade") {
    return `Verifier rejected the execution trace: ${check.reason}`;
  }
  if (check.name === "policy") {
    return "Verifier rejected the side-effect policy for this node; inspect the policy evidence before retrying.";
  }
  return `Verifier failed on ${check.name}: ${check.reason}`;
}

function firstFailedVerificationCheck(
  packet: CommandResultPacket,
): CommandResultPacket["verification"]["checks"][number] | null {
  return packet.verification.checks.find((check) => check.passed === false) ?? null;
}

function packetPrimaryRecord(
  packet: CommandResultPacket,
): Record<string, unknown> | null {
  return isRecord(packet.outputs.primary) ? packet.outputs.primary : null;
}

function opsRepairLabel(
  command: CommandRecord,
  packet: CommandResultPacket,
): string {
  const primary = packetPrimaryRecord(packet);
  if (typeof primary?.label === "string") return primary.label;
  const plannedLabel = command.plan?.action?.args?.[0];
  if (typeof plannedLabel === "string" && plannedLabel.length > 0) {
    return plannedLabel;
  }
  return "the allowlisted LaunchAgent";
}

function laneSpecificFailureRecovery(
  command: CommandRecord,
  packet: CommandResultPacket,
): CommandFinalBrief["recovery"] | null {
  if (command.lane === "project") {
    return projectFailureRecovery(command, packet);
  }
  if (command.lane === "helper") {
    return helperFailureRecovery(command, packet);
  }
  if (command.lane === "browser") {
    return browserFailureRecovery(command, packet);
  }
  if (command.lane === "salesforce") {
    return salesforceFailureRecovery(command, packet);
  }
  if (command.lane === "overnight") {
    return overnightFailureRecovery(command, packet);
  }
  return null;
}

function projectFailureRecovery(
  command: CommandRecord,
  packet: CommandResultPacket,
): CommandFinalBrief["recovery"] | null {
  const directCommand = projectDirectCommand(command);
  if (!directCommand || !command.projectId) return null;
  const verbLabel = projectVerbLabel(command.verb);
  let nextAction =
    `Project ${verbLabel} for ${command.projectId} failed; inspect the manifest and rerun the declared command directly before retrying through Frontier.`;
  if (packet.failure.kind === "retry_exhausted") {
    nextAction =
      `Project ${verbLabel} for ${command.projectId} exhausted retries; reproduce once directly and inspect the manifest before raising retry budget.`;
  } else if (packet.failure.kind === "runtime_exceeded") {
    nextAction =
      `Project ${verbLabel} for ${command.projectId} exceeded its runtime budget; run it directly and only raise the budget after the declared command is healthy.`;
  } else if (packet.failure.kind === "dispatch_failed") {
    nextAction =
      `Project ${verbLabel} for ${command.projectId} failed before Frontier got a clean result; inspect the manifest and rerun the declared command directly.`;
  }
  return {
    needed: true,
    nextAction,
    commands: uniqueCommands([
      directCommand,
      ...laneDiagnosticCommands(command, packet),
      `frontier command retry ${command.commandId} --json`,
      `frontier command packet ${command.commandId} --json`,
      `frontier command events ${command.commandId} --limit 100 --json`,
    ]),
  };
}

function helperFailureRecovery(
  command: CommandRecord,
  packet: CommandResultPacket,
): CommandFinalBrief["recovery"] {
  const path = helperLogPath(packet);
  let nextAction =
    "Helper reachability failed; confirm the helper socket and self-test before retrying the command.";
  if (command.verb === "logs.read") {
    nextAction = path
      ? `Helper log read could not complete for ${path}; confirm the helper socket and the target log path before retrying.`
      : "Helper log read failed; confirm the helper socket and the target log path before retrying.";
  } else if (packet.failure.kind === "runtime_exceeded") {
    nextAction =
      "Helper probe exceeded its runtime budget; confirm helper reachability before raising the budget.";
  }
  return {
    needed: true,
    nextAction,
    commands: uniqueCommands([
      ...laneDiagnosticCommands(command, packet),
      `frontier command retry ${command.commandId} --json`,
      `frontier command packet ${command.commandId} --json`,
      `frontier command events ${command.commandId} --limit 100 --json`,
    ]),
  };
}

function browserFailureRecovery(
  command: CommandRecord,
  packet: CommandResultPacket,
): CommandFinalBrief["recovery"] {
  const summary = failureSummary(command, packet).toLowerCase();
  let nextAction =
    "Browser command failed; confirm an active browser session is attached before retrying.";
  if (summary.includes("9222") || summary.includes("econnrefused")) {
    nextAction =
      "Browser command could not reach the CDP endpoint on 127.0.0.1:9222; attach Chrome or Atlas to Frontier before retrying.";
  } else if (packet.failure.kind === "runtime_exceeded") {
    nextAction =
      "Browser command exceeded its runtime budget; confirm the current CDP session is responsive before raising the budget.";
  }
  return {
    needed: true,
    nextAction,
    commands: uniqueCommands([
      ...laneDiagnosticCommands(command, packet),
      `frontier command retry ${command.commandId} --json`,
      `frontier command packet ${command.commandId} --json`,
      `frontier command events ${command.commandId} --limit 100 --json`,
    ]),
  };
}

function salesforceFailureRecovery(
  command: CommandRecord,
  packet: CommandResultPacket,
): CommandFinalBrief["recovery"] {
  const summary = failureSummary(command, packet).toLowerCase();
  let nextAction =
    `Salesforce ${salesforceVerbLabel(command.verb)} failed; confirm org access and the active dashboard/browser context before retrying.`;
  if (
    summary.includes("no sf access resolved") ||
    summary.includes("sf_instance_url") ||
    summary.includes("sf_access_token")
  ) {
    nextAction =
      `Salesforce ${salesforceVerbLabel(command.verb)} has no resolved org access; set the Salesforce credentials or target org before retrying.`;
  } else if (summary.includes("9222") || summary.includes("econnrefused")) {
    nextAction =
      `Salesforce ${salesforceVerbLabel(command.verb)} could not reach the browser CDP session; attach the intended dashboard tab before retrying.`;
  } else if (packet.failure.kind === "runtime_exceeded") {
    nextAction =
      `Salesforce ${salesforceVerbLabel(command.verb)} exceeded its runtime budget; confirm org access and dashboard responsiveness before raising the budget.`;
  }
  return {
    needed: true,
    nextAction,
    commands: uniqueCommands([
      ...laneDiagnosticCommands(command, packet),
      `frontier command retry ${command.commandId} --json`,
      `frontier command packet ${command.commandId} --json`,
      `frontier command events ${command.commandId} --limit 100 --json`,
    ]),
  };
}

function overnightFailureRecovery(
  command: CommandRecord,
  packet: CommandResultPacket,
): CommandFinalBrief["recovery"] {
  const dryRunReplay =
    command.verb === "overnight.enqueue"
      ? "frontier overnight enqueue --hours 1 --limit 1 --dry-run --json"
      : command.verb === "overnight.brief"
        ? "frontier overnight brief --hours 24 --json"
        : "frontier overnight run --hours 1 --limit 1 --dry-run --json";
  let nextAction =
    "Overnight orchestration failed; inspect the latest overnight brief and rerun a dry-run before queueing live work again.";
  if (packet.failure.kind === "runtime_exceeded") {
    nextAction =
      "Overnight orchestration exceeded its runtime budget; inspect the overnight brief and replay as a dry-run before raising the budget.";
  } else if (command.verb === "overnight.enqueue") {
    nextAction =
      "Overnight queue compilation failed; inspect the latest overnight brief and replay enqueue as a dry-run before queueing live work.";
  }
  return {
    needed: true,
    nextAction,
    commands: uniqueCommands([
      dryRunReplay,
      ...laneDiagnosticCommands(command, packet),
      `frontier command retry ${command.commandId} --json`,
      `frontier command packet ${command.commandId} --json`,
      `frontier command events ${command.commandId} --limit 100 --json`,
    ]),
  };
}

function laneDiagnosticCommands(
  command: CommandRecord,
  packet: CommandResultPacket,
): string[] {
  if (command.lane === "project") {
    const commands = [projectDirectCommand(command)];
    if (command.projectId) {
      commands.push(`frontier project inspect ${command.projectId} --json`);
    }
    return uniqueCommands(commands);
  }
  if (command.lane === "helper") {
    const commands = [
      "frontier helper self-test --json",
      "frontier helper production-status --json",
      "frontier helper production-invoke helper.status --json",
    ];
    const path = helperLogPath(packet);
    if (command.verb === "logs.read" && path) {
      commands.push(
        `frontier helper production-invoke logs.read --path ${shellQuote(path)} --json`,
      );
    }
    return uniqueCommands(commands);
  }
  if (command.lane === "browser") {
    return [
      "frontier adapter invoke browser list-tabs --mode read --json",
      "frontier adapter invoke browser current-tab --mode read --json",
      "frontier adapter invoke browser inspect-network --mode read --json",
    ];
  }
  if (command.lane === "salesforce") {
    if (command.verb === "salesforce.portfolio_summary") {
      return [
        "frontier adapter invoke salesforce portfolio-inventory --mode read --json",
      ];
    }
    if (command.verb === "salesforce.inspect_report") {
      return [
        "frontier adapter invoke salesforce inspect-report --mode read --json",
        "frontier adapter invoke browser current-tab --mode read --json",
      ];
    }
    return [
      "frontier adapter invoke salesforce inspect-dashboard --mode read --json",
      "frontier adapter invoke salesforce list-filters --mode read --json",
      "frontier adapter invoke browser current-tab --mode read --json",
    ];
  }
  if (command.lane === "overnight") {
    return [
      "frontier overnight brief --hours 24 --json",
      "frontier overnight plan --hours 1 --json",
    ];
  }
  return [];
}

function projectDirectCommand(command: CommandRecord): string | null {
  if (!command.projectId) return null;
  if (command.verb === "project.status") {
    return `frontier project status ${command.projectId} --json`;
  }
  if (command.verb === "project.verify") {
    return `frontier project verify ${command.projectId} --json`;
  }
  if (command.verb === "project.smoke") {
    return `frontier project smoke ${command.projectId} --json`;
  }
  return null;
}

function projectVerbLabel(verb: string | null): string {
  if (verb === "project.verify") return "verify";
  if (verb === "project.smoke") return "smoke";
  if (verb === "project.status") return "status";
  return "command";
}

function salesforceVerbLabel(verb: string | null): string {
  if (verb === "salesforce.inspect_dashboard") return "dashboard inspect";
  if (verb === "salesforce.inspect_report") return "report inspect";
  if (verb === "salesforce.list_filters") return "filter inventory";
  if (verb === "salesforce.audit_dashboard") return "dashboard audit";
  if (verb === "salesforce.set_report_filter") return "report filter update";
  if (verb === "salesforce.set_filter") return "filter update";
  if (verb === "salesforce.enter_edit_mode") return "enter edit mode";
  if (verb === "salesforce.move_widget") return "move widget";
  if (verb === "salesforce.save_dashboard") return "save dashboard";
  if (verb === "salesforce.portfolio_summary") return "portfolio inventory";
  return "dashboard command";
}

function helperLogPath(packet: CommandResultPacket): string | null {
  const primary = packetPrimaryRecord(packet);
  const body = isRecord(primary?.body) ? primary.body : null;
  if (typeof body?.path === "string" && body.path.length > 0) {
    return body.path;
  }
  if (typeof primary?.requestPath === "string") {
    const queryIndex = primary.requestPath.indexOf("?");
    if (queryIndex >= 0) {
      const params = new URLSearchParams(primary.requestPath.slice(queryIndex + 1));
      const path = params.get("path");
      if (path && path.length > 0) return path;
    }
  }
  return null;
}

function failureSummary(
  command: CommandRecord,
  packet: CommandResultPacket,
): string {
  return (
    packetPrimarySummary(packet) ??
    packet.outputs.adapterDispatches.find(
      (dispatch) =>
        typeof dispatch.resultSummary === "string" &&
        dispatch.resultSummary.length > 0,
    )?.resultSummary ??
    packet.failure.summary ??
    packet.execution.error ??
    command.error ??
    packet.execution.summary ??
    ""
  );
}

function packetPrimarySummary(packet: CommandResultPacket): string | null {
  const primary = packetPrimaryRecord(packet);
  if (typeof primary?.summary === "string" && primary.summary.length > 0) {
    return primary.summary;
  }
  return null;
}

function uniqueCommands(
  commands: Array<string | null | undefined>,
): string[] {
  const seen = new Set<string>();
  const next: string[] = [];
  for (const command of commands) {
    if (typeof command !== "string") continue;
    const normalized = command.trim();
    if (normalized.length === 0 || seen.has(normalized)) continue;
    seen.add(normalized);
    next.push(normalized);
  }
  return next;
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\"'\"'`)}'`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
