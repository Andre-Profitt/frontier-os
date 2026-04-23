// Rule-based audit of a Lightning DashboardModel.
//
// Each rule is a pure function that takes the captured DashboardModel and
// returns zero or more Finding objects. Rules are deterministic (no LLM
// calls, no network, no randomness) so audits are reproducible and diffable
// across runs.
//
// Severity scheme mirrors the user's existing grading vocabulary from the
// Sales Director Monthly audit work:
//   blocking    — dashboard cannot be trusted without a fix
//   wrong-data  — widget renders but data is wrong or stale
//   warning     — layout / usability issue that should be addressed
//   orphan      — element can't be referenced from dashboard JSON/metadata
//   info        — note for the audit log, not actionable
//
// A dashboard is considered "OK" if it has zero blocking AND zero wrong-data
// findings (warnings/info/orphans do not disqualify).

import type { DashboardModel, DashboardWidget } from "../lightning.ts";

export type FindingSeverity =
  | "blocking"
  | "wrong-data"
  | "warning"
  | "orphan"
  | "info";

export type FindingCategory =
  | "structure"
  | "layout"
  | "data"
  | "performance"
  | "health"
  | "metadata";

export interface Finding {
  ruleId: string;
  severity: FindingSeverity;
  category: FindingCategory;
  title: string;
  detail: string;
  widgetId?: string;
  evidence?: Record<string, unknown>;
  suggestedFix?: string;
}

export type Rule = (model: DashboardModel) => Finding[];

// ---- Individual rules ----

// CRMA and Classic Lightning dashboards cap at 20 chart widgets. The user's
// memory explicitly flags "BOB: 20 widgets, AT LIMIT" as a known tight spot.
const widgetCountAtLimit: Rule = (m) => {
  if (m.widgetCount < 20) return [];
  return [
    {
      ruleId: "widget-count-at-limit",
      severity: m.widgetCount > 20 ? "blocking" : "warning",
      category: "structure",
      title:
        m.widgetCount > 20
          ? `dashboard has ${m.widgetCount} widgets (over the 20-widget cap)`
          : `dashboard is at the 20-widget cap`,
      detail:
        "Salesforce Lightning / CRMA dashboards cap out at 20 chart widgets. At the cap, adding a new widget requires removing or merging an existing one. Over the cap means the dashboard was authored outside normal tooling and may render inconsistently.",
      evidence: { widgetCount: m.widgetCount },
      suggestedFix:
        "Merge two related widgets, move one to a companion dashboard, or retire an unused one.",
    },
  ];
};

const widgetLoading: Rule = (m) => {
  const loaders = m.widgets.filter((w) => w.loading);
  return loaders.map((w): Finding => {
    const finding: Finding = {
      ruleId: "widget-loading",
      severity: "warning",
      category: "performance",
      title: `widget "${w.title ?? w.id ?? "(untitled)"}" still loading at capture time`,
      detail:
        "A visible spinner was present inside this widget when inspect-dashboard captured the page. The audit ran waitStable before the walker, so a widget that's still loading after that is either slow or actually stuck.",
      evidence: { rect: w.rect, tag: w.tag },
      suggestedFix:
        "Re-run audit-dashboard after the spinner clears, or investigate the underlying query timeout.",
    };
    if (w.id !== null) finding.widgetId = w.id;
    return finding;
  });
};

const widgetError: Rule = (m) => {
  const errs = m.widgets.filter((w) => w.errorText !== null);
  return errs.map((w): Finding => {
    const finding: Finding = {
      ruleId: "widget-error",
      severity: "wrong-data",
      category: "data",
      title: `widget "${w.title ?? w.id ?? "(untitled)"}" reporting an error`,
      detail: `Widget rendered an error banner: ${w.errorText}`,
      evidence: { errorText: w.errorText, rect: w.rect },
      suggestedFix:
        "Check the underlying report/lens, filter bindings, and SAQL (for CRMA) or data source (for Classic) for the widget.",
    };
    if (w.id !== null) finding.widgetId = w.id;
    return finding;
  });
};

const widgetHidden: Rule = (m) => {
  const hidden = m.widgets.filter((w) => w.hidden);
  return hidden.map((w): Finding => {
    const finding: Finding = {
      ruleId: "widget-hidden",
      severity: "warning",
      category: "layout",
      title: `widget "${w.title ?? w.id ?? "(untitled)"}" has zero size`,
      detail:
        "Widget bounding rect has zero width or zero height. Either it failed to render, is behind a collapsed accordion, or its parent container is hidden.",
      evidence: { rect: w.rect, tag: w.tag },
      suggestedFix:
        "Scroll the widget into view and re-run audit; if still zero-size, check the widget config or container visibility.",
    };
    if (w.id !== null) finding.widgetId = w.id;
    return finding;
  });
};

const widgetUntitled: Rule = (m) => {
  const untitled = m.widgets.filter((w) => w.title === null || w.title === "");
  return untitled.map((w): Finding => {
    const finding: Finding = {
      ruleId: "widget-untitled",
      severity: "info",
      category: "metadata",
      title: `widget ${w.id ?? w.tag} has no title`,
      detail:
        "No heading or aria-label text could be extracted. Untitled widgets are hard to reference from audit logs and make debugging harder.",
      evidence: { tag: w.tag, rect: w.rect },
      suggestedFix:
        "Add an explicit title in the dashboard builder, or set aria-label if this is a decorative/technical widget.",
    };
    if (w.id !== null) finding.widgetId = w.id;
    return finding;
  });
};

const duplicateWidgetTitles: Rule = (m) => {
  const byTitle = new Map<string, DashboardWidget[]>();
  for (const w of m.widgets) {
    if (!w.title) continue;
    const key = w.title.toLowerCase();
    const bucket = byTitle.get(key) ?? [];
    bucket.push(w);
    byTitle.set(key, bucket);
  }
  const findings: Finding[] = [];
  for (const [key, bucket] of byTitle) {
    if (bucket.length < 2) continue;
    findings.push({
      ruleId: "duplicate-widget-titles",
      severity: "warning",
      category: "metadata",
      title: `${bucket.length} widgets share the title "${bucket[0]!.title}"`,
      detail:
        "Duplicate titles make it impossible to tell widgets apart in audit logs or when asking users to 'check widget X'. Most of the time it means one was copy-pasted without renaming.",
      evidence: {
        titleKey: key,
        widgetIds: bucket.map((w) => w.id).filter(Boolean),
      },
      suggestedFix:
        "Rename all but one to distinct, descriptive titles. Consider adding suffixes like ' — EMEA' / ' — NA' when the difference is just the filter.",
    });
  }
  return findings;
};

const dashboardUntitled: Rule = (m) => {
  if (m.title !== null && m.title !== "" && m.title !== "Untitled Dashboard") {
    return [];
  }
  return [
    {
      ruleId: "dashboard-untitled",
      severity: "info",
      category: "metadata",
      title: "dashboard has no title",
      detail:
        "The walker couldn't extract a dashboard title from .dashboardTitle, h1, or document.title. The dashboard may be unnamed, or the Lightning build shipped a selector change.",
      evidence: { path: m.path, containerTag: m.containerTag },
      suggestedFix:
        "Set a descriptive dashboard title in the dashboard properties pane.",
    },
  ];
};

const noFilters: Rule = (m) => {
  if (m.filterCount > 0) return [];
  return [
    {
      ruleId: "no-filters",
      severity: "info",
      category: "structure",
      title: "dashboard has no global filters",
      detail:
        "No filter pills were detected on the dashboard. Some dashboards deliberately ship without filters; most do not, and a missing filter bar is often the symptom of a broken filter panel.",
      evidence: { widgetCount: m.widgetCount },
      suggestedFix:
        "If filters are expected, check the global filter panel and its selectors. Otherwise mark as intentional.",
    },
  ];
};

const pageErrorsBanner: Rule = (m) => {
  return m.pageErrors.map(
    (text, i): Finding => ({
      ruleId: "page-error",
      severity: "blocking",
      category: "health",
      title: `page-level error banner #${i + 1}`,
      detail: text,
      evidence: { text, url: m.url },
      suggestedFix:
        "Investigate the underlying error — page-level banners usually mean a metadata-missing, access-denied, or metadata-change-broke-a-widget condition.",
    }),
  );
};

const orphanWidgets: Rule = (m) => {
  const orphans = m.widgets.filter((w) => w.id === null);
  return orphans.map(
    (w): Finding => ({
      ruleId: "orphan-widget",
      severity: "orphan",
      category: "metadata",
      title: `widget "${w.title ?? w.tag}" has no id`,
      detail:
        "Widget has neither data-widget-id nor data-component-id. It cannot be referenced from dashboard JSON/metadata, which makes programmatic diff and edit impossible.",
      evidence: { tag: w.tag, rect: w.rect, title: w.title },
      suggestedFix:
        "Re-save the dashboard in the builder (Lightning usually assigns data-component-id on save) or confirm this is a non-widget element that matched a widget selector.",
    }),
  );
};

function rectOverlapArea(
  a: { x: number; y: number; w: number; h: number },
  b: { x: number; y: number; w: number; h: number },
): number {
  const x1 = Math.max(a.x, b.x);
  const y1 = Math.max(a.y, b.y);
  const x2 = Math.min(a.x + a.w, b.x + b.w);
  const y2 = Math.min(a.y + a.h, b.y + b.h);
  if (x2 <= x1 || y2 <= y1) return 0;
  return (x2 - x1) * (y2 - y1);
}

/**
 * Flag widgets whose underlying report hasn't been run in > `REPORT_STALE_DAYS`
 * days. Runs only when `m.widgetReports` is present (the audit command
 * populates it via enrichment when a Salesforce access token is available).
 * When enrichment is skipped (no token), this rule emits nothing; the audit
 * command surfaces the skip reason as a separate INFO finding.
 *
 * This is the first rule that looks past DOM state into server-side truth —
 * it catches the most common "widget looks fine but data is stale" class of
 * issue that pure DOM rules are structurally blind to.
 */
const REPORT_STALE_DAYS_DEFAULT = 30;
const reportStale: Rule = (m) => {
  const enriched = m.widgetReports;
  if (!enriched || Object.keys(enriched).length === 0) return [];
  const findings: Finding[] = [];
  const now = Date.now();
  const staleDays =
    typeof m.reportStaleDays === "number" && m.reportStaleDays > 0
      ? m.reportStaleDays
      : REPORT_STALE_DAYS_DEFAULT;
  const staleThresholdMs = staleDays * 24 * 3600 * 1000;
  for (const w of m.widgets) {
    if (!w.id) continue;
    const wr = enriched[w.id];
    if (!wr || !wr.reportId) continue;
    if (!wr.lastRunDate) {
      findings.push({
        ruleId: "report-never-run",
        severity: "wrong-data",
        category: "data",
        title: `widget "${w.title ?? w.id}" — report "${wr.reportName ?? wr.reportId}" has never been run`,
        detail:
          "The underlying Report has a null LastRunDate in Salesforce. The widget may render cached data, zeros, or an empty state — but nobody has executed the query against current data.",
        widgetId: w.id,
        evidence: {
          reportId: wr.reportId,
          reportName: wr.reportName,
          lastRunDate: null,
          lastModifiedDate: wr.lastModifiedDate,
        },
        suggestedFix:
          "Open the underlying report and run it, or schedule it for periodic refresh via the Reports UI.",
      });
      continue;
    }
    const lastRunMs = Date.parse(wr.lastRunDate);
    if (Number.isNaN(lastRunMs)) continue;
    const ageDays = Math.floor((now - lastRunMs) / (24 * 3600 * 1000));
    if (now - lastRunMs <= staleThresholdMs) continue;
    findings.push({
      ruleId: "report-stale",
      severity: "wrong-data",
      category: "data",
      title: `widget "${w.title ?? w.id}" — report "${wr.reportName ?? wr.reportId}" last run ${ageDays}d ago`,
      detail: `The underlying Report was last executed ${ageDays} days ago (${wr.lastRunDate}). Classic dashboards cache the last-run values until the report is re-run, so the widget is showing data from that point in time — not "now".`,
      widgetId: w.id,
      evidence: {
        reportId: wr.reportId,
        reportName: wr.reportName,
        lastRunDate: wr.lastRunDate,
        lastModifiedDate: wr.lastModifiedDate,
        ageDays,
        thresholdDays: staleDays,
      },
      suggestedFix:
        "Re-run the report or schedule it for automatic refresh. If the widget should show near-real-time data, verify the refresh cadence matches the dashboard's refresh policy.",
    });
  }
  return findings;
};

const overlappingWidgets: Rule = (m) => {
  const findings: Finding[] = [];
  const visible = m.widgets.filter((w) => !w.hidden);
  for (let i = 0; i < visible.length; i++) {
    for (let j = i + 1; j < visible.length; j++) {
      const a = visible[i]!;
      const b = visible[j]!;
      const areaA = a.rect.w * a.rect.h;
      const areaB = b.rect.w * b.rect.h;
      if (areaA === 0 || areaB === 0) continue;
      const overlap = rectOverlapArea(a.rect, b.rect);
      const smaller = Math.min(areaA, areaB);
      if (overlap / smaller > 0.5) {
        findings.push({
          ruleId: "overlapping-widgets",
          severity: "warning",
          category: "layout",
          title: `widgets "${a.title ?? a.id ?? "?"}" and "${b.title ?? b.id ?? "?"}" overlap`,
          detail: `Bounding rects overlap by ${Math.round((overlap / smaller) * 100)}% of the smaller widget's area. This usually means the dashboard was hand-edited or a widget was resized beyond its row.`,
          evidence: {
            a: { id: a.id, rect: a.rect },
            b: { id: b.id, rect: b.rect },
            overlapFraction: +(overlap / smaller).toFixed(2),
          },
          suggestedFix:
            "Open the dashboard in edit mode and reflow the grid. Check for out-of-bounds widget positions in the dashboard JSON.",
        });
      }
    }
  }
  return findings;
};

// ---- Registry ----

export const ALL_RULES: Rule[] = [
  widgetCountAtLimit,
  widgetLoading,
  widgetError,
  widgetHidden,
  widgetUntitled,
  duplicateWidgetTitles,
  dashboardUntitled,
  noFilters,
  pageErrorsBanner,
  orphanWidgets,
  overlappingWidgets,
  reportStale,
];
