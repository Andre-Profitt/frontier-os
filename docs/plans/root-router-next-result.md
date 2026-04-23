# Root Router Next Tranche Result

Date: 2026-04-21

## Shipped

- Native helper build staging: `frontier helper build --json`.
- Root helper install plan: `frontier helper install --dry-run --json` emits explicit sudo install/load/rollback commands and runs none of them.
- Root helper apply path: `frontier helper install --apply --json` runs the staged installer through macOS administrator authorization.
- Production helper probe: `frontier helper production-status --json`.
- Production helper read-only invoke path: `frontier helper production-invoke <verb>`.
- Project runners: `frontier project verify <id>` and `frontier project smoke <id>` execute manifest-declared argv after policy evaluation.
- MCP config output: `frontier mcp config --agent codex|claude`.
- Client status endpoint and CLI: `/v1/client/status`, `/v1/siri/status`, `frontier client status`, and `frontier siri status`.
- Project next/repair planner: `frontier project next <id>` and `frontier project repair <id> --dry-run` rank safe next actions with route/policy decisions.
- Overnight dry-run planner: `frontier overnight plan --hours 8 --json` schedules autonomous-eligible class 0/1 project actions without executing them.
- Overnight Ghost Shift bridge: `frontier overnight enqueue` compiles safe scheduled actions into work-graph JSON, and `frontier overnight run` executes them through a run-scoped Ghost Shift queue.
- Morning brief: `frontier overnight brief --hours 24 --json` summarizes recent runs, Ghost Shift outcomes, and manual-attention items.
- Narrow class-2 user LaunchAgent repair: `frontier ops repair-launchagent <label>` defaults to dry-run, refuses non-Frontier labels, and requires a one-shot approval token before `launchctl` mutation.
- Approval UX surface: `frontier approval list`, `frontier approval approve`, `/v1/approvals`, `client status`, and MCP now expose pending class-2 traces with approve/consume actions for Siri and menubar clients.
- Overnight preflight: `frontier overnight smoke --json`.
- Ledger sessions for project/MCP/helper calls are now trace-scoped to avoid concurrent write collisions.

## Verified

```bash
npm run typecheck
/Users/test/frontier-os/bin/frontier helper build --json
plutil -lint /Users/test/.frontier/helper/com.frontier-os.helper.plist
/Users/test/.frontier/helper/frontier-helper
/Users/test/frontier-os/bin/frontier project verify frontier-os --json
/Users/test/frontier-os/bin/frontier project smoke frontier-os --json
/Users/test/frontier-os/bin/frontier project next frontier-os --json
/Users/test/frontier-os/bin/frontier project repair frontier-os --dry-run --json
/Users/test/frontier-os/bin/frontier client status --json
/Users/test/frontier-os/bin/frontier mcp smoke --read-only --json
/Users/test/frontier-os/bin/frontier overnight plan --hours 8 --json
/Users/test/frontier-os/bin/frontier overnight enqueue --hours 8 --dry-run --limit 3 --json
/Users/test/frontier-os/bin/frontier overnight run --hours 8 --dry-run --limit 3 --json
/Users/test/frontier-os/bin/frontier overnight run --hours 8 --limit 1 --queue-dir /tmp/<queue> --graph-dir /tmp/<graphs> --json
/Users/test/frontier-os/bin/frontier overnight brief --hours 1 --json
/Users/test/frontier-os/bin/frontier ops repair-launchagent com.frontier-os.ghost-shift --json
/Users/test/frontier-os/bin/frontier approval list --json
/Users/test/frontier-os/bin/frontier approval approve <trace-id> --ttl 2s --json
/Users/test/frontier-os/bin/frontier ops repair-launchagent com.frontier-os.ghost-shift --execute --json
/Users/test/frontier-os/bin/frontier ops repair-launchagent com.apple.WindowServer --json
/Users/test/frontier-os/bin/frontier overnight smoke --json
```

## Still Not Done

- Root LaunchDaemon install is explicit/operator-approved, not autonomous.
- The native root helper intentionally exposes read-only fixed verbs only; class-2 repair is currently limited to user LaunchAgents from the normal CLI boundary.
- Siri/menubar still need native buttons wired to the exposed approve/consume actions.
- Shared-queue production overnight runs should wait until Andre explicitly wants the full queue drained.
- External agent config was generated, not written into global app config files.

## Root Install Attempt

`frontier helper install --apply --json` was attempted on 2026-04-21. The first Codex-shell administrator authorization attempt did not complete, then Andre ran the staged installer from Terminal with an admin password. Production install is now complete.

Latest staged helper binary:

```text
f1b61b08c515b1478eed3c363a656d1a5b2d3e07fc52c1d38ebe6eec180a3c68  /Users/test/.frontier/helper/frontier-helper
```

Current production state:

- `/usr/local/libexec/frontier-helper`: installed
- `/Library/LaunchDaemons/com.frontier-os.helper.plist`: installed
- `/Library/Application Support/FrontierOS/helper.sock`: reachable
- `launchctl print system/com.frontier-os.helper`: running
- `frontier helper production-status --json`: reachable with `euid: 0`

Staged installer:

```bash
/Users/test/.frontier/helper/install-root-helper.sh
```
