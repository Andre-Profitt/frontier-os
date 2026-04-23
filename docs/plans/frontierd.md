# T2: `frontierd` User Daemon Plan

Status: M1 shipped, M2 install path shipped, M2 load verification pending

## Goal

Run Frontier OS as an always-on user daemon so Codex, Claude, Siri Gateway, menubar, and scheduled jobs can query one resident local service instead of repeatedly spawning one-shot CLI commands.

## Current State

The CLI works, LaunchAgent plists exist, logs are present, and the scheduler can compute next runs. M1 now includes a foreground user-level `frontierd` Unix-socket API with status/health/stop commands. M2 now has explicit plist print/install commands for the user LaunchAgent; bootstrap remains an operator action.

## Deliverables

1. CLI:
   - `frontier daemon run`
   - `frontier daemon status`
   - `frontier daemon stop`
   - `frontier daemon health`
   - `frontier daemon print-plist`
   - `frontier daemon install-user-agent`
2. LaunchAgent:
   - `~/Library/LaunchAgents/com.frontier-os.frontierd.plist`
3. Local transport:
   - Unix socket preferred for local agents.
   - Optional `127.0.0.1` HTTP for Siri Gateway compatibility.
4. API surface:
   - `/health`
   - `/v1/projects`
   - `/v1/projects/status`
   - `/v1/projects/:id/status`
   - `/v1/ops/status`
   - `/v1/ledger/recent`
   - `/v1/watchers`
   - `/v1/ghost/status`
   - `/v1/approvals`
   - `/v1/work/run` (deferred until policy/work-runner routing is hardened)
5. Ledger events:
   - `daemon.start`
   - `daemon.stop`
   - `daemon.health`
   - `daemon.request`

## Milestones

### M1: In-Process API

Status: shipped.

Add a small API server module that wraps existing registry, ledger, watcher, ghost, and project functions.

Success gate:

```bash
/Users/test/frontier-os/bin/frontier daemon run --foreground --socket /tmp/frontierd.sock
```

Then:

```bash
/Users/test/frontier-os/bin/frontier daemon status --json
```

### M2: LaunchAgent Residency

Install and load a user LaunchAgent for `frontierd`.

Shipped CLI gates:

```bash
/Users/test/frontier-os/bin/frontier daemon install-user-agent --dry-run --json
/Users/test/frontier-os/bin/frontier daemon print-plist --json
/Users/test/frontier-os/bin/frontier daemon install-user-agent --json
```

Success gate:

```bash
launchctl print gui/$(id -u)/com.frontier-os.frontierd
/Users/test/frontier-os/bin/frontier daemon status --json
```

### M3: Request Routing

Make CLI subcommands prefer the daemon when available and fall back to direct local execution when unavailable.

Success gate:

```bash
/Users/test/frontier-os/bin/frontier project status --json
```

The output includes `servedBy: "frontierd"` when the daemon path was used.

### M4: Watcher Coalescing

Move duplicate scheduled status probes behind the daemon to avoid overlapping one-shot processes.

Success gate:

```bash
/Users/test/frontier-os/bin/frontier ops status --json
```

No duplicate watcher processes are reported.

## Boundaries

- `frontierd` runs as the user, not root.
- No privileged operations in `frontierd`; route those to the helper after T4 exists.
- No arbitrary shell endpoint.
- No direct secret material in daemon logs.
