import { attach, evaluate, type CdpAttachOptions } from "../../browser/cdp.ts";
import { DASHBOARD_WALKER_SRC, type DashboardModel } from "../lightning.ts";
import { buildResult } from "../../../result.ts";
import type { AdapterInvocation, AdapterResult } from "../../../schemas.ts";

interface InspectDashboardArgs extends CdpAttachOptions {
  /** Match the tab by URL substring when multiple tabs are open. */
  urlHint?: string;
}

const DEFAULT_URL_MATCH = /salesforce|lightning|force\.com/i;

export async function inspectDashboardCommand(
  invocation: AdapterInvocation,
): Promise<AdapterResult> {
  const args = (invocation.arguments ?? {}) as InspectDashboardArgs;

  const attachOpts: CdpAttachOptions = {};
  if (args.host !== undefined) attachOpts.host = args.host;
  if (args.port !== undefined) attachOpts.port = args.port;
  if (args.target !== undefined) attachOpts.target = args.target;
  // If no explicit target was given, prefer a tab that looks like Salesforce.
  // Fall back to the first non-chrome page if no match.
  if (args.target === undefined) {
    if (args.urlHint) {
      const hint = args.urlHint;
      attachOpts.matchUrl = (url: string) => url.includes(hint);
    } else {
      attachOpts.matchUrl = (url: string) => DEFAULT_URL_MATCH.test(url);
    }
  }
  attachOpts.installHelper = true;

  let session;
  try {
    session = await attach(attachOpts);
  } catch (firstErr) {
    // If the SF-hint fallback picked nothing, retry without the matcher so
    // the user can at least run inspect-dashboard against whatever tab is
    // open (useful for synthetic smoke tests against example.com).
    if (args.target === undefined && !args.urlHint) {
      delete attachOpts.matchUrl;
      session = await attach(attachOpts);
    } else {
      throw firstErr;
    }
  }

  try {
    // The walker is an async IIFE that returns a DashboardModel.
    const model = await evaluate<DashboardModel>(session, {
      expression: DASHBOARD_WALKER_SRC,
      awaitPromise: true,
      returnByValue: true,
      timeout: 15000,
    });

    const summary = model.detected
      ? `inspected ${model.kind} dashboard "${model.title ?? "(untitled)"}" — ` +
        `${model.widgetCount} widgets, ${model.filterCount} filters` +
        (model.pageErrors.length > 0
          ? `, ${model.pageErrors.length} page errors`
          : "")
      : `no dashboard detected at ${session.target.url}: ${model.reason ?? "unknown"}`;

    const artifacts: AdapterResult["artifacts"] = [
      {
        kind: "url",
        ref: session.target.url,
        note: `${model.kind} dashboard page`,
      },
    ];

    return buildResult({
      invocation,
      status: model.detected ? "success" : "partial",
      summary,
      observedState: {
        targetId: session.target.id,
        helperInstalled: session.helperInstalled,
        dashboard: model,
      },
      artifacts,
      verification: {
        status: model.detected ? "passed" : "not_run",
        checks: model.detected ? ["artifact_schema", "trace_grade"] : [],
      },
      suggestedNextActions: model.detected
        ? [
            ...(model.widgets.some((w) => w.loading)
              ? ["re-run after widgets finish loading"]
              : []),
            ...(model.pageErrors.length > 0 ? ["investigate page errors"] : []),
            ...(model.filterCount === 0
              ? ["confirm filters are expected"]
              : []),
          ]
        : [
            "open a Salesforce dashboard tab and retry",
            "or pass { urlHint: '...' } to target a specific tab",
          ],
    });
  } finally {
    await session.close();
  }
}
