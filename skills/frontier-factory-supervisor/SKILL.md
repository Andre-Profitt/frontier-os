---
name: frontier-factory-supervisor
description: Drive the ai-stack-local-smoke factory — run the reconciler, read status, never mutate launchd or /Users/test/bin from this skill.
---

# frontier-factory-supervisor

The local dark-factory has one cell today: `ai-stack-local-smoke`. This
skill covers running and inspecting it via `frontier-os`. Activation
(launchd plist + mode.json writes) lives in a separate skill —
[`factory-activation`](../factory-activation/SKILL.md) — and is the
only path that may mutate operator state.

## When to use

- The user asks for factory status, latest run, or a manual run
- An alert mentions `ai-stack.local-smoke-nightly` and you need to
  reconcile state
- You want a durable reconciliation record (`FactoryReconciliation`)
  for a runbook, post-mortem, or eval input
- A scheduled launchd run finished and you need to confirm freshness

## Forbidden moves

- **Never run** `frontier factory reconcile` with `--mode active`
  unless the operator has explicitly approved it for this session.
  Default to `--mode shadow`.
- **Never call `launchctl`** from this skill. Activation is
  operator-driven.
- **Never delete or rewrite** `factories/ai-stack-local-smoke/state/lock.json`.
  If you suspect a stale lease, read it (don't write); the reconciler
  detects and recovers stale leases on its own (lease.ts).
- **Never edit** `/Users/test/bin/ai-stack-local-smoke` or
  `/Users/test/bin/ai-stack-local-smoke-nightly`. The bounded repair
  is read-only by design (factory.json `boundedRepair.destructive`
  must remain `false`).
- **Never trim alert filters** to make a status look fresh. If a
  failure exists, it owns an alert. See
  [`taste/anti_examples/narrow_alert_filter.md`](../../taste/anti_examples/narrow_alert_filter.md).
- **Never declare** a repair OK without verifying the original
  failure cleared. See
  [`taste/anti_examples/false_green_repair.md`](../../taste/anti_examples/false_green_repair.md).

## Exact commands

Read-only:

```bash
# Status (reads latest-run + lock + kill-switch; never writes)
frontier factory status ai-stack-local-smoke --pretty

# Full reconciliation record (observe → decide → apply → assert)
# Default mode is shadow; safe to run repeatedly.
frontier factory reconcile ai-stack-local-smoke --mode shadow --pretty

# Reconcile in observe mode — does NOT run primary or repair
frontier factory reconcile ai-stack-local-smoke --mode observe --pretty
```

Manual run paths (only after explicit approval):

```bash
# Equivalent to reconcile + supervise but invoked through supervisor.ts
node --import tsx \
  factories/ai-stack-local-smoke/supervisor.ts \
  --trigger manual --mode shadow

# Active mode — emits real factory alerts. ONLY after operator approval.
frontier factory reconcile ai-stack-local-smoke --mode active --pretty
```

Exit codes (both `status` and `reconcile`):

| Code | Status                              |
| ---- | ----------------------------------- |
| 0    | `fresh`                             |
| 1    | `stale` or `missing`                |
| 2    | `failed`                            |
| 3    | `ambiguous`                         |
| 4    | `disabled`                          |
| 5    | `locked`                            |
| 6    | reconciler crashed (reconcile only) |

## Required evidence

A "factory ran cleanly" claim must cite all of:

- `factories/ai-stack-local-smoke/state/latest-run.json` — exists,
  `finishedAt` is recent, `classification` is `passed`
- The `FactoryReconciliation` JSON output (or `FactoryRun` if invoked
  via supervisor.ts) — `result.ran === true`,
  `result.classification === "passed"`, `invariants` are all `held: true`
- `factories/ai-stack-local-smoke/state/lock.json` — does **not**
  exist after the run finishes
- A ledger session entry under
  `~/.frontier/ledger.db` for `factory.ai-stack-local-smoke` (the
  reconciler emits `system`, `ops.repair_start`, `ops.repair_end`
  events; passed runs do not emit `alert`)

A "factory failed" claim must cite all of:

- The `FactoryReconciliation` with `status: "failed"` or `"ambiguous"`
- Either `result.emittedAlertId` (a factory-owned alert) OR a
  populated `result.correlatedLegacyAlertIds` list — never both
  (invariant I7)
- A `taste/anti_examples/...` reference if the failure mode matches
  one already catalogued

## Common anti-patterns

- "Tests pass on my fixture, ship it" — fixtures don't catch the
  cross-table contracts the live evidence does. Run the reconciler
  against real state before claiming green.
- "I'll just rm the lock real quick" — destroys the lease ownership
  contract (invariant I4). If a stale lock blocks you, read it; the
  next reconciler call recovers it via the supervisor's stale-lease
  path.
- "Mode override = active will be fine" — active mode emits live
  alerts. Defaults stay `shadow` until activation is explicitly
  approved.

## Verification before reporting

Run before claiming "factory is healthy":

```bash
frontier factory status ai-stack-local-smoke --pretty | jq .status
# Expect: "fresh"

cat factories/ai-stack-local-smoke/state/latest-run.json | jq '.classification, .finishedAt'
# Expect: "passed", recent ISO timestamp

ls factories/ai-stack-local-smoke/state/lock.json 2>&1
# Expect: No such file or directory
```

If any of those fails, do **not** report green. Reconcile and gather
the real status first.
