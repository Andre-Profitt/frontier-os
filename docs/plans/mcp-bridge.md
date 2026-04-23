# T3: MCP Bridge Plan

Status: M1 read-only bridge shipped; M4 config output shipped; M5 command-gateway tools shipped; M6 write-capable command-control tools shipped

## Goal

Expose Frontier OS as high-level agent tools so Codex and Claude can operate the machine through typed verbs instead of raw shell discovery.

## Current State

Frontier OS has CLI commands, adapters, watchers, ledger events, and work graphs. M1 now adds a read-only MCP tool registry, smoke runner, and JSON-RPC-lines server entrypoint. Tools prefer `frontierd` and fall back to local functions.

## Deliverables

1. MCP server package or entrypoint:
   - `frontier mcp run`
   - `frontier mcp smoke`
2. Tool set:
   - `frontier.project_list`
   - `frontier.project_status`
   - `frontier.project_verify`
   - `frontier.ledger_recent`
   - `frontier.watcher_status`
   - `frontier.ghost_status`
   - `frontier.work_run`
   - `frontier.approval_list`
   - `frontier.approval_approve`
   - `frontier.command_submit`
   - `frontier.command_list`
   - `frontier.command_show`
   - `frontier.command_packet`
   - `frontier.command_final_brief`
   - `frontier.command_brief`
   - `frontier.command_readiness`
   - `frontier.command_resume`
   - `frontier.mlx_status`
   - `frontier.mlx_benchmark`
3. Tool schemas generated from the same TypeScript types used by CLI/daemon.
4. Ledger events for MCP calls:
   - `mcp.request`
   - `mcp.response`
   - `mcp.denied`

## Milestones

### M1: Read-Only Tool Server

Expose project, ledger, watcher, and Ghost Shift status tools only.

Status: shipped.

Success gate:

```bash
/Users/test/frontier-os/bin/frontier mcp smoke --read-only --json
```

### M2: Verification Tools

Add project verification and MLX benchmark tools with policy class 1.

Success gate:

```bash
/Users/test/frontier-os/bin/frontier mcp smoke --tools project_verify,mlx_benchmark --json
```

### M3: Work Graph Tool

Expose `frontier.work_run` for approved work graphs.

Success gate:

```bash
/Users/test/frontier-os/bin/frontier mcp smoke --tools work_run --json
```

The smoke run uses a non-destructive example work graph.

### M4: Agent Configuration

Add documented Codex and Claude MCP config snippets that point to the local `frontier mcp run` entrypoint.

Status: shipped as `frontier mcp config --agent codex|claude`.

Success gate:

An agent can call `frontier.project_status` and get JSON without running shell commands directly.

### M5: Command Gateway Tools

Expose the command gateway through MCP without exposing broad shell or helper
control.

Status: shipped.

Tools:

- `frontier.command_submit` — class 1, not read-only; submits a typed command
  envelope. Smoke uses `dryRun=true`.
- `frontier.command_list` — class 0.
- `frontier.command_show` — class 0.
- `frontier.command_final_brief` — class 0.
- `frontier.command_brief` — class 0.
- `frontier.command_readiness` — class 0.

Success gate:

```bash
frontier mcp call frontier.command_readiness --input '{"hours":24,"limit":25}' --json
frontier mcp call frontier.command_submit --input '{"intent":"status frontier-os","projectId":"frontier-os","dryRun":true}' --json
frontier mcp call frontier.command_final_brief --input '{"commandId":"cmd_mo8xnx5i_394364e6","eventLimit":10}' --json
frontier mcp smoke --read-only --json
frontier mcp smoke --json
```

Current evidence:

- read-only MCP smoke passed with 17/17 tools.
- full MCP smoke passed with 24/24 checks.
- `frontier.command_readiness` was served by `frontierd` and returned `status=ready`.
- `frontier.command_final_brief` was served by `frontierd`.
- `frontier.command_submit` dry-run was served locally and produced a queued dry-run command record without enqueueing work.

### M6: Write-Capable Command Control Tools

Expose bounded write tools for approval and resume, keep submit as the
canonical front door, and add normalized packet lookup for machine follow-up.

Status: shipped.

Tools:

- `frontier.approval_approve` — class 1; grants a one-shot approval token for
  one trace, with optional `resume=false` to defer command resume.
- `frontier.command_packet` — class 0; returns the normalized result packet.
- `frontier.command_resume` — class 1; resumes a blocked command after approval.
- `frontier.command_submit` — expanded schema for payload, correlation/trace
  IDs, explicit approval class, and policy hints.

Success gate:

```bash
frontier mcp call frontier.command_packet --input '{"commandId":"cmd_mo8xnx5i_394364e6"}' --json
frontier mcp smoke --read-only --json
frontier mcp smoke --json
```

Current evidence:

- `frontier.command_packet` was served by `frontierd` and returned
  `packetVersion=v1`.
- full MCP smoke passed with:
  - actual submit
  - packet follow-up lookup
  - blocked class-2 submit
  - manual approval grant with `resume=false`
  - explicit command resume
  - final-brief follow-up

## Boundaries

- MCP tools call `frontierd` when available.
- The MCP bridge does not become a second scheduler.
- Tool inputs are typed and validated.
- Side-effect tools include policy class in schema and ledger output.
