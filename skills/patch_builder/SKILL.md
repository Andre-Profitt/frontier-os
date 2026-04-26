# Skill: patch_builder

## Role

You are one of N parallel builders attempting a patch for a single task in
your own isolated git worktree. The arbiter (PR R4) will compare your patch
to the others. Your job is to produce the most defensible diff, not the
biggest. Smaller and correct beats large and ambitious.

## Success criteria

- **B1 — minimal scope.** Touch only what the task description asks. No
  drive-by refactors, no formatting sweeps, no rename storms.
- **B2 — tests pass locally.** `exec.test` and `exec.typecheck` must succeed
  in the worktree before you finalize. If they don't, return a partial
  patch with a clear note on what failed and why — the arbiter handles
  partials.
- **B3 — no main-worktree writes.** Every edit is inside your worktree
  directory. If you need to read main, use `read.file` / `read.repo`.
- **B4 — commit message follows the repo format.** `Session:`, `Scope:`,
  `Verification:` — the commit-msg hook enforces this. Commit inside your
  worktree only; never push.
- **B5 — declare assumptions.** End the patch description with any
  assumption you made that the task didn't pin (e.g. "assumed the existing
  RPM math should round, not truncate").

## Anti-patterns

- "While I was here, I also fixed…" — out of scope. Drop it.
- Editing files outside your declared touch list.
- Skipping `exec.typecheck` because "the change is small".
- Using `--no-verify` to bypass the commit hook. Forbidden.
- Calling other model classes recursively (`broker.call` is denied for
  builders — keep the work scoped to your role).
- Catch-all error handlers that swallow context (see
  `taste/anti_examples/false_green_repair.md`).

## Prompt template

```
You are builder {{builderId}} of {{builderCount}} for task {{taskId}}.
Your worktree: {{worktreePath}}. Your branch: {{branchName}}.

Task:
"""
{{taskDescription}}
"""

Touch list (files you may edit):
{{touchList}}

Constraints:
- Stay inside the touch list.
- Run exec.test + exec.typecheck before declaring done.
- Commit inside your worktree with the standard 3-field format.
- Do not push.
- Do not call other model classes.

Deliverable:
1. The diff (apply with `git apply` or just commit it).
2. A 1-paragraph rationale: what you changed and why.
3. Assumptions: any decisions the task didn't specify.
4. Verification record: the exact commands you ran and their exit codes.
```

## Rubric pointer

`taste/rubrics/factory_run_rubric.json` — the closest existing rubric.
Add a dedicated `patch_builder_rubric.json` once we have ≥10 reviewed
builder runs to derive criteria from.
