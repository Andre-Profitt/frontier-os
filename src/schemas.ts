// Load frontier-os JSON schemas and expose typed ajv validators.
// The schemas in ./schemas/ are the source of truth; this module mirrors their
// runtime shape as TS types and provides validate() functions for CLI I/O.

import Ajv2020, { type ValidateFunction } from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const SCHEMA_DIR = resolve(__dirname, "..", "schemas");

const ajv = new Ajv2020({ allErrors: true, strict: false });
addFormats(ajv);

function load(name: string): object {
  const path = resolve(SCHEMA_DIR, name);
  return JSON.parse(readFileSync(path, "utf8"));
}

const adapterManifestSchema = load("adapter-manifest.schema.json");
const adapterInvocationSchema = load("adapter-invocation.schema.json");
const adapterResultSchema = load("adapter-result.schema.json");
const watcherSpecSchema = load("watcher-spec.schema.json");
const alertEventSchema = load("alert-event.schema.json");
const workGraphSchema = load("work-graph.schema.json");
const projectManifestSchema = load("project-manifest.schema.json");
const commandEnvelopeSchema = load("command-envelope.schema.json");
const commandResultSchema = load("command-result.schema.json");
const skillSchema = load("skill.schema.json");

export const validateAdapterManifest: ValidateFunction = ajv.compile(
  adapterManifestSchema,
);
export const validateAdapterInvocation: ValidateFunction = ajv.compile(
  adapterInvocationSchema,
);
export const validateAdapterResult: ValidateFunction =
  ajv.compile(adapterResultSchema);
export const validateWatcherSpec: ValidateFunction =
  ajv.compile(watcherSpecSchema);
export const validateAlertEvent: ValidateFunction =
  ajv.compile(alertEventSchema);
export const validateWorkGraph: ValidateFunction = ajv.compile(workGraphSchema);
export const validateProjectManifest: ValidateFunction = ajv.compile(
  projectManifestSchema,
);
export const validateCommandEnvelope: ValidateFunction = ajv.compile(
  commandEnvelopeSchema,
);
export const validateCommandResult: ValidateFunction =
  ajv.compile(commandResultSchema);
export const validateSkill: ValidateFunction = ajv.compile(skillSchema);

// ---- TypeScript mirrors of the JSON schemas (kept in sync manually) ----

export type AdapterMode = "read" | "propose" | "apply" | "undo";

export type SideEffectClass =
  // Unified superset (Phase 18c) — adapter-manifest, adapter-result, and
  // work-graph schemas all speak the same 12-value vocabulary now.
  | "auth_change"
  | "billable_action"
  | "deploy"
  | "destructive_action"
  | "external_message"
  | "financial_action"
  | "local_write"
  | "none"
  | "pr_open"
  | "repo_write"
  | "shared_write"
  | "ticket_write";

export type AdapterStatus =
  | "success"
  | "partial"
  | "blocked"
  | "requires_approval"
  | "failed";

export interface AdapterManifestCommand {
  command: string;
  summary: string;
  supportedModes: AdapterMode[];
  sideEffectClass: SideEffectClass;
  verifierHints?: string[];
  undoSupported?: boolean;
}

export interface AdapterManifest {
  adapterId: string;
  version: string;
  displayName: string;
  owner: string;
  summary: string;
  transport: string;
  modes: AdapterMode[];
  approvalDefaults?: {
    defaultClass?: number;
    billableClass?: number;
    destructiveClass?: number;
  };
  commands: AdapterManifestCommand[];
}

export interface AdapterInvocation {
  invocationId: string;
  adapterId: string;
  command: string;
  mode: AdapterMode;
  requestedAt: string;
  trace?: {
    traceId?: string;
    intentId?: string;
    graphId?: string;
    nodeId?: string;
    actorId?: string;
  };
  policy?: {
    approvalClass?: 0 | 1 | 2 | 3;
    allowSideEffects?: boolean;
    requireVerification?: boolean;
    maxRuntimeSeconds?: number;
  };
  context?: Record<string, unknown>;
  arguments: Record<string, unknown>;
}

export interface AdapterArtifact {
  kind:
    | "file"
    | "url"
    | "trace"
    | "screenshot"
    | "dom_snapshot"
    | "api_response"
    | "console_capture";
  ref: string;
  note?: string;
}

export interface AdapterSideEffect {
  class: SideEffectClass;
  target?: string;
  summary: string;
}

export interface AdapterResult {
  invocationId: string;
  adapterId: string;
  command: string;
  status: AdapterStatus;
  finishedAt: string;
  summary?: string;
  observedState?: Record<string, unknown>;
  artifacts?: AdapterArtifact[];
  sideEffects?: AdapterSideEffect[];
  verification?: {
    status?: "not_run" | "passed" | "failed";
    checks?: string[];
  };
  alerts?: string[];
  suggestedNextActions?: string[];
}

// ---- Project manifest mirror ----

export type ProjectKind =
  | "control-plane"
  | "workbench"
  | "platform"
  | "analytics"
  | "ml-lab"
  | "application"
  | "service"
  | "dormant";

export type ProjectPriority =
  | "critical"
  | "high"
  | "medium"
  | "low"
  | "dormant";

export interface ProjectCommandSpec {
  summary: string;
  argv: string[];
  cwd?: string;
  approvalClass: 0 | 1 | 2 | 3;
  sideEffectClass: SideEffectClass;
  timeoutSeconds?: number;
}

export interface ProjectLogPath {
  label: string;
  path: string;
  kind?: "stdout" | "stderr" | "combined" | "directory" | "file";
}

export interface ProjectPort {
  label: string;
  port: number;
  protocol: "tcp" | "udp";
  required: boolean;
}

export interface ProjectService {
  id: string;
  label: string;
  kind: "process" | "launchagent" | "http" | "cli" | "unknown";
  required: boolean;
  processPattern?: string;
  launchAgentLabel?: string;
  port?: number;
  logPaths?: string[];
}

export interface ProjectManifest {
  id: string;
  name: string;
  root: string;
  kind: ProjectKind;
  priority: ProjectPriority;
  owner: string;
  riskClass: 0 | 1 | 2 | 3;
  commands: {
    verify?: ProjectCommandSpec;
    smoke?: ProjectCommandSpec;
    dev?: ProjectCommandSpec;
    logs?: ProjectLogPath[];
  };
  services: ProjectService[];
  ports: ProjectPort[];
  envFiles: string[];
  secretsPolicy: {
    summary: string;
    allowEnvFiles: boolean;
    keychainItems?: string[];
  };
  ledgerTags: string[];
  notes: string[];
}

// ---- Watcher spec + alert event mirrors ----

export type WatcherScheduleMode = "interval" | "cron" | "event" | "manual";

export interface WatcherSpec {
  watcherId: string;
  version: string;
  summary: string;
  schedule: {
    mode: WatcherScheduleMode;
    intervalSeconds?: number;
    cron?: string;
    eventSources?: string[];
  };
  inputs: string[];
  trigger: {
    condition: string;
    dedupeKey?: string;
  };
  actionPlan: Array<{
    stepId: string;
    adapterId: string;
    command: string;
    mode: AdapterMode;
    when?: string;
    maxAttempts?: number;
  }>;
  policy: {
    approvalClass: 0 | 1 | 2 | 3;
    notifyBeforeAct?: boolean;
    maxActionsPerDay?: number;
    killSwitchFile?: string;
  };
}

export type AlertCategory =
  | "cost"
  | "work"
  | "failure"
  | "health"
  | "security"
  | "recommendation";

export type AlertSeverity = "info" | "low" | "medium" | "high" | "critical";

export type AlertStatus = "open" | "acked" | "resolved" | "suppressed";

export interface AlertEvent {
  alertId: string;
  createdAt: string;
  source: string;
  category: AlertCategory;
  severity: AlertSeverity;
  summary: string;
  status: AlertStatus;
  dedupeKey?: string;
  recommendedActions?: string[];
  traceId?: string;
  /**
   * Optional structured payload — watcher-specific state (snapshots, diffs,
   * evidence objects). Opaque to AlertEvent consumers but inspectable in
   * the ledger. Keep small; heavy artifacts belong in separate events.
   */
  context?: Record<string, unknown>;
}

export function schemaDir(): string {
  return SCHEMA_DIR;
}
