// Factory #1 — concrete cell wrapping ai-stack.local-smoke-nightly.
// Bounded scope only. Do not generalize until a second factory exists.
//
// v2 — addresses GPT Pro PR #1 review:
//   - primary verifier is the actual lane script /Users/test/bin/ai-stack-local-smoke,
//     not the inner `frontier mcp smoke` tool
//   - final classification cannot be "passed" if repair is stale/errored or
//     escalations are non-empty (no false green)
//   - inner classify() honors exit code priority (exit!=0 → failed regardless
//     of stdout shape; only exit=0 cases can be ambiguous)
//
// Flow:
//   1. Load spec from ./factory.json
//   2. If kill switch present → ambiguous, no verifier/repair/ledger/alert
//   3. Run primary verifier: /Users/test/bin/ai-stack-local-smoke
//   4. Optionally run inner check (frontier mcp smoke --read-only) for
//      structured tool-count detail in evidence; does not drive final
//   5. Run bounded repair (verify-timeout-config, read-only)
//   6. Derive final classification (kill switch + primary + repair → passed/failed/ambiguous)
//   7. Write run-ledger entries (system + ops.repair_start/end + maybe alert)
//   8. Emit alert based on FINAL classification (not raw primary)
//   9. Return FactoryRunResult; exit code maps to final classification

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
export type PrimaryStatus = "ok" | "failed" | "ambiguous";
export type RepairStatus = "ok" | "stale" | "skipped" | "error";

export interface FactoryRunResult {
  factoryId: string;
  classification: Classification;
  primary: {
    status: PrimaryStatus;
    exitCode: number;
    durationMs: number;
    detail: string;
  };
  inner: InnerCheckResult | null;
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
  status: RepairStatus;
  observedTimeoutSeconds: number | null;
  minRequiredSeconds: number;
  detail: string;
}

interface FactorySpec {
  factoryId: string;
  lane: {
    primaryVerifier: string[];
    innerCheck: string[];
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
    severityByFinalClassification: Record<
      Classification,
      "high" | "medium" | null
    >;
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

// --- Primary verifier (the real lane script) -------------------------------

export interface PrimaryVerifierOutput {
  exitCode: number;
  stdout: string;
  stderr: string;
  durationMs: number;
}

export function runPrimaryVerifier(
  spec: FactorySpec,
  opts: { timeoutMs?: number } = {},
): PrimaryVerifierOutput {
  const [cmd, ...args] = spec.lane.primaryVerifier;
  const t0 = Date.now();
  const res = spawnSync(cmd, args, {
    encoding: "utf8",
    timeout: opts.timeoutMs ?? 180_000,
  });
  return {
    exitCode: res.status ?? -1,
    stdout: res.stdout ?? "",
    stderr: res.stderr ?? "",
    durationMs: Date.now() - t0,
  };
}

export function classifyPrimaryVerifier(v: PrimaryVerifierOutput): {
  status: PrimaryStatus;
  detail: string;
} {
  if (v.exitCode === -1) {
    return {
      status: "ambiguous",
      detail:
        "primary verifier did not return cleanly (timeout or spawn error)",
    };
  }
  if (v.exitCode === 0) {
    return { status: "ok", detail: `primary verifier exit=0` };
  }
  return {
    status: "failed",
    detail: `primary verifier exit=${v.exitCode}`,
  };
}

// --- Inner check (frontier mcp smoke --read-only) ---------------------------
// Supplementary structured detail. JSON-shaped output. Does not by itself
// drive final classification — the primary script already does its own
// frontier mcp smoke check internally.

export interface VerifierOutput {
  exitCode: number;
  stdout: string;
  stderr: string;
  durationMs: number;
}

export interface InnerCheckResult {
  classification: Classification;
  exitCode: number;
  durationMs: number;
  toolCount: number | null;
  toolsPassed: number | null;
  toolsFailed: number | null;
  detail: string;
}

export function runInnerCheck(
  spec: FactorySpec,
  opts: { timeoutMs?: number } = {},
): VerifierOutput {
  const [cmd, ...args] = spec.lane.innerCheck;
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

// JSON-shape classifier — exit code priority. This is for the inner
// `frontier mcp smoke --read-only` JSON output. Rules:
//   exit == -1                              → ambiguous (timeout/spawn)
//   exit != 0                               → failed (regardless of stdout)
//   exit == 0  + empty stdout               → ambiguous
//   exit == 0  + non-JSON stdout            → ambiguous
//   exit == 0  + JSON missing counters      → ambiguous
//   exit == 0  + JSON failed == 0           → passed
//   exit == 0  + JSON failed >  0           → failed
export function classify(v: VerifierOutput): {
  classification: Classification;
  toolCount: number | null;
  toolsPassed: number | null;
  toolsFailed: number | null;
  detail: string;
} {
  if (v.exitCode === -1) {
    return {
      classification: "ambiguous",
      toolCount: null,
      toolsPassed: null,
      toolsFailed: null,
      detail: "verifier did not return cleanly (timeout or spawn error)",
    };
  }

  // Try JSON parse for context regardless of exit code, but exit code is
  // the dominant signal for non-zero, non-timeout cases.
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
  const passed =
    parsed && typeof parsed.passed === "number" ? parsed.passed : null;
  const failed =
    parsed && typeof parsed.failed === "number" ? parsed.failed : null;
  const toolCount =
    parsed && typeof parsed.toolCount === "number" ? parsed.toolCount : null;

  if (v.exitCode !== 0) {
    // Non-zero exit always means failed, even if stdout is non-JSON or empty.
    return {
      classification: "failed",
      toolCount,
      toolsPassed: passed,
      toolsFailed: failed,
      detail: `verifier nonzero exit=${v.exitCode}${
        parseError ? ` (${parseError})` : ""
      }`,
    };
  }

  // exit code is 0 from here on — only path that can be passed or ambiguous.
  if (parsed === null) {
    return {
      classification: "ambiguous",
      toolCount: null,
      toolsPassed: null,
      toolsFailed: null,
      detail: `exit=0 but ${parseError}`,
    };
  }
  if (failed === null || passed === null) {
    return {
      classification: "ambiguous",
      toolCount,
      toolsPassed: passed,
      toolsFailed: failed,
      detail: "exit=0 but JSON missing passed/failed counters",
    };
  }
  if (failed === 0) {
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
    detail: `exit=0 but ${failed} tool(s) failed`,
  };
}

export function classifyInnerCheck(v: VerifierOutput): InnerCheckResult {
  const cls = classify(v);
  return {
    classification: cls.classification,
    exitCode: v.exitCode,
    durationMs: v.durationMs,
    toolCount: cls.toolCount,
    toolsPassed: cls.toolsPassed,
    toolsFailed: cls.toolsFailed,
    detail: cls.detail,
  };
}

// --- Bounded repair (read-only timeout-config check) -----------------------

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

// --- Final classification --------------------------------------------------
// passed only when:
//   - kill switch inactive
//   - primary verifier exit == 0
//   - bounded repair status == "ok"
//   - escalations are empty
// Anything else lands in failed or ambiguous.

export interface FinalDerivation {
  classification: Classification;
  escalations: string[];
  detail: string;
}

export function deriveFinalClassification(args: {
  killSwitchActive: boolean;
  primary: { status: PrimaryStatus; detail: string } | null;
  repair: RepairResult;
}): FinalDerivation {
  const escalations: string[] = [];

  if (args.killSwitchActive) {
    escalations.push("kill-switch-active");
    return {
      classification: "ambiguous",
      escalations,
      detail: "kill switch active",
    };
  }

  if (!args.primary) {
    escalations.push("missing-evidence");
    return {
      classification: "ambiguous",
      escalations,
      detail: "primary verifier did not run",
    };
  }

  // Repair-derived escalations apply regardless of primary status, so they
  // surface even when the primary verifier passed (the false-green case).
  if (args.repair.status === "stale") {
    escalations.push("repair-did-not-clear-failure");
  }
  if (args.repair.status === "error") {
    escalations.push("missing-evidence");
  }

  if (args.primary.status === "ambiguous") {
    escalations.push("ambiguous-result");
    return {
      classification: "ambiguous",
      escalations,
      detail: args.primary.detail,
    };
  }
  if (args.primary.status === "failed") {
    return {
      classification: "failed",
      escalations,
      detail: args.primary.detail,
    };
  }

  // primary status == ok
  if (args.repair.status === "stale") {
    return {
      classification: "failed",
      escalations,
      detail: `primary ok but repair stale: ${args.repair.detail}`,
    };
  }
  if (args.repair.status === "error") {
    return {
      classification: "ambiguous",
      escalations,
      detail: `primary ok but repair errored: ${args.repair.detail}`,
    };
  }
  // "skipped" outside the kill-switch path is unexpected — treat as missing
  // evidence rather than letting it sneak into a passed result.
  if (args.repair.status === "skipped") {
    if (!escalations.includes("missing-evidence")) {
      escalations.push("missing-evidence");
    }
    return {
      classification: "ambiguous",
      escalations,
      detail: `primary ok but repair was skipped without an active kill switch: ${args.repair.detail}`,
    };
  }
  // Only repair.status === "ok" reaches here. Passed requires no escalations.
  if (escalations.length > 0) {
    return {
      classification: "ambiguous",
      escalations,
      detail: `primary ok but escalations present: ${escalations.join(",")}`,
    };
  }
  return {
    classification: "passed",
    escalations,
    detail: args.primary.detail,
  };
}

// --- Helpers ---------------------------------------------------------------

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

// --- Main entry ------------------------------------------------------------

export interface RunOptions {
  ledgerEnabled?: boolean;
  emitAlert?: boolean;
  primaryTimeoutMs?: number;
  innerTimeoutMs?: number;
  skipInnerCheck?: boolean;
}

export async function runFactoryCell(
  opts: RunOptions = {},
): Promise<FactoryRunResult> {
  const generatedAt = new Date().toISOString();
  const spec = loadSpec();
  const ledgerEnabled = opts.ledgerEnabled !== false;
  const emitAlert = opts.emitAlert !== false;

  // 1. Kill switch — short-circuit before any side effect.
  if (isKillSwitchActive(spec)) {
    const repair: RepairResult = {
      ran: false,
      kind: spec.boundedRepair.kind,
      status: "skipped",
      observedTimeoutSeconds: null,
      minRequiredSeconds: spec.boundedRepair.minTimeoutSeconds,
      detail: "kill switch active",
    };
    const final = deriveFinalClassification({
      killSwitchActive: true,
      primary: null,
      repair,
    });
    return {
      factoryId: spec.factoryId,
      classification: final.classification,
      primary: {
        status: "ambiguous",
        exitCode: -1,
        durationMs: 0,
        detail: "kill switch active — primary verifier not run",
      },
      inner: null,
      killSwitchActive: true,
      ledgerSessionId: null,
      alertId: null,
      alertSeverity: null,
      repair,
      evidencePath: writeEvidence(
        { reason: "kill-switch-active", spec: spec.factoryId },
        generatedAt,
      ),
      detail: final.detail,
      generatedAt,
      escalations: final.escalations,
    };
  }

  // 2. Open ledger session.
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

  // 3. Run primary verifier (the real lane script).
  const traceId = `factory-${spec.factoryId}-${Date.now().toString(36)}`;
  if (ledger && sessionId) {
    ledger.appendEvent({
      sessionId,
      kind: "ops.repair_start",
      actor: `factory.${spec.factoryId}`,
      traceId,
      payload: {
        step: "run-primary-verifier",
        cmd: spec.lane.primaryVerifier,
      },
    });
  }
  const primaryRaw = runPrimaryVerifier(spec, {
    timeoutMs: opts.primaryTimeoutMs,
  });
  const primary = classifyPrimaryVerifier(primaryRaw);

  // 4. Inner check (supplementary). Skippable; primary already ran the same
  //    check internally, so this is observability only.
  let inner: InnerCheckResult | null = null;
  if (!opts.skipInnerCheck) {
    const innerRaw = runInnerCheck(spec, { timeoutMs: opts.innerTimeoutMs });
    inner = classifyInnerCheck(innerRaw);
  }

  // 5. Bounded repair (read-only timeout-config check).
  const repair = runBoundedRepair(spec);

  // 6. Derive final classification (single source of truth).
  const final = deriveFinalClassification({
    killSwitchActive: false,
    primary,
    repair,
  });

  // 7. Write evidence.
  const evidencePath = writeEvidence(
    {
      factoryId: spec.factoryId,
      generatedAt,
      classification: final.classification,
      primary: {
        status: primary.status,
        exitCode: primaryRaw.exitCode,
        durationMs: primaryRaw.durationMs,
        stdoutBytes: primaryRaw.stdout.length,
        stderrBytes: primaryRaw.stderr.length,
        stdoutHead: primaryRaw.stdout.slice(0, 4096),
        stderrHead: primaryRaw.stderr.slice(0, 2048),
        detail: primary.detail,
      },
      inner,
      repair,
      escalations: final.escalations,
      detail: final.detail,
    },
    generatedAt,
  );

  // 8. Close ops.repair_end ledger event with the FINAL classification.
  if (ledger && sessionId) {
    ledger.appendEvent({
      sessionId,
      kind: "ops.repair_end",
      actor: `factory.${spec.factoryId}`,
      traceId,
      payload: {
        step: "run-primary-verifier",
        finalClassification: final.classification,
        primaryStatus: primary.status,
        primaryExit: primaryRaw.exitCode,
        innerClassification: inner?.classification ?? null,
        innerToolsPassed: inner?.toolsPassed ?? null,
        innerToolsFailed: inner?.toolsFailed ?? null,
        repairStatus: repair.status,
        repairDetail: repair.detail,
        escalations: final.escalations,
        evidencePath,
      },
    });
  }

  // 9. Emit alert based on FINAL classification (not primary).
  const severity =
    spec.alert.severityByFinalClassification[final.classification];
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
            final.classification === "failed"
              ? `Factory ${spec.factoryId}: ${final.detail}`
              : `Factory ${spec.factoryId}: ambiguous — ${final.detail}`,
          classification: final.classification,
          escalations: final.escalations,
          evidencePath,
        },
      });
    }
  }

  // 10. Close run.
  if (ledger && sessionId) {
    ledger.appendEvent({
      sessionId,
      kind: "system",
      actor: `factory.${spec.factoryId}`,
      payload: {
        event: "factory.run_end",
        factoryId: spec.factoryId,
        classification: final.classification,
        evidencePath,
        alertId,
      },
    });
  }

  return {
    factoryId: spec.factoryId,
    classification: final.classification,
    primary: {
      status: primary.status,
      exitCode: primaryRaw.exitCode,
      durationMs: primaryRaw.durationMs,
      detail: primary.detail,
    },
    inner,
    killSwitchActive: false,
    ledgerSessionId: sessionId,
    alertId,
    alertSeverity: severity ?? null,
    repair,
    evidencePath,
    detail: final.detail,
    generatedAt,
    escalations: final.escalations,
  };
}

// CLI entry — `node --import tsx factories/ai-stack-local-smoke/run.ts`
// Strict isMain: only true when this exact file is the CLI entry point.
// The previous fallback `argv[1]?.endsWith("run.ts")` triggered for any
// other tsx file named run.ts (e.g., evals/factory-quality/run.ts), which
// caused the factory CLI to fire on import. Fixed.
const isMain =
  process.argv[1] !== undefined &&
  fileURLToPath(import.meta.url) === resolve(process.argv[1]);
if (isMain) {
  runFactoryCell()
    .then((result) => {
      process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
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
