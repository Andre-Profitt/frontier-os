// Static classification of common command heads → side-effect class.
//
// This is the hand-rolled allowlist the lift manifest called for: no OSS
// library does side-effect classification well, so we own a small deterministic
// map + a regex for "obviously destructive" flags. Operators extend this as
// new commands show up in the ledger's work-graph runs.
//
// Policy: if a command head isn't in the map AND isn't obviously destructive,
// default to `local_write` (the safer class 1 stance). Unknown commands
// go through approval-class 1, not class 0 — matches "trust but verify."

import type { SideEffectClass } from "../../schemas.ts";

const READ_ONLY_HEADS = new Set([
  "ls",
  "pwd",
  "cat",
  "head",
  "tail",
  "less",
  "grep",
  "rg",
  "find",
  "file",
  "stat",
  "wc",
  "which",
  "type",
  "whereis",
  "env",
  "printenv",
  "echo",
  "printf",
  "date",
  "uname",
  "hostname",
  "ps",
  "df",
  "du",
  "uptime",
  "who",
  "whoami",
  "id",
  "jq",
  "awk",
  "sed", // sed is read-only unless given -i
  "sort",
  "uniq",
  "cut",
  "tr",
  "diff",
  "cmp",
  "sha1sum",
  "sha256sum",
  "md5",
]);

const LOCAL_WRITE_HEADS = new Set([
  "cp",
  "mv",
  "mkdir",
  "touch",
  "chmod",
  "chown",
  "ln",
  "tar",
  "zip",
  "unzip",
  "gzip",
  "gunzip",
  "make",
  "cmake",
  "ninja",
  "go",
  "cargo",
  "npm",
  "pnpm",
  "yarn",
  "bun",
  "uv",
  "pip",
  "pipx",
  "brew",
  "swift",
  "xcodebuild",
  "pytest",
  "jest",
  "vitest",
]);

const REPO_WRITE_HEADS = new Set([
  "git", // discriminated below — some git subcommands are read-only
]);

const SHARED_WRITE_HEADS = new Set([
  // write to targets users share: databases, remote caches, etc.
  "psql",
  "mysql",
  "sqlite3",
  "redis-cli",
  "mongo",
  "mongosh",
]);

const BILLABLE_HEADS = new Set([
  // spawns cost or external jobs
  "aws",
  "az",
  "gcloud",
  "kubectl",
  "helm",
  "runpodctl",
  "modal",
  "databricks",
  "sf", // Salesforce CLI — writes often hit prod
]);

const DESTRUCTIVE_HEADS = new Set(["rm", "rmdir", "dd", "mkfs", "shred"]);

const DESTRUCTIVE_FLAGS = /(^|\s)(--force|-f|--hard|--no-verify|--purge)(\s|$)/;

/**
 * Git subcommand classification — most git ops are repo-write, some are
 * strictly read-only, and a handful (push --force, reset --hard) escalate.
 */
function classifyGit(args: string[]): SideEffectClass {
  const sub = args[0] ?? "";
  if (
    [
      "status",
      "log",
      "diff",
      "show",
      "blame",
      "branch",
      "tag",
      "remote",
      "rev-parse",
      "rev-list",
      "ls-files",
      "ls-tree",
      "fetch",
      "config",
      "describe",
    ].includes(sub)
  ) {
    // `git fetch` and `git config -l` are read-only in practice.
    return sub === "config" && args.includes("--set") ? "shared_write" : "none";
  }
  if (sub === "push") {
    const hasForce = args.some(
      (a) => a === "-f" || a === "--force" || a === "--force-with-lease",
    );
    return hasForce ? "destructive_action" : "shared_write";
  }
  if (sub === "reset" && args.includes("--hard")) return "destructive_action";
  if (sub === "clean" && (args.includes("-f") || args.includes("-fd"))) {
    return "destructive_action";
  }
  if (
    [
      "commit",
      "add",
      "rm",
      "mv",
      "stash",
      "merge",
      "rebase",
      "cherry-pick",
      "revert",
    ].includes(sub)
  ) {
    return "repo_write";
  }
  if (sub === "checkout" || sub === "switch") return "repo_write";
  return "repo_write";
}

export interface ClassifyInput {
  command: string;
  args: string[];
}

export interface Classification {
  sideEffectClass: SideEffectClass;
  reason: string;
  head: string;
}

/**
 * Classify a command + args into a SideEffectClass.
 * Resolution order:
 *   1. Destructive head → destructive_action
 *   2. Head in known map → mapped class (with git/sed discriminators)
 *   3. Destructive flag anywhere → destructive_action
 *   4. Unknown head → local_write (safe default for class 1)
 */
export function classifyCommand({
  command,
  args,
}: ClassifyInput): Classification {
  const head = basename(command);
  const joined = [command, ...args].join(" ");

  if (DESTRUCTIVE_HEADS.has(head)) {
    return {
      sideEffectClass: "destructive_action",
      reason: `head "${head}" is in destructive allowlist`,
      head,
    };
  }
  if (head === "git") {
    return {
      sideEffectClass: classifyGit(args),
      reason: `git subcommand "${args[0] ?? ""}"`,
      head,
    };
  }
  if (head === "sed") {
    const inplace = args.some((a) => a === "-i" || a.startsWith("-i"));
    return {
      sideEffectClass: inplace ? "local_write" : "none",
      reason: inplace ? "sed with -i (in-place write)" : "sed read-only",
      head,
    };
  }
  if (READ_ONLY_HEADS.has(head)) {
    return {
      sideEffectClass: "none",
      reason: `head "${head}" read-only`,
      head,
    };
  }
  if (BILLABLE_HEADS.has(head)) {
    return {
      sideEffectClass: "billable_action",
      reason: `head "${head}" hits a billable SaaS`,
      head,
    };
  }
  if (SHARED_WRITE_HEADS.has(head)) {
    return {
      sideEffectClass: "shared_write",
      reason: `head "${head}" writes to shared state`,
      head,
    };
  }
  if (LOCAL_WRITE_HEADS.has(head)) {
    return {
      sideEffectClass: "local_write",
      reason: `head "${head}" writes locally`,
      head,
    };
  }
  if (REPO_WRITE_HEADS.has(head)) {
    return {
      sideEffectClass: "repo_write",
      reason: `head "${head}" writes repo state`,
      head,
    };
  }
  if (DESTRUCTIVE_FLAGS.test(joined)) {
    return {
      sideEffectClass: "destructive_action",
      reason: `destructive flag detected: ${joined.match(DESTRUCTIVE_FLAGS)?.[0]?.trim()}`,
      head,
    };
  }
  return {
    sideEffectClass: "local_write",
    reason: `unknown head "${head}"; default = local_write (safe class 1)`,
    head,
  };
}

function basename(command: string): string {
  const parts = command.split("/");
  return parts[parts.length - 1] ?? command;
}
