# T0: Operations Readiness Plan

## Goal

Make the existing automation layer observable and reliable before adding more orchestration. This track turns scattered launchd jobs, logs, and watcher state into one status surface.

## Current State

Existing evidence:

- LaunchAgent plists exist in `~/Library/LaunchAgents`.
- Logs exist in `~/Library/Logs/frontier-os`.
- `frontier watcher list` returns four watchers.
- `frontier scheduler list` computes next runs.
- `frontier ghost status` returns queue/completed/failed/rejected counts.
- MLX background processes are active.

Weakness:

- There is no single command that says what is installed, loaded, running, stale, failed, and actionable.

## Deliverables

1. CLI:
   - `frontier ops status`
   - `frontier ops logs`
   - `frontier ops doctor`
2. LaunchAgent inventory:
   - expected labels
   - plist path
   - loaded state
   - last log timestamp
   - last ledger event
3. Process inventory:
   - `frontierd`
   - MLX watchers
   - companion-platform runtime
   - known watcher jobs
4. Staleness rules:
   - scheduler stale
   - watcher stale
   - log stale
   - repeated failure
5. Ledger events:
   - `ops.status`
   - `ops.doctor`
   - `ops.issue`

## Milestones

### M1: Read-Only Status

Implement `frontier ops status` by reading launchd state, logs, watcher specs, scheduler state, Ghost Shift state, and MLX process probes.

Success gate:

```bash
/Users/test/frontier-os/bin/frontier ops status --json
```

### M2: Doctor

Add pass/warn/fail checks with suggested remediation commands.

Success gate:

```bash
/Users/test/frontier-os/bin/frontier ops doctor --json
```

The command identifies unloaded LaunchAgents and stale logs without making changes.

### M3: Repair Plan Output

Add a dry-run repair plan that can later be routed through policy and the helper.

Success gate:

```bash
/Users/test/frontier-os/bin/frontier ops doctor --repair-plan --json
```

No side effects occur.

### M4: Work Radar Integration

Make work-radar include ops health as a first-class section.

Success gate:

```bash
/Users/test/frontier-os/bin/frontier watcher run work-radar --json
```

Output includes ops readiness status.

## Boundaries

- This track is read-only until policy and helper gates exist.
- Do not load or unload LaunchAgents from `ops doctor`.
- Do not kill processes from `ops status`.
- Do not treat missing optional services as failures unless a project manifest marks them required.

