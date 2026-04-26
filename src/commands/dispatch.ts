import { CommandStore, type CommandRecord } from "./store.ts";
import {
  runCommandWorkerOnce,
  type CommandWorkerRunResult,
} from "./worker.ts";

export interface CommandDispatchResult {
  command: CommandRecord | null;
  worker: CommandWorkerRunResult | null;
  dispatchError: string | null;
}

export async function dispatchCommandIfRunnable(input: {
  commandId: string;
  workerId?: string;
}): Promise<CommandDispatchResult> {
  let worker: CommandWorkerRunResult | null = null;
  let dispatchError: string | null = null;
  try {
    worker = await runCommandWorkerOnce({
      commandId: input.commandId,
      ...(input.workerId ? { workerId: input.workerId } : {}),
    });
  } catch (e) {
    dispatchError = e instanceof Error ? e.message : String(e);
  }

  const store = new CommandStore();
  try {
    return {
      command: store.get(input.commandId),
      worker,
      dispatchError,
    };
  } finally {
    store.close();
  }
}

export function dispatchedWorkerForCommand(
  commandId: string,
  worker: CommandWorkerRunResult | null,
): CommandWorkerRunResult | null {
  if (!worker) return null;
  return worker.claimedCommandId === commandId ? worker : null;
}
