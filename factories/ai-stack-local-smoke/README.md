# Factory #1 — ai-stack-local-smoke

Concrete first-factory cell wrapping the existing `ai-stack.local-smoke-nightly` lane. Built per the Factory #1 minimum bar: bounded scope, explicit pass/fail/ambiguous classification, run-ledger entries, kill switch, and alert output that reflects the factory's classification. Do not generalize this into a `FactoryRunner` until a second cell exists.

## Layout

```
factory.json              Spec (objective, allowed/forbidden actions, kill switch, classification rules, bounded repair)
run.ts                    TS wrapper — kill switch → verifier → classify → bounded repair → ledger → alert
state/                    Runtime state. `state/disabled` (presence) is the kill switch.
evidence/                 Per-run JSON artifacts + captured historic failure logs.
tests/factory.test.ts     node --test suite proving classification mutual exclusion, kill switch, repair, end-to-end.
```

`factory.json` rather than `factory.yaml` because the repo uses JSON manifests across `manifests/` and `schemas/`; adding a YAML parser dependency for a single file isn't worth it.

## Lane wrapped

| Surface         | Path                                                                                  |
| --------------- | ------------------------------------------------------------------------------------- |
| launchd plist   | `~/Library/LaunchAgents/com.andre.ai-stack.local-smoke.plist`                         |
| launchd entry   | `/Users/test/bin/ai-stack-local-smoke-nightly`                                        |
| verifier impl   | `/Users/test/bin/ai-stack-local-smoke`                                                |
| underlying tool | `~/frontier-os/bin/frontier mcp smoke --read-only`                                    |
| logs            | `~/Library/Logs/AIStack/local-smoke-agent.{out,err}.log`                              |
| alerts          | written to `~/.frontier/ledger.db` (kind=alert), polled by `scripts/notify-alerts.sh` |

## Classification

Mutually exclusive by construction (single string return; tests assert this):

| Result    | When                                                                         |
| --------- | ---------------------------------------------------------------------------- |
| passed    | exit=0 AND stdout JSON parses AND `failed == 0`                              |
| failed    | exit≠0 OR (JSON parses AND `failed > 0`)                                     |
| ambiguous | exit=−1 (timeout/spawn) OR empty stdout OR non-JSON OR JSON missing counters |

## Bounded repair

Read-only timeout-config check against `/Users/test/bin/ai-stack-local-smoke`. The 2026-04-25T07:55Z failure (`ai-stack-local-smoke-20260425-035014`) was a `subprocess.TimeoutExpired` after 30s. The fix (commit `a623dd6` in `/Users/test`) bumped that to 60s. The factory's "repair" verifies that the bump is still in place; it does not edit the live script. If the value is below 60s the result is `stale` and `repair-did-not-clear-failure` is added to escalations.

## Kill switch

Touch `state/disabled` (any content) to disable. When active:

- factory does not run the verifier
- does not write ledger events
- does not emit alerts
- returns `classification=ambiguous`, `escalations=["kill-switch-active"]`

## Run-ledger entries

One session per run, labeled `factory:ai-stack-local-smoke`. Events:

1. `system` — `factory.run_start`
2. `ops.repair_start` — step `run-verifier`
3. `ops.repair_end` — classification + repair status + evidencePath
4. `alert` (only if classification ∈ {failed, ambiguous}) — fed back through existing `notify-alerts.sh` poller
5. `system` — `factory.run_end`

## Run it

```sh
node --import tsx factories/ai-stack-local-smoke/run.ts
```

Exit codes: `0` passed, `1` failed, `2` ambiguous, `3` crash.

## Tests

```sh
node --import tsx --test factories/ai-stack-local-smoke/tests/factory.test.ts
```
