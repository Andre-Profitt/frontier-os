import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";

import { defaultDaemonSocketPath } from "./server.ts";

export const FRONTIERD_LAUNCH_AGENT_LABEL = "com.frontier-os.frontierd";

export interface FrontierdLaunchAgentOptions {
  frontierBinPath?: string;
  socketPath?: string;
  repoRoot?: string;
  logDir?: string;
  launchAgentsDir?: string;
}

export interface FrontierdLaunchAgentPaths {
  label: string;
  plistPath: string;
  socketPath: string;
  outLogPath: string;
  errLogPath: string;
  repoRoot: string;
  frontierBinPath: string;
  launchAgentsDir: string;
  logDir: string;
}

export interface FrontierdInstallResult extends FrontierdLaunchAgentPaths {
  status: "dry_run" | "plist_written";
  alreadyInstalled: boolean;
  plist: string;
  loadCommand: string;
  unloadCommand: string;
  kickstartCommand: string;
}

function xmlEscape(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function userDomain(): string {
  return `gui/${process.getuid?.() ?? "$(id -u)"}`;
}

export function frontierdLaunchAgentPaths(
  options: FrontierdLaunchAgentOptions = {},
): FrontierdLaunchAgentPaths {
  const home = homedir();
  const repoRoot = options.repoRoot ?? resolve(home, "frontier-os");
  const frontierBinPath =
    options.frontierBinPath ?? resolve(repoRoot, "bin", "frontier");
  const socketPath = options.socketPath ?? defaultDaemonSocketPath();
  const logDir = options.logDir ?? resolve(home, "Library", "Logs", "frontier-os");
  const launchAgentsDir =
    options.launchAgentsDir ?? resolve(home, "Library", "LaunchAgents");
  const plistPath = resolve(
    launchAgentsDir,
    `${FRONTIERD_LAUNCH_AGENT_LABEL}.plist`,
  );
  return {
    label: FRONTIERD_LAUNCH_AGENT_LABEL,
    plistPath,
    socketPath,
    outLogPath: resolve(logDir, "frontierd.out.log"),
    errLogPath: resolve(logDir, "frontierd.err.log"),
    repoRoot,
    frontierBinPath,
    launchAgentsDir,
    logDir,
  };
}

export function generateFrontierdLaunchAgentPlist(
  options: FrontierdLaunchAgentOptions = {},
): string {
  const paths = frontierdLaunchAgentPaths(options);
  const args = [
    paths.frontierBinPath,
    "daemon",
    "run",
    "--foreground",
    "--socket",
    paths.socketPath,
  ];
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

export function installFrontierdLaunchAgent(
  options: FrontierdLaunchAgentOptions & { dryRun?: boolean } = {},
): FrontierdInstallResult {
  const paths = frontierdLaunchAgentPaths(options);
  const plist = generateFrontierdLaunchAgentPlist(options);
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
