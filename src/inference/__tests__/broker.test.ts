// Broker — integration test that exercises class routing, rate limiting,
// 429 backoff, and fallback to the next model in the class. Uses a stub
// providerFactory and an injected clock; no live network.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { InferenceBroker } from "../broker.ts";
import { ModelRegistry } from "../model-registry.ts";
import {
  OpenAICompatibleProvider,
  type ChatRequest,
  type ChatResponse,
} from "../providers/openai-compatible.ts";

// --- helpers --------------------------------------------------------------

class StubProvider extends OpenAICompatibleProvider {
  private queue: Array<Partial<ChatResponse>> = [];
  public callLog: ChatRequest[] = [];

  constructor(name: string) {
    super(name, { baseUrl: "http://stub.invalid/v1" });
  }

  enqueue(...responses: Array<Partial<ChatResponse>>): void {
    this.queue.push(...responses);
  }

  override async chatCompletion(req: ChatRequest): Promise<ChatResponse> {
    this.callLog.push(req);
    const next = this.queue.shift();
    if (!next) {
      throw new Error(
        `${this.name}: no canned response queued; got call for ${req.model}`,
      );
    }
    return {
      ok: next.ok ?? true,
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

function withTempPolicy<T>(
  policy: Record<string, unknown>,
  fn: (registry: ModelRegistry, eventLogPath: string) => Promise<T> | T,
): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), "broker-test-"));
  const policyPath = join(dir, "model-policy.json");
  writeFileSync(policyPath, JSON.stringify(policy));
  const registry = new ModelRegistry({ policyPath, env: {} });
  const eventLog = join(dir, "events.jsonl");
  return Promise.resolve(fn(registry, eventLog)).finally(() =>
    rmSync(dir, { recursive: true, force: true }),
  );
}

function basicPolicy(overrides: Record<string, unknown> = {}) {
  return {
    version: "v1",
    summary: "test",
    providers: {
      stub: {
        enabled: true,
        baseUrl: "http://stub.invalid/v1",
        apiKey: null,
        defaultRpm: 60,
        defaultMaxParallel: 4,
      },
      stub2: {
        enabled: true,
        baseUrl: "http://stub2.invalid/v1",
        apiKey: null,
        defaultRpm: 60,
        defaultMaxParallel: 4,
      },
    },
    classes: {
      patch_builder: {
        summary: "test",
        models: [
          { provider: "stub", model: "m1" },
          { provider: "stub2", model: "m2" },
        ],
        maxParallel: 1,
      },
      empty_class: {
        summary: "no models",
        models: [],
        maxParallel: 1,
      },
    },
    defaults: {
      rateLimitTargetFraction: 0.65,
      backoff: { baseMs: 1, maxMs: 5, factor: 2 },
      requestTimeoutMs: 30_000,
    },
    ...overrides,
  };
}

// --- happy path ----------------------------------------------------------

test("callClass: first model returns 200 → broker selects it, no fallback", async () => {
  await withTempPolicy(basicPolicy(), async (registry, eventLog) => {
    const stub1 = new StubProvider("stub");
    const stub2 = new StubProvider("stub2");
    stub1.enqueue({ ok: true, status: 200 });
    const broker = new InferenceBroker({
      registry,
      providerFactory: (name) => (name === "stub" ? stub1 : stub2),
      rateLimitEventLogPath: eventLog,
      rng: () => 0, // deterministic backoff
    });
    const res = await broker.callClass({
      taskClass: "patch_builder",
      messages: [{ role: "user", content: "hi" }],
    });
    assert.equal(res.ok, true);
    assert.equal(res.attempts.length, 1);
    assert.equal(res.attempts[0]!.modelKey, "stub:m1");
    assert.equal(res.selected?.modelKey, "stub:m1");
    assert.equal(stub1.callLog.length, 1);
    assert.equal(stub2.callLog.length, 0);
  });
});

// --- class not found / no models -----------------------------------------

test("callClass: unknown class → ok=false, rejected=no-class, no calls", async () => {
  await withTempPolicy(basicPolicy(), async (registry) => {
    const stub1 = new StubProvider("stub");
    const stub2 = new StubProvider("stub2");
    const broker = new InferenceBroker({
      registry,
      providerFactory: (name) => (name === "stub" ? stub1 : stub2),
    });
    const res = await broker.callClass({
      taskClass: "no-such-class",
      messages: [{ role: "user", content: "hi" }],
    });
    assert.equal(res.ok, false);
    assert.equal(res.rejected, "no-class");
    assert.equal(stub1.callLog.length, 0);
    assert.equal(stub2.callLog.length, 0);
  });
});

test("callClass: empty model list → ok=false, rejected=no-models-enabled", async () => {
  await withTempPolicy(basicPolicy(), async (registry) => {
    const broker = new InferenceBroker({
      registry,
      providerFactory: () => new StubProvider("stub"),
    });
    const res = await broker.callClass({
      taskClass: "empty_class",
      messages: [{ role: "user", content: "hi" }],
    });
    assert.equal(res.ok, false);
    assert.equal(res.rejected, "no-models-enabled");
  });
});

// --- 429 → log + retry on same model with backoff ------------------------

test("callClass: 429 then 200 → retried, 429 logged to event file", async () => {
  await withTempPolicy(basicPolicy(), async (registry, eventLog) => {
    const stub1 = new StubProvider("stub");
    const stub2 = new StubProvider("stub2");
    stub1.enqueue(
      { ok: false, status: 429, retryAfterMs: 1, body: { error: "rate" } },
      { ok: true, status: 200 },
    );
    const broker = new InferenceBroker({
      registry,
      providerFactory: (name) => (name === "stub" ? stub1 : stub2),
      rateLimitEventLogPath: eventLog,
      rng: () => 0,
    });
    const res = await broker.callClass({
      taskClass: "patch_builder",
      messages: [{ role: "user", content: "hi" }],
    });
    assert.equal(res.ok, true);
    assert.equal(res.attempts.length, 2);
    assert.equal(res.attempts[0]!.status, 429);
    assert.equal(res.attempts[1]!.status, 200);
    assert.equal(stub1.callLog.length, 2);
    assert.equal(stub2.callLog.length, 0);
    // 429 event was recorded.
    const events = readFileSync(eventLog, "utf8")
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l));
    assert.equal(events.length, 1);
    assert.equal(events[0].status, 429);
    assert.equal(events[0].modelId, "stub:m1");
    assert.equal(events[0].observedRetryAfterMs, 1);
  });
});

// --- non-retryable on first model → fall through to second ---------------

test("callClass: non-retryable 401 on model 1 → fall through to model 2", async () => {
  await withTempPolicy(basicPolicy(), async (registry, eventLog) => {
    const stub1 = new StubProvider("stub");
    const stub2 = new StubProvider("stub2");
    stub1.enqueue({ ok: false, status: 401, body: { error: "unauthorized" } });
    stub2.enqueue({ ok: true, status: 200 });
    const broker = new InferenceBroker({
      registry,
      providerFactory: (name) => (name === "stub" ? stub1 : stub2),
      rateLimitEventLogPath: eventLog,
      rng: () => 0,
    });
    const res = await broker.callClass({
      taskClass: "patch_builder",
      messages: [{ role: "user", content: "hi" }],
    });
    assert.equal(res.ok, true);
    assert.equal(res.selected?.modelKey, "stub2:m2");
    assert.equal(res.attempts.length, 2);
    assert.equal(res.attempts[0]!.status, 401);
    assert.equal(res.attempts[1]!.status, 200);
  });
});

// --- exhaust all models → all-attempts-failed ----------------------------

test("callClass: every model fails non-retryably → ok=false, all attempts recorded", async () => {
  await withTempPolicy(basicPolicy(), async (registry) => {
    const stub1 = new StubProvider("stub");
    const stub2 = new StubProvider("stub2");
    stub1.enqueue({ ok: false, status: 400, body: { error: "bad request" } });
    stub2.enqueue({ ok: false, status: 400, body: { error: "bad request" } });
    const broker = new InferenceBroker({
      registry,
      providerFactory: (name) => (name === "stub" ? stub1 : stub2),
      rng: () => 0,
    });
    const res = await broker.callClass({
      taskClass: "patch_builder",
      messages: [{ role: "user", content: "hi" }],
    });
    assert.equal(res.ok, false);
    assert.equal(res.rejected, "all-attempts-failed");
    assert.equal(res.attempts.length, 2);
    assert.equal(res.selected, null);
  });
});

// --- 5xx is retryable ----------------------------------------------------

test("callClass: 503 on model 1 → retried", async () => {
  await withTempPolicy(basicPolicy(), async (registry) => {
    const stub1 = new StubProvider("stub");
    const stub2 = new StubProvider("stub2");
    stub1.enqueue(
      { ok: false, status: 503, body: { error: "unavail" } },
      { ok: true, status: 200 },
    );
    const broker = new InferenceBroker({
      registry,
      providerFactory: (name) => (name === "stub" ? stub1 : stub2),
      rng: () => 0,
    });
    const res = await broker.callClass({
      taskClass: "patch_builder",
      messages: [{ role: "user", content: "hi" }],
    });
    assert.equal(res.ok, true);
    assert.equal(res.attempts[0]!.status, 503);
    assert.equal(res.attempts[1]!.status, 200);
  });
});

// --- bucket inspection ----------------------------------------------------

test("inspectBucket: configured for every (provider, model) pair in classes", async () => {
  await withTempPolicy(basicPolicy(), async (registry) => {
    const broker = new InferenceBroker({
      registry,
      providerFactory: (name) => new StubProvider(name),
    });
    assert.ok(broker.inspectBucket("stub", "m1"));
    assert.ok(broker.inspectBucket("stub2", "m2"));
    assert.equal(broker.inspectBucket("stub", "missing-model"), null);
  });
});

// --- listProviders --------------------------------------------------------

test("listProviders: returns enabled providers from registry", async () => {
  await withTempPolicy(basicPolicy(), async (registry) => {
    const broker = new InferenceBroker({
      registry,
      providerFactory: (name) => new StubProvider(name),
    });
    const names = broker.listProviders().sort();
    assert.deepEqual(names, ["stub", "stub2"]);
  });
});

// --- live model-policy.json sanity (no network) --------------------------

test("real config/model-policy.json parses; nim disabled by default", () => {
  const registry = new ModelRegistry({ env: {} });
  const nim = registry.providerEntry("nvidia-nim");
  assert.ok(nim);
  assert.equal(nim?.enabled, false);
  // Local providers are listed.
  assert.ok(registry.providerEntry("ollama-local"));
  assert.ok(registry.providerEntry("lmstudio-local"));
  // Effective enablement: nim is disabled (no env key), ollama-local is enabled.
  const enabled = new Set(registry.listEnabledProviders());
  assert.equal(enabled.has("nvidia-nim"), false);
  assert.equal(enabled.has("ollama-local"), true);
});

test("real config/model-policy.json: NVIDIA_API_KEY env makes nim effectively enabled (after policy flip)", () => {
  // Even with the env, the policy itself disables nim. Assert that the
  // registry surfaces the env-driven key resolution but respects the
  // policy gate.
  const registry = new ModelRegistry({
    env: { NVIDIA_API_KEY: "x" },
  });
  const enabled = new Set(registry.listEnabledProviders());
  // Policy says enabled: false → still not effective even with env set.
  assert.equal(enabled.has("nvidia-nim"), false);
});
