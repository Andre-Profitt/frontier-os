// Auto-ingest helper for `frontier orchestrate` (Patch J). Pure
// wrapper around ingestArtifactsDir that:
//   - skips ONLY when opts.skip=true (operator opt-out via
//     --skip-ingest). Patch J self-review NB1: ingest on ALL three
//     orchestration exit codes (0=accept, 1=reject, 2=escalate). All
//     three are completed orchestrations with full evidence (worker
//     runs, review findings, arbiter decision); reject/escalate are
//     SIGNAL ("which models produce candidates the arbiter rejects"
//     and "which models cause escalations"), not failure modes. A
//     truly broken orchestration throws from runOrchestration before
//     we ever reach this helper.
//   - traps any QualityLedgerError so an ingest failure (e.g. duplicate
//     packetId, schema mismatch) doesn't mask the orchestration's
//     primary result. The operator can always re-ingest by hand:
//       frontier quality ledger ingest --artifacts <dir>
//
// Tested directly so the cmdOrchestrate handler stays a thin caller.

import type { OrchestrationPacket } from "../orchestrate/types.ts";
import { ingestArtifactsDir, type IngestOptions } from "./writer.ts";

export interface AutoIngestStatus {
  attempted: boolean;
  ok: boolean;
  // Populated only when attempted=true and ok=true.
  counts?: {
    workerRuns: number;
    reviewFindings: number;
    arbiterDecisions: number;
    modelEvents: number;
  };
  // Reason for skip (when attempted=false) or failure (when ok=false).
  reason?: string;
}

export interface AutoIngestOptions {
  // Operator opt-out (--skip-ingest). Default false → ingest happens.
  skip?: boolean;
  // Override the default ledger directory.
  ledgerDir?: string;
  // Test seam — defaults to ingestArtifactsDir.
  ingestImpl?: typeof ingestArtifactsDir;
}

export function autoIngestOrchestration(
  packet: OrchestrationPacket,
  opts: AutoIngestOptions = {},
): AutoIngestStatus {
  if (opts.skip) {
    return { attempted: false, ok: false, reason: "skipped via --skip-ingest" };
  }
  // No exitCode guard: 0/1/2 all reflect a completed orchestration
  // with full evidence. See module header.
  const ingest = opts.ingestImpl ?? ingestArtifactsDir;
  try {
    const ingestOpts: IngestOptions = {};
    if (opts.ledgerDir) ingestOpts.ledgerDir = opts.ledgerDir;
    const result = ingest(packet.artifactsDir, ingestOpts);
    return {
      attempted: true,
      ok: true,
      counts: {
        workerRuns: result.workerRuns,
        reviewFindings: result.reviewFindings,
        arbiterDecisions: result.arbiterDecisions,
        modelEvents: result.modelEvents,
      },
    };
  } catch (e) {
    return {
      attempted: true,
      ok: false,
      reason: e instanceof Error ? e.message : String(e),
    };
  }
}
