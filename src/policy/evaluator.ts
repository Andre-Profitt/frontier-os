import { randomUUID } from "node:crypto";

import { getLedger } from "../ledger/index.ts";
import type { EventKind, LedgerEvent } from "../ledger/events.ts";

export type ApprovalClass = 0 | 1 | 2 | 3;

export interface PolicyActionEnvelope {
  actor: string;
  source: string;
  projectId: string | null;
  verb: string;
  arguments: Record<string, unknown>;
  approvalClass: ApprovalClass;
  sideEffects: string[];
  traceId: string;
  requestedAt: string;
}

export interface PolicyDecision {
  status: "allow" | "requires_approval" | "deny";
  reason: string;
  approvalRequired: boolean;
  consumedApproval: ApprovalConsumption | null;
}

export interface PolicyEvaluation {
  action: PolicyActionEnvelope;
  decision: PolicyDecision;
  policy: {
    policyId: string;
    version: string;
    classRule: string;
  };
}

export interface ApprovalGrant {
  tokenId: string;
  traceId: string;
  actor: string;
  grantedAt: string;
  expiresAt: string;
  ttlSeconds: number;
}

export interface ApprovalDenial {
  traceId: string;
  actor: string;
  deniedAt: string;
  reason: string;
}

export interface ApprovalConsumption {
  tokenId: string;
  traceId: string;
  consumedAt: string;
  grant: ApprovalGrant;
}

const POLICY_SESSION_ID = "policy-core";
const POLICY_ID = "personal-default";
const POLICY_VERSION = "v1";

const READ_ONLY_VERBS = new Set([
  "daemon.health",
  "daemon.status",
  "helper.status",
  "launchd.status",
  "ledger.recent",
  "mcp.smoke",
  "network.status",
  "ops.status",
  "project.inspect",
  "project.list",
  "project.next",
  "project.repair_plan",
  "project.status",
  "overnight.plan",
  "overnight.brief",
]);

const CLASS_ONE_VERBS = new Set([
  "daemon.install-user-agent",
  "logs.read",
  "overnight.enqueue",
  "overnight.run",
  "watcher.run",
  "work.queue",
]);

const CLASS_TWO_VERBS = new Set([
  "helper.invoke",
  "launchd.kickstart",
  "ops.repair_launchagent",
  "service.stop-user",
  "service.start-user",
]);

const CLASS_THREE_VERBS = new Set([
  "credential.change",
  "external.message",
  "package.install",
  "privilege.change",
  "repo.publish",
  "service.restart",
  "system.shutdown",
]);

export function parseApprovalClass(value: unknown): ApprovalClass | null {
  if (value === undefined || value === null || value === false) return null;
  const n = typeof value === "number" ? value : Number(String(value));
  if (n === 0 || n === 1 || n === 2 || n === 3) return n;
  throw new Error(`invalid approval class: ${String(value)}`);
}

export function parseTtlMs(raw: string | undefined, fallback = "15m"): number {
  const value = raw ?? fallback;
  const match = value.trim().match(/^(\d+)(s|m|h|d)?$/i);
  if (!match) {
    throw new Error(`invalid ttl "${value}"; use formats like 900s, 15m, 2h`);
  }
  const amount = Number(match[1]);
  const unit = (match[2] ?? "m").toLowerCase();
  const multiplier =
    unit === "s"
      ? 1000
      : unit === "m"
        ? 60_000
        : unit === "h"
          ? 3_600_000
          : 86_400_000;
  const ttlMs = amount * multiplier;
  if (!Number.isFinite(ttlMs) || ttlMs <= 0) {
    throw new Error(`ttl must be positive: ${value}`);
  }
  return ttlMs;
}

export function buildActionEnvelope(input: {
  actor?: string;
  source?: string;
  projectId?: string | null;
  verb: string;
  arguments?: Record<string, unknown>;
  approvalClass?: ApprovalClass | null;
  sideEffects?: string[];
  traceId?: string;
}): PolicyActionEnvelope {
  if (!input.verb) throw new Error("policy action requires a verb");
  const classified = classifyVerb(input.verb, input.approvalClass ?? null);
  return {
    actor: input.actor ?? "codex",
    source: input.source ?? "cli",
    projectId: input.projectId ?? null,
    verb: input.verb,
    arguments: input.arguments ?? {},
    approvalClass: classified.approvalClass,
    sideEffects: input.sideEffects ?? classified.sideEffects,
    traceId: input.traceId ?? `trace-${randomUUID()}`,
    requestedAt: new Date().toISOString(),
  };
}

export function classifyVerb(
  verb: string,
  explicitClass: ApprovalClass | null = null,
): { approvalClass: ApprovalClass; sideEffects: string[]; rule: string } {
  if (explicitClass !== null) {
    return {
      approvalClass: explicitClass,
      sideEffects: sideEffectsForClass(explicitClass),
      rule: "explicit_class",
    };
  }
  if (READ_ONLY_VERBS.has(verb)) {
    return { approvalClass: 0, sideEffects: [], rule: "read_only_allowlist" };
  }
  if (CLASS_ONE_VERBS.has(verb)) {
    return {
      approvalClass: 1,
      sideEffects: ["local_write"],
      rule: "class_1_allowlist",
    };
  }
  if (CLASS_TWO_VERBS.has(verb)) {
    return {
      approvalClass: 2,
      sideEffects: ["local_service"],
      rule: "class_2_approval_allowlist",
    };
  }
  if (CLASS_THREE_VERBS.has(verb)) {
    return {
      approvalClass: 3,
      sideEffects: ["privileged_or_external"],
      rule: "class_3_human_required",
    };
  }
  return {
    approvalClass: 1,
    sideEffects: ["local_write"],
    rule: "default_class_1",
  };
}

export function evaluatePolicyAction(
  action: PolicyActionEnvelope,
  options: { consumeApproval?: boolean } = {},
): PolicyEvaluation {
  const classRule = classRuleForAction(action);
  let decision: PolicyDecision;
  if (action.approvalClass === 0) {
    decision = {
      status: "allow",
      reason: "read-only action",
      approvalRequired: false,
      consumedApproval: null,
    };
  } else if (action.approvalClass === 1) {
    decision = {
      status: "allow",
      reason: "bounded local side effect allowed by personal-default policy",
      approvalRequired: false,
      consumedApproval: null,
    };
  } else if (action.approvalClass === 2) {
    const consumed =
      options.consumeApproval === true
        ? consumeApprovalToken(action.traceId, { emitDenied: false })
        : null;
    decision =
      consumed?.consumed === true
        ? {
            status: "allow",
            reason: "class-2 one-shot approval token consumed",
            approvalRequired: true,
            consumedApproval: consumed.consumption,
          }
        : {
            status: "requires_approval",
            reason: "class-2 action requires a one-shot approval token",
            approvalRequired: true,
            consumedApproval: null,
          };
  } else {
    decision = {
      status: "deny",
      reason: "class-3 privileged/external action denied by default",
      approvalRequired: true,
      consumedApproval: null,
    };
  }
  return {
    action,
    decision,
    policy: {
      policyId: POLICY_ID,
      version: POLICY_VERSION,
      classRule,
    },
  };
}

export function logPolicyEvaluation(
  kind: Extract<EventKind, "policy.simulated" | "policy.evaluated">,
  evaluation: PolicyEvaluation,
): LedgerEvent {
  return appendPolicyEvent(
    kind,
    evaluation.action.traceId,
    evaluation as unknown as Record<string, unknown>,
  );
}

export function approveTrace(input: {
  traceId: string;
  ttlMs: number;
  actor?: string;
}): ApprovalGrant {
  const now = new Date();
  const grant: ApprovalGrant = {
    tokenId: `approval-${randomUUID()}`,
    traceId: input.traceId,
    actor: input.actor ?? "codex",
    grantedAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + input.ttlMs).toISOString(),
    ttlSeconds: Math.round(input.ttlMs / 1000),
  };
  appendPolicyEvent(
    "policy.approval_granted",
    input.traceId,
    grant as unknown as Record<string, unknown>,
  );
  return grant;
}

export function denyTrace(input: {
  traceId: string;
  actor?: string;
  reason?: string;
}): ApprovalDenial {
  const denial: ApprovalDenial = {
    traceId: input.traceId,
    actor: input.actor ?? "operator",
    deniedAt: new Date().toISOString(),
    reason: input.reason ?? "operator dismissed approval request",
  };
  appendPolicyEvent(
    "policy.approval_denied",
    input.traceId,
    denial as unknown as Record<string, unknown>,
  );
  return denial;
}

export function consumeApprovalToken(
  traceId: string,
  options: { emitDenied?: boolean } = {},
):
  | { consumed: true; consumption: ApprovalConsumption }
  | { consumed: false; reason: string } {
  const nowMs = Date.now();
  const grants = approvalEvents("policy.approval_granted")
    .map((event) => grantFromEvent(event))
    .filter((grant): grant is ApprovalGrant => grant !== null)
    .filter((grant) => grant.traceId === traceId)
    .filter((grant) => Date.parse(grant.expiresAt) > nowMs);
  const consumedTokenIds = new Set(
    approvalEvents("policy.approval_consumed")
      .map((event) => event.payload.tokenId)
      .filter((tokenId): tokenId is string => typeof tokenId === "string"),
  );
  const grant = grants.find((candidate) => !consumedTokenIds.has(candidate.tokenId));
  if (!grant) {
    const reason = `no active approval token for trace ${traceId}`;
    if (options.emitDenied !== false) {
      appendPolicyEvent("policy.approval_denied", traceId, { traceId, reason });
    }
    return { consumed: false, reason };
  }
  const consumption: ApprovalConsumption = {
    tokenId: grant.tokenId,
    traceId,
    grant,
    consumedAt: new Date().toISOString(),
  };
  appendPolicyEvent(
    "policy.approval_consumed",
    traceId,
    consumption as unknown as Record<string, unknown>,
  );
  return { consumed: true, consumption };
}

function classRuleForAction(action: PolicyActionEnvelope): string {
  const inferred = classifyVerb(action.verb, null);
  return inferred.approvalClass === action.approvalClass
    ? inferred.rule
    : "explicit_class";
}

function sideEffectsForClass(approvalClass: ApprovalClass): string[] {
  if (approvalClass === 0) return [];
  if (approvalClass === 1) return ["local_write"];
  if (approvalClass === 2) return ["local_service"];
  return ["privileged_or_external"];
}

function appendPolicyEvent(
  kind: Extract<
    EventKind,
    | "policy.simulated"
    | "policy.evaluated"
    | "policy.approval_granted"
    | "policy.approval_consumed"
    | "policy.approval_denied"
  >,
  traceId: string,
  payload: Record<string, unknown>,
): LedgerEvent {
  const ledger = getLedger();
  ledger.ensureSession({
    sessionId: POLICY_SESSION_ID,
    label: "policy-core",
    tags: ["policy", "approval"],
  });
  return ledger.appendEvent({
    sessionId: POLICY_SESSION_ID,
    kind,
    actor: "policy",
    traceId,
    payload,
  });
}

function approvalEvents(kind: "policy.approval_granted" | "policy.approval_consumed"): LedgerEvent[] {
  return getLedger().findEventsByKind(kind, 1000);
}

function grantFromEvent(event: LedgerEvent): ApprovalGrant | null {
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
  };
}
