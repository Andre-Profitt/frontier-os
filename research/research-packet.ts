// research/research-packet.ts
//
// A research run produces four durable artifacts:
//   research-packet.md   — human-readable narrative
//   claim-ledger.ndjson  — claim records (claim-ledger.ts)
//   source-ledger.ndjson — source records (source-ledger.ts)
//   review.md            — adversarial review pass
//
// This module is the orchestrator for those artifacts: type contracts,
// a writer that lays out a fresh run directory, and a verifier that
// checks each claim resolves to at least one source on disk.
//
// Concrete-first: a packet today is one folder per (topic, runId)
// under research/runs/. Upstream tool integration (STORM, GPT
// Researcher, PaperQA2, Agent Laboratory) is out of scope for this
// PR — the artifacts must be stable first.

import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

import {
  readClaims,
  type ClaimRecord,
  type ClaimStatus,
} from "./claim-ledger.ts";
import { findSource, readSources, type SourceRecord } from "./source-ledger.ts";

export interface ResearchPacketSpec {
  schema: "frontier_os.research.packet_spec.v1";
  /**
   * The research question this packet answers. Must be specific
   * enough that a reader can tell whether a claim is on-topic.
   */
  question: string;
  /** Free-form scope notes (what's in vs what's out). */
  scope: string;
  /** Why this matters now — links to a project, lane, or PR. */
  motivation: string;
  /**
   * Acceptance criteria. The packet is "complete" when every item
   * has at least one supporting claim with status="supported".
   */
  acceptance: string[];
  /** Tags applied to every artifact in the run. */
  tags: string[];
}

export interface ResearchPacketLayout {
  runDir: string;
  spec: ResearchPacketSpec;
  claimLedgerPath: string;
  sourceLedgerPath: string;
  packetMarkdownPath: string;
  reviewMarkdownPath: string;
  startedAt: string;
}

export interface CreatePacketOptions {
  rootDir: string;
  topic: string;
  spec: ResearchPacketSpec;
  clock?: () => Date;
  /** Test seam — override directory naming. */
  runIdGenerator?: (now: Date) => string;
}

export function newPacketRunId(now: Date): string {
  const ts = now
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d+Z$/, "Z");
  const r = Math.random().toString(36).slice(2, 6);
  return `pkt_${ts}_${r}`;
}

function slugify(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)+/g, "")
    .slice(0, 60);
}

export function createPacket(opts: CreatePacketOptions): ResearchPacketLayout {
  const clock = opts.clock ?? (() => new Date());
  const idGen = opts.runIdGenerator ?? newPacketRunId;
  const now = clock();
  const runId = idGen(now);
  const slug = slugify(opts.topic);
  if (!slug) {
    throw new Error(`topic produced an empty slug: "${opts.topic}"`);
  }
  const runDir = resolve(opts.rootDir, "runs", `${slug}-${runId}`);
  mkdirSync(runDir, { recursive: true });

  const layout: ResearchPacketLayout = {
    runDir,
    spec: opts.spec,
    claimLedgerPath: resolve(runDir, "claim-ledger.ndjson"),
    sourceLedgerPath: resolve(runDir, "source-ledger.ndjson"),
    packetMarkdownPath: resolve(runDir, "research-packet.md"),
    reviewMarkdownPath: resolve(runDir, "review.md"),
    startedAt: now.toISOString(),
  };

  // Seed the markdown files with the spec so the run dir is
  // self-describing even if the agent crashes mid-run.
  const seedHeader =
    `# ${opts.topic}\n\n` +
    `**Run id:** \`${runId}\`\n` +
    `**Started at:** ${layout.startedAt}\n` +
    `**Spec schema:** ${opts.spec.schema}\n\n` +
    `## Question\n\n${opts.spec.question}\n\n` +
    `## Scope\n\n${opts.spec.scope}\n\n` +
    `## Motivation\n\n${opts.spec.motivation}\n\n` +
    `## Acceptance criteria\n\n` +
    opts.spec.acceptance.map((a) => `- [ ] ${a}`).join("\n") +
    "\n\n";

  if (!existsSync(layout.packetMarkdownPath)) {
    writeFileSync(
      layout.packetMarkdownPath,
      seedHeader +
        "## Findings\n\n_(populate as claims land in claim-ledger.ndjson)_\n",
      "utf8",
    );
  }
  if (!existsSync(layout.reviewMarkdownPath)) {
    writeFileSync(
      layout.reviewMarkdownPath,
      `# Review — ${opts.topic}\n\n**Run id:** \`${runId}\`\n\n` +
        `## Adversarial pass\n\n` +
        `- [ ] Every supported claim has at least one supporting source\n` +
        `- [ ] Every contradicted claim has a counter-source on file\n` +
        `- [ ] No claim's quoteOrSummary exceeds 35 words\n` +
        `- [ ] Acceptance criteria all marked done\n` +
        `- [ ] Sources span at least two independent providers (not all one vendor)\n\n` +
        `## Notes\n\n_(reviewer fills in)_\n`,
      "utf8",
    );
  }
  return layout;
}

// --- verification --------------------------------------------------------

export interface PacketCompletenessReport {
  schema: "frontier_os.research.packet_completeness.v1";
  runDir: string;
  totalClaims: number;
  supportedClaims: number;
  contradictedClaims: number;
  uncertainClaims: number;
  supersededClaims: number;
  /** Claim IDs that point at a sourceId not present in the source ledger. */
  orphanedClaimIds: string[];
  /** Source IDs nothing in the claim ledger references. */
  orphanedSourceIds: string[];
  /**
   * Acceptance items with no claim referencing them in `usedFor`. When
   * empty, the packet is "complete" by the spec's own bar.
   */
  unmetAcceptance: string[];
  status: "complete" | "incomplete" | "broken";
}

function statusFromCounts(
  totalClaims: number,
  orphanedClaimIds: string[],
  unmetAcceptance: string[],
): "complete" | "incomplete" | "broken" {
  if (orphanedClaimIds.length > 0) return "broken";
  if (totalClaims === 0) return "incomplete";
  if (unmetAcceptance.length > 0) return "incomplete";
  return "complete";
}

export function computeCompleteness(
  layout: ResearchPacketLayout,
): PacketCompletenessReport {
  const claims = readClaims(layout.claimLedgerPath);
  const sources = readSources(layout.sourceLedgerPath);
  const sourceIds = new Set(sources.map((s) => s.sourceId));

  const orphanedClaimIds: string[] = [];
  const referencedSourceIds = new Set<string>();
  let supported = 0;
  let contradicted = 0;
  let uncertain = 0;
  let superseded = 0;
  for (const c of claims) {
    for (const s of c.support) {
      referencedSourceIds.add(s.sourceId);
      if (!sourceIds.has(s.sourceId)) {
        orphanedClaimIds.push(c.claimId);
      }
    }
    switch (c.status as ClaimStatus) {
      case "supported":
        supported++;
        break;
      case "contradicted":
        contradicted++;
        break;
      case "uncertain":
      case "mixed":
        uncertain++;
        break;
      case "superseded":
        superseded++;
        break;
    }
  }

  const orphanedSourceIds: string[] = [];
  for (const s of sources) {
    if (!referencedSourceIds.has(s.sourceId)) {
      orphanedSourceIds.push(s.sourceId);
    }
  }

  // Acceptance criteria are matched against claim.usedFor by their
  // leading label — the text up to the first " — ", " - ", ":", or
  // "(". This lets a criterion like "tool selection — at least one
  // supported claim ..." match a usedFor of "tool selection —
  // paperqa2 first" without requiring the full sentence to align.
  const usedForBlob = claims
    .flatMap((c) => c.usedFor)
    .map((s) => s.toLowerCase());
  function leadingLabel(s: string): string {
    const lower = s.toLowerCase();
    const stops = [" — ", " - ", " – ", ":", "(", "—", "–"];
    let cut = lower.length;
    for (const t of stops) {
      const i = lower.indexOf(t);
      if (i !== -1 && i < cut) cut = i;
    }
    return lower.slice(0, cut).trim();
  }
  const unmetAcceptance = layout.spec.acceptance.filter((a) => {
    const needle = leadingLabel(a);
    if (needle.length < 4) return false; // short labels can't be reliably matched
    return !usedForBlob.some((u) => u.includes(needle));
  });

  return {
    schema: "frontier_os.research.packet_completeness.v1",
    runDir: layout.runDir,
    totalClaims: claims.length,
    supportedClaims: supported,
    contradictedClaims: contradicted,
    uncertainClaims: uncertain,
    supersededClaims: superseded,
    orphanedClaimIds: Array.from(new Set(orphanedClaimIds)),
    orphanedSourceIds,
    unmetAcceptance,
    status: statusFromCounts(claims.length, orphanedClaimIds, unmetAcceptance),
  };
}

export type { ClaimRecord, SourceRecord };
export { findSource };
