import Database from "better-sqlite3";
import type { Database as SqliteDb, Statement } from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";

import { getLedger } from "../ledger/index.ts";
import {
  buildActionEnvelope,
  evaluatePolicyAction,
  logPolicyEvaluation,
  parseApprovalClass,
  type ApprovalClass,
  type PolicyEvaluation,
} from "../policy/evaluator.ts";
import { loadProjectManifests } from "../projects/registry.ts";
import { validateCommandEnvelope } from "../schemas.ts";
import {
  buildCommandEnvelope,
  type BuildCommandEnvelopeInput,
  type CommandEnvelope,
  type CommandSurfaceChannel,
} from "./envelope.ts";
import { writeCommandGraphFromExplain } from "./compiler.ts";
import {
  analyzeCommandExecution,
  buildCommandExecutionPolicy,
  commandExecutionPolicy,
} from "./execution.ts";

export type CommandStatus =
  | "queued"
  | "running"
  | "blocked_approval"
  | "blocked_policy"
  | "completed"
  | "failed"
  | "canceled";

export type CommandActivityStatus =
  | "queued"
  | "running"
  | "blocked"
  | "completed"
  | "failed"
  | "canceled";

export type CommandLane =
  | "project"
  | "ops"
  | "helper"
  | "mlx"
  | "browser"
  | "salesforce"
  | "overnight"
  | "frontier"
  | "unknown";

export interface CommandRoute {
  lane: CommandLane;
  verb: string;
  projectId: string | null;
  approvalClass: ApprovalClass;
  sideEffects: string[];
  confidence: number;
  reason: string;
  missingInputs: string[];
}

export interface CommandPlan {
  planId: string;
  type: "direct_action" | "work_graph" | "blocked";
  summary: string;
  action:
    | {
        family: string;
        subcommand: string;
        args: string[];
        dryRunSafe: boolean;
      }
    | null;
  activities: Array<{
    name: string;
    lane: CommandLane;
    verb: string;
    input: Record<string, unknown>;
  }>;
  artifactDir: string;
  workGraphPath: string | null;
}

export interface CommandInterrupt {
  interruptId: string;
  type: "approval";
  traceId: string;
  commandId: string;
  question: string;
  details: Record<string, unknown>;
  resume: {
    cli: string;
    apiPath: string;
  };
}

export interface CommandCheckpoint {
  threadId: string;
  cursor: string;
  savedAt: string;
  state: Record<string, unknown>;
}

export interface CommandLease {
  owner: string | null;
  until: string | null;
}

export interface CommandRecord {
  commandId: string;
  traceId: string;
  status: CommandStatus;
  intent: string;
  projectId: string | null;
  actor: string;
  surface: string;
  requestedAt: string;
  updatedAt: string;
  approvalClass: ApprovalClass | null;
  lane: CommandLane | null;
  verb: string | null;
  route: CommandRoute | null;
  policy: PolicyEvaluation | null;
  plan: CommandPlan | null;
  checkpoint: CommandCheckpoint | null;
  interrupt: CommandInterrupt | null;
  resumeCursor: string | null;
  retryPolicy: Record<string, unknown> | null;
  idempotencyKey: string | null;
  lease: CommandLease | null;
  result: Record<string, unknown> | null;
  error: string | null;
  activities: CommandActivity[];
}

export interface CommandActivity {
  activityId: string;
  commandId: string;
  sequence: number;
  lane: CommandLane;
  name: string;
  verb: string;
  status: CommandActivityStatus;
  attempts: number;
  input: Record<string, unknown>;
  output: Record<string, unknown> | null;
  idempotencyKey: string;
  lease: CommandLease | null;
  startedAt: string | null;
  finishedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface CommandListOptions {
  status?: CommandStatus;
  limit?: number;
}

export interface CommandStoreStatus {
  generatedAt: string;
  counts: Record<CommandStatus, number>;
  claimableCount: number;
  runningLeases: Array<{
    commandId: string;
    leaseOwner: string | null;
    leaseUntil: string | null;
    expired: boolean;
  }>;
}

export interface SubmitCommandInput extends BuildCommandEnvelopeInput {
  dryRun?: boolean;
}

export interface CommandExplainResult {
  envelope: CommandEnvelope;
  route: CommandRoute;
  policy: PolicyEvaluation;
  plan: CommandPlan;
  status: CommandStatus;
  interrupt: CommandInterrupt | null;
  checkpoint: CommandCheckpoint;
  retryPolicy: Record<string, unknown>;
  idempotencyKey: string;
}

export interface CommandOperatorResult {
  operatorAction: "retry" | "requeue";
  sourceCommand: CommandRecord;
  command: CommandRecord;
}

const CURRENT_SCHEMA_VERSION = 1;

const SCHEMA_DDL = `
CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS commands (
  command_id TEXT PRIMARY KEY,
  trace_id TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL,
  intent TEXT NOT NULL,
  project_id TEXT,
  actor TEXT NOT NULL,
  surface TEXT NOT NULL,
  requested_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  approval_class INTEGER,
  lane TEXT,
  verb TEXT,
  route_json TEXT,
  policy_json TEXT,
  plan_json TEXT,
  checkpoint_json TEXT,
  interrupt_json TEXT,
  resume_cursor TEXT,
  retry_policy_json TEXT,
  idempotency_key TEXT,
  lease_owner TEXT,
  lease_until TEXT,
  result_json TEXT,
  error TEXT
);

CREATE TABLE IF NOT EXISTS command_activities (
  activity_id TEXT PRIMARY KEY,
  command_id TEXT NOT NULL,
  sequence INTEGER NOT NULL,
  lane TEXT NOT NULL,
  name TEXT NOT NULL,
  verb TEXT NOT NULL,
  status TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  input_json TEXT NOT NULL,
  output_json TEXT,
  idempotency_key TEXT NOT NULL,
  lease_owner TEXT,
  lease_until TEXT,
  started_at TEXT,
  finished_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (command_id) REFERENCES commands(command_id),
  UNIQUE (command_id, sequence)
);

CREATE INDEX IF NOT EXISTS idx_commands_status_updated ON commands(status, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_commands_updated ON commands(updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_command_activities_command ON command_activities(command_id, sequence);
`;

interface CommandRow {
  commandId: string;
  traceId: string;
  status: CommandStatus;
  intent: string;
  projectId: string | null;
  actor: string;
  surface: string;
  requestedAt: string;
  updatedAt: string;
  approvalClass: ApprovalClass | null;
  lane: CommandLane | null;
  verb: string | null;
  routeJson: string | null;
  policyJson: string | null;
  planJson: string | null;
  checkpointJson: string | null;
  interruptJson: string | null;
  resumeCursor: string | null;
  retryPolicyJson: string | null;
  idempotencyKey: string | null;
  leaseOwner: string | null;
  leaseUntil: string | null;
  resultJson: string | null;
  error: string | null;
}

interface ActivityRow {
  activityId: string;
  commandId: string;
  sequence: number;
  lane: CommandLane;
  name: string;
  verb: string;
  status: CommandActivityStatus;
  attempts: number;
  inputJson: string;
  outputJson: string | null;
  idempotencyKey: string;
  leaseOwner: string | null;
  leaseUntil: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export function defaultCommandDbPath(): string {
  return resolve(homedir(), ".frontier", "commands", "commands.db");
}

export function defaultCommandArtifactDir(commandId: string): string {
  return resolve(homedir(), ".frontier", "commands", commandId);
}

export class CommandStore {
  private db: SqliteDb;
  private insertCommand!: Statement;
  private insertActivity!: Statement;
  private getCommandStmt!: Statement;
  private getCommandByTraceStmt!: Statement;
  private listCommandsStmt!: Statement;
  private listCommandsByStatusStmt!: Statement;
  private listActivitiesStmt!: Statement;
  private updateStateStmt!: Statement;
  private updateActivityStatusStmt!: Statement;
  private selectClaimableStmt!: Statement;
  private claimCommandStmt!: Statement;
  private claimActivitiesStmt!: Statement;
  private getActivityStmt!: Statement;
  private updateActivityRunStmt!: Statement;
  private extendLeaseStmt!: Statement;
  private extendActivityLeaseStmt!: Statement;
  private finishCommandStmt!: Statement;
  private countByStatusStmt!: Statement;
  private countClaimableStmt!: Statement;
  private runningLeasesStmt!: Statement;

  constructor(dbPath: string = defaultCommandDbPath()) {
    mkdirSync(dirname(dbPath), { recursive: true });
    this.db = new Database(dbPath);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("synchronous = NORMAL");
    this.db.pragma("foreign_keys = ON");
    this.db.exec(SCHEMA_DDL);
    this.ensureSchemaVersion();
    this.prepareStatements();
  }

  explain(input: SubmitCommandInput): CommandExplainResult {
    const envelope = buildCommandEnvelope(input);
    assertValidCommandEnvelope(envelope);
    return explainEnvelope(envelope);
  }

  submit(input: SubmitCommandInput): CommandRecord {
    const envelope = buildCommandEnvelope(input);
    assertValidCommandEnvelope(envelope);
    const explained = explainEnvelope(envelope, { logPolicy: input.dryRun !== true });
    writeCommandGraphFromExplain(explained);
    if (input.dryRun === true) {
      return explainedToRecord(explained);
    }
    const now = new Date().toISOString();
    const lease: CommandLease = { owner: null, until: null };
    const activityStatus = activityStatusFor(explained.status);
    const tx = this.db.transaction(() => {
      this.insertCommand.run(
        explained.envelope.commandId,
        explained.envelope.traceId,
        explained.status,
        explained.envelope.intent,
        explained.route.projectId,
        explained.envelope.actor.actorId,
        explained.envelope.surface.channel,
        explained.envelope.requestedAt,
        now,
        explained.route.approvalClass,
        explained.route.lane,
        explained.route.verb,
        json(explained.route),
        json(explained.policy),
        json(explained.plan),
        json(explained.checkpoint),
        json(explained.interrupt),
        explained.checkpoint.cursor,
        json(explained.retryPolicy),
        explained.idempotencyKey,
        lease.owner,
        lease.until,
        null,
        null,
      );
      for (const [sequence, activity] of explained.plan.activities.entries()) {
        this.insertActivity.run(
          activityId(explained.envelope.commandId, sequence),
          explained.envelope.commandId,
          sequence,
          activity.lane,
          activity.name,
          activity.verb,
          activityStatus,
          0,
          json(activity.input),
          null,
          `${explained.idempotencyKey}:activity:${sequence}`,
          null,
          null,
          null,
          null,
          now,
          now,
        );
      }
    });
    tx();
    const record = this.get(explained.envelope.commandId);
    if (!record) {
      throw new Error(`command insert failed: ${explained.envelope.commandId}`);
    }
    appendCommandLifecycle(record, explained.envelope);
    return record;
  }

  list(options: CommandListOptions = {}): CommandRecord[] {
    const limit = clampLimit(options.limit ?? 25);
    const rows = options.status
      ? (this.listCommandsByStatusStmt.all(options.status, limit) as CommandRow[])
      : (this.listCommandsStmt.all(limit) as CommandRow[]);
    return rows.map((row) => this.recordFromRow(row));
  }

  get(commandId: string): CommandRecord | null {
    const row = this.getCommandStmt.get(commandId) as CommandRow | undefined;
    return row ? this.recordFromRow(row) : null;
  }

  getByTraceId(traceId: string): CommandRecord | null {
    const row = this.getCommandByTraceStmt.get(traceId) as CommandRow | undefined;
    return row ? this.recordFromRow(row) : null;
  }

  cancel(commandId: string, actor = "operator"): CommandRecord {
    const record = requireCommand(this.get(commandId), commandId);
    if (["completed", "failed", "canceled"].includes(record.status)) {
      return record;
    }
    const updated = this.updateState(commandId, {
      status: "canceled",
      checkpoint: checkpointFor(record.commandId, "canceled", {
        previousStatus: record.status,
        actor,
      }),
      interrupt: null,
      result: { canceledBy: actor, canceledAt: new Date().toISOString() },
      error: null,
    });
    this.markActivities(commandId, "canceled");
    const refreshed = requireCommand(this.get(commandId), commandId);
    appendStateChanged(record, refreshed, { actor, reason: "canceled" });
    return refreshed;
  }

  claimNext(options: {
    workerId: string;
    leaseMs?: number;
    commandId?: string;
    maxApprovalClass?: ApprovalClass;
  }): CommandRecord | null {
    const now = new Date();
    const nowIso = now.toISOString();
    const leaseUntil = new Date(now.getTime() + (options.leaseMs ?? 60_000)).toISOString();
    let before: CommandRecord | null = null;
    const tx = this.db.transaction(() => {
      const row = this.selectClaimableStmt.get(
        nowIso,
        nowIso,
        options.commandId ?? null,
        options.commandId ?? null,
        options.maxApprovalClass ?? null,
        options.maxApprovalClass ?? null,
      ) as { commandId: string } | undefined;
      if (!row) return null;
      before = this.get(row.commandId);
      this.claimCommandStmt.run(
        "running",
        nowIso,
        options.workerId,
        leaseUntil,
        json(
          checkpointFor(row.commandId, "running", {
            previousStatus: before?.status ?? "queued",
            workerId: options.workerId,
            leaseUntil,
          }),
        ),
        `${row.commandId}:running`,
        row.commandId,
      );
      this.claimActivitiesStmt.run(
        "running",
        nowIso,
        options.workerId,
        leaseUntil,
        nowIso,
        row.commandId,
      );
      return row.commandId;
    });
    const commandId = tx();
    if (!commandId) return null;
    const claimed = requireCommand(this.get(commandId), commandId);
    if (before) {
      appendStateChanged(before, claimed, {
        actor: "command.worker",
        reason: "claimed",
        workerId: options.workerId,
        leaseUntil,
      });
    }
    return claimed;
  }

  extendLease(input: {
    commandId: string;
    workerId: string;
    leaseMs?: number;
  }): CommandRecord | null {
    const leaseUntil = new Date(
      Date.now() + (input.leaseMs ?? 60_000),
    ).toISOString();
    const nowIso = new Date().toISOString();
    const tx = this.db.transaction(() => {
      this.extendLeaseStmt.run(
        nowIso,
        leaseUntil,
        json(
          checkpointFor(input.commandId, "running", {
            heartbeatAt: nowIso,
            workerId: input.workerId,
            leaseUntil,
          }),
        ),
        `${input.commandId}:running`,
        input.commandId,
        input.workerId,
      );
      this.extendActivityLeaseStmt.run(
        nowIso,
        leaseUntil,
        input.commandId,
        input.workerId,
      );
    });
    tx();
    return this.get(input.commandId);
  }

  getActivity(activityId: string): CommandActivity | null {
    const row = this.getActivityStmt.get(activityId) as ActivityRow | undefined;
    return row ? activityFromRow(row) : null;
  }

  finishActivity(input: {
    activityId: string;
    status: Extract<CommandActivityStatus, "completed" | "failed" | "canceled">;
    output: Record<string, unknown>;
  }): CommandActivity {
    const now = new Date().toISOString();
    this.updateActivityRunStmt.run(
      input.status,
      now,
      now,
      json(input.output),
      input.activityId,
    );
    const activity = this.getActivity(input.activityId);
    if (!activity) throw new Error(`unknown activity: ${input.activityId}`);
    return activity;
  }

  finishCommand(input: {
    commandId: string;
    status: Extract<CommandStatus, "completed" | "failed">;
    result: Record<string, unknown>;
    error?: string | null;
    actor?: string;
  }): CommandRecord {
    const before = requireCommand(this.get(input.commandId), input.commandId);
    const checkpoint = checkpointFor(input.commandId, input.status, {
      previousStatus: before.status,
      result: input.result,
      error: input.error ?? null,
    });
    this.finishCommandStmt.run(
      input.status,
      new Date().toISOString(),
      json(checkpoint),
      checkpoint.cursor,
      json(input.result),
      input.error ?? null,
      null,
      null,
      input.commandId,
    );
    const after = requireCommand(this.get(input.commandId), input.commandId);
    appendStateChanged(before, after, {
      actor: input.actor ?? "command.worker",
      reason: input.status,
    });
    appendTerminalCommandEvent(after);
    return after;
  }

  status(): CommandStoreStatus {
    const statuses: CommandStatus[] = [
      "queued",
      "running",
      "blocked_approval",
      "blocked_policy",
      "completed",
      "failed",
      "canceled",
    ];
    const counts = Object.fromEntries(
      statuses.map((status) => [status, 0]),
    ) as Record<CommandStatus, number>;
    const rows = this.countByStatusStmt.all() as Array<{
      status: CommandStatus;
      count: number;
    }>;
    for (const row of rows) counts[row.status] = row.count;
    const nowIso = new Date().toISOString();
    const claimable = this.countClaimableStmt.get(nowIso, nowIso) as {
      count: number;
    };
    const leases = this.runningLeasesStmt.all() as Array<{
      commandId: string;
      leaseOwner: string | null;
      leaseUntil: string | null;
    }>;
    return {
      generatedAt: nowIso,
      counts,
      claimableCount: claimable.count,
      runningLeases: leases.map((lease) => ({
        ...lease,
        expired: lease.leaseUntil !== null && lease.leaseUntil <= nowIso,
      })),
    };
  }

  resume(input: {
    commandId: string;
    approvalTraceId?: string;
    actor?: string;
    resumePayload?: Record<string, unknown>;
  }): CommandRecord {
    const record = requireCommand(this.get(input.commandId), input.commandId);
    if (record.status !== "blocked_approval") {
      return record;
    }
    const traceId = input.approvalTraceId ?? record.traceId;
    if (traceId !== record.traceId) {
      throw new Error(
        `approval trace ${traceId} does not match command trace ${record.traceId}`,
      );
    }
    if (!record.route) throw new Error(`command ${record.commandId} has no route`);
    const action = buildActionEnvelope({
      actor: input.actor ?? record.actor,
      source: record.surface,
      projectId: record.projectId,
      verb: record.route.verb,
      arguments: policyArgumentsFor({
        commandId: record.commandId,
        intent: record.intent,
        payload: { resumePayload: input.resumePayload ?? {} },
        plan: record.plan,
      }),
      approvalClass: record.route.approvalClass,
      sideEffects: record.route.sideEffects,
      traceId: record.traceId,
    });
    const policy = evaluatePolicyAction(action, { consumeApproval: true });
    logPolicyEvaluation("policy.evaluated", policy);
    const nextStatus: CommandStatus =
      policy.decision.status === "allow" ? "queued" : "blocked_approval";
    const checkpoint = checkpointFor(record.commandId, nextStatus, {
      previousStatus: record.status,
      resumePayload: input.resumePayload ?? {},
      policy,
    });
    const updated = this.updateState(record.commandId, {
      status: nextStatus,
      policy,
      checkpoint,
      interrupt: nextStatus === "queued" ? null : record.interrupt,
      error:
        nextStatus === "queued"
          ? null
          : policy.decision.reason,
    });
    if (nextStatus === "queued") {
      this.markActivities(record.commandId, "queued");
    }
    const refreshed = requireCommand(this.get(record.commandId), record.commandId);
    appendStateChanged(record, refreshed, {
      actor: input.actor ?? "operator",
      reason: "resume",
      policyStatus: policy.decision.status,
    });
    return refreshed;
  }

  retry(commandId: string, actor = "operator"): CommandOperatorResult {
    const sourceCommand = requireCommand(this.get(commandId), commandId);
    if (!["failed", "canceled"].includes(sourceCommand.status)) {
      throw new Error(
        `command ${commandId} is ${sourceCommand.status}; retry only supports failed/canceled commands`,
      );
    }
    const command = this.submit(
      operatorSubmitInput(sourceCommand, {
        actor,
        operatorAction: "retry",
      }),
    );
    appendOperatorLinked(sourceCommand, command, {
      actor,
      operatorAction: "retry",
    });
    return {
      operatorAction: "retry",
      sourceCommand,
      command,
    };
  }

  requeue(commandId: string, actor = "operator"): CommandOperatorResult {
    const sourceCommand = requireCommand(this.get(commandId), commandId);
    if (!["queued", "running", "blocked_approval"].includes(sourceCommand.status)) {
      throw new Error(
        `command ${commandId} is ${sourceCommand.status}; requeue only supports queued/running/blocked_approval commands`,
      );
    }
    const canceledSource =
      sourceCommand.status === "canceled"
        ? sourceCommand
        : this.cancel(commandId, actor);
    const command = this.submit(
      operatorSubmitInput(canceledSource, {
        actor,
        operatorAction: "requeue",
      }),
    );
    appendOperatorLinked(canceledSource, command, {
      actor,
      operatorAction: "requeue",
    });
    return {
      operatorAction: "requeue",
      sourceCommand: canceledSource,
      command,
    };
  }

  close(): void {
    this.db.close();
  }

  private ensureSchemaVersion(): void {
    const row = this.db
      .prepare("SELECT value FROM meta WHERE key = 'schema_version'")
      .get() as { value: string } | undefined;
    if (!row) {
      this.db
        .prepare("INSERT INTO meta(key, value) VALUES ('schema_version', ?)")
        .run(String(CURRENT_SCHEMA_VERSION));
      return;
    }
    const current = Number(row.value);
    if (current > CURRENT_SCHEMA_VERSION) {
      throw new Error(
        `command store schema version ${current} is newer than supported (${CURRENT_SCHEMA_VERSION}); upgrade frontier-os`,
      );
    }
  }

  private prepareStatements(): void {
    this.insertCommand = this.db.prepare(
      `INSERT INTO commands(
         command_id, trace_id, status, intent, project_id, actor, surface,
         requested_at, updated_at, approval_class, lane, verb, route_json,
         policy_json, plan_json, checkpoint_json, interrupt_json,
         resume_cursor, retry_policy_json, idempotency_key, lease_owner,
         lease_until, result_json, error
       )
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    this.insertActivity = this.db.prepare(
      `INSERT INTO command_activities(
         activity_id, command_id, sequence, lane, name, verb, status, attempts,
         input_json, output_json, idempotency_key, lease_owner, lease_until,
         started_at, finished_at, created_at, updated_at
       )
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    this.getCommandStmt = this.db.prepare(
      `SELECT command_id as commandId, trace_id as traceId, status, intent,
              project_id as projectId, actor, surface,
              requested_at as requestedAt, updated_at as updatedAt,
              approval_class as approvalClass, lane, verb,
              route_json as routeJson, policy_json as policyJson,
              plan_json as planJson, checkpoint_json as checkpointJson,
              interrupt_json as interruptJson, resume_cursor as resumeCursor,
              retry_policy_json as retryPolicyJson, idempotency_key as idempotencyKey,
              lease_owner as leaseOwner, lease_until as leaseUntil,
              result_json as resultJson, error
       FROM commands WHERE command_id = ?`,
    );
    this.getCommandByTraceStmt = this.db.prepare(
      `SELECT command_id as commandId, trace_id as traceId, status, intent,
              project_id as projectId, actor, surface,
              requested_at as requestedAt, updated_at as updatedAt,
              approval_class as approvalClass, lane, verb,
              route_json as routeJson, policy_json as policyJson,
              plan_json as planJson, checkpoint_json as checkpointJson,
              interrupt_json as interruptJson, resume_cursor as resumeCursor,
              retry_policy_json as retryPolicyJson, idempotency_key as idempotencyKey,
              lease_owner as leaseOwner, lease_until as leaseUntil,
              result_json as resultJson, error
       FROM commands WHERE trace_id = ?`,
    );
    this.listCommandsStmt = this.db.prepare(
      `SELECT command_id as commandId, trace_id as traceId, status, intent,
              project_id as projectId, actor, surface,
              requested_at as requestedAt, updated_at as updatedAt,
              approval_class as approvalClass, lane, verb,
              route_json as routeJson, policy_json as policyJson,
              plan_json as planJson, checkpoint_json as checkpointJson,
              interrupt_json as interruptJson, resume_cursor as resumeCursor,
              retry_policy_json as retryPolicyJson, idempotency_key as idempotencyKey,
              lease_owner as leaseOwner, lease_until as leaseUntil,
              result_json as resultJson, error
       FROM commands
       ORDER BY updated_at DESC
       LIMIT ?`,
    );
    this.listCommandsByStatusStmt = this.db.prepare(
      `SELECT command_id as commandId, trace_id as traceId, status, intent,
              project_id as projectId, actor, surface,
              requested_at as requestedAt, updated_at as updatedAt,
              approval_class as approvalClass, lane, verb,
              route_json as routeJson, policy_json as policyJson,
              plan_json as planJson, checkpoint_json as checkpointJson,
              interrupt_json as interruptJson, resume_cursor as resumeCursor,
              retry_policy_json as retryPolicyJson, idempotency_key as idempotencyKey,
              lease_owner as leaseOwner, lease_until as leaseUntil,
              result_json as resultJson, error
       FROM commands
       WHERE status = ?
       ORDER BY updated_at DESC
       LIMIT ?`,
    );
    this.listActivitiesStmt = this.db.prepare(
      `SELECT activity_id as activityId, command_id as commandId, sequence,
              lane, name, verb, status, attempts,
              input_json as inputJson, output_json as outputJson,
              idempotency_key as idempotencyKey, lease_owner as leaseOwner,
              lease_until as leaseUntil, started_at as startedAt,
              finished_at as finishedAt, created_at as createdAt,
              updated_at as updatedAt
       FROM command_activities
       WHERE command_id = ?
       ORDER BY sequence ASC`,
    );
    this.updateStateStmt = this.db.prepare(
      `UPDATE commands
       SET status = ?, updated_at = ?, policy_json = COALESCE(?, policy_json),
           checkpoint_json = ?, interrupt_json = ?, resume_cursor = ?,
           result_json = ?, error = ?
       WHERE command_id = ?`,
    );
    this.updateActivityStatusStmt = this.db.prepare(
      `UPDATE command_activities
       SET status = ?, updated_at = ?
       WHERE command_id = ? AND status IN ('queued', 'blocked', 'running')`,
    );
    this.selectClaimableStmt = this.db.prepare(
      `SELECT command_id as commandId
       FROM commands
       WHERE (
           (status = 'queued' AND (lease_until IS NULL OR lease_until <= ?))
           OR
           (status = 'running' AND lease_until IS NOT NULL AND lease_until <= ?)
         )
         AND (? IS NULL OR command_id = ?)
         AND (? IS NULL OR COALESCE(approval_class, 1) <= ?)
       ORDER BY requested_at ASC
       LIMIT 1`,
    );
    this.claimCommandStmt = this.db.prepare(
      `UPDATE commands
       SET status = ?, updated_at = ?, lease_owner = ?, lease_until = ?,
           checkpoint_json = ?, resume_cursor = ?, interrupt_json = NULL,
           error = NULL
       WHERE command_id = ?`,
    );
    this.claimActivitiesStmt = this.db.prepare(
      `UPDATE command_activities
       SET status = ?, updated_at = ?, lease_owner = ?, lease_until = ?,
           started_at = COALESCE(started_at, ?),
           attempts = attempts + 1
       WHERE command_id = ? AND status IN ('queued', 'running')`,
    );
    this.getActivityStmt = this.db.prepare(
      `SELECT activity_id as activityId, command_id as commandId, sequence,
              lane, name, verb, status, attempts,
              input_json as inputJson, output_json as outputJson,
              idempotency_key as idempotencyKey, lease_owner as leaseOwner,
              lease_until as leaseUntil, started_at as startedAt,
              finished_at as finishedAt, created_at as createdAt,
              updated_at as updatedAt
       FROM command_activities
       WHERE activity_id = ?`,
    );
    this.updateActivityRunStmt = this.db.prepare(
      `UPDATE command_activities
       SET status = ?, updated_at = ?, finished_at = ?, output_json = ?,
           lease_owner = NULL, lease_until = NULL
       WHERE activity_id = ?`,
    );
    this.extendLeaseStmt = this.db.prepare(
      `UPDATE commands
       SET updated_at = ?, lease_until = ?, checkpoint_json = ?,
           resume_cursor = ?
       WHERE command_id = ? AND status = 'running' AND lease_owner = ?`,
    );
    this.extendActivityLeaseStmt = this.db.prepare(
      `UPDATE command_activities
       SET updated_at = ?, lease_until = ?
       WHERE command_id = ? AND status = 'running' AND lease_owner = ?`,
    );
    this.finishCommandStmt = this.db.prepare(
      `UPDATE commands
       SET status = ?, updated_at = ?, checkpoint_json = ?, resume_cursor = ?,
           result_json = ?, error = ?, lease_owner = ?, lease_until = ?
       WHERE command_id = ?`,
    );
    this.countByStatusStmt = this.db.prepare(
      `SELECT status, COUNT(*) as count FROM commands GROUP BY status`,
    );
    this.countClaimableStmt = this.db.prepare(
      `SELECT COUNT(*) as count
       FROM commands
       WHERE (status = 'queued' AND (lease_until IS NULL OR lease_until <= ?))
          OR (status = 'running' AND lease_until IS NOT NULL AND lease_until <= ?)`,
    );
    this.runningLeasesStmt = this.db.prepare(
      `SELECT command_id as commandId, lease_owner as leaseOwner,
              lease_until as leaseUntil
       FROM commands
       WHERE status = 'running'
       ORDER BY updated_at DESC
       LIMIT 25`,
    );
  }

  private recordFromRow(row: CommandRow): CommandRecord {
    const lease =
      row.leaseOwner || row.leaseUntil
        ? { owner: row.leaseOwner, until: row.leaseUntil }
        : null;
    return {
      commandId: row.commandId,
      traceId: row.traceId,
      status: row.status,
      intent: row.intent,
      projectId: row.projectId,
      actor: row.actor,
      surface: row.surface,
      requestedAt: row.requestedAt,
      updatedAt: row.updatedAt,
      approvalClass: row.approvalClass,
      lane: row.lane,
      verb: row.verb,
      route: parseJson<CommandRoute>(row.routeJson),
      policy: parseJson<PolicyEvaluation>(row.policyJson),
      plan: parseJson<CommandPlan>(row.planJson),
      checkpoint: parseJson<CommandCheckpoint>(row.checkpointJson),
      interrupt: parseJson<CommandInterrupt>(row.interruptJson),
      resumeCursor: row.resumeCursor,
      retryPolicy: parseJson<Record<string, unknown>>(row.retryPolicyJson),
      idempotencyKey: row.idempotencyKey,
      lease,
      result: parseJson<Record<string, unknown>>(row.resultJson),
      error: row.error,
      activities: this.activities(row.commandId),
    };
  }

  private activities(commandId: string): CommandActivity[] {
    const rows = this.listActivitiesStmt.all(commandId) as ActivityRow[];
    return rows.map(activityFromRow);
  }

  private updateState(
    commandId: string,
    patch: {
      status: CommandStatus;
      policy?: PolicyEvaluation;
      checkpoint: CommandCheckpoint;
      interrupt: CommandInterrupt | null;
      result?: Record<string, unknown> | null;
      error?: string | null;
    },
  ): CommandRecord {
    this.updateStateStmt.run(
      patch.status,
      new Date().toISOString(),
      patch.policy ? json(patch.policy) : null,
      json(patch.checkpoint),
      json(patch.interrupt),
      patch.checkpoint.cursor,
      json(patch.result ?? null),
      patch.error ?? null,
      commandId,
    );
    return requireCommand(this.get(commandId), commandId);
  }

  private markActivities(
    commandId: string,
    status: CommandActivityStatus,
  ): void {
    this.updateActivityStatusStmt.run(status, new Date().toISOString(), commandId);
  }
}

export function explainCommand(input: SubmitCommandInput): CommandExplainResult {
  const envelope = buildCommandEnvelope(input);
  assertValidCommandEnvelope(envelope);
  return explainEnvelope(envelope);
}

function explainEnvelope(
  envelope: CommandEnvelope,
  options: { logPolicy?: boolean } = {},
): CommandExplainResult {
  const route = classifyCommand(envelope);
  const plan = planCommand(envelope, route);
  const action = buildActionEnvelope({
    actor: envelope.actor.actorId,
    source: envelope.surface.channel,
    projectId: route.projectId,
    verb: route.verb,
    arguments: policyArgumentsFor({
      commandId: envelope.commandId,
      intent: envelope.intent,
      payload: envelope.payload,
      plan,
    }),
    approvalClass: route.approvalClass,
    sideEffects: route.sideEffects,
    traceId: envelope.traceId,
  });
  const policy = evaluatePolicyAction(action);
  if (options.logPolicy === true) {
    logPolicyEvaluation("policy.evaluated", policy);
  }
  const status = initialStatus(policy);
  const interrupt =
    status === "blocked_approval" ? interruptFor(envelope, route, policy) : null;
  const checkpoint = checkpointFor(envelope.commandId, status, {
    route,
    plan,
    policy,
    interrupt,
  });
  const retryPolicy = {
    ...buildCommandExecutionPolicy({
      envelope,
      route,
      plan,
    }),
  };
  const idempotencyKey = `command:${envelope.traceId}:${route.verb}`;
  return {
    envelope,
    route,
    policy,
    plan,
    status,
    interrupt,
    checkpoint,
    retryPolicy,
    idempotencyKey,
  };
}

function policyArgumentsFor(input: {
  commandId: string;
  intent: string;
  payload: Record<string, unknown>;
  plan: CommandPlan | null;
}): Record<string, unknown> {
  const args: Record<string, unknown> = {
    commandId: input.commandId,
    intent: input.intent,
    payload: input.payload,
  };
  if (input.plan?.action) {
    args.plannedAction = input.plan.action;
    if (
      input.plan.action.family === "ops" &&
      input.plan.action.subcommand === "repair-launchagent"
    ) {
      const label = input.plan.action.args[0];
      if (label) args.label = label;
    }
  }
  return args;
}

function classifyCommand(envelope: CommandEnvelope): CommandRoute {
  const intent = envelope.intent.toLowerCase();
  const projectId = envelope.projectId ?? inferProjectId(intent);
  const explicit = parseApprovalClass(envelope.approvalClass);

  if (isDestructiveFilesystemIntent(intent)) {
    return route("frontier", "filesystem.delete", projectId, explicit);
  }
  if (isDestructiveDatabaseIntent(intent)) {
    return route("frontier", "database.drop", projectId, explicit);
  }
  if (isProtectedServiceRestartIntent(intent)) {
    return route("ops", "service.restart", projectId, explicit);
  }
  if (intent.includes("overnight")) {
    const verb = intent.includes("brief")
      ? "overnight.brief"
      : intent.includes("run")
        ? "overnight.run"
        : intent.includes("queue") || intent.includes("enqueue")
          ? "overnight.enqueue"
          : "overnight.plan";
    return route("overnight", verb, projectId, explicit);
  }
  if (intent.includes("mlx")) {
    const verb = intent.includes("smoke")
      ? "mlx.smoke"
      : intent.includes("benchmark") || intent.includes("bench")
        ? "mlx.benchmark"
        : intent.includes("generate")
          ? "mlx.generate"
          : "mlx.status";
    return route("mlx", verb, projectId ?? "mlx-workbench", explicit);
  }
  const browserPayloadRoute = browserRouteFromPayload(
    envelope.payload,
    projectId,
    explicit,
  );
  if (browserPayloadRoute) return browserPayloadRoute;
  const salesforcePayloadRoute = salesforceRouteFromPayload(
    envelope.payload,
    projectId,
    explicit,
  );
  if (salesforcePayloadRoute) return salesforcePayloadRoute;
  if (
    intent.includes("salesforce") ||
    intent.includes("dashboard") ||
    intent.includes("crm analytics")
  ) {
    if (intent.includes("report")) {
      if (intent.includes("filter")) {
        return salesforceReportFilterRoute(envelope.payload, projectId, explicit);
      }
      return route("salesforce", "salesforce.inspect_report", projectId, explicit);
    }
    if (
      intent.includes("move widget") ||
      intent.includes("reposition widget") ||
      intent.includes("rearrange widget")
    ) {
      return salesforceMoveWidgetRoute(envelope.payload, projectId, explicit);
    }
    if (intent.includes("save dashboard") || (intent.includes("save") && intent.includes("dashboard"))) {
      return route("salesforce", "salesforce.save_dashboard", projectId, explicit);
    }
    if (
      intent.includes("enter edit mode") ||
      intent.includes("edit mode") ||
      intent.includes("edit dashboard")
    ) {
      return route("salesforce", "salesforce.enter_edit_mode", projectId, explicit);
    }
    return route("salesforce", "salesforce.portfolio_summary", projectId, explicit);
  }
  if (intent.includes("browser") || intent.includes("tab")) {
    if (intent.includes("click")) {
      return browserClickRoute(envelope.payload, projectId, explicit);
    }
    if (intent.includes("dom")) {
      return route("browser", "browser.inspect_dom", projectId, explicit);
    }
    if (intent.includes("screenshot") || intent.includes("snapshot")) {
      return route("browser", "browser.capture_screenshot", projectId, explicit);
    }
    return route("browser", "browser.inspect", projectId, explicit);
  }
  if (intent.includes("helper") || intent.includes("launchd status")) {
    const verb = intent.includes("logs") ? "logs.read" : "helper.status";
    return route("helper", verb, projectId ?? "frontier-os", explicit);
  }
  if (
    intent.includes("repair") ||
    intent.includes("restart") ||
    intent.includes("fix launch")
  ) {
    return route("ops", "ops.repair_launchagent", projectId ?? "frontier-os", explicit);
  }
  if (intent.includes("verify") || intent.includes("typecheck")) {
    return route("project", "project.verify", projectId, explicit);
  }
  if (intent.includes("smoke")) {
    return route("project", "project.smoke", projectId, explicit);
  }
  if (intent.includes("status") || intent.includes("health")) {
    return route("project", "project.status", projectId, explicit);
  }
  return route("unknown", "command.intent", projectId, explicit);
}

function route(
  lane: CommandLane,
  verb: string,
  projectId: string | null,
  explicitClass: ApprovalClass | null,
): CommandRoute {
  const inferred = inferredClassForVerb(verb);
  const approvalClass = explicitClass ?? inferred.approvalClass;
  return {
    lane,
    verb,
    projectId,
    approvalClass,
    sideEffects: sideEffectsForClass(approvalClass),
    confidence: lane === "unknown" ? 0.35 : projectId ? 0.9 : 0.72,
    reason: lane === "unknown" ? "fallback_intent_route" : "deterministic_intent_route",
    missingInputs:
      lane === "project" && !projectId ? ["projectId"] : [],
  };
}

function inferredClassForVerb(verb: string): {
  approvalClass: ApprovalClass;
} {
  if (
    [
      "project.status",
      "helper.status",
      "overnight.plan",
      "overnight.brief",
      "mlx.status",
      "browser.inspect",
      "browser.inspect_dom",
      "browser.inspect_network",
      "browser.capture_screenshot",
      "salesforce.inspect_dashboard",
      "salesforce.inspect_report",
      "salesforce.list_filters",
      "salesforce.audit_dashboard",
    ].includes(verb)
  ) {
    return { approvalClass: 0 };
  }
  if (
    [
      "project.verify",
      "project.smoke",
      "overnight.enqueue",
      "overnight.run",
      "mlx.smoke",
      "mlx.benchmark",
      "mlx.generate",
      "salesforce.portfolio_summary",
      "salesforce.set_report_filter",
      "salesforce.set_filter",
      "salesforce.enter_edit_mode",
      "salesforce.move_widget",
      "salesforce.save_dashboard",
      "browser.click_element",
      "browser.enter_text",
      "browser.select_option",
      "browser.navigate",
      "command.intent",
      "logs.read",
    ].includes(verb)
  ) {
    return { approvalClass: 1 };
  }
  if (verb === "ops.repair_launchagent") return { approvalClass: 2 };
  if (
    ["filesystem.delete", "database.drop", "service.restart"].includes(verb)
  ) {
    return { approvalClass: 3 };
  }
  return { approvalClass: 1 };
}

function sideEffectsForClass(approvalClass: ApprovalClass): string[] {
  if (approvalClass === 0) return [];
  if (approvalClass === 1) return ["local_write"];
  if (approvalClass === 2) return ["local_service"];
  return ["privileged_or_external"];
}

function inferProjectId(intent: string): string | null {
  for (const project of loadProjectManifests()) {
    const candidates = new Set([
      project.id.toLowerCase(),
      project.name.toLowerCase(),
      ...project.ledgerTags.map((tag) => tag.toLowerCase()),
    ]);
    for (const candidate of candidates) {
      if (candidate && intent.includes(candidate)) return project.id;
    }
  }
  return null;
}

function isDestructiveFilesystemIntent(intent: string): boolean {
  return (
    /\b(delete|remove|erase|wipe|trash|destroy)\b/.test(intent) &&
    /\b(everything|all|recursive|recursively|downloads|documents|desktop|home|root|system|library)\b/.test(
      intent,
    )
  ) || /\brm\s+-rf\b/.test(intent);
}

function isDestructiveDatabaseIntent(intent: string): boolean {
  return /\b(drop|truncate)\b/.test(intent) && /\b(table|database|db)\b/.test(intent);
}

function isProtectedServiceRestartIntent(intent: string): boolean {
  if (!/\b(restart|stop|kill|unload|shutdown)\b/.test(intent)) return false;
  return (
    intent.includes("com.apple.") ||
    intent.includes("windowserver") ||
    intent.includes("systemuiserver") ||
    intent.includes("loginwindow")
  );
}

function planCommand(envelope: CommandEnvelope, routeInfo: CommandRoute): CommandPlan {
  const artifactDir = defaultCommandArtifactDir(envelope.commandId);
  const action = directActionFor(routeInfo, envelope.payload);
  return {
    planId: `plan_${envelope.commandId}`,
    type: action ? "direct_action" : "blocked",
    summary: action
      ? `${routeInfo.verb} via ${routeInfo.lane} lane`
      : routeInfo.missingInputs.length > 0
        ? `Missing inputs for ${routeInfo.verb}: ${routeInfo.missingInputs.join(", ")}`
        : `No direct action compiler yet for ${routeInfo.verb}`,
    action,
    activities: [
      {
        name: routeInfo.verb,
        lane: routeInfo.lane,
        verb: routeInfo.verb,
        input: {
          commandId: envelope.commandId,
          intent: envelope.intent,
          projectId: routeInfo.projectId,
          action,
        },
      },
    ],
    artifactDir,
    workGraphPath: resolve(artifactDir, "graph.json"),
  };
}

function directActionFor(
  routeInfo: CommandRoute,
  payload: Record<string, unknown>,
): CommandPlan["action"] {
  const projectId = routeInfo.projectId;
  if (routeInfo.verb === "project.status") {
    return {
      family: "project",
      subcommand: "status",
      args: projectId ? [projectId] : [],
      dryRunSafe: true,
    };
  }
  if (routeInfo.verb === "project.verify" && projectId) {
    return {
      family: "project",
      subcommand: "verify",
      args: [projectId],
      dryRunSafe: false,
    };
  }
  if (routeInfo.verb === "project.smoke" && projectId) {
    return {
      family: "project",
      subcommand: "smoke",
      args: [projectId],
      dryRunSafe: false,
    };
  }
  if (routeInfo.verb === "overnight.plan") {
    return { family: "overnight", subcommand: "plan", args: [], dryRunSafe: true };
  }
  if (routeInfo.verb === "overnight.brief") {
    return { family: "overnight", subcommand: "brief", args: [], dryRunSafe: true };
  }
  if (routeInfo.verb === "overnight.enqueue") {
    return {
      family: "overnight",
      subcommand: "enqueue",
      args: ["--limit", "4"],
      dryRunSafe: false,
    };
  }
  if (routeInfo.verb === "overnight.run") {
    return {
      family: "overnight",
      subcommand: "run",
      args: ["--limit", "4", "--max-concurrent", "2"],
      dryRunSafe: false,
    };
  }
  if (routeInfo.verb === "mlx.status") {
    return {
      family: "mlx",
      subcommand: "status",
      args: ["--fail-if-not-ready"],
      dryRunSafe: true,
    };
  }
  if (routeInfo.verb === "mlx.smoke") {
    return { family: "mlx", subcommand: "smoke", args: [], dryRunSafe: false };
  }
  if (routeInfo.verb === "mlx.generate") {
    return {
      family: "mlx",
      subcommand: "generate",
      args: ["--prompt", "Say ready in one word.", "--max-tokens", "8"],
      dryRunSafe: false,
    };
  }
  if (routeInfo.verb === "mlx.benchmark") {
    return {
      family: "mlx",
      subcommand: "benchmark",
      args: [
        "--prompt-tokens",
        "32",
        "--generation-tokens",
        "16",
        "--num-trials",
        "1",
        "--timeout-seconds",
        "120",
      ],
      dryRunSafe: false,
    };
  }
  if (routeInfo.verb === "helper.status") {
    return { family: "helper", subcommand: "status", args: [], dryRunSafe: true };
  }
  if (routeInfo.verb === "logs.read") {
    return {
      family: "helper",
      subcommand: "production-invoke",
      args: [
        "logs.read",
        "--path",
        "/Users/test/Library/Logs/frontier-os/frontierd.err.log",
      ],
      dryRunSafe: true,
    };
  }
  if (routeInfo.verb === "browser.inspect") {
    return browserAdapterAction("current-tab", "read", payload, true);
  }
  if (routeInfo.verb === "browser.inspect_dom") {
    return browserAdapterAction("inspect-dom", "read", payload, true);
  }
  if (routeInfo.verb === "browser.inspect_network") {
    return browserAdapterAction("inspect-network", "read", payload, true);
  }
  if (routeInfo.verb === "browser.capture_screenshot") {
    return browserAdapterAction("capture-screenshot", "read", payload, true);
  }
  if (routeInfo.verb === "browser.click_element") {
    if (!browserClickLocatorPresent(payload)) return null;
    return browserAdapterAction("click-element", "apply", payload, false);
  }
  if (routeInfo.verb === "browser.enter_text") {
    if (!browserEnterTextReady(payload)) return null;
    return browserAdapterAction("enter-text", "apply", payload, false);
  }
  if (routeInfo.verb === "browser.select_option") {
    if (!browserSelectOptionReady(payload)) return null;
    return browserAdapterAction("select-option", "apply", payload, false);
  }
  if (routeInfo.verb === "browser.navigate") {
    if (!browserNavigateReady(payload)) return null;
    return browserAdapterAction("navigate", "apply", payload, false);
  }
  if (routeInfo.verb === "salesforce.portfolio_summary") {
    return salesforceAdapterAction("portfolio-inventory", "read", payload, true);
  }
  if (routeInfo.verb === "salesforce.inspect_dashboard") {
    return salesforceAdapterAction("inspect-dashboard", "read", payload, true);
  }
  if (routeInfo.verb === "salesforce.inspect_report") {
    return salesforceAdapterAction("inspect-report", "read", payload, true);
  }
  if (routeInfo.verb === "salesforce.set_report_filter") {
    if (!salesforceReportFilterReady(payload)) return null;
    return salesforceAdapterAction("set-report-filter", "apply", payload, false);
  }
  if (routeInfo.verb === "salesforce.list_filters") {
    return salesforceAdapterAction("list-filters", "read", payload, true);
  }
  if (routeInfo.verb === "salesforce.audit_dashboard") {
    return salesforceAdapterAction("audit-dashboard", "read", payload, true);
  }
  if (routeInfo.verb === "salesforce.set_filter") {
    return salesforceAdapterAction("set-filter", "apply", payload, false);
  }
  if (routeInfo.verb === "salesforce.enter_edit_mode") {
    return salesforceAdapterAction("enter-edit-mode", "apply", payload, false);
  }
  if (routeInfo.verb === "salesforce.move_widget") {
    if (!salesforceMoveWidgetReady(payload)) return null;
    return salesforceAdapterAction("move-widget", "apply", payload, false);
  }
  if (routeInfo.verb === "salesforce.save_dashboard") {
    return salesforceAdapterAction("save-dashboard", "apply", payload, false);
  }
  if (routeInfo.verb === "ops.repair_launchagent") {
    return {
      family: "ops",
      subcommand: "repair-launchagent",
      args: ["com.frontier-os.frontierd"],
      dryRunSafe: false,
    };
  }
  return null;
}

function salesforceAdapterAction(
  command: string,
  mode: "read" | "apply",
  payload: Record<string, unknown>,
  dryRunSafe: boolean,
): CommandPlan["action"] {
  const args = ["salesforce", command, "--mode", mode];
  const adapterArguments = adapterArgumentsFromPayload(payload);
  if (Object.keys(adapterArguments).length > 0) {
    args.push("--input", JSON.stringify(adapterArguments));
  }
  return {
    family: "adapter",
    subcommand: "invoke",
    args,
    dryRunSafe,
  };
}

function salesforceRouteFromPayload(
  payload: Record<string, unknown>,
  projectId: string | null,
  explicitClass: ApprovalClass | null,
): CommandRoute | null {
  const command = adapterCommandFromPayload(payload);
  if (!command) return null;
  if (command === "inspect-dashboard") {
    return route("salesforce", "salesforce.inspect_dashboard", projectId, explicitClass);
  }
  if (command === "inspect-report") {
    return route("salesforce", "salesforce.inspect_report", projectId, explicitClass);
  }
  if (command === "set-report-filter") {
    return salesforceReportFilterRoute(payload, projectId, explicitClass);
  }
  if (command === "list-filters") {
    return route("salesforce", "salesforce.list_filters", projectId, explicitClass);
  }
  if (command === "audit-dashboard") {
    return route("salesforce", "salesforce.audit_dashboard", projectId, explicitClass);
  }
  if (command === "set-filter") {
    return salesforceSetFilterRoute(payload, projectId, explicitClass);
  }
  if (command === "enter-edit-mode") {
    return route("salesforce", "salesforce.enter_edit_mode", projectId, explicitClass);
  }
  if (command === "move-widget") {
    return salesforceMoveWidgetRoute(payload, projectId, explicitClass);
  }
  if (command === "save-dashboard") {
    return route("salesforce", "salesforce.save_dashboard", projectId, explicitClass);
  }
  if (command === "portfolio-inventory") {
    return route("salesforce", "salesforce.portfolio_summary", projectId, explicitClass);
  }
  return null;
}

function browserAdapterAction(
  command: string,
  mode: "read" | "apply",
  payload: Record<string, unknown>,
  dryRunSafe: boolean,
): CommandPlan["action"] {
  const args = ["browser", command, "--mode", mode];
  const adapterArguments = adapterArgumentsFromPayload(payload);
  if (Object.keys(adapterArguments).length > 0) {
    args.push("--input", JSON.stringify(adapterArguments));
  }
  return {
    family: "adapter",
    subcommand: "invoke",
    args,
    dryRunSafe,
  };
}

function browserRouteFromPayload(
  payload: Record<string, unknown>,
  projectId: string | null,
  explicitClass: ApprovalClass | null,
): CommandRoute | null {
  const command = adapterCommandFromPayload(payload);
  if (!command) return null;
  if (command === "current-tab") {
    return route("browser", "browser.inspect", projectId, explicitClass);
  }
  if (command === "inspect-dom") {
    return route("browser", "browser.inspect_dom", projectId, explicitClass);
  }
  if (command === "inspect-network") {
    return route("browser", "browser.inspect_network", projectId, explicitClass);
  }
  if (command === "capture-screenshot") {
    return route("browser", "browser.capture_screenshot", projectId, explicitClass);
  }
  if (command === "click-element") {
    return browserClickRoute(payload, projectId, explicitClass);
  }
  if (command === "enter-text") {
    return browserEnterTextRoute(payload, projectId, explicitClass);
  }
  if (command === "select-option") {
    return browserSelectOptionRoute(payload, projectId, explicitClass);
  }
  if (command === "navigate") {
    return browserNavigateRoute(payload, projectId, explicitClass);
  }
  return null;
}

function browserClickRoute(
  payload: Record<string, unknown>,
  projectId: string | null,
  explicitClass: ApprovalClass | null,
): CommandRoute {
  return {
    ...route("browser", "browser.click_element", projectId, explicitClass),
    missingInputs: browserClickLocatorPresent(payload)
      ? []
      : ["adapterArguments.selector|text|ariaLabel"],
  };
}

function browserEnterTextRoute(
  payload: Record<string, unknown>,
  projectId: string | null,
  explicitClass: ApprovalClass | null,
): CommandRoute {
  return {
    ...route("browser", "browser.enter_text", projectId, explicitClass),
    missingInputs: browserEnterTextMissingInputs(payload),
  };
}

function browserNavigateRoute(
  payload: Record<string, unknown>,
  projectId: string | null,
  explicitClass: ApprovalClass | null,
): CommandRoute {
  return {
    ...route("browser", "browser.navigate", projectId, explicitClass),
    missingInputs: browserNavigateMissingInputs(payload),
  };
}

function browserSelectOptionRoute(
  payload: Record<string, unknown>,
  projectId: string | null,
  explicitClass: ApprovalClass | null,
): CommandRoute {
  return {
    ...route("browser", "browser.select_option", projectId, explicitClass),
    missingInputs: browserSelectOptionMissingInputs(payload),
  };
}

function salesforceMoveWidgetRoute(
  payload: Record<string, unknown>,
  projectId: string | null,
  explicitClass: ApprovalClass | null,
): CommandRoute {
  return {
    ...route("salesforce", "salesforce.move_widget", projectId, explicitClass),
    missingInputs: salesforceMoveWidgetMissingInputs(payload),
  };
}

function salesforceReportFilterRoute(
  payload: Record<string, unknown>,
  projectId: string | null,
  explicitClass: ApprovalClass | null,
): CommandRoute {
  return {
    ...route("salesforce", "salesforce.set_report_filter", projectId, explicitClass),
    missingInputs: salesforceReportFilterMissingInputs(payload),
  };
}

function salesforceSetFilterRoute(
  payload: Record<string, unknown>,
  projectId: string | null,
  explicitClass: ApprovalClass | null,
): CommandRoute {
  return {
    ...route("salesforce", "salesforce.set_filter", projectId, explicitClass),
    missingInputs: salesforceSetFilterMissingInputs(payload),
  };
}

function adapterCommandFromPayload(payload: Record<string, unknown>): string | null {
  const value = payload.adapterCommand;
  if (typeof value !== "string") return null;
  const normalized = value.trim();
  return normalized.length > 0 ? normalized : null;
}

function adapterArgumentsFromPayload(
  payload: Record<string, unknown>,
): Record<string, unknown> {
  const value = payload.adapterArguments;
  return isRecord(value) ? value : {};
}

function browserClickLocatorPresent(payload: Record<string, unknown>): boolean {
  const args = adapterArgumentsFromPayload(payload);
  return (
    typeof args.selector === "string" ||
    typeof args.text === "string" ||
    typeof args.ariaLabel === "string"
  );
}

function browserEnterTextMissingInputs(
  payload: Record<string, unknown>,
): string[] {
  const args = adapterArgumentsFromPayload(payload);
  const missing: string[] = [];
  if (
    typeof args.selector !== "string" &&
    typeof args.text !== "string" &&
    typeof args.ariaLabel !== "string"
  ) {
    missing.push("adapterArguments.selector|text|ariaLabel");
  }
  if (typeof args.value !== "string") {
    missing.push("adapterArguments.value");
  }
  return missing;
}

function browserEnterTextReady(payload: Record<string, unknown>): boolean {
  return browserEnterTextMissingInputs(payload).length === 0;
}

function browserNavigateMissingInputs(
  payload: Record<string, unknown>,
): string[] {
  const args = adapterArgumentsFromPayload(payload);
  const missing: string[] = [];
  if (typeof args.url !== "string" || args.url.trim().length === 0) {
    missing.push("adapterArguments.url");
  }
  return missing;
}

function browserNavigateReady(payload: Record<string, unknown>): boolean {
  return browserNavigateMissingInputs(payload).length === 0;
}

function browserSelectOptionMissingInputs(
  payload: Record<string, unknown>,
): string[] {
  const args = adapterArgumentsFromPayload(payload);
  const missing: string[] = [];
  if (
    typeof args.selector !== "string" &&
    typeof args.text !== "string" &&
    typeof args.ariaLabel !== "string"
  ) {
    missing.push("adapterArguments.selector|text|ariaLabel");
  }
  if (
    typeof args.optionLabel !== "string" &&
    typeof args.optionValue !== "string"
  ) {
    missing.push("adapterArguments.optionLabel|optionValue");
  }
  return missing;
}

function browserSelectOptionReady(payload: Record<string, unknown>): boolean {
  return browserSelectOptionMissingInputs(payload).length === 0;
}

function salesforceReportFilterReady(payload: Record<string, unknown>): boolean {
  return salesforceReportFilterMissingInputs(payload).length === 0;
}

function salesforceSetFilterMissingInputs(
  payload: Record<string, unknown>,
): string[] {
  const args = adapterArgumentsFromPayload(payload);
  const missing: string[] = [];
  const variant =
    typeof args.variant === "string" && args.variant.trim().length > 0
      ? args.variant.trim()
      : "click";
  if (typeof args.filterLabel !== "string" || args.filterLabel.trim().length === 0) {
    missing.push("adapterArguments.filterLabel");
  }
  if (variant === "dropdown") {
    if (typeof args.optionLabel !== "string" || args.optionLabel.trim().length === 0) {
      missing.push("adapterArguments.optionLabel");
    }
    return missing;
  }
  if (
    typeof args.expectedNewLabel !== "string" ||
    args.expectedNewLabel.trim().length === 0
  ) {
    missing.push("adapterArguments.expectedNewLabel");
  }
  return missing;
}

function salesforceReportFilterMissingInputs(
  payload: Record<string, unknown>,
): string[] {
  const args = adapterArgumentsFromPayload(payload);
  const missing: string[] = [];
  if (typeof args.filterLabel !== "string" || args.filterLabel.trim().length === 0) {
    missing.push("adapterArguments.filterLabel");
  }
  if (typeof args.actionLabel !== "string" || args.actionLabel.trim().length === 0) {
    missing.push("adapterArguments.actionLabel");
  }
  if (
    typeof args.expectedNewLabel !== "string" ||
    args.expectedNewLabel.trim().length === 0
  ) {
    missing.push("adapterArguments.expectedNewLabel");
  }
  return missing;
}

function salesforceMoveWidgetMissingInputs(
  payload: Record<string, unknown>,
): string[] {
  const args = adapterArgumentsFromPayload(payload);
  const missing: string[] = [];
  const hasLocator =
    typeof args.selector === "string" ||
    typeof args.widgetId === "string" ||
    typeof args.widgetTitle === "string";
  if (!hasLocator) {
    missing.push("adapterArguments.selector|widgetId|widgetTitle");
  }
  const hasVector =
    typeof args.targetSelector === "string" ||
    typeof args.direction === "string" ||
    typeof args.deltaX === "number" ||
    typeof args.deltaY === "number";
  if (!hasVector) {
    missing.push("adapterArguments.targetSelector|direction|deltaX|deltaY");
  }
  return missing;
}

function salesforceMoveWidgetReady(payload: Record<string, unknown>): boolean {
  return salesforceMoveWidgetMissingInputs(payload).length === 0;
}

function initialStatus(policy: PolicyEvaluation): CommandStatus {
  if (policy.decision.status === "allow") return "queued";
  if (policy.decision.status === "requires_approval") return "blocked_approval";
  return "blocked_policy";
}

function activityStatusFor(status: CommandStatus): CommandActivityStatus {
  if (status === "blocked_approval" || status === "blocked_policy") return "blocked";
  if (status === "canceled") return "canceled";
  if (status === "failed") return "failed";
  if (status === "completed") return "completed";
  return "queued";
}

function interruptFor(
  envelope: CommandEnvelope,
  routeInfo: CommandRoute,
  policy: PolicyEvaluation,
): CommandInterrupt {
  return {
    interruptId: `int_${envelope.commandId}`,
    type: "approval",
    traceId: envelope.traceId,
    commandId: envelope.commandId,
    question: `Approve ${routeInfo.verb}?`,
    details: {
      intent: envelope.intent,
      projectId: routeInfo.projectId,
      approvalClass: routeInfo.approvalClass,
      reason: policy.decision.reason,
      sideEffects: routeInfo.sideEffects,
    },
    resume: {
      cli: `frontier command resume ${shellToken(envelope.commandId)} --approval ${shellToken(envelope.traceId)} --json`,
      apiPath: `/v1/commands/${encodeURIComponent(envelope.commandId)}/resume`,
    },
  };
}

function checkpointFor(
  commandId: string,
  status: CommandStatus,
  state: Record<string, unknown>,
): CommandCheckpoint {
  return {
    threadId: commandId,
    cursor: `${commandId}:${status}`,
    savedAt: new Date().toISOString(),
    state: { status, ...state },
  };
}

function explainedToRecord(explained: CommandExplainResult): CommandRecord {
  return {
    commandId: explained.envelope.commandId,
    traceId: explained.envelope.traceId,
    status: explained.status,
    intent: explained.envelope.intent,
    projectId: explained.route.projectId,
    actor: explained.envelope.actor.actorId,
    surface: explained.envelope.surface.channel,
    requestedAt: explained.envelope.requestedAt,
    updatedAt: explained.envelope.requestedAt,
    approvalClass: explained.route.approvalClass,
    lane: explained.route.lane,
    verb: explained.route.verb,
    route: explained.route,
    policy: explained.policy,
    plan: explained.plan,
    checkpoint: explained.checkpoint,
    interrupt: explained.interrupt,
    resumeCursor: explained.checkpoint.cursor,
    retryPolicy: explained.retryPolicy,
    idempotencyKey: explained.idempotencyKey,
    lease: { owner: null, until: null },
    result: null,
    error:
      explained.status === "blocked_policy" || explained.status === "blocked_approval"
        ? explained.policy.decision.reason
        : null,
    activities: [],
  };
}

function appendCommandLifecycle(
  record: CommandRecord,
  envelope: CommandEnvelope,
): void {
  const ledger = getLedger();
  const sessionId = commandSessionId(record.commandId);
  ledger.ensureSession({
    sessionId,
    label: `command:${record.intent.slice(0, 48)}`,
    tags: ["command", record.commandId, record.lane ?? "unknown"],
  });
  ledger.appendEvent({
    sessionId,
    kind: "command.received",
    actor: record.actor,
    traceId: record.traceId,
    payload: { envelope },
  });
  ledger.appendEvent({
    sessionId,
    kind: "command.classified",
    actor: "command.gateway",
    traceId: record.traceId,
    payload: {
      route: record.route,
      policy: record.policy,
    },
  });
  ledger.appendEvent({
    sessionId,
    kind: "command.planned",
    actor: "command.gateway",
    traceId: record.traceId,
    payload: { plan: record.plan, checkpoint: record.checkpoint },
  });
  ledger.appendEvent({
    sessionId,
    kind: record.status === "queued" ? "command.queued" : "command.state_changed",
    actor: "command.gateway",
    traceId: record.traceId,
    payload: {
      commandId: record.commandId,
      status: record.status,
      interrupt: record.interrupt,
      error: record.error,
    },
  });
}

function appendStateChanged(
  before: CommandRecord,
  after: CommandRecord,
  payload: Record<string, unknown>,
): void {
  const ledger = getLedger();
  const sessionId = commandSessionId(after.commandId);
  ledger.ensureSession({
    sessionId,
    label: `command:${after.intent.slice(0, 48)}`,
    tags: ["command", after.commandId, after.lane ?? "unknown"],
  });
  ledger.appendEvent({
    sessionId,
    kind: "command.state_changed",
    actor: "command.gateway",
    traceId: after.traceId,
    payload: {
      commandId: after.commandId,
      from: before.status,
      to: after.status,
      checkpoint: after.checkpoint,
      interrupt: after.interrupt,
      ...payload,
    },
  });
}

function appendTerminalCommandEvent(record: CommandRecord): void {
  const ledger = getLedger();
  const sessionId = commandSessionId(record.commandId);
  const execution = analyzeCommandExecution(record);
  ledger.ensureSession({
    sessionId,
    label: `command:${record.intent.slice(0, 48)}`,
    tags: ["command", record.commandId, record.lane ?? "unknown"],
  });
  ledger.appendEvent({
    sessionId,
    kind: record.status === "completed" ? "command.completed" : "command.failed",
    actor: "command.worker",
    traceId: record.traceId,
    payload: {
      commandId: record.commandId,
      status: record.status,
      lane: record.lane,
      verb: record.verb,
      approvalClass: record.approvalClass,
      result: record.result,
      error: record.error,
      execution,
      activities: record.activities.map((activity) => ({
        activityId: activity.activityId,
        status: activity.status,
        attempts: activity.attempts,
      })),
    },
  });
}

function appendOperatorLinked(
  sourceCommand: CommandRecord,
  nextCommand: CommandRecord,
  input: {
    actor: string;
    operatorAction: CommandOperatorResult["operatorAction"];
  },
): void {
  const ledger = getLedger();
  const sourceSessionId = commandSessionId(sourceCommand.commandId);
  const nextSessionId = commandSessionId(nextCommand.commandId);
  ledger.ensureSession({
    sessionId: sourceSessionId,
    label: `command:${sourceCommand.intent.slice(0, 48)}`,
    tags: ["command", sourceCommand.commandId, sourceCommand.lane ?? "unknown"],
  });
  ledger.ensureSession({
    sessionId: nextSessionId,
    label: `command:${nextCommand.intent.slice(0, 48)}`,
    tags: ["command", nextCommand.commandId, nextCommand.lane ?? "unknown"],
  });
  ledger.appendEvent({
    sessionId: sourceSessionId,
    kind: "command.state_changed",
    actor: input.actor,
    traceId: sourceCommand.traceId,
    payload: {
      commandId: sourceCommand.commandId,
      operatorAction: input.operatorAction,
      replacementCommandId: nextCommand.commandId,
      replacementTraceId: nextCommand.traceId,
    },
  });
  ledger.appendEvent({
    sessionId: nextSessionId,
    kind: "command.state_changed",
    actor: input.actor,
    traceId: nextCommand.traceId,
    payload: {
      commandId: nextCommand.commandId,
      operatorAction: input.operatorAction,
      sourceCommandId: sourceCommand.commandId,
      sourceTraceId: sourceCommand.traceId,
    },
  });
}

function commandSessionId(commandId: string): string {
  return `command-${commandId}`;
}

function requireCommand(
  record: CommandRecord | null,
  commandId: string,
): CommandRecord {
  if (!record) throw new Error(`unknown command: ${commandId}`);
  return record;
}

function assertValidCommandEnvelope(envelope: CommandEnvelope): void {
  if (!validateCommandEnvelope(envelope)) {
    throw new Error(
      `command envelope failed schema validation: ${JSON.stringify(
        validateCommandEnvelope.errors,
      )}`,
    );
  }
}

function activityId(commandId: string, sequence: number): string {
  return `${commandId}:act:${sequence}`;
}

function activityFromRow(row: ActivityRow): CommandActivity {
  return {
    activityId: row.activityId,
    commandId: row.commandId,
    sequence: row.sequence,
    lane: row.lane,
    name: row.name,
    verb: row.verb,
    status: row.status,
    attempts: row.attempts,
    input: parseJson<Record<string, unknown>>(row.inputJson) ?? {},
    output: parseJson<Record<string, unknown>>(row.outputJson),
    idempotencyKey: row.idempotencyKey,
    lease:
      row.leaseOwner || row.leaseUntil
        ? { owner: row.leaseOwner, until: row.leaseUntil }
        : null,
    startedAt: row.startedAt,
    finishedAt: row.finishedAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function clampLimit(limit: number): number {
  return Math.min(Math.max(Math.trunc(limit), 1), 100);
}

function json(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  return JSON.stringify(value);
}

function parseJson<T>(raw: string | null): T | null {
  if (!raw) return null;
  return JSON.parse(raw) as T;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function shellToken(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

function operatorSubmitInput(
  command: CommandRecord,
  input: {
    actor: string;
    operatorAction: CommandOperatorResult["operatorAction"];
  },
): SubmitCommandInput {
  const execution = commandExecutionPolicy(command);
  const failure = analyzeCommandExecution(command).failure;
  const payload: Record<string, unknown> = {
    sourceCommandId: command.commandId,
    sourceTraceId: command.traceId,
    sourceStatus: command.status,
    sourceFailureKind: failure.kind,
    operatorAction: input.operatorAction,
  };
  const submitInput: SubmitCommandInput = {
    intent: command.intent,
    actorId: input.actor,
    surface: surfaceChannelForRecord(command.surface),
    origin: `frontier-command-${input.operatorAction}`,
    correlationId: command.commandId,
    payload,
    policy: {
      maxRuntimeSeconds: execution.maxRuntimeSeconds,
      maxRetries: Math.max(0, execution.maxAttempts - 1),
      retryBackoffMs: execution.backoffMs,
      requireVerification: execution.requireVerification,
      ...(execution.allowSideEffects !== null
        ? { allowSideEffects: execution.allowSideEffects }
        : {}),
    },
  };
  if (command.projectId) submitInput.projectId = command.projectId;
  if (command.approvalClass !== null) {
    submitInput.approvalClass = command.approvalClass;
  }
  return submitInput;
}

function surfaceChannelForRecord(surface: string): CommandSurfaceChannel {
  if (
    surface === "cli" ||
    surface === "siri_shortcut" ||
    surface === "apple_app_intent" ||
    surface === "mobile_app" ||
    surface === "menu_bar" ||
    surface === "web" ||
    surface === "api" ||
    surface === "automation"
  ) {
    return surface;
  }
  return "automation";
}
