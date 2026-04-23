// Audit-dashboard enrichment: augments the DOM-walker DashboardModel with
// per-widget underlying-report freshness data via the Salesforce REST APIs.
//
// The walker alone cannot tell you if the data a widget is showing is stale —
// it only sees the rendered DOM. To answer that we need two server-side calls:
//
//   1. GET /services/data/v66.0/analytics/dashboards/<dashboardId>/describe
//      → returns all dashboard components, each carrying a reportId.
//
//   2. SOQL: SELECT Id, Name, LastRunDate, LastModifiedDate FROM Report
//      WHERE Id IN (<report ids>)
//      → gives us the actual last-run timestamp for each underlying report.
//
// Credentials come from `sf org display --target-org <alias> --json` when
// `arguments.targetOrg` is supplied; otherwise we fall back to env vars
// SF_ACCESS_TOKEN + SF_INSTANCE_URL. If neither resolves, enrichment returns
// `{ skipped: true, reason: ... }` and the audit command adds an INFO finding
// explaining why the data-correctness rules didn't run.

import { spawn } from "node:child_process";

const SF_BIN = process.env.FRONTIER_SF_BIN ?? "sf";
const API_VERSION = process.env.FRONTIER_SF_API_VERSION ?? "v66.0";

export interface SfAccess {
  instanceUrl: string;
  accessToken: string;
  username?: string;
  source: "env" | "sf-cli";
}

export interface WidgetReport {
  widgetId: string;
  reportId: string | null;
  reportName: string | null;
  lastRunDate: string | null;
  lastModifiedDate: string | null;
}

export interface EnrichmentOk {
  ok: true;
  dashboardId: string;
  componentCount: number;
  widgetReports: Record<string, WidgetReport>;
  reportCount: number;
  accessSource: "env" | "sf-cli";
}

export interface EnrichmentSkipped {
  ok: false;
  skipped: true;
  reason: string;
}

export interface EnrichmentFailed {
  ok: false;
  skipped: false;
  reason: string;
  step: "access" | "dashboard_describe" | "report_soql" | "parse";
  details?: Record<string, unknown>;
}

export type EnrichmentResult =
  | EnrichmentOk
  | EnrichmentSkipped
  | EnrichmentFailed;

/**
 * Resolve SF access (instance URL + session token). Prefers the sf CLI when
 * a `targetOrg` alias is supplied — that matches the user's existing workflow
 * and avoids a second auth surface. Falls back to env vars.
 */
export async function resolveSfAccess(opts: {
  targetOrg?: string;
}): Promise<SfAccess | { error: string }> {
  if (opts.targetOrg) {
    const display = await runSf([
      "org",
      "display",
      "--target-org",
      opts.targetOrg,
      "--json",
    ]);
    if (!display.ok) {
      return {
        error: display.missingBinary
          ? "sf CLI not on PATH"
          : `sf org display exit ${display.exitCode}: ${display.stderr.slice(0, 200)}`,
      };
    }
    try {
      const parsed = JSON.parse(display.stdout) as {
        result?: {
          instanceUrl?: string;
          accessToken?: string;
          username?: string;
        };
      };
      const r = parsed.result ?? {};
      if (!r.instanceUrl || !r.accessToken) {
        return {
          error:
            "sf org display returned no instanceUrl/accessToken — is the org expired? run `sf org login web --alias " +
            opts.targetOrg +
            "`",
        };
      }
      const access: SfAccess = {
        instanceUrl: r.instanceUrl,
        accessToken: r.accessToken,
        source: "sf-cli",
      };
      if (r.username) access.username = r.username;
      return access;
    } catch (err) {
      return {
        error: `sf org display returned non-JSON: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  }
  const envUrl = process.env["SF_INSTANCE_URL"];
  const envToken = process.env["SF_ACCESS_TOKEN"];
  if (envUrl && envToken) {
    return { instanceUrl: envUrl, accessToken: envToken, source: "env" };
  }
  return {
    error:
      "no sf access resolved — pass arguments.targetOrg, or set SF_INSTANCE_URL + SF_ACCESS_TOKEN",
  };
}

/**
 * Pull dashboard components (widget-id → report-id) + report freshness
 * (LastRunDate, LastModifiedDate) for each underlying report. Returns a
 * widgetId-keyed map the audit rules can join against.
 */
export async function enrichDashboardWithReports(opts: {
  access: SfAccess;
  dashboardId: string;
}): Promise<EnrichmentResult> {
  const { access, dashboardId } = opts;

  const describeUrl = `${access.instanceUrl}/services/data/${API_VERSION}/analytics/dashboards/${dashboardId}/describe`;
  let describeResp: Response;
  try {
    describeResp = await fetch(describeUrl, {
      headers: {
        Authorization: `Bearer ${access.accessToken}`,
        Accept: "application/json",
      },
    });
  } catch (err) {
    return {
      ok: false,
      skipped: false,
      step: "dashboard_describe",
      reason: `fetch failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
  if (!describeResp.ok) {
    const body = await describeResp.text();
    return {
      ok: false,
      skipped: false,
      step: "dashboard_describe",
      reason: `dashboards/${dashboardId}/describe returned HTTP ${describeResp.status}`,
      details: {
        httpStatus: describeResp.status,
        body: body.slice(0, 800),
      },
    };
  }

  interface Component {
    id?: string;
    componentId?: string;
    reportId?: string;
    report?: { id?: string; name?: string };
    title?: string;
  }
  interface DashboardDescribe {
    id?: string;
    name?: string;
    components?: Component[];
  }
  let described: DashboardDescribe;
  try {
    described = (await describeResp.json()) as DashboardDescribe;
  } catch (err) {
    return {
      ok: false,
      skipped: false,
      step: "parse",
      reason: `dashboards describe JSON parse failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  const components = described.components ?? [];
  // Build widget-id → report-id map. SF's describe endpoint returns
  // componentId in some versions and id in others; accept either.
  const widgetReports: Record<string, WidgetReport> = {};
  const reportIds = new Set<string>();
  for (const comp of components) {
    const widgetId = comp.componentId ?? comp.id ?? null;
    if (!widgetId) continue;
    const reportId = comp.reportId ?? comp.report?.id ?? null;
    widgetReports[widgetId] = {
      widgetId,
      reportId,
      reportName: comp.report?.name ?? null,
      lastRunDate: null,
      lastModifiedDate: null,
    };
    if (reportId) reportIds.add(reportId);
  }

  if (reportIds.size === 0) {
    return {
      ok: true,
      dashboardId,
      componentCount: components.length,
      widgetReports,
      reportCount: 0,
      accessSource: access.source,
    };
  }

  // SOQL batch-query: get LastRunDate for every referenced report in one
  // request. Quote IDs in case any are trimmed to 15-char form.
  const idList = [...reportIds].map((id) => `'${id}'`).join(",");
  const soql = `SELECT Id, Name, LastRunDate, LastModifiedDate FROM Report WHERE Id IN (${idList})`;
  const queryUrl = `${access.instanceUrl}/services/data/${API_VERSION}/query?q=${encodeURIComponent(soql)}`;
  let queryResp: Response;
  try {
    queryResp = await fetch(queryUrl, {
      headers: {
        Authorization: `Bearer ${access.accessToken}`,
        Accept: "application/json",
      },
    });
  } catch (err) {
    return {
      ok: false,
      skipped: false,
      step: "report_soql",
      reason: `fetch failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
  if (!queryResp.ok) {
    const body = await queryResp.text();
    return {
      ok: false,
      skipped: false,
      step: "report_soql",
      reason: `Report SOQL returned HTTP ${queryResp.status}`,
      details: { httpStatus: queryResp.status, body: body.slice(0, 800) },
    };
  }

  interface ReportRow {
    Id: string;
    Name: string;
    LastRunDate: string | null;
    LastModifiedDate: string | null;
  }
  const queryJson = (await queryResp.json()) as {
    records?: ReportRow[];
  };
  const reports = queryJson.records ?? [];

  // Normalize: IDs in SOQL responses are 18-char. Map them back onto every
  // widget that references them (same 15/18 prefix). Build a lookup keyed
  // by both 15 and 18-char forms so either-side truncation works.
  const byId = new Map<string, ReportRow>();
  for (const r of reports) {
    byId.set(r.Id, r);
    if (r.Id.length === 18) byId.set(r.Id.slice(0, 15), r);
    if (r.Id.length === 15) byId.set(r.Id + suffix18(r.Id), r);
  }

  for (const wr of Object.values(widgetReports)) {
    if (!wr.reportId) continue;
    const row = byId.get(wr.reportId);
    if (!row) continue;
    wr.reportName = row.Name ?? wr.reportName;
    wr.lastRunDate = row.LastRunDate ?? null;
    wr.lastModifiedDate = row.LastModifiedDate ?? null;
  }

  return {
    ok: true,
    dashboardId,
    componentCount: components.length,
    widgetReports,
    reportCount: reports.length,
    accessSource: access.source,
  };
}

/**
 * Compute the 3-char SF ID suffix that converts a 15-char case-sensitive ID
 * into an 18-char case-insensitive one. Used to make the lookup map symmetric
 * when the describe API returns 15-char ids but SOQL returns 18-char.
 */
function suffix18(id15: string): string {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZ012345";
  let suffix = "";
  for (let chunk = 0; chunk < 3; chunk++) {
    let bits = 0;
    for (let bit = 0; bit < 5; bit++) {
      const idx = chunk * 5 + bit;
      if (idx < id15.length && /[A-Z]/.test(id15[idx]!)) {
        bits |= 1 << bit;
      }
    }
    suffix += chars[bits];
  }
  return suffix;
}

/** Extract the 15- or 18-char dashboard ID from the path. */
export function dashboardIdFromPath(path: string): string | null {
  const m = /\/Dashboard\/([A-Za-z0-9]{15,18})/i.exec(path);
  return m ? m[1]! : null;
}

interface SfRunResult {
  ok: boolean;
  stdout: string;
  stderr: string;
  exitCode: number | null;
  missingBinary: boolean;
}

function runSf(args: string[]): Promise<SfRunResult> {
  return new Promise((resolve) => {
    const proc = spawn(SF_BIN, args, { timeout: 60_000 });
    let stdout = "";
    let stderr = "";
    let missingBinary = false;
    proc.stdout?.on("data", (c: Buffer | string) => {
      stdout += typeof c === "string" ? c : c.toString("utf8");
    });
    proc.stderr?.on("data", (c: Buffer | string) => {
      stderr += typeof c === "string" ? c : c.toString("utf8");
    });
    proc.on("error", (err) => {
      if ((err as NodeJS.ErrnoException).code === "ENOENT")
        missingBinary = true;
      resolve({
        ok: false,
        stdout,
        stderr: `${stderr}${err.message}`,
        exitCode: null,
        missingBinary,
      });
    });
    proc.on("close", (code) => {
      resolve({
        ok: code === 0,
        stdout,
        stderr,
        exitCode: code,
        missingBinary,
      });
    });
  });
}
