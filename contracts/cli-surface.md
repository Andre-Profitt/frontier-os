# CLI Surface Contract

Date: April 8, 2026
Status: draft

## Principle

The CLI is the primary operating surface.

Every command should:

- accept structured input
- emit structured output
- separate inspection from mutation
- expose enough metadata for tracing, approvals, and memory writeback

## Command Families

### `frontier adapter`

Purpose:

- discover and invoke semantic adapters

Examples:

```text
frontier adapter list
frontier adapter show browser
frontier adapter inspect browser current-tab
frontier adapter invoke salesforce inspect-dashboard --mode read --input in.json
frontier adapter invoke browser click-element --mode apply --input in.json
```

### `frontier watcher`

Purpose:

- run or inspect always-on watchers

Examples:

```text
frontier watcher list
frontier watcher show runpod-idle-killer
frontier watcher run overnight-review
frontier watcher pause work-radar
frontier watcher resume work-radar
```

### `frontier project`

Purpose:

- inspect the canonical managed-project registry
- report path, git, port, service, env-file, and ledger-tag status without running project commands

Examples:

```text
frontier project list --json
frontier project inspect frontier-os --json
frontier project status --json
frontier project status mlx-workbench --json
frontier project next frontier-os --json
frontier project repair frontier-os --dry-run --json
frontier project verify frontier-os --json
frontier project smoke frontier-os --json
```

Verify and smoke commands execute the manifest-declared argv after policy
evaluation. Use `--dry-run` to see the exact argv/cwd/policy decision without
spawning the process.

`next` and `repair` are non-destructive planning surfaces. They rank the next
safe actions for a project, attach route/policy decisions, and surface blocked
service-level repair ideas without executing them.

### `frontier ops`

Purpose:

- report existing automation health without repairing, loading, unloading, or killing anything

Examples:

```text
frontier ops status --json
frontier ops repair-launchagent com.frontier-os.ghost-shift --json
frontier ops repair-launchagent com.frontier-os.ghost-shift --execute --trace-id <trace> --consume-token --json
```

The status output covers expected LaunchAgents, Ghost Shift queue counts,
watcher and scheduler state, key log paths, and known Frontier/MLX/Codex
processes where visible to the current user.

`repair-launchagent` is a bounded class-2 repair primitive for Frontier-known
user LaunchAgents only. Without `--execute` it returns the exact `plutil` and
`launchctl` commands plus a trace id. Execution requires a one-shot approval
token for that trace id and `--consume-token`; non-allowlisted labels are
refused.

### `frontier approval`

Purpose:

- surface pending class-2 approval requests from the ledger
- grant one-shot approval tokens only for real pending traces
- provide UI-ready approve and consume actions for Siri and menubar clients

Examples:

```text
frontier approval list --json
frontier approval list --include-resolved --json
frontier approval approve ops-repair-abc123 --ttl 15m --json
```

The approval queue is also exposed through `/v1/approvals`, `frontier client
status`, and the MCP `frontier.approval_list` tool. The approve endpoint is
`POST /v1/approvals/approve?traceId=<id>&ttl=15m`; it refuses unknown or already
resolved traces.

### `frontier daemon`

Purpose:

- run and inspect the user-level `frontierd` Unix-socket API
- expose project, ops, watcher, Ghost Shift, ledger, and approval status to local clients

Examples:

```text
frontier daemon run --foreground
frontier daemon run --foreground --socket /tmp/frontierd.sock
frontier daemon print-plist --json
frontier daemon install-user-agent --dry-run --json
frontier daemon install-user-agent --json
frontier daemon status --json
frontier daemon health --json
frontier daemon stop
```

The daemon runs as the current user. It does not expose arbitrary shell, root
operations, package installs, or deploy actions. `install-user-agent` writes the
current user's LaunchAgent plist and reports the exact `launchctl` load/unload
commands; it does not bootstrap launchd by itself.

### `frontier policy`

Purpose:

- classify actions before side effects
- create and consume one-shot approval tokens
- deny class-3 privileged or external actions by default

Examples:

```text
frontier policy simulate --verb project.status --project frontier-os --json
frontier policy simulate --verb service.restart --project frontier-os --json
frontier policy approve --trace-id root-router-smoke --ttl 15m --json
frontier policy consume --trace-id root-router-smoke --json
```

### `frontier mcp`

Purpose:

- expose read-only Frontier tools to agents
- prefer `frontierd` and fall back to local functions
- ledger MCP requests, responses, and denials

Examples:

```text
frontier mcp list --json
frontier mcp config --agent codex --json
frontier mcp smoke --read-only --json
frontier mcp call frontier.project_status --input '{"projectId":"frontier-os"}' --json
frontier mcp run
```

### `frontier helper`

Purpose:

- model the privileged-helper boundary without exposing a shell
- run read-only helper introspection
- prove denied cases through self-tests and ledger events

Examples:

```text
frontier helper status --json
frontier helper build --json
frontier helper install --dry-run --json
frontier helper install --apply --json
frontier helper production-status --json
frontier helper production-invoke helper.status --json
frontier helper production-invoke launchd.status --label com.frontier-os.frontierd --json
frontier helper invoke helper.status --json
frontier helper invoke launchd.status --label com.frontier-os.frontierd --json
frontier helper self-test --json
```

The simulator remains available for policy tests, and the native helper can be
staged under `~/.frontier/helper`. `helper install --dry-run` emits the explicit
sudo install/load/rollback commands without running them. `helper install
--apply` uses the macOS administrator authorization prompt to run the staged
installer script. `helper production-status` probes the production root-owned
socket. `helper production-invoke` calls the production socket for fixed
read-only verbs only.

### `frontier client`

Purpose:

- expose a compact status payload for Siri, Shortcuts, and the macOS menubar

Examples:

```text
frontier client status --json
frontier siri status --json
```

### `frontier overnight`

Purpose:

- plan a non-destructive overnight work block across managed projects
- run a non-destructive orchestrator preflight over daemon, MCP, helper, and policy

Examples:

```text
frontier overnight plan --hours 8 --json
frontier overnight enqueue --hours 8 --dry-run --json
frontier overnight run --hours 8 --dry-run --json
frontier overnight brief --hours 24 --json
frontier overnight smoke --json
```

`plan` schedules autonomous-eligible class 0/1 actions only. It does not run
project commands, start services, restart launchd jobs, deploy, publish, or send
external messages.

`enqueue` compiles scheduled actions into valid work-graph JSON and copies safe
graphs into the Ghost Shift queue. Use `--dry-run` to validate the generated
graphs and safety verdict without writing queue files.

`run` compiles the same actions into a run-scoped Ghost Shift queue and then
executes that queue. It does not drain the shared Ghost Shift queue unless a
caller explicitly points `--queue-dir` at it. Use `--dry-run` for a no-write,
no-execute preview.

`brief` reads the ledger and summarizes recent overnight runs, Ghost Shift
outcomes, and failed/blocked/rejected graphs needing manual attention.

### `frontier route`

Purpose:

- explain which execution lane a verb will use before running it

Examples:

```text
frontier route explain --verb project.status --project frontier-os --json
frontier route explain --verb service.restart --project frontier-os --json
```

### `frontier alert`

Purpose:

- operate the system alert queue

Examples:

```text
frontier alert list
frontier alert show alt_123
frontier alert ack alt_123
frontier alert resolve alt_123 --note "pod stopped"
```

### `frontier memory`

Purpose:

- search, write, and curate memory

Examples:

```text
frontier memory search "salesforce dashboard filters"
frontier memory write --input record.json
frontier memory explain mem_123
```

### `frontier policy`

Purpose:

- inspect and validate policy packs

Examples:

```text
frontier policy list
frontier policy show personal-default
frontier policy validate policy.json
```

### `frontier route`

Purpose:

- explain model and executor selection

Examples:

```text
frontier route explain --task browser_task --goal "audit salesforce dashboard"
frontier route eval --input task.json
```

## Output Rules

- default output is JSON
- text rendering is opt-in
- every response must include `traceId`
- mutations must include side effect and verification summaries

## Modes

Every adapter invocation must declare one of these modes:

- `read`: inspect only
- `propose`: prepare a plan without side effects
- `apply`: perform bounded side effects
- `undo`: attempt rollback of a prior action

## Approval Bar

The CLI should require policy clearance before `apply` or `undo` for:

- billable actions
- external communications
- destructive actions
- privilege changes
- repository writes outside approved scope
