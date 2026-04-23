import { MEMORY_CLASSES, type MemoryClass } from "../memory/schema.ts";
import { MemoryStore, type MemoryBlock } from "../memory/store.ts";
import { assessCommandDebt, commandOperatorAction } from "./debt.ts";
import { commandOperatorAudit } from "./operator.ts";
import { packetFromRecord } from "./packet.ts";
import { CommandStore, type CommandRecord } from "./store.ts";

export interface RememberCommandOptions {
  memoryClass?: MemoryClass;
  namespace?: string;
  label?: string;
}

export interface RememberCommandResult {
  commandId: string;
  memoryClass: MemoryClass;
  namespace: string;
  label: string;
  block: MemoryBlock;
}

export function rememberCommand(
  commandId: string,
  options: RememberCommandOptions = {},
): RememberCommandResult {
  const memoryClass = options.memoryClass ?? "run";
  if (!MEMORY_CLASSES.includes(memoryClass)) {
    throw new Error(`invalid memory class: ${memoryClass}`);
  }

  const commandStore = new CommandStore();
  const memoryStore = new MemoryStore();
  try {
    const command = commandStore.get(commandId);
    if (!command) throw new Error(`unknown command: ${commandId}`);
    const namespace =
      options.namespace ?? `commands/${command.lane ?? "unknown"}`;
    const label = options.label ?? command.commandId;
    const block = memoryStore.put(memoryClass, namespace, label, {
      description: `${command.status} command: ${command.intent}`,
      value: commandMemoryValue(command),
      metadata: {
        source: "frontier.command.remember",
        commandId: command.commandId,
        traceId: command.traceId,
        status: command.status,
        lane: command.lane,
        verb: command.verb,
        projectId: command.projectId,
        approvalClass: command.approvalClass,
        updatedAt: command.updatedAt,
      },
    });
    return {
      commandId: command.commandId,
      memoryClass,
      namespace,
      label,
      block,
    };
  } finally {
    commandStore.close();
    memoryStore.close();
  }
}

function commandMemoryValue(command: CommandRecord): string {
  const packet = packetFromRecord(command);
  const debt = assessCommandDebt(command);
  const operator = commandOperatorAudit(command, { debt });
  const recommended = commandOperatorAction(command, debt);
  const lines = [
    `# Frontier Command ${command.commandId}`,
    "",
    `- Intent: ${command.intent}`,
    `- Status: ${command.status}`,
    `- Trace: ${command.traceId}`,
    `- Lane: ${command.lane ?? "unknown"}`,
    `- Verb: ${command.verb ?? "unknown"}`,
    `- Project: ${command.projectId ?? "none"}`,
    `- Approval class: ${command.approvalClass ?? "unknown"}`,
    `- Requested: ${command.requestedAt}`,
    `- Updated: ${command.updatedAt}`,
  ];
  if (command.error) lines.push(`- Error: ${command.error}`);
  const resultSummary = extractResultSummary(command.result);
  if (resultSummary) lines.push(`- Result: ${resultSummary}`);
  if (command.plan?.workGraphPath) {
    lines.push(`- Work graph: ${command.plan.workGraphPath}`);
  }
  if (command.activities.length > 0) {
    lines.push("", "## Activities");
    for (const activity of command.activities) {
      lines.push(
        `- ${activity.sequence}: ${activity.verb} ${activity.status} attempts=${activity.attempts}`,
      );
    }
  }
  lines.push("", "## Packet");
  lines.push(`- Execution: ${packet.execution.kind}`);
  lines.push(`- Structured outputs: ${packet.outputs.structured.length}`);
  lines.push(`- Adapter dispatches: ${packet.outputs.adapterDispatches.length}`);
  lines.push(`- Artifact files: ${packet.evidence.files}`);
  lines.push(`- Ledger events: ${packet.evidence.ledgerEventCount}`);
  lines.push("", "## Debt");
  lines.push(`- Kind: ${debt.kind}`);
  lines.push(`- Stale: ${debt.stale ? "yes" : "no"}`);
  lines.push(`- Age minutes: ${debt.ageMinutes}`);
  if (debt.thresholdMinutes !== null) {
    lines.push(`- Threshold minutes: ${debt.thresholdMinutes}`);
  }
  if (debt.summary) lines.push(`- Summary: ${debt.summary}`);
  lines.push("", "## Operator");
  lines.push(`- Recommended action: ${recommended.action ?? "none"}`);
  if (recommended.command) lines.push(`- Recommended command: ${recommended.command}`);
  if (operator.sourceCommandId) lines.push(`- Source command: ${operator.sourceCommandId}`);
  if (operator.replacementCommandId) {
    lines.push(`- Replacement command: ${operator.replacementCommandId}`);
  }
  if (operator.lastActionSummary) lines.push(`- Last action: ${operator.lastActionSummary}`);
  lines.push(`- Audit events: ${operator.actionCount}`);
  if (operator.recentActions.length > 0) {
    lines.push("", "## Recent Operator Audit");
    for (const action of operator.recentActions.slice(0, 5)) {
      lines.push(`- ${action.ts}: ${action.summary}`);
    }
  }
  return `${lines.join("\n")}\n`;
}

function extractResultSummary(
  result: Record<string, unknown> | null,
): string | null {
  if (!result) return null;
  const summary = result.summary;
  if (typeof summary === "string" && summary.length > 0) return summary;
  const output = result.output;
  if (isRecord(output)) {
    const outputSummary = output.summary;
    if (typeof outputSummary === "string" && outputSummary.length > 0) {
      return outputSummary;
    }
    const status = output.status;
    if (typeof status === "string" && status.length > 0) return status;
  }
  return null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
