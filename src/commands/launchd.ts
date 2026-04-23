import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";

export const COMMAND_WORKER_LAUNCH_AGENT_LABEL =
  "com.frontier-os.command-worker";

export interface CommandWorkerLaunchAgentOptions {
  frontierBinPath?: string;
  repoRoot?: string;
  logDir?: string;
  launchAgentsDir?: string;
  workerId?: string;
  intervalMs?: number;
  maxRuntimeMs?: number;
  idleExitMs?: number;
  maxCommands?: number;
  maxApprovalClass?: 0 | 1 | 2 | 3;
}

export interface CommandWorkerLaunchAgentPaths {
  label: string;
  plistPath: string;
  outLogPath: string;
  errLogPath: string;
  repoRoot: string;
  frontierBinPath: string;
  launchAgentsDir: string;
  logDir: string;
}

export interface CommandWorkerInstallResult
  extends CommandWorkerLaunchAgentPaths {
  status: "dry_run" | "plist_written";
  alreadyInstalled: boolean;
  plist: string;
  loadCommand: string;
  unloadCommand: string;
  kickstartCommand: string;
}

export function commandWorkerLaunchAgentPaths(
  options: CommandWorkerLaunchAgentOptions = {},
): CommandWorkerLaunchAgentPaths {
  const home = homedir();
  const repoRoot = options.repoRoot ?? resolve(home, "frontier-os");
  const frontierBinPath =
    options.frontierBinPath ?? resolve(repoRoot, "bin", "frontier");
  const logDir = options.logDir ?? resolve(home, "Library", "Logs", "frontier-os");
  const launchAgentsDir =
    options.launchAgentsDir ?? resolve(home, "Library", "LaunchAgents");
  const plistPath = resolve(
    launchAgentsDir,
    `${COMMAND_WORKER_LAUNCH_AGENT_LABEL}.plist`,
  );
  return {
    label: COMMAND_WORKER_LAUNCH_AGENT_LABEL,
    plistPath,
    outLogPath: resolve(logDir, "command-worker.out.log"),
    errLogPath: resolve(logDir, "command-worker.err.log"),
    repoRoot,
    frontierBinPath,
    launchAgentsDir,
    logDir,
  };
}

export function generateCommandWorkerLaunchAgentPlist(
  options: CommandWorkerLaunchAgentOptions = {},
): string {
  const paths = commandWorkerLaunchAgentPaths(options);
  const args = [
    paths.frontierBinPath,
    "command",
    "worker",
    "run",
    "--loop",
    "--worker-id",
    options.workerId ?? "launchd-command-worker",
    "--interval-ms",
    String(options.intervalMs ?? 5_000),
    "--max-runtime-ms",
    String(options.maxRuntimeMs ?? 8 * 60 * 60 * 1000),
    "--max-approval-class",
    String(options.maxApprovalClass ?? 1),
    "--json",
    "--local",
  ];
  if (options.idleExitMs !== undefined) {
    args.push("--idle-exit-ms", String(options.idleExitMs));
  }
  if (options.maxCommands !== undefined) {
    args.push("--max-commands", String(options.maxCommands));
  }

  const argsXml = args
    .map((arg) => `    <string>${xmlEscape(arg)}</string>`)
    .join("\n");
  const pathEnv = [
    resolve(homedir(), "bin"),
    "/opt/homebrew/bin",
    "/usr/local/bin",
    "/usr/bin",
    "/bin",
    "/usr/sbin",
    "/sbin",
  ].join(":");

  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${xmlEscape(paths.label)}</string>
  <key>ProgramArguments</key>
  <array>
${argsXml}
  </array>
  <key>WorkingDirectory</key>
  <string>${xmlEscape(paths.repoRoot)}</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>${xmlEscape(pathEnv)}</string>
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <dict>
    <key>SuccessfulExit</key>
    <false/>
  </dict>
  <key>StandardOutPath</key>
  <string>${xmlEscape(paths.outLogPath)}</string>
  <key>StandardErrorPath</key>
  <string>${xmlEscape(paths.errLogPath)}</string>
</dict>
</plist>
`;
}

export function installCommandWorkerLaunchAgent(
  options: CommandWorkerLaunchAgentOptions & { dryRun?: boolean } = {},
): CommandWorkerInstallResult {
  const paths = commandWorkerLaunchAgentPaths(options);
  const plist = generateCommandWorkerLaunchAgentPlist(options);
  const dryRun = options.dryRun === true;
  const alreadyInstalled = existsSync(paths.plistPath);
  if (!dryRun) {
    mkdirSync(paths.logDir, { recursive: true });
    mkdirSync(paths.launchAgentsDir, { recursive: true });
    writeFileSync(paths.plistPath, plist, "utf8");
  }
  const domain = userDomain();
  return {
    ...paths,
    status: dryRun ? "dry_run" : "plist_written",
    alreadyInstalled,
    plist,
    loadCommand: `launchctl bootstrap ${domain} ${paths.plistPath}`,
    unloadCommand: `launchctl bootout ${domain} ${paths.plistPath}`,
    kickstartCommand: `launchctl kickstart -k ${domain}/${paths.label}`,
  };
}

function userDomain(): string {
  return `gui/${process.getuid?.() ?? "$(id -u)"}`;
}

function xmlEscape(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}
