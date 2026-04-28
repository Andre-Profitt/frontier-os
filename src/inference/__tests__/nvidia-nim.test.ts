// NIM provider — recorded fixtures, no live network.

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  NvidiaNIMProvider,
  NIM_DEFAULT_BASE_URL,
  resolveNIMConfig,
} from "../providers/nvidia-nim.ts";

// Mock a fetch implementation that records the request and returns a
// canned response. Each test owns its mock; no shared state.
function mockFetch(handler: (req: Request) => Promise<Response> | Response) {
  return async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    const req = new Request(url, init);
    return handler(req);
  };
}

test("resolveNIMConfig: NVIDIA_API_KEY wins over NIM_API_KEY", () => {
  const c = resolveNIMConfig({
    env: { NVIDIA_API_KEY: "from-nvidia", NIM_API_KEY: "from-nim" },
  });
  assert.equal(c.apiKey, "from-nvidia");
});

test("resolveNIMConfig: falls back to NIM_API_KEY when NVIDIA_API_KEY absent", () => {
  const c = resolveNIMConfig({ env: { NIM_API_KEY: "fallback-key" } });
  assert.equal(c.apiKey, "fallback-key");
});

test("resolveNIMConfig: NIM_BASE_URL overrides default base URL", () => {
  const c = resolveNIMConfig({
    env: { NIM_BASE_URL: "http://localhost:8000/v1" },
  });
  assert.equal(c.baseUrl, "http://localhost:8000/v1");
});

test("resolveNIMConfig: default base URL when none configured", () => {
  const c = resolveNIMConfig({ env: {} });
  assert.equal(c.baseUrl, NIM_DEFAULT_BASE_URL);
});

test("chatCompletion: posts OpenAI-style body with bearer auth", async () => {
  type Captured = {
    url: string;
    method: string;
    headers: Headers;
    body: string;
  };
  const captured: Captured[] = [];
  const fetchImpl = mockFetch(async (req) => {
    captured.push({
      url: req.url,
      method: req.method,
      headers: req.headers,
      body: await req.text(),
    });
    return new Response(
      JSON.stringify({
        id: "chatcmpl-1",
        choices: [
          {
            index: 0,
            message: { role: "assistant", content: "ok" },
            finish_reason: "stop",
          },
        ],
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  });

  const provider = new NvidiaNIMProvider({
    env: { NVIDIA_API_KEY: "k-test" },
    fetchImpl: fetchImpl as unknown as typeof fetch,
  });
  const res = await provider.chatCompletion({
    model: "kimi-k2",
    messages: [{ role: "user", content: "hi" }],
  });
  assert.equal(res.ok, true);
  assert.equal(res.status, 200);
  assert.equal(res.modelId, "kimi-k2");
  assert.equal(captured.length, 1);
  const c = captured[0]!;
  assert.equal(c.method, "POST");
  assert.ok(c.url.endsWith("/chat/completions"));
  assert.equal(c.headers.get("authorization"), "Bearer k-test");
  assert.equal(c.headers.get("content-type"), "application/json");
  const body = JSON.parse(c.body);
  assert.equal(body.model, "kimi-k2");
  assert.deepEqual(body.messages, [{ role: "user", content: "hi" }]);
});

test("chatCompletion: 429 with Retry-After header → retryAfterMs populated", async () => {
  const fetchImpl = mockFetch(async () => {
    return new Response(JSON.stringify({ error: "rate limit" }), {
      status: 429,
      headers: { "retry-after": "3", "content-type": "application/json" },
    });
  });
  const provider = new NvidiaNIMProvider({
    env: { NVIDIA_API_KEY: "k" },
    fetchImpl: fetchImpl as unknown as typeof fetch,
  });
  const res = await provider.chatCompletion({
    model: "kimi-k2",
    messages: [{ role: "user", content: "hi" }],
  });
  assert.equal(res.ok, false);
  assert.equal(res.status, 429);
  assert.equal(res.retryAfterMs, 3_000);
});

test("chatCompletion: network error returns ok=false, status=0, captures message", async () => {
  const fetchImpl = mockFetch(async () => {
    throw new TypeError("ECONNREFUSED");
  });
  const provider = new NvidiaNIMProvider({
    env: { NVIDIA_API_KEY: "k" },
    fetchImpl: fetchImpl as unknown as typeof fetch,
  });
  const res = await provider.chatCompletion({
    model: "kimi-k2",
    messages: [{ role: "user", content: "hi" }],
  });
  assert.equal(res.ok, false);
  assert.equal(res.status, 0);
  assert.match(res.rawText, /ECONNREFUSED/);
});

test("listModels: parses OpenAI-style { data: [{ id }] } response", async () => {
  const fetchImpl = mockFetch(async () => {
    return new Response(
      JSON.stringify({
        data: [
          { id: "kimi-k2", object: "model" },
          { id: "deepseek-r1", object: "model" },
        ],
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  });
  const provider = new NvidiaNIMProvider({
    env: { NVIDIA_API_KEY: "k" },
    fetchImpl: fetchImpl as unknown as typeof fetch,
  });
  const res = await provider.listModels();
  assert.equal(res.ok, true);
  assert.deepEqual(res.ids.sort(), ["deepseek-r1", "kimi-k2"]);
});

// --- Patch DD: embeddings ----------------------------------------------

test("embed (Patch DD): posts OpenAI-style /v1/embeddings body with bearer auth, returns ordered vectors", async () => {
  type Captured = {
    url: string;
    method: string;
    headers: Headers;
    body: string;
  };
  const captured: Captured[] = [];
  const fetchImpl = mockFetch(async (req) => {
    captured.push({
      url: req.url,
      method: req.method,
      headers: req.headers,
      body: await req.text(),
    });
    // NIM may legitimately return rows out of order; the provider
    // re-orders by index. Pin that contract here so a future
    // refactor doesn't drop the sort and silently mis-pair vectors
    // with their input strings.
    return new Response(
      JSON.stringify({
        object: "list",
        model: "nvidia/llama-3.2-nv-embedqa-1b-v2",
        data: [
          { object: "embedding", index: 1, embedding: [0.4, 0.5, 0.6] },
          { object: "embedding", index: 0, embedding: [0.1, 0.2, 0.3] },
        ],
        usage: { prompt_tokens: 8, total_tokens: 8 },
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  });

  const provider = new NvidiaNIMProvider({
    env: { NVIDIA_API_KEY: "k-test" },
    fetchImpl: fetchImpl as unknown as typeof fetch,
  });
  const res = await provider.embed({
    model: "nvidia/llama-3.2-nv-embedqa-1b-v2",
    input: ["first", "second"],
    input_type: "passage", // NIM-specific pass-through
  });

  assert.equal(res.ok, true);
  assert.equal(res.status, 200);
  assert.deepEqual(res.embeddings, [
    [0.1, 0.2, 0.3],
    [0.4, 0.5, 0.6],
  ]);
  assert.equal(captured.length, 1);
  const c = captured[0]!;
  assert.match(c.url, /\/v1\/embeddings$/);
  assert.equal(c.method, "POST");
  assert.equal(c.headers.get("authorization"), "Bearer k-test");
  assert.equal(c.headers.get("content-type"), "application/json");
  const sentBody = JSON.parse(c.body);
  assert.deepEqual(sentBody.input, ["first", "second"]);
  assert.equal(sentBody.input_type, "passage");
});

test("embed (Patch DD): non-2xx response → ok=false, embeddings=[]", async () => {
  const fetchImpl = mockFetch(async () => {
    return new Response(
      JSON.stringify({ error: { message: "model not found" } }),
      { status: 404, headers: { "content-type": "application/json" } },
    );
  });
  const provider = new NvidiaNIMProvider({
    env: { NVIDIA_API_KEY: "k" },
    fetchImpl: fetchImpl as unknown as typeof fetch,
  });
  const res = await provider.embed({ model: "no/such-model", input: ["x"] });
  assert.equal(res.ok, false);
  assert.equal(res.status, 404);
  assert.deepEqual(res.embeddings, []);
});

test("embed (Patch DD): malformed body (no data array) → ok=true, embeddings=[] (provider can't fabricate)", async () => {
  // 200 OK but the body shape doesn't match the OpenAI embeddings
  // spec — surface as ok=true (the HTTP layer succeeded) with empty
  // embeddings so the caller can decide whether to fall back. Don't
  // throw; the broker's retry logic handles "no useful data".
  const fetchImpl = mockFetch(async () => {
    return new Response(JSON.stringify({ unexpected: "shape" }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  });
  const provider = new NvidiaNIMProvider({
    env: { NVIDIA_API_KEY: "k" },
    fetchImpl: fetchImpl as unknown as typeof fetch,
  });
  const res = await provider.embed({ model: "m", input: ["x"] });
  assert.equal(res.ok, true);
  assert.deepEqual(res.embeddings, []);
});

test("embed (Patch DD): row with non-numeric values is skipped (defense against malformed providers)", async () => {
  // Pin the contract: if a provider returns a row whose `embedding`
  // contains a string / NaN / null, drop that row rather than
  // surfacing a partially-numeric vector that downstream cosine math
  // would silently corrupt.
  const fetchImpl = mockFetch(async () => {
    return new Response(
      JSON.stringify({
        data: [
          { index: 0, embedding: [0.1, 0.2, 0.3] },
          { index: 1, embedding: [0.5, "oops" as unknown as number, 0.7] },
          { index: 2, embedding: [0.9, 1.0, 1.1] },
        ],
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  });
  const provider = new NvidiaNIMProvider({
    env: { NVIDIA_API_KEY: "k" },
    fetchImpl: fetchImpl as unknown as typeof fetch,
  });
  const res = await provider.embed({ model: "m", input: ["a", "b", "c"] });
  assert.equal(res.ok, true);
  // Row 1 dropped; the remaining two rows preserve their indices.
  assert.deepEqual(res.embeddings, [
    [0.1, 0.2, 0.3],
    [0.9, 1.0, 1.1],
  ]);
});
