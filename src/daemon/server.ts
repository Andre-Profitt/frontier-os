import { createServer, request } from "node:http";
import { existsSync, mkdirSync, unlinkSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";

import { approvalQueue, approvePendingTrace } from "../approvals/queue.ts";
import { defaultQueueDir, queueStatus } from "../ghost/shift.ts";
import { closeLedger, getLedger } from "../ledger/index.ts";
import { newSessionId } from "../ledger/events.ts";
import { opsStatus } from "../ops/status.ts";
import { listProjects, projectStatus } from "../projects/registry.ts";
import { projectNext, projectRepairPlan } from "../projects/planner.ts";
import { clientStatus } from "../client/status.ts";
import { overnightPlan } from "../overnight/plan.ts";
import { overnightBrief } from "../overnight/brief.ts";

const DEFAULT_SOCKET = resolve(homedir(), ".frontier", "run", "frontierd.sock");
const DAEMON_VERSION = "0.1.0";

export interface DaemonRunOptions {
  socketPath?: string;
}

export interface DaemonRuntime {
  socketPath: string;
  startedAt: string;
  pid: number;
  stopped: Promise<void>;
}

export interface DaemonClientResult {
  reachable: boolean;
  socketPath: string;
  statusCode: number | null;
  body: unknown;
  error: string | null;
}

export function defaultDaemonSocketPath(): string {
  return DEFAULT_SOCKET;
}

export async function startDaemon(
  options: DaemonRunOptions = {},
): Promise<DaemonRuntime> {
  const socketPath = options.socketPath ?? DEFAULT_SOCKET;
  const startedAt = new Date().toISOString();
  mkdirSync(dirname(socketPath), { recursive: true });
  await clearStaleSocket(socketPath);

  const sessionId = newSessionId("frontierd");
  const ledger = getLedger();
  ledger.ensureSession({
    sessionId,
    label: "frontierd",
    tags: ["frontierd", "daemon"],
  });
  ledger.appendEvent({
    sessionId,
    kind: "daemon.start",
    actor: "frontierd",
    payload: { socketPath, pid: process.pid, startedAt },
  });

  let stopRequested = false;
  let resolveStopped!: () => void;
  const stopped = new Promise<void>((resolvePromise) => {
    resolveStopped = resolvePromise;
  });

  const server = createServer(async (req, res) => {
    const started = Date.now();
    const method = req.method ?? "GET";
    const url = new URL(req.url ?? "/", "http://frontierd.local");
    try {
      const requestBody = await readJsonBody(req);
      const body = await routeRequest({
        method,
        path: url.pathname,
        query: url.searchParams,
        body: requestBody,
        socketPath,
        startedAt,
        stop: () => {
          stopRequested = true;
          setTimeout(() => {
            server.close(() => {
              cleanupSocket(socketPath);
              ledger.appendEvent({
                sessionId,
                kind: "daemon.stop",
                actor: "frontierd",
                payload: {
                  socketPath,
                  pid: process.pid,
                  requestedBy: "api",
                  uptimeSeconds: process.uptime(),
                },
              });
              closeLedger();
              resolveStopped();
            });
          }, 25);
        },
      });
      writeJson(res, 200, body);
      ledger.appendEvent({
        sessionId,
        kind: url.pathname === "/health" ? "daemon.health" : "daemon.request",
        actor: "frontierd",
        payload: {
          method,
          path: url.pathname,
          statusCode: 200,
          durationMs: Date.now() - started,
        },
      });
    } catch (e) {
      const message = e instanceof HttpError ? e.message : String(e);
      const statusCode = e instanceof HttpError ? e.statusCode : 500;
      writeJson(res, statusCode, { error: message, statusCode });
      ledger.appendEvent({
        sessionId,
        kind: "daemon.request",
        actor: "frontierd",
        payload: {
          method,
          path: url.pathname,
          statusCode,
          error: message,
          durationMs: Date.now() - started,
        },
      });
    }
  });

  await new Promise<void>((resolveListen, rejectListen) => {
    server.once("error", rejectListen);
    server.listen(socketPath, () => {
      server.off("error", rejectListen);
      resolveListen();
    });
  });

  const shutdown = (signal: NodeJS.Signals): void => {
    if (stopRequested) return;
    stopRequested = true;
    server.close(() => {
      cleanupSocket(socketPath);
      ledger.appendEvent({
        sessionId,
        kind: "daemon.stop",
        actor: "frontierd",
        payload: {
          socketPath,
          pid: process.pid,
          requestedBy: signal,
          uptimeSeconds: process.uptime(),
        },
      });
      closeLedger();
      resolveStopped();
    });
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);

  return { socketPath, startedAt, pid: process.pid, stopped };
}

export async function requestDaemon(
  path: string,
  options: {
    socketPath?: string;
    method?: "GET" | "POST";
    timeoutMs?: number;
    body?: Record<string, unknown>;
  } = {},
): Promise<DaemonClientResult> {
  const socketPath = options.socketPath ?? DEFAULT_SOCKET;
  const method = options.method ?? "GET";
  const timeoutMs = options.timeoutMs ?? 2000;
  const bodyText =
    options.body === undefined ? null : JSON.stringify(options.body);
  return new Promise((resolveClient) => {
    const req = request(
      {
        socketPath,
        path,
        method,
        timeout: timeoutMs,
        headers:
          bodyText === null
            ? undefined
            : {
                "content-type": "application/json",
                "content-length": Buffer.byteLength(bodyText),
              },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf8");
          let body: unknown = text;
          try {
            body = text ? JSON.parse(text) : null;
          } catch {
            body = text;
          }
          resolveClient({
            reachable: true,
            socketPath,
            statusCode: res.statusCode ?? null,
            body,
            error: null,
          });
        });
      },
    );
    req.on("timeout", () => {
      req.destroy(new Error("timeout"));
    });
    req.on("error", (err) => {
      resolveClient({
        reachable: false,
        socketPath,
        statusCode: null,
        body: null,
        error: err.message,
      });
    });
    if (bodyText !== null) req.write(bodyText);
    req.end();
  });
}

interface RouteContext {
  method: string;
  path: string;
  query: URLSearchParams;
  body: Record<string, unknown>;
  socketPath: string;
  startedAt: string;
  stop: () => void;
}

async function routeRequest(ctx: RouteContext): Promise<unknown> {
  if (ctx.path !== "/v1/commands") {
    requireMethod(ctx, postOnlyPath(ctx.path) ? "POST" : "GET");
  }

  if (ctx.path === "/health") {
    return healthPayload(ctx.socketPath, ctx.startedAt);
  }
  if (ctx.path === "/v1/commands") {
    if (ctx.method === "GET") {
      const { CommandStore } = await import("../commands/store.ts");
      const store = new CommandStore();
      try {
        const listOptions: Parameters<typeof store.list>[0] = {
          limit: parseLimit(ctx.query.get("limit"), 25),
        };
        const status = commandStatusFromUnknown(ctx.query.get("status"));
        if (status !== undefined) listOptions.status = status;
        return {
          generatedAt: new Date().toISOString(),
          commands: store.list(listOptions),
        };
      } finally {
        store.close();
      }
    }
    if (ctx.method === "POST") {
      const { CommandStore } = await import("../commands/store.ts");
      const store = new CommandStore();
      try {
        return { command: store.submit(commandInputFromRequest(ctx)) };
      } finally {
        store.close();
      }
    }
    throw new HttpError(405, "/v1/commands requires GET or POST");
  }
  if (ctx.path === "/v1/command-worker/status") {
    const { commandWorkerStatus } = await import("../commands/worker.ts");
    return commandWorkerStatus();
  }
  if (ctx.path === "/v1/command-worker/run-once") {
    requireMethod(ctx, "POST");
    const { runCommandWorkerOnce } = await import("../commands/worker.ts");
    const body = recordFromUnknown(ctx.body);
    return runCommandWorkerOnce(commandWorkerOptionsFromRequest(body));
  }
  if (ctx.path === "/v1/command-brief") {
    const { commandBrief } = await import("../commands/brief.ts");
    return commandBrief({
      hours: parseHours(ctx.query.get("hours"), 24),
      limit: parseLimit(ctx.query.get("limit"), 100),
    });
  }
  if (ctx.path === "/v1/command-readiness") {
    const { commandReadiness } = await import("../commands/readiness.ts");
    return commandReadiness({
      hours: parseHours(ctx.query.get("hours"), 24),
      limit: parseLimit(ctx.query.get("limit"), 100),
      daemon: {
        reachable: true,
        status: "ok",
        pid: process.pid,
        uptimeSeconds: Number(process.uptime().toFixed(3)),
      },
    });
  }
  if (ctx.path === "/v1/command-debt") {
    const { commandDebt } = await import("../commands/debt.ts");
    return commandDebt({
      limit: parseLimit(ctx.query.get("limit"), 100),
    });
  }
  const commandShowMatch = ctx.path.match(/^\/v1\/commands\/([^/]+)$/);
  if (commandShowMatch) {
    const { CommandStore } = await import("../commands/store.ts");
    const store = new CommandStore();
    try {
      const command = store.get(decodeURIComponent(commandShowMatch[1]!));
      if (!command) throw new HttpError(404, "unknown command");
      return { command };
    } finally {
      store.close();
    }
  }
  const commandEventsMatch = ctx.path.match(/^\/v1\/commands\/([^/]+)\/events$/);
  if (commandEventsMatch) {
    const commandId = decodeURIComponent(commandEventsMatch[1]!);
    const limit = parseLimit(ctx.query.get("limit"), 200);
    const { CommandStore } = await import("../commands/store.ts");
    const store = new CommandStore();
    try {
      const command = store.get(commandId);
      if (!command) throw new HttpError(404, "unknown command");
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
            limit: Math.min(limit, 1000),
          }),
        )
        .sort((a, b) => a.ts.localeCompare(b.ts))
        .slice(-Math.min(limit, 1000));
      return {
        command,
        sessions,
        events,
      };
    } finally {
      store.close();
    }
  }
  const commandArtifactsMatch = ctx.path.match(/^\/v1\/commands\/([^/]+)\/artifacts$/);
  if (commandArtifactsMatch) {
    const { commandArtifacts } = await import("../commands/artifacts.ts");
    try {
      return commandArtifacts(decodeURIComponent(commandArtifactsMatch[1]!));
    } catch (e) {
      throw new HttpError(
        e instanceof Error && e.message.startsWith("unknown command") ? 404 : 500,
        e instanceof Error ? e.message : String(e),
      );
    }
  }
  const commandPacketMatch = ctx.path.match(/^\/v1\/commands\/([^/]+)\/packet$/);
  if (commandPacketMatch) {
    const { commandResultPacket } = await import("../commands/packet.ts");
    try {
      return commandResultPacket(decodeURIComponent(commandPacketMatch[1]!));
    } catch (e) {
      throw new HttpError(
        e instanceof Error && e.message.startsWith("unknown command") ? 404 : 500,
        e instanceof Error ? e.message : String(e),
      );
    }
  }
  const commandBriefMatch = ctx.path.match(/^\/v1\/commands\/([^/]+)\/brief$/);
  if (commandBriefMatch) {
    const { commandFinalBrief } = await import("../commands/final-brief.ts");
    try {
      return commandFinalBrief(decodeURIComponent(commandBriefMatch[1]!), {
        eventLimit: parseLimit(ctx.query.get("eventLimit"), 50),
      });
    } catch (e) {
      throw new HttpError(
        e instanceof Error && e.message.startsWith("unknown command") ? 404 : 500,
        e instanceof Error ? e.message : String(e),
      );
    }
  }
  const commandResumeMatch = ctx.path.match(/^\/v1\/commands\/([^/]+)\/resume$/);
  if (commandResumeMatch) {
    const { CommandStore } = await import("../commands/store.ts");
    const store = new CommandStore();
    try {
      const body = recordFromUnknown(ctx.body);
      const command = store.resume({
        commandId: decodeURIComponent(commandResumeMatch[1]!),
        ...(typeof body.approval === "string"
          ? { approvalTraceId: body.approval }
          : {}),
        ...(typeof body.actor === "string" ? { actor: body.actor } : {}),
        ...(isRecord(body.resumePayload)
          ? { resumePayload: body.resumePayload }
          : {}),
      });
      return { command };
    } finally {
      store.close();
    }
  }
  const commandCancelMatch = ctx.path.match(/^\/v1\/commands\/([^/]+)\/cancel$/);
  if (commandCancelMatch) {
    const { CommandStore } = await import("../commands/store.ts");
    const store = new CommandStore();
    try {
      const body = recordFromUnknown(ctx.body);
      return {
        command: store.cancel(
          decodeURIComponent(commandCancelMatch[1]!),
          typeof body.actor === "string" ? body.actor : "frontierd",
        ),
      };
    } finally {
      store.close();
    }
  }
  const commandRetryMatch = ctx.path.match(/^\/v1\/commands\/([^/]+)\/retry$/);
  if (commandRetryMatch) {
    const { CommandStore } = await import("../commands/store.ts");
    const store = new CommandStore();
    try {
      const body = recordFromUnknown(ctx.body);
      return {
        ...store.retry(
          decodeURIComponent(commandRetryMatch[1]!),
          typeof body.actor === "string" ? body.actor : "frontierd",
        ),
      };
    } finally {
      store.close();
    }
  }
  const commandRequeueMatch = ctx.path.match(/^\/v1\/commands\/([^/]+)\/requeue$/);
  if (commandRequeueMatch) {
    const { CommandStore } = await import("../commands/store.ts");
    const store = new CommandStore();
    try {
      const body = recordFromUnknown(ctx.body);
      return {
        ...store.requeue(
          decodeURIComponent(commandRequeueMatch[1]!),
          typeof body.actor === "string" ? body.actor : "frontierd",
        ),
      };
    } finally {
      store.close();
    }
  }
  if (ctx.path === "/v1/projects") {
    return { projects: listProjects() };
  }
  if (ctx.path === "/v1/projects/status") {
    const status = await projectStatus();
    return {
      generatedAt: new Date().toISOString(),
      projectCount: Array.isArray(status) ? status.length : 1,
      projects: status,
    };
  }
  const projectMatch = ctx.path.match(/^\/v1\/projects\/([^/]+)\/status$/);
  if (projectMatch) {
    const id = decodeURIComponent(projectMatch[1]!);
    return { generatedAt: new Date().toISOString(), project: await projectStatus(id) };
  }
  const projectNextMatch = ctx.path.match(/^\/v1\/projects\/([^/]+)\/next$/);
  if (projectNextMatch) {
    const id = decodeURIComponent(projectNextMatch[1]!);
    return await projectNext(id);
  }
  const projectRepairMatch = ctx.path.match(/^\/v1\/projects\/([^/]+)\/repair$/);
  if (projectRepairMatch) {
    const id = decodeURIComponent(projectRepairMatch[1]!);
    return await projectRepairPlan(id);
  }
  if (ctx.path === "/v1/ops/status") {
    return await opsStatus();
  }
  if (ctx.path === "/v1/watchers") {
    const ops = await opsStatus();
    return {
      generatedAt: ops.generatedAt,
      watchers: ops.watchers,
      scheduler: ops.scheduler,
    };
  }
  if (ctx.path === "/v1/ghost/status") {
    const queueDir = defaultQueueDir();
    return { queueDir, counts: queueStatus(queueDir) };
  }
  if (ctx.path === "/v1/ledger/recent") {
    const limit = parseLimit(ctx.query.get("limit"), 50);
    const ledger = getLedger();
    return {
      sessions: ledger.listSessions(Math.min(limit, 100)),
      events: ledger.recentEvents(Math.min(limit, 100)),
    };
  }
  if (ctx.path === "/v1/approvals") {
    const limit = parseLimit(ctx.query.get("limit"), 25);
    return approvalQueue({
      limit: Math.min(limit, 100),
      includeResolved: ctx.query.get("includeResolved") === "1",
    });
  }
  if (ctx.path === "/v1/approvals/approve") {
    const body = recordFromUnknown(ctx.body);
    const traceId =
      ctx.query.get("traceId") ?? stringFromUnknown(body.traceId) ?? "";
    if (!traceId) throw new HttpError(400, "approval approve requires traceId");
    const actor =
      ctx.query.get("actor") ?? stringFromUnknown(body.actor) ?? "frontierd";
    const opts: Parameters<typeof approvePendingTrace>[0] = {
      traceId,
      actor,
    };
    const ttl = ctx.query.get("ttl") ?? stringFromUnknown(body.ttl);
    if (ttl) opts.ttl = ttl;
    const autoResume = booleanFromUnknown(
      body.resume ?? ctx.query.get("resume"),
    );
    const approval = approvePendingTrace(opts);
    const { CommandStore } = await import("../commands/store.ts");
    const store = new CommandStore();
    try {
      const command = store.getByTraceId(traceId);
      const resumedCommand =
        autoResume !== false && command?.status === "blocked_approval"
          ? store.resume({
              commandId: command.commandId,
              approvalTraceId: traceId,
              actor,
            })
          : null;
      return {
        ...approval,
        resumedCommand,
      };
    } finally {
      store.close();
    }
  }
  if (ctx.path === "/v1/siri/status" || ctx.path === "/v1/client/status") {
    return await clientStatus();
  }
  if (ctx.path === "/v1/overnight/plan") {
    return await overnightPlan({ hours: parseHours(ctx.query.get("hours"), 8) });
  }
  if (ctx.path === "/v1/overnight/brief") {
    const sinceIso = ctx.query.get("since");
    const opts: Parameters<typeof overnightBrief>[0] = {
      hours: parseHours(ctx.query.get("hours"), 24),
    };
    if (sinceIso) opts.sinceIso = sinceIso;
    return overnightBrief(opts);
  }
  if (ctx.path === "/shutdown") {
    ctx.stop();
    return { status: "stopping", socketPath: ctx.socketPath };
  }

  throw new HttpError(404, `unknown endpoint: ${ctx.path}`);
}

function healthPayload(socketPath: string, startedAt: string) {
  return {
    status: "ok",
    service: "frontierd",
    version: DAEMON_VERSION,
    pid: process.pid,
    socketPath,
    startedAt,
    uptimeSeconds: Number(process.uptime().toFixed(3)),
  };
}

function requireMethod(ctx: RouteContext, expected: string): void {
  if (ctx.method !== expected) {
    throw new HttpError(405, `${ctx.path} requires ${expected}`);
  }
}

function postOnlyPath(path: string): boolean {
  return (
    path === "/shutdown" ||
    path === "/v1/approvals/approve" ||
    path === "/v1/command-worker/run-once" ||
    /^\/v1\/commands\/[^/]+\/(resume|cancel|retry|requeue)$/.test(path)
  );
}

function commandWorkerOptionsFromRequest(
  body: Record<string, unknown>,
): {
  workerId?: string;
  leaseMs?: number;
  commandId?: string;
  maxApprovalClass?: 0 | 1 | 2 | 3;
} {
  const opts: {
    workerId?: string;
    leaseMs?: number;
    commandId?: string;
    maxApprovalClass?: 0 | 1 | 2 | 3;
  } = {};
  const workerId = stringFromUnknown(body.workerId);
  if (workerId) opts.workerId = workerId;
  const commandId = stringFromUnknown(body.commandId);
  if (commandId) opts.commandId = commandId;
  const leaseMs = integerFromUnknown(body.leaseMs);
  if (leaseMs !== null) opts.leaseMs = leaseMs;
  const maxApprovalClass = approvalClassFromUnknown(body.maxApprovalClass);
  if (maxApprovalClass !== null) opts.maxApprovalClass = maxApprovalClass;
  return opts;
}

function parseLimit(raw: string | null, fallback: number): number {
  if (!raw) return fallback;
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : fallback;
}

function parseHours(raw: string | null, fallback: number): number {
  if (!raw) return fallback;
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : fallback;
}

function writeJson(
  res: import("node:http").ServerResponse,
  statusCode: number,
  body: unknown,
): void {
  res.writeHead(statusCode, {
    "content-type": "application/json; charset=utf-8",
  });
  res.end(JSON.stringify(body));
}

async function readJsonBody(
  req: import("node:http").IncomingMessage,
): Promise<Record<string, unknown>> {
  if (req.method !== "POST" && req.method !== "PUT" && req.method !== "PATCH") {
    return {};
  }
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  const raw = Buffer.concat(chunks).toString("utf8").trim();
  if (!raw) return {};
  const parsed = JSON.parse(raw) as unknown;
  if (!isRecord(parsed)) {
    throw new HttpError(400, "JSON request body must be an object");
  }
  return parsed;
}

function commandInputFromRequest(ctx: RouteContext) {
  const body = recordFromUnknown(ctx.body);
  const intent =
    stringFromUnknown(body.intent) ??
    stringFromUnknown(body.command) ??
    ctx.query.get("intent") ??
    "";
  if (!intent) throw new HttpError(400, "command submit requires intent");
  const input: {
    intent: string;
    projectId?: string;
    actorId?: string;
    surface: "api";
    origin: string;
    traceId?: string;
    correlationId?: string;
    approvalClass?: 0 | 1 | 2 | 3;
    payload?: Record<string, unknown>;
    policy?: {
      allowSideEffects?: boolean;
      requireVerification?: boolean;
      maxRuntimeSeconds?: number;
      maxRetries?: number;
      retryBackoffMs?: number;
    };
  } = {
    intent,
    surface: "api",
    origin: "frontierd",
  };
  const projectId = stringFromUnknown(body.projectId) ?? ctx.query.get("project");
  if (projectId) input.projectId = projectId;
  const actorId = stringFromUnknown(body.actorId) ?? stringFromUnknown(body.actor);
  if (actorId) input.actorId = actorId;
  const traceId = stringFromUnknown(body.traceId);
  if (traceId) input.traceId = traceId;
  const correlationId = stringFromUnknown(body.correlationId);
  if (correlationId) input.correlationId = correlationId;
  const approvalClass = approvalClassFromUnknown(
    body.approvalClass ?? body.class ?? ctx.query.get("class"),
  );
  if (approvalClass !== null) input.approvalClass = approvalClass;
  if (isRecord(body.payload)) input.payload = body.payload;
  const policyBody = recordFromUnknown(body.policy);
  const policy: NonNullable<typeof input.policy> = {};
  const maxRuntimeSeconds = integerFromUnknown(
    policyBody.maxRuntimeSeconds ?? body.maxRuntimeSeconds ?? ctx.query.get("maxRuntimeSeconds"),
  );
  if (maxRuntimeSeconds !== null && maxRuntimeSeconds > 0) {
    policy.maxRuntimeSeconds = maxRuntimeSeconds;
  }
  const maxRetries = integerFromUnknown(
    policyBody.maxRetries ?? body.maxRetries ?? ctx.query.get("maxRetries"),
  );
  if (maxRetries !== null && maxRetries >= 0) {
    policy.maxRetries = Math.min(maxRetries, 9);
  }
  const retryBackoffMs = integerFromUnknown(
    policyBody.retryBackoffMs ?? body.retryBackoffMs ?? ctx.query.get("retryBackoffMs"),
  );
  if (retryBackoffMs !== null && retryBackoffMs >= 0) {
    policy.retryBackoffMs = retryBackoffMs;
  }
  const requireVerification = booleanFromUnknown(
    policyBody.requireVerification ?? body.requireVerification,
  );
  if (requireVerification !== null) policy.requireVerification = requireVerification;
  const allowSideEffects = booleanFromUnknown(
    policyBody.allowSideEffects ?? body.allowSideEffects,
  );
  if (allowSideEffects !== null) policy.allowSideEffects = allowSideEffects;
  if (Object.keys(policy).length > 0) input.policy = policy;
  return input;
}

function commandStatusFromUnknown(value: unknown):
  | "queued"
  | "running"
  | "blocked_approval"
  | "blocked_policy"
  | "completed"
  | "failed"
  | "canceled"
  | undefined {
  if (typeof value !== "string") return undefined;
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

function approvalClassFromUnknown(value: unknown): 0 | 1 | 2 | 3 | null {
  if (value === undefined || value === null || value === "") return null;
  const n = typeof value === "number" ? value : Number(String(value));
  if (n === 0 || n === 1 || n === 2 || n === 3) return n;
  throw new HttpError(400, `invalid approval class: ${String(value)}`);
}

function recordFromUnknown(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {};
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringFromUnknown(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function integerFromUnknown(value: unknown): number | null {
  if (value === undefined || value === null || value === "") return null;
  const n = typeof value === "number" ? value : Number(String(value));
  if (Number.isInteger(n)) return n;
  throw new HttpError(400, `expected integer, got: ${String(value)}`);
}

function booleanFromUnknown(value: unknown): boolean | null {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value === "boolean") return value;
  if (value === "true" || value === "1") return true;
  if (value === "false" || value === "0") return false;
  throw new HttpError(400, `expected boolean, got: ${String(value)}`);
}

async function clearStaleSocket(socketPath: string): Promise<void> {
  if (!existsSync(socketPath)) return;
  const existing = await requestDaemon("/health", {
    socketPath,
    timeoutMs: 250,
  });
  if (existing.reachable) {
    throw new Error(`frontierd already reachable at ${socketPath}`);
  }
  cleanupSocket(socketPath);
}

function cleanupSocket(socketPath: string): void {
  try {
    if (existsSync(socketPath)) unlinkSync(socketPath);
  } catch {
    // best effort; a future run will detect or replace stale sockets
  }
}

class HttpError extends Error {
  constructor(
    readonly statusCode: number,
    message: string,
  ) {
    super(message);
  }
}
