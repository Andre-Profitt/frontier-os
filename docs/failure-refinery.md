# Failure Refinery

Phase 6.4 of Frontier OS. The Refinery is the moat — it compounds by promoting
repeated failure traces into eval cases, policy rules, and routing updates.
Every rerun of a failing pattern makes the system harder to break in that same
way next time.

See `frontier-os-v1.md` §13.3 for the full design rationale.

## What it does

The Refinery runs in three stages:

1. **Harvest.** Scan the session ledger (`~/.frontier/ledger.db`) for
   failure-shaped events and group them by a stable cause signature. One
   `HarvestedSignal` per unique cause.
2. **Propose.** Map each signal (above a frequency threshold) to a typed
   `PolicyRuleProposal` with a suggested action. Proposals are advisory.
3. **Promote.** An operator (or a future auto-promotion policy) graduates a
   proposal to an active rule, written to `~/.frontier/refinery/rules.jsonl`.

Nothing in the Refinery mutates the live ledger — the database is opened
read-only during harvest. Proposals and rules live in their own
append-only JSONL files so the audit trail is cheap to diff.

## Source events

The harvester recognizes these failure-shaped event kinds:

| Kind                   | Filter                         | Origin                 |
| ---------------------- | ------------------------------ | ---------------------- |
| `work.node_failed`     | always                         | `src/work/executor.ts` |
| `work.verifier_fail`   | always                         | `src/work/executor.ts` |
| `work.verifier_check`  | `payload.passed === false`     | `src/work/executor.ts` |
| `work.node_skipped`    | always                         | `src/work/executor.ts` |
| `ghost.graph_rejected` | always                         | `src/ghost/shift.ts`   |
| `command.failed`       | always                         | `src/commands/store.ts` |
| `agent.review`         | `payload.verdict === "reject"` | hook-emitted           |

## Cause signature

```
${kind}::${check_name_if_any}::${firstLineOfReasonNormalized}
```

Where "normalized" means lowercased, whitespace-collapsed, and with
run-specific tokens replaced by placeholders:

- ISO timestamps → `<ts>`
- Home / tmp paths → `<path>`
- Long hex or alnum ids → `<id>`
- "exit N" / "exited N" → `exit <n>`
- Bare 3+ digit integers → `<n>`

Signatures are stable across runs, so the same underlying failure always
groups into the same bucket.

## Suggested actions

| Action                  | When chosen                                        | Effect (next phase)                    |
| ----------------------- | -------------------------------------------------- | -------------------------------------- |
| `add_rubric_pattern`    | verifier trace_grade failures                      | extends the trace_grade red-flag regex |
| `reject_in_ghost_shift` | ghost.graph_rejected                               | refuses matching graphs overnight      |
| `raise_approval_class`  | generic node failures, command failures, verifier_fail, node_skipped | bumps affected nodes to class ≥ 2      |
| `add_pre_tool_hook`     | agent.review verdict=reject                        | registers a pre-tool-use hook block    |

The chooser is heuristic; operators override by editing a proposal before
promoting.

## How to run

```bash
# 1. Scan the ledger.
frontier refinery harvest --since 2026-04-01T00:00:00Z --limit 500

# 2. Turn signals into rule proposals.
frontier refinery propose --since 2026-04-01T00:00:00Z --min-frequency 2

# 3. Inspect the on-disk state.
frontier refinery rules --show-proposals

# 4. Promote a specific proposal to an active rule.
frontier refinery promote rule_<id>
```

Files are written to:

```
~/.frontier/refinery/
  proposals.jsonl    # every proposal ever written, append-only
  rules.jsonl        # every promotion, append-only (loader picks latest per ruleId)
```

## Example output

A single harvest signal might look like:

```json
{
  "signature": "work.verifier_fail::trace_grade::trace_grade: trace contained red-flag patterns: todo, stub, placeholder",
  "sourceKind": "work.verifier_fail",
  "checkName": "trace_grade",
  "reasonNormalized": "trace_grade: trace contained red-flag patterns: todo, stub, placeholder",
  "count": 4,
  "firstSeen": "2026-04-18T22:00:00Z",
  "lastSeen": "2026-04-19T01:05:57.614Z",
  "exampleEventIds": ["evt_...", "evt_..."],
  "exampleReasons": [
    "trace_grade: trace contained red-flag patterns: TODO, stub, placeholder"
  ]
}
```

Which produces this proposal:

```json
{
  "ruleId": "rule_2f1a9b33",
  "pattern": {
    "kind": "work.verifier_fail",
    "checkName": "trace_grade",
    "reasonRegex": "^trace_grade: trace contained red-flag patterns: todo, stub, placeholder$"
  },
  "reason": "work.verifier_fail (trace_grade): ... — 4 occurrences",
  "suggestedAction": "add_rubric_pattern",
  "evidence": {
    "signature": "...",
    "count": 4,
    "firstSeen": "...",
    "lastSeen": "...",
    "exampleEventIds": ["evt_..."],
    "exampleReasons": ["..."]
  },
  "proposedAt": "2026-04-19T02:00:00Z"
}
```

## Ledger events

The registry emits `refinery.*` events on each state change:

- `refinery.proposal_appended` — a new (or refreshed) proposal row was written.
- `refinery.rule_promoted` — a proposal graduated to an active rule.

These kinds are not yet part of the `EventKind` union in
`src/ledger/events.ts`; the registry casts through `as any` at the call site
so the code typechecks ahead of the merge snippet that adds them.

## Operator notes

- **Proposals are append-only.** Re-running `refinery propose` after the
  failure count grows writes a new row; the loader picks the latest row per
  `ruleId`. Old rows stay as audit evidence.
- **Promotion is one-way from the registry's perspective.** There is no
  `unpromote` — the design is to tombstone with a revoke row, which is not
  implemented yet. For now, manual removal of a line from `rules.jsonl`
  works because the loader reads the whole file.
- **ruleId is deterministic.** It's an fnv-1a 32-bit hash of the signature
  string. Two runs of the Refinery on the same failure produce the same
  ruleId.
