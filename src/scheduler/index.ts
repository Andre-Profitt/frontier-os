// In-process scheduler for watcher manifests.
//
// This is the foreground runner used for dev/testing. For real macOS
// deployment, prefer the launchd plist generator in ./launchd.ts which
// hands scheduling off to launchd (survives reboots, logs captured, etc).
//
// Supported schedule modes:
//   - "interval": setInterval at intervalSeconds
//   - "cron":     minimal 5-field cron parser + setTimeout loop
//   - "event":    SKIPPED (not yet implemented; logged and ignored)
//   - "manual":   SKIPPED (never auto-scheduled by design)
//
// Cron parser limitations (intentional; do NOT add node-cron here):
//   - Only 5 fields: "minute hour day month weekday"
//   - Supports: "*", single integers, comma-separated lists ("0,15,30,45")
//   - Does NOT support: ranges ("1-5"), steps ("*/5"), names ("Mon"),
//     predefined shortcuts ("@daily"), seconds field, "L"/"W"/"#" specials
//   - If you need any of those, move that watcher to an interval schedule
//     or add node-cron behind a feature flag.
//
// Smoke test:
//   npx tsx -e "import('./src/scheduler/index.ts').then(m => m.runScheduler({ foreground: true, stopAfterMs: 5000 }))"

import {
  loadWatcherManifests,
  runWatcher,
  type WatcherRunResult,
} from "../watchers/runtime.ts";
import type { WatcherSpec, WatcherScheduleMode } from "../schemas.ts";

export interface ScheduledWatcher {
  watcherId: string;
  mode: WatcherScheduleMode;
  nextRunAt: Date | null;
  intervalSeconds?: number;
  cron?: string;
}

export interface RunSchedulerOpts {
  /** If true, block forever (until stopAfterMs elapses). If false, compute and report one tick. */
  foreground?: boolean;
  /** Restrict to subset of watcher ids; default all. */
  watcherIds?: string[];
  /** Max wall-clock in ms. Stops the scheduler cleanly. Useful for tests. */
  stopAfterMs?: number;
  /** Optional hook invoked after each watcher fire (success or failure). */
  onTick?: (watcherId: string, result: unknown) => void;
}

// ---------------------------------------------------------------------------
// Cron parser — minimal 5-field form.
// ---------------------------------------------------------------------------

interface CronFields {
  minute: Set<number> | "*";
  hour: Set<number> | "*";
  dayOfMonth: Set<number> | "*";
  month: Set<number> | "*";
  dayOfWeek: Set<number> | "*";
}

function parseCronField(
  raw: string,
  min: number,
  max: number,
  fieldName: string,
): Set<number> | "*" {
  if (raw === "*") return "*";
  const parts = raw.split(",");
  const out = new Set<number>();
  for (const p of parts) {
    if (p.includes("-") || p.includes("/")) {
      throw new Error(
        `cron parser: unsupported pattern "${p}" in ${fieldName}; only *, integers, and comma-lists are supported`,
      );
    }
    const n = Number(p);
    if (!Number.isInteger(n) || n < min || n > max) {
      throw new Error(
        `cron parser: value "${p}" out of range [${min}, ${max}] in ${fieldName}`,
      );
    }
    out.add(n);
  }
  if (out.size === 0) {
    throw new Error(`cron parser: empty field ${fieldName}`);
  }
  return out;
}

export function parseCron(expr: string): CronFields {
  const trimmed = expr.trim().split(/\s+/);
  if (trimmed.length !== 5) {
    throw new Error(
      `cron parser: expected 5 fields, got ${trimmed.length} in "${expr}"`,
    );
  }
  const [minute, hour, dayOfMonth, month, dayOfWeek] = trimmed as [
    string,
    string,
    string,
    string,
    string,
  ];
  return {
    minute: parseCronField(minute, 0, 59, "minute"),
    hour: parseCronField(hour, 0, 23, "hour"),
    dayOfMonth: parseCronField(dayOfMonth, 1, 31, "dayOfMonth"),
    month: parseCronField(month, 1, 12, "month"),
    dayOfWeek: parseCronField(dayOfWeek, 0, 6, "dayOfWeek"),
  };
}

function matches(set: Set<number> | "*", value: number): boolean {
  return set === "*" || set.has(value);
}

/**
 * Walk forward minute by minute from `fromDate` (exclusive of the exact same
 * minute) until a matching minute is found. Caps at 7 days to prevent runaway
 * loops on impossible cron expressions (e.g. "0 0 31 2 *").
 */
export function nextCronFireTime(cronExpr: string, fromDate: Date): Date {
  const fields = parseCron(cronExpr);
  // Round up to next whole minute.
  const start = new Date(fromDate.getTime());
  start.setSeconds(0, 0);
  start.setMinutes(start.getMinutes() + 1);

  const capMs = 7 * 24 * 60 * 60 * 1000;
  const deadline = start.getTime() + capMs;

  const cursor = new Date(start.getTime());
  while (cursor.getTime() <= deadline) {
    const mnt = cursor.getMinutes();
    const hr = cursor.getHours();
    const dom = cursor.getDate();
    const mon = cursor.getMonth() + 1;
    const dow = cursor.getDay();
    if (
      matches(fields.minute, mnt) &&
      matches(fields.hour, hr) &&
      matches(fields.dayOfMonth, dom) &&
      matches(fields.month, mon) &&
      matches(fields.dayOfWeek, dow)
    ) {
      return new Date(cursor.getTime());
    }
    cursor.setMinutes(cursor.getMinutes() + 1);
  }
  throw new Error(
    `cron parser: no matching minute within 7 days for "${cronExpr}"`,
  );
}

// ---------------------------------------------------------------------------
// buildSchedule — pure projection of the manifests into a schedule plan.
// ---------------------------------------------------------------------------

export async function buildSchedule(): Promise<ScheduledWatcher[]> {
  const specs = loadWatcherManifests();
  const now = new Date();
  const out: ScheduledWatcher[] = [];

  for (const spec of specs) {
    const mode = spec.schedule.mode;
    if (mode === "manual") continue;
    if (mode === "event") {
      // Not yet supported — silently skip per design.
      continue;
    }

    if (mode === "interval") {
      const seconds = spec.schedule.intervalSeconds;
      if (typeof seconds !== "number" || seconds <= 0) {
        process.stderr.write(
          `[scheduler] skipping ${spec.watcherId}: interval mode without valid intervalSeconds\n`,
        );
        continue;
      }
      out.push({
        watcherId: spec.watcherId,
        mode,
        nextRunAt: new Date(now.getTime() + seconds * 1000),
        intervalSeconds: seconds,
      });
      continue;
    }

    if (mode === "cron") {
      const cron = spec.schedule.cron;
      if (typeof cron !== "string" || cron.length === 0) {
        process.stderr.write(
          `[scheduler] skipping ${spec.watcherId}: cron mode without cron expression\n`,
        );
        continue;
      }
      try {
        const next = nextCronFireTime(cron, now);
        out.push({
          watcherId: spec.watcherId,
          mode,
          nextRunAt: next,
          cron,
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        process.stderr.write(
          `[scheduler] skipping ${spec.watcherId}: ${message}\n`,
        );
      }
    }
  }

  return out;
}

// ---------------------------------------------------------------------------
// runScheduler — foreground runner with interval + cron primitives.
// ---------------------------------------------------------------------------

type Timer = ReturnType<typeof setTimeout>;

interface SchedulerState {
  specs: Map<string, WatcherSpec>;
  intervalTimers: Map<string, Timer>;
  cronTimers: Map<string, Timer>;
  nextRunAt: Map<string, Date>;
  stopped: boolean;
}

function fireWatcher(
  _state: SchedulerState,
  watcherId: string,
  onTick: ((watcherId: string, result: unknown) => void) | undefined,
): Promise<void> {
  return (async () => {
    try {
      const result: WatcherRunResult = await runWatcher(watcherId);
      if (onTick) onTick(watcherId, result);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      process.stderr.write(
        `[scheduler] watcher ${watcherId} threw: ${message}\n`,
      );
      if (onTick) onTick(watcherId, { error: message });
    }
  })();
}

function scheduleNextCronFire(
  state: SchedulerState,
  watcherId: string,
  cronExpr: string,
  onTick: ((watcherId: string, result: unknown) => void) | undefined,
): void {
  if (state.stopped) return;
  let next: Date;
  try {
    next = nextCronFireTime(cronExpr, new Date());
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    process.stderr.write(
      `[scheduler] cron compute failed for ${watcherId}: ${message}\n`,
    );
    return;
  }
  state.nextRunAt.set(watcherId, next);
  const delay = Math.max(0, next.getTime() - Date.now());
  const timer = setTimeout(() => {
    if (state.stopped) return;
    void fireWatcher(state, watcherId, onTick).finally(() => {
      scheduleNextCronFire(state, watcherId, cronExpr, onTick);
    });
  }, delay);
  // Do not block process exit on these timers; the outer stop loop clears them.
  if (typeof timer === "object" && timer && "unref" in timer) {
    (timer as { unref: () => void }).unref();
  }
  state.cronTimers.set(watcherId, timer);
}

export async function runScheduler(opts: RunSchedulerOpts = {}): Promise<void> {
  const specs = loadWatcherManifests();
  const filter = opts.watcherIds;
  const selected = filter
    ? specs.filter((s) => filter.includes(s.watcherId))
    : specs;

  const state: SchedulerState = {
    specs: new Map(selected.map((s) => [s.watcherId, s])),
    intervalTimers: new Map(),
    cronTimers: new Map(),
    nextRunAt: new Map(),
    stopped: false,
  };

  const onTick = opts.onTick;

  for (const spec of selected) {
    const mode = spec.schedule.mode;
    if (mode === "manual") continue;
    if (mode === "event") {
      process.stderr.write(
        `[scheduler] ${spec.watcherId}: event mode not yet supported, skipping\n`,
      );
      continue;
    }
    if (mode === "interval") {
      const seconds = spec.schedule.intervalSeconds;
      if (typeof seconds !== "number" || seconds <= 0) {
        process.stderr.write(
          `[scheduler] ${spec.watcherId}: interval mode without valid intervalSeconds, skipping\n`,
        );
        continue;
      }
      const ms = seconds * 1000;
      state.nextRunAt.set(spec.watcherId, new Date(Date.now() + ms));
      const timer = setInterval(() => {
        if (state.stopped) return;
        state.nextRunAt.set(spec.watcherId, new Date(Date.now() + ms));
        void fireWatcher(state, spec.watcherId, onTick);
      }, ms);
      if (typeof timer === "object" && timer && "unref" in timer) {
        (timer as { unref: () => void }).unref();
      }
      state.intervalTimers.set(spec.watcherId, timer);
      process.stdout.write(
        `[scheduler] scheduled ${spec.watcherId} (interval ${seconds}s, next=${state.nextRunAt.get(spec.watcherId)?.toISOString()})\n`,
      );
      continue;
    }
    if (mode === "cron") {
      const cron = spec.schedule.cron;
      if (typeof cron !== "string" || cron.length === 0) {
        process.stderr.write(
          `[scheduler] ${spec.watcherId}: cron mode without cron expression, skipping\n`,
        );
        continue;
      }
      scheduleNextCronFire(state, spec.watcherId, cron, onTick);
      const nr = state.nextRunAt.get(spec.watcherId);
      process.stdout.write(
        `[scheduler] scheduled ${spec.watcherId} (cron "${cron}", next=${nr ? nr.toISOString() : "n/a"})\n`,
      );
    }
  }

  if (!opts.foreground) {
    // One-shot mode: tear down timers immediately and return.
    stopAll(state);
    return;
  }

  // Foreground: block until stopAfterMs elapses (if given) or forever.
  await new Promise<void>((resolve) => {
    let stopTimer: Timer | null = null;
    const cleanup = (): void => {
      if (state.stopped) return;
      state.stopped = true;
      stopAll(state);
      if (stopTimer) clearTimeout(stopTimer);
      resolve();
    };

    if (typeof opts.stopAfterMs === "number" && opts.stopAfterMs > 0) {
      stopTimer = setTimeout(cleanup, opts.stopAfterMs);
    }

    const onSig = (): void => cleanup();
    process.once("SIGINT", onSig);
    process.once("SIGTERM", onSig);
  });
}

function stopAll(state: SchedulerState): void {
  state.stopped = true;
  for (const t of state.intervalTimers.values()) clearInterval(t);
  for (const t of state.cronTimers.values()) clearTimeout(t);
  state.intervalTimers.clear();
  state.cronTimers.clear();
}
