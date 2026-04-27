// Quality ledger writer. Ingests an OrchestrationPacket (and the
// sub-packets it points to) and emits per-event JSONL rows.
//
// Append-only. Never rewrites existing rows. The reader is responsible
// for de-duping on eventId if a packet is ingested twice (uncommon but
// possible if an operator runs the CLI again on the same artifacts).
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

// Build the events for one orchestration. Pure function — useful for
// tests that inspect what would be written without touching the
// filesystem.
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
  const rerunOk = arbiterDecision.rerunVerification.results.some(
    (v) => v.phase === "passed",
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
    rerunVerificationOk: rerunOk,
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

  return events;
}

export function ingestOrchestration(
  input: IngestInput,
  opts: IngestOptions = {},
): IngestResult {
  const ledgerDir = opts.ledgerDir ?? DEFAULT_LEDGER_DIR;
  const now = opts.now ?? Date.now;
  const events = buildEvents(input, now);

  // Validate every event before persisting any. A single bad event
  // poisons the whole ingest — partial writes are worse than none.
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

  if (!opts.dryRun) {
    mkdirSync(ledgerDir, { recursive: true });
    for (const e of events) {
      const file = pathFor(ledgerDir, e.kind);
      appendFileSync(file, JSON.stringify(e) + "\n");
    }
  }

  return {
    workerRuns: counts.workerRuns,
    reviewFindings: counts.reviewFindings,
    arbiterDecisions: counts.arbiterDecisions,
    modelEvents: counts.modelEvents,
    appendedAt: new Date(now()).toISOString(),
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
  const reviewPackets: Array<{ builderId: string; packet: ReviewPacket }> = [];
  for (const r of packet.reviewPacketPaths) {
    if (!existsSync(r.path)) continue;
    const rp = JSON.parse(readFileSync(r.path, "utf8")) as ReviewPacket;
    reviewPackets.push({ builderId: r.builderId, packet: rp });
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

  // Resolve packetId + arbiterAgreed from artifactsDir if provided.
  let packetId = input.packetId;
  let arbiterAgreed: boolean | undefined;
  let arbiterAgreedComputed = false;
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
    if (existsSync(arbPath) && input.acceptedBuilderId) {
      try {
        const arb = JSON.parse(
          readFileSync(arbPath, "utf8"),
        ) as ArbiterDecision;
        arbiterAgreed = arb.selectedBuilderId === input.acceptedBuilderId;
        arbiterAgreedComputed = true;
      } catch {
        // ignore
      }
    }
  }

  // Synthetic packetId when the caller didn't link to an orchestration.
  // Operators may want to mark a decision before/without running the
  // orchestrator (e.g. a hand-applied patch).
  const ts = new Date(now()).toISOString();
  if (!packetId) packetId = `manual-${input.taskId}-${ts}`;

  const event: import("./types.ts").HumanDecisionEvent = {
    eventId: `${packetId}-hd-${Math.random().toString(36).slice(2, 8)}`,
    taskId: input.taskId,
    packetId,
    ts,
    kind: "human_decision",
    decision: input.decision,
    ...(input.acceptedBuilderId !== undefined
      ? { acceptedBuilderId: input.acceptedBuilderId }
      : {}),
    ...(arbiterAgreed !== undefined ? { arbiterAgreed } : {}),
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

// Aggregate the review packet's findings for the candidate's worker_run
// row. Mirrors ReviewPacket.findingsBySeverity + findingsByCategory but
// flattens for the ledger schema.
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
