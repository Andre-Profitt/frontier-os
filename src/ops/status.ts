import { existsSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { buildSchedule } from "../scheduler/index.ts";
import {
  killSwitchPath,
  loadWatcherManifests,
} from "../watchers/runtime.ts";
import {
  processMatches,
  readLaunchdList,
  readProcessTable,
  summarizeProcesses,
  type LaunchdEntry,
  type ProcessInfo,
} from "../system/probes.ts";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const REPO_ROOT = resolve(__dirname, "..", "..");
const HOME = homedir();
const LAUNCH_AGENTS_DIR = resolve(HOME, "Library", "LaunchAgents");
const LOG_DIR = resolve(HOME, "Library", "Logs", "frontier-os");
const GHOST_QUEUE_ROOT = resolve(HOME, ".frontier", "ghost-shift");

interface ExpectedLaunchAgent {
  label: string;
  required: boolean;
  source: string;
  plistPath: string;
  logPaths: string[];
}

interface LogPathStatus {
  path: string;
  exists: boolean;
  sizeBytes: number | null;
  modifiedAt: string | null;
}

export interface OpsStatus {
  generatedAt: string;
  launchAgents: Array<{
    label: string;
    required: boolean;
    source: string;
    plistPath: string;
    installed: boolean;
    loaded: boolean;
    pid: number | null;
    lastExitStatus: number | null;
    logs: LogPathStatus[];
  }>;
  ghostShift: {
    queueDir: string;
    disabled: boolean;
    counts: Record<"queue" | "running" | "completed" | "failed" | "blocked" | "rejected", number>;
  };
  watchers: Array<{
    watcherId: string;
    schedule: unknown;
    nextRunAt: string | null;
    killSwitchFile: string | null;
    killSwitchActive: boolean;
    launchAgentLabel: string | null;
    launchAgentLoaded: boolean;
    runningProcesses: ProcessInfo[];
  }>;
  scheduler: {
    computedScheduleCount: number;
    runningProcesses: ProcessInfo[];
    nextRuns: Array<{
      watcherId: string;
      mode: string;
      nextRunAt: string | null;
      intervalSeconds?: number;
      cron?: string;
    }>;
  };
  logs: {
    directory: string;
    directoryExists: boolean;
    paths: LogPathStatus[];
  };
  processes: {
    frontierd: ProcessInfo[];
    frontierWatchers: ProcessInfo[];
    scheduler: ProcessInfo[];
    mlx: ProcessInfo[];
    codex: ProcessInfo[];
  };
}

export async function opsStatus(): Promise<OpsStatus> {
  const generatedAt = new Date().toISOString();
  const watcherSpecs = loadWatcherManifests();
  const schedule = await buildSchedule();
  const scheduleByWatcher = new Map(
    schedule.map((item) => [item.watcherId, item]),
  );
  const launchd = readLaunchdList();
  const processes = readProcessTable();
  const expectedAgents = expectedLaunchAgents(watcherSpecs);
  const allLogPaths = unique(
    expectedAgents.flatMap((agent) => agent.logPaths),
  ).sort();

  return {
    generatedAt,
    launchAgents: expectedAgents.map((agent) =>
      launchAgentStatus(agent, launchd),
    ),
    ghostShift: ghostShiftStatus(),
    watchers: watcherSpecs.map((spec) => {
      const next = scheduleByWatcher.get(spec.watcherId);
      const launchAgentLabel =
        spec.schedule.mode === "cron" || spec.schedule.mode === "interval"
          ? `com.frontier-os.${spec.watcherId}`
          : null;
      const killPath = killSwitchPath(spec);
      return {
        watcherId: spec.watcherId,
        schedule: spec.schedule,
        nextRunAt: next?.nextRunAt?.toISOString() ?? null,
        killSwitchFile: killPath,
        killSwitchActive: killPath !== null && existsSync(killPath),
        launchAgentLabel,
        launchAgentLoaded:
          launchAgentLabel !== null && launchd.has(launchAgentLabel),
        runningProcesses: summarizeProcesses(
          processMatches(processes, `frontier watcher run ${spec.watcherId}`),
        ),
      };
    }),
    scheduler: {
      computedScheduleCount: schedule.length,
      runningProcesses: summarizeProcesses(
        processMatches(processes, "frontier scheduler run"),
      ),
      nextRuns: schedule.map((item) => {
        const projected: OpsStatus["scheduler"]["nextRuns"][number] = {
          watcherId: item.watcherId,
          mode: item.mode,
          nextRunAt: item.nextRunAt?.toISOString() ?? null,
        };
        if (item.intervalSeconds !== undefined) {
          projected.intervalSeconds = item.intervalSeconds;
        }
        if (item.cron !== undefined) projected.cron = item.cron;
        return projected;
      }),
    },
    logs: {
      directory: LOG_DIR,
      directoryExists: existsSync(LOG_DIR),
      paths: allLogPaths.map(logStatus),
    },
    processes: processInventory(processes),
  };
}

function expectedLaunchAgents(watcherSpecs: ReturnType<typeof loadWatcherManifests>): ExpectedLaunchAgent[] {
  const agents: ExpectedLaunchAgent[] = [
    {
      label: "com.frontier-os.frontierd",
      required: true,
      source: "frontierd",
      plistPath: resolve(LAUNCH_AGENTS_DIR, "com.frontier-os.frontierd.plist"),
      logPaths: [
        resolve(LOG_DIR, "frontierd.out.log"),
        resolve(LOG_DIR, "frontierd.err.log"),
      ],
    },
    {
      label: "com.frontier-os.ghost-shift",
      required: true,
      source: "ghost-shift",
      plistPath: resolve(LAUNCH_AGENTS_DIR, "com.frontier-os.ghost-shift.plist"),
      logPaths: [
        resolve(LOG_DIR, "ghost-shift.out.log"),
        resolve(LOG_DIR, "ghost-shift.err.log"),
      ],
    },
    {
      label: "com.frontier-os.nightly-research-enqueue",
      required: true,
      source: "nightly-research-enqueue",
      plistPath: resolve(
        LAUNCH_AGENTS_DIR,
        "com.frontier-os.nightly-research-enqueue.plist",
      ),
      logPaths: [
        resolve(LOG_DIR, "nightly-research-enqueue.out.log"),
        resolve(LOG_DIR, "nightly-research-enqueue.err.log"),
      ],
    },
    {
      label: "com.frontier-os.notify-alerts",
      required: false,
      source: "notify-alerts",
      plistPath: resolve(LAUNCH_AGENTS_DIR, "com.frontier-os.notify-alerts.plist"),
      logPaths: [
        resolve(LOG_DIR, "notify-alerts.out.log"),
        resolve(LOG_DIR, "notify-alerts.err.log"),
      ],
    },
  ];
  for (const spec of watcherSpecs) {
    if (spec.schedule.mode !== "cron" && spec.schedule.mode !== "interval") {
      continue;
    }
    const label = `com.frontier-os.${spec.watcherId}`;
    agents.push({
      label,
      required: true,
      source: `watcher:${spec.watcherId}`,
      plistPath: resolve(LAUNCH_AGENTS_DIR, `${label}.plist`),
      logPaths: [
        resolve(LOG_DIR, `${spec.watcherId}.out.log`),
        resolve(LOG_DIR, `${spec.watcherId}.err.log`),
      ],
    });
  }
  return agents.sort((a, b) => a.label.localeCompare(b.label));
}

function launchAgentStatus(
  agent: ExpectedLaunchAgent,
  launchd: Map<string, LaunchdEntry>,
): OpsStatus["launchAgents"][number] {
  const loaded = launchd.get(agent.label) ?? null;
  return {
    label: agent.label,
    required: agent.required,
    source: agent.source,
    plistPath: agent.plistPath,
    installed: existsSync(agent.plistPath),
    loaded: loaded !== null,
    pid: loaded?.pid ?? null,
    lastExitStatus: loaded?.lastExitStatus ?? null,
    logs: agent.logPaths.map(logStatus),
  };
}

function ghostShiftStatus(): OpsStatus["ghostShift"] {
  return {
    queueDir: GHOST_QUEUE_ROOT,
    disabled: existsSync(resolve(GHOST_QUEUE_ROOT, ".disabled")),
    counts: {
      queue: countJson(resolve(GHOST_QUEUE_ROOT, "queue")),
      running: countJson(resolve(GHOST_QUEUE_ROOT, "running")),
      completed: countJson(resolve(GHOST_QUEUE_ROOT, "completed")),
      failed: countJson(resolve(GHOST_QUEUE_ROOT, "failed")),
      blocked: countJson(resolve(GHOST_QUEUE_ROOT, "blocked")),
      rejected: countJson(resolve(GHOST_QUEUE_ROOT, "rejected")),
    },
  };
}

function countJson(dir: string): number {
  if (!existsSync(dir)) return 0;
  try {
    return readdirSync(dir).filter(
      (file) => file.endsWith(".json") && !file.startsWith("."),
    ).length;
  } catch {
    return 0;
  }
}

function logStatus(path: string): LogPathStatus {
  if (!existsSync(path)) {
    return { path, exists: false, sizeBytes: null, modifiedAt: null };
  }
  const stat = statSync(path);
  return {
    path,
    exists: true,
    sizeBytes: stat.size,
    modifiedAt: stat.mtime.toISOString(),
  };
}

function processInventory(processes: ProcessInfo[]): OpsStatus["processes"] {
  const frontierdMatches = uniqueProcesses([
    ...processMatches(processes, "frontierd"),
    ...processMatches(processes, "frontier daemon run"),
  ]);
  const frontierWatchers = processes.filter((proc) =>
    proc.args.includes("frontier watcher run"),
  );
  const mlx = processes.filter((proc) => {
    const haystack = `${proc.command} ${proc.args}`.toLowerCase();
    return (
      haystack.includes("/.frontier/mlx") ||
      haystack.includes("mlxw") ||
      haystack.includes("mlx-lm") ||
      haystack.includes("mlx_lm")
    );
  });
  const codex = processes.filter((proc) => {
    const haystack = `${proc.command} ${proc.args}`.toLowerCase();
    return haystack.includes("codex");
  });
  return {
    frontierd: summarizeProcesses(frontierdMatches),
    frontierWatchers: summarizeProcesses(frontierWatchers),
    scheduler: summarizeProcesses(processMatches(processes, "frontier scheduler run")),
    mlx: summarizeProcesses(mlx),
    codex: summarizeProcesses(codex),
  };
}

function uniqueProcesses(processes: ProcessInfo[]): ProcessInfo[] {
  return Array.from(new Map(processes.map((proc) => [proc.pid, proc])).values());
}

function unique(values: string[]): string[] {
  return Array.from(new Set(values));
}
