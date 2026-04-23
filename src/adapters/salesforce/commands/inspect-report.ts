import { attach, evaluate, type CdpAttachOptions } from "../../browser/cdp.ts";
import { REPORT_WALKER_SRC, type ReportModel } from "../lightning.ts";
import { buildResult } from "../../../result.ts";
import type { AdapterInvocation, AdapterResult } from "../../../schemas.ts";

interface InspectReportArgs extends CdpAttachOptions {
  /** Match the tab by URL substring when multiple tabs are open. */
  urlHint?: string;
}

const DEFAULT_URL_MATCH = /Report|salesforce|lightning|force\\.com/i;

export async function inspectReportCommand(
  invocation: AdapterInvocation,
): Promise<AdapterResult> {
  const args = (invocation.arguments ?? {}) as InspectReportArgs;

  const attachOpts: CdpAttachOptions = {};
  if (args.host !== undefined) attachOpts.host = args.host;
  if (args.port !== undefined) attachOpts.port = args.port;
  if (args.target !== undefined) attachOpts.target = args.target;
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
    if (args.target === undefined && !args.urlHint) {
      delete attachOpts.matchUrl;
      session = await attach(attachOpts);
    } else {
      throw firstErr;
    }
  }

  try {
    const model = await evaluate<ReportModel>(session, {
      expression: REPORT_WALKER_SRC,
      awaitPromise: true,
      returnByValue: true,
      timeout: 15000,
    });

    const summary = model.detected
      ? `inspected report "${model.title ?? "(untitled)"}" — ` +
        `${model.filterCount} filters, ${model.actionCount} actions` +
        (model.chartVisible === null
          ? ""
          : model.chartVisible
            ? ", chart visible"
            : ", chart hidden") +
        (model.pageErrors.length > 0
          ? `, ${model.pageErrors.length} page errors`
          : "")
      : `no report detected at ${session.target.url}: ${model.reason ?? "unknown"}`;

    const artifacts: AdapterResult["artifacts"] = [
      {
        kind: "url",
        ref: session.target.url,
        note: `${model.kind} report page`,
      },
    ];

    return buildResult({
      invocation,
      status: model.detected ? "success" : "partial",
      summary,
      observedState: {
        targetId: session.target.id,
        helperInstalled: session.helperInstalled,
        report: model,
      },
      artifacts,
      verification: {
        status: model.detected ? "passed" : "not_run",
        checks: model.detected ? ["artifact_schema", "trace_grade"] : [],
      },
      suggestedNextActions: model.detected
        ? [
            ...(model.loading ? ["re-run after report finishes loading"] : []),
            ...(model.pageErrors.length > 0 ? ["investigate page errors"] : []),
            ...(model.filterCount === 0 ? ["confirm filters are expected"] : []),
          ]
        : [
            "open a Salesforce Lightning report tab and retry",
            "or pass { urlHint: '...' } to target a specific tab",
          ],
    });
  } finally {
    await session.close();
  }
}
