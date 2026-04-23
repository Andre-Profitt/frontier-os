// work-radar watcher implementation.
//
// Aggregates multi-source "attention signals" into one number per tick so the
// operator sees a single pane of "what needs me right now" instead of having
// to eyeball five systems. Per vision §13 and system-map.md's entry on
// work-radar, this is the always-on aggregator — runs every 15 minutes
// (interval mode, per the manifest) and turns into the 07:00 morning brief
// via overnight-review's self-improvement pass.
//
// MVP signal sources (all local, no external creds required):
//   1. Ledger failures in the last hour (work.node_failed + work.verifier_fail
//      + agent.review(reject) + ghost.graph_rejected + adapter invocations
//      whose invocation.end status === "failed").
//   2. Ghost Shift queue backlog (files piling up in queue/).
//   3. Refinery proposal backlog (proposals under auto-promote threshold).
//   4. Overnight-research produced briefs in the last 24h (drought → research
//      adapter isn't running or crashing silently).
//
// Decision mapping:
//   - recent-hour failures >= 5 OR pending proposals >= 3 → "escalate" (high)
//   - any of the four sources > 0                        → "recommend" (medium)
//   - empty tick                                         → "no_change"
//
// Future sources (creds-gated — deferred to v0.2):
//   - github open PRs assigned to author                 → `gh pr list --author @me`
//   - azure alerts                                       → azure.list-alerts
//   - databricks failed runs last day                    → databricks.list-jobs

import { existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";

import type { WatcherImpl } from "./runtime.ts";
import { newAlertId } from "./runtime.ts";
import { getLedger } from "../ledger/index.ts";
import type { AlertEvent, WatcherSpec } from "../schemas.ts";
import { loadProposals, loadRules } from "../refinery/registry.ts";

interface WorkRadarSignal {
  kind: string;
  count: number;
  severity: "info" | "low" | "medium" | "high";
  detail: string;
}

const FAILURE_KINDS = [
  "work.node_failed",
  "work.verifier_fail",
  "ghost.graph_rejected",
  "agent.review", // filtered to payload.verdict === "reject"
];

const RESEARCH_ROOT = resolve(homedir(), ".frontier", "research");
const GHOST_QUEUE = resolve(homedir(), ".frontier", "ghost-shift", "queue");

export async function createWorkRadar(spec: WatcherSpec): Promise<WatcherImpl> {
  return {
    spec,
    async run(opts) {
      const signals: WorkRadarSignal[] = [];
      const hourAgoIso = new Date(Date.now() - 3600 * 1000).toISOString();

      // --- 1. Ledger failures in the last hour ---
      const ledger = getLedger();
      let failureCount = 0;
      const failuresByKind: Record<string, number> = {};
      for (const kind of FAILURE_KINDS) {
        const rows = ledger.findEventsByKindInRange(
          kind as Parameters<typeof ledger.findEventsByKindInRange>[0],
          hourAgoIso,
          opts.until,
        );
        // agent.review needs payload filtering (only verdict === "reject")
        const relevant = rows.filter((r) => {
          if (kind !== "agent.review") return true;
          const p = r.payload as Record<string, unknown> | undefined;
          return p?.["verdict"] === "reject";
        });
        if (relevant.length > 0) {
          failuresByKind[kind] = relevant.length;
          failureCount += relevant.length;
        }
      }
      // Also: invocation.end with status=failed in the last hour
      const ends = ledger.findEventsByKindInRange(
        "invocation.end",
        hourAgoIso,
        opts.until,
      );
      const failedInvocations = ends.filter((e) => {
        const p = e.payload as Record<string, unknown> | undefined;
        return p?.["status"] === "failed";
      });
      if (failedInvocations.length > 0) {
        failuresByKind["invocation.end(failed)"] = failedInvocations.length;
        failureCount += failedInvocations.length;
      }
      if (failureCount > 0) {
        signals.push({
          kind: "recent_failures",
          count: failureCount,
          severity: failureCount >= 5 ? "high" : "medium",
          detail: `${failureCount} failure event(s) in the last hour: ${Object.entries(
            failuresByKind,
          )
            .map(([k, n]) => `${k}=${n}`)
            .join(", ")}`,
        });
      }

      // --- 2. Ghost Shift queue backlog ---
      let queueBacklog = 0;
      if (existsSync(GHOST_QUEUE)) {
        queueBacklog = readdirSync(GHOST_QUEUE).filter((f) =>
          f.endsWith(".graph.json"),
        ).length;
      }
      if (queueBacklog > 0) {
        signals.push({
          kind: "ghost_shift_backlog",
          count: queueBacklog,
          severity:
            queueBacklog >= 10 ? "high" : queueBacklog >= 3 ? "medium" : "low",
          detail: `${queueBacklog} graph(s) queued for Ghost Shift at ${GHOST_QUEUE}`,
        });
      }

      // --- 3. Refinery proposals under auto-promote threshold ---
      const proposals = loadProposals();
      const promotedIds = new Set(loadRules().map((r) => r.ruleId));
      const pendingProposals = proposals.filter(
        (p) => !promotedIds.has(p.ruleId),
      );
      if (pendingProposals.length > 0) {
        signals.push({
          kind: "refinery_proposals_pending",
          count: pendingProposals.length,
          severity:
            pendingProposals.length >= 3
              ? "high"
              : pendingProposals.length >= 1
                ? "medium"
                : "low",
          detail: `${pendingProposals.length} proposal(s) awaiting N consecutive passing nights`,
        });
      }

      // --- 4. Research brief drought ---
      const dayAgoMs = Date.now() - 24 * 3600 * 1000;
      let recentBriefCount = 0;
      if (existsSync(RESEARCH_ROOT)) {
        for (const dir of readdirSync(RESEARCH_ROOT)) {
          const briefPath = resolve(RESEARCH_ROOT, dir, "brief.md");
          if (!existsSync(briefPath)) continue;
          try {
            const { statSync } = await import("node:fs");
            const mtime = statSync(briefPath).mtimeMs;
            if (mtime >= dayAgoMs) recentBriefCount++;
          } catch {
            /* ignore */
          }
        }
      }
      const expectedNightlyBriefs = 1;
      if (recentBriefCount < expectedNightlyBriefs) {
        signals.push({
          kind: "research_brief_drought",
          count: expectedNightlyBriefs - recentBriefCount,
          severity: "low",
          detail: `${recentBriefCount}/${expectedNightlyBriefs} expected research brief(s) in the last 24h — nightly-research may be failing`,
        });
      }

      // --- Decision + severity mapping ---
      let decision: "no_change" | "notify" | "recommend" | "escalate";
      let severity: AlertEvent["severity"];
      if (signals.length === 0) {
        decision = "no_change";
        severity = "info";
      } else if (
        signals.some((s) => s.severity === "high") ||
        failureCount >= 5 ||
        pendingProposals.length >= 3
      ) {
        decision = "escalate";
        severity = "high";
      } else if (signals.some((s) => s.severity === "medium")) {
        decision = "recommend";
        severity = "medium";
      } else {
        decision = "notify";
        severity = "low";
      }

      const summaryText =
        signals.length === 0
          ? `work-radar (${opts.since.slice(0, 19)}Z → ${opts.until.slice(0, 19)}Z): quiet`
          : `work-radar: ${signals
              .map((s) => `${s.kind}=${s.count}`)
              .join(", ")}`;

      const recommendedActions: string[] = signals.map((s) => s.detail);

      const alertPayload: AlertEvent = {
        alertId: newAlertId(),
        createdAt: new Date().toISOString(),
        source: "work-radar",
        category: "recommendation",
        severity,
        summary: summaryText,
        status: "open",
        dedupeKey: `work-radar:${opts.until.slice(0, 13)}`, // hour-level dedup
        recommendedActions,
      };

      const alerts: AlertEvent[] = signals.length > 0 ? [alertPayload] : [];

      return {
        decision,
        summary: summaryText,
        metrics: {
          signalCount: signals.length,
          recentHourFailures: failureCount,
          ghostShiftBacklog: queueBacklog,
          refineryProposalsPending: pendingProposals.length,
          recentBriefCount,
          researchBriefDroughtHours:
            recentBriefCount >= expectedNightlyBriefs ? 0 : 24,
        },
        alerts,
        details: {
          signals,
          failuresByKind,
          windowHours: 1, // failure window
        },
      };
    },
  };
}
