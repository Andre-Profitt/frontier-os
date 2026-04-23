// runpod:stop-pod — stop a running pod (preserves state; billable side effect).
//
// Modes:
//   - propose: describe the stop-pod action without touching the API.
//   - apply:   actually issue the podStop mutation.
//   - undo:    NOT supported — starting a pod again requires a different
//              mutation, different GPU availability, and is not symmetric
//              with a stop. We reject undo explicitly so the caller has to
//              intentionally start a fresh pod rather than rely on undo.

import { buildResult, failedResult } from "../../../result.ts";
import type { AdapterInvocation, AdapterResult } from "../../../schemas.ts";
import { createRunpodClient } from "../client.ts";

interface StopPodArgs {
  podId?: string;
}

export async function stopPodCommand(
  invocation: AdapterInvocation,
): Promise<AdapterResult> {
  const args = (invocation.arguments ?? {}) as StopPodArgs;
  if (typeof args.podId !== "string" || args.podId.trim() === "") {
    return failedResult(
      invocation,
      new Error("stop-pod requires `arguments.podId` (non-empty string)"),
    );
  }

  if (invocation.mode === "undo") {
    return failedResult(
      invocation,
      new Error(
        "stop-pod does not support undo — restart the pod explicitly via the RunPod console",
      ),
    );
  }

  if (invocation.mode === "propose") {
    return buildResult({
      invocation,
      status: "success",
      summary: `propose: stop pod ${args.podId} (billable_action, preserves volume)`,
      observedState: {
        podId: args.podId,
        action: "stop-pod",
        mode: "propose",
      },
      sideEffects: [
        {
          class: "billable_action",
          target: `runpod://pod/${args.podId}`,
          summary: `would stop running pod ${args.podId} (preserves volume, halts billing)`,
        },
      ],
      verification: {
        status: "passed",
        checks: ["policy", "trace_grade"],
      },
    });
  }

  // mode === "apply"
  let client;
  try {
    client = createRunpodClient();
  } catch (err) {
    return failedResult(invocation, err);
  }

  try {
    const before = await client.podStatus(args.podId);
    if (!before) {
      return failedResult(
        invocation,
        new Error(`pod ${args.podId} not found in account listing`),
      );
    }

    const result = await client.stopPod(args.podId);
    const after = await client.podStatus(args.podId);

    const nowStopped =
      result.desiredStatus !== "RUNNING" ||
      (after?.desiredStatus !== undefined && after.desiredStatus !== "RUNNING");

    return buildResult({
      invocation,
      status: nowStopped ? "success" : "partial",
      summary: nowStopped
        ? `stopped pod ${args.podId} (was ${before.desiredStatus}, now ${result.desiredStatus})`
        : `podStop returned but pod ${args.podId} still reports desiredStatus=${result.desiredStatus}`,
      observedState: {
        podId: args.podId,
        before: {
          desiredStatus: before.desiredStatus,
          costPerHr: before.costPerHr,
        },
        stopResult: result,
        after: after
          ? {
              desiredStatus: after.desiredStatus,
              costPerHr: after.costPerHr,
            }
          : null,
      },
      sideEffects: [
        {
          class: "billable_action",
          target: `runpod://pod/${args.podId}`,
          summary: `stopped pod ${args.podId} — halts hourly billing, preserves volume state`,
        },
      ],
      verification: {
        status: nowStopped ? "passed" : "failed",
        checks: ["policy", "trace_grade"],
      },
    });
  } catch (err) {
    return failedResult(invocation, err);
  }
}
