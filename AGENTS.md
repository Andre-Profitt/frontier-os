# AGENTS.md — frontier-os contract for AI coding agents

Read this before doing work in this repo. Both Codex and Claude Code consume
this file at session start.

## What this repo is

The control plane for a personal multi-agent OS. TypeScript + tsx + Node 20.
SQLite ledger at `~/.frontier/ledger.db` is the source of truth for run history.
Adapters wrap external systems; factories run scheduled work; watchers raise
alerts; an inference broker fronts every LLM call.

See `README.md` for the architecture map and `docs/system-map.md` for the
component-by-component layout.

## Build, typecheck, test

```sh
npm run typecheck                                   # tsc --noEmit
node --import tsx --test src/<area>/__tests__/*.test.ts
node --import tsx --test tests/<area>/*.test.ts
./bin/frontier <family> <subcommand> [--pretty]     # CLI entry point
```

There is no `npm test` — point the runner at the test files you care about.
The full sweep used by CI: see `scripts/hooks/commit-msg` for the canonical
verification command.

## Hard invariants

These hold across every change:

- **No worker writes the main worktree.** Builders work in isolated git
  worktrees (PR R2). Workers see read-only repo state unless their task class
  declares otherwise via `skills/<class>/skill.json`.
- **The inference broker is the single LLM entry point.** Never call a model
  provider directly from a factory, watcher, or CLI command. Use
  `InferenceBroker.callClass({ taskClass, ... })`. New providers go in
  `src/inference/providers/` and register in `config/model-policy.json`.
- **Capacity is measured, not declared.** Token-bucket RPM seeds from
  `state/inference/model-capacity.json` (written by `frontier model
capacity-scan`). Don't hardcode RPM ceilings in code; bump the policy
  defaults only when a measured number disagrees.
- **Factories own state mutations.** Launchd plists, secrets, alerts, ledger
  writes, repo merges go through factory cells with desired-vs-observed
  reconciliation (see `factories/ai-stack-local-smoke/`). Workers propose;
  the factory executes policy.
- **No YAML.** This repo has no YAML parser dep. Use JSON for config and
  contracts; markdown with JSON code-fences is fine for prose+metadata.
- **Commit messages need three fields.** `Session: …`, `Scope: …`,
  `Verification: …` — enforced by `scripts/hooks/commit-msg`. Without them
  the commit is rejected.

## Where things live

```
src/
  inference/        broker, providers, rate-limit, capacity probe
  router/           model routing helpers (broker is the runtime)
  swarm/            Magentic-One single-round runner
  work/             work-graph load/topo-sort/dispatch
  builders/         (PR R2) isolated worktree builders
  commands/         per-subcommand modules referenced from cli.ts
  ledger/           SQLite event store
  watchers/         long-running watchers (smoke, alerts, ghost-shift)
  factories/        factory cell runtimes (ai-stack-local-smoke, ai-radar)
config/
  model-policy.json task-class → model routing
factories/          per-factory contracts (factory.json + run.ts + tests)
skills/             per-task-class agent contracts (skill.json + SKILL.md)
schemas/            JSON Schemas for every contract
state/              runtime state (gitignored except .gitignore stubs)
taste/              rubrics + anti-examples — read before producing artifacts
docs/               architecture docs, runbooks, plans
```

## Skills

Before producing model-routed output, load the matching skill from
`skills/<task-class>/`. Each skill carries:

- `skill.json` — allowed/forbidden tools, side-effect class, verifier mode,
  quality floor, parallelism cap
- `SKILL.md` — role description, success criteria, anti-patterns, prompt
  template

The 5 task classes in v1 (must match `config/model-policy.json:classes`):
`routine_summary`, `patch_builder`, `adversarial_review`,
`research_extraction`, `merge_arbiter`. The skill loader (`src/skills/loader.ts`)
asserts no drift between policy and skills.

## Lanes (Codex vs Claude)

`~/.claude/CLAUDE_LANES.md` is the canonical lane assignment. Briefly: Codex
is the orchestrator (overnight runner, root-router, mechanical refactors).
Claude is the reasoner (architecture, multi-file design, diff-against-intent
review, long-form writing). Don't bounce work to the other agent for lane
purity — bounce only when the task plays to the other's strength.

## Branching

Active work lives on `agent/2026-04-DD/<topic>` branches. Don't push to
`main` directly. PRs merge after the branch's verification command passes
and a taste-rubric review.

## Anti-patterns to avoid

- Embedding prompts inline in factories or swarms instead of loading from
  `skills/`. Drives the "30 paste blocks" pain.
- Calling `process.env.NVIDIA_API_KEY` directly. Use `ModelRegistry.resolveApiKey`.
- Adding YAML frontmatter or YAML config (see invariants).
- Skipping `Verification:` in the commit message and bypassing the hook.
- Running `git checkout` / `git clean` in a directory with another agent's
  uncommitted work. Switch branches only when status is clean or you own
  the changes.

## Pointers

- Architecture: `README.md`, `docs/system-map.md`, `docs/inference-broker.md`
- Skills: `skills/README.md`
- Factories: `factories/<name>/README.md`
- Taste: `taste/README.md` (read before producing reviewable artifacts)
- Lanes: `~/.claude/CLAUDE_LANES.md`
