// Pluggable verifier service for work-graph nodes.
//
// Replaces the Phase-6 placeholder that only checked "dispatch succeeded +
// payload non-empty". Per vision §5.3 "Verification Before Side Effects",
// class 2+ side effects should not land without a passing verifier. This
// module provides six check types matching schemas/work-graph.schema.json:
//
//   tests             run a CLI test command, expect exit 0
//   lint              run a CLI lint command, expect exit 0
//   policy            node sideEffects must not violate graph's
//                     approvalPolicy.requireHumanFor without explicit approval
//   trace_grade       pattern-match dispatch stdout/stderr for red flags
//                     (TODO, stub, dummy, traceback, error) and optional
//                     operator-supplied rubricPatterns
//   artifact_schema   payload non-empty AND, if outputs declare locations,
//                     they must exist on disk
//   human_review      block until ~/.frontier/reviews/<graphId>.<nodeId>.approved
//                     token file is present; MVP equivalent to approval nodes
//
// Each check is isolated — a failure in one does NOT short-circuit the others
// (useful for batch reporting of "this node failed 2 of 3 checks"). Overall
// verifier `passed` is the AND of all required check outcomes.

import { existsSync, statSync } from "node:fs";
import { spawn } from "node:child_process";
import { resolve } from "node:path";
import { homedir } from "node:os";

import type { WorkGraph, WorkNode, SideEffectClass } from "./graph.ts";
import type { DispatchResult } from "./dispatcher.ts";

export type CheckName =
  | "tests"
  | "lint"
  | "policy"
  | "trace_grade"
  | "artifact_schema"
  | "human_review";

export interface CheckResult {
  name: CheckName;
  passed: boolean;
  reason: string;
  evidence?: Record<string, unknown>;
}

export interface VerifierResult {
  required: boolean;
  passed: boolean;
  reason: string;
  checks: CheckResult[];
}

export interface VerifierContext {
  graph: WorkGraph;
  autoApprove: boolean;
}

/** Dispatch-driven entry point. Returns a summary + per-check detail. */
export async function runVerifier(
  node: WorkNode,
  dispatch: DispatchResult,
  ctx: VerifierContext,
): Promise<VerifierResult> {
  const mode = node.verifierPolicy.mode;
  if (mode === "none") {
    return {
      required: false,
      passed: true,
      reason: "verifier disabled",
      checks: [],
    };
  }
  const hasSideEffects =
    (node.sideEffects ?? []).filter((s) => s !== "none").length > 0;
  if (mode === "required_before_side_effect" && !hasSideEffects) {
    return {
      required: false,
      passed: true,
      reason: "no side effects",
      checks: [],
    };
  }

  const configured = (node.verifierPolicy.checks ?? []) as CheckName[];
  // If no explicit checks listed but mode is required, fall back to the
  // implicit "did dispatch succeed and return something" default.
  const effective: CheckName[] =
    configured.length > 0 ? configured : ["artifact_schema"];

  const results: CheckResult[] = [];
  for (const name of effective) {
    results.push(await runCheck(name, node, dispatch, ctx));
  }

  const passed = results.every((r) => r.passed);
  return {
    required: true,
    passed,
    reason: passed
      ? `all ${results.length} check(s) passed`
      : results
          .filter((r) => !r.passed)
          .map((r) => `${r.name}: ${r.reason}`)
          .join("; "),
    checks: results,
  };
}

async function runCheck(
  name: CheckName,
  node: WorkNode,
  dispatch: DispatchResult,
  ctx: VerifierContext,
): Promise<CheckResult> {
  switch (name) {
    case "tests":
      return checkCli(name, node, "tests");
    case "lint":
      return checkCli(name, node, "lint");
    case "policy":
      return checkPolicy(node, ctx);
    case "trace_grade":
      return checkTraceGrade(node, dispatch);
    case "artifact_schema":
      return checkArtifactSchema(node, dispatch);
    case "human_review":
      return checkHumanReview(node, ctx);
    default:
      return {
        name,
        passed: false,
        reason: `unknown check name: ${name}`,
      };
  }
}

// ---- tests / lint ----

async function checkCli(
  name: CheckName,
  node: WorkNode,
  configKey: string,
): Promise<CheckResult> {
  const cfg = readConfig(node, configKey);
  if (!cfg || typeof cfg.command !== "string") {
    return {
      name,
      passed: false,
      reason: `verifier ${configKey} requires config.${configKey}.command`,
    };
  }
  const command = String(cfg.command);
  const args = Array.isArray(cfg.args)
    ? (cfg.args as unknown[]).map((a) => String(a))
    : [];
  const cwd = typeof cfg.cwd === "string" ? cfg.cwd : process.cwd();
  const timeoutMs = typeof cfg.timeoutMs === "number" ? cfg.timeoutMs : 120_000;

  return new Promise<CheckResult>((resolve) => {
    const proc = spawn(command, args, { cwd, timeout: timeoutMs });
    let stdout = "";
    let stderr = "";
    proc.stdout?.on("data", (chunk: Buffer | string) => {
      stdout += typeof chunk === "string" ? chunk : chunk.toString("utf8");
    });
    proc.stderr?.on("data", (chunk: Buffer | string) => {
      stderr += typeof chunk === "string" ? chunk : chunk.toString("utf8");
    });
    proc.on("error", (err) => {
      resolve({
        name,
        passed: false,
        reason: `${command} failed to spawn: ${err.message}`,
      });
    });
    proc.on("close", (code, signal) => {
      const exitCode = code ?? -1;
      resolve({
        name,
        passed: exitCode === 0,
        reason:
          exitCode === 0
            ? `${command} exited 0`
            : `${command} exited ${exitCode}${signal ? ` (signal ${signal})` : ""}`,
        evidence: {
          command,
          args,
          exitCode,
          stdout: truncate(stdout, 2000),
          stderr: truncate(stderr, 2000),
        },
      });
    });
    proc.stdin?.end();
  });
}

// ---- policy ----

function checkPolicy(node: WorkNode, ctx: VerifierContext): CheckResult {
  const sideEffects = (node.sideEffects ?? []) as SideEffectClass[];
  const requireHuman = ctx.graph.approvalPolicy.requireHumanFor ?? [];

  // Map side effects to the higher-level labels the graph's approvalPolicy uses.
  const mapping: Record<string, string[]> = {
    deploy: ["deploy"],
    external_message: ["external_message"],
    auth_change: ["auth_change"],
    financial_action: ["financial_action"],
    repo_write: ["prod_write"], // conservative: repo writes count as prod_write
    pr_open: ["prod_write"],
    shared_write: ["prod_write"],
  };

  const violations: string[] = [];
  for (const se of sideEffects) {
    const mapped = mapping[se] ?? [];
    for (const label of mapped) {
      if (requireHuman.includes(label) && !ctx.autoApprove) {
        violations.push(`${se} requires human approval (${label})`);
      }
    }
  }

  if (violations.length === 0) {
    return {
      name: "policy",
      passed: true,
      reason:
        sideEffects.length === 0
          ? "no side effects declared"
          : "side effects consistent with graph approval policy",
      evidence: { sideEffects, requireHuman },
    };
  }
  return {
    name: "policy",
    passed: false,
    reason: violations.join("; "),
    evidence: { sideEffects, requireHuman, violations },
  };
}

// ---- trace_grade ----

const DEFAULT_RED_FLAGS = [
  "TODO",
  "FIXME",
  "stub",
  "dummy",
  "placeholder",
  "not[- ]?implemented",
  "Traceback",
  "error:",
  "Exception:",
];

function checkTraceGrade(
  node: WorkNode,
  dispatch: DispatchResult,
): CheckResult {
  const cfg = readConfig(node, "trace_grade") ?? {};
  const extra = Array.isArray(cfg.rubricPatterns)
    ? (cfg.rubricPatterns as unknown[]).map((p) => String(p))
    : [];
  const requireNonEmptyStdout = cfg.requireNonEmptyStdout === true;

  const payload = dispatch.payload ?? {};
  const stdout = String(payload.stdout ?? "");
  const stderr = String(payload.stderr ?? "");
  const combined = `${stdout}\n${stderr}`;

  const flags = [...DEFAULT_RED_FLAGS, ...extra];
  const hits: string[] = [];
  for (const pattern of flags) {
    try {
      const re = new RegExp(pattern, "i");
      if (re.test(combined)) hits.push(pattern);
    } catch {
      /* bad regex from config — ignore */
    }
  }

  if (requireNonEmptyStdout && stdout.trim().length === 0) {
    return {
      name: "trace_grade",
      passed: false,
      reason: "expected non-empty stdout but dispatch produced none",
      evidence: { stdoutBytes: stdout.length, hits },
    };
  }

  if (hits.length === 0) {
    return {
      name: "trace_grade",
      passed: true,
      reason: "no red-flag patterns matched",
      evidence: { rubricSize: flags.length },
    };
  }
  return {
    name: "trace_grade",
    passed: false,
    reason: `trace contained red-flag patterns: ${hits.slice(0, 5).join(", ")}`,
    evidence: { hits },
  };
}

// ---- artifact_schema ----

function checkArtifactSchema(
  node: WorkNode,
  dispatch: DispatchResult,
): CheckResult {
  const dispatchSucceeded = dispatch.status === "succeeded";
  const payloadKeys = Object.keys(dispatch.payload ?? {}).length;
  const declaredOutputs = node.outputs ?? [];

  if (!dispatchSucceeded) {
    return {
      name: "artifact_schema",
      passed: false,
      reason: `dispatch did not succeed (${dispatch.status})`,
    };
  }
  if (payloadKeys === 0 && (dispatch.artifactRefs?.length ?? 0) === 0) {
    return {
      name: "artifact_schema",
      passed: false,
      reason: "dispatch returned empty payload and no artifact refs",
    };
  }

  // If outputs declare file locations, verify they exist on disk.
  const missing: string[] = [];
  for (const output of declaredOutputs) {
    const loc = output.location;
    if (!loc) continue;
    if (loc.startsWith("/") || loc.startsWith("~")) {
      const resolved = loc.startsWith("~")
        ? resolve(homedir(), loc.slice(2))
        : loc;
      try {
        if (!existsSync(resolved) || !statSync(resolved).isFile()) {
          missing.push(loc);
        }
      } catch {
        missing.push(loc);
      }
    }
  }
  if (missing.length > 0) {
    return {
      name: "artifact_schema",
      passed: false,
      reason: `declared outputs missing on disk: ${missing.join(", ")}`,
      evidence: { missing },
    };
  }

  return {
    name: "artifact_schema",
    passed: true,
    reason: "payload non-empty and declared outputs present",
    evidence: {
      payloadKeys,
      artifactRefs: dispatch.artifactRefs ?? [],
      outputs: declaredOutputs.length,
    },
  };
}

// ---- human_review ----

function checkHumanReview(node: WorkNode, ctx: VerifierContext): CheckResult {
  if (ctx.autoApprove) {
    return {
      name: "human_review",
      passed: true,
      reason: "auto-approved via --auto-approve",
    };
  }
  const tokenDir = resolve(homedir(), ".frontier", "reviews");
  const token = resolve(
    tokenDir,
    `${ctx.graph.graphId}.${node.nodeId}.approved`,
  );
  if (existsSync(token)) {
    return {
      name: "human_review",
      passed: true,
      reason: `review token present: ${token}`,
    };
  }
  return {
    name: "human_review",
    passed: false,
    reason: `awaiting human review — touch ${token}`,
    evidence: { expectedToken: token },
  };
}

// ---- shared helpers ----

function readConfig(
  node: WorkNode,
  key: string,
): Record<string, unknown> | null {
  const config = node.verifierPolicy.config ?? {};
  const val = (config as Record<string, unknown>)[key];
  return isRecord(val) ? val : null;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function truncate(s: string, n: number): string {
  return s.length > n ? s.slice(0, n) + `...(+${s.length - n} chars)` : s;
}
