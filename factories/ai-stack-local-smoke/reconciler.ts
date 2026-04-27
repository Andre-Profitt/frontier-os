// Local-smoke factory reconciler.
//
// Mental model: this is a control loop, not a script.
//
//   1. observe — snapshot reality (no side effects).
//   2. decide  — pure mapping (intent, observed) → FactoryAction[].
//   3. apply   — execute actions; the actual lane work delegates to
//                superviseFactoryRun() so the well-tested run lifecycle
//                stays in one place.
//   4. assert  — the 15 dark-factory invariants must hold.
//   5. record  — return a FactoryReconciliation that explains what was
//                observed, what was decided, what was done, and what
//                state was left behind.
//
// The reconciler is the public API of the local-smoke factory. The CLI
// `frontier factory reconcile` calls this; tests call this; future
// watchdog triggers will call this. The supervisor remains as the
// run-lifecycle implementation; the reconciler is the control plane.
//
// Invariants enforced (see tests/reconciler.test.ts for the bad
// fixtures):
//
//   I1  Kill switch wins before lease / verifier / repair / ledger / alert.
//   I2  Status command is read-only.                (enforced by observeFactory + CLI)
//   I3  No two factory runs can own the same lock.  (enforced by lease.ts)
//   I4  Release cannot delete another run's lock.   (enforced by lease.ts)
//   I5  latest-run is written for passed/failed/ambiguous active+shadow runs.
//   I6  failed/ambiguous active runs emit at most one alert.
//   I7  Legacy alert during run suppresses factory duplicate.
//   I8  passed runs emit no alert.
//   I9  Activation apply backs up before write.     (enforced by activation.ts)
//   I10 Activation never calls launchctl in PR #7.  (enforced by activation.ts)
//   I11 Activation never edits /Users/test/bin.     (enforced by activation.ts)
//   I12 launchd wrapper is boring: cd repo, exec node supervisor.
//   I13 observe mode does not run primary or repair.
//   I14 shadow mode can run factory without changing launchd.
//   I15 active mode is the only canonical scheduled operation.
//
// Retry policy for PR #7: zero automatic retries. A failed run produces
// a durable record + at most one alert; the watchdog (later PR) decides
// whether stale/missing requires a new run.

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  reconcileAlerts as _reconcileAlerts,
  type AlertRecordLike,
  type Ownership,
} from "./alert-ownership.ts";
import { readActiveLease, isProcessAlive, type Lease } from "./lease.ts";
import {
  readLatestRun,
  type FactoryStatus,
  type LatestRun,
  type LatestRunMode,
  type LatestRunTrigger,
} from "./latest-run.ts";
import { isKillSwitchActive, killSwitchPath, loadSpec } from "./run.ts";
import {
  superviseFactoryRun,
  type FactoryRun,
  type SuperviseOptions,
  type SupervisorSpec,
} from "./supervisor.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, "..", "..");

// --- public types --------------------------------------------------------

export interface FactoryIntent {
  factoryId: "ai-stack-local-smoke";
  /**
   * Mode the operator wants the factory in. The reconciler checks the
   * kill switch + state/disabled + state/mode.json against this and
   * either accepts it (active/shadow operating modes), no-ops it
   * (observe), or returns a disabled status (kill switch / explicit
   * disable wins).
   */
  desiredMode: "shadow" | "active" | "disabled" | "observe";
  trigger: LatestRunTrigger;
  /** A run older than this is "stale". Default 26h matches factory.json. */
  staleAfterHours: number;
}

export interface ObservedMode {
  defaultMode: LatestRunMode;
  runtimeMode: LatestRunMode | null;
  effectiveMode: LatestRunMode;
  killSwitchActive: boolean;
  killSwitchPath: string;
}

export interface ObservedLock {
  exists: boolean;
  active: boolean;
  stale: boolean;
  holderRunId: string | null;
  expiresAt: string | null;
}

export interface ObservedLatestRun {
  exists: boolean;
  classification: LatestRun["classification"] | null;
  finishedAt: string | null;
  ageHours: number | null;
  freshness: "fresh" | "stale" | "missing";
  raw: LatestRun | null;
}

export interface ObservedFactoryState {
  observedAt: string;
  factoryId: "ai-stack-local-smoke";
  mode: ObservedMode;
  lock: ObservedLock;
  latestRun: ObservedLatestRun;
  alerts: { before: AlertRecordLike[] };
}

export type FactoryAction =
  | { type: "noop"; reason: string }
  | { type: "observe_only"; reason: string }
  | { type: "kill_switch_short_circuit"; killSwitchPath: string }
  | { type: "lease_blocked"; holderRunId: string | null; reason: string }
  | { type: "supervise_run"; mode: LatestRunMode; trigger: LatestRunTrigger }
  | { type: "write_latest_run"; path: string }
  | { type: "emit_factory_alert"; severity: "high" | "medium"; alertId: string }
  | { type: "suppress_duplicate_alert"; legacyAlertIds: string[] };

export interface FactoryRunResult {
  ran: boolean;
  classification: "passed" | "failed" | "ambiguous" | "skipped";
  primaryStatus: "ok" | "failed" | "ambiguous" | "skipped";
  repairStatus: "ok" | "stale" | "error" | "skipped";
  emittedAlertId: string | null;
  correlatedLegacyAlertIds: string[];
  ownership: Ownership;
  detail: string;
  /** Full run record when the supervisor was invoked; null otherwise. */
  run: FactoryRun | null;
}

export interface InvariantCheck {
  id: string;
  name: string;
  held: boolean;
  detail?: string;
}

export interface FactoryReconciliation {
  schema: "frontier_os.factory_reconciliation.v1";
  runId: string;
  factoryId: "ai-stack-local-smoke";
  startedAt: string;
  finishedAt: string;
  desired: FactoryIntent;
  observed: ObservedFactoryState;
  actions: FactoryAction[];
  result: FactoryRunResult;
  status: FactoryStatus;
  invariants: InvariantCheck[];
}

// --- observation ---------------------------------------------------------

export interface ObserveOpts {
  spec?: SupervisorSpec;
  clock?: () => Date;
  alertReader?: (factorySource: string) => AlertRecordLike[];
}

function readModeFile(modePath: string): LatestRunMode | null {
  if (!existsSync(modePath)) return null;
  try {
    const parsed = JSON.parse(readFileSync(modePath, "utf8")) as {
      mode?: string;
    };
    if (
      parsed.mode === "observe" ||
      parsed.mode === "shadow" ||
      parsed.mode === "active" ||
      parsed.mode === "disabled"
    ) {
      return parsed.mode;
    }
  } catch {
    // fall through
  }
  return null;
}

function observeLock(lockPath: string): ObservedLock {
  const lease = readActiveLease(lockPath);
  if (lease === null) {
    return {
      exists: false,
      active: false,
      stale: false,
      holderRunId: null,
      expiresAt: null,
    };
  }
  const alive = isProcessAlive(lease.pid);
  const expired = Date.parse(lease.expiresAt) <= Date.now();
  // "active" means a real other run holds it; "stale" means it exists
  // but is recoverable (process gone or expired).
  const active = alive && !expired;
  const stale = !active;
  return {
    exists: true,
    active,
    stale,
    holderRunId: (lease as Lease).runId,
    expiresAt: lease.expiresAt,
  };
}

function observeLatestRun(
  path: string,
  staleAfterHours: number,
  now: Date,
): ObservedLatestRun {
  const raw = readLatestRun(path);
  if (raw === null) {
    return {
      exists: false,
      classification: null,
      finishedAt: null,
      ageHours: null,
      freshness: "missing",
      raw: null,
    };
  }
  const ageMs = now.getTime() - Date.parse(raw.finishedAt);
  const ageHours = ageMs / 3_600_000;
  const freshness: "fresh" | "stale" | "missing" =
    ageHours > staleAfterHours ? "stale" : "fresh";
  return {
    exists: true,
    classification: raw.classification,
    finishedAt: raw.finishedAt,
    ageHours,
    freshness,
    raw,
  };
}

export function observeFactory(
  intent: FactoryIntent,
  opts: ObserveOpts = {},
): ObservedFactoryState {
  const clock = opts.clock ?? (() => new Date());
  const spec = opts.spec ?? (loadSpec() as unknown as SupervisorSpec);
  const now = clock();

  const ksActive = isKillSwitchActive(spec);
  const ksPath = killSwitchPath(spec);

  const modePath = resolve(REPO_ROOT, spec.activation.modeFile);
  const runtimeMode = readModeFile(modePath);
  const effectiveMode: LatestRunMode = ksActive
    ? "disabled"
    : (runtimeMode ?? spec.activation.defaultMode);

  const lockPath = resolve(REPO_ROOT, spec.activation.leaseLockFile);
  const lock = observeLock(lockPath);

  const latestRunPath = resolve(REPO_ROOT, spec.activation.latestRunFile);
  const latestRun = observeLatestRun(
    latestRunPath,
    intent.staleAfterHours,
    now,
  );

  // The observed.alerts.before snapshot is intentionally empty here.
  // decideActions does not depend on the alert pre-state; the supervisor
  // owns the before/after read inside its own pipeline (so it sees a
  // fresh "before" right at lease acquisition, not earlier). Keeping the
  // observation read-only and stub-free also keeps observeFactory cheap.
  const alertsBefore: AlertRecordLike[] = [];
  void opts.alertReader; // intentionally unused at observation time

  return {
    observedAt: now.toISOString(),
    factoryId: "ai-stack-local-smoke",
    mode: {
      defaultMode: spec.activation.defaultMode,
      runtimeMode,
      effectiveMode,
      killSwitchActive: ksActive,
      killSwitchPath: ksPath,
    },
    lock,
    latestRun,
    alerts: { before: alertsBefore },
  };
}

// --- decision ------------------------------------------------------------

/**
 * Pure state-machine: given an intent and an observed snapshot, return
 * the planned action sequence. Apply only executes; it does not decide.
 *
 * Precedence (table-driven):
 *
 *   1. kill switch active        → kill_switch_short_circuit
 *   2. effectiveMode === disabled → noop(disabled)
 *   3. lock active (not stale)    → lease_blocked
 *   4. effectiveMode === observe  → observe_only
 *   5. shadow / active            → supervise_run (+ writes/alerts inferred)
 */
export function decideActions(
  intent: FactoryIntent,
  observed: ObservedFactoryState,
): FactoryAction[] {
  if (observed.mode.killSwitchActive) {
    return [
      {
        type: "kill_switch_short_circuit",
        killSwitchPath: observed.mode.killSwitchPath,
      },
    ];
  }
  if (observed.mode.effectiveMode === "disabled") {
    return [
      {
        type: "noop",
        reason: "supervisor mode=disabled (operator disable, no kill switch)",
      },
    ];
  }
  if (observed.lock.active) {
    return [
      {
        type: "lease_blocked",
        holderRunId: observed.lock.holderRunId,
        reason: `lock held by ${observed.lock.holderRunId ?? "unknown"} until ${observed.lock.expiresAt ?? "?"}`,
      },
    ];
  }
  if (observed.mode.effectiveMode === "observe") {
    return [{ type: "observe_only", reason: "supervisor mode=observe" }];
  }
  // Shadow / active: actually run. The supervise_run action is the
  // headline; write_latest_run / emit / suppress get appended at apply
  // time once the run record exists.
  return [
    {
      type: "supervise_run",
      mode: observed.mode.effectiveMode,
      trigger: intent.trigger,
    },
  ];
}

// --- application ---------------------------------------------------------

export interface ReconcileOptions extends Omit<
  SuperviseOptions,
  "trigger" | "modeOverride"
> {
  /** Test seam: skip the real ledger / alert reader / primary spawn. */
  superviseOverride?: (inner: SuperviseOptions) => Promise<FactoryRun>;
}

function emptyRunResult(detail: string): FactoryRunResult {
  return {
    ran: false,
    classification: "skipped",
    primaryStatus: "skipped",
    repairStatus: "skipped",
    emittedAlertId: null,
    correlatedLegacyAlertIds: [],
    ownership: "none",
    detail,
    run: null,
  };
}

function newReconciliationRunId(now: Date): string {
  const ts = now
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d+Z$/, "Z");
  const r = Math.random().toString(36).slice(2, 6);
  return `rec_${ts}_${r}`;
}

function appendActionsFromRun(
  actions: FactoryAction[],
  run: FactoryRun,
  latestRunPath: string,
): void {
  // Active runs always heartbeat. Shadow runs also heartbeat (the
  // supervisor writes latest-run regardless of mode for failed/ambiguous
  // /passed end states), so we surface the action either way.
  actions.push({ type: "write_latest_run", path: latestRunPath });
  if (run.alerting.correlatedLegacyAlertIds.length > 0) {
    actions.push({
      type: "suppress_duplicate_alert",
      legacyAlertIds: run.alerting.correlatedLegacyAlertIds,
    });
  }
  if (run.alerting.emittedFactoryAlertId !== null) {
    const severity: "high" | "medium" =
      run.final.classification === "failed" ? "high" : "medium";
    actions.push({
      type: "emit_factory_alert",
      severity,
      alertId: run.alerting.emittedFactoryAlertId,
    });
  }
}

function statusFromObservedAndResult(
  observed: ObservedFactoryState,
  result: FactoryRunResult,
): FactoryStatus {
  if (observed.mode.killSwitchActive) return "disabled";
  if (observed.mode.effectiveMode === "disabled") return "disabled";
  if (observed.lock.active) return "locked";
  // After running, the run's classification is more authoritative than
  // freshness — the supervisor just wrote latest-run.
  if (result.ran) {
    if (result.classification === "failed") return "failed";
    if (result.classification === "ambiguous") return "ambiguous";
    if (result.classification === "passed") return "fresh";
  }
  // Didn't run (observe mode, or other no-op). Defer to staleness of
  // the existing latest-run record.
  if (observed.latestRun.freshness === "missing") return "missing";
  if (observed.latestRun.freshness === "stale") return "stale";
  if (observed.latestRun.classification === "failed") return "failed";
  if (observed.latestRun.classification === "ambiguous") return "ambiguous";
  return "fresh";
}

// --- invariants ----------------------------------------------------------

export function checkInvariants(
  rec: Omit<FactoryReconciliation, "invariants">,
): InvariantCheck[] {
  const checks: InvariantCheck[] = [];
  const o = rec.observed;
  const a = rec.actions;
  const r = rec.result;

  const has = (t: FactoryAction["type"]): boolean =>
    a.some((x) => x.type === t);

  // I1: kill switch active → no lease, no verifier, no repair, no ledger, no alert
  checks.push({
    id: "I1",
    name: "kill switch wins before lease/verifier/repair/ledger/alert",
    held:
      !o.mode.killSwitchActive ||
      (!has("supervise_run") && !has("emit_factory_alert") && r.ran === false),
    detail: o.mode.killSwitchActive
      ? "kill switch active; no run/alert allowed"
      : "n/a",
  });

  // I5: latest-run is written for passed/failed/ambiguous runs
  checks.push({
    id: "I5",
    name: "latest-run written for every active/shadow run that produced a classification",
    held: !r.ran || has("write_latest_run"),
    detail:
      r.ran && !has("write_latest_run")
        ? "ran but no write_latest_run action"
        : "n/a",
  });

  // I6: failed/ambiguous → at most one alert
  checks.push({
    id: "I6",
    name: "failed/ambiguous active run emits at most one alert",
    held: a.filter((x) => x.type === "emit_factory_alert").length <= 1,
    detail: "any-mode",
  });

  // I7: legacy alert during run suppresses factory duplicate
  checks.push({
    id: "I7",
    name: "legacy alert correlation suppresses factory duplicate",
    held:
      r.correlatedLegacyAlertIds.length === 0 ||
      r.emittedAlertId === null ||
      // shadow mode never emits regardless; the suppression rule applies
      // when the factory would otherwise emit but a legacy correlation
      // exists. Active+correlated → emittedAlertId must be null.
      o.mode.effectiveMode === "shadow",
    detail:
      r.correlatedLegacyAlertIds.length > 0 && r.emittedAlertId !== null
        ? "legacy alert correlated AND factory still emitted"
        : "n/a",
  });

  // I8: passed runs emit no alert
  checks.push({
    id: "I8",
    name: "passed runs emit no alert",
    held: r.classification !== "passed" || r.emittedAlertId === null,
    detail: r.classification === "passed" ? "must be silent" : "n/a",
  });

  // I13: observe mode does not run primary or repair
  checks.push({
    id: "I13",
    name: "observe mode does not run primary or repair",
    held:
      o.mode.effectiveMode !== "observe" ||
      (!r.ran && r.primaryStatus === "skipped" && r.repairStatus === "skipped"),
    detail: o.mode.effectiveMode === "observe" ? "no lane work" : "n/a",
  });

  // I14: shadow mode runs the factory but does not modify launchd
  checks.push({
    id: "I14",
    name: "shadow mode is allowed to run the lane (without launchd changes)",
    held:
      o.mode.effectiveMode !== "shadow" ||
      r.ran === true ||
      // It's also valid for shadow to be locked; that's not a violation.
      o.lock.active,
    detail: "shadow mode requires execution unless blocked",
  });

  // I15: only active mode is canonical scheduled operation. Shadow runs
  // produce evidence but never emit. The reconciler honors this by
  // pulling emit-decisions from the supervisor (which is mode-aware);
  // this check is a guard rail.
  checks.push({
    id: "I15",
    name: "shadow mode never emits a factory alert",
    held: o.mode.effectiveMode !== "shadow" || r.emittedAlertId === null,
    detail:
      o.mode.effectiveMode === "shadow" && r.emittedAlertId !== null
        ? "shadow run emitted alert (forbidden)"
        : "n/a",
  });

  return checks;
}

// --- main entry ----------------------------------------------------------

export async function reconcileLocalSmokeFactory(
  intent: FactoryIntent,
  opts: ReconcileOptions = {},
): Promise<FactoryReconciliation> {
  const clock = opts.clock ?? (() => new Date());
  const spec = opts.spec ?? (loadSpec() as unknown as SupervisorSpec);
  const startedAt = clock();
  const runId = newReconciliationRunId(startedAt);

  const observeOpts: ObserveOpts = { spec, clock };
  if (opts.alertReader !== undefined) {
    observeOpts.alertReader = opts.alertReader;
  }
  const observed = observeFactory(intent, observeOpts);

  const actions: FactoryAction[] = decideActions(intent, observed);
  let result: FactoryRunResult;

  // The decided action list opens with one of:
  //   kill_switch_short_circuit | noop | lease_blocked | observe_only | supervise_run
  const head = actions[0];
  if (head === undefined || head.type !== "supervise_run") {
    result = emptyRunResult(
      head?.type === "kill_switch_short_circuit"
        ? `kill switch active at ${observed.mode.killSwitchPath}`
        : head?.type === "lease_blocked"
          ? head.reason
          : head?.type === "observe_only"
            ? "observe mode — no lane work"
            : head?.type === "noop"
              ? head.reason
              : "no action decided",
    );
  } else {
    // Apply: delegate to superviseFactoryRun. The supervisor enforces
    // the run-time invariants (kill-switch re-check is redundant but
    // safe; lease acquisition is authoritative, etc.). The reconciler
    // surfaces the resulting actions in its action log.
    const inner: SuperviseOptions = {
      trigger: intent.trigger,
      modeOverride: head.mode,
      spec,
      clock,
      ...(opts.ledgerEnabled !== undefined
        ? { ledgerEnabled: opts.ledgerEnabled }
        : {}),
      ...(opts.emitAlertEnabled !== undefined
        ? { emitAlertEnabled: opts.emitAlertEnabled }
        : {}),
      ...(opts.primaryRunner !== undefined
        ? { primaryRunner: opts.primaryRunner }
        : {}),
      ...(opts.innerRunner !== undefined
        ? { innerRunner: opts.innerRunner }
        : {}),
      ...(opts.repairRunner !== undefined
        ? { repairRunner: opts.repairRunner }
        : {}),
      ...(opts.alertReader !== undefined
        ? { alertReader: opts.alertReader }
        : {}),
      ...(opts.skipInnerCheck !== undefined
        ? { skipInnerCheck: opts.skipInnerCheck }
        : {}),
    };
    const run = opts.superviseOverride
      ? await opts.superviseOverride(inner)
      : await superviseFactoryRun(inner);

    if (run.lease.acquired === false) {
      // Race: nobody owned the lock at observe time, but acquisition
      // failed (concurrent reconciler). Reflect that in the action log
      // and the result without a write_latest_run.
      actions.splice(0, 1, {
        type: "lease_blocked",
        holderRunId: run.lease.blockedBy?.runId ?? null,
        reason: "lease blocked at acquisition time",
      });
      result = emptyRunResult("lease blocked during apply");
      result.run = run;
    } else {
      appendActionsFromRun(actions, run, run.artifacts.latestRunPath);
      result = {
        ran: true,
        classification: run.final.classification,
        primaryStatus: run.primary.status,
        repairStatus: run.repair.status,
        emittedAlertId: run.alerting.emittedFactoryAlertId,
        correlatedLegacyAlertIds: run.alerting.correlatedLegacyAlertIds,
        ownership: run.alerting.ownership,
        detail: run.final.detail,
        run,
      };
    }
  }

  const finishedAt = clock().toISOString();
  const finalStatus: FactoryStatus = statusFromObservedAndResult(
    observed,
    result,
  );

  const recBase: Omit<FactoryReconciliation, "invariants"> = {
    schema: "frontier_os.factory_reconciliation.v1",
    runId,
    factoryId: "ai-stack-local-smoke",
    startedAt: startedAt.toISOString(),
    finishedAt,
    desired: intent,
    observed,
    actions,
    result,
    status: finalStatus,
  };
  const invariants = checkInvariants(recBase);
  return { ...recBase, invariants };
}

// CLI entry — `node --import tsx factories/<lane>/reconciler.ts [--mode active]`
const isMain =
  process.argv[1] !== undefined &&
  fileURLToPath(import.meta.url) === resolve(process.argv[1]);
if (isMain) {
  const argv = process.argv.slice(2);
  const triggerIdx = argv.indexOf("--trigger");
  const trigger: LatestRunTrigger =
    triggerIdx >= 0 && argv[triggerIdx + 1]
      ? (argv[triggerIdx + 1] as LatestRunTrigger)
      : "manual";
  const modeIdx = argv.indexOf("--mode");
  const desiredMode: FactoryIntent["desiredMode"] =
    modeIdx >= 0 && argv[modeIdx + 1]
      ? (argv[modeIdx + 1] as FactoryIntent["desiredMode"])
      : "shadow";
  const intent: FactoryIntent = {
    factoryId: "ai-stack-local-smoke",
    desiredMode,
    trigger,
    staleAfterHours: 26,
  };
  reconcileLocalSmokeFactory(intent)
    .then((rec) => {
      process.stdout.write(`${JSON.stringify(rec, null, 2)}\n`);
      // Exit code parity with `frontier factory status`:
      //   0 fresh | 1 stale|missing | 2 failed | 3 ambiguous | 4 disabled | 5 locked
      const code =
        rec.status === "fresh"
          ? 0
          : rec.status === "stale" || rec.status === "missing"
            ? 1
            : rec.status === "failed"
              ? 2
              : rec.status === "ambiguous"
                ? 3
                : rec.status === "disabled"
                  ? 4
                  : 5;
      process.exit(code);
    })
    .catch((err: unknown) => {
      const msg =
        err instanceof Error ? (err.stack ?? err.message) : String(err);
      process.stderr.write(`reconciler crashed: ${msg}\n`);
      process.exit(6);
    });
}

// Re-export ledgerDb resolver / alert reader stubs the supervisor uses so
// that the reconciler can be a one-stop import for callers and tests.
export type { Lease } from "./lease.ts";
export type { AlertRecordLike, Ownership } from "./alert-ownership.ts";
export type { LatestRun } from "./latest-run.ts";
export const _internal = { homedir };
