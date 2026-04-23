// Terminal adapter — policy-gated local shell execution.
//
// Per lift manifest (docs/lift-manifests/adapters-and-research-primitive.md),
// this wraps `execa` for safe subprocess management and adds a hand-rolled
// SideEffectClass classifier (side-effects.ts) so the rest of Frontier OS can
// reason about approval classes without each caller re-implementing the map.
//
// Scope v0.1: run-command, read-file, list-dir, which.
// Deferred: stop-process, queue-command (pueue backend), streaming stdout.

import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { resolve as resolvePath } from "node:path";
import { execa } from "execa";

import type { AdapterImpl } from "../../registry.ts";
import type {
  AdapterInvocation,
  AdapterManifest,
  AdapterResult,
  AdapterStatus,
} from "../../schemas.ts";
import { classifyCommand } from "./side-effects.ts";

const DEFAULT_TIMEOUT_MS = 120_000;
const MAX_STDOUT = 16_000;
const MAX_STDERR = 8_000;

export async function createTerminalAdapter(
  manifest: AdapterManifest,
): Promise<AdapterImpl> {
  return {
    manifest,
    async invoke(invocation: AdapterInvocation): Promise<AdapterResult> {
      const args = (invocation.arguments ?? {}) as Record<string, unknown>;
      switch (invocation.command) {
        case "run-command":
          return runCommand(invocation, args);
        case "read-file":
          return readFile(invocation, args);
        case "list-dir":
          return listDir(invocation, args);
        case "which":
          return which(invocation, args);
        default:
          return failed(
            invocation,
            `unknown terminal command: ${invocation.command}`,
          );
      }
    },
  };
}

async function runCommand(
  invocation: AdapterInvocation,
  args: Record<string, unknown>,
): Promise<AdapterResult> {
  const command = String(args.command ?? "");
  if (!command) {
    return failed(invocation, "run-command requires 'command'");
  }
  const rawArgs = Array.isArray(args.args)
    ? (args.args as unknown[]).map((a) => String(a))
    : [];
  const cwd = typeof args.cwd === "string" ? args.cwd : process.cwd();
  const timeoutMs =
    typeof args.timeoutMs === "number" ? args.timeoutMs : DEFAULT_TIMEOUT_MS;
  const stdinText = typeof args.stdin === "string" ? args.stdin : undefined;

  const classification = classifyCommand({ command, args: rawArgs });

  // Mode semantics:
  //   read   — only permitted if classification == "none"
  //   propose — return the classification + preview, do NOT execute
  //   apply  — execute
  if (invocation.mode === "read" && classification.sideEffectClass !== "none") {
    return {
      invocationId: invocation.invocationId,
      adapterId: "terminal",
      command: invocation.command,
      finishedAt: new Date().toISOString(),
      status: "blocked",
      summary: `command classified as ${classification.sideEffectClass}; mode=read refuses`,
      observedState: {
        classification,
        command,
        args: rawArgs,
      },
    };
  }
  if (invocation.mode === "propose") {
    return {
      invocationId: invocation.invocationId,
      adapterId: "terminal",
      command: invocation.command,
      finishedAt: new Date().toISOString(),
      status: "success",
      summary: `would run: ${command} ${rawArgs.join(" ")}`,
      observedState: {
        classification,
        command,
        args: rawArgs,
        cwd,
      },
    };
  }

  try {
    const child = execa(command, rawArgs, {
      cwd,
      timeout: timeoutMs,
      shell: false,
      stripFinalNewline: false,
      reject: false,
      encoding: "utf8",
      ...(stdinText !== undefined ? { input: stdinText } : {}),
    });
    const result = await child;
    const stdout = truncate(result.stdout ?? "", MAX_STDOUT);
    const stderr = truncate(result.stderr ?? "", MAX_STDERR);
    const exitCode = result.exitCode ?? -1;
    const ok = exitCode === 0 && !result.timedOut;
    const status: AdapterStatus = ok ? "success" : "failed";
    return {
      invocationId: invocation.invocationId,
      adapterId: "terminal",
      command: invocation.command,
      finishedAt: new Date().toISOString(),
      status,
      summary: `${command} ${rawArgs.join(" ")} -> exit ${exitCode}${result.timedOut ? " (timed out)" : ""}`,
      observedState: {
        classification,
        command,
        args: rawArgs,
        cwd,
        exitCode,
        timedOut: Boolean(result.timedOut),
        stdout,
        stderr,
      },
      sideEffects:
        classification.sideEffectClass === "none"
          ? []
          : [
              {
                class: classification.sideEffectClass,
                target: `${command} ${rawArgs.join(" ")}`.trim(),
                summary: classification.reason,
              },
            ],
    };
  } catch (err) {
    return failed(
      invocation,
      `execa threw: ${err instanceof Error ? err.message : String(err)}`,
      { command, args: rawArgs, classification },
    );
  }
}

function readFile(
  invocation: AdapterInvocation,
  args: Record<string, unknown>,
): AdapterResult {
  const path = String(args.path ?? "");
  if (!path) return failed(invocation, "read-file requires 'path'");
  const resolved = resolvePath(path);
  if (!existsSync(resolved)) {
    return failed(invocation, `file not found: ${resolved}`);
  }
  try {
    const content = readFileSync(resolved, "utf8");
    return {
      invocationId: invocation.invocationId,
      adapterId: "terminal",
      command: "read-file",
      finishedAt: new Date().toISOString(),
      status: "success",
      summary: `${resolved} (${content.length} chars)`,
      observedState: {
        path: resolved,
        bytes: content.length,
        content: truncate(content, MAX_STDOUT),
      },
    };
  } catch (err) {
    return failed(
      invocation,
      `read failed: ${err instanceof Error ? err.message : String(err)}`,
      { path: resolved },
    );
  }
}

function listDir(
  invocation: AdapterInvocation,
  args: Record<string, unknown>,
): AdapterResult {
  const path = String(args.path ?? "");
  if (!path) return failed(invocation, "list-dir requires 'path'");
  const resolved = resolvePath(path);
  if (!existsSync(resolved)) {
    return failed(invocation, `dir not found: ${resolved}`);
  }
  try {
    const entries = readdirSync(resolved).map((name) => {
      const full = resolvePath(resolved, name);
      let kind = "other";
      try {
        const s = statSync(full);
        kind = s.isDirectory() ? "dir" : s.isFile() ? "file" : "other";
      } catch {
        /* dangling symlink, etc. */
      }
      return { name, kind };
    });
    return {
      invocationId: invocation.invocationId,
      adapterId: "terminal",
      command: "list-dir",
      finishedAt: new Date().toISOString(),
      status: "success",
      summary: `${resolved} (${entries.length} entries)`,
      observedState: { path: resolved, entries },
    };
  } catch (err) {
    return failed(
      invocation,
      `list failed: ${err instanceof Error ? err.message : String(err)}`,
      { path: resolved },
    );
  }
}

async function which(
  invocation: AdapterInvocation,
  args: Record<string, unknown>,
): Promise<AdapterResult> {
  const name = String(args.name ?? "");
  if (!name) return failed(invocation, "which requires 'name'");
  try {
    const r = await execa("which", [name], { reject: false });
    const out = (r.stdout ?? "").trim();
    const ok = r.exitCode === 0 && out.length > 0;
    return {
      invocationId: invocation.invocationId,
      adapterId: "terminal",
      command: "which",
      finishedAt: new Date().toISOString(),
      status: ok ? "success" : "failed",
      summary: ok ? `${name} -> ${out}` : `${name} not on PATH`,
      observedState: { name, path: ok ? out : null, exitCode: r.exitCode },
    };
  } catch (err) {
    return failed(
      invocation,
      `which failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

// --- helpers ---

function truncate(s: string, n: number): string {
  return s.length > n ? s.slice(0, n) + `...(+${s.length - n} chars)` : s;
}

function failed(
  invocation: AdapterInvocation,
  message: string,
  extra?: Record<string, unknown>,
): AdapterResult {
  return {
    invocationId: invocation.invocationId,
    adapterId: "terminal",
    command: invocation.command,
    finishedAt: new Date().toISOString(),
    status: "failed",
    summary: message,
    observedState: { error: message, ...(extra ?? {}) },
  };
}
