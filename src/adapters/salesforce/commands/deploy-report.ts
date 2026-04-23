// salesforce:deploy-report — deploy a Report metadata file to a Salesforce
// org via the `sf` CLI. Class-2 `deploy` side effect; apply is the first live
// exercise of the "deploy" Ghost Shift refusal category (pre-existing in
// DANGEROUS_SIDE_EFFECTS, now with a real apply-mode adapter behind it).
//
// Modes:
//   - propose: verify the input file exists, parse the bare-minimum report
//     metadata shape, echo the exact `sf project deploy start` argv. No
//     subprocess call, no org mutation.
//   - apply: shell out to `sf project deploy start --metadata ... --target-org
//     <alias>`, capture stdout/stderr, surface the deploy result.
//
// We do NOT support undo: un-deploying a Report requires explicit deletion
// which is a class-3 destructive_action and belongs to a separate command.
//
// Credentials / target-org resolution:
//   - arguments.targetOrg (sf alias) takes precedence
//   - falls back to env SF_TARGET_ORG
//   - falls back to env SF_DEFAULT_ORG
//   - if none, we still proceed in propose mode (just note "no target-org
//     resolved"); apply refuses without a target-org.

import { spawn } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";

import { buildResult, failedResult } from "../../../result.ts";
import type { AdapterInvocation, AdapterResult } from "../../../schemas.ts";

const SF_BIN = process.env.FRONTIER_SF_BIN ?? "sf";
const DEFAULT_TIMEOUT_MS = 300_000;

interface DeployReportArgs {
  reportPath?: string;
  targetOrg?: string;
  dryRun?: boolean;
}

export async function deployReportCommand(
  invocation: AdapterInvocation,
): Promise<AdapterResult> {
  const args = (invocation.arguments ?? {}) as DeployReportArgs;
  const reportPath =
    typeof args.reportPath === "string" ? args.reportPath.trim() : "";
  if (!reportPath) {
    return failedResult(
      invocation,
      new Error(
        "deploy-report requires `arguments.reportPath` (path to .report-meta.xml)",
      ),
    );
  }
  const targetOrg =
    (typeof args.targetOrg === "string" && args.targetOrg.trim()) ||
    process.env["SF_TARGET_ORG"] ||
    process.env["SF_DEFAULT_ORG"] ||
    "";
  const dryRun = args.dryRun === true;

  const fileExists = existsSync(reportPath);
  const fileSize = fileExists
    ? (() => {
        try {
          return statSync(reportPath).size;
        } catch {
          return null;
        }
      })()
    : null;

  // Read a small head of the XML for the preview (don't parse fully — we just
  // want enough evidence that the file looks like Report metadata).
  let reportFullName: string | null = null;
  let reportFolder: string | null = null;
  let xmlHead: string | null = null;
  if (fileExists) {
    try {
      const raw = readFileSync(reportPath, "utf8");
      xmlHead = raw.slice(0, 600);
      const nameMatch = raw.match(/<name>([^<]+)<\/name>/);
      if (nameMatch) reportFullName = nameMatch[1]!.trim();
      const folderMatch = raw.match(/<folderName>([^<]+)<\/folderName>/);
      if (folderMatch) reportFolder = folderMatch[1]!.trim();
    } catch {
      // File read errors surface via fileExists=true but xmlHead=null, which
      // is visible in observedState — no need to bail.
    }
  }

  // Construct the canonical sf argv. apply uses this verbatim.
  const sfArgs = [
    "project",
    "deploy",
    "start",
    "--metadata-dir",
    // sf supports both --metadata-dir and --source-dir; metadata-dir is the
    // saner flag for a single-file .report-meta.xml because it treats the
    // file's parent directory as the package root. If the user already ships
    // a source-format source-dir structure we can switch later.
    deriveMetadataDir(reportPath),
  ];
  if (targetOrg) {
    sfArgs.push("--target-org", targetOrg);
  }
  if (dryRun) {
    sfArgs.push("--dry-run");
  }
  sfArgs.push("--json");

  const sideEffect = {
    class: "deploy" as const,
    target: targetOrg
      ? `salesforce org ${targetOrg}`
      : "salesforce org (resolve at runtime)",
    summary: `would deploy ${reportFullName ?? reportPath}${dryRun ? " (sf --dry-run: validation only, no org mutation)" : ""}`,
  };

  // Propose mode: no subprocess, no mutation. Echo the argv that apply would
  // run, plus evidence we can actually find the file.
  if (invocation.mode === "propose") {
    return buildResult({
      invocation,
      status: "success",
      summary: fileExists
        ? `propose: would deploy ${reportFullName ?? reportPath}${targetOrg ? ` → ${targetOrg}` : " (no target-org resolved; apply will fail)"}`
        : `propose: ${reportPath} does not exist (apply would fail fast)`,
      observedState: {
        mode: "propose",
        reportPath,
        fileExists,
        fileSize,
        reportFullName,
        reportFolder,
        targetOrg: targetOrg || null,
        dryRun,
        argv: [SF_BIN, ...sfArgs],
        xmlHead,
      },
      sideEffects: [sideEffect],
      verification: {
        status: "passed",
        checks: ["policy", "trace_grade"],
      },
    });
  }

  // Apply mode: refuse without file or target-org.
  if (!fileExists) {
    return failedResult(
      invocation,
      new Error(
        `deploy-report: ${reportPath} does not exist; propose-mode preview first`,
      ),
    );
  }
  if (!targetOrg) {
    return failedResult(
      invocation,
      new Error(
        "deploy-report apply requires arguments.targetOrg (or SF_TARGET_ORG/SF_DEFAULT_ORG env)",
      ),
    );
  }

  const run = await runSf(sfArgs);
  if (!run.ok) {
    return failedResult(
      invocation,
      new Error(
        run.missingBinary
          ? `sf CLI not on PATH (set FRONTIER_SF_BIN or install Salesforce CLI)`
          : `sf project deploy start exit ${run.exitCode ?? "(signal)"}: ${run.stderr.slice(0, 400)}`,
      ),
      {
        observedState: {
          mode: "apply",
          reportPath,
          targetOrg,
          argv: [SF_BIN, ...sfArgs],
          exitCode: run.exitCode,
          stdout: run.stdout.slice(0, 2000),
          stderr: run.stderr.slice(0, 1000),
          missingBinary: run.missingBinary,
        },
      },
    );
  }

  // sf emits JSON when --json is set; parse and surface the deploy id/result.
  let sfJson: Record<string, unknown> | null = null;
  try {
    sfJson = run.stdout.trim()
      ? (JSON.parse(run.stdout) as Record<string, unknown>)
      : null;
  } catch {
    sfJson = null;
  }
  const result = (sfJson?.["result"] ?? {}) as Record<string, unknown>;
  const deployId =
    typeof result["id"] === "string" ? (result["id"] as string) : null;
  const deploySuccess =
    result["success"] === true ||
    (typeof result["status"] === "string" &&
      (result["status"] as string).toLowerCase() === "succeeded");

  return buildResult({
    invocation,
    status: deploySuccess ? "success" : "partial",
    summary: deploySuccess
      ? `deployed ${reportFullName ?? reportPath} → ${targetOrg}${deployId ? ` (id=${deployId})` : ""}`
      : `deploy returned but success flag not set (deployId=${deployId ?? "none"}) — see observedState`,
    observedState: {
      mode: "apply",
      reportPath,
      reportFullName,
      reportFolder,
      targetOrg,
      dryRun,
      deployId,
      sfResult: sfJson,
      argv: [SF_BIN, ...sfArgs],
      stdout: run.stdout.slice(0, 4000),
    },
    sideEffects: [
      {
        ...sideEffect,
        summary: deploySuccess
          ? `deployed ${reportFullName ?? reportPath} to ${targetOrg}${deployId ? ` (deployId=${deployId})` : ""}`
          : `deploy invoked but success unclear — see observedState.sfResult`,
      },
    ],
    verification: {
      status: deploySuccess ? "passed" : "failed",
      checks: ["policy", "trace_grade"],
    },
  });
}

function deriveMetadataDir(reportPath: string): string {
  // If the user points at the file directly, deploy its parent directory.
  // If they point at a directory already, use it as-is.
  try {
    const stat = statSync(reportPath);
    if (stat.isDirectory()) return reportPath;
  } catch {
    // fall through — we'll just return the parent segment below
  }
  const lastSlash = reportPath.lastIndexOf("/");
  return lastSlash === -1 ? "." : reportPath.slice(0, lastSlash);
}

interface SfRunResult {
  ok: boolean;
  stdout: string;
  stderr: string;
  exitCode: number | null;
  missingBinary: boolean;
}

function runSf(args: string[]): Promise<SfRunResult> {
  return new Promise((resolve) => {
    const proc = spawn(SF_BIN, args, { timeout: DEFAULT_TIMEOUT_MS });
    let stdout = "";
    let stderr = "";
    let missingBinary = false;
    proc.stdout?.on("data", (c: Buffer | string) => {
      stdout += typeof c === "string" ? c : c.toString("utf8");
    });
    proc.stderr?.on("data", (c: Buffer | string) => {
      stderr += typeof c === "string" ? c : c.toString("utf8");
    });
    proc.on("error", (err) => {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        missingBinary = true;
      }
      resolve({
        ok: false,
        stdout,
        stderr: `${stderr}${err.message}`,
        exitCode: null,
        missingBinary,
      });
    });
    proc.on("close", (code) => {
      resolve({
        ok: code === 0,
        stdout,
        stderr,
        exitCode: code,
        missingBinary,
      });
    });
  });
}
