// RunPod adapter entry: dispatches invocations to command implementations.
// Mirrors the shape of src/adapters/browser/index.ts.
//
// Credential handling: commands construct their own RunpodClient and catch
// the RunpodMissingCredentialsError → failedResult path. That keeps the
// "no RUNPOD_API_KEY set" diagnostic visible at invoke-time without blowing
// up manifest loading or the dispatcher itself.

import type { AdapterImpl } from "../../registry.ts";
import { adapterCommandSpec } from "../../registry.ts";
import { failedResult } from "../../result.ts";
import type {
  AdapterInvocation,
  AdapterManifest,
  AdapterResult,
} from "../../schemas.ts";

import { listPodsCommand } from "./commands/list-pods.ts";
import { podStatusCommand } from "./commands/pod-status.ts";
import { stopPodCommand } from "./commands/stop-pod.ts";
import { costSummaryCommand } from "./commands/cost-summary.ts";

type CommandHandler = (invocation: AdapterInvocation) => Promise<AdapterResult>;

const HANDLERS: Record<string, CommandHandler> = {
  "list-pods": listPodsCommand,
  "pod-status": podStatusCommand,
  "stop-pod": stopPodCommand,
  "cost-summary": costSummaryCommand,
};

export async function createRunpodAdapter(
  manifest: AdapterManifest,
): Promise<AdapterImpl> {
  return {
    manifest,
    async invoke(invocation: AdapterInvocation): Promise<AdapterResult> {
      // 1. Manifest sanity — command must be declared.
      const spec = adapterCommandSpec(manifest, invocation.command);
      // 2. Mode must be supported.
      if (!spec.supportedModes.includes(invocation.mode)) {
        return failedResult(
          invocation,
          new Error(
            `command "${invocation.command}" does not support mode "${invocation.mode}"`,
          ),
        );
      }
      // 3. Implementation exists.
      const handler = HANDLERS[invocation.command];
      if (!handler) {
        return failedResult(
          invocation,
          new Error(
            `runpod adapter has no handler for command "${invocation.command}" yet`,
          ),
        );
      }
      try {
        return await handler(invocation);
      } catch (err) {
        return failedResult(invocation, err);
      }
    },
  };
}
