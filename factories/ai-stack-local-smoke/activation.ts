// activation — plan / apply / rollback the launchd plist that owns the
// scheduled lane.
//
// Plan: read the current plist, compute the proposed ProgramArguments
// (pointing at the factory wrapper script), produce a backup path, and
// return a human-readable diff with the rollback command.
//
// Apply: copy the original plist to the backup path, then write the
// new ProgramArguments. Atomic via plutil convert + rename.
//
// Rollback: copy a named backup back over the live plist.
//
// All operations are dry-run-safe — `applyActivation({dryRun: true})`
// produces no file writes; same for `rollbackActivation`. Tests use
// fixture plists under tmpdir; production callers operate on the real
// `~/Library/LaunchAgents/<label>.plist` path.

import { spawnSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";

const SUBPROCESS_TIMEOUT_MS = 5_000;

export interface ActivationPlanInput {
  plistPath: string; // live plist (e.g. ~/Library/LaunchAgents/<label>.plist)
  factoryWrapperPath: string; // e.g. /Users/test/frontier-os/scripts/run-...sh
  backupDir: string; // e.g. factories/<lane>/state/backups
  // Optional clock for deterministic backup naming in tests.
  now?: () => Date;
}

export interface ActivationPlan {
  plistPath: string;
  current: {
    exists: boolean;
    programArguments: string[] | null;
  };
  proposed: {
    programArguments: string[];
  };
  backupPath: string;
  diff: string;
  rollbackCommand: string;
  alreadyActivated: boolean; // true if current already points at the wrapper
}

export interface ApplyResult {
  applied: boolean;
  dryRun: boolean;
  backupPath: string;
  detail: string;
}

export interface RollbackResult {
  restored: boolean;
  dryRun: boolean;
  fromBackup: string;
  detail: string;
}

function plutilToJson(plistPath: string): Record<string, unknown> {
  const res = spawnSync("plutil", ["-convert", "json", "-o", "-", plistPath], {
    encoding: "utf8",
    timeout: SUBPROCESS_TIMEOUT_MS,
  });
  if (res.status !== 0) {
    throw new Error(
      `plutil failed to read ${plistPath}: status=${res.status}, stderr=${(
        res.stderr ?? ""
      ).trim()}`,
    );
  }
  return JSON.parse(res.stdout ?? "{}") as Record<string, unknown>;
}

function jsonToXmlPlistAtomic(
  plistPath: string,
  payload: Record<string, unknown>,
): void {
  // plutil reads JSON from stdin via `-` and emits XML plist on stdout.
  const tmp = `${plistPath}.tmp.${process.pid}.${Date.now()}`;
  const res = spawnSync("plutil", ["-convert", "xml1", "-o", tmp, "-"], {
    encoding: "utf8",
    input: JSON.stringify(payload),
    timeout: SUBPROCESS_TIMEOUT_MS,
  });
  if (res.status !== 0) {
    throw new Error(
      `plutil failed to write ${plistPath}: status=${res.status}, stderr=${(
        res.stderr ?? ""
      ).trim()}`,
    );
  }
  renameSync(tmp, plistPath);
}

function backupName(now: Date): string {
  return now
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d+Z$/, "Z");
}

export function planActivation(input: ActivationPlanInput): ActivationPlan {
  const now = input.now ? input.now() : new Date();
  const stamp = backupName(now);
  const backupPath = resolve(input.backupDir, `${stamp}.plist`);

  let current: { exists: boolean; programArguments: string[] | null } = {
    exists: false,
    programArguments: null,
  };

  if (existsSync(input.plistPath)) {
    const parsed = plutilToJson(input.plistPath);
    const pa = parsed["ProgramArguments"];
    current = {
      exists: true,
      programArguments: Array.isArray(pa) ? (pa as string[]) : null,
    };
  }

  const proposed = {
    programArguments: ["/bin/bash", input.factoryWrapperPath],
  };

  const alreadyActivated =
    current.programArguments !== null &&
    current.programArguments.length === proposed.programArguments.length &&
    current.programArguments.every(
      (v, i) => v === proposed.programArguments[i],
    );

  const diff = [
    `--- current ${input.plistPath}`,
    `+++ proposed`,
    `- ProgramArguments: ${
      current.programArguments
        ? JSON.stringify(current.programArguments)
        : "(missing or non-array)"
    }`,
    `+ ProgramArguments: ${JSON.stringify(proposed.programArguments)}`,
    `# backup will be written to: ${backupPath}`,
  ].join("\n");

  const rollbackCommand = `./scripts/install-local-smoke-factory-launchd.sh --rollback ${stamp}`;

  return {
    plistPath: input.plistPath,
    current,
    proposed,
    backupPath,
    diff,
    rollbackCommand,
    alreadyActivated,
  };
}

export function applyActivation(
  plan: ActivationPlan,
  opts: { dryRun: boolean },
): ApplyResult {
  if (plan.alreadyActivated) {
    return {
      applied: false,
      dryRun: opts.dryRun,
      backupPath: plan.backupPath,
      detail: "plist already points at the factory wrapper; no change",
    };
  }
  if (opts.dryRun) {
    return {
      applied: false,
      dryRun: true,
      backupPath: plan.backupPath,
      detail: "dry-run; no files modified",
    };
  }
  if (!plan.current.exists) {
    throw new Error(
      `cannot apply: live plist does not exist at ${plan.plistPath}`,
    );
  }

  // Backup first.
  mkdirSync(dirname(plan.backupPath), { recursive: true });
  copyFileSync(plan.plistPath, plan.backupPath);

  // Read current plist, replace ProgramArguments, write back.
  const parsed = plutilToJson(plan.plistPath);
  parsed["ProgramArguments"] = plan.proposed.programArguments;
  jsonToXmlPlistAtomic(plan.plistPath, parsed);

  return {
    applied: true,
    dryRun: false,
    backupPath: plan.backupPath,
    detail: `plist updated; backup at ${plan.backupPath}`,
  };
}

export interface RollbackInput {
  plistPath: string;
  backupDir: string;
  backupId: string; // the stamp portion of <stamp>.plist
  dryRun: boolean;
}

export function rollbackActivation(input: RollbackInput): RollbackResult {
  const fromBackup = resolve(input.backupDir, `${input.backupId}.plist`);
  if (!existsSync(fromBackup)) {
    throw new Error(`backup not found: ${fromBackup}`);
  }
  if (input.dryRun) {
    return {
      restored: false,
      dryRun: true,
      fromBackup,
      detail: `dry-run; would copy ${fromBackup} → ${input.plistPath}`,
    };
  }
  copyFileSync(fromBackup, input.plistPath);
  return {
    restored: true,
    dryRun: false,
    fromBackup,
    detail: `restored ${input.plistPath} from ${fromBackup}`,
  };
}

// Helper for tests: build a minimal valid launchd plist on disk so
// fixtures don't have to hand-write XML. Production callers should not
// use this — real plists are authored elsewhere.
export function writeFixturePlist(
  plistPath: string,
  payload: Record<string, unknown>,
): void {
  mkdirSync(dirname(plistPath), { recursive: true });
  // First write a JSON sibling, then convert to XML plist.
  const tmpJson = `${plistPath}.tmp.json`;
  writeFileSync(tmpJson, JSON.stringify(payload));
  const res = spawnSync(
    "plutil",
    ["-convert", "xml1", "-o", plistPath, tmpJson],
    { encoding: "utf8", timeout: SUBPROCESS_TIMEOUT_MS },
  );
  if (res.status !== 0) {
    throw new Error(
      `writeFixturePlist failed: status=${res.status}, stderr=${(
        res.stderr ?? ""
      ).trim()}`,
    );
  }
  // Cleanup tmpJson (plutil already wrote the xml output to plistPath).
  if (existsSync(tmpJson)) {
    try {
      writeFileSync(tmpJson, ""); // best-effort blank, then leave it for caller's tmpdir cleanup
    } catch {
      /* ignore */
    }
  }
  // Suppress unused-import warnings without functional change.
  void join;
}
