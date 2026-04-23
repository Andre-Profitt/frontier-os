// Salesforce adapter entry.
//
// Composes the browser adapter's CDP transport + page-side helper and adds
// Salesforce-aware command implementations. The public contract is still
// the standard AdapterInvocation / AdapterResult shape; salesforce-specific
// shapes live only in observedState.dashboard (DashboardModel).

import type { AdapterImpl } from "../../registry.ts";
import { adapterCommandSpec } from "../../registry.ts";
import { failedResult } from "../../result.ts";
import type {
  AdapterInvocation,
  AdapterManifest,
  AdapterResult,
} from "../../schemas.ts";

import { inspectDashboardCommand } from "./commands/inspect-dashboard.ts";
import { inspectReportCommand } from "./commands/inspect-report.ts";
import { setReportFilterCommand } from "./commands/set-report-filter.ts";
import { listFiltersCommand } from "./commands/list-filters.ts";
import { auditDashboardCommand } from "./commands/audit-dashboard.ts";
import { setFilterCommand } from "./commands/set-filter.ts";
import { enterEditModeCommand } from "./commands/enter-edit-mode.ts";
import { moveWidgetCommand } from "./commands/move-widget.ts";
import { saveDashboardCommand } from "./commands/save-dashboard.ts";
import { deployReportCommand } from "./commands/deploy-report.ts";
import { portfolioInventoryCommand } from "./commands/portfolio-inventory.ts";

type CommandHandler = (invocation: AdapterInvocation) => Promise<AdapterResult>;

const HANDLERS: Record<string, CommandHandler> = {
  "inspect-dashboard": inspectDashboardCommand,
  "inspect-report": inspectReportCommand,
  "set-report-filter": setReportFilterCommand,
  "list-filters": listFiltersCommand,
  "audit-dashboard": auditDashboardCommand,
  "set-filter": setFilterCommand,
  "enter-edit-mode": enterEditModeCommand,
  "move-widget": moveWidgetCommand,
  "save-dashboard": saveDashboardCommand,
  "deploy-report": deployReportCommand,
  "portfolio-inventory": portfolioInventoryCommand,
};

export async function createSalesforceAdapter(
  manifest: AdapterManifest,
): Promise<AdapterImpl> {
  return {
    manifest,
    async invoke(invocation: AdapterInvocation): Promise<AdapterResult> {
      const spec = adapterCommandSpec(manifest, invocation.command);
      if (!spec.supportedModes.includes(invocation.mode)) {
        return failedResult(
          invocation,
          new Error(
            `command "${invocation.command}" does not support mode "${invocation.mode}"`,
          ),
        );
      }
      const handler = HANDLERS[invocation.command];
      if (!handler) {
        return failedResult(
          invocation,
          new Error(
            `salesforce adapter has no handler for command "${invocation.command}" yet`,
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
