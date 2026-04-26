# Repo-local git hooks

Phase 4 deliverable. This directory holds in-repo git hooks pointed at by `core.hooksPath`. Run `./scripts/install-git-hooks.sh` once after cloning to wire them up.

## `commit-msg` — agent commit guard

Rejects commits whose message body does not include all three audit fields:

```
Session: <agent session id>
Scope: <what this commit covers>
Verification: <exact commands run>
```

The guard exists because parallel agents committing under the same Claude identity is hard to audit otherwise. With this hook installed, every agent-authored commit carries enough metadata to trace which session produced it, what scope it covered, and what was verified.

### Valid example

```
feat(eval): add factory quality eval suite

Session: claude-factory-quality-eval-2026-04-26
Scope: Phase 3 eval suite for local-smoke factory quality
Verification: npm run typecheck; node --import tsx --test evals/factory-quality/tests/quality.test.ts
```

### Bypass paths

| When                              | How                                                 |
| --------------------------------- | --------------------------------------------------- |
| Human / emergency commit          | prefix subject with `[no-guard]`                    |
| Scripted / out-of-band            | `FRONTIER_HUMAN=1 git commit ...`                   |
| Merge commit                      | exempt automatically (subject starts with `Merge `) |
| Revert                            | exempt (subject starts with `Revert `)              |
| `git commit --fixup` / `--squash` | exempt (subject starts with `fixup! ` / `squash! `) |

### Behavior summary

- canonical labels only — `Session:` (capital S), not `session:`
- field values must be non-empty (whitespace-only counts as empty)
- field order is unconstrained; fields can sit among other body lines
- git-comment lines (`#`-prefixed) are stripped before inspection
- exit `0` accept, exit `1` reject

### Install / uninstall

```sh
./scripts/install-git-hooks.sh                # set core.hooksPath = scripts/hooks
./scripts/install-git-hooks.sh --uninstall    # unset core.hooksPath
```

The installer is idempotent. It does not copy files into `.git/hooks/` — it points git at this directory directly so the hooks travel with the repo.

### Tests

```sh
node --import tsx --test tests/hooks/commit-msg-guard.test.ts
```

20 black-box tests covering accept paths, reject paths, bypass mechanisms, git-generated message exemptions, error-message quality, and case sensitivity.
