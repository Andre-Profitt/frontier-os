# Lift Manifest — Observability + Trace-to-eval

## Topic C — Observability (OpenTelemetry export)

### Worth lifting (ranked)

1. **OpenInference span conventions, NOT OTel GenAI.** OpenInference covers `tool.*`, `agent.name`, `graph.node.*`, `retrieval.documents`, `session.id`, cost, cache tokens. OTel GenAI is still **Development** stability (April 2026) — nothing Stable. Emit OTel GenAI _only_ for LLM call basics (model/tokens) where Langfuse ingest maps both. https://opentelemetry.io/blog/2025/stability-proposal-announcement/
2. **`openinference-instrumentation` base package** — plain Python context managers (`using_session`, `using_user`, `using_metadata`, `TraceConfig`). No auto-instrumentation. Apache-2.0. https://github.com/Arize-ai/openinference/tree/main/python/openinference-instrumentation
3. **OTLP/HTTP JSON as wire format** — Langfuse: `/api/public/otel/v1/traces` with Basic auth. Phoenix: `arize-phoenix-otel`. Grafana Tempo/Jaeger/Datadog all OTLP. One exporter, many backends.

### Assets

| Asset                                                | Primitive                                                                                   | License                    | Caveat                                                                                |
| ---------------------------------------------------- | ------------------------------------------------------------------------------------------- | -------------------------- | ------------------------------------------------------------------------------------- |
| OpenInference `semantic_conventions.md`              | Attribute keys (`openinference.span.kind`, `session.id`, `llm.*`, `tool.*`, `graph.node.*`) | Apache-2.0                 | Indexed-message convention verbose — flatten on write                                 |
| OTel GenAI `registry.yaml`                           | `gen_ai.request.model`, `gen_ai.usage.*`                                                    | Apache-2.0                 | **Development** stability; names WILL churn; gate via `OTEL_SEMCONV_STABILITY_OPT_IN` |
| `@opentelemetry/sdk-node` + OTLP-HTTP exporter       | TS exporter with batching/retry                                                             | Apache-2.0                 | TS-native; don't pull Python                                                          |
| `openinference-instrumentation` Python `TraceConfig` | Config struct (hide_input_value, image size caps)                                           | Apache-2.0                 | No TS equivalent; port 40 LOC                                                         |
| `arize-phoenix-otel`                                 | Env names (`PHOENIX_COLLECTOR_ENDPOINT`)                                                    | **ELv2**                   | ELv2 non-OSI — point at, don't vendor                                                 |
| Langfuse core                                        | Endpoint `/api/public/otel/v1/traces`, `x-langfuse-ingestion-version: 4`                    | MIT **w/ `ee/` carve-out** | Core fine; self-host needs **Postgres + ClickHouse**                                  |
| OpenLLMetry                                          | Reference OTel GenAI shape                                                                  | Apache-2.0                 | Auto-instruments LLM libs — reference only                                            |

### Verdict: **WRAP**

Thin `src/telemetry/otel-exporter.ts` reads ledger events, emits OTLP/HTTP batches. No trace SDK needed — we control `traceId` generation already.

### Integration plan

New module `src/telemetry/`. New CLI `frontier telemetry export [--since ISO] [--endpoint URL]`. New watcher `src/watchers/telemetry-tail.ts` for continuous tail.

**Ledger → OTel mapping:**

| Ledger                                     | OTel / OpenInference                                                                 |
| ------------------------------------------ | ------------------------------------------------------------------------------------ |
| `traceId`                                  | OTLP `trace_id` (pad 16→32 hex)                                                      |
| `sessionId`                                | `session.id`                                                                         |
| `eventId`                                  | `span_id` (pad to 16 hex)                                                            |
| `ts`                                       | `start_time_unix_nano`                                                               |
| `kind`=`invocation.*`                      | `openinference.span.kind="TOOL"`; `tool.name`, `tool.parameters`                     |
| `kind`=`agent.{pre,post}_tool_use`         | `openinference.span.kind="TOOL"`; `input.value`/`output.value`                       |
| `kind`=`work.node_{start,end}`             | `openinference.span.kind="CHAIN"`; `graph.node.id`, `graph.node.parent_id`           |
| `kind`=`work.verifier_*`                   | `openinference.span.kind="EVALUATOR"`; `eval.name`, `eval.score`, `eval.explanation` |
| `kind`=`work.{awaiting_approval,approved}` | status + `metadata.approval_class`                                                   |
| `kind`=`audit.grade`+`finding`             | parent+child spans; `metadata.grade`                                                 |
| `actor` (claude/codex)                     | `user.id` or `metadata.agent`                                                        |
| Anthropic token counts                     | `gen_ai.usage.{input,output,cache_read.input}_tokens`                                |

**Default collector:** local Phoenix (`docker run -p 6006:6006 arizephoenix/phoenix`) for dev. Langfuse or Grafana Tempo for longer retention.

### Gotchas

- `gen_ai.*` WILL rename — wrap in one helper.
- `input.value`/`output.value` leak PII — port OpenInference `TraceConfig.hide_input_value` as env toggle.
- 16 vs 32 hex — OTLP requires 32-char trace IDs. Our `newEventId()` isn't hex. Add `traceIdHex` column (schema_version bump) or SHA-256 hash.
- Langfuse HTTP-only to OTLP — good, fewer deps.
- Batch: 5s / 512 spans via `@opentelemetry/sdk-trace-base`.
- Phoenix ELv2 — point at, don't vendor.

## Topic D — Trace-to-eval automation

### The loop

```
agent.review(verdict=reject) OR work.verifier_fail
  → Refinery harvester groups into signatures (already works)
  → NEW: promote example event → dataset row {input, expected, metadata}
  → Next run: pre-flight replays dataset
  → Regression → block merge / block Ghost Shift class ≤ 1
```

### Framework comparison

| Framework      | Trace→dataset row                                                                        | Regression runner       | Self-host                                 | License                          |
| -------------- | ---------------------------------------------------------------------------------------- | ----------------------- | ----------------------------------------- | -------------------------------- |
| **Langfuse**   | `create_dataset_item(source_trace_id=, source_observation_id=)` + JSON-schema validation | Yes                     | Yes — MIT core, needs Postgres+ClickHouse | MIT w/ `ee/` carve-out           |
| **Braintrust** | BTQL SELECT + `POST /v1/dataset/{id}/insert` with `origin:{object_id,id}`                | Yes (Python/TS/Go SDKs) | Yes — Helm chart                          | Apache-2.0 SDKs                  |
| **Phoenix**    | `datasets.create_dataset(dataframe=)` or UI                                              | Yes (experiments)       | Yes                                       | **ELv2**                         |
| **LangSmith**  | `list_runs()`→`create_examples(dataset_id=, examples=[…])`                               | Yes                     | **No self-host**                          | Paid SaaS                        |
| OpenAI Evals   | JSON+YAML                                                                                | Yes (CLI)               | Yes                                       | MIT **frozen** (no external PRs) |

**Recommendation:** Langfuse. Rationale: MIT core, explicit `source_trace_id`/`source_observation_id` = our `traceId`/`eventId`, same backend as OTLP ingest (Topic C), JSON-schema-validated rows. Braintrust strong #2 if ClickHouse non-starter (Apache-2.0 TS SDK, clean `origin.object_id` mapping).

### Lift targets

**Dataset row schema — Langfuse verbatim:**

```ts
{
  datasetName: string,
  id?: string,  // upsert key: frontierRuleId + eventId
  input: unknown,  // payload.tool_args | payload.input
  expectedOutput?: unknown,  // reviewer correction or null
  metadata: {
    frontierSignature: string,
    frontierRuleId: string,
    frontierSourceKind: string,  // "work.verifier_fail", etc.
    frontierVerdict: "reject" | "fail" | "skip",
    frontierGradedBy: "verifier" | "reviewer" | "ghost",
  },
  sourceTraceId: string,
  sourceObservationId?: string,
  status?: "ARCHIVED"
}
```

**Sampling policy (STaR 2203.14465 + SRLM 2401.10020):**

- `agent.review(verdict=reject)` → negative example
- `work.verifier_fail` count ≥ minFrequency → negative tagged with signature
- `work.verifier_pass` on sibling of failure → positive (STaR rationalization-fallback)
- Dedup by signature, cap 10/signature

**Promotion:** reuse `proposeRules.minFrequency` (default 2). Add `minReviewers` for agent.review path.

### Verdict: **WRAP**

Langfuse `create_dataset_item(source_trace_id=…)` is exactly what we'd build. One network call per Refinery signal; their eval harness runs regressions.

### Integration plan

**New:** `src/refinery/eval-exporter.ts` reads `~/.frontier/refinery/proposals.jsonl`, walks `evidence.exampleEventIds`, fetches events, constructs Langfuse items, POSTs.

**Schema:** add `refinery.eval_exported` kind + idempotency file `~/.frontier/refinery/eval-exports.jsonl` keyed `(frontierRuleId, eventId)`.

**Regression hook:** `frontier eval run --dataset <name>` — hits Langfuse, replays each `input` through current tool/adapter, records Langfuse run, fails if regression. Wire into `.git/hooks/pre-push` or CI. Fifth CLI family.

**Promote-to-rule path stays local** — `refinery/registry.ts#promoteProposal` unchanged. Eval export is additive evidence layer.

### Gotchas

- Langfuse self-host = Postgres + ClickHouse. Non-trivial. Cloud free tier for datasets + local traces is a way.
- `ee/` boundary: SSO + some RBAC proprietary. Datasets+evals+OTLP all MIT core.
- `input`/`expectedOutput` schema validation opt-in — turn on at dataset create.
- STaR-style rejection sampling biases toward known patterns — pair with small random holdout (RAFT-style).
- LangSmith SaaS-only — don't plan around as fallback.
- Braintrust rename 2025→2026: `braintrust-sdk` → `braintrust-sdk-javascript`.
- Agent-as-a-Judge (2410.10934) good for verifier design but doesn't ship dataset-construction pipeline — cite, don't lift.
- OpenAI Evals effectively frozen — use JSON shape as reference only.

## Execution order

1. Port OpenInference attribute constants → `src/telemetry/attributes.ts` (~80 LOC)
2. OTLP/HTTP exporter via `@opentelemetry/exporter-trace-otlp-http` → `frontier telemetry export`. Phoenix first, Langfuse when ClickHouse OK.
3. `traceIdHex` in ledger (schema v2) for round-trip.
4. Eval exporter: refinery proposals → `create_dataset_item`. Idempotent.
5. `frontier eval run` regression harness.

All additive. Nothing existing rewritten.

### Files affected

- `src/ledger/events.ts` — `refinery.eval_exported` kind
- `src/ledger/index.ts` — schema bump for `traceIdHex`
- `src/refinery/harvester.ts` — signal source
- `src/refinery/registry.ts` — new `loadExampleEventsForProposal()` helper
- `src/refinery/rules.ts` — reuse `minFrequency` unchanged
- New: `src/telemetry/{attributes.ts, otel-exporter.ts}`
- New: `src/refinery/eval-exporter.ts`
- New: `src/eval/{runner.ts, cli.ts}`

## Sources

- https://github.com/Arize-ai/openinference/blob/main/spec/semantic_conventions.md
- https://github.com/Arize-ai/openinference/tree/main/python/openinference-instrumentation
- https://github.com/open-telemetry/semantic-conventions/blob/main/docs/gen-ai/gen-ai-spans.md
- https://opentelemetry.io/docs/specs/semconv/gen-ai/
- https://opentelemetry.io/blog/2025/stability-proposal-announcement/
- https://github.com/Arize-ai/phoenix
- https://langfuse.com/docs/opentelemetry/get-started
- https://langfuse.com/docs/datasets/overview
- https://github.com/langfuse/langfuse/blob/main/LICENSE
- https://github.com/traceloop/openllmetry
- https://github.com/braintrustdata/braintrust-sdk
- https://www.braintrust.dev/docs/guides/datasets
- https://github.com/braintrustdata/helm
- https://docs.langchain.com/langsmith/manage-datasets-programmatically
- https://github.com/wandb/weave
- https://github.com/openai/evals
- https://arxiv.org/abs/2203.14465
- https://arxiv.org/abs/2401.10020
- https://arxiv.org/abs/2410.10934
