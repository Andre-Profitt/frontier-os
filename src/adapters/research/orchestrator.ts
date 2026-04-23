// Orchestrator-worker research loop.
//
// Pattern lifted from Anthropic's "How we built our multi-agent research system"
// (anthropic.com/engineering/multi-agent-research-system):
//   1. Lead agent decomposes the query into N sub-research questions.
//   2. N workers run in parallel, each with its own context window, each
//      producing a focused markdown finding with citations.
//   3. Lead synthesizes the N findings into a single brief.
//
// Every step shells out to `claude -p` (local Claude Code). Session artifacts
// land under ~/.frontier/research/<sessionId>/ for replay and audit.

import { readFileSync } from "node:fs";

import { callClaude, extractJsonArray } from "./claude-sub.ts";
import {
  ensureSession,
  sessionPaths,
  writeBrief,
  writeDecomposition,
  writeWorkerOutput,
  type SessionPaths,
} from "./artifacts.ts";

export interface SurveyInput {
  query: string;
  maxWorkers?: number;
  /** Per-call budget in USD, passed to --max-budget-usd. */
  maxBudgetUsdPerCall?: number;
  orchestratorModel?: string;
  workerModel?: string;
  sessionId: string;
}

export interface WorkerRecord {
  index: number;
  subQuestion: string;
  path: string;
  ok: boolean;
  durationMs: number;
  words: number;
}

export interface SurveyResult {
  sessionId: string;
  query: string;
  decomposition: string[];
  workers: WorkerRecord[];
  brief: string;
  briefPath: string;
  paths: SessionPaths;
  totalDurationMs: number;
}

const DEFAULT_MAX_WORKERS = 3;
const DEFAULT_BUDGET = 0.5; // $ per call

export async function runSurvey(input: SurveyInput): Promise<SurveyResult> {
  const startedAt = Date.now();
  const maxWorkers = Math.max(
    1,
    Math.min(6, input.maxWorkers ?? DEFAULT_MAX_WORKERS),
  );
  const budget = input.maxBudgetUsdPerCall ?? DEFAULT_BUDGET;
  const paths = ensureSession(input.sessionId);

  // --- 1. Decompose ---
  const decompositionPrompt = buildDecompositionPrompt(input.query, maxWorkers);
  const decomp = await callClaude({
    prompt: decompositionPrompt,
    maxBudgetUsd: budget,
    ...(input.orchestratorModel !== undefined
      ? { model: input.orchestratorModel }
      : {}),
  });
  if (!decomp.ok) {
    throw new Error(
      `decomposition failed: exit=${decomp.exitCode} stderr=${decomp.stderr.slice(0, 400)}`,
    );
  }
  const parsed = extractJsonArray(decomp.text);
  const subQuestions =
    parsed && parsed.length > 0 ? parsed.slice(0, maxWorkers) : [input.query]; // fallback: one worker on the original query
  writeDecomposition(paths, input.query, subQuestions);

  // --- 2. Workers (in parallel) ---
  const workerResults = await Promise.all(
    subQuestions.map((q, idx) =>
      runWorker(q, idx, paths, budget, input.workerModel),
    ),
  );

  // --- 3. Synthesize ---
  const synthesisPrompt = buildSynthesisPrompt(input.query, workerResults);
  const synth = await callClaude({
    prompt: synthesisPrompt,
    maxBudgetUsd: budget,
    ...(input.orchestratorModel !== undefined
      ? { model: input.orchestratorModel }
      : {}),
  });

  const brief = synth.ok
    ? synth.text.trim()
    : `# Synthesis failed\n\nStderr: ${synth.stderr.slice(0, 400)}\n\nRaw worker outputs are in \`workers/\`.`;

  const totalDurationMs = Date.now() - startedAt;
  const metadata = {
    sessionId: input.sessionId,
    query: input.query,
    generatedAt: new Date().toISOString(),
    maxWorkers,
    actualWorkers: subQuestions.length,
    totalDurationMs,
    decompositionMs: decomp.durationMs,
    synthesisMs: synth.durationMs,
    synthesisOk: synth.ok,
    budgetPerCallUsd: budget,
  };
  writeBrief(paths, input.query, brief, metadata);

  return {
    sessionId: input.sessionId,
    query: input.query,
    decomposition: subQuestions,
    workers: workerResults,
    brief,
    briefPath: paths.briefMarkdown,
    paths,
    totalDurationMs,
  };
}

async function runWorker(
  subQuestion: string,
  index: number,
  paths: SessionPaths,
  budget: number,
  model?: string,
): Promise<WorkerRecord> {
  const prompt = buildWorkerPrompt(subQuestion);
  const r = await callClaude({
    prompt,
    maxBudgetUsd: budget,
    ...(model !== undefined ? { model } : {}),
  });
  const markdown = r.ok
    ? r.text.trim()
    : `_Worker ${index} failed._\n\nStderr: ${r.stderr.slice(0, 400)}`;
  const writtenPath = writeWorkerOutput(paths, index, subQuestion, markdown, {
    ok: r.ok,
    exitCode: r.exitCode,
    timedOut: r.timedOut,
    durationMs: r.durationMs,
  });
  return {
    index,
    subQuestion,
    path: writtenPath,
    ok: r.ok,
    durationMs: r.durationMs,
    words: markdown.trim().split(/\s+/).length,
  };
}

// --- Prompt builders ---

function buildDecompositionPrompt(query: string, maxN: number): string {
  return [
    `You are the lead orchestrator in a multi-agent research loop.`,
    ``,
    `The user's research query:`,
    `"""${query}"""`,
    ``,
    `Decompose this query into UP TO ${maxN} focused sub-research questions. Each sub-question should:`,
    `- Be answerable on its own by a separate worker agent with web access`,
    `- Not overlap with the others`,
    `- Together cover the original query thoroughly`,
    `- Be phrased as a question or directive, not a keyword`,
    ``,
    `Output ONLY a JSON array of ${maxN} strings, nothing else. No prose, no markdown fences.`,
    `Example: ["What X?", "What Y?", "What Z?"]`,
  ].join("\n");
}

function buildWorkerPrompt(subQuestion: string): string {
  return [
    `You are a research worker answering ONE focused question.`,
    ``,
    `Question: ${subQuestion}`,
    ``,
    `Use web search if available to find current information. Produce a focused markdown finding with:`,
    `- A brief summary (2-3 sentences)`,
    `- Key points (bullets)`,
    `- Sources (URLs or paper citations)`,
    `- Caveats / unknowns`,
    ``,
    `Maximum 500 words. Be concise. No preamble. Start with the summary.`,
  ].join("\n");
}

function buildSynthesisPrompt(query: string, workers: WorkerRecord[]): string {
  // Inline every worker's content directly into the prompt so the synthesizer
  // doesn't need filesystem tool access (claude -p runs without Read by
  // default — asking it to open a path fails silently).
  const blocks = workers
    .map((w) => {
      const label = `### Worker ${w.index}${w.ok ? "" : " (FAILED)"}: ${w.subQuestion}`;
      let content = "_(no content produced)_";
      try {
        const raw = readFileSync(w.path, "utf8");
        // Strip the file's own header + trailing metadata block so the
        // synthesizer sees just the substantive finding text.
        content = raw
          .replace(/^# Worker \d+:.*?\n\n/, "")
          .replace(/\n\n---\n\n```json[\s\S]*?```\s*$/, "")
          .trim();
        if (!content) content = "_(empty file)_";
      } catch (err) {
        content = `_(failed to read ${w.path}: ${err instanceof Error ? err.message : String(err)})_`;
      }
      return `${label}\n\n${content}`;
    })
    .join("\n\n---\n\n");

  return [
    `You are the lead synthesizer combining worker findings into a unified research brief.`,
    ``,
    `## Original query`,
    query,
    ``,
    `## Worker findings (${workers.length} total, ${workers.filter((w) => w.ok).length} successful)`,
    ``,
    blocks,
    ``,
    `## Your task`,
    `Synthesize the findings above into a single brief. The brief MUST:`,
    `- Lead with a 3-5 bullet executive summary answering the original query`,
    `- Have sections that reflect the structure of the findings (not the workers)`,
    `- Preserve all source citations from the workers (aggregate, dedupe)`,
    `- Flag contradictions between workers explicitly`,
    `- Note what's still unknown`,
    `- If every worker failed, say so plainly and list what the query was asking about`,
    ``,
    `Maximum 1000 words. Structured markdown. No filler. No preamble — start with the executive summary.`,
  ].join("\n");
}
