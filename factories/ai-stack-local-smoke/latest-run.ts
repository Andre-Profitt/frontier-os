// latest-run — supervisor heartbeat read/write + staleness assessment.
//
// Every non-killed supervisor invocation writes latest-run.json at the
// end of the run. The file lives under state/ and is gitignored. It is
// the operator's view of whether the factory is functioning at all,
// independent of any single classification.
//
// `assessStaleness` is the pure decision function used by
// `frontier factory status <factoryId>`. Inputs: latest-run record (or
// null), kill-switch state, lease state, the configured stale window,
// and current time. Output: a single status from {fresh, stale, missing,
// failed, ambiguous, disabled, locked}.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export type LatestRunMode = "observe" | "shadow" | "active" | "disabled";
export type LatestRunTrigger = "manual" | "launchd" | "watchdog";
export type LatestRunClassification = "passed" | "failed" | "ambiguous";
export type LatestRunPrimaryStatus = "ok" | "failed" | "ambiguous";
export type LatestRunRepairStatus = "ok" | "stale" | "error" | "skipped";

export interface LatestRun {
  factoryId: string;
  runId: string;
  mode: LatestRunMode;
  trigger: LatestRunTrigger;
  startedAt: string;
  finishedAt: string;
  classification: LatestRunClassification;
  primaryStatus: LatestRunPrimaryStatus;
  repairStatus: LatestRunRepairStatus;
  escalations: string[];
  ledgerSessionId: string | null;
  alertId: string | null;
  evidencePath: string;
}

export function writeLatestRun(path: string, run: LatestRun): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(run, null, 2));
}

export function readLatestRun(path: string): LatestRun | null {
  if (!existsSync(path)) return null;
  try {
    const raw = readFileSync(path, "utf8");
    const parsed = JSON.parse(raw) as LatestRun;
    if (
      typeof parsed.factoryId !== "string" ||
      typeof parsed.runId !== "string" ||
      typeof parsed.classification !== "string" ||
      typeof parsed.finishedAt !== "string"
    ) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

export type FactoryStatus =
  | "fresh"
  | "stale"
  | "missing"
  | "failed"
  | "ambiguous"
  | "disabled"
  | "locked";

export interface AssessStalenessInput {
  latestRun: LatestRun | null;
  now: Date;
  staleWindowSeconds: number;
  killSwitchActive: boolean;
  lockHeld: boolean;
}

export interface AssessStalenessResult {
  status: FactoryStatus;
  detail: string;
  ageSeconds: number | null;
}

// Status precedence (highest first):
//   1. disabled    — kill switch overrides everything; operator wants
//                    factory off.
//   2. locked      — a run is in flight; status reflects that, not the
//                    last completed run.
//   3. missing     — no latest-run.json; supervisor never wrote one.
//   4. stale       — latest-run is older than the configured window;
//                    supervisor stopped running.
//   5. failed      — latest-run.classification === "failed"
//   6. ambiguous   — latest-run.classification === "ambiguous"
//   7. fresh       — latest-run is recent and passed
//
// Rationale for ordering: disabled and locked describe the supervisor
// itself (off / busy); missing and stale describe whether the supervisor
// is producing heartbeats at all; failed/ambiguous describe the most
// recent verified outcome; fresh is the only "all good" terminal state.
export function assessStaleness(
  input: AssessStalenessInput,
): AssessStalenessResult {
  if (input.killSwitchActive) {
    return {
      status: "disabled",
      detail: "kill switch active",
      ageSeconds: null,
    };
  }
  if (input.lockHeld) {
    return {
      status: "locked",
      detail: "a supervisor run holds the lease",
      ageSeconds: null,
    };
  }
  if (!input.latestRun) {
    return {
      status: "missing",
      detail: "no latest-run.json",
      ageSeconds: null,
    };
  }
  const finishedAtMs = Date.parse(input.latestRun.finishedAt);
  if (Number.isNaN(finishedAtMs)) {
    return {
      status: "stale",
      detail: `latest-run finishedAt is unparseable: ${input.latestRun.finishedAt}`,
      ageSeconds: null,
    };
  }
  const ageSeconds = Math.floor((input.now.getTime() - finishedAtMs) / 1000);
  if (ageSeconds > input.staleWindowSeconds) {
    return {
      status: "stale",
      detail: `latest-run is ${ageSeconds}s old (window ${input.staleWindowSeconds}s)`,
      ageSeconds,
    };
  }
  if (input.latestRun.classification === "failed") {
    return {
      status: "failed",
      detail: `last run failed (runId=${input.latestRun.runId})`,
      ageSeconds,
    };
  }
  if (input.latestRun.classification === "ambiguous") {
    return {
      status: "ambiguous",
      detail: `last run ambiguous (runId=${input.latestRun.runId})`,
      ageSeconds,
    };
  }
  return {
    status: "fresh",
    detail: `last run passed (runId=${input.latestRun.runId}, ${ageSeconds}s ago)`,
    ageSeconds,
  };
}
