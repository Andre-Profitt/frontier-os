// Research adapter — orchestrator-worker literature/web survey primitive.
//
// Commands:
//   run-survey     {query, maxWorkers?, maxBudgetUsdPerCall?, orchestratorModel?, workerModel?}
//   monitor-topic  {topicId, watchlistPath?, maxWorkers?}
//   brief          {sessionId?, limit?}
//
// Architecture: Anthropic multi-agent research pattern on top of local
// `claude -p` subprocess. See src/adapters/research/orchestrator.ts.

import { existsSync, readFileSync } from "node:fs";
import { resolve as resolvePath } from "node:path";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";

import type { AdapterImpl } from "../../registry.ts";
import type {
  AdapterInvocation,
  AdapterManifest,
  AdapterResult,
} from "../../schemas.ts";
import { runSurvey } from "./orchestrator.ts";
import { listSessions, readBrief } from "./artifacts.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolvePath(__dirname, "..", "..", "..");
const DEFAULT_WATCHLIST = resolvePath(
  REPO_ROOT,
  "examples",
  "research",
  "watchlist.json",
);

export async function createResearchAdapter(
  manifest: AdapterManifest,
): Promise<AdapterImpl> {
  return {
    manifest,
    async invoke(invocation: AdapterInvocation): Promise<AdapterResult> {
      const args = (invocation.arguments ?? {}) as Record<string, unknown>;
      switch (invocation.command) {
        case "run-survey":
          return cmdRunSurvey(invocation, args);
        case "monitor-topic":
          return cmdMonitorTopic(invocation, args);
        case "brief":
          return cmdBrief(invocation, args);
        default:
          return failed(
            invocation,
            `unknown research command: ${invocation.command}`,
          );
      }
    },
  };
}

async function cmdRunSurvey(
  invocation: AdapterInvocation,
  args: Record<string, unknown>,
): Promise<AdapterResult> {
  const query = String(args.query ?? "");
  if (!query) return failed(invocation, "run-survey requires 'query'");
  const sessionId = String(args.sessionId ?? newSessionId(query));
  const surveyInput: Parameters<typeof runSurvey>[0] = {
    query,
    sessionId,
  };
  if (typeof args.maxWorkers === "number")
    surveyInput.maxWorkers = args.maxWorkers;
  if (typeof args.maxBudgetUsdPerCall === "number") {
    surveyInput.maxBudgetUsdPerCall = args.maxBudgetUsdPerCall;
  }
  if (typeof args.orchestratorModel === "string") {
    surveyInput.orchestratorModel = args.orchestratorModel;
  }
  if (typeof args.workerModel === "string") {
    surveyInput.workerModel = args.workerModel;
  }

  try {
    const result = await runSurvey(surveyInput);
    return {
      invocationId: invocation.invocationId,
      adapterId: "research",
      command: "run-survey",
      finishedAt: new Date().toISOString(),
      status: "success",
      summary: `survey ${result.sessionId}: ${result.workers.length} workers, ${result.brief.length} chars, ${result.totalDurationMs}ms`,
      observedState: {
        sessionId: result.sessionId,
        query: result.query,
        decomposition: result.decomposition,
        workers: result.workers.map((w) => ({
          index: w.index,
          subQuestion: w.subQuestion,
          ok: w.ok,
          durationMs: w.durationMs,
          words: w.words,
          path: w.path,
        })),
        briefPath: result.briefPath,
        briefPreview: result.brief.slice(0, 1500),
        totalDurationMs: result.totalDurationMs,
      },
      artifacts: [
        {
          kind: "file" as const,
          ref: result.briefPath,
          note: "brief: synthesized research brief (markdown)",
        },
        ...result.workers.map((w) => ({
          kind: "file" as const,
          ref: w.path,
          note: `worker_finding ${w.index}: ${w.subQuestion}`.slice(0, 180),
        })),
      ],
      sideEffects: [
        {
          class: "billable_action",
          target: "claude -p subprocess calls",
          summary: `~${result.workers.length + 2} Claude invocations (decompose + ${result.workers.length} workers + synth)`,
        },
      ],
    };
  } catch (err) {
    return failed(
      invocation,
      `survey failed: ${err instanceof Error ? err.message : String(err)}`,
      { sessionId, query },
    );
  }
}

interface WatchlistTopic {
  topicId: string;
  title?: string;
  queries?: string[];
  cadence?: string;
  priority?: string;
}

async function cmdMonitorTopic(
  invocation: AdapterInvocation,
  args: Record<string, unknown>,
): Promise<AdapterResult> {
  const topicId = String(args.topicId ?? "");
  if (!topicId) return failed(invocation, "monitor-topic requires 'topicId'");
  const watchlistPath = String(args.watchlistPath ?? DEFAULT_WATCHLIST);
  if (!existsSync(watchlistPath)) {
    return failed(invocation, `watchlist not found: ${watchlistPath}`);
  }
  let watchlist: { topics?: WatchlistTopic[] };
  try {
    watchlist = JSON.parse(readFileSync(watchlistPath, "utf8"));
  } catch (err) {
    return failed(
      invocation,
      `watchlist parse error: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  const topic = (watchlist.topics ?? []).find((t) => t.topicId === topicId);
  if (!topic) {
    return failed(
      invocation,
      `topic "${topicId}" not found in ${watchlistPath}`,
    );
  }
  const queries = topic.queries ?? [];
  if (queries.length === 0) {
    return failed(invocation, `topic "${topicId}" has no queries`);
  }
  // Combine topic queries into a single research query
  const combinedQuery = `${topic.title ?? topicId} — research signal across these angles:\n${queries.map((q, i) => `${i + 1}. ${q}`).join("\n")}`;

  const sessionId = newSessionId(`monitor-${topicId}`);
  const surveyInput: Parameters<typeof runSurvey>[0] = {
    query: combinedQuery,
    sessionId,
  };
  if (typeof args.maxWorkers === "number")
    surveyInput.maxWorkers = args.maxWorkers;

  try {
    const result = await runSurvey(surveyInput);
    return {
      invocationId: invocation.invocationId,
      adapterId: "research",
      command: "monitor-topic",
      finishedAt: new Date().toISOString(),
      status: "success",
      summary: `topic ${topicId} → ${result.sessionId} (${result.workers.length} workers)`,
      observedState: {
        topicId,
        topicTitle: topic.title,
        sessionId: result.sessionId,
        briefPath: result.briefPath,
        briefPreview: result.brief.slice(0, 1500),
        totalDurationMs: result.totalDurationMs,
      },
      artifacts: [
        {
          kind: "file" as const,
          ref: result.briefPath,
          note: `brief: topic ${topicId}`,
        },
      ],
      sideEffects: [
        {
          class: "billable_action",
          target: "claude -p subprocess calls",
          summary: `monitor-topic ${topicId}`,
        },
      ],
    };
  } catch (err) {
    return failed(
      invocation,
      `monitor-topic failed: ${err instanceof Error ? err.message : String(err)}`,
      { topicId, sessionId },
    );
  }
}

function cmdBrief(
  invocation: AdapterInvocation,
  args: Record<string, unknown>,
): AdapterResult {
  const sessionId = typeof args.sessionId === "string" ? args.sessionId : null;
  if (sessionId) {
    const brief = readBrief(sessionId);
    if (brief === null) {
      return failed(invocation, `no brief found for session ${sessionId}`);
    }
    return {
      invocationId: invocation.invocationId,
      adapterId: "research",
      command: "brief",
      finishedAt: new Date().toISOString(),
      status: "success",
      summary: `brief for ${sessionId} (${brief.length} chars)`,
      observedState: { sessionId, brief },
    };
  }
  const limit = typeof args.limit === "number" ? args.limit : 20;
  const sessions = listSessions(limit);
  return {
    invocationId: invocation.invocationId,
    adapterId: "research",
    command: "brief",
    finishedAt: new Date().toISOString(),
    status: "success",
    summary: `${sessions.length} research session(s)`,
    observedState: { sessions },
  };
}

// --- helpers ---

function newSessionId(label: string): string {
  const t = Math.floor(Date.now() / 1000).toString(36);
  const r = Math.random().toString(36).slice(2, 8);
  const slug = label
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
  return slug ? `res_${t}_${slug}_${r}` : `res_${t}_${r}`;
}

function failed(
  invocation: AdapterInvocation,
  message: string,
  extra?: Record<string, unknown>,
): AdapterResult {
  return {
    invocationId: invocation.invocationId,
    adapterId: "research",
    command: invocation.command,
    finishedAt: new Date().toISOString(),
    status: "failed",
    summary: message,
    observedState: { error: message, ...(extra ?? {}) },
  };
}
