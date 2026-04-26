// Inference Broker — every model call in frontier-os goes through this.
//
// Responsibilities:
//   - resolve task class → model list (via ModelRegistry)
//   - per-model rate limiting (TokenBucketLimiter)
//   - capped exponential backoff with jitter on 429 / 5xx
//   - fallback to next model in the class on persistent failure
//   - record latency / status / 429s for empirical capacity scoring
//
// Pure orchestration — no provider-specific logic. Providers are passed
// in by the caller (or constructed via the default factory).
//
// Concurrency limits per class are enforced by a per-class semaphore;
// callers `await broker.callClass(...)` and the broker schedules.

import {
  ModelRegistry,
  type ClassModel,
  type ProviderEntry,
} from "./model-registry.ts";
import { TokenBucketLimiter, logRateLimitEvent } from "./rate-limit.ts";
import {
  delay,
  isRetryableStatus,
  nextDelayMs,
  type BackoffOptions,
} from "./backoff.ts";
import {
  OpenAICompatibleProvider,
  type ChatRequest,
  type ChatResponse,
  type ProviderConfig,
} from "./providers/openai-compatible.ts";
import { NvidiaNIMProvider } from "./providers/nvidia-nim.ts";

export interface BrokerCallOptions {
  taskClass: string;
  messages: ChatRequest["messages"];
  // Pass-through fields for the provider request.
  temperature?: number;
  max_tokens?: number;
  // Override the maxAttempts default (defaults to 3 across all models in
  // the class).
  maxAttempts?: number;
}

export interface BrokerCallResult {
  ok: boolean;
  taskClass: string;
  attempts: AttemptRecord[];
  selected: AttemptRecord | null;
  totalDurationMs: number;
  rejected: "no-class" | "no-models-enabled" | "all-attempts-failed" | null;
}

export interface AttemptRecord {
  modelKey: string; // "<provider>:<model>"
  provider: string;
  model: string;
  attemptNumber: number;
  bucketGranted: boolean;
  bucketWaitedMs: number;
  status: number;
  ok: boolean;
  durationMs: number;
  retryAfterMs: number | null;
  errorPreview?: string;
}

export interface BrokerOptions {
  registry?: ModelRegistry;
  // Caller-supplied provider factory. Default constructs nim + ollama-local
  // + lmstudio-local from the registry.
  providerFactory?: (
    name: string,
    entry: ProviderEntry,
    apiKey: string | null,
    baseUrl: string | null,
  ) => OpenAICompatibleProvider;
  // Test seam.
  now?: () => number;
  rng?: () => number;
  // Optional path for the 429 events log (default: state/inference/...).
  rateLimitEventLogPath?: string;
  // Optional override for the class maxAttempts default.
  defaultMaxAttempts?: number;
}

const DEFAULT_MAX_ATTEMPTS = 3;

export class InferenceBroker {
  readonly registry: ModelRegistry;
  private limiter = new TokenBucketLimiter();
  private providers = new Map<string, OpenAICompatibleProvider>();
  private classSemaphores = new Map<
    string,
    { inFlight: number; max: number }
  >();
  private now: () => number;
  private rng: () => number;
  private rateLimitEventLogPath: string | undefined;
  private defaultMaxAttempts: number;

  constructor(opts: BrokerOptions = {}) {
    this.registry = opts.registry ?? new ModelRegistry();
    this.now = opts.now ?? Date.now;
    this.rng = opts.rng ?? Math.random;
    this.rateLimitEventLogPath = opts.rateLimitEventLogPath;
    this.defaultMaxAttempts = opts.defaultMaxAttempts ?? DEFAULT_MAX_ATTEMPTS;

    // Initialize provider clients + buckets for each effectively-enabled
    // provider in the registry.
    const factory = opts.providerFactory ?? defaultProviderFactory;
    for (const name of this.registry.listEnabledProviders()) {
      const entry = this.registry.providerEntry(name)!;
      const apiKey = this.registry.resolveApiKey(name);
      const baseUrl = this.registry.resolveBaseUrl(name);
      const provider = factory(name, entry, apiKey, baseUrl);
      this.providers.set(name, provider);
    }

    // Configure rate-limit buckets per (provider, model) key found in
    // any class. Multiple classes may reference the same model; the
    // bucket is shared (correct: rate limit is per model, not per task).
    for (const [, classEntry] of Object.entries(this.registry.policy.classes)) {
      for (const m of classEntry.models) {
        const provider = this.registry.providerEntry(m.provider);
        if (!provider) continue;
        if (!this.registry.providerEffectivelyEnabled(provider)) continue;
        const key = modelKey(m);
        if (this.limiter.inspect(key)) continue;
        this.limiter.configure({
          modelId: key,
          rpm: provider.defaultRpm,
          now: this.now,
        });
      }
    }
  }

  listProviders(): string[] {
    return [...this.providers.keys()];
  }

  // Inspect bucket state — diagnostics only.
  inspectBucket(provider: string, model: string) {
    return this.limiter.inspect(`${provider}:${model}`);
  }

  async callClass(opts: BrokerCallOptions): Promise<BrokerCallResult> {
    const t0 = this.now();
    const cls = this.registry.classEntry(opts.taskClass);
    if (!cls) {
      return {
        ok: false,
        taskClass: opts.taskClass,
        attempts: [],
        selected: null,
        totalDurationMs: this.now() - t0,
        rejected: "no-class",
      };
    }
    const candidates = this.registry.resolveClassModels(opts.taskClass);
    if (candidates.length === 0) {
      return {
        ok: false,
        taskClass: opts.taskClass,
        attempts: [],
        selected: null,
        totalDurationMs: this.now() - t0,
        rejected: "no-models-enabled",
      };
    }

    // Per-class concurrency. Fast-path when nothing else is in flight.
    const sem = this.classSemaphores.get(opts.taskClass) ?? {
      inFlight: 0,
      max: cls.maxParallel,
    };
    this.classSemaphores.set(opts.taskClass, sem);
    while (sem.inFlight >= sem.max) {
      await delay(50);
    }
    sem.inFlight += 1;

    const attempts: AttemptRecord[] = [];
    const maxAttempts = opts.maxAttempts ?? this.defaultMaxAttempts;
    const backoff: BackoffOptions = {
      ...this.registry.defaults().backoff,
      rng: this.rng,
    };

    try {
      let attemptNumber = 0;
      for (const candidate of candidates) {
        for (let perModel = 0; perModel < maxAttempts; perModel++) {
          attemptNumber += 1;
          if (attemptNumber > maxAttempts * candidates.length) break;

          const key = modelKey(candidate);
          const provider = this.providers.get(candidate.provider);
          if (!provider) {
            attempts.push({
              modelKey: key,
              provider: candidate.provider,
              model: candidate.model,
              attemptNumber,
              bucketGranted: false,
              bucketWaitedMs: 0,
              status: 0,
              ok: false,
              durationMs: 0,
              retryAfterMs: null,
              errorPreview: "provider not initialized (likely auth missing)",
            });
            break; // skip remaining attempts on this model
          }

          // Wait for a token, capped by backoff schedule for this attempt.
          const bucketStart = this.now();
          let acquire = this.limiter.acquire(key, this.now());
          while (!acquire.granted) {
            await delay(Math.min(acquire.retryAfterMs, 250));
            acquire = this.limiter.acquire(key, this.now());
          }
          const bucketWaitedMs = this.now() - bucketStart;

          const req: ChatRequest = {
            model: candidate.model,
            messages: opts.messages,
          };
          if (opts.temperature !== undefined)
            req.temperature = opts.temperature;
          if (opts.max_tokens !== undefined) req.max_tokens = opts.max_tokens;
          const res = await provider.chatCompletion(req);

          const record: AttemptRecord = {
            modelKey: key,
            provider: candidate.provider,
            model: candidate.model,
            attemptNumber,
            bucketGranted: acquire.granted,
            bucketWaitedMs,
            status: res.status,
            ok: res.ok,
            durationMs: res.durationMs,
            retryAfterMs: res.retryAfterMs,
          };
          if (!res.ok) {
            record.errorPreview =
              typeof res.body === "object" && res.body !== null
                ? JSON.stringify(res.body).slice(0, 240)
                : (res.rawText ?? "").slice(0, 240);
          }
          attempts.push(record);

          if (res.ok) {
            return {
              ok: true,
              taskClass: opts.taskClass,
              attempts,
              selected: record,
              totalDurationMs: this.now() - t0,
              rejected: null,
            };
          }

          // 429 → log + penalize bucket, retry on this model with backoff.
          if (res.status === 429) {
            this.limiter.penalize(key, res.retryAfterMs ?? 1_000, this.now());
            logRateLimitEvent(
              {
                ts: new Date(this.now()).toISOString(),
                modelId: key,
                observedRetryAfterMs: res.retryAfterMs,
                status: res.status,
                endpoint: res.endpoint,
                detail: record.errorPreview ?? "",
              },
              this.rateLimitEventLogPath,
            );
            const sleepMs =
              res.retryAfterMs ?? nextDelayMs(perModel + 1, backoff);
            await delay(sleepMs);
            continue;
          }

          // Other retryable (5xx) → backoff, retry on same model.
          if (isRetryableStatus(res.status)) {
            const sleepMs = nextDelayMs(perModel + 1, backoff);
            await delay(sleepMs);
            continue;
          }

          // Non-retryable on this model → break to next candidate.
          break;
        }
      }

      return {
        ok: false,
        taskClass: opts.taskClass,
        attempts,
        selected: null,
        totalDurationMs: this.now() - t0,
        rejected: "all-attempts-failed",
      };
    } finally {
      sem.inFlight -= 1;
    }
  }
}

function modelKey(m: ClassModel): string {
  return `${m.provider}:${m.model}`;
}

function defaultProviderFactory(
  name: string,
  entry: ProviderEntry,
  apiKey: string | null,
  baseUrl: string | null,
): OpenAICompatibleProvider {
  if (name === "nvidia-nim") {
    // NIM provider knows its own defaults; re-resolve auth via env unless
    // baseUrl is overridden.
    return new NvidiaNIMProvider();
  }
  if (!baseUrl) {
    throw new Error(`provider ${name} has no baseUrl; cannot construct client`);
  }
  const config: ProviderConfig = { baseUrl };
  if (apiKey) config.apiKey = apiKey;
  return new OpenAICompatibleProvider(name, config);
}

// Type-only re-exports so callers don't have to import from multiple files.
export type {
  ChatMessage,
  ChatRequest,
  ChatResponse,
} from "./providers/openai-compatible.ts";
