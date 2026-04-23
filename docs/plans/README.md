# Frontier OS Gap-Closure Plans

Date: 2026-04-21
Status: root-router build lane active; T2 M2, T3 M1, T4 simulator M1-M2, and T5 M1-M2 shipped

## Operating Context

Live probes show Frontier OS is already a working CLI-first control plane:

- Ledger: 10,001 events across 946 sessions.
- Watchers: work radar, RunPod idle killer, overnight review, Salesforce portfolio audit.
- Ghost Shift: queue, completed jobs, failed jobs, rejected unsafe jobs.
- MLX: background `mlxw watch` and `mlxw unlock-run` processes are active.
- LaunchAgent logs: present under `~/Library/Logs/frontier-os/`.

The remaining gap is not "build the whole thing." The gap is turning this from a CLI and scheduled-job substrate into an always-on, policy-gated, project-aware local operating layer for Codex, Claude, Siri, and native apps.

## Tracks

Primary 8-hour execution lane:

- `eight-hour-root-router-build.md` — concentrated build plan to move the root-level router from roughly 35-40% to 80-90% complete.
- `root-level-orchestrator-master-plan.md` — canonical plan for turning the shipped router substrate into the full command gateway, planner, queue, worker, and Jarvis/Siri operator system.

| Track | Plan | Purpose | First success gate |
| --- | --- | --- | --- |
| T0 | `ops-readiness.md` | Make existing launchd jobs and health checks visible and reliable. | `frontier ops status --json` reports scheduler, logs, watchers, and MLX. |
| T1 | `project-registry.md` | Give the system a canonical inventory of projects, commands, services, and verification gates. | `frontier project status --json` covers the initial project set. |
| T2 | `frontierd.md` | Add a resident user daemon with local API/socket access. | `frontier daemon status --json` returns healthy from a LaunchAgent-backed process. |
| T3 | `mcp-bridge.md` | Expose Frontier verbs to Codex/Claude as high-level tools. | An agent can call `frontier.project_status` without raw shell discovery. |
| T4 | `privileged-helper.md` | Add narrow root-level capabilities without an arbitrary root shell. | `frontier helper status --json` succeeds and logs a denied unapproved class-3 action. |
| T5 | `policy-ledger.md` | Make action classification, approval, and audit evidence first-class. | Class-2 actions pause for approval; class-0/1 actions log automatically. |
| T6 | `siri-menubar.md` | Make Siri and the macOS menubar thin clients over Frontier state. | Siri status includes Frontier watcher, Ghost Shift, and approval summaries. |

## Initial Managed Project Set

These are the first projects the registry should know about:

| Project | Path | Primary role | Known verification gate |
| --- | --- | --- | --- |
| `frontier-os` | `/Users/test/frontier-os` | Control plane, ledger, adapters, watchers. | `npm run typecheck` |
| `mlx-workbench` | `/Users/test/.frontier/mlx` | Shared MLX runtime and benchmark substrate. | `/Users/test/.frontier/mlx/bin/mlxw status --fail-if-not-ready` |
| `companion-platform` | `/Users/test/code/platform/companion-platform` | Siri Gateway, Apple companion, runtime API. | `make verify` |
| `crm-analytics` | `/Users/test/crm-analytics` | Salesforce CRM Analytics dashboards and monthly review. | `make verify` |
| `kaggle-nemotron` | `/Users/test/code/labs/kaggle-nemotron` | Local ML/competition lab. | `uv run pytest` or `nemotron-mlx` smoke after registry probing. |
| `salesforce-api` | `/Users/test/code/apps/salesforce-api` | Salesforce API application and dashboard deploy flow. | Registry discovery required. |
| `nexus` | `/Users/test/code/platform/nexus` | Voice pipeline, MCP/API/CLI experiments. | `uv run pytest` |
| `jarvis-menubar` | `/Users/test/code/apps/jarvis-menubar` | Native macOS menubar for Frontier state. | `swift test` |
| `aegis` | `/Users/test/code/apps/SIRI/aegis` | Dormant brain/memory service to consolidate or retire. | Registry discovery required. |

## Execution Order

1. T1 project registry and T0 ops readiness are shipped.
2. T2 `frontierd` M1 foreground API is shipped.
3. T2 M2 residency, T5 policy, T3 MCP, T4 helper simulator, and route explain are shipped.
4. T6 Siri/menubar integration follows after daemon/MCP/helper contracts stabilize.

## Global Acceptance Gates

- `frontier project status --json` returns all initial managed projects.
- `frontier ops status --json` reports running, stale, failed, and unloaded automation.
- `frontier daemon status --json` returns healthy from the LaunchAgent process.
- `frontier mcp smoke --read-only --json` proves project, ops, ledger, watcher, Ghost Shift, and approval tools.
- `frontier helper status --json` proves helper reachability without granting arbitrary shell.
- `frontier policy simulate --class 3 --verb service.restart` denies by default.
- Siri `/v1/siri/status` or equivalent includes Frontier OS summary data.

## Boundaries

- No root shell exposed to agents.
- No duplicated MLX setup per project.
- No replacement of the existing companion-platform Siri Gateway until Frontier data is integrated into it.
- No rewrite of `frontier-os` adapters while adding daemon/API surfaces.
- No destructive or billable autonomous action without approval-class enforcement.
