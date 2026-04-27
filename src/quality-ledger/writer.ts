// Quality ledger writer. Ingests an OrchestrationPacket (and the
// sub-packets it points to) and emits per-event JSONL rows.
//
// Append-only. Never rewrites existing rows. Re-ingesting the same
// packetId throws QualityLedgerError unless `force: true` is passed —
// double-ingest silently doubles every downstream aggregate
// (selectionRate, validityRate, finding counts), so we fail loud at the
// writer rather than push the burden to the reader.
//
// Design choices that matter:
//   - One row per builder CANDIDATE in worker-runs.jsonl. Excluded
//     candidates (phase != collected) get rows too — "this model failed
//     at apply_failed" is signal.
//   - One row per FINDING in review-findings.jsonl. Denormalized so
//     downstream queries don't need a join.
//   - Per (modelKey, role, taskClass) aggregate in model-events.jsonl.
//     Lets the model-score CLI compute per-orchestration deltas.
//   - ALL rows validated against schemas/quality-ledger-event.schema.json
//     before write. Drift surfaces in tests, not at downstream queries.

import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { appendFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";

import type { ArbiterDecision } from "../arbiter/types.ts";
import type {
  BuilderSwarmPacket,
  CandidatePatch,
} from "../swarm/builder-swarm.ts";
import type { Finding, ReviewPacket } from "../swarm/review-swarm.ts";
import type { OrchestrationPacket } from "../orchestrate/types.ts";
import { validateQualityLedgerEvent } from "../schemas.ts";
import {
  QualityLedgerError,
  type ArbiterDecisionEvent,
  type ModelEvent,
  type QualityLedgerEvent,
  type ReviewFindingEvent,
  type WorkerRunEvent,
} from "./types.ts";

const HERE = fileURLToPath(import.meta.url);
const REPO_ROOT_DEFAULT = resolve(dirname(HERE), "..", "..");

export const DEFAULT_LEDGER_DIR = resolve(
  REPO_ROOT_DEFAULT,
  "state",
  "quality-ledger",
);

export interface IngestInput {
  packet: OrchestrationPacket;
  builderPacket: BuilderSwarmPacket;
  reviewPackets: Array<{ builderId: string; packet: ReviewPacket }>;
  arbiterDecision: ArbiterDecision;
}

export interface IngestOptions {
  ledgerDir?: string;
  now?: () => number;
  // Pure-function mode: don't append to disk, just return what would
  // have been written. Used by the dry-run CLI flag and most tests.
  dryRun?: boolean;
  // Opt-in to re-ingest a packetId that's already in the ledger.
  // Default false → ingest throws QualityLedgerError on duplicate
  // packetId so silent double-counting can't poison downstream
  // aggregates (selectionRate, validityRate, finding counts).
  force?: boolean;
}

export interface IngestResult {
  workerRuns: number;
  reviewFindings: number;
  arbiterDecisions: number;
  modelEvents: number;
  appendedAt: string;
  // The events that were (or would have been) appended, in write order.
  // Lets tests inspect content without re-reading the JSONL files.
  events: QualityLedgerEvent[];
}

// Build the events for one orchestration. Validates every event against
// the quality-ledger JSON Schema before returning — callers can never
// observe an unvalidated event from this module. Throws
// QualityLedgerError on the first invalid event (no partial output).
export function buildEvents(
  input: IngestInput,
  now: () => number = Date.now,
): QualityLedgerEvent[] {
  const events: QualityLedgerEvent[] = [];
  const { packet, builderPacket, reviewPackets, arbiterDecision } = input;
  const ts = new Date(now()).toISOString();
  let seq = 0;
  const eid = (kind: string) => `${packet.packetId}-${kind}-${seq++}`;

  // Index review packets by builderId for fast lookup.
  const reviewByBuilder = new Map<string, ReviewPacket>();
  for (const r of reviewPackets) reviewByBuilder.set(r.builderId, r.packet);

  // Index rubric scores by builderId for the worker_run rows.
  const rubricByBuilder = new Map<
    string,
    { score: number; coverage: number }
  >();
  for (const s of arbiterDecision.rubricScores) {
    rubricByBuilder.set(s.builderId, {
      score: s.score,
      coverage: s.coverage,
    });
  }
  // Index verification phase by builderId.
  const verPhaseByBuilder = new Map<string, string>();
  for (const v of arbiterDecision.rerunVerification.results) {
    verPhaseByBuilder.set(v.builderId, v.phase);
  }

  // ---- worker_run events: one per builder candidate ----
  for (const c of builderPacket.candidates) {
    const review = reviewByBuilder.get(c.builderId);
    const rubric = rubricByBuilder.get(c.builderId);
    const verPhase = verPhaseByBuilder.get(c.builderId);
    const arbiterOutcome: WorkerRunEvent["arbiterOutcome"] =
      c.phase !== "collected"
        ? "excluded"
        : arbiterDecision.selectedBuilderId === c.builderId
          ? "selected"
          : "not_selected";
    const event: WorkerRunEvent = {
      eventId: eid("wr"),
      taskId: packet.taskId,
      packetId: packet.packetId,
      ts,
      kind: "worker_run",
      workerId: c.builderId,
      role: "builder",
      ...(c.modelKey !== undefined ? { modelKey: c.modelKey } : {}),
      taskClass: builderPacket.taskClass,
      phase: c.phase,
      ok: c.ok,
      ...(c.patch
        ? {
            patch: {
              sizeBytes: c.patch.sizeBytes,
              addedLines: c.patch.addedLines,
              deletedLines: c.patch.deletedLines,
              commitCount: c.patch.commitCount,
              files: c.patch.files,
            },
          }
        : {}),
      ...(rubric !== undefined
        ? { rubricScore: rubric.score, rubricCoverage: rubric.coverage }
        : {}),
      ...(verPhase !== undefined ? { verificationPhase: verPhase } : {}),
      ...(c.applyAttempts !== undefined
        ? { applyAttempts: c.applyAttempts }
        : {}),
      arbiterOutcome,
      ...(review
        ? {
            reviewFindings: aggregateFindingsForLedger(review),
          }
        : {}),
    };
    events.push(event);
  }

  // ---- review_finding events: one per finding (denormalized) ----
  for (const { builderId, packet: rp } of reviewPackets) {
    for (const reviewer of rp.reviewers) {
      if (!reviewer.output) continue; // invalid reviewer — no findings to record
      for (const finding of reviewer.output.findings) {
        const event: ReviewFindingEvent = {
          eventId: eid("rf"),
          taskId: packet.taskId,
          packetId: packet.packetId,
          ts,
          kind: "review_finding",
          reviewerId: reviewer.reviewerId,
          ...(reviewer.modelKey !== undefined
            ? { modelKey: reviewer.modelKey }
            : {}),
          reviewerRole: "reviewer",
          taskClass: rp.taskClass,
          category: finding.category,
          severity: finding.severity,
          ...(finding.file !== undefined ? { file: finding.file } : {}),
          ...(finding.line !== undefined ? { line: finding.line } : {}),
          claim: finding.claim,
          reviewedBuilderId: builderId,
        };
        events.push(event);
      }
    }
  }

  // ---- arbiter_decision event: one per orchestration ----
  // Two signals:
  //   anyCandidateVerified — coarse "did anyone pass." Useful for "did
  //     the orchestration produce a verifiable patch at all" telemetry.
  //   selectedCandidateVerified — "did the candidate WE PICKED pass."
  //     This is the routing-decision signal; the recommender should
  //     prefer it because "some candidate passed" can overstate the
  //     arbiter decision when the picked candidate isn't that one
  //     (or when no candidate was picked at all — escalate/reject).
  const anyCandidateVerified = arbiterDecision.rerunVerification.results.some(
    (v) => v.phase === "passed",
  );
  const selectedCandidateVerified =
    arbiterDecision.selectedBuilderId !== undefined &&
    arbiterDecision.rerunVerification.results.some(
      (v) =>
        v.builderId === arbiterDecision.selectedBuilderId &&
        v.phase === "passed",
    );
  const decisionEvent: ArbiterDecisionEvent = {
    eventId: eid("ad"),
    taskId: packet.taskId,
    packetId: packet.packetId,
    ts,
    kind: "arbiter_decision",
    decision: arbiterDecision.decision,
    ...(arbiterDecision.selectedBuilderId !== undefined
      ? { selectedBuilderId: arbiterDecision.selectedBuilderId }
      : {}),
    ...(arbiterDecision.qualityFloor !== undefined
      ? { qualityFloor: arbiterDecision.qualityFloor }
      : {}),
    candidatesEvaluated: arbiterDecision.candidatesEvaluated,
    anyCandidateVerified,
    selectedCandidateVerified,
  };
  events.push(decisionEvent);

  // ---- model_event aggregates: per (modelKey, role, taskClass) ----
  // Builder side: count by modelKey across builderPacket.candidates.
  const builderByModel = new Map<
    string,
    { total: number; ok: number; failed: number; selected: number }
  >();
  for (const c of builderPacket.candidates) {
    if (!c.modelKey) continue;
    const stats = builderByModel.get(c.modelKey) ?? {
      total: 0,
      ok: 0,
      failed: 0,
      selected: 0,
    };
    stats.total += 1;
    if (c.ok) stats.ok += 1;
    else stats.failed += 1;
    if (arbiterDecision.selectedBuilderId === c.builderId) stats.selected += 1;
    builderByModel.set(c.modelKey, stats);
  }
  for (const [modelKey, stats] of builderByModel) {
    events.push({
      eventId: eid("me"),
      taskId: packet.taskId,
      packetId: packet.packetId,
      ts,
      kind: "model_event",
      modelKey,
      role: "builder",
      taskClass: builderPacket.taskClass,
      callsTotal: stats.total,
      callsOk: stats.ok,
      callsFailed: stats.failed,
      arbiterSelectedCount: stats.selected,
    });
  }

  // Reviewer side: count by modelKey across all reviewer runs in all
  // review packets.
  const reviewerByModel = new Map<
    string,
    { total: number; ok: number; failed: number; taskClass: string }
  >();
  for (const { packet: rp } of reviewPackets) {
    for (const reviewer of rp.reviewers) {
      if (!reviewer.modelKey) continue;
      const stats = reviewerByModel.get(reviewer.modelKey) ?? {
        total: 0,
        ok: 0,
        failed: 0,
        taskClass: rp.taskClass,
      };
      stats.total += 1;
      if (reviewer.ok && reviewer.output) stats.ok += 1;
      else stats.failed += 1;
      reviewerByModel.set(reviewer.modelKey, stats);
    }
  }
  for (const [modelKey, stats] of reviewerByModel) {
    events.push({
      eventId: eid("me"),
      taskId: packet.taskId,
      packetId: packet.packetId,
      ts,
      kind: "model_event",
      modelKey,
      role: "reviewer",
      taskClass: stats.taskClass,
      callsTotal: stats.total,
      callsOk: stats.ok,
      callsFailed: stats.failed,
    });
  }

  // Validate every event before returning. Putting this inside
  // buildEvents (instead of in ingestOrchestration) means callers
  // cannot bypass schema validation by depending on the pure builder.
  for (const e of events) {
    // Capture identifying fields before validate — Ajv's type guard
    // narrows `e` to never in the !valid branch.
    const eventId = e.eventId;
    const kind = e.kind;
    if (!validateQualityLedgerEvent(e)) {
      throw new QualityLedgerError(
        `event ${eventId} (kind=${kind}) failed schema validation`,
        { errors: validateQualityLedgerEvent.errors, event: e },
      );
    }
  }

  return events;
}

export function ingestOrchestration(
  input: IngestInput,
  opts: IngestOptions = {},
): IngestResult {
  const ledgerDir = opts.ledgerDir ?? DEFAULT_LEDGER_DIR;
  const now = opts.now ?? Date.now;
  const packetId = input.packet.packetId;

  // Fail loud on duplicate ingest. Append-only + double-ingest silently
  // doubles every aggregate downstream (selectionRate, validityRate,
  // findings counts) — the operator must opt in via `force`.
  if (
    !opts.force &&
    packetAlreadyIngested(ledgerDir, packetId, { dryRun: opts.dryRun ?? false })
  ) {
    throw new QualityLedgerError(
      `packet ${packetId} already ingested into ${ledgerDir}; pass force=true (CLI: --force-reingest) to override`,
      { packetId, ledgerDir },
    );
  }

  const events = buildEvents(input, now);

  const counts = {
    workerRuns: 0,
    reviewFindings: 0,
    arbiterDecisions: 0,
    modelEvents: 0,
  };
  for (const e of events) {
    if (e.kind === "worker_run") counts.workerRuns += 1;
    else if (e.kind === "review_finding") counts.reviewFindings += 1;
    else if (e.kind === "arbiter_decision") counts.arbiterDecisions += 1;
    else if (e.kind === "model_event") counts.modelEvents += 1;
  }

  const appendedAt = new Date(now()).toISOString();
  if (!opts.dryRun) {
    mkdirSync(ledgerDir, { recursive: true });
    // Patch R blocker #4: write transaction begin marker BEFORE event
    // rows. If the process crashes mid-ingest, the manifest will have
    // an in_progress row but no complete row → dedup detects the
    // packet as retryable instead of treating partial events as a
    // permanent ingest. Reader-side dedup-by-eventId then collapses
    // the partial-crash rows when the retry replays them.
    appendPacketIndexRow(
      ledgerDir,
      input.packet.packetId,
      input.packet.taskId,
      input.packet.scannedAt,
      appendedAt,
      "in_progress",
    );
    for (const e of events) {
      const file = pathFor(ledgerDir, e.kind);
      appendFileSync(file, JSON.stringify(e) + "\n");
    }
    // Transaction complete: now and only now is the packet considered
    // fully ingested for dedup purposes.
    appendPacketIndexRow(
      ledgerDir,
      input.packet.packetId,
      input.packet.taskId,
      input.packet.scannedAt,
      new Date(now()).toISOString(),
      "complete",
    );
  }

  return {
    workerRuns: counts.workerRuns,
    reviewFindings: counts.reviewFindings,
    arbiterDecisions: counts.arbiterDecisions,
    modelEvents: counts.modelEvents,
    appendedAt,
    events,
  };
}

// Read an OrchestrationPacket + sub-packets from an artifactsDir and
// ingest. CLI's `frontier quality ledger ingest --artifacts <dir>` calls
// this; tests can call buildEvents() directly with synthetic inputs.
export function ingestArtifactsDir(
  artifactsDir: string,
  opts: IngestOptions = {},
): IngestResult {
  const packetPath = resolve(artifactsDir, "orchestration-packet.json");
  if (!existsSync(packetPath)) {
    throw new QualityLedgerError(
      `orchestration-packet.json not found in ${artifactsDir}`,
    );
  }
  const packet = JSON.parse(
    readFileSync(packetPath, "utf8"),
  ) as OrchestrationPacket;
  const builderPacket = JSON.parse(
    readFileSync(packet.builderPacketPath, "utf8"),
  ) as BuilderSwarmPacket;
  // GPT Pro Patch I — fix #2: missing review packet paths used to be
  // silently skipped, which produced a ledger with fewer reviewer rows
  // than the orchestration promised and corrupted reviewer
  // validityRate downstream. Treat missing artifacts as a data-integrity
  // error — collect every miss and throw with the full list.
  const reviewPackets: Array<{ builderId: string; packet: ReviewPacket }> = [];
  const missing: Array<{ builderId: string; path: string }> = [];
  for (const r of packet.reviewPacketPaths) {
    if (!existsSync(r.path)) {
      missing.push({ builderId: r.builderId, path: r.path });
      continue;
    }
    const rp = JSON.parse(readFileSync(r.path, "utf8")) as ReviewPacket;
    reviewPackets.push({ builderId: r.builderId, packet: rp });
  }
  if (missing.length > 0) {
    const list = missing.map((m) => `${m.builderId}=${m.path}`).join(", ");
    throw new QualityLedgerError(
      `orchestration packet ${packet.packetId} declares ${missing.length} review packet(s) but the file(s) are missing on disk: ${list}; refusing to ingest a partial ledger`,
      { packetId: packet.packetId, missing },
    );
  }
  const arbiterDecision = JSON.parse(
    readFileSync(packet.arbiterDecisionPath, "utf8"),
  ) as ArbiterDecision;
  return ingestOrchestration(
    { packet, builderPacket, reviewPackets, arbiterDecision },
    opts,
  );
}

// --- Q2: human decision capture ------------------------------------------

export interface MarkHumanDecisionInput {
  taskId: string;
  // Optional: the orchestration packet this decision relates to. When
  // provided, the writer reads the packet's arbiter-decision.json to
  // compute arbiterAgreed (acceptedBuilderId === selectedBuilderId).
  packetId?: string;
  // Path to the orchestration's artifacts dir, used to resolve packetId
  // and compute arbiterAgreed when the caller didn't pass them.
  artifactsDir?: string;
  decision: "accepted" | "rejected" | "escalation_resolved" | "deferred";
  // Required when decision="accepted".
  acceptedBuilderId?: string;
  reason: string;
  decidedBy?: string;
}

export interface MarkResult {
  event: import("./types.ts").HumanDecisionEvent;
  appendedAt: string;
  ledgerPath: string;
  // True when the writer was able to compare against an arbiter
  // decision (artifactsDir or packetId resolved). false → arbiterAgreed
  // not computed.
  arbiterAgreedComputed: boolean;
}

export function markHumanDecision(
  input: MarkHumanDecisionInput,
  opts: IngestOptions = {},
): MarkResult {
  const ledgerDir = opts.ledgerDir ?? DEFAULT_LEDGER_DIR;
  const now = opts.now ?? Date.now;

  if (input.decision === "accepted" && !input.acceptedBuilderId) {
    throw new QualityLedgerError(
      "decision='accepted' requires acceptedBuilderId",
    );
  }

  // Resolve packetId + arbiterAgreed + humanOutcomeRelation from
  // artifactsDir if provided. arbiterDecision is loaded once and used
  // for both — computed below.
  let packetId = input.packetId;
  let arbiterAgreed: boolean | undefined;
  let arbiterAgreedComputed = false;
  let arbiterDecision: ArbiterDecision | undefined;
  if (input.artifactsDir) {
    const arbPath = resolve(input.artifactsDir, "arbiter-decision.json");
    const orchPath = resolve(input.artifactsDir, "orchestration-packet.json");
    if (existsSync(orchPath)) {
      try {
        const orch = JSON.parse(
          readFileSync(orchPath, "utf8"),
        ) as OrchestrationPacket;
        packetId = packetId ?? orch.packetId;
      } catch {
        // ignore — packetId stays undefined; we'll set a synthetic below
      }
    }
    if (existsSync(arbPath)) {
      try {
        arbiterDecision = JSON.parse(
          readFileSync(arbPath, "utf8"),
        ) as ArbiterDecision;
        if (input.acceptedBuilderId) {
          arbiterAgreed =
            arbiterDecision.selectedBuilderId === input.acceptedBuilderId;
          arbiterAgreedComputed = true;
        }
      } catch {
        // ignore
      }
    }
  }
  // Patch K — GPT Pro safe-follow-up: richer than arbiterAgreed.
  // See HumanOutcomeRelation in types.ts for the enum definition.
  const humanOutcomeRelation: import("./types.ts").HumanOutcomeRelation =
    computeHumanOutcomeRelation(input, arbiterDecision);

  // Synthetic packetId when the caller didn't link to an orchestration.
  // Operators may want to mark a decision before/without running the
  // orchestrator (e.g. a hand-applied patch). Use crypto.randomUUID so
  // two operators marking the same task in the same millisecond cannot
  // collide.
  const ts = new Date(now()).toISOString();
  if (!packetId) packetId = `manual-${input.taskId}-${randomUUID()}`;

  const event: import("./types.ts").HumanDecisionEvent = {
    eventId: `${packetId}-hd-${randomUUID()}`,
    taskId: input.taskId,
    packetId,
    ts,
    kind: "human_decision",
    decision: input.decision,
    ...(input.acceptedBuilderId !== undefined
      ? { acceptedBuilderId: input.acceptedBuilderId }
      : {}),
    ...(arbiterAgreed !== undefined ? { arbiterAgreed } : {}),
    humanOutcomeRelation,
    reason: input.reason,
    ...(input.decidedBy !== undefined ? { decidedBy: input.decidedBy } : {}),
  };

  if (!validateQualityLedgerEvent(event)) {
    throw new QualityLedgerError(
      `human_decision event failed schema validation`,
      { errors: validateQualityLedgerEvent.errors, event },
    );
  }

  const ledgerPath = resolve(ledgerDir, "human-decisions.jsonl");
  if (!opts.dryRun) {
    mkdirSync(ledgerDir, { recursive: true });
    appendFileSync(ledgerPath, JSON.stringify(event) + "\n");
  }

  return {
    event,
    appendedAt: ts,
    ledgerPath,
    arbiterAgreedComputed,
  };
}

// --- helpers --------------------------------------------------------------

function pathFor(ledgerDir: string, kind: QualityLedgerEvent["kind"]): string {
  switch (kind) {
    case "worker_run":
      return resolve(ledgerDir, "worker-runs.jsonl");
    case "review_finding":
      return resolve(ledgerDir, "review-findings.jsonl");
    case "arbiter_decision":
      return resolve(ledgerDir, "arbiter-decisions.jsonl");
    case "human_decision":
      return resolve(ledgerDir, "human-decisions.jsonl");
    case "model_event":
      return resolve(ledgerDir, "model-events.jsonl");
  }
}

// GPT Pro Patch I — fix #1: packet dedup via a dedicated manifest
// (state/quality-ledger/packets-index.jsonl), one row per ingested
// packet. Replaces the prior O(file size) substring scan over
// worker-runs.jsonl, which would have become the ingest bottleneck at
// 100k+ event rows. The index file is small and grows linearly with
// orchestrations, not events.
//
// Each row: {packetId, taskId, ts, ingestedAt}. taskId/ts are
// duplicated from the OrchestrationPacket so an operator can `cat`
// the manifest and see what's been ingested without parsing the full
// event ledger.
//
// Backwards-compat: if a ledger directory has worker-runs.jsonl rows
// but no packets-index.jsonl (e.g. ingested by an earlier writer
// version), readPacketIndex does a one-shot backfill on first call and
// then trusts the manifest from then on.
//
// Patch I follow-up (PR #25 v2): the backfill is gated by an explicit
// `backfill` option. dryRun ingestion MUST set backfill=false so a
// "what would happen" call cannot mutate disk — the prior version
// silently created `packets-index.jsonl` (and mkdir'd the ledger
// directory) during a dryRun, violating the dryRun contract. The
// in-memory packet set is still computed correctly so dedup detection
// works in dryRun; only the disk write is suppressed.

const PACKETS_INDEX_FILE = "packets-index.jsonl";

interface PacketIndexRow {
  packetId: string;
  taskId: string;
  ts: string;
  ingestedAt: string;
  // Patch R blocker #4: transaction status. "in_progress" is written
  // BEFORE event JSONL writes; "complete" AFTER. Reader treats a
  // packetId as fully ingested only when a "complete" row exists, so
  // a process crash mid-ingest leaves the packet retryable rather
  // than creating a phantom dedup hit on partial events. Legacy rows
  // without `status` are treated as "complete" for backwards compat.
  status?: "in_progress" | "complete";
}

function packetIndexPath(ledgerDir: string): string {
  return resolve(ledgerDir, PACKETS_INDEX_FILE);
}

function readPacketIndex(
  ledgerDir: string,
  opts: { backfill?: boolean } = {},
): Set<string> {
  const backfill = opts.backfill ?? true;
  const indexFile = packetIndexPath(ledgerDir);
  if (existsSync(indexFile)) {
    // Patch R blocker #4: only "complete" rows count as already
    // ingested. Rows with status=undefined are legacy (pre-Patch-R
    // writer or backfilled rows) — treat as complete to preserve
    // dedup against existing ledger directories. Rows with
    // status="in_progress" mean a crash happened mid-ingest; the
    // packet is RETRYABLE so we deliberately do NOT add it to the
    // set.
    //
    // Patch S non-blocker: malformed lines used to be silently
    // skipped, which hid duplicate-ingest protection failures (e.g.
    // an operator hand-edit truncating a row). Now the reader throws
    // with file/line context so the operator notices and can fix the
    // manifest before any new ingest. Strictly stricter than Patch R.
    const set = new Set<string>();
    const text = readFileSync(indexFile, "utf8");
    const lines = text.split("\n");
    for (let i = 0; i < lines.length; i++) {
      const trimmed = lines[i]!.trim();
      if (trimmed.length === 0) continue;
      let row: PacketIndexRow;
      try {
        row = JSON.parse(trimmed) as PacketIndexRow;
      } catch (e) {
        throw new QualityLedgerError(
          `packets-index.jsonl line ${i + 1} is not valid JSON: ${e instanceof Error ? e.message : String(e)} (raw: ${trimmed.slice(0, 200)})`,
          { ledgerDir, line: i + 1 },
        );
      }
      if (typeof row.packetId !== "string") {
        throw new QualityLedgerError(
          `packets-index.jsonl line ${i + 1} missing packetId field (raw: ${trimmed.slice(0, 200)})`,
          { ledgerDir, line: i + 1 },
        );
      }
      const status = row.status ?? "complete";
      if (status === "complete") set.add(row.packetId);
    }
    return set;
  }
  // No manifest yet. Scan worker-runs.jsonl in-memory to build the
  // packet set so dedup still works. Persist the backfill ONLY when
  // backfill=true (default) — dryRun callers pass false so no disk
  // write happens.
  const workerRunsFile = resolve(ledgerDir, "worker-runs.jsonl");
  if (!existsSync(workerRunsFile)) return new Set();
  const seen = new Map<string, PacketIndexRow>();
  const text = readFileSync(workerRunsFile, "utf8");
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    try {
      const row = JSON.parse(trimmed) as {
        packetId?: unknown;
        taskId?: unknown;
        ts?: unknown;
      };
      if (typeof row.packetId !== "string") continue;
      if (seen.has(row.packetId)) continue;
      seen.set(row.packetId, {
        packetId: row.packetId,
        taskId: typeof row.taskId === "string" ? row.taskId : "",
        ts: typeof row.ts === "string" ? row.ts : "",
        ingestedAt: "backfill",
        // Backfilled rows represent already-persisted events from a
        // pre-Patch-R writer — record them as complete so dedup
        // continues to fire on these existing packetIds.
        status: "complete",
      });
    } catch {
      // Skip malformed worker_run line (reader has the same tolerance).
    }
  }
  if (seen.size > 0 && backfill) {
    mkdirSync(ledgerDir, { recursive: true });
    const lines = [...seen.values()].map((r) => JSON.stringify(r) + "\n");
    appendFileSync(packetIndexPath(ledgerDir), lines.join(""));
  }
  return new Set(seen.keys());
}

function packetAlreadyIngested(
  ledgerDir: string,
  packetId: string,
  opts: { dryRun?: boolean } = {},
): boolean {
  // dryRun must not write — disable backfill so the manifest stays off
  // disk until a real ingest happens.
  return readPacketIndex(ledgerDir, { backfill: !opts.dryRun }).has(packetId);
}

function appendPacketIndexRow(
  ledgerDir: string,
  packetId: string,
  taskId: string,
  ts: string,
  ingestedAt: string,
  status: "in_progress" | "complete",
): void {
  const row: PacketIndexRow = { packetId, taskId, ts, ingestedAt, status };
  appendFileSync(packetIndexPath(ledgerDir), JSON.stringify(row) + "\n");
}

// Aggregate the review packet's findings for the candidate's worker_run
// row. Mirrors ReviewPacket.findingsBySeverity + findingsByCategory but
// flattens for the ledger schema.
// Compute the richer human-vs-arbiter relation from the human's
// decision + (optionally) the arbiter decision file.
//
// Resolution order — each branch returns the most specific relation
// that fits the observed inputs:
//   decision=deferred              → "deferred"
//   decision=escalation_resolved   → "escalation_resolved"
//   decision=rejected              → "rejected_all"
//   decision=accepted, no arbiter  → "accepted_manual"
//                                    (no artifactsDir or arbiter file
//                                    missing — can't say what arbiter
//                                    would have picked)
//   decision=accepted, arbiter has selectedBuilderId === acceptedBuilderId
//                                  → "accepted_selected"
//   decision=accepted, arbiter pick differs                 → "accepted_non_selected"
//   anything else                  → "unknown"
function computeHumanOutcomeRelation(
  input: MarkHumanDecisionInput,
  arbiterDecision: ArbiterDecision | undefined,
): import("./types.ts").HumanOutcomeRelation {
  switch (input.decision) {
    case "deferred":
      return "deferred";
    case "escalation_resolved":
      return "escalation_resolved";
    case "rejected":
      return "rejected_all";
    case "accepted": {
      if (!arbiterDecision || !input.acceptedBuilderId) {
        return "accepted_manual";
      }
      return arbiterDecision.selectedBuilderId === input.acceptedBuilderId
        ? "accepted_selected"
        : "accepted_non_selected";
    }
  }
  // Exhaustiveness guard: TS will fail to compile if a new decision
  // value is added without a case above. The "unknown" enum value
  // remains in the schema for forward-compat with future readers, but
  // the writer never produces it.
  const exhaustive: never = input.decision;
  return exhaustive;
}

function aggregateFindingsForLedger(
  rp: ReviewPacket,
): NonNullable<WorkerRunEvent["reviewFindings"]> {
  return {
    high: rp.findingsBySeverity.high ?? 0,
    medium: rp.findingsBySeverity.medium ?? 0,
    low: rp.findingsBySeverity.low ?? 0,
    bug: rp.findingsByCategory["bug"] ?? 0,
    contract_violation: rp.findingsByCategory["contract_violation"] ?? 0,
    false_green: rp.findingsByCategory["false_green"] ?? 0,
    risk: rp.findingsByCategory["risk"] ?? 0,
    style: rp.findingsByCategory["style"] ?? 0,
  };
}
