// supervisor tests — fixture-driven, no live launchd, no live primary
// verifier spawn, no real ledger writes (ledgerEnabled: false).
//
// Test seams (`primaryRunner`, `innerRunner`, `repairRunner`,
// `alertReader`, `clock`) let us synthesize every code path the
// supervisor handles without depending on the real factory script,
// the real sqlite3 ledger, or the real launchd plist.
//
// The supervisor's lease + heartbeat write to real paths under
// factories/ai-stack-local-smoke/state/. We use modeOverride='disabled'
// where appropriate and clean up state files in finally blocks. A
// dedicated test asserts the real state/disabled file is not created.

import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { superviseFactoryRun, type SuperviseOptions } from "../supervisor.ts";
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
const KILL_SWITCH_PATH = resolve(STATE_DIR, "disabled");

function cleanState(): void {
  rmSync(LOCK_PATH, { force: true });
  rmSync(LATEST_RUN_PATH, { force: true });
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

const stubPrimary = (status: 0 | 1 | -1 = 0) => ({
  exitCode: status,
  stdout: status === 0 ? "ok" : "",
  stderr: "",
  durationMs: 1,
});

const stubInner = (failed = 0) => ({
  exitCode: 0,
  stdout: JSON.stringify({ passed: 18 - failed, failed, toolCount: 18 }),
  stderr: "",
  durationMs: 1,
});

const stubRepair = (status: RepairResult["status"] = "ok"): RepairResult => ({
  ran: status !== "skipped",
  kind: "verify-timeout-config",
  status,
  observedTimeoutSeconds: status === "ok" ? 60 : 30,
  minRequiredSeconds: 60,
  detail: status,
});

function baseOpts(overrides: Partial<SuperviseOptions> = {}): SuperviseOptions {
  return {
    trigger: "manual",
    modeOverride: "shadow",
    ledgerEnabled: false,
    emitAlertEnabled: false,
    primaryRunner: () => stubPrimary(0),
    innerRunner: () => stubInner(0),
    repairRunner: () => stubRepair("ok"),
    alertReader: () => [],
    skipInnerCheck: false,
    ...overrides,
  };
}

// --- mode handling --------------------------------------------------------

test("disabled mode: no lease, no primary, no ledger, no alert; classification=ambiguous", async () => {
  refusalGuard();
  cleanState();
  try {
    const run = await superviseFactoryRun(
      baseOpts({ modeOverride: "disabled" }),
    );
    assert.equal(run.mode, "disabled");
    assert.equal(run.lease.acquired, false);
    assert.equal(run.killSwitchActive, false);
    assert.equal(run.primary.status, "ambiguous");
    assert.equal(run.repair.ran, false);
    assert.equal(run.repair.status, "skipped");
    assert.equal(run.final.classification, "ambiguous");
    assert.ok(run.final.escalations.includes("supervisor-disabled"));
    assert.equal(run.alerting.emittedFactoryAlertId, null);
    assert.equal(run.artifacts.ledgerSessionId, null);
    // Disabled mode does NOT write a heartbeat or take the lease.
    assert.equal(existsSync(LOCK_PATH), false);
    assert.equal(existsSync(LATEST_RUN_PATH), false);
  } finally {
    cleanState();
  }
});

// --- kill switch ----------------------------------------------------------

test("kill switch active: mode resolves to disabled; no lease, no primary, no heartbeat", async () => {
  refusalGuard();
  cleanState();
  try {
    writeFileSync(KILL_SWITCH_PATH, "test\n");
    let primaryCalls = 0;
    let repairCalls = 0;
    // Don't pass modeOverride — let resolveMode see the kill switch.
    const run = await superviseFactoryRun({
      trigger: "manual",
      ledgerEnabled: false,
      emitAlertEnabled: false,
      primaryRunner: () => {
        primaryCalls++;
        return stubPrimary(0);
      },
      repairRunner: () => {
        repairCalls++;
        return stubRepair("ok");
      },
    });
    assert.equal(run.killSwitchActive, true);
    assert.equal(run.mode, "disabled");
    assert.equal(
      run.lease.acquired,
      false,
      "kill switch resolves to disabled — no lease",
    );
    assert.equal(primaryCalls, 0, "primary must not run with kill switch");
    assert.equal(repairCalls, 0, "repair must not run with kill switch");
    assert.equal(run.final.classification, "ambiguous");
    assert.ok(run.final.escalations.includes("kill-switch-active"));
    assert.equal(run.alerting.emittedFactoryAlertId, null);
    // No-run modes don't write a heartbeat — the kill-switch file itself
    // is the operator-visible signal; the status command reads it directly.
    assert.equal(existsSync(LATEST_RUN_PATH), false);
    assert.equal(existsSync(LOCK_PATH), false);
  } finally {
    cleanState();
  }
});

test("observe mode: no lease, no primary, no heartbeat; escalation = supervisor-observe-mode", async () => {
  refusalGuard();
  cleanState();
  try {
    let primaryCalls = 0;
    const run = await superviseFactoryRun(
      baseOpts({
        modeOverride: "observe",
        primaryRunner: () => {
          primaryCalls++;
          return stubPrimary(0);
        },
      }),
    );
    assert.equal(run.mode, "observe");
    assert.equal(run.lease.acquired, false);
    assert.equal(primaryCalls, 0);
    assert.equal(run.final.classification, "ambiguous");
    assert.ok(run.final.escalations.includes("supervisor-observe-mode"));
    assert.equal(existsSync(LATEST_RUN_PATH), false);
    assert.equal(existsSync(LOCK_PATH), false);
  } finally {
    cleanState();
  }
});

test("mode resolution: state/mode.json overrides factory.json default", async () => {
  refusalGuard();
  cleanState();
  try {
    const modePath = join(STATE_DIR, "mode.json");
    writeFileSync(
      modePath,
      JSON.stringify({
        mode: "active",
        setBy: "test",
        setAt: "2026-04-26T00:00:00Z",
      }),
    );
    try {
      const run = await superviseFactoryRun({
        trigger: "manual",
        // no modeOverride — supervisor must read state/mode.json
        ledgerEnabled: false,
        emitAlertEnabled: false,
        alertReader: () => [],
        primaryRunner: () => stubPrimary(0),
        innerRunner: () => stubInner(0),
        repairRunner: () => stubRepair("ok"),
      });
      assert.equal(run.mode, "active");
      assert.equal(run.final.classification, "passed");
    } finally {
      rmSync(modePath, { force: true });
    }
  } finally {
    cleanState();
  }
});

// --- lease ----------------------------------------------------------------

test("lease conflict: second supervisor invocation refuses, no primary called", async () => {
  refusalGuard();
  cleanState();
  try {
    // Pre-write a lease held by an alive pid (ourselves) far in the future.
    const fakeLease = {
      factoryId: "ai-stack-local-smoke",
      runId: "concurrent-run",
      pid: process.pid,
      startedAt: "2026-04-26T00:00:00Z",
      expiresAt: "2099-01-01T00:00:00Z",
    };
    writeFileSync(LOCK_PATH, JSON.stringify(fakeLease));
    let primaryCalls = 0;
    const run = await superviseFactoryRun(
      baseOpts({
        primaryRunner: () => {
          primaryCalls++;
          return stubPrimary(0);
        },
      }),
    );
    assert.equal(run.lease.acquired, false);
    assert.ok(run.lease.blockedBy);
    assert.equal(run.lease.blockedBy?.runId, "concurrent-run");
    assert.equal(primaryCalls, 0, "primary must not run when lease blocked");
    assert.equal(run.final.classification, "ambiguous");
    assert.ok(run.final.escalations.includes("lease-blocked"));
    // Pre-existing lease must not be overwritten by the refused run.
    const stillThere = JSON.parse(readFileSync(LOCK_PATH, "utf8"));
    assert.equal(stillThere.runId, "concurrent-run");
  } finally {
    cleanState();
  }
});

test("lease released after run, even on primary-failed path", async () => {
  refusalGuard();
  cleanState();
  try {
    await superviseFactoryRun(
      baseOpts({
        primaryRunner: () => stubPrimary(1),
      }),
    );
    assert.equal(existsSync(LOCK_PATH), false, "lock must be released");
  } finally {
    cleanState();
  }
});

// --- final classification + alert ownership in shadow mode ----------------

test("shadow + primary ok + repair ok → passed, no alert (passed never alerts)", async () => {
  refusalGuard();
  cleanState();
  try {
    const run = await superviseFactoryRun(baseOpts());
    assert.equal(run.final.classification, "passed");
    assert.equal(run.alerting.emittedFactoryAlertId, null);
    assert.equal(run.alerting.ownership, "none");
    assert.ok(existsSync(LATEST_RUN_PATH));
  } finally {
    cleanState();
  }
});

test("shadow + primary failed + no legacy alert → suppressed-shadow-mode, no factory alert", async () => {
  refusalGuard();
  cleanState();
  try {
    const run = await superviseFactoryRun(
      baseOpts({
        primaryRunner: () => stubPrimary(1),
        alertReader: () => [],
      }),
    );
    assert.equal(run.final.classification, "failed");
    assert.equal(run.alerting.ownership, "suppressed-shadow-mode");
    assert.equal(run.alerting.emittedFactoryAlertId, null);
  } finally {
    cleanState();
  }
});

test("shadow + primary failed + legacy alert appeared → suppressed-shadow-mode, legacy correlated", async () => {
  refusalGuard();
  cleanState();
  try {
    const before: Array<{ alertId: string; source: string }> = [];
    const after = [
      { alertId: "legacy-x", source: "ai-stack.local-smoke-nightly" },
    ];
    let calls = 0;
    const run = await superviseFactoryRun(
      baseOpts({
        primaryRunner: () => stubPrimary(1),
        alertReader: () => (calls++ === 0 ? before : after),
      }),
    );
    assert.equal(run.alerting.ownership, "suppressed-shadow-mode");
    assert.deepEqual(run.alerting.correlatedLegacyAlertIds, ["legacy-x"]);
    assert.equal(run.alerting.emittedFactoryAlertId, null);
  } finally {
    cleanState();
  }
});

// --- active mode emits alerts when no legacy correlates -------------------

test("active + primary failed + no legacy alert → factory-alert-emitted, alertId set", async () => {
  refusalGuard();
  cleanState();
  try {
    const run = await superviseFactoryRun(
      baseOpts({
        modeOverride: "active",
        primaryRunner: () => stubPrimary(1),
        alertReader: () => [],
        // emitAlertEnabled stays false to avoid live ledger writes —
        // we still expect the supervisor to set alertId on the FactoryRun.
      }),
    );
    assert.equal(run.final.classification, "failed");
    assert.equal(run.alerting.ownership, "factory-alert-emitted");
    assert.ok(run.alerting.emittedFactoryAlertId);
    assert.match(
      run.alerting.emittedFactoryAlertId!,
      /^factory\.ai-stack-local-smoke-run_/,
    );
  } finally {
    cleanState();
  }
});

test("active + primary ok + repair=stale → final=failed, factory alert emitted (no false green via stale)", async () => {
  refusalGuard();
  cleanState();
  try {
    const run = await superviseFactoryRun(
      baseOpts({
        modeOverride: "active",
        primaryRunner: () => stubPrimary(0),
        repairRunner: () => stubRepair("stale"),
        alertReader: () => [],
      }),
    );
    assert.equal(run.final.classification, "failed");
    assert.equal(run.repair.status, "stale");
    assert.equal(run.alerting.ownership, "factory-alert-emitted");
    assert.ok(run.alerting.emittedFactoryAlertId);
  } finally {
    cleanState();
  }
});

test("active + primary failed + legacy alert appeared → legacy-alert-correlated, NO factory alert", async () => {
  refusalGuard();
  cleanState();
  try {
    let calls = 0;
    const run = await superviseFactoryRun(
      baseOpts({
        modeOverride: "active",
        primaryRunner: () => stubPrimary(1),
        alertReader: () =>
          calls++ === 0
            ? []
            : [
                {
                  alertId: "legacy-x",
                  source: "ai-stack.local-smoke-nightly",
                },
              ],
      }),
    );
    assert.equal(run.final.classification, "failed");
    assert.equal(run.alerting.ownership, "legacy-alert-correlated");
    assert.equal(run.alerting.emittedFactoryAlertId, null);
    assert.deepEqual(run.alerting.correlatedLegacyAlertIds, ["legacy-x"]);
  } finally {
    cleanState();
  }
});

// --- heartbeat + lease invariants ----------------------------------------

test("latest-run.json written for every non-disabled run", async () => {
  refusalGuard();
  cleanState();
  try {
    await superviseFactoryRun(baseOpts());
    assert.ok(existsSync(LATEST_RUN_PATH));
    const r = JSON.parse(readFileSync(LATEST_RUN_PATH, "utf8"));
    assert.equal(r.factoryId, "ai-stack-local-smoke");
    assert.equal(r.classification, "passed");
    assert.match(r.runId, /^run_\d+T\d+Z_[a-z0-9]+$/);
  } finally {
    cleanState();
  }
});

test("FactoryRun shape is durable: contains lease, killSwitch, primary, repair, final, alerting, artifacts", async () => {
  refusalGuard();
  cleanState();
  try {
    const run = await superviseFactoryRun(baseOpts());
    for (const k of [
      "runId",
      "factoryId",
      "trigger",
      "mode",
      "startedAt",
      "finishedAt",
      "lease",
      "killSwitchActive",
      "primary",
      "inner",
      "repair",
      "final",
      "alerting",
      "artifacts",
    ]) {
      assert.ok(k in run, `FactoryRun missing key ${k}`);
    }
  } finally {
    cleanState();
  }
});

test("supervisor does not modify factories/<lane>/state/disabled (no kill-switch toggling)", async () => {
  refusalGuard();
  cleanState();
  try {
    await superviseFactoryRun(baseOpts());
    assert.equal(
      existsSync(KILL_SWITCH_PATH),
      false,
      "supervisor must not create/touch the real kill-switch file",
    );
  } finally {
    cleanState();
  }
});
