# Patch Summary — Response to GPT Pro Architecture Review

**Date:** 2026-04-26
**Original review brief:** `docs/architecture-review-brief-2026-04-26.md`
**This document:** what changed in response to GPT's blocking + strongly-recommended items, with file:line citations and test names so the re-review can verify each fix without re-reading the full diff.

All eight items from GPT Pro's "must-fix before merge" + "strongly recommended before merge" tiers landed across the four-PR stack as four discrete patches. **207/207 tests pass, typecheck clean.**

## What landed

```
PR #11  044dbd0  Patch A — broker modelOverride + selectedResponse + permgate symlink note
PR #13  993bd60  Patch B — ReviewPacket coverage fields prevent false-clean
PR #14  ffe2760  Patch C — builder model pinning + diff-scope gate
PR #15  25b109e  Patch D — arbiter eligibility hardening
```

The patches were rebased onto each other in dependency order (A → B → C → D); each downstream branch was force-pushed after rebase. PR diffs on GitHub show the rebased-then-fixed state.

## Issue-by-issue map

| #     | Issue (GPT's words)                                             | Patch | Where the fix lives                                                                                                                                                                                                                                                                | Pinning test                                                                                                                                                                                                 |
| ----- | --------------------------------------------------------------- | ----- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **1** | Builder model pinning appears not to work                       | A + C | `src/inference/broker.ts:36-55` (`modelOverride` in `BrokerCallOptions`); `src/inference/broker.ts:213-227` (filter to override candidate); `src/swarm/builder-swarm.ts:255-267` (passes `pinnedModelKey` through)                                                                 | `broker.test.ts` "callClass: modelOverride pins to that exact (provider, model)"; `builder-swarm.test.ts` "pinned modelKeys are passed to broker.callClass({modelOverride})"                                 |
| **2** | Review failures can look like clean reviews                     | B + D | `src/swarm/review-swarm.ts:70-79` (new fields on ReviewPacket); `src/swarm/review-swarm.ts:225-247` (counter logic); `src/arbiter/arbiter.ts:266-276` (arbiter requires `reviewCoverageOk`)                                                                                        | `review-swarm.test.ts` "all reviewers return non-JSON → reviewCoverage=0, totalFindings=0 — must NOT look 'clean'"; `arbiter.test.ts` "low reviewCoverage with empty findings → escalate, not accept"        |
| **3** | Rubric score can be 1.0 with almost no coverage                 | D     | `src/arbiter/types.ts:42-58` (`coverage`, `scoredWeight`, `totalWeight`, `unsupportedCriteria` on RubricScore); `src/arbiter/rubric-scorer.ts:90-122` (computes coverage during aggregation); `src/arbiter/arbiter.ts:255-262` (gates on score AND coverage)                       | `arbiter.test.ts` "rubric coverage below minRubricCoverage → escalate, not accept"                                                                                                                           |
| **4** | Builder patch scope is not enforced                             | C     | New file `src/swarm/diff-scope-checker.ts` (parses unified-diff headers, set-membership match, rejects binary/absolute/parent-traversal); `src/swarm/builder-swarm.ts:288-306` (gate runs between extract and `git apply`); new `CandidatePhase` value `scope_rejected`            | `diff-scope-checker.test.ts` "file outside touchList → allowed=false"; `builder-swarm.test.ts` "diff outside touchList → phase=scope_rejected, git apply not called, rawText preserved"                      |
| **5** | Arbiter verification claim is stronger than the code guarantees | D     | `src/arbiter/types.ts:11-20` (new `VerificationPhase` value `passed_typecheck_only`); `src/arbiter/verifier.ts:87-99` (verifier emits new phase when `testCommand` absent); `src/arbiter/arbiter.ts:243-251` (arbiter's `verPassed` requires `passed` unless `requireTests=false`) | `verifier.test.ts` "typecheck pass + no test command → phase=passed_typecheck_only"; `arbiter.test.ts` "typecheck-only verification with requireTests=true → reject" + "...with requireTests=false → accept" |
| **6** | Missing anti-example files are silently skipped                 | D     | `src/arbiter/arbiter.ts:130-138` (track `missingAntiExamplePaths`); `src/arbiter/arbiter.ts:307-312` (escalate when any path failed to load); evidence packet calls them out                                                                                                       | `arbiter.test.ts` "missing anti-example file → escalate (config error, not silent skip)"                                                                                                                     |
| **7** | PermissionGate's symlink comment is unsafe                      | A     | `src/builders/permission-gate.ts:96-117` — comment rewritten to honestly state "v1 PermissionGate is lexical only and must not be used as the final authority for real filesystem writes without lstat/realpath symlink checks"; new test pins the documented limitation           | `permission-gate.test.ts` "isInsideWritablePath: KNOWN LIMITATION — lexical-only, not symlink-safe"                                                                                                          |
| **8** | Broker response shape (body + assistantText)                    | A     | `src/inference/broker.ts:57-66` (new `NormalizedModelResponse`); `src/inference/broker.ts:73-83` (`selectedResponse` on `BrokerCallResult`); `src/inference/broker.ts:374-409` (`normalizeResponse` helper); body/assistantText REMOVED from `AttemptRecord` (no coexist)          | `broker.test.ts` "selectedResponse populated on success — text from choices[0].message.content" + "selectedResponse falls back to JSON-stringify when body is not OpenAI-shape"                              |

## Beyond the issue list — other changes worth flagging

### Reject vs escalate distinction (across #2, #3, #5)

GPT called for:

> objective failure → reject
> review uncertainty → escalate

Implemented in `src/arbiter/arbiter.ts:298-345`:

- 0 collected → `reject`
- missing anti-example → `escalate_to_human` (config error)
- 0 eligible AND ≥1 candidate has objective failure (verPassed/rubricScoreOk/anti-example match) → `reject`
- 0 eligible AND only uncertainty (low coverage, confirmed high-severity) → `escalate_to_human`
- exactly 1 eligible → `accept`
- multiple eligible → `escalate_to_human` (no auto-tiebreak)

High-severity reviewer findings now ESCALATE (claim, not confirmed defect) rather than auto-reject. The pre-Patch logic conflated these cases.

### Rubric scorer signal for `passed_typecheck_only`

`src/arbiter/rubric-scorer.ts:158-168` — verification-derived criteria score 0.5 (partial signal) when phase is `passed_typecheck_only`. The arbiter's `verPassed` gate (which honors `requireTests`) is the layer that decides eligibility; the rubric scorer just reports the partial signal so coverage is non-zero.

### Stub broker mirrors real broker

Both `review-swarm.test.ts` and `builder-swarm.test.ts` stub brokers were rewritten to construct a proper `BrokerCallResult.selectedResponse` (instead of stuffing `assistantText` onto `AttemptRecord`). This keeps the tests honest about the broker's contract — a test that passes `assistantText` through the stub now exercises the same `selectedResponse.text` path the real broker uses.

The builder-swarm stub also captures `modelOverride` per call into a `callLog` so the model-pinning test asserts both:

- the broker received the correct override
- the resulting candidate's `modelKey` matches the pinned key

### Schemas updated

- `schemas/review-packet.schema.json` — `validReviewerCount`/`invalidReviewerCount`/`failedReviewerCount`/`reviewCoverage` required
- `schemas/builder-swarm-packet.schema.json` — `phase` enum gains `scope_rejected`
- `schemas/arbiter-decision.schema.json` — `verificationResult.phase` enum gains `passed_typecheck_only`; `rubricScore` requires `coverage`/`scoredWeight`/`totalWeight`/`unsupportedCriteria`

## Test deltas

| Suite                                                                            | Before patches | After patches | Δ                                                                                                                                                   |
| -------------------------------------------------------------------------------- | -------------- | ------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/inference/__tests__/*`                                                      | 49             | 58            | +9 (modelOverride routes/rejects, selectedResponse on success/failure/non-OpenAI, normalizeResponse)                                                |
| `src/skills/__tests__/*`                                                         | 16             | 16            | unchanged                                                                                                                                           |
| `src/builders/__tests__/*`                                                       | 27             | 28            | +1 (permgate lexical-only known-limitation pin)                                                                                                     |
| `src/swarm/__tests__/*` (review + builder + diff-extractor + diff-scope-checker) | 40             | 73            | +33 (4 review-coverage, 2 builder model-pinning, 4 builder scope, 18 diff-scope-checker, 5 misc)                                                    |
| `src/arbiter/__tests__/*`                                                        | 31             | 37            | +6 (review-coverage gate, rubric-coverage gate, typecheck-only ×2, missing-anti-example) — plus 5 existing tests updated to match stricter behavior |
| **Total**                                                                        | **163**        | **207**       | **+44**                                                                                                                                             |

No tests skipped, no `todo`. All assertions tightened, none weakened.

## What's still deferred (per original brief, GPT did not push back)

- **LLM judge for soft rubric criteria** — `merge_arbiter` task class still empty in `config/model-policy.json`
- **Auto-`combine` decisions** — schema accommodates, decision logic still skips
- **Sustained-RPM probe** — burst is the conservative seed; sustained is a different probe shape
- **Quality-ledger writer + DSPy flywheel** — no labeled corpus yet
- **Egress whitelist for `read.web`** — needs OS-level network mediator
- **Real `lstat`/`realpath` symlink check in PermissionGate** — comment now honest; runtime check is a follow-up when a writer needs it
- **Anti-example matching with explicit machine-readable patterns** — heading-grep is advisory; per-anti-example pattern files come when we have a corpus to validate against
- **`swarmHealth` block on `BuilderSwarmPacket`** — operator-visibility nice-to-have
- **R6 `frontier orchestrate`** wrapper

## What changed in the API surface (so consumers know)

Breaking, but only on this branch (no production callers):

- `BrokerCallResult.selectedResponse: NormalizedModelResponse | null` is now a required field (added to all return paths).
- `BrokerCallResult.rejected` enum gains `"model-override-not-found"`.
- `AttemptRecord` no longer has `body` or `assistantText` fields (replaced by `BrokerCallResult.selectedResponse`).
- `ReviewPacket` has 4 new required fields: `validReviewerCount`, `invalidReviewerCount`, `failedReviewerCount`, `reviewCoverage`.
- `ReviewerFindingInput` has new optional `reviewCoverage` field; arbiter requires it when findings are provided for that builder.
- `RubricScore` has 4 new required fields: `coverage`, `scoredWeight`, `totalWeight`, `unsupportedCriteria`.
- `VerificationPhase` enum gains `"passed_typecheck_only"`.
- `CandidatePhase` enum gains `"scope_rejected"`.
- `BuilderSwarmInput.modelKeys[]` now actually routes (was previously stored on `BuilderRun` but never passed to broker).
- New `ArbiterInput` options: `minRubricCoverage` (default 0.5), `minReviewCoverage` (default 0.66), `requireTests` (default true).

All of these are tested. No flag-to-flip-the-default exists for any of them; the new behavior IS the default.

---

**Re-review focus.** GPT can re-evaluate the four original questions against the patched code:

1. **Eligibility predicate** (Q1) — the hard AND now includes `rubricCoverageOk` and `reviewCoverageOk`. Reject vs escalate is split. Is the new logic right?
2. **Heuristic-only rubric** (Q2) — coverage now exposed and gated. Is `minRubricCoverage=0.5` the right default? Is the keyword mapping (`"passed implies"` → verification, `"false-green"` → reviewer findings) good enough as v1?
3. **Builder failure tolerance** (Q3) — phase enum gained `scope_rejected`. swarmHealth block is still deferred. Is the failure-mode taxonomy good enough now, or should the apply_failed substructure (`applyFailureKind`) land before merge?
4. **Broker response shape** (Q4) — `selectedResponse: NormalizedModelResponse` is the new canonical. body/assistantText fully removed. Is this the right minimal interface?

Same six files plus `src/swarm/diff-scope-checker.ts` (new) and `src/arbiter/verifier.ts` (changed) cover the surface area.
