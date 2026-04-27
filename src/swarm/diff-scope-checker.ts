// Diff scope checker — ensures a candidate patch only touches files the
// builder was allowed to edit.
//
// Why: a model can ignore the touchList in its prompt and produce a diff
// that edits unrelated files. Each worker has an isolated worktree so it
// won't damage main, but the arbiter could still accept an overbroad
// patch as if it were the requested change. The scope checker rejects
// the candidate before `git apply` runs.
//
// Pure function — no fs, no subprocess. Inputs:
//   - the unified-diff text (post-extractor)
//   - the touchList (allowlist of file paths the builder was scoped to)
// Output:
//   - { allowed: true } when every touched file is in the touchList
//   - { allowed: false, violations, reason } when any file is out-of-scope
//
// touchList semantics:
//   - empty list → no scope (skip the gate; caller decides whether that's
//     acceptable). The swarm passes touchList only when the caller pinned
//     scope; otherwise the gate is skipped.
//   - exact paths only — no glob expansion in v1. "src/*.ts" matches
//     literally "src/*.ts", not all .ts files. Wildcards may come later
//     once we have a real corpus to test against.
//   - a/b/foo.ts in the diff matches "b/foo.ts" in touchList iff
//     touchList contains "b/foo.ts" (no implicit prefix stripping beyond
//     the unified-diff "a/" + "b/" markers, which we do strip).
//
// Defense in depth: this is in addition to per-worker worktree isolation
// and the closed-by-default PermissionGate. The skill loader's
// DEFAULT_FORBID still applies to the arbiter and any non-builder caller.

export interface ScopeViolation {
  path: string;
  reason:
    | "outside_touch_list"
    | "binary_file"
    | "absolute_path"
    | "parent_traversal";
}

export interface ScopeCheckResult {
  allowed: boolean;
  touchedFiles: string[];
  // Empty when allowed=true.
  violations: ScopeViolation[];
  // Human-readable summary for evidence packets.
  reason: string;
}

export interface ScopeCheckOptions {
  // Allowlist of file paths the builder was scoped to. Each entry is a
  // repo-relative path (e.g. "src/foo.ts"). Empty list → gate skipped.
  touchList: string[];
}

// Parse the file paths a unified diff touches. Looks for `diff --git
// a/<path> b/<path>` headers (preferred) and falls back to `--- a/<path>`
// + `+++ b/<path>` pairs. Handles file deletions (`+++ /dev/null`) and
// new files (`--- /dev/null`). Returns deduped, sorted paths.
export function parseDiffFiles(diff: string): string[] {
  if (typeof diff !== "string" || diff.length === 0) return [];
  const files = new Set<string>();

  // 1. `diff --git a/x b/x` — most reliable, present in `git diff` output.
  const gitHeaderRe = /^diff --git a\/(.+?) b\/(.+?)$/gm;
  let m: RegExpExecArray | null;
  while ((m = gitHeaderRe.exec(diff)) !== null) {
    // Both a/ and b/ should match same path for normal modifies; for
    // renames they differ — record both as touched.
    if (m[1]) files.add(m[1]);
    if (m[2]) files.add(m[2]);
  }

  // 2. `--- a/x` / `+++ b/x` — useful when no git header (e.g. plain
  // diff -u output). Skip /dev/null markers.
  if (files.size === 0) {
    const minusRe = /^---\s+a\/(.+?)$/gm;
    while ((m = minusRe.exec(diff)) !== null) {
      if (m[1] && m[1] !== "/dev/null") files.add(m[1]);
    }
    const plusRe = /^\+\+\+\s+b\/(.+?)$/gm;
    while ((m = plusRe.exec(diff)) !== null) {
      if (m[1] && m[1] !== "/dev/null") files.add(m[1]);
    }
  }

  return [...files].sort();
}

// True iff the path is dangerous regardless of touchList: absolute or
// contains a parent-traversal segment. Caught here so the touchList
// authority isn't required for these to be rejected.
function checkPathDanger(p: string): ScopeViolation["reason"] | null {
  if (p.startsWith("/")) return "absolute_path";
  // Reject `..` as a path segment. ".." prefix or `/../` interior. Catches
  // `../etc/passwd` and `src/../../../etc/passwd`.
  const segments = p.split("/");
  if (segments.includes("..")) return "parent_traversal";
  return null;
}

// True iff the path is plausibly a binary diff (`Binary files ... differ`
// or GIT binary patch markers). v1 rejects binary patches entirely; the
// review/build flow has not been validated against them.
export function diffHasBinaryMarkers(diff: string): boolean {
  return (
    /^Binary files .+ differ$/m.test(diff) || /^GIT binary patch$/m.test(diff)
  );
}

export function checkDiffScope(
  diff: string,
  opts: ScopeCheckOptions,
): ScopeCheckResult {
  const touchedFiles = parseDiffFiles(diff);

  // Empty diff → allowed but obviously useless; caller surfaces phase
  // separately. Treat as allowed=true to avoid a false negative.
  if (touchedFiles.length === 0) {
    return {
      allowed: true,
      touchedFiles,
      violations: [],
      reason: "diff is empty (no file headers parsed)",
    };
  }

  const violations: ScopeViolation[] = [];

  // Binary patch check applies regardless of touchList.
  if (diffHasBinaryMarkers(diff)) {
    for (const p of touchedFiles) {
      violations.push({ path: p, reason: "binary_file" });
    }
  }

  // Path-danger check applies regardless of touchList.
  for (const p of touchedFiles) {
    const danger = checkPathDanger(p);
    if (danger) violations.push({ path: p, reason: danger });
  }

  // touchList check only applies when caller pinned scope. Empty list =
  // skip the gate (callers without a scope pass an empty list).
  if (opts.touchList.length > 0) {
    const allowSet = new Set(opts.touchList);
    for (const p of touchedFiles) {
      if (!allowSet.has(p)) {
        violations.push({ path: p, reason: "outside_touch_list" });
      }
    }
  }

  if (violations.length === 0) {
    return {
      allowed: true,
      touchedFiles,
      violations: [],
      reason: `${touchedFiles.length} file(s) touched, all in scope`,
    };
  }

  // Build a concise reason string for evidence packets.
  const byReason: Record<string, string[]> = {};
  for (const v of violations) {
    (byReason[v.reason] ??= []).push(v.path);
  }
  const reason = Object.entries(byReason)
    .map(([r, ps]) => `${r}: ${ps.join(", ")}`)
    .join(" | ");

  return {
    allowed: false,
    touchedFiles,
    violations,
    reason,
  };
}
