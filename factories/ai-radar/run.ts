// factories/ai-radar/run.ts
//
// Entry point. One-shot: read sources, fetch each (one attempt, no
// auto-retry — see AGENTS.md hard rule #1), normalize, dedupe against
// state/seen-items.json, render digest, write artifacts, write run
// summary. No mutations outside `factories/ai-radar/`.
//
// Modes (from factory.json activation):
//   observe   read sources.json only; no fetch, no writes besides state/latest-run.
//   shadow    fetch + normalize; write to evidence/, NOT artifacts/.
//   active    fetch + normalize; write digest+items to artifacts/, update state.
//   disabled  short-circuit. Kill switch wins over everything (rule I1).
//
// CLI:
//   node --import tsx factories/ai-radar/run.ts            # active
//   node --import tsx factories/ai-radar/run.ts --mode observe
//   node --import tsx factories/ai-radar/run.ts --mode shadow

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { renderDigest } from "./digest.ts";
import { httpGet, type Fetcher } from "./fetch.ts";
import { normalize } from "./normalize.ts";
import type { RadarItem, RunSummary, Source, SourceRegistry } from "./types.ts";

const HERE = fileURLToPath(import.meta.url);
const FACTORY_ROOT_DEFAULT = dirname(HERE);

export type Mode = "observe" | "shadow" | "active" | "disabled";

export interface RunOptions {
  factoryRoot?: string;
  fetcher?: Fetcher;
  clock?: () => Date;
  modeOverride?: "observe" | "shadow" | "active";
}

interface FactoryConfig {
  factoryId: string;
  version: string;
  activation: {
    defaultMode: "observe" | "shadow" | "active";
    staleAfterHours: number;
    modeFile: string;
    latestRunFile: string;
  };
  collection: {
    sourceRegistry: string;
    fetchTimeoutMs: number;
    maxBytesPerSource: number;
    userAgent: string;
  };
  policy: {
    killSwitchFile: string;
  };
}

export async function runRadar(opts: RunOptions = {}): Promise<RunSummary> {
  const factoryRoot = opts.factoryRoot ?? FACTORY_ROOT_DEFAULT;
  const clock = opts.clock ?? (() => new Date());
  const fetcher = opts.fetcher ?? httpGet;

  const factory: FactoryConfig = JSON.parse(
    readFileSync(resolve(factoryRoot, "factory.json"), "utf8"),
  );
  const registry: SourceRegistry = JSON.parse(
    readFileSync(resolve(factoryRoot, "sources.json"), "utf8"),
  );

  const startedAtDate = clock();
  const startedAt = startedAtDate.toISOString();
  const runId = `radar-${startedAt.replace(/[:.]/g, "-")}`;

  // Resolve mode. Kill switch wins (AGENTS.md rule 7).
  const killSwitchPath = resolve(factoryRoot, "state", "disabled");
  const killSwitchActive = existsSync(killSwitchPath);
  const requestedMode: Mode = killSwitchActive
    ? "disabled"
    : (opts.modeOverride ??
      readModeFile(factoryRoot) ??
      factory.activation.defaultMode);

  // Empty per-source result list to start; populated by mode-specific paths.
  const perSource: RunSummary["perSource"] = [];
  let items: RadarItem[] = [];

  if (requestedMode === "disabled") {
    const summary = finalize({
      factoryRoot,
      runId,
      startedAt,
      finishedAt: clock().toISOString(),
      mode: "disabled",
      killSwitchActive,
      perSource: [],
      items: [],
      registryDate: dateOnly(startedAtDate),
      writeArtifacts: false,
    });
    persistLatestRun(factoryRoot, summary);
    return summary;
  }

  if (requestedMode === "observe") {
    // Validate: registry parses, every source has required fields. We
    // don't fetch.
    for (const source of registry.sources) {
      perSource.push({
        id: source.id,
        classification: "ok",
        fetchedBytes: 0,
        httpStatus: null,
        error: null,
        newItems: 0,
        seenItems: 0,
      });
    }
    const summary = finalize({
      factoryRoot,
      runId,
      startedAt,
      finishedAt: clock().toISOString(),
      mode: "observe",
      killSwitchActive: false,
      perSource,
      items: [],
      registryDate: dateOnly(startedAtDate),
      writeArtifacts: false,
    });
    persistLatestRun(factoryRoot, summary);
    return summary;
  }

  // shadow + active: fetch each source.
  const seen = readSeenItems(factoryRoot);

  for (const source of registry.sources) {
    const result = await fetchSource(source, fetcher, factory);
    if (result.status === 0 && result.error === "timeout") {
      perSource.push({
        id: source.id,
        classification: "ambiguous",
        fetchedBytes: 0,
        httpStatus: null,
        error: result.error,
        newItems: 0,
        seenItems: 0,
      });
      continue;
    }
    if (result.status === 0 || result.error !== null) {
      perSource.push({
        id: source.id,
        classification: "failed",
        fetchedBytes: result.bytes,
        httpStatus: result.status === 0 ? null : result.status,
        error: result.error ?? "unknown error",
        newItems: 0,
        seenItems: 0,
      });
      continue;
    }
    if (result.status >= 400) {
      perSource.push({
        id: source.id,
        classification: "failed",
        fetchedBytes: result.bytes,
        httpStatus: result.status,
        error: `http ${result.status}`,
        newItems: 0,
        seenItems: 0,
      });
      continue;
    }

    const norm = normalize({
      source,
      fetchedAt: startedAt,
      body: result.body,
    });

    let newCount = 0;
    let seenCount = 0;
    for (const item of norm.items) {
      if (seen.has(item.id)) {
        seenCount += 1;
        continue;
      }
      newCount += 1;
      items.push(item);
      seen.add(item.id);
    }

    perSource.push({
      id: source.id,
      classification: newCount > 0 ? "ok" : "stale",
      fetchedBytes: result.bytes,
      httpStatus: result.status,
      error: norm.warnings.length > 0 ? norm.warnings.join("; ") : null,
      newItems: newCount,
      seenItems: seenCount,
    });
  }

  const summary = finalize({
    factoryRoot,
    runId,
    startedAt,
    finishedAt: clock().toISOString(),
    mode: requestedMode,
    killSwitchActive: false,
    perSource,
    items,
    registryDate: dateOnly(startedAtDate),
    writeArtifacts: requestedMode === "active",
  });

  if (requestedMode === "active") {
    writeSeenItems(factoryRoot, seen);
  }
  persistLatestRun(factoryRoot, summary);
  return summary;
}

interface FinalizeArgs {
  factoryRoot: string;
  runId: string;
  startedAt: string;
  finishedAt: string;
  mode: Mode;
  killSwitchActive: boolean;
  perSource: RunSummary["perSource"];
  items: RadarItem[];
  registryDate: string;
  writeArtifacts: boolean;
}

function finalize(args: FinalizeArgs): RunSummary {
  const final = computeFinalClassification(
    args.perSource,
    args.killSwitchActive,
  );

  let digestPath: string | null = null;
  let itemsPath: string | null = null;

  if (args.writeArtifacts) {
    const artifactsDir = resolve(args.factoryRoot, "artifacts");
    mkdirSync(artifactsDir, { recursive: true });

    const itemsFile = resolve(
      artifactsDir,
      `radar-items-${args.registryDate}.json`,
    );
    writeFileSync(
      itemsFile,
      JSON.stringify(
        {
          schema: "frontier_os.radar.items_file.v1",
          runId: args.runId,
          generatedAt: args.finishedAt,
          items: args.items,
        },
        null,
        2,
      ),
    );
    itemsPath = itemsFile;

    const digestFile = resolve(
      artifactsDir,
      `radar-digest-${args.registryDate}.md`,
    );
    const summaryForDigest: RunSummary = {
      schema: "frontier_os.radar.run_summary.v1",
      runId: args.runId,
      startedAt: args.startedAt,
      finishedAt: args.finishedAt,
      mode: args.mode,
      killSwitchActive: args.killSwitchActive,
      perSource: args.perSource,
      finalClassification: final,
      digestPath: null,
      itemsPath,
    };
    writeFileSync(
      digestFile,
      renderDigest({
        date: args.registryDate,
        items: args.items,
        summary: summaryForDigest,
      }),
    );
    digestPath = digestFile;
  }

  if (args.mode === "shadow") {
    const evidenceDir = resolve(args.factoryRoot, "evidence");
    mkdirSync(evidenceDir, { recursive: true });
    const evidenceFile = resolve(evidenceDir, `${args.runId}.json`);
    writeFileSync(
      evidenceFile,
      JSON.stringify(
        {
          schema: "frontier_os.radar.shadow_evidence.v1",
          runId: args.runId,
          startedAt: args.startedAt,
          finishedAt: args.finishedAt,
          perSource: args.perSource,
          itemCount: args.items.length,
        },
        null,
        2,
      ),
    );
  }

  return {
    schema: "frontier_os.radar.run_summary.v1",
    runId: args.runId,
    startedAt: args.startedAt,
    finishedAt: args.finishedAt,
    mode: args.mode,
    killSwitchActive: args.killSwitchActive,
    perSource: args.perSource,
    finalClassification: final,
    digestPath,
    itemsPath,
  };
}

function computeFinalClassification(
  perSource: RunSummary["perSource"],
  killSwitchActive: boolean,
): RunSummary["finalClassification"] {
  if (killSwitchActive) return "ambiguous";
  if (perSource.some((s) => s.classification === "failed")) return "failed";
  if (perSource.some((s) => s.classification === "ambiguous"))
    return "ambiguous";
  return "passed";
}

async function fetchSource(
  source: Source,
  fetcher: Fetcher,
  factory: FactoryConfig,
): Promise<Awaited<ReturnType<Fetcher>>> {
  return fetcher(source.url, {
    timeoutMs: factory.collection.fetchTimeoutMs,
    maxBytes: factory.collection.maxBytesPerSource,
    userAgent: factory.collection.userAgent,
    headers: source.fetch.githubApi
      ? { accept: "application/vnd.github+json" }
      : {},
  });
}

function readSeenItems(factoryRoot: string): Set<string> {
  const file = resolve(factoryRoot, "state", "seen-items.json");
  if (!existsSync(file)) return new Set();
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8")) as {
      ids?: string[];
    };
    return new Set(parsed.ids ?? []);
  } catch {
    return new Set();
  }
}

function writeSeenItems(factoryRoot: string, ids: Set<string>): void {
  const stateDir = resolve(factoryRoot, "state");
  mkdirSync(stateDir, { recursive: true });
  const file = resolve(stateDir, "seen-items.json");
  writeFileSync(
    file,
    JSON.stringify(
      {
        schema: "frontier_os.radar.seen_items.v1",
        ids: [...ids].sort(),
      },
      null,
      2,
    ),
  );
}

function readModeFile(
  factoryRoot: string,
): "observe" | "shadow" | "active" | null {
  const file = resolve(factoryRoot, "state", "mode.json");
  if (!existsSync(file)) return null;
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8")) as { mode?: string };
    if (
      parsed.mode === "observe" ||
      parsed.mode === "shadow" ||
      parsed.mode === "active"
    ) {
      return parsed.mode;
    }
    return null;
  } catch {
    return null;
  }
}

function persistLatestRun(factoryRoot: string, summary: RunSummary): void {
  const stateDir = resolve(factoryRoot, "state");
  mkdirSync(stateDir, { recursive: true });
  writeFileSync(
    resolve(stateDir, "latest-run.json"),
    JSON.stringify(summary, null, 2),
  );
}

function dateOnly(d: Date): string {
  return d.toISOString().slice(0, 10);
}

// --- CLI entry ----------------------------------------------------

function parseCliArgs(argv: string[]): {
  modeOverride?: "observe" | "shadow" | "active";
} {
  const out: { modeOverride?: "observe" | "shadow" | "active" } = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--mode") {
      const next = argv[i + 1];
      if (next === "observe" || next === "shadow" || next === "active") {
        out.modeOverride = next;
        i++;
      }
    }
  }
  return out;
}

const isCliMain =
  process.argv[1] !== undefined &&
  fileURLToPath(import.meta.url) === resolve(process.argv[1]);

if (isCliMain) {
  const cli = parseCliArgs(process.argv.slice(2));
  runRadar(cli)
    .then((summary) => {
      console.log(JSON.stringify(summary, null, 2));
      process.exit(summary.finalClassification === "failed" ? 1 : 0);
    })
    .catch((err: Error) => {
      console.error(`radar run failed: ${err.message}`);
      process.exit(2);
    });
}
