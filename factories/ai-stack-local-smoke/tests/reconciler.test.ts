// reconciler tests — fixture-driven; no live launchd, no real spawn.
//
// The reconciler is a control loop:
//   observe → decide → apply → assert invariants → record.
//
// These tests assert two things:
//   (A) the state-machine table — every row from the design doc has
//       exactly one row in this file with the expected actions[] and
//       status.
//   (B) the 15 dark-factory invariants hold across the relevant rows.

import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, rmSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  decideActions,
  observeFactory,
  reconcileLocalSmokeFactory,
  type FactoryIntent,
  type ObservedFactoryState,
  type ReconcileOptions,
} from "../reconciler.ts";
import { type FactoryRun, type SupervisorSpec } from "../supervisor.ts";
import { type RepairResult } from "../run.ts";

const HERE = fileURLToPath(import.meta.url);
const REPO_ROOT = resolve(dirname(HERE), "..", "..", "..");
const STATE_DIR = resolve(
  REPO_ROOT,
  "factories",
  "ai-stack-local-smoke",
  "state",
);
const LOCK_PATH = resolve(STATE_DIR, "lock.json");
const LATEST_RUN_PATH = resolve(STATE_DIR, "latest-run.json");
const MODE_PATH = resolve(STATE_DIR, "mode.json");
const KILL_SWITCH_PATH = resolve(STATE_DIR, "disabled");

function cleanState(): void {
  rmSync(LOCK_PATH, { force: true });
  rmSync(LATEST_RUN_PATH, { force: true });
  rmSync(MODE_PATH, { force: true });
  rmSync(KILL_SWITCH_PATH, { force: true });
}

function refusalGuard(): void {
  if (existsSync(KILL_SWITCH_PATH)) {
    throw new Error(
      `refusing to run: real kill switch is armed at ${KILL_SWITCH_PATH}`,
    );
  }
  if (existsSync(LOCK_PATH)) {
    throw new Error(
      `refusing to run: stale lock at ${LOCK_PATH} — clean up first`,
    );
  }
}

function intent(
  desiredMode: FactoryIntent["desiredMode"] = "shadow",
): FactoryIntent {
  return {
    factoryId: "ai-stack-local-smoke",
    desiredMode,
    trigger: "manual",
    staleAfterHours: 26,
  };
}

function baseReconcileOpts(
  overrides: Partial<ReconcileOptions> = {},
): ReconcileOptions {
  return {
    ledgerEnabled: false,
    emitAlertEnabled: false,
    primaryRunner: () => ({
      exitCode: 0,
      stdout: "ok",
      stderr: "",
      durationMs: 1,
    }),
    innerRunner: () => ({
      exitCode: 0,
      stdout: JSON.stringify({ passed: 18, failed: 0, toolCount: 18 }),
      stderr: "",
      durationMs: 1,
    }),
    repairRunner: (): RepairResult => ({
      ran: true,
      kind: "verify-timeout-config",
      status: "ok",
      observedTimeoutSeconds: 60,
      minRequiredSeconds: 60,
      detail: "ok",
    }),
    alertReader: () => [],
    skipInnerCheck: false,
    ...overrides,
  };
}

// =========================================================================
// (B) Invariant helpers
// =========================================================================

function assertAllInvariantsHeld(
  rec: Awaited<ReturnType<typeof reconcileLocalSmokeFactory>>,
): void {
  const broken = rec.invariants.filter((i) => !i.held);
  assert.deepEqual(
    broken.map((i) => `${i.id} ${i.name}`),
    [],
    "no invariants should be violated",
  );
}

// =========================================================================
// (A) State-machine table — one test per row
// =========================================================================

// --- row: kill switch active ---------------------------------------------

test("[table] kill switch active → kill_switch_short_circuit, status=disabled, no run", async () => {
  refusalGuard();
  cleanState();
  try {
    writeFileSync(KILL_SWITCH_PATH, "test\n");
    let primaryCalls = 0;
    let repairCalls = 0;
    const rec = await reconcileLocalSmokeFactory(
      intent("active"),
      baseReconcileOpts({
        primaryRunner: () => {
          primaryCalls++;
          return { exitCode: 0, stdout: "", stderr: "", durationMs: 0 };
        },
        repairRunner: () => {
          repairCalls++;
          return {
            ran: true,
            kind: "verify-timeout-config",
            status: "ok",
            observedTimeoutSeconds: 60,
            minRequiredSeconds: 60,
            detail: "ok",
          };
        },
      }),
    );
    assert.equal(rec.observed.mode.killSwitchActive, true);
    assert.equal(rec.observed.mode.effectiveMode, "disabled");
    assert.equal(rec.actions[0]?.type, "kill_switch_short_circuit");
    assert.equal(rec.result.ran, false);
    assert.equal(primaryCalls, 0);
    assert.equal(repairCalls, 0);
    assert.equal(rec.status, "disabled");
    // I1: kill switch wins everywhere
    assertAllInvariantsHeld(rec);
  } finally {
    cleanState();
  }
});

// --- row: explicit disabled (no kill switch) ------------------------------

test("[table] mode=disabled (no kill switch) → noop, status=disabled, no run", async () => {
  refusalGuard();
  cleanState();
  try {
    writeFileSync(
      MODE_PATH,
      JSON.stringify({ mode: "disabled", setBy: "test" }),
    );
    let primaryCalls = 0;
    const rec = await reconcileLocalSmokeFactory(
      intent("active"),
      baseReconcileOpts({
        primaryRunner: () => {
          primaryCalls++;
          return { exitCode: 0, stdout: "", stderr: "", durationMs: 0 };
        },
      }),
    );
    assert.equal(rec.observed.mode.killSwitchActive, false);
    assert.equal(rec.observed.mode.runtimeMode, "disabled");
    assert.equal(rec.actions[0]?.type, "noop");
    assert.equal(rec.result.ran, false);
    assert.equal(primaryCalls, 0);
    assert.equal(rec.status, "disabled");
    assertAllInvariantsHeld(rec);
  } finally {
    cleanState();
  }
});

// --- row: lock active → locked --------------------------------------------

test("[table] active live lock → lease_blocked, status=locked, no run", async () => {
  refusalGuard();
  cleanState();
  try {
    writeFileSync(
      LOCK_PATH,
      JSON.stringify({
        factoryId: "ai-stack-local-smoke",
        runId: "run_someone_else",
        pid: process.pid, // live process so it's "active"
        acquiredAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
      }),
    );
    let primaryCalls = 0;
    const rec = await reconcileLocalSmokeFactory(
      intent("active"),
      baseReconcileOpts({
        primaryRunner: () => {
          primaryCalls++;
          return { exitCode: 0, stdout: "", stderr: "", durationMs: 0 };
        },
      }),
    );
    assert.equal(rec.observed.lock.active, true);
    assert.equal(rec.actions[0]?.type, "lease_blocked");
    assert.equal(rec.result.ran, false);
    assert.equal(primaryCalls, 0);
    assert.equal(rec.status, "locked");
    assertAllInvariantsHeld(rec);
  } finally {
    cleanState();
  }
});

// --- row: observe mode → no run -------------------------------------------

test("[table] mode=observe → observe_only, no run; status reflects existing latest-run staleness", async () => {
  refusalGuard();
  cleanState();
  try {
    writeFileSync(MODE_PATH, JSON.stringify({ mode: "observe" }));
    let primaryCalls = 0;
    let repairCalls = 0;
    const rec = await reconcileLocalSmokeFactory(
      intent("observe"),
      baseReconcileOpts({
        primaryRunner: () => {
          primaryCalls++;
          return { exitCode: 0, stdout: "", stderr: "", durationMs: 0 };
        },
        repairRunner: () => {
          repairCalls++;
          return {
            ran: true,
            kind: "verify-timeout-config",
            status: "ok",
            observedTimeoutSeconds: 60,
            minRequiredSeconds: 60,
            detail: "ok",
          };
        },
      }),
    );
    assert.equal(rec.observed.mode.effectiveMode, "observe");
    assert.equal(rec.actions[0]?.type, "observe_only");
    assert.equal(rec.result.ran, false);
    assert.equal(primaryCalls, 0);
    assert.equal(repairCalls, 0);
    // No latest-run on disk → status missing.
    assert.equal(rec.status, "missing");
    assertAllInvariantsHeld(rec);
    // I13: observe mode does not run primary or repair
    const i13 = rec.invariants.find((i) => i.id === "I13");
    assert.ok(i13?.held);
  } finally {
    cleanState();
  }
});

// --- row: shadow + passed primary + ok repair → ran, status=fresh ---------

test("[table] shadow + passed → supervise_run + write_latest_run, status=fresh, no alert", async () => {
  refusalGuard();
  cleanState();
  try {
    const rec = await reconcileLocalSmokeFactory(
      intent("shadow"),
      baseReconcileOpts(),
    );
    assert.equal(rec.observed.mode.effectiveMode, "shadow");
    assert.equal(rec.actions[0]?.type, "supervise_run");
    assert.equal(rec.result.ran, true);
    assert.equal(rec.result.classification, "passed");
    assert.equal(rec.result.emittedAlertId, null);
    assert.ok(rec.actions.some((a) => a.type === "write_latest_run"));
    assert.equal(
      rec.actions.some((a) => a.type === "emit_factory_alert"),
      false,
    );
    assert.equal(rec.status, "fresh");
    assertAllInvariantsHeld(rec);
  } finally {
    cleanState();
  }
});

// --- row: active + failed primary → ran, alert emitted, status=failed -----

test("[table] active + failed primary → emit_factory_alert, status=failed", async () => {
  refusalGuard();
  cleanState();
  try {
    writeFileSync(MODE_PATH, JSON.stringify({ mode: "active" }));
    const rec = await reconcileLocalSmokeFactory(
      intent("active"),
      baseReconcileOpts({
        primaryRunner: () => ({
          exitCode: 1,
          stdout: "",
          stderr: "fail",
          durationMs: 1,
        }),
      }),
    );
    assert.equal(rec.observed.mode.effectiveMode, "active");
    assert.equal(rec.result.ran, true);
    assert.equal(rec.result.classification, "failed");
    assert.ok(
      rec.actions.some((a) => a.type === "emit_factory_alert"),
      "should emit one factory alert on active+failed",
    );
    const emits = rec.actions.filter((a) => a.type === "emit_factory_alert");
    assert.equal(emits.length, 1, "I6: at most one alert");
    assert.equal(rec.status, "failed");
    assertAllInvariantsHeld(rec);
  } finally {
    cleanState();
  }
});

// --- row: active + ambiguous primary → ran, alert emitted, status=ambiguous

test("[table] active + ambiguous primary (timeout) → emit_factory_alert(medium), status=ambiguous", async () => {
  refusalGuard();
  cleanState();
  try {
    writeFileSync(MODE_PATH, JSON.stringify({ mode: "active" }));
    const rec = await reconcileLocalSmokeFactory(
      intent("active"),
      baseReconcileOpts({
        primaryRunner: () => ({
          exitCode: -1,
          stdout: "",
          stderr: "ETIMEDOUT",
          durationMs: 1,
        }),
      }),
    );
    assert.equal(rec.result.ran, true);
    assert.equal(rec.result.classification, "ambiguous");
    const emits = rec.actions.filter((a) => a.type === "emit_factory_alert");
    assert.equal(emits.length, 1);
    assert.equal(emits[0]?.severity, "medium");
    assert.equal(rec.status, "ambiguous");
    assertAllInvariantsHeld(rec);
  } finally {
    cleanState();
  }
});

// --- row: active + failed primary + legacy alert → suppress, no factory alert

test("[table] active + failed + legacy alert during run → suppress_duplicate_alert; no factory alert", async () => {
  refusalGuard();
  cleanState();
  try {
    writeFileSync(MODE_PATH, JSON.stringify({ mode: "active" }));
    const legacyAlert = {
      alertId: "ai-stack.local-smoke-nightly#legacy",
      source: "ai-stack.local-smoke-nightly",
      summary: "AI Stack local smoke failed",
      ts: new Date().toISOString(),
    };
    const rec = await reconcileLocalSmokeFactory(
      intent("active"),
      baseReconcileOpts({
        primaryRunner: () => ({
          exitCode: 1,
          stdout: "",
          stderr: "fail",
          durationMs: 1,
        }),
        // Empty before; legacy alert appears after primary runs.
        alertReader: (() => {
          let calls = 0;
          return () => {
            calls += 1;
            return calls === 1 ? [] : [legacyAlert];
          };
        })(),
      }),
    );
    assert.equal(rec.result.ran, true);
    assert.equal(rec.result.classification, "failed");
    assert.equal(
      rec.result.emittedAlertId,
      null,
      "I7: legacy alert correlates → no factory duplicate",
    );
    assert.ok(
      rec.actions.some((a) => a.type === "suppress_duplicate_alert"),
      "should record the suppression action",
    );
    assert.equal(
      rec.actions.some((a) => a.type === "emit_factory_alert"),
      false,
      "I7: factory must not emit",
    );
    assertAllInvariantsHeld(rec);
  } finally {
    cleanState();
  }
});

// --- row: shadow + failed → run + write_latest_run, NO factory alert ------

test("[table] shadow + failed → no factory alert (shadow never emits) (I15)", async () => {
  refusalGuard();
  cleanState();
  try {
    const rec = await reconcileLocalSmokeFactory(
      intent("shadow"),
      baseReconcileOpts({
        primaryRunner: () => ({
          exitCode: 1,
          stdout: "",
          stderr: "fail",
          durationMs: 1,
        }),
      }),
    );
    assert.equal(rec.result.ran, true);
    assert.equal(rec.result.classification, "failed");
    assert.equal(
      rec.result.emittedAlertId,
      null,
      "I15: shadow runs never emit factory alerts",
    );
    assert.equal(rec.status, "failed");
    assertAllInvariantsHeld(rec);
  } finally {
    cleanState();
  }
});

// =========================================================================
// (B) Invariant tests — explicit assertions per ID
// =========================================================================

test("[invariants] decideActions is a pure function of observed state", () => {
  // Same observed → same actions. No side effects.
  const observed: ObservedFactoryState = {
    observedAt: new Date().toISOString(),
    factoryId: "ai-stack-local-smoke",
    mode: {
      defaultMode: "shadow",
      runtimeMode: null,
      effectiveMode: "active",
      killSwitchActive: false,
      killSwitchPath: "/tmp/disabled",
    },
    lock: {
      exists: false,
      active: false,
      stale: false,
      holderRunId: null,
      expiresAt: null,
    },
    latestRun: {
      exists: false,
      classification: null,
      finishedAt: null,
      ageHours: null,
      freshness: "missing",
      raw: null,
    },
    alerts: { before: [] },
  };
  const a1 = decideActions(intent("active"), observed);
  const a2 = decideActions(intent("active"), observed);
  assert.deepEqual(a1, a2);
});

test("[invariants] observeFactory does not mutate state files", () => {
  refusalGuard();
  cleanState();
  try {
    observeFactory(intent("shadow"), { alertReader: () => [] });
    // No state files should have been written.
    assert.equal(existsSync(LOCK_PATH), false);
    assert.equal(existsSync(LATEST_RUN_PATH), false);
    assert.equal(existsSync(MODE_PATH), false);
    assert.equal(existsSync(KILL_SWITCH_PATH), false);
  } finally {
    cleanState();
  }
});

test("[invariants] I1 — kill switch wins over an explicit active intent", async () => {
  refusalGuard();
  cleanState();
  try {
    writeFileSync(KILL_SWITCH_PATH, "test\n");
    const rec = await reconcileLocalSmokeFactory(
      intent("active"),
      baseReconcileOpts(),
    );
    const i1 = rec.invariants.find((i) => i.id === "I1");
    assert.ok(i1?.held, `I1 violated: ${i1?.detail}`);
    assert.equal(rec.result.ran, false);
    assert.equal(
      rec.actions.some((a) => a.type === "supervise_run"),
      false,
    );
  } finally {
    cleanState();
  }
});

test("[invariants] I8 — passed run emits no alert", async () => {
  refusalGuard();
  cleanState();
  try {
    const rec = await reconcileLocalSmokeFactory(
      intent("active"),
      baseReconcileOpts(),
    );
    assert.equal(rec.result.classification, "passed");
    const i8 = rec.invariants.find((i) => i.id === "I8");
    assert.ok(i8?.held);
    assert.equal(rec.result.emittedAlertId, null);
  } finally {
    cleanState();
  }
});

test("[invariants] I5 — every classified run heartbeats latest-run", async () => {
  refusalGuard();
  cleanState();
  try {
    const rec = await reconcileLocalSmokeFactory(
      intent("active"),
      baseReconcileOpts({
        primaryRunner: () => ({
          exitCode: 1,
          stdout: "",
          stderr: "x",
          durationMs: 1,
        }),
      }),
    );
    const i5 = rec.invariants.find((i) => i.id === "I5");
    assert.ok(i5?.held);
    assert.ok(rec.actions.some((a) => a.type === "write_latest_run"));
  } finally {
    cleanState();
  }
});

test("[invariants] I6 — at most one factory alert per reconciliation", async () => {
  refusalGuard();
  cleanState();
  try {
    const rec = await reconcileLocalSmokeFactory(
      intent("active"),
      baseReconcileOpts({
        primaryRunner: () => ({
          exitCode: 1,
          stdout: "",
          stderr: "x",
          durationMs: 1,
        }),
      }),
    );
    const emits = rec.actions.filter((a) => a.type === "emit_factory_alert");
    assert.ok(emits.length <= 1);
    const i6 = rec.invariants.find((i) => i.id === "I6");
    assert.ok(i6?.held);
  } finally {
    cleanState();
  }
});

test("[invariants] FactoryReconciliation has stable schema marker", async () => {
  refusalGuard();
  cleanState();
  try {
    writeFileSync(KILL_SWITCH_PATH, "test\n");
    const rec = await reconcileLocalSmokeFactory(
      intent("shadow"),
      baseReconcileOpts(),
    );
    assert.equal(rec.schema, "frontier_os.factory_reconciliation.v1");
    assert.equal(typeof rec.runId, "string");
    assert.ok(rec.runId.startsWith("rec_"));
    assert.deepEqual(rec.desired, intent("shadow"));
    assert.ok(rec.observed.observedAt);
    assert.ok(Array.isArray(rec.actions));
    assert.ok(Array.isArray(rec.invariants));
  } finally {
    cleanState();
  }
});

test("[invariants] reconciler does not retry on failure (PR #7 policy)", async () => {
  refusalGuard();
  cleanState();
  try {
    let primaryCalls = 0;
    const rec = await reconcileLocalSmokeFactory(
      intent("active"),
      baseReconcileOpts({
        primaryRunner: () => {
          primaryCalls += 1;
          return { exitCode: 1, stdout: "", stderr: "x", durationMs: 1 };
        },
      }),
    );
    // Exactly one primary invocation. No retry loop.
    assert.equal(primaryCalls, 1);
    assert.equal(rec.result.classification, "failed");
  } finally {
    cleanState();
  }
});

// --- mode override correctness -------------------------------------------

test("[reconciler] desiredMode=shadow with no runtime override → shadow run", async () => {
  refusalGuard();
  cleanState();
  try {
    const rec = await reconcileLocalSmokeFactory(
      intent("shadow"),
      baseReconcileOpts(),
    );
    assert.equal(rec.observed.mode.runtimeMode, null);
    // factory.json default is "shadow" so effective is shadow.
    assert.equal(rec.observed.mode.effectiveMode, "shadow");
    assert.equal(rec.result.ran, true);
  } finally {
    cleanState();
  }
});

test("[reconciler] runtime mode.json overrides factory.json default", async () => {
  refusalGuard();
  cleanState();
  try {
    writeFileSync(MODE_PATH, JSON.stringify({ mode: "active" }));
    const rec = await reconcileLocalSmokeFactory(
      intent("shadow"),
      baseReconcileOpts(),
    );
    assert.equal(rec.observed.mode.runtimeMode, "active");
    assert.equal(rec.observed.mode.effectiveMode, "active");
  } finally {
    cleanState();
  }
});
