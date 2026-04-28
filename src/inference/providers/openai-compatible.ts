// Generic OpenAI-compatible chat provider. Handles the wire format that
// NIM, OpenRouter, LM Studio, Ollama (with --openai-compat), and Together
// all expose: POST /v1/chat/completions with { model, messages, ... }.
//
// Stays a thin client: no rate-limit enforcement (broker's job), no
// retries (backoff helper's job), no logging beyond returning structured
// metadata. The broker composes those.

export interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  // tool fields are passed through if provided; we don't model them
  // strictly because providers vary in support.
  [key: string]: unknown;
}

export interface ChatRequest {
  model: string;
  messages: ChatMessage[];
  temperature?: number;
  max_tokens?: number;
  stream?: false; // streaming is out of scope for this PR
  // Pass-through for tool / response_format / etc. Provider-specific.
  [key: string]: unknown;
}

export interface ChatResponse {
  ok: boolean;
  status: number;
  modelId: string;
  // Parsed body when ok; raw text otherwise.
  body: unknown;
  rawText: string;
  retryAfterMs: number | null; // populated on 429 if header present
  durationMs: number;
  endpoint: string;
}

// Patch DD: OpenAI-compatible embeddings request. Same wire format as
// chat completions — POST /v1/embeddings with { model, input }. NIM's
// NV-EmbedQA family additionally supports `input_type: "query" |
// "passage"` (the [key: string]: unknown pass-through covers it without
// committing to a NIM-specific schema). Most providers (OpenAI,
// Together, OpenRouter, NIM-non-EmbedQA) ignore unknown fields.
export interface EmbedRequest {
  model: string;
  // OpenAI accepts a single string or an array of strings; we always
  // pass an array so the response shape is uniform.
  input: string[];
  // Provider-specific pass-throughs (e.g. NIM's `input_type`,
  // `truncate`, `encoding_format`).
  [key: string]: unknown;
}

export interface EmbedResponse {
  ok: boolean;
  status: number;
  modelId: string;
  // One vector per input string, in input order. Empty when !ok.
  embeddings: number[][];
  // Parsed body when ok; null otherwise. Surfaced for callers that
  // need usage tokens / model echoback.
  body: unknown;
  rawText: string;
  retryAfterMs: number | null;
  durationMs: number;
  endpoint: string;
}

export interface ProviderConfig {
  baseUrl: string;
  apiKey?: string; // optional for local providers (ollama / lmstudio)
  // Test seam — inject a fetch implementation. Defaults to globalThis.fetch.
  fetchImpl?: typeof fetch;
  // Per-call timeout (ms). The broker enforces its own envelope; this is
  // the client's last-resort cap.
  requestTimeoutMs?: number;
}

// Default per-call timeout when the broker doesn't supply one. 300s
// covers both branches:
//   - local 70B-class on consumer hardware (qwen2.5:72b on M-series
//     Mac runs ~30–120s for builder-sized prompts)
//   - NIM frontier models (qwen3-coder-480b, kimi-k2.5, deepseek-v4)
//     have meaningful cold-start + queue + generation latency on the
//     free tier — Patch N validation showed 264s elapsed on a single
//     call to qwen2.5-coder-32b-instruct via NIM
// Was 180s pre-Patch-N (killed long NIM calls mid-flight). Patch U
// now threads `policy.defaults.requestTimeoutMs` through the broker
// → factory → provider config, so operators tune timeouts in one
// place. This constant remains as the last-resort fallback for
// callers that construct a provider directly without going through
// the broker.
const DEFAULT_TIMEOUT_MS = 300_000;

export class OpenAICompatibleProvider {
  readonly name: string;
  readonly baseUrl: string;
  protected apiKey: string | undefined;
  protected fetchImpl: typeof fetch;
  protected requestTimeoutMs: number;

  constructor(name: string, config: ProviderConfig) {
    this.name = name;
    this.baseUrl = config.baseUrl.replace(/\/$/, "");
    this.apiKey = config.apiKey;
    this.fetchImpl = config.fetchImpl ?? fetch;
    this.requestTimeoutMs = config.requestTimeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  async chatCompletion(req: ChatRequest): Promise<ChatResponse> {
    const endpoint = `${this.baseUrl}/chat/completions`;
    const headers: Record<string, string> = {
      "content-type": "application/json",
      accept: "application/json",
    };
    if (this.apiKey) {
      headers["authorization"] = `Bearer ${this.apiKey}`;
    }

    const ac = new AbortController();
    const t0 = Date.now();
    const timer = setTimeout(() => ac.abort(), this.requestTimeoutMs);
    try {
      const res = await this.fetchImpl(endpoint, {
        method: "POST",
        headers,
        body: JSON.stringify(req),
        signal: ac.signal,
      });
      const rawText = await res.text();
      const durationMs = Date.now() - t0;
      let body: unknown = null;
      try {
        body = rawText.length > 0 ? JSON.parse(rawText) : null;
      } catch {
        body = null;
      }
      const retryAfterMs = parseRetryAfter(res.headers.get("retry-after"));
      return {
        ok: res.ok,
        status: res.status,
        modelId: req.model,
        body,
        rawText,
        retryAfterMs,
        durationMs,
        endpoint,
      };
    } catch (err) {
      const durationMs = Date.now() - t0;
      const message = err instanceof Error ? err.message : String(err);
      return {
        ok: false,
        status: 0,
        modelId: req.model,
        body: null,
        rawText: `client error: ${message}`,
        retryAfterMs: null,
        durationMs,
        endpoint,
      };
    } finally {
      clearTimeout(timer);
    }
  }

  // Patch DD: OpenAI-compatible embeddings call. Mirrors chatCompletion's
  // shape — same auth, same timeout, same fetch seam — so the broker
  // and downstream callers can reuse provider plumbing for both kinds
  // of inference. Stays a thin client: no batching beyond what the
  // caller passes, no rate-limit enforcement, no retry logic. Wire
  // point for the eventual review-swarm anti-example reranker, but
  // shippable as a foundation cut on its own.
  async embed(req: EmbedRequest): Promise<EmbedResponse> {
    const endpoint = `${this.baseUrl}/embeddings`;
    const headers: Record<string, string> = {
      "content-type": "application/json",
      accept: "application/json",
    };
    if (this.apiKey) {
      headers["authorization"] = `Bearer ${this.apiKey}`;
    }

    const ac = new AbortController();
    const t0 = Date.now();
    const timer = setTimeout(() => ac.abort(), this.requestTimeoutMs);
    try {
      const res = await this.fetchImpl(endpoint, {
        method: "POST",
        headers,
        body: JSON.stringify(req),
        signal: ac.signal,
      });
      const rawText = await res.text();
      const durationMs = Date.now() - t0;
      let body: unknown = null;
      try {
        body = rawText.length > 0 ? JSON.parse(rawText) : null;
      } catch {
        body = null;
      }
      const retryAfterMs = parseRetryAfter(res.headers.get("retry-after"));
      const embeddings = res.ok ? extractEmbeddings(body) : [];
      return {
        ok: res.ok,
        status: res.status,
        modelId: req.model,
        embeddings,
        body,
        rawText,
        retryAfterMs,
        durationMs,
        endpoint,
      };
    } catch (err) {
      const durationMs = Date.now() - t0;
      const message = err instanceof Error ? err.message : String(err);
      return {
        ok: false,
        status: 0,
        modelId: req.model,
        embeddings: [],
        body: null,
        rawText: `client error: ${message}`,
        retryAfterMs: null,
        durationMs,
        endpoint,
      };
    } finally {
      clearTimeout(timer);
    }
  }

  async listModels(): Promise<{ ok: boolean; status: number; ids: string[] }> {
    const endpoint = `${this.baseUrl}/models`;
    const headers: Record<string, string> = { accept: "application/json" };
    if (this.apiKey) headers["authorization"] = `Bearer ${this.apiKey}`;
    try {
      const res = await this.fetchImpl(endpoint, { method: "GET", headers });
      const text = await res.text();
      const parsed = (() => {
        try {
          return JSON.parse(text);
        } catch {
          return null;
        }
      })() as { data?: Array<{ id: string }> } | null;
      const ids = parsed?.data?.map((m) => m.id) ?? [];
      return { ok: res.ok, status: res.status, ids };
    } catch {
      return { ok: false, status: 0, ids: [] };
    }
  }
}

// Patch DD: extract per-input embedding vectors from a parsed
// /v1/embeddings response. OpenAI / NIM / Together all return:
//   { object: "list", data: [{ index: N, embedding: [...] }, ...] }
// We sort by `index` so callers can rely on input-order alignment
// even if the provider returns rows out of order (rare but spec-
// allowed). Returns [] if the body shape doesn't match — the caller
// already knows ok=false at that point, this just keeps the type
// surface clean.
function extractEmbeddings(body: unknown): number[][] {
  if (!body || typeof body !== "object") return [];
  const data = (body as { data?: unknown }).data;
  if (!Array.isArray(data)) return [];
  const rows: Array<{ index: number; embedding: number[] }> = [];
  for (const row of data) {
    if (!row || typeof row !== "object") continue;
    const r = row as { index?: unknown; embedding?: unknown };
    const idx = typeof r.index === "number" ? r.index : rows.length;
    if (!Array.isArray(r.embedding)) continue;
    const vec: number[] = [];
    let valid = true;
    for (const v of r.embedding) {
      if (typeof v !== "number" || !Number.isFinite(v)) {
        valid = false;
        break;
      }
      vec.push(v);
    }
    if (!valid) continue;
    rows.push({ index: idx, embedding: vec });
  }
  rows.sort((a, b) => a.index - b.index);
  return rows.map((r) => r.embedding);
}

// retry-after may be either delta-seconds (integer) or HTTP-date.
function parseRetryAfter(header: string | null): number | null {
  if (!header) return null;
  const trimmed = header.trim();
  if (/^\d+$/.test(trimmed)) {
    return parseInt(trimmed, 10) * 1000;
  }
  const ms = Date.parse(trimmed);
  if (!Number.isNaN(ms)) {
    const delta = ms - Date.now();
    return delta > 0 ? delta : 0;
  }
  return null;
}
