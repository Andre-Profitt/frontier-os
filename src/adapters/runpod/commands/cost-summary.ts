// runpod:cost-summary — aggregate hourly cost and running-pod count.

import { buildResult, failedResult } from "../../../result.ts";
import type { AdapterInvocation, AdapterResult } from "../../../schemas.ts";
import { createRunpodClient } from "../client.ts";

interface CostBreakdownEntry {
  podId: string;
  name: string | null;
  desiredStatus: string;
  costPerHr: number;
  podType: string | null;
}

export async function costSummaryCommand(
  invocation: AdapterInvocation,
): Promise<AdapterResult> {
  let client;
  try {
    client = createRunpodClient();
  } catch (err) {
    return failedResult(invocation, err);
  }

  try {
    const pods = await client.listPods();
    const running = pods.filter((p) => p.desiredStatus === "RUNNING");
    const stopped = pods.filter((p) => p.desiredStatus !== "RUNNING");

    const totalCostPerHr = running.reduce((acc, p) => acc + p.costPerHr, 0);
    const projectedDailyCost = totalCostPerHr * 24;
    const projectedMonthlyCost = totalCostPerHr * 24 * 30;

    const breakdown: CostBreakdownEntry[] = running
      .map((p) => ({
        podId: p.id,
        name: p.name,
        desiredStatus: p.desiredStatus,
        costPerHr: p.costPerHr,
        podType: p.podType,
      }))
      .sort((a, b) => b.costPerHr - a.costPerHr);

    return buildResult({
      invocation,
      status: "success",
      summary: `${running.length} running / ${stopped.length} stopped, $${totalCostPerHr.toFixed(4)}/hr ($${projectedDailyCost.toFixed(2)}/day, $${projectedMonthlyCost.toFixed(2)}/mo)`,
      observedState: {
        runningCount: running.length,
        stoppedCount: stopped.length,
        totalCostPerHr,
        projectedDailyCost,
        projectedMonthlyCost,
        breakdown,
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
