// Thin wrapper around `claude -p` (Claude Code print mode) as a subprocess.
//
// Rationale (lift manifest, adapters-and-research-primitive.md): we don't have
// an Anthropic API key in env, but Claude Code is already authenticated locally.
// Shelling out reuses that auth, gets access to the full Claude Code tool
// surface (web_search, web_fetch, read/write), and matches Frontier's CLI-first
// ethos. Each call is an isolated subprocess → isolated context window, which
// is exactly what the orchestrator-worker pattern needs.

import { execa } from "execa";

export interface ClaudeCallOptions {
  prompt: string;
  model?: string;
  maxBudgetUsd?: number;
  timeoutMs?: number;
  /** Working directory for the subprocess. Useful for scoping allowed tools. */
  cwd?: string;
}

export interface ClaudeCallResult {
  ok: boolean;
  text: string;
  exitCode: number | null;
  timedOut: boolean;
  stderr: string;
  durationMs: number;
}

const DEFAULT_TIMEOUT_MS = 240_000; // 4 minutes per call — research can take a while
const CLAUDE_BIN = process.env.FRONTIER_CLAUDE_BIN ?? "claude";

/**
 * Invoke `claude -p "<prompt>"` and capture stdout as the response.
 * Never throws — returns `ok=false` with the error captured.
 */
export async function callClaude(
  opts: ClaudeCallOptions,
): Promise<ClaudeCallResult> {
  const startedAt = Date.now();
  // Flags first, prompt last. `--max-budget-usd` is intentionally NOT passed
  // here even when opts.maxBudgetUsd is set — empirically, Opus + extended
  // thinking inside `claude -p` can silently exit 1 at sub-budget values with
  // empty stderr (no "budget exceeded" signal). Budget enforcement should
  // live at the adapter/side-effect-policy layer instead, not per-call.
  const args: string[] = [];
  if (opts.model) args.push("--model", opts.model);
  args.push("-p", opts.prompt);
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  try {
    const r = await execa(CLAUDE_BIN, args, {
      ...(opts.cwd !== undefined ? { cwd: opts.cwd } : {}),
      timeout: timeoutMs,
      reject: false,
      shell: false,
      encoding: "utf8",
      stripFinalNewline: true,
      // Close stdin by passing an empty input buffer. Without this, Claude
      // Code CLI prints "no stdin data received in 3s" and exits 1 when
      // run from a non-TTY parent without piped stdin. `stdin: "ignore"`
      // is the "right" option name but behaves inconsistently across
      // execa versions — `input: ""` closes stdin deterministically.
      input: "",
    });
    const exitCode = r.exitCode ?? -1;
    return {
      ok: exitCode === 0 && !r.timedOut,
      text: r.stdout ?? "",
      exitCode,
      timedOut: Boolean(r.timedOut),
      stderr: r.stderr ?? "",
      durationMs: Date.now() - startedAt,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      ok: false,
      text: "",
      exitCode: null,
      timedOut: false,
      stderr: `callClaude threw: ${msg}`,
      durationMs: Date.now() - startedAt,
    };
  }
}

/**
 * Parse a JSON array of strings from Claude's response.
 * Claude tends to wrap JSON in prose/markdown — we extract the first
 * top-level JSON array robustly.
 */
export function extractJsonArray(text: string): string[] | null {
  if (!text) return null;
  // Try strict parse first
  const trimmed = text.trim();
  const direct = tryParseArray(trimmed);
  if (direct) return direct;

  // Try a fenced code block: ```json ... ``` or ``` ... ```
  const fence = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence && fence[1]) {
    const inside = tryParseArray(fence[1].trim());
    if (inside) return inside;
  }

  // Fall back to greedy "first [ to matching ]"
  const start = trimmed.indexOf("[");
  const end = trimmed.lastIndexOf("]");
  if (start >= 0 && end > start) {
    const slice = trimmed.slice(start, end + 1);
    const greedy = tryParseArray(slice);
    if (greedy) return greedy;
  }
  return null;
}

function tryParseArray(s: string): string[] | null {
  try {
    const v = JSON.parse(s);
    if (Array.isArray(v) && v.every((x) => typeof x === "string")) {
      return v as string[];
    }
  } catch {
    /* not JSON */
  }
  return null;
}
