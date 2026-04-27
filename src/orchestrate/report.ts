// Render the operator-facing final-report.md for an orchestration run.
//
// Designed to be the FIRST thing a human reads when an orchestration
// completes. Buries nothing: decision and exit code at the top, then the
// rationale, then the per-candidate breakdown, then the artifact
// pointers.

import type { ArbiterDecision } from "../arbiter/types.ts";
import type { BuilderSwarmPacket } from "../swarm/builder-swarm.ts";
import type { ReviewPacket } from "../swarm/review-swarm.ts";
import type { OrchestrationInput, OrchestrationPacket } from "./types.ts";

export interface RenderInput {
  packet: OrchestrationPacket;
  input: OrchestrationInput;
  builderPacket: BuilderSwarmPacket;
  reviewPackets: Array<{ builderId: string; packet: ReviewPacket }>;
  arbiterDecision: ArbiterDecision;
}

export function renderFinalReport(input: RenderInput): string {
  const lines: string[] = [];
  const { packet, builderPacket, reviewPackets, arbiterDecision } = input;
  const exitLabel =
    packet.exitCode === 0
      ? "accept"
      : packet.exitCode === 1
        ? "reject"
        : "escalate";

  lines.push(`# Orchestration final report — ${packet.taskId}`);
  lines.push("");
  lines.push(
    `**Decision:** \`${arbiterDecision.decision}\` (exit code ${packet.exitCode}: ${exitLabel})`,
  );
  if (arbiterDecision.selectedBuilderId) {
    lines.push(`**Selected:** \`${arbiterDecision.selectedBuilderId}\``);
  }
  if (arbiterDecision.escalationQuestion) {
    lines.push(`**Escalation:** ${arbiterDecision.escalationQuestion}`);
  }
  if (arbiterDecision.rejectionReasons?.length) {
    lines.push("**Rejection reasons:**");
    for (const r of arbiterDecision.rejectionReasons) lines.push(`- ${r}`);
  }
  lines.push("");
  lines.push(`Generated at: ${packet.scannedAt}`);
  lines.push(`Elapsed: ${packet.elapsedMs}ms`);
  lines.push("");

  // Arbiter evidence is the load-bearing prose.
  lines.push("## Arbiter evidence");
  lines.push("");
  lines.push("```");
  lines.push(arbiterDecision.evidence);
  lines.push("```");
  lines.push("");

  // Builder swarm summary.
  lines.push("## Builder swarm");
  lines.push("");
  lines.push(`- builders spawned: ${builderPacket.builderCount}`);
  lines.push(
    `- collected: ${builderPacket.candidates.filter((c) => c.phase === "collected").length}`,
  );
  lines.push(
    `- models used: ${builderPacket.modelsUsed.join(", ") || "(none)"}`,
  );
  lines.push("");
  lines.push("Per-builder phase:");
  for (const c of builderPacket.candidates) {
    const modelLabel = c.modelKey ? ` (${c.modelKey})` : "";
    lines.push(
      `- \`${c.builderId}\`${modelLabel} → ${c.phase}` +
        (c.errorMessage ? ` — ${c.errorMessage.slice(0, 200)}` : ""),
    );
  }
  lines.push("");

  // Review swarm summaries.
  if (reviewPackets.length > 0) {
    lines.push("## Review swarms (one per collected candidate)");
    lines.push("");
    for (const { builderId, packet: rp } of reviewPackets) {
      const high = rp.findingsBySeverity.high ?? 0;
      const medium = rp.findingsBySeverity.medium ?? 0;
      const low = rp.findingsBySeverity.low ?? 0;
      const cov = rp.reviewCoverage.toFixed(2);
      lines.push(
        `- \`${builderId}\`: ${rp.totalFindings} findings (high=${high}, medium=${medium}, low=${low}); reviewCoverage=${cov} (${rp.validReviewerCount}/${rp.reviewerCount} valid)`,
      );
      const cats = Object.entries(rp.findingsByCategory)
        .map(([k, v]) => `${k}=${v}`)
        .join(", ");
      if (cats) lines.push(`  by category: ${cats}`);
    }
    lines.push("");
  }

  // Rubric scoring breakdown — one block per candidate the arbiter
  // evaluated. Coverage is surfaced explicitly so the operator doesn't
  // misread a 1.0 score under a 0.1 coverage as confident.
  if (arbiterDecision.rubricScores.length > 0) {
    lines.push("## Rubric scoring");
    lines.push("");
    for (const score of arbiterDecision.rubricScores) {
      lines.push(
        `- \`${score.builderId}\`: score=${score.score.toFixed(2)} coverage=${score.coverage.toFixed(2)} (${score.scoredWeight}/${score.totalWeight} weight)` +
          (score.unsupportedCriteria.length > 0
            ? ` — unscored: ${score.unsupportedCriteria.join(", ")}`
            : ""),
      );
    }
    lines.push("");
  }

  // Re-run verification table.
  if (arbiterDecision.rerunVerification.results.length > 0) {
    lines.push("## Verification re-run (arbiter ground-truth)");
    lines.push("");
    for (const v of arbiterDecision.rerunVerification.results) {
      lines.push(
        `- \`${v.builderId}\`: phase=${v.phase} typecheck=${v.typecheckExitCode ?? "n/a"} test=${v.testExitCode ?? "n/a"}`,
      );
    }
    lines.push("");
  }

  // Anti-example matches if any.
  const matched = arbiterDecision.antiExampleMatches.filter(
    (m) => m.verdict === "matches",
  );
  if (matched.length > 0) {
    lines.push("## Anti-example matches");
    lines.push("");
    for (const m of matched) {
      lines.push(`- \`${m.builderId}\` matched ${m.antiExample}`);
    }
    lines.push("");
  }

  // Artifact pointers.
  lines.push("## Artifacts");
  lines.push("");
  lines.push(`- builder swarm packet: \`${packet.builderPacketPath}\``);
  lines.push(`- arbiter decision: \`${packet.arbiterDecisionPath}\``);
  if (packet.contextPackPath) {
    lines.push(`- context pack: \`${packet.contextPackPath}\``);
  }
  for (const r of packet.reviewPacketPaths) {
    lines.push(`- review packet (${r.builderId}): \`${r.path}\``);
  }
  lines.push("");
  lines.push(
    `_Operator next step: read the arbiter evidence above. R6 never auto-merges. To apply an accepted candidate's patch, inspect the worktree at the candidate's worktreePath in the builder swarm packet._`,
  );
  lines.push("");

  return lines.join("\n");
}
