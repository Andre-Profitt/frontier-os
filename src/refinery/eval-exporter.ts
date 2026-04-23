// Failure Refinery — Eval dataset exporter (Phase 12).
//
// Closes the trace→eval loop (vision §13.3 + observability lift manifest):
// every refined failure proposal's example events become labeled rows in a
// Langfuse dataset. A future `frontier eval run --dataset <name>` replays
// those inputs against the current tool/adapter and fails if behavior
// regresses — so fixing one failure means it can never silently come back.
//
// Langfuse ingest (MIT core, self-host or cloud):
//   POST {base}/api/public/dataset-items
//   auth: Basic base64(PUBLIC_KEY:SECRET_KEY)
//   body: { datasetName, id?, input, expectedOutput?, metadata,
//           sourceTraceId, sourceObservationId? }
//
// Idempotency: we never re-send an (ruleId, eventId) pair that's already in
// ~/.frontier/refinery/eval-exports.jsonl. Re-running is a no-op.

import Database from "better-sqlite3";
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";

import { getLedger } from "../ledger/index.ts";
import { newSessionId } from "../ledger/events.ts";
import { loadProposals } from "./registry.ts";
import { toTraceIdHex, toSpanIdHex } from "../telemetry/id-hash.ts";
import type { PolicyRuleProposal } from "./rules.ts";

const LEDGER_DB = resolve(homedir(), ".frontier", "ledger.db");
const EVAL_EXPORTS_LOG = resolve(
  homedir(),
  ".frontier",
  "refinery",
  "eval-exports.jsonl",
);

export interface ExportOptions {
  /** Langfuse base URL. Default: LANGFUSE_BASE_URL env var or Langfuse Cloud. */
  baseUrl?: string;
  /** Target dataset name in Langfuse. Default: frontier-refinery-failures. */
  datasetName?: string;
  /** Langfuse public key (or read from LANGFUSE_PUBLIC_KEY env). */
  publicKey?: string;
  /** Langfuse secret key (or read from LANGFUSE_SECRET_KEY env). */
  secretKey?: string;
  /** Only consider proposals observed on/after this ISO. */
  sinceIso?: string;
  /** Hard cap on dataset items emitted per run. */
  maxItems?: number;
  /** Emit to stdout instead of POSTing. Also implied when creds missing. */
  dryRun?: boolean;
}

export interface DatasetItemPayload {
  datasetName: string;
  id: string;
  input: unknown;
  expectedOutput: null;
  metadata: Record<string, unknown>;
  sourceTraceId: string;
  sourceObservationId?: string;
  status?: "ACTIVE" | "ARCHIVED";
}

export interface ExportSummary {
  datasetName: string;
  baseUrl: string | null;
  proposalsConsidered: number;
  itemsBuilt: number;
  itemsSkippedIdempotent: number;
  itemsPosted: number;
  itemsFailed: number;
  dryRun: boolean;
  reasonIfDryRun?: string;
  samplePayloads?: DatasetItemPayload[];
  errors?: Array<{ itemId: string; status?: number; error: string }>;
}

const DEFAULT_DATASET = "frontier-refinery-failures";
const DEFAULT_BASE_URL = "https://cloud.langfuse.com";
const DEFAULT_MAX_ITEMS = 500;

export async function exportEvalDataset(
  opts: ExportOptions = {},
): Promise<ExportSummary> {
  const baseUrl =
    opts.baseUrl ?? process.env.LANGFUSE_BASE_URL ?? DEFAULT_BASE_URL;
  const datasetName = opts.datasetName ?? DEFAULT_DATASET;
  const publicKey = opts.publicKey ?? process.env.LANGFUSE_PUBLIC_KEY;
  const secretKey = opts.secretKey ?? process.env.LANGFUSE_SECRET_KEY;
  const maxItems = Math.max(
    1,
    Math.min(5000, opts.maxItems ?? DEFAULT_MAX_ITEMS),
  );

  const sinceIso = opts.sinceIso ?? "1970-01-01T00:00:00Z";
  const proposals = loadProposals().filter((p) => p.proposedAt >= sinceIso);

  const sent = loadSentPairs();
  const items: DatasetItemPayload[] = [];
  let skipped = 0;

  for (const proposal of proposals) {
    for (const eventId of proposal.evidence.exampleEventIds) {
      if (items.length >= maxItems) break;
      if (sent.has(`${proposal.ruleId}:${eventId}`)) {
        skipped++;
        continue;
      }
      const event = fetchEvent(eventId);
      if (!event) continue;
      items.push(buildItem(datasetName, proposal, event));
    }
    if (items.length >= maxItems) break;
  }

  const forceDry =
    opts.dryRun === true ||
    !publicKey ||
    !secretKey ||
    publicKey.trim() === "" ||
    secretKey.trim() === "";
  const summary: ExportSummary = {
    datasetName,
    baseUrl: forceDry ? null : baseUrl,
    proposalsConsidered: proposals.length,
    itemsBuilt: items.length,
    itemsSkippedIdempotent: skipped,
    itemsPosted: 0,
    itemsFailed: 0,
    dryRun: forceDry,
  };
  if (forceDry) {
    summary.reasonIfDryRun =
      opts.dryRun === true
        ? "--dry-run"
        : "LANGFUSE_PUBLIC_KEY / LANGFUSE_SECRET_KEY not set; dry-run forced";
    summary.samplePayloads = items.slice(0, 3);
    return summary;
  }

  const errors: Array<{ itemId: string; status?: number; error: string }> = [];
  const postedPairs: Array<{
    ruleId: string;
    eventId: string;
    itemId: string;
  }> = [];
  for (const item of items) {
    const r = await postItem(baseUrl, publicKey, secretKey, item);
    if (r.ok) {
      summary.itemsPosted++;
      postedPairs.push({
        ruleId: String(item.metadata.frontierRuleId),
        eventId: String(item.metadata.frontierSourceEventId),
        itemId: item.id,
      });
    } else {
      summary.itemsFailed++;
      const errEntry: { itemId: string; status?: number; error: string } = {
        itemId: item.id,
        error: r.error ?? "unknown",
      };
      if (r.status !== undefined) errEntry.status = r.status;
      errors.push(errEntry);
    }
  }
  if (errors.length > 0) summary.errors = errors.slice(0, 10);

  if (postedPairs.length > 0) {
    recordExports(postedPairs);
    emitLedgerEvent(datasetName, postedPairs);
  }
  return summary;
}

// ---- helpers ----

function fetchEvent(eventId: string): {
  eventId: string;
  sessionId: string;
  ts: string;
  kind: string;
  actor: string | null;
  traceId: string | null;
  payload: Record<string, unknown>;
} | null {
  const db = new Database(LEDGER_DB, { readonly: true, fileMustExist: true });
  try {
    const row = db
      .prepare(
        `SELECT event_id, session_id, ts, kind, actor, trace_id, payload
         FROM events WHERE event_id = ?`,
      )
      .get(eventId) as
      | {
          event_id: string;
          session_id: string;
          ts: string;
          kind: string;
          actor: string | null;
          trace_id: string | null;
          payload: string;
        }
      | undefined;
    if (!row) return null;
    let payload: Record<string, unknown> = {};
    try {
      payload = JSON.parse(row.payload) as Record<string, unknown>;
    } catch {
      payload = { _raw: row.payload };
    }
    return {
      eventId: row.event_id,
      sessionId: row.session_id,
      ts: row.ts,
      kind: row.kind,
      actor: row.actor,
      traceId: row.trace_id,
      payload,
    };
  } finally {
    db.close();
  }
}

function buildItem(
  datasetName: string,
  proposal: PolicyRuleProposal,
  event: NonNullable<ReturnType<typeof fetchEvent>>,
): DatasetItemPayload {
  // Deterministic id so re-sends upsert rather than duplicate on Langfuse.
  const id = `frontier_${proposal.ruleId}_${event.eventId}`;
  const input = extractInput(event);
  const traceId = event.traceId
    ? toTraceIdHex(event.traceId)
    : toTraceIdHex(event.sessionId);
  const observationId = toSpanIdHex(event.eventId);

  return {
    datasetName,
    id,
    input,
    expectedOutput: null,
    metadata: {
      frontierSignature: proposal.evidence.signature,
      frontierRuleId: proposal.ruleId,
      frontierSourceKind: event.kind,
      frontierVerdict: verdictFromEvent(event),
      frontierGradedBy: gradedBy(event),
      frontierSourceEventId: event.eventId,
      frontierSessionId: event.sessionId,
      frontierActor: event.actor ?? "unknown",
      frontierTs: event.ts,
      frontierSuggestedAction: proposal.suggestedAction,
      frontierProposalReason: proposal.reason,
    },
    sourceTraceId: traceId,
    sourceObservationId: observationId,
    status: "ACTIVE",
  };
}

function extractInput(
  event: NonNullable<ReturnType<typeof fetchEvent>>,
): unknown {
  const p = event.payload;
  // Best-effort reconstruction of "what the agent was trying to do" when
  // the event fired. Order matters — agent tool use > adapter invocation
  // > work-graph node > verifier check > fallback to whole payload.
  if ("tool_input" in p && p.tool_input) {
    return { tool: p.tool_name ?? p.tool, tool_input: p.tool_input };
  }
  if ("arguments" in p && p.arguments) {
    return {
      adapter: p.adapterId ?? null,
      command: p.command ?? null,
      arguments: p.arguments,
    };
  }
  if ("title" in p && typeof p.title === "string") {
    return { nodeId: p.nodeId ?? null, title: p.title };
  }
  if ("check" in p && typeof p.check === "string") {
    return { check: p.check, nodeId: p.nodeId ?? null };
  }
  if ("command_preview" in p && typeof p.command_preview === "string") {
    return { command_preview: p.command_preview };
  }
  return p;
}

function verdictFromEvent(
  event: NonNullable<ReturnType<typeof fetchEvent>>,
): "reject" | "fail" | "skip" | "unknown" {
  if (event.kind === "agent.review") {
    const v = event.payload["verdict"];
    return v === "reject" ? "reject" : "unknown";
  }
  if (
    event.kind === "work.verifier_fail" ||
    event.kind === "work.node_failed"
  ) {
    return "fail";
  }
  if (
    event.kind === "work.verifier_check" &&
    event.payload["passed"] === false
  ) {
    return "fail";
  }
  if (
    event.kind === "work.node_skipped" ||
    event.kind === "ghost.graph_rejected"
  ) {
    return "skip";
  }
  return "unknown";
}

function gradedBy(
  event: NonNullable<ReturnType<typeof fetchEvent>>,
): "verifier" | "reviewer" | "ghost" | "executor" {
  if (event.kind === "agent.review") return "reviewer";
  if (event.kind.startsWith("work.verifier_")) return "verifier";
  if (event.kind.startsWith("ghost.")) return "ghost";
  return "executor";
}

// ---- Langfuse HTTP ----

async function postItem(
  baseUrl: string,
  publicKey: string,
  secretKey: string,
  item: DatasetItemPayload,
): Promise<{ ok: boolean; status?: number; error?: string }> {
  const auth = Buffer.from(`${publicKey}:${secretKey}`).toString("base64");
  const url = `${baseUrl.replace(/\/+$/, "")}/api/public/dataset-items`;
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Basic ${auth}`,
      },
      body: JSON.stringify(item),
    });
    if (res.status >= 200 && res.status < 300) {
      return { ok: true, status: res.status };
    }
    const body = (await res.text()).slice(0, 400);
    return { ok: false, status: res.status, error: body };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

// ---- idempotency ----

function loadSentPairs(): Set<string> {
  const set = new Set<string>();
  if (!existsSync(EVAL_EXPORTS_LOG)) return set;
  const lines = readFileSync(EVAL_EXPORTS_LOG, "utf8").split(/\r?\n/);
  for (const line of lines) {
    if (!line.trim()) continue;
    try {
      const row = JSON.parse(line) as { ruleId?: string; eventId?: string };
      if (row.ruleId && row.eventId) {
        set.add(`${row.ruleId}:${row.eventId}`);
      }
    } catch {
      /* skip malformed line */
    }
  }
  return set;
}

function recordExports(
  pairs: Array<{ ruleId: string; eventId: string; itemId: string }>,
): void {
  mkdirSync(dirname(EVAL_EXPORTS_LOG), { recursive: true });
  const now = new Date().toISOString();
  const body = pairs
    .map((p) => JSON.stringify({ ...p, exportedAt: now }))
    .join("\n");
  appendFileSync(EVAL_EXPORTS_LOG, body + "\n");
}

function emitLedgerEvent(
  datasetName: string,
  pairs: Array<{ ruleId: string; eventId: string }>,
): void {
  const ledger = getLedger();
  const sessionId = newSessionId(`refinery-eval-export-${datasetName}`);
  ledger.ensureSession({
    sessionId,
    label: `refinery:eval-export:${datasetName}`,
    tags: ["refinery", "eval-export", datasetName],
  });
  ledger.appendEvent({
    sessionId,
    kind: "refinery.eval_exported" as Parameters<
      typeof ledger.appendEvent
    >[0]["kind"],
    actor: "refinery.eval-exporter",
    payload: {
      datasetName,
      itemCount: pairs.length,
      ruleIds: Array.from(new Set(pairs.map((p) => p.ruleId))),
    },
  });
}

export function evalExportStats(): {
  logPath: string;
  totalExports: number;
  byRule: Record<string, number>;
} {
  const byRule: Record<string, number> = {};
  if (!existsSync(EVAL_EXPORTS_LOG)) {
    return { logPath: EVAL_EXPORTS_LOG, totalExports: 0, byRule };
  }
  const lines = readFileSync(EVAL_EXPORTS_LOG, "utf8").split(/\r?\n/);
  let total = 0;
  for (const line of lines) {
    if (!line.trim()) continue;
    try {
      const row = JSON.parse(line) as { ruleId?: string };
      if (row.ruleId) {
        byRule[row.ruleId] = (byRule[row.ruleId] ?? 0) + 1;
        total++;
      }
    } catch {
      /* skip */
    }
  }
  return { logPath: EVAL_EXPORTS_LOG, totalExports: total, byRule };
}
