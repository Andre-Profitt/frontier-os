// Factory #1 unit tests — covers v2 semantics:
//   - exit-code priority in classify() (the JSON-shape inner-check classifier)
//   - primary-verifier classification (the lane script's exit code)
//   - deriveFinalClassification (no false-green when repair stale/error)
//   - kill-switch behavior
//   - bounded-repair status mapping
//   - end-to-end with synthetic primary + repair (no live spawn required)
//
// The live e2e test that spawns the actual /Users/test/bin/ai-stack-local-smoke
// is gated by FACTORY_LIVE=1 because it takes seconds and writes to the real
// ledger.
//
// Run unit tests:
//   node --import tsx --test factories/ai-stack-local-smoke/tests/factory.test.ts
// Run including live e2e:
//   FACTORY_LIVE=1 node --import tsx --test factories/ai-stack-local-smoke/tests/factory.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  classify,
  classifyInnerCheck,
  classifyPrimaryVerifier,
  deriveFinalClassification,
  isKillSwitchActive,
  killSwitchPath,
  loadSpec,
  runBoundedRepair,
  runFactoryCell,
  type PrimaryVerifierOutput,
  type RepairResult,
  type VerifierOutput,
} from "../run.ts";

const LIVE = process.env.FACTORY_LIVE === "1";

// --- inner classify(): exit-code priority ----------------------------------

const v = (
  exitCode: number,
  stdout: string,
  stderr = "",
  durationMs = 1,
): VerifierOutput => ({ exitCode, stdout, stderr, durationMs });

test("classify: clean exit + JSON failed=0 → passed", () => {
  const r = classify(
    v(0, JSON.stringify({ passed: 18, failed: 0, toolCount: 18 })),
  );
  assert.equal(r.classification, "passed");
  assert.equal(r.toolsPassed, 18);
  assert.equal(r.toolsFailed, 0);
});

test("classify: clean exit + JSON failed>0 → failed", () => {
  const r = classify(
    v(0, JSON.stringify({ passed: 17, failed: 1, toolCount: 18 })),
  );
  assert.equal(r.classification, "failed");
  assert.equal(r.toolsFailed, 1);
});

test("classify: nonzero exit + JSON parsable → failed", () => {
  const r = classify(
    v(2, JSON.stringify({ passed: 0, failed: 18, toolCount: 18 })),
  );
  assert.equal(r.classification, "failed");
});

test("classify: nonzero exit + non-JSON stdout → failed (exit-code priority)", () => {
  const r = classify(v(2, "Traceback (most recent call last):\n..."));
  assert.equal(r.classification, "failed");
});

test("classify: nonzero exit + empty stdout → failed (exit-code priority)", () => {
  const r = classify(v(127, ""));
  assert.equal(r.classification, "failed");
});

test("classify: timeout / spawn error (exit=-1) → ambiguous", () => {
  const r = classify(v(-1, ""));
  assert.equal(r.classification, "ambiguous");
});

test("classify: clean exit + empty stdout → ambiguous", () => {
  const r = classify(v(0, ""));
  assert.equal(r.classification, "ambiguous");
});

test("classify: clean exit + non-JSON stdout → ambiguous", () => {
  const r = classify(v(0, "not json at all\n"));
  assert.equal(r.classification, "ambiguous");
});

test("classify: clean exit + JSON missing failed/passed → ambiguous", () => {
  const r = classify(v(0, JSON.stringify({ status: "ok" })));
  assert.equal(r.classification, "ambiguous");
});

test("classify is total and exactly one classification per case", () => {
  const cases: VerifierOutput[] = [
    v(0, JSON.stringify({ passed: 18, failed: 0, toolCount: 18 })),
    v(0, JSON.stringify({ passed: 17, failed: 1, toolCount: 18 })),
    v(2, "boom"),
    v(2, ""),
    v(127, "command not found"),
    v(-1, ""),
    v(0, ""),
    v(0, "garbage"),
    v(0, JSON.stringify({ unrelated: true })),
  ];
  const valid = new Set(["passed", "failed", "ambiguous"]);
  for (const c of cases) {
    const r = classify(c);
    assert.ok(
      valid.has(r.classification),
      `unknown classification ${r.classification}`,
    );
    const counts = ["passed", "failed", "ambiguous"].filter(
      (x) => x === r.classification,
    ).length;
    assert.equal(counts, 1, "exactly one classification per result");
  }
});

test("classifyInnerCheck packages classify() output", () => {
  const r = classifyInnerCheck(
    v(0, JSON.stringify({ passed: 18, failed: 0, toolCount: 18 })),
  );
  assert.equal(r.classification, "passed");
  assert.equal(r.toolCount, 18);
  assert.equal(r.exitCode, 0);
});

// --- primary verifier classification (the lane script) ---------------------

const pv = (
  exitCode: number,
  stdout = "",
  stderr = "",
  durationMs = 1,
): PrimaryVerifierOutput => ({ exitCode, stdout, stderr, durationMs });

test("classifyPrimaryVerifier: exit=0 → ok", () => {
  assert.equal(classifyPrimaryVerifier(pv(0, "all good")).status, "ok");
});

test("classifyPrimaryVerifier: exit!=0 → failed (regardless of stdout)", () => {
  assert.equal(classifyPrimaryVerifier(pv(1)).status, "failed");
  assert.equal(classifyPrimaryVerifier(pv(2, "boom")).status, "failed");
  assert.equal(classifyPrimaryVerifier(pv(127)).status, "failed");
});

test("classifyPrimaryVerifier: exit=-1 → ambiguous (timeout/spawn)", () => {
  assert.equal(classifyPrimaryVerifier(pv(-1)).status, "ambiguous");
});

// --- deriveFinalClassification: no false-green ----------------------------

const repairOk = (): RepairResult => ({
  ran: true,
  kind: "verify-timeout-config",
  status: "ok",
  observedTimeoutSeconds: 60,
  minRequiredSeconds: 60,
  detail: "ok",
});
const repairStale = (): RepairResult => ({
  ran: true,
  kind: "verify-timeout-config",
  status: "stale",
  observedTimeoutSeconds: 30,
  minRequiredSeconds: 60,
  detail: "stale",
});
const repairError = (): RepairResult => ({
  ran: true,
  kind: "verify-timeout-config",
  status: "error",
  observedTimeoutSeconds: null,
  minRequiredSeconds: 60,
  detail: "target missing",
});
const repairSkipped = (): RepairResult => ({
  ran: false,
  kind: "verify-timeout-config",
  status: "skipped",
  observedTimeoutSeconds: null,
  minRequiredSeconds: 60,
  detail: "kill switch active",
});

test("final: kill switch active → ambiguous, escalations include kill-switch-active", () => {
  const f = deriveFinalClassification({
    killSwitchActive: true,
    primary: null,
    repair: repairSkipped(),
  });
  assert.equal(f.classification, "ambiguous");
  assert.ok(f.escalations.includes("kill-switch-active"));
});

test("final: primary ambiguous → ambiguous", () => {
  const f = deriveFinalClassification({
    killSwitchActive: false,
    primary: { status: "ambiguous", detail: "timeout" },
    repair: repairOk(),
  });
  assert.equal(f.classification, "ambiguous");
  assert.ok(f.escalations.includes("ambiguous-result"));
});

test("final: primary failed → failed", () => {
  const f = deriveFinalClassification({
    killSwitchActive: false,
    primary: { status: "failed", detail: "exit=1" },
    repair: repairOk(),
  });
  assert.equal(f.classification, "failed");
});

test("final: primary ok + repair ok → passed (the only passed path)", () => {
  const f = deriveFinalClassification({
    killSwitchActive: false,
    primary: { status: "ok", detail: "exit=0" },
    repair: repairOk(),
  });
  assert.equal(f.classification, "passed");
  assert.equal(f.escalations.length, 0);
});

test("final: primary ok + repair stale → failed (no false green)", () => {
  const f = deriveFinalClassification({
    killSwitchActive: false,
    primary: { status: "ok", detail: "exit=0" },
    repair: repairStale(),
  });
  assert.equal(f.classification, "failed");
  assert.ok(f.escalations.includes("repair-did-not-clear-failure"));
});

test("final: primary ok + repair error → ambiguous (missing evidence)", () => {
  const f = deriveFinalClassification({
    killSwitchActive: false,
    primary: { status: "ok", detail: "exit=0" },
    repair: repairError(),
  });
  assert.equal(f.classification, "ambiguous");
  assert.ok(f.escalations.includes("missing-evidence"));
});

test("invariant: classification == 'passed' implies repair.status == 'ok' AND escalations empty", () => {
  // Hard invariant. Synthesize all combinations and verify every "passed"
  // result satisfies the constraints.
  const primaries = [
    { status: "ok" as const, detail: "ok" },
    { status: "failed" as const, detail: "fail" },
    { status: "ambiguous" as const, detail: "ambig" },
  ];
  const repairs = [repairOk(), repairStale(), repairError(), repairSkipped()];
  for (const killSwitchActive of [false, true]) {
    for (const primary of primaries) {
      for (const repair of repairs) {
        const f = deriveFinalClassification({
          killSwitchActive,
          primary: killSwitchActive ? null : primary,
          repair,
        });
        if (f.classification === "passed") {
          assert.equal(
            repair.status,
            "ok",
            `passed but repair.status=${repair.status}`,
          );
          assert.equal(
            f.escalations.length,
            0,
            `passed but escalations=${f.escalations.join(",")}`,
          );
          assert.equal(
            killSwitchActive,
            false,
            "passed but kill switch active",
          );
          assert.equal(primary.status, "ok", "passed but primary not ok");
        }
      }
    }
  }
});

// --- kill switch -----------------------------------------------------------

test("kill switch: absent file → not active", () => {
  const spec = loadSpec();
  const path = killSwitchPath(spec);
  if (existsSync(path)) {
    throw new Error(`refusing to run: kill switch already exists at ${path}`);
  }
  assert.equal(isKillSwitchActive(spec), false);
});

test("kill switch: present file → factory short-circuits, no verifier/repair/ledger/alert", async () => {
  const spec = loadSpec();
  const path = killSwitchPath(spec);
  if (existsSync(path)) {
    throw new Error(`refusing to run: kill switch already exists at ${path}`);
  }
  writeFileSync(path, "test\n");
  try {
    const result = await runFactoryCell({
      ledgerEnabled: false,
      emitAlert: false,
    });
    assert.equal(result.killSwitchActive, true);
    assert.equal(result.classification, "ambiguous");
    assert.equal(result.repair.ran, false);
    assert.equal(result.repair.status, "skipped");
    assert.equal(result.primary.status, "ambiguous");
    assert.ok(result.escalations.includes("kill-switch-active"));
    assert.equal(result.ledgerSessionId, null);
    assert.equal(result.alertId, null);
    assert.equal(result.inner, null);
  } finally {
    rmSync(path, { force: true });
  }
});

// --- bounded repair --------------------------------------------------------

test("bounded repair: target with timeout=60 → ok", () => {
  const dir = mkdtempSync(join(tmpdir(), "factory-repair-"));
  try {
    const target = join(dir, "ai-stack-local-smoke");
    writeFileSync(
      target,
      `#!/usr/bin/env python3\nsmoke = run([str(FRONTIER_BIN), "mcp", "smoke", "--read-only"], timeout=60)\n`,
    );
    const spec = {
      ...loadSpec(),
      boundedRepair: {
        kind: "verify-timeout-config",
        target,
        minTimeoutSeconds: 60,
      },
    };
    const r = runBoundedRepair(spec as Parameters<typeof runBoundedRepair>[0]);
    assert.equal(r.status, "ok");
    assert.equal(r.observedTimeoutSeconds, 60);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("bounded repair: target with timeout=30 → stale", () => {
  const dir = mkdtempSync(join(tmpdir(), "factory-repair-"));
  try {
    const target = join(dir, "ai-stack-local-smoke");
    writeFileSync(
      target,
      `#!/usr/bin/env python3\nsmoke = run([str(FRONTIER_BIN), "mcp", "smoke", "--read-only"], timeout=30)\n`,
    );
    const spec = {
      ...loadSpec(),
      boundedRepair: {
        kind: "verify-timeout-config",
        target,
        minTimeoutSeconds: 60,
      },
    };
    const r = runBoundedRepair(spec as Parameters<typeof runBoundedRepair>[0]);
    assert.equal(r.status, "stale");
    assert.equal(r.observedTimeoutSeconds, 30);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("bounded repair: missing target → error", () => {
  const spec = {
    ...loadSpec(),
    boundedRepair: {
      kind: "verify-timeout-config",
      target: "/nonexistent/path/does/not/exist",
      minTimeoutSeconds: 60,
    },
  };
  const r = runBoundedRepair(spec as Parameters<typeof runBoundedRepair>[0]);
  assert.equal(r.status, "error");
});

// --- alert reflection of FINAL classification ------------------------------

test("alert spec: passed → null, failed → high, ambiguous → medium", () => {
  const spec = loadSpec();
  assert.equal(spec.alert.severityByFinalClassification.passed, null);
  assert.equal(spec.alert.severityByFinalClassification.failed, "high");
  assert.equal(spec.alert.severityByFinalClassification.ambiguous, "medium");
});

test("alert lifecycle: deriveFinal failed + spec.severity → reportable severity", () => {
  // Demonstrates the chain: a passed primary + stale repair becomes a failed
  // final classification, and the spec maps that to severity 'high'. The
  // factory wrapper consults `severityByFinalClassification[final]`, not the
  // raw primary, so a stale-repair scenario produces a high alert rather
  // than silent green.
  const final = deriveFinalClassification({
    killSwitchActive: false,
    primary: { status: "ok", detail: "exit=0" },
    repair: repairStale(),
  });
  const spec = loadSpec();
  assert.equal(final.classification, "failed");
  assert.equal(
    spec.alert.severityByFinalClassification[final.classification],
    "high",
  );
});

// --- live integration (env-gated) ------------------------------------------

test(
  "live e2e: factory wraps real /Users/test/bin/ai-stack-local-smoke (FACTORY_LIVE=1)",
  { skip: LIVE ? false : "FACTORY_LIVE != 1; skipping live integration" },
  async () => {
    const result = await runFactoryCell({
      ledgerEnabled: false,
      emitAlert: false,
    });
    assert.equal(result.killSwitchActive, false);
    assert.ok(
      ["passed", "failed", "ambiguous"].includes(result.classification),
    );
    assert.ok(existsSync(result.evidencePath), "evidence file written");
    assert.equal(result.repair.ran, true);
    assert.ok(["ok", "stale", "error"].includes(result.repair.status));
    if (result.classification === "passed") {
      assert.equal(result.repair.status, "ok");
      assert.equal(result.escalations.length, 0);
      assert.equal(result.alertId, null);
      assert.equal(result.alertSeverity, null);
    }
    if (result.classification === "failed") {
      assert.equal(result.alertSeverity, "high");
    }
    if (result.classification === "ambiguous") {
      assert.equal(result.alertSeverity, "medium");
    }
  },
);
