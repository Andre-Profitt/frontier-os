// runpod-idle-killer watcher implementation.
//
// Periodically queries the RunPod adapter for all pods and flags any running
// pods that have been sitting at the same desiredStatus for longer than
// `idleThresholdMinutes`. For each idle candidate we emit a structured
// AlertEvent recommending a stop-pod invocation.
//
// v0.1 policy: ALWAYS notify, NEVER auto-stop. The manifest already carries
// notifyBeforeAct=true and approvalClass=2, but even in a future variant
// where that's flipped, we need explicit wiring into runWatcher's action
// pipeline before we can apply billable_action calls autonomously.
// TODO(v0.2): when spec.policy.notifyBeforeAct === false AND not dryRun,
//             invoke stop-pod directly via the adapter registry.
//
// Decision mapping:
//   - idle candidates present → "recommend" (medium)
//   - no running pods         → "no_change" (info)
//   - adapter/API failure     → "failed"

import type { WatcherImpl } from "./runtime.ts";
import { newAlertId } from "./runtime.ts";
import type { AlertEvent, WatcherSpec } from "../schemas.ts";
import {
  createRunpodClient,
  RunpodMissingCredentialsError,
  type RunpodPod,
} from "../adapters/runpod/client.ts";

const DEFAULT_IDLE_THRESHOLD_MINUTES = 15;

interface IdleCandidate {
  podId: string;
  name: string | null;
  podType: string | null;
  costPerHr: number;
  desiredStatus: string;
  lastStatusChange: string | null;
  timeSinceLastStatusChangeMs: number;
  estimatedCostBurnedSinceLastChange: number;
}

function parseIdleThresholdMinutes(spec: WatcherSpec): number {
  // The watcher spec doesn't expose a typed idleThresholdMinutes slot, so we
  // sniff the trigger.condition string for a "idle window: Nm" hint. Fall
  // back to the default otherwise. Kept narrow on purpose — a proper schema
  // extension is the right answer once the pattern stabilises.
  const cond = spec.trigger.condition;
  const match = /idle[^0-9]*([0-9]+)\s*m/i.exec(cond);
  if (match && match[1]) {
    const parsed = Number.parseInt(match[1], 10);
    if (Number.isFinite(parsed) && parsed > 0) return parsed;
  }
  return DEFAULT_IDLE_THRESHOLD_MINUTES;
}

// Parse RunPod's lastStatusChange timestamp.
//
// The real RunPod API doesn't return ISO 8601 — it returns human-readable
// strings like "Exited by user: Wed Apr 08 2026 19:14:57 GMT+0000 (Coordinated Universal Time)"
// or "Running since: Mon Apr 07 2026 ...". We try:
//   1. Straight Date.parse (works for ISO 8601 if RunPod ever changes)
//   2. Strip a leading "<prefix>: " match and retry
//   3. Return NaN if both fail
function parseRunpodTimestamp(raw: string): number {
  const direct = Date.parse(raw);
  if (Number.isFinite(direct)) return direct;
  const stripped = raw.replace(/^[^:]+:\s*/, "");
  if (stripped !== raw) {
    const second = Date.parse(stripped);
    if (Number.isFinite(second)) return second;
  }
  return Number.NaN;
}

function buildIdleCandidate(
  pod: RunpodPod,
  now: number,
  thresholdMs: number,
): IdleCandidate | null {
  if (pod.desiredStatus !== "RUNNING") return null;
  if (!pod.lastStatusChange) return null;
  const changedAt = parseRunpodTimestamp(pod.lastStatusChange);
  if (!Number.isFinite(changedAt)) return null;
  const delta = now - changedAt;
  if (delta < thresholdMs) return null;
  const hours = delta / (1000 * 60 * 60);
  return {
    podId: pod.id,
    name: pod.name,
    podType: pod.podType,
    costPerHr: pod.costPerHr,
    desiredStatus: pod.desiredStatus,
    lastStatusChange: pod.lastStatusChange,
    timeSinceLastStatusChangeMs: delta,
    estimatedCostBurnedSinceLastChange: hours * pod.costPerHr,
  };
}

function formatMinutes(ms: number): string {
  const minutes = Math.floor(ms / 60000);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const rem = minutes % 60;
  return `${hours}h${rem}m`;
}

export async function createRunpodIdleKiller(
  spec: WatcherSpec,
): Promise<WatcherImpl> {
  const thresholdMinutes = parseIdleThresholdMinutes(spec);
  const thresholdMs = thresholdMinutes * 60 * 1000;
  const notifyBeforeAct = spec.policy.notifyBeforeAct !== false;

  return {
    spec,
    async run() {
      let client;
      try {
        client = createRunpodClient();
      } catch (err) {
        const message =
          err instanceof RunpodMissingCredentialsError
            ? err.message
            : err instanceof Error
              ? err.message
              : String(err);
        return {
          decision: "failed",
          summary: `runpod-idle-killer failed to initialize: ${message}`,
          metrics: {},
          alerts: [],
          details: { error: message },
        };
      }

      let pods: RunpodPod[];
      try {
        pods = await client.listPods();
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return {
          decision: "failed",
          summary: `runpod-idle-killer list-pods failed: ${message}`,
          metrics: {},
          alerts: [],
          details: { error: message },
        };
      }

      const now = Date.now();
      const running = pods.filter((p) => p.desiredStatus === "RUNNING");
      const candidates: IdleCandidate[] = [];
      for (const pod of running) {
        const c = buildIdleCandidate(pod, now, thresholdMs);
        if (c) candidates.push(c);
      }

      const totalRunningCostPerHr = running.reduce(
        (acc, p) => acc + p.costPerHr,
        0,
      );
      const candidateCostPerHr = candidates.reduce(
        (acc, c) => acc + c.costPerHr,
        0,
      );

      const metrics: Record<string, number> = {
        podCount: pods.length,
        runningPodCount: running.length,
        idleCandidateCount: candidates.length,
        idleThresholdMinutes: thresholdMinutes,
        totalRunningCostPerHr,
        idleCandidateCostPerHr: candidateCostPerHr,
      };

      // No running pods → no_change.
      if (running.length === 0) {
        return {
          decision: "no_change",
          summary: `runpod-idle-killer: no running pods (${pods.length} total)`,
          metrics,
          alerts: [],
          details: { running: [], candidates: [] },
        };
      }

      // Running pods but none idle → no_change (info).
      if (candidates.length === 0) {
        return {
          decision: "no_change",
          summary: `runpod-idle-killer: ${running.length} running pod(s), 0 idle above ${thresholdMinutes}m threshold ($${totalRunningCostPerHr.toFixed(4)}/hr)`,
          metrics,
          alerts: [],
          details: {
            running: running.map((p) => ({
              id: p.id,
              name: p.name,
              desiredStatus: p.desiredStatus,
              costPerHr: p.costPerHr,
            })),
            candidates: [],
          },
        };
      }

      // Build one alert per idle candidate so dedupeKey can scope per-pod.
      const alerts: AlertEvent[] = candidates.map((c): AlertEvent => {
        const burnedStr = c.estimatedCostBurnedSinceLastChange.toFixed(4);
        const ageStr = formatMinutes(c.timeSinceLastStatusChangeMs);
        const summary = `RunPod ${c.name ?? c.podId} idle ${ageStr} at $${c.costPerHr}/hr (~$${burnedStr} burned)`;
        const recommendedActions: string[] = [
          `stop pod ${c.podId} via: frontier adapter invoke runpod stop-pod --mode apply --input {"podId":"${c.podId}"}`,
        ];
        if (!notifyBeforeAct) {
          // TODO(v0.2): switch to autonomous stop-pod invocation here once
          // runWatcher exposes an action-dispatch hook. For v0.1 we still
          // only emit the alert + recommendation.
          recommendedActions.push(
            "(policy says notifyBeforeAct=false, but v0.1 watcher always notifies — enable auto-stop in v0.2)",
          );
        }
        return {
          alertId: newAlertId(),
          createdAt: new Date().toISOString(),
          source: "runpod-idle-killer",
          category: "cost",
          severity: "medium",
          summary,
          status: "open",
          dedupeKey: `runpod-idle-killer:${c.podId}`,
          recommendedActions,
        };
      });

      const headline = `runpod-idle-killer: ${candidates.length} idle pod(s) above ${thresholdMinutes}m ($${candidateCostPerHr.toFixed(4)}/hr at risk of ${running.length > candidates.length ? "partial" : "full"} waste)`;

      return {
        decision: "recommend",
        summary: headline,
        metrics,
        alerts,
        details: {
          thresholdMinutes,
          running: running.map((p) => ({
            id: p.id,
            name: p.name,
            desiredStatus: p.desiredStatus,
            costPerHr: p.costPerHr,
            lastStatusChange: p.lastStatusChange,
          })),
          candidates,
        },
      };
    },
  };
}
