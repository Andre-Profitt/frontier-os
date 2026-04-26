# Factory quality eval — `local-smoke-factory-quality`

First eval suite. Scores whether the local-smoke factory + context-pack workflow does the disciplined things that prevent mean reversion and wrong-context starts.

Concrete-first: this suite is wired specifically to the `ai-stack-local-smoke` factory and the `frontier context pack --lane <lane>` workflow. Do not generalize until a second factory + a second eval suite both exist.

## Layout

```
local-smoke-factory-quality.json   Rubric — 15 criteria with weights and ship/investigate/block thresholds
run.ts                             Runner + criterion scorers + markdown / JSON output
tests/quality.test.ts              22 tests including anti-examples (wrong-repo, false-green, alert-coverage)
```

## Run it

```sh
node --import tsx evals/factory-quality/run.ts             # markdown
node --import tsx evals/factory-quality/run.ts --json      # structured JSON
node --import tsx evals/factory-quality/run.ts --json --pretty
```

Exit codes: `0` ship, `1` investigate, `2` block, `3` crash.

## Criteria

| ID  | W   | Description                                                                                                    |
| --- | --- | -------------------------------------------------------------------------------------------------------------- |
| C1  | 1   | Evidence captured before repair (committed evidence files exist for the factory).                              |
| C2  | 1   | Dirty working tree is surfaced in the context pack, not hidden.                                                |
| C3  | 1   | Context pack explicitly identifies the repo as `frontier-os`.                                                  |
| C4  | 1   | Context pack lists Siri/menu-bar, companion-platform, and `/Users/test/bin` scripts as forbidden areas.        |
| C5  | 1   | Factory spec is found, parsed, and surfaced in the context pack.                                               |
| C6  | 1   | Allowed and forbidden actions from the factory policy are present in the context pack.                         |
| C7  | 1   | Kill switch path and current active flag are present in the context pack.                                      |
| C8  | 1   | Primary verifier path (the actual lane script) is present in the context pack.                                 |
| C9  | 1   | Alert filter surfaces both legacy and factory wrapper alerts when present.                                     |
| C10 | 1   | Factory final classification is mutually exclusive — exactly one of {passed, failed, ambiguous}.               |
| C11 | 2   | Final classification cannot be 'passed' while repair is stale, errored, or skipped (no false green).           |
| C12 | 2   | Kill switch prevents verifier, inner check, repair, ledger writes, and alert emission.                         |
| C13 | 1   | Run ledger entries are written for a normal factory run (system + ops.repair_start + ops.repair_end + system). |
| C14 | 1   | Alert/report severity reflects the FINAL classification, not the raw primary verifier classification.          |
| C15 | 1   | Context-pack generation produces no filesystem or ledger side effects.                                         |

Total weight: 17. Heavy-weight (`>= 2`) criteria: C11, C12.

## Recommendation thresholds

```
ship          score >= 0.95 AND zero failed
investigate   score >= 0.80 AND any failed
block         score < 0.80 OR any heavyweight (weight>=2) failed
```

## Read-only proof

The runner reads `factory.json`, the live ledger (`PRAGMA query_only = 1`), the context-pack output, and the evidence directory. Specifically:

- **C12 does NOT touch the real `factories/<lane>/state/disabled` file.** It uses a synthetic spec rooted in `mkdtempSync(tmpdir())` for the kill-switch detection check, exercises `deriveFinalClassification({ killSwitchActive: true })` for the decision logic, and inspects the `runFactoryCell` source text to assert the kill-switch short-circuit precedes verifier / inner check / repair / ledger calls. A dedicated test asserts the real kill-switch path is not created during scoring.
- **C13 reads past ledger sessions** (`PRAGMA query_only = 1`); it does not run the live factory.
- **C9 / alert filter test** seeds a synthetic ledger DB under `mkdtempSync(tmpdir())` and removes it in `finally`. The production ledger is not seeded with test data.
- **No /Users/test/bin scripts touched, no launchd plist touched.** The eval reads them via the spec for documentation but never opens them for write.
- **C15** is itself the side-effect proof: it captures the filesystem fingerprint before/after a context-pack generation and asserts identity.

## Anti-examples covered by the test suite

| Test                                           | What it asserts                                                                                    |
| ---------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| wrong-repo: `repo.marker = "ai-os"`            | scoreC3 returns failed                                                                             |
| empty `forbiddenAreas`                         | scoreC4 returns failed with the missing keywords listed                                            |
| empty `committedFiles`                         | scoreC1 returns failed                                                                             |
| missing `factorySpecPath`                      | scoreC5 returns failed                                                                             |
| empty allowed/forbidden actions                | scoreC6 returns failed                                                                             |
| empty kill-switch path                         | scoreC7 returns failed                                                                             |
| primary verifier swapped to inner mcp tool     | scoreC8 returns failed (catches the v1-of-Factory-#1 mistake)                                      |
| `derive(primary=ok, repair=stale)`             | classification is `failed`, not `passed`                                                           |
| `derive(primary=ok, repair=skipped, ks=false)` | classification is not `passed` (no false green via skipped)                                        |
| only factory wrapper alerts (legacy missing)   | `assertLegacyAndFactoryCoverage` returns `ok=false` (catches the PR #2 v1 alert-filter regression) |
| only legacy alerts (factory wrapper missing)   | coverage returns `ok=false`                                                                        |
| unrelated alert leaks through filter           | coverage returns `ok=false` with `unrelatedExcluded=false`                                         |
| C12 scoring is itself read-only                | the real `factories/<lane>/state/disabled` is not created                                          |
