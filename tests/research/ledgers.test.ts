// research/ — claim ledger + source ledger contract tests.
//
// These tests pin the artifact format. Upstream tool integration
// (STORM, GPT Researcher, PaperQA2) lands later; the format
// must be stable first so later tools write to a known shape.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

import {
  appendClaim,
  currentView,
  newClaimId,
  readClaims,
} from "../../research/claim-ledger.ts";
import {
  appendSource,
  findSource,
  newSourceId,
  readSources,
} from "../../research/source-ledger.ts";

function tmp(): string {
  return mkdtempSync(resolve(tmpdir(), "frontier-research-"));
}

function fixedClock(iso: string): () => Date {
  return () => new Date(iso);
}

// --- claim ledger -------------------------------------------------------

test("appendClaim writes one NDJSON line and round-trips", () => {
  const dir = tmp();
  const path = resolve(dir, "claims.ndjson");
  const rec = appendClaim({
    ledgerPath: path,
    text: "PaperQA2 supports citation-graph traversal.",
    status: "supported",
    confidence: "medium",
    support: [
      {
        sourceId: "src_test_001",
        quoteOrSummary:
          "PaperQA2 exposes citation graph operations as first-class tools.",
        stance: "supports",
        confidence: "medium",
      },
    ],
    usedFor: ["research-factory.tool-selection"],
    tags: ["paperqa2"],
    clock: fixedClock("2026-04-26T21:00:00Z"),
  });
  assert.equal(rec.schema, "frontier_os.research.claim_record.v1");
  assert.match(rec.claimId, /^claim_\d{8}T\d{6}Z_/);
  assert.equal(rec.status, "supported");
  const round = readClaims(path);
  assert.equal(round.length, 1);
  assert.deepEqual(round[0], rec);
});

test("claim text must be non-trivial", () => {
  const dir = tmp();
  assert.throws(
    () =>
      appendClaim({
        ledgerPath: resolve(dir, "c.ndjson"),
        text: "x",
        status: "supported",
        confidence: "low",
        support: [
          {
            sourceId: "src_x",
            quoteOrSummary: "n/a",
            stance: "supports",
            confidence: "low",
          },
        ],
      }),
    /text too short/,
  );
});

test("claim must carry at least one source", () => {
  const dir = tmp();
  assert.throws(
    () =>
      appendClaim({
        ledgerPath: resolve(dir, "c.ndjson"),
        text: "Sourceless claim should be rejected.",
        status: "supported",
        confidence: "low",
        support: [],
      }),
    /at least one ClaimSupport/,
  );
});

test("claim quoteOrSummary cap is 35 words", () => {
  const dir = tmp();
  const longQuote = Array(40).fill("word").join(" ");
  assert.throws(
    () =>
      appendClaim({
        ledgerPath: resolve(dir, "c.ndjson"),
        text: "A claim with an oversized supporting quote.",
        status: "supported",
        confidence: "low",
        support: [
          {
            sourceId: "src_x",
            quoteOrSummary: longQuote,
            stance: "supports",
            confidence: "low",
          },
        ],
      }),
    /too long/,
  );
});

test("appending multiple claims yields multiple lines, append-only", () => {
  const dir = tmp();
  const path = resolve(dir, "c.ndjson");
  appendClaim({
    ledgerPath: path,
    text: "Claim A — first record.",
    status: "supported",
    confidence: "low",
    support: [
      {
        sourceId: "s1",
        quoteOrSummary: "ok",
        stance: "supports",
        confidence: "low",
      },
    ],
  });
  appendClaim({
    ledgerPath: path,
    text: "Claim B — second record.",
    status: "uncertain",
    confidence: "low",
    support: [
      {
        sourceId: "s2",
        quoteOrSummary: "ok",
        stance: "supports",
        confidence: "low",
      },
    ],
  });
  const text = readFileSync(path, "utf8");
  const lines = text.split("\n").filter((l) => l.trim());
  assert.equal(lines.length, 2);
  assert.equal(readClaims(path).length, 2);
});

test("supersedes chains compute correctly via currentView", () => {
  const dir = tmp();
  const path = resolve(dir, "c.ndjson");
  const c1 = appendClaim({
    ledgerPath: path,
    text: "Initial assertion v1.",
    status: "uncertain",
    confidence: "low",
    support: [
      {
        sourceId: "s1",
        quoteOrSummary: "ok",
        stance: "supports",
        confidence: "low",
      },
    ],
  });
  const c2 = appendClaim({
    ledgerPath: path,
    text: "Refined assertion v2 with stronger evidence.",
    status: "supported",
    confidence: "high",
    support: [
      {
        sourceId: "s1",
        quoteOrSummary: "ok",
        stance: "supports",
        confidence: "high",
      },
    ],
    supersedes: c1.claimId,
  });
  const all = readClaims(path);
  assert.equal(all.length, 2, "old record kept (append-only)");
  const view = currentView(all);
  assert.equal(view.length, 1);
  assert.equal(view[0]?.claimId, c2.claimId);
});

test("malformed line is reported with the file path", () => {
  const dir = tmp();
  const path = resolve(dir, "c.ndjson");
  writeFileSync(path, '{"valid":1}\n{not json}\n', "utf8");
  assert.throws(() => readClaims(path), /malformed line/);
});

test("newClaimId is monotonic-ish given a fixed clock", () => {
  const t = new Date("2026-04-26T21:00:00.000Z");
  const a = newClaimId(t);
  const b = newClaimId(t);
  // Same timestamp prefix; random suffix differs.
  assert.equal(a.split("_")[1], b.split("_")[1]);
  assert.notEqual(a, b);
});

// --- source ledger ------------------------------------------------------

test("appendSource writes + readSources round-trips", () => {
  const dir = tmp();
  const path = resolve(dir, "sources.ndjson");
  const rec = appendSource({
    ledgerPath: path,
    kind: "paper",
    title: "PaperQA2: Scientific Literature Agent",
    authors: ["FutureHouse"],
    summary:
      "PaperQA2 is a research agent for retrieving and summarizing scientific papers with citation-graph tools.",
    url: "https://example.com/paperqa2",
    tags: ["rag", "papers"],
    clock: fixedClock("2026-04-26T20:55:00Z"),
  });
  assert.equal(rec.schema, "frontier_os.research.source_record.v1");
  assert.match(rec.sourceId, /^src_\d{8}T\d{6}Z_/);
  const round = readSources(path);
  assert.equal(round.length, 1);
  assert.deepEqual(round[0], rec);
});

test("source title must be at least 4 chars", () => {
  const dir = tmp();
  assert.throws(
    () =>
      appendSource({
        ledgerPath: resolve(dir, "s.ndjson"),
        kind: "web",
        title: "x",
        authors: [],
        summary: "A short but valid summary of at least five words.",
      }),
    /title must be non-trivial/,
  );
});

test("source summary too short is rejected", () => {
  const dir = tmp();
  assert.throws(
    () =>
      appendSource({
        ledgerPath: resolve(dir, "s.ndjson"),
        kind: "web",
        title: "A reasonable title",
        authors: [],
        summary: "two words",
      }),
    /too short/,
  );
});

test("source summary too long (>80 words) is rejected", () => {
  const dir = tmp();
  const long = Array(90).fill("word").join(" ");
  assert.throws(
    () =>
      appendSource({
        ledgerPath: resolve(dir, "s.ndjson"),
        kind: "web",
        title: "A reasonable title",
        authors: [],
        summary: long,
      }),
    /too long/,
  );
});

test("findSource returns matching record by id", () => {
  const dir = tmp();
  const path = resolve(dir, "s.ndjson");
  const rec = appendSource({
    ledgerPath: path,
    kind: "repo",
    title: "Research Factory POC",
    authors: ["frontier-os"],
    summary:
      "Internal repo containing the research factory artifact format used by frontier-os.",
  });
  const sources = readSources(path);
  assert.deepEqual(findSource(sources, rec.sourceId), rec);
  assert.equal(findSource(sources, "src_does_not_exist"), null);
});

test("newSourceId distinct calls produce distinct IDs", () => {
  const t = new Date("2026-04-26T21:00:00Z");
  const a = newSourceId(t);
  const b = newSourceId(t);
  assert.notEqual(a, b);
});
