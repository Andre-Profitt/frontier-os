# Operator runbook — frontier-os inference loop

How to drive the inference loop end-to-end on a fresh host. Validated
against `inference-loop-v1` (tag) on a Mac with local Ollama.

## Prerequisites

```bash
# 1. Ollama running locally
curl -sf http://127.0.0.1:11434/api/tags >/dev/null || ollama serve &

# 2. Models the policy expects (config/model-policy.json)
ollama pull qwen2.5:72b
ollama pull deepseek-coder:33b-instruct
ollama pull qwen2.5:7b
# Optional but recommended for builder role:
ollama pull qwen2.5-coder:14b

# 3. Repo dependencies
cd /path/to/frontier-os
npm install

# 4. Smoke test the broker
npx tsx src/cli.ts model probe --provider ollama-local --model qwen2.5:72b
# Expected: {"ok":true, "status":200, "modelCount":N, ...}
```

## Run an orchestration

```bash
npx tsx src/cli.ts orchestrate \
  --task <slug> \
  --description "<one-paragraph task description, including which file
                  and function/section to edit; mention 'use search/replace
                  block format' for best results>" \
  --rubric taste/rubrics/factory_run_rubric.json \
  --touch <comma-separated-file-paths> \
  --builders 2 \
  --reviewers 2 \
  --skip-tests \
  --pretty
```

What happens (in order):

1. Two parallel **builders** (R5) each generate a candidate patch in their own git worktree. Default: search/replace blocks (Patch M); falls back to unified diff.
2. Two parallel **reviewers** (R3) attack each candidate, producing structured findings.
3. **Arbiter** (R4) scores against the rubric, applies gates, picks a winner or rejects.
4. **Auto-ingest** (Patch J) writes the run's evidence into `state/quality-ledger/*.jsonl`. Skipped only via `--skip-ingest`.

Output JSON includes `qualityIngest.counts` so you can verify the run reached the ledger.

## Useful flags

| Flag                               | Default                | When to use                                                        |
| ---------------------------------- | ---------------------- | ------------------------------------------------------------------ |
| `--builders N`                     | 3                      | Lower for cost/speed; raise for diversity                          |
| `--reviewers N`                    | 3                      | Same logic per-builder                                             |
| `--quality-floor 0.4`              | 0.7                    | Allow trivial patches through (first-accept proof / tutorial runs) |
| `--min-rubric-coverage 0.3`        | 0.5                    | Same — relax coverage gate for tiny patches                        |
| `--require-tests` / `--skip-tests` | require                | `--skip-tests` for doc/comment-only changes                        |
| `--models a,b`                     | from policy            | Force specific builder models (one per builder)                    |
| `--touch a,b`                      | (required)             | Comma-separated file paths the swarm may edit                      |
| `--allow-unscoped-diff`            | false                  | DANGEROUS — only with empty touch list                             |
| `--cleanup`                        | false                  | Delete losing-candidate worktrees after run                        |
| `--skip-ingest`                    | false                  | Don't write to ledger (synthetic/smoke runs only)                  |
| `--quality-ledger-dir P`           | `state/quality-ledger` | Override ledger location                                           |

## Inspect a run

```bash
# Where did it land?
ls artifacts/orchestrations/<task>/
#   builder-swarm-packet.json   <- candidate patches + per-builder phase
#   review-packets/b1.json      <- adversarial reviewer findings (per candidate)
#   arbiter-decision.json       <- scores + gates + decision
#   final-report.md             <- human-readable summary (start here)
#   orchestration-packet.json   <- top-level audit trail

# The accepted candidate's patch is in its worktree:
git -C .worktrees/<task>--<builderId>--<runId>/ show HEAD
```

## Apply an accepted patch

R6 NEVER auto-merges. To apply:

```bash
# Inspect first.
git -C .worktrees/<task>--<acceptedBuilderId>--<runId>/ diff main

# Apply to your branch.
git checkout -b feature/<task>
git -C .worktrees/<task>--<acceptedBuilderId>--<runId>/ format-patch -1 --stdout | git am
# or just `git apply` the diff
```

## Record the human verdict

After looking at what the arbiter picked (or chose not to pick), log
the outcome into the ledger. This is what powers the routing flywheel
— the arbiter's pick is one signal, the human's actual verdict is the
ground-truth label.

```bash
# Accepted the arbiter's pick:
npx tsx src/cli.ts quality mark \
  --task <slug> \
  --decision accepted \
  --accepted-builder <builderId> \
  --reason "exact match to spec" \
  --artifacts artifacts/orchestrations/<task>

# Accepted a different candidate than the arbiter picked
# (highest-value flywheel signal — humanOutcomeRelation=accepted_non_selected):
npx tsx src/cli.ts quality mark \
  --task <slug> \
  --decision accepted \
  --accepted-builder <other-builderId> \
  --reason "arbiter pick had subtle bug; b3's approach is cleaner" \
  --artifacts artifacts/orchestrations/<task>

# Rejected everything:
npx tsx src/cli.ts quality mark \
  --task <slug> \
  --decision rejected \
  --reason "all candidates miss the spec — re-spec and re-run" \
  --artifacts artifacts/orchestrations/<task>

# Resolved an escalation manually:
npx tsx src/cli.ts quality mark \
  --task <slug> \
  --decision escalation_resolved \
  --reason "fixed by hand — see commit X"
```

## Watch the flywheel

```bash
# Per-(model, role, taskClass) scorecard:
npx tsx src/cli.ts quality scorecard

# Routing recommendations from the recommender (NEVER auto-applies):
npx tsx src/cli.ts quality recommend --pretty

# When recommend says demote_primary or promote_alternate, edit
# config/model-policy.json by hand. That's the operator-driven loop.
```

## Volume targets

The recommender needs `n ≥ 3` per model per task class to weigh in.
Realistically:

| Volume                                | What you get                                              |
| ------------------------------------- | --------------------------------------------------------- |
| 1 successful run                      | Pipeline validation only                                  |
| ~5 runs                               | First per-model rate signal                               |
| ~10 runs per (model, role)            | Wilson lower bounds tight enough for promote/demote calls |
| ~50 runs with `quality mark` verdicts | Q5 (LLM judge) becomes worth building                     |

## Known calibration knobs

These are tunable per orchestration via flags and are deliberately
strict by default. Loosen when you understand the trade-off.

- **qualityFloor 0.7** — patches scoring below this are rejected. Set
  lower (e.g. 0.4) to let through partial-coverage patches on small
  task classes.
- **minRubricCoverage 0.5** — at least half the rubric weight must be
  scoreable. Trivial doc patches might cap below this; lower for those.
- **minReviewCoverage 0.66** — at least 2/3 of reviewers must produce
  parseable JSON. With deepseek-coder reviewer at ~50% validity rate,
  this often fails when reviewerCount=2; raise reviewerCount or
  switch the reviewer primary to a more reliable model.
- **noBlockingReview** — any reviewer flagging a high-severity bug
  blocks the candidate. Useful for safety; can over-trigger when
  reviewers hallucinate findings.

## Troubleshooting

- **`broker rejected: model-override-not-found`** — your `--models` key
  isn't in `config/model-policy.json`. Add it to the relevant class's
  `models[]` first.
- **`broker rejected: all-attempts-failed`** — model timed out (default
  180s). Check `tail /tmp/*.log` for the actual error. Big prompts on
  70B-class need more time; either raise `requestTimeoutMs` in policy
  defaults, or use a smaller model.
- **`apply_failed`** — model produced a diff/S-R block that doesn't
  match the file. With Patch M+M1 this is mostly hallucination, not
  parser issues. Re-run; or pull a code-tuned model
  (`ollama pull qwen2.5-coder:14b`).
- **`scope_rejected: outside_touch_list`** — model edited a file you
  didn't authorize. The diff scope checker did its job; refine the
  task description to be unambiguous about which file to edit.
- **Reviewer paraphrases instead of producing JSON** — happens with
  smaller / instruction-loose models. Patch L extracts only the prompt
  block from SKILL.md, which helps. Switch reviewer primary to
  qwen2.5:72b for higher validity rate.

## Validated end-to-end

First arbiter `accept` recorded 2026-04-27 (`first-accept-no-review-gate`):

- Task: add a one-line comment above `fmtRate` in `scorecard-format.ts`
- Builder: `qwen2.5:72b` produced an applying S/R block
- Reviewer: `deepseek-coder:33b-instruct` paraphrased (validityRate 0.0
  on this run) → relaxed `--min-review-coverage 0.0`
- Arbiter: `accept` (exit 0), selectedBuilderId=b1
- Q2 mark: `humanOutcomeRelation: "accepted_selected"`,
  `arbiterAgreed: true`
- First non-zero `selectionRate` in the scorecard: 1/14 = 0.07

Reproducible end-to-end with the flags in this runbook.

## Related references

- Tag `inference-loop-v1` — current shipped state
- GitHub Issue #24 — original GPT Pro architecture review brief
- `schemas/quality-ledger-event.schema.json` — durable event contract
- `config/model-policy.json` — routing policy (operator-edited)
