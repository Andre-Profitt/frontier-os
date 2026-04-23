import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";

import { getLedger } from "../ledger/index.ts";
import {
  buildActionEnvelope,
  evaluatePolicyAction,
  type PolicyEvaluation,
} from "../policy/evaluator.ts";
import { runReadOnlyCommand } from "../system/probes.ts";
import { opsStatus } from "./status.ts";

export interface LaunchAgentRepairOptions {
  label: string;
  execute?: boolean;
  traceId?: string;
  consumeApproval?: boolean;
}

export interface LaunchAgentRepairResult {
  status:
    | "planned"
    | "repaired"
    | "failed"
    | "requires_approval"
    | "denied"
    | "not_found"
    | "not_installed";
  generatedAt: string;
  label: string;
  dryRun: boolean;
  traceId: string;
  policy: PolicyEvaluation;
  before: LaunchAgentRepairTarget | null;
  after: LaunchAgentRepairTarget | null;
  commands: RepairCommand[];
  process: Array<{
    command: string;
    args: string[];
    status: number | null;
    signal: string | null;
    error: string | null;
    stdoutTail: string;
    stderrTail: string;
  }>;
  error: string | null;
}

interface LaunchAgentRepairTarget {
  label: string;
  required: boolean;
  source: string;
  plistPath: string;
  installed: boolean;
  loaded: boolean;
  pid: number | null;
  lastExitStatus: number | null;
}

interface RepairCommand {
  command: string;
  args: string[];
  purpose: string;
  mutates: boolean;
}

export async function repairLaunchAgent(
  options: LaunchAgentRepairOptions,
): Promise<LaunchAgentRepairResult> {
  const generatedAt = new Date().toISOString();
  const dryRun = options.execute !== true;
  const traceId =
    options.traceId ??
    `ops-repair-${Date.now().toString(36)}-${Math.random()
      .toString(36)
      .slice(2, 8)}`;
  const before = await findTarget(options.label);
  const action = buildActionEnvelope({
    actor: "ops-repair",
    source: "ops",
    projectId: "frontier-os",
    verb: "ops.repair_launchagent",
    approvalClass: 2,
    arguments: {
      label: options.label,
      execute: options.execute === true,
      plistPath: before?.plistPath ?? null,
    },
    traceId,
  });
  const policy = evaluatePolicyAction(action, {
    consumeApproval: options.execute === true && options.consumeApproval === true,
  });

  const commands = before ? commandsFor(before) : [];
  appendRepairEvent("ops.repair_start", traceId, {
    label: options.label,
    dryRun,
    before,
    commands,
    policy,
  });

  if (!before) {
    return finish({
      status: "not_found",
      generatedAt,
      label: options.label,
      dryRun,
      traceId,
      policy,
      before: null,
      after: null,
      commands,
      process: [],
      error: `launch agent is not in Frontier allowlist: ${options.label}`,
    });
  }
  if (!before.installed || !existsSync(before.plistPath)) {
    return finish({
      status: "not_installed",
      generatedAt,
      label: options.label,
      dryRun,
      traceId,
      policy,
      before,
      after: before,
      commands,
      process: [],
      error: `launch agent plist is not installed: ${before.plistPath}`,
    });
  }
  if (dryRun) {
    return finish({
      status: "planned",
      generatedAt,
      label: options.label,
      dryRun,
      traceId,
      policy,
      before,
      after: before,
      commands,
      process: [],
      error: null,
    });
  }
  if (policy.decision.status !== "allow") {
    return finish({
      status:
        policy.decision.status === "requires_approval"
          ? "requires_approval"
          : "denied",
      generatedAt,
      label: options.label,
      dryRun,
      traceId,
      policy,
      before,
      after: before,
      commands,
      process: [],
      error: policy.decision.reason,
    });
  }

  const processResults = commands.map(runCommand);
  const failed = processResults.find((result) => result.status !== 0);
  const after = await findTarget(options.label);
  return finish({
    status: failed || !after?.loaded ? "failed" : "repaired",
    generatedAt,
    label: options.label,
    dryRun,
    traceId,
    policy,
    before,
    after,
    commands,
    process: processResults,
    error: failed
      ? failed.stderrTail || failed.error || `${failed.command} exited ${failed.status}`
      : after?.loaded
        ? null
        : "launch agent is still not loaded after repair command",
  });
}

async function findTarget(label: string): Promise<LaunchAgentRepairTarget | null> {
  const ops = await opsStatus();
  const target = ops.launchAgents.find((agent) => agent.label === label);
  if (!target) return null;
  return {
    label: target.label,
    required: target.required,
    source: target.source,
    plistPath: target.plistPath,
    installed: target.installed,
    loaded: target.loaded,
    pid: target.pid,
    lastExitStatus: target.lastExitStatus,
  };
}

function commandsFor(target: LaunchAgentRepairTarget): RepairCommand[] {
  const domain = `gui/${process.getuid?.() ?? 0}`;
  const commands: RepairCommand[] = [
    {
      command: "/usr/bin/plutil",
      args: ["-lint", target.plistPath],
      purpose: "validate launch agent plist before mutation",
      mutates: false,
    },
  ];
  if (target.loaded) {
    commands.push({
      command: "/bin/launchctl",
      args: ["kickstart", "-k", `${domain}/${target.label}`],
      purpose: "restart allowlisted user LaunchAgent",
      mutates: true,
    });
  } else {
    commands.push({
      command: "/bin/launchctl",
      args: ["bootstrap", domain, target.plistPath],
      purpose: "load allowlisted user LaunchAgent",
      mutates: true,
    });
    commands.push({
      command: "/bin/launchctl",
      args: ["kickstart", "-k", `${domain}/${target.label}`],
      purpose: "start allowlisted user LaunchAgent after bootstrap",
      mutates: true,
    });
  }
  return commands;
}

function runCommand(command: RepairCommand): LaunchAgentRepairResult["process"][number] {
  const result = command.command === "/usr/bin/plutil"
    ? runReadOnlyCommand(command.command, command.args, { timeoutMs: 10_000 })
    : spawnSync(command.command, command.args, {
        encoding: "utf8",
        timeout: 30_000,
      });
  if ("ok" in result) {
    return {
      command: command.command,
      args: command.args,
      status: result.status,
      signal: null,
      error: result.error ?? null,
      stdoutTail: tail(result.stdout),
      stderrTail: tail(result.stderr),
    };
  }
  return {
    command: command.command,
    args: command.args,
    status: result.status,
    signal: result.signal,
    error: result.error?.message ?? null,
    stdoutTail: tail(result.stdout ?? ""),
    stderrTail: tail(result.stderr ?? ""),
  };
}

function finish(result: LaunchAgentRepairResult): LaunchAgentRepairResult {
  appendRepairEvent("ops.repair_end", result.traceId, {
    label: result.label,
    status: result.status,
    dryRun: result.dryRun,
    error: result.error,
    after: result.after,
  });
  return result;
}

function appendRepairEvent(
  kind: "ops.repair_start" | "ops.repair_end",
  traceId: string,
  payload: Record<string, unknown>,
): void {
  const ledger = getLedger();
  const sessionId = `ops-repair-${traceId}`;
  ledger.ensureSession({
    sessionId,
    label: "ops-repair",
    tags: ["ops", "repair"],
  });
  ledger.appendEvent({
    sessionId,
    kind,
    actor: "ops-repair",
    traceId,
    payload,
  });
}

function tail(value: string, max = 8_000): string {
  return value.length > max ? value.slice(-max) : value;
}
