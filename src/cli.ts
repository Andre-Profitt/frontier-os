#!/usr/bin/env tsx
// frontier CLI entrypoint.
// Usage:
//   frontier adapter list
//   frontier adapter show <adapterId>
//   frontier adapter invoke <adapterId> <command> [--mode read|propose|apply|undo]
//                                                 [--input <json|path>]
//                                                 [--pretty]

import { readFileSync } from "node:fs";
import { existsSync } from "node:fs";

import { loadManifests, findManifest, resolveAdapter } from "./registry.ts";
import {
  validateAdapterInvocation,
  validateAdapterResult,
  type AdapterInvocation,
  type AdapterMode,
  type AdapterResult,
} from "./schemas.ts";
import { newInvocationId } from "./result.ts";
import { getLedger, closeLedger, defaultArchiveDir } from "./ledger/index.ts";
import { newSessionId } from "./ledger/events.ts";
import {
  loadWatcherManifests,
  findWatcherSpec,
  runWatcher,
} from "./watchers/runtime.ts";

interface ParsedArgs {
  family: string;
  subcommand?: string;
  positional: string[];
  flags: Record<string, string | boolean>;
}

function parseArgs(argv: string[]): ParsedArgs {
  const tokens = argv.slice(2);
  const allPositional: string[] = [];
  const flags: Record<string, string | boolean> = {};
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i]!;
    if (token.startsWith("--")) {
      const key = token.slice(2);
      const next = tokens[i + 1];
      if (next === undefined || next.startsWith("--")) {
        flags[key] = true;
      } else {
        flags[key] = next;
        i++;
      }
    } else {
      allPositional.push(token);
    }
  }
  const family = allPositional[0] ?? "";
  const subcommand = allPositional[1];
  const positional = allPositional.slice(2);
  const parsed: ParsedArgs = {
    family,
    positional,
    flags,
  };
  if (subcommand !== undefined) parsed.subcommand = subcommand;
  return parsed;
}

function out(obj: unknown, pretty: boolean): void {
  process.stdout.write(
    (pretty ? JSON.stringify(obj, null, 2) : JSON.stringify(obj)) + "\n",
  );
}

function err(obj: unknown): never {
  process.stderr.write(JSON.stringify(obj) + "\n");
  process.exit(1);
}

function parseInputFlag(value: unknown): Record<string, unknown> {
  if (value === undefined || value === true || value === false) return {};
  const str = String(value);
  // If it looks like a path, read it.
  if (existsSync(str)) {
    try {
      return JSON.parse(readFileSync(str, "utf8"));
    } catch (e) {
      throw new Error(`--input path ${str} is not valid JSON: ${String(e)}`);
    }
  }
  // Otherwise, treat as literal JSON.
  try {
    return JSON.parse(str);
  } catch (e) {
    throw new Error(`--input is neither a file nor valid JSON: ${String(e)}`);
  }
}

async function cmdAdapterList(pretty: boolean): Promise<void> {
  const manifests = loadManifests();
  out(
    {
      adapters: manifests.map((m) => ({
        adapterId: m.adapterId,
        version: m.version,
        displayName: m.displayName,
        transport: m.transport,
        summary: m.summary,
        commands: m.commands.map((c) => c.command),
      })),
    },
    pretty,
  );
}

async function cmdAdapterShow(
  adapterId: string | undefined,
  pretty: boolean,
): Promise<void> {
  if (!adapterId) err({ error: "adapter show requires an adapterId" });
  const manifest = findManifest(adapterId!);
  out({ manifest }, pretty);
}

async function cmdAdapterInvoke(
  args: ParsedArgs,
  pretty: boolean,
): Promise<void> {
  const adapterId = args.positional[0];
  const command = args.positional[1];
  if (!adapterId || !command) {
    err({
      error:
        "usage: frontier adapter invoke <adapterId> <command> [--mode read|propose|apply|undo] [--input <json|path>]",
    });
  }
  const mode = (args.flags.mode ?? "read") as AdapterMode;
  if (!["read", "propose", "apply", "undo"].includes(mode)) {
    err({ error: `invalid --mode value: ${mode}` });
  }
  let parsedInput: Record<string, unknown>;
  try {
    parsedInput = parseInputFlag(args.flags.input);
  } catch (e) {
    return err({ error: (e as Error).message });
  }

  const invocation: AdapterInvocation = {
    invocationId: newInvocationId(),
    adapterId: adapterId!,
    command: command!,
    mode,
    requestedAt: new Date().toISOString(),
    arguments: parsedInput,
  };

  if (!validateAdapterInvocation(invocation)) {
    return err({
      error: "invocation failed schema validation",
      details: validateAdapterInvocation.errors,
    });
  }

  // --- Ledger: open a session and log the invocation start ---
  const sessionOverride =
    typeof args.flags.session === "string" ? args.flags.session : null;
  const sessionId = sessionOverride ?? newSessionId(`${adapterId}-${command}`);
  const ledger = getLedger();
  ledger.ensureSession({
    sessionId,
    label: `${adapterId}:${command}`,
    tags: [adapterId!, command!, mode],
  });
  ledger.appendEvent({
    sessionId,
    kind: "invocation.start",
    actor: "cli",
    traceId: invocation.invocationId,
    payload: {
      invocationId: invocation.invocationId,
      adapterId: invocation.adapterId,
      command: invocation.command,
      mode: invocation.mode,
      arguments: invocation.arguments,
    },
  });

  const adapter = await resolveAdapter(adapterId!);
  const result = await adapter.invoke(invocation);

  if (!validateAdapterResult(result)) {
    ledger.appendEvent({
      sessionId,
      kind: "invocation.end",
      actor: adapterId!,
      traceId: invocation.invocationId,
      payload: {
        invocationId: invocation.invocationId,
        status: "schema_invalid",
      },
    });
    return err({
      error: "adapter returned a result that failed schema validation",
      details: validateAdapterResult.errors,
      result,
    });
  }

  // --- Ledger: log the invocation end + any audit signal ---
  logResultToLedger(sessionId, result);

  out({ ...result, sessionId }, pretty);
  closeLedger();
  if (result.status === "failed") process.exit(2);
}

function logResultToLedger(sessionId: string, result: AdapterResult): void {
  const ledger = getLedger();
  ledger.appendEvent({
    sessionId,
    kind: "invocation.end",
    actor: result.adapterId,
    traceId: result.invocationId,
    payload: {
      invocationId: result.invocationId,
      adapterId: result.adapterId,
      command: result.command,
      status: result.status,
      summary: result.summary,
      verification: result.verification,
      alertCount: result.alerts?.length ?? 0,
      artifactCount: result.artifacts?.length ?? 0,
      sideEffectCount: result.sideEffects?.length ?? 0,
    },
  });

  // Artifacts as individual events so they're individually queryable.
  for (const artifact of result.artifacts ?? []) {
    ledger.appendEvent({
      sessionId,
      kind: "artifact",
      actor: result.adapterId,
      traceId: result.invocationId,
      payload: {
        kind: artifact.kind,
        ref: artifact.ref,
        note: artifact.note,
      },
    });
  }

  // Side effects as individual events.
  for (const sideEffect of result.sideEffects ?? []) {
    ledger.appendEvent({
      sessionId,
      kind: "side_effect",
      actor: result.adapterId,
      traceId: result.invocationId,
      payload: {
        class: sideEffect.class,
        target: sideEffect.target,
        summary: sideEffect.summary,
      },
    });
  }

  // Audit output: write one audit.grade event + one finding event per finding
  // when observedState.audit exists. This makes audit findings individually
  // queryable via `frontier ledger search --kind finding`.
  const observed = result.observedState as
    | {
        audit?: {
          grade?: Record<string, number | boolean>;
          gradeLine?: string;
          findings?: Array<Record<string, unknown>>;
        };
        dashboard?: {
          widgetReports?: Record<string, Record<string, unknown>>;
        };
        enrichment?: {
          status?: string;
          dashboardId?: string;
          componentCount?: number;
          reportCount?: number;
          widgetCount?: number;
        };
      }
    | undefined;
  const audit = observed?.audit;
  if (audit?.grade) {
    ledger.appendEvent({
      sessionId,
      kind: "audit.grade",
      actor: result.adapterId,
      traceId: result.invocationId,
      payload: {
        grade: audit.grade,
        gradeLine: audit.gradeLine,
        findingCount: audit.findings?.length ?? 0,
      },
    });
    for (const finding of audit.findings ?? []) {
      ledger.appendEvent({
        sessionId,
        kind: "finding",
        actor: result.adapterId,
        traceId: result.invocationId,
        payload: finding,
      });
    }
    // Persist the per-dashboard widget -> report map when enrichment ran.
    // Downstream (portfolio-summary cross-dashboard analysis) uses this to
    // detect shared reports across dashboards + build the stale-reports
    // inventory without re-hitting SF for every summary run.
    if (
      observed?.enrichment?.status === "ok" &&
      observed.dashboard?.widgetReports
    ) {
      ledger.appendEvent({
        sessionId,
        kind: "audit.enrichment",
        actor: result.adapterId,
        traceId: result.invocationId,
        payload: {
          dashboardId: observed.enrichment.dashboardId ?? null,
          componentCount: observed.enrichment.componentCount ?? 0,
          reportCount: observed.enrichment.reportCount ?? 0,
          widgetReports: observed.dashboard.widgetReports,
        },
      });
    }
  }
}

async function cmdLedgerListSessions(
  args: ParsedArgs,
  pretty: boolean,
): Promise<void> {
  const limit =
    typeof args.flags.limit === "string" ? parseInt(args.flags.limit, 10) : 50;
  const ledger = getLedger();
  const sessions = ledger.listSessions(limit);
  closeLedger();
  out({ sessions }, pretty);
}

async function cmdLedgerShow(args: ParsedArgs, pretty: boolean): Promise<void> {
  const sessionId = args.positional[0];
  if (!sessionId) return err({ error: "ledger show requires a sessionId" });
  const offset =
    typeof args.flags.offset === "string" ? parseInt(args.flags.offset, 10) : 0;
  const limit =
    typeof args.flags.limit === "string" ? parseInt(args.flags.limit, 10) : 500;
  const ledger = getLedger();
  const session = ledger.getSessionSummary(sessionId);
  if (!session) {
    closeLedger();
    return err({ error: `no session with id ${sessionId}` });
  }
  const events = ledger.getEvents(sessionId, { offset, limit });
  closeLedger();
  out({ session, events }, pretty);
}

async function cmdLedgerSearch(
  args: ParsedArgs,
  pretty: boolean,
): Promise<void> {
  const kind =
    typeof args.flags.kind === "string" ? args.flags.kind : undefined;
  if (!kind) return err({ error: "ledger search requires --kind <kind>" });
  const limit =
    typeof args.flags.limit === "string" ? parseInt(args.flags.limit, 10) : 50;
  const ledger = getLedger();
  const events = ledger.findEventsByKind(kind, limit);
  closeLedger();
  out({ kind, count: events.length, events }, pretty);
}

async function cmdLedgerStats(pretty: boolean): Promise<void> {
  const ledger = getLedger();
  const stats = ledger.stats();
  closeLedger();
  out(stats, pretty);
}

// ---- ledger log: cross-tool agent-event writer (Phase 2 bridge) ----
//
// Hook-driven entry point for Claude Code / Codex to append agent events
// alongside normal Frontier OS events. Payload is read from stdin if present,
// or passed via --payload <json|path>. Session is auto-created if missing.
async function cmdLedgerLog(args: ParsedArgs, pretty: boolean): Promise<void> {
  const agent = typeof args.flags.agent === "string" ? args.flags.agent : "";
  const kindRaw = typeof args.flags.kind === "string" ? args.flags.kind : "";
  if (!agent)
    return err({ error: "ledger log requires --agent <claude|codex|...>" });
  if (!kindRaw) return err({ error: "ledger log requires --kind <agent.*>" });
  if (!kindRaw.startsWith("agent.")) {
    return err({
      error: `ledger log --kind must start with "agent.": got ${kindRaw}`,
    });
  }

  const sessionIdOverride =
    typeof args.flags.session === "string" ? args.flags.session : null;
  const sessionId = sessionIdOverride ?? newSessionId(`${agent}-adhoc`);
  const traceId =
    typeof args.flags["trace-id"] === "string" ? args.flags["trace-id"] : null;
  const tool = typeof args.flags.tool === "string" ? args.flags.tool : null;
  const label = typeof args.flags.label === "string" ? args.flags.label : null;

  // Payload: prefer stdin if piped, else --payload flag, else empty.
  let payload: Record<string, unknown> = {};
  if (!process.stdin.isTTY) {
    const chunks: Buffer[] = [];
    for await (const chunk of process.stdin) {
      chunks.push(Buffer.from(chunk));
    }
    const raw = Buffer.concat(chunks).toString("utf8").trim();
    if (raw) {
      try {
        payload = JSON.parse(raw);
      } catch (e) {
        return err({ error: "stdin is not valid JSON", message: String(e) });
      }
    }
  }
  if (Object.keys(payload).length === 0 && args.flags.payload !== undefined) {
    try {
      payload = parseInputFlag(args.flags.payload);
    } catch (e) {
      return err({ error: (e as Error).message });
    }
  }

  if (tool !== null) payload = { tool, ...payload };
  if (label !== null) payload = { label, ...payload };

  const ledger = getLedger();
  ledger.ensureSession({
    sessionId,
    label: `agent:${agent}`,
    tags: ["agent", agent],
  });
  ledger.appendEvent({
    sessionId,
    kind: kindRaw as Parameters<typeof ledger.appendEvent>[0]["kind"],
    actor: agent,
    ...(traceId !== null ? { traceId } : {}),
    payload,
  });
  closeLedger();
  out({ sessionId, agent, kind: kindRaw, tool }, pretty);
}

async function cmdWatcherList(pretty: boolean): Promise<void> {
  const specs = loadWatcherManifests();
  out(
    {
      watchers: specs.map((s) => ({
        watcherId: s.watcherId,
        version: s.version,
        summary: s.summary,
        schedule: s.schedule,
        policy: s.policy,
      })),
    },
    pretty,
  );
}

async function cmdWatcherShow(
  args: ParsedArgs,
  pretty: boolean,
): Promise<void> {
  const watcherId = args.positional[0];
  if (!watcherId) return err({ error: "watcher show requires a watcherId" });
  const spec = findWatcherSpec(watcherId);
  out({ spec }, pretty);
}

async function cmdWatcherRun(args: ParsedArgs, pretty: boolean): Promise<void> {
  const watcherId = args.positional[0];
  if (!watcherId) return err({ error: "watcher run requires a watcherId" });
  const runOpts: { since?: string; until?: string; dryRun?: boolean } = {};
  if (typeof args.flags.since === "string") runOpts.since = args.flags.since;
  if (typeof args.flags.until === "string") runOpts.until = args.flags.until;
  if (args.flags["dry-run"] === true) runOpts.dryRun = true;
  try {
    const result = await runWatcher(watcherId, runOpts);
    closeLedger();
    out(result, pretty);
    if (result.decision === "failed") process.exit(2);
  } catch (e) {
    closeLedger();
    err({
      error: "watcher run failed",
      message: e instanceof Error ? e.message : String(e),
    });
  }
}

// ---- project registry ----

async function cmdProjectList(pretty: boolean): Promise<void> {
  const daemonBody = await tryDaemonRead({ flags: {}, positional: [], family: "project" }, "/v1/projects");
  if (daemonBody !== null) {
    out({ servedBy: "frontierd", ...recordFromUnknown(daemonBody) }, pretty);
    return;
  }
  const { listProjects } = await import("./projects/registry.ts");
  out({ servedBy: "local", projects: listProjects() }, pretty);
}

async function cmdProjectInspect(
  args: ParsedArgs,
  pretty: boolean,
): Promise<void> {
  const projectId = args.positional[0];
  if (!projectId) return err({ error: "project inspect requires a project id" });
  try {
    const { findProjectManifest } = await import("./projects/registry.ts");
    out({ project: findProjectManifest(projectId) }, pretty);
  } catch (e) {
    return err({
      error: "project inspect failed",
      message: e instanceof Error ? e.message : String(e),
    });
  }
}

async function cmdProjectStatus(
  args: ParsedArgs,
  pretty: boolean,
): Promise<void> {
  const projectId = args.positional[0];
  try {
    const daemonBody = await tryDaemonRead(
      args,
      projectId
        ? `/v1/projects/${encodeURIComponent(projectId)}/status`
        : "/v1/projects/status",
    );
    if (daemonBody !== null) {
      out({ servedBy: "frontierd", ...recordFromUnknown(daemonBody) }, pretty);
      return;
    }
    const { projectStatus } = await import("./projects/registry.ts");
    const status = await projectStatus(projectId);
    if (Array.isArray(status)) {
      out(
        {
          servedBy: "local",
          generatedAt: new Date().toISOString(),
          projectCount: status.length,
          projects: status,
        },
        pretty,
      );
    } else {
      out(
        { servedBy: "local", generatedAt: new Date().toISOString(), project: status },
        pretty,
      );
    }
  } catch (e) {
    return err({
      error: "project status failed",
      message: e instanceof Error ? e.message : String(e),
    });
  }
}

async function cmdProjectNext(
  args: ParsedArgs,
  pretty: boolean,
): Promise<void> {
  const projectId = args.positional[0];
  if (!projectId) return err({ error: "project next requires a project id" });
  try {
    const daemonBody = await tryDaemonRead(
      args,
      `/v1/projects/${encodeURIComponent(projectId)}/next`,
    );
    if (daemonBody !== null) {
      out({ servedBy: "frontierd", ...recordFromUnknown(daemonBody) }, pretty);
      return;
    }
    const { projectNext } = await import("./projects/planner.ts");
    const result = await projectNext(projectId);
    closeLedger();
    out({ servedBy: "local", ...result }, pretty);
  } catch (e) {
    closeLedger();
    return err({
      error: "project next failed",
      message: e instanceof Error ? e.message : String(e),
    });
  }
}

async function cmdProjectRepair(
  args: ParsedArgs,
  pretty: boolean,
): Promise<void> {
  const projectId = args.positional[0];
  if (!projectId) return err({ error: "project repair requires a project id" });
  try {
    const daemonBody = await tryDaemonRead(
      args,
      `/v1/projects/${encodeURIComponent(projectId)}/repair`,
    );
    if (daemonBody !== null) {
      out({ servedBy: "frontierd", ...recordFromUnknown(daemonBody) }, pretty);
      return;
    }
    const { projectRepairPlan } = await import("./projects/planner.ts");
    const result = await projectRepairPlan(projectId);
    closeLedger();
    out({ servedBy: "local", ...result }, pretty);
  } catch (e) {
    closeLedger();
    return err({
      error: "project repair failed",
      message: e instanceof Error ? e.message : String(e),
    });
  }
}

async function cmdProjectRunDeclared(
  args: ParsedArgs,
  pretty: boolean,
  command: "verify" | "smoke" | "dev",
): Promise<void> {
  const projectId = args.positional[0];
  if (!projectId) return err({ error: `project ${command} requires a project id` });
  try {
    const { runProjectCommand } = await import("./projects/runner.ts");
    const result = runProjectCommand(projectId, command, {
      dryRun: args.flags["dry-run"] === true,
      consumeApproval: args.flags["consume-token"] === true,
    });
    out(result, pretty);
    if (result.status !== "passed" && result.status !== "planned") process.exit(2);
  } catch (e) {
    return err({
      error: `project ${command} failed`,
      message: e instanceof Error ? e.message : String(e),
    });
  }
}

// ---- ops readiness ----

async function cmdOpsStatus(pretty: boolean): Promise<void> {
  try {
    const daemonBody = await tryDaemonRead(
      { flags: {}, positional: [], family: "ops" },
      "/v1/ops/status",
    );
    if (daemonBody !== null) {
      out({ servedBy: "frontierd", ...recordFromUnknown(daemonBody) }, pretty);
      return;
    }
    const { opsStatus } = await import("./ops/status.ts");
    out({ servedBy: "local", ...(await opsStatus()) }, pretty);
  } catch (e) {
    return err({
      error: "ops status failed",
      message: e instanceof Error ? e.message : String(e),
    });
  }
}

async function cmdOpsRepairLaunchAgent(
  args: ParsedArgs,
  pretty: boolean,
): Promise<void> {
  const label = args.positional[0];
  if (!label) {
    return err({ error: "ops repair-launchagent requires a launchd label" });
  }
  const opts: {
    label: string;
    execute?: boolean;
    traceId?: string;
    consumeApproval?: boolean;
  } = { label };
  if (args.flags.execute === true) opts.execute = true;
  if (typeof args.flags["trace-id"] === "string") {
    opts.traceId = args.flags["trace-id"];
  }
  if (args.flags["consume-token"] === true) opts.consumeApproval = true;
  try {
    const { repairLaunchAgent } = await import("./ops/repair.ts");
    const result = await repairLaunchAgent(opts);
    closeLedger();
    out(result, pretty);
    if (
      result.status !== "planned" &&
      result.status !== "repaired" &&
      result.status !== "requires_approval"
    ) {
      process.exit(2);
    }
  } catch (e) {
    closeLedger();
    return err({
      error: "ops repair-launchagent failed",
      message: e instanceof Error ? e.message : String(e),
    });
  }
}

// ---- frontierd user daemon ----

function daemonSocketArg(args: ParsedArgs): string | undefined {
  return typeof args.flags.socket === "string" ? args.flags.socket : undefined;
}

async function tryDaemonRead(
  args: ParsedArgs,
  path: string,
): Promise<unknown | null> {
  if (args.flags.local === true) return null;
  const { requestDaemon, defaultDaemonSocketPath } = await import(
    "./daemon/server.ts"
  );
  const socketPath = daemonSocketArg(args) ?? defaultDaemonSocketPath();
  const result = await requestDaemon(path, { socketPath, timeoutMs: 1500 });
  return result.reachable && result.statusCode === 200 ? result.body : null;
}

async function cmdDaemonRun(
  args: ParsedArgs,
  pretty: boolean,
): Promise<void> {
  const { startDaemon } = await import("./daemon/server.ts");
  try {
    const socketPath = daemonSocketArg(args);
    const opts: Parameters<typeof startDaemon>[0] = {};
    if (socketPath !== undefined) opts.socketPath = socketPath;
    const runtime = await startDaemon(opts);
    out(
      {
        status: "daemon_running",
        service: "frontierd",
        pid: runtime.pid,
        socketPath: runtime.socketPath,
        startedAt: runtime.startedAt,
        mode: "foreground",
      },
      pretty,
    );
    await runtime.stopped;
  } catch (e) {
    return err({
      error: "daemon run failed",
      message: e instanceof Error ? e.message : String(e),
    });
  }
}

async function cmdDaemonStatus(
  args: ParsedArgs,
  pretty: boolean,
): Promise<void> {
  const { requestDaemon, defaultDaemonSocketPath } = await import(
    "./daemon/server.ts"
  );
  const socketPath = daemonSocketArg(args) ?? defaultDaemonSocketPath();
  const result = await requestDaemon("/health", { socketPath });
  if (!result.reachable) {
    out(
      {
        status: "unavailable",
        service: "frontierd",
        socketPath,
        error: result.error,
      },
      pretty,
    );
    return;
  }
  out(
    {
      status: result.statusCode === 200 ? "ok" : "degraded",
      service: "frontierd",
      socketPath,
      response: result.body,
    },
    pretty,
  );
}

async function cmdDaemonHealth(
  args: ParsedArgs,
  pretty: boolean,
): Promise<void> {
  const { requestDaemon, defaultDaemonSocketPath } = await import(
    "./daemon/server.ts"
  );
  const socketPath = daemonSocketArg(args) ?? defaultDaemonSocketPath();
  const result = await requestDaemon("/health", { socketPath });
  if (!result.reachable || result.statusCode !== 200) {
    out(
      {
        status: "unhealthy",
        service: "frontierd",
        socketPath,
        error: result.error,
        response: result.body,
      },
      pretty,
    );
    process.exit(2);
  }
  out(result.body, pretty);
}

async function cmdDaemonStop(
  args: ParsedArgs,
  pretty: boolean,
): Promise<void> {
  const { requestDaemon, defaultDaemonSocketPath } = await import(
    "./daemon/server.ts"
  );
  const socketPath = daemonSocketArg(args) ?? defaultDaemonSocketPath();
  const result = await requestDaemon("/shutdown", {
    socketPath,
    method: "POST",
  });
  if (!result.reachable) {
    return err({
      error: "daemon stop failed",
      message: result.error ?? `frontierd unavailable at ${socketPath}`,
    });
  }
  out(
    {
      status: result.statusCode === 200 ? "stopping" : "error",
      service: "frontierd",
      socketPath,
      response: result.body,
    },
    pretty,
  );
  if (result.statusCode !== 200) process.exit(2);
}

function daemonLaunchAgentOptions(args: ParsedArgs): {
  frontierBinPath?: string;
  socketPath?: string;
  repoRoot?: string;
  logDir?: string;
  launchAgentsDir?: string;
} {
  const opts: {
    frontierBinPath?: string;
    socketPath?: string;
    repoRoot?: string;
    logDir?: string;
    launchAgentsDir?: string;
  } = {};
  const socketPath = daemonSocketArg(args);
  if (socketPath !== undefined) opts.socketPath = socketPath;
  if (typeof args.flags["frontier-bin"] === "string") {
    opts.frontierBinPath = args.flags["frontier-bin"];
  }
  if (typeof args.flags["repo-root"] === "string") {
    opts.repoRoot = args.flags["repo-root"];
  }
  if (typeof args.flags["log-dir"] === "string") {
    opts.logDir = args.flags["log-dir"];
  }
  if (typeof args.flags["launch-agents-dir"] === "string") {
    opts.launchAgentsDir = args.flags["launch-agents-dir"];
  }
  return opts;
}

async function cmdDaemonPrintPlist(
  args: ParsedArgs,
  pretty: boolean,
): Promise<void> {
  const { frontierdLaunchAgentPaths, generateFrontierdLaunchAgentPlist } =
    await import("./daemon/launchd.ts");
  const opts = daemonLaunchAgentOptions(args);
  const paths = frontierdLaunchAgentPaths(opts);
  out(
    {
      service: "frontierd",
      ...paths,
      plist: generateFrontierdLaunchAgentPlist(opts),
    },
    pretty,
  );
}

async function cmdDaemonInstallUserAgent(
  args: ParsedArgs,
  pretty: boolean,
): Promise<void> {
  const { installFrontierdLaunchAgent } = await import("./daemon/launchd.ts");
  const opts: Parameters<typeof installFrontierdLaunchAgent>[0] = {
    ...daemonLaunchAgentOptions(args),
    dryRun: args.flags["dry-run"] === true,
  };
  out(
    {
      service: "frontierd",
      ...installFrontierdLaunchAgent(opts),
    },
    pretty,
  );
}

// ---- policy core ----

function recordFromUnknown(value: unknown): Record<string, unknown> {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return {};
}

function stringArrayFromUnknown(value: unknown): string[] | undefined {
  if (Array.isArray(value)) {
    return value.filter((item): item is string => typeof item === "string");
  }
  if (typeof value === "string") {
    return value
      .split(",")
      .map((item) => item.trim())
      .filter(Boolean);
  }
  return undefined;
}

async function policyActionFromArgs(args: ParsedArgs) {
  const { buildActionEnvelope, parseApprovalClass } = await import(
    "./policy/evaluator.ts"
  );
  let input: Record<string, unknown> = {};
  if (args.flags.input !== undefined) {
    input = parseInputFlag(args.flags.input);
  }
  const verb =
    typeof args.flags.verb === "string"
      ? args.flags.verb
      : typeof input.verb === "string"
        ? input.verb
        : "";
  const projectId =
    typeof args.flags.project === "string"
      ? args.flags.project
      : typeof input.projectId === "string"
        ? input.projectId
        : null;
  const actor =
    typeof args.flags.actor === "string"
      ? args.flags.actor
      : typeof input.actor === "string"
        ? input.actor
        : "codex";
  const source =
    typeof args.flags.source === "string"
      ? args.flags.source
      : typeof input.source === "string"
        ? input.source
        : "cli";
  const traceId =
    typeof args.flags["trace-id"] === "string"
      ? args.flags["trace-id"]
      : typeof input.traceId === "string"
        ? input.traceId
        : undefined;
  const classFlag = args.flags.class ?? args.flags["approval-class"];
  const approvalClass = parseApprovalClass(
    classFlag !== undefined ? classFlag : input.approvalClass,
  );
  const argsPayload =
    args.flags.arguments !== undefined
      ? parseInputFlag(args.flags.arguments)
      : recordFromUnknown(input.arguments);
  const sideEffects = stringArrayFromUnknown(
    args.flags["side-effects"] ?? input.sideEffects,
  );
  return buildActionEnvelope({
    actor,
    source,
    projectId,
    verb,
    arguments: argsPayload,
    approvalClass,
    ...(sideEffects !== undefined ? { sideEffects } : {}),
    ...(traceId !== undefined ? { traceId } : {}),
  });
}

async function cmdPolicySimulate(
  args: ParsedArgs,
  pretty: boolean,
): Promise<void> {
  const { evaluatePolicyAction, logPolicyEvaluation } = await import(
    "./policy/evaluator.ts"
  );
  try {
    const action = await policyActionFromArgs(args);
    const evaluation = evaluatePolicyAction(action);
    const event = logPolicyEvaluation("policy.simulated", evaluation);
    closeLedger();
    out({ ...evaluation, eventId: event.eventId }, pretty);
  } catch (e) {
    closeLedger();
    return err({
      error: "policy simulate failed",
      message: e instanceof Error ? e.message : String(e),
    });
  }
}

async function cmdPolicyEvaluate(
  args: ParsedArgs,
  pretty: boolean,
): Promise<void> {
  const { evaluatePolicyAction, logPolicyEvaluation } = await import(
    "./policy/evaluator.ts"
  );
  try {
    const action = await policyActionFromArgs(args);
    const evaluation = evaluatePolicyAction(action, {
      consumeApproval: args.flags["consume-token"] === true,
    });
    const event = logPolicyEvaluation("policy.evaluated", evaluation);
    closeLedger();
    out({ ...evaluation, eventId: event.eventId }, pretty);
    if (evaluation.decision.status !== "allow") process.exit(2);
  } catch (e) {
    closeLedger();
    return err({
      error: "policy evaluate failed",
      message: e instanceof Error ? e.message : String(e),
    });
  }
}

async function cmdPolicyApprove(
  args: ParsedArgs,
  pretty: boolean,
): Promise<void> {
  const { approveTrace, parseTtlMs } = await import("./policy/evaluator.ts");
  const traceId =
    typeof args.flags["trace-id"] === "string" ? args.flags["trace-id"] : "";
  if (!traceId) return err({ error: "policy approve requires --trace-id <id>" });
  try {
    const ttlMs = parseTtlMs(
      typeof args.flags.ttl === "string" ? args.flags.ttl : undefined,
    );
    const grant = approveTrace({
      traceId,
      ttlMs,
      actor: typeof args.flags.actor === "string" ? args.flags.actor : "codex",
    });
    closeLedger();
    out({ status: "approved", grant }, pretty);
  } catch (e) {
    closeLedger();
    return err({
      error: "policy approve failed",
      message: e instanceof Error ? e.message : String(e),
    });
  }
}

async function cmdPolicyConsume(
  args: ParsedArgs,
  pretty: boolean,
): Promise<void> {
  const { consumeApprovalToken } = await import("./policy/evaluator.ts");
  const traceId =
    typeof args.flags["trace-id"] === "string" ? args.flags["trace-id"] : "";
  if (!traceId) return err({ error: "policy consume requires --trace-id <id>" });
  const result = consumeApprovalToken(traceId);
  closeLedger();
  out(result, pretty);
  if (!result.consumed) process.exit(2);
}

// ---- approval queue ----

async function cmdApprovalList(
  args: ParsedArgs,
  pretty: boolean,
): Promise<void> {
  try {
    const limit =
      typeof args.flags.limit === "string" ? parseInt(args.flags.limit, 10) : 25;
    const daemonBody = await tryDaemonRead(
      args,
      `/v1/approvals?limit=${encodeURIComponent(String(limit))}${
        args.flags["include-resolved"] === true ? "&includeResolved=1" : ""
      }`,
    );
    if (daemonBody !== null) {
      out({ servedBy: "frontierd", ...recordFromUnknown(daemonBody) }, pretty);
      return;
    }
    const { approvalQueue } = await import("./approvals/queue.ts");
    const result = approvalQueue({
      limit,
      includeResolved: args.flags["include-resolved"] === true,
    });
    closeLedger();
    out({ servedBy: "local", ...result }, pretty);
  } catch (e) {
    closeLedger();
    return err({
      error: "approval list failed",
      message: e instanceof Error ? e.message : String(e),
    });
  }
}

async function cmdApprovalApprove(
  args: ParsedArgs,
  pretty: boolean,
): Promise<void> {
  const traceId = args.positional[0];
  if (!traceId) return err({ error: "approval approve requires a trace id" });
  const ttl = typeof args.flags.ttl === "string" ? args.flags.ttl : "15m";
  const actor = typeof args.flags.actor === "string" ? args.flags.actor : "operator";
  try {
    const daemonBody = await tryDaemonPost(
      args,
      `/v1/approvals/approve?traceId=${encodeURIComponent(traceId)}&ttl=${encodeURIComponent(ttl)}&actor=${encodeURIComponent(actor)}`,
      { traceId, ttl, actor },
    );
    if (daemonBody !== null) {
      out({ servedBy: "frontierd", ...recordFromUnknown(daemonBody) }, pretty);
      return;
    }
    const { approvePendingTrace } = await import("./approvals/queue.ts");
    const { CommandStore } = await import("./commands/store.ts");
    const {
      dispatchCommandIfRunnable,
      dispatchedWorkerForCommand,
    } = await import("./commands/dispatch.ts");
    const result = approvePendingTrace({ traceId, ttl, actor });
    const store = new CommandStore();
    let resumedCommand = null;
    try {
      const command = store.getByTraceId(traceId);
      resumedCommand =
        command?.status === "blocked_approval"
          ? store.resume({
              commandId: command.commandId,
              approvalTraceId: traceId,
              actor,
            })
          : null;
    } finally {
      store.close();
    }
    const dispatched =
      resumedCommand === null
        ? null
        : await dispatchCommandIfRunnable({
            commandId: resumedCommand.commandId,
            workerId: "local-cli",
          });
    closeLedger();
    out(
      {
        servedBy: "local",
        ...result,
        resumedCommand: dispatched?.command ?? resumedCommand,
        ...(resumedCommand &&
        dispatchedWorkerForCommand(resumedCommand.commandId, dispatched?.worker ?? null)
          ? { worker: dispatched?.worker ?? null }
          : {}),
        ...(dispatched?.dispatchError ? { dispatchError: dispatched.dispatchError } : {}),
      },
      pretty,
    );
  } catch (e) {
    closeLedger();
    return err({
      error: "approval approve failed",
      message: e instanceof Error ? e.message : String(e),
    });
  }
}

async function cmdApprovalDeny(
  args: ParsedArgs,
  pretty: boolean,
): Promise<void> {
  const traceId = args.positional[0];
  if (!traceId) return err({ error: "approval deny requires a trace id" });
  const actor = typeof args.flags.actor === "string" ? args.flags.actor : "operator";
  const reason =
    typeof args.flags.reason === "string"
      ? args.flags.reason
      : "operator dismissed approval request";
  try {
    const daemonBody = await tryDaemonPost(
      args,
      `/v1/approvals/deny?traceId=${encodeURIComponent(traceId)}&actor=${encodeURIComponent(actor)}&reason=${encodeURIComponent(reason)}`,
      { traceId, actor, reason },
    );
    if (daemonBody !== null) {
      out({ servedBy: "frontierd", ...recordFromUnknown(daemonBody) }, pretty);
      return;
    }
    const { denyPendingTrace } = await import("./approvals/queue.ts");
    closeLedger();
    out(
      {
        servedBy: "local",
        ...denyPendingTrace({ traceId, actor, reason }),
      },
      pretty,
    );
  } catch (e) {
    closeLedger();
    return err({
      error: "approval deny failed",
      message: e instanceof Error ? e.message : String(e),
    });
  }
}

// ---- MLX shared workbench ----

async function cmdMlx(args: ParsedArgs, pretty: boolean): Promise<void> {
  const subcommand = args.subcommand ?? "status";
  const supported = new Set([
    "status",
    "smoke",
    "generate",
    "benchmark",
    "audit",
    "inventory",
    "doctor",
    "task",
  ]);
  if (!supported.has(subcommand)) {
    return err({ error: `unknown mlx subcommand: ${subcommand}` });
  }
  const { spawnSync } = await import("node:child_process");
  const { homedir } = await import("node:os");
  const { resolve: resolvePath } = await import("node:path");
  const mlxw = resolvePath(homedir(), ".frontier", "mlx", "bin", "mlxw");
  const python = "/usr/local/bin/python3";
  const mlxArgs = mlxwArgsFor(args, subcommand);
  const result = spawnSync(python, [mlxw, ...mlxArgs], {
    cwd: resolvePath(homedir(), "frontier-os"),
    env: {
      ...process.env,
      FRONTIER_MLX_LAUNCHD_SAFE: "1",
      PYTHONPATH: "/Users/test/Library/Python/3.13/lib/python/site-packages",
      PYTHONNOUSERSITE: "1",
      PYTHONUNBUFFERED: "1",
    },
    encoding: "utf8",
    timeout: timeoutForMlx(subcommand),
  });
  if (result.error) {
    return err({
      error: "mlxw failed to spawn",
      message: result.error.message,
    });
  }
  const exitCode = result.status ?? 1;
  out(
    {
      servedBy: "mlxw",
      status: exitCode === 0 ? "ok" : "failed",
      subcommand,
      argv: [python, mlxw, ...mlxArgs],
      exitCode,
      stdoutTail: tailString(result.stdout ?? "", 8000),
      stderrTail: tailString(result.stderr ?? "", 4000),
      parsedStdout: parseMaybeJsonValue(result.stdout ?? ""),
    },
    pretty,
  );
  if (exitCode !== 0) process.exit(exitCode);
}

function mlxwArgsFor(args: ParsedArgs, subcommand: string): string[] {
  const outArgs = [subcommand];
  if (subcommand === "task") {
    const task = args.positional[0] ?? "inference";
    outArgs.push(task);
  }
  appendStringFlag(outArgs, args, "prompt");
  appendStringFlag(outArgs, args, "model");
  appendStringFlag(outArgs, args, "model-path");
  appendStringFlag(outArgs, args, "max-tokens");
  appendStringFlag(outArgs, args, "temp");
  appendStringFlag(outArgs, args, "prompt-tokens");
  appendStringFlag(outArgs, args, "generation-tokens");
  appendStringFlag(outArgs, args, "batch-size");
  appendStringFlag(outArgs, args, "num-trials");
  appendStringFlag(outArgs, args, "prefill-step-size");
  appendStringFlag(outArgs, args, "timeout-seconds");
  if (args.flags.edge === true) outArgs.push("--edge");
  if (args.flags.pipeline === true) outArgs.push("--pipeline");
  if (args.flags["quantize-activations"] === true) {
    outArgs.push("--quantize-activations");
  }
  if (args.flags["fail-if-not-ready"] === true) {
    outArgs.push("--fail-if-not-ready");
  }
  return outArgs;
}

function appendStringFlag(outArgs: string[], args: ParsedArgs, flag: string): void {
  if (typeof args.flags[flag] === "string") {
    outArgs.push(`--${flag}`, args.flags[flag]);
  }
}

function timeoutForMlx(subcommand: string): number {
  if (subcommand === "benchmark") return 5 * 60_000;
  if (subcommand === "generate" || subcommand === "smoke") return 2 * 60_000;
  return 60_000;
}

function parseMaybeJsonValue(value: string): unknown {
  const trimmed = value.trim();
  if (!trimmed) return null;
  try {
    return JSON.parse(trimmed);
  } catch {
    return null;
  }
}

function tailString(value: string, max: number): string {
  return value.length > max ? value.slice(-max) : value;
}

// ---- command gateway ----

async function commandInputFromArgs(args: ParsedArgs) {
  const { parseApprovalClass } = await import("./policy/evaluator.ts");
  const intent =
    typeof args.flags.intent === "string"
      ? args.flags.intent
      : args.positional.join(" ");
  if (!intent.trim()) return err({ error: "command requires --intent <text>" });
  const input: {
    intent: string;
    projectId?: string;
    actorId?: string;
    surface?: "cli" | "api" | "automation";
    origin?: string;
    traceId?: string;
    correlationId?: string;
    approvalClass?: 0 | 1 | 2 | 3;
    payload?: Record<string, unknown>;
    dryRun?: boolean;
    policy?: {
      allowSideEffects?: boolean;
      requireVerification?: boolean;
      maxRuntimeSeconds?: number;
      maxRetries?: number;
      retryBackoffMs?: number;
    };
  } = {
    intent,
    surface: "cli",
    origin: "frontier-cli",
  };
  if (typeof args.flags.project === "string") input.projectId = args.flags.project;
  if (typeof args.flags.actor === "string") input.actorId = args.flags.actor;
  if (typeof args.flags["trace-id"] === "string") {
    input.traceId = args.flags["trace-id"];
  }
  if (typeof args.flags["correlation-id"] === "string") {
    input.correlationId = args.flags["correlation-id"];
  }
  const classFlag = args.flags.class ?? args.flags["approval-class"];
  const approvalClass = parseApprovalClass(classFlag);
  if (approvalClass !== null) input.approvalClass = approvalClass;
  if (args.flags.input !== undefined) input.payload = parseInputFlag(args.flags.input);
  const policy: NonNullable<typeof input.policy> = {};
  if (typeof args.flags["max-runtime-seconds"] === "string") {
    const parsed = parseInt(args.flags["max-runtime-seconds"], 10);
    if (Number.isFinite(parsed) && parsed > 0) {
      policy.maxRuntimeSeconds = parsed;
    }
  }
  if (typeof args.flags["max-retries"] === "string") {
    const parsed = parseInt(args.flags["max-retries"], 10);
    if (Number.isFinite(parsed) && parsed >= 0) {
      policy.maxRetries = Math.min(parsed, 9);
    }
  }
  if (typeof args.flags["retry-backoff-ms"] === "string") {
    const parsed = parseInt(args.flags["retry-backoff-ms"], 10);
    if (Number.isFinite(parsed) && parsed >= 0) {
      policy.retryBackoffMs = parsed;
    }
  }
  if (args.flags["require-verification"] === true) {
    policy.requireVerification = true;
  }
  if (args.flags["allow-side-effects"] === true) {
    policy.allowSideEffects = true;
  }
  if (Object.keys(policy).length > 0) input.policy = policy;
  if (args.flags["dry-run"] === true) input.dryRun = true;
  return input;
}

async function tryDaemonPost(
  args: ParsedArgs,
  path: string,
  body: Record<string, unknown>,
): Promise<unknown | null> {
  if (args.flags.local === true) return null;
  const { requestDaemon, defaultDaemonSocketPath } = await import(
    "./daemon/server.ts"
  );
  const socketPath = daemonSocketArg(args) ?? defaultDaemonSocketPath();
  const result = await requestDaemon(path, {
    socketPath,
    method: "POST",
    timeoutMs: 1500,
    body,
  });
  return result.reachable && result.statusCode === 200 ? result.body : null;
}

async function cmdCommandSubmit(
  args: ParsedArgs,
  pretty: boolean,
): Promise<void> {
  try {
    const input = await commandInputFromArgs(args);
    if (input.dryRun === true) {
      const { explainCommand } = await import("./commands/store.ts");
      const { writeCommandGraphFromExplain } = await import(
        "./commands/compiler.ts"
      );
      const explained = explainCommand(input);
      const graph = writeCommandGraphFromExplain(explained);
      closeLedger();
      out({ servedBy: "local", dryRun: true, graph, ...explained }, pretty);
      return;
    }
    const daemonBody = await tryDaemonPost(args, "/v1/commands", input);
    if (daemonBody !== null) {
      out({ servedBy: "frontierd", ...recordFromUnknown(daemonBody) }, pretty);
      return;
    }
    const { CommandStore } = await import("./commands/store.ts");
    const {
      dispatchCommandIfRunnable,
      dispatchedWorkerForCommand,
    } = await import("./commands/dispatch.ts");
    const store = new CommandStore();
    let command = null;
    try {
      command = store.submit(input);
    } finally {
      store.close();
    }
    const dispatched = await dispatchCommandIfRunnable({
      commandId: command.commandId,
      workerId: "local-cli",
    });
    closeLedger();
    out(
      {
        servedBy: "local",
        command: dispatched.command ?? command,
        ...(dispatchedWorkerForCommand(command.commandId, dispatched.worker)
          ? { worker: dispatched.worker }
          : {}),
        ...(dispatched.dispatchError ? { dispatchError: dispatched.dispatchError } : {}),
      },
      pretty,
    );
  } catch (e) {
    closeLedger();
    return err({
      error: "command submit failed",
      message: e instanceof Error ? e.message : String(e),
    });
  }
}

async function cmdCommandExplain(
  args: ParsedArgs,
  pretty: boolean,
): Promise<void> {
  try {
    const input = await commandInputFromArgs(args);
    const { explainCommand } = await import("./commands/store.ts");
    const result = explainCommand(input);
    closeLedger();
    out(result, pretty);
  } catch (e) {
    closeLedger();
    return err({
      error: "command explain failed",
      message: e instanceof Error ? e.message : String(e),
    });
  }
}

async function cmdCommandList(
  args: ParsedArgs,
  pretty: boolean,
): Promise<void> {
  const limit =
    typeof args.flags.limit === "string" ? parseInt(args.flags.limit, 10) : 25;
  const status =
    typeof args.flags.status === "string" ? args.flags.status : undefined;
  try {
    const query = `/v1/commands?limit=${encodeURIComponent(String(limit))}${
      status ? `&status=${encodeURIComponent(status)}` : ""
    }`;
    const daemonBody = await tryDaemonRead(args, query);
    if (daemonBody !== null) {
      out({ servedBy: "frontierd", ...recordFromUnknown(daemonBody) }, pretty);
      return;
    }
    const { CommandStore } = await import("./commands/store.ts");
    const store = new CommandStore();
    try {
      const listOptions: Parameters<typeof store.list>[0] = { limit };
      const parsedStatus = commandStatusFromString(status);
      if (parsedStatus !== undefined) listOptions.status = parsedStatus;
      const commands = store.list(listOptions);
      out({ servedBy: "local", generatedAt: new Date().toISOString(), commands }, pretty);
    } finally {
      store.close();
    }
  } catch (e) {
    return err({
      error: "command list failed",
      message: e instanceof Error ? e.message : String(e),
    });
  }
}

async function cmdCommandShow(
  args: ParsedArgs,
  pretty: boolean,
): Promise<void> {
  const commandId = args.positional[0];
  if (!commandId) return err({ error: "command show requires a command id" });
  try {
    const daemonBody = await tryDaemonRead(
      args,
      `/v1/commands/${encodeURIComponent(commandId)}`,
    );
    if (daemonBody !== null) {
      out({ servedBy: "frontierd", ...recordFromUnknown(daemonBody) }, pretty);
      return;
    }
    const { CommandStore } = await import("./commands/store.ts");
    const store = new CommandStore();
    try {
      const command = store.get(commandId);
      if (!command) return err({ error: `unknown command: ${commandId}` });
      out({ servedBy: "local", command }, pretty);
    } finally {
      store.close();
    }
  } catch (e) {
    return err({
      error: "command show failed",
      message: e instanceof Error ? e.message : String(e),
    });
  }
}

async function cmdCommandEvents(
  args: ParsedArgs,
  pretty: boolean,
): Promise<void> {
  const commandId = args.positional[0];
  if (!commandId) return err({ error: "command events requires a command id" });
  const limit =
    typeof args.flags.limit === "string" ? parseInt(args.flags.limit, 10) : 100;
  const safeLimit = Number.isFinite(limit) && limit > 0 ? limit : 100;
  try {
    const daemonBody = await tryDaemonRead(
      args,
      `/v1/commands/${encodeURIComponent(commandId)}/events?limit=${encodeURIComponent(
        String(safeLimit),
      )}`,
    );
    if (daemonBody !== null) {
      out({ servedBy: "frontierd", ...recordFromUnknown(daemonBody) }, pretty);
      return;
    }
    const { CommandStore } = await import("./commands/store.ts");
    const store = new CommandStore();
    try {
      const command = store.get(commandId);
      if (!command) return err({ error: `unknown command: ${commandId}` });
      const ledger = getLedger();
      const sessionIds = [
        `command-${commandId}`,
        `command-worker-${commandId}`,
        ...(command.plan?.workGraphPath ? [`workgraph-wg_${commandId}`] : []),
      ];
      const sessions = sessionIds
        .map((sessionId) => ledger.getSessionSummary(sessionId))
        .filter((session) => session !== null);
      const events = sessionIds
        .flatMap((sessionId) =>
          ledger.getEvents(sessionId, {
            limit: Math.min(safeLimit, 1000),
          }),
        )
        .sort((a, b) => a.ts.localeCompare(b.ts))
        .slice(-Math.min(safeLimit, 1000));
      closeLedger();
      out({ servedBy: "local", command, sessions, events }, pretty);
    } finally {
      store.close();
    }
  } catch (e) {
    closeLedger();
    return err({
      error: "command events failed",
      message: e instanceof Error ? e.message : String(e),
    });
  }
}

async function cmdCommandArtifacts(
  args: ParsedArgs,
  pretty: boolean,
): Promise<void> {
  const commandId = args.positional[0];
  if (!commandId) return err({ error: "command artifacts requires a command id" });
  try {
    const daemonBody = await tryDaemonRead(
      args,
      `/v1/commands/${encodeURIComponent(commandId)}/artifacts`,
    );
    if (daemonBody !== null) {
      out({ servedBy: "frontierd", ...recordFromUnknown(daemonBody) }, pretty);
      return;
    }
    const { commandArtifacts } = await import("./commands/artifacts.ts");
    out({ servedBy: "local", ...commandArtifacts(commandId) }, pretty);
  } catch (e) {
    return err({
      error: "command artifacts failed",
      message: e instanceof Error ? e.message : String(e),
    });
  }
}

async function cmdCommandPacket(
  args: ParsedArgs,
  pretty: boolean,
): Promise<void> {
  const commandId = args.positional[0];
  if (!commandId) return err({ error: "command packet requires a command id" });
  try {
    const daemonBody = await tryDaemonRead(
      args,
      `/v1/commands/${encodeURIComponent(commandId)}/packet`,
    );
    if (daemonBody !== null) {
      out({ servedBy: "frontierd", ...recordFromUnknown(daemonBody) }, pretty);
      return;
    }
    const { commandResultPacket } = await import("./commands/packet.ts");
    out({ servedBy: "local", ...commandResultPacket(commandId) }, pretty);
  } catch (e) {
    return err({
      error: "command packet failed",
      message: e instanceof Error ? e.message : String(e),
    });
  }
}

async function cmdCommandFinalBrief(
  args: ParsedArgs,
  pretty: boolean,
): Promise<void> {
  const commandId = args.positional[0];
  if (!commandId) {
    return err({ error: "command final-brief requires a command id" });
  }
  const eventLimit =
    typeof args.flags["event-limit"] === "string"
      ? parseInt(args.flags["event-limit"], 10)
      : 50;
  const safeEventLimit =
    Number.isFinite(eventLimit) && eventLimit > 0 ? eventLimit : 50;
  try {
    const daemonBody = await tryDaemonRead(
      args,
      `/v1/commands/${encodeURIComponent(
        commandId,
      )}/brief?eventLimit=${encodeURIComponent(String(safeEventLimit))}`,
    );
    if (daemonBody !== null) {
      out({ servedBy: "frontierd", ...recordFromUnknown(daemonBody) }, pretty);
      return;
    }
    const { commandFinalBrief } = await import("./commands/final-brief.ts");
    out(
      {
        servedBy: "local",
        ...commandFinalBrief(commandId, { eventLimit: safeEventLimit }),
      },
      pretty,
    );
  } catch (e) {
    return err({
      error: "command final-brief failed",
      message: e instanceof Error ? e.message : String(e),
    });
  }
}

async function cmdCommandBackup(
  args: ParsedArgs,
  pretty: boolean,
): Promise<void> {
  try {
    const { backupCommandDb } = await import("./commands/backup.ts");
    const destDir =
      typeof args.flags["dest-dir"] === "string"
        ? args.flags["dest-dir"]
        : undefined;
    out(
      {
        servedBy: "local",
        ...backupCommandDb(destDir ? { destDir } : {}),
      },
      pretty,
    );
  } catch (e) {
    return err({
      error: "command backup failed",
      message: e instanceof Error ? e.message : String(e),
    });
  }
}

async function cmdCommandRemember(
  args: ParsedArgs,
  pretty: boolean,
): Promise<void> {
  const commandId = args.positional[0];
  if (!commandId) return err({ error: "command remember requires a command id" });
  try {
    const { rememberCommand } = await import("./commands/memory.ts");
    const options: Parameters<typeof rememberCommand>[1] = {};
    if (typeof args.flags.class === "string") {
      options.memoryClass = args.flags.class as NonNullable<
        typeof options.memoryClass
      >;
    }
    if (typeof args.flags.namespace === "string") {
      options.namespace = args.flags.namespace;
    }
    if (typeof args.flags.label === "string") {
      options.label = args.flags.label;
    }
    out({ servedBy: "local", ...rememberCommand(commandId, options) }, pretty);
  } catch (e) {
    return err({
      error: "command remember failed",
      message: e instanceof Error ? e.message : String(e),
    });
  }
}

async function cmdCommandBrief(
  args: ParsedArgs,
  pretty: boolean,
): Promise<void> {
  const hours = typeof args.flags.hours === "string" ? parseInt(args.flags.hours, 10) : 24;
  const limit = typeof args.flags.limit === "string" ? parseInt(args.flags.limit, 10) : 100;
  const safeHours = Number.isFinite(hours) && hours > 0 ? hours : 24;
  const safeLimit = Number.isFinite(limit) && limit > 0 ? limit : 100;
  try {
    const query = `/v1/command-brief?hours=${encodeURIComponent(
      String(safeHours),
    )}&limit=${encodeURIComponent(String(safeLimit))}`;
    const daemonBody = await tryDaemonRead(args, query);
    if (daemonBody !== null) {
      out({ servedBy: "frontierd", ...recordFromUnknown(daemonBody) }, pretty);
      return;
    }
    const { commandBrief } = await import("./commands/brief.ts");
    out({ servedBy: "local", ...commandBrief({ hours: safeHours, limit: safeLimit }) }, pretty);
  } catch (e) {
    return err({
      error: "command brief failed",
      message: e instanceof Error ? e.message : String(e),
    });
  }
}

async function cmdCommandReadiness(
  args: ParsedArgs,
  pretty: boolean,
): Promise<void> {
  const hours = typeof args.flags.hours === "string" ? parseInt(args.flags.hours, 10) : 24;
  const limit = typeof args.flags.limit === "string" ? parseInt(args.flags.limit, 10) : 100;
  const safeHours = Number.isFinite(hours) && hours > 0 ? hours : 24;
  const safeLimit = Number.isFinite(limit) && limit > 0 ? limit : 100;
  try {
    const query = `/v1/command-readiness?hours=${encodeURIComponent(
      String(safeHours),
    )}&limit=${encodeURIComponent(String(safeLimit))}`;
    const daemonBody = await tryDaemonRead(args, query);
    if (daemonBody !== null) {
      out({ servedBy: "frontierd", ...recordFromUnknown(daemonBody) }, pretty);
      return;
    }
    const { commandReadiness } = await import("./commands/readiness.ts");
    out(
      {
        servedBy: "local",
        ...commandReadiness({
          hours: safeHours,
          limit: safeLimit,
        }),
      },
      pretty,
    );
  } catch (e) {
    return err({
      error: "command readiness failed",
      message: e instanceof Error ? e.message : String(e),
    });
  }
}

async function cmdCommandDebt(
  args: ParsedArgs,
  pretty: boolean,
): Promise<void> {
  const limit = typeof args.flags.limit === "string" ? parseInt(args.flags.limit, 10) : 100;
  const safeLimit = Number.isFinite(limit) && limit > 0 ? limit : 100;
  try {
    const query = `/v1/command-debt?limit=${encodeURIComponent(String(safeLimit))}`;
    const daemonBody = await tryDaemonRead(args, query);
    if (daemonBody !== null) {
      out({ servedBy: "frontierd", ...recordFromUnknown(daemonBody) }, pretty);
      return;
    }
    const { commandDebt } = await import("./commands/debt.ts");
    out({ servedBy: "local", ...commandDebt({ limit: safeLimit }) }, pretty);
  } catch (e) {
    return err({
      error: "command debt failed",
      message: e instanceof Error ? e.message : String(e),
    });
  }
}

async function cmdCommandCancel(
  args: ParsedArgs,
  pretty: boolean,
): Promise<void> {
  const commandId = args.positional[0];
  if (!commandId) return err({ error: "command cancel requires a command id" });
  try {
    const actor = typeof args.flags.actor === "string" ? args.flags.actor : "operator";
    const daemonBody = await tryDaemonPost(
      args,
      `/v1/commands/${encodeURIComponent(commandId)}/cancel`,
      { actor },
    );
    if (daemonBody !== null) {
      out({ servedBy: "frontierd", ...recordFromUnknown(daemonBody) }, pretty);
      return;
    }
    const { CommandStore } = await import("./commands/store.ts");
    const store = new CommandStore();
    try {
      const command = store.cancel(commandId, actor);
      closeLedger();
      out({ servedBy: "local", command }, pretty);
    } finally {
      store.close();
    }
  } catch (e) {
    closeLedger();
    return err({
      error: "command cancel failed",
      message: e instanceof Error ? e.message : String(e),
    });
  }
}

async function cmdCommandRetry(
  args: ParsedArgs,
  pretty: boolean,
): Promise<void> {
  const commandId = args.positional[0];
  if (!commandId) return err({ error: "command retry requires a command id" });
  try {
    const actor = typeof args.flags.actor === "string" ? args.flags.actor : "operator";
    const daemonBody = await tryDaemonPost(
      args,
      `/v1/commands/${encodeURIComponent(commandId)}/retry`,
      { actor },
    );
    if (daemonBody !== null) {
      out({ servedBy: "frontierd", ...recordFromUnknown(daemonBody) }, pretty);
      return;
    }
    const { CommandStore } = await import("./commands/store.ts");
    const store = new CommandStore();
    try {
      const result = store.retry(commandId, actor);
      closeLedger();
      out({ servedBy: "local", ...result }, pretty);
    } finally {
      store.close();
    }
  } catch (e) {
    closeLedger();
    return err({
      error: "command retry failed",
      message: e instanceof Error ? e.message : String(e),
    });
  }
}

async function cmdCommandRequeue(
  args: ParsedArgs,
  pretty: boolean,
): Promise<void> {
  const commandId = args.positional[0];
  if (!commandId) return err({ error: "command requeue requires a command id" });
  try {
    const actor = typeof args.flags.actor === "string" ? args.flags.actor : "operator";
    const daemonBody = await tryDaemonPost(
      args,
      `/v1/commands/${encodeURIComponent(commandId)}/requeue`,
      { actor },
    );
    if (daemonBody !== null) {
      out({ servedBy: "frontierd", ...recordFromUnknown(daemonBody) }, pretty);
      return;
    }
    const { CommandStore } = await import("./commands/store.ts");
    const store = new CommandStore();
    try {
      const result = store.requeue(commandId, actor);
      closeLedger();
      out({ servedBy: "local", ...result }, pretty);
    } finally {
      store.close();
    }
  } catch (e) {
    closeLedger();
    return err({
      error: "command requeue failed",
      message: e instanceof Error ? e.message : String(e),
    });
  }
}

async function cmdCommandResume(
  args: ParsedArgs,
  pretty: boolean,
): Promise<void> {
  const commandId = args.positional[0];
  if (!commandId) return err({ error: "command resume requires a command id" });
  try {
    const body: Record<string, unknown> = {};
    if (typeof args.flags.approval === "string") body.approval = args.flags.approval;
    if (typeof args.flags.actor === "string") body.actor = args.flags.actor;
    if (args.flags.input !== undefined) body.resumePayload = parseInputFlag(args.flags.input);
    const daemonBody = await tryDaemonPost(
      args,
      `/v1/commands/${encodeURIComponent(commandId)}/resume`,
      body,
    );
    if (daemonBody !== null) {
      out({ servedBy: "frontierd", ...recordFromUnknown(daemonBody) }, pretty);
      return;
    }
    const { CommandStore } = await import("./commands/store.ts");
    const {
      dispatchCommandIfRunnable,
      dispatchedWorkerForCommand,
    } = await import("./commands/dispatch.ts");
    const store = new CommandStore();
    let command = null;
    try {
      const opts: {
        commandId: string;
        approvalTraceId?: string;
        actor?: string;
        resumePayload?: Record<string, unknown>;
      } = { commandId };
      if (typeof body.approval === "string") opts.approvalTraceId = body.approval;
      if (typeof body.actor === "string") opts.actor = body.actor;
      if (recordFromUnknown(body.resumePayload) === body.resumePayload) {
        opts.resumePayload = body.resumePayload as Record<string, unknown>;
      }
      command = store.resume(opts);
    } finally {
      store.close();
    }
    const dispatched = await dispatchCommandIfRunnable({
      commandId: command.commandId,
      workerId: "local-cli",
    });
    closeLedger();
    out(
      {
        servedBy: "local",
        command: dispatched.command ?? command,
        ...(dispatchedWorkerForCommand(command.commandId, dispatched.worker)
          ? { worker: dispatched.worker }
          : {}),
        ...(dispatched.dispatchError ? { dispatchError: dispatched.dispatchError } : {}),
      },
      pretty,
    );
  } catch (e) {
    closeLedger();
    return err({
      error: "command resume failed",
      message: e instanceof Error ? e.message : String(e),
    });
  }
}

async function cmdCommandSmoke(pretty: boolean): Promise<void> {
  try {
    const { commandSmoke } = await import("./commands/smoke.ts");
    const result = await commandSmoke();
    closeLedger();
    out(result, pretty);
    if (result.status !== "ok") process.exit(2);
  } catch (e) {
    closeLedger();
    return err({
      error: "command smoke failed",
      message: e instanceof Error ? e.message : String(e),
    });
  }
}

async function cmdCommandWorker(
  args: ParsedArgs,
  pretty: boolean,
): Promise<void> {
  const action = args.positional[0] ?? "status";
  try {
    if (action === "status") {
      const { commandWorkerStatus } = await import("./commands/worker.ts");
      out(commandWorkerStatus(), pretty);
      return;
    }
    if (action === "run") {
      const { runCommandWorkerLoop, runCommandWorkerOnce } = await import(
        "./commands/worker.ts"
      );
      const opts: {
        workerId?: string;
        leaseMs?: number;
        commandId?: string;
        maxApprovalClass?: 0 | 1 | 2 | 3;
      } = {};
      if (typeof args.flags["worker-id"] === "string") {
        opts.workerId = args.flags["worker-id"];
      }
      if (typeof args.flags["lease-ms"] === "string") {
        opts.leaseMs = parseInt(args.flags["lease-ms"], 10);
      }
      if (typeof args.flags.command === "string") {
        opts.commandId = args.flags.command;
      }
      if (typeof args.flags["max-approval-class"] === "string") {
        const parsed = parseInt(args.flags["max-approval-class"], 10);
        if ([0, 1, 2, 3].includes(parsed)) {
          opts.maxApprovalClass = parsed as 0 | 1 | 2 | 3;
        } else {
          return err({ error: "--max-approval-class must be 0, 1, 2, or 3" });
        }
      }
      if (args.flags.loop === true) {
        const loopOpts: Parameters<typeof runCommandWorkerLoop>[0] = { ...opts };
        if (typeof args.flags["interval-ms"] === "string") {
          loopOpts.intervalMs = parseInt(args.flags["interval-ms"], 10);
        }
        if (typeof args.flags["max-runtime-ms"] === "string") {
          loopOpts.maxRuntimeMs = parseInt(args.flags["max-runtime-ms"], 10);
        }
        if (typeof args.flags["idle-exit-ms"] === "string") {
          loopOpts.idleExitMs = parseInt(args.flags["idle-exit-ms"], 10);
        }
        if (typeof args.flags["max-commands"] === "string") {
          loopOpts.maxCommands = parseInt(args.flags["max-commands"], 10);
        }
        if (args.flags["continue-on-failure"] === true) {
          loopOpts.continueOnFailure = true;
        }
        const result = await runCommandWorkerLoop(loopOpts);
        closeLedger();
        out(result, pretty);
        if (result.status === "failed") process.exit(2);
        return;
      }
      const result = await runCommandWorkerOnce(opts);
      closeLedger();
      out(result, pretty);
      if (result.status === "failed") process.exit(2);
      return;
    }
    if (action === "print-plist") {
      const {
        commandWorkerLaunchAgentPaths,
        generateCommandWorkerLaunchAgentPlist,
      } = await import("./commands/launchd.ts");
      const opts = commandWorkerLaunchAgentOptions(args);
      out(
        {
          service: "command-worker",
          ...commandWorkerLaunchAgentPaths(opts),
          plist: generateCommandWorkerLaunchAgentPlist(opts),
        },
        pretty,
      );
      return;
    }
    if (action === "install-user-agent") {
      const { installCommandWorkerLaunchAgent } = await import(
        "./commands/launchd.ts"
      );
      const opts: Parameters<typeof installCommandWorkerLaunchAgent>[0] = {
        ...commandWorkerLaunchAgentOptions(args),
        dryRun: args.flags["dry-run"] === true,
      };
      out(
        {
          service: "command-worker",
          ...installCommandWorkerLaunchAgent(opts),
        },
        pretty,
      );
      return;
    }
    return err({ error: `unknown command worker action: ${action}` });
  } catch (e) {
    closeLedger();
    return err({
      error: "command worker failed",
      message: e instanceof Error ? e.message : String(e),
    });
  }
}

function commandWorkerLaunchAgentOptions(args: ParsedArgs): {
  frontierBinPath?: string;
  repoRoot?: string;
  logDir?: string;
  launchAgentsDir?: string;
  workerId?: string;
  intervalMs?: number;
  maxRuntimeMs?: number;
  idleExitMs?: number;
  maxCommands?: number;
  maxApprovalClass?: 0 | 1 | 2 | 3;
} {
  const opts: {
    frontierBinPath?: string;
    repoRoot?: string;
    logDir?: string;
    launchAgentsDir?: string;
    workerId?: string;
    intervalMs?: number;
    maxRuntimeMs?: number;
    idleExitMs?: number;
    maxCommands?: number;
    maxApprovalClass?: 0 | 1 | 2 | 3;
  } = {};
  if (typeof args.flags["frontier-bin"] === "string") {
    opts.frontierBinPath = args.flags["frontier-bin"];
  }
  if (typeof args.flags["repo-root"] === "string") {
    opts.repoRoot = args.flags["repo-root"];
  }
  if (typeof args.flags["log-dir"] === "string") {
    opts.logDir = args.flags["log-dir"];
  }
  if (typeof args.flags["launch-agents-dir"] === "string") {
    opts.launchAgentsDir = args.flags["launch-agents-dir"];
  }
  if (typeof args.flags["worker-id"] === "string") {
    opts.workerId = args.flags["worker-id"];
  }
  if (typeof args.flags["interval-ms"] === "string") {
    opts.intervalMs = parseInt(args.flags["interval-ms"], 10);
  }
  if (typeof args.flags["max-runtime-ms"] === "string") {
    opts.maxRuntimeMs = parseInt(args.flags["max-runtime-ms"], 10);
  }
  if (typeof args.flags["idle-exit-ms"] === "string") {
    opts.idleExitMs = parseInt(args.flags["idle-exit-ms"], 10);
  }
  if (typeof args.flags["max-commands"] === "string") {
    opts.maxCommands = parseInt(args.flags["max-commands"], 10);
  }
  if (typeof args.flags["max-approval-class"] === "string") {
    const parsed = parseInt(args.flags["max-approval-class"], 10);
    if ([0, 1, 2, 3].includes(parsed)) {
      opts.maxApprovalClass = parsed as 0 | 1 | 2 | 3;
    } else {
      err({ error: "--max-approval-class must be 0, 1, 2, or 3" });
    }
  }
  return opts;
}

function commandStatusFromString(value: string | undefined) {
  if (
    value === "queued" ||
    value === "running" ||
    value === "blocked_approval" ||
    value === "blocked_policy" ||
    value === "completed" ||
    value === "failed" ||
    value === "canceled"
  ) {
    return value;
  }
  return undefined;
}

// ---- MCP bridge ----

async function cmdMcpList(pretty: boolean): Promise<void> {
  const { listMcpTools } = await import("./mcp/bridge.ts");
  out({ tools: listMcpTools() }, pretty);
}

async function cmdMcpConfig(args: ParsedArgs, pretty: boolean): Promise<void> {
  const { mcpConfig } = await import("./mcp/config.ts");
  const agent =
    args.flags.agent === "codex" || args.flags.agent === "claude"
      ? args.flags.agent
      : "all";
  out(mcpConfig(agent), pretty);
}

async function cmdMcpCall(args: ParsedArgs, pretty: boolean): Promise<void> {
  const toolName = args.positional[0];
  if (!toolName) return err({ error: "mcp call requires a tool name" });
  const input =
    args.flags.input !== undefined ? parseInputFlag(args.flags.input) : {};
  try {
    const { callMcpTool } = await import("./mcp/bridge.ts");
    const result = await callMcpTool(toolName, input);
    closeLedger();
    out(result, pretty);
  } catch (e) {
    closeLedger();
    return err({
      error: "mcp call failed",
      message: e instanceof Error ? e.message : String(e),
    });
  }
}

async function cmdMcpSmoke(args: ParsedArgs, pretty: boolean): Promise<void> {
  const { smokeMcpBridge } = await import("./mcp/bridge.ts");
  const result = await smokeMcpBridge({ readOnly: args.flags["read-only"] === true });
  out(result, pretty);
  if (result.status !== "ok") process.exit(2);
}

async function cmdMcpRun(): Promise<void> {
  const { callMcpTool, listMcpTools } = await import("./mcp/bridge.ts");
  process.stderr.write(
    JSON.stringify({
      service: "frontier-mcp",
      transport: "json-rpc-lines",
      status: "ready",
    }) + "\n",
  );
  for await (const chunk of process.stdin) {
    const lines = Buffer.from(chunk).toString("utf8").split("\n");
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      let message: {
        id?: string | number;
        method?: string;
        params?: Record<string, unknown>;
      };
      try {
        message = JSON.parse(trimmed);
      } catch (e) {
        process.stdout.write(
          JSON.stringify({
            jsonrpc: "2.0",
            error: { code: -32700, message: String(e) },
          }) + "\n",
        );
        continue;
      }
      try {
        if (message.method === "initialize") {
          process.stdout.write(
            JSON.stringify({
              jsonrpc: "2.0",
              id: message.id ?? null,
              result: {
                protocolVersion: "2024-11-05",
                serverInfo: { name: "frontier-os", version: "0.1.0" },
                capabilities: { tools: {} },
              },
            }) + "\n",
          );
        } else if (message.method === "tools/list") {
          process.stdout.write(
            JSON.stringify({
              jsonrpc: "2.0",
              id: message.id ?? null,
              result: {
                tools: listMcpTools().map((tool) => ({
                  name: tool.name,
                  description: tool.description,
                  inputSchema: tool.inputSchema,
                })),
              },
            }) + "\n",
          );
        } else if (message.method === "tools/call") {
          const params = message.params ?? {};
          const name = typeof params.name === "string" ? params.name : "";
          const input = recordFromUnknown(params.arguments);
          const result = await callMcpTool(name, input);
          process.stdout.write(
            JSON.stringify({
              jsonrpc: "2.0",
              id: message.id ?? null,
              result: {
                content: [
                  {
                    type: "text",
                    text: JSON.stringify(result),
                  },
                ],
              },
            }) + "\n",
          );
        } else {
          process.stdout.write(
            JSON.stringify({
              jsonrpc: "2.0",
              id: message.id ?? null,
              error: {
                code: -32601,
                message: `unknown method: ${message.method ?? "(none)"}`,
              },
            }) + "\n",
          );
        }
      } catch (e) {
        process.stdout.write(
          JSON.stringify({
            jsonrpc: "2.0",
            id: message.id ?? null,
            error: {
              code: -32000,
              message: e instanceof Error ? e.message : String(e),
            },
          }) + "\n",
        );
      }
    }
  }
}

// ---- privileged helper simulator ----

function helperInvokeOptionsFromArgs(args: ParsedArgs): {
  verb: string;
  label?: string;
  path?: string;
  tailBytes?: number;
  traceId?: string;
  consumeApproval?: boolean;
} {
  const opts: {
    verb: string;
    label?: string;
    path?: string;
    tailBytes?: number;
    traceId?: string;
    consumeApproval?: boolean;
  } = {
    verb: args.positional[0] ?? "",
  };
  if (typeof args.flags.label === "string") opts.label = args.flags.label;
  if (typeof args.flags.path === "string") opts.path = args.flags.path;
  if (typeof args.flags["tail-bytes"] === "string") {
    opts.tailBytes = parseInt(args.flags["tail-bytes"], 10);
  }
  if (typeof args.flags["trace-id"] === "string") {
    opts.traceId = args.flags["trace-id"];
  }
  if (args.flags["consume-token"] === true) opts.consumeApproval = true;
  return opts;
}

async function cmdHelperStatus(pretty: boolean): Promise<void> {
  const { helperStatus } = await import("./helper/simulator.ts");
  out(helperStatus(), pretty);
}

async function cmdHelperBuild(pretty: boolean): Promise<void> {
  const { buildNativeHelper, helperInstallPlan } = await import(
    "./helper/install.ts"
  );
  const build = buildNativeHelper();
  out({ build, installPlan: helperInstallPlan() }, pretty);
  if (build.status !== "built") process.exit(2);
}

async function cmdHelperInstall(pretty: boolean): Promise<void> {
  const { applyRootInstallViaOsascript, helperInstallPlan } = await import(
    "./helper/install.ts"
  );
  if (process.argv.includes("--apply")) {
    const result = applyRootInstallViaOsascript();
    out(result, pretty);
    if (result.status !== "installed") process.exit(2);
    return;
  }
  out(helperInstallPlan(), pretty);
}

async function cmdHelperProductionStatus(pretty: boolean): Promise<void> {
  const { requestProductionHelper } = await import("./helper/install.ts");
  const result = await requestProductionHelper();
  out(result, pretty);
  if (!result.reachable || result.statusCode !== 200) process.exit(2);
}

async function cmdHelperProductionInvoke(
  args: ParsedArgs,
  pretty: boolean,
): Promise<void> {
  const opts = helperInvokeOptionsFromArgs(args);
  if (!opts.verb) return err({ error: "helper production-invoke requires a verb" });
  const path = productionHelperPath(opts);
  const { requestProductionHelper } = await import("./helper/install.ts");
  const result = await requestProductionHelper(path);
  out({ verb: opts.verb, requestPath: path, ...result }, pretty);
  if (!result.reachable || result.statusCode !== 200) process.exit(2);
}

function productionHelperPath(opts: ReturnType<typeof helperInvokeOptionsFromArgs>): string {
  switch (opts.verb) {
    case "helper.status":
      return "/v1/helper/status";
    case "launchd.status":
      return `/v1/launchd/status?label=${encodeURIComponent(opts.label ?? "")}`;
    case "logs.read":
      return `/v1/logs/read?path=${encodeURIComponent(opts.path ?? "")}&tailBytes=${encodeURIComponent(String(opts.tailBytes ?? 4096))}`;
    case "network.status":
      return "/v1/network/status";
    default:
      throw new Error(`production helper verb is not supported: ${opts.verb}`);
  }
}

async function cmdHelperInvoke(
  args: ParsedArgs,
  pretty: boolean,
): Promise<void> {
  const opts = helperInvokeOptionsFromArgs(args);
  if (!opts.verb) return err({ error: "helper invoke requires a verb" });
  const { invokeHelper } = await import("./helper/simulator.ts");
  const result = await invokeHelper(opts);
  closeLedger();
  out(result, pretty);
  if (result.status !== "allowed") process.exit(2);
}

async function cmdHelperSelfTest(pretty: boolean): Promise<void> {
  const { helperSelfTest } = await import("./helper/simulator.ts");
  const result = await helperSelfTest();
  closeLedger();
  out(result, pretty);
  if (result.status !== "ok") process.exit(2);
}

// ---- route explain ----

async function cmdRouteExplain(
  args: ParsedArgs,
  pretty: boolean,
): Promise<void> {
  const { explainRoute, parseRouteApprovalClass } = await import(
    "./router/explain.ts"
  );
  const verb = typeof args.flags.verb === "string" ? args.flags.verb : "";
  if (!verb) return err({ error: "route explain requires --verb <verb>" });
  const projectId =
    typeof args.flags.project === "string" ? args.flags.project : null;
  const classFlag = args.flags.class ?? args.flags["approval-class"];
  const approvalClass = parseRouteApprovalClass(classFlag);
  const traceId =
    typeof args.flags["trace-id"] === "string" ? args.flags["trace-id"] : undefined;
  out(
    explainRoute({
      verb,
      projectId,
      approvalClass,
      ...(traceId !== undefined ? { traceId } : {}),
    }),
    pretty,
  );
}

async function cmdClientStatus(pretty: boolean): Promise<void> {
  const daemonBody = await tryDaemonRead(
    { family: "client", positional: [], flags: {} },
    "/v1/client/status",
  );
  if (daemonBody !== null) {
    out({ servedBy: "frontierd", ...recordFromUnknown(daemonBody) }, pretty);
    return;
  }
  const { clientStatus } = await import("./client/status.ts");
  out({ servedBy: "local", ...(await clientStatus()) }, pretty);
}

async function cmdOvernightSmoke(pretty: boolean): Promise<void> {
  const { overnightSmoke } = await import("./overnight/smoke.ts");
  const result = await overnightSmoke();
  out(result, pretty);
  if (result.status !== "ok") process.exit(2);
}

async function cmdOvernightPlan(args: ParsedArgs, pretty: boolean): Promise<void> {
  const hours =
    typeof args.flags.hours === "string" ? parseInt(args.flags.hours, 10) : 8;
  try {
    const daemonBody = await tryDaemonRead(
      args,
      `/v1/overnight/plan?hours=${encodeURIComponent(String(hours))}`,
    );
    if (daemonBody !== null) {
      out({ servedBy: "frontierd", ...recordFromUnknown(daemonBody) }, pretty);
      return;
    }
    const { overnightPlan } = await import("./overnight/plan.ts");
    const result = await overnightPlan({ hours });
    closeLedger();
    out({ servedBy: "local", ...result }, pretty);
  } catch (e) {
    closeLedger();
    return err({
      error: "overnight plan failed",
      message: e instanceof Error ? e.message : String(e),
    });
  }
}

async function cmdOvernightEnqueue(
  args: ParsedArgs,
  pretty: boolean,
): Promise<void> {
  const hours =
    typeof args.flags.hours === "string" ? parseInt(args.flags.hours, 10) : 8;
  const opts: {
    hours: number;
    dryRun?: boolean;
    queueDir?: string;
    graphDir?: string;
    maxGraphs?: number;
  } = { hours };
  if (args.flags["dry-run"] === true) opts.dryRun = true;
  if (typeof args.flags["queue-dir"] === "string") {
    opts.queueDir = args.flags["queue-dir"];
  }
  if (typeof args.flags["graph-dir"] === "string") {
    opts.graphDir = args.flags["graph-dir"];
  }
  if (typeof args.flags.limit === "string") {
    opts.maxGraphs = parseInt(args.flags.limit, 10);
  }
  try {
    const { enqueueOvernightPlan } = await import("./overnight/queue.ts");
    const result = await enqueueOvernightPlan(opts);
    closeLedger();
    out(result, pretty);
    if (result.skippedCount > 0 && result.queuedCount === 0 && !result.dryRun) {
      process.exit(2);
    }
  } catch (e) {
    closeLedger();
    return err({
      error: "overnight enqueue failed",
      message: e instanceof Error ? e.message : String(e),
    });
  }
}

async function cmdOvernightRun(
  args: ParsedArgs,
  pretty: boolean,
): Promise<void> {
  const hours =
    typeof args.flags.hours === "string" ? parseInt(args.flags.hours, 10) : 8;
  const opts: {
    hours: number;
    dryRun?: boolean;
    queueDir?: string;
    graphDir?: string;
    maxGraphs?: number;
    maxConcurrent?: number;
    maxRetries?: number;
  } = { hours };
  if (args.flags["dry-run"] === true) opts.dryRun = true;
  if (typeof args.flags["queue-dir"] === "string") {
    opts.queueDir = args.flags["queue-dir"];
  }
  if (typeof args.flags["graph-dir"] === "string") {
    opts.graphDir = args.flags["graph-dir"];
  }
  if (typeof args.flags.limit === "string") {
    opts.maxGraphs = parseInt(args.flags.limit, 10);
  }
  if (typeof args.flags["max-concurrent"] === "string") {
    opts.maxConcurrent = parseInt(args.flags["max-concurrent"], 10);
  }
  if (typeof args.flags["max-retries"] === "string") {
    opts.maxRetries = parseInt(args.flags["max-retries"], 10);
  }
  try {
    const { runOvernightPlan } = await import("./overnight/queue.ts");
    const result = await runOvernightPlan(opts);
    closeLedger();
    out(result, pretty);
    if (!result.dryRun && (result.status === "failed" || result.status === "blocked")) {
      process.exit(2);
    }
  } catch (e) {
    closeLedger();
    return err({
      error: "overnight run failed",
      message: e instanceof Error ? e.message : String(e),
    });
  }
}

async function cmdOvernightBrief(
  args: ParsedArgs,
  pretty: boolean,
): Promise<void> {
  const opts: { sinceIso?: string; hours?: number } = {};
  if (typeof args.flags.since === "string") opts.sinceIso = args.flags.since;
  if (typeof args.flags.hours === "string") {
    opts.hours = parseInt(args.flags.hours, 10);
  }
  try {
    const { overnightBrief } = await import("./overnight/brief.ts");
    const result = overnightBrief(opts);
    closeLedger();
    out(result, pretty);
  } catch (e) {
    closeLedger();
    return err({
      error: "overnight brief failed",
      message: e instanceof Error ? e.message : String(e),
    });
  }
}

// ---- ledger archive (subagent 5) ----

async function cmdLedgerArchive(
  args: ParsedArgs,
  pretty: boolean,
): Promise<void> {
  const beforeTs =
    typeof args.flags.before === "string" ? args.flags.before : undefined;
  if (!beforeTs) {
    return err({ error: "ledger archive requires --before <iso>" });
  }
  const dryRun = args.flags["dry-run"] === true;
  const archiveDir =
    typeof args.flags["archive-dir"] === "string"
      ? args.flags["archive-dir"]
      : defaultArchiveDir();
  const ledger = getLedger();
  try {
    const result = ledger.archive({ beforeTs, archiveDir, dryRun });
    closeLedger();
    out(result, pretty);
  } catch (e) {
    closeLedger();
    err({
      error: "ledger archive failed",
      message: e instanceof Error ? e.message : String(e),
    });
  }
}

// ---- scheduler (subagent 2) ----

async function cmdSchedulerList(pretty: boolean): Promise<void> {
  const { buildSchedule } = await import("./scheduler/index.ts");
  const plan = await buildSchedule();
  out({ schedule: plan }, pretty);
}

async function cmdSchedulerRun(
  args: ParsedArgs,
  pretty: boolean,
): Promise<void> {
  const { runScheduler } = await import("./scheduler/index.ts");
  const stopAfter =
    typeof args.flags["stop-after-ms"] === "string"
      ? parseInt(args.flags["stop-after-ms"], 10)
      : undefined;
  const opts: { foreground: boolean; stopAfterMs?: number } = {
    foreground: true,
  };
  if (stopAfter !== undefined) opts.stopAfterMs = stopAfter;
  out({ status: "scheduler_starting", stopAfterMs: stopAfter ?? null }, pretty);
  await runScheduler(opts);
  out({ status: "scheduler_exited" }, pretty);
}

async function cmdSchedulerInstall(
  args: ParsedArgs,
  pretty: boolean,
): Promise<void> {
  const watcherId = args.positional[0];
  if (!watcherId) {
    return err({ error: "scheduler install requires a watcherId" });
  }
  const { writePlist } = await import("./scheduler/launchd.ts");
  const { loadWatcherManifests: load } = await import("./watchers/runtime.ts");
  const { homedir } = await import("node:os");
  const { resolve: resolvePath } = await import("node:path");
  const specs = load();
  const spec = specs.find((s) => s.watcherId === watcherId);
  if (!spec) return err({ error: `unknown watcher: ${watcherId}` });
  if (spec.schedule.mode !== "cron" && spec.schedule.mode !== "interval") {
    return err({
      error: `watcher ${watcherId} schedule mode "${spec.schedule.mode}" is not installable via launchd`,
    });
  }
  const binPath = resolvePath(
    process.env.HOME ?? "",
    "frontier-os",
    "bin",
    "frontier",
  );
  const logDir = resolvePath(homedir(), "Library", "Logs", "frontier-os");
  const destDir =
    typeof args.flags["dest-dir"] === "string"
      ? args.flags["dest-dir"]
      : resolvePath(homedir(), "Library", "LaunchAgents");
  const plistOpts: Parameters<typeof writePlist>[0] = {
    watcherId,
    mode: spec.schedule.mode,
    frontierBinPath: binPath,
    logDir,
  };
  if (spec.schedule.intervalSeconds !== undefined) {
    plistOpts.intervalSeconds = spec.schedule.intervalSeconds;
  }
  if (spec.schedule.cron !== undefined) {
    plistOpts.cron = spec.schedule.cron;
  }
  const path = await writePlist(plistOpts, destDir);
  out(
    {
      status: "plist_written",
      path,
      loadCommand: `launchctl load -w ${path}`,
      unloadCommand: `launchctl unload ${path}`,
    },
    pretty,
  );
}

// ---- salesforce batch runner + portfolio summary (subagent 3) ----

async function cmdSalesforceAuditBatch(
  args: ParsedArgs,
  _pretty: boolean,
): Promise<void> {
  const dashboardsFile =
    typeof args.flags["dashboards-file"] === "string"
      ? args.flags["dashboards-file"]
      : args.positional[0];
  if (!dashboardsFile) {
    return err({
      error:
        "salesforce audit-batch requires --dashboards-file <path> or a positional path",
    });
  }
  const { spawnSync } = await import("node:child_process");
  const { fileURLToPath } = await import("node:url");
  const { dirname, resolve: resolvePath } = await import("node:path");
  const repoRoot = resolvePath(dirname(fileURLToPath(import.meta.url)), "..");
  const script = resolvePath(repoRoot, "scripts", "audit-portfolio.sh");
  const extraArgs: string[] = [dashboardsFile];
  if (typeof args.flags.session === "string") {
    extraArgs.push("--session", args.flags.session);
  }
  if (typeof args.flags["base-url"] === "string") {
    extraArgs.push("--base-url", args.flags["base-url"]);
  }
  if (typeof args.flags["target-org"] === "string") {
    extraArgs.push("--target-org", args.flags["target-org"]);
  }
  if (typeof args.flags["report-stale-days"] === "string") {
    extraArgs.push("--report-stale-days", args.flags["report-stale-days"]);
  }
  if (args.flags["dry-run"] === true) {
    extraArgs.push("--dry-run");
  }
  const result = spawnSync(script, extraArgs, {
    stdio: "inherit",
    env: process.env,
  });
  if (result.error) {
    return err({
      error: "audit-batch script failed to spawn",
      message: result.error.message,
    });
  }
  if (result.status !== 0 && result.status !== null) {
    process.exit(result.status);
  }
}

// ---- eval family (Phase 15: regression harness) ----

async function cmdEvalRun(args: ParsedArgs, pretty: boolean): Promise<void> {
  const { runEvalDataset } = await import("./eval/runner.ts");
  const opts: Parameters<typeof runEvalDataset>[0] = {};
  if (typeof args.flags.since === "string") opts.sinceIso = args.flags.since;
  if (typeof args.flags.limit === "string")
    opts.maxItems = parseInt(args.flags.limit, 10);
  if (typeof args.flags["rule-id"] === "string")
    opts.ruleId = args.flags["rule-id"];
  const summary = runEvalDataset(opts);
  out(summary, pretty);
  if (args.flags["fail-on-regression"] === true && summary.regressed > 0) {
    process.exit(2);
  }
}

async function cmdEvalStats(pretty: boolean): Promise<void> {
  const { evalStats } = await import("./eval/runner.ts");
  out(evalStats(), pretty);
}

// ---- swarm family (Phase 11: Magentic-One worktree swarm) ----

async function cmdSwarmRun(args: ParsedArgs, pretty: boolean): Promise<void> {
  const task = typeof args.flags.task === "string" ? args.flags.task : "";
  if (!task) return err({ error: "swarm run requires --task <description>" });
  const { runSwarm } = await import("./swarm/runner.ts");
  const opts: Parameters<typeof runSwarm>[0] = { task };
  if (typeof args.flags.readers === "string")
    opts.maxReaders = parseInt(args.flags.readers, 10);
  if (typeof args.flags["run-id"] === "string")
    opts.runId = args.flags["run-id"];
  if (typeof args.flags["orchestrator-model"] === "string")
    opts.orchestratorModel = args.flags["orchestrator-model"];
  if (typeof args.flags["worker-model"] === "string")
    opts.workerModel = args.flags["worker-model"];
  const result = await runSwarm(opts);
  out(
    {
      runId: result.runId,
      task: result.task,
      totalDurationMs: result.totalDurationMs,
      satisfied: result.satisfied,
      taskLedger: result.taskLedger
        ? {
            facts_verified: result.taskLedger.facts_verified.length,
            facts_to_look_up: result.taskLedger.facts_to_look_up.length,
            plan: result.taskLedger.plan.map((s) => ({
              stepId: s.stepId,
              assignedTo: s.assignedTo,
              title: s.title,
            })),
          }
        : null,
      progressLedger: result.progressLedger,
      invocations: result.invocations.map((i) => ({
        role: i.role,
        stepId: i.stepId ?? null,
        ok: i.ok,
        ms: i.durationMs,
        words: i.words,
      })),
      paths: result.paths,
    },
    pretty,
  );
  if (result.satisfied === false) process.exit(2);
}

async function cmdSwarmList(args: ParsedArgs, pretty: boolean): Promise<void> {
  const { listRuns } = await import("./swarm/artifacts.ts");
  const limit =
    typeof args.flags.limit === "string" ? parseInt(args.flags.limit, 10) : 20;
  out({ runs: listRuns(limit) }, pretty);
}

// ---- telemetry family (Phase 10: OTLP export) ----

async function cmdTelemetryExport(
  args: ParsedArgs,
  pretty: boolean,
): Promise<void> {
  const { exportLedger } = await import("./telemetry/otel-exporter.ts");
  const opts: Parameters<typeof exportLedger>[0] = {};
  if (typeof args.flags.endpoint === "string")
    opts.endpoint = args.flags.endpoint;
  if (typeof args.flags.since === "string") opts.sinceIso = args.flags.since;
  if (typeof args.flags.limit === "string")
    opts.limit = parseInt(args.flags.limit, 10);
  if (args.flags["dry-run"] === true) opts.dryRun = true;
  if (typeof args.flags["kind-prefix"] === "string")
    opts.kindPrefix = args.flags["kind-prefix"];
  const summary = await exportLedger(opts);
  if (opts.dryRun) {
    // dry-run already wrote the OTLP JSON to stdout; write the summary to stderr.
    process.stderr.write(JSON.stringify(summary, null, 2) + "\n");
  } else {
    out(summary, pretty);
  }
  if (summary.httpError) process.exit(2);
  if (summary.httpStatus && summary.httpStatus >= 400) process.exit(2);
}

// ---- memory family (Phase 9: typed memory classes) ----

async function cmdMemoryPut(args: ParsedArgs, pretty: boolean): Promise<void> {
  const cls = typeof args.flags.class === "string" ? args.flags.class : "";
  const label = args.positional[0];
  const valueArg =
    typeof args.flags.value === "string" ? args.flags.value : null;
  if (!cls)
    return err({
      error:
        "memory put requires --class <run|operational|procedural|evaluative>",
    });
  if (!label)
    return err({ error: "memory put requires a label (first positional)" });
  if (valueArg === null)
    return err({ error: "memory put requires --value <text|@path>" });

  const { readFileSync, existsSync } = await import("node:fs");
  let value = valueArg;
  if (valueArg.startsWith("@")) {
    const path = valueArg.slice(1);
    if (!existsSync(path))
      return err({ error: `value file not found: ${path}` });
    value = readFileSync(path, "utf8");
  }

  const namespace =
    typeof args.flags.namespace === "string" ? args.flags.namespace : "";
  const description =
    typeof args.flags.description === "string"
      ? args.flags.description
      : undefined;
  const charLimit =
    typeof args.flags["char-limit"] === "string"
      ? parseInt(args.flags["char-limit"], 10)
      : undefined;
  let metadata: Record<string, unknown> | undefined;
  if (typeof args.flags.metadata === "string") {
    try {
      metadata = JSON.parse(args.flags.metadata);
    } catch (e) {
      return err({ error: `--metadata is not valid JSON: ${String(e)}` });
    }
  }

  const { getMemoryStore, closeMemoryStore, MemoryWriteViolation } =
    await import("./memory/store.ts");
  const store = getMemoryStore();
  try {
    const block = store.put(
      cls as "run" | "operational" | "procedural" | "evaluative",
      namespace,
      label,
      {
        value,
        ...(description !== undefined ? { description } : {}),
        ...(charLimit !== undefined ? { charLimit } : {}),
        ...(metadata !== undefined ? { metadata } : {}),
      },
    );
    out(block, pretty);
  } catch (e) {
    if (e instanceof MemoryWriteViolation) {
      return err({ error: e.message, code: "write_violation" });
    }
    throw e;
  } finally {
    closeMemoryStore();
  }
}

async function cmdMemoryGet(args: ParsedArgs, pretty: boolean): Promise<void> {
  const cls = typeof args.flags.class === "string" ? args.flags.class : "";
  const label = args.positional[0];
  if (!cls || !label) {
    return err({ error: "memory get requires --class <class> and a label" });
  }
  const namespace =
    typeof args.flags.namespace === "string" ? args.flags.namespace : "";
  const { getMemoryStore, closeMemoryStore } =
    await import("./memory/store.ts");
  const store = getMemoryStore();
  const block = store.get(
    cls as "run" | "operational" | "procedural" | "evaluative",
    namespace,
    label,
  );
  closeMemoryStore();
  if (!block) return err({ error: `not found: ${cls}:${namespace}:${label}` });
  out(block, pretty);
}

async function cmdMemoryList(args: ParsedArgs, pretty: boolean): Promise<void> {
  const cls = typeof args.flags.class === "string" ? args.flags.class : "";
  if (!cls) return err({ error: "memory list requires --class <class>" });
  const limit =
    typeof args.flags.limit === "string" ? parseInt(args.flags.limit, 10) : 50;
  const nsFlag =
    typeof args.flags.namespace === "string" ? args.flags.namespace : undefined;
  const { getMemoryStore, closeMemoryStore } =
    await import("./memory/store.ts");
  const store = getMemoryStore();
  const rows = store.list(
    cls as "run" | "operational" | "procedural" | "evaluative",
    {
      limit,
      ...(nsFlag !== undefined ? { namespacePrefix: nsFlag } : {}),
    },
  );
  closeMemoryStore();
  out(
    {
      class: cls,
      count: rows.length,
      blocks: rows.map(({ value, ...rest }) => ({
        ...rest,
        valueBytes: value.length,
      })),
    },
    pretty,
  );
}

async function cmdMemorySearch(
  args: ParsedArgs,
  pretty: boolean,
): Promise<void> {
  const cls = typeof args.flags.class === "string" ? args.flags.class : "";
  if (!cls) return err({ error: "memory search requires --class <class>" });
  const query = typeof args.flags.query === "string" ? args.flags.query : "";
  const nsFlag =
    typeof args.flags.namespace === "string" ? args.flags.namespace : undefined;
  const limit =
    typeof args.flags.limit === "string" ? parseInt(args.flags.limit, 10) : 20;
  const { getMemoryStore, closeMemoryStore } =
    await import("./memory/store.ts");
  const store = getMemoryStore();
  const rows = store.search(
    cls as "run" | "operational" | "procedural" | "evaluative",
    {
      query,
      ...(nsFlag !== undefined ? { namespacePrefix: nsFlag } : {}),
      limit,
    },
  );
  closeMemoryStore();
  out({ class: cls, query, count: rows.length, blocks: rows }, pretty);
}

async function cmdMemoryDelete(
  args: ParsedArgs,
  pretty: boolean,
): Promise<void> {
  const cls = typeof args.flags.class === "string" ? args.flags.class : "";
  const label = args.positional[0];
  if (!cls || !label) {
    return err({ error: "memory delete requires --class <class> and a label" });
  }
  const namespace =
    typeof args.flags.namespace === "string" ? args.flags.namespace : "";
  const { getMemoryStore, closeMemoryStore, MemoryWriteViolation } =
    await import("./memory/store.ts");
  const store = getMemoryStore();
  try {
    const deleted = store.delete(
      cls as "run" | "operational" | "procedural" | "evaluative",
      namespace,
      label,
    );
    closeMemoryStore();
    if (!deleted)
      return err({ error: `not found: ${cls}:${namespace}:${label}` });
    out({ deleted: true, class: cls, namespace, label }, pretty);
  } catch (e) {
    closeMemoryStore();
    if (e instanceof MemoryWriteViolation) {
      return err({ error: e.message, code: "write_violation" });
    }
    throw e;
  }
}

async function cmdMemoryStats(pretty: boolean): Promise<void> {
  const { getMemoryStore, closeMemoryStore } =
    await import("./memory/store.ts");
  const store = getMemoryStore();
  const s = store.stats();
  closeMemoryStore();
  out(s, pretty);
}

// ---- refinery family (Phase 6.4) ----

async function cmdRefineryHarvest(
  args: ParsedArgs,
  pretty: boolean,
): Promise<void> {
  const since =
    typeof args.flags.since === "string"
      ? args.flags.since
      : new Date(Date.now() - 7 * 86400 * 1000).toISOString();
  const limit =
    typeof args.flags.limit === "string"
      ? parseInt(args.flags.limit, 10)
      : 1000;
  const { harvestFailures } = await import("./refinery/harvester.ts");
  const signals = await harvestFailures({ sinceIso: since, limit });
  out({ since, limit, count: signals.length, signals }, pretty);
}

async function cmdRefineryPropose(
  args: ParsedArgs,
  pretty: boolean,
): Promise<void> {
  const since =
    typeof args.flags.since === "string"
      ? args.flags.since
      : new Date(Date.now() - 7 * 86400 * 1000).toISOString();
  const limit =
    typeof args.flags.limit === "string"
      ? parseInt(args.flags.limit, 10)
      : 1000;
  const minFrequency =
    typeof args.flags["min-frequency"] === "string"
      ? parseInt(args.flags["min-frequency"], 10)
      : 2;
  const { harvestFailures } = await import("./refinery/harvester.ts");
  const { proposeRules } = await import("./refinery/rules.ts");
  const signals = await harvestFailures({ sinceIso: since, limit });
  const proposals = proposeRules(signals, { minFrequency });
  if (args.flags.persist === true) {
    const { appendProposal } = await import("./refinery/registry.ts");
    const appended: string[] = [];
    for (const p of proposals) {
      const r = appendProposal(p);
      if (r.appended) appended.push(r.ruleId);
    }
    out(
      {
        proposed: proposals.length,
        appendedCount: appended.length,
        appended,
        proposals,
      },
      pretty,
    );
  } else {
    out({ proposed: proposals.length, proposals }, pretty);
  }
  const { closeLedger } = await import("./ledger/index.ts");
  closeLedger();
}

async function cmdRefineryRules(
  args: ParsedArgs,
  pretty: boolean,
): Promise<void> {
  const { loadRules, loadProposals } = await import("./refinery/registry.ts");
  const rules = loadRules();
  const body: Record<string, unknown> = { activeCount: rules.length, rules };
  if (args.flags["show-proposals"] === true) {
    const proposals = loadProposals();
    body.proposalCount = proposals.length;
    body.proposals = proposals;
  }
  out(body, pretty);
}

async function cmdRefineryPromote(
  args: ParsedArgs,
  pretty: boolean,
): Promise<void> {
  const ruleId = args.positional[0];
  if (!ruleId) return err({ error: "refinery promote requires a ruleId" });
  const { promoteProposal } = await import("./refinery/registry.ts");
  const result = promoteProposal(ruleId);
  out(result, pretty);
  const { closeLedger } = await import("./ledger/index.ts");
  closeLedger();
  if (result.status === "not_proposed") process.exit(2);
}

async function cmdRefineryEvalExport(
  args: ParsedArgs,
  pretty: boolean,
): Promise<void> {
  const { exportEvalDataset } = await import("./refinery/eval-exporter.ts");
  const opts: Parameters<typeof exportEvalDataset>[0] = {};
  if (typeof args.flags.dataset === "string")
    opts.datasetName = args.flags.dataset;
  if (typeof args.flags.endpoint === "string")
    opts.baseUrl = args.flags.endpoint;
  if (typeof args.flags.since === "string") opts.sinceIso = args.flags.since;
  if (typeof args.flags.limit === "string")
    opts.maxItems = parseInt(args.flags.limit, 10);
  if (args.flags["dry-run"] === true) opts.dryRun = true;
  const summary = await exportEvalDataset(opts);
  out(summary, pretty);
  const { closeLedger } = await import("./ledger/index.ts");
  closeLedger();
  if (summary.itemsFailed > 0) process.exit(2);
}

async function cmdRefineryEvalStats(pretty: boolean): Promise<void> {
  const { evalExportStats } = await import("./refinery/eval-exporter.ts");
  out(evalExportStats(), pretty);
}

async function cmdRefineryAutoPromote(
  args: ParsedArgs,
  pretty: boolean,
): Promise<void> {
  const { autoPromote } = await import("./refinery/auto-promote.ts");
  const opts: Parameters<typeof autoPromote>[0] = {};
  if (typeof args.flags.threshold === "string") {
    opts.threshold = parseInt(args.flags.threshold, 10);
  }
  if (args.flags["dry-run"] === true) opts.dryRun = true;
  const result = autoPromote(opts);
  out(result, pretty);
  const { closeLedger } = await import("./ledger/index.ts");
  closeLedger();
}

async function cmdRefineryRevoke(
  args: ParsedArgs,
  pretty: boolean,
): Promise<void> {
  const ruleId = args.positional[0];
  if (!ruleId) return err({ error: "refinery revoke requires a ruleId" });
  const { revokeRule } = await import("./refinery/registry.ts");
  const reason = typeof args.flags.reason === "string" ? args.flags.reason : "";
  const revokedBy =
    typeof args.flags["revoked-by"] === "string"
      ? args.flags["revoked-by"]
      : "operator";
  const result = revokeRule(ruleId, { reason, revokedBy });
  out(result, pretty);
  const { closeLedger } = await import("./ledger/index.ts");
  closeLedger();
  if (result.status === "not_promoted") process.exit(2);
}

// ---- ghost shift family (Phase 6.2) ----

async function cmdGhostRun(args: ParsedArgs, pretty: boolean): Promise<void> {
  const { runShift } = await import("./ghost/shift.ts");
  const opts: {
    queueDir?: string;
    maxRuntimeSeconds?: number;
    maxConcurrent?: number;
    maxRetries?: number;
    dryRun?: boolean;
  } = {};
  if (typeof args.flags["queue-dir"] === "string") {
    opts.queueDir = args.flags["queue-dir"];
  }
  if (typeof args.flags["max-runtime"] === "string") {
    opts.maxRuntimeSeconds = parseInt(args.flags["max-runtime"], 10);
  }
  if (typeof args.flags["max-concurrent"] === "string") {
    opts.maxConcurrent = parseInt(args.flags["max-concurrent"], 10);
  }
  if (typeof args.flags["max-retries"] === "string") {
    opts.maxRetries = parseInt(args.flags["max-retries"], 10);
  }
  if (args.flags["dry-run"] === true) opts.dryRun = true;
  const summary = await runShift(opts);
  out(summary, pretty);
  if (summary.failed > 0) process.exit(2);
}

async function cmdGhostStatus(
  args: ParsedArgs,
  pretty: boolean,
): Promise<void> {
  const { queueStatus, defaultQueueDir } = await import("./ghost/shift.ts");
  const queueDir =
    typeof args.flags["queue-dir"] === "string"
      ? args.flags["queue-dir"]
      : defaultQueueDir();
  const counts = queueStatus(queueDir);
  out({ queueDir, counts }, pretty);
}

async function cmdGhostQueue(args: ParsedArgs, pretty: boolean): Promise<void> {
  const graphPath = args.positional[0];
  if (!graphPath) {
    return err({
      error:
        "ghost queue requires a graph path (frontier ghost queue <graph.json>)",
    });
  }
  const { enqueue } = await import("./ghost/shift.ts");
  const queueDir =
    typeof args.flags["queue-dir"] === "string"
      ? args.flags["queue-dir"]
      : undefined;
  const dest = enqueue(graphPath, queueDir);
  out({ queued: graphPath, destination: dest }, pretty);
}

// ---- work graph family (Phase 6) ----

async function cmdWorkValidate(
  args: ParsedArgs,
  pretty: boolean,
): Promise<void> {
  const path = args.positional[0];
  if (!path) return err({ error: "work validate requires a graph path" });
  const { loadGraph, prepare } = await import("./work/graph.ts");
  try {
    const graph = loadGraph(path);
    const prepared = prepare(graph);
    out(
      {
        ok: true,
        graphId: graph.graphId,
        goal: graph.goal,
        nodeCount: graph.nodes.length,
        topoOrder: prepared.order,
      },
      pretty,
    );
  } catch (e) {
    return err({
      error: "work graph validation failed",
      message: e instanceof Error ? e.message : String(e),
      details: (e as { details?: unknown }).details,
    });
  }
}

async function cmdWorkRun(args: ParsedArgs, pretty: boolean): Promise<void> {
  const path = args.positional[0];
  if (!path) return err({ error: "work run requires a graph path" });
  const { loadGraph } = await import("./work/graph.ts");
  const { runGraph } = await import("./work/executor.ts");
  const graph = loadGraph(path);
  const opts: {
    autoApprove?: boolean;
    sessionIdOverride?: string;
    dryRun?: boolean;
    maxConcurrent?: number;
    maxRetries?: number;
  } = {};
  if (args.flags["auto-approve"] === true) opts.autoApprove = true;
  if (args.flags["dry-run"] === true) opts.dryRun = true;
  if (typeof args.flags.session === "string") {
    opts.sessionIdOverride = args.flags.session;
  }
  if (typeof args.flags["max-concurrent"] === "string") {
    opts.maxConcurrent = parseInt(args.flags["max-concurrent"], 10);
  }
  if (typeof args.flags["max-retries"] === "string") {
    opts.maxRetries = parseInt(args.flags["max-retries"], 10);
  }
  const result = await runGraph(graph, opts);
  const { closeLedger } = await import("./ledger/index.ts");
  closeLedger();
  out(result, pretty);
  if (result.status === "failed") process.exit(2);
}

async function cmdSalesforcePortfolioSummary(
  args: ParsedArgs,
  pretty: boolean,
): Promise<void> {
  const sessionId = args.positional[0];
  if (!sessionId) {
    return err({ error: "salesforce portfolio-summary requires a sessionId" });
  }
  const { summarizePortfolioSession, runPortfolioSummaryCli } =
    await import("./salesforce/portfolio-summary.ts");
  if (args.flags.json === true) {
    const summary = summarizePortfolioSession(sessionId);
    out(summary, pretty);
  } else {
    runPortfolioSummaryCli(sessionId);
  }
  closeLedger();
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv);
  const pretty = Boolean(args.flags.pretty);

  if (args.family === "" || args.family === "help" || args.flags.help) {
    out(
      {
        name: "frontier",
        version: "0.1.0",
        families: {
          command: [
            "submit --intent <text> [--project <id>] [--dry-run] [--max-runtime-seconds N] [--max-retries N] [--retry-backoff-ms N]",
            "explain --intent <text> [--project <id>]",
            "list [--status queued|blocked_approval|completed|failed] [--limit N]",
            "show <commandId>",
            "events <commandId> [--limit N]",
            "artifacts <commandId>",
            "packet <commandId>",
            "final-brief <commandId> [--event-limit N]",
            "backup [--dest-dir path]",
            "remember <commandId> [--class run|operational|procedural|evaluative] [--namespace path] [--label name]",
          "brief [--hours N] [--limit N]",
          "readiness [--hours N] [--limit N]",
          "debt [--limit N]",
          "resume <commandId> [--approval <traceId>]",
          "retry <commandId> [--actor name]",
          "requeue <commandId> [--actor name]",
          "cancel <commandId> [--actor name]",
          "worker status",
            "worker run [--command <commandId>] [--worker-id ID] [--max-approval-class N]",
            "worker run --loop [--max-runtime-ms N] [--idle-exit-ms N] [--max-commands N]",
            "worker print-plist [--max-approval-class N]",
            "worker install-user-agent [--dry-run] [--max-approval-class N]",
            "smoke",
          ],
          adapter: ["list", "show <adapterId>", "invoke <adapterId> <command>"],
          ledger: [
            "list-sessions [--limit N]",
            "show <sessionId> [--offset N] [--limit N]",
            "search --kind <kind> [--limit N]",
            "stats",
            "archive --before <iso> [--dry-run] [--archive-dir <path>]",
            "log --agent <name> --kind <agent.*> [--session <id>] [--tool <name>] [--trace-id <id>] [--payload <json|path>]",
          ],
          watcher: [
            "list",
            "show <watcherId>",
            "run <watcherId> [--since ISO] [--until ISO] [--dry-run]",
          ],
          project: [
            "list [--json]",
            "inspect <projectId> [--json]",
            "status [projectId] [--json]",
            "next <projectId> [--json]",
            "repair <projectId> --dry-run [--json]",
            "verify <projectId> [--dry-run]",
            "smoke <projectId> [--dry-run]",
          ],
          ops: [
            "status [--json]",
            "repair-launchagent <label> [--execute] [--trace-id ID] [--consume-token]",
          ],
          daemon: [
            "run [--foreground] [--socket <path>]",
            "status [--socket <path>]",
            "health [--socket <path>]",
            "stop [--socket <path>]",
            "print-plist [--socket <path>]",
            "install-user-agent [--dry-run] [--socket <path>]",
          ],
          policy: [
            "simulate --verb <verb> [--project <id>] [--class 0|1|2|3]",
            "evaluate --verb <verb> [--project <id>] [--consume-token]",
            "approve --trace-id <id> [--ttl 15m]",
            "consume --trace-id <id>",
          ],
          approval: [
            "list [--limit N] [--include-resolved]",
            "approve <traceId> [--ttl 15m] [--actor name]",
            "deny <traceId> [--actor name] [--reason text]",
          ],
          mcp: [
            "list",
            "config [--agent codex|claude]",
            "call <toolName> [--input <json|path>]",
            "smoke [--read-only]",
            "run",
          ],
          helper: [
            "status",
            "build",
            "install --dry-run",
            "install --apply",
            "production-status",
            "production-invoke <verb> [--label <launchdLabel>] [--path <path>]",
            "invoke <verb> [--label <launchdLabel>] [--path <path>] [--consume-token]",
            "self-test",
          ],
          mlx: [
            "status [--fail-if-not-ready]",
            "smoke [--edge]",
            "generate [--prompt text] [--max-tokens N] [--edge]",
            "benchmark [--timeout-seconds N] [--edge]",
            "audit",
            "inventory",
            "doctor",
            "task inference|service|speech|swift|training",
          ],
          route: ["explain --verb <verb> [--project <id>] [--class 0|1|2|3]"],
          client: ["status"],
          overnight: [
            "plan [--hours N]",
            "enqueue [--hours N] [--dry-run] [--queue-dir P] [--graph-dir P] [--limit N]",
            "run [--hours N] [--dry-run] [--max-concurrent N] [--max-retries N] [--limit N]",
            "brief [--hours N] [--since ISO]",
            "smoke",
          ],
          scheduler: [
            "list",
            "run [--stop-after-ms N]",
            "install <watcherId> [--dest-dir <path>]",
          ],
          salesforce: [
            "audit-batch <dashboards-file> [--session <id>] [--base-url <url>] [--dry-run]",
            "portfolio-summary <sessionId> [--json]",
          ],
          work: [
            "validate <graph.json>",
            "run <graph.json> [--auto-approve] [--dry-run] [--session <id>] [--max-concurrent N] [--max-retries N]",
          ],
          ghost: [
            "status [--queue-dir <path>]",
            "queue <graph.json> [--queue-dir <path>]",
            "run [--queue-dir <path>] [--max-runtime N] [--max-concurrent N] [--max-retries N] [--dry-run]",
          ],
          refinery: [
            "harvest [--since ISO] [--limit N]",
            "propose [--since ISO] [--min-frequency N] [--persist]",
            "rules [--show-proposals]",
            "promote <ruleId>",
            "eval-export [--dataset NAME] [--endpoint URL] [--since ISO] [--limit N] [--dry-run]",
            "eval-stats",
            "auto-promote [--threshold N] [--dry-run]",
            "revoke <ruleId> [--reason R] [--revoked-by B]",
          ],
          memory: [
            "put <label> --class <run|operational|procedural|evaluative> --value <text|@path> [--namespace P] [--description D] [--char-limit N] [--metadata JSON]",
            "get <label> --class <class> [--namespace P]",
            "list --class <class> [--namespace P] [--limit N]",
            "search --class <class> --query <fts> [--namespace P] [--limit N]",
            "delete <label> --class <class> [--namespace P]",
            "stats",
          ],
          telemetry: [
            "export [--endpoint URL] [--since ISO] [--limit N] [--kind-prefix K] [--dry-run]",
          ],
          swarm: [
            "run --task <description> [--readers N] [--run-id ID] [--orchestrator-model M] [--worker-model M]",
            "list [--limit N]",
          ],
          eval: [
            "run [--since ISO] [--limit N] [--rule-id ID] [--fail-on-regression]",
            "stats",
          ],
        },
        notes: [
          "Output is JSON by default. --json is accepted for explicit callers; pass --pretty for indented JSON.",
          "Adapter invocations follow schemas/adapter-invocation.schema.json.",
          "Adapter results follow schemas/adapter-result.schema.json.",
          "Project verify/smoke runners execute manifest-declared argv after policy evaluation.",
          "frontierd is a user-level local daemon; LaunchAgent install is explicit and launchctl load/unload remains operator controlled.",
          "Session ledger lives at ~/.frontier/ledger.db (SQLite, append-only).",
        ],
      },
      pretty,
    );
    return;
  }

  if (args.family === "command") {
    switch (args.subcommand) {
      case "submit":
        return cmdCommandSubmit(args, pretty);
      case "explain":
        return cmdCommandExplain(args, pretty);
      case "list":
        return cmdCommandList(args, pretty);
      case "show":
        return cmdCommandShow(args, pretty);
      case "events":
        return cmdCommandEvents(args, pretty);
      case "artifacts":
        return cmdCommandArtifacts(args, pretty);
      case "packet":
        return cmdCommandPacket(args, pretty);
      case "final-brief":
        return cmdCommandFinalBrief(args, pretty);
      case "backup":
        return cmdCommandBackup(args, pretty);
      case "remember":
        return cmdCommandRemember(args, pretty);
      case "brief":
        return cmdCommandBrief(args, pretty);
      case "readiness":
        return cmdCommandReadiness(args, pretty);
      case "debt":
        return cmdCommandDebt(args, pretty);
      case "resume":
        return cmdCommandResume(args, pretty);
      case "retry":
        return cmdCommandRetry(args, pretty);
      case "requeue":
        return cmdCommandRequeue(args, pretty);
      case "cancel":
        return cmdCommandCancel(args, pretty);
      case "worker":
        return cmdCommandWorker(args, pretty);
      case "smoke":
        return cmdCommandSmoke(pretty);
      default:
        return err({
          error: `unknown command subcommand: ${args.subcommand ?? "(none)"}`,
        });
    }
  }

  if (args.family === "adapter") {
    switch (args.subcommand) {
      case "list":
        return cmdAdapterList(pretty);
      case "show":
        return cmdAdapterShow(args.positional[0], pretty);
      case "invoke":
        return cmdAdapterInvoke(args, pretty);
      default:
        return err({
          error: `unknown adapter subcommand: ${args.subcommand ?? "(none)"}`,
        });
    }
  }

  if (args.family === "ledger") {
    switch (args.subcommand) {
      case "list-sessions":
        return cmdLedgerListSessions(args, pretty);
      case "show":
        return cmdLedgerShow(args, pretty);
      case "search":
        return cmdLedgerSearch(args, pretty);
      case "stats":
        return cmdLedgerStats(pretty);
      case "archive":
        return cmdLedgerArchive(args, pretty);
      case "log":
        return cmdLedgerLog(args, pretty);
      default:
        return err({
          error: `unknown ledger subcommand: ${args.subcommand ?? "(none)"}`,
        });
    }
  }

  if (args.family === "watcher") {
    switch (args.subcommand) {
      case "list":
        return cmdWatcherList(pretty);
      case "show":
        return cmdWatcherShow(args, pretty);
      case "run":
        return cmdWatcherRun(args, pretty);
      default:
        return err({
          error: `unknown watcher subcommand: ${args.subcommand ?? "(none)"}`,
        });
    }
  }

  if (args.family === "project") {
    switch (args.subcommand) {
      case "list":
        return cmdProjectList(pretty);
      case "inspect":
        return cmdProjectInspect(args, pretty);
      case "status":
        return cmdProjectStatus(args, pretty);
      case "next":
        return cmdProjectNext(args, pretty);
      case "repair":
        return cmdProjectRepair(args, pretty);
      case "verify":
        return cmdProjectRunDeclared(args, pretty, "verify");
      case "smoke":
        return cmdProjectRunDeclared(args, pretty, "smoke");
      default:
        return err({
          error: `unknown project subcommand: ${args.subcommand ?? "(none)"}`,
        });
    }
  }

  if (args.family === "ops") {
    switch (args.subcommand) {
      case "status":
        return cmdOpsStatus(pretty);
      case "repair-launchagent":
        return cmdOpsRepairLaunchAgent(args, pretty);
      default:
        return err({
          error: `unknown ops subcommand: ${args.subcommand ?? "(none)"}`,
        });
    }
  }

  if (args.family === "daemon") {
    switch (args.subcommand) {
      case "run":
        return cmdDaemonRun(args, pretty);
      case "status":
        return cmdDaemonStatus(args, pretty);
      case "health":
        return cmdDaemonHealth(args, pretty);
      case "stop":
        return cmdDaemonStop(args, pretty);
      case "print-plist":
        return cmdDaemonPrintPlist(args, pretty);
      case "install-user-agent":
        return cmdDaemonInstallUserAgent(args, pretty);
      default:
        return err({
          error: `unknown daemon subcommand: ${args.subcommand ?? "(none)"}`,
        });
    }
  }

  if (args.family === "policy") {
    switch (args.subcommand) {
      case "simulate":
        return cmdPolicySimulate(args, pretty);
      case "evaluate":
        return cmdPolicyEvaluate(args, pretty);
      case "approve":
        return cmdPolicyApprove(args, pretty);
      case "consume":
        return cmdPolicyConsume(args, pretty);
      default:
        return err({
          error: `unknown policy subcommand: ${args.subcommand ?? "(none)"}`,
        });
    }
  }

  if (args.family === "approval" || args.family === "approvals") {
    switch (args.subcommand) {
      case "list":
        return cmdApprovalList(args, pretty);
      case "approve":
        return cmdApprovalApprove(args, pretty);
      case "deny":
        return cmdApprovalDeny(args, pretty);
      default:
        return err({
          error: `unknown approval subcommand: ${args.subcommand ?? "(none)"}`,
        });
    }
  }

  if (args.family === "mcp") {
    switch (args.subcommand) {
      case "list":
        return cmdMcpList(pretty);
      case "config":
        return cmdMcpConfig(args, pretty);
      case "call":
        return cmdMcpCall(args, pretty);
      case "smoke":
        return cmdMcpSmoke(args, pretty);
      case "run":
        return cmdMcpRun();
      default:
        return err({
          error: `unknown mcp subcommand: ${args.subcommand ?? "(none)"}`,
        });
    }
  }

  if (args.family === "helper") {
    switch (args.subcommand) {
      case "status":
        return cmdHelperStatus(pretty);
      case "build":
        return cmdHelperBuild(pretty);
      case "install":
        return cmdHelperInstall(pretty);
      case "production-status":
        return cmdHelperProductionStatus(pretty);
      case "production-invoke":
        return cmdHelperProductionInvoke(args, pretty);
      case "invoke":
        return cmdHelperInvoke(args, pretty);
      case "self-test":
        return cmdHelperSelfTest(pretty);
      default:
        return err({
          error: `unknown helper subcommand: ${args.subcommand ?? "(none)"}`,
        });
    }
  }

  if (args.family === "mlx") {
    return cmdMlx(args, pretty);
  }

  if (args.family === "route") {
    switch (args.subcommand) {
      case "explain":
        return cmdRouteExplain(args, pretty);
      default:
        return err({
          error: `unknown route subcommand: ${args.subcommand ?? "(none)"}`,
        });
    }
  }

  if (args.family === "client" || args.family === "siri") {
    switch (args.subcommand) {
      case "status":
        return cmdClientStatus(pretty);
      default:
        return err({
          error: `unknown ${args.family} subcommand: ${args.subcommand ?? "(none)"}`,
        });
    }
  }

  if (args.family === "overnight") {
    switch (args.subcommand) {
      case "plan":
        return cmdOvernightPlan(args, pretty);
      case "enqueue":
        return cmdOvernightEnqueue(args, pretty);
      case "run":
        return cmdOvernightRun(args, pretty);
      case "brief":
        return cmdOvernightBrief(args, pretty);
      case "smoke":
        return cmdOvernightSmoke(pretty);
      default:
        return err({
          error: `unknown overnight subcommand: ${args.subcommand ?? "(none)"}`,
        });
    }
  }

  if (args.family === "scheduler") {
    switch (args.subcommand) {
      case "list":
        return cmdSchedulerList(pretty);
      case "run":
        return cmdSchedulerRun(args, pretty);
      case "install":
        return cmdSchedulerInstall(args, pretty);
      default:
        return err({
          error: `unknown scheduler subcommand: ${args.subcommand ?? "(none)"}`,
        });
    }
  }

  if (args.family === "swarm") {
    switch (args.subcommand) {
      case "run":
        return cmdSwarmRun(args, pretty);
      case "list":
        return cmdSwarmList(args, pretty);
      default:
        return err({
          error: `unknown swarm subcommand: ${args.subcommand ?? "(none)"}`,
        });
    }
  }

  if (args.family === "eval") {
    switch (args.subcommand) {
      case "run":
        return cmdEvalRun(args, pretty);
      case "stats":
        return cmdEvalStats(pretty);
      default:
        return err({
          error: `unknown eval subcommand: ${args.subcommand ?? "(none)"}`,
        });
    }
  }

  if (args.family === "telemetry") {
    switch (args.subcommand) {
      case "export":
        return cmdTelemetryExport(args, pretty);
      default:
        return err({
          error: `unknown telemetry subcommand: ${args.subcommand ?? "(none)"}`,
        });
    }
  }

  if (args.family === "memory") {
    switch (args.subcommand) {
      case "put":
        return cmdMemoryPut(args, pretty);
      case "get":
        return cmdMemoryGet(args, pretty);
      case "list":
        return cmdMemoryList(args, pretty);
      case "search":
        return cmdMemorySearch(args, pretty);
      case "delete":
        return cmdMemoryDelete(args, pretty);
      case "stats":
        return cmdMemoryStats(pretty);
      default:
        return err({
          error: `unknown memory subcommand: ${args.subcommand ?? "(none)"}`,
        });
    }
  }

  if (args.family === "refinery") {
    switch (args.subcommand) {
      case "harvest":
        return cmdRefineryHarvest(args, pretty);
      case "propose":
        return cmdRefineryPropose(args, pretty);
      case "rules":
        return cmdRefineryRules(args, pretty);
      case "promote":
        return cmdRefineryPromote(args, pretty);
      case "eval-export":
        return cmdRefineryEvalExport(args, pretty);
      case "eval-stats":
        return cmdRefineryEvalStats(pretty);
      case "auto-promote":
        return cmdRefineryAutoPromote(args, pretty);
      case "revoke":
        return cmdRefineryRevoke(args, pretty);
      default:
        return err({
          error: `unknown refinery subcommand: ${args.subcommand ?? "(none)"}`,
        });
    }
  }

  if (args.family === "ghost") {
    switch (args.subcommand) {
      case "run":
        return cmdGhostRun(args, pretty);
      case "status":
        return cmdGhostStatus(args, pretty);
      case "queue":
        return cmdGhostQueue(args, pretty);
      default:
        return err({
          error: `unknown ghost subcommand: ${args.subcommand ?? "(none)"}`,
        });
    }
  }

  if (args.family === "work") {
    switch (args.subcommand) {
      case "validate":
        return cmdWorkValidate(args, pretty);
      case "run":
        return cmdWorkRun(args, pretty);
      default:
        return err({
          error: `unknown work subcommand: ${args.subcommand ?? "(none)"}`,
        });
    }
  }

  if (args.family === "salesforce") {
    switch (args.subcommand) {
      case "audit-batch":
        return cmdSalesforceAuditBatch(args, pretty);
      case "portfolio-summary":
        return cmdSalesforcePortfolioSummary(args, pretty);
      default:
        return err({
          error: `unknown salesforce subcommand: ${args.subcommand ?? "(none)"}`,
        });
    }
  }

  err({ error: `unknown command family: ${args.family}` });
}

main().catch((e) => {
  err({
    error: "unhandled error in frontier CLI",
    message: e instanceof Error ? e.message : String(e),
    stack: e instanceof Error ? e.stack : undefined,
  });
});
