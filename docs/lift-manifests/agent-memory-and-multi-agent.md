# Lift Manifest — Memory Classes + Worktree Swarm

Scope: vision §8.5 memory separation, §13.2 multi-agent Worktree Swarm. Sources verified April 2026.

## Topic A — Typed Memory Class Separation

### Worth lifting

1. **Letta's `Block` schema + Core/Archival/Recall tri-partition** — battle-tested split mapping onto our run/operational/procedural/evaluative classes. Block schema = 5 fields (`label`, `description`, `value`, `limit`, `metadata`). https://github.com/letta-ai/letta/blob/main/letta/schemas/block.py
2. **LangGraph `BaseStore` namespace/key/value API** — `namespace: tuple[str,...]`, `key: str`, `value: dict`. Four methods: `put`, `get`, `search`, `batch`. Maps to `("run",…)`, `("operational",…)`, etc. https://github.com/langchain-ai/langgraph/blob/main/libs/checkpoint/langgraph/store/base/__init__.py
3. **Anthropic memory tool's six-verb protocol** (`view/create/str_replace/insert/delete/rename`, scoped to `/memories`) — Claude-native write access, no embeddings, ~80 LOC on pathlib. Tool type `memory_20250818`. https://platform.claude.com/docs/en/agents-and-tools/tool-use/memory-tool

### Assets

| Asset                              | Lift                                                      | License    | Caveat                                                             |
| ---------------------------------- | --------------------------------------------------------- | ---------- | ------------------------------------------------------------------ |
| `letta/schemas/block.py`           | Block dataclass (5 fields)                                | Apache-2.0 | Don't lift the ORM; port fields into existing SQLite               |
| `letta/schemas/memory.py`          | Three-tier taxonomy (core/archival/recall)                | Apache-2.0 | Copy shape; ignore pgvector hook                                   |
| `langgraph/store/base/__init__.py` | BaseStore 4-method surface                                | MIT        | **Reference only** — implement against SQLite+sqlite-vec. ~250 LOC |
| `langgraph/checkpoint/sqlite`      | checkpoints/writes table shapes                           | MIT        | Use as "run" memory class schema                                   |
| Anthropic memory tool              | 6-verb protocol + `/memories/{category}/{name}.md` layout | Beta       | Beta header required for `memory_20250818`                         |
| Mem0 (Apr 2026)                    | **ADD-only, no UPDATE/DELETE** algorithm                  | Apache-2.0 | Algorithmic idea; not the SDK                                      |
| A-Mem paper (arxiv 2502.12110)     | Zettelkasten link-on-write + memory-evolution step        | Paper      | 1 LLM call per write — budget-gate to Ghost Shift only             |
| Zep / Graphiti                     | Bi-temporal edges (`valid_at`, `invalid_at`)              | Apache-2.0 | Overkill unless fact-supersession needed                           |

### Verdict: **PORT interfaces, BUILD on own SQLite**

No new runtime dependencies beyond `sqlite-vec` + Anthropic SDK `BetaAbstractMemoryTool`.

### Integration plan

1. Add `memory_class` enum + `memory_blocks` table (Letta field names) in SQLite.
2. Implement `src/memory/store.ts` with BaseStore surface (`put/get/search/batch`). Back with SQLite; `archival_vec` virtual table via `sqlite-vec` for `evaluative` only; FTS5 for the rest.
3. Expose Anthropic 6-verb memory tool as in-process MCP tool in Claude Code bridge. Path `/memories/{class}/{label}.md` ↔ `memory_blocks(memory_class=class, label=label)`. Use `BetaAbstractMemoryTool` base class.
4. Ghost Shift writes procedural + evaluative only; Claude sessions write run/operational live.
5. Per-class TTL: run=7d, operational=session-scoped, procedural=∞ human-approved, evaluative=∞ append-only (Mem0 rule).

### Gotchas

- Letta `limit` is character-count, not tokens. Name misleading.
- LangGraph `Store` vs. `Checkpointer` — separate APIs; keep namespaces disjoint.
- Anthropic memory tool requires directory-traversal protection (validate `pathlib.Path.resolve()` + `relative_to('/memories')`).
- A-Mem's evolution step conflicts with Mem0's ADD-only rule. Pick per class: evaluative = ADD-only, procedural = mutable with audit log.
- Mem0 OSS package != Mem0 hosted algorithm.

## Topic B — Multi-Agent Worktree Swarm

### Worth lifting

1. **Magentic-One's Task Ledger + Progress Ledger dual-loop** — outer Task Ledger (facts/guesses/plan), inner Progress Ledger (`is_request_satisfied`, `is_in_loop`, `is_progress_being_made`, `next_speaker`, `instruction_or_question`). Stall detection via `max_round_count / max_stall_count / max_reset_count`. arxiv 2411.04468. Code: `autogen-ext` `StandardMagenticManager`.
2. **LangGraph Swarm handoff-tool Command pattern** — agents hand off via tool calls returning `Command(goto=agent_name, graph=Command.PARENT, update={...})`. SwarmState tracks `active_agent`. ~60 LOC. https://github.com/langchain-ai/langgraph-swarm-py/blob/main/langgraph_swarm/handoff.py
3. **OpenAI Agents SDK `Handoff` + Runner schema** — `{name, instructions, tools, handoffs, guardrails}` + `Runner.run_sync(agent, prompt, config)`. Use as schema shape even if not vendoring runtime. https://github.com/openai/openai-agents-python

### Assets

| Asset                                  | Lift                                                      | License | Caveat                                                        |
| -------------------------------------- | --------------------------------------------------------- | ------- | ------------------------------------------------------------- |
| `autogen-ext/magentic_one/_prompts.py` | 3 prompt templates + Progress Ledger JSON schema          | MIT     | Prompts prescriptive; tune domain, keep JSON schema exact     |
| Magentic-One control knobs             | `max_round_count/stall_count/reset_count`                 | MIT     | SLA-shaped — required for Ghost Shift                         |
| `langgraph-swarm-py/handoff.py`        | `create_handoff_tool` returning Command                   | MIT     | 60 LOC real code                                              |
| OpenAI Agents SDK types                | Agent/Handoff/Runner schema                               | MIT     | Runtime opinionated (Responses API) — lift schema not runtime |
| AutoGen SelectorGroupChat              | `selector_func` contract                                  | MIT     | Not serializable — wrap or keep deterministic                 |
| CrewAI `Process.hierarchical`          | role/goal/task triple                                     | MIT     | Lift triple only; skip the auto-manager magic                 |
| Agent-as-a-Judge (arxiv 2410.10934)    | Judge calls tools before ruling + DevAI 365-req benchmark | Paper   | Upgrade path for existing verifier                            |
| Claude Agent SDK                       | `HookMatcher`, `create_sdk_mcp_server`, session forking   | MIT     | Session forking v0.1.0+; check CHANGELOG                      |

### Verdict: **PORT Magentic-One's ledger prompts + loop, BUILD on existing work-graph executor**

### Integration plan

1. Add `src/orchestrator/ledger.ts`: `TaskLedger` + `ProgressLedger` typed records. Copy JSON schemas from `_prompts.py`.
2. Add `Orchestrator` node kind to work-graph executor: (a) TaskLedger once, (b) per-step ProgressLedger via structured output, (c) dispatch to `next_speaker`, (d) replan when stall_count exceeded. Existing verifier = `is_request_satisfied` evaluator (Agent-as-Judge upgrade).
3. Typed agent roles matching Agents SDK shape: `planner`, `reader[0..n]`, `writer`, `verifier`. Pre-register with scoped tool allowlists.
4. Readers via Claude Agent SDK session forking — one fork per reader, scoped `ClaudeAgentOptions(allowed_tools, cwd)`. Collect `ResultMessage`, feed back to ledger.
5. `handoff_to(agent_name)` MCP tool returning `{goto, update}`; emits typed `Handoff` event to ledger. Add `active_agent` to worktree-swarm state.
6. Bound everything: `max_round_count=30, max_stall_count=3, max_reset_count=2` as Ghost Shift defaults.

### Gotchas

- **AutoGen in maintenance mode**; AG2 is community fork (Apache-2.0 from v0.3). Don't adopt AutoGen as dep; lift templates only.
- **OpenAI Swarm deprecated** → Agents SDK.
- **LangGraph Swarm `active_agent` requires checkpointer** — or emit `agent_became_active` to our ledger.
- **Magentic-One LLM-generates `next_speaker` each step** — cache-friendly but adds latency; consider deterministic fast-path for linear plans.
- **ComputerTerminal/WebSurfer agents** in Magentic-One can install packages and browse web. Inherits real safety risk — gate writer + terminal roles behind explicit approval.
- **DevAI benchmark** hierarchical requirement schema — adopt for verifier contracts rather than inventing.

## Priority ranking

**Memory (A) — 1-2 weeks total:**

1. Port Letta Block schema into SQLite (1-2d)
2. BaseStore interface over SQLite+FTS5 (2-3d)
3. Anthropic memory tool wiring (1d)
4. Later: `sqlite-vec` for evaluative semantic search (1d)

**Multi-agent (B) — 2-3 weeks:**

1. Port Magentic-One ledger prompts + JSON schema (1d)
2. Orchestrator node in executor with ledger loop (3-5d)
3. Typed agent roles + reader fan-out via session forking (3d)
4. `handoff_to` tool + `active_agent` state (1d)
5. DevAI-style requirement schema for verifier (2d, optional)

Zero new runtime deps beyond `sqlite-vec` + `BetaAbstractMemoryTool`.

## Sources

**Memory:**

- https://github.com/letta-ai/letta/blob/main/letta/schemas/block.py
- https://github.com/letta-ai/letta/blob/main/letta/schemas/memory.py
- https://github.com/langchain-ai/langgraph/blob/main/libs/checkpoint/langgraph/store/base/__init__.py
- https://github.com/langchain-ai/langgraph/blob/main/libs/checkpoint-sqlite/langgraph/checkpoint/sqlite/__init__.py
- https://platform.claude.com/docs/en/agents-and-tools/tool-use/memory-tool
- https://github.com/mem0ai/mem0
- https://github.com/getzep/zep
- https://arxiv.org/abs/2502.12110

**Multi-agent:**

- https://arxiv.org/abs/2411.04468
- https://microsoft.github.io/autogen/dev/reference/python/autogen_ext.teams.magentic_one.html
- https://github.com/langchain-ai/langgraph-swarm-py/blob/main/langgraph_swarm/handoff.py
- https://github.com/langchain-ai/langgraph-supervisor-py
- https://github.com/openai/openai-agents-python
- https://github.com/ag2ai/ag2
- https://github.com/crewAIInc/crewAI
- https://github.com/google/adk-python
- https://arxiv.org/abs/2410.10934
- https://github.com/anthropics/claude-agent-sdk-python
