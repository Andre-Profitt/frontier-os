# Narrow alert filter — context pack hid the alert that motivated Factory #1

## What happened

PR #2 v1 (context-pack CLI, commit `bcdf8c4`) shipped with an alert filter in `src/context/pack.ts:readRecentAlertsForLane` that matched alerts using a single substring pattern:

```sql
AND COALESCE(json_extract(payload, '$.source'), actor, '') LIKE '%${alertSource}%'
```

with `alertSource = "factory.ai-stack-local-smoke"` (the factory's own emitted alert source, set by Factory #1 v2 spec).

Live result on the user's actual ledger: **0 alerts surfaced**, even though the lookback window (7 days) contained 4 high-severity historic alerts including `ai-stack-local-smoke-20260425-035014` — the failure that triggered the entire week of work.

The reason: those historic alerts had `payload.source = "ai-stack.local-smoke-nightly"` (the legacy launchd-script source), not `"factory.ai-stack-local-smoke"` (the new factory-wrapper source). The substring filter matched the latter, which subsumed the former by accident in the substring sense — except the legacy source has a literal `.` instead of the factory prefix `factory.`, so the prefixes diverged and the filter dropped them.

The packet's "Recent alerts" section was empty in production, while the user's ledger contained exactly the alert class the context pack was supposed to surface. **The context pack hid its own reason for existing.**

## Why it was wrong

The point of the alert section is to remind the next agent: "this lane has had real failures recently — don't assume it's healthy just because the verifier passes today." A filter that only matches the new wrapper's emissions misses every alert from before the wrapper existed. In a freshly-wrapped lane, that's _every relevant historic alert_.

More generally: an audit surface that's narrower than the audit need is worse than no surface at all, because it suggests the absence of evidence is evidence of absence.

The mistake was using a single keyword (`alert.source`) as the filter and assuming all alerts for the lane would namespace under it. Reality: alerts for the lane come from at least two emitters — the launchd script directly (legacy) and the factory wrapper (new) — and other emitters could appear later (a watcher, a manual probe). The filter needed to match by lane _identity_, not by emitter _namespace_.

## How to detect

1. **`assertLegacyAndFactoryCoverage` helper in `evals/factory-quality/run.ts` (PR #3 v2).** Pure function: takes an `AlertRecord[]` and required IDs (factory wrapper + legacy + unrelated), returns `{ ok, factoryHit, legacyHit, unrelatedExcluded, reason }`. Tests exercise it with hand-built arrays so a filter regression is detectable without perturbing the production filter.

2. **Eval criterion C9 in `evals/factory-quality/local-smoke-factory-quality.json`** — "Alert filter surfaces both legacy and factory wrapper alerts when present." The criterion seeds a fixture sqlite ledger with three alerts (factory + legacy + unrelated), generates the context pack against it, and asserts factory + legacy are both surfaced and unrelated is excluded.

3. **Anti-example test** `"PR #2 v1 bug — only factory alerts (legacy missing) fails coverage"` in `evals/factory-quality/tests/quality.test.ts`. Feeds the helper a recentAlerts array containing only the factory wrapper alert and asserts `ok = false, legacyHit = false`.

4. **Broadened filter in `src/context/pack.ts:readRecentAlertsForLane` (PR #2 v2 fix).** Now uses an OR over five patterns: factory source substring, lane id substring on source, lane id substring on actor, alertId starts with `<factoryId>-`, and case-insensitive summary keyword match. The keywords come from the spec's `alert.summaryKeywords` array (`["local smoke", "ai stack local smoke"]` for ai-stack-local-smoke).

5. **Section heading change** to `## Recent <factoryId> alerts (legacy + factory wrapper)` — explicitly tells the reader the section spans both layers, so a missing-legacy slip would be visible in review.

## Reference

- PR #2 v1: https://github.com/Andre-Profitt/frontier-os/pull/2 — initial commit `bcdf8c4`.
- GPT Pro v1 review: requested broadening the filter; quoted the historic alert ID `ai-stack-local-smoke-20260425-035014` as the regression case.
- Fix commit: `2bb422b` (`fix(context): broaden alert filter to surface legacy + factory wrapper alerts`).
- Pure helper: `evals/factory-quality/run.ts:assertLegacyAndFactoryCoverage`.
- Eval criterion: `evals/factory-quality/local-smoke-factory-quality.json:C9`.
- Anti-example test: `evals/factory-quality/tests/quality.test.ts` — search for "only factory alerts".
- Live alert source mismatch: the historic alert `ai-stack-local-smoke-20260425-035014` has `payload.source = "ai-stack.local-smoke-nightly"`, NOT `factory.ai-stack-local-smoke`. The bare-source naming convention predates Factory #1 by months.
