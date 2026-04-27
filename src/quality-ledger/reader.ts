// Quality ledger reader. Reads JSONL files from state/quality-ledger/
// and returns typed event arrays. Skips malformed rows (logs to a
// caller-provided onMalformed callback if supplied) — a corrupt
// row in production must not stop the model-score CLI.

import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

import type {
  ArbiterDecisionEvent,
  HumanDecisionEvent,
  ModelEvent,
  QualityLedgerEvent,
  ReviewFindingEvent,
  WorkerRunEvent,
} from "./types.ts";
import { DEFAULT_LEDGER_DIR } from "./writer.ts";

export interface ReadOptions {
  ledgerDir?: string;
  // Optional callback for rows that fail JSON.parse or kind discrimination.
  onMalformed?: (
    file: string,
    lineNumber: number,
    raw: string,
    error: string,
  ) => void;
}

export interface LedgerSnapshot {
  workerRuns: WorkerRunEvent[];
  reviewFindings: ReviewFindingEvent[];
  arbiterDecisions: ArbiterDecisionEvent[];
  modelEvents: ModelEvent[];
  humanDecisions: HumanDecisionEvent[];
}

export function readLedger(opts: ReadOptions = {}): LedgerSnapshot {
  const dir = opts.ledgerDir ?? DEFAULT_LEDGER_DIR;
  return {
    workerRuns: readKind<WorkerRunEvent>(
      resolve(dir, "worker-runs.jsonl"),
      "worker_run",
      opts.onMalformed,
    ),
    reviewFindings: readKind<ReviewFindingEvent>(
      resolve(dir, "review-findings.jsonl"),
      "review_finding",
      opts.onMalformed,
    ),
    arbiterDecisions: readKind<ArbiterDecisionEvent>(
      resolve(dir, "arbiter-decisions.jsonl"),
      "arbiter_decision",
      opts.onMalformed,
    ),
    modelEvents: readKind<ModelEvent>(
      resolve(dir, "model-events.jsonl"),
      "model_event",
      opts.onMalformed,
    ),
    humanDecisions: readKind<HumanDecisionEvent>(
      resolve(dir, "human-decisions.jsonl"),
      "human_decision",
      opts.onMalformed,
    ),
  };
}

function readKind<T extends QualityLedgerEvent>(
  file: string,
  expectedKind: T["kind"],
  onMalformed?: ReadOptions["onMalformed"],
): T[] {
  if (!existsSync(file)) return [];
  const text = readFileSync(file, "utf8");
  const out: T[] = [];
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i]!;
    if (raw.trim().length === 0) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (e) {
      onMalformed?.(
        file,
        i + 1,
        raw,
        e instanceof Error ? e.message : String(e),
      );
      continue;
    }
    if (typeof parsed !== "object" || parsed === null) {
      onMalformed?.(file, i + 1, raw, "row is not an object");
      continue;
    }
    const kind = (parsed as { kind?: unknown }).kind;
    if (kind !== expectedKind) {
      onMalformed?.(
        file,
        i + 1,
        raw,
        `kind mismatch: expected ${expectedKind}, got ${String(kind)}`,
      );
      continue;
    }
    out.push(parsed as T);
  }
  return out;
}
