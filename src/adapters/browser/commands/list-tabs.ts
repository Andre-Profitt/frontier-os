import { listTabs } from "../cdp.ts";
import { buildResult } from "../../../result.ts";
import type { AdapterInvocation, AdapterResult } from "../../../schemas.ts";

interface ListTabsArgs {
  host?: string;
  port?: number;
}

export async function listTabsCommand(
  invocation: AdapterInvocation,
): Promise<AdapterResult> {
  const args = (invocation.arguments ?? {}) as ListTabsArgs;
  const listOpts: { host?: string; port?: number } = {};
  if (args.host !== undefined) listOpts.host = args.host;
  if (args.port !== undefined) listOpts.port = args.port;
  const tabs = await listTabs(listOpts);
  const pages = tabs.filter((t) => t.type === "page");
  return buildResult({
    invocation,
    status: "success",
    summary: `found ${tabs.length} targets (${pages.length} pages)`,
    observedState: {
      host: args.host ?? "localhost",
      port: args.port ?? 9222,
      tabs,
    },
    verification: {
      status: "passed",
      checks: ["trace_grade"],
    },
  });
}
