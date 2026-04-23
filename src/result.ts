// Helpers for constructing well-formed AdapterResult objects.

import type {
  AdapterArtifact,
  AdapterInvocation,
  AdapterResult,
  AdapterSideEffect,
  AdapterStatus,
} from "./schemas.ts";

export interface ResultBuilderInit {
  invocation: Pick<AdapterInvocation, "invocationId" | "adapterId" | "command">;
  status: AdapterStatus;
  summary?: string;
  observedState?: Record<string, unknown>;
  artifacts?: AdapterArtifact[];
  sideEffects?: AdapterSideEffect[];
  verification?: AdapterResult["verification"];
  alerts?: string[];
  suggestedNextActions?: string[];
}

export function buildResult(init: ResultBuilderInit): AdapterResult {
  const result: AdapterResult = {
    invocationId: init.invocation.invocationId,
    adapterId: init.invocation.adapterId,
    command: init.invocation.command,
    status: init.status,
    finishedAt: new Date().toISOString(),
  };
  if (init.summary !== undefined) result.summary = init.summary;
  if (init.observedState !== undefined)
    result.observedState = init.observedState;
  if (init.artifacts !== undefined) result.artifacts = init.artifacts;
  if (init.sideEffects !== undefined) result.sideEffects = init.sideEffects;
  if (init.verification !== undefined) result.verification = init.verification;
  if (init.alerts !== undefined) result.alerts = init.alerts;
  if (init.suggestedNextActions !== undefined)
    result.suggestedNextActions = init.suggestedNextActions;
  return result;
}

export function failedResult(
  invocation: Pick<AdapterInvocation, "invocationId" | "adapterId" | "command">,
  error: unknown,
  extra: Partial<ResultBuilderInit> = {},
): AdapterResult {
  const message = error instanceof Error ? error.message : String(error);
  return buildResult({
    invocation,
    status: "failed",
    summary: message,
    ...extra,
  });
}

export function newInvocationId(): string {
  const t = Date.now().toString(36);
  const r = Math.random().toString(36).slice(2, 10);
  return `inv_${t}_${r}`;
}
