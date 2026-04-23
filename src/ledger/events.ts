// Event kinds + types for the Frontier OS session ledger.
//
// The ledger is an append-only event log decoupled from the CLI harness,
// following the Anthropic Managed Agents separation: harness writes events,
// ledger is a separate durable store, state is recovered by replaying events.
// Every adapter invocation writes at least two events (invocation.start +
// invocation.end); audit-producing commands also write audit.grade + one
// finding event per finding so they're individually queryable.

export type EventKind =
  | "session.started"
  | "invocation.start"
  | "invocation.end"
  | "audit.grade"
  | "audit.enrichment"
  | "finding"
  | "artifact"
  | "side_effect"
  | "alert"
  | "memory.write"
  | "watcher.tick"
  | "watcher.result"
  | "compliance.override"
  | "system"
  // Agent coordination events (Phase 2): cross-tool ledger bridge between
  // Claude Code and Codex. Written by hook scripts (Claude) and plugin/AGENTS
  // protocol (Codex). `actor` carries the agent name: "claude" | "codex".
  | "agent.session_start"
  | "agent.session_end"
  | "agent.pre_tool_use"
  | "agent.post_tool_use"
  | "agent.user_prompt"
  | "agent.stop"
  | "agent.review"
  // Work graph events (Phase 6): orchestrated execution of typed work graphs
  // per schemas/work-graph.schema.json. `actor` is the executor ("work.executor").
  | "work.graph_start"
  | "work.graph_end"
  | "work.node_start"
  | "work.node_end"
  | "work.node_failed"
  | "work.node_skipped"
  | "work.awaiting_approval"
  | "work.approved"
  | "work.verifier_pass"
  | "work.verifier_fail"
  | "work.node_retry"
  | "work.verifier_check"
  // Ghost Shift events (Phase 6.2): overnight safe-mode runner that drains a
  // local work-graph queue. Per vision §13.1 — never deploy, merge, or message
  // externally; only class ≤ 1 graphs run autonomously.
  | "ghost.shift_start"
  | "ghost.shift_end"
  | "ghost.graph_started"
  | "ghost.graph_completed"
  | "ghost.graph_failed"
  | "ghost.graph_blocked"
  | "ghost.graph_rejected"
  // Failure Refinery events (Phase 6.4): compound repeated failures into
  // eval cases, policy rules, and routing updates. Written by src/refinery/*.
  | "refinery.proposal_appended"
  | "refinery.rule_promoted"
  | "refinery.rule_auto_promoted"
  | "refinery.rule_revoked"
  | "refinery.eval_exported"
  | "refinery.eval_pass_recorded"
  // Worktree Swarm events (Phase 11): Magentic-One Task/Progress Ledger loop
  // with typed planner/reader/writer/verifier roles. See src/swarm/.
  | "swarm.run_start"
  | "swarm.run_end"
  | "swarm.task_ledger"
  | "swarm.role_start"
  | "swarm.role_end"
  | "swarm.progress_ledger"
  // frontierd user daemon events (Phase T2): resident user-level API wrapper
  // around project, ops, watcher, ghost, and ledger status.
  | "daemon.start"
  | "daemon.stop"
  | "daemon.health"
  | "daemon.request"
  // Ops repair events: bounded, allowlisted local service repair attempts.
  | "ops.repair_start"
  | "ops.repair_end"
  // Policy core events (T5): central action classification and one-shot
  // approval-token lifecycle. Approval tokens are append-only ledger records.
  | "policy.simulated"
  | "policy.evaluated"
  | "policy.approval_granted"
  | "policy.approval_consumed"
  | "policy.approval_denied"
  // MCP bridge events (T3): typed agent tool calls routed through frontierd
  // when available, with policy decisions captured at the tool boundary.
  | "mcp.request"
  | "mcp.response"
  | "mcp.denied"
  // Privileged helper boundary events (T4). The helper surface is a fixed
  // verb allowlist; denied requests are first-class audit records.
  | "helper.request"
  | "helper.allowed"
  | "helper.denied"
  | "helper.result"
  // Project command runner events: executable verify/smoke/dev gates declared
  // in manifests and checked by policy before process spawn.
  | "project.command_start"
  | "project.command_end"
  | "project.plan"
  // Command gateway events (M1): one typed ingress path from CLI, daemon,
  // Jarvis/Siri, and agents into the durable command queue.
  | "command.received"
  | "command.classified"
  | "command.planned"
  | "command.queued"
  | "command.state_changed"
  | "command.completed"
  | "command.failed"
  // Overnight orchestrator evidence for preflight and smoke runs.
  | "overnight.smoke"
  | "overnight.plan"
  | "overnight.enqueue"
  | "overnight.run"
  | "overnight.brief";

export interface EventInput {
  sessionId: string;
  kind: EventKind;
  actor?: string;
  traceId?: string;
  payload: Record<string, unknown>;
}

export interface LedgerEvent {
  eventId: string;
  sessionId: string;
  offset: number;
  ts: string;
  kind: EventKind;
  actor: string | null;
  traceId: string | null;
  payload: Record<string, unknown>;
}

export interface SessionInit {
  sessionId: string;
  label?: string;
  tags?: string[];
}

export interface SessionSummary {
  sessionId: string;
  startedAt: string;
  lastEventAt: string | null;
  label: string | null;
  tags: string[];
  eventCount: number;
}

/** Generate a time-sortable event id: ts36-randomhex. */
export function newEventId(): string {
  const t = Date.now().toString(36);
  const r = Math.random().toString(36).slice(2, 10);
  return `evt_${t}_${r}`;
}

/** Generate a new session id. */
export function newSessionId(label?: string): string {
  const t = Date.now().toString(36);
  const r = Math.random().toString(36).slice(2, 8);
  const slug = label
    ? label
        .replace(/[^a-z0-9]+/gi, "-")
        .replace(/^-+|-+$/g, "")
        .slice(0, 24)
        .toLowerCase()
    : "";
  return slug ? `ses_${t}_${slug}_${r}` : `ses_${t}_${r}`;
}
