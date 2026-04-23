// Prompt builders for the four Magentic-One roles.
//
// Planner and verifier produce structured JSON (the Task Ledger and Progress
// Ledger respectively). Readers and writer produce markdown. Prompts follow
// Magentic-One's _prompts.py structure but tightened for brevity — the
// original templates assume a chat transcript; we're operating one-shot.

import type { AgentRole, TaskLedgerPlanStep } from "./ledgers.ts";

export interface RoleInput {
  task: string;
  maxReaders?: number;
}

export function plannerPrompt(input: RoleInput): string {
  const maxReaders = input.maxReaders ?? 3;
  return [
    `You are the PLANNER in a multi-agent Magentic-One-style swarm.`,
    ``,
    `Task:`,
    `"""${input.task}"""`,
    ``,
    `Produce a Task Ledger JSON with these fields:`,
    `- facts_verified: string[] — facts the task states that are already true`,
    `- facts_to_look_up: string[] — info a reader needs to gather (one per future reader step)`,
    `- facts_derived: string[] — facts that can be derived by reasoning`,
    `- educated_guesses: string[] — assumptions you're making`,
    `- plan: Step[] — an ordered plan where each Step is {stepId, title, assignedTo, rationale?}`,
    `  where assignedTo is one of: "reader" | "writer" | "verifier" | "planner"`,
    ``,
    `Design the plan so:`,
    `- Up to ${maxReaders} "reader" steps can run IN PARALLEL (they must be independent)`,
    `- Exactly 1 "writer" step synthesizes the readers' outputs into the deliverable`,
    `- Exactly 1 "verifier" step grades the writer's output against the original task`,
    ``,
    `Output ONLY the JSON object. No prose, no markdown fences. Start with '{'.`,
  ].join("\n");
}

export interface ReaderContext {
  task: string;
  step: TaskLedgerPlanStep;
}

export function readerPrompt(ctx: ReaderContext): string {
  return [
    `You are a READER in a Magentic-One-style swarm. Your scope is one specific step.`,
    ``,
    `Original task:`,
    `"""${ctx.task}"""`,
    ``,
    `Your step (${ctx.step.stepId}):`,
    `${ctx.step.title}`,
    ctx.step.rationale ? `Rationale: ${ctx.step.rationale}` : "",
    ``,
    `Produce a focused markdown finding with:`,
    `- Summary (2-3 sentences at most)`,
    `- Key facts (bullets, with inline sources/citations if you use web tools)`,
    `- Open questions`,
    ``,
    `Maximum 500 words. Be concise. Start with the summary. No preamble.`,
  ]
    .filter(Boolean)
    .join("\n");
}

export interface WriterContext {
  task: string;
  readerFindings: Array<{ stepId: string; title: string; content: string }>;
}

export function writerPrompt(ctx: WriterContext): string {
  const bundle = ctx.readerFindings
    .map(
      (f) =>
        `### Reader ${f.stepId}: ${f.title}\n\n${f.content || "_(empty)_"}`,
    )
    .join("\n\n---\n\n");
  return [
    `You are the WRITER in a Magentic-One-style swarm. One job: produce the deliverable.`,
    ``,
    `Original task:`,
    `"""${ctx.task}"""`,
    ``,
    `Reader findings (${ctx.readerFindings.length}):`,
    ``,
    bundle,
    ``,
    `Produce the deliverable the task asked for. It must:`,
    `- Directly answer the original task in the format it specifies`,
    `- Use only evidence from the reader findings above`,
    `- Preserve citations / source URLs from the readers`,
    `- Flag contradictions between readers explicitly`,
    `- Note what's still unknown if readers left gaps`,
    ``,
    `Structured markdown. Max 1200 words. No preamble — start with the deliverable.`,
  ].join("\n");
}

export interface VerifierContext {
  task: string;
  writerOutput: string;
  plan: TaskLedgerPlanStep[];
}

export function verifierPrompt(ctx: VerifierContext): string {
  const planStr = ctx.plan
    .map((s) => `- ${s.stepId} [${s.assignedTo}]: ${s.title}`)
    .join("\n");
  return [
    `You are the VERIFIER in a Magentic-One-style swarm. Output a Progress Ledger JSON.`,
    ``,
    `Original task:`,
    `"""${ctx.task}"""`,
    ``,
    `Plan that was executed:`,
    planStr,
    ``,
    `Writer's deliverable:`,
    `"""`,
    ctx.writerOutput.slice(0, 6000),
    `"""`,
    ``,
    `Grade the deliverable against the original task. Output a Progress Ledger JSON with these keys, each {answer, reason}:`,
    `- is_request_satisfied: {answer: boolean, reason: string}`,
    `- is_in_loop: {answer: boolean, reason: string}  (detect if the swarm appears to be looping)`,
    `- is_progress_being_made: {answer: boolean, reason: string}`,
    `- next_speaker: {answer: "planner"|"reader"|"writer"|"verifier", reason: string}`,
    `- instruction_or_question: {answer: string, reason: string}  (what next_speaker should do — empty if is_request_satisfied=true)`,
    ``,
    `Be a hard critic. If the deliverable misses any explicit requirement from the task, answer is_request_satisfied=false and set instruction_or_question to the precise gap.`,
    ``,
    `Output ONLY the JSON object. No prose, no fences. Start with '{'.`,
  ].join("\n");
}

export function roleDescription(role: AgentRole): string {
  switch (role) {
    case "planner":
      return "Produces Task Ledger + plan. One-shot per task.";
    case "reader":
      return "Researches one plan step. Parallel-safe. Max 500 words.";
    case "writer":
      return "Synthesizes reader findings into the final deliverable.";
    case "verifier":
      return "Grades the deliverable, outputs Progress Ledger JSON.";
  }
}
