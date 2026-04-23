// One-round Worktree Swarm executor.
//
// Flow (Magentic-One single-round):
//   1. Planner → Task Ledger (facts + plan with step assignments)
//   2. Readers (sequential — see research-adapter note on execa+claude-p) for
//      every step with assignedTo === "reader"
//   3. Writer → deliverable synthesized from reader findings
//   4. Verifier → Progress Ledger (satisfied? next_speaker? instruction?)
//
// Multi-round iteration (if !is_request_satisfied → replan → re-run readers)
// is a v0.2 concern. For now the verdict is emitted and the operator decides.
//
// Reuses the subprocess wrapper from the research adapter so the Claude-p
// bug-class we already solved (empty stdin, arg order, --max-budget-usd
// silent kill) stays solved.

import { callClaude } from "../adapters/research/claude-sub.ts";
import { getLedger, closeLedger } from "../ledger/index.ts";
import { newSessionId } from "../ledger/events.ts";
import {
  ensure,
  pathsFor,
  writeMetadata,
  writeReaderFinding,
  writeTaskLedger,
  writeVerdict,
  writeWriterDraft,
  type SwarmPaths,
} from "./artifacts.ts";
import {
  extractJsonObject,
  parseProgressLedger,
  parseTaskLedger,
  type AgentRole,
  type ProgressLedger,
  type TaskLedger,
  type TaskLedgerPlanStep,
} from "./ledgers.ts";
import {
  plannerPrompt,
  readerPrompt,
  verifierPrompt,
  writerPrompt,
} from "./roles.ts";

export interface SwarmRunInput {
  task: string;
  runId?: string;
  maxReaders?: number;
  timeoutMsPerRole?: number;
  orchestratorModel?: string;
  workerModel?: string;
}

export interface RoleInvocation {
  role: AgentRole;
  stepId?: string;
  ok: boolean;
  durationMs: number;
  words: number;
  path?: string;
}

export interface SwarmRunResult {
  runId: string;
  sessionId: string;
  startedAt: string;
  endedAt: string;
  totalDurationMs: number;
  task: string;
  paths: SwarmPaths;
  taskLedger: TaskLedger | null;
  progressLedger: ProgressLedger | null;
  invocations: RoleInvocation[];
  satisfied: boolean | null;
}

const DEFAULT_MAX_READERS = 3;

export async function runSwarm(input: SwarmRunInput): Promise<SwarmRunResult> {
  const startedAt = new Date().toISOString();
  const startMs = Date.now();
  const maxReaders = Math.max(
    1,
    Math.min(6, input.maxReaders ?? DEFAULT_MAX_READERS),
  );
  const runId = input.runId ?? newRunId(input.task);
  const paths = ensure(runId);
  const sessionId = newSessionId(`swarm-${runId}`);
  const ledger = getLedger();
  ledger.ensureSession({
    sessionId,
    label: `swarm:${runId}`,
    tags: ["swarm", runId],
  });
  ledger.appendEvent({
    sessionId,
    kind: "swarm.run_start",
    actor: "swarm.runner",
    payload: { runId, task: input.task, maxReaders },
  });

  const invocations: RoleInvocation[] = [];
  const modelOpts = roleModelOpts(input);

  // --- 1. Planner ---
  const plannerRes = await runRole(
    "planner",
    plannerPrompt({ task: input.task, maxReaders }),
    sessionId,
    modelOpts.orchestrator,
  );
  invocations.push({
    role: "planner",
    ok: plannerRes.ok,
    durationMs: plannerRes.durationMs,
    words: plannerRes.text.trim().split(/\s+/).length,
  });

  let taskLedger: TaskLedger | null = null;
  if (plannerRes.ok) {
    const raw = extractJsonObject(plannerRes.text);
    taskLedger = raw ? parseTaskLedger(raw) : null;
  }
  if (taskLedger) {
    writeTaskLedger(paths, taskLedger);
    ledger.appendEvent({
      sessionId,
      kind: "swarm.task_ledger",
      actor: "swarm.runner",
      payload: {
        runId,
        facts_verified: taskLedger.facts_verified.length,
        facts_to_look_up: taskLedger.facts_to_look_up.length,
        plan: taskLedger.plan.map((s) => ({
          stepId: s.stepId,
          assignedTo: s.assignedTo,
          title: s.title.slice(0, 120),
        })),
      },
    });
  }

  // --- 2. Readers ---
  const readerSteps: TaskLedgerPlanStep[] = (taskLedger?.plan ?? []).filter(
    (s) => s.assignedTo === "reader",
  );
  if (readerSteps.length === 0 && taskLedger === null) {
    // Planner failed — degrade to one reader with the raw task.
    readerSteps.push({
      stepId: "r1",
      title: input.task,
      assignedTo: "reader",
    });
  }
  const readerFindings: Array<{
    stepId: string;
    title: string;
    content: string;
  }> = [];
  for (let i = 0; i < Math.min(readerSteps.length, maxReaders); i++) {
    const step = readerSteps[i]!;
    const r = await runRole(
      "reader",
      readerPrompt({ task: input.task, step }),
      sessionId,
      modelOpts.worker,
      step.stepId,
    );
    const content = r.ok
      ? r.text.trim()
      : `_Reader failed: ${r.stderr.slice(0, 300)}_`;
    const path = writeReaderFinding(paths, i, step, content, {
      ok: r.ok,
      durationMs: r.durationMs,
      exitCode: r.exitCode,
    });
    readerFindings.push({ stepId: step.stepId, title: step.title, content });
    invocations.push({
      role: "reader",
      stepId: step.stepId,
      ok: r.ok,
      durationMs: r.durationMs,
      words: content.trim().split(/\s+/).length,
      path,
    });
  }

  // --- 3. Writer ---
  const writerRes = await runRole(
    "writer",
    writerPrompt({ task: input.task, readerFindings }),
    sessionId,
    modelOpts.worker,
  );
  const writerOutput = writerRes.ok
    ? writerRes.text.trim()
    : `_Writer failed: ${writerRes.stderr.slice(0, 300)}_`;
  writeWriterDraft(paths, input.task, writerOutput);
  invocations.push({
    role: "writer",
    ok: writerRes.ok,
    durationMs: writerRes.durationMs,
    words: writerOutput.trim().split(/\s+/).length,
    path: paths.writerDraft,
  });

  // --- 4. Verifier ---
  const verifierRes = await runRole(
    "verifier",
    verifierPrompt({
      task: input.task,
      writerOutput,
      plan: taskLedger?.plan ?? [],
    }),
    sessionId,
    modelOpts.orchestrator,
  );
  let progressLedger: ProgressLedger | null = null;
  if (verifierRes.ok) {
    const raw = extractJsonObject(verifierRes.text);
    progressLedger = raw ? parseProgressLedger(raw) : null;
  }
  if (progressLedger) {
    writeVerdict(paths, progressLedger, writerOutput);
    ledger.appendEvent({
      sessionId,
      kind: "swarm.progress_ledger",
      actor: "swarm.runner",
      payload: {
        runId,
        is_request_satisfied: progressLedger.is_request_satisfied.answer,
        is_in_loop: progressLedger.is_in_loop.answer,
        is_progress_being_made: progressLedger.is_progress_being_made.answer,
        next_speaker: progressLedger.next_speaker.answer,
      },
    });
  }
  invocations.push({
    role: "verifier",
    ok: verifierRes.ok,
    durationMs: verifierRes.durationMs,
    words: verifierRes.text.trim().split(/\s+/).length,
    path: paths.verdictMd,
  });

  const endedAt = new Date().toISOString();
  const totalDurationMs = Date.now() - startMs;
  const satisfied = progressLedger
    ? progressLedger.is_request_satisfied.answer
    : null;
  writeMetadata(paths, {
    runId,
    sessionId,
    startedAt,
    endedAt,
    totalDurationMs,
    task: input.task,
    maxReaders,
    invocations,
    satisfied,
  });
  ledger.appendEvent({
    sessionId,
    kind: "swarm.run_end",
    actor: "swarm.runner",
    payload: {
      runId,
      satisfied,
      totalDurationMs,
      roles: invocations.length,
      readersCompleted: invocations.filter((i) => i.role === "reader" && i.ok)
        .length,
    },
  });
  closeLedger();

  return {
    runId,
    sessionId,
    startedAt,
    endedAt,
    totalDurationMs,
    task: input.task,
    paths,
    taskLedger,
    progressLedger,
    invocations,
    satisfied,
  };
}

async function runRole(
  role: AgentRole,
  prompt: string,
  sessionId: string,
  model: string | undefined,
  stepId?: string,
): Promise<{
  ok: boolean;
  text: string;
  durationMs: number;
  exitCode: number | null;
  stderr: string;
}> {
  const ledger = getLedger();
  ledger.appendEvent({
    sessionId,
    kind: "swarm.role_start",
    actor: "swarm.runner",
    payload: {
      role,
      stepId: stepId ?? null,
      promptBytes: prompt.length,
    },
  });
  const callOpts: Parameters<typeof callClaude>[0] = { prompt };
  if (model !== undefined) callOpts.model = model;
  const r = await callClaude(callOpts);
  ledger.appendEvent({
    sessionId,
    kind: "swarm.role_end",
    actor: "swarm.runner",
    payload: {
      role,
      stepId: stepId ?? null,
      ok: r.ok,
      durationMs: r.durationMs,
      exitCode: r.exitCode,
      words: r.text.trim().split(/\s+/).length,
    },
  });
  return r;
}

function roleModelOpts(input: SwarmRunInput): {
  orchestrator: string | undefined;
  worker: string | undefined;
} {
  return {
    orchestrator: input.orchestratorModel,
    worker: input.workerModel,
  };
}

function newRunId(label: string): string {
  const t = Math.floor(Date.now() / 1000).toString(36);
  const r = Math.random().toString(36).slice(2, 8);
  const slug = label
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
  return slug ? `swarm_${t}_${slug}_${r}` : `swarm_${t}_${r}`;
}
