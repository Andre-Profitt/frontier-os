# Lift Manifest — Remaining Adapters + Research Primitive

## Executive Summary

| Target       | Verdict                                                    | Winner                                                          |
| ------------ | ---------------------------------------------------------- | --------------------------------------------------------------- |
| Terminal     | BUILD over `execa`                                         | `execa` (sindresorhus)                                          |
| Sigma        | BUILD via OpenAPI codegen + CDP shim                       | OpenAPI spec + `openapi-typescript-codegen`                     |
| Azure        | WRAP narrow `@azure/arm-*` + `az` fallback                 | `@azure/arm-monitor`, `@azure/arm-resources`, `@azure/identity` |
| Databricks   | BUILD thin REST wrapper (types from Go SDK)                | hand-rolled                                                     |
| Kaggle       | BUILD — shell out to Python CLI (`kaggle-node` dead)       | Python `kaggle` via `execa`                                     |
| NVIDIA/GPU   | WRAP `@quik-fe/node-nvidia-smi`                            | same                                                            |
| **Research** | **WRAP Anthropic `web_search` + PORT orchestrator-worker** | Anthropic native + hand-rolled TS                               |

Net: 1 pure WRAP (NVIDIA), 1 WRAP-heavy (Azure), 5 BUILDs — all 5 stand on substantial OSS primitives we don't write from scratch.

## 1. Terminal — BUILD on `execa`

**Winner:** `execa` for inline subprocess; `pueue` as optional backend for long-running backgrounded commands.

**Reason:** `execa` gives safe argv pass-through (no shell interp by default), `timedOut` result, clean SIGTERM→SIGKILL. Shell-level safety isn't about finding a classifier library (none exists) — it's correctness + a hand-rolled allowlist. ~200 LOC for `commandSideEffects.ts`.

**Contract:**

```
adapterId: terminal
commands:
  run-command        modes: [propose, apply]   side-effect: by-policy
  read-file          modes: [read]
  list-dir           modes: [read]
  stop-process       modes: [apply, undo]
  queue-command      modes: [propose, apply]   side-effect: local_write   (pueue-backed)
```

## 2. Sigma — BUILD, OpenAPI-generated client

**Winner:** Typed fetch client via `openapi-typescript-codegen` against Sigma's OpenAPI spec + tiny CDP shim for unsaved-workbook state.

**Reason:** Sigma REST API v2 is rich + documented. No first-party JS SDK. Generate off spec = 1 hour. `@sigmacomputing/plugin` and `@sigmacomputing/node-embed-sdk` solve different problems (iframe embedding, not API calling).

**Contract:**

```
adapterId: sigma
commands:
  list-workbooks, inspect-workbook, refresh-workbook,
  list-members, set-workbook-filter, audit-workbook
```

API-first; CDP only when API can't express (live filters on unsaved workbook). Same "API-first, CDP for gap" as Salesforce.

## 3. Azure — WRAP narrow `@azure/arm-*` + `az` fallback

**Winner:** `@azure/identity` + `@azure/arm-monitor` + `@azure/arm-resources` + `@azure/arm-costmanagement`; shell `az` for niche.

**Reason:** Mgmt libs handle retries, logging, transport, AAD uniformly. **Don't install all 866 `@azure/*` packages** — only 3-5 needed. `az` stays for commands without ARM surface.

**Contract:**

```
adapterId: azure
commands:
  list-resources, list-alerts, inspect-resource,
  list-metrics, cost-summary, stop-resource, run-az
```

## 4. Databricks — BUILD thin REST wrapper

**Winner:** Hand-rolled wrapper for ~8 Jobs/Runs/Workspace endpoints; types ported from Go SDK. Supplement with `databricks` CLI via terminal adapter for long-tail.

**Reason:** No official JS/TS SDK. `yuhsak/databricks-api` is single-maintainer; auditing it is comparable work to writing 8 endpoints. Go SDK's OpenAPI pagination pattern public.

**Contract:**

```
adapterId: databricks
commands:
  list-jobs, job-status, run-job, cancel-run,
  list-clusters, notebook-export, workspace-tree
```

Workspace limits: 2000 concurrent task runs, 10k jobs/hr.

## 5. Kaggle — BUILD by shelling out to Python CLI

**Winner:** Shell out to `kaggle` Python CLI via terminal adapter.

**Reason:** `kaggle-node` is DEAD (0 stars, last release June 2024, only datasets). Python CLI is canonical. Creds already at `~/.kaggle/kaggle.json`.

**Flag:** adds Python runtime dep (~5 MB) despite TS stack.

**Contract:**

```
adapterId: kaggle
commands:
  list-kernels, kernel-status, push-kernel,
  download-dataset, list-competitions, submit-competition
```

## 6. NVIDIA/GPU — WRAP `@quik-fe/node-nvidia-smi`

**Winner:** `@quik-fe/node-nvidia-smi` for v0; migrate to koffi+NVML only if sub-second polling needed.

**Reason:** Polling cadence is seconds at most; `nvidia-smi -q -x` parse cost irrelevant. Avoids native-binding build complexity on Mac where NVML doesn't exist anyway.

**Contract:**

```
adapterId: nvidia
commands:
  list-gpus, gpu-status, gpu-processes, kill-gpu-process
```

`kill-gpu-process` delegates to terminal adapter for unified policy surface.

## 7. Research Primitive — WRAP Anthropic native + PORT orchestrator-worker

**The most important one.** Answer: **don't build a fresh literature-survey agent. Compose existing primitives.**

### The stack

1. **Orchestrator-worker runtime (hand-rolled TS, ~400-600 LOC):** lead Claude call with extended thinking, spawns N sub-researcher Claude calls in parallel, each with own context window, each writing to artifact store. Copy pattern from Anthropic's engineering post + LangChain's `open_deep_research` graph shape.
2. **Retrieval backbone:** Claude native `web_search_20260209` tool (first choice — citations included) + `web_fetch`. Fall back to `@mendable/firecrawl-js` for sites Claude's search misses or bulk crawl.
3. **Typed source adapters (as tools):** `arxiv-api` for arxiv, `OpenAlex-SDK` for cross-publisher + semantic search, `gh release list` via existing github adapter for watchlist.
4. **Paper extraction (optional):** shell `paper-qa` via terminal adapter when corpus of PDFs needs extraction — adds Python + ~500 MB. Only when needed.

**Reason (one sentence):** Anthropic already published both the agent architecture (multi-agent-research writeup) and the retrieval tool (`web_search`) — work is 400 LOC of orchestration, not framework adoption.

**Contract:**

```
adapterId: research
commands:
  run-survey             modes: [apply]    side-effect: billable_action  (Claude tokens + $/search)
  expand-citation        modes: [read]     side-effect: billable_action
  monitor-topic          modes: [read]     side-effect: none             (schedules watcher)
  fetch-paper            modes: [read]     side-effect: local_write      (caches PDF)
  brief                  modes: [read]     side-effect: billable_action  (synth → report)

sub-tools internally:
  web_search (Claude native), web_fetch (Claude native),
  arxiv.search, openalex.works, github.list_releases,
  firecrawl.scrape, paperqa.ask
```

**Side-effect = `billable_action`.** Anthropic's post cites 15× chat baseline token cost. Hard cap: `maxTokens`, `maxSearches`, `maxRuntimeSeconds`.

**MCP bridge note:** `web_search` via normal `tools` parameter in Messages API — no MCP needed. Call from adapter directly. Managed Agents beta (`managed-agents-2026-04-01`) is separate if harness wanted rather than build-own-loop; for Frontier OS's "own the orchestrator" stance, stick to raw Messages API.

## Integration dependency order

1. **Terminal first.** Everything CLI-fallback (`gh`, `az`, `databricks`, `kaggle`, `nvidia-smi`, `pqa`) needs the terminal adapter first. Without it, re-implement argv/timeout/side-effect classification 5 times.
2. **NVIDIA** (cheap win; exercises terminal end-to-end).
3. **Kaggle** (shells out; proves wrap-external-CLI-with-creds pattern).
4. **Azure** (WRAP; mostly SDK with minor `az` fallbacks).
5. **Databricks** (BUILD REST; shares fetch-client with Sigma).
6. **Sigma** (BUILD with OpenAPI codegen; reuses Databricks patterns + Salesforce CDP shim).
7. **Research last.** Depends on: Terminal (shell `pqa`), GitHub (release-watching), stable Claude-tool harness. Building first = rewriting orchestration when lower adapters land.

Parallelizable: Kaggle + NVIDIA after Terminal. Databricks + Sigma after either one ships.

## Prior Art for "Overnight Literature Survey"

Single best writeup: **Anthropic's "How we built our multi-agent research system"** (anthropic.com/engineering/multi-agent-research-system). Specifically about overnight long-horizon research: orchestrator decomposes brief, spawns N parallel sub-researchers, artifacts on filesystem for high fidelity, compression step before synthesis. Names the 15× token tradeoff. Exactly the Monday-brief use case.

Companion sources:

- LangChain `open_deep_research` (langchain.com/blog/open-deep-research) — open reference w/ Deep Research Bench scores.
- Anthropic "Building Effective Agents" — 5 workflow patterns (prompt chaining, routing, parallelization, orchestrator-workers, evaluator-optimizer). Research adapter = orchestrator-workers + evaluator-optimizer composed.
- FutureHouse PaperQA2 (arxiv 2312.07559) — RCS (re-ranking + contextual summarization) for scientific-paper RAG.

No one has published "personal OS overnight research agent" end-to-end — composition job, not wholesale adoption.

## Sources / verified files

- `/Users/test/frontier-os/docs/system-map.md` — adapter priorities
- `/Users/test/frontier-os/contracts/adapter-contract.md` — lifecycle, side-effects
- `/Users/test/frontier-os/schemas/adapter-invocation.schema.json` — invocation shape
- `/Users/test/frontier-os/src/adapters/github/index.ts` — reference for `spawn`-based CLI wrapping
- `/Users/test/frontier-os/src/adapters/runpod/index.ts` — reference for HTTP-API adapters

External:

- https://github.com/sindresorhus/execa
- https://github.com/microsoft/node-pty
- https://github.com/Nukesor/pueue
- https://help.sigmacomputing.com/reference/get-started-sigma-api
- https://github.com/ferdikoomen/openapi-typescript-codegen
- https://azure.github.io/azure-sdk/releases/latest/js.html
- https://learn.microsoft.com/en-us/azure/developer/javascript/sdk/use-azure-sdk
- https://github.com/databricks/databricks-sql-nodejs
- https://docs.databricks.com/aws/en/dev-tools/sdks
- https://github.com/anorderh/kaggle-node (DEAD — skip)
- https://www.npmjs.com/package/@quik-fe/node-nvidia-smi
- https://github.com/NVIDIA/go-nvml
- https://docs.nvidia.com/datacenter/dcgm/latest/gpu-telemetry/dcgm-exporter.html
- https://claude.com/blog/web-search-api
- https://www.anthropic.com/engineering/multi-agent-research-system
- https://www.anthropic.com/research/building-effective-agents
- https://github.com/langchain-ai/open_deep_research
- https://github.com/firecrawl/open-researcher
- https://www.npmjs.com/package/@mendable/firecrawl-js
- https://github.com/Future-House/paper-qa
- https://arxiv.org/abs/2312.07559
- https://www.npmjs.com/package/arxiv-api
- https://github.com/OpenDevEd/OpenAlex-SDK
- https://github.com/langchain-ai/local-deep-researcher
