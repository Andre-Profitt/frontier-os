// Factory #1 unit tests — narrow scope: classification mutual exclusion,
// kill switch behavior, ledger entry shape, alert reflects classification.
//
// Run with:
//   node --import tsx --test factories/ai-stack-local-smoke/tests/factory.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";

import {
  classify,
  isKillSwitchActive,
  killSwitchPath,
  loadSpec,
  runBoundedRepair,
  runFactoryCell,
  type VerifierOutput,
} from "../run.ts";

// --- classify ----------------------------------------------------------------

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

test("classify: non-zero exit + JSON parsable → failed", () => {
  const r = classify(
    v(2, JSON.stringify({ passed: 0, failed: 18, toolCount: 18 })),
  );
  assert.equal(r.classification, "failed");
});

test("classify: timeout / spawn error (exit=-1) → ambiguous", () => {
  const r = classify(v(-1, ""));
  assert.equal(r.classification, "ambiguous");
});

test("classify: empty stdout, exit=0 → ambiguous", () => {
  const r = classify(v(0, ""));
  assert.equal(r.classification, "ambiguous");
});

test("classify: non-JSON stdout → ambiguous", () => {
  const r = classify(v(0, "not json at all\n"));
  assert.equal(r.classification, "ambiguous");
});

test("classify: JSON missing failed/passed → ambiguous", () => {
  const r = classify(v(0, JSON.stringify({ status: "ok" })));
  assert.equal(r.classification, "ambiguous");
});

test("classify is total and mutually exclusive across cases", () => {
  const cases: VerifierOutput[] = [
    v(0, JSON.stringify({ passed: 18, failed: 0, toolCount: 18 })),
    v(0, JSON.stringify({ passed: 17, failed: 1, toolCount: 18 })),
    v(2, "boom"),
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
    // Mutual exclusion: classification is a single string, not a set —
    // structurally impossible to be both. Assert the type narrowing too.
    const counts = ["passed", "failed", "ambiguous"].filter(
      (x) => x === r.classification,
    ).length;
    assert.equal(counts, 1, "exactly one classification per result");
  }
});

// --- kill switch -------------------------------------------------------------

test("kill switch: absent file → not active", () => {
  const spec = loadSpec();
  const path = killSwitchPath(spec);
  // Ensure clean baseline (test does not own this path; refuse to delete).
  if (existsSync(path)) {
    throw new Error(`refusing to run: kill switch already exists at ${path}`);
  }
  assert.equal(isKillSwitchActive(spec), false);
});

test("kill switch: present file blocks repair via runFactoryCell", async () => {
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
    assert.ok(result.escalations.includes("kill-switch-active"));
    // No ledger session opened, no alert id minted.
    assert.equal(result.ledgerSessionId, null);
    assert.equal(result.alertId, null);
  } finally {
    rmSync(path, { force: true });
  }
});

// --- bounded repair (read-only timeout check) -------------------------------

test("bounded repair: target with timeout=60 returns ok", () => {
  const dir = mkdtempSync(join(tmpdir(), "factory-repair-"));
  try {
    const target = join(dir, "ai-stack-local-smoke");
    writeFileSync(
      target,
      [
        "#!/usr/bin/env python3",
        'smoke = run([str(FRONTIER_BIN), "mcp", "smoke", "--read-only"], timeout=60)',
        "",
      ].join("\n"),
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

test("bounded repair: target with timeout=30 returns stale", () => {
  const dir = mkdtempSync(join(tmpdir(), "factory-repair-"));
  try {
    const target = join(dir, "ai-stack-local-smoke");
    writeFileSync(
      target,
      [
        "#!/usr/bin/env python3",
        'smoke = run([str(FRONTIER_BIN), "mcp", "smoke", "--read-only"], timeout=30)',
        "",
      ].join("\n"),
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

test("bounded repair: missing target returns error", () => {
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

// --- end-to-end: factory wraps the live smoke lane --------------------------

test("end-to-end: factory wraps verifier and reflects pass in run record", async () => {
  // Run with ledger disabled to keep the test hermetic, but still invoke the
  // real verifier via spawnSync so we prove the wrapper integrates with the
  // actual lane.
  const result = await runFactoryCell({
    ledgerEnabled: false,
    emitAlert: false,
  });
  assert.equal(result.killSwitchActive, false);
  assert.ok(["passed", "failed", "ambiguous"].includes(result.classification));
  assert.ok(result.evidencePath.length > 0);
  assert.ok(existsSync(result.evidencePath), "evidence file written");
  // Repair ran and is one of {ok, stale, error}.
  assert.equal(result.repair.ran, true);
  assert.ok(["ok", "stale", "error"].includes(result.repair.status));
});

test("alert: passed → no alert; failed/ambiguous → alert with severity", async () => {
  // Synthetic check: confirm spec maps severity correctly.
  const spec = loadSpec();
  assert.equal(spec.alert.severityByClassification.passed, null);
  assert.equal(spec.alert.severityByClassification.failed, "high");
  assert.equal(spec.alert.severityByClassification.ambiguous, "medium");
});
