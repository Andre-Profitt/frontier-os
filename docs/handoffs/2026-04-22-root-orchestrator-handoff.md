# Root Orchestrator Handoff

Date: 2026-04-22
Owner at handoff: Codex
Primary repos:
- `/Users/test/frontier-os`
- `/Users/test/code/platform/companion-platform/apps/apple-companion`

## Scope of This Handoff

This handoff covers the Frontier root-level orchestrator work carried through the recent M1-M69 tranche, the honest project-status review we did today, and the correction we agreed on: stop burning cycles on Apple passive-surface polish and move back to capability-bearing execution-lane work.

This is the canonical handoff for the work Codex and Andre reviewed together in this session.

## Main Goal

From the master plan in [root-level-orchestrator-master-plan.md](/Users/test/frontier-os/docs/plans/root-level-orchestrator-master-plan.md:8):

> One resident local operator that accepts intent from Codex, Claude, Jarvis, Siri, CLI, or schedules; routes it through policy; plans work; runs the right project/system/ML/browser/Salesforce action; pauses for approval when needed; self-audits; and resumes until done.

This is not arbitrary root shell access. The helper stays narrow and allowlisted. Root-level means machine-wide coordination with policy, approvals, and ledger evidence.

## Honest Status

These are the numbers we agreed are still the right read from the current master plan:

| Layer | Estimate | Source |
| --- | ---: | --- |
| Root-router substrate | 85-90% | [master plan](/Users/test/frontier-os/docs/plans/root-level-orchestrator-master-plan.md:82) |
| Full root-level orchestrator product | 65-75% | [master plan](/Users/test/frontier-os/docs/plans/root-level-orchestrator-master-plan.md:85) |
| Autonomous 8-hour work system | 45-55% | [master plan](/Users/test/frontier-os/docs/plans/root-level-orchestrator-master-plan.md:86) |

Reasoning:
- The substrate is real.
- The full product is not done because lane depth, retries/resume/verifiers, and unattended execution quality are still short of the goal.
- The recent M60-M69 slices do not materially change these percentages.

## What Is Actually Shipped

From the current-reality section of the master plan:
- `frontierd` resident daemon and local APIs [master plan](/Users/test/frontier-os/docs/plans/root-level-orchestrator-master-plan.md:27)
- policy and approval core [master plan](/Users/test/frontier-os/docs/plans/root-level-orchestrator-master-plan.md:31)
- MCP bridge and smoke coverage [master plan](/Users/test/frontier-os/docs/plans/root-level-orchestrator-master-plan.md:35)
- root helper with fixed allowlist and denial posture [master plan](/Users/test/frontier-os/docs/plans/root-level-orchestrator-master-plan.md:39)
- Ghost Shift / overnight planner and brief [master plan](/Users/test/frontier-os/docs/plans/root-level-orchestrator-master-plan.md:44)
- Jarvis / menubar / App Intents / notifications [master plan](/Users/test/frontier-os/docs/plans/root-level-orchestrator-master-plan.md:47)
- shared `mlxw` machine-level MLX workbench [master plan](/Users/test/frontier-os/docs/plans/root-level-orchestrator-master-plan.md:53)
- command gateway, queue, checkpoints, worker, compiler, leases, and idempotency [master plan](/Users/test/frontier-os/docs/plans/root-level-orchestrator-master-plan.md:55)
- execution-lane MVPs for project, overnight, MLX, helper, plus browser/Salesforce scaffolds [master plan](/Users/test/frontier-os/docs/plans/root-level-orchestrator-master-plan.md:61)

The success definition remains the v1 bar in [master plan](/Users/test/frontier-os/docs/plans/root-level-orchestrator-master-plan.md:3300):
- common command envelope across surfaces
- route and policy explanation before execution
- class 0/1 autonomous execution
- class 2 approval pause and resume
- class 3 deny by default
- resident worker drainage
- command-scoped ledger evidence
- final brief on every command
- core lanes working end to end

## What Is Not Done

This is still the important gap list:
- broader operator productization is incomplete [master plan](/Users/test/frontier-os/docs/plans/root-level-orchestrator-master-plan.md:71)
- no production-grade retry, resume, budget, and verifier policy across every lane [master plan](/Users/test/frontier-os/docs/plans/root-level-orchestrator-master-plan.md:74)
- browser lane needs live CDP on `127.0.0.1:9222` for real inspection [master plan](/Users/test/frontier-os/docs/plans/root-level-orchestrator-master-plan.md:75)
- Salesforce and browser lanes are still scaffolded/read-only, not rich task lanes [master plan](/Users/test/frontier-os/docs/plans/root-level-orchestrator-master-plan.md:76)

Bluntly: the missing work is execution-lane maturity and reliable unattended operation, not another round of labels in Apple passive surfaces.

## What We Diagnosed Today

### 1. Frontier / Apple lane got stuck in a polish loop

We reviewed the recent M60-M69 tranche and concluded it was mostly passive-surface wording, App Intent metadata, labels, and empty-state cleanup, not new orchestrator capability.

This is visible directly in the master plan status and tranche notes [master plan](/Users/test/frontier-os/docs/plans/root-level-orchestrator-master-plan.md:4).

Conclusion:
- useful polish
- not wasted
- but not material progress against the main goal

### 2. The whole day was not all the same work

There were other active lanes today:
- CRM Analytics had real Claude work centered on `/Users/test/crm-analytics/scripts/build_deck_from_excel.py`
- AI stack / MLX tooling had real Codex work around MLX remote ensure, watch-loop support, and AI stack attention surfaces

Those lanes may matter more to future-state autonomy than another Apple copy-tightening slice.

### 3. Current live Frontier state is healthy

Verified at handoff time:

```bash
/Users/test/frontier-os/bin/frontier command readiness --hours 24 --limit 50 --json
/Users/test/frontier-os/bin/frontier command worker status --json --local
/Users/test/frontier-os/bin/frontier daemon health --json
/Users/test/frontier-os/bin/frontier helper self-test --json
```

Observed state:
- readiness: `ready`
- daemon: `ok`
- queue: `queued=0`, `running=0`, `blocked_approval=0`, `blocked_policy=0`, `claimableCount=0`
- helper self-test: `passed=5`, `failed=0`

## What To Stop Doing

Do not spend the next tranche on more micro-polish like:
- App Intent phrasing
- passive widget wording
- notification subtitle cleanup
- enum label tightening

Those changes can be bundled later as a single polish pass. They should not keep getting promoted as milestone-bearing work.

## Recommended Next Tranche

The next tranche should be capability-bearing:

1. Browser lane
- make real CDP-backed inspection and task execution usable
- prove end-to-end route, execution, packet, final brief

2. Salesforce lane
- move past read-only/scaffolded status
- add actual safe task primitives with verifier paths

3. Retry / verifier / budget hardening
- tighten real command execution behavior across active lanes
- focus on unattended recovery, not UI copy

4. Overnight quality
- run real overnight work on active projects
- improve morning brief usefulness and evidence quality

## Recommended Repo Triage After Context Reset

These are the three independent diagnosis lanes we were about to formalize:

1. Frontier / Apple
- keep/drop/integrate review of recent native work
- separate real operator capability from passive-surface polish

2. CRM Analytics
- review today’s `build_deck_from_excel.py` changes and monthly-review path
- separate keeper fixes from generated sprawl

3. AI stack / MLX tools
- identify what should be folded into the future-state orchestrator plan
- especially anything around MLX watch, remote ensure, and attention surfaces

## Constraints and Important Context

- Perplexity is eval-only right now. Do not commit into that lane or treat it as canonical project state.
- For MLX host-level work, use the shared workbench:

```bash
/Users/test/.frontier/mlx/bin/mlxw status
/Users/test/.frontier/mlx/bin/mlxw smoke
/Users/test/.frontier/mlx/bin/mlxw audit
```

- Do not treat recent Apple companion wording changes as proof of core orchestrator progress.

## First Commands for the Next Session

Use these before making new claims:

```bash
cd /Users/test/frontier-os
git status --short

/Users/test/frontier-os/bin/frontier command readiness --hours 24 --limit 50 --json
/Users/test/frontier-os/bin/frontier command worker status --json --local
/Users/test/frontier-os/bin/frontier daemon health --json
/Users/test/frontier-os/bin/frontier helper self-test --json
```

Then re-read:
- [root-level-orchestrator-master-plan.md](/Users/test/frontier-os/docs/plans/root-level-orchestrator-master-plan.md:8)
- [command-orchestrator.md](/Users/test/frontier-os/docs/runbooks/command-orchestrator.md:1)

## Takeover Summary

The substrate is strong.

The product is not done.

The missing work is execution-lane depth and unattended reliability.

Do not continue the M60-M69-style polish loop unless it is bundled as explicit cleanup after capability work lands.
