// factories/ai-radar/tests/digest.test.ts
//
// Markdown digest format tests. No filesystem (the writer returns a
// string; the caller writes to disk).
//
// Run:
//   node --import tsx --test factories/ai-radar/tests/digest.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";

import { renderDigest } from "../digest.ts";
import type { RadarItem, RunSummary } from "../types.ts";

function mkItem(over: Partial<RadarItem>): RadarItem {
  return {
    schema: "frontier_os.radar.radar_item.v1",
    id: over.id ?? "radar_0000000000000000",
    source: over.source ?? {
      kind: "github_release",
      id: "anthropic-claude-code-releases",
      name: "anthropics/claude-code GitHub Releases",
      url: "https://github.com/anthropics/claude-code/releases",
      trustTier: "official",
    },
    observedAt: over.observedAt ?? "2026-04-26T20:00:00.000Z",
    publishedAt: over.publishedAt ?? "2026-04-25T12:00:00Z",
    title: over.title ?? "v1.0.42",
    summary: over.summary ?? "Added support for Sonnet 4.6.",
    claims: over.claims ?? [],
    classification: over.classification ?? {
      topic: "coding_agent",
      novelty: 0,
      impact: 0,
      urgency: 0,
      confidence: 0,
    },
    recommendedAction: over.recommendedAction ?? "remember",
    linkedArtifacts: over.linkedArtifacts ?? {},
  };
}

function mkSummary(over: Partial<RunSummary> = {}): RunSummary {
  return {
    schema: "frontier_os.radar.run_summary.v1",
    runId: over.runId ?? "test-run",
    startedAt: over.startedAt ?? "2026-04-26T20:00:00.000Z",
    finishedAt: over.finishedAt ?? "2026-04-26T20:00:01.000Z",
    mode: over.mode ?? "active",
    killSwitchActive: over.killSwitchActive ?? false,
    perSource: over.perSource ?? [
      {
        id: "anthropic-claude-code-releases",
        classification: "ok",
        fetchedBytes: 12345,
        httpStatus: 200,
        error: null,
        newItems: 1,
        seenItems: 0,
      },
    ],
    finalClassification: over.finalClassification ?? "passed",
    digestPath: over.digestPath ?? null,
    itemsPath: over.itemsPath ?? null,
  };
}

test("digest header includes the date and item count", () => {
  const md = renderDigest({
    date: "2026-04-26",
    items: [mkItem({})],
    summary: mkSummary(),
  });
  assert.match(md, /^# AI Radar Digest — 2026-04-26/m);
  assert.match(md, /1 item/);
});

test("digest groups items under the recommendedAction section", () => {
  const md = renderDigest({
    date: "2026-04-26",
    items: [mkItem({ recommendedAction: "remember" })],
    summary: mkSummary(),
  });
  assert.match(md, /## Memory-only items/);
  // PR #8 emits only "remember"; other sections render empty placeholders.
  assert.match(md, /## Upgrade candidates/);
  assert.match(md, /## Research candidates/);
});

test("digest groups by source name within a section", () => {
  const md = renderDigest({
    date: "2026-04-26",
    items: [
      mkItem({
        id: "radar_aaaaaaaaaaaaaaaa",
        title: "v1.0.42",
        source: {
          kind: "github_release",
          id: "anthropic-claude-code-releases",
          name: "anthropics/claude-code GitHub Releases",
          url: "https://github.com/anthropics/claude-code/releases/tag/v1.0.42",
          trustTier: "official",
        },
      }),
      mkItem({
        id: "radar_bbbbbbbbbbbbbbbb",
        title: "Some New Agent Memory Method (arXiv:2604.12345)",
        source: {
          kind: "paper",
          id: "arxiv-cs-ai-rss",
          name: "arXiv cs.AI RSS",
          url: "http://arxiv.org/abs/2604.12345",
          trustTier: "community",
        },
        publishedAt: "2026-04-25T00:00:00+00:00",
      }),
    ],
    summary: mkSummary(),
  });

  assert.match(md, /### anthropics\/claude-code GitHub Releases/);
  assert.match(md, /### arXiv cs.AI RSS/);
  // Source group header includes the trust tier.
  assert.match(md, /\(official\)/);
  assert.match(md, /\(community\)/);
});

test("digest item line includes title, link, and published date when present", () => {
  const md = renderDigest({
    date: "2026-04-26",
    items: [
      mkItem({
        id: "radar_aaaaaaaaaaaaaaaa",
        title: "v1.0.42",
        source: {
          kind: "github_release",
          id: "anthropic-claude-code-releases",
          name: "anthropics/claude-code GitHub Releases",
          url: "https://github.com/anthropics/claude-code/releases/tag/v1.0.42",
          trustTier: "official",
        },
        publishedAt: "2026-04-25T12:00:00Z",
      }),
    ],
    summary: mkSummary(),
  });
  assert.match(
    md,
    /\[v1\.0\.42\]\(https:\/\/github\.com\/anthropics\/claude-code\/releases\/tag\/v1\.0\.42\)/,
  );
  assert.match(md, /2026-04-25/);
});

test("digest run summary table lists each source with status", () => {
  const md = renderDigest({
    date: "2026-04-26",
    items: [],
    summary: mkSummary({
      perSource: [
        {
          id: "openai-api-changelog",
          classification: "ok",
          fetchedBytes: 1234,
          httpStatus: 200,
          error: null,
          newItems: 1,
          seenItems: 0,
        },
        {
          id: "gemini-api-release-notes",
          classification: "failed",
          fetchedBytes: 0,
          httpStatus: 503,
          error: "service unavailable",
          newItems: 0,
          seenItems: 0,
        },
      ],
      finalClassification: "failed",
    }),
  });
  assert.match(md, /## Run summary/);
  assert.match(md, /\| openai-api-changelog \| ok \|/);
  assert.match(md, /\| gemini-api-release-notes \| failed \|/);
  assert.match(md, /\*\*Final\*\*: failed/);
});

test("digest with zero items still renders a valid empty digest", () => {
  const md = renderDigest({
    date: "2026-04-26",
    items: [],
    summary: mkSummary({ perSource: [] }),
  });
  assert.match(md, /^# AI Radar Digest — 2026-04-26/m);
  assert.match(md, /0 items/);
  assert.match(md, /## Run summary/);
});

test("digest escapes pipe characters in titles for the run-summary table id column", () => {
  // The table source-id cell is the registry id, which should never contain
  // pipes — but be defensive against newlines breaking the table.
  const md = renderDigest({
    date: "2026-04-26",
    items: [],
    summary: mkSummary({
      perSource: [
        {
          id: "weird|id-with-pipe",
          classification: "ok",
          fetchedBytes: 0,
          httpStatus: 200,
          error: null,
          newItems: 0,
          seenItems: 0,
        },
      ],
    }),
  });
  // pipe is escaped as `\|` in the table cell.
  assert.match(md, /weird\\\|id-with-pipe/);
});
