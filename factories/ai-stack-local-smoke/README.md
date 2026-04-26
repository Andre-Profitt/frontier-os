# Factory #1 — ai-stack-local-smoke (v2)

Concrete first-factory cell wrapping the existing `ai-stack.local-smoke-nightly` lane. v2 addresses GPT Pro's PR #1 review: the primary verifier is the actual lane script, the final classification cannot be `passed` while a repair is stale or escalations exist, and the inner JSON-shape classifier honors exit-code priority.

## Layout

```
factory.json              Spec — lane wiring, policy, classification rules, bounded repair, alert mapping
run.ts                    TS wrapper — kill switch → primary verifier → inner check → repair → derive final → ledger → alert
state/                    Runtime state. `state/disabled` (presence) is the kill switch.
evidence/                 Per-run JSON artifacts (gitignored) plus committed historic-failure logs.
tests/factory.test.ts     node --test suite (29 tests, 1 env-gated). Covers classification rules, kill switch, repair, final-classification invariant, end-to-end with synthetic primary.
```

`factory.json` rather than `factory.yaml` because the repo uses JSON manifests across `manifests/` and `schemas/`; adding a YAML parser dependency for a single file isn't worth it.

## Lane wrapped

| Surface              | Path                                                                                  |
| -------------------- | ------------------------------------------------------------------------------------- |
| launchd plist        | `~/Library/LaunchAgents/com.andre.ai-stack.local-smoke.plist`                         |
| launchd entry        | `/Users/test/bin/ai-stack-local-smoke-nightly`                                        |
| **primary verifier** | **`/Users/test/bin/ai-stack-local-smoke`** — the actual lane script                   |
| inner check          | `~/frontier-os/bin/frontier mcp smoke --read-only` (supplementary, JSON tool counts)  |
| logs                 | `~/Library/Logs/AIStack/local-smoke-agent.{out,err}.log`                              |
| alerts               | written to `~/.frontier/ledger.db` (kind=alert), polled by `scripts/notify-alerts.sh` |

Primary verifier exit semantics: `0` = ok, `≠0` = failed (regardless of stdout shape), `−1` = ambiguous (spawn error / timeout).

## Classification

Three layers, all mutually exclusive within their tier.

### Inner check (`classify()`) — JSON-shape, exit-code priority

| Inner result | When                                                                     |
| ------------ | ------------------------------------------------------------------------ |
| ambiguous    | exit=−1 OR (exit=0 AND non-JSON/empty/missing-counters stdout)           |
| passed       | exit=0 AND JSON parses AND `failed==0`                                   |
| failed       | exit≠0 (regardless of stdout) OR (exit=0 AND JSON parses AND `failed>0`) |

### Primary verifier — exit code only

| Primary status | When    |
| -------------- | ------- |
| ambiguous      | exit=−1 |
| ok             | exit=0  |
| failed         | exit≠0  |

### Final (`deriveFinalClassification`) — single source of truth

| Final     | When                                                                                                                                 |
| --------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| ambiguous | kill switch active, OR primary ambiguous, OR (primary ok AND repair errored), OR (primary ok AND repair skipped without kill switch) |
| failed    | primary failed, OR (primary ok AND repair stale)                                                                                     |
| passed    | primary ok AND repair status `ok` AND escalations empty AND kill switch inactive                                                     |

Hard invariant (test #21): `classification == "passed"` implies `repair.status == "ok"` AND `escalations.length == 0` AND `killSwitchActive == false` AND `primary.status == "ok"`.

Alert severity is mapped from the **final** classification, not the primary. Stale repair therefore produces a high-severity alert, not a silent green.

## Bounded repair

Read-only timeout-config check against `/Users/test/bin/ai-stack-local-smoke`. The 2026-04-25T07:55Z failure (`ai-stack-local-smoke-20260425-035014`) was a `subprocess.TimeoutExpired` after 30s. The fix (commit `a623dd6` in `/Users/test`) bumped that to 60s. The factory verifies the bump is still in place; it does not edit the live script. If the value is below 60s the result is `stale` and the **final classification downgrades to `failed`** — this is the no-false-green guarantee.

## Kill switch

Touch `state/disabled` (any content) to disable. When active:

- primary verifier is **not invoked**
- inner check is **not invoked**
- repair is **not run** (status `skipped`)
- ledger session is **not opened**
- alert is **not emitted**
- result is `classification=ambiguous`, `escalations=["kill-switch-active"]`

## Run-ledger entries

One session per non-killed run, labeled `factory:ai-stack-local-smoke`. Events:

1. `system` — `factory.run_start`
2. `ops.repair_start` — step `run-primary-verifier`
3. `ops.repair_end` — payload includes `finalClassification`, `primaryStatus`, `primaryExit`, `innerClassification`, `innerToolsPassed/Failed`, `repairStatus`, `escalations`, `evidencePath`
4. `alert` (only when final classification ∈ {failed, ambiguous}) — picked up by existing `scripts/notify-alerts.sh`
5. `system` — `factory.run_end`

## Run it

```sh
node --import tsx factories/ai-stack-local-smoke/run.ts
```

Exit codes: `0` passed, `1` failed, `2` ambiguous, `3` crash.

## Tests

Unit tests (no live spawns):

```sh
node --import tsx --test factories/ai-stack-local-smoke/tests/factory.test.ts
```

Including the live integration test that spawns the real lane script (~13s):

```sh
FACTORY_LIVE=1 node --import tsx --test factories/ai-stack-local-smoke/tests/factory.test.ts
```
