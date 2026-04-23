# Frontier OS

Personal control plane for multi-agent overnight autonomy. The Orchestrator
component — SQLite ledger at `~/.frontier/ledger.db`, Ghost Shift queue,
watcher runtime, adapter registry, Kahn-scheduled work-graph executor.

Sibling components under the Frontier OS umbrella:

- **Siri Gateway** — `~/code/platform/companion-platform/` (HTTP API on `:8765`, iOS Shortcuts backend, reads this ledger via `runtime/frontier_ledger.py`)
- **Brain** — `~/code/apps/SIRI/aegis/` (memory / RAG, FastAPI on `:8742`)
- **Voice** — `~/code/platform/nexus/` (mlx-whisper + Silero + Kokoro + Ollama)
- **Menubar** — `~/code/apps/jarvis-menubar/` (Swift native menubar, reads this ledger direct-SQLite)

See `docs/frontier-consolidation-design.md` for the consolidation plan and
`docs/plans/` for the active gap-closure execution tracks.

---

Initial architecture assets:

- `../frontier-os-v1.md`: high-level product and system thesis
- `current-assets.md`: inventory of real built assets already on disk
- `docs/repo-blueprint.md`: concrete repo structure and implementation order
- `docs/plans/`: active plans for project registry, `frontierd`, MCP bridge,
  privileged helper, policy/ledger, ops readiness, and Siri/menubar integration
- `docs/system-map.md`: system-by-system adapter map for the personal AI OS
- `contracts/jarvis-intent-catalog.md`: mapping from current Jarvis assets to canonical Frontier intents
- `contracts/cli-surface.md`: CLI-first command surface for orchestration and operators
- `contracts/adapter-contract.md`: semantic adapter lifecycle and JSON I/O rules
- `contracts/watcher-contract.md`: always-on watcher model and alert loop
- `schemas/intent-envelope.schema.json`: versioned envelope for requests across CLI, Apple, and web surfaces
- `schemas/work-graph.schema.json`: machine-readable contract for orchestrated work
- `schemas/adapter-manifest.schema.json`: adapter registry contract
- `schemas/project-manifest.schema.json`: project registry contract
- `schemas/adapter-invocation.schema.json`: runtime request envelope for adapters
- `schemas/adapter-result.schema.json`: normalized adapter response envelope
- `schemas/watcher-spec.schema.json`: durable watcher configuration
- `schemas/alert-event.schema.json`: alert and escalation envelope
- `schemas/memory-record.schema.json`: memory writeback contract
- `schemas/policy-pack.schema.json`: approvals, spend, and kill-switch policy
- `schemas/model-routing-policy.schema.json`: Codex/Claude/local-model routing rules
- `manifests/adapters/`: starter manifests for the first control-plane adapters
- `manifests/projects/`: initial managed-project registry for `frontier project *`
- `manifests/watchers/`: starter manifests for the first always-on watchers
- `examples/`: concrete policy, routing, and work graph examples

This directory should become the nucleus of the product's control-plane contracts:

- work graph schemas
- approval policies
- verifier interfaces
- runtime adapter contracts
- trace and artifact models

Near-term implementation focus:

- `browser`: active-session Chrome/Atlas control via CDP
- `salesforce`: browser-backed semantic wrapper for Lightning and dashboards
- `watchers`: overnight review, work radar, and RunPod idle killer
- `memory`: structured writeback for what worked, what failed, and what transfers

Read-only operator commands:

```text
frontier project list --json
frontier project inspect frontier-os --json
frontier project status --json
frontier project next frontier-os --json
frontier project repair frontier-os --dry-run --json
frontier project verify frontier-os --json
frontier project smoke frontier-os --json
frontier ops status --json
frontier daemon run --foreground
frontier daemon print-plist --json
frontier daemon install-user-agent --dry-run --json
frontier daemon status --json
frontier daemon health --json
frontier daemon stop
frontier policy simulate --verb service.restart --project frontier-os --json
frontier mcp config --agent codex --json
frontier mcp smoke --read-only --json
frontier helper build --json
frontier helper install --dry-run --json
frontier helper install --apply --json
frontier helper production-status --json
frontier helper status --json
frontier helper self-test --json
frontier client status --json
frontier overnight plan --hours 8 --json
frontier overnight enqueue --hours 8 --dry-run --json
frontier overnight run --hours 8 --dry-run --json
frontier overnight brief --hours 24 --json
frontier overnight smoke --json
frontier route explain --verb project.status --project frontier-os --json
frontier ops repair-launchagent com.frontier-os.ghost-shift --json
frontier approval list --json
frontier approval approve <trace-id> --ttl 15m --json
frontier ops repair-launchagent com.frontier-os.ghost-shift --execute --trace-id <trace> --consume-token --json
```

Project manifests declare verify/smoke commands and the project runner executes
them after policy evaluation. `frontierd` is a user-level Unix-socket daemon;
its LaunchAgent install command writes only a user agent and returns the exact
`launchctl` bootstrap/bootout commands for explicit operator control.
Project `next`/`repair` and `overnight plan` are dry-run planning surfaces:
they rank safe gates, dirty-worktree review, missing-root inspection, and
unhealthy required-service diagnostics without launching or restarting anything.
`overnight enqueue` compiles scheduled class 0/1 actions into Ghost Shift
work-graph JSON. `overnight run` uses a run-scoped Ghost Shift queue so it does
not drain unrelated queued work. `overnight brief` summarizes recent overnight
runs, Ghost Shift outcomes, manual-attention items, per-lane rollups, and
recent run/shift trend counts.
`ops repair-launchagent` is the first narrow class-2 repair verb. It only
targets Frontier-known user LaunchAgents, defaults to dry-run, lints the plist,
and requires a one-shot approval token before `launchctl bootstrap` or
`launchctl kickstart`.
`approval list` exposes pending approval traces with UI-ready approve and
consume actions. `client status`, `/v1/approvals`, and MCP expose the same queue
for Siri and menubar clients.
Policy, MCP, helper, and route commands are wired to the same deny-by-default
root-router boundary; the production helper exposes fixed read-only verbs, not
an arbitrary root shell.
