# Wrong-repo hallucination — handoff carried context from a different codebase

## What happened

On 2026-04-25 (start of the session that produced PRs #1-#4), the user pasted a handoff message into a fresh agent session in `~/frontier-os`. The handoff stated:

- "Current main is coherent and working tree should be clean."
- "Latest commits on main: `d08b4bf — screenshot/link cleanup`, `c901462 — round-5 enterprise UX patch`."
- "Streamlit was manually verified before the cleanup commit, ran cleanly on port 8511, all 4 page navigations succeeded, governance ribbon rendered, release-gate table rendered."

None of that was true for `~/frontier-os`. The actual state on disk:

- `git log --oneline -1` returned `331b620 Initial commit: frontier-os control plane` — the **only** commit.
- `git status --short` returned 14 modified files + 5 untracked files (~7,600 LOC of unrelated in-progress work) — the working tree was **dirty**, not clean.
- `~/frontier-os` is a TypeScript / Node CLI + daemon. It contains **no Streamlit code at all**, no port 8511, no governance ribbon UI.

The handoff was describing a different repo (likely `ai-os`, `companion-platform`, or a Streamlit dashboard side project) that the prior assistant had been working in.

If the agent had trusted the handoff:

- It would have looked for commits that didn't exist.
- It would have assumed the working tree was clean and edited freely on top of someone else's uncommitted work.
- It would have built UI patches against a non-existent Streamlit app.
- The first concrete outputs would have been hallucinations, and any review packet would have inherited the false claims.

The agent caught this by running `git status --short` and `git log --oneline -5` as the first step and reporting the discrepancy, refusing to edit until the user confirmed which repo was actually in scope.

## Why it was wrong

Handoffs that name "the repo" without proving it can fabricate state. A multi-project user has many repos. Assistant memory + handoff prose is not a substitute for:

- `git rev-parse HEAD` (what's actually checked out)
- `git status --short` (what's actually dirty)
- `git log --oneline -5` (what commits actually exist)
- a literal marker (`package.json` `name` field, a top-level `README.md`, the directory path itself)

The cost of skipping verification is high: every claim downstream — file paths, commit hashes, test counts, behavior assertions — inherits the wrong context. By the time the error surfaces (a missing file, a failed build, a mismatched diff), the agent has often produced load-bearing outputs that have to be thrown away.

The deeper failure is **identity ambiguity in handoffs**. When an agent runs across many user projects, "I'm Claude working with this user" is not enough context to anchor work. The repo, the branch, the recent commits, and the working-tree state must all be re-asserted at the top of every session. The handoff format prior to this session did none of that.

## How to detect

This anti-example is now actively detected by:

1. **`frontier context pack --lane <lane>` (Phase 2 / PR #2).** Generates a markdown packet whose first non-title line is `**This is the \`frontier-os\` repo.\*\*`, followed by `git status --short`, recent commits, branch, HEAD, and the live factory spec. An agent that runs this command before editing cannot inherit a wrong-repo claim from a handoff.

2. **Eval criterion C3 in `evals/factory-quality/local-smoke-factory-quality.json`** — "Context pack explicitly identifies the repo as `frontier-os`." Anti-example test in `evals/factory-quality/tests/quality.test.ts` constructs a synthetic ContextPack with `repo.marker = "ai-os"` and asserts `scoreC3` returns `failed`.

3. **Handoff rubric criterion H1** — "Repo identity is the first claim." Weighted 2.

4. **Repo-identity warning in `src/context/pack.ts`** — `generateContextPack` reads `package.json` and pushes a warning to `pack.warnings` if the `name` field doesn't match `frontier-os`.

If a future handoff makes claims about the wrong repo, the agent has three independent ways to catch it before editing.

## Reference

- Initial session detection: this thread, message 1 (the agent's response listing actual vs. handoff state).
- Factory #1 PR cover: https://github.com/Andre-Profitt/frontier-os/pull/1 — describes the discovery and the snapshot branch (`snapshot/2026-04-26/pre-factory-dirty`, commit `46df6a2`) where the dirty pre-existing tree was preserved.
- Phase 2 PR (context pack): https://github.com/Andre-Profitt/frontier-os/pull/2 — the explicit countermeasure.
- Eval criterion C3: `evals/factory-quality/local-smoke-factory-quality.json:C3`.
- C3 anti-example test: `evals/factory-quality/tests/quality.test.ts` — `"anti-example: wrong-repo context — repo.marker != 'frontier-os' fails C3"`.
- Memory: `~/.claude/projects/-Users-test/memory/feedback_verify_handoff_claims.md` — "Handoff docs can hallucinate hard. Verify scores, file contents, job state against real logs/filesystem before acting."
