import { spawnSync } from "node:child_process";
import { createConnection } from "node:net";

export interface ReadOnlyCommandResult {
  ok: boolean;
  status: number | null;
  signal: string | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  error?: string;
}

export interface ProcessInfo {
  pid: number;
  command: string;
  args: string;
}

export interface LaunchdEntry {
  label: string;
  pid: number | null;
  lastExitStatus: number | null;
}

export interface TcpPortProbe {
  host: string;
  port: number;
  open: boolean;
  status: "open" | "closed" | "unknown";
  error: string | null;
}

export function runReadOnlyCommand(
  command: string,
  args: string[],
  opts: { cwd?: string; timeoutMs?: number; env?: NodeJS.ProcessEnv } = {},
): ReadOnlyCommandResult {
  const result = spawnSync(command, args, {
    cwd: opts.cwd,
    encoding: "utf8",
    timeout: opts.timeoutMs ?? 2000,
    env: opts.env ?? process.env,
  });
  const output: ReadOnlyCommandResult = {
    ok: result.status === 0,
    status: result.status,
    signal: result.signal,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    timedOut: result.error?.message.includes("ETIMEDOUT") ?? false,
  };
  if (result.error) output.error = result.error.message;
  return output;
}

export function readProcessTable(): ProcessInfo[] {
  const result = runReadOnlyCommand("ps", ["-axo", "pid=,comm=,args="], {
    timeoutMs: 2000,
  });
  if (!result.stdout) return [];
  const processes: ProcessInfo[] = [];
  for (const line of result.stdout.split("\n")) {
    const match = line.match(/^\s*(\d+)\s+(\S+)\s*(.*)$/);
    if (!match) continue;
    const pid = Number(match[1]);
    const command = match[2] ?? "";
    const args = match[3] ?? command;
    if (!Number.isInteger(pid)) continue;
    processes.push({ pid, command, args });
  }
  return processes;
}

export function processMatches(
  processes: ProcessInfo[],
  pattern: string,
): ProcessInfo[] {
  const needle = pattern.toLowerCase();
  return processes.filter((proc) => {
    const haystack = `${proc.command} ${proc.args}`.toLowerCase();
    return haystack.includes(needle);
  });
}

export function summarizeProcesses(processes: ProcessInfo[]): ProcessInfo[] {
  return processes.map((proc) => ({
    pid: proc.pid,
    command: proc.command,
    args: proc.args.length > 240 ? `${proc.args.slice(0, 237)}...` : proc.args,
  }));
}

export function readLaunchdList(): Map<string, LaunchdEntry> {
  const result = runReadOnlyCommand("launchctl", ["list"], {
    timeoutMs: 2000,
  });
  const entries = new Map<string, LaunchdEntry>();
  if (!result.stdout) return readLaunchdGuiDomain();
  for (const line of result.stdout.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("PID\t")) continue;
    const parts = trimmed.split(/\s+/);
    const label = parts[2];
    if (!label) continue;
    const pidRaw = parts[0] ?? "-";
    const statusRaw = parts[1] ?? "-";
    const pid = pidRaw === "-" ? null : Number(pidRaw);
    const lastExitStatus = statusRaw === "-" ? null : Number(statusRaw);
    entries.set(label, {
      label,
      pid: Number.isFinite(pid) ? pid : null,
      lastExitStatus: Number.isFinite(lastExitStatus) ? lastExitStatus : null,
    });
  }
  return entries.size > 0 ? entries : readLaunchdGuiDomain();
}

function readLaunchdGuiDomain(): Map<string, LaunchdEntry> {
  const uid = typeof process.getuid === "function" ? process.getuid() : null;
  const entries = new Map<string, LaunchdEntry>();
  if (uid === null) return entries;
  const result = runReadOnlyCommand("launchctl", ["print", `gui/${uid}`], {
    timeoutMs: 3000,
  });
  if (!result.stdout) return entries;
  for (const line of result.stdout.split("\n")) {
    const match = line.match(/^\s*(\d+|-)\s+(-?\d+|-)\s+([A-Za-z0-9_.-]+)\s*$/);
    if (!match) continue;
    const label = match[3] ?? "";
    if (!label.includes(".")) continue;
    const pidRaw = match[1] ?? "-";
    const statusRaw = match[2] ?? "-";
    const pidNumber = pidRaw === "-" ? null : Number(pidRaw);
    const statusNumber = statusRaw === "-" ? null : Number(statusRaw);
    entries.set(label, {
      label,
      pid:
        pidNumber !== null && Number.isFinite(pidNumber) && pidNumber > 0
          ? pidNumber
          : null,
      lastExitStatus: Number.isFinite(statusNumber) ? statusNumber : null,
    });
  }
  return entries;
}

export function probeTcpPort(
  port: number,
  host = "127.0.0.1",
  timeoutMs = 250,
): Promise<TcpPortProbe> {
  return new Promise((resolve) => {
    const socket = createConnection({ host, port });
    let settled = false;
    const finish = (probe: TcpPortProbe): void => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(probe);
    };
    socket.setTimeout(timeoutMs);
    socket.once("connect", () => {
      finish({ host, port, open: true, status: "open", error: null });
    });
    socket.once("timeout", () => {
      finish({ host, port, open: false, status: "unknown", error: "timeout" });
    });
    socket.once("error", (err: NodeJS.ErrnoException) => {
      const status = err.code === "ECONNREFUSED" ? "closed" : "unknown";
      finish({
        host,
        port,
        open: false,
        status,
        error: err.code ?? err.message,
      });
    });
  });
}
