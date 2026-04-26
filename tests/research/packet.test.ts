// research/research-packet.ts contract tests.
//
// createPacket lays out a fresh run directory with the four canonical
// artifacts (claim ledger NDJSON, source ledger NDJSON,
// research-packet.md, review.md). computeCompleteness verifies
// claim→source consistency and acceptance-criterion coverage.

import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

import { appendClaim } from "../../research/claim-ledger.ts";
import { appendSource } from "../../research/source-ledger.ts";
import {
  computeCompleteness,
  createPacket,
  newPacketRunId,
  type ResearchPacketSpec,
} from "../../research/research-packet.ts";

function tmp(): string {
  return mkdtempSync(resolve(tmpdir(), "frontier-research-"));
}

function spec(): ResearchPacketSpec {
  return {
    schema: "frontier_os.research.packet_spec.v1",
    question:
      "Which auto-research tools should the research factory integrate first?",
    scope:
      "Survey of STORM, GPT Researcher, PaperQA2, Agent Laboratory. Not surveying production agent stacks unless they ship research components.",
    motivation:
      "Block on choosing a first integration target for the research factory lane.",
    acceptance: [
      "tool selection — at least one supported claim about the chosen tool",
      "tradeoff analysis — at least one claim weighing scientific vs web research",
    ],
    tags: ["research-factory", "tool-selection"],
  };
}

test("createPacket writes the four canonical artifacts", () => {
  const root = tmp();
  const layout = createPacket({
    rootDir: root,
    topic: "research factory tool selection",
    spec: spec(),
    clock: () => new Date("2026-04-26T21:00:00Z"),
  });
  assert.ok(layout.runDir.startsWith(root));
  assert.ok(layout.runDir.includes("research-factory-tool-selection-pkt_"));
  // Empty until populated.
  assert.equal(existsSync(layout.claimLedgerPath), false);
  assert.equal(existsSync(layout.sourceLedgerPath), false);
  // Markdown files seeded with the spec.
  assert.equal(existsSync(layout.packetMarkdownPath), true);
  assert.equal(existsSync(layout.reviewMarkdownPath), true);
  const md = readFileSync(layout.packetMarkdownPath, "utf8");
  assert.match(md, /research factory tool selection/);
  assert.match(md, /Which auto-research tools/);
  assert.match(md, /## Acceptance criteria/);
  const review = readFileSync(layout.reviewMarkdownPath, "utf8");
  assert.match(review, /Adversarial pass/);
});

test("createPacket refuses an empty-slug topic", () => {
  const root = tmp();
  assert.throws(
    () =>
      createPacket({
        rootDir: root,
        topic: "!!!",
        spec: spec(),
      }),
    /empty slug/,
  );
});

test("computeCompleteness flags an empty packet as incomplete", () => {
  const root = tmp();
  const layout = createPacket({
    rootDir: root,
    topic: "scope-x",
    spec: spec(),
  });
  const r = computeCompleteness(layout);
  assert.equal(r.totalClaims, 0);
  assert.equal(r.status, "incomplete");
  assert.equal(r.orphanedClaimIds.length, 0);
  assert.equal(r.unmetAcceptance.length, spec().acceptance.length);
});

test("computeCompleteness flags an orphan-claim packet as broken", () => {
  const root = tmp();
  const layout = createPacket({
    rootDir: root,
    topic: "scope-x",
    spec: spec(),
  });
  // Claim cites a source that was never written to the source ledger.
  appendClaim({
    ledgerPath: layout.claimLedgerPath,
    text: "PaperQA2 supports citation-graph traversal.",
    status: "supported",
    confidence: "medium",
    support: [
      {
        sourceId: "src_phantom",
        quoteOrSummary: "PaperQA2 exposes citation graph operations.",
        stance: "supports",
        confidence: "medium",
      },
    ],
    usedFor: ["tool selection — paperqa2"],
  });
  const r = computeCompleteness(layout);
  assert.equal(r.status, "broken");
  assert.deepEqual(r.orphanedClaimIds.length > 0, true);
});

test("computeCompleteness reports complete when claims close all acceptance items", () => {
  const root = tmp();
  const layout = createPacket({
    rootDir: root,
    topic: "scope-x",
    spec: spec(),
  });

  const src = appendSource({
    ledgerPath: layout.sourceLedgerPath,
    kind: "paper",
    title: "PaperQA2 announcement",
    authors: ["FutureHouse"],
    summary:
      "PaperQA2 is a research agent for retrieving and summarizing scientific papers with citation-graph tools and explicit answer formulation.",
  });

  // Claim 1 — covers acceptance item "tool selection".
  appendClaim({
    ledgerPath: layout.claimLedgerPath,
    text: "PaperQA2 is a strong first integration target for the research factory.",
    status: "supported",
    confidence: "medium",
    support: [
      {
        sourceId: src.sourceId,
        quoteOrSummary:
          "Research agent for scientific papers with citation-graph tools.",
        stance: "supports",
        confidence: "medium",
      },
    ],
    usedFor: ["tool selection — paperqa2 first"],
  });

  // Claim 2 — covers acceptance item "tradeoff analysis".
  appendClaim({
    ledgerPath: layout.claimLedgerPath,
    text: "Scientific-paper RAG and general web research target different evidence shapes; the factory should keep them as separate tools.",
    status: "supported",
    confidence: "high",
    support: [
      {
        sourceId: src.sourceId,
        quoteOrSummary:
          "PaperQA2 is optimized for scientific literature, distinct from general web research.",
        stance: "supports",
        confidence: "high",
      },
    ],
    usedFor: ["tradeoff analysis — keep distinct"],
  });

  const r = computeCompleteness(layout);
  assert.equal(r.totalClaims, 2);
  assert.equal(r.supportedClaims, 2);
  assert.equal(r.orphanedClaimIds.length, 0);
  assert.equal(r.unmetAcceptance.length, 0);
  assert.equal(r.status, "complete");
});

test("computeCompleteness reports orphaned sources", () => {
  const root = tmp();
  const layout = createPacket({
    rootDir: root,
    topic: "scope-x",
    spec: spec(),
  });
  const src = appendSource({
    ledgerPath: layout.sourceLedgerPath,
    kind: "web",
    title: "Unreferenced source",
    authors: [],
    summary:
      "A source entry that no claim happens to cite — the ledger should report it for cleanup.",
  });
  const r = computeCompleteness(layout);
  assert.deepEqual(r.orphanedSourceIds, [src.sourceId]);
});

test("newPacketRunId distinct calls produce distinct IDs", () => {
  const t = new Date("2026-04-26T21:00:00Z");
  assert.notEqual(newPacketRunId(t), newPacketRunId(t));
});
