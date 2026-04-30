// factories/ai-radar/tests/normalize.test.ts
//
// Per-format normalizer tests using fixtures. No network.
//
// Run:
//   node --import tsx --test factories/ai-radar/tests/normalize.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { normalize, radarItemId } from "../normalize.ts";
import type { Source } from "../types.ts";

const HERE = fileURLToPath(import.meta.url);
const FIXTURES = resolve(dirname(HERE), "fixtures");

function loadFixture(name: string): string {
  return readFileSync(resolve(FIXTURES, name), "utf8");
}

const FETCHED_AT = "2026-04-26T20:00:00.000Z";

const markdownSource: Source = {
  id: "claude-code-changelog",
  kind: "github_raw_changelog",
  trustTier: "official",
  name: "Anthropic Claude Code CHANGELOG.md",
  url: "https://raw.githubusercontent.com/anthropics/claude-code/refs/heads/main/CHANGELOG.md",
  fetch: { type: "http_get", format: "markdown" },
  cadence: "daily",
  topicHints: ["coding_agent", "agent_runtime"],
};

const githubReleasesSource: Source = {
  id: "anthropic-claude-code-releases",
  kind: "github_release",
  trustTier: "official",
  name: "anthropics/claude-code GitHub Releases",
  url: "https://api.github.com/repos/anthropics/claude-code/releases",
  fetch: { type: "http_get", format: "json", githubApi: true },
  cadence: "daily",
  topicHints: ["coding_agent"],
};

const arxivSource: Source = {
  id: "arxiv-cs-ai-rss",
  kind: "paper",
  trustTier: "community",
  name: "arXiv cs.AI RSS",
  url: "http://export.arxiv.org/rss/cs.AI",
  fetch: { type: "http_get", format: "rss" },
  cadence: "daily",
  topicHints: ["research"],
};

const htmlSource: Source = {
  id: "openai-api-changelog",
  kind: "official_changelog",
  trustTier: "official",
  name: "OpenAI API Changelog",
  url: "https://platform.openai.com/docs/changelog",
  fetch: { type: "http_get", format: "html" },
  cadence: "daily",
  topicHints: ["model_release"],
};

// --- radarItemId --------------------------------------------------

test("radarItemId is deterministic for the same parts", () => {
  const a = radarItemId(["claude-code-changelog", "v1.0.42"]);
  const b = radarItemId(["claude-code-changelog", "v1.0.42"]);
  assert.equal(a, b);
  assert.match(a, /^radar_[0-9a-f]{16}$/);
});

test("radarItemId differs when parts differ", () => {
  const a = radarItemId(["claude-code-changelog", "v1.0.42"]);
  const b = radarItemId(["claude-code-changelog", "v1.0.41"]);
  assert.notEqual(a, b);
});

// --- markdown changelog -------------------------------------------

test("normalize markdown changelog: emits one item per H2 heading", () => {
  const body = loadFixture("claude-code-changelog.md");
  const r = normalize({ source: markdownSource, fetchedAt: FETCHED_AT, body });
  assert.equal(r.warnings.length, 0, JSON.stringify(r.warnings));
  assert.equal(r.items.length, 3);

  const titles = r.items.map((i) => i.title);
  assert.ok(
    titles.some((t) => t.includes("1.0.42")),
    `expected v1.0.42 title in ${JSON.stringify(titles)}`,
  );

  for (const item of r.items) {
    assert.equal(item.schema, "frontier_os.radar.radar_item.v1");
    assert.equal(item.source.id, "claude-code-changelog");
    assert.equal(item.source.trustTier, "official");
    assert.equal(item.observedAt, FETCHED_AT);
    assert.equal(item.recommendedAction, "remember");
    assert.equal(item.claims.length, 0);
    assert.equal(item.classification.topic, "coding_agent");
    assert.equal(item.classification.novelty, 0);
    assert.equal(item.classification.confidence, 0);
    assert.deepEqual(item.linkedArtifacts, {});
    assert.match(item.id, /^radar_[0-9a-f]{16}$/);
  }
});

test("normalize markdown changelog: same input → identical ids (idempotent)", () => {
  const body = loadFixture("claude-code-changelog.md");
  const r1 = normalize({ source: markdownSource, fetchedAt: FETCHED_AT, body });
  const r2 = normalize({
    source: markdownSource,
    fetchedAt: "2099-01-01T00:00:00Z",
    body,
  });
  assert.deepEqual(
    r1.items.map((i) => i.id),
    r2.items.map((i) => i.id),
    "ids depend on body content, not fetchedAt",
  );
});

// --- github releases ----------------------------------------------

test("normalize github releases: one RadarItem per release", () => {
  const body = loadFixture("github-releases.json");
  const r = normalize({
    source: githubReleasesSource,
    fetchedAt: FETCHED_AT,
    body,
  });
  assert.equal(r.warnings.length, 0);
  assert.equal(r.items.length, 3);

  const v42 = r.items.find((i) => i.title.includes("1.0.42"));
  assert.ok(v42, "expected a v1.0.42 release item");
  assert.equal(v42.publishedAt, "2026-04-25T12:00:00Z");
  assert.equal(
    v42.source.url,
    "https://github.com/anthropics/claude-code/releases/tag/v1.0.42",
  );
  assert.ok(v42.summary.length > 0);
});

test("normalize github releases: empty array → no items, no warnings", () => {
  const r = normalize({
    source: githubReleasesSource,
    fetchedAt: FETCHED_AT,
    body: "[]",
  });
  assert.equal(r.items.length, 0);
  assert.equal(r.warnings.length, 0);
});

test("normalize github releases: malformed JSON → warning, no crash", () => {
  const r = normalize({
    source: githubReleasesSource,
    fetchedAt: FETCHED_AT,
    body: "not-json{",
  });
  assert.equal(r.items.length, 0);
  assert.ok(r.warnings.length >= 1);
  assert.match(r.warnings[0]!, /parse/i);
});

// --- arxiv rss ----------------------------------------------------

test("normalize arxiv rss: one item per <item>", () => {
  const body = loadFixture("arxiv-cs-ai.rss");
  const r = normalize({ source: arxivSource, fetchedAt: FETCHED_AT, body });
  assert.equal(r.warnings.length, 0, JSON.stringify(r.warnings));
  assert.equal(r.items.length, 2);

  const first = r.items[0]!;
  assert.match(first.title, /Agent Memory/);
  assert.equal(first.source.url, "http://arxiv.org/abs/2604.12345");
  assert.ok(first.publishedAt?.startsWith("2026-04-25"));
  assert.equal(first.classification.topic, "research");
  assert.equal(first.source.trustTier, "community");
});

// --- html stub ----------------------------------------------------

test("normalize html: emits a single page-snapshot item with title", () => {
  const body = loadFixture("openai-changelog.html");
  const r = normalize({ source: htmlSource, fetchedAt: FETCHED_AT, body });
  assert.equal(r.items.length, 1);
  const it = r.items[0]!;
  assert.match(it.title, /OpenAI API Changelog/);
  assert.equal(it.source.id, "openai-api-changelog");
  assert.equal(it.classification.topic, "model_release");
  assert.match(
    it.summary,
    /v0 HTML normalizer|page-level/i,
    "summary should declare v0-stub limitation",
  );
});
