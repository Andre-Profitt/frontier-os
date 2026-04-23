# Root-Level Orchestrator Master Plan

Date: 2026-04-21
Status: canonical plan; M1-M69 orchestration baseline shipped, overnight lane rollups and historical backfill shipped, broader native operator surfaces now include notifications, intents, a persistent macOS widget surface, direct Frontier deep links, a dedicated macOS operator review window, route-specific review controls, native route handoff from Shortcuts/App Intents, a canonical preferred-review route shared across widgets and native shortcuts, expanded selected-command packet/final-brief detail in the standalone operator surface, selected-command passive detail in notifications and macOS widget glance state, low-friction recovery-command copy in the native operator flow, direct evidence reveal from the dedicated review window, direct opening of the selected command's exact evidence file, Terminal handoff into the selected command's live tool context, direct Terminal execution of the selected command's best Frontier CLI follow-up, direct native memory handoff for the selected command, direct Terminal handoff into the selected command's remembered Frontier memory block, direct Terminal handoff into the selected command's audit trail, direct Terminal handoff into the selected command's normalized packet, direct Terminal handoff into the selected command's final brief, direct Terminal handoff into the selected command's artifact index, direct Terminal handoff into the selected command's raw stored command record, passive selected-command route/policy context in widget and notification glance state, a consolidated specialist handoff menu in the native operator window, a canonical selected-command context copy action in that menu, a context-aware primary follow-up copy action, state-aware pruning of selected-command review actions for active work, a read-only Shortcut/App Intent for the current Frontier focus from the shared snapshot, passive selected-command follow-up guidance across widget/notifications/intent surfaces, passive queue-target detail across widget/notifications/intent surfaces, scope-aware stale-state guidance across widget and focus-intent surfaces, truth-preserving refresh prompts in Frontier review notifications, canonical preferred-review labels reused in passive stale-state messaging, compact passive preferred-route labels across widget/notifications/intent surfaces, compact target labels in Frontier Shortcut/App Intent handoffs, humanized Frontier Shortcut/App Intent status phrasing, humanized steady-state command status phrasing in the focus intent, singular/plural-correct overnight review phrasing plus cleaner top-verb cadence in passive intent output, tighter focus-intent framing and empty-state wording, unified `Open Frontier` fallback phrasing in the intent lane, explicit queue-context phrasing in focus-intent pressure summaries, humanized passive selected-command status copy across widget and notification surfaces, aligned legacy widget/command-intent entry-point copy on `Open Frontier …`, aligned snapshot-empty and passive stale-refresh copy on `Frontier` + `local state`, tighter empty-state focus wording in the review intent, tighter passive notification fallback wording, tighter overnight-failure intent fallback wording, tighter Frontier App Intent metadata wording, tighter Frontier App Intent noun phrasing, tighter Frontier review-target enum wording, and tighter long-window preferred-route backfill for retained overnight history, and the remaining work is richer native expansion plus execution-lane maturity

## Executive Summary

This is the canonical integrated plan for the root-level orchestrator. It is grounded in shipped results for project registry, ops readiness, `frontierd`, policy, approvals, MCP, root helper, overnight/Ghost Shift, Jarvis approval UX, the command gateway, and the resident worker. The product target remains:

> One resident local operator that accepts intent from Codex, Claude, Jarvis, Siri, CLI, or schedules; routes it through policy; plans work; runs the right project/system/ML/browser/Salesforce action; pauses for approval when needed; self-audits; and resumes until done.

This plan defines that system and the build path from the current substrate to a real root-level orchestrator.

This is not a backdoor or arbitrary root shell. "Root-level" means the orchestrator can coordinate across the machine and call a narrow privileged helper for allowlisted operations after policy and approval. All actions are ledgered.

## Current Reality

### Already Shipped

The substrate is real:

- Project registry and executable project gates:
  - `frontier project list|inspect|status|verify|smoke|next|repair`
- Ops readiness:
  - `frontier ops status`
  - bounded LaunchAgent repair planning/execution
- Resident user daemon:
  - `frontierd`
  - local API and status endpoints
  - user LaunchAgent residency
- Policy and approval core:
  - action classes
  - one-shot approval grants
  - approval list/approve/consume surfaces
- MCP bridge:
  - read-only tools
  - smoke coverage
  - config output for Codex/Claude
- Root helper:
  - native helper installed as root LaunchDaemon
  - reachable Unix socket
  - read-only helper verbs
  - fixed allowlist and denial posture
- Work graph and Ghost Shift:
  - graph validation/run
  - safe overnight planner/enqueue/run/brief
- Jarvis menubar:
  - resident LaunchAgent app
  - approval panel
  - App Intents / Shortcuts metadata
  - native notifications
  - notification action logging
- MLX shared workbench:
  - machine-level `mlxw` entrypoint and status/smoke/generate/audit flows
- Command gateway and resident worker:
  - `frontier command submit|explain|list|show|resume|cancel`
  - SQLite command queue with checkpoints, activities, leases, retry policy, and idempotency keys
  - work graph compiler for direct lane actions
  - resident `com.frontier-os.command-worker` LaunchAgent
  - daemon command and worker endpoints
- Execution lane MVP:
  - project status/verify/smoke
  - overnight plan/enqueue/run/brief
  - MLX status/smoke/generate/benchmark through the shared `mlxw` workbench
  - helper status/log reads through the root helper
  - Salesforce portfolio inventory scaffold
  - browser current-tab inspection scaffold

### What Is Not Yet Done

The remaining layer is hardening the unified intent-to-execution loop into an overnight-grade product:

- No broader operator dashboard beyond the macOS queue/blocker view.
- No production-grade retry, resume, budget, and verifier policy across every lane.
- Browser lane is wired, but live inspection requires a browser exposing CDP on `127.0.0.1:9222`.
- Salesforce and browser lanes are still scaffolded/read-only; richer task primitives remain open follow-on work.

### Completion Estimate

Current state depends on what we measure:

| Layer | Estimate | Reason |
| --- | ---: | --- |
| Root-router substrate | 85-90% | Daemon, policy, helper, approvals, route explain, MCP, project runner, overnight, command queue, resident worker, and baseline lanes are shipped. |
| Full root-level orchestrator product | 65-75% | The command gateway, planner/compiler, queue, worker, approval resume loop, native submit surfaces, normalized result packet, and write-capable MCP tooling exist. Remaining work is product UX, broader policy hardening, richer lane primitives, and stronger autonomy controls. |
| Autonomous 8-hour work system | 45-55% | Ghost Shift, overnight planning, queue, leases, and worker residency exist. Broad unsupervised execution still needs budget policy, stronger retries/resume, richer verifiers, and morning brief quality. |

The earlier `35-40%` estimate was the right mental model before the command gateway, resident worker, native companion surfaces, normalized result packet, and write-capable MCP control path were in place. With those shipped, the conservative read is now `65-75%` for the full orchestrator product and `45-55%` for reliable 8-hour autonomous work.

## North Star

The finished system should make these workflows feel normal:

```bash
frontier command submit --intent "repair ghost shift and tell me what changed" --json
frontier command submit --intent "run frontier-os verify, fix failures, and rerun" --json
frontier command submit --intent "benchmark the current MLX default model and compare to last run" --json
frontier command submit --intent "prepare the CRM analytics monthly fact pack" --json
frontier command submit --intent "run an 8 hour overnight safe build across my active projects" --json
```

And from Jarvis:

- `Command-K`: "verify frontier-os"
- `Command-K`: "repair ghost shift"
- `Command-K`: "run overnight safe queue"
- `Command-K`: "benchmark MLX"
- `Command-K`: "what is blocked?"

Every request should produce:

- a command ID
- a trace ID
- a route decision
- a policy decision
- a plan or work graph
- live state
- artifacts/logs
- final brief

## Product Contract

### Command Envelope

All surfaces submit the same envelope:

```json
{
  "intent": "repair ghost shift",
  "requestedBy": "andre|codex|claude|jarvis|siri|scheduler",
  "surface": "cli|jarvis|siri|mcp|overnight",
  "projectId": "frontier-os",
  "riskClassHint": 1,
  "context": {
    "cwd": "/Users/test/frontier-os",
    "selectedText": null,
    "attachments": [],
    "recentEventIds": []
  },
  "constraints": {
    "maxRuntimeSeconds": 1800,
    "maxCostUsd": 0,
    "networkAllowed": true,
    "externalWritesAllowed": false
  },
  "approvalPolicy": {
    "autoRunClasses": [0, 1],
    "pauseClasses": [2, 3],
    "requireHumanForExternalSideEffects": true
  }
}
```

### Command States

The command lifecycle is:

| State | Meaning |
| --- | --- |
| `received` | Envelope accepted and ledgered. |
| `classified` | Project/domain/risk/route inferred. |
| `planned` | Work graph or direct action plan created. |
| `queued` | Ready for worker. |
| `running` | Worker owns execution. |
| `blocked_approval` | Class 2/3 action is waiting for one-shot approval. |
| `blocked_input` | Missing credential, context, path, or human decision. |
| `verifying` | Checks are running. |
| `done` | Final brief and artifacts available. |
| `failed` | Terminal failure with recovery path. |
| `cancelled` | Explicit operator cancellation. |

### Policy Classes

| Class | Autonomy | Examples |
| --- | --- | --- |
| 0 | Always allowed | read status, list projects, inspect ledger, dry-run plans |
| 1 | Allowed by default | run tests, typecheck, local smoke, MLX local inference, generate reports |
| 2 | Approval required | restart allowlisted LaunchAgent, consume repair token, modify repo files, deploy to local service |
| 3 | Denied by default / explicit approval | external messages, prod writes, destructive data ops, package installs, arbitrary root/system changes |

## Target Architecture

```text
Surfaces
  CLI / Jarvis / Siri / Codex MCP / Claude MCP / Scheduler
    |
    v
Command Gateway
  validate envelope -> assign commandId/traceId -> ledger command.received
    |
    v
Classifier + Router
  infer project/domain/risk -> choose lane -> policy.evaluate
    |
    v
Planner / Compiler
  direct action OR work graph -> verifier policy -> budget -> approval nodes
    |
    v
Command Queue
  now / queued / blocked / running / done read models
    |
    v
Resident Worker
  executes class 0/1 -> pauses class 2/3 -> resumes after approval
    |
    v
Execution Lanes
  project runner | MLX | browser CDP | Salesforce | GitHub | helper | memory | work graph | ghost
    |
    v
Ledger + Artifacts + Briefs
  append-only events, screenshots, logs, JSON results, final summary
```

## Build Tracks

## External Reference Projects to Copy From

Research pass: 2026-04-21.

These projects should accelerate the build, but none should replace Frontier OS wholesale. Frontier's differentiator is local-first machine control with a narrow root helper, project registry, approvals, ledger, Jarvis/Siri surfaces, and Andre-specific lanes.

### LangGraph: Interrupts, Resume, and Checkpoint Semantics

Reference:

- `https://docs.langchain.com/oss/python/langgraph/interrupts`
- `https://docs.langchain.com/oss/python/langgraph/persistence`

What to copy:

- Treat approval pauses as dynamic interrupts, not ad hoc "blocked" flags.
- Persist a stable thread/command ID as the resume cursor.
- Store the interrupt payload as JSON.
- Resume by passing a structured approval result back into the same command/work graph.

What not to copy immediately:

- Do not migrate Frontier to Python/LangGraph just to get this. The semantics fit our existing TypeScript + SQLite ledger well.

Plan impact:

- Command state `blocked_approval` should include an `interrupt` object.
- Approval consume should call `command resume <commandId> --approval <traceId>`.
- Work graph approval nodes should become resumable instead of terminal skipped nodes.

### Temporal: Durable Workflow History and Activity Boundaries

Reference:

- `https://temporal.io/`
- `https://github.com/temporalio/sdk-typescript`

What to copy:

- Workflow history as the durable source of truth.
- Activities as side-effect boundaries.
- Heartbeats and leases for long-running worker actions.
- Retry policies and idempotency keys per activity.

What not to copy immediately:

- Do not add a Temporal server as M1 infrastructure. It would add operational weight before the command gateway exists.

Plan impact:

- Command worker should model every executor step as an activity record.
- Each command action should have an idempotency key.
- Worker leases should be explicit, even for local SQLite.
- A later M7/M8 decision can evaluate swapping the homegrown worker for Temporal if local-only durability becomes insufficient.

### OpenHands: Agent SDK, Runtime Boundaries, and Event Model

References:

- `https://github.com/OpenHands/OpenHands`
- `https://docs.openhands.dev/sdk`
- `https://docs.openhands.dev/sdk/arch/overview`
- `https://docs.openhands.dev/modules/usage/architecture/runtime`

What to copy:

- Separate core SDK/engine from surfaces.
- Keep tools, workspace, events, LLM, state, and security policy as clean components.
- Use sandbox/runtime boundaries for arbitrary code execution.
- Consider OpenHands SDK as a coding-agent lane for repo tasks, not as the root orchestrator.

What not to copy:

- Do not let a coding-agent runtime become the root authority.
- Do not route root helper or system actions through arbitrary OpenHands shell execution.

Plan impact:

- `frontier command` remains the root command gateway.
- Add an optional future execution lane: `coding-agent.openhands`.
- Keep project verify/smoke and helper operations in Frontier-owned lanes.

### Goose: Local Native Agent + MCP Extension Model

References:

- `https://github.com/aaif-goose/goose`
- `https://goose-docs.ai/docs/getting-started/using-extensions/`

What to copy:

- Desktop + CLI + API shape for one local agent.
- MCP extensions as first-class pluggable capabilities.
- Permission modes, tool permissions, and ignore-file concepts.
- Built-in task/todo/skill style extensions.

What not to copy:

- Do not run Goose as the orchestrator above Frontier. Use it as a peer client or reference.

Plan impact:

- `frontier mcp` should become write-capable only through policy gates.
- Command gateway should expose a small stable MCP tool set rather than hundreds of tools.
- Add a future "extension registry" for Frontier lanes using MCP-compatible descriptors.

### Magentic-One / AutoGen: Orchestrator + Specialist Agents

References:

- `https://www.microsoft.com/en-us/research/publication/magentic-one-a-generalist-multi-agent-system-for-solving-complex-tasks/`
- `https://microsoft.github.io/autogen/stable/user-guide/agentchat-user-guide/magentic-one.html`
- `https://github.com/microsoft/autogen`

What to copy:

- Top-level orchestrator delegates to specialized agents/lanes.
- Keep Coder, Terminal, Browser, File, and domain specialists separate.
- Use benchmark/eval isolation for side-effecting agents.

Important warning:

- Microsoft Research also flags tool-space interference: adding too many tools can degrade agent performance. Frontier should present small lane-specific tool menus, not the whole machine.

Plan impact:

- Command classifier chooses one lane first.
- Planner exposes only lane-relevant tools to a model/agent.
- Multi-agent delegation should be opt-in per command, not always-on.

### Skyvern: Browser Automation API Patterns

Reference:

- `https://github.com/skyvern-ai/skyvern`

What to copy:

- Natural-language browser actions as structured primitives:
  - `act`
  - `extract`
  - `validate`
  - `run_task`
- Schema-backed extraction and validation.
- Browser workflows as reusable artifacts.

What not to copy immediately:

- Do not replace our CDP/browser adapter yet.
- Do not add cloud/proxy/CAPTCHA behavior.

Plan impact:

- Browser lane should expose `browser.act`, `browser.extract`, `browser.validate`.
- Salesforce lane should use schema-backed extraction/validation, not brittle selector-only automation.

### Open Interpreter: Safety Lessons for Local Computer Control

Reference:

- `https://github.com/openinterpreter/open-interpreter`

What to copy:

- Simple natural-language computer interface.
- Explicit confirmation before local code execution.
- Treat auto-run as dangerous.

What not to copy:

- Do not give Frontier an `exec(any code)` primitive.
- Do not bypass approval for file/system changes.

Plan impact:

- Keep Frontier's helper allowlist and policy classes.
- Any broad shell execution must stay project-scoped, manifest-declared, and ledgered.

## Build Acceleration Decision

We should not import a large framework before M1. The fastest path is:

1. Build Frontier's command gateway in TypeScript using the existing ledger, policy, project registry, and daemon.
2. Copy LangGraph/Temporal semantics into our queue schema:
   - checkpoint/resume cursor
   - interrupt payload
   - activity record
   - worker lease
   - retry policy
3. Copy OpenHands/Goose boundaries:
   - engine separate from surfaces
   - small tool menus
   - MCP-compatible extension descriptors
4. Add external runtimes as lanes only after the command gateway exists:
   - OpenHands for coding-agent lane
   - Skyvern or browser-use style primitives for browser lane
   - Temporal only if local SQLite worker durability is not enough

This avoids rebuilding a worse LangGraph/Temporal by accident while preserving Frontier's local/security/product shape.

### Track A: Command Gateway

Goal: create one typed ingress path for every surface.

Status: M1 baseline shipped on 2026-04-21.

Shipped:

- command envelope and command result schemas
- SQLite command store at `~/.frontier/commands/commands.db`
- CLI `submit`, `explain`, `list`, `show`, `resume`, `cancel`, and `smoke`
- `frontierd` endpoints for command submit/list/show/resume/cancel
- persisted checkpoint, interrupt payload, retry policy, idempotency key, and activity rows
- ledger events for received/classified/planned/queued/state changes

Deliverables:

- `schemas/command-envelope.schema.json`
- `schemas/command-result.schema.json`
- `src/commands/envelope.ts`
- `src/commands/store.ts`
- CLI:
  - `frontier command submit --intent <text> [--project <id>] [--json]`
  - `frontier command list --json`
  - `frontier command show <commandId> --json`
  - `frontier command cancel <commandId> --json`
- API:
  - `POST /v1/commands`
  - `GET /v1/commands`
  - `GET /v1/commands/:id`
- Ledger events:
  - `command.received`
  - `command.classified`
  - `command.planned`
  - `command.queued`
  - `command.state_changed`
  - `command.completed`
  - `command.failed`

Success gate:

```bash
/Users/test/frontier-os/bin/frontier command submit --intent "status frontier-os" --json
/Users/test/frontier-os/bin/frontier command list --json
/Users/test/frontier-os/bin/frontier command show <commandId> --json
```

### Track B: Classifier and Router

Goal: convert plain intent into project/domain/risk/route.

Initial deterministic classifier:

- project name/path aliases from project registry
- verbs from known families:
  - `status`, `verify`, `smoke`, `test`, `build`
  - `repair`, `restart`, `logs`
  - `mlx`, `benchmark`, `generate`
  - `salesforce`, `dashboard`, `crm`
  - `browser`, `tab`, `inspect`
  - `overnight`, `queue`, `brief`
- risk class from verb and target

No LLM needed for M1. LLM planner can be added after deterministic routing is stable.

Deliverables:

- `src/commands/classifier.ts`
- `src/commands/router.ts`
- `frontier command explain --intent <text> --json`
- route explanations include:
  - project
  - lane
  - risk class
  - approval requirement
  - confidence
  - missing inputs

Success gate:

```bash
frontier command explain --intent "verify frontier-os" --json
frontier command explain --intent "repair ghost shift" --json
frontier command explain --intent "benchmark MLX" --json
frontier command explain --intent "run overnight safe queue" --json
```

### Track C: Planner / Work Compiler

Goal: convert commands into executable direct actions or work graphs.

MVP planning rules:

| Intent | Plan |
| --- | --- |
| `status <project>` | Direct project status command. |
| `verify <project>` | Direct project verify command with verifier. |
| `smoke <project>` | Direct project smoke command with verifier. |
| `repair <launchagent>` | Dry-run repair, then approval node if execute is needed. |
| `benchmark MLX` | MLX status, smoke, generate, benchmark/audit artifact. |
| `overnight safe queue` | Overnight plan, enqueue, run class 0/1, brief. |

Deliverables:

- `src/commands/planner.ts`
- `src/commands/compiler.ts`
- command plans can emit:
  - direct runnable action
  - work graph JSON
  - blocked/missing-input result
- generated graphs stored under `~/.frontier/commands/<commandId>/graph.json`

Success gate:

```bash
frontier command submit --intent "verify frontier-os" --dry-run --json
frontier command submit --intent "repair ghost shift" --dry-run --json
```

### Track D: Queue and Resident Worker

Goal: keep work moving without interactive babysitting.

Deliverables:

- persistent command store in `~/.frontier/commands/commands.db` or a command table in ledger DB
- worker loop:
  - `frontier command worker run`
  - `frontier command worker status`
  - `frontier command worker install-user-agent`
- queue state:
  - `now`
  - `queued`
  - `blocked`
  - `done`
  - `failed`
- worker claims commands with leases to avoid duplicate execution
- worker resumes after approval token appears

Success gate:

```bash
frontier command submit --intent "verify frontier-os" --json
frontier command worker run --once --json
frontier command show <commandId> --json
```

### Track E: Policy and Approval Integration

Goal: make every command action policy-gated before execution.

Deliverables:

- command planner calls `policy.evaluate` before enqueue/run
- class 2/3 planned actions create pending approval records
- approval actions include command ID and resume command
- Jarvis approval list shows command context, not only raw trace IDs
- notification actions can approve/resume commands

Success gate:

```bash
frontier command submit --intent "repair ghost shift" --json
frontier approval list --json
frontier approval approve <traceId> --ttl 15m --json
frontier command worker run --once --json
```

### Track F: Jarvis Command Surface

Goal: make the orchestrator feel like a native OS layer.

Deliverables:

- Jarvis `Command-K` command field
- submit command to `frontier command submit`
- panes:
  - `Now`
  - `Queue`
  - `Blocked`
  - `Done`
  - `Actions`
- command detail view:
  - plan
  - route
  - policy
  - logs
  - artifacts
  - approval buttons
- App Intent:
  - `Submit Frontier Command`
  - `Show Frontier Queue`
  - `Resume Frontier Command`

Success gate:

```bash
cd /Users/test/code/apps/jarvis-menubar
swift test
scripts/install-launch-agent.sh
```

Manual gate:

- type `verify frontier-os` in Jarvis
- command appears in queue
- worker completes it
- final brief appears in Jarvis

### Track G: Execution Lane Expansion

Goal: route common Andre workflows through stable lanes.

#### Project Lane

- `verify`
- `smoke`
- `dev`
- `logs`
- `next`
- `repair --dry-run`

Gate:

```bash
frontier command submit --intent "verify frontier-os" --json
frontier command submit --intent "smoke jarvis-menubar" --json
```

#### MLX Lane

Use shared `mlxw`, never per-repo duplication.

- status
- smoke
- generate
- audit
- benchmark
- inventory

Gate:

```bash
frontier command submit --intent "run MLX smoke and benchmark default model" --json
```

#### Browser Lane

- inspect active approved browser session
- capture DOM/network/console/screenshot
- bounded interactions
- no credential scraping

Gate:

```bash
frontier command submit --intent "inspect current Salesforce browser tab" --json
```

#### Salesforce / CRM Analytics Lane

- portfolio summary
- dashboard audit batch
- CLI-only Salesforce flows for CRM Analytics repo
- no prohibited MCP Salesforce tools for CRM Analytics work

Gate:

```bash
frontier command submit --intent "run CRM Analytics portfolio summary" --json
```

#### Helper Lane

- read-only helper status/logs/network/launchd status
- class-2 controlled verbs later:
  - restart allowlisted services
  - load/unload allowlisted labels
  - fix ownership under allowlisted roots

Gate:

```bash
frontier command submit --intent "show helper and frontierd launchd status" --json
```

### Track H: Observability, Memory, and Evals

Goal: make the system self-improving and auditable.

Deliverables:

- command final briefs
- artifact directory per command
- ledger query views:
  - by command
  - by project
  - by route
  - by failure class
- failure refinery integration:
  - repeated command failure -> eval case
  - repeated repair -> proposed rule
- memory writes:
  - operational decisions
  - procedural lessons
  - project-specific runbooks

Success gate:

```bash
frontier command brief <commandId> --json
frontier eval run --since <iso> --json
frontier memory search --class procedural --query "ghost shift repair" --json
```

### Track I: Security and Governance

Goal: preserve power without turning the machine into an unsafe root bot.

Rules:

- No arbitrary root shell.
- No helper verb that runs arbitrary commands.
- No wildcard filesystem writes.
- No destructive DB/file operations without explicit approval.
- No external messages, public posts, deployments, or billable cloud changes without approval.
- Every side effect has:
  - trace ID
  - actor
  - policy decision
  - command ID
  - ledger events
  - rollback/recovery note where possible

Deliverables:

- policy matrix by lane
- helper denial tests extended for command path
- command dry-run mode
- command cancellation
- budget enforcement
- approval expiry/resume handling

Success gate:

```bash
frontier command submit --intent "delete everything in Downloads" --dry-run --json
frontier command submit --intent "restart com.apple.WindowServer" --dry-run --json
frontier helper self-test --json
```

Expected result: blocked/denied with exact reasons.

## Milestone Roadmap

### M0: Plan Consolidation

Status: this document.

Gate:

- one canonical master plan exists
- existing lower-level plans stay linked

### M1: Command Gateway MVP

Build:

- command schema
- submit/list/show/explain
- command ledger events
- deterministic classifier for project status/verify/smoke/repair/overnight/MLX

Gate:

```bash
npm run typecheck
frontier command submit --intent "status frontier-os" --json
frontier command explain --intent "repair ghost shift" --json
```

### M2: Queue and Worker

Build:

- persistent command queue
- worker `run --once`
- state transitions
- final brief for direct actions

Status: M2 baseline shipped on 2026-04-21.

Shipped:

- `frontier command worker status`
- `frontier command worker run --once [--command <commandId>]`
- SQLite command leases with `lease_owner` and `lease_until`
- activity attempts, start/finish timestamps, and captured process output
- direct-action execution for compiled command plans
- graph-backed execution when `plan.workGraphPath` exists
- direct process fallback for older commands without graph artifacts
- bounded loop mode with `--loop`, `--max-runtime-ms`, `--idle-exit-ms`, and `--max-commands`
- queue guard with `--max-approval-class` for safe resident draining
- command worker LaunchAgent generator and installer at `com.frontier-os.command-worker`
- terminal `command.completed` / `command.failed` ledger events

Gate:

```bash
frontier command submit --intent "verify frontier-os" --json
frontier command worker run --once --json
frontier command show <id> --json
```

Verified graph-backed worker bridge:

```bash
frontier command submit --intent "verify frontier-os" --project frontier-os --json --local
frontier command worker run --command cmd_mo8oplg9_6f7ef983 --json --local
```

Verified loop mode:

```bash
frontier command worker run --loop --max-approval-class 0 --max-commands 2 --interval-ms 50 --idle-exit-ms 100 --json --local
frontier command submit --intent "status frontier-os" --project frontier-os --json --local
frontier command worker run --loop --command cmd_mo8orggh_8207f295 --max-commands 1 --interval-ms 50 --idle-exit-ms 100 --json --local
frontier command worker status --json --local
```

Verified worker LaunchAgent:

```bash
frontier command worker print-plist --max-approval-class 1 --json --local
frontier command worker install-user-agent --dry-run --max-approval-class 1 --json --local
frontier command worker install-user-agent --max-approval-class 1 --json --local
plutil -lint /Users/test/Library/LaunchAgents/com.frontier-os.command-worker.plist
launchctl bootstrap gui/503 /Users/test/Library/LaunchAgents/com.frontier-os.command-worker.plist
launchctl print gui/503/com.frontier-os.command-worker
```

Runtime evidence:

- LaunchAgent state: `running`
- LaunchAgent PID: `40561`
- Queue drained from 5 queued commands to 1 queued command
- Remaining queued command is class-2 `ops.repair_launchagent`, intentionally excluded by `--max-approval-class 1`
- Recent `command.completed` ledger events landed at `2026-04-21T14:00:01Z` through `2026-04-21T14:00:02Z`

### M3: Planner/Compiler

Status: M3 baseline shipped on 2026-04-21.

Build:

- command-to-work-graph compiler
- dry-run graph artifacts
- approval nodes for class 2
- verifier policies

Shipped:

- `src/commands/compiler.ts`
- command graph artifacts at `~/.frontier/commands/<commandId>/graph.json`
- dry-run `frontier command submit` writes the graph artifact
- persisted command plans include `plan.workGraphPath`
- class-2 command graphs include explicit approval nodes
- direct-action graphs route through the native `frontier` CLI dispatcher
- verifier policies cover artifact output and trace grading for project verify/smoke

Gate:

```bash
frontier command submit --intent "repair ghost shift" --dry-run --json
frontier work validate ~/.frontier/commands/<id>/graph.json
frontier work run ~/.frontier/commands/<id>/graph.json --dry-run --json
```

Verified:

- `npm run typecheck -- --pretty false`
- `frontier work validate /Users/test/.frontier/commands/cmd_mo8om25n_cbf04eff/graph.json --json --local`
- `frontier work run /Users/test/.frontier/commands/cmd_mo8om25n_cbf04eff/graph.json --dry-run --json --local`
- `frontier work validate /Users/test/.frontier/commands/cmd_mo8om5p3_935ff775/graph.json --json --local`
- `frontier work run /Users/test/.frontier/commands/cmd_mo8om5p3_935ff775/graph.json --json --local`
- `frontier command worker run --command cmd_mo8om5p3_935ff775 --json --local`

### M4: Jarvis Command-K

Status: backend surface shipped on 2026-04-21.

Build:

- command field
- queue panes
- command details
- submit/list/show integration

Backend shipped:

- `GET /v1/commands`
- `POST /v1/commands`
- `GET /v1/commands/:id`
- `GET /v1/commands/:id/events`
- `POST /v1/commands/:id/resume`
- `POST /v1/commands/:id/cancel`
- `GET /v1/command-worker/status`
- `POST /v1/command-worker/run-once`
- daemon-backed submit/list/show tested through the Unix socket
- resident worker completion visible through command details and events

Gate:

- Jarvis can submit `verify frontier-os`
- command status updates live
- final result appears in menu

Backend gate verified:

```bash
curl --unix-socket /Users/test/.frontier/run/frontierd.sock http://frontierd.local/v1/command-worker/status
curl --unix-socket /Users/test/.frontier/run/frontierd.sock http://frontierd.local/v1/commands?limit=3
curl --unix-socket /Users/test/.frontier/run/frontierd.sock \
  -H 'content-type: application/json' \
  --data '{"intent":"status frontier-os","projectId":"frontier-os","actorId":"command-k-smoke"}' \
  http://frontierd.local/v1/commands
curl --unix-socket /Users/test/.frontier/run/frontierd.sock \
  http://frontierd.local/v1/commands/cmd_mo8ozs3i_6e20ca4a/events?limit=50
```

### M5: Approval Resume Loop

Status: M5 baseline shipped on 2026-04-21.

Build:

- class-2 command pauses
- approval list includes command context
- approve button resumes worker
- notification action resumes worker

Shipped:

- command trace lookup in `CommandStore.getByTraceId`
- `frontier approval approve <traceId>` auto-resumes a matching `blocked_approval` command
- `POST /v1/approvals/approve` accepts query or JSON body and returns `resumedCommand`
- graph-backed worker can explicitly drain approved class-2 commands with `--max-approval-class 2`

Gate:

```bash
frontier command submit --intent "repair ghost shift" --json
frontier approval approve <traceId> --ttl 15m --json
frontier command worker run --once --json
```

Verified:

```bash
frontier command submit --intent "repair ghost shift m5 smoke" --project frontier-os --actor m5-smoke --json
frontier approval approve trace-f873e016-004e-4ba7-a915-a292818ff920 --actor m5-smoke --ttl 15m --json
frontier command worker run --command cmd_mo8p463b_93d59253 --max-approval-class 2 --json --local
curl --unix-socket /Users/test/.frontier/run/frontierd.sock \
  http://frontierd.local/v1/commands/cmd_mo8p463b_93d59253/events?limit=80
```

### M6: Execution Lanes

Status: M6 baseline shipped on 2026-04-21.

Build:

- project lane coverage for initial manifest set
- MLX lane
- helper read-only lane
- overnight lane
- Salesforce/CRM lane scaffolding
- browser inspection lane

Shipped:

- `frontier mlx` wrapper for the shared `/Users/test/.frontier/mlx/bin/mlxw` workbench
- graph compiler routes MLX lane commands through `/usr/local/bin/python3 /Users/test/.frontier/mlx/bin/mlxw ...`
- LaunchAgent-safe MLX environment:
  - `FRONTIER_MLX_LAUNCHD_SAFE=1`
  - `PYTHONNOUSERSITE=1`
  - `PYTHONPATH=/Users/test/Library/Python/3.13/lib/python/site-packages`
  - workbench clears bootstrap `PYTHONPATH` before spawning subprocesses so edge venv versions stay isolated
- helper logs route now calls `helper production-invoke logs.read --path /Users/test/Library/Logs/frontier-os/frontierd.err.log`
- deterministic routes for:
  - `mlx status|smoke|generate|benchmark`
  - `helper logs`
  - `run overnight safe queue`
  - `salesforce portfolio summary`
  - `inspect current browser tab`
- work dispatcher supports per-node environment overrides

Verified:

```bash
frontier mlx status --fail-if-not-ready --json --local
frontier command submit --intent "mlx status" --actor m6-resident-smoke5 --json --local
frontier command show cmd_mo8pqz3e_72f8e31a --json --local
frontier command submit --intent "helper logs" --actor m6-helper-smoke2 --json --local
frontier command show cmd_mo8prew0_ca6a4dd5 --json --local
frontier command worker status --json --local
```

Current evidence:

- `cmd_mo8pqz3e_72f8e31a` completed via resident worker with MLX host `ready`, `mlx=0.31.1`, `mlx-lm=0.31.1`, edge `mlx-lm=0.31.2`.
- `cmd_mo8prew0_ca6a4dd5` completed via resident worker and read `/Users/test/Library/Logs/frontier-os/frontierd.err.log` through the production helper.
- Queue is clean: `queued=0`, `running=0`, `claimableCount=0`.

Known caveat:

- Browser lane is wired, but `browser current-tab` currently requires a browser launched with CDP on `127.0.0.1:9222`; without that, the adapter returns `ECONNREFUSED`.

Gate:

```bash
frontier command submit --intent "benchmark MLX default model" --json
frontier command submit --intent "run overnight safe queue for 2 hours" --json
frontier command submit --intent "inspect current browser tab" --json
```

### M7: Resident Autonomy

Status: M7 started on 2026-04-21.

Build:

- worker LaunchAgent
- leases
- retry policy
- budget policy
- morning command brief

Shipped:

- `frontier command brief --hours N --limit N`
- `GET /v1/command-brief?hours=N&limit=N`
- `frontier command readiness --hours N --limit N`
- `GET /v1/command-readiness?hours=N&limit=N`
- `frontier command submit ... --max-runtime-seconds N`
- `frontier command submit ... --max-retries N --retry-backoff-ms N`
- brief includes:
  - queue/worker status
  - active commands
  - approval/policy blockers
  - recent completions
  - recent failures
  - unresolved failures
  - resolved historical failures with the later command that cleared the lane
  - in-window status counts
- command envelope `policy.maxRuntimeSeconds` now clamps compiled graph node `timeoutMs`
- command envelope `policy.maxRetries` and `policy.retryBackoffMs` now compile into work graph node retry policies
- read-only and dry-run-safe actions get one conservative retry by default
- worker heartbeats extend leases while a command is running
- expired `running` commands are reclaimable after worker death
- readiness gate checks `frontierd`, queue, expired leases, blockers, and unresolved failures

Verified:

```bash
frontier command brief --hours 24 --limit 50 --json --local
frontier command brief --hours 24 --limit 20 --json
frontier command readiness --hours 24 --limit 50 --json
curl --unix-socket /Users/test/.frontier/run/frontierd.sock \
  'http://frontierd.local/v1/command-readiness?hours=24&limit=50'
frontier command submit --intent "mlx benchmark" --max-runtime-seconds 30 --dry-run --json --local
frontier command submit --intent "inspect current browser tab" --max-retries 2 --retry-backoff-ms 25 --dry-run --json --local
curl --unix-socket /Users/test/.frontier/run/frontierd.sock \
  -H 'content-type: application/json' \
  --data '{"intent":"mlx status","actorId":"m7-daemon-policy-smoke","policy":{"maxRetries":2,"retryBackoffMs":25,"maxRuntimeSeconds":45}}' \
  http://frontierd.local/v1/commands
frontier command worker run --command cmd_mo8qc3t7_88dbd5c2 --worker-id m7-reclaim-worker --lease-ms 30000 --json --local
```

Current evidence:

- queue clear
- no approval/policy blockers
- no unresolved recent failures
- worker LaunchAgent running
- `frontier command brief --hours 24 --limit 20 --json` served by `frontierd`
- `frontier command readiness --hours 24 --limit 50 --json` returned `status=ready`
- `queued=0`, `running=0`, `claimableCount=0`
- 4 historical MLX lane failures remain visible from the pre-fix launchd Python issue, but the brief marks them resolved by later successful MLX status commands.
- dry-run `mlx benchmark` with `--max-runtime-seconds 30` compiles to `timeoutMs=30000`.
- dry-run browser inspect with `--max-retries 2 --retry-backoff-ms 25` compiles to `maxAttempts=3`.
- direct browser work-graph retry proof attempted 3 times and failed only because CDP is unavailable.
- daemon-submitted `cmd_mo8q9eks_112cf3a7` compiled to `maxAttempts=3`, `timeoutMs=45000`, and completed through the resident worker.
- synthetic expired lease `cmd_mo8qc3t7_88dbd5c2` was reclaimed from `dead-worker` and completed by `m7-reclaim-worker`.

Gate:

```bash
frontier command worker install-user-agent --dry-run --json
frontier overnight run --hours 8 --dry-run --json
frontier overnight brief --hours 24 --json
frontier command brief --hours 24 --json
```

### M8: Hardening and Productization

Status: M8 baseline shipped on 2026-04-21; command DB restore remains manual/destructive.

Build:

- command cancellation
- command artifacts UI
- failure refinery integration
- memory integration
- denial tests
- backup/restore for command DB
- docs/runbooks

Shipped:

- `frontier command events <commandId> --limit N`
- `frontier command artifacts <commandId>`
- `frontier command backup [--dest-dir path]`
- `GET /v1/commands/:id/artifacts`
- command artifacts include:
  - artifact directory
  - work graph path
  - files under the command artifact directory
  - dispatch artifact refs from graph execution results
- command DB backup creates a timestamped local snapshot directory with `commands.db`, any present WAL/SHM sidecars, and a manifest
- deterministic class-3 denial guards for destructive filesystem/database intents and protected system-service restarts
- `frontier command smoke` now includes denial checks for `delete everything in Downloads` and `restart com.apple.WindowServer`
- Refinery harvest now recognizes `command.failed` terminal events and future command failures include lane/verb/approval metadata
- Refinery propose maps repeated command failures to advisory `raise_approval_class` proposals
- `frontier command remember <commandId>` writes compact command outcomes into typed memory
- memory FTS search now quotes plain terms so hyphenated project IDs such as `frontier-os` search correctly
- command orchestrator runbook: `docs/runbooks/command-orchestrator.md`

Verified:

```bash
frontier command events cmd_mo8q9eks_112cf3a7 --limit 20 --json
frontier command artifacts cmd_mo8q9eks_112cf3a7 --json
frontier command backup --json --local
jq '{status, backupDir, dbPath, copiedFiles: [.files[] | select(.copied == true) | .destination]}' \
  /Users/test/.frontier/commands/backups/2026-04-21T18-02-41-920Z/manifest.json
frontier command submit --intent "delete everything in Downloads" --dry-run --json --local
frontier command submit --intent "restart com.apple.WindowServer" --dry-run --json --local
frontier command smoke --json
frontier refinery harvest --since 2026-04-21T00:00:00Z --limit 2000 --json
frontier refinery propose --since 2026-04-21T00:00:00Z --limit 2000 --min-frequency 2 --json
frontier command remember cmd_mo8xnx5i_394364e6 --json --local
frontier memory get cmd_mo8xnx5i_394364e6 --class run --namespace commands/project --json
frontier memory search --class run --namespace commands --query "status frontier-os" --limit 5 --json
test -s docs/runbooks/command-orchestrator.md
```

Current evidence:

- events endpoint served by `frontierd` returned 2 sessions and 11 events for `cmd_mo8q9eks_112cf3a7`.
- artifacts endpoint served by `frontierd` returned `/Users/test/.frontier/commands/cmd_mo8q9eks_112cf3a7/graph.json`.
- backup manifest written to `/Users/test/.frontier/commands/backups/2026-04-21T18-02-41-920Z/manifest.json`; `commands.db` copied successfully and WAL/SHM were absent at snapshot time.
- destructive dry-runs returned `status=blocked_policy`, `approvalClass=3`, `decision=deny`, and no planned action.
- command smoke returned `status=ok` with both denial checks marked `blocked=true`.
- Refinery harvest returned a `command.failed::command_failed::work graph failed` signal with `count=4`.
- Refinery propose returned `rule_f9c54ecc` with `suggestedAction=raise_approval_class` for repeated command failures.
- command memory write stored `cmd_mo8xnx5i_394364e6` under `run:commands/project` with source metadata `frontier.command.remember`.
- memory search for `status frontier-os` returned the remembered command block.
- command orchestrator runbook now covers health, morning brief, submit/inspect, backup, denial smoke, memory handoff, failure refinery, and approval resume.

Gate:

```bash
npm run typecheck
frontier overnight smoke --json
frontier mcp smoke --read-only --json
frontier helper self-test --json
frontier command smoke --json
```

### M9: Command Final Briefs

Status: M9 baseline shipped on 2026-04-21.

Build:

- command-scoped final brief
- daemon endpoint for final brief
- result summary and recovery commands
- events/artifacts folded into one handoff packet

Shipped:

- `frontier command final-brief <commandId> [--event-limit N]`
- `GET /v1/commands/:id/brief?eventLimit=N`
- final brief includes:
  - command identity and status
  - route and policy
  - result summary and error
  - activity attempts
  - artifact directory, graph path, files, and dispatch artifact refs
  - command/workgraph ledger sessions and event tail
  - recovery next action and exact follow-up commands

Verified:

```bash
npm run typecheck -- --pretty false
frontier command final-brief cmd_mo8xnx5i_394364e6 --event-limit 20 --json --local
frontier command final-brief cmd_mo8xnx5i_394364e6 --event-limit 20 --json
curl --unix-socket /Users/test/.frontier/run/frontierd.sock \
  'http://frontierd.local/v1/commands/cmd_mo8xnx5i_394364e6/brief?eventLimit=20'
frontier command readiness --hours 24 --limit 50 --json
```

Current evidence:

- local final brief returned `status=completed`, result summary `project.status completed via work graph`, one graph artifact file, 11 ledger events, and recovery `No recovery needed`.
- daemon-served final brief returned `servedBy=frontierd` after restarting `com.frontier-os.frontierd`.
- raw daemon endpoint returned the same completed command result and 11-event ledger tail.
- readiness remained `status=ready`.

### M10: MCP Command Gateway

Status: M10 baseline shipped on 2026-04-21.

Build:

- command gateway exposed as a narrow MCP tool set
- read-only command tools for queue, command detail, final brief, aggregate brief, and readiness
- class-1 command submit tool with dry-run smoke coverage

Shipped:

- `frontier.command_submit`
- `frontier.command_list`
- `frontier.command_show`
- `frontier.command_final_brief`
- `frontier.command_brief`
- `frontier.command_readiness`

Verified:

```bash
npm run typecheck -- --pretty false
frontier mcp call frontier.command_readiness --input '{"hours":24,"limit":25}' --json
frontier mcp call frontier.command_submit --input '{"intent":"status frontier-os","projectId":"frontier-os","dryRun":true}' --json
frontier mcp call frontier.command_final_brief --input '{"commandId":"cmd_mo8xnx5i_394364e6","eventLimit":10}' --json
frontier mcp smoke --read-only --json
frontier mcp smoke --json
```

Current evidence:

- `frontier.command_readiness` returned `status=ready` served by `frontierd`.
- `frontier.command_submit` dry-run returned a project/status command record served locally.
- `frontier.command_final_brief` returned a completed command brief served by `frontierd`.
- read-only MCP smoke passed `16/16`.
- full MCP smoke passed `17/17`.

### M11: Native Menu Bar Final Briefs

Status: M11 baseline shipped on 2026-04-21.

Build:

- native macOS command surface consumes command final briefs
- selected command view shows recovery, artifacts, and ledger evidence
- keep execution in Frontier CLI/backend rather than duplicating orchestration in Swift

Shipped in `/Users/test/code/platform/companion-platform`:

- `CompanionMenuBarApp` command selection now calls:
  - `frontier command final-brief <commandId> --event-limit 20 --json`
  - falls back to `frontier command show <commandId> --json` for older Frontier builds
- selected command details now decode:
  - recovery next action
  - artifact file count
  - ledger event count
  - final-brief activities
- menu bar panel renders recovery plus artifact/ledger chips

Verified:

```bash
cd /Users/test/code/platform/companion-platform/apps/apple-companion
swift build --target CompanionMenuBarApp
```

Current evidence:

- `CompanionMenuBarApp` target built successfully after the final-brief model and panel changes.

### M12: Siri Shortcut Command Submission

Status: M12 baseline shipped on 2026-04-21.

Build:

- macOS App Intent for submitting Frontier commands from Siri/Shortcuts
- dry-run parameter for safe voice testing
- shortcut phrase provider for discoverability
- route all execution through `frontier command submit`, not duplicated Swift orchestration

Shipped in `/Users/test/code/platform/companion-platform`:

- `CompanionSubmitFrontierCommandIntent`
- `CompanionFrontierCommandShortcuts`
- default command: `status frontier-os`
- actor tag: `siri-frontier`

Verified:

```bash
cd /Users/test/code/platform/companion-platform/apps/apple-companion
swift build --target CompanionAppleIntents
```

Current evidence:

- `CompanionAppleIntents` target built successfully with the macOS-only Frontier command intent and App Shortcut provider.

### M13: Normalized Command Result Packet

Status: M13 baseline shipped on 2026-04-21.

Build:

- stable cross-lane command result packet
- daemon endpoint for packet retrieval
- packet folded into final brief and memory handoff
- normalized evidence counts for artifacts, dispatches, and ledger sessions

Shipped:

- `frontier command packet <commandId>`
- `GET /v1/commands/:id/packet`
- `commandResultPacket` / `packetFromRecord` normalization for:
  - process-backed results
  - work-graph results
  - structured outputs
  - adapter dispatch metadata
  - artifact and ledger evidence
- `frontier command final-brief` now includes `packet`
- `frontier command remember` now writes a compact packet section into memory

Verified:

```bash
npm run typecheck -- --pretty false
frontier command packet cmd_mo8xnx5i_394364e6 --json --local
frontier command packet cmd_mo8xnx5i_394364e6 --json
curl --unix-socket /Users/test/.frontier/run/frontierd.sock \
  'http://frontierd.local/v1/commands/cmd_mo8xnx5i_394364e6/packet'
frontier command final-brief cmd_mo8xnx5i_394364e6 --event-limit 20 --json --local
frontier command remember cmd_mo8xnx5i_394364e6 --json --local
```

Current evidence:

- local packet returned `packetVersion=v1`, `execution.kind=work_graph`, primary structured output `project_output`, and `ledgerEventCount=11`.
- daemon-served packet returned `servedBy=frontierd` after restarting `com.frontier-os.frontierd`.
- raw daemon packet endpoint returned the same packet shape and evidence counts through the Unix socket.
- final brief now carries the normalized packet instead of reconstructing result state ad hoc.
- memory handoff now records packet execution/evidence counts alongside the command summary.

### M14: Native Operator Queue Dashboard

Status: M14 baseline shipped on 2026-04-21.

Build:

- menu bar queue/blocker dashboard backed by `command brief` and `command readiness`
- segmented running/blocked/failed/done queue focus
- selected-command recovery context from `final-brief`
- packet-derived execution/evidence chips in the native command panel

Shipped in `/Users/test/code/platform/companion-platform`:

- `FrontierCommandController` now refreshes:
  - `frontier command readiness --hours 24 --limit 20 --json`
  - `frontier command brief --hours 24 --limit 20 --json`
  - `frontier command final-brief <commandId> --event-limit 20 --json`
- the menu bar command surface now shows:
  - readiness state
  - queued/running/blocked/unresolved-failure counts
  - segmented queue views for running, blocked, failed, and done
  - selected-command recovery command plus packet-derived execution/evidence counts

Verified:

```bash
cd /Users/test/code/platform/companion-platform/apps/apple-companion
swift build --target CompanionMenuBarApp
cd /Users/test/frontier-os
frontier command readiness --hours 24 --limit 20 --json
frontier command brief --hours 24 --limit 20 --json
```

Current evidence:

- `CompanionMenuBarApp` built successfully after the queue dashboard controller/panel changes.
- `frontier command readiness --hours 24 --limit 20 --json` remained `status=ready`.
- `frontier command brief --hours 24 --limit 20 --json` returned queue/blocker/failure data for the native panel to render.

### M15: Write-Capable MCP Agent Tools

Status: M15 baseline shipped on 2026-04-21.

Build:

- write-capable MCP tools for approval grant and command resume
- normalized packet lookup exposed through MCP
- fuller command-submit schema for trace/correlation/payload/policy hints
- full smoke coverage for actual submit, blocked submit, approval, resume, and follow-up lookup

Shipped:

- `frontier.approval_approve`
- `frontier.command_packet`
- `frontier.command_resume`
- `frontier.command_submit` now accepts:
  - `traceId`
  - `correlationId`
  - `approvalClass`
  - `payload`
  - `requireVerification`
  - `allowSideEffects`
- `/v1/approvals/approve` now honors `resume=false` while keeping auto-resume as the default behavior

Verified:

```bash
npm run typecheck -- --pretty false
frontier mcp call frontier.command_packet --input '{"commandId":"cmd_mo8xnx5i_394364e6"}' --json
frontier mcp call frontier.command_submit --input '{"intent":"status frontier-os","projectId":"frontier-os","dryRun":true,"requireVerification":true}' --json
frontier mcp smoke --read-only --json
frontier mcp smoke --json
```

Current evidence:

- read-only MCP smoke passed `17/17`.
- full MCP smoke passed `24/24`.
- `frontier.command_packet` was served by `frontierd` and returned `packetVersion=v1`.
- full smoke proved:
  - actual submit
  - packet follow-up lookup
  - blocked class-2 submit
  - manual approval grant with `resume=false`
  - explicit command resume
  - final-brief follow-up

### M16: Retry/Budget/Verifier Hardening

Keep the source of truth in the command gateway and make longer autonomous runs
observable instead of opaque.

Status: shipped.

Shipped:

- canonical command execution policy recorded at submit time:
  - max runtime
  - max attempts / backoff
  - verification requirement / verifier mode
  - side-effect allowance hint
- worker/runtime budget enforcement:
  - explicit timeout metadata on CLI dispatch/process paths
  - command policy reapplied onto loaded work graphs before execution
  - command-level retry defaults threaded into the graph executor
- operator-visible execution analysis:
  - normalized packet now carries `executionPolicy` and `failure`
  - final brief now carries the same execution policy/failure surfaces and
    recovery guidance for verifier failure, retry exhaustion, and runtime expiry
  - command brief items now expose execution policy + classified failure kind
- readiness hardening:
  - `retry_budget` check
  - `verification` check
  - verifier failures block readiness
  - retry/runtime failures degrade readiness
- stronger command smoke:
  - retry exhaustion path
  - verifier-required failure path
  - degraded readiness during unresolved retry failure
  - blocked readiness during unresolved verifier failure
  - automatic resolution commands so smoke does not leave unresolved failures behind

Success gate:

```bash
npm run typecheck -- --pretty false
frontier command smoke --json
frontier command packet <retry-failure-command-id> --json --local
frontier command final-brief <verifier-failure-command-id> --event-limit 20 --json --local
frontier command readiness --hours 24 --limit 50 --json
frontier mcp smoke --read-only --json
frontier mcp smoke --json
```

Current evidence:

- typecheck passed.
- `frontier command smoke --json` passed and proved:
  - retry exhaustion -> `failureKind=retry_exhausted`, readiness `retry_budget=warn`
  - verifier failure -> `failureKind=verifier_failed`, readiness `verification=fail`
  - both failures were later resolved by matching success commands.
- local packet for retry exhaustion returned:
  - `executionPolicy.maxAttempts=2`
  - `executionPolicy.requireVerification=false`
  - `failure.kind=retry_exhausted`
- local final brief for verifier failure returned:
  - `failure.kind=verifier_failed`
  - recovery guidance specific to verifier failure
- daemon-served readiness now includes:
  - brief summaries for verifier and retry/budget failures
  - explicit `retry_budget` and `verification` checks
- read-only MCP smoke passed against `frontierd`.

## M17 Shipped: Queue-Debt And Operator Recovery Controls

Shipped in this slice:

1. Added canonical queue-debt analysis in `src/commands/debt.ts` with stale
   queued, running, approval, and policy classification.
2. Added bounded operator actions in the command store and CLI/daemon/MCP:
   `retry`, `requeue`, `cancel`, and `resume`.
3. Readiness now distinguishes healthy in-flight work from stale queue debt:
   fresh queued/running work keeps `queue=pass`.
4. Final briefs, aggregate briefs, and native menu bar surfaces now expose
   debt/recovery state plus direct operator controls.
5. MCP smoke now proves `frontier.command_retry`,
   `frontier.command_requeue`, and `frontier.command_cancel`.

Verification:

- `npm run typecheck -- --pretty false`
- `frontier command smoke --json`
- `frontier command debt --json`
- `frontier command readiness --hours 24 --limit 50 --json`
- `frontier mcp smoke --read-only --json`
- `frontier mcp smoke --json`
- `swift build --target CompanionMenuBarApp`
- `frontier helper self-test --json`

Live state after cleanup:

- `frontierd` healthy
- `command readiness` = `ready`
- worker queue clean: `queued=0`, `running=0`, `claimableCount=0`

## M18 Shipped: Overnight Debt Automation And Operator Audit

Shipped in this slice:

1. Added overnight command-debt preflight in `src/overnight/queue.ts` with a
   bounded automation policy:
   - stale queued class-0/1 commands are auto-requeued
   - stale running class-0/1 commands are auto-requeued only when the lease is expired
   - stale approval and policy blockers remain manual attention
2. Added `preflight` payloads to overnight enqueue/run results and to
   `overnight brief`, including automated-action counts and manual debt
   attention counts.
3. Added canonical operator lineage/audit to command final briefs via
   `src/commands/operator.ts`, including source/replacement command IDs,
   last-action summary, and recent operator events.
4. Added debt/operator-aware command memory rollups so operator handoff keeps
   the recommended action, replacement linkage, and recent audit history.
5. Upgraded the macOS menu bar command panel to show operator audit details,
   replacement/source linkage, and audit counts on the selected command.

Verification:

- `npm run typecheck -- --pretty false`
- `swift build --target CompanionMenuBarApp`
- `frontier daemon health --json`
- `frontier overnight run --dry-run --json`
- synthetic stale queued command -> `frontier overnight enqueue --json`
  returned `preflight.status=remediated`, `automatedCount=1`, `staleAfter=0`
- `frontier overnight brief --hours 2 --json`
- `frontier command final-brief <stale-source-command> --event-limit 20 --json`
  returned `operator.replacementCommandId` and recent operator audit events
- `frontier command remember <commandId> --json`
- `frontier memory get --class run --namespace commands/project <commandId> --json`
- `frontier command readiness --hours 24 --limit 50 --json`

Live state after cleanup:

- `frontierd` healthy after restart
- `command readiness` = `ready`
- worker queue clean: `queued=0`, `running=0`, `claimableCount=0`

## M19 Shipped: Lane-Specific Recovery Hardening

Shipped in this slice:

1. Extended the normalized command packet with a canonical `verification`
   block in `src/commands/packet.ts`, including:
   - verifier-required state
   - failed-check counts
   - per-check `name`, `reason`, and `evidence`
2. Upgraded final-brief recovery in `src/commands/final-brief.ts` so recovery
   is lane-aware instead of generic:
   - MLX `runtime_exceeded` failures now point to `frontier mlx status` and
     `frontier mlx doctor` before retry
   - verifier failures now name the failed check and include repair hints such
     as creating the expected human-review token
   - ops `repair_launchagent` blockers now name the allowlisted service label
     and point to approval/resume plus `frontier ops status`
3. Upgraded the macOS operator panel to decode packet verification details and
   show verifier reason plus failed-check count on the selected command.
4. Preserved compatibility with existing packet/final-brief consumers by
   keeping the normalized shape additive and route-stable.

Verification:

- `npm run typecheck -- --pretty false`
- `swift build --target CompanionMenuBarApp`
- `frontier command smoke --json`
- `frontier helper self-test --json`
- `frontier daemon health --json`
- `frontier command final-brief cmd_mo97xz6l_7c6d9a30 --event-limit 20 --json`
  returned:
  - `packet.verification.required=true`
  - `packet.verification.failedChecks=1`
  - failed check `human_review` with `evidence.expectedToken`
  - recovery commands including `touch '<expectedToken>'`
- `frontier command final-brief cmd_mo8pi38o_b12e78cc --event-limit 20 --json`
  returned MLX-specific runtime-budget recovery commands:
  - `frontier mlx status --json --local`
  - `frontier mlx doctor --json --local`
- synthetic ops approval blocker:
  - `frontier command submit --intent "repair frontier daemon" --json`
  - `frontier command final-brief cmd_mo999pqn_88ee7772 --event-limit 20 --json`
    returned recovery commands for approval, resume, and ops status with label
    `com.frontier-os.frontierd`
  - `frontier command cancel cmd_mo999pqn_88ee7772 --actor m19-cleanup --json`
    removed the verification artifact from the active queue
- `frontier command readiness --hours 24 --limit 50 --json`
- `frontier command worker status --json --local`

Live state after cleanup:

- `frontierd` healthy
- `command readiness` = `ready`
- worker queue clean: `queued=0`, `running=0`, `claimableCount=0`

## M20 Shipped: Overnight Lane Rollups And Native Operator View

Shipped in this slice:

1. Added overnight queue lane rollups in `src/overnight/queue.ts`, including
   planned/queued counts, project counts, and top verbs per lane.
2. Added lane/project/verb metadata to Ghost Shift outcome events in
   `src/ghost/shift.ts` so overnight summaries can distinguish what actually
   ran from what was only planned.
3. Rebuilt `src/overnight/brief.ts` to emit:
   - `runTrend`
   - `lanes[]`
   - lane-aware manual-attention items with lane/project/verb metadata when available
4. Expanded the macOS menu bar operator panel to show overnight status, lane
   rollups, and overnight attention counts from the same canonical runtime API.

Verification:

- `npm run typecheck -- --pretty false`
- `swift build --target CompanionMenuBarApp`
- `frontier overnight brief --hours 24 --json`
- bounded live run:
  - `frontier overnight run --hours 1 --limit 1 --queue-dir /tmp/frontier-m20-queue.379NgW --graph-dir /tmp/frontier-m20-graphs.zDOGFa --json`
  - returned `status=completed`
  - `queue.laneSummary[0].lane=frontierd`
  - `shift.results[0]` carried `lane=frontierd`, `projectId=crm-analytics`, `verb=project.status`
- post-run `frontier overnight brief --hours 24 --json` returned:
  - `runTrend.runsByStatus.completed=2`
  - `lanes[0].lane=frontierd`
  - `lanes[0].planned=1`
  - `lanes[0].queued=1`
  - `lanes[0].completed=1`

Live state after cleanup:

- `frontierd` healthy
- `command readiness` = `ready`
- worker queue clean: `queued=0`, `running=0`, `claimableCount=0`
- overnight brief now has live lane rollup data from the new ledger shape

## M21 Shipped: Remaining Lane Recovery Coverage And Verifier Detail

Shipped in this slice:

1. Expanded `src/commands/final-brief.ts` so the remaining execution lanes now
   return lane-specific recovery guidance instead of falling back to generic
   failure text:
   - project
   - helper
   - browser
   - salesforce
   - overnight
2. Tightened verifier recovery so the final brief now prefers packet output
   summaries from adapter work, which means browser CDP failures and Salesforce
   org-access failures resolve to the actual root cause instead of a generic
   `artifact_schema` message.
3. Expanded the macOS menu bar selected-command view so it now shows failed
   verifier check details from the normalized packet, not just the top-level
   verifier reason and count.

Verification:

- `npm run typecheck -- --pretty false`
- `swift build --target CompanionMenuBarApp`
- isolated browser final brief:
  - `HOME=/tmp/frontier-m21-browser... frontier command final-brief cmd_mo9a2xk8_e911b6b8 --event-limit 20 --json`
  - returned recovery pointing to `127.0.0.1:9222` / CDP attach
- isolated Salesforce final brief:
  - `HOME=/tmp/frontier-m21-salesforce... frontier command final-brief cmd_mo9a2xnm_d2fb062d --event-limit 20 --json`
  - returned recovery pointing to unresolved Salesforce org access / credentials
- retained local verification for project-lane retry exhaustion and verifier
  failure final briefs from the same slice

Live state after this slice:

- live queue untouched by the isolated lane probes
- `frontierd` was not restarted in this slice
- daemon-backed final briefs will reflect the new recovery text after the next
  normal restart / kickstart

## M22 Shipped: Overnight Backfill And Additional Native Surfaces

Shipped in this slice:

1. Rebuilt `src/overnight/brief.ts` historical rollup fallback so older
   Ghost Shift outcome events now backfill lane/project/verb from the graph
   files still on disk when the original ledger payload lacked that metadata.
2. Added a dedicated macOS Notification Center surface for Frontier overnight
   attention and degraded queue health in
   `Sources/CompanionMenuBarApp/FrontierOperatorNotificationController.swift`.
3. Added a dedicated App Intent + Shortcut for overnight review in
   `Sources/CompanionAppleIntents/CompanionFrontierOvernightIntent.swift`, so
   Siri/Shortcuts can read the local Frontier overnight brief without opening
   the menu bar panel.
4. Shared the local Frontier CLI intent runner across the Apple intents target
   in `Sources/CompanionAppleIntents/FrontierIntentSupport.swift`.

Verification:

- `npm run typecheck -- --pretty false`
- `swift build --target CompanionMenuBarApp`
- `swift build --target CompanionAppleIntents`
- `frontier overnight brief --hours 120 --json`
  - older Ghost Shift events now contribute recovered lanes such as
    `salesforce`, `research`, and `project`
  - manual-attention rows now carry backfilled lane/verb metadata instead of
    dropping to null for those older events

Live state after this slice:

- `frontierd` healthy
- command readiness still `ready`
- worker queue still clean
- overnight brief returns historical lane data from the new backfill path

## M23 Shipped: Persistent Native Snapshot Surface And Legacy Demo Normalization

Shipped in this slice:

1. Added a shared `FrontierOperatorSnapshotStore` in the Apple companion
   runtime client and taught the menu bar controller to persist canonical
   readiness + overnight summary state into the shared app-group defaults after
   each refresh.
2. Added a dedicated macOS Frontier operator widget surface in
   `AppHost/CompanionWidgetExtension/Sources/CompanionWidgetBundle.swift` and a
   generated `CompanionMacWidgetExtension` host target in `project.yml`, so the
   native host now has a persistent WidgetKit surface backed by the same local
   Frontier snapshot as the menu bar panel.
3. Added the missing macOS host dependency wiring for `CompanionMLXMac` plus
   the `mlx-swift-lm` package in `project.yml`, then regenerated the host
   project so `CompanionMenuBarMacApp` can build with the new widget extension
   embedded.
4. Refined `src/overnight/brief.ts` legacy heuristics so generic demo graphs
   built from CLI nodes such as `sleep` normalize into the canonical `demo`
   lane instead of polluting long-window overnight lane rollups.

Verification:

- `npm run typecheck -- --pretty false`
- `swift build --target CompanionMenuBarApp`
- `xcodegen generate`
- `xcodebuild -skipMacroValidation -project CompanionAppleHost.xcodeproj -scheme CompanionMenuBarMacApp -destination 'platform=macOS' CODE_SIGNING_ALLOWED=NO build`
- `frontier overnight brief --hours 168 --json`
- `frontier daemon health --json`
- `frontier command readiness --hours 24 --limit 50 --json`
- `frontier command worker status --json --local`

Live state after this slice:

- `frontierd` healthy
- command readiness still `ready`
- worker queue still clean
- overnight brief no longer leaks the legacy demo proofs into a fake `sleep`
  lane

## M24 Shipped: Frontier Deep Links And Snapshot Lifecycle Hardening

Shipped in this slice:

1. Added a shared `CompanionFrontierRoute` URL contract in the Apple runtime
   client so widgets, notifications, and the menu bar host all use the same
   `companion://frontier/...` deep links for overview, overnight review, queue
   focus, and specific command selection.
2. Extended `FrontierOperatorSnapshot` with selected-command state and upgraded
   `FrontierOperatorSnapshotStore` to reload WidgetKit timelines whenever the
   snapshot changes, so the persistent macOS widget stays in sync with the
   menu bar controller instead of drifting until the next scheduled refresh.
3. Taught `FrontierCommandController` to consume Frontier deep links after a
   refresh, restore queue focus, and resolve the best command target for
   overnight review from current queue state and overnight manual-attention
   metadata.
4. Wired Frontier operator notifications and the macOS widget to those deep
   links, added snapshot staleness labeling in the widget, and bridged custom
   URL handling through the menu bar app delegate so cold-launch and warm-app
   route delivery both land in the coordinator.

Verification:

- `swift build --target CompanionMenuBarApp`
- `xcodegen generate`
- `xcodebuild -skipMacroValidation -project CompanionAppleHost.xcodeproj -scheme CompanionMenuBarMacApp -destination 'platform=macOS' CODE_SIGNING_ALLOWED=NO build`

Live state after this slice:

- native Frontier widget and notification surfaces now point at real
  `companion://frontier/...` routes
- snapshot writes now invalidate WidgetKit timelines immediately
- stale widget snapshots are labeled instead of reading as live state

## M25 Shipped: Dedicated Frontier Operator Review Window

Shipped in this slice:

1. Added a reusable `FrontierOperatorWindowController` in the macOS host so
   Frontier review no longer depends on the menu bar popover for click-through
   work from widgets or notifications.
2. Added a dedicated `FrontierOperatorReviewWindow` that renders the Frontier
   command panel in a resizable standalone macOS window with refresh control
   and larger review space for queue triage and recovery actions.
3. Added an operator-window detach affordance to the menu bar Frontier panel so
   the operator can break out of the popover into the standalone review window
   without changing command state.
4. Wired `CompanionMenuBarCoordinator` so any `companion://frontier/...` deep
   link now resolves Frontier state first and then presents the dedicated
   operator window instead of only activating the accessory app.

Verification:

- `swift build --target CompanionMenuBarApp`
- `xcodebuild -skipMacroValidation -project CompanionAppleHost.xcodeproj -scheme CompanionMenuBarMacApp -destination 'platform=macOS' CODE_SIGNING_ALLOWED=NO build`

Live state after this slice:

- Frontier deep links now open a real review window instead of relying on the
  popover
- the menu bar panel can detach into the same operator window on demand
- host build still passes with the new review-surface wiring

## M26 Shipped: Route-Aware Operator Window Controls And Native Handoff

Shipped in this slice:

1. Added direct review controls inside the dedicated `FrontierOperatorReviewWindow`
   so the operator can jump between overview, overnight review, and queue-focus
   slices without going back through the menu bar popover.
2. Added route-aware review helpers in `FrontierCommandController` so both the
   standalone review window and external route callers can consistently restore
   overview, overnight, or specific queue slices through the same Frontier
   refresh/apply path.
3. Added a macOS `Open Frontier Operator` App Intent plus App Shortcuts for
   overview, blocked, and failed review targets, backed by the shared Frontier
   route handoff store instead of duplicate local routing logic.
4. Extended the macOS app-activation bridge so route handoffs written by
   Shortcuts/App Intents are delivered into the dedicated Frontier operator
   review window on cold or warm launch.

Verification:

- `swift build --target CompanionAppleIntents`
- `swift build --target CompanionMenuBarApp`
- `xcodebuild -skipMacroValidation -project CompanionAppleHost.xcodeproj -scheme CompanionMenuBarMacApp -destination 'platform=macOS' CODE_SIGNING_ALLOWED=NO build`

Live state after this slice:

- the dedicated Frontier review window now has first-class overview,
  overnight, and queue-focus navigation
- macOS Shortcuts/App Intents can hand off directly into Frontier operator
  review targets instead of only opening the host generically
- the Apple host build still passes with the new route-handoff wiring

## M27 Shipped: Preferred Review Routing Across Widgets And Shortcuts

Shipped in this slice:

1. Added a canonical preferred-review route to `FrontierCommandController` so
   blocked, active, failed, overnight-attention, and clear states now resolve
   to one shared Frontier destination instead of each native surface making its
   own routing guess.
2. Persisted that preferred route and label into `FrontierOperatorSnapshot`,
   making the widget snapshot itself route-aware rather than only carrying raw
   counts and a selected-command shell.
3. Expanded `Open Frontier Operator` with `priority` and `selected command`
   review targets, so macOS Shortcuts/App Intents can open the best next
   Frontier review or the current selected command directly.
4. Updated the macOS Frontier widget to use the canonical preferred route for
   click-through and to surface selected-command or preferred-review context in
   the glance UI when that route is meaningful.

Verification:

- `swift build --target CompanionAppleIntents`
- `swift build --target CompanionMenuBarApp`
- `xcodebuild -skipMacroValidation -project CompanionAppleHost.xcodeproj -scheme CompanionMenuBarMacApp -destination 'platform=macOS' CODE_SIGNING_ALLOWED=NO build`

Live state after this slice:

- widget click-through now follows the same preferred Frontier review route as
  the menu bar controller and notifications
- macOS Shortcuts can open Frontier priority review or the current selected
  command directly
- the Apple host build still passes with the route-aware snapshot changes

## M28 Shipped: Expanded Selected-Command Final-Brief Surface

Shipped in this slice:

1. Extended the Apple-side `FrontierCommandDetail` mapping so the standalone
   operator surface now keeps typed route, policy, execution, verification,
   evidence, artifact, and ledger-session fields from `frontier command final-brief`
   instead of collapsing them into only counts and one-line summaries.
2. Split `FrontierCommandPanel` into compact and expanded display modes so the
   menu bar popover stays dense while the dedicated operator window can render
   richer selected-command detail without overwhelming the popover.
3. Added expanded selected-command sections for route/recovery, packet and
   verification, evidence, and activity/audit detail in the standalone
   Frontier review window, all backed by the existing final-brief path rather
   than a second custom command parser.
4. Kept the `command show` fallback working by normalizing it into the same
   Apple-side detail model when a final brief is unavailable.

Verification:

- `swift build --target CompanionAppleIntents`
- `swift build --target CompanionMenuBarApp`
- `xcodebuild -skipMacroValidation -project CompanionAppleHost.xcodeproj -scheme CompanionMenuBarMacApp -destination 'platform=macOS' CODE_SIGNING_ALLOWED=NO build`

Live state after this slice:

- the dedicated Frontier operator window now shows command-specific route,
  policy, packet, evidence, and audit detail without losing the compact menu
  bar presentation
- the Apple host build still passes with the richer final-brief mapping

## M29 Shipped: Passive Selected-Command Native Detail

Shipped in this slice:

1. Extended the shared `FrontierOperatorSnapshot` selected-command payload so
   passive native surfaces can reuse command summary, next-action, and
   verifier-reason detail without re-querying Frontier.
2. Updated the macOS operator notification path to emit command-specific queue
   alerts when the canonical preferred-review route already targets a selected
   command, instead of always sending only generic queue-health text.
3. Updated the macOS Frontier widget glance surface to show the selected
   command's passive detail line when that command is the preferred review
   target, so the widget can surface the next operator action or verifier
   reason directly.
4. Kept the route contract unchanged, so widget click-through, Notification
   Center, the menu bar popover, and the standalone operator window all still
   converge on the same canonical Frontier review target.

Verification:

- `swift build --target CompanionAppleIntents`
- `swift build --target CompanionMenuBarApp`
- `xcodebuild -skipMacroValidation -project CompanionAppleHost.xcodeproj -scheme CompanionMenuBarMacApp -destination 'platform=macOS' CODE_SIGNING_ALLOWED=NO build`

Live state after this slice:

- queue notifications can now name the current selected command and include its
  best passive recovery or verifier summary
- the macOS Frontier widget now surfaces selected-command next-step context in
  the compact glance UI when command review is the preferred target
- the Apple host build still passes with the richer passive-surface snapshot
  payload

## M30 Shipped: Native Recovery Copy and Legacy Route Backfill

Shipped in this slice:

1. Added a low-friction selected-command recovery action in the macOS operator
   surface: when a final brief exposes a recovery or recommended operator
   command, the review panel now offers a native copy action instead of making
   the operator manually select CLI text.
2. Tightened `src/overnight/brief.ts` name-based legacy inference so retained
   overnight history now recovers canonical route metadata for older
   `git-review`, `frontier_gap_overnight_build`, `self-audit`, and parallel
   demo graphs even when the original graph file is gone.
3. Fixed the fallback order for older Ghost Shift events so generic file names
   no longer outrank a more informative `graphId` when reconstructing
   historical lane/project/verb metadata.
4. Kept the preferred-review contract stable, so the richer backfill improves
   notifications, widgets, overnight attention rows, and lane rollups without
   changing the route schema.

Verification:

- `npm run typecheck -- --pretty false`
- `swift build --target CompanionMenuBarApp`
- `swift build --target CompanionAppleIntents`
- `xcodebuild -skipMacroValidation -project CompanionAppleHost.xcodeproj -scheme CompanionMenuBarMacApp -destination 'platform=macOS' CODE_SIGNING_ALLOWED=NO build`
- `frontier overnight brief --hours 168 --json`

Live state after this slice:

- the macOS operator panel can now copy the selected command's best recovery
  command directly from the native review surface
- long-window overnight history now backfills older `crm-analytics` git-review
  work into `frontierd` instead of leaking a fake `overnight` lane
- older retained `wg_ledger_self_audit_v1` events now resolve to
  `demo` / `self-audit` / `demo.self-audit` across manual-attention history

## M31 Shipped: Native Evidence Reveal and Route Audit

Shipped in this slice:

1. Added a direct evidence-reveal action to the expanded macOS operator review
   surface, so the selected command can jump straight into Finder on its
   artifact directory, work graph, or first artifact file without making the
   operator hunt through final-brief text.
2. Kept that action route-aware and command-scoped by sourcing it from the same
   selected-command final-brief detail already driving the standalone review
   window.
3. Ran a fresh 168-hour overnight history audit against the live Frontier
   ledger after the M30 backfill changes; the manual-attention set now returns
   zero null lane/verb rows, so no additional overnight heuristic patch was
   needed in this slice.

Verification:

- `swift build --target CompanionMenuBarApp`
- `swift build --target CompanionAppleIntents`
- `xcodebuild -skipMacroValidation -project CompanionAppleHost.xcodeproj -scheme CompanionMenuBarMacApp -destination 'platform=macOS' CODE_SIGNING_ALLOWED=NO build`
- `frontier command final-brief <recent-completed-command> --event-limit 20 --json`
- `frontier overnight brief --hours 168 --json`

Live state after this slice:

- the expanded operator window now has a Finder reveal path for the selected
  command's evidence
- current command final briefs still carry real evidence paths such as
  `artifactDir` and `workGraphPath`
- the live 168-hour overnight brief now audits clean on null manual-attention
  route metadata after the previous backfill work

## M32 Shipped: Direct Evidence Open

Shipped in this slice:

1. Added a direct open action to the expanded macOS operator review surface, so
   the selected command can open its exact evidence file or directory straight
   from the final-brief detail instead of stopping in Finder first.
2. Kept the action route-aware by prioritizing retained artifact files, then
   work-graph paths, then the artifact directory from the canonical selected
   command brief.
3. Re-ran the 168-hour overnight route audit after the previous history fixes;
   the live brief still returns zero null manual-attention lane/verb rows, so
   no additional overnight heuristic work was needed in this slice.

Verification:

- `swift build --target CompanionMenuBarApp`
- `swift build --target CompanionAppleIntents`
- `xcodebuild -skipMacroValidation -project CompanionAppleHost.xcodeproj -scheme CompanionMenuBarMacApp -destination 'platform=macOS' CODE_SIGNING_ALLOWED=NO build`
- `frontier command final-brief <recent-completed-command> --event-limit 20 --json`
- `frontier command readiness --hours 24 --limit 50 --json`
- `frontier overnight brief --hours 168 --json`

Live state after this slice:

- the expanded operator window now has both Finder reveal and direct-open paths
  for selected-command evidence
- live command briefs still resolve the exact open target to a retained file
  such as `graph.json`
- the live 168-hour overnight brief still audits clean on null
  manual-attention route metadata

## M33 Shipped: Terminal Handoff from Selected Command Context

Shipped in this slice:

1. Added a direct Terminal handoff action to the expanded macOS operator review
   surface, so the selected command can jump into Terminal at the right working
   directory without leaving the operator flow.
2. Kept the handoff route-aware by preferring the selected command's artifact
   directory when present, then falling back to the parent directory of the
   live evidence file or work graph already chosen by the final-brief detail.
3. Re-ran the 168-hour overnight route audit after the previous history work;
   the live brief still returns zero null manual-attention lane/verb rows, so
   no additional overnight heuristic patch was needed in this slice.

Verification:

- `swift build --target CompanionMenuBarApp`
- `swift build --target CompanionAppleIntents`
- `xcodebuild -skipMacroValidation -project CompanionAppleHost.xcodeproj -scheme CompanionMenuBarMacApp -destination 'platform=macOS' CODE_SIGNING_ALLOWED=NO build`
- `frontier command final-brief <recent-completed-command> --event-limit 20 --json`
- `frontier command readiness --hours 24 --limit 50 --json`
- `frontier overnight brief --hours 168 --json`

Live state after this slice:

- the expanded operator window now has copy, open, reveal, and Terminal
  handoff controls for the selected command's recovery/evidence path
- the live Terminal target resolves to a real command artifact directory such
  as `~/.frontier/commands/cmd_mo999ku7_507f0435`
- the live 168-hour overnight brief still audits clean on null
  manual-attention route metadata

## M34 Shipped: Direct Frontier CLI Handoff from Selected Command Review

Shipped in this slice:

1. Added a direct CLI handoff action to the expanded macOS operator review
   surface, so the selected command can launch its best Frontier follow-up in
   Terminal instead of stopping at copy-and-paste.
2. Kept the follow-up canonical by normalizing `frontier ...` recovery commands
   to the resident Frontier binary path, and by falling back to
   `command final-brief` when the selected command has no explicit recovery
   command.
3. Reused the existing route-aware tool context for the Terminal launch,
   preferring the selected command's artifact/evidence directory when present
   and otherwise falling back to `~/frontier-os`.

Verification:

- `swift build --target CompanionMenuBarApp`
- `swift build --target CompanionAppleIntents`
- `xcodebuild -skipMacroValidation -project CompanionAppleHost.xcodeproj -scheme CompanionMenuBarMacApp -destination 'platform=macOS' CODE_SIGNING_ALLOWED=NO build`
- `frontier command readiness --hours 24 --limit 50 --json`
- `frontier overnight brief --hours 168 --json`

Live state after this slice:

- the expanded operator window now has copy, run, open, reveal, and Terminal
  handoff controls for the selected command's recovery/evidence path
- the CLI handoff uses the resident Frontier binary path, so it does not depend
  on Terminal PATH state when launching a selected-command follow-up
- the live 168-hour overnight brief still audits clean on null
  manual-attention route metadata

## M35 Shipped: Native Memory Handoff from Selected Command Review

Shipped in this slice:

1. Added a one-click memory handoff action to the expanded macOS operator review
   surface, so the selected command can be written into Frontier memory without
   leaving the native review flow.
2. Reused the canonical `frontier command remember <commandId> --json --local`
   path instead of inventing a second Apple-side memory write model.
3. Kept the UI state minimal by using transient button feedback in SwiftUI while
   the actual memory side effect stays in the existing controller CLI bridge.

Verification:

- `swift build --target CompanionMenuBarApp`
- `swift build --target CompanionAppleIntents`
- `xcodebuild -skipMacroValidation -project CompanionAppleHost.xcodeproj -scheme CompanionMenuBarMacApp -destination 'platform=macOS' CODE_SIGNING_ALLOWED=NO build`
- `frontier command remember cmd_mo999ku7_507f0435 --json --local`
- `frontier memory get --class run --namespace commands/project cmd_mo999ku7_507f0435 --json`
- `frontier command readiness --hours 24 --limit 50 --json`

Live state after this slice:

- the expanded operator window now has copy, remember, run, open, reveal, and
  Terminal handoff controls for the selected command's recovery/evidence path
- native memory handoff reuses the canonical `commands/<lane>` storage path, so
  remembered command blocks stay aligned with the CLI/runbook flow
- the live command system remains `ready` with a clean worker queue

## M36 Shipped: Direct Terminal Handoff into Selected Command Memory

Shipped in this slice:

1. Added a direct Terminal handoff from the expanded macOS operator review
   surface into the selected command's remembered Frontier memory block.
2. Reused the canonical CLI path by chaining `frontier command remember` and
   `frontier memory get` with the resident Frontier binary, so the handoff works
   even when Terminal PATH state is incomplete.
3. Kept the Apple side thin by reusing the existing Terminal launcher and
   defaulting the memory handoff to the Frontier working directory instead of
   creating a second native memory browser.

Verification:

- `swift build --target CompanionMenuBarApp`
- `swift build --target CompanionAppleIntents`
- `xcodebuild -skipMacroValidation -project CompanionAppleHost.xcodeproj -scheme CompanionMenuBarMacApp -destination 'platform=macOS' CODE_SIGNING_ALLOWED=NO build`
- `frontier command remember cmd_mo999ku7_507f0435 --json --local`
- `frontier memory get --class run --namespace commands/project cmd_mo999ku7_507f0435 --json`
- `frontier command readiness --hours 24 --limit 50 --json`
- `frontier command worker status --json --local`

Live state after this slice:

- the expanded operator window now has copy, remember, memory-open, run, open,
  reveal, and Terminal handoff controls for the selected command path
- selected-command memory handoff lands on the canonical `commands/<lane>`
  block by chaining `command remember` and `memory get` in Terminal
- the live command system remains `ready` with a clean worker queue

## M37 Shipped: Direct Terminal Handoff into Selected Command Audit Trail

Shipped in this slice:

1. Added a direct Terminal handoff from the expanded macOS operator review
   surface into the selected command's audit trail.
2. Reused the canonical `frontier command events <commandId> --limit 50 --json`
   path so the handoff lands on the command-scoped ledger sessions and event
   tail instead of forcing the operator to assemble raw ledger queries.
3. Kept the Apple side thin by reusing the existing Terminal launcher and
   resident Frontier binary path rather than introducing another native audit
   detail model.

Verification:

- `swift build --target CompanionMenuBarApp`
- `swift build --target CompanionAppleIntents`
- `xcodebuild -skipMacroValidation -project CompanionAppleHost.xcodeproj -scheme CompanionMenuBarMacApp -destination 'platform=macOS' CODE_SIGNING_ALLOWED=NO build`
- `frontier command events cmd_mo999ku7_507f0435 --limit 20 --json`
- `frontier command readiness --hours 24 --limit 50 --json`
- `frontier command worker status --json --local`

Live state after this slice:

- the expanded operator window now has copy, remember, memory-open, audit-open,
  run, open, reveal, and Terminal handoff controls for the selected command path
- selected-command audit handoff lands on command-scoped sessions plus ledger
  tail via `command events`, not a raw ledger search
- the live command system remains `ready` with a clean worker queue

## M38 Shipped: Direct Terminal Handoff into Selected Command Packet

Shipped in this slice:

1. Added a direct Terminal handoff from the expanded macOS operator review
   surface into the selected command's normalized packet.
2. Reused the canonical `frontier command packet <commandId> --json` path so
   the operator can jump straight into normalized execution/result state without
   detouring through the broader final brief.
3. Kept the Apple side thin by reusing the existing Terminal launcher and
   resident Frontier binary path rather than adding another native packet view.

Verification:

- `swift build --target CompanionMenuBarApp`
- `swift build --target CompanionAppleIntents`
- `xcodebuild -skipMacroValidation -project CompanionAppleHost.xcodeproj -scheme CompanionMenuBarMacApp -destination 'platform=macOS' CODE_SIGNING_ALLOWED=NO build`
- `frontier command packet cmd_mo999ku7_507f0435 --json`
- `frontier command readiness --hours 24 --limit 50 --json`
- `frontier command worker status --json --local`

Live state after this slice:

- the expanded operator window now has copy, remember, memory-open, audit-open,
  packet-open, run, open, reveal, and Terminal handoff controls for the selected
  command path
- selected-command packet handoff lands on the canonical normalized packet
  output, distinct from the audit and memory paths
- the live command system remains `ready` with a clean worker queue

## M39 Shipped: Direct Terminal Handoff into Selected Command Final Brief

Shipped in this slice:

1. Added a dedicated Terminal handoff from the expanded macOS operator review
   surface into the selected command's canonical final brief.
2. Reused `frontier command final-brief <commandId> --event-limit 20 --json`
   with the resident Frontier binary so the operator can jump straight into the
   command narrative/result view without depending on PATH state.
3. Kept the generic run control free to prioritize recovery commands while
   still exposing a stable one-click final-brief action beside packet, audit,
   and memory handoffs.

Verification:

- `swift build --target CompanionMenuBarApp`
- `swift build --target CompanionAppleIntents`
- `xcodebuild -skipMacroValidation -project CompanionAppleHost.xcodeproj -scheme CompanionMenuBarMacApp -destination 'platform=macOS' CODE_SIGNING_ALLOWED=NO build`
- `frontier command final-brief cmd_mo999ku7_507f0435 --event-limit 20 --json`
- `frontier command readiness --hours 24 --limit 50 --json`
- `frontier command worker status --json --local`

Live state after this slice:

- the expanded operator window now has copy, remember, memory-open, audit-open,
  packet-open, final-brief-open, run, open, reveal, and Terminal handoff
  controls for the selected command path
- selected-command final-brief handoff stays distinct from the generic run
  control, which can still prioritize recovery commands
- the live command system remains `ready` with a clean worker queue

## M40 Shipped: Direct Terminal Handoff into Selected Command Artifact Index

Shipped in this slice:

1. Added a dedicated Terminal handoff from the expanded macOS operator review
   surface into the selected command's canonical artifact index.
2. Reused `frontier command artifacts <commandId> --json` with the resident
   Frontier binary so the operator can inspect retained files, artifact
   directories, and work-graph references directly from the native flow.
3. Kept the Apple layer thin by exposing the runtime's canonical artifact view
   rather than inventing another native artifact browser.

Verification:

- `swift build --target CompanionMenuBarApp`
- `swift build --target CompanionAppleIntents`
- `xcodegen generate`
- `xcodebuild -skipMacroValidation -project CompanionAppleHost.xcodeproj -scheme CompanionMenuBarMacApp -destination 'platform=macOS' CODE_SIGNING_ALLOWED=NO build`
- `frontier command artifacts cmd_mo999ku7_507f0435 --json`
- `frontier command readiness --hours 24 --limit 50 --json`
- `frontier command worker status --json --local`

Live state after this slice:

- the expanded operator window now has copy, remember, memory-open, audit-open,
  packet-open, final-brief-open, artifact-index-open, run, open, reveal, and
  Terminal handoff controls for the selected command path
- selected-command artifact inspection now has a canonical CLI path distinct
  from Finder open/reveal actions
- the live command system remains `ready` with a clean worker queue

## M41 Shipped: Direct Terminal Handoff into Selected Command Show Record

Shipped in this slice:

1. Added a dedicated Terminal handoff from the expanded macOS operator review
   surface into the selected command's raw stored command record.
2. Reused `frontier command show <commandId> --json` with the resident Frontier
   binary so the operator can inspect the canonical route, policy, plan, and
   checkpoint payload directly when the packet or final brief is too
   summarized.
3. Kept the Apple layer thin by exposing the runtime's raw command record
   instead of introducing another native debugging pane.

Verification:

- `swift build --target CompanionMenuBarApp`
- `swift build --target CompanionAppleIntents`
- `xcodegen generate`
- `xcodebuild -skipMacroValidation -project CompanionAppleHost.xcodeproj -scheme CompanionMenuBarMacApp -destination 'platform=macOS' CODE_SIGNING_ALLOWED=NO build`
- `frontier command show cmd_mo999ku7_507f0435 --json`
- `frontier command readiness --hours 24 --limit 50 --json`
- `frontier command worker status --json --local`

Live state after this slice:

- the expanded operator window now has copy, remember, memory-open, audit-open,
  packet-open, final-brief-open, artifact-index-open, raw-record-open, run,
  open, reveal, and Terminal handoff controls for the selected command path
- selected-command raw record inspection now has a canonical CLI path distinct
  from final-brief, packet, and artifact views
- the live command system remains `ready` with a clean worker queue

## M42 Shipped: Passive Selected-Command Route/Policy Context in Native Glance State

Shipped in this slice:

1. Extended the shared Frontier operator snapshot with a passive selected-command
   context line derived from canonical command data.
2. Updated the macOS widget and Notification Center summaries to surface that
   `lane / verb • policyId` context when the preferred review target is a
   specific command.
3. Kept the native surfaces thin by reusing the already-fetched selected-command
   state from the resident Frontier flow rather than adding another review pane
   or new daemon API.

Verification:

- `swift build --target CompanionMenuBarApp`
- `swift build --target CompanionAppleIntents`
- `xcodegen generate`
- `xcodebuild -skipMacroValidation -project CompanionAppleHost.xcodeproj -scheme CompanionMenuBarMacApp -destination 'platform=macOS' CODE_SIGNING_ALLOWED=NO build`
- `frontier command show cmd_mo999ku7_507f0435 --json`
- `frontier command readiness --hours 24 --limit 50 --json`
- `frontier command worker status --json --local`

Live state after this slice:

- widget and notification glance state now carry canonical selected-command
  route/policy context when a specific command is the preferred review target
- passive native selected-command detail now goes beyond summary/next-action
  without requiring the operator to reopen the full review window
- the live command system remains `ready` with a clean worker queue

## M43 Shipped: Consolidated Specialist Handoff Menu in Native Operator Window

Shipped in this slice:

1. Replaced the growing row of specialist selected-command handoff buttons in
   the expanded macOS operator view with a single overflow menu.
2. Kept the underlying canonical Frontier handoffs intact inside that menu:
   memory, audit, packet, final brief, artifact index, and raw command record.
3. Left the primary buttons first-class: recovery/run, evidence open, reveal,
   Terminal context, and operator actions still stay visible without opening a
   submenu.

Verification:

- `swift build --target CompanionMenuBarApp`
- `swift build --target CompanionAppleIntents`
- `xcodegen generate`
- `xcodebuild -skipMacroValidation -project CompanionAppleHost.xcodeproj -scheme CompanionMenuBarMacApp -destination 'platform=macOS' CODE_SIGNING_ALLOWED=NO build`
- `frontier command readiness --hours 24 --limit 50 --json`
- `frontier command worker status --json --local`

Live state after this slice:

- the expanded operator window keeps the same canonical selected-command
  handoffs, but the specialist Terminal paths now live behind one overflow menu
- the visible button row is tighter without removing any Frontier command path
- the live command system remains `ready` with a clean worker queue

## M44 Shipped: Canonical Selected-Command Context Copy Action

Shipped in this slice:

1. Added a copy action to the native selected-command overflow menu for a
   canonical command context bundle.
2. The copied bundle includes command id, intent, status, route/policy context,
   passive summary, and recovery command when available.
3. Kept the action on top of the already-fetched selected-command state instead
   of introducing another summary surface or extra runtime endpoint.

Verification:

- `swift build --target CompanionMenuBarApp`
- `swift build --target CompanionAppleIntents`
- `xcodegen generate`
- `xcodebuild -skipMacroValidation -project CompanionAppleHost.xcodeproj -scheme CompanionMenuBarMacApp -destination 'platform=macOS' CODE_SIGNING_ALLOWED=NO build`
- `frontier command show cmd_mo999ku7_507f0435 --json`
- `frontier command readiness --hours 24 --limit 50 --json`
- `frontier command worker status --json --local`

Live state after this slice:

- the expanded operator window now exposes both specialist Terminal handoffs and
  a canonical command-context copy path from the same overflow menu
- native handoff into Codex, Claude, notes, or tickets no longer requires
  opening raw JSON or manually assembling route/policy context
- the live command system remains `ready` with a clean worker queue

## M45 Shipped: Context-Aware Primary Follow-Up Copy Action

Shipped in this slice:

1. Upgraded the primary selected-command copy action so it no longer only copies
   recovery commands.
2. The button now copies the best canonical Frontier follow-up command for the
   selected command: recovery when available, otherwise the resident-binary
   `command final-brief` handoff.
3. This keeps one-click copy useful for both failed commands and completed
   commands without adding another action slot or menu.

Verification:

- `swift build --target CompanionMenuBarApp`
- `swift build --target CompanionAppleIntents`
- `xcodegen generate`
- `xcodebuild -skipMacroValidation -project CompanionAppleHost.xcodeproj -scheme CompanionMenuBarMacApp -destination 'platform=macOS' CODE_SIGNING_ALLOWED=NO build`
- `frontier command show cmd_mo999ku7_507f0435 --json`
- `frontier command readiness --hours 24 --limit 50 --json`
- `frontier command worker status --json --local`

Live state after this slice:

- the primary copy action now stays useful even when no recovery command exists
- copied follow-up commands are aligned with the same canonical action path the
  native run button uses
- the live command system remains `ready` with a clean worker queue

## M46 Shipped: State-Aware Selected-Command Action Pruning

Shipped in this slice:

1. Tightened the selected-command action row so queued/running commands stop
   showing settled review shortcuts that only make sense after execution has
   resolved.
2. The primary follow-up copy/run path now disappears for active commands and
   stays focused on recovery or final-brief review only when the command has
   actually reached a reviewable state.
3. The overflow menu now drops duplicate final-brief entries when the primary
   action already points there, and the artifact-index handoff only appears
   when canonical artifact or work-graph state exists for the command.

Verification:

- `swift build --target CompanionMenuBarApp`
- `swift build --target CompanionAppleIntents`
- `xcodegen generate`
- `xcodebuild -skipMacroValidation -project CompanionAppleHost.xcodeproj -scheme CompanionMenuBarMacApp -destination 'platform=macOS' CODE_SIGNING_ALLOWED=NO build`
- `frontier command show cmd_mo999ku7_507f0435 --json`
- `frontier command readiness --hours 24 --limit 50 --json`
- `frontier command worker status --json --local`

Live state after this slice:

- active queued/running commands no longer advertise final-brief or memory
  follow-ups before there is a settled review target
- completed or failed commands keep the same canonical follow-up paths, but the
  overflow menu now avoids duplicate review entries
- the live command system remains `ready` with a clean worker queue

## M47 Shipped: Read-Only Frontier Focus Intent

Shipped in this slice:

1. Added a read-only `Review Frontier Focus` App Intent that answers from the
   shared operator snapshot instead of opening the app or calling new runtime
   endpoints.
2. Siri and Shortcuts can now read the current selected-command focus, status,
   passive next action, and queue pressure from the same snapshot already used
   by the widget and notifications.
3. Added a matching `Frontier Focus` shortcut phrase so the passive native
   surfaces cover both visual glance state and voice/shortcut query flow.

Verification:

- `swift build --target CompanionMenuBarApp`
- `swift build --target CompanionAppleIntents`
- `xcodegen generate`
- `xcodebuild -skipMacroValidation -project CompanionAppleHost.xcodeproj -scheme CompanionMenuBarMacApp -destination 'platform=macOS' CODE_SIGNING_ALLOWED=NO build`
- `frontier command readiness --hours 24 --limit 50 --json`
- `frontier command worker status --json --local`

Live state after this slice:

- passive Frontier focus is now available through Shortcut/App Intent dialog
  without opening the operator window
- the new voice/shortcut path reuses the same selected-command snapshot already
  feeding widget and Notification Center surfaces
- the live command system remains `ready` with a clean worker queue

## M48 Shipped: Passive Selected-Command Follow-Up Guidance

Shipped in this slice:

1. Extended the shared selected-command snapshot with a canonical passive
   follow-up label derived from the same operator rules as the native review
   window.
2. The macOS widget, Notification Center review alert, and `Review Frontier
   Focus` intent now surface that follow-up label so passive native surfaces can
   tell the operator the next likely tool action.
3. Kept the change on the existing snapshot and passive surfaces instead of
   adding another Apple-side review model or runtime endpoint.

Verification:

- `swift build --target CompanionMenuBarApp`
- `swift build --target CompanionAppleIntents`
- `xcodegen generate`
- `xcodebuild -skipMacroValidation -project CompanionAppleHost.xcodeproj -scheme CompanionMenuBarMacApp -destination 'platform=macOS' CODE_SIGNING_ALLOWED=NO build`
- `frontier command readiness --hours 24 --limit 50 --json`
- `frontier command worker status --json --local`

Live state after this slice:

- widget, notification, and shortcut surfaces now carry a canonical “next”
  action label for the selected command
- passive Frontier focus stays aligned with the same operator-action rules as
  the dedicated review window
- the live command system remains `ready` with a clean worker queue

## M49 Shipped: Passive Queue-Target Detail Fidelity

Shipped in this slice:

1. Extended the shared preferred-review snapshot with a queue/route detail line
   so passive surfaces can say what the active queue pressure is when the
   preferred target is not a specific command.
2. The macOS widget, Notification Center review alert, and `Review Frontier
   Focus` intent now render that detail line instead of falling back to a
   generic queue label.
3. Kept the change on the existing snapshot and passive surfaces, with no new
   runtime endpoint or Apple-side review model.

Verification:

- `swift build --target CompanionMenuBarApp`
- `swift build --target CompanionAppleIntents`
- `xcodegen generate`
- `xcodebuild -skipMacroValidation -project CompanionAppleHost.xcodeproj -scheme CompanionMenuBarMacApp -destination 'platform=macOS' CODE_SIGNING_ALLOWED=NO build`
- `frontier command readiness --hours 24 --limit 50 --json`
- `frontier command worker status --json --local`

Live state after this slice:

- passive queue targets now say things like running/blocked/failure pressure
  instead of only naming the queue
- the widget and focus intent stay clearer when Frontier is not centered on a
  single selected command
- the live command system remains `ready` with a clean worker queue

## M50 Shipped: Scope-Aware Passive Stale-State Guidance

Shipped in this slice:

1. Added shared runtime-client helpers for snapshot age, stale detection, stale
   scope labeling, and passive refresh guidance.
2. The macOS widget and `Review Frontier Focus` intent now say what is stale
   when operator state ages out, such as `Command stale 18m ago` or `Blocked
   queue stale 22m ago`, and they tell the operator to open Frontier to
   refresh.
3. Kept the change on the existing passive surfaces and shared snapshot client,
   with no new runtime endpoint or Apple-side review surface.

Verification:

- `swift build --target CompanionMenuBarApp`
- `swift build --target CompanionAppleIntents`
- `xcodegen generate`
- `xcodebuild -skipMacroValidation -project CompanionAppleHost.xcodeproj -scheme CompanionMenuBarMacApp -destination 'platform=macOS' CODE_SIGNING_ALLOWED=NO build`
- `frontier command readiness --hours 24 --limit 50 --json`
- `frontier command worker status --json --local`

Live state after this slice:

- passive stale snapshots now identify the stale Frontier scope instead of
  showing only a generic stale label
- the widget and focus intent now include a direct refresh prompt when state is
  stale
- the live command system remains `ready` with a clean worker queue

## M51 Shipped: Truth-Preserving Refresh Prompts In Notifications

Shipped in this slice:

1. Decided not to add stale/fresh timing claims to the Notification Center lane,
   because delivered alerts can outlive the refresh cycle and drift into fake
   freshness.
2. Frontier overnight and queue review notifications now append `Open Frontier
   to refresh live state.` so the notification lane stays action-oriented
   without claiming timing it cannot keep truthful after delivery.
3. Kept the stale/fresh phrasing in the widget and focus intent, where passive
   state is rendered from the current shared snapshot instead of a persisted
   delivered alert.

Verification:

- `swift build --target CompanionMenuBarApp`
- `swift build --target CompanionAppleIntents`
- `xcodegen generate`
- `xcodebuild -skipMacroValidation -project CompanionAppleHost.xcodeproj -scheme CompanionMenuBarMacApp -destination 'platform=macOS' CODE_SIGNING_ALLOWED=NO build`
- `frontier command readiness --hours 24 --limit 50 --json`
- `frontier command worker status --json --local`

Live state after this slice:

- Frontier review notifications now stay truthful even after they sit in
  Notification Center for a while
- passive widget and focus-intent surfaces keep the richer stale/fresh phrasing
  because they render against the current shared snapshot
- the live command system remains `ready` with a clean worker queue

## Immediate Next Build Slice

Build M52:

1. Push one more passive native fidelity cut only where it improves operator
   truthfulness, likely around clearer route or queue scope in the remaining
   passive surfaces.

## M52 Shipped: Canonical Preferred-Route Labels In Passive Stale Messaging

Shipped in this slice:

1. The shared passive stale-state helper now prefers the canonical
   `preferredRoute.label` when Frontier focus is a queue, overnight review, or
   overview target, instead of falling back immediately to a coarse route
   bucket.
2. Passive widget and `Review Frontier Focus` stale messaging now names the
   actual review target more precisely, e.g. `Blocked queue stale 22m ago` or
   `Overnight review stale 17m ago`.
3. Notification Center remains freshness-neutral; this slice only tightens the
   current-snapshot surfaces that can stay truthful.

Verification:

- `swift build --target CompanionMenuBarApp`
- `swift build --target CompanionAppleIntents`
- `xcodegen generate`
- `xcodebuild -skipMacroValidation -project CompanionAppleHost.xcodeproj -scheme CompanionMenuBarMacApp -destination 'platform=macOS' CODE_SIGNING_ALLOWED=NO build`
- `frontier command readiness --hours 24 --limit 50 --json`
- `frontier command worker status --json --local`

Live state after this slice:

- passive stale-state labels now reuse the canonical preferred-review target
  name instead of a generic route bucket where that label is available
- Notification Center still avoids stale/fresh timing claims by design
- the live command system remains `ready` with a clean worker queue

## Immediate Next Build Slice

Build M53:

1. Push one more passive native fidelity cut only where it improves operator
   truthfulness, likely around remaining queue/overnight wording drift between
   passive surfaces.
2. Keep tightening the dedicated operator window around the real selected
   command state so the visible affordances stay dense but not noisy.
3. Keep auditing long-window overnight history and only patch heuristics when
   live retained data shows a real route-fidelity gap.

## M53 Shipped: Compact Passive Preferred-Route Labels

Shipped in this slice:

1. The shared Frontier operator snapshot now exposes a compact passive
   preferred-route label that strips the redundant `Frontier` prefix when the
   surface already establishes the app context.
2. The macOS widget and `Review Frontier Focus` intent now reuse that compact
   label, so they say `Blocked queue` or `Overnight review` instead of
   `Frontier blocked queue` in passive copy.
3. Frontier queue-review notifications now use the same compact label in the
   subtitle, while keeping `Frontier Queue Needs Review` as the notification
   title.

Verification:

- `swift build --target CompanionMenuBarApp`
- `swift build --target CompanionAppleIntents`
- `xcodegen generate`
- `xcodebuild -skipMacroValidation -project CompanionAppleHost.xcodeproj -scheme CompanionMenuBarMacApp -destination 'platform=macOS' CODE_SIGNING_ALLOWED=NO build`
- `frontier command readiness --hours 24 --limit 50 --json`
- `frontier command worker status --json --local`

Live state after this slice:

- passive queue and overnight labels are now tighter and more consistent across
  widget, notification, and focus-intent surfaces
- Notification Center still avoids stale/fresh timing claims by design
- the live command system remains `ready` with a clean worker queue

## Immediate Next Build Slice

Build M54:

1. Keep tightening passive surface wording only where it improves operator
   truthfulness or scanning speed, without inventing another review model.
2. Keep tightening the dedicated operator window around the real selected
   command state so the visible affordances stay dense but not noisy.
3. Keep auditing long-window overnight history and only patch heuristics when
   live retained data shows a real route-fidelity gap.

## M54 Shipped: Compact Frontier Intent Handoff Labels

Shipped in this slice:

1. `CompanionFrontierReviewTarget` now uses compact target labels like
   `Blocked queue`, `Overnight review`, and `Overview` instead of repeating the
   `Frontier` prefix in App Intent handoff copy.
2. `Open Frontier Operator` now confirms `Opening Blocked queue.` or
   `Opening Overview.` while keeping the intent title as the Frontier-branded
   context.
3. The fallback route labels for priority and selected-command handoff now also
   stay compact, so the native intent lane matches the widget, focus intent,
   and notification surfaces more closely.

Verification:

- `swift build --target CompanionMenuBarApp`
- `swift build --target CompanionAppleIntents`
- `xcodegen generate`
- `xcodebuild -skipMacroValidation -project CompanionAppleHost.xcodeproj -scheme CompanionMenuBarMacApp -destination 'platform=macOS' CODE_SIGNING_ALLOWED=NO build`
- `frontier command readiness --hours 24 --limit 50 --json`
- `frontier command worker status --json --local`

Live state after this slice:

- Frontier Shortcut/App Intent handoff copy now scans more like the passive
  widget, focus-intent, and notification surfaces
- Notification Center still avoids stale/fresh timing claims by design
- the live command system remains `ready` with a clean worker queue

## Immediate Next Build Slice

Build M55:

1. Keep tightening wording only where it improves operator truthfulness or
   scanning speed, without inventing another review model.
2. Keep tightening the dedicated operator window around the real selected
   command state so the visible affordances stay dense but not noisy.
3. Keep auditing long-window overnight history and only patch heuristics when
   live retained data shows a real route-fidelity gap.

## M55 Shipped: Humanized Frontier Intent Status Phrasing

Shipped in this slice:

1. `Review Frontier Overnight` now maps raw overnight status values like
   `attention`, `quiet`, and `remediated` into cleaner spoken/readback copy
   such as `Frontier overnight needs attention.` and `Frontier overnight was
   remediated.`
2. `Review Frontier Focus` now maps command states like `blocked_approval` and
   `blocked_policy` into operator-facing phrasing such as `Waiting on
   approval.` and `Blocked by policy.`
3. The rest of the intent dialog structure stayed the same; this slice only
   tightened wording in places where the old literal status echo was awkward.

Verification:

- `swift build --target CompanionMenuBarApp`
- `swift build --target CompanionAppleIntents`
- `xcodegen generate`
- `xcodebuild -skipMacroValidation -project CompanionAppleHost.xcodeproj -scheme CompanionMenuBarMacApp -destination 'platform=macOS' CODE_SIGNING_ALLOWED=NO build`
- `frontier command readiness --hours 24 --limit 50 --json`
- `frontier command worker status --json --local`

Live state after this slice:

- Frontier Shortcut/App Intent dialogs now read more like operator-facing
  English instead of repeating internal status identifiers
- Notification Center still avoids stale/fresh timing claims by design
- the live command system remains `ready` with a clean worker queue

## Immediate Next Build Slice

Build M56:

1. Keep tightening wording only where it improves operator truthfulness or
   scanning speed, without inventing another review model.
2. Keep tightening the dedicated operator window around the real selected
   command state so the visible affordances stay dense but not noisy.
3. Keep auditing long-window overnight history and only patch heuristics when
   live retained data shows a real route-fidelity gap.

## M56 Shipped: Humanized Steady-State Command Status Readback

Shipped in this slice:

1. `Review Frontier Focus` now maps the common steady command states into
   cleaner operator-facing readback: `Queued.`, `In progress.`, `Completed.`,
   `Failed.`, and `Canceled.`
2. The blocker-specific phrases from M55 remain in place, so approval and
   policy blockers still read as `Waiting on approval.` and `Blocked by
   policy.`
3. The intent structure stayed the same; this slice only tightened the status
   sentence where the old fallback sounded flat.

Verification:

- `swift build --target CompanionMenuBarApp`
- `swift build --target CompanionAppleIntents`
- `xcodegen generate`
- `xcodebuild -skipMacroValidation -project CompanionAppleHost.xcodeproj -scheme CompanionMenuBarMacApp -destination 'platform=macOS' CODE_SIGNING_ALLOWED=NO build`
- `frontier command readiness --hours 24 --limit 50 --json`
- `frontier command worker status --json --local`

Live state after this slice:

- Frontier focus-intent readback now sounds more like operator-facing English
  for both blocker and steady-state command statuses
- Notification Center still avoids stale/fresh timing claims by design
- the live command system remains `ready` with a clean worker queue

## Immediate Next Build Slice

Build M57:

1. Keep tightening wording only where it improves operator truthfulness or
   scanning speed, without inventing another review model.
2. Keep tightening the dedicated operator window around the real selected
   command state so the visible affordances stay dense but not noisy.
3. Keep auditing long-window overnight history and only patch heuristics when
   live retained data shows a real route-fidelity gap.

## M57 Shipped: Overnight Review Grammar And Cadence Tightening

Shipped in this slice:

1. `Review Frontier Overnight` now uses singular/plural-correct review-count
   phrasing, so it says `1 item needs review.` and `2 items need review.`
2. The Frontier overnight notification subtitle now uses the same corrected
   grammar instead of the old `1 item need review` phrasing.
3. The overnight intent now joins top-verb counts with commas for cleaner
   spoken/readback cadence.

Verification:

- `swift build --target CompanionMenuBarApp`
- `swift build --target CompanionAppleIntents`
- `xcodegen generate`
- `xcodebuild -skipMacroValidation -project CompanionAppleHost.xcodeproj -scheme CompanionMenuBarMacApp -destination 'platform=macOS' CODE_SIGNING_ALLOWED=NO build`
- `frontier command readiness --hours 24 --limit 50 --json`
- `frontier command worker status --json --local`

Live state after this slice:

- overnight Shortcut/App Intent and notification wording is now grammatically
  correct for both singular and plural review counts
- Notification Center still avoids stale/fresh timing claims by design
- the live command system remains `ready` with a clean worker queue

## Immediate Next Build Slice

Build M58:

1. Keep tightening wording only where it improves operator truthfulness or
   scanning speed, without inventing another review model.
2. Keep tightening the dedicated operator window around the real selected
   command state so the visible affordances stay dense but not noisy.
3. Keep auditing long-window overnight history and only patch heuristics when
   live retained data shows a real route-fidelity gap.

## M58 Shipped: Tighter Frontier Focus-Intent Framing

Shipped in this slice:

1. `Review Frontier Focus` now leads with `Frontier focus: …` instead of the
   longer `Current Frontier focus is …` framing.
2. The empty-state refresh copy is shorter, and the command-debt fallback now
   says `Command debt still needs review.` instead of the longer operator-review
   phrasing.
3. This slice only tightened readback wording; it did not change routing,
   prioritization, or the underlying Frontier state.

Verification:

- `swift build --target CompanionMenuBarApp`
- `swift build --target CompanionAppleIntents`
- `xcodegen generate`
- `xcodebuild -skipMacroValidation -project CompanionAppleHost.xcodeproj -scheme CompanionMenuBarMacApp -destination 'platform=macOS' CODE_SIGNING_ALLOWED=NO build`
- `frontier command readiness --hours 24 --limit 50 --json`
- `frontier command worker status --json --local`

Live state after this slice:

- Frontier focus-intent readback reaches the actionable content faster
- Notification Center still avoids stale/fresh timing claims by design
- the live command system remains `ready` with a clean worker queue

## Immediate Next Build Slice

Build M59:

1. Keep tightening wording only where it improves operator truthfulness or
   scanning speed, without inventing another review model.
2. Keep tightening the dedicated operator window around the real selected
   command state so the visible affordances stay dense but not noisy.
3. Keep auditing long-window overnight history and only patch heuristics when
   live retained data shows a real route-fidelity gap.

## M59 Shipped: Unified `Open Frontier` Intent Fallback Copy

Shipped in this slice:

1. `Review Frontier Overnight` failure fallback now says `Open Frontier to
   inspect live state.` instead of referring to the menu bar app directly.
2. `Review Frontier Focus` empty-state fallback now says `Open Frontier to
   refresh local state.` instead of `Open the menu bar app …`.
3. This keeps the intent lane aligned with the widget, notification, and stale
   snapshot copy that already points the operator back to Frontier by name.

Verification:

- `swift build --target CompanionMenuBarApp`
- `swift build --target CompanionAppleIntents`
- `xcodegen generate`
- `xcodebuild -skipMacroValidation -project CompanionAppleHost.xcodeproj -scheme CompanionMenuBarMacApp -destination 'platform=macOS' CODE_SIGNING_ALLOWED=NO build`
- `frontier command readiness --hours 24 --limit 50 --json`
- `frontier command worker status --json --local`

Live state after this slice:

- Frontier intent fallback copy now uses one consistent `Open Frontier …`
  call to action across passive and active native surfaces
- Notification Center still avoids stale/fresh timing claims by design
- the live command system remains `ready` with a clean worker queue

## Immediate Next Build Slice

Build M60:

1. Keep tightening wording only where it improves operator truthfulness or
   scanning speed, without inventing another review model.
2. Keep tightening the dedicated operator window around the real selected
   command state so the visible affordances stay dense but not noisy.
3. Keep auditing long-window overnight history and only patch heuristics when
   live retained data shows a real route-fidelity gap.

## M60 Shipped: Explicit Queue Context In Focus-Intent Summaries

Shipped in this slice:

1. `Review Frontier Focus` now prefixes queue pressure with `Queue:` so the
   spoken/readback summary is self-labeling.
2. The underlying counts and ordering did not change; this slice only made the
   queue-attention sentence easier to parse in the middle of the full dialog.
3. This keeps the focus intent aligned with the broader native operator goal of
   dense but unambiguous passive summaries.

Verification:

- `swift build --target CompanionMenuBarApp`
- `swift build --target CompanionAppleIntents`
- `xcodegen generate`
- `xcodebuild -skipMacroValidation -project CompanionAppleHost.xcodeproj -scheme CompanionMenuBarMacApp -destination 'platform=macOS' CODE_SIGNING_ALLOWED=NO build`
- `frontier command readiness --hours 24 --limit 50 --json`
- `frontier command worker status --json --local`

Live state after this slice:

- Frontier focus-intent queue pressure is now explicitly labeled instead of
  appearing as a bare count list
- Notification Center still avoids stale/fresh timing claims by design
- the live command system remains `ready` with a clean worker queue

## Immediate Next Build Slice

Build M63:

1. Keep tightening wording only where it improves operator truthfulness or
   scanning speed, without inventing another review model.
2. Keep tightening the dedicated operator window around the real selected
   command state so the visible affordances stay dense but not noisy.
3. Keep auditing long-window overnight history and only patch heuristics when
   live retained data shows a real route-fidelity gap.

## M61 Shipped: Humanized Passive Selected-Command Status Copy

Shipped in this slice:

1. The shared runtime snapshot model now exposes a canonical humanized
   selected-command status label for passive native surfaces.
2. The macOS widget now reuses that label, so selected-command glance state
   says `Waiting on approval` or `Blocked by policy` instead of exposing raw
   stored status strings.
3. Notification Center review alerts now use the same label, keeping the
   selected-command passive wording aligned across the main passive surfaces.

Verification:

- `swift build --target CompanionMenuBarApp`
- `swift build --target CompanionAppleIntents`
- `xcodegen generate`
- `xcodebuild -skipMacroValidation -project CompanionAppleHost.xcodeproj -scheme CompanionMenuBarMacApp -destination 'platform=macOS' CODE_SIGNING_ALLOWED=NO build`
- `frontier command readiness --hours 24 --limit 50 --json`
- `frontier command worker status --json --local`

Live state after this slice:

- passive selected-command status copy is now humanized across the macOS widget
  and Notification Center review alerts
- Frontier intent and passive surfaces now share the same approval/policy
  wording instead of diverging
- the live command system remains `ready` with a clean worker queue

## M62 Shipped: Unified Legacy Frontier Entry-Point Copy

Shipped in this slice:

1. The Frontier command-intent failure fallback now says `Open Frontier to
   review.` instead of pointing at the menu bar app by implementation detail.
2. The macOS widget empty state now says `Open Frontier to refresh local
   state.` instead of `Open the macOS companion to refresh Frontier state.`
3. This removes the last remaining entry-point wording drift across the native
   passive and App Intent Frontier surfaces.

Verification:

- `swift build --target CompanionMenuBarApp`
- `swift build --target CompanionAppleIntents`
- `xcodegen generate`
- `xcodebuild -skipMacroValidation -project CompanionAppleHost.xcodeproj -scheme CompanionMenuBarMacApp -destination 'platform=macOS' CODE_SIGNING_ALLOWED=NO build`
- `frontier command readiness --hours 24 --limit 50 --json`
- `frontier command worker status --json --local`

Live state after this slice:

- widget empty-state and command-intent failure copy now both use the same
  `Open Frontier …` entry-point language as the rest of the Frontier surfaces
- Frontier native surfaces no longer reference the menu bar app or macOS
  companion when they only need to point the operator back to Frontier
- the live command system remains `ready` with a clean worker queue

## M63 Shipped: Aligned Snapshot-Empty And Passive Stale-Refresh Copy

Shipped in this slice:

1. The macOS widget unavailable state now says `No Frontier snapshot yet.`
   instead of `No operator snapshot yet.`
2. The shared passive stale call to action now says `Open Frontier to refresh
   local state.` instead of the looser `Open Frontier to refresh.`
3. This keeps the widget and `Review Frontier Focus` stale/empty copy on the
   same `Frontier` and `local state` wording.

Verification:

- `swift build --target CompanionMenuBarApp`
- `swift build --target CompanionAppleIntents`
- `xcodegen generate`
- `xcodebuild -skipMacroValidation -project CompanionAppleHost.xcodeproj -scheme CompanionMenuBarMacApp -destination 'platform=macOS' CODE_SIGNING_ALLOWED=NO build`
- `frontier command readiness --hours 24 --limit 50 --json`
- `frontier command worker status --json --local`

Live state after this slice:

- the widget unavailable state now matches the rest of the Frontier snapshot
  wording
- passive stale prompts now explicitly say `refresh local state` instead of
  the shorter but less specific `refresh`
- the live command system remains `ready` with a clean worker queue

## M64 Shipped: Tighter Empty-State Focus Wording

Shipped in this slice:

1. `Review Frontier Focus` now says `No Frontier focus is set.` instead of the
   more indirect `No Frontier review target is set.`
2. This keeps the empty-state wording aligned with the intent’s own `Frontier
   focus: …` framing.
3. No routing or behavior changed; this slice only tightened the passive
   spoken/readback copy.

Verification:

- `swift build --target CompanionMenuBarApp`
- `swift build --target CompanionAppleIntents`
- `xcodegen generate`
- `xcodebuild -skipMacroValidation -project CompanionAppleHost.xcodeproj -scheme CompanionMenuBarMacApp -destination 'platform=macOS' CODE_SIGNING_ALLOWED=NO build`
- `frontier command readiness --hours 24 --limit 50 --json`
- `frontier command worker status --json --local`

Live state after this slice:

- the focus intent empty-state copy now uses the same `focus` language as the
  rest of the surface
- the live command system remains `ready` with a clean worker queue

## M65 Shipped: Tighter Passive Notification Fallback Wording

Shipped in this slice:

1. The queue/command review notification fallback body now says `Frontier
   review is required.` instead of the looser `Operator review is required.`
2. This keeps the passive notification lane on the same `Frontier` naming used
   by the intent, widget, and operator-window surfaces.
3. No notification routing or timing behavior changed; this slice only
   tightened the fallback copy.

Verification:

- `swift build --target CompanionMenuBarApp`
- `swift build --target CompanionAppleIntents`
- `xcodegen generate`
- `xcodebuild -skipMacroValidation -project CompanionAppleHost.xcodeproj -scheme CompanionMenuBarMacApp -destination 'platform=macOS' CODE_SIGNING_ALLOWED=NO build`
- `frontier command readiness --hours 24 --limit 50 --json`
- `frontier command worker status --json --local`

Live state after this slice:

- passive notification fallback copy now stays on `Frontier` language even
  when the review alert has no richer body text
- the live command system remains `ready` with a clean worker queue

## M66 Shipped: Tighter Overnight-Failure Intent Fallback Wording

Shipped in this slice:

1. `Review Frontier Overnight` now says `Open Frontier to refresh live state.`
   when its local brief read fails instead of the older `inspect live state`
   phrasing.
2. This keeps the overnight intent on the same truth-preserving `Open
   Frontier … refresh live state` language already used by the passive
   notification lane.
3. No routing or runtime behavior changed; this slice only tightened the
   fallback copy.

Verification:

- `swift build --target CompanionMenuBarApp`
- `swift build --target CompanionAppleIntents`
- `xcodegen generate`
- `xcodebuild -skipMacroValidation -project CompanionAppleHost.xcodeproj -scheme CompanionMenuBarMacApp -destination 'platform=macOS' CODE_SIGNING_ALLOWED=NO build`
- `frontier command readiness --hours 24 --limit 50 --json`
- `frontier command worker status --json --local`

Live state after this slice:

- the overnight intent failure fallback now matches the passive notification
  lane on `refresh live state` wording
- the live command system remains `ready` with a clean worker queue

## M67 Shipped: Tighter Frontier App Intent Metadata Wording

Shipped in this slice:

1. The Frontier App Intent descriptions now drop redundant `operator` /
   `macOS` wording where the intent title already carries that context.
2. `Review Frontier Overnight`, `Review Frontier Focus`, and `Open Frontier
   Operator` now describe the same review targets with less noise.
3. No runtime wording, routing, or behavior changed; this slice only tightens
   App Intent metadata copy.

Verification:

- `swift build --target CompanionMenuBarApp`
- `swift build --target CompanionAppleIntents`
- `xcodegen generate`
- `xcodebuild -skipMacroValidation -project CompanionAppleHost.xcodeproj -scheme CompanionMenuBarMacApp -destination 'platform=macOS' CODE_SIGNING_ALLOWED=NO build`
- `frontier command readiness --hours 24 --limit 50 --json`
- `frontier command worker status --json --local`

Live state after this slice:

- Frontier App Intent metadata now describes overnight/focus/operator review
  targets with less repetition
- the live command system remains `ready` with a clean worker queue

## M68 Shipped: Tighter Frontier App Intent Noun Phrasing

Shipped in this slice:

1. The Frontier App Intent descriptions now use cleaner nouns for the same
   review surfaces: `attention items`, `command`, and `specific target`.
2. This removes the last awkward metadata phrases like `manual attention` and
   `specific review target` without changing what the intents expose.
3. No runtime wording, routing, or behavior changed; this slice only tightens
   App Intent metadata copy.

Verification:

- `swift build --target CompanionMenuBarApp`
- `swift build --target CompanionAppleIntents`
- `xcodegen generate`
- `xcodebuild -skipMacroValidation -project CompanionAppleHost.xcodeproj -scheme CompanionMenuBarMacApp -destination 'platform=macOS' CODE_SIGNING_ALLOWED=NO build`
- `frontier command readiness --hours 24 --limit 50 --json`
- `frontier command worker status --json --local`

Live state after this slice:

- Frontier App Intent metadata now uses cleaner nouns for overnight/focus/open
  descriptions
- the live command system remains `ready` with a clean worker queue

## M69 Shipped: Tighter Frontier Review-Target Enum Wording

Shipped in this slice:

1. The Frontier review-target enum subtitles now drop redundant `Frontier`
   wording where the enum already supplies that context.
2. The open-intent readback now says `Done queue` instead of `Completed queue`,
   matching the passive route labels used elsewhere in the native surfaces.
3. No routing or behavior changed; this slice only tightens App Intent
   metadata and open-intent wording.

Verification:

- `swift build --target CompanionMenuBarApp`
- `swift build --target CompanionAppleIntents`
- `xcodegen generate`
- `xcodebuild -skipMacroValidation -project CompanionAppleHost.xcodeproj -scheme CompanionMenuBarMacApp -destination 'platform=macOS' CODE_SIGNING_ALLOWED=NO build`
- `frontier command readiness --hours 24 --limit 50 --json`
- `frontier command worker status --json --local`

Live state after this slice:

- Frontier review-target metadata now scans faster in App Intent pickers and
  aligns `Done queue` with the passive route labels
- the live command system remains `ready` with a clean worker queue

## Success Definition for the Full Root-Level Orchestrator

The system is "root-level orchestrator v1 complete" when all of this is true:

- Any surface can submit the same command envelope.
- The system can classify and explain route/policy before execution.
- Class 0/1 commands run without babysitting.
- Class 2 commands pause, show in Jarvis/Siri/CLI, and resume after approval.
- Class 3 commands deny by default with clear reasons.
- A resident worker can drain safe commands.
- Every action writes command-scoped ledger evidence.
- Every command has a final brief.
- Jarvis shows now/queue/blocked/done.
- The helper remains narrow and cannot run arbitrary root commands.
- At least these lanes work end-to-end:
  - project verify/smoke
  - ops status/repair dry-run
  - MLX status/smoke/benchmark
  - overnight safe queue
  - helper status/launchd status
  - approval approve/resume

## Relationship to Existing Plans

This master plan sits above the existing track plans:

- `eight-hour-root-router-build.md` covers the substrate sprint.
- `root-router-8h-result.md` and `root-router-next-result.md` record shipped lower-level capability.
- `project-registry.md` covers managed project inventory.
- `policy-ledger.md` covers action classification and approvals.
- `privileged-helper.md` covers root helper boundaries.
- `mcp-bridge.md` covers agent tool exposure.
- `siri-menubar.md` covers native surfaces.
- `ghost-shift.md` covers safe queued execution.

The remaining connective tissue is richer persistent native operator surfaces,
deeper historical inference polish, and continued execution-lane maturity.
