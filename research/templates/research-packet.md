# Research packet — `<topic>`

**Run id:** `<runId>`
**Started at:** `<ISO timestamp>`
**Spec schema:** `frontier_os.research.packet_spec.v1`

## Question

_The specific question this packet answers. Must be narrow enough that
a reader can tell whether a claim is on-topic._

## Scope

_What's in. What's out. What's deferred._

## Motivation

_Why now. Which lane / project / PR will consume this packet._

## Acceptance criteria

- [ ] Every criterion has at least one supporting claim with `status: "supported"`
- [ ] No claim's `quoteOrSummary` exceeds 35 words
- [ ] Sources span at least two independent providers
- [ ] `review.md` adversarial pass complete

## Findings

_Populate as claims land in `claim-ledger.ndjson`. Each entry below
should reference at least one `claimId` so a reader can trace the
narrative back to durable evidence._

### Finding 1

`claimIds: claim_..., claim_...`

_One paragraph synthesis. Cite quotes by claimId, not by source URL —
the source ledger is the place for URLs._

### Finding 2

...

## Open questions

_Things you found that this packet does NOT close. These should
become the next research run, not be hidden in a footnote._

## Recommended next loops

_If this research changes a skill, eval, anti-example, or factory
invariant, name the artifact:_

- skill update: `skills/<id>/SKILL.md` — _what changes_
- anti-example: `taste/anti_examples/<name>.md` — _what to avoid_
- eval case: `evals/<id>/...` — _what to test_
- model policy: `<class>: <provider>` — _routing change_
