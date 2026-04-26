---
name: factory-activation
description: The launchd activation sequence for ai-stack-local-smoke. Plan → dry-run → operator-approved apply → operator-driven launchctl reload. The script never calls launchctl itself.
---

# factory-activation

This skill governs the **only** path that mutates operator state for
the local-smoke factory: writing the launchd plist and `mode.json`.
Every step has a backup + rollback. The factory does not own the
`launchctl` reload — the operator does.

## When to use

- The operator explicitly asks to activate or reactivate the
  ai-stack-local-smoke factory in shadow or active mode
- A recovery is needed after a bad plist (rollback path)
- The operator wants to inspect what activation _would_ do before
  approving anything (`--dry-run`)

## Forbidden moves

- **Never call `launchctl bootstrap`, `launchctl unload`,
  `launchctl bootout`, or any other `launchctl` subcommand** from
  this skill or from `scripts/install-local-smoke-factory-launchd.sh`.
  The script must print the exact reload command for the operator and
  stop. (AGENTS.md hard rule #2.)
- **Never edit `/Users/test/bin/ai-stack-local-smoke*`.** The wrapper
  script the plist points at is committed in the repo
  (`scripts/run-ai-stack-local-smoke-factory-nightly.sh`). The
  upstream `~/bin` script is owned by the original lane and stays
  untouched. (AGENTS.md hard rule #3.)
- **Never write the plist without the backup step succeeding.**
  `applyActivation` (in `factories/ai-stack-local-smoke/activation.ts`)
  refuses to apply unless `backupPath` exists. Don't bypass.
- **Never apply when `state/disabled` exists** (kill switch). The
  reconciler will short-circuit; activation should refuse too.
  (Reconciler invariant I1.)
- **Never ship an activation that points launchd at a path the
  operator cannot inspect.** The wrapper must be the boring
  repo-local script: `cd <repo-root>; exec node --import tsx
factories/ai-stack-local-smoke/supervisor.ts --trigger launchd
--mode <mode>` (invariant I12).

## Exact commands

```bash
# 1. PLAN — print proposed plist + backup path + rollback command.
#    Reads only. Safe at any time.
scripts/install-local-smoke-factory-launchd.sh --dry-run

# 2. APPLY — write proposed plist, write mode.json, leave a backup.
#    DOES NOT call launchctl. Prints the exact reload command.
#    Run this only after the operator has eyeballed the dry-run.
scripts/install-local-smoke-factory-launchd.sh --apply

# 3. OPERATOR-DRIVEN reload (NOT this skill's job):
#    The operator runs:
#       launchctl bootout gui/$UID com.andre.ai-stack.local-smoke
#       launchctl bootstrap gui/$UID ~/Library/LaunchAgents/com.andre.ai-stack.local-smoke.plist
#    Or whatever the apply step printed.

# 4. ROLLBACK — restore the most recent backed-up plist.
scripts/install-local-smoke-factory-launchd.sh --rollback
```

## State that activation touches

- `~/Library/LaunchAgents/com.andre.ai-stack.local-smoke.plist`
  (operator state — backed up before any write)
- `factories/ai-stack-local-smoke/state/mode.json` (`"shadow"` or
  `"active"`; reconciler reads this)
- `factories/ai-stack-local-smoke/state/backups/<timestamp>.plist`
  (rollback source)

## Required evidence

Before claiming "activation applied":

- The dry-run output is captured (paste or save). The
  `proposed.programArguments` must be the boring wrapper from
  `scripts/run-ai-stack-local-smoke-factory-nightly.sh`. If it points
  anywhere else, refuse.
- A backup file exists under
  `factories/ai-stack-local-smoke/state/backups/`.
- `state/mode.json` parses to JSON with `{"mode": "shadow"}` or
  `{"mode": "active"}` and a `setBy`/`setAt` audit trail.
- `state/disabled` does not exist (kill switch off).
- The exact `launchctl` reload command is shown to the operator —
  not run by the script.

After the operator reloads launchd:

- `frontier factory status ai-stack-local-smoke` returns `missing`
  initially (no scheduled run yet) or `fresh` (after one)
- One scheduled run lands in `state/latest-run.json` with
  `trigger: "launchd"` and `mode` matching what was applied

## Anti-patterns

- "I'll just `launchctl reload` from the install script for the
  operator" — explicit violation of the operator-controlled boundary.
  The whole point of dark-factory governance is that mutating
  scheduled state is a deliberate human action.
- "The backup directory is empty so I'll just write the plist" —
  every apply must produce a backup. If `state/backups/` is empty
  before the apply, that's a sign nothing was read first.
- "Active mode looks the same as shadow, let's flip it" — active
  mode emits live alerts. Shadow runs first, fresh status after one
  scheduled run, _then_ discuss active.

## Test references

`factories/ai-stack-local-smoke/tests/activation.test.ts` covers:

- `planActivation` produces a stable `proposed.programArguments`
- `applyActivation` refuses without a backup
- `rollbackActivation` restores the most recent backup
- The script never invokes `launchctl` (`writeFixturePlist` exists
  precisely so tests don't need real launchd)

If you change activation behavior, update those tests in the same
PR — never separately.
