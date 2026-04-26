// Factory #1 — concrete cell wrapping ai-stack.local-smoke-nightly.
// Bounded scope only. Do not generalize until a second factory exists.
//
// Flow:
//   1. Load spec from ./factory.json
//   2. If kill switch present → escalate "kill-switch-active", do not run
//   3. Run verifier (frontier mcp smoke --read-only)
//   4. Classify passed | failed | ambiguous (mutually exclusive)
//   5. Run bounded repair (verify-timeout-config, read-only)
//   6. Write run-ledger entries (session.system + ops.repair_start/end + alert)
//   7. Emit alert reflecting the factory's classification
//   8. Return FactoryRunResult; exit code maps to classification

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { newSessionId } from "../../src/ledger/events.ts";
import { getLedger } from "../../src/ledger/index.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, "..", "..");
const SPEC_PATH = resolve(HERE, "factory.json");
const EVIDENCE_DIR = resolve(HERE, "evidence");

export type Classification = "passed" | "failed" | "ambiguous";

export interface FactoryRunResult {
  factoryId: string;
  classification: Classification;
  exitCode: number;
  toolCount: number | null;
  toolsPassed: number | null;
  toolsFailed: number | null;
  killSwitchActive: boolean;
  ledgerSessionId: string | null;
  alertId: string | null;
  alertSeverity: "high" | "medium" | null;
  repair: RepairResult;
  evidencePath: string;
  detail: string;
  generatedAt: string;
  escalations: string[];
}

export interface RepairResult {
  ran: boolean;
  kind: string;
  status: "ok" | "stale" | "skipped" | "error";
  observedTimeoutSeconds: number | null;
  minRequiredSeconds: number;
  detail: string;
}

interface FactorySpec {
  factoryId: string;
  lane: {
    underlyingTool: string[];
  };
  policy: {
    killSwitchFile: string;
  };
  boundedRepair: {
    kind: string;
    target: string;
    minTimeoutSeconds: number;
  };
  alert: {
    source: string;
    category: string;
    severityByClassification: Record<Classification, "high" | "medium" | null>;
  };
}

export function loadSpec(): FactorySpec {
  return JSON.parse(readFileSync(SPEC_PATH, "utf8")) as FactorySpec;
}

export function killSwitchPath(spec: FactorySpec): string {
  return resolve(REPO_ROOT, spec.policy.killSwitchFile);
}

export function isKillSwitchActive(spec: FactorySpec): boolean {
  return existsSync(killSwitchPath(spec));
}

export interface VerifierOutput {
  exitCode: number;
  stdout: string;
  stderr: string;
  durationMs: number;
}

export function runVerifier(
  spec: FactorySpec,
  opts: { timeoutMs?: number } = {},
): VerifierOutput {
  const [cmd, ...args] = spec.lane.underlyingTool;
  const t0 = Date.now();
  const res = spawnSync(cmd, args, {
    encoding: "utf8",
    timeout: opts.timeoutMs ?? 90_000,
  });
  return {
    exitCode: res.status ?? -1,
    stdout: res.stdout ?? "",
    stderr: res.stderr ?? "",
    durationMs: Date.now() - t0,
  };
}

// Classification rules — mutually exclusive by construction.
// Only one of (passed, failed, ambiguous) is returned; the order of checks
// guarantees no overlap. Tests assert this invariant.
export function classify(v: VerifierOutput): {
  classification: Classification;
  toolCount: number | null;
  toolsPassed: number | null;
  toolsFailed: number | null;
  detail: string;
} {
  // Ambiguous: process did not return cleanly (-1 = spawn error / timeout).
  if (v.exitCode === -1) {
    return {
      classification: "ambiguous",
      toolCount: null,
      toolsPassed: null,
      toolsFailed: null,
      detail: `verifier did not return cleanly (timeout or spawn error)`,
    };
  }

  // Try to parse JSON regardless of exit code; failure shape is also JSON.
  let parsed: { passed?: number; failed?: number; toolCount?: number } | null =
    null;
  let parseError: string | null = null;
  const trimmed = v.stdout.trim();
  if (trimmed.length === 0) {
    parseError = "empty stdout";
  } else {
    try {
      parsed = JSON.parse(trimmed);
    } catch (err) {
      parseError = err instanceof Error ? err.message : String(err);
    }
  }

  if (parsed === null) {
    // Non-JSON output — classification cannot be made reliably.
    return {
      classification: "ambiguous",
      toolCount: null,
      toolsPassed: null,
      toolsFailed: null,
      detail: `non-JSON verifier output (${parseError}); exit=${v.exitCode}`,
    };
  }

  const passed = typeof parsed.passed === "number" ? parsed.passed : null;
  const failed = typeof parsed.failed === "number" ? parsed.failed : null;
  const toolCount =
    typeof parsed.toolCount === "number" ? parsed.toolCount : null;

  if (failed === null || passed === null) {
    return {
      classification: "ambiguous",
      toolCount,
      toolsPassed: passed,
      toolsFailed: failed,
      detail: `JSON missing passed/failed counts; exit=${v.exitCode}`,
    };
  }

  if (v.exitCode === 0 && failed === 0) {
    return {
      classification: "passed",
      toolCount,
      toolsPassed: passed,
      toolsFailed: failed,
      detail: `${passed}/${toolCount ?? passed} tools ok`,
    };
  }

  return {
    classification: "failed",
    toolCount,
    toolsPassed: passed,
    toolsFailed: failed,
    detail: `verifier reported failure: exit=${v.exitCode}, failed=${failed}`,
  };
}

// Bounded repair: read /Users/test/bin/ai-stack-local-smoke and confirm the
// timeout for `frontier mcp smoke --read-only` is at least minTimeoutSeconds.
// Read-only — no edits, no fallback to "fix it for you". If stale, escalate.
export function runBoundedRepair(spec: FactorySpec): RepairResult {
  const min = spec.boundedRepair.minTimeoutSeconds;
  const target = spec.boundedRepair.target;
  if (!existsSync(target)) {
    return {
      ran: true,
      kind: spec.boundedRepair.kind,
      status: "error",
      observedTimeoutSeconds: null,
      minRequiredSeconds: min,
      detail: `target not found: ${target}`,
    };
  }
  const src = readFileSync(target, "utf8");
  // Locate the call: run([..., "mcp", "smoke", "--read-only"], timeout=NN)
  // The script source uses Python `timeout=N` keyword. Match conservatively.
  const re =
    /run\(\s*\[[^\]]*"mcp"\s*,\s*"smoke"\s*,\s*"--read-only"[^\]]*\]\s*,\s*timeout\s*=\s*(\d+)\s*\)/;
  const m = src.match(re);
  if (!m) {
    return {
      ran: true,
      kind: spec.boundedRepair.kind,
      status: "error",
      observedTimeoutSeconds: null,
      minRequiredSeconds: min,
      detail: `could not locate frontier mcp smoke timeout literal in ${target}`,
    };
  }
  const observed = Number.parseInt(m[1], 10);
  if (observed >= min) {
    return {
      ran: true,
      kind: spec.boundedRepair.kind,
      status: "ok",
      observedTimeoutSeconds: observed,
      minRequiredSeconds: min,
      detail: `observed timeout ${observed}s >= required ${min}s`,
    };
  }
  return {
    ran: true,
    kind: spec.boundedRepair.kind,
    status: "stale",
    observedTimeoutSeconds: observed,
    minRequiredSeconds: min,
    detail: `observed timeout ${observed}s < required ${min}s — escalate; do not edit live script from factory`,
  };
}

function newAlertId(factoryId: string): string {
  const ts = new Date()
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d+Z$/, "Z");
  return `${factoryId}-${ts}`;
}

function writeEvidence(payload: unknown, generatedAt: string): string {
  mkdirSync(EVIDENCE_DIR, { recursive: true });
  const stamp = generatedAt.replace(/[:.]/g, "-");
  const path = resolve(EVIDENCE_DIR, `run-${stamp}.json`);
  writeFileSync(path, JSON.stringify(payload, null, 2));
  return path;
}

export interface RunOptions {
  ledgerEnabled?: boolean; // default true
  emitAlert?: boolean; // default true
  verifierTimeoutMs?: number;
}

export async function runFactoryCell(
  opts: RunOptions = {},
): Promise<FactoryRunResult> {
  const generatedAt = new Date().toISOString();
  const spec = loadSpec();
  const escalations: string[] = [];
  const ledgerEnabled = opts.ledgerEnabled !== false;
  const emitAlert = opts.emitAlert !== false;

  // 1. Kill switch gates everything else, including ledger writes
  //    (matches src/watchers/runtime.ts:isKillSwitchActive semantics).
  if (isKillSwitchActive(spec)) {
    escalations.push("kill-switch-active");
    const result: FactoryRunResult = {
      factoryId: spec.factoryId,
      classification: "ambiguous",
      exitCode: -1,
      toolCount: null,
      toolsPassed: null,
      toolsFailed: null,
      killSwitchActive: true,
      ledgerSessionId: null,
      alertId: null,
      alertSeverity: null,
      repair: {
        ran: false,
        kind: spec.boundedRepair.kind,
        status: "skipped",
        observedTimeoutSeconds: null,
        minRequiredSeconds: spec.boundedRepair.minTimeoutSeconds,
        detail: "kill switch active",
      },
      evidencePath: writeEvidence(
        { reason: "kill-switch-active", spec: spec.factoryId },
        generatedAt,
      ),
      detail: `kill switch present at ${killSwitchPath(spec)}`,
      generatedAt,
      escalations,
    };
    return result;
  }

  // 2. Open ledger session for this run.
  const sessionId = ledgerEnabled
    ? newSessionId(`factory-${spec.factoryId}`)
    : null;
  const ledger = ledgerEnabled ? getLedger() : null;
  if (ledger && sessionId) {
    ledger.ensureSession({
      sessionId,
      label: `factory:${spec.factoryId}`,
      tags: ["factory", spec.factoryId],
    });
    ledger.appendEvent({
      sessionId,
      kind: "system",
      actor: `factory.${spec.factoryId}`,
      payload: {
        event: "factory.run_start",
        factoryId: spec.factoryId,
        generatedAt,
      },
    });
  }

  // 3. Run verifier.
  const traceId = `factory-${spec.factoryId}-${Date.now().toString(36)}`;
  if (ledger && sessionId) {
    ledger.appendEvent({
      sessionId,
      kind: "ops.repair_start",
      actor: `factory.${spec.factoryId}`,
      traceId,
      payload: {
        step: "run-verifier",
        cmd: spec.lane.underlyingTool,
      },
    });
  }
  const verifier = runVerifier(spec, { timeoutMs: opts.verifierTimeoutMs });

  // 4. Classify.
  const cls = classify(verifier);
  if (cls.classification === "ambiguous") {
    escalations.push("ambiguous-result");
  }

  // 5. Bounded repair (verify-timeout-config) — independent of classification,
  //    so we can detect stale config even on a transiently passing run.
  const repair = runBoundedRepair(spec);
  if (repair.status === "stale") {
    escalations.push("repair-did-not-clear-failure");
  }
  if (repair.status === "error") {
    escalations.push("missing-evidence");
  }

  // 6. Write evidence file.
  const evidencePath = writeEvidence(
    {
      factoryId: spec.factoryId,
      generatedAt,
      classification: cls.classification,
      verifier: {
        exitCode: verifier.exitCode,
        durationMs: verifier.durationMs,
        stdoutBytes: verifier.stdout.length,
        stderrBytes: verifier.stderr.length,
        stdoutHead: verifier.stdout.slice(0, 4096),
        stderrHead: verifier.stderr.slice(0, 2048),
      },
      tools: {
        toolCount: cls.toolCount,
        passed: cls.toolsPassed,
        failed: cls.toolsFailed,
      },
      repair,
      escalations,
      detail: cls.detail,
    },
    generatedAt,
  );

  // 7. Close ops.repair_end ledger event.
  if (ledger && sessionId) {
    ledger.appendEvent({
      sessionId,
      kind: "ops.repair_end",
      actor: `factory.${spec.factoryId}`,
      traceId,
      payload: {
        step: "run-verifier",
        classification: cls.classification,
        verifierExit: verifier.exitCode,
        toolsPassed: cls.toolsPassed,
        toolsFailed: cls.toolsFailed,
        repairStatus: repair.status,
        repairDetail: repair.detail,
        evidencePath,
      },
    });
  }

  // 8. Emit alert reflecting factory result.
  const severity = spec.alert.severityByClassification[cls.classification];
  let alertId: string | null = null;
  if (emitAlert && severity !== null) {
    alertId = newAlertId(spec.factoryId);
    if (ledger && sessionId) {
      ledger.appendEvent({
        sessionId,
        kind: "alert",
        actor: `factory.${spec.factoryId}`,
        payload: {
          alertId,
          severity,
          category: spec.alert.category,
          source: spec.alert.source,
          summary:
            cls.classification === "failed"
              ? `Factory ${spec.factoryId}: verifier failed (${cls.detail})`
              : `Factory ${spec.factoryId}: ambiguous result (${cls.detail})`,
          classification: cls.classification,
          escalations,
          evidencePath,
        },
      });
    }
  }

  // 9. Close run.
  if (ledger && sessionId) {
    ledger.appendEvent({
      sessionId,
      kind: "system",
      actor: `factory.${spec.factoryId}`,
      payload: {
        event: "factory.run_end",
        factoryId: spec.factoryId,
        classification: cls.classification,
        evidencePath,
        alertId,
      },
    });
  }

  return {
    factoryId: spec.factoryId,
    classification: cls.classification,
    exitCode: verifier.exitCode,
    toolCount: cls.toolCount,
    toolsPassed: cls.toolsPassed,
    toolsFailed: cls.toolsFailed,
    killSwitchActive: false,
    ledgerSessionId: sessionId,
    alertId,
    alertSeverity: severity ?? null,
    repair,
    evidencePath,
    detail: cls.detail,
    generatedAt,
    escalations,
  };
}

// CLI entry — `node --import tsx factories/ai-stack-local-smoke/run.ts`
const isMain =
  import.meta.url === `file://${process.argv[1]}` ||
  process.argv[1]?.endsWith("run.ts");
if (isMain) {
  runFactoryCell()
    .then((result) => {
      process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
      // Exit code maps to classification: 0 passed, 1 failed, 2 ambiguous.
      const code =
        result.classification === "passed"
          ? 0
          : result.classification === "failed"
            ? 1
            : 2;
      process.exit(code);
    })
    .catch((err: unknown) => {
      process.stderr.write(
        `factory.ai-stack-local-smoke crashed: ${
          err instanceof Error ? (err.stack ?? err.message) : String(err)
        }\n`,
      );
      process.exit(3);
    });
}
