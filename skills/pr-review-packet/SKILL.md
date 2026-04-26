---
name: pr-review-packet
description: Build an evidence-backed PR review packet — diff, test runs, contract validations, anti-example references, invariant checks. Reviews check evidence, not vibes.
---

# pr-review-packet

A PR review claim ("this is mergeable", "this fails I7", "this changes
contract semantics") is only credible with evidence. This skill
defines the canonical bundle.

## When to use

- The user asks for a PR review, second opinion, or merge
  recommendation
- You are about to mark a milestone "done" and want a durable record
  of what was checked
- A failed PR needs a reviewer-readable explanation of _why_ it
  failed (not just an inline comment)

## Forbidden moves

- **Never review on description alone.** Read the diff. Run the
  tests. Don't trust commit messages — verify them against the
  actual change. (This is the
  [`feedback_verify_handoff_claims.md`](feedback memory) rule applied
  to PR reviews.)
- **Never quote a "passing test count" without naming the suite and
  the command.** "All tests pass" with no command is meaningless.
- **Never bless a PR that adds a forbidden action** (launchctl mutation,
  `/Users/test/bin` edit, retries through Factory #2, third-party
  unvetted skill). Refuse and cite the AGENTS.md rule it violates.
- **Never bypass the commit-msg guard** with `--no-verify`. If the
  three-field audit block is missing, ask for it.
- **Never review your own commit on the same pass it was generated.**
  Separate the build pass and the review pass.

## Exact commands

```bash
# Diff vs base (don't trust the PR UI summary alone)
git fetch origin
git log --oneline origin/main..HEAD
git diff --stat origin/main...HEAD
git diff origin/main...HEAD -- '<paths>'

# Typecheck the whole tree, not just changed files
npx tsc --noEmit

# Run the full test surface for any package the PR touches.
# For factory PRs:
for f in factories/ai-stack-local-smoke/tests/*.test.ts; do
  echo "=== $f ==="
  node --import tsx --test "$f"
done

# Eval suite (factory quality)
npx tsx evals/factory-quality/run.ts

# Skill structure (when skills change)
node --import tsx --test tests/skills/structure.test.ts

# CLI smoke (sanity)
bin/frontier --help | jq .families.factory
```

For factory-touching PRs, also run:

```bash
# Reconcile against current state — does the change behave?
frontier factory reconcile ai-stack-local-smoke --mode shadow --pretty | tee /tmp/rec.json

# Spot-check invariants
jq '.invariants[] | select(.held == false)' /tmp/rec.json
# Expect: empty
```

## Required evidence

A review packet must include:

1. **The diff** — list of files changed + line counts, not just the
   PR title
2. **The verification commands run** — exact strings, not "I ran the
   tests"
3. **Test results** — pass count + suite name per command. Note any
   skipped/todo tests and ask if they should be enabled.
4. **Invariant check** — for factory PRs, the
   `FactoryReconciliation.invariants` array (all `held: true`)
5. **Anti-example references** — does the change avoid known bad
   patterns? Link to the relevant
   [`taste/anti_examples/*.md`](../../taste/anti_examples/) entries.
6. **Audit block check** — every commit on the branch has the
   three-field block (Session, Scope, Verification) or a documented
   `[no-guard]` reason
7. **Forbidden-action audit** — explicit "no launchctl mutation, no
   `/Users/test/bin` edit, no retries, no main commit without guard,
   no third-party skill" check. Cite line ranges if anything looks
   close.
8. **Recommendation** — `merge`, `request changes`, or `close` with
   one-sentence reason and the specific evidence supporting it

## Output template

```
PR #N: <title>

Diff: <N files, +X/-Y> (link to commit range)
Branch: <branchname> off <base>

Verification run:
  npx tsc --noEmit                                       → clean
  for f in factories/.../tests/*.test.ts ...             → 101/101 pass
  node --import tsx --test tests/skills/structure.test.ts → N/N pass
  frontier factory reconcile ... --mode shadow           → status=fresh, invariants all held

Forbidden-action audit:
  - launchctl mutation:        not present
  - /Users/test/bin edit:      not present
  - retry policy violated:     not present
  - main commit without guard: N/A (PR branch)
  - third-party skill:         N/A

Anti-example references:
  - <link>: <how this PR avoids it>

Audit block: present on all commits

Recommendation: merge / request changes / close
Reason: <one sentence + evidence>
```

## Anti-patterns

- "Looks good to me" with no commands run — useless review.
- Citing test counts without the command — unverifiable claim.
- Flagging a problem without a fix path — leaves the author guessing.
- Reviewing a PR by reading the conversation that produced it — the
  PR is what merges, not the chat. Read the actual diff.

## Verification before reporting

```bash
# Did you actually run what you say you ran?
history | tail -50
# Or capture each command's output to /tmp/review-N/.
```

If you cannot point at a captured output for each verification
command, redo the run. Reviews check evidence, not memory.
