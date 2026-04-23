import { randomUUID } from "node:crypto";

import type { ApprovalClass } from "../policy/evaluator.ts";

export type CommandSurfaceChannel =
  | "cli"
  | "siri_shortcut"
  | "apple_app_intent"
  | "mobile_app"
  | "menu_bar"
  | "web"
  | "api"
  | "automation";

export type CommandActorType = "human" | "agent" | "service" | "device";

export type CommandRequestedOutput =
  | "spoken"
  | "state"
  | "artifact"
  | "decision"
  | "patch"
  | "summary"
  | "approval";

export interface CommandEnvelope {
  commandId: string;
  version: "v1";
  intent: string;
  requestedAt: string;
  traceId: string;
  correlationId?: string;
  projectId?: string;
  actor: {
    actorId: string;
    actorType: CommandActorType;
    tenantId?: string;
  };
  surface: {
    channel: CommandSurfaceChannel;
    origin: string;
    deviceId?: string;
  };
  approvalClass?: ApprovalClass;
  payload: Record<string, unknown>;
  requestedOutputs?: CommandRequestedOutput[];
  policy?: {
    allowSideEffects?: boolean;
    requireVerification?: boolean;
    maxRuntimeSeconds?: number;
    maxRetries?: number;
    retryBackoffMs?: number;
  };
}

export interface BuildCommandEnvelopeInput {
  intent: string;
  projectId?: string | null;
  actorId?: string;
  actorType?: CommandActorType;
  surface?: CommandSurfaceChannel;
  origin?: string;
  traceId?: string;
  correlationId?: string;
  approvalClass?: ApprovalClass | null;
  payload?: Record<string, unknown>;
  requestedOutputs?: CommandRequestedOutput[];
  policy?: CommandEnvelope["policy"];
}

export function newCommandId(): string {
  return `cmd_${Date.now().toString(36)}_${randomUUID().slice(0, 8)}`;
}

export function newTraceId(): string {
  return `trace-${randomUUID()}`;
}

export function normalizeIntent(intent: string): string {
  const normalized = intent.trim().replace(/\s+/g, " ");
  if (!normalized) throw new Error("command intent is required");
  return normalized;
}

export function buildCommandEnvelope(
  input: BuildCommandEnvelopeInput,
): CommandEnvelope {
  const intent = normalizeIntent(input.intent);
  const commandId = newCommandId();
  const payload = {
    ...(input.payload ?? {}),
    intent,
    ...(input.projectId ? { projectId: input.projectId } : {}),
  };
  const envelope: CommandEnvelope = {
    commandId,
    version: "v1",
    intent,
    requestedAt: new Date().toISOString(),
    traceId: input.traceId ?? newTraceId(),
    actor: {
      actorId: input.actorId ?? "codex",
      actorType: input.actorType ?? "agent",
    },
    surface: {
      channel: input.surface ?? "cli",
      origin: input.origin ?? "frontier-cli",
    },
    payload,
  };
  if (input.correlationId) envelope.correlationId = input.correlationId;
  if (input.projectId) envelope.projectId = input.projectId;
  if (input.approvalClass !== undefined && input.approvalClass !== null) {
    envelope.approvalClass = input.approvalClass;
  }
  if (input.requestedOutputs !== undefined) {
    envelope.requestedOutputs = input.requestedOutputs;
  }
  if (input.policy !== undefined) {
    envelope.policy = input.policy;
  }
  return envelope;
}
