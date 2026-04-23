import { attach, evaluate, type CdpAttachOptions } from "../../browser/cdp.ts";
import { DASHBOARD_WALKER_SRC, type DashboardModel } from "../lightning.ts";
import { runAudit, gradeLine } from "../audit/index.ts";
import {
  dashboardIdFromPath,
  enrichDashboardWithReports,
  resolveSfAccess,
  type EnrichmentResult,
} from "../audit/enrichment.ts";
import { buildResult } from "../../../result.ts";
import type { AdapterInvocation, AdapterResult } from "../../../schemas.ts";

interface AuditDashboardArgs extends CdpAttachOptions {
  urlHint?: string;
  /**
   * When present, resolve an SF access token via `sf org display --target-org
   * <alias>` for server-side enrichment (report freshness). Falls back to
   * env SF_INSTANCE_URL + SF_ACCESS_TOKEN.
   */
  targetOrg?: string;
  /** Disable enrichment entirely — useful for DOM-only offline runs. */
  skipEnrichment?: boolean;
  /**
   * Override the report-stale rule threshold (days). Default 30. Lower values
   * make the audit stricter; useful for smoke-testing or for dashboards with
   * near-real-time refresh expectations.
   */
  reportStaleDays?: number;
}

const DEFAULT_URL_MATCH = /salesforce|lightning|force\.com/i;

export async function auditDashboardCommand(
  invocation: AdapterInvocation,
): Promise<AdapterResult> {
  const args = (invocation.arguments ?? {}) as AuditDashboardArgs;

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
    const model = await evaluate<DashboardModel>(session, {
      expression: DASHBOARD_WALKER_SRC,
      awaitPromise: true,
      returnByValue: true,
      timeout: 15000,
    });

    if (!model.detected) {
      return buildResult({
        invocation,
        status: "partial",
        summary: `no dashboard detected at ${session.target.url}: ${model.reason ?? "unknown"}`,
        observedState: {
          targetId: session.target.id,
          helperInstalled: session.helperInstalled,
          dashboard: model,
        },
        artifacts: [
          {
            kind: "url",
            ref: session.target.url,
            note: `${model.kind} page (no dashboard)`,
          },
        ],
        verification: { status: "not_run", checks: [] },
        suggestedNextActions: [
          "open a Salesforce dashboard tab and retry",
          "or pass { urlHint: '...' } to target a specific tab",
        ],
      });
    }

    // Enrich model with per-widget report freshness when possible. Any
    // failure (no token, API HTTP error, non-Dashboard URL) degrades
    // gracefully — rules that depend on `widgetReports` simply emit nothing
    // and we surface the skip reason as an INFO finding below.
    let enrichment: EnrichmentResult | null = null;
    let enrichmentNote: string | null = null;
    if (args.skipEnrichment === true) {
      enrichmentNote = "enrichment skipped via arguments.skipEnrichment=true";
    } else {
      const dashboardId = dashboardIdFromPath(model.path);
      if (!dashboardId) {
        enrichmentNote = `could not parse dashboard id from path ${model.path}`;
      } else {
        const accessOpts: { targetOrg?: string } = {};
        if (args.targetOrg) accessOpts.targetOrg = args.targetOrg;
        const access = await resolveSfAccess(accessOpts);
        if ("error" in access) {
          enrichmentNote = `enrichment skipped: ${access.error}`;
        } else {
          enrichment = await enrichDashboardWithReports({
            access,
            dashboardId,
          });
          if (enrichment.ok) {
            model.widgetReports = enrichment.widgetReports;
          } else if ("skipped" in enrichment && enrichment.skipped) {
            enrichmentNote = `enrichment skipped: ${enrichment.reason}`;
          } else {
            enrichmentNote = `enrichment failed at ${enrichment.step}: ${enrichment.reason}`;
          }
        }
      }
    }

    if (typeof args.reportStaleDays === "number" && args.reportStaleDays > 0) {
      model.reportStaleDays = args.reportStaleDays;
    }

    const audit = runAudit(model);
    const grade = audit.grade;
    const line = gradeLine(grade);

    // Propose mode is read + any suggested fixes surfaced at the top level.
    const isPropose = invocation.mode === "propose";

    const suggestedNextActions: string[] = [];
    if (audit.topFindings.length > 0) {
      for (const f of audit.topFindings) {
        if (f.suggestedFix) {
          suggestedNextActions.push(
            `[${f.severity}] ${f.title} → ${f.suggestedFix}`,
          );
        } else {
          suggestedNextActions.push(`[${f.severity}] ${f.title}`);
        }
      }
    } else {
      suggestedNextActions.push("no findings — dashboard is clean");
    }

    const summary = `audited ${model.kind} dashboard "${model.title ?? "(untitled)"}": ${line}`;

    return buildResult({
      invocation,
      status: "success",
      summary,
      observedState: {
        targetId: session.target.id,
        helperInstalled: session.helperInstalled,
        mode: invocation.mode,
        dashboard: model,
        audit: {
          grade,
          gradeLine: line,
          findings: audit.findings,
          topFindings: audit.topFindings,
        },
        enrichment: enrichment
          ? enrichment.ok
            ? {
                status: "ok",
                accessSource: enrichment.accessSource,
                dashboardId: enrichment.dashboardId,
                componentCount: enrichment.componentCount,
                reportCount: enrichment.reportCount,
                widgetCount: Object.keys(enrichment.widgetReports).length,
              }
            : {
                status: "failed",
                step: (enrichment as { step: string }).step,
                reason: enrichment.reason,
              }
          : { status: "skipped", reason: enrichmentNote },
        ...(isPropose
          ? {
              proposal: {
                fixes: audit.findings
                  .filter((f) => f.suggestedFix)
                  .map((f) => ({
                    ruleId: f.ruleId,
                    severity: f.severity,
                    title: f.title,
                    suggestedFix: f.suggestedFix!,
                    ...(f.widgetId !== undefined
                      ? { widgetId: f.widgetId }
                      : {}),
                  })),
              },
            }
          : {}),
      },
      artifacts: [
        {
          kind: "url",
          ref: session.target.url,
          note: `audit of ${model.kind} dashboard ${model.title ?? model.path}`,
        },
      ],
      verification: {
        status: "passed",
        checks: ["artifact_schema", "trace_grade"],
      },
      suggestedNextActions,
    });
  } finally {
    await session.close();
  }
}
