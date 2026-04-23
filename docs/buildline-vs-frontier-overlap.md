# Buildline vs Frontier OS — overlap map and consolidation vectors

Date: 2026-04-19
Audience: both tracks (frontier-os TS orchestrator + companion-platform
`runtime/buildline_*` codegen stack)
Scope: read-only scan of the sibling Codex agent's 20 new commits on the
`ai-os` main branch, checked against frontier-os primitives.

This is a MAP, not a plan. It names where the two tracks solve the same
problem with independent implementations, and proposes contract-level
alignments that would let them cross-apply instead of reinventing.

## What the sibling Codex agent built (20+ new modules)

All under `runtime/buildline_*` in companion-platform. An end-to-end
autonomous code-generation stack:

| Module                                                        | Role                                                                           |
| ------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| `agent_orchestrator` / `codex_orchestrator`                   | End-to-end orchestrator — task in, graded code out                             |
| `real_executor` / `codex_executor` / `codex_client`           | CLI execution layer wrapping `claude -p` and `codex`                           |
| `real_grader`                                                 | Multi-dimension grading: pytest + ruff + file-existence + docstring + coverage |
| `regression_gate`                                             | Captures test pass-counts pre/post, flags regressions                          |
| `refinement_loop`                                             | Iterative retry-on-failure loop (replaces single-shot overnight director)      |
| `agent_verifier`                                              | Post-execution verification: existence, lint, anti-pattern detection           |
| `agent_feedback` + `auto_learner` + `agent_knowledge`         | Feedback → failure grouping → knowledge-base entries                           |
| `pattern_library`                                             | Code patterns injected into agent prompts                                      |
| `agent_templates` / `agent_prompts`                           | Per-task prompt templates                                                      |
| `agent_metrics` / `agent_notifier`                            | Observability                                                                  |
| `code_reviewer` / `import_validator` / `codebase_index`       | Static analysis on generated code                                              |
| `task_queue`                                                  | SQLite-backed task queue (replaces director's single-shot)                     |
| `event_bus`                                                   | In-memory pub/sub with optional SQLite persist                                 |
| `morning_bundle`                                              | Overnight-run summaries (structured + markdown + HTML)                         |
| `multi_repo_router`                                           | Task → repo dispatch via keyword analysis                                      |
| `portfolio_dashboard`                                         | Web dashboard                                                                  |
| `notification_batcher/digest/preferences/templates`           | Notification lifecycle                                                         |
| `github_attention` / `scanner_attention` / `webhook_receiver` | External integrations                                                          |
| `slice_decomposer`                                            | Task decomposition                                                             |
| `structured_logging`                                          | Logging schema                                                                 |

## Frontier OS primitives (TS, for comparison)

| Location                                                                                                            | Role                                                                      |
| ------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| `src/work/executor.ts`                                                                                              | Kahn topological work-graph executor                                      |
| `src/ghost/shift.ts` + `src/ghost/safety.ts`                                                                        | Overnight queue runner + 4-layer safety gate                              |
| `src/watchers/` (overnight-review, nightly-sf-portfolio, work-radar, runpod-idle-killer)                            | Periodic watchers emitting alerts                                         |
| `src/refinery/` (harvester, proposer, registry, auto-promote)                                                       | Failure harvest → rule proposal → eval → auto-promote (sticky revocation) |
| `src/eval/`                                                                                                         | Eval harness with regression detection                                    |
| `src/adapters/` (github, databricks, sigma, kaggle, salesforce, azure, runpod, browser, research, nvidia, terminal) | Typed adapter registry with 4-mode invocation (read/propose/apply/undo)   |
| `~/.frontier/ledger.db` (SQLite WAL)                                                                                | Single-writer append-only event log                                       |

## Overlap map (6 axes)

### 1. Iterative refine-grade-retry loop

- **Frontier OS**: `src/refinery/` (harvester → proposer → eval → auto-promote, sticky revocation)
- **Buildline**: `refinement_loop` + `real_grader` + `regression_gate` + `agent_feedback` + `auto_learner` + `agent_knowledge`
- **Both** do: attempt → grade → feedback → retry → persist what worked.
- **Different**: refinery targets RULES promoted into the adapter pipeline;
  buildline targets agent KNOWLEDGE reinjected into prompts.
- **Contract alignment candidate**: **shared severity vocabulary**
  (`blocking|wrong-data|warning|orphan|info`). Today refinery findings use
  it, buildline grader does not. If real_grader emitted findings in this
  shape, they would render uniformly in morning brief + menubar.

### 2. Overnight autonomy

- **Frontier OS**: Ghost Shift queue + class-based safety gate (class ≤ 1 only, dangerous-side-effect refusal) + work-graph executor
- **Buildline**: overnight director + refinement loop + regression gate + task queue
- **Both** do: run stuff overnight, safely.
- **Different**: Ghost Shift is adapter-agnostic + hard class gate;
  buildline is codegen-specific + grader-driven.
- **Contract alignment candidate**: **task_queue → Ghost Shift mirror**. If
  buildline tasks that pass regression gate + are class ≤ 1 queued into
  `~/.frontier/ghost-shift/queue/`, the existing Ghost Shift runner would
  pick them up and apply the same safety rules. Today these queues do
  not talk.

### 3. Adapter / tool execution

- **Frontier OS**: `src/adapters/` with AdapterInvocation → AdapterResult
  contract, 4 modes, manifest-declared side-effect classes.
- **Buildline**: `real_executor` wrapping `claude -p` / `codex`; no
  AdapterResult emission.
- **Contract alignment candidate**: **buildline CLI runs emit
  AdapterResult**. If each `claude -p` or `codex` invocation appended an
  adapter-shaped ledger event to `~/.frontier/ledger.db`, every buildline
  task would automatically appear in `/v1/siri/runs` (the merged
  runs endpoint already handles this shape for frontier invocations).
  Zero API changes needed on the Siri side.

### 4. Event log / observability

- **Frontier OS**: `~/.frontier/ledger.db`, single-writer, append-only,
  WAL-journaled, read by companion-platform + jarvis-menubar.
- **Buildline**: `event_bus` (pub/sub, optional SQLite persist) +
  `structured_logging`.
- **Contract alignment candidate**: **event_bus persists to frontier
  ledger** (with a `buildline.*` kind prefix). Lets watchers see buildline
  lifecycle events, lets buildline subscribe to watcher events, without a
  custom bridge.

### 5. Task queue / routing

- **Frontier OS**: work-graph JSON + Ghost Shift queue dir (filesystem
  semantics, class-gated).
- **Buildline**: `task_queue` (SQLite, worker-claimed) +
  `multi_repo_router` (keyword → repo dispatch).
- **Different semantics**: Ghost Shift is batch-overnight; buildline is
  always-on worker pool. Probably leave separate.
- **Contract alignment candidate**: **expose buildline queue state in the
  Siri Gateway** — `/v1/buildline/queue` alongside `/v1/frontier/*`.

### 6. Morning brief / notifications

- **Frontier OS**: `overnight-review` watcher summary +
  `nightly-sf-portfolio` snapshot + `watcher.result` events.
- **Buildline**: `morning_bundle` + `notification_batcher/digest/preferences`.
- **Already aligned** (this session): `/v1/siri/morning-brief` now weaves
  frontier overnight state into the spoken output via `frontier_ledger.py`.
  Buildline's `morning_bundle` could reciprocally pull watcher summaries
  into its markdown output — single source.

## Recommended next steps

In order of ROI:

1. **Severity vocabulary unification** (half-day).
   Update buildline `real_grader` to emit findings in the same
   `blocking|wrong-data|warning|orphan|info` schema the refinery rules use.
   Immediate win: uniform rendering in morning-brief + menubar; later wins:
   cross-track rule promotion.

2. **Buildline → frontier ledger event mirror** (~1 day).
   Add a ledger-writer wrapper in `event_bus` that appends buildline
   events as `buildline.<verb>` events to `~/.frontier/ledger.db`. Once
   landed, `/v1/siri/runs` shows buildline tasks automatically, jarvis-
   menubar sees them, watchers can alert on them.

3. **AdapterResult shape for buildline CLI executions** (~1 day).
   Wrap `real_executor` output in an AdapterResult-compatible envelope.
   One-way interop: frontier side sees buildline as just another adapter.

4. **Shared task queue sink** (separate phase).
   Graduate buildline-completed class-0 tasks into `~/.frontier/ghost-
shift/queue/` as a class-0 work-graph. Ghost Shift picks them up
   overnight, re-validates against its safety gate, applies idempotently.

## Leave separate

These do not benefit from consolidation:

- Notification stack (batcher/digest/preferences/templates): buildline-specific, no frontier-os equivalent
- Swift Apple companion apps: separate surface
- Pattern library / code review / import validator: codegen-specific
- Slice decomposer: codegen-specific
- portfolio_dashboard web: distinct from the Siri-voice surface
- agent_templates / agent_prompts: codegen-specific

## Non-goals

- Do NOT merge the codebases. Two tracks, two execution models, one shared
  ledger contract.
- Do NOT rename buildline modules to `frontier_*`. The module names are
  load-bearing in 60+ files.
- Do NOT fork or duplicate — every shared contract should live in one
  place (preferably frontier-os's schemas).
