import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { request } from "node:http";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";
import { spawnSync } from "node:child_process";

const REPO_ROOT = resolve(dirname(new URL(import.meta.url).pathname), "..", "..");
const HELPER_SOURCE = resolve(REPO_ROOT, "helpers", "frontier-helper", "main.swift");
const TEMPLATE_PATH = resolve(
  REPO_ROOT,
  "helpers",
  "frontier-helper",
  "com.frontier-os.helper.plist.template",
);
const STAGE_DIR = resolve(homedir(), ".frontier", "helper");
const STAGED_BINARY = resolve(STAGE_DIR, "frontier-helper");
const STAGED_PLIST = resolve(STAGE_DIR, "com.frontier-os.helper.plist");
const STAGED_INSTALL_SCRIPT = resolve(STAGE_DIR, "install-root-helper.sh");
const PRODUCTION_BINARY = "/usr/local/libexec/frontier-helper";
const PRODUCTION_PLIST = "/Library/LaunchDaemons/com.frontier-os.helper.plist";
const PRODUCTION_SOCKET = "/Library/Application Support/FrontierOS/helper.sock";

export interface HelperBuildResult {
  status: "built" | "failed";
  sourcePath: string;
  binaryPath: string;
  exitCode: number | null;
  stderr: string;
  sha256: string | null;
}

export interface HelperInstallPlan {
  service: "frontier-helper";
  mode: "plan-only";
  stageDir: string;
  stagedBinary: string;
  stagedPlist: string;
  stagedInstallScript: string;
  productionBinary: string;
  productionPlist: string;
  productionSocket: string;
  stagedBinaryExists: boolean;
  stagedBinarySha256: string | null;
  stagedPlistExists: boolean;
  installCommands: string[];
  loadCommands: string[];
  rollbackCommands: string[];
  hardening: string[];
}

export interface HelperRootInstallResult {
  status: "installed" | "failed";
  exitCode: number | null;
  stdout: string;
  stderr: string;
  scriptPath: string;
  plan: HelperInstallPlan;
}

export interface ProductionHelperStatus {
  reachable: boolean;
  socketPath: string;
  statusCode: number | null;
  body: unknown;
  error: string | null;
}

export function buildNativeHelper(): HelperBuildResult {
  mkdirSync(STAGE_DIR, { recursive: true });
  const result = spawnSync("swiftc", [HELPER_SOURCE, "-o", STAGED_BINARY], {
    encoding: "utf8",
    timeout: 60_000,
  });
  if (result.status === 0) {
    writeFileSync(STAGED_PLIST, readFileSync(TEMPLATE_PATH, "utf8"), "utf8");
  }
  return {
    status: result.status === 0 ? "built" : "failed",
    sourcePath: HELPER_SOURCE,
    binaryPath: STAGED_BINARY,
    exitCode: result.status,
    stderr: result.stderr ?? "",
    sha256: existsSync(STAGED_BINARY) ? sha256(STAGED_BINARY) : null,
  };
}

export function helperInstallPlan(): HelperInstallPlan {
  return {
    service: "frontier-helper",
    mode: "plan-only",
    stageDir: STAGE_DIR,
    stagedBinary: STAGED_BINARY,
    stagedPlist: STAGED_PLIST,
    stagedInstallScript: STAGED_INSTALL_SCRIPT,
    productionBinary: PRODUCTION_BINARY,
    productionPlist: PRODUCTION_PLIST,
    productionSocket: PRODUCTION_SOCKET,
    stagedBinaryExists: existsSync(STAGED_BINARY),
    stagedBinarySha256: existsSync(STAGED_BINARY) ? sha256(STAGED_BINARY) : null,
    stagedPlistExists: existsSync(STAGED_PLIST),
    installCommands: [
      "sudo mkdir -p /usr/local/libexec '/Library/Application Support/FrontierOS'",
      `sudo install -o root -g wheel -m 755 ${STAGED_BINARY} ${PRODUCTION_BINARY}`,
      `sudo install -o root -g wheel -m 644 ${STAGED_PLIST} ${PRODUCTION_PLIST}`,
      `sudo plutil -lint ${PRODUCTION_PLIST}`,
    ],
    loadCommands: [
      `sudo launchctl bootstrap system ${PRODUCTION_PLIST}`,
      "sudo launchctl print system/com.frontier-os.helper",
    ],
    rollbackCommands: [
      "sudo launchctl bootout system/com.frontier-os.helper",
      `sudo rm -f ${PRODUCTION_PLIST}`,
      `sudo rm -f ${PRODUCTION_BINARY}`,
      `sudo rm -f '${PRODUCTION_SOCKET}'`,
    ],
    hardening: [
      "No arbitrary command verb.",
      "Root install is explicit; CLI only emits commands.",
      "LaunchDaemon plist is static and lintable before install.",
      "Native helper is staged under ~/.frontier/helper before any sudo step.",
      "Policy approval remains required for class-2+ helper verbs.",
    ],
  };
}

export function writeRootInstallScript(): string {
  mkdirSync(STAGE_DIR, { recursive: true });
  const script = `#!/bin/sh
set -eu
mkdir -p /usr/local/libexec '/Library/Application Support/FrontierOS'
install -o root -g wheel -m 755 ${shellQuote(STAGED_BINARY)} ${shellQuote(PRODUCTION_BINARY)}
install -o root -g wheel -m 644 ${shellQuote(STAGED_PLIST)} ${shellQuote(PRODUCTION_PLIST)}
plutil -lint ${shellQuote(PRODUCTION_PLIST)}
launchctl bootout system/com.frontier-os.helper >/dev/null 2>&1 || true
rm -f ${shellQuote(PRODUCTION_SOCKET)}
launchctl bootstrap system ${shellQuote(PRODUCTION_PLIST)}
launchctl kickstart -k system/com.frontier-os.helper
launchctl print system/com.frontier-os.helper
`;
  writeFileSync(STAGED_INSTALL_SCRIPT, script, "utf8");
  chmodSync(STAGED_INSTALL_SCRIPT, 0o755);
  return STAGED_INSTALL_SCRIPT;
}

export function applyRootInstallViaOsascript(): HelperRootInstallResult {
  buildNativeHelper();
  const scriptPath = writeRootInstallScript();
  const appleScript = `do shell script ${JSON.stringify(
    `/bin/sh ${shellQuote(scriptPath)}`,
  )} with administrator privileges`;
  const result = spawnSync("osascript", ["-e", appleScript], {
    encoding: "utf8",
    timeout: 300_000,
  });
  return {
    status: result.status === 0 ? "installed" : "failed",
    exitCode: result.status,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? result.error?.message ?? "",
    scriptPath,
    plan: helperInstallPlan(),
  };
}

export async function requestProductionHelper(
  path = "/health",
  timeoutMs = 2000,
): Promise<ProductionHelperStatus> {
  return new Promise((resolveStatus) => {
    const req = request(
      {
        socketPath: PRODUCTION_SOCKET,
        path,
        method: "GET",
        timeout: timeoutMs,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf8");
          let body: unknown = text;
          try {
            body = text ? JSON.parse(text) : null;
          } catch {
            body = text;
          }
          resolveStatus({
            reachable: true,
            socketPath: PRODUCTION_SOCKET,
            statusCode: res.statusCode ?? null,
            body,
            error: null,
          });
        });
      },
    );
    req.on("timeout", () => {
      req.destroy(new Error("timeout"));
    });
    req.on("error", (err) => {
      resolveStatus({
        reachable: false,
        socketPath: PRODUCTION_SOCKET,
        statusCode: null,
        body: null,
        error: err.message,
      });
    });
    req.end();
  });
}

function sha256(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}
