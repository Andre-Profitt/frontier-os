---
name: context-pack
description: Use `frontier context pack --lane <id>` to assemble a complete, evidence-backed context bundle for a lane before doing any analysis or write — never reconstruct context from chat history.
---

# context-pack

Lanes drift. Chat scrolls. Memory rots. Before reasoning about a lane,
generate a fresh context pack and read THAT, not your conversation
history. The pack is a deterministic snapshot of what the lane
actually looks like right now: spec, recent alerts, recent runs, lock
state, evidence files, ledger excerpts.

## When to use

- You are about to do _anything_ non-trivial with a lane (review,
  patch, status report, post-mortem)
- A new session is resuming work and the prior conversation may be
  stale (handoff hallucination is a real failure mode — see
  [`taste/anti_examples/wrong_repo_hallucination.md`](../../taste/anti_examples/wrong_repo_hallucination.md))
- You need to attach lane state to a PR description, eval input, or
  runbook
- The user asked "what's going on with X lane?" and you don't have
  freshly verified evidence to answer

## Forbidden moves

- **Never substitute chat memory for a context pack.** If the
  question is "what's X's current state?", the answer is the pack
  output, not what someone said earlier in the thread.
- **Never edit the pack output to fit a narrative.** It's a snapshot;
  if reality contradicts your draft, fix the draft.
- **Never paste a context pack into a public PR description if it
  contains paths under `/Users/test/`** without a quick scrub. The
  pack is for internal reasoning + private review.
- **Never run `--no-alerts` to make a lane look healthy.** That flag
  exists for legitimate cases (e.g. testing pack rendering offline);
  using it to silence noise is the same anti-pattern as
  [`taste/anti_examples/narrow_alert_filter.md`](../../taste/anti_examples/narrow_alert_filter.md).

## Exact commands

```bash
# Default — JSON output, includes recent alerts (last 7d by default)
frontier context pack --lane ai-stack-local-smoke --pretty

# Markdown rendering (good for handoffs / runbooks)
frontier context pack --lane ai-stack-local-smoke

# Tighter alert window (quieter packs for routine status)
frontier context pack --lane ai-stack-local-smoke --alert-lookback-days 1 --pretty

# Pack without alert lookup (offline / fixture testing only)
frontier context pack --lane ai-stack-local-smoke --no-alerts
```

Positional form is also accepted:

```bash
frontier context pack ai-stack-local-smoke --pretty
```

## What the pack contains

The schema is owned by `src/context/pack.ts`. Today it includes (and
keeps including, by contract):

- Lane identity (`factoryId`, `launchdLabel`, `repoHead`)
- Factory spec excerpts (`activation`, `policy`, `boundedRepair`,
  `alert.source`)
- Recent runs from `state/latest-run.json` and the ledger
- Active lock (if any)
- Mode + kill-switch state
- Recent alerts within the lookback window
- Pointers to evidence files

If a field is missing, that's load-bearing — _don't_ guess. The pack
is supposed to be honest about what it could not find.

## Required evidence

Before reporting on a lane, you must have:

- A pack output (file, paste, or piped buffer) that you generated
  _this session_ — not last week's
- The pack's `repoHead` matches `git rev-parse HEAD` in the working
  tree (mismatch = pack ran somewhere else and is stale)
- If the pack reports `mode.killSwitchActive: true`, every claim
  about runs/alerts must acknowledge that — disabled lanes don't
  produce fresh evidence

## Verification before reporting

```bash
# Sanity: pack head matches your working tree
frontier context pack --lane ai-stack-local-smoke --pretty | jq .repoHead
git rev-parse HEAD
# Both should match.

# Cross-check the pack's claims against status:
frontier factory status ai-stack-local-smoke --pretty | jq .status
# Same lane, same moment, should agree.
```

## Anti-patterns

- "I remember the lane was fresh yesterday" — generate a pack now;
  don't lean on memory.
- "The pack says alert X is active but the user told me it cleared,
  so I'll skip it" — the pack is the truth, not the user message.
  Re-run the pack after the alert is actually cleared in the source
  system.
- "I'll piece together the state by grep-ing files" — the pack
  already does this, deterministically. Use it.
