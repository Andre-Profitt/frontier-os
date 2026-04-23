import { spawnSync } from "node:child_process";

import { closeLedger, getLedger } from "../ledger/index.ts";
import {
  buildActionEnvelope,
  evaluatePolicyAction,
  type PolicyEvaluation,
} from "../policy/evaluator.ts";
import { type ProjectCommandSpec } from "../schemas.ts";
import { findProjectManifest } from "./registry.ts";

export type ProjectCommandKind = "verify" | "smoke" | "dev";

export interface ProjectCommandRunOptions {
  dryRun?: boolean;
  consumeApproval?: boolean;
}

export interface ProjectCommandRunResult {
  projectId: string;
  command: ProjectCommandKind;
  status:
    | "planned"
    | "passed"
    | "failed"
    | "denied"
    | "requires_approval"
    | "not_declared";
  argv: string[] | null;
  cwd: string | null;
  durationMs: number;
  policy: PolicyEvaluation | null;
  process: {
    status: number | null;
    signal: string | null;
    timedOut: boolean;
    error: string | null;
    stdoutTail: string;
    stderrTail: string;
  } | null;
}

export function runProjectCommand(
  projectId: string,
  command: ProjectCommandKind,
  options: ProjectCommandRunOptions = {},
): ProjectCommandRunResult {
  const startedAt = Date.now();
  const manifest = findProjectManifest(projectId);
  const spec = manifest.commands[command] as ProjectCommandSpec | undefined;
  if (!spec) {
    return {
      projectId,
      command,
      status: "not_declared",
      argv: null,
      cwd: null,
      durationMs: Date.now() - startedAt,
      policy: null,
      process: null,
    };
  }

  const cwd = spec.cwd ?? manifest.root;
  const action = buildActionEnvelope({
    actor: "project-runner",
    source: "project",
    projectId,
    verb: `project.${command}`,
    arguments: { argv: spec.argv, cwd },
    approvalClass: spec.approvalClass,
    sideEffects: spec.sideEffectClass === "none" ? [] : [spec.sideEffectClass],
  });
  const policy = evaluatePolicyAction(action, {
    consumeApproval: options.consumeApproval === true,
  });
  appendProjectEvent("project.command_start", action.traceId, {
    projectId,
    command,
    argv: spec.argv,
    cwd,
    dryRun: options.dryRun === true,
    policy,
  });

  if (policy.decision.status !== "allow") {
    const status =
      policy.decision.status === "requires_approval"
        ? "requires_approval"
        : "denied";
    const result: ProjectCommandRunResult = {
      projectId,
      command,
      status,
      argv: spec.argv,
      cwd,
      durationMs: Date.now() - startedAt,
      policy,
      process: null,
    };
    appendProjectEvent(
      "project.command_end",
      action.traceId,
      result as unknown as Record<string, unknown>,
    );
    closeLedger();
    return result;
  }

  if (options.dryRun === true) {
    const result: ProjectCommandRunResult = {
      projectId,
      command,
      status: "planned",
      argv: spec.argv,
      cwd,
      durationMs: Date.now() - startedAt,
      policy,
      process: null,
    };
    appendProjectEvent(
      "project.command_end",
      action.traceId,
      result as unknown as Record<string, unknown>,
    );
    closeLedger();
    return result;
  }

  const [bin, ...args] = spec.argv;
  if (!bin) throw new Error(`project ${projectId} ${command} argv is empty`);
  const spawned = spawnSync(bin, args, {
    cwd,
    encoding: "utf8",
    timeout: (spec.timeoutSeconds ?? 120) * 1000,
    env: process.env,
  });
  const result: ProjectCommandRunResult = {
    projectId,
    command,
    status: spawned.status === 0 ? "passed" : "failed",
    argv: spec.argv,
    cwd,
    durationMs: Date.now() - startedAt,
    policy,
    process: {
      status: spawned.status,
      signal: spawned.signal,
      timedOut: spawned.error?.message.includes("ETIMEDOUT") ?? false,
      error: spawned.error?.message ?? null,
      stdoutTail: tail(spawned.stdout ?? ""),
      stderrTail: tail(spawned.stderr ?? ""),
    },
  };
  appendProjectEvent(
    "project.command_end",
    action.traceId,
    result as unknown as Record<string, unknown>,
  );
  closeLedger();
  return result;
}

function appendProjectEvent(
  kind: "project.command_start" | "project.command_end",
  traceId: string,
  payload: Record<string, unknown>,
): void {
  const ledger = getLedger();
  const sessionId = `project-runner-${traceId}`;
  ledger.ensureSession({
    sessionId,
    label: "project-runner",
    tags: ["project", "runner"],
  });
  ledger.appendEvent({
    sessionId,
    kind,
    actor: "project-runner",
    traceId,
    payload,
  });
}

function tail(value: string, max = 8_000): string {
  return value.length > max ? value.slice(-max) : value;
}
