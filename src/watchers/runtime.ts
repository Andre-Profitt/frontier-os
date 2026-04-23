// Watcher runtime: manifest loading, kill-switch enforcement, dispatch.
//
// Mirrors the adapter registry but for watchers. Each watcher has:
//   1. A JSON manifest at manifests/watchers/<id>.watcher.json (validated
//      against schemas/watcher-spec.schema.json)
//   2. A TypeScript implementation registered in the factories map below
//   3. A kill-switch file path (from spec.policy.killSwitchFile) that, when
//      present, causes runWatcher to skip with decision "skipped"
//
// runWatcher() is the single entry point: it validates the manifest, checks
// the kill switch, opens a ledger session, calls the watcher's run() method,
// validates every emitted alert against the alert-event schema, and writes
// events back to the ledger.

import { readFileSync, readdirSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

import {
  validateWatcherSpec,
  validateAlertEvent,
  type WatcherSpec,
  type AlertEvent,
} from "../schemas.ts";
import { getLedger } from "../ledger/index.ts";
import { newSessionId } from "../ledger/events.ts";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const REPO_ROOT = resolve(__dirname, "..", "..");
const MANIFEST_DIR = resolve(REPO_ROOT, "manifests", "watchers");

export interface WatcherRunOpts {
  /** ISO 8601 lower bound (inclusive). Default: 24h before now. */
  since?: string;
  /** ISO 8601 upper bound (exclusive). Default: now. */
  until?: string;
  /** If true, compute the review but don't append alert events. */
  dryRun?: boolean;
}

export type WatcherDecision =
  | "no_change"
  | "notify"
  | "recommend"
  | "act"
  | "escalate"
  | "skipped"
  | "failed";

export interface WatcherRunResult {
  decision: WatcherDecision;
  summary: string;
  metrics: Record<string, number>;
  alerts: AlertEvent[];
  sessionId: string;
  /** Pre-loaded window bounds used by the run, echoed for clarity. */
  window: { since: string; until: string };
  /** Extra observed state the watcher wants to surface (not persisted verbatim). */
  details?: Record<string, unknown>;
}

export interface WatcherImpl {
  spec: WatcherSpec;
  run(opts: {
    since: string;
    until: string;
    sessionId: string;
    dryRun: boolean;
  }): Promise<Omit<WatcherRunResult, "sessionId" | "window">>;
}

type WatcherFactory = (spec: WatcherSpec) => Promise<WatcherImpl>;

const factories: Record<string, WatcherFactory> = {
  "overnight-review": async (spec) => {
    const mod = await import("./overnight-review.ts");
    return mod.createOvernightReview(spec);
  },
  "runpod-idle-killer": async (spec) => {
    const mod = await import("./runpod-idle-killer.ts");
    return mod.createRunpodIdleKiller(spec);
  },
  "work-radar": async (spec) => {
    const mod = await import("./work-radar.ts");
    return mod.createWorkRadar(spec);
  },
  "nightly-sf-portfolio": async (spec) => {
    const mod = await import("./nightly-sf-portfolio.ts");
    return mod.createNightlySfPortfolio(spec);
  },
};

export function loadWatcherManifests(): WatcherSpec[] {
  const files = readdirSync(MANIFEST_DIR).filter((f) =>
    f.endsWith(".watcher.json"),
  );
  const specs: WatcherSpec[] = [];
  for (const file of files) {
    const path = resolve(MANIFEST_DIR, file);
    const raw = JSON.parse(readFileSync(path, "utf8"));
    if (!validateWatcherSpec(raw)) {
      throw new Error(
        `watcher manifest ${file} failed schema validation: ${JSON.stringify(
          validateWatcherSpec.errors,
          null,
          2,
        )}`,
      );
    }
    specs.push(raw as WatcherSpec);
  }
  return specs.sort((a, b) => a.watcherId.localeCompare(b.watcherId));
}

export function findWatcherSpec(watcherId: string): WatcherSpec {
  const all = loadWatcherManifests();
  const found = all.find((s) => s.watcherId === watcherId);
  if (!found) throw new Error(`unknown watcher: ${watcherId}`);
  return found;
}

export async function resolveWatcher(watcherId: string): Promise<WatcherImpl> {
  const spec = findWatcherSpec(watcherId);
  const factory = factories[watcherId];
  if (!factory) {
    throw new Error(
      `watcher ${watcherId} has a manifest but no implementation yet`,
    );
  }
  return factory(spec);
}

/** Resolve kill-switch path relative to the repo root. */
export function killSwitchPath(spec: WatcherSpec): string | null {
  if (!spec.policy.killSwitchFile) return null;
  return resolve(REPO_ROOT, spec.policy.killSwitchFile);
}

export function isKillSwitchActive(spec: WatcherSpec): boolean {
  const path = killSwitchPath(spec);
  return path !== null && existsSync(path);
}

export function newAlertId(): string {
  const t = Date.now().toString(36);
  const r = Math.random().toString(36).slice(2, 10);
  return `alt_${t}_${r}`;
}

export async function runWatcher(
  watcherId: string,
  opts: WatcherRunOpts = {},
): Promise<WatcherRunResult> {
  const spec = findWatcherSpec(watcherId);

  // Kill switch gates before we touch the ledger.
  if (isKillSwitchActive(spec)) {
    const sessionId = newSessionId(`watcher-${watcherId}-skipped`);
    return {
      decision: "skipped",
      summary: `watcher ${watcherId} skipped: kill switch at ${spec.policy.killSwitchFile}`,
      metrics: {},
      alerts: [],
      sessionId,
      window: {
        since:
          opts.since ?? new Date(Date.now() - 24 * 3600 * 1000).toISOString(),
        until: opts.until ?? new Date().toISOString(),
      },
    };
  }

  const until = opts.until ?? new Date().toISOString();
  const since =
    opts.since ?? new Date(Date.now() - 24 * 3600 * 1000).toISOString();

  const sessionId = newSessionId(`watcher-${watcherId}`);
  const ledger = getLedger();
  ledger.ensureSession({
    sessionId,
    label: `watcher:${watcherId}`,
    tags: ["watcher", watcherId],
  });

  ledger.appendEvent({
    sessionId,
    kind: "watcher.tick",
    actor: watcherId,
    payload: {
      watcherId,
      window: { since, until },
      dryRun: opts.dryRun ?? false,
    },
  });

  const impl = await resolveWatcher(watcherId);
  let watcherOutput: Omit<WatcherRunResult, "sessionId" | "window">;
  try {
    watcherOutput = await impl.run({
      since,
      until,
      sessionId,
      dryRun: opts.dryRun ?? false,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    ledger.appendEvent({
      sessionId,
      kind: "watcher.tick",
      actor: watcherId,
      payload: { watcherId, status: "failed", error: message },
    });
    return {
      decision: "failed",
      summary: `watcher ${watcherId} failed: ${message}`,
      metrics: {},
      alerts: [],
      sessionId,
      window: { since, until },
    };
  }

  // Validate + write every emitted alert unless dry-run.
  for (const alert of watcherOutput.alerts) {
    if (!validateAlertEvent(alert)) {
      throw new Error(
        `watcher ${watcherId} emitted invalid alert: ${JSON.stringify(
          validateAlertEvent.errors,
          null,
          2,
        )}`,
      );
    }
    if (!opts.dryRun) {
      ledger.appendEvent({
        sessionId,
        kind: "alert",
        actor: watcherId,
        traceId: alert.alertId,
        payload: alert as unknown as Record<string, unknown>,
      });
    }
  }

  // Emit a terminal watcher.result event with decision/summary/metrics so
  // downstream readers (Frontier Siri Gateway, menubar, morning-brief) can
  // reconstruct the tick outcome without replaying the alert stream.
  if (!opts.dryRun) {
    ledger.appendEvent({
      sessionId,
      kind: "watcher.result",
      actor: watcherId,
      payload: {
        watcherId,
        decision: watcherOutput.decision,
        summary: watcherOutput.summary,
        metrics: watcherOutput.metrics,
        alertCount: watcherOutput.alerts.length,
        window: { since, until },
      },
    });
  }

  return {
    ...watcherOutput,
    sessionId,
    window: { since, until },
  };
}
