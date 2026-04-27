// Capacity prober — measurement logic + file I/O.
//
// All tests use a stub provider with a canned-response queue (matches the
// pattern in broker.test.ts). No live network, no filesystem outside
// mkdtempSync. The prober's only side effect should be calling
// provider.chatCompletion; budget enforcement and stats math are
// purely arithmetic over the responses.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  probeModelCapacity,
  computeLatencyStats,
  loadCapacityFile,
  mergeCapacityRecord,
  saveCapacityFile,
  emptyCapacityFile,
  type ModelCapacityRecord,
} from "../capacity-probe.ts";
import {
  OpenAICompatibleProvider,
  type ChatRequest,
  type ChatResponse,
} from "../providers/openai-compatible.ts";

// --- helpers --------------------------------------------------------------

class StubProvider extends OpenAICompatibleProvider {
  private queue: Array<Partial<ChatResponse>> = [];
  // Default response when the queue is empty — used when waves of unknown
  // length make exact-queue tests painful. Tests that care about exhaustion
  // can leave this null.
  private defaultResponse: Partial<ChatResponse> | null = null;
  public callLog: ChatRequest[] = [];

  constructor(name: string) {
    super(name, { baseUrl: "http://stub.invalid/v1" });
  }

  enqueue(...responses: Array<Partial<ChatResponse>>): void {
    this.queue.push(...responses);
  }

  setDefault(response: Partial<ChatResponse>): void {
    this.defaultResponse = response;
  }

  override async chatCompletion(req: ChatRequest): Promise<ChatResponse> {
    this.callLog.push(req);
    const next = this.queue.shift() ?? this.defaultResponse;
    if (!next) {
      throw new Error(
        `${this.name}: queue empty and no default; got call for ${req.model}`,
      );
    }
    return {
      ok: next.ok ?? next.status === 200,
      status: next.status ?? 200,
      modelId: req.model,
      body: next.body ?? { ok: true },
      rawText: next.rawText ?? "",
      retryAfterMs: next.retryAfterMs ?? null,
      durationMs: next.durationMs ?? 1,
      endpoint: "http://stub.invalid/v1/chat/completions",
    };
  }
}

// --- computeLatencyStats --------------------------------------------------

test("computeLatencyStats: empty input → all zeros", () => {
  const stats = computeLatencyStats([]);
  assert.equal(stats.p50Ms, 0);
  assert.equal(stats.p95Ms, 0);
  assert.equal(stats.p99Ms, 0);
  assert.equal(stats.minMs, 0);
  assert.equal(stats.maxMs, 0);
  assert.equal(stats.meanMs, 0);
});

test("computeLatencyStats: single sample → p50/p95/p99 all = sample", () => {
  const stats = computeLatencyStats([42]);
  assert.equal(stats.p50Ms, 42);
  assert.equal(stats.p95Ms, 42);
  assert.equal(stats.p99Ms, 42);
  assert.equal(stats.minMs, 42);
  assert.equal(stats.maxMs, 42);
  assert.equal(stats.meanMs, 42);
});

test("computeLatencyStats: 10 samples → nearest-rank percentiles", () => {
  // 100, 200, ..., 1000 ms
  const stats = computeLatencyStats([
    100, 200, 300, 400, 500, 600, 700, 800, 900, 1000,
  ]);
  // ceil(0.5 * 10) = 5 → sorted[4] = 500
  assert.equal(stats.p50Ms, 500);
  // ceil(0.95 * 10) = 10 → sorted[9] = 1000
  assert.equal(stats.p95Ms, 1000);
  assert.equal(stats.p99Ms, 1000);
  assert.equal(stats.minMs, 100);
  assert.equal(stats.maxMs, 1000);
  assert.equal(stats.meanMs, 550);
});

test("computeLatencyStats: unsorted input is sorted internally", () => {
  const stats = computeLatencyStats([300, 100, 200]);
  assert.equal(stats.minMs, 100);
  assert.equal(stats.maxMs, 300);
  assert.equal(stats.meanMs, 200);
});

// --- probeModelCapacity: latency phase ------------------------------------

test("probeModelCapacity: all latency calls succeed → available=true, latency stats populated", async () => {
  const provider = new StubProvider("stub");
  // 3 latency calls → 3 succeeding responses with controlled durations.
  provider.enqueue(
    { ok: true, status: 200, durationMs: 100 },
    { ok: true, status: 200, durationMs: 200 },
    { ok: true, status: 200, durationMs: 300 },
  );
  // Default for the ramp phase — succeed at every wave so we exhaust the
  // sequence rather than detecting a ceiling.
  provider.setDefault({ ok: true, status: 200, durationMs: 50 });

  const record = await probeModelCapacity({
    provider,
    model: "test-model",
    budgetCalls: 50,
    latencySamples: 3,
    rampSequence: [5, 10],
    rateLimitTargetFraction: 0.65,
  });

  assert.equal(record.available, true);
  assert.equal(record.modelKey, "stub:test-model");
  assert.equal(record.latency?.samples, 3);
  assert.equal(record.latency?.okSamples, 3);
  assert.equal(record.latency?.minMs, 100);
  assert.equal(record.latency?.maxMs, 300);
  assert.equal(record.errors.length, 0);
});

test("probeModelCapacity: all latency calls fail → available=false, ramp skipped", async () => {
  const provider = new StubProvider("stub");
  provider.enqueue(
    { ok: false, status: 500, body: { error: "down" } },
    { ok: false, status: 500, body: { error: "down" } },
    { ok: false, status: 500, body: { error: "down" } },
  );

  const record = await probeModelCapacity({
    provider,
    model: "test-model",
    budgetCalls: 50,
    latencySamples: 3,
    rampSequence: [5, 10],
  });

  assert.equal(record.available, false);
  assert.equal(record.latency?.samples, 3);
  assert.equal(record.latency?.okSamples, 0);
  assert.equal(record.rateLimit?.method, "skipped");
  assert.equal(record.rateLimit?.observedSafeRpm, 0);
  assert.equal(record.rateLimit?.recommendedBucketRpm, 0);
  assert.equal(record.errors.length, 3);
  // No ramp calls were issued.
  assert.equal(provider.callLog.length, 3);
});

// --- probeModelCapacity: ramp phase ---------------------------------------

test("probeModelCapacity: ramp finds ceiling → observedSafeRpm = previous wave, ceilingFound=true", async () => {
  const provider = new StubProvider("stub");
  // Latency phase: 1 success.
  provider.enqueue({ ok: true, status: 200, durationMs: 100 });
  // Wave 1 (5 calls): all succeed.
  for (let i = 0; i < 5; i++) {
    provider.enqueue({ ok: true, status: 200 });
  }
  // Wave 2 (10 calls): all succeed.
  for (let i = 0; i < 10; i++) {
    provider.enqueue({ ok: true, status: 200 });
  }
  // Wave 3 (20 calls): 50% are 429 (way over the 10% threshold).
  for (let i = 0; i < 10; i++) {
    provider.enqueue({ ok: true, status: 200 });
  }
  for (let i = 0; i < 10; i++) {
    provider.enqueue({ ok: false, status: 429 });
  }

  const record = await probeModelCapacity({
    provider,
    model: "test-model",
    budgetCalls: 100,
    latencySamples: 1,
    rampSequence: [5, 10, 20, 40],
    stopAtErr429Rate: 0.1,
    rateLimitTargetFraction: 0.65,
  });

  assert.equal(record.available, true);
  assert.equal(record.rateLimit?.method, "burst-ramp");
  assert.equal(record.rateLimit?.ceilingFound, true);
  assert.equal(record.rateLimit?.observedSafeRpm, 10); // last clean wave
  assert.ok((record.rateLimit?.observed429RateAtCeiling ?? 0) >= 0.5);
  // floor(10 * 0.65) = 6
  assert.equal(record.rateLimit?.recommendedBucketRpm, 6);
  assert.equal(record.rateLimit?.rampSequence?.length, 3); // 5, 10, 20
  // Wave 4 (40 rpm) was skipped on ceiling detection.
  assert.equal(record.rateLimit?.rampSequence?.[2]?.targetRpm, 20);
});

test("probeModelCapacity: no ceiling found, full sequence runs → observedSafeRpm = last wave, ceilingFound=false", async () => {
  const provider = new StubProvider("stub");
  provider.enqueue({ ok: true, status: 200, durationMs: 100 });
  provider.setDefault({ ok: true, status: 200 });

  const record = await probeModelCapacity({
    provider,
    model: "test-model",
    budgetCalls: 200,
    latencySamples: 1,
    rampSequence: [5, 10, 20],
    rateLimitTargetFraction: 0.65,
  });

  assert.equal(record.rateLimit?.ceilingFound, false);
  assert.equal(record.rateLimit?.budgetExhausted, false);
  assert.equal(record.rateLimit?.observedSafeRpm, 20);
  assert.equal(record.rateLimit?.recommendedBucketRpm, 13); // floor(20 * 0.65)
  assert.equal(record.rateLimit?.rampSequence?.length, 3);
});

test("probeModelCapacity: budget runs out mid-ramp → budgetExhausted=true, observedSafeRpm = last completed", async () => {
  const provider = new StubProvider("stub");
  provider.enqueue({ ok: true, status: 200, durationMs: 100 });
  provider.setDefault({ ok: true, status: 200 });

  // Budget = 1 (latency) + 5 (wave1) + 10 (wave2) = 16 → wave3 (20) would
  // need 20 more but only 0 remain. Wave3 should be skipped, marking
  // budgetExhausted.
  const record = await probeModelCapacity({
    provider,
    model: "test-model",
    budgetCalls: 16,
    latencySamples: 1,
    rampSequence: [5, 10, 20, 40],
    rateLimitTargetFraction: 0.65,
  });

  assert.equal(record.rateLimit?.budgetExhausted, true);
  assert.equal(record.rateLimit?.ceilingFound, false);
  assert.equal(record.rateLimit?.observedSafeRpm, 10);
  assert.equal(record.rateLimit?.rampSequence?.length, 2); // waves 5, 10
  // 1 latency + 5 + 10 = 16 calls total.
  assert.equal(provider.callLog.length, 16);
});

test("probeModelCapacity: 429 rate just under threshold → continues to next wave", async () => {
  const provider = new StubProvider("stub");
  provider.enqueue({ ok: true, status: 200, durationMs: 100 });
  // Wave 1 (10 calls): 1 of 10 is 429 → 10% (NOT > 10%, so still safe).
  provider.enqueue({ ok: false, status: 429 });
  for (let i = 0; i < 9; i++) {
    provider.enqueue({ ok: true, status: 200 });
  }
  // Wave 2 (10 calls): all 429 → ceiling.
  for (let i = 0; i < 10; i++) {
    provider.enqueue({ ok: false, status: 429 });
  }

  const record = await probeModelCapacity({
    provider,
    model: "test-model",
    budgetCalls: 100,
    latencySamples: 1,
    rampSequence: [10, 10],
    stopAtErr429Rate: 0.1,
    rateLimitTargetFraction: 0.65,
  });

  // Wave 1 had err429Rate = 0.1 — equal to threshold, NOT greater, so we
  // continue.
  assert.equal(record.rateLimit?.rampSequence?.[0]?.err429Rate, 0.1);
  // Wave 2 detects ceiling → observedSafeRpm = 10 (wave 1's targetRpm).
  assert.equal(record.rateLimit?.ceilingFound, true);
  assert.equal(record.rateLimit?.observedSafeRpm, 10);
});

test("probeModelCapacity: rateLimitTargetFraction applied to recommendedBucketRpm", async () => {
  const provider = new StubProvider("stub");
  provider.enqueue({ ok: true, status: 200, durationMs: 100 });
  provider.setDefault({ ok: true, status: 200 });

  const record = await probeModelCapacity({
    provider,
    model: "test-model",
    budgetCalls: 200,
    latencySamples: 1,
    rampSequence: [40],
    rateLimitTargetFraction: 0.5, // not the default
  });

  assert.equal(record.rateLimit?.observedSafeRpm, 40);
  assert.equal(record.rateLimit?.recommendedBucketRpm, 20); // floor(40 * 0.5)
  assert.equal(record.rateLimit?.rateLimitTargetFraction, 0.5);
});

test("probeModelCapacity: scannedAt comes from injected now()", async () => {
  const provider = new StubProvider("stub");
  provider.enqueue({ ok: true, status: 200 });
  provider.setDefault({ ok: true, status: 200 });

  const fixed = Date.parse("2026-04-26T17:00:00.000Z");
  const record = await probeModelCapacity({
    provider,
    model: "test-model",
    budgetCalls: 10,
    latencySamples: 1,
    rampSequence: [5],
    now: () => fixed,
  });

  assert.equal(record.scannedAt, "2026-04-26T17:00:00.000Z");
});

// --- file I/O -------------------------------------------------------------

function withTempDir<T>(fn: (dir: string) => Promise<T> | T): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), "capacity-test-"));
  return Promise.resolve(fn(dir)).finally(() =>
    rmSync(dir, { recursive: true, force: true }),
  );
}

test("loadCapacityFile: missing path → empty file", async () => {
  await withTempDir((dir) => {
    const file = loadCapacityFile(join(dir, "missing.json"));
    assert.equal(file.version, "v1");
    assert.equal(file.models.length, 0);
  });
});

test("loadCapacityFile: corrupt JSON → empty file (no throw)", async () => {
  await withTempDir((dir) => {
    const path = join(dir, "corrupt.json");
    saveRawFile(path, "{not json}");
    const file = loadCapacityFile(path);
    assert.equal(file.models.length, 0);
  });
});

test("loadCapacityFile: wrong version → empty file", async () => {
  await withTempDir((dir) => {
    const path = join(dir, "wrong-ver.json");
    saveRawFile(
      path,
      JSON.stringify({ version: "v0", models: [], scannedAt: "x" }),
    );
    const file = loadCapacityFile(path);
    assert.equal(file.models.length, 0);
  });
});

test("mergeCapacityRecord: new modelKey appended, top-level scannedAt updated", () => {
  const file = emptyCapacityFile(() => Date.parse("2026-01-01T00:00:00Z"));
  const record = sampleRecord("nim:m1", "2026-04-26T17:00:00.000Z");
  const merged = mergeCapacityRecord(file, record);
  assert.equal(merged.models.length, 1);
  assert.equal(merged.models[0]!.modelKey, "nim:m1");
  assert.equal(merged.scannedAt, "2026-04-26T17:00:00.000Z");
});

test("mergeCapacityRecord: existing modelKey replaced, others preserved", () => {
  const initial = emptyCapacityFile();
  let file = mergeCapacityRecord(
    initial,
    sampleRecord("nim:m1", "2026-04-26T16:00:00.000Z"),
  );
  file = mergeCapacityRecord(
    file,
    sampleRecord("nim:m2", "2026-04-26T16:30:00.000Z"),
  );
  // Now re-scan m1 with a newer timestamp — should replace, not duplicate.
  file = mergeCapacityRecord(
    file,
    sampleRecord("nim:m1", "2026-04-26T17:00:00.000Z"),
  );
  assert.equal(file.models.length, 2);
  const m1 = file.models.find((m) => m.modelKey === "nim:m1");
  assert.equal(m1?.scannedAt, "2026-04-26T17:00:00.000Z");
  const m2 = file.models.find((m) => m.modelKey === "nim:m2");
  assert.equal(m2?.scannedAt, "2026-04-26T16:30:00.000Z");
});

test("saveCapacityFile + loadCapacityFile: roundtrip preserves structure", async () => {
  await withTempDir((dir) => {
    const path = join(dir, "nested", "model-capacity.json");
    const original = mergeCapacityRecord(
      emptyCapacityFile(),
      sampleRecord("nim:m1", "2026-04-26T17:00:00.000Z"),
    );
    saveCapacityFile(path, original);
    assert.ok(existsSync(path));
    const reloaded = loadCapacityFile(path);
    assert.equal(reloaded.version, "v1");
    assert.equal(reloaded.models.length, 1);
    assert.equal(reloaded.models[0]!.modelKey, "nim:m1");
    // File ends with a newline (POSIX).
    const raw = readFileSync(path, "utf8");
    assert.equal(raw.endsWith("\n"), true);
  });
});

// --- helpers --------------------------------------------------------------

function sampleRecord(
  modelKey: string,
  scannedAt: string,
): ModelCapacityRecord {
  const [provider = "?", model = "?"] = modelKey.split(":");
  return {
    modelKey,
    provider,
    model,
    scannedAt,
    available: true,
    latency: {
      samples: 1,
      okSamples: 1,
      p50Ms: 100,
      p95Ms: 100,
      p99Ms: 100,
      minMs: 100,
      maxMs: 100,
      meanMs: 100,
    },
    rateLimit: {
      method: "burst-ramp",
      observedSafeRpm: 10,
      recommendedBucketRpm: 6,
      rateLimitTargetFraction: 0.65,
      ceilingFound: false,
      budgetExhausted: false,
      rampSequence: [],
    },
    errors: [],
  };
}

function saveRawFile(path: string, contents: string): void {
  // Avoid pulling in the production saver — tests should drive raw bytes.
  writeFileSync(path, contents);
}
