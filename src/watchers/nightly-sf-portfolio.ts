// nightly-sf-portfolio watcher implementation.
//
// Runs the salesforce.portfolio-inventory adapter (zero DOM, pure HTTP+SOQL),
// persists a "snapshot" alert containing the full stale/shared lists, and
// diffs today's snapshot against the most-recent prior snapshot to emit one
// medium-severity "new stale report" alert per report that crossed the
// staleness threshold since yesterday.
//
// Decision mapping:
//   - no prior snapshot (first run)         → "notify" (info)
//   - new-stale count > 0                   → "notify" (one alert per delta)
//   - no new-stale since prior snapshot     → "no_change"
//   - adapter error                         → "failed"
//
// Configuration knobs come from the watcher spec's trigger.condition hints:
//   - "staleDays: 30"   overrides the 30-day threshold
//   - "limit: 40"       overrides the 40-dashboard cap
// Falls back to defaults when absent. A proper schema extension is a v0.2
// concern — same pattern as runpod-idle-killer's "idle window" hint.

import type { WatcherImpl } from "./runtime.ts";
import { newAlertId } from "./runtime.ts";
import type { AlertEvent, WatcherSpec } from "../schemas.ts";
import { getLedger } from "../ledger/index.ts";
import { portfolioInventoryCommand } from "../adapters/salesforce/commands/portfolio-inventory.ts";

const DEFAULT_STALE_DAYS = 30;
const DEFAULT_DASHBOARD_LIMIT = 40;
const SNAPSHOT_DEDUPE_PREFIX = "nightly-sf-portfolio:snapshot";
const NEW_STALE_DEDUPE_PREFIX = "nightly-sf-portfolio:new-stale";

interface StaleEntry {
  reportId: string;
  reportName: string | null;
  lastRunDate: string | null;
  ageDays: number | null;
  dashboardCount: number;
  widgetCount: number;
}

interface SharedEntry {
  reportId: string;
  reportName: string | null;
  dashboardCount: number;
  widgetCount: number;
}

interface SnapshotPayload {
  snapshotSchemaVersion: 1;
  takenAt: string;
  staleDays: number;
  dashboardLimit: number;
  dashboardCount: number;
  enrichedCount: number;
  reportCount: number;
  sharedReportCount: number;
  staleReportCount: number;
  /** Top-20 shared — full list can be reconstructed from adapter run. */
  sharedReports: SharedEntry[];
  /** Full stale-reports list — needed for next-night diff. */
  staleReports: StaleEntry[];
  /** Target-org alias used (preprod etc.) — lets future multi-org work diff per-org. */
  targetOrg: string;
}

export async function createNightlySfPortfolio(
  spec: WatcherSpec,
): Promise<WatcherImpl> {
  const staleDays = parseStaleDaysHint(spec);
  const dashboardLimit = parseLimitHint(spec);
  const targetOrg = parseTargetOrgHint(spec);

  return {
    spec,
    async run({ sessionId, dryRun }) {
      // 1. Run the portfolio-inventory adapter. We invoke the command
      // function directly (rather than going through the adapter registry +
      // a new sub-session) because the watcher already owns a ledger session
      // and we want the snapshot alert to land in THAT session so next-night
      // diff-vs-yesterday can replay it without chasing sub-sessions.
      const inventoryResult = await portfolioInventoryCommand({
        invocationId: `inv_${sessionId}_inventory`,
        adapterId: "salesforce",
        command: "portfolio-inventory",
        mode: "read",
        requestedAt: new Date().toISOString(),
        arguments: {
          targetOrg,
          staleDays,
          limit: dashboardLimit,
        },
      });

      if (inventoryResult.status !== "success") {
        return {
          decision: "failed",
          summary: `nightly-sf-portfolio: portfolio-inventory returned ${inventoryResult.status}: ${inventoryResult.summary}`,
          metrics: {},
          alerts: [],
          details: { inventoryResult },
        };
      }

      const obs = (inventoryResult.observedState ?? {}) as Record<
        string,
        unknown
      >;
      const snapshot: SnapshotPayload = {
        snapshotSchemaVersion: 1,
        takenAt: new Date().toISOString(),
        staleDays,
        dashboardLimit,
        dashboardCount: asNumber(obs["dashboardCount"]),
        enrichedCount: asNumber(obs["enrichedCount"]),
        reportCount: asNumber(obs["reportCount"]),
        sharedReportCount: asNumber(obs["sharedReportCount"]),
        staleReportCount: asNumber(obs["staleReportCount"]),
        sharedReports: coerceSharedReports(obs["sharedReports"]).slice(0, 20),
        staleReports: coerceStaleReports(obs["staleReports"]),
        targetOrg,
      };

      const metrics: Record<string, number> = {
        dashboardCount: snapshot.dashboardCount,
        enrichedCount: snapshot.enrichedCount,
        reportCount: snapshot.reportCount,
        sharedReportCount: snapshot.sharedReportCount,
        staleReportCount: snapshot.staleReportCount,
      };

      // 2. Load the most-recent PRIOR snapshot alert for diff. We exclude
      // the current session because (a) it doesn't have a snapshot alert
      // yet and (b) a newly-created session is identified by not matching
      // our watcher tag in listSessions below.
      const prior = loadMostRecentPriorSnapshot(sessionId);

      const nowIso = snapshot.takenAt;
      const snapshotAlert: AlertEvent = {
        alertId: newAlertId(),
        createdAt: nowIso,
        source: "nightly-sf-portfolio",
        category: "health",
        severity: "info",
        summary: `nightly SF portfolio snapshot: ${snapshot.dashboardCount} dashboards (${snapshot.enrichedCount} enriched), ${snapshot.reportCount} reports, ${snapshot.sharedReportCount} shared, ${snapshot.staleReportCount} stale @ >${staleDays}d`,
        status: "open",
        dedupeKey: `${SNAPSHOT_DEDUPE_PREFIX}:${targetOrg}:${dateOnly(nowIso)}`,
        recommendedActions: [
          `inspect full details with: frontier ledger show ${sessionId}`,
        ],
        context: snapshot as unknown as Record<string, unknown>,
      };

      const alerts: AlertEvent[] = [snapshotAlert];

      if (!prior) {
        return {
          decision: "notify",
          summary: `nightly-sf-portfolio (first run): ${snapshot.staleReportCount} stale report(s) / ${snapshot.dashboardCount} dashboards — no prior baseline for diff yet`,
          metrics,
          alerts: dryRun ? [] : alerts,
          details: {
            snapshot,
            prior: null,
            diff: { newStale: [], resolvedStale: [] },
          },
        };
      }

      const { newStale, resolvedStale } = diffStale(
        prior.staleReports,
        snapshot.staleReports,
      );

      // 3. One alert per newly-stale report — these are the actionable
      // items the morning-brief should surface at 07:00.
      for (const entry of newStale) {
        const age =
          entry.ageDays === null ? "never run" : `${entry.ageDays}d old`;
        alerts.push({
          alertId: newAlertId(),
          createdAt: nowIso,
          source: "nightly-sf-portfolio",
          category: "recommendation",
          severity: "medium",
          summary: `new stale: ${entry.reportName ?? entry.reportId} (${age}) on ${entry.dashboardCount} dashboard${entry.dashboardCount === 1 ? "" : "s"} (${entry.widgetCount} widget${entry.widgetCount === 1 ? "" : "s"})`,
          status: "open",
          dedupeKey: `${NEW_STALE_DEDUPE_PREFIX}:${targetOrg}:${entry.reportId}`,
          recommendedActions: [
            `re-run report: ${entry.reportId}`,
            "OR adjust dashboard refresh cadence if this is expected",
          ],
          context: entry as unknown as Record<string, unknown>,
        });
      }

      metrics.newStaleCount = newStale.length;
      metrics.resolvedStaleCount = resolvedStale.length;

      const headline =
        newStale.length === 0
          ? `nightly-sf-portfolio: no new stale reports since ${prior.takenAt.slice(0, 10)} (current: ${snapshot.staleReportCount} / previous: ${prior.staleReports.length})`
          : `nightly-sf-portfolio: ${newStale.length} new stale report${newStale.length === 1 ? "" : "s"} since ${prior.takenAt.slice(0, 10)} (total stale: ${snapshot.staleReportCount})`;

      return {
        decision: newStale.length === 0 ? "no_change" : "notify",
        summary: headline,
        metrics,
        alerts: dryRun ? [] : alerts,
        details: {
          snapshot,
          prior: {
            takenAt: prior.takenAt,
            staleCount: prior.staleReports.length,
            fromSessionId: prior.sessionId,
          },
          diff: {
            newStale: newStale.map((e) => ({
              reportId: e.reportId,
              reportName: e.reportName,
              ageDays: e.ageDays,
            })),
            resolvedStale: resolvedStale.map((e) => ({
              reportId: e.reportId,
              reportName: e.reportName,
              ageDays: e.ageDays,
            })),
          },
        },
      };
    },
  };
}

// ---- helpers ----

function parseStaleDaysHint(spec: WatcherSpec): number {
  const match = /staleDays\s*:\s*([0-9]+)/i.exec(spec.trigger.condition);
  if (match && match[1]) {
    const n = Number.parseInt(match[1], 10);
    if (Number.isFinite(n) && n > 0) return n;
  }
  return DEFAULT_STALE_DAYS;
}

function parseLimitHint(spec: WatcherSpec): number {
  const match = /limit\s*:\s*([0-9]+)/i.exec(spec.trigger.condition);
  if (match && match[1]) {
    const n = Number.parseInt(match[1], 10);
    if (Number.isFinite(n) && n > 0) return n;
  }
  return DEFAULT_DASHBOARD_LIMIT;
}

function parseTargetOrgHint(spec: WatcherSpec): string {
  const match = /targetOrg\s*:\s*([A-Za-z0-9_-]+)/i.exec(
    spec.trigger.condition,
  );
  if (match && match[1]) return match[1];
  return process.env["FRONTIER_SF_TARGET_ORG"] ?? "preprod";
}

function dateOnly(iso: string): string {
  return iso.slice(0, 10);
}

function asNumber(v: unknown): number {
  return typeof v === "number" ? v : 0;
}

function coerceStaleReports(v: unknown): StaleEntry[] {
  if (!Array.isArray(v)) return [];
  return v
    .filter(
      (x): x is Record<string, unknown> => typeof x === "object" && x !== null,
    )
    .map((x) => ({
      reportId:
        typeof x["reportId"] === "string" ? (x["reportId"] as string) : "",
      reportName:
        typeof x["reportName"] === "string"
          ? (x["reportName"] as string)
          : null,
      lastRunDate:
        typeof x["lastRunDate"] === "string"
          ? (x["lastRunDate"] as string)
          : null,
      ageDays:
        typeof x["ageDays"] === "number" ? (x["ageDays"] as number) : null,
      dashboardCount: asNumber(x["dashboardCount"]),
      widgetCount: asNumber(x["widgetCount"]),
    }))
    .filter((x) => x.reportId !== "");
}

function coerceSharedReports(v: unknown): SharedEntry[] {
  if (!Array.isArray(v)) return [];
  return v
    .filter(
      (x): x is Record<string, unknown> => typeof x === "object" && x !== null,
    )
    .map((x) => ({
      reportId:
        typeof x["reportId"] === "string" ? (x["reportId"] as string) : "",
      reportName:
        typeof x["reportName"] === "string"
          ? (x["reportName"] as string)
          : null,
      dashboardCount: asNumber(x["dashboardCount"]),
      widgetCount: asNumber(x["widgetCount"]),
    }))
    .filter((x) => x.reportId !== "");
}

interface PriorSnapshot {
  sessionId: string;
  takenAt: string;
  staleReports: StaleEntry[];
}

function loadMostRecentPriorSnapshot(
  currentSessionId: string,
): PriorSnapshot | null {
  const ledger = getLedger();
  // Scan recent sessions tagged nightly-sf-portfolio. Watchers use
  // ensureSession with tags=["watcher", watcherId] per runtime.ts:179.
  const sessions = ledger.listSessions(200);
  const candidates = sessions
    .filter(
      (s) =>
        s.sessionId !== currentSessionId &&
        Array.isArray(s.tags) &&
        s.tags.includes("nightly-sf-portfolio"),
    )
    .sort((a, b) => b.startedAt.localeCompare(a.startedAt));

  for (const sess of candidates) {
    const events = ledger.getEvents(sess.sessionId, { limit: 500 });
    // Snapshot alert is marked by context.snapshotSchemaVersion=1 so we can
    // skip the per-delta "new-stale" alerts in the same session.
    for (const ev of events) {
      if (ev.kind !== "alert") continue;
      const payload = ev.payload as Record<string, unknown>;
      const ctx = payload["context"];
      if (
        ctx &&
        typeof ctx === "object" &&
        (ctx as Record<string, unknown>)["snapshotSchemaVersion"] === 1
      ) {
        const ctxObj = ctx as unknown as SnapshotPayload;
        return {
          sessionId: sess.sessionId,
          takenAt: ctxObj.takenAt,
          staleReports: coerceStaleReports(ctxObj.staleReports),
        };
      }
    }
  }
  return null;
}

function diffStale(
  prior: StaleEntry[],
  current: StaleEntry[],
): { newStale: StaleEntry[]; resolvedStale: StaleEntry[] } {
  const priorIds = new Set(prior.map((e) => e.reportId));
  const currentIds = new Set(current.map((e) => e.reportId));
  const newStale = current.filter((e) => !priorIds.has(e.reportId));
  const resolvedStale = prior.filter((e) => !currentIds.has(e.reportId));
  return { newStale, resolvedStale };
}
