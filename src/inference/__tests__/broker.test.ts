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

// --- modelOverride (PR-A patch) ------------------------------------------

test("callClass: modelOverride pins to that exact (provider, model) — fallback skipped", async () => {
  await withTempPolicy(basicPolicy(), async (registry) => {
    const stub1 = new StubProvider("stub");
    const stub2 = new StubProvider("stub2");
    // stub1 would normally be tried first, but override pins stub2:m2.
    stub2.enqueue({ ok: true, status: 200 });
    const broker = new InferenceBroker({
      registry,
      providerFactory: (name) => (name === "stub" ? stub1 : stub2),
      rng: () => 0,
    });
    const res = await broker.callClass({
      taskClass: "patch_builder",
      messages: [{ role: "user", content: "hi" }],
      modelOverride: "stub2:m2",
    });
    assert.equal(res.ok, true);
    assert.equal(res.selected?.modelKey, "stub2:m2");
    assert.equal(stub1.callLog.length, 0); // pinned away from stub1
    assert.equal(stub2.callLog.length, 1);
  });
});

test("callClass: modelOverride that doesn't match any class candidate → rejected=model-override-not-found", async () => {
  await withTempPolicy(basicPolicy(), async (registry) => {
    const broker = new InferenceBroker({
      registry,
      providerFactory: (name) => new StubProvider(name),
    });
    const res = await broker.callClass({
      taskClass: "patch_builder",
      messages: [{ role: "user", content: "hi" }],
      modelOverride: "nonexistent:model",
    });
    assert.equal(res.ok, false);
    assert.equal(res.rejected, "model-override-not-found");
    assert.equal(res.attempts.length, 0);
    assert.equal(res.selected, null);
    assert.equal(res.selectedResponse, null);
  });
});

test("callClass: modelOverride does NOT bypass the class — still must be in classes[taskClass].models", async () => {
  // Ensures override can't be used to escape the class allowlist (e.g.
  // route a builder model through merge_arbiter). Override is a filter,
  // not a backdoor.
  await withTempPolicy(basicPolicy(), async (registry) => {
    const broker = new InferenceBroker({
      registry,
      providerFactory: (name) => new StubProvider(name),
    });
    // empty_class has no models; override should be rejected even though
    // stub2:m2 is a real model in another class.
    const res = await broker.callClass({
      taskClass: "empty_class",
      messages: [{ role: "user", content: "hi" }],
      modelOverride: "stub2:m2",
    });
    assert.equal(res.ok, false);
    // empty_class has no models, so we hit no-models-enabled BEFORE
    // model-override-not-found is even evaluated.
    assert.equal(res.rejected, "no-models-enabled");
  });
});

// --- selectedResponse normalization (PR-A patch) -------------------------

test("callClass: selectedResponse is null when ok=false", async () => {
  await withTempPolicy(basicPolicy(), async (registry) => {
    const stub1 = new StubProvider("stub");
    const stub2 = new StubProvider("stub2");
    stub1.enqueue({ ok: false, status: 400, body: { error: "bad" } });
    stub2.enqueue({ ok: false, status: 400, body: { error: "bad" } });
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
    assert.equal(res.selectedResponse, null);
  });
});

test("callClass: selectedResponse populated on success — text from choices[0].message.content", async () => {
  await withTempPolicy(basicPolicy(), async (registry) => {
    const stub1 = new StubProvider("stub");
    stub1.enqueue({
      ok: true,
      status: 200,
      body: {
        choices: [
          {
            message: { content: "hello world" },
            finish_reason: "stop",
          },
        ],
        usage: { prompt_tokens: 5, completion_tokens: 2 },
      },
    });
    const broker = new InferenceBroker({
      registry,
      providerFactory: (name) =>
        name === "stub" ? stub1 : new StubProvider(name),
      rng: () => 0,
    });
    const res = await broker.callClass({
      taskClass: "patch_builder",
      messages: [{ role: "user", content: "hi" }],
    });
    assert.equal(res.ok, true);
    assert.ok(res.selectedResponse);
    assert.equal(res.selectedResponse?.text, "hello world");
    assert.equal(res.selectedResponse?.finishReason, "stop");
    assert.deepEqual(res.selectedResponse?.usage, {
      prompt_tokens: 5,
      completion_tokens: 2,
    });
    assert.ok(res.selectedResponse?.rawBody);
  });
});

test("callClass: selectedResponse falls back to JSON-stringify when body is not OpenAI-shape", async () => {
  await withTempPolicy(basicPolicy(), async (registry) => {
    const stub1 = new StubProvider("stub");
    stub1.enqueue({
      ok: true,
      status: 200,
      body: { custom: "non-openai", payload: 42 },
    });
    const broker = new InferenceBroker({
      registry,
      providerFactory: (name) =>
        name === "stub" ? stub1 : new StubProvider(name),
      rng: () => 0,
    });
    const res = await broker.callClass({
      taskClass: "patch_builder",
      messages: [{ role: "user", content: "hi" }],
    });
    assert.equal(res.ok, true);
    assert.match(res.selectedResponse?.text ?? "", /custom/);
    assert.equal(res.selectedResponse?.finishReason, undefined);
  });
});

// --- normalizeResponse direct unit tests ---------------------------------

test("normalizeResponse: null body → empty text, rawBody null", async () => {
  const { normalizeResponse } = await import("../broker.ts");
  const r = normalizeResponse(null);
  assert.equal(r.text, "");
  assert.equal(r.rawBody, null);
});

test("normalizeResponse: choices[0].message.content extracted", async () => {
  const { normalizeResponse } = await import("../broker.ts");
  const r = normalizeResponse({
    choices: [{ message: { content: "ok" } }],
  });
  assert.equal(r.text, "ok");
});

test("normalizeResponse: empty choices → fall back to stringify", async () => {
  const { normalizeResponse } = await import("../broker.ts");
  const r = normalizeResponse({ choices: [] });
  assert.match(r.text, /"choices":\[\]/);
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

test("real config/model-policy.json parses; nim enabled but needs auth (Patch N)", () => {
  // Test seam: env={} closes the env AND defaults the credential resolver
  // to no-op so we don't leak ~/.env from the dev machine.
  const registry = new ModelRegistry({ env: {} });
  const nim = registry.providerEntry("nvidia-nim");
  assert.ok(nim);
  assert.equal(nim?.enabled, true); // Patch N flipped this on
  // Local providers are listed.
  assert.ok(registry.providerEntry("ollama-local"));
  assert.ok(registry.providerEntry("lmstudio-local"));
  // Effective enablement: nim is policy-enabled BUT the test env has
  // no NVIDIA_API_KEY → not effective. ollama-local needs no auth.
  const enabled = new Set(registry.listEnabledProviders());
  assert.equal(enabled.has("nvidia-nim"), false);
  assert.equal(enabled.has("ollama-local"), true);
});

test("real config/model-policy.json: NVIDIA_API_KEY env makes nim effectively enabled (Patch N)", () => {
  // env-injected key satisfies the auth check; policy is enabled.
  const registry = new ModelRegistry({
    env: { NVIDIA_API_KEY: "x" },
  });
  const enabled = new Set(registry.listEnabledProviders());
  assert.equal(enabled.has("nvidia-nim"), true);
});

test("real config/model-policy.json: dotenv-resolved key satisfies nim auth (Patch N resolver)", () => {
  // Test seam: env={} closes process.env; resolveCredentialImpl provides
  // the key as if it came from ~/.env. Pins the credential-resolver
  // wiring so a future regression where the registry stops calling the
  // resolver gets caught.
  const registry = new ModelRegistry({
    env: {},
    resolveCredentialImpl: (key) =>
      key === "NVIDIA_API_KEY" ? "from-dotenv" : undefined,
  });
  const enabled = new Set(registry.listEnabledProviders());
  assert.equal(enabled.has("nvidia-nim"), true);
  assert.equal(registry.resolveApiKey("nvidia-nim"), "from-dotenv");
});

// Patch O — per-class arbiter gate defaults.

test("ModelRegistry.classGates: returns the policy class's gates field", () => {
  const registry = new ModelRegistry({ env: {} });
  const gates = registry.classGates("patch_builder");
  // patch_builder has Patch O calibrated gates set.
  assert.ok(gates);
  assert.equal(typeof gates?.qualityFloor, "number");
  assert.ok(
    (gates?.qualityFloor ?? 0) > 0 && (gates?.qualityFloor ?? 1) < 1,
    "qualityFloor must be in (0, 1)",
  );
});

test("ModelRegistry.classGates: returns undefined for class without gates", () => {
  const registry = new ModelRegistry({ env: {} });
  // research_extraction has no gates field set in the live policy.
  const gates = registry.classGates("research_extraction");
  assert.equal(gates, undefined);
});

test("ModelRegistry.classGates: returns undefined for unknown taskClass", () => {
  const registry = new ModelRegistry({ env: {} });
  const gates = registry.classGates("does-not-exist");
  assert.equal(gates, undefined);
});
