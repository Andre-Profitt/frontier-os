// Portfolio-level aggregator for `salesforce audit-dashboard` runs.
//
// Lives under src/salesforce/ (NOT src/adapters/salesforce/) because it is a
// higher-level aggregator over ledger events, not an adapter itself. It is
// read-only against the ledger — no writes, no side effects.
//
// Pairing model:
//   - A "portfolio audit" is one shared ledger session (sessionId) inside
//     which N invocations of the audit-dashboard adapter have each emitted
//     invocation.start + invocation.end + audit.grade + N finding events.
//   - All events for one invocation share the same traceId (invocationId).
//   - This module groups events by traceId, reconstructs one
//     DashboardAuditSummary per trace, then aggregates across all traces.
//
// Title/URL reconstruction:
//   - The audit-dashboard command does not copy the dashboard title into the
//     audit.grade payload. We derive it best-effort from:
//       1. invocation.start.payload.arguments.urlHint  (always the URL)
//       2. artifact.payload.ref                        (the live page URL)
//       3. artifact.payload.note                       ("audit of <kind> dashboard <title>")
//       4. invocation.end.payload.summary              ("audited <kind> dashboard \"<title>\": ...")
//   - Dashboard id is parsed from the URL when it matches
//     /lightning/r/Dashboard/<id>/view, else null.

import { getLedger } from "../ledger/index.ts";
import type { LedgerEvent } from "../ledger/events.ts";

export interface DashboardAuditSummary {
  dashboardId: string | null;
  dashboardTitle: string | null;
  dashboardKind: string;
  url: string;
  grade: {
    blocking: number;
    wrongData: number;
    warning: number;
    orphan: number;
    info: number;
    total: number;
    ok: boolean;
  };
  gradeLine: string;
  findingCount: number;
  topFindings: Array<{ ruleId: string; severity: string; count: number }>;
}

export interface SharedReportEntry {
  reportId: string;
  reportName: string | null;
  dashboardCount: number;
  widgetCount: number;
  lastRunDate: string | null;
  dashboards: Array<{
    dashboardId: string | null;
    dashboardTitle: string | null;
    widgetIds: string[];
  }>;
}

export interface PortfolioStaleReport {
  reportId: string;
  reportName: string | null;
  lastRunDate: string | null;
  dashboardCount: number;
  /** Total number of widget-occurrences across all dashboards. */
  widgetCount: number;
  /** Dashboards this stale report appears on (title + id). */
  dashboards: Array<{
    dashboardId: string | null;
    dashboardTitle: string | null;
  }>;
  /** Age in days at the time of the summary (null if reportDate unparseable). */
  ageDays: number | null;
}

export interface PortfolioSummary {
  sessionId: string;
  windowStart: string | null;
  windowEnd: string | null;
  totalDashboards: number;
  okCount: number;
  notOkCount: number;
  aggregateGrade: {
    blocking: number;
    wrongData: number;
    warning: number;
    orphan: number;
    info: number;
  };
  byDashboard: DashboardAuditSummary[];
  topRules: Array<{ ruleId: string; severity: string; count: number }>;
  /**
   * Cross-dashboard shared reports: a report that appears on 2+ dashboards in
   * this portfolio session. Consolidation candidates — renaming or refactoring
   * a shared report affects every downstream dashboard that uses it.
   */
  sharedReports: SharedReportEntry[];
  /**
   * Portfolio-wide stale-reports inventory built from enrichment events
   * (union of every dashboard's widgetReports with reportId present),
   * filtered to reports past the configured threshold. Sorted oldest-first.
   */
  staleReports: PortfolioStaleReport[];
  /**
   * Count of audits that actually carried enrichment data (audit.enrichment
   * event present) — the cross-dashboard analyses are only as accurate as
   * enrichmentCount / totalDashboards.
   */
  enrichmentCount: number;
}

// ---- internal shapes for narrowing the opaque payload blobs ----

interface InvocationStartPayload {
  invocationId?: string;
  adapterId?: string;
  command?: string;
  mode?: string;
  arguments?: { urlHint?: string } & Record<string, unknown>;
}

interface InvocationEndPayload {
  invocationId?: string;
  status?: string;
  summary?: string;
}

interface ArtifactPayload {
  kind?: string;
  ref?: string;
  note?: string;
}

interface AuditGradePayload {
  grade?: {
    blocking?: number;
    wrongData?: number;
    warning?: number;
    orphan?: number;
    info?: number;
    total?: number;
    ok?: boolean;
  };
  gradeLine?: string;
  findingCount?: number;
}

interface FindingPayload {
  ruleId?: string;
  severity?: string;
  category?: string;
  title?: string;
}

interface EnrichmentPayload {
  dashboardId?: string;
  componentCount?: number;
  reportCount?: number;
  widgetReports?: Record<
    string,
    {
      widgetId?: string;
      reportId?: string | null;
      reportName?: string | null;
      lastRunDate?: string | null;
      lastModifiedDate?: string | null;
    }
  >;
}

interface TraceBundle {
  traceId: string;
  startEvent: LedgerEvent | null;
  endEvent: LedgerEvent | null;
  gradeEvent: LedgerEvent | null;
  enrichmentEvent: LedgerEvent | null;
  artifactEvents: LedgerEvent[];
  findingEvents: LedgerEvent[];
  firstTs: string;
}

const DASHBOARD_ID_RE = /\/lightning\/r\/Dashboard\/([^/]+)\/view/i;
const NOTE_TITLE_RE =
  /audit of\s+(classic|crma|lwc|unknown)\s+dashboard\s+(.+?)$/i;
const SUMMARY_TITLE_RE =
  /audited\s+(classic|crma|lwc|unknown)\s+dashboard\s+"([^"]*)"/i;

function parseDashboardIdFromUrl(url: string | null): string | null {
  if (!url) return null;
  const m = url.match(DASHBOARD_ID_RE);
  return m && m[1] ? m[1] : null;
}

function firstArtifactUrl(artifacts: LedgerEvent[]): string | null {
  for (const a of artifacts) {
    const p = a.payload as ArtifactPayload;
    if (p.kind === "url" && typeof p.ref === "string") return p.ref;
  }
  return null;
}

function titleFromArtifactNote(note: string | undefined): {
  kind: string | null;
  title: string | null;
} {
  if (!note) return { kind: null, title: null };
  const m = note.match(NOTE_TITLE_RE);
  if (!m) return { kind: null, title: null };
  return { kind: m[1] ?? null, title: (m[2] ?? "").trim() || null };
}

function titleFromSummary(summary: string | undefined): {
  kind: string | null;
  title: string | null;
} {
  if (!summary) return { kind: null, title: null };
  const m = summary.match(SUMMARY_TITLE_RE);
  if (!m) return { kind: null, title: null };
  return { kind: m[1] ?? null, title: m[2] ?? null };
}

function buildDashboardSummary(bundle: TraceBundle): DashboardAuditSummary {
  const startPayload = (bundle.startEvent?.payload ??
    {}) as InvocationStartPayload;
  const endPayload = (bundle.endEvent?.payload ?? {}) as InvocationEndPayload;
  const gradePayload = (bundle.gradeEvent?.payload ?? {}) as AuditGradePayload;

  const urlHint = startPayload.arguments?.urlHint;
  const artifactUrl = firstArtifactUrl(bundle.artifactEvents);
  const url = (typeof urlHint === "string" && urlHint) || artifactUrl || "";

  const artifactNote = (
    bundle.artifactEvents[0]?.payload as ArtifactPayload | undefined
  )?.note;
  const fromNote = titleFromArtifactNote(artifactNote);
  const fromSummary = titleFromSummary(endPayload.summary);

  const dashboardTitle = fromNote.title ?? fromSummary.title ?? null;
  const dashboardKind = fromNote.kind ?? fromSummary.kind ?? "unknown";
  const dashboardId = parseDashboardIdFromUrl(url);

  const rawGrade = gradePayload.grade ?? {};
  const grade = {
    blocking: typeof rawGrade.blocking === "number" ? rawGrade.blocking : 0,
    wrongData: typeof rawGrade.wrongData === "number" ? rawGrade.wrongData : 0,
    warning: typeof rawGrade.warning === "number" ? rawGrade.warning : 0,
    orphan: typeof rawGrade.orphan === "number" ? rawGrade.orphan : 0,
    info: typeof rawGrade.info === "number" ? rawGrade.info : 0,
    total: typeof rawGrade.total === "number" ? rawGrade.total : 0,
    ok: typeof rawGrade.ok === "boolean" ? rawGrade.ok : false,
  };

  // Per-dashboard "top findings" = the most common ruleId|severity buckets
  // inside this single dashboard's findings, top 5.
  const ruleBuckets = new Map<
    string,
    { ruleId: string; severity: string; count: number }
  >();
  for (const e of bundle.findingEvents) {
    const f = e.payload as FindingPayload;
    const ruleId = f.ruleId ?? "?";
    const severity = f.severity ?? "info";
    const key = `${ruleId}|${severity}`;
    const cur = ruleBuckets.get(key);
    if (cur) {
      cur.count++;
    } else {
      ruleBuckets.set(key, { ruleId, severity, count: 1 });
    }
  }
  const topFindings = [...ruleBuckets.values()]
    .sort((a, b) => b.count - a.count)
    .slice(0, 5);

  return {
    dashboardId,
    dashboardTitle,
    dashboardKind,
    url,
    grade,
    gradeLine:
      typeof gradePayload.gradeLine === "string"
        ? gradePayload.gradeLine
        : "(no grade recorded)",
    findingCount:
      typeof gradePayload.findingCount === "number"
        ? gradePayload.findingCount
        : bundle.findingEvents.length,
    topFindings,
  };
}

/**
 * Read all events for the given session, pair audit.grade + finding events
 * by traceId (invocation id), and produce a portfolio summary.
 */
export function summarizePortfolioSession(sessionId: string): PortfolioSummary {
  const ledger = getLedger();
  const events = ledger.getEvents(sessionId, { limit: 10000 });

  // Group events by traceId. Events without a traceId are ignored for pairing
  // but still count toward window start/end.
  const bundles = new Map<string, TraceBundle>();
  let windowStart: string | null = null;
  let windowEnd: string | null = null;

  for (const evt of events) {
    if (windowStart === null || evt.ts < windowStart) windowStart = evt.ts;
    if (windowEnd === null || evt.ts > windowEnd) windowEnd = evt.ts;

    if (!evt.traceId) continue;
    let bundle = bundles.get(evt.traceId);
    if (!bundle) {
      bundle = {
        traceId: evt.traceId,
        startEvent: null,
        endEvent: null,
        gradeEvent: null,
        enrichmentEvent: null,
        artifactEvents: [],
        findingEvents: [],
        firstTs: evt.ts,
      };
      bundles.set(evt.traceId, bundle);
    }
    if (evt.ts < bundle.firstTs) bundle.firstTs = evt.ts;

    switch (evt.kind) {
      case "invocation.start":
        bundle.startEvent = evt;
        break;
      case "invocation.end":
        bundle.endEvent = evt;
        break;
      case "audit.grade":
        bundle.gradeEvent = evt;
        break;
      case "audit.enrichment":
        bundle.enrichmentEvent = evt;
        break;
      case "artifact":
        bundle.artifactEvents.push(evt);
        break;
      case "finding":
        bundle.findingEvents.push(evt);
        break;
      default:
        // Other kinds (side_effect, alert, system, etc.) are ignored here.
        break;
    }
  }

  // Only traces that actually produced an audit.grade event count as a
  // "dashboard audit" for the portfolio. Traces with only invocation.start
  // (e.g. still-running, crashed, or non-audit invocations) are skipped.
  const auditedBundles = [...bundles.values()].filter(
    (b) => b.gradeEvent !== null,
  );
  auditedBundles.sort((a, b) => a.firstTs.localeCompare(b.firstTs));

  const byDashboard: DashboardAuditSummary[] = auditedBundles.map(
    buildDashboardSummary,
  );

  let okCount = 0;
  let notOkCount = 0;
  const aggregateGrade = {
    blocking: 0,
    wrongData: 0,
    warning: 0,
    orphan: 0,
    info: 0,
  };
  for (const d of byDashboard) {
    if (d.grade.ok) okCount++;
    else notOkCount++;
    aggregateGrade.blocking += d.grade.blocking;
    aggregateGrade.wrongData += d.grade.wrongData;
    aggregateGrade.warning += d.grade.warning;
    aggregateGrade.orphan += d.grade.orphan;
    aggregateGrade.info += d.grade.info;
  }

  // Portfolio-wide top rules: aggregate every finding across every trace.
  const portfolioRuleBuckets = new Map<
    string,
    { ruleId: string; severity: string; count: number }
  >();
  for (const b of auditedBundles) {
    for (const e of b.findingEvents) {
      const f = e.payload as FindingPayload;
      const ruleId = f.ruleId ?? "?";
      const severity = f.severity ?? "info";
      const key = `${ruleId}|${severity}`;
      const cur = portfolioRuleBuckets.get(key);
      if (cur) {
        cur.count++;
      } else {
        portfolioRuleBuckets.set(key, { ruleId, severity, count: 1 });
      }
    }
  }
  const topRules = [...portfolioRuleBuckets.values()]
    .sort((a, b) => b.count - a.count)
    .slice(0, 10);

  // Cross-dashboard analysis: index every enrichment event by reportId and
  // aggregate. A report seen on 2+ distinct dashboards goes into sharedReports;
  // every unique reportId with a lastRunDate older than the threshold goes
  // into staleReports. Bundles without an enrichmentEvent are skipped silently
  // — the enrichmentCount counter surfaces coverage.
  interface AggReportRow {
    reportId: string;
    reportName: string | null;
    lastRunDate: string | null;
    dashboards: Map<
      string /* dashboardKey */,
      {
        dashboardId: string | null;
        dashboardTitle: string | null;
        widgetIds: Set<string>;
      }
    >;
  }
  const reportIndex = new Map<string, AggReportRow>();
  let enrichmentCount = 0;
  const bundleById = new Map<string /* dashboardId */, DashboardAuditSummary>();
  for (const d of byDashboard) {
    if (d.dashboardId) bundleById.set(d.dashboardId, d);
  }

  for (const b of auditedBundles) {
    if (!b.enrichmentEvent) continue;
    enrichmentCount++;
    const payload = (b.enrichmentEvent.payload ?? {}) as EnrichmentPayload;
    const dashId = payload.dashboardId ?? null;
    const dash =
      (dashId && bundleById.get(dashId)) ||
      byDashboard.find((d) => d.dashboardId === dashId) ||
      null;
    const dashTitle = dash?.dashboardTitle ?? null;
    const dashKey = dashId ?? b.traceId;
    const widgetReports = payload.widgetReports ?? {};
    for (const [widgetId, wr] of Object.entries(widgetReports)) {
      const reportId = wr?.reportId ?? null;
      if (!reportId) continue;
      let agg = reportIndex.get(reportId);
      if (!agg) {
        agg = {
          reportId,
          reportName: wr.reportName ?? null,
          lastRunDate: wr.lastRunDate ?? null,
          dashboards: new Map(),
        };
        reportIndex.set(reportId, agg);
      }
      // Prefer a non-null name or the freshest lastRunDate when merging.
      if (!agg.reportName && wr.reportName) agg.reportName = wr.reportName;
      if (wr.lastRunDate) {
        if (!agg.lastRunDate || wr.lastRunDate > agg.lastRunDate) {
          agg.lastRunDate = wr.lastRunDate;
        }
      }
      let dashBucket = agg.dashboards.get(dashKey);
      if (!dashBucket) {
        dashBucket = {
          dashboardId: dashId,
          dashboardTitle: dashTitle,
          widgetIds: new Set(),
        };
        agg.dashboards.set(dashKey, dashBucket);
      }
      dashBucket.widgetIds.add(widgetId);
    }
  }

  const now = Date.now();
  const STALE_DAYS = 30;
  const staleThreshMs = STALE_DAYS * 24 * 3600 * 1000;

  const sharedReports: SharedReportEntry[] = [];
  const staleReports: PortfolioStaleReport[] = [];
  for (const agg of reportIndex.values()) {
    const dashboardArr = [...agg.dashboards.values()].map((db) => ({
      dashboardId: db.dashboardId,
      dashboardTitle: db.dashboardTitle,
      widgetIds: [...db.widgetIds],
    }));
    const widgetCount = dashboardArr.reduce(
      (n, db) => n + db.widgetIds.length,
      0,
    );
    if (dashboardArr.length >= 2) {
      sharedReports.push({
        reportId: agg.reportId,
        reportName: agg.reportName,
        dashboardCount: dashboardArr.length,
        widgetCount,
        lastRunDate: agg.lastRunDate,
        dashboards: dashboardArr,
      });
    }
    const lastRunMs = agg.lastRunDate ? Date.parse(agg.lastRunDate) : NaN;
    const isStale =
      !agg.lastRunDate ||
      (!Number.isNaN(lastRunMs) && now - lastRunMs > staleThreshMs);
    if (isStale) {
      const ageDays =
        agg.lastRunDate && !Number.isNaN(lastRunMs)
          ? Math.floor((now - lastRunMs) / (24 * 3600 * 1000))
          : null;
      staleReports.push({
        reportId: agg.reportId,
        reportName: agg.reportName,
        lastRunDate: agg.lastRunDate,
        dashboardCount: dashboardArr.length,
        widgetCount,
        dashboards: dashboardArr.map((db) => ({
          dashboardId: db.dashboardId,
          dashboardTitle: db.dashboardTitle,
        })),
        ageDays,
      });
    }
  }
  sharedReports.sort(
    (a, b) =>
      b.dashboardCount - a.dashboardCount || b.widgetCount - a.widgetCount,
  );
  staleReports.sort((a, b) => {
    // Oldest first; never-run reports ranked above any dated report.
    if (a.lastRunDate === null && b.lastRunDate !== null) return -1;
    if (b.lastRunDate === null && a.lastRunDate !== null) return 1;
    if (a.lastRunDate === null && b.lastRunDate === null) return 0;
    return (a.lastRunDate as string).localeCompare(b.lastRunDate as string);
  });

  return {
    sessionId,
    windowStart,
    windowEnd,
    totalDashboards: byDashboard.length,
    okCount,
    notOkCount,
    aggregateGrade,
    byDashboard,
    topRules,
    sharedReports,
    staleReports,
    enrichmentCount,
  };
}

// ---- CLI helper for smoke-testing ----

function padRight(s: string, width: number): string {
  if (s.length >= width) return s.slice(0, width);
  return s + " ".repeat(width - s.length);
}

function padLeft(s: string, width: number): string {
  if (s.length >= width) return s.slice(0, width);
  return " ".repeat(width - s.length) + s;
}

/**
 * Pretty-print a portfolio summary to stdout. Importable so callers can run:
 *   npx tsx -e "import('./src/salesforce/portfolio-summary.ts').then(m => m.runPortfolioSummaryCli('ses_xxx'))"
 */
export function runPortfolioSummaryCli(sessionId: string): void {
  const s = summarizePortfolioSession(sessionId);

  const lines: string[] = [];
  lines.push(`portfolio session: ${s.sessionId}`);
  lines.push(
    `window: ${s.windowStart ?? "(empty)"} -> ${s.windowEnd ?? "(empty)"}`,
  );
  lines.push(
    `dashboards: ${s.totalDashboards} (${s.okCount} ok, ${s.notOkCount} not-ok)`,
  );
  lines.push(
    `aggregate: ${s.aggregateGrade.blocking} BLOCKING / ${s.aggregateGrade.wrongData} WRONG-DATA / ${s.aggregateGrade.warning} WARNING / ${s.aggregateGrade.orphan} ORPHAN / ${s.aggregateGrade.info} INFO`,
  );
  lines.push("");

  if (s.byDashboard.length === 0) {
    lines.push("(no dashboard audits in this session)");
  } else {
    // Table columns: #, id, kind, title, B/W/Wn/O/I, ok?
    const header =
      padRight("#", 3) +
      " " +
      padRight("id", 20) +
      " " +
      padRight("kind", 8) +
      " " +
      padRight("title", 40) +
      " " +
      padLeft("B", 3) +
      " " +
      padLeft("WD", 3) +
      " " +
      padLeft("Wn", 3) +
      " " +
      padLeft("Or", 3) +
      " " +
      padLeft("In", 3) +
      " " +
      padRight("ok?", 4);
    lines.push(header);
    lines.push("-".repeat(header.length));
    s.byDashboard.forEach((d, i) => {
      lines.push(
        padRight(String(i + 1), 3) +
          " " +
          padRight(d.dashboardId ?? "(no id)", 20) +
          " " +
          padRight(d.dashboardKind, 8) +
          " " +
          padRight(d.dashboardTitle ?? "(no title)", 40) +
          " " +
          padLeft(String(d.grade.blocking), 3) +
          " " +
          padLeft(String(d.grade.wrongData), 3) +
          " " +
          padLeft(String(d.grade.warning), 3) +
          " " +
          padLeft(String(d.grade.orphan), 3) +
          " " +
          padLeft(String(d.grade.info), 3) +
          " " +
          padRight(d.grade.ok ? "OK" : "NOT", 4),
      );
    });
  }

  lines.push("");
  lines.push("top recurring rules (portfolio-wide):");
  if (s.topRules.length === 0) {
    lines.push("  (none)");
  } else {
    s.topRules.forEach((r, i) => {
      lines.push(
        `  ${padLeft(String(i + 1), 2)}. ${padRight(r.ruleId, 32)} [${padRight(r.severity, 10)}] x${r.count}`,
      );
    });
  }

  lines.push("");
  lines.push(
    `enrichment coverage: ${s.enrichmentCount}/${s.totalDashboards} audit(s) carried widget -> report data`,
  );

  lines.push("");
  lines.push(
    `shared reports (used by 2+ dashboards in this session): ${s.sharedReports.length}`,
  );
  if (s.sharedReports.length === 0) {
    if (s.enrichmentCount === 0) {
      lines.push(
        "  (no enrichment data — re-run the batch with --target-org <alias>)",
      );
    } else {
      lines.push("  (no report is shared across 2+ dashboards)");
    }
  } else {
    s.sharedReports.slice(0, 10).forEach((r, i) => {
      lines.push(
        `  ${padLeft(String(i + 1), 2)}. ${padRight(r.reportId, 20)} ${padRight(r.reportName ?? "(no name)", 40)} ` +
          `dashboards=${r.dashboardCount} widgets=${r.widgetCount}`,
      );
      r.dashboards.slice(0, 3).forEach((db) => {
        lines.push(
          `        - ${db.dashboardTitle ?? "(no title)"} (${db.dashboardId ?? "?"}) [${db.widgetIds.length} widget${db.widgetIds.length === 1 ? "" : "s"}]`,
        );
      });
    });
  }

  lines.push("");
  lines.push(
    `stale reports (last run > 30d or never): ${s.staleReports.length}`,
  );
  if (s.staleReports.length === 0) {
    if (s.enrichmentCount === 0) {
      lines.push(
        "  (no enrichment data — re-run the batch with --target-org <alias>)",
      );
    } else {
      lines.push("  (no stale reports — every enriched report ran ≤ 30d ago)");
    }
  } else {
    s.staleReports.slice(0, 15).forEach((r, i) => {
      const age =
        r.ageDays === null ? "never" : `${padLeft(String(r.ageDays), 4)}d`;
      lines.push(
        `  ${padLeft(String(i + 1), 2)}. ${padRight(r.reportId, 20)} ${padRight(r.reportName ?? "(no name)", 40)} ` +
          `last=${age} on ${r.dashboardCount} dashboard${r.dashboardCount === 1 ? "" : "s"} (${r.widgetCount} widget${r.widgetCount === 1 ? "" : "s"})`,
      );
    });
  }

  process.stdout.write(lines.join("\n") + "\n");
}
