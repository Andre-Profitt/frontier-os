// Factory Supervisor — owns the dark-factory run lifecycle.
//
//   trigger
//   → acquire lease
//   → check kill switch
//   → capture pre-state (alerts before)
//   → run primary verifier (the lane script)
//   → run inner check (supplementary)
//   → run bounded repair (read-only)
//   → derive final classification
//   → reconcile alerts (legacy ↔ factory ownership)
//   → write run-ledger
//   → write latest-run heartbeat
//   → emit at most one alert
//   → release lease
//
// Returns a FactoryRun record — the durable representation of one
// scheduled execution. The supervisor does not orchestrate scheduling;
// launchd does that. The supervisor only owns what happens inside one
// invocation.

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { newSessionId } from "../../src/ledger/events.ts";
import { getLedger } from "../../src/ledger/index.ts";
import {
  reconcileAlerts,
  type AlertRecordLike,
  type Ownership,
} from "./alert-ownership.ts";
import { acquireLease, releaseLease, type Lease } from "./lease.ts";
import {
  writeLatestRun,
  type LatestRun,
  type LatestRunMode,
  type LatestRunTrigger,
} from "./latest-run.ts";
import {
  classifyPrimaryVerifier,
  classifyInnerCheck,
  deriveFinalClassification,
  isKillSwitchActive,
  killSwitchPath,
  loadSpec as loadFactorySpec,
  runBoundedRepair,
  runInnerCheck,
  runPrimaryVerifier,
  type FactorySpec as RunFactorySpec,
  type InnerCheckResult,
  type PrimaryStatus,
  type RepairResult,
} from "./run.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, "..", "..");
const SUBPROCESS_TIMEOUT_MS = 5_000;

// --- types ---------------------------------------------------------------

export interface SupervisorSpec extends RunFactorySpec {
  activation: {
    defaultMode: LatestRunMode;
    staleAfterHours: number;
    leaseTtlSeconds: number;
    leaseLockFile: string;
    modeFile: string;
    latestRunFile: string;
    plistBackupDir: string;
  };
}

interface ModeFile {
  mode: LatestRunMode;
  setBy?: string;
  setAt?: string;
}

// Resolve effective mode per spec priority:
//   1. state/disabled (kill switch) → "disabled" effective mode
//   2. state/mode.json (runtime override) → mode from that file
//   3. factory.json activation.defaultMode → static default
function resolveMode(
  spec: SupervisorSpec,
  override: LatestRunMode | undefined,
  killSwitchActive: boolean,
): {
  mode: LatestRunMode;
  source: "kill-switch" | "override" | "mode-file" | "default";
} {
  if (override) return { mode: override, source: "override" };
  if (killSwitchActive) return { mode: "disabled", source: "kill-switch" };
  const modePath = resolve(REPO_ROOT, spec.activation.modeFile);
  if (existsSync(modePath)) {
    try {
      const parsed = JSON.parse(readFileSync(modePath, "utf8")) as ModeFile;
      if (
        parsed.mode === "observe" ||
        parsed.mode === "shadow" ||
        parsed.mode === "active" ||
        parsed.mode === "disabled"
      ) {
        return { mode: parsed.mode, source: "mode-file" };
      }
    } catch {
      // fall through to default
    }
  }
  return { mode: spec.activation.defaultMode, source: "default" };
}

export interface FactoryRun {
  runId: string;
  factoryId: string;
  trigger: LatestRunTrigger;
  mode: LatestRunMode;
  startedAt: string;
  finishedAt: string;
  lease: {
    acquired: boolean;
    staleRecovered: boolean;
    expiresAt: string | null;
    blockedBy: Lease | null;
  };
  killSwitchActive: boolean;
  primary: {
    status: PrimaryStatus;
    exitCode: number;
    durationMs: number;
    detail: string;
  };
  inner: InnerCheckResult | null;
  repair: RepairResult;
  final: {
    classification: "passed" | "failed" | "ambiguous";
    escalations: string[];
    detail: string;
  };
  alerting: {
    correlatedLegacyAlertIds: string[];
    emittedFactoryAlertId: string | null;
    ownership: Ownership;
    reason: string;
  };
  artifacts: {
    latestRunPath: string;
    evidencePath: string;
    ledgerSessionId: string | null;
  };
}

export interface SuperviseOptions {
  trigger?: LatestRunTrigger;
  modeOverride?: LatestRunMode;
  // Test seams. Production callers leave these undefined.
  spec?: SupervisorSpec;
  clock?: () => Date;
  ledgerEnabled?: boolean;
  emitAlertEnabled?: boolean;
  primaryRunner?: (
    spec: SupervisorSpec,
  ) => ReturnType<typeof runPrimaryVerifier>;
  innerRunner?: (spec: SupervisorSpec) => ReturnType<typeof runInnerCheck>;
  repairRunner?: (spec: SupervisorSpec) => RepairResult;
  alertReader?: (factorySource: string) => AlertRecordLike[];
  skipInnerCheck?: boolean;
}

// --- helpers -------------------------------------------------------------

function loadSupervisorSpec(): SupervisorSpec {
  return loadFactorySpec() as unknown as SupervisorSpec;
}

function newRunId(now: Date): string {
  const ts = now
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d+Z$/, "Z");
  const r = Math.random().toString(36).slice(2, 6);
  return `run_${ts}_${r}`;
}

function newAlertId(factoryId: string, runId: string): string {
  return `factory.${factoryId}-${runId}`;
}

function readRecentAlerts(
  factorySource: string,
  ledgerDb: string,
): AlertRecordLike[] {
  if (!existsSync(ledgerDb)) return [];
  const since = new Date(Date.now() - 24 * 3600 * 1000).toISOString();
  const sql = [
    "PRAGMA query_only = 1;",
    "SELECT",
    "  COALESCE(json_extract(payload, '$.alertId'), event_id) AS alert_id,",
    "  COALESCE(json_extract(payload, '$.source'), actor, 'unknown') AS source,",
    "  COALESCE(json_extract(payload, '$.summary'), '') AS summary,",
    "  ts",
    "FROM events",
    "WHERE kind = 'alert'",
    `  AND ts >= '${since}'`,
    "ORDER BY ts DESC",
    "LIMIT 50;",
  ].join("\n");
  const res = spawnSync("sqlite3", ["-separator", "\t", ledgerDb, sql], {
    encoding: "utf8",
    timeout: SUBPROCESS_TIMEOUT_MS,
  });
  if (res.status !== 0) return [];
  const out = res.stdout ?? "";
  if (out.trim().length === 0) return [];
  const records: AlertRecordLike[] = [];
  for (const line of out.split("\n").filter(Boolean)) {
    const cols = line.split("\t");
    records.push({
      alertId: cols[0] ?? "",
      source: cols[1] ?? "",
      summary: cols[2] ?? "",
      ts: cols[3] ?? "",
    });
  }
  void factorySource;
  return records;
}

// --- main entry ----------------------------------------------------------

export async function superviseFactoryRun(
  opts: SuperviseOptions = {},
): Promise<FactoryRun> {
  const clock = opts.clock ?? (() => new Date());
  const startedAtDate = clock();
  const startedAt = startedAtDate.toISOString();
  const spec = opts.spec ?? loadSupervisorSpec();
  const trigger: LatestRunTrigger = opts.trigger ?? "manual";

  const leaseLockPath = resolve(REPO_ROOT, spec.activation.leaseLockFile);
  const latestRunPath = resolve(REPO_ROOT, spec.activation.latestRunFile);
  const ledgerEnabled = opts.ledgerEnabled !== false;
  const emitAlertEnabled = opts.emitAlertEnabled !== false;

  // Resolve mode using the priority chain documented in resolveMode:
  // explicit override > kill-switch (disabled) > state/mode.json > factory.json default.
  // The kill-switch check here happens before mode.json so a flipped switch
  // wins over any mode override the operator may have left configured.
  const killSwitchActive = isKillSwitchActive(spec);
  const modeResolution = resolveMode(spec, opts.modeOverride, killSwitchActive);
  const mode = modeResolution.mode;
  const runId = newRunId(startedAtDate);

  // 1. No-run modes: observe and disabled. Both short-circuit before
  // lease acquisition, the primary verifier, repair, ledger writes, and
  // alert emission. The difference is the label and the escalation:
  //   - observe: factory is monitoring only; no lane work
  //   - disabled (kill switch): emergency stop
  //   - disabled (configured): operator turned the supervisor off
  // killSwitchActive is reported truthfully so the FactoryRun record
  // distinguishes the cause.
  if (mode === "disabled" || mode === "observe") {
    const finishedAt = clock().toISOString();
    const escalation =
      mode === "observe"
        ? "supervisor-observe-mode"
        : modeResolution.source === "kill-switch"
          ? "kill-switch-active"
          : "supervisor-disabled";
    const detail =
      mode === "observe"
        ? "supervisor mode=observe — read-only, no lane work"
        : modeResolution.source === "kill-switch"
          ? `kill switch present at ${killSwitchPath(spec)}`
          : `supervisor mode=disabled (source=${modeResolution.source})`;
    return {
      runId,
      factoryId: spec.factoryId,
      trigger,
      mode,
      startedAt,
      finishedAt,
      lease: {
        acquired: false,
        staleRecovered: false,
        expiresAt: null,
        blockedBy: null,
      },
      killSwitchActive,
      primary: {
        status: "ambiguous",
        exitCode: -1,
        durationMs: 0,
        detail: `${detail} — primary verifier not run`,
      },
      inner: null,
      repair: {
        ran: false,
        kind: spec.boundedRepair.kind,
        status: "skipped",
        observedTimeoutSeconds: null,
        minRequiredSeconds: spec.boundedRepair.minTimeoutSeconds,
        detail,
      },
      final: {
        classification: "ambiguous",
        escalations: [escalation],
        detail,
      },
      alerting: {
        correlatedLegacyAlertIds: [],
        emittedFactoryAlertId: null,
        ownership: "none",
        reason: `${escalation} — no alert ever`,
      },
      artifacts: {
        latestRunPath,
        evidencePath: "",
        ledgerSessionId: null,
      },
    };
  }

  // 2. Acquire lease.
  const leaseResult = acquireLease({
    factoryId: spec.factoryId,
    runId,
    ttlSeconds: spec.activation.leaseTtlSeconds,
    lockPath: leaseLockPath,
    now: () => clock(),
  });
  if (!leaseResult.acquired) {
    const finishedAt = clock().toISOString();
    return {
      runId,
      factoryId: spec.factoryId,
      trigger,
      mode,
      startedAt,
      finishedAt,
      lease: {
        acquired: false,
        staleRecovered: false,
        expiresAt: null,
        blockedBy: leaseResult.blockedBy,
      },
      killSwitchActive: false,
      primary: {
        status: "ambiguous",
        exitCode: -1,
        durationMs: 0,
        detail: `lease blocked: ${leaseResult.detail}`,
      },
      inner: null,
      repair: {
        ran: false,
        kind: spec.boundedRepair.kind,
        status: "skipped",
        observedTimeoutSeconds: null,
        minRequiredSeconds: spec.boundedRepair.minTimeoutSeconds,
        detail: "lease blocked",
      },
      final: {
        classification: "ambiguous",
        escalations: ["lease-blocked"],
        detail: leaseResult.detail,
      },
      alerting: {
        correlatedLegacyAlertIds: [],
        emittedFactoryAlertId: null,
        ownership: "none",
        reason: "lease blocked — no alert",
      },
      artifacts: {
        latestRunPath,
        evidencePath: "",
        ledgerSessionId: null,
      },
    };
  }

  try {
    // (Kill switch is already resolved upstream via resolveMode → mode.
    // If we reached here, mode ∈ {shadow, active} and the lease is held.)

    // 4. Pre-state: read recent alerts before primary run.
    const ledgerDb = resolve(homedir(), ".frontier", "ledger.db");
    const alertsBefore = opts.alertReader
      ? opts.alertReader(spec.alert.source)
      : readRecentAlerts(spec.alert.source, ledgerDb);

    // 5. Open ledger session.
    const sessionId = ledgerEnabled
      ? newSessionId(`factory-${spec.factoryId}`)
      : null;
    const ledger = ledgerEnabled ? getLedger() : null;
    if (ledger && sessionId) {
      ledger.ensureSession({
        sessionId,
        label: `factory:${spec.factoryId}`,
        tags: ["factory", "supervisor", spec.factoryId, mode],
      });
      ledger.appendEvent({
        sessionId,
        kind: "system",
        actor: `factory.${spec.factoryId}`,
        payload: {
          event: "supervisor.run_start",
          factoryId: spec.factoryId,
          runId,
          trigger,
          mode,
          leaseStaleRecovered: leaseResult.staleRecovered,
          startedAt,
        },
      });
    }
    const traceId = `supervisor-${runId}`;
    if (ledger && sessionId) {
      ledger.appendEvent({
        sessionId,
        kind: "ops.repair_start",
        actor: `factory.${spec.factoryId}`,
        traceId,
        payload: { step: "supervise", cmd: spec.lane.primaryVerifier },
      });
    }

    // 6. Run primary verifier.
    const primaryRaw = opts.primaryRunner
      ? opts.primaryRunner(spec)
      : runPrimaryVerifier(spec);
    const primary = classifyPrimaryVerifier(primaryRaw);

    // 7. Inner check (supplementary).
    let inner: InnerCheckResult | null = null;
    if (!opts.skipInnerCheck) {
      const innerRaw = opts.innerRunner
        ? opts.innerRunner(spec)
        : runInnerCheck(spec);
      inner = classifyInnerCheck(innerRaw);
    }

    // 8. Bounded repair.
    const repair = opts.repairRunner
      ? opts.repairRunner(spec)
      : runBoundedRepair(spec);

    // 9. Derive final.
    const final = deriveFinalClassification({
      killSwitchActive: false,
      primary,
      repair,
    });

    // 10. Reconcile alerts.
    const alertsAfter = opts.alertReader
      ? opts.alertReader(spec.alert.source)
      : readRecentAlerts(spec.alert.source, ledgerDb);
    const reconcile = reconcileAlerts({
      finalClassification: final.classification,
      alertsBefore,
      alertsAfter,
      factoryAlertSourcePrefix: spec.alert.source,
      mode,
    });

    // Mint the alertId whenever the reconciler says we should emit. The
    // alertId is part of the durable FactoryRun record; the ledger event
    // is a separate side effect gated on emitAlertEnabled. Decoupling
    // these means a test that disables ledger writes still sees the
    // emission decision in the returned run record.
    let emittedAlertId: string | null = null;
    if (reconcile.shouldEmitFactoryAlert) {
      emittedAlertId = newAlertId(spec.factoryId, runId);
      if (emitAlertEnabled && ledger && sessionId) {
        const severity =
          spec.alert.severityByFinalClassification[final.classification] ??
          "high";
        ledger.appendEvent({
          sessionId,
          kind: "alert",
          actor: `factory.${spec.factoryId}`,
          payload: {
            alertId: emittedAlertId,
            severity,
            category: spec.alert.category,
            source: spec.alert.source,
            summary: `Factory ${spec.factoryId} ${final.classification}: ${final.detail}`,
            classification: final.classification,
            escalations: final.escalations,
            runId,
            mode,
          },
        });
      }
    }

    // 11. Write ops.repair_end.
    const finishedAtDate = clock();
    const finishedAt = finishedAtDate.toISOString();
    const evidencePath = `factories/${spec.factoryId}/evidence/run-${runId}.json`;
    if (ledger && sessionId) {
      ledger.appendEvent({
        sessionId,
        kind: "ops.repair_end",
        actor: `factory.${spec.factoryId}`,
        traceId,
        payload: {
          step: "supervise",
          finalClassification: final.classification,
          primaryStatus: primary.status,
          primaryExit: primaryRaw.exitCode,
          innerClassification: inner?.classification ?? null,
          repairStatus: repair.status,
          escalations: final.escalations,
          alertOwnership: reconcile.ownership,
          correlatedLegacyAlertIds: reconcile.correlatedLegacyAlertIds,
          emittedFactoryAlertId: emittedAlertId,
          mode,
          runId,
          evidencePath,
        },
      });
      ledger.appendEvent({
        sessionId,
        kind: "system",
        actor: `factory.${spec.factoryId}`,
        payload: {
          event: "supervisor.run_end",
          factoryId: spec.factoryId,
          runId,
          classification: final.classification,
          mode,
          finishedAt,
        },
      });
    }

    const run: FactoryRun = {
      runId,
      factoryId: spec.factoryId,
      trigger,
      mode,
      startedAt,
      finishedAt,
      lease: {
        acquired: true,
        staleRecovered: leaseResult.staleRecovered,
        expiresAt: leaseResult.lease?.expiresAt ?? null,
        blockedBy: null,
      },
      killSwitchActive: false,
      primary: {
        status: primary.status,
        exitCode: primaryRaw.exitCode,
        durationMs: primaryRaw.durationMs,
        detail: primary.detail,
      },
      inner,
      repair,
      final: {
        classification: final.classification,
        escalations: final.escalations,
        detail: final.detail,
      },
      alerting: {
        correlatedLegacyAlertIds: reconcile.correlatedLegacyAlertIds,
        emittedFactoryAlertId: emittedAlertId,
        ownership: reconcile.ownership,
        reason: reconcile.reason,
      },
      artifacts: {
        latestRunPath,
        evidencePath,
        ledgerSessionId: sessionId,
      },
    };

    writeLatestRun(latestRunPath, runToLatest(run));
    return run;
  } finally {
    releaseLease(leaseLockPath, runId);
  }
}

function runToLatest(run: FactoryRun): LatestRun {
  return {
    factoryId: run.factoryId,
    runId: run.runId,
    mode: run.mode,
    trigger: run.trigger,
    startedAt: run.startedAt,
    finishedAt: run.finishedAt,
    classification: run.final.classification,
    primaryStatus: run.primary.status,
    repairStatus: run.repair.status,
    escalations: run.final.escalations,
    ledgerSessionId: run.artifacts.ledgerSessionId,
    alertId: run.alerting.emittedFactoryAlertId,
    evidencePath: run.artifacts.evidencePath,
  };
}

// CLI entry — `node --import tsx factories/<lane>/supervisor.ts [--trigger ...]`
const isMain =
  process.argv[1] !== undefined &&
  fileURLToPath(import.meta.url) === resolve(process.argv[1]);
if (isMain) {
  const argv = process.argv.slice(2);
  const triggerIdx = argv.indexOf("--trigger");
  const trigger =
    triggerIdx >= 0 && argv[triggerIdx + 1]
      ? (argv[triggerIdx + 1] as LatestRunTrigger)
      : "manual";
  const modeIdx = argv.indexOf("--mode");
  const modeOverride =
    modeIdx >= 0 && argv[modeIdx + 1]
      ? (argv[modeIdx + 1] as LatestRunMode)
      : undefined;
  const opts: SuperviseOptions = { trigger };
  if (modeOverride !== undefined) {
    opts.modeOverride = modeOverride;
  }
  superviseFactoryRun(opts)
    .then((run) => {
      process.stdout.write(`${JSON.stringify(run, null, 2)}\n`);
      const code =
        run.final.classification === "passed"
          ? 0
          : run.final.classification === "failed"
            ? 1
            : 2;
      process.exit(code);
    })
    .catch((err: unknown) => {
      const msg =
        err instanceof Error ? (err.stack ?? err.message) : String(err);
      process.stderr.write(`supervisor crashed: ${msg}\n`);
      process.exit(3);
    });
}
