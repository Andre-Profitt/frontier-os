// Deterministic ID transforms for OTLP export.
//
// OTLP requires traceId = 32 hex chars, spanId = 16 hex chars. Frontier's
// native ids (evt_mo4wnc8n_645diwo6, ses_mo4wnc7o_claude-adhoc_ydskca) are
// non-hex and variable-length. SHA-256 truncation gives us a stable,
// collision-resistant mapping — same input → same output, round-tripable for
// trace correlation.

import { createHash } from "node:crypto";

/** 32 hex chars for OTLP trace_id. */
export function toTraceIdHex(sessionId: string): string {
  return createHash("sha256").update(sessionId).digest("hex").slice(0, 32);
}

/** 16 hex chars for OTLP span_id. */
export function toSpanIdHex(eventId: string): string {
  return createHash("sha256").update(eventId).digest("hex").slice(0, 16);
}

/** Parse an ISO-8601 timestamp to Unix nanoseconds (as a string, per OTLP spec). */
export function isoToUnixNanos(iso: string): string {
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) return "0";
  // JavaScript loses precision beyond ms; pad with zeros for nanos.
  return `${ms}000000`;
}
