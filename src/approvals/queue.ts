import { approveTrace, parseTtlMs, type ApprovalGrant } from "../policy/evaluator.ts";
import { getLedger } from "../ledger/index.ts";
import type { LedgerEvent } from "../ledger/events.ts";

export type ApprovalRequestStatus = "pending" | "approved" | "consumed";

export interface ApprovalQueueOptions {
  limit?: number;
  includeResolved?: boolean;
}

export interface ApprovalRequest {
  traceId: string;
  status: ApprovalRequestStatus;
  requestedAt: string;
  originKind: string;
  originSessionId: string;
  verb: string;
  actor: string | null;
  projectId: string | null;
  approvalClass: number | null;
  reason: string | null;
  summary: string;
  arguments: Record<string, unknown>;
  approve: {
    ttlDefault: string;
    cli: string;
    apiPath: string;
  };
  consume: {
    cli: string | null;
  };
  activeGrant: ApprovalGrantSummary | null;
}

export interface ApprovalGrantSummary {
  tokenId: string;
  traceId: string;
  actor: string;
  grantedAt: string;
  expiresAt: string;
  ttlSeconds: number;
  expired: boolean;
  consumed: boolean;
}

export interface ApprovalQueue {
  generatedAt: string;
  pendingCount: number;
  approvedCount: number;
  consumedCount: number;
  expiredGrantCount: number;
  pending: ApprovalRequest[];
  approved: ApprovalRequest[];
  consumed: ApprovalRequest[];
  recentGrants: ApprovalGrantSummary[];
  workAwaitingApproval: LedgerEvent[];
  ghostBlocked: LedgerEvent[];
}

export interface ApprovalApproveResult {
  status: "approved" | "already_approved";
  traceId: string;
  request: ApprovalRequest;
  grant: ApprovalGrantSummary;
}

const DEFAULT_TTL = "15m";

export function approvalQueue(options: ApprovalQueueOptions = {}): ApprovalQueue {
  const limit = Math.min(Math.max(options.limit ?? 25, 1), 100);
  const includeResolved = options.includeResolved === true;
  const generatedAt = new Date().toISOString();
  const nowMs = Date.now();
  const ledger = getLedger();
  const grantSummaries = ledger
    .findEventsByKind("policy.approval_granted", 1000)
    .map((event) => grantSummary(event, nowMs))
    .filter((grant): grant is ApprovalGrantSummary => grant !== null);
  const consumedTokenIds = new Set(
    ledger
      .findEventsByKind("policy.approval_consumed", 1000)
      .map((event) => event.payload.tokenId)
      .filter((tokenId): tokenId is string => typeof tokenId === "string"),
  );
  for (const grant of grantSummaries) {
    grant.consumed = consumedTokenIds.has(grant.tokenId);
  }
  const activeGrantByTrace = new Map<string, ApprovalGrantSummary>();
  for (const grant of grantSummaries) {
    if (!grant.expired && !grant.consumed && !activeGrantByTrace.has(grant.traceId)) {
      activeGrantByTrace.set(grant.traceId, grant);
    }
  }
  const consumedTraceIds = new Set(
    grantSummaries
      .filter((grant) => grant.consumed)
      .map((grant) => grant.traceId),
  );

  const requests = approvalRequestEvents(ledger)
    .map((event) =>
      requestFromEvent(event, activeGrantByTrace, consumedTraceIds),
    )
    .filter((request): request is ApprovalRequest => request !== null)
    .sort((a, b) => b.requestedAt.localeCompare(a.requestedAt));
  const unique = uniqueByTrace(requests);
  const pending = unique
    .filter((request) => request.status === "pending")
    .slice(0, limit);
  const approved = unique
    .filter((request) => request.status === "approved")
    .slice(0, limit);
  const consumed = includeResolved
    ? unique.filter((request) => request.status === "consumed").slice(0, limit)
    : [];
  return {
    generatedAt,
    pendingCount: pending.length,
    approvedCount: approved.length,
    consumedCount: unique.filter((request) => request.status === "consumed").length,
    expiredGrantCount: grantSummaries.filter((grant) => grant.expired).length,
    pending,
    approved,
    consumed,
    recentGrants: grantSummaries.slice(0, limit),
    workAwaitingApproval: ledger.findEventsByKind("work.awaiting_approval", limit),
    ghostBlocked: ledger.findEventsByKind("ghost.graph_blocked", limit),
  };
}

export function approvePendingTrace(input: {
  traceId: string;
  ttl?: string;
  actor?: string;
}): ApprovalApproveResult {
  const queue = approvalQueue({ limit: 100, includeResolved: false });
  const request =
    queue.pending.find((candidate) => candidate.traceId === input.traceId) ??
    queue.approved.find((candidate) => candidate.traceId === input.traceId);
  if (!request) {
    throw new Error(`no pending approval request for trace ${input.traceId}`);
  }
  if (request.activeGrant) {
    return {
      status: "already_approved",
      traceId: input.traceId,
      request,
      grant: request.activeGrant,
    };
  }
  const grant = approveTrace({
    traceId: input.traceId,
    ttlMs: parseTtlMs(input.ttl, DEFAULT_TTL),
    actor: input.actor ?? "operator",
  });
  return {
    status: "approved",
    traceId: input.traceId,
    request,
    grant: {
      ...grant,
      expired: false,
      consumed: false,
    },
  };
}

function approvalRequestEvents(ledger: ReturnType<typeof getLedger>): LedgerEvent[] {
  return [
    ...ledger.findEventsByKind("ops.repair_start", 1000),
    ...ledger.findEventsByKind("policy.evaluated", 1000),
  ];
}

function requestFromEvent(
  event: LedgerEvent,
  activeGrantByTrace: Map<string, ApprovalGrantSummary>,
  consumedTraceIds: Set<string>,
): ApprovalRequest | null {
  const payload = event.payload;
  if (event.kind === "ops.repair_start" && !record(payload.before).label) {
    return null;
  }
  const policy =
    event.kind === "ops.repair_start" ? record(payload.policy) : payload;
  const action = record(policy.action);
  const decision = record(policy.decision);
  if (decision.status !== "requires_approval") return null;
  const traceId = stringOrNull(action.traceId) ?? event.traceId;
  if (!traceId) return null;
  const approvalClass = numberOrNull(action.approvalClass);
  if (approvalClass !== 2) return null;
  const activeGrant = activeGrantByTrace.get(traceId) ?? null;
  const status: ApprovalRequestStatus = consumedTraceIds.has(traceId)
    ? "consumed"
    : activeGrant
      ? "approved"
      : "pending";
  const args = record(action.arguments);
  const verb = stringOrNull(action.verb) ?? "unknown";
  return {
    traceId,
    status,
    requestedAt: event.ts,
    originKind: event.kind,
    originSessionId: event.sessionId,
    verb,
    actor: stringOrNull(action.actor),
    projectId: stringOrNull(action.projectId),
    approvalClass,
    reason: stringOrNull(decision.reason),
    summary: summaryFor(verb, args, payload),
    arguments: args,
    approve: {
      ttlDefault: DEFAULT_TTL,
      cli: `frontier approval approve ${shellToken(traceId)} --ttl ${DEFAULT_TTL} --json`,
      apiPath: `/v1/approvals/approve?traceId=${encodeURIComponent(
        traceId,
      )}&ttl=${encodeURIComponent(DEFAULT_TTL)}`,
    },
    consume: {
      cli: consumeCommandFor(verb, traceId, args),
    },
    activeGrant,
  };
}

function uniqueByTrace(requests: ApprovalRequest[]): ApprovalRequest[] {
  const seen = new Set<string>();
  const out: ApprovalRequest[] = [];
  for (const request of requests) {
    if (seen.has(request.traceId)) continue;
    seen.add(request.traceId);
    out.push(request);
  }
  return out;
}

function grantSummary(
  event: LedgerEvent,
  nowMs: number,
): ApprovalGrantSummary | null {
  const payload = event.payload;
  if (
    typeof payload.tokenId !== "string" ||
    typeof payload.traceId !== "string" ||
    typeof payload.actor !== "string" ||
    typeof payload.grantedAt !== "string" ||
    typeof payload.expiresAt !== "string" ||
    typeof payload.ttlSeconds !== "number"
  ) {
    return null;
  }
  return {
    tokenId: payload.tokenId,
    traceId: payload.traceId,
    actor: payload.actor,
    grantedAt: payload.grantedAt,
    expiresAt: payload.expiresAt,
    ttlSeconds: payload.ttlSeconds,
    expired: Date.parse(payload.expiresAt) <= nowMs,
    consumed: false,
  };
}

function summaryFor(
  verb: string,
  args: Record<string, unknown>,
  payload: Record<string, unknown>,
): string {
  if (verb === "ops.repair_launchagent") {
    const label =
      stringOrNull(payload.label) ?? stringOrNull(args.label) ?? "(unknown label)";
    return `Approve user LaunchAgent repair for ${label}`;
  }
  return `Approve ${verb}`;
}

function consumeCommandFor(
  verb: string,
  traceId: string,
  args: Record<string, unknown>,
): string | null {
  if (verb === "ops.repair_launchagent") {
    const label = stringOrNull(args.label);
    if (!label) return null;
    return `frontier ops repair-launchagent ${shellToken(
      label,
    )} --execute --trace-id ${shellToken(traceId)} --consume-token --json`;
  }
  return null;
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function stringOrNull(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function numberOrNull(value: unknown): number | null {
  return typeof value === "number" ? value : null;
}

function shellToken(value: string): string {
  if (/^[A-Za-z0-9_./:@=-]+$/.test(value)) return value;
  return `'${value.replace(/'/g, "'\\''")}'`;
}
