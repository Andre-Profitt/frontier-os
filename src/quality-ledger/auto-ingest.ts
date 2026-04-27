// Auto-ingest helper for `frontier orchestrate` (Patch J). Pure
// wrapper around ingestArtifactsDir that:
//   - skips when opts.skip=true (operator opt-out via --skip-ingest)
//   - skips when the orchestration didn't succeed (exitCode !== 0) so
//     we don't pollute the routing memory with incomplete runs
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
  if (packet.exitCode !== 0) {
    return {
      attempted: false,
      ok: false,
      reason: `orchestration exitCode=${packet.exitCode}; ingest skipped to keep ledger free of incomplete runs`,
    };
  }
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
