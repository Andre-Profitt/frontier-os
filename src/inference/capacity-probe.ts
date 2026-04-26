// Empirical capacity probe for inference broker models.
//
// The broker config seeds token-bucket RPM from `defaultRpm` in
// model-policy.json — a static guess. This module replaces those guesses
// with measurements: latency stats and an observed safe RPM ceiling per
// model. Output is `state/inference/model-capacity.json`, which the broker
// can later read to reconfigure buckets at startup.
//
// Two phases per model, both budget-capped:
//   1. latency — N sequential chat-completions, compute p50/p95/p99/min/max/mean
//   2. burst-ramp — waves at increasing target RPM (5, 10, 20, 40, …)
//      sent as concurrent bursts in a 1-second window. The first wave with
//      err429Rate > stopAtErr429Rate (default 10%) marks the ceiling; the
//      previous wave's targetRpm is the observedSafeRpm. recommendedBucketRpm
//      is observedSafeRpm * rateLimitTargetFraction (rounded down).
//
// A "burst" is not a sustained-RPM measurement; token buckets allow short
// bursts above their refill rate. We accept this approximation because
// burning enough budget for a true 60-second sustained probe per model is
// expensive on free-tier providers. The broker still applies the target
// fraction (default 0.65) which gives headroom for the difference.
//
// All side effects go through OpenAICompatibleProvider, which already has a
// fetchImpl test seam. The probe takes a provider in, so callers (CLI,
// tests) compose the right provider for the target model.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  OpenAICompatibleProvider,
  type ChatRequest,
  type ChatResponse,
} from "./providers/openai-compatible.ts";

export interface CapacityProbeOptions {
  provider: OpenAICompatibleProvider;
  model: string;
  // Total chat-completion calls allowed for this probe (latency + ramp).
  budgetCalls?: number;
  // Sequential latency-phase samples. Each consumes one budget call.
  latencySamples?: number;
  // Wave targets in calls-per-minute. Each wave consumes targetRpm calls.
  // The probe stops early on budget exhaustion or ceiling detection.
  rampSequence?: number[];
  // 429-rate threshold above which a wave is judged the ceiling.
  stopAtErr429Rate?: number;
  // Bucket recommendation = observedSafeRpm * rateLimitTargetFraction.
  rateLimitTargetFraction?: number;
  // Probe message — small + cheap by default. Override for richer probes.
  probePrompt?: string;
  // Token cap for completion. Default 16 — we care about latency, not output.
  maxTokens?: number;
  // Test seam.
  now?: () => number;
}

export interface LatencyStats {
  samples: number;
  okSamples: number;
  p50Ms: number;
  p95Ms: number;
  p99Ms: number;
  minMs: number;
  maxMs: number;
  meanMs: number;
}

export interface RampWave {
  targetRpm: number;
  actualCalls: number;
  ok: number;
  errors429: number;
  errorsOther: number;
  elapsedMs: number;
  err429Rate: number;
}

export interface RateLimitProbe {
  method: "burst-ramp" | "skipped";
  observedSafeRpm: number;
  observed429RateAtCeiling?: number;
  recommendedBucketRpm: number;
  rateLimitTargetFraction: number;
  ceilingFound?: boolean;
  budgetExhausted?: boolean;
  rampSequence?: RampWave[];
  skippedReason?: string;
}

export interface ProbeError {
  phase: "latency" | "ramp";
  status: number;
  message: string;
  ts?: string;
}

export interface ModelCapacityRecord {
  modelKey: string;
  provider: string;
  model: string;
  scannedAt: string;
  available: boolean;
  latency?: LatencyStats;
  rateLimit?: RateLimitProbe;
  errors: ProbeError[];
}

const DEFAULT_BUDGET_CALLS = 100;
const DEFAULT_LATENCY_SAMPLES = 3;
const DEFAULT_RAMP_SEQUENCE = [5, 10, 20, 40, 60, 80, 100, 150, 200];
const DEFAULT_STOP_ERR429_RATE = 0.1;
const DEFAULT_TARGET_FRACTION = 0.65;
const DEFAULT_PROMPT = "Reply with the single word: ok.";
const DEFAULT_MAX_TOKENS = 16;

export async function probeModelCapacity(
  opts: CapacityProbeOptions,
): Promise<ModelCapacityRecord> {
  const now = opts.now ?? Date.now;
  const budgetCalls = opts.budgetCalls ?? DEFAULT_BUDGET_CALLS;
  const latencySamples = opts.latencySamples ?? DEFAULT_LATENCY_SAMPLES;
  const rampSequence = opts.rampSequence ?? DEFAULT_RAMP_SEQUENCE;
  const stopAtErr429Rate = opts.stopAtErr429Rate ?? DEFAULT_STOP_ERR429_RATE;
  const targetFraction =
    opts.rateLimitTargetFraction ?? DEFAULT_TARGET_FRACTION;
  const probePrompt = opts.probePrompt ?? DEFAULT_PROMPT;
  const maxTokens = opts.maxTokens ?? DEFAULT_MAX_TOKENS;

  const errors: ProbeError[] = [];
  const modelKey = `${opts.provider.name}:${opts.model}`;
  const scannedAt = new Date(now()).toISOString();

  // Budget guard: refuse to overrun budget.
  let remaining = budgetCalls;

  const baseRequest: Pick<
    ChatRequest,
    "messages" | "temperature" | "max_tokens"
  > = {
    messages: [{ role: "user", content: probePrompt }],
    max_tokens: maxTokens,
    temperature: 0,
  };

  // --- latency phase ---
  const latencyDurations: number[] = [];
  let latencyOk = 0;
  const samplesToTake = Math.min(latencySamples, remaining);
  for (let i = 0; i < samplesToTake; i++) {
    const res = await callOnce(opts.provider, opts.model, baseRequest);
    remaining -= 1;
    if (res.ok) {
      latencyDurations.push(res.durationMs);
      latencyOk += 1;
    } else {
      errors.push({
        phase: "latency",
        status: res.status,
        message: previewError(res),
        ts: new Date(now()).toISOString(),
      });
    }
  }

  const latency: LatencyStats | undefined =
    samplesToTake > 0
      ? {
          samples: samplesToTake,
          okSamples: latencyOk,
          ...computeLatencyStats(latencyDurations),
        }
      : undefined;

  // If every latency call failed, the model is effectively unavailable —
  // skip the ramp phase and report.
  if (samplesToTake > 0 && latencyOk === 0) {
    return {
      modelKey,
      provider: opts.provider.name,
      model: opts.model,
      scannedAt,
      available: false,
      ...(latency ? { latency } : {}),
      rateLimit: {
        method: "skipped",
        observedSafeRpm: 0,
        recommendedBucketRpm: 0,
        rateLimitTargetFraction: targetFraction,
        skippedReason: "every latency-phase call failed; model not reachable",
      },
      errors,
    };
  }

  // --- burst-ramp phase ---
  const rampWaves: RampWave[] = [];
  let observedSafeRpm = 0;
  let observed429RateAtCeiling: number | undefined;
  let ceilingFound = false;
  let budgetExhausted = false;

  for (const targetRpm of rampSequence) {
    if (remaining < targetRpm) {
      budgetExhausted = true;
      break;
    }
    const wave = await runBurstWave(
      opts.provider,
      opts.model,
      baseRequest,
      targetRpm,
      now,
    );
    remaining -= wave.actualCalls;
    rampWaves.push(wave);
    if (wave.errorsOther > 0) {
      errors.push({
        phase: "ramp",
        status: 0,
        message: `wave at ${targetRpm} rpm: ${wave.errorsOther} non-429 errors`,
        ts: new Date(now()).toISOString(),
      });
    }
    if (wave.err429Rate > stopAtErr429Rate) {
      observed429RateAtCeiling = wave.err429Rate;
      ceilingFound = true;
      break;
    }
    observedSafeRpm = targetRpm;
  }

  const recommendedBucketRpm = Math.floor(observedSafeRpm * targetFraction);

  const rateLimit: RateLimitProbe = {
    method: "burst-ramp",
    observedSafeRpm,
    recommendedBucketRpm,
    rateLimitTargetFraction: targetFraction,
    ceilingFound,
    budgetExhausted,
    rampSequence: rampWaves,
  };
  if (observed429RateAtCeiling !== undefined) {
    rateLimit.observed429RateAtCeiling = observed429RateAtCeiling;
  }

  return {
    modelKey,
    provider: opts.provider.name,
    model: opts.model,
    scannedAt,
    available: true,
    ...(latency ? { latency } : {}),
    rateLimit,
    errors,
  };
}

// Sequential single call.
async function callOnce(
  provider: OpenAICompatibleProvider,
  model: string,
  base: Pick<ChatRequest, "messages" | "temperature" | "max_tokens">,
): Promise<ChatResponse> {
  const req: ChatRequest = { ...base, model };
  return provider.chatCompletion(req);
}

// Concurrent burst — fires `targetRpm` calls in parallel and waits for all.
// Spaced spawn (one every 1000/targetRpm ms) would be more faithful to
// "RPM" but adds variance from setTimeout drift; concurrent burst is the
// stricter test and matches token-bucket burst behavior.
async function runBurstWave(
  provider: OpenAICompatibleProvider,
  model: string,
  base: Pick<ChatRequest, "messages" | "temperature" | "max_tokens">,
  targetRpm: number,
  now: () => number,
): Promise<RampWave> {
  const t0 = now();
  const calls: Array<Promise<ChatResponse>> = [];
  for (let i = 0; i < targetRpm; i++) {
    calls.push(callOnce(provider, model, base));
  }
  const results = await Promise.all(calls);
  const elapsedMs = now() - t0;
  let ok = 0;
  let errors429 = 0;
  let errorsOther = 0;
  for (const r of results) {
    if (r.ok) ok += 1;
    else if (r.status === 429) errors429 += 1;
    else errorsOther += 1;
  }
  const actualCalls = results.length;
  const err429Rate = actualCalls > 0 ? errors429 / actualCalls : 0;
  return {
    targetRpm,
    actualCalls,
    ok,
    errors429,
    errorsOther,
    elapsedMs,
    err429Rate,
  };
}

// p50/p95/p99 via nearest-rank percentile on the OK durations only.
// Empty input yields all zeros — paired with samples=0 in the wrapper.
export function computeLatencyStats(
  okDurations: number[],
): Omit<LatencyStats, "samples" | "okSamples"> {
  if (okDurations.length === 0) {
    return { p50Ms: 0, p95Ms: 0, p99Ms: 0, minMs: 0, maxMs: 0, meanMs: 0 };
  }
  const sorted = [...okDurations].sort((a, b) => a - b);
  const sum = sorted.reduce((a, b) => a + b, 0);
  return {
    p50Ms: percentile(sorted, 0.5),
    p95Ms: percentile(sorted, 0.95),
    p99Ms: percentile(sorted, 0.99),
    minMs: sorted[0]!,
    maxMs: sorted[sorted.length - 1]!,
    meanMs: sum / sorted.length,
  };
}

// Nearest-rank percentile (Hyndman-Fan type 1) on a pre-sorted array.
// 0 < p ≤ 1; returns sorted[ceil(p*n) - 1].
function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.max(0, Math.ceil(p * sorted.length) - 1);
  return sorted[Math.min(idx, sorted.length - 1)]!;
}

function previewError(res: ChatResponse): string {
  if (typeof res.body === "object" && res.body !== null) {
    return JSON.stringify(res.body).slice(0, 240);
  }
  return (res.rawText ?? "").slice(0, 240);
}

// --- file I/O for state/inference/model-capacity.json --------------------

export interface ModelCapacityFile {
  version: "v1";
  scannedAt: string;
  scanner?: {
    rateLimitTargetFraction?: number;
    budgetCallsPerModel?: number;
    latencySamples?: number;
    rampSequence?: number[];
  };
  models: ModelCapacityRecord[];
}

const HERE = fileURLToPath(import.meta.url);
const REPO_ROOT = resolve(dirname(HERE), "..", "..");
export const DEFAULT_CAPACITY_PATH = resolve(
  REPO_ROOT,
  "state",
  "inference",
  "model-capacity.json",
);

export function emptyCapacityFile(
  now: () => number = Date.now,
): ModelCapacityFile {
  return {
    version: "v1",
    scannedAt: new Date(now()).toISOString(),
    models: [],
  };
}

// Returns an empty file when the path is missing or corrupt. The probe is
// the source of truth — we never want a parse failure to block a re-scan.
export function loadCapacityFile(path: string): ModelCapacityFile {
  if (!existsSync(path)) return emptyCapacityFile();
  try {
    const raw = JSON.parse(
      readFileSync(path, "utf8"),
    ) as Partial<ModelCapacityFile>;
    if (raw.version === "v1" && Array.isArray(raw.models)) {
      return {
        version: "v1",
        scannedAt: raw.scannedAt ?? new Date(0).toISOString(),
        ...(raw.scanner ? { scanner: raw.scanner } : {}),
        models: raw.models,
      };
    }
  } catch {
    // fall through to empty
  }
  return emptyCapacityFile();
}

// Replaces any prior record with the same modelKey, then appends. Top-level
// scannedAt is bumped to the new record's scannedAt so consumers see the
// freshest scan timestamp first.
export function mergeCapacityRecord(
  file: ModelCapacityFile,
  record: ModelCapacityRecord,
): ModelCapacityFile {
  const filtered = file.models.filter((m) => m.modelKey !== record.modelKey);
  return {
    ...file,
    models: [...filtered, record],
    scannedAt: record.scannedAt,
  };
}

export function saveCapacityFile(path: string, file: ModelCapacityFile): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(file, null, 2) + "\n");
}
