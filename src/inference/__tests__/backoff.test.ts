// Backoff helper — deterministic via injected RNG.

import { test } from "node:test";
import assert from "node:assert/strict";
import { delay, isRetryableStatus, nextDelayMs } from "../backoff.ts";

test("nextDelayMs: 0 for non-positive attempt", () => {
  assert.equal(nextDelayMs(0), 0);
  assert.equal(nextDelayMs(-1), 0);
});

test("nextDelayMs: bounded by maxMs cap", () => {
  // attempt=10, factor=2, base=500 → 500*2^9 = 256000ms; capped at 30s.
  const d = nextDelayMs(10, {
    baseMs: 500,
    maxMs: 30_000,
    factor: 2,
    rng: () => 0.999, // pull jitter to the top of the range
  });
  assert.ok(d <= 30_000);
});

test("nextDelayMs: full jitter — rng=0 → 0; rng=0.5 → ~half of capped exp", () => {
  const opts = { baseMs: 1_000, maxMs: 100_000, factor: 2 };
  // attempt=3 → 1000*4 = 4000 capped → 4000.
  const lo = nextDelayMs(3, { ...opts, rng: () => 0 });
  const hi = nextDelayMs(3, { ...opts, rng: () => 0.999 });
  const mid = nextDelayMs(3, { ...opts, rng: () => 0.5 });
  assert.equal(lo, 0);
  assert.ok(hi <= 4_000 && hi >= 3_990);
  assert.ok(mid >= 1_900 && mid <= 2_100);
});

test("isRetryableStatus: 429 retryable, 5xx retryable, 4xx (others) not", () => {
  assert.equal(isRetryableStatus(429), true);
  assert.equal(isRetryableStatus(500), true);
  assert.equal(isRetryableStatus(503), true);
  assert.equal(isRetryableStatus(599), true);
  assert.equal(isRetryableStatus(400), false);
  assert.equal(isRetryableStatus(401), false);
  assert.equal(isRetryableStatus(404), false);
  assert.equal(isRetryableStatus(200), false);
  assert.equal(isRetryableStatus(0), false);
});

test("delay: resolves after approximately the requested time", async () => {
  const t0 = Date.now();
  await delay(50);
  const elapsed = Date.now() - t0;
  assert.ok(elapsed >= 40, `elapsed ${elapsed}ms should be >= ~40`);
  assert.ok(elapsed < 500, `elapsed ${elapsed}ms should be << 500`);
});

test("delay: aborts cleanly via AbortSignal", async () => {
  const ac = new AbortController();
  const t0 = Date.now();
  const p = delay(5_000, ac.signal);
  setTimeout(() => ac.abort(), 20);
  await assert.rejects(p, /aborted/);
  const elapsed = Date.now() - t0;
  assert.ok(elapsed < 500, `elapsed ${elapsed}ms — abort should be fast`);
});
