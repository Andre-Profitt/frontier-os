// Token bucket rate limiter — pure unit tests with injected clock.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  TokenBucketLimiter,
  logRateLimitEvent,
  type RateLimitEvent,
} from "../rate-limit.ts";

test("acquire: fresh bucket grants up to capacity, then blocks", () => {
  let now = 1_000_000;
  const lim = new TokenBucketLimiter();
  lim.configure({ modelId: "m", rpm: 60, now: () => now });
  // Capacity = 60 by default. Drain.
  for (let i = 0; i < 60; i++) {
    const r = lim.acquire("m", now);
    assert.equal(r.granted, true, `attempt ${i + 1}`);
  }
  const denied = lim.acquire("m", now);
  assert.equal(denied.granted, false);
  assert.ok(denied.retryAfterMs > 0);
});

test("acquire: refill at rpm/60 tokens per second", () => {
  let now = 1_000_000;
  const lim = new TokenBucketLimiter();
  lim.configure({ modelId: "m", rpm: 60, now: () => now });
  for (let i = 0; i < 60; i++) lim.acquire("m", now);
  // Advance 1 second → +1 token.
  now += 1_000;
  const r = lim.acquire("m", now);
  assert.equal(r.granted, true);
});

test("acquire: unknown model returns clear error, not throw", () => {
  const lim = new TokenBucketLimiter();
  const r = lim.acquire("ghost-model");
  assert.equal(r.granted, false);
  assert.match(r.reason, /no bucket configured/);
});

test("penalize: drains bucket and pushes lastRefill into the future", () => {
  let now = 1_000_000;
  const lim = new TokenBucketLimiter();
  lim.configure({ modelId: "m", rpm: 60, now: () => now });
  // Penalize: 5 second cooldown.
  lim.penalize("m", 5_000, now);
  const inspected = lim.inspect("m");
  assert.equal(inspected?.tokens, 0);
  // Even 4s later, bucket has not refilled.
  now += 4_000;
  const r = lim.acquire("m", now);
  assert.equal(r.granted, false);
  // 6s after the original penalty (1s past the 5s cooldown), refill resumes.
  now += 2_000;
  const r2 = lim.acquire("m", now);
  // ~1 token of refill at 1 rps; first acquire consumes it.
  assert.equal(r2.granted, true);
});

test("capacity is bounded — refill cannot exceed capacity", () => {
  let now = 1_000_000;
  const lim = new TokenBucketLimiter();
  lim.configure({ modelId: "m", rpm: 60, now: () => now, capacity: 10 });
  // Drain to 0.
  for (let i = 0; i < 10; i++) lim.acquire("m", now);
  // Advance an hour. Refill is capped at capacity.
  now += 3_600_000;
  const inspected = lim.inspect("m");
  // Trigger refill via acquire (which refills first, then consumes).
  const r = lim.acquire("m", now);
  assert.equal(r.granted, true);
  assert.ok(
    inspected !== null && inspected.capacity === 10,
    "capacity preserved",
  );
  // After this single acquire, tokens are 9 (10 cap, refilled, minus 1).
  const after = lim.inspect("m");
  assert.equal(after?.tokens, 9);
});

test("logRateLimitEvent: appends one JSON line per call", () => {
  const dir = mkdtempSync(join(tmpdir(), "rl-event-"));
  const path = join(dir, "events.jsonl");
  try {
    const e1: RateLimitEvent = {
      ts: "2026-04-26T19:00:00Z",
      modelId: "p:m",
      observedRetryAfterMs: 1500,
      status: 429,
      endpoint: "https://example/v1/chat/completions",
    };
    const e2: RateLimitEvent = { ...e1, ts: "2026-04-26T19:00:01Z" };
    logRateLimitEvent(e1, path);
    logRateLimitEvent(e2, path);
    const lines = readFileSync(path, "utf8").trim().split("\n");
    assert.equal(lines.length, 2);
    assert.deepEqual(JSON.parse(lines[0]!), e1);
    assert.deepEqual(JSON.parse(lines[1]!), e2);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
