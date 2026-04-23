# T4: Privileged Helper Plan

Status: M1-M2 simulator shipped, resident native helper installed as root LaunchDaemon

## Goal

Add narrow root-level capabilities for system operations while avoiding a backdoor, arbitrary root shell, or unbounded agent control.

## Current State

The Frontier LaunchDaemon is installed at `/Library/LaunchDaemons/com.frontier-os.helper.plist` and runs `/usr/local/libexec/frontier-helper` as root. Root-level tasks still require direct user approval or manual shell operations. The repo now includes a resident native helper socket service, read-only HTTP-over-UDS endpoints, a LaunchDaemon plist template, a staged native build under `~/.frontier/helper`, and a user-mode simulator with the fixed verb allowlist and denial self-test.

## Design Decision

Build a small native helper with a fixed verb allowlist. Prefer a Swift command-line helper installed as a LaunchDaemon because it avoids running a mutable npm dependency tree as root.

`frontierd` remains the user-level coordinator. The helper only executes allowlisted privileged verbs after policy approval.

## Allowed Verbs, Initial Set

Class 0 read-only:

- `helper.status`
- `launchd.status`
- `logs.read`
- `network.status`

Class 2 controlled side effects:

- `launchd.load`
- `launchd.unload`
- `service.restart`
- `port.kill`
- `fs.fixOwnership`

Class 3 blocked by default:

- any verb touching system paths outside allowlisted roots
- changing firewall/VPN/system security state
- installing packages
- deleting files
- arbitrary command execution

## Allowlisted Roots and Labels

Initial roots:

- `/Users/test/frontier-os`
- `/Users/test/.frontier`
- `/Users/test/code`
- `/Users/test/crm-analytics`
- `/Users/test/Library/Logs/frontier-os`

Initial launchd labels:

- `com.frontier-os.frontierd`
- `com.frontier-os.ghost-shift`
- `com.frontier-os.work-radar`
- `com.frontier-os.overnight-review`
- `com.frontier-os.runpod-idle-killer`
- `com.frontier-os.nightly-research-enqueue`
- `ai.companion.platform.runtime`

## Deliverables

1. Helper source under `helpers/frontier-helper/`.
2. LaunchDaemon plist template:
   - `/Library/LaunchDaemons/com.frontier-os.helper.plist`
3. User CLI:
   - `frontier helper install`
   - `frontier helper status`
   - `frontier helper invoke <verb>`
4. Local IPC:
   - root-owned Unix socket with user-group access.
5. Policy integration:
   - helper rejects requests missing approval tokens when class >= 2.
6. Ledger events:
   - `helper.request`
   - `helper.allowed`
   - `helper.denied`
   - `helper.result`

## Milestones

### M1: Status-Only Helper

Install helper with only `helper.status`.

Status: simulator and resident native helper build shipped; production install complete.

Native helper endpoints:

- `/health`
- `/v1/helper/status`
- `/v1/launchd/status?label=<allowlisted-label>`
- `/v1/logs/read?path=<allowlisted-path>&tailBytes=<n>`
- `/v1/network/status`

Success gate:

```bash
/Users/test/frontier-os/bin/frontier helper status --json
```

### M2: Read-Only System Introspection

Add launchd status, logs read, and network status.

Status: simulator shipped.

Success gate:

```bash
/Users/test/frontier-os/bin/frontier helper invoke launchd.status --label com.frontier-os.frontierd --json
```

### M3: Controlled Service Operations

Add load, unload, restart, and port kill for allowlisted labels and ports.

Success gate:

```bash
/Users/test/frontier-os/bin/frontier policy simulate --class 2 --verb service.restart --json
```

Then an approved token permits one service restart and writes ledger evidence.

### M4: Denial Tests

Prove the helper rejects arbitrary commands, destructive file operations, and non-allowlisted labels.

Status: shipped in `frontier helper self-test`.

Success gate:

```bash
/Users/test/frontier-os/bin/frontier helper self-test --json
```

All denial cases pass.

## Boundaries

- No `run-command` root verb.
- No shell interpolation.
- No wildcard path grants.
- No persistent approval tokens.
- No package installs through the helper in v1.
