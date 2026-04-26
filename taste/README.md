# Taste library

Living definition of "good" for this repo. Read this before producing artifacts; cite it when explaining choices.

The library exists because "polished" is underspecified. A worker that does not know what excellent looks like in a specific codebase mean-reverts to generic output. This directory documents:

- **rubrics/** — the criteria that make an artifact good (factory run, handoff packet, etc.)
- **anti_examples/** — concrete failure modes from real sessions, with citations. Use these as "do not do this" reference cases.

When a real reviewed failure surfaces (a GPT Pro change-request, a production incident, a regression in this repo's own work), it should land here as a new anti-example. The goal is that **every prior reviewed failure becomes a permanent guardrail**.

JSON, not YAML. The repo has no YAML parser dep and adding one for two rubric files would be wasted complexity.

## Layout

```
taste/
├── README.md                                  ← this file
├── rubrics/
│   ├── factory_run_rubric.json                ← what makes a good factory cell run
│   └── handoff_rubric.json                    ← what makes a good handoff / review packet
└── anti_examples/
    ├── wrong_repo_hallucination.md            ← prior assistant imported context from a different repo
    ├── false_green_repair.md                  ← PR #1 v1: stale repair could coexist with classification=passed
    └── narrow_alert_filter.md                 ← PR #2 v1: alert filter dropped legacy alerts
```

## Rubric shape (canonical)

Every rubric JSON file follows this minimum schema:

```json
{
  "rubricId": "factory_run",
  "version": "v1",
  "summary": "what this rubric grades",
  "criteria": [{ "id": "R1", "title": "...", "rationale": "...", "weight": 1 }],
  "non_goals": ["explicit list of things this rubric does NOT grade"]
}
```

Validation lives in `tests/taste/structure.test.ts`. Adding a new rubric must keep the test passing.

## Anti-example shape (canonical)

Every anti-example markdown file has these sections, in order:

1. `# <Short, blunt title>`
2. `## What happened` — the concrete event, with date and PR or commit reference if available.
3. `## Why it was wrong` — the underlying principle violated.
4. `## How to detect` — the heuristic or test that would have caught this earlier; if it now exists in the codebase, link to it (file path, criterion id).
5. `## Reference` — links to the actual artifacts (commit hashes, PR numbers, diff lines).

## How to use this directory

- **Before doing creative work:** read the relevant rubric and skim recent anti-examples in the same area.
- **After getting a review:** if the review revealed a failure mode that isn't already an anti-example here, add it.
- **When citing taste:** name the rubric or anti-example file and the criterion / section. Don't paraphrase.

## What this directory is NOT

- It is **not** an automated checker. The eval suite (`evals/factory-quality/`) does that for one workflow; future eval suites would extend coverage.
- It is **not** style guides for code formatting (the repo uses prettier for that).
- It is **not** a substitute for tests. Tests prove correctness; rubrics + anti-examples explain "what good looks like" so you write the right code in the first place.
