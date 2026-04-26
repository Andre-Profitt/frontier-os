import { existsSync, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, resolve } from "node:path";

import { getLedger } from "../ledger/index.ts";
import { newSessionId } from "../ledger/events.ts";
import type { LedgerEvent } from "../ledger/events.ts";

export interface OvernightBriefOptions {
  sinceIso?: string;
  hours?: number;
}

export interface OvernightBriefResult {
  status: "ok" | "attention" | "quiet";
  generatedAt: string;
  sinceIso: string;
  untilIso: string;
  counts: Record<string, number>;
  failureKinds: Record<string, number>;
  latestRuns: OvernightRunBriefItem[];
  ghostShifts: OvernightGhostShiftBriefItem[];
  manualAttention: OvernightManualAttentionItem[];
  runTrend: OvernightRunTrend;
  lanes: OvernightLaneBriefItem[];
  summary: {
    runCount: number;
    shiftCount: number;
    preflightCount: number;
    completedGraphs: number;
    failedGraphs: number;
    blockedGraphs: number;
    rejectedGraphs: number;
    automatedDebtActions: number;
    commandDebtAttentionCount: number;
    attentionCount: number;
    quarantineCount: number;
  };
}

export interface OvernightRunBriefItem {
  ts: string;
  runId: string | null;
  status: string | null;
  dryRun: boolean | null;
  graphCount: number | null;
  queuedCount: number | null;
  completed: number | null;
  failed: number | null;
  blocked: number | null;
  rejected: number | null;
  preflightStatus: string | null;
  staleCommandDebtBefore: number | null;
  staleCommandDebtAfter: number | null;
  automatedDebtActions: number | null;
  manualDebtAttention: number | null;
}

export interface OvernightGhostShiftBriefItem {
  ts: string;
  processed: number | null;
  completed: number | null;
  failed: number | null;
  blocked: number | null;
  rejected: number | null;
  skippedTimeBudget: number | null;
}

export interface OvernightManualAttentionItem {
  ts: string;
  kind: string;
  graphId: string | null;
  file: string | null;
  lane: string | null;
  projectId: string | null;
  verb: string | null;
  reason: string | null;
  failureKind: string | null;
  quarantineRecommended: boolean;
  quarantineReason: string | null;
  payload: Record<string, unknown>;
}

export interface OvernightRunTrend {
  runsByStatus: Record<string, number>;
  liveRuns: number;
  dryRuns: number;
  cleanShifts: number;
  attentionShifts: number;
}

export interface OvernightLaneBriefItem {
  lane: string;
  status: "ok" | "attention" | "quiet";
  planned: number;
  queued: number;
  completed: number;
  failed: number;
  blocked: number;
  rejected: number;
  automatedDebtActions: number;
  manualDebtAttention: number;
  projectCount: number;
  latestTs: string | null;
  latestRunId: string | null;
  topVerbs: Array<{
    verb: string;
    count: number;
  }>;
}

const BRIEF_KINDS = [
  "overnight.plan",
  "overnight.enqueue",
  "overnight.run",
  "ghost.shift_end",
  "ghost.graph_completed",
  "ghost.graph_failed",
  "ghost.graph_blocked",
  "ghost.graph_rejected",
] as const;

const GHOST_OUTCOME_KINDS = new Set([
  "ghost.graph_completed",
  "ghost.graph_failed",
  "ghost.graph_blocked",
  "ghost.graph_rejected",
]);

const GHOST_SHIFT_STATE_DIRS = [
  "queue",
  "running",
  "completed",
  "failed",
  "blocked",
  "rejected",
] as const;

const GENERIC_GRAPH_LABELS = new Set([
  "nightly",
  "ghost-shift-safe",
  "overnight",
  "watchlist",
  "codex-build",
  "project-registry",
  "ops-readiness",
  "portfolio-inventory",
]);

const GENERIC_TOOL_LANES = new Set([
  "mkdir",
  "echo",
  "sleep",
  "cat",
  "cp",
  "mv",
  "rm",
  "bash",
  "sh",
  "zsh",
  "npm",
  "node",
  "python",
  "python3",
  "codex",
]);

const graphMetaCache = new Map<string, {
  lane: string | null;
  projectId: string | null;
  verb: string | null;
} | null>();

export function overnightBrief(
  options: OvernightBriefOptions = {},
): OvernightBriefResult {
  const untilIso = new Date().toISOString();
  const sinceIso =
    options.sinceIso ??
    new Date(Date.now() - (options.hours ?? 24) * 3600 * 1000).toISOString();
  const ledger = getLedger();
  const events = BRIEF_KINDS.flatMap((kind) =>
    ledger.findEventsByKindInRange(kind, sinceIso, untilIso),
  ).sort((a, b) => a.ts.localeCompare(b.ts));
  const counts: Record<string, number> = {};
  for (const event of events) {
    counts[event.kind] = (counts[event.kind] ?? 0) + 1;
  }

  const runLikeEvents = dedupeRunEvents(events);
  const runSummaries = runLikeEvents.map(runSummary);
  const latestRuns = runSummaries.slice(-10).reverse();
  const shiftEvents = events.filter((event) => event.kind === "ghost.shift_end");
  const ghostShifts = shiftEvents.slice(-10).reverse().map(shiftSummary);
  const ghostAttention = events
    .filter((event) => GHOST_OUTCOME_KINDS.has(event.kind) && event.kind !== "ghost.graph_completed")
    .slice(-25)
    .reverse()
    .map(attentionSummary);
  const debtAttention = runLikeEvents
    .flatMap(debtAttentionSummary)
    .sort((a, b) => a.ts.localeCompare(b.ts))
    .slice(-25)
    .reverse();
  const manualAttention = [...ghostAttention, ...debtAttention]
    .sort((a, b) => b.ts.localeCompare(a.ts))
    .slice(0, 25);
  const failureKinds = countFailureKinds(ghostAttention);
  const quarantineCount = ghostAttention.filter(
    (item) => item.quarantineRecommended,
  ).length;

  const completedGraphs = counts["ghost.graph_completed"] ?? 0;
  const failedGraphs = counts["ghost.graph_failed"] ?? 0;
  const blockedGraphs = counts["ghost.graph_blocked"] ?? 0;
  const rejectedGraphs = counts["ghost.graph_rejected"] ?? 0;
  const commandDebtAttentionCount = runSummaries.reduce(
    (sum, run) => sum + (run.manualDebtAttention ?? 0),
    0,
  );
  const automatedDebtActions = runSummaries.reduce(
    (sum, run) => sum + (run.automatedDebtActions ?? 0),
    0,
  );
  const attentionCount =
    failedGraphs + blockedGraphs + rejectedGraphs + commandDebtAttentionCount;
  const lanes = laneSummaries(runLikeEvents, events);

  const result: OvernightBriefResult = {
    status:
      attentionCount > 0
        ? "attention"
        : runLikeEvents.length > 0 || shiftEvents.length > 0 || completedGraphs > 0
          ? "ok"
          : "quiet",
    generatedAt: untilIso,
    sinceIso,
    untilIso,
    counts,
    failureKinds,
    latestRuns,
    ghostShifts,
    manualAttention,
    runTrend: runTrendSummary(runLikeEvents, shiftEvents),
    lanes,
    summary: {
      runCount: runLikeEvents.length,
      shiftCount: shiftEvents.length,
      preflightCount: runLikeEvents.length,
      completedGraphs,
      failedGraphs,
      blockedGraphs,
      rejectedGraphs,
      automatedDebtActions,
      commandDebtAttentionCount,
      attentionCount,
      quarantineCount,
    },
  };
  appendBriefEvent(result);
  return result;
}

function runSummary(event: LedgerEvent): OvernightRunBriefItem {
  const payload = event.payload;
  const queue = queueRecord(event);
  const shift = record(payload.shift);
  const preflight = record(queue.preflight);
  return {
    ts: event.ts,
    runId: stringOrNull(payload.runId),
    status: stringOrNull(payload.status),
    dryRun: booleanOrNull(payload.dryRun),
    graphCount: numberOrNull(queue.graphCount),
    queuedCount: numberOrNull(queue.queuedCount),
    completed: numberOrNull(shift.completed),
    failed: numberOrNull(shift.failed),
    blocked: numberOrNull(shift.blocked),
    rejected: numberOrNull(shift.rejected),
    preflightStatus: stringOrNull(preflight.status),
    staleCommandDebtBefore: numberOrNull(preflight.staleBefore),
    staleCommandDebtAfter: numberOrNull(preflight.staleAfter),
    automatedDebtActions: numberOrNull(preflight.automatedCount),
    manualDebtAttention: numberOrNull(preflight.manualAttentionCount),
  };
}

function shiftSummary(event: LedgerEvent): OvernightGhostShiftBriefItem {
  const payload = event.payload;
  return {
    ts: event.ts,
    processed: numberOrNull(payload.processed),
    completed: numberOrNull(payload.completed),
    failed: numberOrNull(payload.failed),
    blocked: numberOrNull(payload.blocked),
    rejected: numberOrNull(payload.rejected),
    skippedTimeBudget: numberOrNull(payload.skippedTimeBudget),
  };
}

function attentionSummary(event: LedgerEvent): OvernightManualAttentionItem {
  const payload = event.payload;
  const meta = ghostLaneMeta(event);
  return {
    ts: event.ts,
    kind: event.kind,
    graphId: stringOrNull(payload.graphId),
    file: stringOrNull(payload.file),
    lane: meta.lane,
    projectId: meta.projectId,
    verb: meta.verb,
    reason: reasonFromPayload(payload),
    failureKind: stringOrNull(payload.failureKind),
    quarantineRecommended: payload.quarantineRecommended === true,
    quarantineReason: stringOrNull(payload.quarantineReason),
    payload,
  };
}

function debtAttentionSummary(event: LedgerEvent): OvernightManualAttentionItem[] {
  const payload = event.payload;
  const runId = stringOrNull(payload.runId);
  const preflight = record(queueRecord(event).preflight);
  const actions = Array.isArray(preflight.actions) ? preflight.actions : [];
  return actions
    .map(record)
    .filter((action) => stringOrNull(action.outcome) === "manual_attention")
    .map((action) => ({
      ts: event.ts,
      kind: "overnight.command_debt",
      graphId: null,
      file: null,
      lane: stringOrNull(action.lane),
      projectId: null,
      verb: stringOrNull(action.verb),
      reason:
        stringOrNull(action.reason) ??
        stringOrNull(action.debtSummary) ??
        stringOrNull(action.action),
      failureKind: null,
      quarantineRecommended: false,
      quarantineReason: null,
      payload: {
        runId,
        ...action,
      },
    }));
}

function runTrendSummary(
  runLikeEvents: LedgerEvent[],
  shiftEvents: LedgerEvent[],
): OvernightRunTrend {
  const runsByStatus: Record<string, number> = {};
  let liveRuns = 0;
  let dryRuns = 0;
  for (const event of runLikeEvents) {
    const payload = record(event.payload);
    const status = stringOrNull(payload.status) ?? "unknown";
    runsByStatus[status] = (runsByStatus[status] ?? 0) + 1;
    if (payload.dryRun === true) dryRuns += 1;
    else liveRuns += 1;
  }
  let cleanShifts = 0;
  let attentionShifts = 0;
  for (const event of shiftEvents) {
    const payload = record(event.payload);
    const failed = numberOrNull(payload.failed) ?? 0;
    const blocked = numberOrNull(payload.blocked) ?? 0;
    const rejected = numberOrNull(payload.rejected) ?? 0;
    if (failed > 0 || blocked > 0 || rejected > 0) attentionShifts += 1;
    else cleanShifts += 1;
  }
  return {
    runsByStatus,
    liveRuns,
    dryRuns,
    cleanShifts,
    attentionShifts,
  };
}

function laneSummaries(
  runLikeEvents: LedgerEvent[],
  events: LedgerEvent[],
): OvernightLaneBriefItem[] {
  const lanes = new Map<
    string,
    {
      lane: string;
      planned: number;
      queued: number;
      completed: number;
      failed: number;
      blocked: number;
      rejected: number;
      automatedDebtActions: number;
      manualDebtAttention: number;
      projects: Set<string>;
      verbs: Map<string, number>;
      latestTs: string | null;
      latestRunId: string | null;
    }
  >();

  for (const event of runLikeEvents) {
    const payload = record(event.payload);
    const runId = stringOrNull(payload.runId);
    for (const lane of queueLaneSummaries(event)) {
      const entry = laneEntry(lanes, lane.lane);
      entry.planned += lane.graphCount;
      entry.queued += lane.queuedCount;
      for (const projectId of lane.projects) entry.projects.add(projectId);
      for (const verb of lane.topVerbs) {
        entry.verbs.set(verb.verb, (entry.verbs.get(verb.verb) ?? 0) + verb.count);
      }
      if (!entry.latestTs || event.ts > entry.latestTs) {
        entry.latestTs = event.ts;
        entry.latestRunId = runId;
      }
    }
    const preflight = record(queueRecord(event).preflight);
    const actions = Array.isArray(preflight.actions) ? preflight.actions : [];
    for (const action of actions.map(record)) {
      const lane = stringOrNull(action.lane);
      if (!lane) continue;
      const entry = laneEntry(lanes, lane);
      if (action.automated === true) entry.automatedDebtActions += 1;
      if (stringOrNull(action.outcome) === "manual_attention") {
        entry.manualDebtAttention += 1;
      }
      const verb = stringOrNull(action.verb);
      if (verb) entry.verbs.set(verb, (entry.verbs.get(verb) ?? 0) + 1);
      if (!entry.latestTs || event.ts > entry.latestTs) {
        entry.latestTs = event.ts;
        entry.latestRunId = runId;
      }
    }
  }

  for (const event of events) {
    const outcome = ghostLaneOutcome(event);
    if (!outcome) continue;
    const entry = laneEntry(lanes, outcome.lane);
    entry[outcome.outcome] += 1;
    if (outcome.projectId) entry.projects.add(outcome.projectId);
    if (outcome.verb) {
      entry.verbs.set(outcome.verb, (entry.verbs.get(outcome.verb) ?? 0) + 1);
    }
    if (!entry.latestTs || event.ts > entry.latestTs) {
      entry.latestTs = event.ts;
      entry.latestRunId = null;
    }
  }

  return [...lanes.values()]
    .map((entry) => ({
      lane: entry.lane,
      status: laneStatus(entry),
      planned: entry.planned,
      queued: entry.queued,
      completed: entry.completed,
      failed: entry.failed,
      blocked: entry.blocked,
      rejected: entry.rejected,
      automatedDebtActions: entry.automatedDebtActions,
      manualDebtAttention: entry.manualDebtAttention,
      projectCount: entry.projects.size,
      latestTs: entry.latestTs,
      latestRunId: entry.latestRunId,
      topVerbs: [...entry.verbs.entries()]
        .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
        .slice(0, 5)
        .map(([verb, count]) => ({ verb, count })),
    }))
    .sort((a, b) => {
      const attentionA = attentionWeight(a);
      const attentionB = attentionWeight(b);
      if (attentionB !== attentionA) return attentionB - attentionA;
      if (b.planned !== a.planned) return b.planned - a.planned;
      return a.lane.localeCompare(b.lane);
    });
}

function attentionWeight(item: Pick<
  OvernightLaneBriefItem,
  "failed" | "blocked" | "rejected" | "manualDebtAttention"
>): number {
  return item.failed + item.blocked + item.rejected + item.manualDebtAttention;
}

function laneEntry(
  lanes: Map<
    string,
    {
      lane: string;
      planned: number;
      queued: number;
      completed: number;
      failed: number;
      blocked: number;
      rejected: number;
      automatedDebtActions: number;
      manualDebtAttention: number;
      projects: Set<string>;
      verbs: Map<string, number>;
      latestTs: string | null;
      latestRunId: string | null;
    }
  >,
  lane: string,
) {
  const existing = lanes.get(lane);
  if (existing) return existing;
  const created = {
    lane,
    planned: 0,
    queued: 0,
    completed: 0,
    failed: 0,
    blocked: 0,
    rejected: 0,
    automatedDebtActions: 0,
    manualDebtAttention: 0,
    projects: new Set<string>(),
    verbs: new Map<string, number>(),
    latestTs: null,
    latestRunId: null,
  };
  lanes.set(lane, created);
  return created;
}

function queueLaneSummaries(event: LedgerEvent): Array<{
  lane: string;
  graphCount: number;
  queuedCount: number;
  projects: string[];
  topVerbs: Array<{ verb: string; count: number }>;
}> {
  const laneSummary = record(queueRecord(event)).laneSummary;
  if (!Array.isArray(laneSummary)) {
    return backfillQueueLaneSummaries(event);
  }
  return laneSummary
    .map(record)
    .map((item) => ({
      lane: stringOrNull(item.lane) ?? "unknown",
      graphCount: numberOrNull(item.graphCount) ?? 0,
      queuedCount: numberOrNull(item.queuedCount) ?? 0,
      projects: Array.isArray(item.projects)
        ? item.projects.map(stringOrNull).filter((value): value is string => value !== null)
        : [],
      topVerbs: Array.isArray(item.topVerbs)
        ? item.topVerbs
            .map(record)
            .map((verb) => ({
              verb: stringOrNull(verb.verb),
              count: numberOrNull(verb.count),
            }))
            .filter(
              (
                verb,
              ): verb is {
                verb: string;
                count: number;
              } => verb.verb !== null && verb.count !== null,
            )
        : [],
    }));
}

function ghostLaneOutcome(event: LedgerEvent):
  | {
      lane: string;
      projectId: string | null;
      verb: string | null;
      outcome: "completed" | "failed" | "blocked" | "rejected";
    }
  | null {
  if (!GHOST_OUTCOME_KINDS.has(event.kind)) return null;
  const meta = ghostLaneMeta(event);
  const lane = meta.lane;
  if (!lane) return null;
  return {
    lane,
    projectId: meta.projectId,
    verb: meta.verb,
    outcome:
      event.kind === "ghost.graph_completed"
        ? "completed"
        : event.kind === "ghost.graph_blocked"
          ? "blocked"
          : event.kind === "ghost.graph_rejected"
            ? "rejected"
            : "failed",
  };
}

function backfillQueueLaneSummaries(event: LedgerEvent): Array<{
  lane: string;
  graphCount: number;
  queuedCount: number;
  projects: string[];
  topVerbs: Array<{ verb: string; count: number }>;
}> {
  const queue = queueRecord(event);
  const graphDir = stringOrNull(queue.graphDir);
  if (graphDir) {
    const fromGraphDir = summarizeLaneGraphs(listJsonFiles(graphDir), {
      queuedCountHint: numberOrNull(queue.queuedCount) ?? 0,
    });
    if (fromGraphDir.length > 0) return fromGraphDir;
  }
  const queueDir = stringOrNull(queue.queueDir);
  if (!queueDir) return [];
  const files = listQueueStateJsonFiles(queueDir);
  if (files.length === 0) return [];
  return summarizeLaneGraphs(files, {
    queuedCountHint: numberOrNull(queue.queuedCount) ?? 0,
  });
}

function listQueueStateJsonFiles(queueDir: string): string[] {
  const files: string[] = [];
  for (const state of GHOST_SHIFT_STATE_DIRS) {
    files.push(...listJsonFiles(resolve(queueDir, state)));
  }
  return files;
}

function listJsonFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];
  try {
    return readdirSync(dir)
      .filter((name) => name.endsWith(".json") && !name.startsWith("."))
      .map((name) => resolve(dir, name));
  } catch {
    return [];
  }
}

function summarizeLaneGraphs(
  files: string[],
  options: { queuedCountHint: number },
): Array<{
  lane: string;
  graphCount: number;
  queuedCount: number;
  projects: string[];
  topVerbs: Array<{ verb: string; count: number }>;
}> {
  const lanes = new Map<
    string,
    {
      lane: string;
      graphCount: number;
      projects: Set<string>;
      verbs: Map<string, number>;
    }
  >();
  for (const filePath of files) {
    const meta = graphMetaFromFile(filePath);
    const lane = meta?.lane ?? inferGraphMetaFromName(basename(filePath)).lane;
    if (!lane) continue;
    const entry = lanes.get(lane) ?? {
      lane,
      graphCount: 0,
      projects: new Set<string>(),
      verbs: new Map<string, number>(),
    };
    entry.graphCount += 1;
    if (meta?.projectId) entry.projects.add(meta.projectId);
    if (meta?.verb) entry.verbs.set(meta.verb, (entry.verbs.get(meta.verb) ?? 0) + 1);
    lanes.set(lane, entry);
  }
  return [...lanes.values()]
    .map((entry) => ({
      lane: entry.lane,
      graphCount: entry.graphCount,
      queuedCount: options.queuedCountHint > 0 ? entry.graphCount : 0,
      projects: [...entry.projects].sort((a, b) => a.localeCompare(b)),
      topVerbs: [...entry.verbs.entries()]
        .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
        .slice(0, 5)
        .map(([verb, count]) => ({ verb, count })),
    }))
    .sort((a, b) => b.graphCount - a.graphCount || a.lane.localeCompare(b.lane));
}

function ghostLaneMeta(event: LedgerEvent): {
  lane: string | null;
  projectId: string | null;
  verb: string | null;
} {
  const payload = record(event.payload);
  const explicit = {
    lane: stringOrNull(payload.lane),
    projectId: stringOrNull(payload.projectId),
    verb: stringOrNull(payload.verb),
  };
  if (explicit.lane && explicit.projectId && explicit.verb) return explicit;
  const inferred = inferGhostMeta(payload);
  return {
    lane: explicit.lane ?? inferred.lane,
    projectId: explicit.projectId ?? inferred.projectId,
    verb: explicit.verb ?? inferred.verb,
  };
}

function inferGhostMeta(payload: Record<string, unknown>): {
  lane: string | null;
  projectId: string | null;
  verb: string | null;
} {
  const file = stringOrNull(payload.file) ?? stringOrNull(payload.destination);
  const graphId = stringOrNull(payload.graphId);
  if (file) {
    const fromQueueFile = graphMetaFromGhostShiftFile(file);
    if (fromQueueFile) return fromQueueFile;
  }
  const summaryPath = stringOrNull(payload.summaryPath);
  if (summaryPath) {
    const fallback = inferGraphMetaFromName(graphId ?? basename(summaryPath));
    if (fallback.lane || fallback.projectId || fallback.verb) return fallback;
  }
  if (graphId) {
    const fromGraphId = inferGraphMetaFromName(graphId);
    if (fromGraphId.lane || fromGraphId.projectId || fromGraphId.verb) {
      return fromGraphId;
    }
  }
  if (file) {
    const fromFile = inferGraphMetaFromName(file);
    if (fromFile.lane || fromFile.projectId || fromFile.verb) {
      return fromFile;
    }
  }
  return inferGraphMetaFromName("unknown");
}

function graphMetaFromGhostShiftFile(file: string): {
  lane: string | null;
  projectId: string | null;
  verb: string | null;
} | null {
  const root = resolve(homedir(), ".frontier", "ghost-shift");
  for (const state of GHOST_SHIFT_STATE_DIRS) {
    const path = resolve(root, state, file);
    const meta = graphMetaFromFile(path);
    if (meta) return meta;
  }
  return null;
}

function graphMetaFromFile(path: string): {
  lane: string | null;
  projectId: string | null;
  verb: string | null;
} | null {
  const cached = graphMetaCache.get(path);
  if (cached !== undefined) return cached;
  if (!existsSync(path)) {
    graphMetaCache.set(path, null);
    return null;
  }
  try {
    const raw = JSON.parse(readFileSync(path, "utf8"));
    const meta = inferGraphMetaFromRecord(record(raw), basename(path));
    graphMetaCache.set(path, meta);
    return meta;
  } catch {
    graphMetaCache.set(path, null);
    return null;
  }
}

function inferGraphMetaFromRecord(
  graph: Record<string, unknown>,
  fallbackName: string,
): {
  lane: string | null;
  projectId: string | null;
  verb: string | null;
} {
  const context = record(graph.context);
  const action = record(context.action);
  const labels = Array.isArray(graph.labels)
    ? graph.labels.map(stringOrNull).filter((value): value is string => value !== null)
    : [];
  const hasDemoLabel = labels.includes("demo");
  const nodeMeta = inferGraphMetaFromNodes(graph);
  const hintMeta = inferGraphMetaFromLabels(labels, fallbackName);
  const lane =
    stringOrNull(action.lane) ??
    labelValue(labels, "lane") ??
    nodeMeta.lane ??
    hintMeta.lane;
  const projectId =
    stringOrNull(action.projectId) ??
    labelValue(labels, "project") ??
    nodeMeta.projectId ??
    hintMeta.projectId;
  const verb =
    stringOrNull(action.verb) ??
    labelValue(labels, "verb") ??
    nodeMeta.verb ??
    hintMeta.verb;
  const normalizedLane = normalizeInferredLane(lane, projectId);
  return {
    lane: normalizeDemoLane(normalizedLane, hasDemoLabel),
    projectId,
    verb: normalizeInferredVerb(
      verb,
      normalizeDemoLane(normalizedLane, hasDemoLabel),
      projectId,
      labels,
    ),
  };
}

function inferGraphMetaFromNodes(graph: Record<string, unknown>): {
  lane: string | null;
  projectId: string | null;
  verb: string | null;
} {
  let lane: string | null = null;
  let projectId: string | null = null;
  let verb: string | null = null;
  const nodes = Array.isArray(graph.nodes) ? graph.nodes.map(record) : [];
  for (const node of nodes) {
    const allowedTools = Array.isArray(node.allowedTools)
      ? node.allowedTools
          .map(stringOrNull)
          .filter((value): value is string => value !== null)
      : [];
    const firstTool = allowedTools[0] ?? null;
    if (!verb && firstTool) {
      verb = firstTool;
    }
    if (!lane && verb) {
      lane = inferLaneFromVerb(verb);
    }
    const inputs = Array.isArray(node.inputs) ? node.inputs.map(record) : [];
    for (const input of inputs) {
      const value = record(input.value);
      const adapterId = stringOrNull(value.adapterId);
      const command = stringOrNull(value.command);
      if (!lane && adapterId) lane = adapterId;
      if (!verb && adapterId && command) {
        verb = `${adapterId}.${command}`;
      }
      const args = record(value.arguments);
      if (!projectId) {
        projectId =
          stringOrNull(args.projectId) ??
          stringOrNull(args.project) ??
          stringOrNull(args.workspace) ??
          null;
      }
      const cli = record(value.cli);
      const cwd = stringOrNull(cli.cwd);
      if (!projectId && cwd) {
        projectId = inferProjectIdFromPath(cwd);
      }
    }
  }
  return { lane, projectId, verb };
}

function inferGraphMetaFromLabels(
  labels: string[],
  fallbackName: string,
): {
  lane: string | null;
  projectId: string | null;
  verb: string | null;
} {
  let lane: string | null = null;
  let projectId: string | null = null;
  for (const label of labels) {
    const lowered = label.toLowerCase();
    if (!lane && isLaneHint(lowered)) {
      lane = lowered;
    }
    if (!projectId && isProjectLabel(lowered)) {
      projectId = lowered;
    }
  }
  const fallback = inferGraphMetaFromName(fallbackName);
  return {
    lane: lane ?? fallback.lane,
    projectId: projectId ?? fallback.projectId,
    verb: fallback.verb,
  };
}

function inferGraphMetaFromName(name: string): {
  lane: string | null;
  projectId: string | null;
  verb: string | null;
} {
  const lowered = name.toLowerCase();
  const legacyProjectId =
    lowered.includes("crm-analytics")
      ? "crm-analytics"
      : lowered.includes("frontier-os")
        ? "frontier-os"
        : lowered.includes("companion-platform")
          ? "companion-platform"
          : lowered.includes("self_audit") || lowered.includes("self-audit")
            ? "self-audit"
            : null;
  if (lowered.includes("git-review")) {
    return {
      lane: "frontierd",
      projectId: legacyProjectId,
      verb: lowered.includes("verify") ? "project.verify" : "project.status",
    };
  }
  if (lowered.includes("self_audit") || lowered.includes("self-audit")) {
    return {
      lane: "demo",
      projectId: legacyProjectId ?? "self-audit",
      verb: "demo.self-audit",
    };
  }
  if (lowered.includes("parallel_sleep_demo") || (lowered.includes("parallel") && lowered.includes("demo"))) {
    return {
      lane: "demo",
      projectId: legacyProjectId,
      verb: "demo.parallel",
    };
  }
  if (lowered.includes("frontier_gap_overnight_build") || lowered.includes("frontier-gap-overnight-build")) {
    return {
      lane: "project",
      projectId: legacyProjectId ?? "frontier-os",
      verb: "project.automation",
    };
  }
  const lane =
    lowered.includes("frontierd")
      ? "frontierd"
      : lowered.includes("salesforce") || lowered.includes("sf-") || lowered.includes("sf_")
      ? "salesforce"
      : lowered.includes("browser") || lowered.includes("chrome") || lowered.includes("atlas")
        ? "browser"
        : lowered.includes("github")
          ? "github"
          : lowered.includes("databricks")
            ? "databricks"
            : lowered.includes("kaggle")
              ? "kaggle"
              : lowered.includes("runpod")
                ? "runpod"
                : lowered.includes("azure")
                  ? "azure"
                  : lowered.includes("sigma")
                    ? "sigma"
          : lowered.includes("mlx")
            ? "mlx"
          : lowered.includes("helper")
            ? "helper"
            : lowered.includes("overnight")
              ? "overnight"
              : lowered.includes("research")
                ? "research"
                : lowered.includes("frontier") || lowered.includes("project")
                  ? "project"
                  : null;
  const projectId = legacyProjectId;
  const verb =
    lane === "frontierd" && lowered.includes("git-review")
      ? lowered.includes("verify")
        ? "project.verify"
        : "project.status"
      : lane === "databricks" && lowered.includes("run-job")
        ? "databricks.run-job"
      : lane === "github" && lowered.includes("comment")
        ? "github.create-pr-comment"
      : lane === "kaggle" && lowered.includes("submit")
        ? "kaggle.submit-competition"
      : lane === "runpod" && lowered.includes("stop")
        ? "runpod.stop-pod"
      : lane === "azure" && lowered.includes("stop")
        ? "azure.stop-resource"
      : lane === "sigma" && lowered.includes("refresh")
        ? "sigma.refresh-workbook"
      : lane === "salesforce" && lowered.includes("deploy-report")
        ? "salesforce.deploy-report"
      : lane === "project" && lowered.includes("overnight-build")
        ? "project.automation"
      :
    lane === "salesforce" && lowered.includes("portfolio")
      ? "salesforce.portfolio-inventory"
      : lane === "browser" && lowered.includes("tab")
        ? "browser.current-tab"
        : lane === "research" && lowered.includes("watchlist")
          ? "research.monitor-topic"
          : lane === "project" && projectId
            ? "project.status"
            : null;
  return { lane, projectId, verb };
}

function inferLaneFromVerb(verb: string): string | null {
  const [prefix] = verb.split(".", 1);
  return prefix && prefix.length > 0 ? prefix : null;
}

function normalizeInferredLane(
  lane: string | null,
  projectId: string | null,
): string | null {
  if (lane && GENERIC_TOOL_LANES.has(lane) && projectId) {
    return "project";
  }
  return lane ?? (projectId ? "project" : null);
}

function normalizeInferredVerb(
  verb: string | null,
  lane: string | null,
  projectId: string | null,
  labels: string[],
): string | null {
  if (lane === "demo") {
    if (labels.includes("self-audit")) return "demo.self-audit";
    if (labels.includes("parallel")) return "demo.parallel";
    return "demo.automation";
  }
  if (!verb) {
    return lane === "project" && projectId ? "project.automation" : null;
  }
  const normalizedLane = inferLaneFromVerb(verb);
  if (lane === "project" && normalizedLane && GENERIC_TOOL_LANES.has(normalizedLane)) {
    return "project.automation";
  }
  return verb;
}

function normalizeDemoLane(
  lane: string | null,
  hasDemoLabel: boolean,
): string | null {
  if (!hasDemoLabel) return lane;
  if (!lane || GENERIC_TOOL_LANES.has(lane) || lane === "frontier") {
    return "demo";
  }
  return lane;
}

function inferProjectIdFromPath(path: string): string | null {
  const root = resolve(homedir());
  if (!path.startsWith(root)) return null;
  const projectId = basename(path);
  return projectId.length > 0 ? projectId : null;
}

function labelValue(labels: string[], prefix: string): string | null {
  const match = labels.find((label) => label.startsWith(`${prefix}:`));
  if (!match) return null;
  const value = match.slice(prefix.length + 1);
  return value.length > 0 ? value : null;
}

function isLaneHint(label: string): boolean {
  return [
    "frontierd",
    "project",
    "salesforce",
    "browser",
    "helper",
    "mlx",
    "overnight",
    "research",
    "memory",
    "ops",
    "demo",
    "github",
    "databricks",
    "kaggle",
    "runpod",
    "azure",
    "sigma",
  ].includes(label);
}

function isProjectLabel(label: string): boolean {
  if (GENERIC_GRAPH_LABELS.has(label)) return false;
  if (isLaneHint(label)) return false;
  if (/^class-\d+$/.test(label)) return false;
  return label.includes("-") || label.endsWith("os") || label.endsWith("analytics");
}

function laneStatus(item: {
  planned: number;
  queued: number;
  completed: number;
  failed: number;
  blocked: number;
  rejected: number;
  manualDebtAttention: number;
}): "ok" | "attention" | "quiet" {
  if (
    item.failed > 0 ||
    item.blocked > 0 ||
    item.rejected > 0 ||
    item.manualDebtAttention > 0
  ) {
    return "attention";
  }
  if (item.planned > 0 || item.queued > 0 || item.completed > 0) return "ok";
  return "quiet";
}

function reasonFromPayload(payload: Record<string, unknown>): string | null {
  if (typeof payload.failureSummary === "string") return payload.failureSummary;
  if (typeof payload.reason === "string") return payload.reason;
  if (typeof payload.error === "string") return payload.error;
  if (typeof payload.quarantineReason === "string") return payload.quarantineReason;
  if (Array.isArray(payload.rejections) && payload.rejections.length > 0) {
    const first = payload.rejections[0];
    if (first && typeof first === "object") {
      const message = (first as Record<string, unknown>).message;
      if (typeof message === "string") return message;
    }
  }
  return null;
}

function countFailureKinds(
  items: OvernightManualAttentionItem[],
): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const item of items) {
    if (!item.failureKind) continue;
    counts[item.failureKind] = (counts[item.failureKind] ?? 0) + 1;
  }
  return counts;
}

function appendBriefEvent(result: OvernightBriefResult): void {
  const ledger = getLedger();
  const sessionId = newSessionId("overnight-brief");
  ledger.ensureSession({
    sessionId,
    label: "overnight-brief",
    tags: ["overnight", "brief"],
  });
  ledger.appendEvent({
    sessionId,
    kind: "overnight.brief",
    actor: "overnight",
    payload: {
      status: result.status,
      sinceIso: result.sinceIso,
      untilIso: result.untilIso,
      summary: result.summary,
    },
  });
}

function dedupeRunEvents(events: LedgerEvent[]): LedgerEvent[] {
  const selected = new Map<string, LedgerEvent>();
  for (const event of events) {
    if (event.kind !== "overnight.enqueue" && event.kind !== "overnight.run") continue;
    const runId = stringOrNull(record(event.payload).runId);
    if (!runId) continue;
    const existing = selected.get(runId);
    if (
      !existing ||
      (existing.kind === "overnight.enqueue" && event.kind === "overnight.run")
    ) {
      selected.set(runId, event);
    }
  }
  return [...selected.values()].sort((a, b) => a.ts.localeCompare(b.ts));
}

function queueRecord(event: LedgerEvent): Record<string, unknown> {
  return event.kind === "overnight.enqueue"
    ? record(event.payload)
    : record(record(event.payload).queue);
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function stringOrNull(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function numberOrNull(value: unknown): number | null {
  return typeof value === "number" ? value : null;
}

function booleanOrNull(value: unknown): boolean | null {
  return typeof value === "boolean" ? value : null;
}
