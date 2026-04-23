// NVIDIA GPU adapter — thin nvidia-smi wrapper.
//
// Per lift manifest: we could use @quik-fe/node-nvidia-smi for ~0 code, but
// a dozen-line CSV parser is cheaper than another dep + it works on hosts
// with different `nvidia-smi` CSV dialects. No npm install needed.
//
// macOS reality check: no NVIDIA binary. Adapter returns status=failed with
// a clear `hint` in observedState instead of crashing. Makes CI + dev-mac
// workflows clean.

import { spawn } from "node:child_process";

import type { AdapterImpl } from "../../registry.ts";
import type {
  AdapterInvocation,
  AdapterManifest,
  AdapterResult,
} from "../../schemas.ts";

const NVIDIA_SMI_BIN = process.env.FRONTIER_NVIDIA_SMI_BIN ?? "nvidia-smi";
const DEFAULT_TIMEOUT_MS = 15_000;

interface Csv {
  header: string[];
  rows: Record<string, string>[];
}

export async function createNvidiaAdapter(
  manifest: AdapterManifest,
): Promise<AdapterImpl> {
  return {
    manifest,
    async invoke(invocation: AdapterInvocation): Promise<AdapterResult> {
      switch (invocation.command) {
        case "list-gpus":
          return listGpus(invocation);
        case "gpu-status":
          return gpuStatus(invocation);
        case "gpu-processes":
          return gpuProcesses(invocation);
        case "driver-version":
          return driverVersion(invocation);
        default:
          return failed(
            invocation,
            `unknown nvidia command: ${invocation.command}`,
          );
      }
    },
  };
}

async function listGpus(invocation: AdapterInvocation): Promise<AdapterResult> {
  const r = await runSmi([
    "--query-gpu=index,name,uuid,memory.total,driver_version",
    "--format=csv,noheader,nounits",
  ]);
  if (!r.ok) return rToFailed(invocation, r, "list-gpus");
  const parsed = parseCsvRows(r.stdout, [
    "index",
    "name",
    "uuid",
    "memory_total_mb",
    "driver_version",
  ]);
  return {
    invocationId: invocation.invocationId,
    adapterId: "nvidia",
    command: invocation.command,
    finishedAt: new Date().toISOString(),
    status: "success",
    summary: `${parsed.length} GPU(s)`,
    observedState: {
      count: parsed.length,
      gpus: parsed.map((row) => ({
        index: Number(row.index),
        name: row.name,
        uuid: row.uuid,
        memoryTotalMb: Number(row.memory_total_mb),
        driverVersion: row.driver_version,
      })),
    },
  };
}

async function gpuStatus(
  invocation: AdapterInvocation,
): Promise<AdapterResult> {
  const r = await runSmi([
    "--query-gpu=index,utilization.gpu,utilization.memory,memory.used,memory.total,temperature.gpu,power.draw",
    "--format=csv,noheader,nounits",
  ]);
  if (!r.ok) return rToFailed(invocation, r, "gpu-status");
  const parsed = parseCsvRows(r.stdout, [
    "index",
    "util_gpu",
    "util_mem",
    "mem_used_mb",
    "mem_total_mb",
    "temp_c",
    "power_w",
  ]);
  return {
    invocationId: invocation.invocationId,
    adapterId: "nvidia",
    command: invocation.command,
    finishedAt: new Date().toISOString(),
    status: "success",
    summary: `${parsed.length} GPU status rows`,
    observedState: {
      count: parsed.length,
      status: parsed.map((row) => ({
        index: Number(row.index),
        utilGpuPct: parseNum(row.util_gpu),
        utilMemPct: parseNum(row.util_mem),
        memUsedMb: parseNum(row.mem_used_mb),
        memTotalMb: parseNum(row.mem_total_mb),
        tempC: parseNum(row.temp_c),
        powerW: parseNum(row.power_w),
      })),
    },
  };
}

async function gpuProcesses(
  invocation: AdapterInvocation,
): Promise<AdapterResult> {
  const r = await runSmi([
    "--query-compute-apps=pid,process_name,gpu_uuid,used_memory",
    "--format=csv,noheader,nounits",
  ]);
  if (!r.ok) return rToFailed(invocation, r, "gpu-processes");
  const parsed = parseCsvRows(r.stdout, [
    "pid",
    "process_name",
    "gpu_uuid",
    "used_memory_mb",
  ]);
  return {
    invocationId: invocation.invocationId,
    adapterId: "nvidia",
    command: invocation.command,
    finishedAt: new Date().toISOString(),
    status: "success",
    summary: `${parsed.length} GPU process(es)`,
    observedState: {
      count: parsed.length,
      processes: parsed.map((row) => ({
        pid: Number(row.pid),
        processName: row.process_name,
        gpuUuid: row.gpu_uuid,
        usedMemoryMb: parseNum(row.used_memory_mb),
      })),
    },
  };
}

async function driverVersion(
  invocation: AdapterInvocation,
): Promise<AdapterResult> {
  const r = await runSmi([
    "--query-gpu=driver_version",
    "--format=csv,noheader",
  ]);
  if (!r.ok) return rToFailed(invocation, r, "driver-version");
  const first = r.stdout.trim().split("\n")[0]?.trim() ?? "";
  return {
    invocationId: invocation.invocationId,
    adapterId: "nvidia",
    command: invocation.command,
    finishedAt: new Date().toISOString(),
    status: first ? "success" : "failed",
    summary: first ? `driver ${first}` : "driver_version empty",
    observedState: { driverVersion: first },
  };
}

// --- helpers ---

interface RunResult {
  ok: boolean;
  stdout: string;
  stderr: string;
  exitCode: number | null;
  missingBinary: boolean;
  timedOut: boolean;
}

function runSmi(args: string[]): Promise<RunResult> {
  return new Promise((resolve) => {
    const proc = spawn(NVIDIA_SMI_BIN, args, { timeout: DEFAULT_TIMEOUT_MS });
    let stdout = "";
    let stderr = "";
    let missingBinary = false;
    proc.stdout?.on("data", (c: Buffer | string) => {
      stdout += typeof c === "string" ? c : c.toString("utf8");
    });
    proc.stderr?.on("data", (c: Buffer | string) => {
      stderr += typeof c === "string" ? c : c.toString("utf8");
    });
    proc.on("error", (err) => {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        missingBinary = true;
      }
      resolve({
        ok: false,
        stdout,
        stderr: `${stderr}${err.message}`,
        exitCode: null,
        missingBinary,
        timedOut: false,
      });
    });
    proc.on("close", (code, signal) => {
      resolve({
        ok: code === 0,
        stdout,
        stderr,
        exitCode: code,
        missingBinary,
        timedOut: signal === "SIGTERM" || signal === "SIGKILL",
      });
    });
  });
}

function parseCsvRows(
  text: string,
  columns: string[],
): Record<string, string>[] {
  const rows: Record<string, string>[] = [];
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const parts = trimmed.split(",").map((p) => p.trim());
    const row: Record<string, string> = {};
    for (let i = 0; i < columns.length; i++) {
      row[columns[i]!] = parts[i] ?? "";
    }
    rows.push(row);
  }
  return rows;
}

function parseNum(s: string | undefined): number | null {
  if (s === undefined) return null;
  const t = s.trim();
  if (!t || t === "[Not Supported]" || t === "N/A") return null;
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
}

function rToFailed(
  invocation: AdapterInvocation,
  r: RunResult,
  op: string,
): AdapterResult {
  const hint = r.missingBinary
    ? `nvidia-smi not found on PATH (set FRONTIER_NVIDIA_SMI_BIN, or this host has no NVIDIA GPU — normal on macOS).`
    : r.timedOut
      ? `nvidia-smi ${op} timed out after ${DEFAULT_TIMEOUT_MS}ms`
      : `nvidia-smi ${op} exit ${r.exitCode ?? "(signal)"}`;
  return {
    invocationId: invocation.invocationId,
    adapterId: "nvidia",
    command: invocation.command,
    finishedAt: new Date().toISOString(),
    status: "failed",
    summary: hint,
    observedState: {
      hint,
      missingBinary: r.missingBinary,
      stderr: r.stderr.slice(0, 1000),
      exitCode: r.exitCode,
    },
  };
}

function failed(invocation: AdapterInvocation, message: string): AdapterResult {
  return {
    invocationId: invocation.invocationId,
    adapterId: "nvidia",
    command: invocation.command,
    finishedAt: new Date().toISOString(),
    status: "failed",
    summary: message,
    observedState: { error: message },
  };
}
