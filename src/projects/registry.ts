import Database from "better-sqlite3";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { defaultLedgerPath } from "../ledger/index.ts";
import {
  processMatches,
  probeTcpPort,
  readLaunchdList,
  readProcessTable,
  runReadOnlyCommand,
  summarizeProcesses,
  type LaunchdEntry,
  type ProcessInfo,
  type TcpPortProbe,
} from "../system/probes.ts";
import {
  validateProjectManifest,
  type ProjectCommandSpec,
  type ProjectManifest,
} from "../schemas.ts";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const REPO_ROOT = resolve(__dirname, "..", "..");
const MANIFEST_DIR = resolve(REPO_ROOT, "manifests", "projects");

export interface ProjectListItem {
  id: string;
  name: string;
  root: string;
  kind: string;
  priority: string;
  owner: string;
  riskClass: 0 | 1 | 2 | 3;
  rootExists: boolean;
}

export interface ProjectCommandStatus {
  declared: boolean;
  runner: "available" | "not_implemented";
  summary?: string;
  argv?: string[];
  cwd?: string;
  approvalClass?: 0 | 1 | 2 | 3;
  sideEffectClass?: string;
}

export interface ProjectGitStatus {
  available: boolean;
  branch: string | null;
  dirty: boolean;
  changedFiles: number;
  untrackedFiles: number;
  statusSample: string[];
  error: string | null;
}

export interface ProjectServiceStatus {
  id: string;
  label: string;
  kind: string;
  required: boolean;
  status: "running" | "open" | "loaded" | "stopped" | "missing" | "unknown";
  processMatches: ProcessInfo[];
  launchAgent: LaunchdEntry | null;
  port: TcpPortProbe | null;
}

export interface ProjectLedgerSummary {
  path: string;
  status: "ok" | "missing" | "unavailable";
  matchedTags: string[];
  latestSessions: Array<{
    sessionId: string;
    startedAt: string;
    label: string | null;
    tags: string[];
    lastEventAt: string | null;
    eventCount: number;
  }>;
  error: string | null;
}

export interface ProjectStatus {
  id: string;
  name: string;
  root: string;
  rootExists: boolean;
  kind: string;
  priority: string;
  riskClass: 0 | 1 | 2 | 3;
  health: "ok" | "attention" | "missing" | "unknown";
  commands: {
    verify: ProjectCommandStatus;
    smoke: ProjectCommandStatus;
    dev: ProjectCommandStatus;
    logs: ProjectManifest["commands"]["logs"];
  };
  git: ProjectGitStatus;
  ports: Array<ProjectManifest["ports"][number] & TcpPortProbe>;
  services: ProjectServiceStatus[];
  envFiles: Array<{ path: string; exists: boolean }>;
  ledger: ProjectLedgerSummary;
  notes: string[];
}

interface ProjectStatusContext {
  processes: ProcessInfo[];
  launchd: Map<string, LaunchdEntry>;
}

export function loadProjectManifests(): ProjectManifest[] {
  const files = readdirSync(MANIFEST_DIR).filter((f) =>
    f.endsWith(".project.json"),
  );
  const manifests: ProjectManifest[] = [];
  for (const file of files) {
    const path = resolve(MANIFEST_DIR, file);
    const raw = JSON.parse(readFileSync(path, "utf8"));
    if (!validateProjectManifest(raw)) {
      throw new Error(
        `project manifest ${file} failed schema validation: ${JSON.stringify(
          validateProjectManifest.errors,
          null,
          2,
        )}`,
      );
    }
    manifests.push(raw as ProjectManifest);
  }
  return manifests.sort((a, b) => a.id.localeCompare(b.id));
}

export function findProjectManifest(id: string): ProjectManifest {
  const manifest = loadProjectManifests().find((p) => p.id === id);
  if (!manifest) throw new Error(`unknown project: ${id}`);
  return manifest;
}

export function listProjects(): ProjectListItem[] {
  return loadProjectManifests().map((manifest) => ({
    id: manifest.id,
    name: manifest.name,
    root: manifest.root,
    kind: manifest.kind,
    priority: manifest.priority,
    owner: manifest.owner,
    riskClass: manifest.riskClass,
    rootExists: existsSync(manifest.root),
  }));
}

export async function projectStatus(
  id?: string,
): Promise<ProjectStatus | ProjectStatus[]> {
  const manifests = id ? [findProjectManifest(id)] : loadProjectManifests();
  const context: ProjectStatusContext = {
    processes: readProcessTable(),
    launchd: readLaunchdList(),
  };
  const statuses: ProjectStatus[] = [];
  for (const manifest of manifests) {
    statuses.push(await statusForProject(manifest, context));
  }
  return id ? statuses[0]! : statuses;
}

async function statusForProject(
  manifest: ProjectManifest,
  context: ProjectStatusContext,
): Promise<ProjectStatus> {
  const rootExists = existsSync(manifest.root);
  const git = rootExists ? gitStatus(manifest.root) : missingGitStatus();
  const ports = await Promise.all(
    manifest.ports.map(async (declaredPort) => ({
      ...declaredPort,
      ...(await probeTcpPort(declaredPort.port)),
    })),
  );
  const portByNumber = new Map(ports.map((port) => [port.port, port]));
  const services: ProjectServiceStatus[] = [];
  for (const service of manifest.services) {
    const matches = service.processPattern
      ? summarizeProcesses(processMatches(context.processes, service.processPattern))
      : [];
    const launchAgent = service.launchAgentLabel
      ? context.launchd.get(service.launchAgentLabel) ?? null
      : null;
    const port =
      service.port !== undefined
        ? portByNumber.get(service.port) ?? (await probeTcpPort(service.port))
        : null;
    let status: ProjectServiceStatus["status"] = "unknown";
    if (launchAgent) status = "loaded";
    else if (matches.length > 0) status = "running";
    else if (port?.open) status = "open";
    else if (service.launchAgentLabel && !launchAgent) status = "missing";
    else if (service.processPattern || service.port !== undefined) status = "stopped";
    services.push({
      id: service.id,
      label: service.label,
      kind: service.kind,
      required: service.required,
      status,
      processMatches: matches,
      launchAgent,
      port,
    });
  }
  const requiredMissing = services.some(
    (service) =>
      service.required &&
      (service.status === "missing" || service.status === "stopped"),
  );
  const health: ProjectStatus["health"] = !rootExists
    ? "missing"
    : requiredMissing
      ? "attention"
      : git.available && git.dirty
        ? "attention"
        : git.available
          ? "ok"
          : "unknown";

  return {
    id: manifest.id,
    name: manifest.name,
    root: manifest.root,
    rootExists,
    kind: manifest.kind,
    priority: manifest.priority,
    riskClass: manifest.riskClass,
    health,
    commands: {
      verify: commandStatus(manifest.commands.verify),
      smoke: commandStatus(manifest.commands.smoke),
      dev: commandStatus(manifest.commands.dev),
      logs: manifest.commands.logs ?? [],
    },
    git,
    ports,
    services,
    envFiles: manifest.envFiles.map((path) => ({
      path,
      exists: existsSync(path),
    })),
    ledger: latestLedgerSessions(manifest.ledgerTags),
    notes: manifest.notes,
  };
}

function commandStatus(
  command: ProjectCommandSpec | undefined,
): ProjectCommandStatus {
  if (!command) return { declared: false, runner: "not_implemented" };
  const status: ProjectCommandStatus = {
    declared: true,
    runner: "available",
    summary: command.summary,
    argv: command.argv,
    approvalClass: command.approvalClass,
    sideEffectClass: command.sideEffectClass,
  };
  if (command.cwd !== undefined) status.cwd = command.cwd;
  return status;
}

function gitStatus(root: string): ProjectGitStatus {
  const env = { ...process.env, GIT_OPTIONAL_LOCKS: "0" };
  const inside = runReadOnlyCommand(
    "git",
    ["-c", "core.fsmonitor=false", "rev-parse", "--is-inside-work-tree"],
    { cwd: root, timeoutMs: 2000, env },
  );
  if (!inside.ok) {
    return {
      available: false,
      branch: null,
      dirty: false,
      changedFiles: 0,
      untrackedFiles: 0,
      statusSample: [],
      error: inside.stderr.trim() || inside.error || "not a git worktree",
    };
  }
  const branch = runReadOnlyCommand(
    "git",
    ["-c", "core.fsmonitor=false", "branch", "--show-current"],
    { cwd: root, timeoutMs: 2000, env },
  );
  const porcelain = runReadOnlyCommand(
    "git",
    ["-c", "core.fsmonitor=false", "status", "--short", "--", "."],
    { cwd: root, timeoutMs: 3000, env },
  );
  const lines = porcelain.stdout
    .split("\n")
    .map((line) => line.trimEnd())
    .filter(Boolean);
  return {
    available: true,
    branch: branch.stdout.trim() || null,
    dirty: lines.length > 0,
    changedFiles: lines.filter((line) => !line.startsWith("??")).length,
    untrackedFiles: lines.filter((line) => line.startsWith("??")).length,
    statusSample: lines.slice(0, 20),
    error: porcelain.ok ? null : porcelain.stderr.trim() || porcelain.error || null,
  };
}

function missingGitStatus(): ProjectGitStatus {
  return {
    available: false,
    branch: null,
    dirty: false,
    changedFiles: 0,
    untrackedFiles: 0,
    statusSample: [],
    error: "project root missing",
  };
}

function latestLedgerSessions(tags: string[]): ProjectLedgerSummary {
  const path = defaultLedgerPath();
  if (!existsSync(path)) {
    return {
      path,
      status: "missing",
      matchedTags: tags,
      latestSessions: [],
      error: null,
    };
  }
  try {
    const db = new Database(path, { readonly: true, fileMustExist: true });
    try {
      const rows = db
        .prepare(
          `SELECT session_id as sessionId, started_at as startedAt, label, tags,
                  last_event_at as lastEventAt,
                  (SELECT COUNT(*) FROM events e WHERE e.session_id = sessions.session_id) as eventCount
           FROM sessions
           ORDER BY COALESCE(last_event_at, started_at) DESC
           LIMIT 250`,
        )
        .all() as Array<{
        sessionId: string;
        startedAt: string;
        label: string | null;
        tags: string;
        lastEventAt: string | null;
        eventCount: number;
      }>;
      const tagSet = new Set(tags);
      const latestSessions = rows
        .map((row) => ({
          sessionId: row.sessionId,
          startedAt: row.startedAt,
          label: row.label,
          tags: parseTags(row.tags),
          lastEventAt: row.lastEventAt,
          eventCount: row.eventCount,
        }))
        .filter((row) => row.tags.some((tag) => tagSet.has(tag)))
        .slice(0, 5);
      return {
        path,
        status: "ok",
        matchedTags: tags,
        latestSessions,
        error: null,
      };
    } finally {
      db.close();
    }
  } catch (err) {
    return {
      path,
      status: "unavailable",
      matchedTags: tags,
      latestSessions: [],
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

function parseTags(raw: string): string[] {
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((tag) => typeof tag === "string") : [];
  } catch {
    return [];
  }
}
