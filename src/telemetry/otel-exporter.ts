// Ledger → OTLP/HTTP JSON exporter.
//
// Reads `events` rows from ~/.frontier/ledger.db, maps each to an OTLP span
// tagged with OpenInference semantic-convention attributes, and POSTs to the
// configured collector (Phoenix / Langfuse / Grafana Tempo — all accept OTLP).
//
// We do NOT depend on an OTel SDK — we control `traceId`/`spanId` generation
// ourselves and the OTLP JSON shape is small enough to serialize by hand.
// This avoids pulling 30+ MB of `@opentelemetry/*` packages for a one-way
// export that runs on a schedule.

import {
  AGENT_NAME,
  EVAL_EXPLANATION,
  EVAL_NAME,
  EVAL_SCORE,
  FRONTIER_ADAPTER_ID,
  FRONTIER_APPROVAL_CLASS,
  FRONTIER_EVENT_KIND,
  FRONTIER_GRAPH_ID,
  FRONTIER_SIDE_EFFECT_CLASS,
  GRAPH_NODE_ID,
  GRAPH_NODE_NAME,
  GRAPH_NODE_PARENT_ID,
  INPUT_VALUE,
  METADATA,
  OPENINFERENCE_SPAN_KIND,
  OUTPUT_VALUE,
  SESSION_ID,
  SpanKind,
  TOOL_DESCRIPTION,
  TOOL_NAME,
  TOOL_PARAMETERS,
  USER_ID,
} from "./attributes.ts";
import { isoToUnixNanos, toSpanIdHex, toTraceIdHex } from "./id-hash.ts";
import { getLedger } from "../ledger/index.ts";

export interface ExportOptions {
  /** Collector endpoint accepting OTLP/HTTP JSON (POST). */
  endpoint?: string;
  /** ISO timestamp; only export events with ts >= sinceIso. */
  sinceIso?: string;
  /** Cap batch size for the single-shot export. */
  limit?: number;
  /** Emit to stdout instead of POSTing. */
  dryRun?: boolean;
  /** Only export events whose kind starts with this prefix. */
  kindPrefix?: string;
}

export interface ExportSummary {
  endpoint: string | null;
  sinceIso: string;
  kindPrefix: string | null;
  eventCount: number;
  spanCount: number;
  dryRun: boolean;
  httpStatus?: number;
  httpBody?: string;
  httpError?: string;
}

const DEFAULT_ENDPOINT = "http://localhost:6006/v1/traces";
const SERVICE_NAME = "frontier-os";
const SERVICE_VERSION = "0.1.0";
const SCOPE_NAME = "frontier-os.ledger";

interface OtlpAttributeValue {
  stringValue?: string;
  boolValue?: boolean;
  intValue?: string;
  doubleValue?: number;
}

interface OtlpAttribute {
  key: string;
  value: OtlpAttributeValue;
}

interface OtlpSpan {
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  name: string;
  kind: number;
  startTimeUnixNano: string;
  endTimeUnixNano: string;
  attributes: OtlpAttribute[];
  status?: { code: number; message?: string };
}

interface OtlpPayload {
  resourceSpans: Array<{
    resource: { attributes: OtlpAttribute[] };
    scopeSpans: Array<{
      scope: { name: string; version: string };
      spans: OtlpSpan[];
    }>;
  }>;
}

interface LedgerEventRow {
  eventId: string;
  sessionId: string;
  offset: number;
  ts: string;
  kind: string;
  actor: string | null;
  traceId: string | null;
  payload: string; // JSON text
}

export async function exportLedger(
  opts: ExportOptions = {},
): Promise<ExportSummary> {
  const endpoint = opts.endpoint ?? DEFAULT_ENDPOINT;
  const sinceIso =
    opts.sinceIso ?? new Date(Date.now() - 24 * 3600 * 1000).toISOString();
  const limit = Math.max(1, Math.min(5000, opts.limit ?? 1000));

  const rows = readEvents(sinceIso, limit, opts.kindPrefix);
  const spans: OtlpSpan[] = [];
  for (const row of rows) {
    const span = mapEventToSpan(row);
    if (span) spans.push(span);
  }

  const payload: OtlpPayload = {
    resourceSpans: [
      {
        resource: {
          attributes: [
            attr("service.name", SERVICE_NAME),
            attr("service.version", SERVICE_VERSION),
            attr("telemetry.sdk.name", "frontier-os-handrolled"),
          ],
        },
        scopeSpans: [
          {
            scope: { name: SCOPE_NAME, version: SERVICE_VERSION },
            spans,
          },
        ],
      },
    ],
  };

  const summary: ExportSummary = {
    endpoint: opts.dryRun ? null : endpoint,
    sinceIso,
    kindPrefix: opts.kindPrefix ?? null,
    eventCount: rows.length,
    spanCount: spans.length,
    dryRun: Boolean(opts.dryRun),
  };

  if (opts.dryRun) {
    process.stdout.write(JSON.stringify(payload, null, 2) + "\n");
    return summary;
  }

  try {
    const res = await fetch(endpoint, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    });
    summary.httpStatus = res.status;
    summary.httpBody = (await res.text()).slice(0, 400);
  } catch (err) {
    summary.httpError = err instanceof Error ? err.message : String(err);
  }
  return summary;
}

// --- mapping ---

function readEvents(
  sinceIso: string,
  limit: number,
  kindPrefix?: string,
): LedgerEventRow[] {
  const ledger = getLedger();
  const stmt = (
    ledger as unknown as {
      db: {
        prepare: (sql: string) => { all: (...args: unknown[]) => unknown[] };
      };
    }
  ).db.prepare(
    kindPrefix
      ? `SELECT event_id as eventId, session_id as sessionId, offset, ts, kind,
                 actor, trace_id as traceId, payload
         FROM events
         WHERE ts >= ? AND kind LIKE ?
         ORDER BY ts ASC
         LIMIT ?`
      : `SELECT event_id as eventId, session_id as sessionId, offset, ts, kind,
                 actor, trace_id as traceId, payload
         FROM events
         WHERE ts >= ?
         ORDER BY ts ASC
         LIMIT ?`,
  );
  const rows = kindPrefix
    ? stmt.all(sinceIso, `${kindPrefix}%`, limit)
    : stmt.all(sinceIso, limit);
  return rows as LedgerEventRow[];
}

function mapEventToSpan(row: LedgerEventRow): OtlpSpan | null {
  let payload: Record<string, unknown>;
  try {
    payload = JSON.parse(row.payload) as Record<string, unknown>;
  } catch {
    payload = { _raw: row.payload };
  }
  const unixNanos = isoToUnixNanos(row.ts);
  const attrs: OtlpAttribute[] = [
    attr(FRONTIER_EVENT_KIND, row.kind),
    attr(SESSION_ID, row.sessionId),
  ];
  if (row.actor) attrs.push(attr(USER_ID, row.actor));
  if (row.traceId) attrs.push(attr("frontier.trace_id.raw", row.traceId));

  const name = row.kind;
  const kindSemantic = semanticKindForEvent(row.kind);
  if (kindSemantic) attrs.push(attr(OPENINFERENCE_SPAN_KIND, kindSemantic));

  enrichAttributes(row.kind, payload, attrs);

  attrs.push(attr(METADATA, JSON.stringify(payload)));

  const traceId =
    typeof row.traceId === "string" && row.traceId.length > 0
      ? toTraceIdHex(row.traceId)
      : toTraceIdHex(row.sessionId);
  const spanId = toSpanIdHex(row.eventId);

  return {
    traceId,
    spanId,
    name,
    kind: 1, // SPAN_KIND_INTERNAL
    startTimeUnixNano: unixNanos,
    endTimeUnixNano: unixNanos,
    attributes: attrs,
    status: statusForEvent(row.kind, payload),
  };
}

function semanticKindForEvent(kind: string): string | null {
  if (kind === "invocation.start" || kind === "invocation.end")
    return SpanKind.TOOL;
  if (kind === "artifact" || kind === "side_effect") return SpanKind.TOOL;
  if (
    kind.startsWith("agent.pre_tool_use") ||
    kind.startsWith("agent.post_tool_use")
  )
    return SpanKind.TOOL;
  if (kind.startsWith("agent.user_prompt")) return SpanKind.AGENT;
  if (kind.startsWith("agent.session_") || kind === "agent.stop")
    return SpanKind.AGENT;
  if (kind === "agent.review") return SpanKind.EVALUATOR;
  if (
    kind.startsWith("work.node_") ||
    kind === "work.graph_start" ||
    kind === "work.graph_end"
  )
    return SpanKind.CHAIN;
  if (kind.startsWith("work.verifier_")) return SpanKind.EVALUATOR;
  if (
    kind.startsWith("work.awaiting_approval") ||
    kind.startsWith("work.approved")
  )
    return SpanKind.GUARDRAIL;
  if (kind === "audit.grade" || kind === "finding") return SpanKind.EVALUATOR;
  if (kind === "watcher.tick") return SpanKind.CHAIN;
  if (kind.startsWith("ghost.")) return SpanKind.AGENT;
  if (kind.startsWith("refinery.")) return SpanKind.EVALUATOR;
  return null;
}

function enrichAttributes(
  kind: string,
  payload: Record<string, unknown>,
  attrs: OtlpAttribute[],
): void {
  const str = (k: string): string | null => {
    const v = payload[k];
    return typeof v === "string" ? v : null;
  };
  const num = (k: string): number | null => {
    const v = payload[k];
    return typeof v === "number" ? v : null;
  };

  // Tool name / parameters
  const toolName = str("tool") ?? str("tool_name");
  if (toolName) attrs.push(attr(TOOL_NAME, toolName));
  if (payload["adapterId"] && typeof payload["adapterId"] === "string") {
    attrs.push(attr(FRONTIER_ADAPTER_ID, String(payload["adapterId"])));
    attrs.push(
      attr(TOOL_NAME, `${payload["adapterId"]}.${payload["command"] ?? ""}`),
    );
  }
  if (payload["tool_input"] || payload["arguments"]) {
    attrs.push(
      attr(
        TOOL_PARAMETERS,
        JSON.stringify(payload["tool_input"] ?? payload["arguments"]),
      ),
    );
  }
  if (
    payload["command_preview"] &&
    typeof payload["command_preview"] === "string"
  ) {
    attrs.push(attr(TOOL_DESCRIPTION, String(payload["command_preview"])));
  }

  // Input/output from agent tool use
  if (
    kind === "agent.post_tool_use" &&
    payload["tool_response_status"] !== undefined
  ) {
    attrs.push(
      attr(
        OUTPUT_VALUE,
        JSON.stringify({ status: payload["tool_response_status"] }),
      ),
    );
  }
  if (kind === "agent.user_prompt" && payload["prompt_preview"]) {
    attrs.push(attr(INPUT_VALUE, String(payload["prompt_preview"])));
  }

  // Graph node
  if (payload["nodeId"] && typeof payload["nodeId"] === "string") {
    attrs.push(attr(GRAPH_NODE_ID, String(payload["nodeId"])));
  }
  if (payload["title"] && typeof payload["title"] === "string") {
    attrs.push(attr(GRAPH_NODE_NAME, String(payload["title"])));
  }
  if (payload["graphId"] && typeof payload["graphId"] === "string") {
    attrs.push(attr(FRONTIER_GRAPH_ID, String(payload["graphId"])));
  }
  if (
    payload["parent_event_id"] &&
    typeof payload["parent_event_id"] === "string"
  ) {
    attrs.push(attr(GRAPH_NODE_PARENT_ID, String(payload["parent_event_id"])));
  }

  // Verifier / eval
  if (kind.startsWith("work.verifier_check") || kind === "agent.review") {
    const check = str("check") ?? str("verdict");
    if (check) attrs.push(attr(EVAL_NAME, check));
    const passed = payload["passed"];
    if (typeof passed === "boolean") {
      attrs.push({ key: EVAL_SCORE, value: { doubleValue: passed ? 1 : 0 } });
    }
    const reason = str("reason") ?? str("evidence");
    if (reason) attrs.push(attr(EVAL_EXPLANATION, reason));
  }

  // Approval class
  if (payload["approvalClassEffective"] !== undefined) {
    const v = num("approvalClassEffective");
    if (v !== null) {
      attrs.push({
        key: FRONTIER_APPROVAL_CLASS,
        value: { intValue: String(v) },
      });
    }
  }

  // Side effects
  const se = payload["sideEffects"];
  if (Array.isArray(se) && se.length > 0) {
    attrs.push(attr(FRONTIER_SIDE_EFFECT_CLASS, (se as unknown[]).join(",")));
  }
  if (payload["class"] && typeof payload["class"] === "string") {
    attrs.push(attr(FRONTIER_SIDE_EFFECT_CLASS, String(payload["class"])));
  }

  // Agent name from actor fallback
  if (kind.startsWith("agent.") && payload["actor"]) {
    attrs.push(attr(AGENT_NAME, String(payload["actor"])));
  }
}

function statusForEvent(
  kind: string,
  payload: Record<string, unknown>,
): { code: number; message?: string } {
  // OTLP status codes: 0=UNSET, 1=OK, 2=ERROR
  if (kind.endsWith("_failed") || kind.endsWith(".fail"))
    return { code: 2, message: "failed" };
  if (kind === "invocation.end" && payload["status"] === "failed") {
    return { code: 2, message: "invocation failed" };
  }
  if (kind === "work.verifier_fail")
    return { code: 2, message: "verifier failed" };
  if (kind === "alert") return { code: 2, message: "alert" };
  return { code: 1 };
}

function attr(key: string, value: string): OtlpAttribute {
  return { key, value: { stringValue: value } };
}
