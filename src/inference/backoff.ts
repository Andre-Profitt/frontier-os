// Capped exponential backoff with full jitter.
//
// AWS reliability guidance: blind retries can overload a struggling
// service. Use bounded delay + jitter so retry storms don't synchronize.
//
// Pure functions — `nextDelayMs(attempt)` is deterministic given a random
// source; the default uses Math.random but tests inject a seed.

export interface BackoffOptions {
  baseMs: number; // delay for attempt 1
  maxMs: number; // hard cap on any single delay
  factor: number; // multiplier per attempt (typical: 2)
  rng?: () => number; // returns [0,1); default Math.random
}

export const DEFAULT_BACKOFF: BackoffOptions = {
  baseMs: 500,
  maxMs: 30_000,
  factor: 2,
};

export function nextDelayMs(
  attempt: number,
  opts: BackoffOptions = DEFAULT_BACKOFF,
): number {
  if (attempt < 1) return 0;
  const exp = opts.baseMs * Math.pow(opts.factor, attempt - 1);
  const capped = Math.min(opts.maxMs, exp);
  const r = (opts.rng ?? Math.random)();
  // Full jitter: uniform random in [0, capped].
  return Math.floor(r * capped);
}

export function delay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((res, rej) => {
    if (signal?.aborted) {
      rej(new Error("aborted"));
      return;
    }
    const t = setTimeout(() => res(), ms);
    if (signal) {
      signal.addEventListener(
        "abort",
        () => {
          clearTimeout(t);
          rej(new Error("aborted"));
        },
        { once: true },
      );
    }
  });
}

// Decide whether a given HTTP status should be retried.
// 429 (rate limit) and 5xx (server) are retryable; 4xx others are not.
export function isRetryableStatus(status: number): boolean {
  if (status === 429) return true;
  if (status >= 500 && status < 600) return true;
  return false;
}
