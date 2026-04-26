# Inference Broker

The broker is the single entry point for every model call in frontier-os. It owns rate limiting, fallback, 429 handling, and per-task-class concurrency. Providers are pluggable; the OpenAI-compatible base client covers NIM, OpenRouter, LM Studio, Ollama, Together, and most local servers.

## Design

```
caller
  ↓
InferenceBroker.callClass({ taskClass, messages, ... })
  ↓
ModelRegistry.resolveClassModels(taskClass)         ← reads config/model-policy.json
  ↓ for each candidate model:
TokenBucketLimiter.acquire(modelKey)                ← per-model RPM cap
  ↓
OpenAICompatibleProvider.chatCompletion(req)         ← provider-specific subclass: NvidiaNIMProvider, ...
  ↓ status:
  200      → return AttemptRecord, broker resolves
  429      → log to state/inference/rate-limit-events.jsonl, penalize bucket, backoff with jitter, retry
  5xx      → backoff, retry on same model
  other    → fall through to next model in the class
  ↓
fallback exhausted → ok=false, rejected="all-attempts-failed"
```

The broker is **pure orchestration**. Provider-specific logic (auth, base URL, body shape) lives in `providers/`. Rate-limit math lives in `rate-limit.ts`. Backoff lives in `backoff.ts`.

## Files

| Path                                           | Purpose                                                                                                                                         |
| ---------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/inference/broker.ts`                      | `InferenceBroker.callClass(...)` — composes everything                                                                                          |
| `src/inference/model-registry.ts`              | reads `config/model-policy.json`, exposes `listEnabledProviders`, `resolveClassModels`, etc.                                                    |
| `src/inference/rate-limit.ts`                  | `TokenBucketLimiter` — per-model bucket; `logRateLimitEvent` writes JSONL to `state/inference/rate-limit-events.jsonl`                          |
| `src/inference/backoff.ts`                     | capped exponential delay with full jitter (`nextDelayMs`), `delay(ms, signal?)`, `isRetryableStatus`                                            |
| `src/inference/providers/openai-compatible.ts` | base class — `chatCompletion`, `listModels`, retry-after parsing, request timeout                                                               |
| `src/inference/providers/nvidia-nim.ts`        | NIM subclass — auth via `NVIDIA_API_KEY` (fallback `NIM_API_KEY`), base URL `https://integrate.api.nvidia.com/v1` (override via `NIM_BASE_URL`) |
| `config/model-policy.json`                     | task-class → model list, per-provider enable / RPM / max-parallel                                                                               |
| `state/inference/.gitignore`                   | runtime state never committed: `model-capacity.json`, `model-scores.json`, `rate-limit-events.jsonl`, `buckets.json`                            |

## Task classes

Calls are made by class, not by model. The class names used today (`config/model-policy.json`):

| Class                 | Intent                                                                                                                                  |
| --------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| `routine_summary`     | log compression, packet rendering — local first                                                                                         |
| `patch_builder`       | code patches; eventually multiple builders in parallel worktrees                                                                        |
| `adversarial_review`  | attack a candidate patch; diversity matters                                                                                             |
| `research_extraction` | source reading + claim ledgers                                                                                                          |
| `merge_arbiter`       | final ship/block; **empty by default** — broker returns a clear error rather than silently picking a model for the highest-stakes class |

## Adding a provider

1. **Subclass `OpenAICompatibleProvider`** if the wire format is OpenAI-compatible (most are). Override the constructor to set `name`, base URL default, and auth resolution. See `providers/nvidia-nim.ts`.
2. **Register in `config/model-policy.json`** under `providers`. Set `enabled: true` and either `baseUrl` (local) or `envKeyVar` (cloud auth). Add the provider's models to one or more `classes[].models` lists.
3. **Wire the constructor** in `broker.ts:defaultProviderFactory` (one switch case). Tests pass providers in via `providerFactory` so this only matters in production.
4. **Probe** with `frontier model probe <provider>`.

## Adding a task class

Edit `config/model-policy.json:classes`. Each entry needs `summary`, `models[]`, and `maxParallel`. Models are ordered by preference; the broker tries them in order and falls through on persistent failure.

## Rate limiting

Each `(provider, model)` pair gets its own token bucket with capacity `defaultRpm` (refill rate `defaultRpm / 60` tokens per second). On a 429 response, the broker:

1. Logs the event to `state/inference/rate-limit-events.jsonl` (one line per event: `{ ts, modelId, observedRetryAfterMs, status, endpoint, detail }`).
2. Penalizes the bucket — drains tokens to 0 and pushes the next refill out by either `Retry-After` (if the server sent one) or 1 second.
3. Backs off with capped exponential + full jitter, then retries on the same model.

If a model returns 429 repeatedly, the broker exhausts its per-model attempts and falls through to the next candidate. There is no retry storm protection beyond the jitter; if a class has 3 candidates × 3 attempts, that's at most 9 calls before rejection.

## Defaults

```json
{
  "rateLimitTargetFraction": 0.65,
  "backoff": { "baseMs": 500, "maxMs": 30000, "factor": 2 },
  "requestTimeoutMs": 30000
}
```

`rateLimitTargetFraction` is informational — when `frontier model probe` produces empirical capacity numbers, target ~65% of the observed safe RPM (so a measured 40 RPM ceiling becomes a 26 RPM bucket). The probe writes results to `state/inference/model-capacity.json`; bucket reconfiguration on broker start reads from there. Today buckets are seeded from `defaultRpm` only.

## CLI

```sh
frontier model list                                    # inventory
frontier model probe nvidia-nim                        # /v1/models against the provider
frontier model call --class patch_builder --prompt "…" # route through the broker
```

`probe` requires the provider to be effectively enabled (policy `enabled: true` AND env auth present, if a cloud provider). `call` returns a `BrokerCallResult` with the full attempt log.

## Out of scope (future PRs)

- **Builder worktrees (PR B)** — isolated git worktrees per builder, patch collection.
- **Merge arbiter (PR C)** — score patches by tests + evals + reviewer findings.
- **Streaming** — current `chatCompletion` is non-streaming.
- **Tool calls / structured output** — pass-through fields on `ChatRequest` work, but the broker doesn't model them.
- **LiteLLM proxy** — could replace the provider layer eventually; not now.
- **Empirical capacity scoring** — `state/inference/model-capacity.json` exists in `.gitignore` but no writer yet.

## Production-call posture

The broker is built but no production code path calls it yet. Factories, context-pack, eval suites, and the commit-msg guard all run without inference. PR B introduces the first production caller (builder spawn).
