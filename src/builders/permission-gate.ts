// Per-builder permission gate. Wraps a Skill (from src/skills/loader.ts)
// and a worktree path. Decides whether a worker's tool request is allowed
// under the skill's contract AND the runtime invariants we never want to
// violate (no writes outside the worktree, no main-worktree mutation).
//
// Pure logic — no fs, no subprocess. R3/R5 will integrate this into a
// real tool dispatcher; for now it's the contract everything else cites.
//
// Three-layer check:
//   1. forbiddenTools (deny first — wins over allow)
//   2. allowedTools (closed-by-default — tool not in either list is denied)
//   3. tool-specific argument check (filesystem scope, command class)
//
// Future extensions (not in v1):
//   - egress whitelist for read.web (needs a network mediator)
//   - per-MCP-tool enforcement (needs MCP runtime hooks)

import { resolve, sep } from "node:path";

import type { Skill } from "../skills/loader.ts";

export interface ToolRequest {
  // Verb from skills/README.md tool vocabulary.
  tool: string;
  // For filesystem tools (read.file, write.worktree): the path being
  // touched. Absolute or repo-relative.
  path?: string;
  // For exec.shell.* tools: the command being run. Used for the
  // closed-by-default check.
  command?: string;
}

export interface PermissionDecision {
  allowed: boolean;
  reason: string;
}

export interface PermissionGateOptions {
  skill: Skill;
  worktreePath: string;
  // Optional extra paths the worker may write to (e.g. a scratch dir).
  // Worktree path is always allowed.
  extraWritablePaths?: string[];
}

export class PermissionGate {
  readonly skill: Skill;
  readonly worktreePath: string;
  readonly writablePaths: string[];

  constructor(opts: PermissionGateOptions) {
    this.skill = opts.skill;
    this.worktreePath = resolve(opts.worktreePath);
    this.writablePaths = [
      this.worktreePath,
      ...(opts.extraWritablePaths ?? []).map((p) => resolve(p)),
    ];
  }

  check(req: ToolRequest): PermissionDecision {
    // Layer 1 — forbidden wins.
    if (this.skill.forbiddenTools.includes(req.tool)) {
      return {
        allowed: false,
        reason: `tool "${req.tool}" is in forbiddenTools for skill ${this.skill.skillId}`,
      };
    }

    // Layer 2 — closed-by-default.
    if (!this.skill.allowedTools.includes(req.tool)) {
      return {
        allowed: false,
        reason: `tool "${req.tool}" not in allowedTools for skill ${this.skill.skillId}`,
      };
    }

    // Layer 3 — tool-specific argument check.
    if (req.tool === "write.worktree") {
      if (req.path === undefined) {
        return {
          allowed: false,
          reason: "write.worktree requires a path",
        };
      }
      if (!this.isInsideWritablePath(req.path)) {
        return {
          allowed: false,
          reason: `write.worktree path "${req.path}" is outside ${this.worktreePath}`,
        };
      }
    }

    if (req.tool.startsWith("exec.shell.")) {
      // exec.shell.read|write are gated by the allow/forbid lists above —
      // by here they're allowed. We don't introspect the command yet
      // (would need a parser per shell).
    }

    return {
      allowed: true,
      reason: `tool "${req.tool}" allowed under skill ${this.skill.skillId}`,
    };
  }

  // True iff `target` resolves LEXICALLY inside one of the writable roots.
  //
  // ⚠️ WARNING: this is a LEXICAL prefix check only. It does NOT protect
  // against symlink exfiltration. A path like
  //   /tmp/wt-1/link-out/file.ts
  // resolves syntactically inside /tmp/wt-1/ but, if `link-out` is a
  // symlink to /tmp/elsewhere/, the actual write lands outside the
  // worktree. The prefix-substring guard (`+ sep`) only stops the
  // /tmp/wt-1-other lookalike attack.
  //
  // v1 PermissionGate is a POLICY DECLARATION, not a runtime sandbox.
  // The current builder swarm never invokes this gate before a
  // filesystem mutation (it applies diffs via `git apply`, which has
  // its own --check). Any future caller that uses this for *real* write
  // authority MUST add an lstat/realpath check on every parent directory
  // in the path, or run the writer in a sandbox (chroot, namespace, etc.).
  // Without that, a malicious or accidental symlink in the worktree
  // can escape.
  //
  // Tracking: see `docs/architecture-review-brief-2026-04-26.md` § Q3
  // and the GPT Pro review (Issue #6) for context.
  isInsideWritablePath(target: string): boolean {
    const abs = resolve(target);
    for (const root of this.writablePaths) {
      if (abs === root) return true;
      if (abs.startsWith(root + sep)) return true;
    }
    return false;
  }
}
