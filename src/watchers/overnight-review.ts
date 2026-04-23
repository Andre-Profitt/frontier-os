// overnight-review watcher implementation.
//
// Reads the ledger over a time window (default: last 24h) and emits a
// structured summary alert covering:
//   - total invocations by adapter:command
//   - success/partial/failed breakdown
//   - audit.grade entries (list of dashboards audited + their grade lines)
//   - top finding rule ids by count
//   - finding breakdown by severity
//   - any failed invocations (with summaries)
//
// Decision logic:
//   - any failed invocation OR any blocking finding → "escalate" (high)
//   - any non-zero finding severity → "recommend" (medium)
//   - any activity at all → "notify" (info)
//   - empty window → "no_change"

import type { WatcherImpl } from "./runtime.ts";
import { newAlertId } from "./runtime.ts";
import { getLedger } from "../ledger/index.ts";
import type { AlertEvent, WatcherSpec } from "../schemas.ts";
import { harvestFailures } from "../refinery/harvester.ts";
import { proposeRules } from "../refinery/rules.ts";
import { runEvalDataset } from "../eval/runner.ts";
import { autoPromote } from "../refinery/auto-promote.ts";

interface FindingCountEntry {
  ruleId: string;
  severity: string;
  count: number;
}

interface AuditGradeEntry {
  ts: string;
  sessionId: string;
  gradeLine: string;
  grade: Record<string, number | boolean>;
  findingCount: number;
}

interface InvocationCountEntry {
  key: string;
  count: number;
}

interface FailedInvocationEntry {
  ts: string;
  sessionId: string;
  adapterId: string;
  command: string;
  summary: string;
}

export async function createOvernightReview(
  spec: WatcherSpec,
): Promise<WatcherImpl> {
  return {
    spec,
    async run(opts) {
      const ledger = getLedger();

      const starts = ledger.findEventsByKindInRange(
        "invocation.start",
        opts.since,
        opts.until,
      );
      const ends = ledger.findEventsByKindInRange(
        "invocation.end",
        opts.since,
        opts.until,
      );
      const grades = ledger.findEventsByKindInRange(
        "audit.grade",
        opts.since,
        opts.until,
      );
      const findings = ledger.findEventsByKindInRange(
        "finding",
        opts.since,
        opts.until,
      );

      // Breakdown: invocation end status counts.
      let success = 0;
      let partial = 0;
      let failed = 0;
      const failedList: FailedInvocationEntry[] = [];
      for (const e of ends) {
        const payload = e.payload as {
          status?: string;
          adapterId?: string;
          command?: string;
          summary?: string;
        };
        const status = payload.status ?? "unknown";
        if (status === "success") success++;
        else if (status === "partial") partial++;
        else if (status === "failed") {
          failed++;
          failedList.push({
            ts: e.ts,
            sessionId: e.sessionId,
            adapterId: payload.adapterId ?? "?",
            command: payload.command ?? "?",
            summary: payload.summary ?? "",
          });
        }
      }

      // Breakdown: invocations by adapter:command.
      const invKeyCounts = new Map<string, number>();
      for (const e of starts) {
        const p = e.payload as { adapterId?: string; command?: string };
        const key = `${p.adapterId ?? "?"}:${p.command ?? "?"}`;
        invKeyCounts.set(key, (invKeyCounts.get(key) ?? 0) + 1);
      }
      const invByKey: InvocationCountEntry[] = [...invKeyCounts.entries()]
        .map(([key, count]) => ({ key, count }))
        .sort((a, b) => b.count - a.count);

      // Audit grades in window.
      const auditList: AuditGradeEntry[] = grades.map((e): AuditGradeEntry => {
        const p = e.payload as {
          grade?: Record<string, number | boolean>;
          gradeLine?: string;
          findingCount?: number;
        };
        return {
          ts: e.ts,
          sessionId: e.sessionId,
          gradeLine: p.gradeLine ?? "(no gradeLine)",
          grade: p.grade ?? {},
          findingCount: p.findingCount ?? 0,
        };
      });

      // Finding breakdown by severity + top rule ids.
      const findingBySeverity: Record<string, number> = {
        blocking: 0,
        "wrong-data": 0,
        warning: 0,
        orphan: 0,
        info: 0,
      };
      const ruleCounts = new Map<string, FindingCountEntry>();
      for (const e of findings) {
        const p = e.payload as { severity?: string; ruleId?: string };
        const sev = p.severity ?? "info";
        findingBySeverity[sev] = (findingBySeverity[sev] ?? 0) + 1;
        const key = `${p.ruleId ?? "?"}|${sev}`;
        const existing = ruleCounts.get(key);
        if (existing) {
          existing.count++;
        } else {
          ruleCounts.set(key, {
            ruleId: p.ruleId ?? "?",
            severity: sev,
            count: 1,
          });
        }
      }
      const topRules = [...ruleCounts.values()]
        .sort((a, b) => b.count - a.count)
        .slice(0, 10);

      // Unfinished sessions (started but never ended) in window.
      const startTraces = new Set(starts.map((e) => e.traceId));
      const endTraces = new Set(ends.map((e) => e.traceId));
      const unfinished: string[] = [];
      for (const t of startTraces) {
        if (t && !endTraces.has(t)) unfinished.push(t);
      }

      const totalInvocations = starts.length;
      const hasActivity = totalInvocations > 0;
      const hasBlocking = (findingBySeverity["blocking"] ?? 0) > 0;
      const hasFailure = failed > 0;
      const hasAnyFinding = findings.length > 0;

      // Decision + severity mapping.
      let decision: "no_change" | "notify" | "recommend" | "escalate";
      let severity: AlertEvent["severity"];
      if (!hasActivity) {
        decision = "no_change";
        severity = "info";
      } else if (hasBlocking || hasFailure) {
        decision = "escalate";
        severity = "high";
      } else if (hasAnyFinding) {
        decision = "recommend";
        severity = "medium";
      } else {
        decision = "notify";
        severity = "info";
      }

      // --- Phase 17.1: self-improvement pass ---
      // Harvest failure signals from the same window + check for regressions
      // against the persisted refinery proposals. Output attaches to the brief
      // AND adjusts decision/severity so a silent eval regression can't hide
      // behind a quiet 24h of runs.
      let selfImprovement: {
        harvestedSignalCount: number;
        newSignalCount: number; // above minFrequency, new relative to current ledger
        topNewSignals: Array<{ signature: string; count: number }>;
        proposalCount: number;
        newProposalIds: string[];
        evalItems: number;
        evalPassed: number;
        evalRegressed: number;
        evalRegressionRate: number;
        autoPromoteThreshold: number;
        autoPromotedRules: Array<{
          ruleId: string;
          suggestedAction: string;
          consecutive: number;
        }>;
        autoPromoteUnderThreshold: number;
        error: string | null;
      } = {
        harvestedSignalCount: 0,
        newSignalCount: 0,
        topNewSignals: [],
        proposalCount: 0,
        newProposalIds: [],
        evalItems: 0,
        evalPassed: 0,
        evalRegressed: 0,
        evalRegressionRate: 0,
        autoPromoteThreshold: 3,
        autoPromotedRules: [],
        autoPromoteUnderThreshold: 0,
        error: null,
      };
      try {
        const signals = await harvestFailures({
          sinceIso: opts.since,
          limit: 2000,
        });
        const proposals = proposeRules(signals, { minFrequency: 2 });
        const highSignalProposals = proposals.filter(
          (p) => p.evidence.count >= 2,
        );
        const evalSummary = runEvalDataset({ maxItems: 500 });

        // Auto-promote: reuse the eval summary we already computed. Threshold 3
        // = a proposal needs 3 consecutive passing nights to become an active
        // rule. Promotion events land in the ledger as
        // `refinery.rule_auto_promoted`.
        const autoPromoteThreshold = 3;
        const promoteResult = autoPromote({
          threshold: autoPromoteThreshold,
          evalSummary,
        });

        selfImprovement = {
          harvestedSignalCount: signals.length,
          newSignalCount: signals.filter((s) => s.count >= 2).length,
          topNewSignals: signals
            .filter((s) => s.count >= 2)
            .slice(0, 5)
            .map((s) => ({ signature: s.signature, count: s.count })),
          proposalCount: proposals.length,
          newProposalIds: highSignalProposals.map((p) => p.ruleId),
          evalItems: evalSummary.itemsConsidered,
          evalPassed: evalSummary.passed,
          evalRegressed: evalSummary.regressed,
          evalRegressionRate: evalSummary.regressionRate,
          autoPromoteThreshold,
          autoPromotedRules: promoteResult.promoted
            .filter((p) => p.result.status === "ok")
            .map((p) => ({
              ruleId: p.ruleId,
              suggestedAction: p.suggestedAction,
              consecutive: p.consecutive,
            })),
          autoPromoteUnderThreshold: promoteResult.underThreshold,
          error: null,
        };

        // Decision escalation: regressions force `escalate`; new high-signal
        // proposals bump a "notify"-grade morning into at least "recommend".
        if (evalSummary.regressed > 0) {
          decision = "escalate";
          severity = "high";
        } else if (
          highSignalProposals.length > 0 &&
          decision !== "escalate" &&
          decision !== "recommend"
        ) {
          decision = "recommend";
          severity = "medium";
        }
      } catch (e) {
        selfImprovement.error = e instanceof Error ? e.message : String(e);
      }

      const metrics: Record<string, number> = {
        totalInvocations,
        invocationsSuccess: success,
        invocationsPartial: partial,
        invocationsFailed: failed,
        auditsRun: auditList.length,
        findingsBlocking: findingBySeverity["blocking"] ?? 0,
        findingsWrongData: findingBySeverity["wrong-data"] ?? 0,
        findingsWarning: findingBySeverity["warning"] ?? 0,
        findingsOrphan: findingBySeverity["orphan"] ?? 0,
        findingsInfo: findingBySeverity["info"] ?? 0,
        findingsTotal: findings.length,
        unfinishedSessions: unfinished.length,
      };

      // Summary: short, Siri-friendly spoken form — no ISO timestamps, no
      // jargon. The full technical breakdown lives in `metrics` and `details`
      // for programmatic consumers (morning-brief synthesis, dashboards).
      const summaryParts: string[] = [];
      if (totalInvocations > 0) {
        const failFragment =
          failed > 0 ? ` with ${failed} failure${failed === 1 ? "" : "s"}` : "";
        summaryParts.push(
          `${totalInvocations} adapter run${totalInvocations === 1 ? "" : "s"}${failFragment}`,
        );
      }
      if (auditList.length > 0) {
        const blocking = findingBySeverity["blocking"] ?? 0;
        const wrongData = findingBySeverity["wrong-data"] ?? 0;
        let auditFragment = `${auditList.length} audit${auditList.length === 1 ? "" : "s"}`;
        if (findings.length > 0) {
          const severityFrags: string[] = [];
          if (blocking > 0) severityFrags.push(`${blocking} blocking`);
          if (wrongData > 0) severityFrags.push(`${wrongData} wrong-data`);
          auditFragment +=
            severityFrags.length > 0
              ? ` with ${severityFrags.join(" and ")}`
              : "";
        }
        summaryParts.push(auditFragment);
      }
      if (unfinished.length > 0) {
        summaryParts.push(
          `${unfinished.length} unfinished session${unfinished.length === 1 ? "" : "s"}`,
        );
      }
      const summaryText = hasActivity
        ? `In the last 24 hours: ${summaryParts.join(", ")}`
        : "No overnight activity";

      // Build recommended actions — only include actionable items.
      const recommendedActions: string[] = [];
      if (hasFailure) {
        recommendedActions.push(
          `investigate ${failed} failed invocation(s): ${failedList
            .slice(0, 3)
            .map((f) => `${f.adapterId}:${f.command}`)
            .join(", ")}`,
        );
      }
      if (hasBlocking) {
        recommendedActions.push(
          `resolve ${findingBySeverity["blocking"]} blocking finding(s) from the most recent audit`,
        );
      }
      if ((findingBySeverity["wrong-data"] ?? 0) > 0) {
        recommendedActions.push(
          `check ${findingBySeverity["wrong-data"]} wrong-data finding(s) — likely underlying query/data issues`,
        );
      }
      if (unfinished.length > 0) {
        recommendedActions.push(
          `${unfinished.length} sessions started without completion — possible crashes or aborts`,
        );
      }
      if (topRules.length > 0 && (hasAnyFinding || hasBlocking)) {
        const top = topRules[0]!;
        recommendedActions.push(
          `top recurring finding: ${top.ruleId} [${top.severity}] (${top.count} occurrences)`,
        );
      }

      const alertPayload: AlertEvent = {
        alertId: newAlertId(),
        createdAt: new Date().toISOString(),
        source: "overnight-review",
        category: "recommendation",
        severity,
        summary: summaryText,
        status: "open",
        dedupeKey: `overnight-review:${opts.since.slice(0, 10)}`,
        recommendedActions,
      };

      const alerts: AlertEvent[] =
        hasActivity || hasFailure ? [alertPayload] : [];

      // Layer the self-improvement counters into metrics + details.
      metrics.harvestedSignals = selfImprovement.harvestedSignalCount;
      metrics.newHighSignalProposals = selfImprovement.newProposalIds.length;
      metrics.evalItemsChecked = selfImprovement.evalItems;
      metrics.evalRegressed = selfImprovement.evalRegressed;
      metrics.autoPromotedRules = selfImprovement.autoPromotedRules.length;

      if (selfImprovement.evalRegressed > 0) {
        recommendedActions.unshift(
          `${selfImprovement.evalRegressed} eval regression(s) — run \`frontier eval run --fail-on-regression\` for detail`,
        );
      }
      if (selfImprovement.autoPromotedRules.length > 0) {
        const actionsSet = Array.from(
          new Set(
            selfImprovement.autoPromotedRules.map((r) => r.suggestedAction),
          ),
        ).join(", ");
        recommendedActions.unshift(
          `${selfImprovement.autoPromotedRules.length} rule(s) auto-promoted after ${selfImprovement.autoPromoteThreshold} passing nights (actions: ${actionsSet}). Inspect: \`frontier refinery rules\`.`,
        );
      }
      if (selfImprovement.newProposalIds.length > 0) {
        recommendedActions.push(
          `${selfImprovement.newProposalIds.length} refinery proposal(s) below auto-promote threshold (need ${selfImprovement.autoPromoteThreshold} passing nights). See \`frontier refinery rules --show-proposals\`.`,
        );
      }
      if (selfImprovement.error) {
        recommendedActions.push(
          `refinery/eval self-improvement pass errored: ${selfImprovement.error.slice(0, 120)}`,
        );
      }

      return {
        decision,
        summary: summaryText,
        metrics,
        alerts,
        details: {
          invocationsByKey: invByKey,
          audits: auditList,
          findingBySeverity,
          topRules,
          failedInvocations: failedList,
          unfinishedTraces: unfinished,
          selfImprovement,
        },
      };
    },
  };
}
