// factories/ai-radar/tests/run.test.ts
//
// End-to-end tests for run.ts. The fetcher is injected so no test hits
// the network. A live smoke test against the real registry is gated by
// FACTORY_LIVE=1 and is opt-in.
//
// Run unit:
//   node --import tsx --test factories/ai-radar/tests/run.test.ts
// Run including live smoke:
//   FACTORY_LIVE=1 node --import tsx --test factories/ai-radar/tests/run.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { runRadar } from "../run.ts";
import type { Fetcher, FetchResult } from "../fetch.ts";

const HERE = fileURLToPath(import.meta.url);
const FIXTURES = resolve(dirname(HERE), "fixtures");
const FACTORY_REAL = resolve(dirname(HERE), "..");

const LIVE = process.env.FACTORY_LIVE === "1";

// --- helpers ------------------------------------------------------

function setupFactoryRoot(): string {
  const dir = mkdtempSync(join(tmpdir(), "ai-radar-test-"));
  // Copy real factory.json so we exercise the same defaults as
  // production, then overwrite sources.json with a minimal test
  // registry.
  cpSync(resolve(FACTORY_REAL, "factory.json"), resolve(dir, "factory.json"));
  return dir;
}

function writeRegistry(factoryRoot: string, sources: unknown[]): void {
  writeFileSync(
    resolve(factoryRoot, "sources.json"),
    JSON.stringify(
      { schema: "frontier_os.radar.source_registry.v1", sources },
      null,
      2,
    ),
  );
}

function fixtureBody(name: string): string {
  return readFileSync(resolve(FIXTURES, name), "utf8");
}

function makeFetcher(responses: Record<string, FetchResult>): Fetcher {
  return async (url) => {
    const r = responses[url];
    if (!r) {
      return {
        status: 0,
        body: "",
        bytes: 0,
        error: `unmocked url: ${url}`,
        truncated: false,
      };
    }
    return r;
  };
}

function ok(body: string): FetchResult {
  return {
    status: 200,
    body,
    bytes: Buffer.byteLength(body, "utf8"),
    error: null,
    truncated: false,
  };
}

const FIXED_NOW = new Date("2026-04-26T20:00:00.000Z");
const fixedClock = () => FIXED_NOW;

const claudeChangelogSource = {
  id: "claude-code-changelog",
  kind: "github_raw_changelog",
  trustTier: "official",
  name: "Anthropic Claude Code CHANGELOG.md",
  url: "https://example.test/claude-code/CHANGELOG.md",
  fetch: { type: "http_get", format: "markdown" },
  cadence: "daily",
  topicHints: ["coding_agent"],
};

const githubReleasesSource = {
  id: "anthropic-claude-code-releases",
  kind: "github_release",
  trustTier: "official",
  name: "anthropics/claude-code GitHub Releases",
  url: "https://example.test/api/repos/anthropics/claude-code/releases",
  fetch: { type: "http_get", format: "json", githubApi: true },
  cadence: "daily",
  topicHints: ["coding_agent"],
};

const arxivSource = {
  id: "arxiv-cs-ai-rss",
  kind: "paper",
  trustTier: "community",
  name: "arXiv cs.AI RSS",
  url: "https://example.test/arxiv/cs.AI",
  fetch: { type: "http_get", format: "rss" },
  cadence: "daily",
  topicHints: ["research"],
};

// --- tests --------------------------------------------------------

test("active mode: fetches all sources, normalizes, writes digest+items", async () => {
  const root = setupFactoryRoot();
  try {
    writeRegistry(root, [
      claudeChangelogSource,
      githubReleasesSource,
      arxivSource,
    ]);

    const fetcher = makeFetcher({
      [claudeChangelogSource.url]: ok(fixtureBody("claude-code-changelog.md")),
      [githubReleasesSource.url]: ok(fixtureBody("github-releases.json")),
      [arxivSource.url]: ok(fixtureBody("arxiv-cs-ai.rss")),
    });

    const summary = await runRadar({
      factoryRoot: root,
      fetcher,
      clock: fixedClock,
      modeOverride: "active",
    });

    assert.equal(summary.mode, "active");
    assert.equal(summary.finalClassification, "passed");
    assert.equal(summary.killSwitchActive, false);
    assert.equal(summary.perSource.length, 3);
    for (const s of summary.perSource) {
      assert.equal(s.classification, "ok", `source ${s.id} not ok`);
    }

    assert.ok(summary.digestPath, "digest path should be set");
    assert.ok(summary.itemsPath, "items path should be set");
    assert.ok(existsSync(summary.digestPath!), "digest file written");
    assert.ok(existsSync(summary.itemsPath!), "items file written");

    const digest = readFileSync(summary.digestPath!, "utf8");
    assert.match(digest, /# AI Radar Digest — 2026-04-26/);
    assert.match(digest, /## Memory-only items/);
    assert.match(digest, /Anthropic Claude Code CHANGELOG\.md/);

    const itemsFile = JSON.parse(readFileSync(summary.itemsPath!, "utf8"));
    assert.equal(itemsFile.schema, "frontier_os.radar.items_file.v1");
    // 3 markdown sections + 3 github releases + 2 arxiv items = 8
    assert.equal(itemsFile.items.length, 8);

    const seenPath = resolve(root, "state", "seen-items.json");
    assert.ok(existsSync(seenPath), "seen-items.json written in active mode");
    const seen = JSON.parse(readFileSync(seenPath, "utf8"));
    assert.equal(seen.ids.length, 8);

    const latestPath = resolve(root, "state", "latest-run.json");
    assert.ok(existsSync(latestPath), "latest-run.json written");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("active mode: dedupe across runs — second run reports seenItems and emits no new items", async () => {
  const root = setupFactoryRoot();
  try {
    writeRegistry(root, [claudeChangelogSource]);
    const fetcher = makeFetcher({
      [claudeChangelogSource.url]: ok(fixtureBody("claude-code-changelog.md")),
    });

    const first = await runRadar({
      factoryRoot: root,
      fetcher,
      clock: fixedClock,
      modeOverride: "active",
    });
    assert.equal(first.perSource[0]!.newItems, 3);
    assert.equal(first.perSource[0]!.seenItems, 0);
    assert.equal(first.perSource[0]!.classification, "ok");

    const second = await runRadar({
      factoryRoot: root,
      fetcher,
      clock: fixedClock,
      modeOverride: "active",
    });
    assert.equal(second.perSource[0]!.newItems, 0);
    assert.equal(second.perSource[0]!.seenItems, 3);
    assert.equal(
      second.perSource[0]!.classification,
      "stale",
      "all-seen run is `stale`, not `failed`",
    );
    assert.equal(second.finalClassification, "passed");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("kill switch wins: no fetches, finalClassification ambiguous", async () => {
  const root = setupFactoryRoot();
  try {
    writeRegistry(root, [claudeChangelogSource]);
    mkdirSync(resolve(root, "state"), { recursive: true });
    writeFileSync(resolve(root, "state", "disabled"), "killed for test\n");

    let calls = 0;
    const fetcher: Fetcher = async () => {
      calls += 1;
      return ok("");
    };

    const summary = await runRadar({
      factoryRoot: root,
      fetcher,
      clock: fixedClock,
      modeOverride: "active", // explicitly requested, but kill wins
    });
    assert.equal(calls, 0, "fetcher must NOT be called when kill switch is on");
    assert.equal(summary.mode, "disabled");
    assert.equal(summary.killSwitchActive, true);
    assert.equal(summary.finalClassification, "ambiguous");
    assert.equal(summary.digestPath, null);
    assert.equal(summary.itemsPath, null);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("observe mode: no fetches, no artifacts, registry validation only", async () => {
  const root = setupFactoryRoot();
  try {
    writeRegistry(root, [claudeChangelogSource, arxivSource]);

    let calls = 0;
    const fetcher: Fetcher = async () => {
      calls += 1;
      return ok("");
    };

    const summary = await runRadar({
      factoryRoot: root,
      fetcher,
      clock: fixedClock,
      modeOverride: "observe",
    });
    assert.equal(calls, 0);
    assert.equal(summary.mode, "observe");
    assert.equal(summary.finalClassification, "passed");
    assert.equal(summary.perSource.length, 2);
    assert.equal(summary.digestPath, null);
    assert.equal(summary.itemsPath, null);
    // No artifacts dir should have been touched.
    assert.equal(
      existsSync(resolve(root, "artifacts")),
      false,
      "observe mode must not create artifacts dir",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("shadow mode: writes evidence but not artifacts", async () => {
  const root = setupFactoryRoot();
  try {
    writeRegistry(root, [claudeChangelogSource]);
    const fetcher = makeFetcher({
      [claudeChangelogSource.url]: ok(fixtureBody("claude-code-changelog.md")),
    });

    const summary = await runRadar({
      factoryRoot: root,
      fetcher,
      clock: fixedClock,
      modeOverride: "shadow",
    });
    assert.equal(summary.mode, "shadow");
    assert.equal(summary.finalClassification, "passed");
    assert.equal(summary.digestPath, null);
    assert.equal(summary.itemsPath, null);
    assert.equal(
      existsSync(resolve(root, "artifacts")),
      false,
      "shadow must NOT write artifacts/",
    );
    const evDir = resolve(root, "evidence");
    assert.ok(existsSync(evDir), "shadow MUST write evidence/");
    const files = readdirSync(evDir);
    assert.ok(
      files.some((f) => f.startsWith("radar-") && f.endsWith(".json")),
      `expected an evidence file in ${files}`,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("source HTTP 503 → classification failed; final failed", async () => {
  const root = setupFactoryRoot();
  try {
    writeRegistry(root, [claudeChangelogSource]);
    const fetcher: Fetcher = async () => ({
      status: 503,
      body: "",
      bytes: 0,
      error: null,
      truncated: false,
    });
    const summary = await runRadar({
      factoryRoot: root,
      fetcher,
      clock: fixedClock,
      modeOverride: "active",
    });
    assert.equal(summary.perSource[0]!.classification, "failed");
    assert.equal(summary.finalClassification, "failed");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("source timeout → classification ambiguous; final ambiguous", async () => {
  const root = setupFactoryRoot();
  try {
    writeRegistry(root, [claudeChangelogSource]);
    const fetcher: Fetcher = async () => ({
      status: 0,
      body: "",
      bytes: 0,
      error: "timeout",
      truncated: false,
    });
    const summary = await runRadar({
      factoryRoot: root,
      fetcher,
      clock: fixedClock,
      modeOverride: "active",
    });
    assert.equal(summary.perSource[0]!.classification, "ambiguous");
    assert.equal(summary.finalClassification, "ambiguous");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// --- live smoke (opt-in) -----------------------------------------

test(
  "live smoke: hits real registry, observe mode (no writes, no parse)",
  { skip: !LIVE },
  async () => {
    const summary = await runRadar({ modeOverride: "observe" });
    assert.equal(summary.mode, "observe");
    assert.equal(summary.finalClassification, "passed");
    assert.ok(summary.perSource.length > 0);
  },
);
