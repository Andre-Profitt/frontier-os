// Lane context pack — read-only context generator.
//
// Purpose: prevent wrong-repo / wrong-context hallucinations by producing a
// concrete, ground-truth packet about a factory lane before any agent starts
// work on it. Read-only: no ledger writes, no alerts, no repairs, no edits.
//
// Phase 2 scope: support `ai-stack-local-smoke`. The implementation is
// concrete-first; it is generic enough to read any factory under
// factories/<lane>/factory.json but is exercised against the only factory
// that exists today.
//
// Caller: src/cli.ts -> `frontier context pack --lane <lane>` (markdown to
// stdout by default; JSON via --json).

import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";

const HERE_FILE = fileURLToPath(import.meta.url);
const REPO_ROOT_DEFAULT = resolve(HERE_FILE, "..", "..", "..");
const REPO_MARKER = "frontier-os" as const;

export interface PackOptions {
  lane: string;
  repoRoot?: string;
  includeAlerts?: boolean;
  alertLookbackDays?: number;
  ledgerDb?: string;
}

export interface GitStatus {
  clean: boolean;
  modified: string[];
  untracked: string[];
  rawLines: string[];
}

export interface AlertRecord {
  alertId: string;
  severity: string;
  category: string;
  source: string;
  summary: string;
  ts: string;
}

export interface FactoryRef {
  factoryId: string;
  version: string;
  summary: string;
  objective: string;
  factorySpecPath: string;
  policy: {
    approvalClass: number;
    allowedActions: string[];
    forbiddenActions: string[];
    escalation: string[];
  };
  killSwitch: {
    path: string;
    active: boolean;
  };
  lane: {
    launchdLabel: string;
    launchdPlist: string;
    verifierEntry: string;
    primaryVerifier: string[];
    innerCheck: string[];
    logs: { out: string; err: string };
  };
  classification: Record<string, unknown>;
  boundedRepair: {
    kind: string;
    target: string;
    minTimeoutSeconds: number;
    destructive: boolean;
    rollback: string;
  };
  alert: {
    source: string;
    category: string;
    severityByFinalClassification: Record<string, string | null>;
  };
}

export interface EvidenceSummary {
  dir: string;
  committedFiles: Array<{ name: string; bytes: number }>;
  runArtifactCount: number;
}

export interface ContextPack {
  generatedAt: string;
  repo: {
    marker: typeof REPO_MARKER;
    root: string;
    remote: string | null;
  };
  branch: string;
  headSha: string;
  recentCommits: string[];
  gitStatus: GitStatus;
  lane: FactoryRef;
  evidence: EvidenceSummary;
  recentAlerts: AlertRecord[] | null;
  verificationCommands: string[];
  forbiddenAreas: string[];
  followUps: string[];
  warnings: string[];
}

// --- helpers ---------------------------------------------------------------

function git(args: string[], cwd: string): string {
  const res = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (res.status !== 0) {
    return "";
  }
  return (res.stdout ?? "").trim();
}

function readGitStatus(cwd: string): GitStatus {
  const raw = git(["status", "--porcelain=v1"], cwd);
  const lines = raw.length === 0 ? [] : raw.split("\n");
  const modified: string[] = [];
  const untracked: string[] = [];
  for (const line of lines) {
    if (line.startsWith("??")) {
      untracked.push(line.slice(3));
    } else {
      modified.push(line.slice(3));
    }
  }
  return {
    clean: lines.length === 0,
    modified,
    untracked,
    rawLines: lines,
  };
}

function readRecentCommits(cwd: string, n: number): string[] {
  const raw = git(["log", `-n${n}`, "--oneline", "--no-decorate"], cwd);
  if (raw.length === 0) return [];
  return raw.split("\n");
}

function readBranch(cwd: string): string {
  return git(["branch", "--show-current"], cwd) || "(detached HEAD)";
}

function readHead(cwd: string): string {
  return git(["rev-parse", "HEAD"], cwd);
}

function readRemote(cwd: string): string | null {
  const out = git(["remote", "get-url", "origin"], cwd);
  return out.length > 0 ? out : null;
}

function readFactoryRef(repoRoot: string, lane: string): FactoryRef {
  const factorySpecPath = resolve(repoRoot, "factories", lane, "factory.json");
  if (!existsSync(factorySpecPath)) {
    throw new Error(
      `unknown lane: ${lane} (no factory.json at ${factorySpecPath})`,
    );
  }
  const raw = readFileSync(factorySpecPath, "utf8");
  const spec = JSON.parse(raw) as {
    factoryId: string;
    version: string;
    summary: string;
    objective: string;
    lane: {
      launchdLabel: string;
      launchdPlist: string;
      verifierEntry: string;
      primaryVerifier: string[];
      innerCheck: string[];
      logs: { out: string; err: string };
    };
    policy: {
      approvalClass: number;
      allowedActions: string[];
      forbiddenActions: string[];
      escalation: string[];
      killSwitchFile: string;
    };
    classification: Record<string, unknown>;
    boundedRepair: {
      kind: string;
      target: string;
      minTimeoutSeconds: number;
      destructive: boolean;
      rollback: string;
    };
    alert: {
      source: string;
      category: string;
      severityByFinalClassification: Record<string, string | null>;
    };
  };
  const killSwitchAbs = resolve(repoRoot, spec.policy.killSwitchFile);
  return {
    factoryId: spec.factoryId,
    version: spec.version,
    summary: spec.summary,
    objective: spec.objective,
    factorySpecPath,
    policy: {
      approvalClass: spec.policy.approvalClass,
      allowedActions: spec.policy.allowedActions,
      forbiddenActions: spec.policy.forbiddenActions,
      escalation: spec.policy.escalation,
    },
    killSwitch: {
      path: killSwitchAbs,
      active: existsSync(killSwitchAbs),
    },
    lane: spec.lane,
    classification: spec.classification,
    boundedRepair: spec.boundedRepair,
    alert: spec.alert,
  };
}

function readEvidenceSummary(
  repoRoot: string,
  lane: string,
  cwd: string,
): EvidenceSummary {
  const dir = resolve(repoRoot, "factories", lane, "evidence");
  const committedFiles: Array<{ name: string; bytes: number }> = [];
  let runArtifactCount = 0;
  if (!existsSync(dir)) {
    return { dir, committedFiles, runArtifactCount };
  }
  // Files actually tracked by git (committed). Distinguishes evidence at
  // rest from generated per-run artifacts (which are git-ignored).
  const tracked = git(["ls-files", "--full-name", "--", dir], cwd)
    .split("\n")
    .filter(Boolean);
  for (const rel of tracked) {
    const abs = resolve(repoRoot, rel);
    if (!existsSync(abs)) continue;
    const st = statSync(abs);
    committedFiles.push({
      name: rel.replace(/^factories\/[^/]+\/evidence\//, ""),
      bytes: st.size,
    });
  }
  // Count untracked run-*.json artifacts without listing them.
  for (const entry of readdirSync(dir)) {
    if (entry.startsWith("run-") && entry.endsWith(".json")) {
      runArtifactCount++;
    }
  }
  return { dir, committedFiles, runArtifactCount };
}

function readRecentAlertsForLane(
  ledgerDb: string,
  alertSource: string,
  lookbackDays: number,
): AlertRecord[] | null {
  if (!existsSync(ledgerDb)) return null;
  // Read-only via sqlite3 CLI with PRAGMA query_only — same approach as
  // scripts/notify-alerts.sh. No ledger writes from this code path.
  const sinceIso = new Date(
    Date.now() - lookbackDays * 24 * 3600 * 1000,
  ).toISOString();
  const sql = [
    "PRAGMA query_only = 1;",
    "SELECT",
    "  COALESCE(json_extract(payload, '$.alertId'), event_id) AS alert_id,",
    "  COALESCE(json_extract(payload, '$.severity'), 'info') AS severity,",
    "  COALESCE(json_extract(payload, '$.category'), 'health') AS category,",
    "  COALESCE(json_extract(payload, '$.source'), actor, 'unknown') AS source,",
    "  COALESCE(json_extract(payload, '$.summary'), '') AS summary,",
    "  ts",
    "FROM events",
    "WHERE kind = 'alert'",
    `  AND ts >= '${sinceIso}'`,
    `  AND COALESCE(json_extract(payload, '$.source'), actor, '') LIKE '%${alertSource.replace(/'/g, "''")}%'`,
    "ORDER BY ts DESC",
    "LIMIT 20;",
  ].join("\n");
  const res = spawnSync("sqlite3", ["-separator", "\t", ledgerDb, sql], {
    encoding: "utf8",
  });
  if (res.status !== 0) return null;
  const out = res.stdout ?? "";
  if (out.trim().length === 0) return [];
  const records: AlertRecord[] = [];
  for (const line of out.split("\n").filter(Boolean)) {
    const cols = line.split("\t");
    records.push({
      alertId: cols[0] ?? "",
      severity: cols[1] ?? "",
      category: cols[2] ?? "",
      source: cols[3] ?? "",
      summary: cols[4] ?? "",
      ts: cols[5] ?? "",
    });
  }
  return records;
}

// --- main entry ------------------------------------------------------------

export function generateContextPack(opts: PackOptions): ContextPack {
  const repoRoot = opts.repoRoot ?? REPO_ROOT_DEFAULT;
  if (!existsSync(resolve(repoRoot, "package.json"))) {
    throw new Error(`repoRoot does not look like a repo: ${repoRoot}`);
  }
  // Cheap repo identity check: package.json should declare name "frontier-os".
  const warnings: string[] = [];
  try {
    const pkg = JSON.parse(
      readFileSync(resolve(repoRoot, "package.json"), "utf8"),
    ) as { name?: string };
    if (pkg.name !== REPO_MARKER) {
      warnings.push(
        `repo identity mismatch: package.json name is "${pkg.name}", expected "${REPO_MARKER}"`,
      );
    }
  } catch (err) {
    warnings.push(
      `could not read package.json: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  const lane = readFactoryRef(repoRoot, opts.lane);
  const branch = readBranch(repoRoot);
  const headSha = readHead(repoRoot);
  const recentCommits = readRecentCommits(repoRoot, 10);
  const gitStatus = readGitStatus(repoRoot);
  const evidence = readEvidenceSummary(repoRoot, opts.lane, repoRoot);

  let recentAlerts: AlertRecord[] | null = null;
  if (opts.includeAlerts !== false) {
    const ledgerDb =
      opts.ledgerDb ?? resolve(homedir(), ".frontier", "ledger.db");
    recentAlerts = readRecentAlertsForLane(
      ledgerDb,
      lane.alert.source,
      opts.alertLookbackDays ?? 7,
    );
    if (recentAlerts === null) {
      warnings.push(
        `ledger not readable at ${ledgerDb}; alerts section omitted`,
      );
    }
  }

  const verificationCommands = [
    "npm run typecheck",
    `node --import tsx --test factories/${opts.lane}/tests/factory.test.ts`,
    `node --import tsx factories/${opts.lane}/run.ts`,
  ];
  if (opts.lane === "ai-stack-local-smoke") {
    verificationCommands.push(
      `FACTORY_LIVE=1 node --import tsx --test factories/${opts.lane}/tests/factory.test.ts`,
    );
  }

  const forbiddenAreas = [
    ...lane.policy.forbiddenActions,
    "Siri / menu-bar app (separate lane, do not import context)",
    "companion-platform repo (separate concern)",
    "/Users/test/bin scripts (read-only from this lane; do not edit from factory)",
  ];

  const followUps = [
    "launchd lane is not yet wired to invoke the factory wrapper",
    "factory.run_* event kinds not added to src/ledger/events.ts (piggy-backing on system + ops.repair_*)",
    "no retention policy on per-run evidence artifacts",
  ];

  return {
    generatedAt: new Date().toISOString(),
    repo: {
      marker: REPO_MARKER,
      root: repoRoot,
      remote: readRemote(repoRoot),
    },
    branch,
    headSha,
    recentCommits,
    gitStatus,
    lane,
    evidence,
    recentAlerts,
    verificationCommands,
    forbiddenAreas,
    followUps,
    warnings,
  };
}

// --- markdown renderer ----------------------------------------------------

export function renderMarkdown(pack: ContextPack): string {
  const lines: string[] = [];
  const push = (s = "") => lines.push(s);

  push(`# Lane context pack — ${pack.lane.factoryId}`);
  push("");
  push(
    `**This is the \`${pack.repo.marker}\` repo.** Do not import context from ai-os, Siri, or companion-platform when working on this lane.`,
  );
  push("");
  push(`- Generated: \`${pack.generatedAt}\``);
  push(`- Repo root: \`${pack.repo.root}\``);
  push(`- Remote: \`${pack.repo.remote ?? "(none)"}\``);
  push(`- Branch: \`${pack.branch}\``);
  push(`- HEAD: \`${pack.headSha || "(unknown)"}\``);
  push("");

  push("## Git status");
  push("");
  if (pack.gitStatus.clean) {
    push("Working tree is clean.");
  } else {
    push(
      `Working tree is **dirty** — ${pack.gitStatus.modified.length} modified, ${pack.gitStatus.untracked.length} untracked. Verify whose work this is before editing.`,
    );
    push("");
    push("```");
    for (const line of pack.gitStatus.rawLines) push(line);
    push("```");
  }
  push("");

  push("## Recent commits");
  push("");
  push("```");
  for (const c of pack.recentCommits) push(c);
  push("```");
  push("");

  push("## Factory");
  push("");
  push(`- Factory id: \`${pack.lane.factoryId}\``);
  push(`- Version: \`${pack.lane.version}\``);
  push(`- Spec: \`${pack.lane.factorySpecPath}\``);
  push(`- Objective: ${pack.lane.objective}`);
  push(`- Summary: ${pack.lane.summary}`);
  push("");

  push("## Lane wiring (external integration surfaces)");
  push("");
  push(`- launchd label: \`${pack.lane.lane.launchdLabel}\``);
  push(`- launchd plist: \`${pack.lane.lane.launchdPlist}\``);
  push(`- verifier entry: \`${pack.lane.lane.verifierEntry}\``);
  push(
    `- **primary verifier**: \`${pack.lane.lane.primaryVerifier.join(" ")}\``,
  );
  push(`- inner check: \`${pack.lane.lane.innerCheck.join(" ")}\``);
  push(`- logs.out: \`${pack.lane.lane.logs.out}\``);
  push(`- logs.err: \`${pack.lane.lane.logs.err}\``);
  push("");

  push("## Kill switch");
  push("");
  push(`- Path: \`${pack.lane.killSwitch.path}\``);
  push(
    `- Currently: **${pack.lane.killSwitch.active ? "ACTIVE — factory will not run" : "inactive"}**`,
  );
  push("");

  push("## Bounded repair");
  push("");
  push(`- Kind: \`${pack.lane.boundedRepair.kind}\``);
  push(`- Target: \`${pack.lane.boundedRepair.target}\``);
  push(
    `- Minimum timeout (seconds): \`${pack.lane.boundedRepair.minTimeoutSeconds}\``,
  );
  push(`- Destructive: \`${pack.lane.boundedRepair.destructive}\``);
  push(`- Rollback: \`${pack.lane.boundedRepair.rollback}\``);
  push("");

  push("## Policy");
  push("");
  push(`- approvalClass: ${pack.lane.policy.approvalClass}`);
  push("- Allowed actions:");
  for (const a of pack.lane.policy.allowedActions) push(`  - ${a}`);
  push("- Forbidden actions:");
  for (const a of pack.lane.policy.forbiddenActions) push(`  - ${a}`);
  push("- Escalation triggers:");
  for (const a of pack.lane.policy.escalation) push(`  - ${a}`);
  push("");

  push("## Forbidden areas (do not touch from this lane)");
  push("");
  for (const a of pack.forbiddenAreas) push(`- ${a}`);
  push("");

  push("## Evidence at rest (committed)");
  push("");
  push(`- Directory: \`${pack.evidence.dir}\``);
  if (pack.evidence.committedFiles.length === 0) {
    push("- (no committed evidence files)");
  } else {
    for (const f of pack.evidence.committedFiles) {
      push(`- \`${f.name}\` (${f.bytes} B)`);
    }
  }
  push(
    `- Per-run artifacts on disk (gitignored): ${pack.evidence.runArtifactCount}`,
  );
  push("");

  push("## Recent alerts (read-only ledger query)");
  push("");
  if (pack.recentAlerts === null) {
    push("- (ledger not readable; alerts not queried)");
  } else if (pack.recentAlerts.length === 0) {
    push("- (no alerts in lookback window)");
  } else {
    push("| ts | severity | alertId | summary |");
    push("|---|---|---|---|");
    for (const a of pack.recentAlerts) {
      const summarySafe = a.summary.replace(/\|/g, "\\|").slice(0, 80);
      push(
        `| \`${a.ts}\` | ${a.severity} | \`${a.alertId}\` | ${summarySafe} |`,
      );
    }
  }
  push("");

  push("## Verification commands");
  push("");
  push("```sh");
  for (const c of pack.verificationCommands) push(c);
  push("```");
  push("");

  push("## Known follow-ups / ambiguities");
  push("");
  for (const f of pack.followUps) push(`- ${f}`);
  push("");

  if (pack.warnings.length > 0) {
    push("## Warnings");
    push("");
    for (const w of pack.warnings) push(`- ${w}`);
    push("");
  }

  push("---");
  push("");
  push(
    `_End of context pack. Repo: \`${pack.repo.marker}\`. Use this packet, not memory of other repos, when working on \`${pack.lane.factoryId}\`._`,
  );
  push("");
  return lines.join("\n");
}
