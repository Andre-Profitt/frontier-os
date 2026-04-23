import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

import type { WorkGraph, WorkNode } from "../work/graph.ts";
import { analyzeCommandExecution } from "./execution.ts";
import { commandReadiness } from "./readiness.ts";
import { CommandStore, type CommandRecord } from "./store.ts";
import { runCommandWorkerOnce } from "./worker.ts";

export interface CommandSmokeResult {
  status: "ok" | "failed";
  submitted: string;
  shown: boolean;
  listed: boolean;
  commandStatus: string;
  denialChecks: Array<{
    intent: string;
    status: string;
    verb: string;
    approvalClass: number;
    decision: string;
    blocked: boolean;
  }>;
  baselineReadiness: {
    status: string;
    unresolvedFailures: number;
  };
  retryScenario: CommandSmokeScenarioResult;
  verifierScenario: CommandSmokeScenarioResult;
  finalReadiness: {
    status: string;
    unresolvedFailures: number;
  };
}

interface CommandSmokeScenarioResult {
  name: string;
  commandId: string;
  failureKind: string;
  failureStatus: string;
  attempts: number | null;
  maxAttempts: number | null;
  readinessStatus: string;
  readinessCheckStatus: string | null;
  resolvedBy: string;
  unresolvedCleared: boolean;
  ok: boolean;
}

export async function commandSmoke(): Promise<CommandSmokeResult> {
  const store = new CommandStore();
  try {
    const baselineReadiness = commandReadiness({ hours: 24, limit: 200 });
    const submitted = store.submit({
      intent: "status frontier-os",
      projectId: "frontier-os",
      actorId: "command-smoke",
      surface: "automation",
      origin: "frontier-command-smoke",
    });
    const shown = store.get(submitted.commandId);
    const listed = store
      .list({ limit: 10 })
      .some((command) => command.commandId === submitted.commandId);
    const denialChecks = [
      {
        intent: "delete everything in Downloads",
        expectedVerb: "filesystem.delete",
      },
      {
        intent: "restart com.apple.WindowServer",
        expectedVerb: "service.restart",
      },
    ].map((check) => {
      const explained = store.explain({
        intent: check.intent,
        actorId: "command-smoke",
        surface: "automation",
        origin: "frontier-command-smoke",
      });
      return {
        intent: check.intent,
        status: explained.status,
        verb: explained.route.verb,
        approvalClass: explained.route.approvalClass,
        decision: explained.policy.decision.status,
        blocked:
          explained.status === "blocked_policy" &&
          explained.route.verb === check.expectedVerb &&
          explained.route.approvalClass === 3 &&
          explained.policy.decision.status === "deny" &&
          explained.plan.action === null,
      };
    });
    store.cancel(submitted.commandId, "command-smoke");

    const smokeId = Date.now().toString(36);
    const retryScenario = await runScenario(store, {
      name: "retry_exhaustion",
      intent: `status command-retrycase-${smokeId}`,
      projectId: `command-retrycase-${smokeId}`,
      readinessCheckId: "retry_budget",
      expectedReadinessCheckStatus: "warn",
      expectedFailureKind: "retry_exhausted",
      failureNode: retryFailureNode(),
      recoveryNode: successNode("status command recovered"),
    });
    const verifierScenario = await runScenario(store, {
      name: "verifier_failure",
      intent: `verify command-verifiercase-${smokeId}`,
      projectId: `command-verifiercase-${smokeId}`,
      readinessCheckId: "verification",
      expectedReadinessCheckStatus: "fail",
      expectedFailureKind: "verifier_failed",
      failureNode: verifierFailureNode(),
      recoveryNode: verifiedSuccessNode(),
    });

    const finalReadiness = commandReadiness({ hours: 24, limit: 200 });
    const ok =
      shown !== null &&
      listed &&
      submitted.status === "queued" &&
      denialChecks.every((check) => check.blocked) &&
      retryScenario.ok &&
      verifierScenario.ok &&
      !finalReadiness.brief.unresolvedFailures.some(
        (failure) =>
          failure.commandId === retryScenario.commandId ||
          failure.commandId === verifierScenario.commandId,
      );

    return {
      status: ok ? "ok" : "failed",
      submitted: submitted.commandId,
      shown: shown !== null,
      listed,
      commandStatus: submitted.status,
      denialChecks,
      baselineReadiness: {
        status: baselineReadiness.status,
        unresolvedFailures: baselineReadiness.brief.unresolvedFailures.length,
      },
      retryScenario,
      verifierScenario,
      finalReadiness: {
        status: finalReadiness.status,
        unresolvedFailures: finalReadiness.brief.unresolvedFailures.length,
      },
    };
  } finally {
    store.close();
  }
}

async function runScenario(
  store: CommandStore,
  input: {
    name: string;
    intent: string;
    projectId: string;
    readinessCheckId: string;
    expectedReadinessCheckStatus: "warn" | "fail";
    expectedFailureKind: string;
    failureNode: WorkNode;
    recoveryNode: WorkNode;
  },
): Promise<CommandSmokeScenarioResult> {
  const failingCommand = store.submit({
    intent: input.intent,
    projectId: input.projectId,
    actorId: "command-smoke",
    surface: "automation",
    origin: "frontier-command-smoke",
  });
  writeScenarioGraph(failingCommand, input.failureNode);
  await runCommandWorkerOnce({
    commandId: failingCommand.commandId,
    workerId: `command-smoke-${input.name}-fail`,
  });
  const failed = requireCommand(store.get(failingCommand.commandId));
  const failure = analyzeCommandExecution(failed);
  const readinessAfterFailure = commandReadiness({ hours: 24, limit: 200 });
  const readinessCheckStatus =
    readinessAfterFailure.checks.find((check) => check.id === input.readinessCheckId)
      ?.status ?? null;

  const resolvedBy = store.submit({
    intent: input.intent,
    projectId: input.projectId,
    actorId: "command-smoke",
    surface: "automation",
    origin: "frontier-command-smoke",
  });
  writeScenarioGraph(resolvedBy, input.recoveryNode);
  await runCommandWorkerOnce({
    commandId: resolvedBy.commandId,
    workerId: `command-smoke-${input.name}-recover`,
  });
  const readinessAfterRecovery = commandReadiness({ hours: 24, limit: 200 });
  const unresolvedCleared = !readinessAfterRecovery.brief.unresolvedFailures.some(
    (item) => item.commandId === failingCommand.commandId,
  );
  return {
    name: input.name,
    commandId: failingCommand.commandId,
    failureKind: failure.failure.kind,
    failureStatus: failed.status,
    attempts: failure.failure.attempts,
    maxAttempts: failure.failure.maxAttempts,
    readinessStatus: readinessAfterFailure.status,
    readinessCheckStatus,
    resolvedBy: resolvedBy.commandId,
    unresolvedCleared,
    ok:
      failed.status === "failed" &&
      failure.failure.kind === input.expectedFailureKind &&
      readinessCheckStatus === input.expectedReadinessCheckStatus &&
      unresolvedCleared,
  };
}

function writeScenarioGraph(command: CommandRecord, node: WorkNode): void {
  const path = command.plan?.workGraphPath;
  if (!path) throw new Error(`command ${command.commandId} has no work graph path`);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(buildGraph(command, node), null, 2) + "\n");
}

function buildGraph(command: CommandRecord, node: WorkNode): WorkGraph {
  return {
    graphId: `wg_${command.commandId}`,
    version: "v1",
    goal: command.intent,
    tenantId: "personal",
    createdAt: command.requestedAt,
    updatedAt: new Date().toISOString(),
    priority: "normal",
    status: "planned",
    approvalPolicy: {
      defaultClass: 0,
      requireHumanFor: [],
    },
    labels: ["command", command.commandId, "command-smoke"],
    entryIntent: {
      intentId: command.commandId,
      intentType: "frontier.command",
      surfaceChannel: "automation",
    },
    context: {
      commandId: command.commandId,
      traceId: command.traceId,
      projectId: command.projectId,
      lane: command.lane,
      verb: command.verb,
    },
    nodes: [{ ...node, traceId: command.traceId }],
  };
}

function retryFailureNode(): WorkNode {
  return {
    nodeId: "action",
    kind: "dispatch",
    title: "retry exhaustion smoke",
    status: "queued",
    priority: "normal",
    runtime: {
      plane: "linux",
      executor: "native_cli",
    },
    approvalClass: 0,
    dependencies: [],
    allowedTools: ["frontier"],
    verifierPolicy: { mode: "none" },
    sideEffects: ["none"],
    inputs: [
      {
        type: "structured_payload",
        value: {
          cli: {
            command: "/bin/sh",
            args: ["-lc", "exit 7"],
            cwd: "/Users/test/frontier-os",
            timeoutMs: 2_000,
          },
        },
      },
    ],
    retryPolicy: {
      maxAttempts: 2,
      backoffMs: 5,
      retryOnFailed: true,
    },
  };
}

function verifierFailureNode(): WorkNode {
  return {
    nodeId: "action",
    kind: "test_run",
    title: "verifier failure smoke",
    status: "queued",
    priority: "normal",
    runtime: {
      plane: "linux",
      executor: "native_cli",
    },
    approvalClass: 1,
    dependencies: [],
    allowedTools: ["frontier"],
    verifierPolicy: {
      mode: "required",
      checks: ["human_review"],
    },
    sideEffects: ["local_write"],
    inputs: [
      {
        type: "structured_payload",
        value: {
          cli: {
            command: "/bin/sh",
            args: ["-lc", "printf '%s\\n' '{\"status\":\"ok\",\"servedBy\":\"smoke\"}'"],
            cwd: "/Users/test/frontier-os",
            timeoutMs: 2_000,
          },
        },
      },
    ],
    retryPolicy: {
      maxAttempts: 1,
      backoffMs: 5,
      retryOnFailed: true,
    },
  };
}

function successNode(summary: string): WorkNode {
  return {
    nodeId: "action",
    kind: "repo_analysis",
    title: "recovery success smoke",
    status: "queued",
    priority: "normal",
    runtime: {
      plane: "linux",
      executor: "native_cli",
    },
    approvalClass: 0,
    dependencies: [],
    allowedTools: ["frontier"],
    verifierPolicy: { mode: "none" },
    sideEffects: ["none"],
    inputs: [
      {
        type: "structured_payload",
        value: {
          cli: {
            command: "/bin/sh",
            args: ["-lc", `printf '%s\\n' '{"status":"ok","summary":"${summary}"}'`],
            cwd: "/Users/test/frontier-os",
            timeoutMs: 2_000,
          },
        },
      },
    ],
    retryPolicy: {
      maxAttempts: 1,
      backoffMs: 5,
      retryOnFailed: true,
    },
  };
}

function verifiedSuccessNode(): WorkNode {
  return {
    nodeId: "action",
    kind: "test_run",
    title: "verifier recovery smoke",
    status: "queued",
    priority: "normal",
    runtime: {
      plane: "linux",
      executor: "native_cli",
    },
    approvalClass: 1,
    dependencies: [],
    allowedTools: ["frontier"],
    verifierPolicy: {
      mode: "required",
      checks: ["artifact_schema"],
    },
    sideEffects: ["local_write"],
    inputs: [
      {
        type: "structured_payload",
        value: {
          cli: {
            command: "/bin/sh",
            args: ["-lc", "printf '%s\\n' '{\"status\":\"ok\",\"servedBy\":\"smoke\"}'"],
            cwd: "/Users/test/frontier-os",
            timeoutMs: 2_000,
          },
        },
      },
    ],
    retryPolicy: {
      maxAttempts: 1,
      backoffMs: 5,
      retryOnFailed: true,
    },
  };
}

function requireCommand(command: CommandRecord | null): CommandRecord {
  if (!command) throw new Error("command not found");
  return command;
}
