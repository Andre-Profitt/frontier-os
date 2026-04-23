// runpod:list-pods — enumerate the caller's pods with runtime + cost metadata.

import { buildResult, failedResult } from "../../../result.ts";
import type { AdapterInvocation, AdapterResult } from "../../../schemas.ts";
import { createRunpodClient, type RunpodPod } from "../client.ts";

interface ListPodsArgs {
  /** If true, include pods whose desiredStatus is not RUNNING. Default true. */
  includeStopped?: boolean;
}

export async function listPodsCommand(
  invocation: AdapterInvocation,
): Promise<AdapterResult> {
  const args = (invocation.arguments ?? {}) as ListPodsArgs;
  const includeStopped = args.includeStopped !== false;

  let client;
  try {
    client = createRunpodClient();
  } catch (err) {
    return failedResult(invocation, err);
  }

  try {
    const pods: RunpodPod[] = await client.listPods();
    const running = pods.filter((p) => p.desiredStatus === "RUNNING");
    const visible = includeStopped ? pods : running;
    const totalCostPerHr = running.reduce((acc, p) => acc + p.costPerHr, 0);

    return buildResult({
      invocation,
      status: "success",
      summary: `found ${pods.length} pod(s) (${running.length} running, $${totalCostPerHr.toFixed(4)}/hr total)`,
      observedState: {
        podCount: pods.length,
        runningCount: running.length,
        totalCostPerHr,
        pods: visible,
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
