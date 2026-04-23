// runpod:pod-status — fetch a single pod by id.

import { buildResult, failedResult } from "../../../result.ts";
import type { AdapterInvocation, AdapterResult } from "../../../schemas.ts";
import { createRunpodClient } from "../client.ts";

interface PodStatusArgs {
  podId?: string;
}

export async function podStatusCommand(
  invocation: AdapterInvocation,
): Promise<AdapterResult> {
  const args = (invocation.arguments ?? {}) as PodStatusArgs;
  if (typeof args.podId !== "string" || args.podId.trim() === "") {
    return failedResult(
      invocation,
      new Error("pod-status requires `arguments.podId` (non-empty string)"),
    );
  }

  let client;
  try {
    client = createRunpodClient();
  } catch (err) {
    return failedResult(invocation, err);
  }

  try {
    const pod = await client.podStatus(args.podId);
    if (!pod) {
      return buildResult({
        invocation,
        status: "partial",
        summary: `pod ${args.podId} not found in account listing`,
        observedState: {
          podId: args.podId,
          found: false,
        },
        verification: {
          status: "passed",
          checks: ["trace_grade"],
        },
      });
    }

    return buildResult({
      invocation,
      status: "success",
      summary: `pod ${pod.id} "${pod.name ?? "(unnamed)"}" status=${pod.desiredStatus} $${pod.costPerHr}/hr`,
      observedState: {
        podId: pod.id,
        found: true,
        pod,
      },
      verification: {
        status: "passed",
        checks: ["trace_grade"],
      },
    });
  } catch (err) {
    return failedResult(invocation, err);
  }
}
