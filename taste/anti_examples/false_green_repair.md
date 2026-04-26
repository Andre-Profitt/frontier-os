# False green — `passed` classification could coexist with a stale repair

## What happened

PR #1 v1 (Factory #1, commit `eab97e7`) had a classification flow that returned `classification: "passed"` even when the bounded repair came back with `status: "stale"` or `status: "error"`. The factory's `runFactoryCell` set `classification` directly from the verifier's exit code; the repair result was attached to the run record but never folded into the final classification.

GPT Pro's PR #1 review caught this:

> A stale/error repair check can coexist with `classification: "passed"`. If the verifier passes but `runBoundedRepair()` returns stale or error, the current code keeps the result as `passed` and emits no alert. That is a false green.

Concretely, the bug shape:

- `primary verifier exit = 0` (the lane script reported healthy)
- `repair.status = "stale"` (the live `/Users/test/bin/ai-stack-local-smoke` script's `frontier mcp smoke` timeout was below the required 60s)
- `classification = "passed"` ← wrong. The factory was telling the world the lane was healthy while the configuration drift that caused the original failure was still present.
- `alertId = null` ← no alert fired because severity is keyed off classification.

The lane had exhibited this exact stale-timeout failure at the start of the session — the historic alert `ai-stack-local-smoke-20260425-035014` was a 30s `subprocess.TimeoutExpired` against the prior version of `/Users/test/bin/ai-stack-local-smoke`. v1 of the factory could not have detected a regression of that fix.

## Why it was wrong

A factory cell's whole purpose is to combine signals into one trustworthy verdict. If any sub-signal indicates the lane is unhealthy or unverifiable, the verdict cannot be `passed`. v1's mistake was treating the verifier as the sole source of truth and treating the repair check as commentary.

The deeper failure is letting `passed` mean "the verifier returned 0" instead of "the lane is verified healthy AND there is no missing evidence AND no escalation is open." Those are different statements. The first one is vulnerable to silent drift; the second is the property the factory should guarantee.

## How to detect

1. **`deriveFinalClassification` in `factories/ai-stack-local-smoke/run.ts` (PR #1 v2).** Single source of truth for the verdict. Inputs: kill switch, primary status, repair status. Output: classification + escalations. The function is the only place classification is computed; everything else (alert severity, ledger payload, exit code) reads from it.

2. **The hard invariant**: `classification == "passed"` ⇒ `kill switch inactive AND primary status == "ok" AND repair status == "ok" AND escalations == []`. Asserted by enumeration over the full state space (kill switch × primary status × repair status — 24 cells in the test suite at `factories/ai-stack-local-smoke/tests/factory.test.ts`, test #21).

3. **Eval criterion C11 in `evals/factory-quality/local-smoke-factory-quality.json`** — "Final classification cannot be 'passed' while repair is stale, errored, or skipped." Weight 2 (heavyweight). Anti-example tests assert that `derive(primary=ok, repair=stale)` returns `failed` and `derive(primary=ok, repair=skipped, ks=false)` does not return `passed`.

4. **Factory-run rubric criterion R4** — "passed implies invariants." Weight 2.

A regression that re-introduced the v1 shape would now fail tests #21 in the factory suite, criterion C11 in the eval suite, and any handoff packet trying to claim the factory shipped.

## Reference

- PR #1 v1: https://github.com/Andre-Profitt/frontier-os/pull/1 — initial commit `eab97e7`.
- GPT Pro v1 review: requested changes; quoted block above.
- Fix commit: `844d8b2` (`fix(factory): tighten local-smoke factory classification and lane verification`).
- Single-source-of-truth function: `factories/ai-stack-local-smoke/run.ts:deriveFinalClassification`.
- Hard invariant test: `factories/ai-stack-local-smoke/tests/factory.test.ts` test #21 ("invariant: classification == 'passed' implies repair.status == 'ok' AND escalations empty").
- Eval criterion: `evals/factory-quality/local-smoke-factory-quality.json:C11`.
