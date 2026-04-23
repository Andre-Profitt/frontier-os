import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { getLedger } from "../ledger/index.ts";
import type { EventKind } from "../ledger/events.ts";
import {
  buildActionEnvelope,
  evaluatePolicyAction,
  type ApprovalClass,
  type PolicyDecision,
} from "../policy/evaluator.ts";
import { readLaunchdList, runReadOnlyCommand } from "../system/probes.ts";

export interface HelperStatus {
  service: "frontier-helper";
  mode: "simulated-user-cli" | "production-root-launchdaemon";
  installed: boolean;
  loaded: boolean;
  pid: number | null;
  lastExitStatus: number | null;
  launchDaemonPath: string;
  socketPath: string;
  templatePath: string;
  templateExists: boolean;
  allowedVerbs: string[];
  allowedLabels: string[];
  allowedRoots: string[];
}

export interface HelperInvokeOptions {
  verb: string;
  label?: string;
  path?: string;
  tailBytes?: number;
  traceId?: string;
  consumeApproval?: boolean;
}

export interface HelperInvokeResult {
  status: "allowed" | "denied";
  verb: string;
  traceId: string;
  decision: PolicyDecision;
  output: unknown;
  error: string | null;
}

export interface HelperSelfTestResult {
  status: "ok" | "failed";
  generatedAt: string;
  passed: number;
  failed: number;
  cases: Array<{
    name: string;
    ok: boolean;
    expected: "allowed" | "denied";
    actual: "allowed" | "denied";
    error: string | null;
  }>;
}

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const REPO_ROOT = resolve(__dirname, "..", "..");
const HELPER_LABEL = "com.frontier-os.helper";
const LAUNCH_DAEMON_PATH = "/Library/LaunchDaemons/com.frontier-os.helper.plist";
const SOCKET_PATH = "/Library/Application Support/FrontierOS/helper.sock";
const TEMPLATE_PATH = resolve(
  REPO_ROOT,
  "helpers",
  "frontier-helper",
  "com.frontier-os.helper.plist.template",
);

const ALLOWED_LABELS = [
  "ai.companion.platform.runtime",
  "com.frontier-os.frontierd",
  "com.frontier-os.ghost-shift",
  "com.frontier-os.nightly-research-enqueue",
  "com.frontier-os.overnight-review",
  "com.frontier-os.runpod-idle-killer",
  "com.frontier-os.work-radar",
];

const ALLOWED_ROOTS = [
  "/Users/test/.frontier",
  "/Users/test/Library/Logs/frontier-os",
  "/Users/test/code",
  "/Users/test/crm-analytics",
  "/Users/test/frontier-os",
];

const VERB_CLASSES: Record<string, ApprovalClass> = {
  "helper.status": 0,
  "launchd.status": 0,
  "logs.read": 0,
  "network.status": 0,
  "launchd.load": 2,
  "launchd.unload": 2,
  "port.kill": 2,
  "fs.fixOwnership": 2,
  "service.restart": 3,
};

export function helperStatus(): HelperStatus {
  const loaded = helperLaunchDaemonStatus();
  return {
    service: "frontier-helper",
    mode: loaded !== null ? "production-root-launchdaemon" : "simulated-user-cli",
    installed: existsSync(LAUNCH_DAEMON_PATH),
    loaded: loaded !== null,
    pid: loaded?.pid ?? null,
    lastExitStatus: loaded?.lastExitStatus ?? null,
    launchDaemonPath: LAUNCH_DAEMON_PATH,
    socketPath: SOCKET_PATH,
    templatePath: TEMPLATE_PATH,
    templateExists: existsSync(TEMPLATE_PATH),
    allowedVerbs: Object.keys(VERB_CLASSES).sort(),
    allowedLabels: [...ALLOWED_LABELS],
    allowedRoots: [...ALLOWED_ROOTS],
  };
}

export async function invokeHelper(
  options: HelperInvokeOptions,
): Promise<HelperInvokeResult> {
  const traceId =
    options.traceId ??
    `helper-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  const approvalClass = VERB_CLASSES[options.verb] ?? 3;
  const action = buildActionEnvelope({
    actor: "helper",
    source: "helper",
    projectId: "frontier-os",
    verb: options.verb,
    arguments: helperArguments(options),
    approvalClass,
    traceId,
  });
  appendHelperEvent("helper.request", traceId, {
    verb: options.verb,
    arguments: action.arguments,
    approvalClass,
  });

  const staticDenial = staticDenyReason(options);
  const evaluation = staticDenial
    ? {
        action,
        decision: {
          status: "deny" as const,
          reason: staticDenial,
          approvalRequired: approvalClass >= 2,
          consumedApproval: null,
        },
        policy: {
          policyId: "helper-static-allowlist",
          version: "v1",
          classRule: "helper_allowlist",
        },
      }
    : evaluatePolicyAction(action, {
        consumeApproval: options.consumeApproval === true,
      });

  if (evaluation.decision.status !== "allow") {
    appendHelperEvent("helper.denied", traceId, {
      verb: options.verb,
      decision: evaluation.decision,
    });
    return {
      status: "denied",
      verb: options.verb,
      traceId,
      decision: evaluation.decision,
      output: null,
      error: evaluation.decision.reason,
    };
  }

  const output = await executeAllowedVerb(options);
  appendHelperEvent("helper.allowed", traceId, {
    verb: options.verb,
    decision: evaluation.decision,
  });
  appendHelperEvent("helper.result", traceId, {
    verb: options.verb,
    output,
  });
  return {
    status: "allowed",
    verb: options.verb,
    traceId,
    decision: evaluation.decision,
    output,
    error: null,
  };
}

export async function helperSelfTest(): Promise<HelperSelfTestResult> {
  const tests: Array<{
    name: string;
    expected: "allowed" | "denied";
    options: HelperInvokeOptions;
  }> = [
    {
      name: "helper status allowed",
      expected: "allowed",
      options: { verb: "helper.status" },
    },
    {
      name: "frontierd launchd status allowed",
      expected: "allowed",
      options: { verb: "launchd.status", label: "com.frontier-os.frontierd" },
    },
    {
      name: "non-allowlisted label denied",
      expected: "denied",
      options: { verb: "launchd.status", label: "com.apple.WindowServer" },
    },
    {
      name: "arbitrary command denied",
      expected: "denied",
      options: { verb: "run-command" },
    },
    {
      name: "class-3 restart denied",
      expected: "denied",
      options: { verb: "service.restart", label: "com.frontier-os.frontierd" },
    },
  ];

  const cases: HelperSelfTestResult["cases"] = [];
  for (const test of tests) {
    try {
      const result = await invokeHelper(test.options);
      cases.push({
        name: test.name,
        ok: result.status === test.expected,
        expected: test.expected,
        actual: result.status,
        error: result.error,
      });
    } catch (e) {
      cases.push({
        name: test.name,
        ok: false,
        expected: test.expected,
        actual: "denied",
        error: e instanceof Error ? e.message : String(e),
      });
    }
  }
  const failed = cases.filter((test) => !test.ok).length;
  return {
    status: failed === 0 ? "ok" : "failed",
    generatedAt: new Date().toISOString(),
    passed: cases.length - failed,
    failed,
    cases,
  };
}

async function executeAllowedVerb(options: HelperInvokeOptions): Promise<unknown> {
  switch (options.verb) {
    case "helper.status":
      return helperStatus();
    case "launchd.status":
      return launchdStatus(options.label ?? "");
    case "logs.read":
      return readLogTail(options.path ?? "", options.tailBytes ?? 4096);
    case "network.status": {
      const result = runReadOnlyCommand("scutil", ["--nwi"], {
        timeoutMs: 2000,
      });
      return {
        ok: result.ok,
        status: result.status,
        stdout: result.stdout,
        stderr: result.stderr,
      };
    }
    default:
      throw new Error(`helper verb is not executable in simulator: ${options.verb}`);
  }
}

function launchdStatus(label: string): unknown {
  const launchd = readLaunchdList();
  const entry = launchd.get(label) ?? null;
  return {
    label,
    allowlisted: ALLOWED_LABELS.includes(label),
    loaded: entry !== null,
    pid: entry?.pid ?? null,
    lastExitStatus: entry?.lastExitStatus ?? null,
  };
}

function helperLaunchDaemonStatus(): { pid: number | null; lastExitStatus: number | null } | null {
  if (!existsSync(LAUNCH_DAEMON_PATH)) return null;
  const result = runReadOnlyCommand(
    "launchctl",
    ["print", `system/${HELPER_LABEL}`],
    { timeoutMs: 2000 },
  );
  if (!result.ok) return null;
  const pidMatch = result.stdout.match(/^\s*pid = (\d+)/m);
  const exitMatch = result.stdout.match(/^\s*last exit code = (-?\d+)/m);
  return {
    pid: pidMatch ? Number(pidMatch[1]) : null,
    lastExitStatus: exitMatch ? Number(exitMatch[1]) : 0,
  };
}

function readLogTail(path: string, tailBytes: number): unknown {
  const resolved = resolve(path);
  const maxBytes = Math.min(Math.max(tailBytes, 1), 65_536);
  const stat = statSync(resolved);
  const contents = readFileSync(resolved, "utf8");
  return {
    path: resolved,
    sizeBytes: stat.size,
    returnedBytes: Math.min(Buffer.byteLength(contents), maxBytes),
    text: contents.slice(-maxBytes),
  };
}

function staticDenyReason(options: HelperInvokeOptions): string | null {
  if (!(options.verb in VERB_CLASSES)) {
    return `helper verb is not allowlisted: ${options.verb}`;
  }
  if (
    (options.verb === "launchd.status" ||
      options.verb === "launchd.load" ||
      options.verb === "launchd.unload" ||
      options.verb === "service.restart") &&
    (!options.label || !ALLOWED_LABELS.includes(options.label))
  ) {
    return `launchd label is not allowlisted: ${options.label ?? "(none)"}`;
  }
  if (options.verb === "logs.read") {
    if (!options.path) return "logs.read requires --path";
    const resolved = resolve(options.path);
    if (!ALLOWED_ROOTS.some((root) => isPathWithin(resolved, root))) {
      return `path is outside helper allowlisted roots: ${resolved}`;
    }
    if (!existsSync(resolved)) return `path does not exist: ${resolved}`;
  }
  return null;
}

function helperArguments(options: HelperInvokeOptions): Record<string, unknown> {
  const args: Record<string, unknown> = {};
  if (options.label !== undefined) args.label = options.label;
  if (options.path !== undefined) args.path = options.path;
  if (options.tailBytes !== undefined) args.tailBytes = options.tailBytes;
  return args;
}

function isPathWithin(path: string, root: string): boolean {
  const resolvedRoot = resolve(root);
  return path === resolvedRoot || path.startsWith(`${resolvedRoot}/`);
}

function appendHelperEvent(
  kind: Extract<
    EventKind,
    "helper.request" | "helper.allowed" | "helper.denied" | "helper.result"
  >,
  traceId: string,
  payload: Record<string, unknown>,
): void {
  const ledger = getLedger();
  const sessionId = `helper-simulator-${traceId}`;
  ledger.ensureSession({
    sessionId,
    label: "helper-simulator",
    tags: ["helper", "policy"],
  });
  ledger.appendEvent({
    sessionId,
    kind,
    actor: "helper",
    traceId,
    payload,
  });
}
