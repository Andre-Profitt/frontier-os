// salesforce:portfolio-inventory — server-side portfolio audit with ZERO DOM
// dependency. Queries SF for the dashboard list, hits /analytics/dashboards
// per dashboard for widget -> report map, batch-SOQLs all referenced reports
// for LastRunDate, and returns the portfolio-level aggregate (shared reports
// + stale reports + per-dashboard counts) in one shot.
//
// This is the overnight-lane variant of audit-batch: no Chrome, no walker, no
// human in the loop. class 0, read-only, safe to run in Ghost Shift.
//
// Scope is intentionally narrower than audit-batch: no per-widget structural
// rules (those require the DOM walker). This command answers exactly "which
// dashboards share reports + which reports are stale" — the two aggregations
// the DOM audit can't surface efficiently.

import { buildResult, failedResult } from "../../../result.ts";
import type { AdapterInvocation, AdapterResult } from "../../../schemas.ts";
import {
  resolveSfAccess,
  enrichDashboardWithReports,
  type EnrichmentResult,
  type SfAccess,
} from "../audit/enrichment.ts";

const API_VERSION = process.env.FRONTIER_SF_API_VERSION ?? "v66.0";

interface InventoryArgs {
  targetOrg?: string;
  staleDays?: number;
  limit?: number;
  /** SOQL where-clause filter appended to the dashboard query. Optional. */
  dashboardFilter?: string;
}

interface DashboardRow {
  Id: string;
  Title: string | null;
  FolderName: string | null;
  LastModifiedDate: string | null;
}

interface DashboardInventory {
  dashboardId: string;
  dashboardTitle: string | null;
  folder: string | null;
  componentCount: number;
  reportCount: number;
  staleCount: number;
  /**
   * If enrichment failed for this dashboard, `enrichment` carries the reason;
   * the aggregation below excludes its widgets. Partial failures degrade
   * gracefully — one broken dashboard doesn't kill the nightly run.
   */
  enrichment:
    | {
        status: "ok";
        widgetCount: number;
      }
    | {
        status: "failed";
        reason: string;
        step: string;
      };
}

interface SharedReport {
  reportId: string;
  reportName: string | null;
  dashboardCount: number;
  widgetCount: number;
  lastRunDate: string | null;
  dashboards: Array<{
    dashboardId: string;
    dashboardTitle: string | null;
  }>;
}

interface StaleReport {
  reportId: string;
  reportName: string | null;
  lastRunDate: string | null;
  ageDays: number | null;
  dashboardCount: number;
  widgetCount: number;
  dashboards: Array<{
    dashboardId: string;
    dashboardTitle: string | null;
  }>;
}

export async function portfolioInventoryCommand(
  invocation: AdapterInvocation,
): Promise<AdapterResult> {
  const args = (invocation.arguments ?? {}) as InventoryArgs;
  const accessOpts: { targetOrg?: string } = {};
  if (args.targetOrg) accessOpts.targetOrg = args.targetOrg;

  const access = await resolveSfAccess(accessOpts);
  if ("error" in access) {
    return failedResult(
      invocation,
      new Error(`portfolio-inventory: ${access.error}`),
    );
  }

  const limit =
    typeof args.limit === "number" && args.limit > 0 ? args.limit : 50;
  const staleDays =
    typeof args.staleDays === "number" && args.staleDays > 0
      ? args.staleDays
      : 30;
  const extraWhere =
    typeof args.dashboardFilter === "string" && args.dashboardFilter.trim()
      ? ` AND ${args.dashboardFilter.trim()}`
      : "";

  // 1. List dashboards in-scope. Default: non-deleted + touched by the
  // authenticated user (matches the ad-hoc SOQL used by the audit-batch flow).
  const userFilter = access.username
    ? `(CreatedBy.Username='${access.username}' OR LastModifiedBy.Username='${access.username}')`
    : "CreatedDate >= LAST_N_DAYS:180";
  const soql = `SELECT Id, Title, FolderName, LastModifiedDate FROM Dashboard WHERE IsDeleted=FALSE AND ${userFilter}${extraWhere} ORDER BY LastModifiedDate DESC LIMIT ${limit}`;

  const dashListResp = await fetch(
    `${access.instanceUrl}/services/data/${API_VERSION}/query?q=${encodeURIComponent(soql)}`,
    {
      headers: {
        Authorization: `Bearer ${access.accessToken}`,
        Accept: "application/json",
      },
    },
  );
  if (!dashListResp.ok) {
    const body = await dashListResp.text();
    return failedResult(
      invocation,
      new Error(
        `portfolio-inventory: Dashboard SOQL returned HTTP ${dashListResp.status}: ${body.slice(0, 400)}`,
      ),
    );
  }
  const dashListJson = (await dashListResp.json()) as {
    records?: DashboardRow[];
  };
  const dashboards = dashListJson.records ?? [];

  // 2. Enrich each dashboard. Reuse the same enrichment helper the DOM audit
  // uses — identical /describe + /query pattern, identical widget->report
  // shape. Serial rather than parallel to stay under SF concurrent-call
  // governor limits.
  const perDashboard: DashboardInventory[] = [];
  interface AggRow {
    reportId: string;
    reportName: string | null;
    lastRunDate: string | null;
    dashboards: Map<
      string,
      {
        dashboardTitle: string | null;
        widgetCount: number;
      }
    >;
  }
  const reportIndex = new Map<string, AggRow>();

  for (const dash of dashboards) {
    const result = await enrichDashboardWithReports({
      access,
      dashboardId: dash.Id,
    });
    const widgetReportsMap: EnrichmentResult = result;
    if (!widgetReportsMap.ok) {
      const failedInfo = widgetReportsMap as Extract<
        EnrichmentResult,
        { ok: false }
      >;
      perDashboard.push({
        dashboardId: dash.Id,
        dashboardTitle: dash.Title,
        folder: dash.FolderName,
        componentCount: 0,
        reportCount: 0,
        staleCount: 0,
        enrichment: {
          status: "failed",
          reason: failedInfo.reason,
          step:
            "step" in failedInfo
              ? failedInfo.step
              : "skipped" in failedInfo
                ? "skipped"
                : "?",
        },
      });
      continue;
    }

    let staleForThisDash = 0;
    const now = Date.now();
    const thresholdMs = staleDays * 24 * 3600 * 1000;
    const widgetReports = widgetReportsMap.widgetReports;
    const widgetCount = Object.keys(widgetReports).length;

    for (const [, wr] of Object.entries(widgetReports)) {
      const reportId = wr.reportId;
      if (!reportId) continue;
      const lastRun = wr.lastRunDate;
      const lastRunMs = lastRun ? Date.parse(lastRun) : NaN;
      if (
        !lastRun ||
        (Number.isFinite(lastRunMs) && now - lastRunMs > thresholdMs)
      ) {
        staleForThisDash++;
      }

      let agg = reportIndex.get(reportId);
      if (!agg) {
        agg = {
          reportId,
          reportName: wr.reportName ?? null,
          lastRunDate: lastRun,
          dashboards: new Map(),
        };
        reportIndex.set(reportId, agg);
      }
      if (!agg.reportName && wr.reportName) agg.reportName = wr.reportName;
      if (lastRun && (!agg.lastRunDate || lastRun > agg.lastRunDate)) {
        agg.lastRunDate = lastRun;
      }
      const bucket = agg.dashboards.get(dash.Id);
      if (bucket) {
        bucket.widgetCount++;
      } else {
        agg.dashboards.set(dash.Id, {
          dashboardTitle: dash.Title,
          widgetCount: 1,
        });
      }
    }

    perDashboard.push({
      dashboardId: dash.Id,
      dashboardTitle: dash.Title,
      folder: dash.FolderName,
      componentCount: widgetReportsMap.componentCount,
      reportCount: widgetReportsMap.reportCount,
      staleCount: staleForThisDash,
      enrichment: {
        status: "ok",
        widgetCount,
      },
    });
  }

  // 3. Derive shared + stale lists from the global index.
  const sharedReports: SharedReport[] = [];
  const staleReports: StaleReport[] = [];
  const now = Date.now();
  const thresholdMs = staleDays * 24 * 3600 * 1000;
  for (const agg of reportIndex.values()) {
    const dashArr = [...agg.dashboards.entries()].map(([id, v]) => ({
      dashboardId: id,
      dashboardTitle: v.dashboardTitle,
      widgetCount: v.widgetCount,
    }));
    const widgetCount = dashArr.reduce((n, d) => n + d.widgetCount, 0);
    if (dashArr.length >= 2) {
      sharedReports.push({
        reportId: agg.reportId,
        reportName: agg.reportName,
        dashboardCount: dashArr.length,
        widgetCount,
        lastRunDate: agg.lastRunDate,
        dashboards: dashArr.map((d) => ({
          dashboardId: d.dashboardId,
          dashboardTitle: d.dashboardTitle,
        })),
      });
    }
    const lastRunMs = agg.lastRunDate ? Date.parse(agg.lastRunDate) : NaN;
    const isStale =
      !agg.lastRunDate ||
      (Number.isFinite(lastRunMs) && now - lastRunMs > thresholdMs);
    if (isStale) {
      const ageDays =
        agg.lastRunDate && Number.isFinite(lastRunMs)
          ? Math.floor((now - lastRunMs) / (24 * 3600 * 1000))
          : null;
      staleReports.push({
        reportId: agg.reportId,
        reportName: agg.reportName,
        lastRunDate: agg.lastRunDate,
        ageDays,
        dashboardCount: dashArr.length,
        widgetCount,
        dashboards: dashArr.map((d) => ({
          dashboardId: d.dashboardId,
          dashboardTitle: d.dashboardTitle,
        })),
      });
    }
  }
  sharedReports.sort(
    (a, b) =>
      b.dashboardCount - a.dashboardCount || b.widgetCount - a.widgetCount,
  );
  staleReports.sort((a, b) => {
    if (a.lastRunDate === null && b.lastRunDate !== null) return -1;
    if (b.lastRunDate === null && a.lastRunDate !== null) return 1;
    if (a.lastRunDate === null && b.lastRunDate === null) return 0;
    return (a.lastRunDate as string).localeCompare(b.lastRunDate as string);
  });

  const okCount = perDashboard.filter(
    (d) => d.enrichment.status === "ok",
  ).length;
  const reportTotal = reportIndex.size;

  return buildResult({
    invocation,
    status: "success",
    summary: `portfolio-inventory: ${perDashboard.length} dashboards (${okCount} enriched), ${reportTotal} distinct reports (${sharedReports.length} shared, ${staleReports.length} stale @ >${staleDays}d)`,
    observedState: {
      mode: invocation.mode,
      accessSource: access.source,
      instanceUrl: access.instanceUrl,
      username: access.username ?? null,
      filter: {
        limit,
        staleDays,
        userFilter,
        extraWhere: extraWhere || null,
      },
      dashboardCount: perDashboard.length,
      enrichedCount: okCount,
      reportCount: reportTotal,
      sharedReportCount: sharedReports.length,
      staleReportCount: staleReports.length,
      dashboards: perDashboard,
      sharedReports: sharedReports.slice(0, 40),
      staleReports,
    },
    artifacts: [],
    sideEffects: [],
    verification: {
      status: "passed",
      checks: ["trace_grade"],
    },
  });
}

interface SfAccessCheck {
  access: SfAccess | null;
  error: string | null;
}
// Unused helper retained for interface documentation; the command calls
// resolveSfAccess directly above.
export function _accessCheckShape(): SfAccessCheck {
  return { access: null, error: null };
}
