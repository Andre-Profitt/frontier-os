# 8-Hour Root-Level Router Build Plan

Status: execution lane shipped through route explain; final gates passing
Date: 2026-04-21

## Goal

Move Frontier OS from a partial root-level routing substrate to an 80-90% usable local control plane in one uninterrupted 8-hour work block.

This does not mean "give agents an arbitrary root shell." It means:

- agents route through `frontierd`, not raw shell discovery
- policy classifies every action before execution
- root-level capability exists only through a narrow helper allowlist
- every action is ledgered with evidence
- Codex/Claude can call high-level Frontier tools through MCP
- the system can manage its own project, daemon, watcher, and helper health

## Starting Point

Already shipped:

- Project registry: `frontier project list|inspect|status`.
- Ops readiness: `frontier ops status`.
- `frontierd` M1 foreground Unix-socket API.
- Ledger-backed daemon events: `daemon.start`, `daemon.stop`, `daemon.health`, `daemon.request`.
- Ghost Shift and work graph runner.
- MLX shared workbench.

Current estimated completion:

- user-space control plane: 70-75%
- root-level router: 35-40%

Target after the 8-hour block:

- user-space control plane: 90%+
- root-level router: 80-90%

## Definition of 80-90% Done

The root-level router is 80-90% done when these commands pass:

```bash
npm run typecheck
/Users/test/frontier-os/bin/frontier project status --json
/Users/test/frontier-os/bin/frontier ops status --json
/Users/test/frontier-os/bin/frontier daemon status --json
/Users/test/frontier-os/bin/frontier mcp smoke --read-only --json
/Users/test/frontier-os/bin/frontier policy simulate --verb service.restart --project frontier-os --json
/Users/test/frontier-os/bin/frontier helper status --json
/Users/test/frontier-os/bin/frontier helper self-test --json
```

And these properties are true:

- `frontierd` has a user LaunchAgent plist and can be run as a resident user daemon.
- MCP exposes read-only status tools.
- Policy evaluation runs before MCP/work/helper side effects.
- The helper can answer status/read-only introspection.
- Class-2 helper verbs require one-shot approval tokens.
- Class-3 requests are denied by default and denial tests prove it.
- No arbitrary root shell exists.

Current run status: T2 residency, T5 policy, T3 read-only MCP, T4 helper simulator, and route explain are shipped. Final acceptance gates are passing as of the April 21, 2026 run.

## 8-Hour Flow

### Hour 0.0-0.5: Baseline and Guardrails

Objective: start from a known-good state and keep the build reversible.

Tasks:

- Run `npm run typecheck`.
- Run `frontier project status --json`.
- Run `frontier ops status --json`.
- Run `frontier daemon status --json`.
- Write one ledger event marking the 8-hour build start.
- Confirm no root helper is currently installed or running.

Success gate:

```bash
/Users/test/frontier-os/bin/frontier ledger log --agent codex --kind agent.session_start --session root-router-8h
```

Fallback:

- If baseline fails, fix only the failing current-state gate before moving forward.

### Hour 0.5-1.5: `frontierd` Residency

Objective: make the user-level daemon a real resident service without touching root.

Tasks:

- Add `frontier daemon install-user-agent --dry-run`.
- Add `frontier daemon install-user-agent`.
- Generate `~/Library/LaunchAgents/com.frontier-os.frontierd.plist`.
- Add log paths under `~/Library/Logs/frontier-os/frontierd.*.log`.
- Add `frontier daemon print-plist`.
- Keep load/bootstrap as an explicit operator command, not automatic.

Success gates:

```bash
/Users/test/frontier-os/bin/frontier daemon install-user-agent --dry-run --json
/Users/test/frontier-os/bin/frontier daemon print-plist --json
/Users/test/frontier-os/bin/frontier daemon run --foreground --socket /tmp/frontierd.sock
/Users/test/frontier-os/bin/frontier daemon health --socket /tmp/frontierd.sock
```

Fallback:

- If launchd plist generation is blocked, ship foreground daemon plus exact plist artifact and defer loading.

### Hour 1.5-2.75: Policy Core

Objective: centralize action classification before enabling helper verbs.

Tasks:

- Add action envelope type: actor, source, projectId, verb, arguments, approvalClass, sideEffects, traceId.
- Add `frontier policy simulate`.
- Add `frontier policy evaluate`.
- Add one-shot approval tokens:
  - `frontier policy approve --trace-id <id> --ttl 15m`
  - `frontier policy consume --trace-id <id>`
- Move terminal/work/helper/MCP classifications toward the same evaluator.

Success gates:

```bash
/Users/test/frontier-os/bin/frontier policy simulate --verb project.status --project frontier-os --json
/Users/test/frontier-os/bin/frontier policy simulate --verb service.restart --project frontier-os --json
/Users/test/frontier-os/bin/frontier policy approve --trace-id root-router-smoke --ttl 15m --json
/Users/test/frontier-os/bin/frontier policy consume --trace-id root-router-smoke --json
```

Fallback:

- If full token lifecycle is too large, ship `simulate/evaluate` first and keep helper side effects disabled.

### Hour 2.75-4.0: MCP Bridge

Objective: let agents call Frontier verbs directly.

Tasks:

- Add `frontier mcp run`.
- Add `frontier mcp smoke`.
- Implement read-only tools:
  - `frontier.project_list`
  - `frontier.project_status`
  - `frontier.ops_status`
  - `frontier.ledger_recent`
  - `frontier.watcher_status`
  - `frontier.ghost_status`
  - `frontier.approval_list`
- Route through `frontierd` when available and fall back to local functions when unavailable.
- Ledger MCP requests/responses.

Success gates:

```bash
/Users/test/frontier-os/bin/frontier mcp smoke --read-only --json
/Users/test/frontier-os/bin/frontier ledger search --kind mcp.request --limit 5
```

Fallback:

- If stdio MCP server shape is too large, ship `frontier mcp smoke` plus the tool schema registry and leave server loop as the next small patch.

### Hour 4.0-5.5: Helper M1/M2

Objective: create the root-level helper path without opening a backdoor.

Tasks:

- Add helper source under `helpers/frontier-helper/`.
- Add LaunchDaemon plist template only.
- Add user CLI:
  - `frontier helper status`
  - `frontier helper invoke helper.status`
  - `frontier helper invoke launchd.status`
  - `frontier helper invoke logs.read`
  - `frontier helper invoke network.status`
- Use a fixed verb allowlist.
- Add request/response schemas.
- Ledger helper requests, allowed responses, denials, and results.

Success gates:

```bash
/Users/test/frontier-os/bin/frontier helper status --json
/Users/test/frontier-os/bin/frontier helper invoke helper.status --json
/Users/test/frontier-os/bin/frontier helper invoke launchd.status --label com.frontier-os.frontierd --json
```

Fallback:

- If LaunchDaemon install is not appropriate during the block, ship a foreground helper simulator plus plist/template/self-test. Do not fake root.

### Hour 5.5-6.5: Helper M3 Controlled Verbs

Objective: add the minimum useful controlled root actions behind policy.

Tasks:

- Add class-2 verbs:
  - `launchd.load`
  - `launchd.unload`
  - `service.restart`
  - `port.kill`
  - `fs.fixOwnership`
- Restrict all verbs to allowlisted labels, roots, and ports.
- Require consumed one-shot approval tokens.
- Return exact denial reasons.

Success gates:

```bash
/Users/test/frontier-os/bin/frontier policy simulate --verb service.restart --project frontier-os --json
/Users/test/frontier-os/bin/frontier helper self-test --json
```

Fallback:

- If controlled verbs need more hardening, leave them implemented but disabled behind `FRONTIER_HELPER_ENABLE_CLASS2=1`.

### Hour 6.5-7.25: Routing Integration

Objective: connect the pieces so the router chooses the right execution lane.

Tasks:

- Add `frontier route explain`.
- Route read-only status to daemon/MCP.
- Route project verify/smoke to user-space runner.
- Route service/system verbs to helper only after policy approval.
- Add `servedBy` metadata to project/ops status when daemon-backed.

Success gates:

```bash
/Users/test/frontier-os/bin/frontier route explain --verb project.status --project frontier-os --json
/Users/test/frontier-os/bin/frontier route explain --verb service.restart --project frontier-os --json
```

Fallback:

- If routing needs more design, ship route explain only and keep actual CLI commands on current paths.

### Hour 7.25-8.0: End-to-End Smoke and Handoff

Objective: prove the system is materially closer to the target and leave the next block obvious.

Tasks:

- Run all root-router gates.
- Run helper denial tests.
- Run MCP smoke.
- Run daemon smoke.
- Update plan statuses.
- Write `docs/plans/root-router-8h-result.md`.
- Write a ledger summary event.

Success gates:

```bash
npm run typecheck
/Users/test/frontier-os/bin/frontier daemon health --json
/Users/test/frontier-os/bin/frontier mcp smoke --read-only --json
/Users/test/frontier-os/bin/frontier policy simulate --verb service.restart --project frontier-os --json
/Users/test/frontier-os/bin/frontier helper self-test --json
```

## Work Discipline

- Keep one active implementation lane at a time.
- Every hour ends with at least one passing command or a concrete blocker.
- Prefer foreground/smokeable services before LaunchAgent/LaunchDaemon loading.
- Do not build duplicate daemons or helper runtimes.
- Do not add arbitrary shell execution.
- Do not weaken CRM Analytics CLI-only rules.
- Do not auto-run destructive or billable actions.

## What Is Explicitly Out of Scope

- Arbitrary root shell.
- Full filesystem control outside allowlisted roots.
- Package installs through the helper.
- Automatic external messages.
- Production deploys.
- Force-pushes or repository cleanup.
- Renaming/moving major projects.

## Expected State After 8 Hours

| Capability | Target |
| --- | --- |
| Project inventory | Complete initial registry, status, verify/smoke declarations. |
| Ops visibility | LaunchAgents, logs, watchers, scheduler, Ghost Shift, MLX process view. |
| Daemon | User-level resident-ready `frontierd` with health/status APIs. |
| MCP | Read-only agent tools and smoke test. |
| Policy | Shared evaluator and one-shot approvals. |
| Helper | Status/read-only helper plus denied-by-default class-3 self-tests. |
| Controlled side effects | Minimal class-2 verbs behind policy, or disabled behind a feature flag if hardening is incomplete. |
| Ledger | Daemon, MCP, policy, helper evidence logged. |

## Residual 10-20%

The remaining work after this block should be:

- hardening the privileged helper installer
- full LaunchDaemon lifecycle tests
- deeper Keychain secret resolver
- Siri/menubar UI polish
- broader project-specific verify/smoke runners
- long-run reliability soak
