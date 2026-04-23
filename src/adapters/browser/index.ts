// Browser adapter entry: dispatches invocations to command implementations.
// Each command owns its own file and returns a well-formed AdapterResult.

import type { AdapterImpl } from "../../registry.ts";
import { adapterCommandSpec } from "../../registry.ts";
import { failedResult } from "../../result.ts";
import type {
  AdapterInvocation,
  AdapterManifest,
  AdapterResult,
} from "../../schemas.ts";

import { listTabsCommand } from "./commands/list-tabs.ts";
import { currentTabCommand } from "./commands/current-tab.ts";
import { captureScreenshotCommand } from "./commands/capture-screenshot.ts";
import { runScriptCommand } from "./commands/run-script.ts";
import { inspectDomCommand } from "./commands/inspect-dom.ts";
import { clickElementCommand } from "./commands/click-element.ts";
import { inspectNetworkCommand } from "./commands/inspect-network.ts";
import { enterTextCommand } from "./commands/enter-text.ts";
import { navigateCommand } from "./commands/navigate.ts";
import { selectOptionCommand } from "./commands/select-option.ts";

type CommandHandler = (invocation: AdapterInvocation) => Promise<AdapterResult>;

const HANDLERS: Record<string, CommandHandler> = {
  "list-tabs": listTabsCommand,
  "current-tab": currentTabCommand,
  "capture-screenshot": captureScreenshotCommand,
  "run-script": runScriptCommand,
  "inspect-dom": inspectDomCommand,
  "inspect-network": inspectNetworkCommand,
  "click-element": clickElementCommand,
  "enter-text": enterTextCommand,
  "select-option": selectOptionCommand,
  navigate: navigateCommand,
};

export async function createBrowserAdapter(
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
            `browser adapter has no handler for command "${invocation.command}" yet`,
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
