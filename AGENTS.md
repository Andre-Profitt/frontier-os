# AGENTS.md — frontier-os repo doctrine

This file is the canonical instruction surface for any agent (Claude
Code, Codex, Hermes, Aider, OpenCode, OpenHands, etc.) operating in
this repository. Skills under [`skills/`](skills/) load on demand for
specific tasks; this file defines the rules they all inherit.

## What frontier-os is

A **local dark-factory control plane**. The factory is the control
system that decides when agents may act, records what happened,
verifies the result, and stops or escalates when reality diverges from
desired state. The factory itself is **not an agent**.

Role split with adjacent tools:

- **frontier-os (this repo)** — factory state authority. Owns launchd
  control, ledger, latest-run, lock, mode, kill switch, evidence,
  alert ownership. Single source of truth.
- **Hermes / Agent Skills** — procedural memory + operator chat
  interface + skill execution + subagent delegation. Hermes can _talk
  to_ the factory; it must not _be_ the factory.
- **OpenHands / Daytona / Docker worktrees** — isolated labor pool for
  risky refactors, parallel attempts, dependency installs, large test
  matrices. Not for live-repo mutation.
- **Litestream** — SQLite ledger backup/replication.
- **Playwright** — browser/UI verification evidence.

## Hard rules

Violating any of these should cause an agent to STOP and ask. They are
enforced by tests, the commit-message guard, and (where applicable)
pre-action hooks.

1. **No automatic retries** through Factory #2. One attempt → classify
   → record → alert/escalate → stop. The watchdog decides whether
   stale/missing requires a new run.
2. **Activation `apply` never calls `launchctl`.** It backs up the
   plist, writes the proposed plist, writes `mode.json`, and prints
   the exact reload + rollback commands. The operator runs
   `launchctl` themselves.
3. **Activation never edits `/Users/test/bin`.** Repair is read-only.
4. **No third-party Agent Skill enters this repo unless** pinned by
   commit hash, inspected, sandboxed, copied into repo-local
   `skills/`, and covered by a test or capability policy. (See
   OpenClaw lessons — community skill markets have shipped
   credential-stealing skills in the wild.)
5. **No commit to `main` from an agent without the three audit
   fields** (`Session:`, `Scope:`, `Verification:`) unless the subject
   begins with `[no-guard]` or it's a true merge commit. The
   commit-msg guard rejects everything else.
6. **No mutating tools in `frontier factory status`** — it's
   read-only by contract.
7. **The kill switch wins over everything**: lease, verifier, repair,
   ledger, alert. Any code path that sees `state/disabled` must
   short-circuit immediately. (Reconciler invariant I1.)
8. **Never delete another run's lock.** Lease release verifies
   ownership by `runId` first.
9. **Never silence an alert by trimming filters.** A failure must
   either clear at the source or own its own alert. Anti-example:
   [`taste/anti_examples/narrow_alert_filter.md`](taste/anti_examples/narrow_alert_filter.md).
10. **Never declare a repair "OK" without verifying the underlying
    failure cleared.** Anti-example:
    [`taste/anti_examples/false_green_repair.md`](taste/anti_examples/false_green_repair.md).
11. **Verify the repo, not the conversation.** Don't claim a file/PR
    exists in a repo without checking. Anti-example:
    [`taste/anti_examples/wrong_repo_hallucination.md`](taste/anti_examples/wrong_repo_hallucination.md).

## Default agent loop

For every non-trivial task, follow:

```
observe → decide → act → verify → write state → stop
```

This is Reflexion + Voyager applied to ops: shorter autonomous loops
with durable state and independent verification beat longer prompts.
The dark-factory reconciler enforces this shape; agent tasks should
mirror it.

## Skill discovery

When you start a task, scan [`skills/`](skills/) for a folder matching
the task. Each skill has a `SKILL.md` with: when-to-use, forbidden
moves, exact commands, required evidence, anti-example references.
Load the skill instead of inferring from this file.

Currently shipped:

- [`skills/frontier-factory-supervisor/`](skills/frontier-factory-supervisor/) — driving the local-smoke factory (status, reconcile, run modes)
- [`skills/factory-activation/`](skills/factory-activation/) — the dry-run → apply → operator-reload sequence
- [`skills/context-pack/`](skills/context-pack/) — assembling lane context with `frontier context pack`
- [`skills/pr-review-packet/`](skills/pr-review-packet/) — building a PR review evidence packet

`tests/skills/structure.test.ts` verifies every skill has the required
shape. Adding a skill requires adding the test fixture too.

## CLI is the agent-computer interface

Per SWE-agent's "Agent-Computer Interface" lesson: the CLI surface is
part of the model's intelligence. If a safe path is obvious and a
dangerous path is hard to express, the model gets smarter without
changing weights. When in doubt, prefer:

```
frontier factory status <id>
frontier factory reconcile <id> [--mode shadow|active|observe|disabled]
frontier context pack --lane <id>
frontier eval run factory-quality
```

Mutating commands (`activation apply`, ledger writes, branch pushes)
should always require an explicit flag and produce a durable record.

## Verification expectations

Every PR must:

- Include `tsc --noEmit` clean
- Run all tests in changed packages
- Include the commit-msg three-field audit block
- Reference any anti-example/eval/skill it touches

Reviews check evidence, not vibes: link to a `factory.test.ts` line, a
`run-*.json`, an anti-example, or an eval rubric — not to a PR
description claim.
