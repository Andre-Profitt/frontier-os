// Tiny async `az` CLI wrapper used by the `whoami` fallback path.
// Mirrors the gh-wrap pattern from src/adapters/github/index.ts: spawn the
// binary, capture stdout/stderr, never throw.

import { spawn } from "node:child_process";

const AZ_BIN = process.env["FRONTIER_AZ_BIN"] ?? "az";

export interface AzRunResult {
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  argv: string[];
  spawnError?: Error;
}

/**
 * Spawn `az` asynchronously, collecting stdout + stderr. Never throws; always
 * resolves with an AzRunResult so callers can translate to AdapterResult shape.
 */
export function runAz(
  args: string[],
  timeoutMs?: number,
): Promise<AzRunResult> {
  return new Promise((resolve) => {
    const child = spawn(AZ_BIN, args, {
      stdio: ["ignore", "pipe", "pipe"],
    });
    const argv = [AZ_BIN, ...args];

    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let timer: NodeJS.Timeout | undefined;

    if (timeoutMs !== undefined && timeoutMs > 0) {
      timer = setTimeout(() => {
        timedOut = true;
        child.kill("SIGTERM");
      }, timeoutMs);
    }

    child.stdout?.on("data", (chunk) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr?.on("data", (chunk) => {
      stderr += chunk.toString("utf8");
    });

    child.on("error", (err) => {
      if (timer) clearTimeout(timer);
      resolve({
        code: null,
        signal: null,
        stdout,
        stderr: stderr || err.message,
        argv,
        spawnError: err,
      });
    });

    child.on("close", (code, signal) => {
      if (timer) clearTimeout(timer);
      const effectiveStderr =
        timedOut && !stderr ? `az timed out after ${timeoutMs}ms` : stderr;
      resolve({
        code,
        signal,
        stdout,
        stderr: effectiveStderr,
        argv,
      });
    });
  });
}

export function azBin(): string {
  return AZ_BIN;
}
