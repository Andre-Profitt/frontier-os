import { closeLedger, getLedger } from "../ledger/index.ts";
import type { EventKind } from "../ledger/events.ts";
import {
  buildActionEnvelope,
  evaluatePolicyAction,
  type ApprovalClass,
} from "../policy/evaluator.ts";
import { CommandStore } from "../commands/store.ts";

export interface FrontierMcpTool {
  name: string;
  title: string;
  description: string;
  readOnly: boolean;
  approvalClass: ApprovalClass;
  inputSchema: Record<string, unknown>;
}

export interface FrontierMcpCallResult {
  tool: string;
  traceId: string;
  servedBy: "frontierd" | "local";
  durationMs: number;
  output: unknown;
}

export interface FrontierMcpSmokeResult {
  status: "ok" | "failed";
  readOnly: boolean;
  generatedAt: string;
  toolCount: number;
  passed: number;
  failed: number;
  results: Array<{
    tool: string;
    ok: boolean;
    servedBy: "frontierd" | "local" | null;
    durationMs: number;
    error: string | null;
  }>;
}

const TOOLS: FrontierMcpTool[] = [
  {
    name: "frontier.project_list",
    title: "List Frontier Projects",
    description: "Return the managed-project registry.",
    readOnly: true,
    approvalClass: 0,
    inputSchema: objectSchema({}),
  },
  {
    name: "frontier.project_status",
    title: "Project Status",
    description: "Return status for all projects or one projectId.",
    readOnly: true,
    approvalClass: 0,
    inputSchema: objectSchema({
      projectId: { type: "string" },
    }),
  },
  {
    name: "frontier.project_next",
    title: "Project Next Actions",
    description: "Return ranked next actions for one managed project.",
    readOnly: true,
    approvalClass: 0,
    inputSchema: objectSchema({
      projectId: { type: "string" },
    }),
  },
  {
    name: "frontier.ops_status",
    title: "Ops Status",
    description: "Return launchd, watcher, process, and log health.",
    readOnly: true,
    approvalClass: 0,
    inputSchema: objectSchema({}),
  },
  {
    name: "frontier.ledger_recent",
    title: "Recent Ledger Events",
    description: "Return recent sessions and events from the append-only ledger.",
    readOnly: true,
    approvalClass: 0,
    inputSchema: objectSchema({
      limit: { type: "integer", minimum: 1, maximum: 100 },
    }),
  },
  {
    name: "frontier.watcher_status",
    title: "Watcher Status",
    description: "Return watcher and scheduler status.",
    readOnly: true,
    approvalClass: 0,
    inputSchema: objectSchema({}),
  },
  {
    name: "frontier.ghost_status",
    title: "Ghost Shift Status",
    description: "Return Ghost Shift queue counts.",
    readOnly: true,
    approvalClass: 0,
    inputSchema: objectSchema({}),
  },
  {
    name: "frontier.approval_list",
    title: "Approval Queue",
    description: "Return pending class-2 approvals, active grants, and blocked work.",
    readOnly: true,
    approvalClass: 0,
    inputSchema: objectSchema({
      limit: { type: "integer", minimum: 1, maximum: 100 },
    }),
  },
  {
    name: "frontier.approval_approve",
    title: "Approve Frontier Trace",
    description:
      "Grant a one-shot approval token for one class-2 trace. Set resume=false to defer command resume.",
    readOnly: false,
    approvalClass: 1,
    inputSchema: objectSchema({
      traceId: { type: "string" },
      ttl: { type: "string" },
      actorId: { type: "string" },
      resume: { type: "boolean" },
    }),
  },
  {
    name: "frontier.command_submit",
    title: "Submit Frontier Command",
    description:
      "Submit one command envelope to the Frontier command gateway. Use dryRun=true for route/policy planning only.",
    readOnly: false,
    approvalClass: 1,
    inputSchema: objectSchema({
      intent: { type: "string" },
      projectId: { type: "string" },
      actorId: { type: "string" },
      traceId: { type: "string" },
      correlationId: { type: "string" },
      approvalClass: { type: "integer", minimum: 0, maximum: 3 },
      dryRun: { type: "boolean" },
      payload: {
        type: "object",
        additionalProperties: true,
      },
      maxRuntimeSeconds: { type: "integer", minimum: 1 },
      maxRetries: { type: "integer", minimum: 0, maximum: 9 },
      retryBackoffMs: { type: "integer", minimum: 0 },
      requireVerification: { type: "boolean" },
      allowSideEffects: { type: "boolean" },
    }),
  },
  {
    name: "frontier.command_list",
    title: "List Frontier Commands",
    description: "Return recent commands from the durable command queue.",
    readOnly: true,
    approvalClass: 0,
    inputSchema: objectSchema({
      limit: { type: "integer", minimum: 1, maximum: 100 },
      status: { type: "string" },
    }),
  },
  {
    name: "frontier.command_show",
    title: "Show Frontier Command",
    description: "Return one command record. Defaults to the latest command if commandId is omitted.",
    readOnly: true,
    approvalClass: 0,
    inputSchema: objectSchema({
      commandId: { type: "string" },
    }),
  },
  {
    name: "frontier.command_packet",
    title: "Frontier Command Packet",
    description: "Return the normalized command result packet for one command.",
    readOnly: true,
    approvalClass: 0,
    inputSchema: objectSchema({
      commandId: { type: "string" },
    }),
  },
  {
    name: "frontier.command_final_brief",
    title: "Frontier Command Final Brief",
    description:
      "Return the command-scoped handoff packet with result, events, artifacts, and recovery commands.",
    readOnly: true,
    approvalClass: 0,
    inputSchema: objectSchema({
      commandId: { type: "string" },
      eventLimit: { type: "integer", minimum: 1, maximum: 100 },
    }),
  },
  {
    name: "frontier.command_brief",
    title: "Frontier Command Queue Brief",
    description: "Return aggregate command queue, blocker, completion, and failure summary.",
    readOnly: true,
    approvalClass: 0,
    inputSchema: objectSchema({
      hours: { type: "integer", minimum: 1, maximum: 168 },
      limit: { type: "integer", minimum: 1, maximum: 500 },
    }),
  },
  {
    name: "frontier.command_readiness",
    title: "Frontier Command Readiness",
    description: "Return go/no-go readiness for command autonomy.",
    readOnly: true,
    approvalClass: 0,
    inputSchema: objectSchema({
      hours: { type: "integer", minimum: 1, maximum: 168 },
      limit: { type: "integer", minimum: 1, maximum: 500 },
    }),
  },
  {
    name: "frontier.command_debt",
    title: "Frontier Command Debt",
    description: "Return stale queue, running, and approval debt that needs operator action.",
    readOnly: true,
    approvalClass: 0,
    inputSchema: objectSchema({
      limit: { type: "integer", minimum: 1, maximum: 500 },
    }),
  },
  {
    name: "frontier.command_resume",
    title: "Resume Frontier Command",
    description:
      "Resume one blocked command after approval. Provide approval to consume the trace grant explicitly.",
    readOnly: false,
    approvalClass: 1,
    inputSchema: objectSchema({
      commandId: { type: "string" },
      approval: { type: "string" },
      actorId: { type: "string" },
      resumePayload: {
        type: "object",
        additionalProperties: true,
      },
    }),
  },
  {
    name: "frontier.command_retry",
    title: "Retry Frontier Command",
    description: "Create a fresh command from one failed or canceled command.",
    readOnly: false,
    approvalClass: 1,
    inputSchema: objectSchema({
      commandId: { type: "string" },
      actorId: { type: "string" },
    }),
  },
  {
    name: "frontier.command_requeue",
    title: "Requeue Frontier Command",
    description: "Replace one queued, running, or blocked-approval command with a fresh command.",
    readOnly: false,
    approvalClass: 1,
    inputSchema: objectSchema({
      commandId: { type: "string" },
      actorId: { type: "string" },
    }),
  },
  {
    name: "frontier.command_cancel",
    title: "Cancel Frontier Command",
    description: "Cancel one active or blocked command.",
    readOnly: false,
    approvalClass: 1,
    inputSchema: objectSchema({
      commandId: { type: "string" },
      actorId: { type: "string" },
    }),
  },
  {
    name: "frontier.client_status",
    title: "Client Status",
    description: "Return compact Frontier status for Siri and menubar clients.",
    readOnly: true,
    approvalClass: 0,
    inputSchema: objectSchema({}),
  },
  {
    name: "frontier.overnight_plan",
    title: "Overnight Plan",
    description: "Return a non-destructive dry-run plan for an overnight work block.",
    readOnly: true,
    approvalClass: 0,
    inputSchema: objectSchema({
      hours: { type: "integer", minimum: 1, maximum: 24 },
    }),
  },
  {
    name: "frontier.overnight_brief",
    title: "Overnight Brief",
    description: "Return recent overnight run, Ghost Shift, and manual-attention summary.",
    readOnly: true,
    approvalClass: 0,
    inputSchema: objectSchema({
      hours: { type: "integer", minimum: 1, maximum: 168 },
    }),
  },
];

export function listMcpTools(options: { readOnly?: boolean } = {}): FrontierMcpTool[] {
  return TOOLS.filter((tool) => options.readOnly !== true || tool.readOnly);
}

export async function callMcpTool(
  name: string,
  input: Record<string, unknown> = {},
): Promise<FrontierMcpCallResult> {
  const tool = TOOLS.find((candidate) => candidate.name === name);
  if (!tool) throw new Error(`unknown MCP tool: ${name}`);
  const traceId = `mcp-${Date.now().toString(36)}-${Math.random()
    .toString(36)
    .slice(2, 8)}`;
  const startedAt = Date.now();
  const action = buildActionEnvelope({
    actor: "mcp",
    source: "mcp",
    projectId: typeof input.projectId === "string" ? input.projectId : null,
    verb: mcpToolVerb(tool.name),
    arguments: input,
    approvalClass: tool.approvalClass,
    traceId,
  });
  const evaluation = evaluatePolicyAction(action);
  appendMcpEvent("mcp.request", traceId, {
    tool: tool.name,
    input,
    policy: evaluation,
  });
  if (evaluation.decision.status !== "allow") {
    appendMcpEvent("mcp.denied", traceId, {
      tool: tool.name,
      decision: evaluation.decision,
    });
    throw new Error(
      `MCP tool ${tool.name} denied by policy: ${evaluation.decision.reason}`,
    );
  }

  const output = await invokeTool(tool.name, input);
  const result: FrontierMcpCallResult = {
    tool: tool.name,
    traceId,
    servedBy: output.servedBy,
    durationMs: Date.now() - startedAt,
    output: output.body,
  };
  appendMcpEvent("mcp.response", traceId, {
    tool: tool.name,
    servedBy: result.servedBy,
    durationMs: result.durationMs,
    ok: true,
  });
  return result;
}

export async function smokeMcpBridge(
  options: { readOnly?: boolean } = {},
): Promise<FrontierMcpSmokeResult> {
  const tools = listMcpTools({ readOnly: options.readOnly === true });
  const smokeTools =
    options.readOnly === true
      ? tools
      : tools.filter(
          (tool) =>
            tool.name !== "frontier.approval_approve" &&
            tool.name !== "frontier.command_resume" &&
            tool.name !== "frontier.command_retry" &&
            tool.name !== "frontier.command_requeue" &&
            tool.name !== "frontier.command_cancel",
        );
  const results: FrontierMcpSmokeResult["results"] = [];
  for (const tool of smokeTools) {
    const startedAt = Date.now();
    try {
      const result = await callMcpTool(tool.name, smokeInput(tool.name));
      results.push({
        tool: tool.name,
        ok: true,
        servedBy: result.servedBy,
        durationMs: Date.now() - startedAt,
        error: null,
      });
    } catch (e) {
      results.push({
        tool: tool.name,
        ok: false,
        servedBy: null,
        durationMs: Date.now() - startedAt,
        error: e instanceof Error ? e.message : String(e),
      });
    }
  }
  if (options.readOnly !== true) {
    await smokeWriteFlows(results);
  }
  const failed = results.filter((result) => !result.ok).length;
  const passed = results.length - failed;
  closeLedger();
  return {
    status: failed === 0 ? "ok" : "failed",
    readOnly: options.readOnly === true,
    generatedAt: new Date().toISOString(),
    toolCount: results.length,
    passed,
    failed,
    results,
  };
}

async function smokeWriteFlows(
  results: FrontierMcpSmokeResult["results"],
): Promise<void> {
  let actualCommandId: string | null = null;
  await runSmokeCase(results, "frontier.command_submit#actual", async () => {
    const result = await callMcpTool("frontier.command_submit", {
      intent: "status frontier-os",
      projectId: "frontier-os",
      actorId: "mcp-smoke-live",
    });
    const command = commandFromOutput(result.output);
    const status = stringFromUnknown(command.status);
    if (!status || !["queued", "running", "completed"].includes(status)) {
      throw new Error(`unexpected actual submit status: ${String(command.status)}`);
    }
    actualCommandId = requiredString(command.commandId, "missing commandId");
    return result.servedBy;
  });

  await runSmokeCase(results, "frontier.command_packet#followup", async () => {
    if (!actualCommandId) throw new Error("missing commandId from actual submit");
    const result = await callMcpTool("frontier.command_packet", {
      commandId: actualCommandId,
    });
    const packet = recordFromUnknown(result.output);
    if (stringFromUnknown(packet.packetVersion) !== "v1") {
      throw new Error("command packet did not return packetVersion=v1");
    }
    const command = recordFromUnknown(packet.command);
    if (stringFromUnknown(command.commandId) !== actualCommandId) {
      throw new Error("command packet returned the wrong command");
    }
    return result.servedBy;
  });

  let blockedCommandId: string | null = null;
  let blockedTraceId: string | null = null;
  await runSmokeCase(results, "frontier.command_submit#blocked", async () => {
    const result = await callMcpTool("frontier.command_submit", {
      intent: "repair ghost shift",
      projectId: "frontier-os",
      actorId: "mcp-smoke-approval",
    });
    const command = commandFromOutput(result.output);
    const status = stringFromUnknown(command.status);
    if (status !== "blocked_approval") {
      throw new Error(`expected blocked_approval, got ${String(command.status)}`);
    }
    blockedCommandId = requiredString(command.commandId, "missing blocked commandId");
    blockedTraceId = requiredString(command.traceId, "missing blocked traceId");
    return result.servedBy;
  });

  await runSmokeCase(results, "frontier.approval_approve#manual", async () => {
    if (!blockedTraceId) throw new Error("missing blocked traceId");
    const result = await callMcpTool("frontier.approval_approve", {
      traceId: blockedTraceId,
      ttl: "15m",
      actorId: "mcp-smoke-approval",
      resume: false,
    });
    const body = recordFromUnknown(result.output);
    const status = stringFromUnknown(body.status);
    if (status !== "approved" && status !== "already_approved") {
      throw new Error(`unexpected approval status: ${String(body.status)}`);
    }
    if (body.resumedCommand !== null && body.resumedCommand !== undefined) {
      throw new Error("approval approve resumed the command despite resume=false");
    }
    return result.servedBy;
  });

  await runSmokeCase(results, "frontier.command_resume#approved", async () => {
    if (!blockedCommandId || !blockedTraceId) {
      throw new Error("missing blocked command inputs");
    }
    const result = await callMcpTool("frontier.command_resume", {
      commandId: blockedCommandId,
      approval: blockedTraceId,
      actorId: "mcp-smoke-approval",
    });
    const command = commandFromOutput(result.output);
    const status = stringFromUnknown(command.status);
    if (!status || !["queued", "running", "completed"].includes(status)) {
      throw new Error(`unexpected resumed status: ${String(command.status)}`);
    }
    return result.servedBy;
  });

  await runSmokeCase(results, "frontier.command_final_brief#followup", async () => {
    if (!blockedCommandId) throw new Error("missing blocked commandId");
    const result = await callMcpTool("frontier.command_final_brief", {
      commandId: blockedCommandId,
      eventLimit: 10,
    });
    const body = recordFromUnknown(result.output);
    const command = recordFromUnknown(body.command);
    if (stringFromUnknown(command.commandId) !== blockedCommandId) {
      throw new Error("final brief returned the wrong command");
    }
    return result.servedBy;
  });

  let failedCommandId: string | null = null;
  {
    const store = new CommandStore();
    try {
      const failed = store.submit({
        intent: "status frontier-os",
        projectId: "frontier-os",
        actorId: "mcp-smoke-retry-source",
        surface: "automation",
        origin: "frontier-mcp-smoke",
      });
      store.finishCommand({
        commandId: failed.commandId,
        status: "failed",
        result: { summary: "forced failure for retry smoke" },
        error: "forced retry smoke failure",
        actor: "mcp-smoke",
      });
      failedCommandId = failed.commandId;
    } finally {
      store.close();
    }
  }

  await runSmokeCase(results, "frontier.command_retry#failed", async () => {
    if (!failedCommandId) throw new Error("missing failed commandId");
    const result = await callMcpTool("frontier.command_retry", {
      commandId: failedCommandId,
      actorId: "mcp-smoke-retry",
    });
    const body = recordFromUnknown(result.output);
    const sourceCommand = recordFromUnknown(body.sourceCommand);
    const command = commandFromOutput(result.output);
    if (stringFromUnknown(sourceCommand.commandId) !== failedCommandId) {
      throw new Error("retry returned the wrong source command");
    }
    if (stringFromUnknown(sourceCommand.status) !== "failed") {
      throw new Error("retry did not preserve failed source status");
    }
    if (stringFromUnknown(command.commandId) === failedCommandId) {
      throw new Error("retry did not mint a fresh command");
    }
    const status = stringFromUnknown(command.status);
    if (!status || !["queued", "running", "completed"].includes(status)) {
      throw new Error(`unexpected retry status: ${String(command.status)}`);
    }
    return result.servedBy;
  });

  let requeueSourceCommandId: string | null = null;
  {
    const store = new CommandStore();
    try {
      const command = store.submit({
        intent: "repair ghost shift",
        projectId: "frontier-os",
        actorId: "mcp-smoke-requeue-source",
        surface: "automation",
        origin: "frontier-mcp-smoke",
      });
      requeueSourceCommandId = command.commandId;
    } finally {
      store.close();
    }
  }

  await runSmokeCase(results, "frontier.command_requeue#blocked", async () => {
    if (!requeueSourceCommandId) throw new Error("missing requeue source commandId");
    const result = await callMcpTool("frontier.command_requeue", {
      commandId: requeueSourceCommandId,
      actorId: "mcp-smoke-requeue",
    });
    const body = recordFromUnknown(result.output);
    const sourceCommand = recordFromUnknown(body.sourceCommand);
    const command = commandFromOutput(result.output);
    if (stringFromUnknown(sourceCommand.commandId) !== requeueSourceCommandId) {
      throw new Error("requeue returned the wrong source command");
    }
    if (stringFromUnknown(sourceCommand.status) !== "canceled") {
      throw new Error("requeue did not cancel the source command");
    }
    if (stringFromUnknown(command.commandId) === requeueSourceCommandId) {
      throw new Error("requeue did not mint a fresh command");
    }
    if (stringFromUnknown(command.status) !== "blocked_approval") {
      throw new Error(`unexpected requeue status: ${String(command.status)}`);
    }
    return result.servedBy;
  });

  let cancelCommandId: string | null = null;
  {
    const store = new CommandStore();
    try {
      const command = store.submit({
        intent: "status frontier-os",
        projectId: "frontier-os",
        actorId: "mcp-smoke-cancel-source",
        surface: "automation",
        origin: "frontier-mcp-smoke",
      });
      cancelCommandId = command.commandId;
    } finally {
      store.close();
    }
  }

  await runSmokeCase(results, "frontier.command_cancel#queued", async () => {
    if (!cancelCommandId) throw new Error("missing cancel commandId");
    const result = await callMcpTool("frontier.command_cancel", {
      commandId: cancelCommandId,
      actorId: "mcp-smoke-cancel",
    });
    const command = commandFromOutput(result.output);
    if (stringFromUnknown(command.commandId) !== cancelCommandId) {
      throw new Error("cancel returned the wrong command");
    }
    if (stringFromUnknown(command.status) !== "canceled") {
      throw new Error(`unexpected cancel status: ${String(command.status)}`);
    }
    return result.servedBy;
  });
}

async function runSmokeCase(
  results: FrontierMcpSmokeResult["results"],
  tool: string,
  run: () => Promise<"frontierd" | "local">,
): Promise<void> {
  const startedAt = Date.now();
  try {
    const servedBy = await run();
    results.push({
      tool,
      ok: true,
      servedBy,
      durationMs: Date.now() - startedAt,
      error: null,
    });
  } catch (e) {
    results.push({
      tool,
      ok: false,
      servedBy: null,
      durationMs: Date.now() - startedAt,
      error: e instanceof Error ? e.message : String(e),
    });
  }
}

async function invokeTool(
  name: string,
  input: Record<string, unknown>,
): Promise<{ servedBy: "frontierd" | "local"; body: unknown }> {
  const daemon = await tryDaemonTool(name, input);
  if (daemon !== null) return daemon;
  return { servedBy: "local", body: await localTool(name, input) };
}

async function tryDaemonTool(
  name: string,
  input: Record<string, unknown>,
): Promise<{ servedBy: "frontierd"; body: unknown } | null> {
  if (name === "frontier.command_submit" && input.dryRun === true) return null;
  const { requestDaemon } = await import("../daemon/server.ts");
  const toolRequest = daemonRequestForTool(name, input);
  const requestOptions: Parameters<typeof requestDaemon>[1] = {
    timeoutMs: 2500,
  };
  if (toolRequest.method !== undefined) requestOptions.method = toolRequest.method;
  if (toolRequest.body !== undefined) requestOptions.body = toolRequest.body;
  const result = await requestDaemon(toolRequest.path, requestOptions);
  if (!result.reachable || result.statusCode !== 200) return null;
  return { servedBy: "frontierd", body: result.body };
}

function daemonRequestForTool(
  name: string,
  input: Record<string, unknown>,
): {
  path: string;
  method?: "GET" | "POST";
  body?: Record<string, unknown>;
} {
  switch (name) {
    case "frontier.project_list":
      return { path: "/v1/projects" };
    case "frontier.project_status": {
      const projectId = typeof input.projectId === "string" ? input.projectId : "";
      return {
        path: projectId
          ? `/v1/projects/${encodeURIComponent(projectId)}/status`
          : "/v1/projects/status",
      };
    }
    case "frontier.project_next": {
      const projectId = typeof input.projectId === "string" ? input.projectId : "";
      if (!projectId) throw new Error("frontier.project_next requires projectId");
      return { path: `/v1/projects/${encodeURIComponent(projectId)}/next` };
    }
    case "frontier.ops_status":
      return { path: "/v1/ops/status" };
    case "frontier.ledger_recent":
      return { path: `/v1/ledger/recent?limit=${boundedLimit(input.limit, 25)}` };
    case "frontier.watcher_status":
      return { path: "/v1/watchers" };
    case "frontier.ghost_status":
      return { path: "/v1/ghost/status" };
    case "frontier.approval_list":
      return { path: `/v1/approvals?limit=${boundedLimit(input.limit, 25)}` };
    case "frontier.approval_approve":
      return {
        path: "/v1/approvals/approve",
        method: "POST",
        body: approvalApproveBody(input),
      };
    case "frontier.command_submit":
      return {
        path: "/v1/commands",
        method: "POST",
        body: commandSubmitBody(input),
      };
    case "frontier.command_list":
      return { path: commandListPath(input) };
    case "frontier.command_show":
      return {
        path: `/v1/commands/${encodeURIComponent(commandIdFromInput(input))}`,
      };
    case "frontier.command_packet":
      return {
        path: `/v1/commands/${encodeURIComponent(commandIdFromInput(input))}/packet`,
      };
    case "frontier.command_final_brief":
      return {
        path: `/v1/commands/${encodeURIComponent(
          commandIdFromInput(input),
        )}/brief?eventLimit=${boundedLimit(input.eventLimit, 50)}`,
      };
    case "frontier.command_brief":
      return {
        path: `/v1/command-brief?hours=${boundedLimit(
          input.hours,
          24,
        )}&limit=${boundedLimit(input.limit, 100)}`,
      };
    case "frontier.command_readiness":
      return {
        path: `/v1/command-readiness?hours=${boundedLimit(
          input.hours,
          24,
        )}&limit=${boundedLimit(input.limit, 100)}`,
      };
    case "frontier.command_debt":
      return {
        path: `/v1/command-debt?limit=${boundedLimit(input.limit, 100)}`,
      };
    case "frontier.command_resume": {
      const request = commandResumeRequest(input);
      return {
        path: `/v1/commands/${encodeURIComponent(request.commandId)}/resume`,
        method: "POST",
        body: request.body,
      };
    }
    case "frontier.command_retry": {
      const request = commandOperatorRequest(input);
      return {
        path: `/v1/commands/${encodeURIComponent(request.commandId)}/retry`,
        method: "POST",
        body: request.body,
      };
    }
    case "frontier.command_requeue": {
      const request = commandOperatorRequest(input);
      return {
        path: `/v1/commands/${encodeURIComponent(request.commandId)}/requeue`,
        method: "POST",
        body: request.body,
      };
    }
    case "frontier.command_cancel": {
      const request = commandOperatorRequest(input);
      return {
        path: `/v1/commands/${encodeURIComponent(request.commandId)}/cancel`,
        method: "POST",
        body: request.body,
      };
    }
    case "frontier.client_status":
      return { path: "/v1/client/status" };
    case "frontier.overnight_plan":
      return { path: `/v1/overnight/plan?hours=${boundedLimit(input.hours, 8)}` };
    case "frontier.overnight_brief":
      return { path: `/v1/overnight/brief?hours=${boundedLimit(input.hours, 24)}` };
    default:
      throw new Error(`no daemon path for MCP tool: ${name}`);
  }
}

async function localTool(
  name: string,
  input: Record<string, unknown>,
): Promise<unknown> {
  switch (name) {
    case "frontier.project_list": {
      const { listProjects } = await import("../projects/registry.ts");
      return { projects: listProjects() };
    }
    case "frontier.project_status": {
      const { projectStatus } = await import("../projects/registry.ts");
      const projectId =
        typeof input.projectId === "string" ? input.projectId : undefined;
      const status = await projectStatus(projectId);
      return Array.isArray(status)
        ? {
            generatedAt: new Date().toISOString(),
            projectCount: status.length,
            projects: status,
          }
        : { generatedAt: new Date().toISOString(), project: status };
    }
    case "frontier.project_next": {
      const { projectNext } = await import("../projects/planner.ts");
      const projectId =
        typeof input.projectId === "string" ? input.projectId : "";
      if (!projectId) throw new Error("frontier.project_next requires projectId");
      return await projectNext(projectId);
    }
    case "frontier.ops_status": {
      const { opsStatus } = await import("../ops/status.ts");
      return await opsStatus();
    }
    case "frontier.ledger_recent": {
      const ledger = getLedger();
      const limit = boundedLimit(input.limit, 25);
      return {
        sessions: ledger.listSessions(limit),
        events: ledger.recentEvents(limit),
      };
    }
    case "frontier.watcher_status": {
      const { opsStatus } = await import("../ops/status.ts");
      const ops = await opsStatus();
      return {
        generatedAt: ops.generatedAt,
        watchers: ops.watchers,
        scheduler: ops.scheduler,
      };
    }
    case "frontier.ghost_status": {
      const { defaultQueueDir, queueStatus } = await import("../ghost/shift.ts");
      const queueDir = defaultQueueDir();
      return { queueDir, counts: queueStatus(queueDir) };
    }
    case "frontier.approval_list": {
      const limit = boundedLimit(input.limit, 25);
      const { approvalQueue } = await import("../approvals/queue.ts");
      return approvalQueue({ limit });
    }
    case "frontier.approval_approve": {
      const { approvePendingTrace } = await import("../approvals/queue.ts");
      const {
        dispatchCommandIfRunnable,
        dispatchedWorkerForCommand,
      } = await import("../commands/dispatch.ts");
      const body = approvalApproveBody(input);
      const traceId = String(body.traceId);
      const actor = stringFromUnknown(body.actor) ?? "mcp";
      const ttl = stringFromUnknown(body.ttl) ?? undefined;
      const approvalInput: Parameters<typeof approvePendingTrace>[0] = {
        traceId,
        actor,
      };
      if (ttl) approvalInput.ttl = ttl;
      const approval = approvePendingTrace(approvalInput);
      const autoResume = booleanFromUnknown(body.resume);
      const store = new CommandStore();
      let resumedCommand = null;
      try {
        const command = store.getByTraceId(traceId);
        resumedCommand =
          autoResume !== false && command?.status === "blocked_approval"
            ? store.resume({
                commandId: command.commandId,
                approvalTraceId: traceId,
                actor,
              })
            : null;
      } finally {
        store.close();
      }
      const dispatched =
        resumedCommand === null
          ? null
          : await dispatchCommandIfRunnable({
              commandId: resumedCommand.commandId,
              workerId: "mcp",
            });
      return {
        ...approval,
        resumedCommand: dispatched?.command ?? resumedCommand,
        ...(resumedCommand &&
        dispatchedWorkerForCommand(resumedCommand.commandId, dispatched?.worker ?? null)
          ? { worker: dispatched?.worker ?? null }
          : {}),
        ...(dispatched?.dispatchError ? { dispatchError: dispatched.dispatchError } : {}),
      };
    }
    case "frontier.command_submit": {
      const store = new CommandStore();
      const {
        dispatchCommandIfRunnable,
        dispatchedWorkerForCommand,
      } = await import("../commands/dispatch.ts");
      let command = null;
      try {
        command = store.submit(commandSubmitInput(input));
      } finally {
        store.close();
      }
      const dispatched = await dispatchCommandIfRunnable({
        commandId: command.commandId,
        workerId: "mcp",
      });
      return {
        command: dispatched.command ?? command,
        ...(dispatchedWorkerForCommand(command.commandId, dispatched.worker)
          ? { worker: dispatched.worker }
          : {}),
        ...(dispatched.dispatchError ? { dispatchError: dispatched.dispatchError } : {}),
      };
    }
    case "frontier.command_list": {
      const store = new CommandStore();
      try {
        return {
          generatedAt: new Date().toISOString(),
          commands: store.list(commandListOptions(input)),
        };
      } finally {
        store.close();
      }
    }
    case "frontier.command_show": {
      const store = new CommandStore();
      try {
        const command = store.get(commandIdFromInput(input));
        if (!command) throw new Error("unknown command");
        return { command };
      } finally {
        store.close();
      }
    }
    case "frontier.command_packet": {
      const { commandResultPacket } = await import("../commands/packet.ts");
      return commandResultPacket(commandIdFromInput(input));
    }
    case "frontier.command_final_brief": {
      const { commandFinalBrief } = await import("../commands/final-brief.ts");
      return commandFinalBrief(commandIdFromInput(input), {
        eventLimit: boundedLimit(input.eventLimit, 50),
      });
    }
    case "frontier.command_brief": {
      const { commandBrief } = await import("../commands/brief.ts");
      return commandBrief({
        hours: boundedLimit(input.hours, 24),
        limit: boundedLimit(input.limit, 100),
      });
    }
    case "frontier.command_readiness": {
      const { commandReadiness } = await import("../commands/readiness.ts");
      return commandReadiness({
        hours: boundedLimit(input.hours, 24),
        limit: boundedLimit(input.limit, 100),
      });
    }
    case "frontier.command_debt": {
      const { commandDebt } = await import("../commands/debt.ts");
      return commandDebt({
        limit: boundedLimit(input.limit, 100),
      });
    }
    case "frontier.command_resume": {
      const request = commandResumeRequest(input);
      const store = new CommandStore();
      const {
        dispatchCommandIfRunnable,
        dispatchedWorkerForCommand,
      } = await import("../commands/dispatch.ts");
      let command = null;
      try {
        command = store.resume({
          commandId: request.commandId,
          ...(typeof request.body.approval === "string"
            ? { approvalTraceId: request.body.approval }
            : {}),
          ...(typeof request.body.actor === "string"
            ? { actor: request.body.actor }
            : {}),
          ...(isRecord(request.body.resumePayload)
            ? { resumePayload: request.body.resumePayload }
            : {}),
        });
      } finally {
        store.close();
      }
      const dispatched = await dispatchCommandIfRunnable({
        commandId: command.commandId,
        workerId: "mcp",
      });
      return {
        command: dispatched.command ?? command,
        ...(dispatchedWorkerForCommand(command.commandId, dispatched.worker)
          ? { worker: dispatched.worker }
          : {}),
        ...(dispatched.dispatchError ? { dispatchError: dispatched.dispatchError } : {}),
      };
    }
    case "frontier.command_retry": {
      const request = commandOperatorRequest(input);
      const store = new CommandStore();
      try {
        return store.retry(
          request.commandId,
          typeof request.body.actor === "string" ? request.body.actor : "mcp",
        );
      } finally {
        store.close();
      }
    }
    case "frontier.command_requeue": {
      const request = commandOperatorRequest(input);
      const store = new CommandStore();
      try {
        return store.requeue(
          request.commandId,
          typeof request.body.actor === "string" ? request.body.actor : "mcp",
        );
      } finally {
        store.close();
      }
    }
    case "frontier.command_cancel": {
      const request = commandOperatorRequest(input);
      const store = new CommandStore();
      try {
        return {
          command: store.cancel(
            request.commandId,
            typeof request.body.actor === "string" ? request.body.actor : "mcp",
          ),
        };
      } finally {
        store.close();
      }
    }
    case "frontier.client_status": {
      const { clientStatus } = await import("../client/status.ts");
      return await clientStatus();
    }
    case "frontier.overnight_plan": {
      const { overnightPlan } = await import("../overnight/plan.ts");
      return await overnightPlan({ hours: boundedLimit(input.hours, 8) });
    }
    case "frontier.overnight_brief": {
      const { overnightBrief } = await import("../overnight/brief.ts");
      return overnightBrief({ hours: boundedLimit(input.hours, 24) });
    }
    default:
      throw new Error(`no local handler for MCP tool: ${name}`);
  }
}

function appendMcpEvent(
  kind: Extract<EventKind, "mcp.request" | "mcp.response" | "mcp.denied">,
  traceId: string,
  payload: Record<string, unknown>,
): void {
  const ledger = getLedger();
  const sessionId = `mcp-bridge-${traceId}`;
  ledger.ensureSession({
    sessionId,
    label: "mcp-bridge",
    tags: ["mcp", "tools"],
  });
  ledger.appendEvent({
    sessionId,
    kind,
    actor: "mcp",
    traceId,
    payload,
  });
}

function mcpToolVerb(name: string): string {
  return `mcp.${name.replace(/^frontier\./, "")}`;
}

function smokeInput(name: string): Record<string, unknown> {
  if (name === "frontier.project_next") return { projectId: "frontier-os" };
  if (name === "frontier.command_submit") {
    return { intent: "status frontier-os", projectId: "frontier-os", dryRun: true };
  }
  if (name === "frontier.command_list") return { limit: 3 };
  if (name === "frontier.command_final_brief") return { eventLimit: 10 };
  if (name === "frontier.command_brief" || name === "frontier.command_readiness") {
    return { hours: 24, limit: 25 };
  }
  if (name === "frontier.command_debt") return { limit: 25 };
  if (name === "frontier.overnight_plan") return { hours: 8 };
  if (name === "frontier.overnight_brief") return { hours: 1 };
  if (name === "frontier.ledger_recent" || name === "frontier.approval_list") {
    return { limit: 5 };
  }
  return {};
}

function commandSubmitBody(input: Record<string, unknown>): Record<string, unknown> {
  const intent = stringFromUnknown(input.intent) ?? "";
  if (!intent) throw new Error("frontier.command_submit requires intent");
  const body: Record<string, unknown> = {
    intent,
    actorId: stringFromUnknown(input.actorId) ?? "mcp",
  };
  const projectId = stringFromUnknown(input.projectId);
  if (projectId) body.projectId = projectId;
  const traceId = stringFromUnknown(input.traceId);
  if (traceId) body.traceId = traceId;
  const correlationId = stringFromUnknown(input.correlationId);
  if (correlationId) body.correlationId = correlationId;
  const approvalClass = approvalClassFromInput(input.approvalClass);
  if (approvalClass !== null) body.approvalClass = approvalClass;
  if (isRecord(input.payload)) body.payload = input.payload;
  const policy: Record<string, unknown> = {};
  for (const key of ["maxRuntimeSeconds", "maxRetries", "retryBackoffMs"]) {
    const value = input[key];
    if (typeof value === "number" && Number.isFinite(value)) policy[key] = value;
  }
  const requireVerification = booleanFromUnknown(input.requireVerification);
  if (requireVerification !== null) {
    policy.requireVerification = requireVerification;
  }
  const allowSideEffects = booleanFromUnknown(input.allowSideEffects);
  if (allowSideEffects !== null) {
    policy.allowSideEffects = allowSideEffects;
  }
  if (Object.keys(policy).length > 0) body.policy = policy;
  return body;
}

function commandSubmitInput(
  input: Record<string, unknown>,
): Parameters<CommandStore["submit"]>[0] {
  const body = commandSubmitBody(input);
  const submitInput: Parameters<CommandStore["submit"]>[0] = {
    intent: String(body.intent),
    actorId: typeof body.actorId === "string" ? body.actorId : "mcp",
    surface: "automation",
    origin: "frontier-mcp",
  };
  if (typeof body.projectId === "string") submitInput.projectId = body.projectId;
  if (typeof body.traceId === "string") submitInput.traceId = body.traceId;
  if (typeof body.correlationId === "string") {
    submitInput.correlationId = body.correlationId;
  }
  if (typeof body.approvalClass === "number") {
    submitInput.approvalClass = body.approvalClass as NonNullable<
      typeof submitInput.approvalClass
    >;
  }
  if (isRecord(body.payload)) submitInput.payload = body.payload;
  if (input.dryRun === true) submitInput.dryRun = true;
  if (isRecord(body.policy)) submitInput.policy = body.policy;
  return submitInput;
}

function approvalApproveBody(input: Record<string, unknown>): Record<string, unknown> {
  const traceId = stringFromUnknown(input.traceId);
  if (!traceId) throw new Error("frontier.approval_approve requires traceId");
  const body: Record<string, unknown> = {
    traceId,
    actor: stringFromUnknown(input.actorId) ?? "mcp",
  };
  const ttl = stringFromUnknown(input.ttl);
  if (ttl) body.ttl = ttl;
  const resume = booleanFromUnknown(input.resume);
  if (resume !== null) body.resume = resume;
  return body;
}

function commandResumeRequest(input: Record<string, unknown>): {
  commandId: string;
  body: Record<string, unknown>;
} {
  const commandId = commandIdFromInput(input);
  const body: Record<string, unknown> = {};
  const approval = stringFromUnknown(input.approval);
  if (approval) body.approval = approval;
  const actor = stringFromUnknown(input.actorId);
  if (actor) body.actor = actor;
  if (isRecord(input.resumePayload)) body.resumePayload = input.resumePayload;
  return { commandId, body };
}

function commandOperatorRequest(input: Record<string, unknown>): {
  commandId: string;
  body: Record<string, unknown>;
} {
  const commandId = commandIdFromInput(input);
  const body: Record<string, unknown> = {};
  const actor = stringFromUnknown(input.actorId);
  if (actor) body.actor = actor;
  return { commandId, body };
}

function commandListPath(input: Record<string, unknown>): string {
  const params = new URLSearchParams();
  params.set("limit", String(boundedLimit(input.limit, 25)));
  if (typeof input.status === "string" && input.status.trim()) {
    params.set("status", input.status.trim());
  }
  return `/v1/commands?${params.toString()}`;
}

function commandListOptions(
  input: Record<string, unknown>,
): Parameters<CommandStore["list"]>[0] {
  const options: Parameters<CommandStore["list"]>[0] = {
    limit: boundedLimit(input.limit, 25),
  };
  if (typeof input.status === "string" && input.status.trim()) {
    options.status = input.status.trim() as NonNullable<typeof options.status>;
  }
  return options;
}

function commandIdFromInput(input: Record<string, unknown>): string {
  if (typeof input.commandId === "string" && input.commandId.trim()) {
    return input.commandId.trim();
  }
  const store = new CommandStore();
  try {
    const latest = store.list({ limit: 1 })[0];
    if (!latest) throw new Error("no commands available");
    return latest.commandId;
  } finally {
    store.close();
  }
}

function boundedLimit(value: unknown, fallback: number): number {
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isInteger(n) || n <= 0) return fallback;
  return Math.min(n, 100);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function recordFromUnknown(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {};
}

function stringFromUnknown(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function booleanFromUnknown(value: unknown): boolean | null {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value === "boolean") return value;
  if (value === "true" || value === "1") return true;
  if (value === "false" || value === "0") return false;
  throw new Error(`expected boolean, got: ${String(value)}`);
}

function approvalClassFromInput(value: unknown): ApprovalClass | null {
  if (value === undefined || value === null || value === "") return null;
  const n = typeof value === "number" ? value : Number(String(value));
  if (n === 0 || n === 1 || n === 2 || n === 3) return n;
  throw new Error(`invalid approval class: ${String(value)}`);
}

function commandFromOutput(output: unknown): Record<string, unknown> {
  const body = recordFromUnknown(output);
  const command = recordFromUnknown(body.command);
  if (Object.keys(command).length === 0) {
    throw new Error("MCP command tool did not return a command record");
  }
  return command;
}

function requiredString(value: unknown, message: string): string {
  const parsed = stringFromUnknown(value);
  if (!parsed) throw new Error(message);
  return parsed;
}

function objectSchema(properties: Record<string, unknown>): Record<string, unknown> {
  return {
    type: "object",
    additionalProperties: false,
    properties,
  };
}
