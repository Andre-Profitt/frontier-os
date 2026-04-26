// Factory quality eval — Phase 3 first eval suite.
//
// Scores whether the local-smoke factory + context-pack workflow does the
// disciplined things that prevent mean reversion and wrong-context starts.
// Read-only. Does not invoke the live factory verifier; uses synthetic
// inputs and committed artifacts to score the 15 criteria in
// local-smoke-factory-quality.json.
//
// Run:
//   node --import tsx evals/factory-quality/run.ts                 # markdown
//   node --import tsx evals/factory-quality/run.ts --json          # JSON
//   node --import tsx evals/factory-quality/run.ts --json --pretty # pretty JSON
//
// Tests live in evals/factory-quality/tests/quality.test.ts.

import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  generateContextPack,
  renderMarkdown,
  type ContextPack,
} from "../../src/context/pack.ts";
import {
  classify,
  classifyPrimaryVerifier,
  deriveFinalClassification,
  isKillSwitchActive,
  loadSpec,
  type RepairResult,
} from "../../factories/ai-stack-local-smoke/run.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, "..", "..");
const SUITE_PATH = resolve(HERE, "local-smoke-factory-quality.json");
const LANE = "ai-stack-local-smoke";

// Defensive timeout for small local subprocess calls (sqlite3 fixture
// setup/reads, find fingerprint). Local-file operations should complete
// in milliseconds; 5s is well past the worst realistic case and prevents
// an unrelated hang from blocking eval runs. The factory verifier
// subprocesses (which actually run work) have their own larger timeouts
// inside factories/<lane>/run.ts.
const READONLY_SUBPROCESS_TIMEOUT_MS = 5_000;

// Render a spawnSync result into a diagnostic string that surfaces
// timeout failures clearly. On `timeout`, spawnSync sets `status=null`
// and `signal="SIGTERM"`, and `stderr` may be empty — a plain
// `${res.stderr}` log would be unhelpful. This helper joins the
// signals/status/error/stderr fields that are actually populated.
function subprocessFailure(res: ReturnType<typeof spawnSync>): string {
  const parts: string[] = [];
  if (res.error) parts.push(`error=${res.error.message}`);
  parts.push(res.status !== null ? `status=${res.status}` : "status=null");
  if (res.signal) parts.push(`signal=${res.signal}`);
  const stderr = (res.stderr ?? "").toString().trim();
  if (stderr) parts.push(`stderr=${stderr}`);
  return parts.join(", ");
}

export type CriterionStatus = "passed" | "failed" | "not_applicable";

export interface CriterionResult {
  id: string;
  description: string;
  status: CriterionStatus;
  weight: number;
  evidence: string;
  detail?: string;
}

export interface EvalReport {
  evalSuite: "local-smoke-factory-quality";
  version: string;
  generatedAt: string;
  target: { lane: string; factorySpecPath: string };
  total: number;
  passed: number;
  failed: number;
  notApplicable: number;
  weightedScore: number;
  weightedTotal: number;
  ratio: number;
  recommendation: "ship" | "investigate" | "block";
  criteria: CriterionResult[];
}

interface SuiteSpec {
  evalSuiteId: string;
  version: string;
  target: { lane: string; factorySpecPath: string };
  criteria: Array<{ id: string; description: string; weight: number }>;
}

function loadSuite(): SuiteSpec {
  return JSON.parse(readFileSync(SUITE_PATH, "utf8")) as SuiteSpec;
}

function pass(
  c: { id: string; description: string; weight: number },
  evidence: string,
  detail?: string,
): CriterionResult {
  const result: CriterionResult = {
    id: c.id,
    description: c.description,
    status: "passed",
    weight: c.weight,
    evidence,
  };
  if (detail !== undefined) result.detail = detail;
  return result;
}

function fail(
  c: { id: string; description: string; weight: number },
  evidence: string,
  detail?: string,
): CriterionResult {
  const result: CriterionResult = {
    id: c.id,
    description: c.description,
    status: "failed",
    weight: c.weight,
    evidence,
  };
  if (detail !== undefined) result.detail = detail;
  return result;
}

// --- helpers --------------------------------------------------------------

function seedFixtureLedger(
  dbPath: string,
  alerts: Array<{
    alertId: string;
    severity: string;
    category: string;
    source: string;
    summary: string;
    ts: string;
  }>,
): void {
  const ddl = `
    CREATE TABLE IF NOT EXISTS sessions (
      session_id TEXT PRIMARY KEY,
      started_at TEXT NOT NULL,
      label TEXT,
      tags TEXT NOT NULL DEFAULT '[]',
      last_event_at TEXT
    );
    CREATE TABLE IF NOT EXISTS events (
      event_id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      offset INTEGER NOT NULL,
      ts TEXT NOT NULL,
      kind TEXT NOT NULL,
      actor TEXT,
      trace_id TEXT,
      payload TEXT NOT NULL
    );
    INSERT INTO sessions (session_id, started_at) VALUES ('ses_eval_fixture', '2026-04-26T00:00:00Z');
  `;
  const inserts = alerts
    .map((a, i) => {
      const payload = JSON.stringify(a).replace(/'/g, "''");
      return `INSERT INTO events VALUES ('evt_${i}', 'ses_eval_fixture', ${i}, '${a.ts}', 'alert', NULL, NULL, '${payload}');`;
    })
    .join("\n");
  const res = spawnSync("sqlite3", [dbPath, ddl + inserts], {
    encoding: "utf8",
    timeout: READONLY_SUBPROCESS_TIMEOUT_MS,
  });
  if (res.status !== 0) {
    throw new Error(`failed to seed fixture ledger: ${subprocessFailure(res)}`);
  }
}

function findFingerprint(root: string): string {
  const res = spawnSync(
    "find",
    [
      join(root, "factories"),
      join(root, "src", "context"),
      join(root, "evals"),
      "-type",
      "f",
      "-print",
    ],
    { encoding: "utf8", timeout: READONLY_SUBPROCESS_TIMEOUT_MS },
  );
  if (res.status !== 0) return "";
  return (res.stdout ?? "").split("\n").filter(Boolean).sort().join("\n");
}

// --- criterion scorers ----------------------------------------------------

export function scoreC1(
  c: SuiteSpec["criteria"][number],
  pack: ContextPack,
): CriterionResult {
  const committed = pack.evidence.committedFiles;
  const expected = ["smoke-fresh.json", "historic-failure.out.log"];
  const present = expected.filter((n) => committed.some((f) => f.name === n));
  if (present.length === expected.length) {
    return pass(
      c,
      `committed evidence: ${committed.length} files including ${expected.join(", ")}`,
    );
  }
  return fail(
    c,
    `evidence list: ${committed.map((f) => f.name).join(", ") || "(empty)"}`,
    `missing expected baseline files: ${expected.filter((n) => !present.includes(n)).join(", ")}`,
  );
}

export function scoreC2(c: SuiteSpec["criteria"][number]): CriterionResult {
  // Render a context pack with a synthetic dirty status and confirm the
  // markdown surfaces it. Does not depend on live working-tree state.
  const livePack = generateContextPack({
    lane: LANE,
    repoRoot: REPO_ROOT,
    includeAlerts: false,
  });
  const dirty: ContextPack = {
    ...livePack,
    gitStatus: {
      clean: false,
      modified: ["src/foo.ts"],
      untracked: ["scripts/bar.sh"],
      rawLines: [" M src/foo.ts", "?? scripts/bar.sh"],
    },
  };
  const md = renderMarkdown(dirty);
  if (
    /Working tree is \*\*dirty\*\*/.test(md) &&
    md.includes(" M src/foo.ts") &&
    md.includes("?? scripts/bar.sh")
  ) {
    return pass(
      c,
      "renderMarkdown surfaces dirty status with raw porcelain lines",
    );
  }
  return fail(
    c,
    "dirty status not visible in rendered markdown",
    md.slice(0, 400),
  );
}

export function scoreC3(
  c: SuiteSpec["criteria"][number],
  pack: ContextPack,
): CriterionResult {
  const md = renderMarkdown(pack);
  if (
    pack.repo.marker === "frontier-os" &&
    /This is the `frontier-os` repo/.test(md)
  ) {
    return pass(
      c,
      `repo.marker="${pack.repo.marker}" + markdown declares identity`,
    );
  }
  return fail(
    c,
    `repo.marker="${pack.repo.marker}", marker line missing in markdown`,
  );
}

export function scoreC4(
  c: SuiteSpec["criteria"][number],
  pack: ContextPack,
): CriterionResult {
  const joined = pack.forbiddenAreas.join("\n").toLowerCase();
  const expected = ["siri", "companion-platform", "/users/test/bin"];
  const missing = expected.filter((kw) => !joined.includes(kw));
  if (missing.length === 0) {
    return pass(
      c,
      `forbiddenAreas mentions Siri, companion-platform, /Users/test/bin`,
    );
  }
  return fail(c, `forbiddenAreas missing: ${missing.join(", ")}`);
}

export function scoreC5(
  c: SuiteSpec["criteria"][number],
  pack: ContextPack,
): CriterionResult {
  if (
    pack.lane.factoryId === LANE &&
    pack.lane.factorySpecPath.endsWith("factory.json") &&
    existsSync(pack.lane.factorySpecPath)
  ) {
    return pass(c, `factorySpecPath=${pack.lane.factorySpecPath}`);
  }
  return fail(
    c,
    `factoryId=${pack.lane.factoryId}, factorySpecPath=${pack.lane.factorySpecPath}`,
  );
}

export function scoreC6(
  c: SuiteSpec["criteria"][number],
  pack: ContextPack,
): CriterionResult {
  const a = pack.lane.policy.allowedActions.length;
  const f = pack.lane.policy.forbiddenActions.length;
  if (a > 0 && f > 0) {
    return pass(c, `allowedActions=${a}, forbiddenActions=${f}`);
  }
  return fail(c, `allowedActions=${a}, forbiddenActions=${f}`);
}

export function scoreC7(
  c: SuiteSpec["criteria"][number],
  pack: ContextPack,
): CriterionResult {
  if (
    typeof pack.lane.killSwitch.path === "string" &&
    pack.lane.killSwitch.path.length > 0 &&
    typeof pack.lane.killSwitch.active === "boolean"
  ) {
    return pass(
      c,
      `killSwitch.path=${pack.lane.killSwitch.path}, active=${pack.lane.killSwitch.active}`,
    );
  }
  return fail(c, JSON.stringify(pack.lane.killSwitch));
}

export function scoreC8(
  c: SuiteSpec["criteria"][number],
  pack: ContextPack,
): CriterionResult {
  const pv = pack.lane.lane.primaryVerifier ?? [];
  const expected = "/Users/test/bin/ai-stack-local-smoke";
  if (pv.length > 0 && pv[0] === expected) {
    return pass(c, `primaryVerifier=${pv.join(" ")}`);
  }
  return fail(
    c,
    `primaryVerifier=${pv.join(" ")}`,
    `expected to start with ${expected}`,
  );
}

// Pure assertion helper for alert coverage. Used by scoreC9 (live fixture
// path) and exercisable by tests with hand-built AlertRecord arrays so an
// anti-example regression — e.g., a filter that surfaces only factory
// wrapper alerts and misses legacy ai-stack-local-smoke alerts (the
// PR #2 v1 bug) — fails the criterion immediately.
export interface AlertRecordLike {
  alertId: string;
  source: string;
  summary: string;
}

export interface AlertCoverageVerdict {
  ok: boolean;
  factoryHit: boolean;
  legacyHit: boolean;
  unrelatedExcluded: boolean;
  reason: string;
}

export function assertLegacyAndFactoryCoverage(
  alerts: AlertRecordLike[],
  expected: {
    factoryAlertId: string;
    legacyAlertId: string;
    unrelatedAlertId: string;
  },
): AlertCoverageVerdict {
  const ids = alerts.map((a) => a.alertId);
  const factoryHit = ids.includes(expected.factoryAlertId);
  const legacyHit = ids.includes(expected.legacyAlertId);
  const unrelatedExcluded = !ids.includes(expected.unrelatedAlertId);
  if (factoryHit && legacyHit && unrelatedExcluded) {
    return {
      ok: true,
      factoryHit,
      legacyHit,
      unrelatedExcluded,
      reason: `factory + legacy included, unrelated excluded (${[...ids].sort().join(", ")})`,
    };
  }
  const missing: string[] = [];
  if (!factoryHit) missing.push(`factory alert ${expected.factoryAlertId}`);
  if (!legacyHit) missing.push(`legacy alert ${expected.legacyAlertId}`);
  if (!unrelatedExcluded)
    missing.push(`unrelated alert ${expected.unrelatedAlertId} not excluded`);
  return {
    ok: false,
    factoryHit,
    legacyHit,
    unrelatedExcluded,
    reason: `${missing.join("; ")}; ids=${[...ids].sort().join(", ")}`,
  };
}

export function scoreC9(c: SuiteSpec["criteria"][number]): CriterionResult {
  // Seed a fixture ledger with one factory wrapper alert + one legacy
  // alert + one unrelated alert. Confirm the pack surfaces the first two
  // and excludes the third. Scoring delegates to the pure helper so an
  // anti-example regression (filter dropping legacy alerts) is catchable
  // via direct unit tests without needing to perturb the production
  // alert filter or the live ledger.
  const dir = mkdtempSync(join(tmpdir(), "eval-c9-"));
  const dbPath = join(dir, "ledger.db");
  const expected = {
    factoryAlertId: "factory.ai-stack-local-smoke-eval-001",
    legacyAlertId: "ai-stack-local-smoke-20260425-035014",
    unrelatedAlertId: "unrelated-eval-x",
  };
  try {
    const now = new Date();
    const iso = (offset: number) =>
      new Date(now.getTime() + offset * 1000).toISOString();
    seedFixtureLedger(dbPath, [
      {
        alertId: expected.factoryAlertId,
        severity: "high",
        category: "health",
        source: "factory.ai-stack-local-smoke",
        summary: "Factory wrapper failure",
        ts: iso(-1800),
      },
      {
        alertId: expected.legacyAlertId,
        severity: "high",
        category: "health",
        source: "ai-stack.local-smoke-nightly",
        summary: "AI Stack local smoke failed",
        ts: iso(-3600),
      },
      {
        alertId: expected.unrelatedAlertId,
        severity: "low",
        category: "other",
        source: "some-other-watcher",
        summary: "irrelevant",
        ts: iso(-1200),
      },
    ]);
    const pack = generateContextPack({
      lane: LANE,
      repoRoot: REPO_ROOT,
      ledgerDb: dbPath,
    });
    const verdict = assertLegacyAndFactoryCoverage(
      pack.recentAlerts ?? [],
      expected,
    );
    if (verdict.ok) {
      return pass(c, `fixture: ${verdict.reason}`);
    }
    return fail(c, verdict.reason);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

export function scoreC10(c: SuiteSpec["criteria"][number]): CriterionResult {
  // Exhaustive enumeration over the inner classify() fed with diverse
  // verifier outputs. Each result must have exactly one classification
  // from {passed, failed, ambiguous}.
  const cases = [
    {
      exitCode: 0,
      stdout: JSON.stringify({ passed: 1, failed: 0, toolCount: 1 }),
      stderr: "",
    },
    {
      exitCode: 0,
      stdout: JSON.stringify({ passed: 0, failed: 1, toolCount: 1 }),
      stderr: "",
    },
    { exitCode: 2, stdout: "boom", stderr: "" },
    { exitCode: 2, stdout: "", stderr: "" },
    { exitCode: -1, stdout: "", stderr: "timeout" },
    { exitCode: 0, stdout: "", stderr: "" },
    { exitCode: 0, stdout: "garbage", stderr: "" },
    { exitCode: 0, stdout: JSON.stringify({ unrelated: true }), stderr: "" },
  ];
  for (const v of cases) {
    const r = classify({ ...v, durationMs: 1 });
    const counts = ["passed", "failed", "ambiguous"].filter(
      (x) => x === r.classification,
    ).length;
    if (counts !== 1) {
      return fail(c, `case ${JSON.stringify(v)} produced ${r.classification}`);
    }
    // Also exercise the primary verifier classifier.
    const p = classifyPrimaryVerifier({ ...v, durationMs: 1 });
    if (!["ok", "failed", "ambiguous"].includes(p.status)) {
      return fail(c, `primary case ${JSON.stringify(v)} produced ${p.status}`);
    }
  }
  return pass(
    c,
    `${cases.length} cases × 2 classifiers, each returns exactly one label`,
  );
}

export function scoreC11(c: SuiteSpec["criteria"][number]): CriterionResult {
  // Enumerate (kill switch × primary status × repair status). Whenever the
  // derived classification is "passed", repair MUST be ok and escalations
  // MUST be empty. This catches false-green regressions.
  const repairOk: RepairResult = {
    ran: true,
    kind: "verify-timeout-config",
    status: "ok",
    observedTimeoutSeconds: 60,
    minRequiredSeconds: 60,
    detail: "ok",
  };
  const repairStale: RepairResult = { ...repairOk, status: "stale" };
  const repairError: RepairResult = { ...repairOk, status: "error" };
  const repairSkipped: RepairResult = {
    ...repairOk,
    status: "skipped",
    ran: false,
  };
  const repairs = [repairOk, repairStale, repairError, repairSkipped];
  const primaries = [
    { status: "ok" as const, detail: "ok" },
    { status: "failed" as const, detail: "fail" },
    { status: "ambiguous" as const, detail: "ambig" },
  ];
  for (const ks of [false, true]) {
    for (const p of primaries) {
      for (const r of repairs) {
        const f = deriveFinalClassification({
          killSwitchActive: ks,
          primary: ks ? null : p,
          repair: r,
        });
        if (f.classification === "passed") {
          if (
            r.status !== "ok" ||
            f.escalations.length !== 0 ||
            ks !== false ||
            p.status !== "ok"
          ) {
            return fail(
              c,
              `false green: ks=${ks} p=${p.status} repair=${r.status} -> passed (escalations=${f.escalations.join(",")})`,
            );
          }
        }
      }
    }
  }
  return pass(
    c,
    "24-cell enumeration: passed only when killSwitch=false, primary=ok, repair=ok, escalations=[]",
  );
}

export function scoreC12(c: SuiteSpec["criteria"][number]): CriterionResult {
  // Read-only verification of kill-switch semantics. Does NOT touch the
  // real factories/<lane>/state/disabled file. Three layers of evidence:
  //
  //   1. Detection: isKillSwitchActive(synthSpec) correctly tracks the
  //      presence of a file at a synthetic absolute path under tmpdir.
  //      The synth spec reuses the real spec but rewrites
  //      policy.killSwitchFile to an absolute tmpdir path; isKillSwitchActive
  //      uses path.resolve which short-circuits to the absolute value.
  //
  //   2. Decision: deriveFinalClassification({killSwitchActive: true,
  //      primary: null, repair: skipped}) returns ambiguous with the
  //      kill-switch-active escalation. This is the pure logic that
  //      runFactoryCell delegates to.
  //
  //   3. Structural: source-text inspection of factories/<lane>/run.ts
  //      confirms the kill-switch short-circuit precedes verifier,
  //      ledger, and alert code. Any reordering that would let those
  //      side effects fire under an active kill switch is detected here.
  //
  // The factory's own test #23 covers the live runFactoryCell short-circuit
  // (it owns the writeFileSync to state/disabled). This eval criterion no
  // longer duplicates that touch.
  const realSpec = loadSpec();
  const dir = mkdtempSync(join(tmpdir(), "eval-c12-"));
  const synthKillPath = join(dir, "synthetic-disabled");
  const synthSpec = {
    ...realSpec,
    policy: { ...realSpec.policy, killSwitchFile: synthKillPath },
  } as Parameters<typeof isKillSwitchActive>[0];
  try {
    // (1a) absent -> false
    if (isKillSwitchActive(synthSpec)) {
      return fail(
        c,
        `synthetic kill-switch path unexpectedly active before write: ${synthKillPath}`,
      );
    }
    // (1b) present -> true
    writeFileSync(synthKillPath, "synth\n");
    if (!isKillSwitchActive(synthSpec)) {
      return fail(
        c,
        `synthetic kill-switch path not detected after write: ${synthKillPath}`,
      );
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }

  // (2) decision logic
  const final = deriveFinalClassification({
    killSwitchActive: true,
    primary: null,
    repair: {
      ran: false,
      kind: "verify-timeout-config",
      status: "skipped",
      observedTimeoutSeconds: null,
      minRequiredSeconds: 60,
      detail: "kill switch active",
    },
  });
  if (
    final.classification !== "ambiguous" ||
    !final.escalations.includes("kill-switch-active")
  ) {
    return fail(
      c,
      `deriveFinalClassification with killSwitchActive=true returned classification=${final.classification}, escalations=[${final.escalations.join(",")}]`,
    );
  }

  // (3) source-text inspection — slice to the runFactoryCell body so we
  // compare call-site ordering, not function-definition ordering. The file
  // declares runPrimaryVerifier / runInnerCheck / runBoundedRepair earlier
  // as helpers; their call sites live inside runFactoryCell, which is
  // where the kill-switch short-circuit must come first.
  const factorySrcPath = resolve(REPO_ROOT, "factories", LANE, "run.ts");
  const fullSrc = readFileSync(factorySrcPath, "utf8");
  const bodyStart = fullSrc.indexOf("export async function runFactoryCell(");
  const src = bodyStart >= 0 ? fullSrc.slice(bodyStart) : fullSrc;
  const ksIdx = src.indexOf("if (isKillSwitchActive(spec))");
  const verifierIdx = src.indexOf("runPrimaryVerifier(spec");
  const innerIdx = src.indexOf("runInnerCheck(spec");
  const repairIdx = src.indexOf("runBoundedRepair(spec)");
  const ledgerEnsureIdx = src.indexOf("ledger.ensureSession(");
  const ledgerAppendIdx = src.indexOf("ledger.appendEvent(");
  const indices = {
    ks: ksIdx,
    verifier: verifierIdx,
    inner: innerIdx,
    repair: repairIdx,
    ledgerEnsure: ledgerEnsureIdx,
    ledgerAppend: ledgerAppendIdx,
  };
  const failedOrdering: string[] = [];
  if (ksIdx < 0) failedOrdering.push("kill-switch check missing");
  for (const [name, idx] of Object.entries(indices)) {
    if (name === "ks") continue;
    if (idx < 0) continue;
    if (ksIdx > idx) failedOrdering.push(`kill-switch check after ${name}`);
  }
  if (failedOrdering.length > 0) {
    return fail(
      c,
      `source ordering invariant broken: ${failedOrdering.join(", ")} (indices=${JSON.stringify(indices)})`,
    );
  }

  return pass(
    c,
    "detection (synth tmpdir spec): isKillSwitchActive false→true on file presence; decision: deriveFinalClassification({killSwitchActive:true}) → ambiguous + kill-switch-active escalation; structural: kill-switch check precedes verifier/inner/repair/ledger calls in factories/<lane>/run.ts",
  );
}

export function scoreC13(c: SuiteSpec["criteria"][number]): CriterionResult {
  // Read-only: query the live ledger for any factory.ai-stack-local-smoke
  // session that already produced the four expected events. We do NOT run
  // the factory; we score whether the writes happened in any past run.
  const ledgerDb = resolve(process.env.HOME ?? "", ".frontier", "ledger.db");
  if (!existsSync(ledgerDb)) {
    return {
      id: c.id,
      description: c.description,
      status: "not_applicable",
      weight: c.weight,
      evidence: `ledger not present at ${ledgerDb}`,
    };
  }
  const sql = `
    PRAGMA query_only = 1;
    SELECT session_id, kind, COUNT(*) AS n
    FROM events
    WHERE actor = 'factory.ai-stack-local-smoke'
    GROUP BY session_id, kind
    ORDER BY session_id;
  `;
  const res = spawnSync("sqlite3", ["-separator", "\t", ledgerDb, sql], {
    encoding: "utf8",
    timeout: READONLY_SUBPROCESS_TIMEOUT_MS,
  });
  if (res.status !== 0) {
    return fail(c, `sqlite3 query failed: ${subprocessFailure(res)}`);
  }
  const lines = (res.stdout ?? "").trim().split("\n").filter(Boolean);
  // Group by session.
  const bySession = new Map<string, Map<string, number>>();
  for (const line of lines) {
    const [sid, kind, n] = line.split("\t");
    if (!sid || !kind) continue;
    if (!bySession.has(sid)) bySession.set(sid, new Map());
    bySession.get(sid)!.set(kind, parseInt(n ?? "0", 10));
  }
  for (const [sid, kinds] of bySession) {
    const has =
      (kinds.get("system") ?? 0) >= 2 &&
      (kinds.get("ops.repair_start") ?? 0) >= 1 &&
      (kinds.get("ops.repair_end") ?? 0) >= 1;
    if (has) {
      return pass(
        c,
        `session ${sid} has the expected event shape (system×${kinds.get("system")}, ops.repair_start×${kinds.get("ops.repair_start")}, ops.repair_end×${kinds.get("ops.repair_end")})`,
      );
    }
  }
  return fail(
    c,
    `no past factory session has the full system + ops.repair_start + ops.repair_end shape (sessions inspected: ${bySession.size})`,
  );
}

export function scoreC14(c: SuiteSpec["criteria"][number]): CriterionResult {
  // The alert severity is keyed off final classification. Confirm that
  // (primary=ok, repair=stale) -> final=failed -> severity=high, and that
  // a primary=ok scenario with stale repair does NOT get the severity for
  // primary=ok ("passed" -> null).
  const repairStale: RepairResult = {
    ran: true,
    kind: "verify-timeout-config",
    status: "stale",
    observedTimeoutSeconds: 30,
    minRequiredSeconds: 60,
    detail: "stale",
  };
  const final = deriveFinalClassification({
    killSwitchActive: false,
    primary: { status: "ok", detail: "exit=0" },
    repair: repairStale,
  });
  const spec = loadSpec();
  const finalSeverity =
    spec.alert.severityByFinalClassification[final.classification];
  const primarySeverity =
    spec.alert.severityByFinalClassification["passed" as const];
  if (
    final.classification === "failed" &&
    finalSeverity === "high" &&
    primarySeverity === null
  ) {
    return pass(
      c,
      `primary=ok + repair=stale -> final=failed -> severity=high (primary-only would have been passed/null)`,
    );
  }
  return fail(
    c,
    `final=${final.classification}, finalSeverity=${finalSeverity}, primarySeverity=${primarySeverity}`,
  );
}

export function scoreC15(c: SuiteSpec["criteria"][number]): CriterionResult {
  const before = findFingerprint(REPO_ROOT);
  generateContextPack({
    lane: LANE,
    repoRoot: REPO_ROOT,
    includeAlerts: false,
  });
  const after = findFingerprint(REPO_ROOT);
  if (before === after && before.length > 0) {
    return pass(
      c,
      `filesystem fingerprint identical before/after generation (${before.split("\n").length} files)`,
    );
  }
  return fail(
    c,
    "fingerprint changed during generation",
    `delta: ${after.length - before.length} chars`,
  );
}

// --- main runner ---------------------------------------------------------

export async function runEval(): Promise<EvalReport> {
  const suite = loadSuite();
  const generatedAt = new Date().toISOString();
  // Generate the live context pack once and reuse across criteria that
  // need it. This invocation is the unit under test (see C15).
  const livePack = generateContextPack({
    lane: LANE,
    repoRoot: REPO_ROOT,
    includeAlerts: true,
  });
  const c = suite.criteria;
  const results: CriterionResult[] = [
    scoreC1(c[0]!, livePack),
    scoreC2(c[1]!),
    scoreC3(c[2]!, livePack),
    scoreC4(c[3]!, livePack),
    scoreC5(c[4]!, livePack),
    scoreC6(c[5]!, livePack),
    scoreC7(c[6]!, livePack),
    scoreC8(c[7]!, livePack),
    scoreC9(c[8]!),
    scoreC10(c[9]!),
    scoreC11(c[10]!),
    scoreC12(c[11]!),
    scoreC13(c[12]!),
    scoreC14(c[13]!),
    scoreC15(c[14]!),
  ];
  const passed = results.filter((r) => r.status === "passed").length;
  const failed = results.filter((r) => r.status === "failed").length;
  const notApplicable = results.filter(
    (r) => r.status === "not_applicable",
  ).length;
  const weightedScore = results
    .filter((r) => r.status === "passed")
    .reduce((sum, r) => sum + r.weight, 0);
  const weightedTotal = results
    .filter((r) => r.status !== "not_applicable")
    .reduce((sum, r) => sum + r.weight, 0);
  const ratio = weightedTotal === 0 ? 0 : weightedScore / weightedTotal;
  const heavyFailed = results.some(
    (r) => r.status === "failed" && r.weight >= 2,
  );
  const recommendation: EvalReport["recommendation"] = heavyFailed
    ? "block"
    : ratio < 0.8
      ? "block"
      : failed === 0 && ratio >= 0.95
        ? "ship"
        : "investigate";
  return {
    evalSuite: "local-smoke-factory-quality",
    version: suite.version,
    generatedAt,
    target: suite.target,
    total: results.length,
    passed,
    failed,
    notApplicable,
    weightedScore,
    weightedTotal,
    ratio,
    recommendation,
    criteria: results,
  };
}

export function renderEvalMarkdown(r: EvalReport): string {
  const lines: string[] = [];
  const push = (s = "") => lines.push(s);
  push(`# Factory quality eval — ${r.evalSuite} ${r.version}`);
  push("");
  push(`- Target lane: \`${r.target.lane}\``);
  push(`- Generated: \`${r.generatedAt}\``);
  push(
    `- Score: **${r.passed}/${r.total}** (weighted ${r.weightedScore}/${r.weightedTotal} = ${(r.ratio * 100).toFixed(1)}%)`,
  );
  push(`- Recommendation: **${r.recommendation}**`);
  push("");
  push("## Criteria");
  push("");
  push("| ID | Status | Weight | Description |");
  push("|---|---|---|---|");
  for (const c of r.criteria) {
    const status =
      c.status === "passed" ? "PASS" : c.status === "failed" ? "FAIL" : "n/a";
    push(`| ${c.id} | ${status} | ${c.weight} | ${c.description} |`);
  }
  push("");
  push("## Evidence");
  push("");
  for (const c of r.criteria) {
    const status =
      c.status === "passed" ? "PASS" : c.status === "failed" ? "FAIL" : "n/a";
    push(`### ${c.id} — ${status}`);
    push("");
    push(`> ${c.description}`);
    push("");
    push("```");
    push(`evidence: ${c.evidence}`);
    if (c.detail !== undefined) push(`detail:   ${c.detail}`);
    push("```");
    push("");
  }
  return lines.join("\n");
}

// CLI entry — `node --import tsx evals/factory-quality/run.ts`
// Strict isMain: only true when this exact file is the CLI entry point.
const isMain =
  process.argv[1] !== undefined &&
  fileURLToPath(import.meta.url) === resolve(process.argv[1]);
if (isMain) {
  const argv = process.argv.slice(2);
  const wantJson = argv.includes("--json");
  const pretty = argv.includes("--pretty");
  runEval()
    .then((r) => {
      if (wantJson) {
        process.stdout.write(
          (pretty ? JSON.stringify(r, null, 2) : JSON.stringify(r)) + "\n",
        );
      } else {
        process.stdout.write(renderEvalMarkdown(r));
      }
      const code =
        r.recommendation === "ship"
          ? 0
          : r.recommendation === "investigate"
            ? 1
            : 2;
      process.exit(code);
    })
    .catch((err: unknown) => {
      process.stderr.write(
        `eval crashed: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`,
      );
      process.exit(3);
    });
}
