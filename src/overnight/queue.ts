import { randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, resolve } from "node:path";

import {
  assessCommandDebt,
  commandDebtFromCommands,
  commandOperatorAction,
  type CommandDebtReport,
} from "../commands/debt.ts";
import { CommandStore, type CommandRecord } from "../commands/store.ts";
import { defaultQueueDir, enqueue, runShift, type ShiftSummary } from "../ghost/shift.ts";
import { assessGraph, type SafetyVerdict } from "../ghost/safety.ts";
import { getLedger } from "../ledger/index.ts";
import { newSessionId } from "../ledger/events.ts";
import { validateWorkGraph } from "../schemas.ts";
import { prepare, type SideEffectClass, type WorkGraph, type WorkNode } from "../work/graph.ts";
import { overnightPlan, type OvernightPlanResult, type OvernightPlannedAction } from "./plan.ts";

export interface OvernightQueueOptions {
  hours?: number;
  dryRun?: boolean;
  queueDir?: string;
  graphDir?: string;
  maxGraphs?: number;
}

export interface OvernightCompiledGraph {
  sequence: number;
  projectId: string;
  actionId: string;
  graphId: string;
  status: "ready" | "invalid" | "unsafe" | "unsupported";
  path: string | null;
  queuedPath: string | null;
  validation: {
    ok: boolean;
    errors: unknown;
  };
  safety: SafetyVerdict | null;
  reason: string | null;
  graph: WorkGraph;
}

export interface OvernightQueueResult {
  status: "planned" | "queued" | "partial";
  dryRun: boolean;
  runId: string;
  generatedAt: string;
  hours: number;
  queueDir: string;
  graphDir: string | null;
  preflight: OvernightDebtPreflight;
  plan: Pick<
    OvernightPlanResult,
    | "status"
    | "projectCount"
    | "attentionCount"
    | "actionCount"
    | "scheduledCount"
    | "blockedCount"
    | "usedMinutes"
    | "capacityMinutes"
  >;
  laneSummary: OvernightLaneSummary[];
  graphCount: number;
  readyCount: number;
  queuedCount: number;
  skippedCount: number;
  graphs: OvernightCompiledGraph[];
}

export interface OvernightRunOptions extends OvernightQueueOptions {
  maxConcurrent?: number;
  maxRetries?: number;
}

export interface OvernightRunResult {
  status: "planned" | "completed" | "failed" | "blocked" | "partial";
  dryRun: boolean;
  runId: string;
  queue: OvernightQueueResult;
  shift: ShiftSummary | null;
}

export interface OvernightLaneSummary {
  lane: string;
  graphCount: number;
  readyCount: number;
  queuedCount: number;
  skippedCount: number;
  projectCount: number;
  projects: string[];
  topVerbs: Array<{
    verb: string;
    count: number;
  }>;
}

export interface OvernightDebtPreflightAction {
  commandId: string;
  traceId: string;
  status: string;
  lane: string | null;
  verb: string | null;
  debtKind: string;
  debtSummary: string | null;
  ageMinutes: number;
  action: string | null;
  actionCommand: string | null;
  automated: boolean;
  outcome: "planned" | "requeued" | "manual_attention";
  reason: string | null;
  sourceCommandId: string | null;
  replacementCommandId: string | null;
  replacementTraceId: string | null;
}

export interface OvernightDebtPreflight {
  generatedAt: string;
  status: "clear" | "planned" | "remediated" | "attention";
  summary: string[];
  inspectedCount: number;
  staleCount: number;
  automatedCount: number;
  manualAttentionCount: number;
  before: CommandDebtReport;
  after: CommandDebtReport | null;
  actions: OvernightDebtPreflightAction[];
}

const FRONTIER_BIN = "/Users/test/frontier-os/bin/frontier";

export async function enqueueOvernightPlan(
  options: OvernightQueueOptions = {},
): Promise<OvernightQueueResult> {
  const result = await compileOvernightGraphs({
    ...options,
    queueDir: options.queueDir ?? defaultQueueDir(),
  });
  appendOvernightQueueEvent("overnight.enqueue", result);
  return result;
}

export async function runOvernightPlan(
  options: OvernightRunOptions = {},
): Promise<OvernightRunResult> {
  const runId = newRunId();
  const queueDir =
    options.queueDir ?? resolve(homedir(), ".frontier", "overnight", "run-queues", runId);
  const graphDir =
    options.graphDir ?? resolve(homedir(), ".frontier", "overnight", "graphs", runId);
  const queue = await compileOvernightGraphs({
    ...options,
    queueDir,
    graphDir,
    dryRun: options.dryRun === true,
    runId,
  } as OvernightQueueOptions & { runId: string });

  if (options.dryRun === true) {
    const result: OvernightRunResult = {
      status: "planned",
      dryRun: true,
      runId,
      queue,
      shift: null,
    };
    appendOvernightRunEvent(result);
    return result;
  }

  const shiftOptions: Parameters<typeof runShift>[0] = {
    queueDir,
    maxRuntimeSeconds: (queue.hours || 8) * 3600,
  };
  if (options.maxConcurrent !== undefined) {
    shiftOptions.maxConcurrent = options.maxConcurrent;
  }
  if (options.maxRetries !== undefined) {
    shiftOptions.maxRetries = options.maxRetries;
  }
  const shift = await runShift(shiftOptions);
  const status: OvernightRunResult["status"] =
    shift.rejected > 0 || shift.failed > 0
      ? "failed"
      : shift.blocked > 0
        ? "blocked"
        : queue.queuedCount === 0
          ? "partial"
          : "completed";
  const result: OvernightRunResult = {
    status,
    dryRun: false,
    runId,
    queue,
    shift,
  };
  appendOvernightRunEvent(result);
  return result;
}

async function compileOvernightGraphs(
  options: OvernightQueueOptions & { runId?: string } = {},
): Promise<OvernightQueueResult> {
  const dryRun = options.dryRun === true;
  const runId = options.runId ?? newRunId();
  const queueDir = options.queueDir ?? defaultQueueDir();
  const graphDir =
    options.graphDir ?? resolve(homedir(), ".frontier", "overnight", "graphs", runId);
  const preflight = evaluateOvernightDebtPreflight({ dryRun });
  const plan = await overnightPlan({ hours: options.hours ?? 8 });
  const scheduled = plan.actions
    .filter((planned) => planned.scheduled && planned.action.autonomousEligible)
    .slice(0, options.maxGraphs ?? Number.POSITIVE_INFINITY);
  if (!dryRun) mkdirSync(graphDir, { recursive: true });

  const graphs: OvernightCompiledGraph[] = [];
  for (const planned of scheduled) {
    const compiled = compilePlannedAction(planned, runId, plan.generatedAt);
    const validation = validateCompiledGraph(compiled.graph);
    const safety = validation.ok ? assessGraph(compiled.graph) : null;
    let status: OvernightCompiledGraph["status"] = compiled.status;
    let reason = compiled.reason;
    let path: string | null = null;
    let queuedPath: string | null = null;

    if (status === "ready" && !validation.ok) {
      status = "invalid";
      reason = "work graph schema validation failed";
    }
    if (status === "ready" && safety && !safety.safe) {
      status = "unsafe";
      reason = "ghost shift safety assessment rejected the graph";
    }
    if (status === "ready" && !dryRun) {
      path = resolve(
        graphDir,
        `${String(planned.sequence).padStart(3, "0")}-${slug(compiled.graph.graphId)}.json`,
      );
      writeFileSync(path, JSON.stringify(compiled.graph, null, 2) + "\n", "utf8");
      queuedPath = enqueue(path, queueDir);
    }

    graphs.push({
      sequence: planned.sequence,
      projectId: planned.projectId,
      actionId: planned.action.actionId,
      graphId: compiled.graph.graphId,
      status,
      path,
      queuedPath,
      validation,
      safety,
      reason,
      graph: compiled.graph,
    });
  }

  const readyCount = graphs.filter((graph) => graph.status === "ready").length;
  const queuedCount = graphs.filter((graph) => graph.queuedPath !== null).length;
  const skippedCount = graphs.length - readyCount;
  const laneSummary = summarizeOvernightLanes(graphs);
  return {
    status:
      dryRun
        ? "planned"
        : queuedCount === graphs.length
          ? "queued"
          : queuedCount > 0
            ? "partial"
            : "partial",
    dryRun,
    runId,
    generatedAt: new Date().toISOString(),
    hours: plan.hours,
    queueDir,
    graphDir: dryRun ? null : graphDir,
    preflight,
    plan: {
      status: plan.status,
      projectCount: plan.projectCount,
      attentionCount: plan.attentionCount,
      actionCount: plan.actionCount,
      scheduledCount: plan.scheduledCount,
      blockedCount: plan.blockedCount,
      usedMinutes: plan.usedMinutes,
      capacityMinutes: plan.capacityMinutes,
    },
    laneSummary,
    graphCount: graphs.length,
    readyCount,
    queuedCount,
    skippedCount,
    graphs,
  };
}

function compilePlannedAction(
  planned: OvernightPlannedAction,
  runId: string,
  createdAt: string,
): {
  status: "ready" | "unsupported";
  reason: string | null;
  graph: WorkGraph;
} {
  const cli = cliForAction(planned);
  const graphId = `overnight-${runId}-${String(planned.sequence).padStart(3, "0")}-${slug(
    planned.action.actionId,
  )}`;
  const nodeId = "run";
  const node: WorkNode = {
    nodeId,
    kind: nodeKindForAction(planned),
    title: planned.action.title,
    description: planned.action.evidence.join("\n"),
    status: "queued",
    priority: nodePriority(planned.action.priority),
    runtime: { plane: "mac", executor: "native_cli", worktreeStrategy: "shared" },
    approvalClass: planned.action.approvalClass,
    dependencies: [],
    allowedTools: cli ? [toolName(cli.command)] : [],
    verifierPolicy: {
      mode: "required",
      checks: ["artifact_schema"],
    },
    sideEffects: sideEffectsForAction(planned),
    inputs: [
      {
        type: "structured_payload",
        value: cli
          ? {
              cli,
              frontier: {
                projectId: planned.projectId,
                actionId: planned.action.actionId,
                verb: planned.action.verb,
                lane: planned.action.lane,
              },
            }
          : {
              unsupported: {
                projectId: planned.projectId,
                actionId: planned.action.actionId,
                verb: planned.action.verb,
              },
            },
      },
    ],
    budgets: {
      maxRuntimeSeconds: Math.max(Math.ceil((cli?.timeoutMs ?? 60_000) / 1000), 1),
      maxToolCalls: 1,
    },
    owner: "frontier-overnight",
    traceId: `${graphId}.${nodeId}`,
  };
  const graph: WorkGraph = {
    graphId,
    version: "v1",
    goal: `${planned.action.title} for ${planned.projectId}`,
    tenantId: "personal",
    createdAt,
    priority: graphPriority(planned.action.priority),
    status: "planned",
    approvalPolicy: {
      defaultClass: 0,
      requireHumanFor: [
        "auth_change",
        "billable_action",
        "data_deletion",
        "deploy",
        "destructive_action",
        "external_message",
        "financial_action",
        "prod_write",
        "security_change",
      ],
    },
    budgets: {
      maxRuntimeSeconds: Math.max(Math.ceil((cli?.timeoutMs ?? 60_000) / 1000), 1),
      maxToolCalls: 1,
    },
    labels: [
      "overnight",
      "ghost-shift",
      `run:${runId}`,
      `lane:${planned.action.lane}`,
      `project:${planned.projectId}`,
      `verb:${planned.action.verb}`,
    ],
    context: {
      scheduledStartMinute: planned.scheduledStartMinute,
      estimatedMinutes: planned.estimatedMinutes,
      action: {
        actionId: planned.action.actionId,
        title: planned.action.title,
        verb: planned.action.verb,
        approvalClass: planned.action.approvalClass,
        lane: planned.action.lane,
        arguments: planned.action.arguments,
      },
    },
    successCriteria: [
      "CLI dispatch exits 0.",
      "Dispatch returns a non-empty normalized payload.",
    ],
    nodes: [node],
  };
  return {
    status: cli ? "ready" : "unsupported",
    reason: cli ? null : `unsupported overnight action verb: ${planned.action.verb}`,
    graph,
  };
}

function cliForAction(planned: OvernightPlannedAction):
  | { command: string; args: string[]; cwd: string; timeoutMs: number }
  | null {
  const action = planned.action;
  if (action.command) {
    const [command, ...args] = action.command.argv;
    if (!command) return null;
    return {
      command,
      args,
      cwd: action.command.cwd,
      timeoutMs: (action.command.timeoutSeconds ?? 120) * 1000,
    };
  }
  switch (action.verb) {
    case "project.status":
      return {
        command: FRONTIER_BIN,
        args: ["project", "status", planned.projectId, "--json"],
        cwd: "/Users/test/frontier-os",
        timeoutMs: 60_000,
      };
    case "project.inspect":
      return {
        command: FRONTIER_BIN,
        args: ["project", "inspect", planned.projectId, "--json"],
        cwd: "/Users/test/frontier-os",
        timeoutMs: 60_000,
      };
    case "launchd.status": {
      const label = stringArg(action.arguments.label);
      if (!label) return null;
      return {
        command: FRONTIER_BIN,
        args: ["helper", "production-invoke", "launchd.status", "--label", label, "--json"],
        cwd: "/Users/test/frontier-os",
        timeoutMs: 30_000,
      };
    }
    case "logs.read": {
      const path = stringArg(action.arguments.path);
      if (!path) return null;
      const tailBytes = Number(action.arguments.tailBytes ?? 8192);
      return {
        command: FRONTIER_BIN,
        args: [
          "helper",
          "production-invoke",
          "logs.read",
          "--path",
          path,
          "--tail-bytes",
          String(Number.isFinite(tailBytes) ? tailBytes : 8192),
          "--json",
        ],
        cwd: "/Users/test/frontier-os",
        timeoutMs: 30_000,
      };
    }
    default:
      return null;
  }
}

function validateCompiledGraph(graph: WorkGraph): OvernightCompiledGraph["validation"] {
  const ok = validateWorkGraph(graph);
  if (!ok) return { ok: false, errors: validateWorkGraph.errors ?? null };
  try {
    prepare(graph);
    return { ok: true, errors: null };
  } catch (e) {
    return { ok: false, errors: e instanceof Error ? e.message : String(e) };
  }
}

function nodeKindForAction(planned: OvernightPlannedAction): WorkNode["kind"] {
  if (planned.action.command) return "test_run";
  if (planned.action.verb === "launchd.status" || planned.action.verb === "logs.read") {
    return "mac_task";
  }
  return "repo_analysis";
}

function sideEffectsForAction(planned: OvernightPlannedAction): SideEffectClass[] {
  return planned.action.approvalClass === 0 ? ["none"] : ["local_write"];
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function graphPriority(priority: OvernightPlannedAction["action"]["priority"]): WorkGraph["priority"] {
  switch (priority) {
    case "critical":
      return "urgent";
    case "high":
      return "high";
    case "medium":
      return "normal";
    case "low":
      return "low";
  }
}

function nodePriority(priority: OvernightPlannedAction["action"]["priority"]): WorkNode["priority"] {
  return graphPriority(priority);
}

function stringArg(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function toolName(command: string): string {
  return basename(command);
}

function slug(value: string): string {
  const cleaned = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
  return cleaned || "graph";
}

function newRunId(): string {
  return `ovr-${Date.now().toString(36)}-${randomUUID().slice(0, 8)}`;
}

function evaluateOvernightDebtPreflight(input: {
  dryRun: boolean;
  limit?: number;
}): OvernightDebtPreflight {
  const now = new Date();
  const nowIso = now.toISOString();
  const store = new CommandStore();
  try {
    const beforeCommands = store.list({ limit: input.limit ?? 200 });
    const before = commandDebtFromCommands(beforeCommands, now);
    const actions: OvernightDebtPreflightAction[] = [];
    for (const item of before.commands) {
      const command = store.get(item.commandId);
      if (!command) continue;
      const debt = assessCommandDebt(command, now);
      const operator = commandOperatorAction(command, debt);
      const eligibility = autoRemediationPolicy(command, debt, nowIso);
      if (eligibility.eligible) {
        if (input.dryRun) {
          actions.push({
            commandId: command.commandId,
            traceId: command.traceId,
            status: command.status,
            lane: command.lane,
            verb: command.verb,
            debtKind: debt.kind,
            debtSummary: debt.summary,
            ageMinutes: debt.ageMinutes,
            action: "requeue",
            actionCommand: `frontier command requeue ${command.commandId} --actor overnight-preflight --json`,
            automated: true,
            outcome: "planned",
            reason: eligibility.reason,
            sourceCommandId: command.commandId,
            replacementCommandId: null,
            replacementTraceId: null,
          });
          continue;
        }
        const requeued = store.requeue(command.commandId, "overnight-preflight");
        actions.push({
          commandId: command.commandId,
          traceId: command.traceId,
          status: command.status,
          lane: command.lane,
          verb: command.verb,
          debtKind: debt.kind,
          debtSummary: debt.summary,
          ageMinutes: debt.ageMinutes,
          action: requeued.operatorAction,
          actionCommand: `frontier command requeue ${command.commandId} --actor overnight-preflight --json`,
          automated: true,
          outcome: "requeued",
          reason: eligibility.reason,
          sourceCommandId: requeued.sourceCommand.commandId,
          replacementCommandId: requeued.command.commandId,
          replacementTraceId: requeued.command.traceId,
        });
        continue;
      }
      actions.push({
        commandId: command.commandId,
        traceId: command.traceId,
        status: command.status,
        lane: command.lane,
        verb: command.verb,
        debtKind: debt.kind,
        debtSummary: debt.summary,
        ageMinutes: debt.ageMinutes,
        action: operator.action,
        actionCommand: operator.command,
        automated: false,
        outcome: "manual_attention",
        reason: eligibility.reason,
        sourceCommandId: null,
        replacementCommandId: null,
        replacementTraceId: null,
      });
    }
    const after = input.dryRun
      ? null
      : commandDebtFromCommands(store.list({ limit: input.limit ?? 200 }));
    const automatedCount = actions.filter((action) => action.automated).length;
    const manualAttentionCount = actions.filter(
      (action) => action.outcome === "manual_attention",
    ).length;
    return {
      generatedAt: nowIso,
      status: preflightStatus({
        dryRun: input.dryRun,
        before,
        after,
        manualAttentionCount,
        automatedCount,
      }),
      summary: preflightSummary({
        dryRun: input.dryRun,
        before,
        after,
        manualAttentionCount,
        automatedCount,
      }),
      inspectedCount: beforeCommands.length,
      staleCount: before.counts.staleTotal,
      automatedCount,
      manualAttentionCount,
      before,
      after,
      actions,
    };
  } finally {
    store.close();
  }
}

function autoRemediationPolicy(
  command: CommandRecord,
  debt: ReturnType<typeof assessCommandDebt>,
  nowIso: string,
): { eligible: boolean; reason: string } {
  if (debt.kind === "stale_queued") {
    if ((command.approvalClass ?? 1) > 1) {
      return {
        eligible: false,
        reason: `approval class ${command.approvalClass ?? "unknown"} queue debt stays manual`,
      };
    }
    return {
      eligible: true,
      reason: "stale queued class 0/1 command can be requeued before overnight work starts",
    };
  }
  if (debt.kind === "stale_running") {
    if ((command.approvalClass ?? 1) > 1) {
      return {
        eligible: false,
        reason: `approval class ${command.approvalClass ?? "unknown"} running debt stays manual`,
      };
    }
    if (!command.lease?.until || command.lease.until > nowIso) {
      return {
        eligible: false,
        reason: "running command exceeded age threshold but still has an active lease",
      };
    }
    return {
      eligible: true,
      reason: "expired running lease on a class 0/1 command can be requeued safely",
    };
  }
  if (debt.kind === "stale_approval") {
    return {
      eligible: false,
      reason: "approval blockers require an operator decision and are not auto-resumed overnight",
    };
  }
  if (debt.kind === "stale_policy") {
    return {
      eligible: false,
      reason: "policy blockers remain manual until the intent or policy path changes",
    };
  }
  return {
    eligible: false,
    reason: "no automated overnight remediation is defined for this command",
  };
}

function preflightStatus(input: {
  dryRun: boolean;
  before: CommandDebtReport;
  after: CommandDebtReport | null;
  manualAttentionCount: number;
  automatedCount: number;
}): OvernightDebtPreflight["status"] {
  if (input.before.counts.staleTotal === 0) return "clear";
  if (input.manualAttentionCount > 0) return "attention";
  if (input.dryRun) return "planned";
  if ((input.after?.counts.staleTotal ?? 0) > 0) return "attention";
  return input.automatedCount > 0 ? "remediated" : "clear";
}

function preflightSummary(input: {
  dryRun: boolean;
  before: CommandDebtReport;
  after: CommandDebtReport | null;
  manualAttentionCount: number;
  automatedCount: number;
}): string[] {
  if (input.before.counts.staleTotal === 0) {
    return ["no stale command debt before overnight queue"];
  }
  const lines = [
    `${input.before.counts.staleTotal} stale command debt item${
      input.before.counts.staleTotal === 1 ? "" : "s"
    } before overnight queue`,
  ];
  if (input.automatedCount > 0) {
    lines.push(
      `${input.dryRun ? "would requeue" : "requeued"} ${input.automatedCount} stale command${
        input.automatedCount === 1 ? "" : "s"
      }`,
    );
  }
  if (input.manualAttentionCount > 0) {
    lines.push(
      `${input.manualAttentionCount} stale command debt item${
        input.manualAttentionCount === 1 ? "" : "s"
      } need manual attention`,
    );
  }
  if (input.after) {
    lines.push(
      input.after.counts.staleTotal === 0
        ? "no stale command debt remains after preflight"
        : `${input.after.counts.staleTotal} stale command debt item${
            input.after.counts.staleTotal === 1 ? "" : "s"
          } remain after preflight`,
    );
  }
  return lines;
}

function appendOvernightQueueEvent(
  kind: "overnight.enqueue",
  result: OvernightQueueResult,
): void {
  const ledger = getLedger();
  const sessionId = newSessionId(`overnight-queue-${result.runId}`);
  ledger.ensureSession({
    sessionId,
    label: "overnight-queue",
    tags: ["overnight", "orchestrator"],
  });
  ledger.appendEvent({
    sessionId,
    kind,
    actor: "overnight",
    payload: {
      runId: result.runId,
      status: result.status,
      dryRun: result.dryRun,
      hours: result.hours,
      queueDir: result.queueDir,
      graphDir: result.graphDir,
      graphCount: result.graphCount,
      readyCount: result.readyCount,
      queuedCount: result.queuedCount,
      skippedCount: result.skippedCount,
      laneSummary: compactLaneSummary(result.laneSummary),
      preflight: {
        status: result.preflight.status,
        staleBefore: result.preflight.before.counts.staleTotal,
        staleAfter: result.preflight.after?.counts.staleTotal ?? null,
        automatedCount: result.preflight.automatedCount,
        manualAttentionCount: result.preflight.manualAttentionCount,
        actions: result.preflight.actions.map((action) => ({
          commandId: action.commandId,
          traceId: action.traceId,
          status: action.status,
          lane: action.lane,
          verb: action.verb,
          debtKind: action.debtKind,
          debtSummary: action.debtSummary,
          action: action.action,
          actionCommand: action.actionCommand,
          automated: action.automated,
          outcome: action.outcome,
          reason: action.reason,
          sourceCommandId: action.sourceCommandId,
          replacementCommandId: action.replacementCommandId,
          replacementTraceId: action.replacementTraceId,
        })),
      },
    },
  });
}

function appendOvernightRunEvent(result: OvernightRunResult): void {
  const ledger = getLedger();
  const sessionId = newSessionId(`overnight-run-${result.runId}`);
  ledger.ensureSession({
    sessionId,
    label: "overnight-run",
    tags: ["overnight", "orchestrator"],
  });
  ledger.appendEvent({
    sessionId,
    kind: "overnight.run",
    actor: "overnight",
    payload: {
      runId: result.runId,
      status: result.status,
      dryRun: result.dryRun,
      queue: {
        status: result.queue.status,
        graphCount: result.queue.graphCount,
        queuedCount: result.queue.queuedCount,
        skippedCount: result.queue.skippedCount,
        queueDir: result.queue.queueDir,
        laneSummary: compactLaneSummary(result.queue.laneSummary),
        preflight: {
          status: result.queue.preflight.status,
          staleBefore: result.queue.preflight.before.counts.staleTotal,
          staleAfter: result.queue.preflight.after?.counts.staleTotal ?? null,
          automatedCount: result.queue.preflight.automatedCount,
          manualAttentionCount: result.queue.preflight.manualAttentionCount,
          actions: result.queue.preflight.actions.map((action) => ({
            commandId: action.commandId,
            traceId: action.traceId,
            status: action.status,
            lane: action.lane,
            verb: action.verb,
            debtKind: action.debtKind,
            debtSummary: action.debtSummary,
            action: action.action,
            actionCommand: action.actionCommand,
            automated: action.automated,
            outcome: action.outcome,
            reason: action.reason,
            sourceCommandId: action.sourceCommandId,
            replacementCommandId: action.replacementCommandId,
            replacementTraceId: action.replacementTraceId,
          })),
        },
      },
      shift: result.shift
        ? {
            shiftId: result.shift.shiftId,
            processed: result.shift.processed,
            completed: result.shift.completed,
            failed: result.shift.failed,
            blocked: result.shift.blocked,
            rejected: result.shift.rejected,
            skippedTimeBudget: result.shift.skippedTimeBudget,
          }
        : null,
    },
  });
}

function summarizeOvernightLanes(
  graphs: OvernightCompiledGraph[],
): OvernightLaneSummary[] {
  const lanes = new Map<
    string,
    {
      lane: string;
      graphCount: number;
      readyCount: number;
      queuedCount: number;
      skippedCount: number;
      projects: Set<string>;
      verbs: Map<string, number>;
    }
  >();
  for (const graph of graphs) {
    const action = record(graph.graph.context?.action);
    const lane = stringArg(action.lane) ?? "unknown";
    const verb = stringArg(action.verb) ?? graph.graphId;
    const entry =
      lanes.get(lane) ??
      {
        lane,
        graphCount: 0,
        readyCount: 0,
        queuedCount: 0,
        skippedCount: 0,
        projects: new Set<string>(),
        verbs: new Map<string, number>(),
      };
    entry.graphCount += 1;
    if (graph.status === "ready") entry.readyCount += 1;
    if (graph.queuedPath !== null) entry.queuedCount += 1;
    if (graph.status !== "ready") entry.skippedCount += 1;
    entry.projects.add(graph.projectId);
    entry.verbs.set(verb, (entry.verbs.get(verb) ?? 0) + 1);
    lanes.set(lane, entry);
  }
  return [...lanes.values()]
    .map((entry) => ({
      lane: entry.lane,
      graphCount: entry.graphCount,
      readyCount: entry.readyCount,
      queuedCount: entry.queuedCount,
      skippedCount: entry.skippedCount,
      projectCount: entry.projects.size,
      projects: [...entry.projects].sort(),
      topVerbs: [...entry.verbs.entries()]
        .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
        .slice(0, 5)
        .map(([verb, count]) => ({ verb, count })),
    }))
    .sort((a, b) => {
      if (b.graphCount !== a.graphCount) return b.graphCount - a.graphCount;
      return a.lane.localeCompare(b.lane);
    });
}

function compactLaneSummary(
  items: OvernightLaneSummary[],
): Array<{
  lane: string;
  graphCount: number;
  readyCount: number;
  queuedCount: number;
  skippedCount: number;
  projectCount: number;
  projects: string[];
  topVerbs: Array<{ verb: string; count: number }>;
}> {
  return items.map((item) => ({
    lane: item.lane,
    graphCount: item.graphCount,
    readyCount: item.readyCount,
    queuedCount: item.queuedCount,
    skippedCount: item.skippedCount,
    projectCount: item.projectCount,
    projects: item.projects,
    topVerbs: item.topVerbs,
  }));
}
