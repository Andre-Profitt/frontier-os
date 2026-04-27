// Per-model token bucket rate limiter.
//
// Each model has a bucket sized for its observed safe RPM. Calls consume
// one token; refill is at rpm/60 tokens per second. Bucket capacity is
// equal to the configured RPM (so a fresh bucket can support a one-second
// burst, then settles to the steady rate).
//
// In-memory by design — restarts reset budgets. A 429 record is emitted
// to state/inference/rate-limit-events.jsonl so the empirical RPM ceiling
// can be reconstructed across restarts.

import { appendFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export interface BucketConfig {
  modelId: string;
  rpm: number; // requests per minute the bucket targets
  // Optional overrides (mostly for tests).
  now?: () => number; // ms since epoch
  capacity?: number; // defaults to rpm
}

export interface AcquireResult {
  granted: boolean;
  tokensRemaining: number;
  retryAfterMs: number; // 0 if granted
  reason: string;
}

interface BucketState {
  config: BucketConfig;
  tokens: number;
  lastRefillMs: number;
  capacity: number;
  refillPerMs: number; // tokens added per ms
}

export class TokenBucketLimiter {
  private buckets = new Map<string, BucketState>();

  configure(config: BucketConfig): void {
    const capacity = config.capacity ?? config.rpm;
    this.buckets.set(config.modelId, {
      config,
      tokens: capacity,
      lastRefillMs: (config.now ?? Date.now)(),
      capacity,
      refillPerMs: config.rpm / 60_000,
    });
  }

  acquire(modelId: string, now?: number): AcquireResult {
    const state = this.buckets.get(modelId);
    if (!state) {
      return {
        granted: false,
        tokensRemaining: 0,
        retryAfterMs: 0,
        reason: `no bucket configured for ${modelId}`,
      };
    }
    const t = now ?? (state.config.now ?? Date.now)();
    const elapsedMs = Math.max(0, t - state.lastRefillMs);
    const refilled = Math.min(
      state.capacity,
      state.tokens + elapsedMs * state.refillPerMs,
    );
    state.tokens = refilled;
    state.lastRefillMs = t;
    if (state.tokens >= 1) {
      state.tokens -= 1;
      return {
        granted: true,
        tokensRemaining: state.tokens,
        retryAfterMs: 0,
        reason: "ok",
      };
    }
    const deficit = 1 - state.tokens;
    const retryAfterMs = Math.ceil(deficit / state.refillPerMs);
    return {
      granted: false,
      tokensRemaining: state.tokens,
      retryAfterMs,
      reason: `bucket empty; refill in ${retryAfterMs}ms`,
    };
  }

  // Manual penalty: when a provider returns 429, treat it as evidence the
  // RPM ceiling is lower than configured. Drain the bucket and shrink
  // capacity for the next minute.
  penalize(modelId: string, observedRetryAfterMs: number, now?: number): void {
    const state = this.buckets.get(modelId);
    if (!state) return;
    state.tokens = 0;
    const t = now ?? (state.config.now ?? Date.now)();
    state.lastRefillMs = t + observedRetryAfterMs;
  }

  // Inspect (for tests / diagnostics).
  inspect(modelId: string): { tokens: number; capacity: number } | null {
    const state = this.buckets.get(modelId);
    if (!state) return null;
    return { tokens: state.tokens, capacity: state.capacity };
  }
}

// --- 429 event log -------------------------------------------------------

export interface RateLimitEvent {
  ts: string;
  modelId: string;
  observedRetryAfterMs: number | null;
  status: number;
  endpoint: string;
  detail?: string;
}

const HERE = fileURLToPath(import.meta.url);
const REPO_ROOT = resolve(HERE, "..", "..", "..");
const DEFAULT_EVENT_LOG = resolve(
  REPO_ROOT,
  "state",
  "inference",
  "rate-limit-events.jsonl",
);

export function logRateLimitEvent(
  event: RateLimitEvent,
  path: string = DEFAULT_EVENT_LOG,
): void {
  mkdirSync(dirname(path), { recursive: true });
  appendFileSync(path, JSON.stringify(event) + "\n");
}
