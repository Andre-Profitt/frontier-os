// Lease — prevents overlapping factory runs.
//
// One supervisor invocation acquires the lock before doing any work. If a
// concurrent invocation finds an active, non-expired lock held by a live
// process, it refuses. Stale locks (expired window OR dead PID) are
// taken over and flagged via `staleRecovered`.
//
// Lock format (lock.json):
//   { factoryId, runId, pid, startedAt, expiresAt }
//
// Atomic write: we write `<lockPath>.tmp` and rename onto `<lockPath>`.
// On macOS this is atomic on the same filesystem; the lock file lives
// under the same directory as the factory state, so this holds.
//
// Process liveness check uses `process.kill(pid, 0)` which throws ESRCH
// on a dead pid and EPERM on a live-but-not-ours pid. Both EPERM and the
// no-throw case mean alive.

import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname } from "node:path";

export interface Lease {
  factoryId: string;
  runId: string;
  pid: number;
  startedAt: string;
  expiresAt: string;
}

export interface LeaseAcquireOptions {
  factoryId: string;
  runId: string;
  ttlSeconds: number;
  lockPath: string;
  now?: () => Date;
  // Test seam — the live PID liveness check spawns process.kill; tests
  // can pass a known-dead pid via fixtures without needing to inject
  // here. But for full isolation, allow override.
  isAlive?: (pid: number) => boolean;
}

export interface LeaseAcquireResult {
  acquired: boolean;
  staleRecovered: boolean;
  lease: Lease | null;
  blockedBy: Lease | null;
  detail: string;
}

export function isProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    // ESRCH: process not found. EPERM: process exists but we lack perms
    // (still alive). Anything else: treat as dead defensively.
    if (code === "ESRCH") return false;
    if (code === "EPERM") return true;
    return false;
  }
}

function readLeaseFile(path: string): Lease | null {
  if (!existsSync(path)) return null;
  try {
    const raw = readFileSync(path, "utf8");
    const parsed = JSON.parse(raw) as Lease;
    if (
      typeof parsed.factoryId !== "string" ||
      typeof parsed.runId !== "string" ||
      typeof parsed.pid !== "number" ||
      typeof parsed.expiresAt !== "string"
    ) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

function writeLeaseFile(path: string, lease: Lease): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp.${process.pid}.${Date.now()}`;
  writeFileSync(tmp, JSON.stringify(lease, null, 2));
  renameSync(tmp, path);
}

export function acquireLease(opts: LeaseAcquireOptions): LeaseAcquireResult {
  const now = opts.now ? opts.now() : new Date();
  const isAlive = opts.isAlive ?? isProcessAlive;
  const existing = readLeaseFile(opts.lockPath);
  let staleRecovered = false;

  if (existing) {
    const expiresAt = Date.parse(existing.expiresAt);
    const expired = !Number.isNaN(expiresAt) && expiresAt <= now.getTime();
    const alive = isAlive(existing.pid);
    if (alive && !expired) {
      return {
        acquired: false,
        staleRecovered: false,
        lease: null,
        blockedBy: existing,
        detail: `lock held by pid ${existing.pid} (runId=${existing.runId}); expires ${existing.expiresAt}`,
      };
    }
    staleRecovered = true;
  }

  const lease: Lease = {
    factoryId: opts.factoryId,
    runId: opts.runId,
    pid: process.pid,
    startedAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + opts.ttlSeconds * 1000).toISOString(),
  };
  writeLeaseFile(opts.lockPath, lease);
  return {
    acquired: true,
    staleRecovered,
    lease,
    blockedBy: null,
    detail: staleRecovered
      ? `recovered stale lock from pid ${existing?.pid} (runId=${existing?.runId})`
      : "fresh lease acquired",
  };
}

export function releaseLease(
  lockPath: string,
  runId: string,
): { released: boolean; reason: string } {
  const existing = readLeaseFile(lockPath);
  if (!existing) {
    return { released: false, reason: "no lock present" };
  }
  if (existing.runId !== runId) {
    return {
      released: false,
      reason: `lock owned by different runId ${existing.runId}`,
    };
  }
  rmSync(lockPath, { force: true });
  return { released: true, reason: "released" };
}

export function readActiveLease(lockPath: string): Lease | null {
  return readLeaseFile(lockPath);
}
