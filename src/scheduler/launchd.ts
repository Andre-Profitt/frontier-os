// macOS launchd plist generator for frontier-os watchers.
//
// This module produces launchd plist XML that invokes `bin/frontier watcher run <id>`
// on a schedule. Two scheduling styles are supported, mapped from the watcher
// manifest's schedule.mode:
//
//   - "interval" -> <key>StartInterval</key><integer>N</integer>
//   - "cron"     -> <key>StartCalendarInterval</key><array>...</array>
//                   where each array dict is one fire time. Only the same
//                   minimal 5-field cron subset supported by ./index.ts
//                   (*, integers, comma-lists) is allowed. Anything more
//                   complex throws with a clear error telling the caller to
//                   either simplify the cron or use an interval watcher.
//
// This file deliberately does NOT touch ~/Library/LaunchAgents. Callers pass
// destDir explicitly. During dev, use /tmp/frontier-scheduler-test.

import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

import { parseCron } from "./index.ts";

export interface PlistOptions {
  watcherId: string;
  mode: "interval" | "cron";
  intervalSeconds?: number;
  cron?: string;
  /** Absolute path to the frontier CLI shim (bin/frontier). */
  frontierBinPath: string;
  /** Absolute path to the log directory; will be created if missing. */
  logDir: string;
}

export function plistLabel(watcherId: string): string {
  return `com.frontier-os.${watcherId}`;
}

function xmlEscape(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function programArgsXml(bin: string, watcherId: string): string {
  const args = [bin, "watcher", "run", watcherId, "--pretty"];
  const lines = args.map((a) => `    <string>${xmlEscape(a)}</string>`);
  return `  <key>ProgramArguments</key>\n  <array>\n${lines.join("\n")}\n  </array>`;
}

interface CalendarEntry {
  Minute?: number;
  Hour?: number;
  Day?: number;
  Month?: number;
  Weekday?: number;
}

/**
 * Expand a minimal 5-field cron into an array of StartCalendarInterval dicts.
 *
 * launchd's StartCalendarInterval semantics: each dict with a key/value set
 * restricts that field; unset fields are wildcards. We map our CronFields the
 * same way. For comma-lists we produce the Cartesian product as multiple dicts
 * — launchd runs the job when ANY dict matches.
 *
 * Throws for anything the minimal parser rejects (ranges, steps, etc).
 */
export function cronToCalendarEntries(cronExpr: string): CalendarEntry[] {
  const fields = parseCron(cronExpr);

  const minutes =
    fields.minute === "*"
      ? [null]
      : Array.from(fields.minute).sort((a, b) => a - b);
  const hours =
    fields.hour === "*"
      ? [null]
      : Array.from(fields.hour).sort((a, b) => a - b);
  const days =
    fields.dayOfMonth === "*"
      ? [null]
      : Array.from(fields.dayOfMonth).sort((a, b) => a - b);
  const months =
    fields.month === "*"
      ? [null]
      : Array.from(fields.month).sort((a, b) => a - b);
  const weekdays =
    fields.dayOfWeek === "*"
      ? [null]
      : Array.from(fields.dayOfWeek).sort((a, b) => a - b);

  const entries: CalendarEntry[] = [];
  for (const mnt of minutes) {
    for (const hr of hours) {
      for (const d of days) {
        for (const mo of months) {
          for (const wd of weekdays) {
            const entry: CalendarEntry = {};
            if (mnt !== null) entry.Minute = mnt;
            if (hr !== null) entry.Hour = hr;
            if (d !== null) entry.Day = d;
            if (mo !== null) entry.Month = mo;
            if (wd !== null) entry.Weekday = wd;
            entries.push(entry);
          }
        }
      }
    }
  }

  // Bound the fan-out so a pathological cron doesn't produce thousands of dicts.
  if (entries.length > 256) {
    throw new Error(
      `cron "${cronExpr}" expands to ${entries.length} StartCalendarInterval entries; too complex for launchd. Simplify the cron or use an interval watcher.`,
    );
  }
  return entries;
}

function calendarEntriesXml(entries: CalendarEntry[]): string {
  const dictLines: string[] = [];
  for (const e of entries) {
    const kvs: string[] = [];
    if (typeof e.Minute === "number") {
      kvs.push(`      <key>Minute</key>\n      <integer>${e.Minute}</integer>`);
    }
    if (typeof e.Hour === "number") {
      kvs.push(`      <key>Hour</key>\n      <integer>${e.Hour}</integer>`);
    }
    if (typeof e.Day === "number") {
      kvs.push(`      <key>Day</key>\n      <integer>${e.Day}</integer>`);
    }
    if (typeof e.Month === "number") {
      kvs.push(`      <key>Month</key>\n      <integer>${e.Month}</integer>`);
    }
    if (typeof e.Weekday === "number") {
      kvs.push(
        `      <key>Weekday</key>\n      <integer>${e.Weekday}</integer>`,
      );
    }
    if (kvs.length === 0) {
      // All-wildcard dict -> launchd would fire every minute. That's almost
      // never what the user means; refuse to generate it.
      throw new Error(
        "cron expression is all wildcards; refusing to generate a launchd plist that fires every minute. Use an interval watcher instead.",
      );
    }
    dictLines.push(`    <dict>\n${kvs.join("\n")}\n    </dict>`);
  }
  return `  <key>StartCalendarInterval</key>\n  <array>\n${dictLines.join("\n")}\n  </array>`;
}

export function generatePlist(opts: PlistOptions): string {
  const label = plistLabel(opts.watcherId);
  const outLog = resolve(opts.logDir, `${opts.watcherId}.out.log`);
  const errLog = resolve(opts.logDir, `${opts.watcherId}.err.log`);

  let scheduleXml: string;
  if (opts.mode === "interval") {
    const seconds = opts.intervalSeconds;
    if (
      typeof seconds !== "number" ||
      !Number.isInteger(seconds) ||
      seconds <= 0
    ) {
      throw new Error(
        `generatePlist: interval mode requires positive integer intervalSeconds, got ${String(seconds)}`,
      );
    }
    scheduleXml = `  <key>StartInterval</key>\n  <integer>${seconds}</integer>`;
  } else if (opts.mode === "cron") {
    const cron = opts.cron;
    if (typeof cron !== "string" || cron.length === 0) {
      throw new Error("generatePlist: cron mode requires cron expression");
    }
    let entries: CalendarEntry[];
    try {
      entries = cronToCalendarEntries(cron);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      throw new Error(
        `complex cron pattern "${cron}" not supported for launchd; use an interval watcher or simplify the cron (${message})`,
      );
    }
    scheduleXml = calendarEntriesXml(entries);
  } else {
    // Defensive; mode is type-narrowed at compile time.
    throw new Error(`generatePlist: unsupported mode ${String(opts.mode)}`);
  }

  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${xmlEscape(label)}</string>
${programArgsXml(opts.frontierBinPath, opts.watcherId)}
${scheduleXml}
  <key>RunAtLoad</key>
  <false/>
  <key>StandardOutPath</key>
  <string>${xmlEscape(outLog)}</string>
  <key>StandardErrorPath</key>
  <string>${xmlEscape(errLog)}</string>
</dict>
</plist>
`;
  return xml;
}

export async function writePlist(
  opts: PlistOptions,
  destDir: string,
): Promise<string> {
  mkdirSync(opts.logDir, { recursive: true });
  mkdirSync(destDir, { recursive: true });
  const label = plistLabel(opts.watcherId);
  const path = resolve(destDir, `${label}.plist`);
  const xml = generatePlist(opts);
  writeFileSync(path, xml, "utf8");
  return path;
}
