// Kaggle adapter — wraps the Python `kaggle` CLI via spawn.
//
// Per lift manifest: the `kaggle-node` npm package is DEAD (0 stars, 2024-06
// release, datasets only). Python CLI is canonical and authed via
// ~/.kaggle/kaggle.json. We shell out; flag the Python dep explicitly in the
// `whoami` smoke test.

import { spawn } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { mkdirSync } from "node:fs";
import { resolve as resolvePath } from "node:path";
import { homedir } from "node:os";

import type { AdapterImpl } from "../../registry.ts";
import type {
  AdapterInvocation,
  AdapterManifest,
  AdapterResult,
} from "../../schemas.ts";

const KAGGLE_BIN = process.env.FRONTIER_KAGGLE_BIN ?? "kaggle";
const DEFAULT_TIMEOUT_MS = 120_000;

export async function createKaggleAdapter(
  manifest: AdapterManifest,
): Promise<AdapterImpl> {
  return {
    manifest,
    async invoke(invocation: AdapterInvocation): Promise<AdapterResult> {
      const args = (invocation.arguments ?? {}) as Record<string, unknown>;
      switch (invocation.command) {
        case "list-kernels":
          return listKernels(invocation, args);
        case "list-competitions":
          return listCompetitions(invocation, args);
        case "kernel-status":
          return kernelStatus(invocation, args);
        case "download-dataset":
          return downloadDataset(invocation, args);
        case "whoami":
          return whoami(invocation);
        case "submit-competition":
          return submitCompetition(invocation, args);
        default:
          return failed(
            invocation,
            `unknown kaggle command: ${invocation.command}`,
          );
      }
    },
  };
}

async function listKernels(
  invocation: AdapterInvocation,
  args: Record<string, unknown>,
): Promise<AdapterResult> {
  const kArgs = ["kernels", "list", "--csv"];
  if (args.mine !== false) kArgs.push("-m");
  if (args.search && typeof args.search === "string") {
    kArgs.push("-s", args.search);
  }
  const limit = typeof args.limit === "number" ? args.limit : 20;
  kArgs.push("--page-size", String(limit));
  const r = await runKaggle(kArgs);
  if (!r.ok) return rToFailed(invocation, r, "list-kernels");
  const kernels = parseCsv(r.stdout);
  return ok(invocation, `${kernels.length} kernel(s)`, {
    count: kernels.length,
    kernels,
  });
}

async function listCompetitions(
  invocation: AdapterInvocation,
  args: Record<string, unknown>,
): Promise<AdapterResult> {
  const kArgs = ["competitions", "list", "--csv"];
  if (typeof args.category === "string")
    kArgs.push("--category", args.category);
  if (typeof args.search === "string") kArgs.push("-s", args.search);
  const r = await runKaggle(kArgs);
  if (!r.ok) return rToFailed(invocation, r, "list-competitions");
  const comps = parseCsv(r.stdout);
  return ok(invocation, `${comps.length} competition(s)`, {
    count: comps.length,
    competitions: comps,
  });
}

async function kernelStatus(
  invocation: AdapterInvocation,
  args: Record<string, unknown>,
): Promise<AdapterResult> {
  const slug = typeof args.slug === "string" ? args.slug : "";
  if (!slug)
    return failed(
      invocation,
      "kernel-status requires 'slug' (user/kernel-name)",
    );
  const r = await runKaggle(["kernels", "status", slug]);
  if (!r.ok) return rToFailed(invocation, r, "kernel-status");
  return ok(invocation, `status: ${r.stdout.trim().slice(0, 100)}`, {
    slug,
    raw: r.stdout.trim(),
  });
}

async function downloadDataset(
  invocation: AdapterInvocation,
  args: Record<string, unknown>,
): Promise<AdapterResult> {
  const dataset = typeof args.dataset === "string" ? args.dataset : "";
  if (!dataset) {
    return failed(
      invocation,
      "download-dataset requires 'dataset' (owner/slug)",
    );
  }
  const destination =
    typeof args.path === "string"
      ? args.path
      : resolvePath(homedir(), ".frontier", "kaggle", "datasets");
  mkdirSync(destination, { recursive: true });
  const kArgs = ["datasets", "download", "-d", dataset, "-p", destination];
  if (args.unzip === true) kArgs.push("--unzip");
  const r = await runKaggle(kArgs);
  if (!r.ok) return rToFailed(invocation, r, "download-dataset");

  const expectedZip = resolvePath(
    destination,
    `${dataset.split("/").pop() ?? dataset}.zip`,
  );
  const zipPresent = existsSync(expectedZip)
    ? { path: expectedZip, size: statSync(expectedZip).size }
    : null;

  return {
    invocationId: invocation.invocationId,
    adapterId: "kaggle",
    command: invocation.command,
    finishedAt: new Date().toISOString(),
    status: "success",
    summary: `${dataset} → ${destination}`,
    observedState: {
      dataset,
      destination,
      stdout: r.stdout.slice(0, 2000),
      zip: zipPresent,
    },
    artifacts: zipPresent
      ? [
          {
            kind: "file" as const,
            ref: zipPresent.path,
            note: `dataset zip: ${dataset}`,
          },
        ]
      : [],
    sideEffects: [
      {
        class: "local_write",
        target: destination,
        summary: `kaggle datasets download ${dataset}`,
      },
    ],
  };
}

async function whoami(invocation: AdapterInvocation): Promise<AdapterResult> {
  const r = await runKaggle(["config", "view"]);
  if (!r.ok) return rToFailed(invocation, r, "whoami");
  const text = r.stdout;
  const userMatch = text.match(/username:\s*(\S+)/i);
  const pathMatch = text.match(/config(?:uration)? file.*?:\s*(.+)/i);
  return ok(invocation, `auth ok`, {
    username: userMatch ? userMatch[1] : null,
    configPath:
      pathMatch && pathMatch[1]
        ? pathMatch[1].trim()
        : resolvePath(homedir(), ".kaggle", "kaggle.json"),
    rawConfig: text.slice(0, 500),
  });
}

// --- helpers ---

async function submitCompetition(
  invocation: AdapterInvocation,
  args: Record<string, unknown>,
): Promise<AdapterResult> {
  const competition =
    typeof args.competition === "string" ? args.competition : "";
  const filePath = typeof args.file === "string" ? args.file : "";
  const message = typeof args.message === "string" ? args.message : "";
  if (!competition) {
    return failed(
      invocation,
      "submit-competition requires 'competition' (slug)",
    );
  }
  if (!filePath) {
    return failed(
      invocation,
      "submit-competition requires 'file' (path to submission)",
    );
  }
  if (!message) {
    return failed(
      invocation,
      "submit-competition requires 'message' (submission note)",
    );
  }

  // Propose mode: preview the exact kaggle argv + file-existence check.
  // No subprocess call. Ghost Shift and human review both inspect intent
  // before a single scoring-board write.
  if (invocation.mode === "propose") {
    const kArgs = [
      "competitions",
      "submit",
      "-c",
      competition,
      "-f",
      filePath,
      "-m",
      message,
    ];
    const fileExists = existsSync(filePath);
    const fileSize = fileExists
      ? (() => {
          try {
            return statSync(filePath).size;
          } catch {
            return null;
          }
        })()
      : null;
    return {
      invocationId: invocation.invocationId,
      adapterId: "kaggle",
      command: invocation.command,
      finishedAt: new Date().toISOString(),
      status: "success",
      summary: `propose: would submit ${filePath} to ${competition}`,
      observedState: {
        mode: "propose",
        competition,
        file: filePath,
        fileExists,
        fileSize,
        message,
        argv: [KAGGLE_BIN, ...kArgs],
      },
      sideEffects: [
        {
          class: "shared_write",
          target: `kaggle competition ${competition}`,
          summary: `would submit "${message}" to ${competition}`,
        },
      ],
    };
  }

  // Apply mode: real submission. Kaggle CLI prints human text, not JSON;
  // we capture the whole stdout and surface it under observedState so the
  // operator can see the leaderboard line / error text from the CLI itself.
  const kArgs = [
    "competitions",
    "submit",
    "-c",
    competition,
    "-f",
    filePath,
    "-m",
    message,
  ];
  const r = await runKaggle(kArgs);
  if (!r.ok) return rToFailed(invocation, r, "submit-competition");
  return {
    invocationId: invocation.invocationId,
    adapterId: "kaggle",
    command: invocation.command,
    finishedAt: new Date().toISOString(),
    status: "success",
    summary: `submitted ${filePath} to ${competition}`,
    observedState: {
      mode: "apply",
      competition,
      file: filePath,
      message,
      raw: r.stdout.slice(0, 2000),
    },
    sideEffects: [
      {
        class: "shared_write",
        target: `kaggle competition ${competition}`,
        summary: `submitted "${message}" to ${competition}`,
      },
    ],
  };
}

interface RunResult {
  ok: boolean;
  stdout: string;
  stderr: string;
  exitCode: number | null;
  missingBinary: boolean;
  timedOut: boolean;
}

function runKaggle(args: string[]): Promise<RunResult> {
  return new Promise((resolve) => {
    const proc = spawn(KAGGLE_BIN, args, { timeout: DEFAULT_TIMEOUT_MS });
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
        timedOut: false,
      });
    });
    proc.on("close", (code, signal) => {
      resolve({
        ok: code === 0,
        stdout,
        stderr,
        exitCode: code,
        missingBinary,
        timedOut: signal === "SIGTERM" || signal === "SIGKILL",
      });
    });
  });
}

function parseCsv(text: string): Record<string, string>[] {
  const lines = text.split(/\r?\n/).filter((l) => l.trim());
  if (lines.length < 1) return [];
  const header = splitCsvLine(lines[0]!);
  const rows: Record<string, string>[] = [];
  for (let i = 1; i < lines.length; i++) {
    const parts = splitCsvLine(lines[i]!);
    const row: Record<string, string> = {};
    for (let j = 0; j < header.length; j++) {
      row[header[j]!] = parts[j] ?? "";
    }
    rows.push(row);
  }
  return rows;
}

function splitCsvLine(line: string): string[] {
  // Kaggle's CSV is simple (no embedded commas or newlines observed in field
  // values from their fixed schemas), so a split-and-trim is sufficient.
  return line.split(",").map((p) => p.trim());
}

function ok(
  invocation: AdapterInvocation,
  summary: string,
  observedState: Record<string, unknown>,
): AdapterResult {
  return {
    invocationId: invocation.invocationId,
    adapterId: "kaggle",
    command: invocation.command,
    finishedAt: new Date().toISOString(),
    status: "success",
    summary,
    observedState,
  };
}

function rToFailed(
  invocation: AdapterInvocation,
  r: RunResult,
  op: string,
): AdapterResult {
  const hint = r.missingBinary
    ? `kaggle CLI not on PATH. Install: pip install kaggle. Set FRONTIER_KAGGLE_BIN to override.`
    : r.timedOut
      ? `kaggle ${op} timed out after ${DEFAULT_TIMEOUT_MS}ms`
      : `kaggle ${op} exit ${r.exitCode ?? "(signal)"}: ${r.stderr.slice(0, 200)}`;
  return {
    invocationId: invocation.invocationId,
    adapterId: "kaggle",
    command: invocation.command,
    finishedAt: new Date().toISOString(),
    status: "failed",
    summary: hint,
    observedState: {
      hint,
      missingBinary: r.missingBinary,
      stderr: r.stderr.slice(0, 1000),
      stdout: r.stdout.slice(0, 500),
      exitCode: r.exitCode,
    },
  };
}

function failed(invocation: AdapterInvocation, message: string): AdapterResult {
  return {
    invocationId: invocation.invocationId,
    adapterId: "kaggle",
    command: invocation.command,
    finishedAt: new Date().toISOString(),
    status: "failed",
    summary: message,
    observedState: { error: message },
  };
}
