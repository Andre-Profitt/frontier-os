# Architecture Review Brief — Inference Layer (PRs #11 → #13 → #14 → #15)

**Date:** 2026-04-26
**Author of code:** Claude Opus 4.7 (1M context)
**Reviewer:** GPT Pro (manual review surface)
**Scope:** ~10K lines added across 7 commits in 4 stacked PRs implementing the dark-factory inference layer for `frontier-os`.

This is a self-contained brief. Paste it into ChatGPT and ask GPT Pro to focus on the four questions in **§ The four review questions** below. The brief is organized so a 30-second read of the TL;DR + diagram is enough to orient; the rest fills in evidence.

---

## TL;DR

The frontier-os repo gained four stacked PRs implementing a measured-then-routed inference layer: an OpenAI-compatible **broker** with empirical RPM scoring, **per-task-class skill contracts** in `skills/<class>/{skill.json,SKILL.md}`, **isolated git worktrees** for builders with a permission gate, a **review swarm** that fires N parallel reviewers via the broker, a **builder swarm** that fires N parallel patch attempts in worktrees, and a **merge arbiter** that re-runs verification and decides accept/reject/escalate over the candidates. Total: **9,998 LOC added, 163/163 tests, typecheck clean.** Nothing auto-merges; nothing decides without ground-truth re-runs.

The architecture is the response to the "two routers, not one" critique: a **model router** (the broker, choosing which model serves which task class) plus a **work router** (the builder swarm + worktree manager + arbiter, choosing which worker takes which work and what they're allowed to do).

**Key contested choices to scrutinize:**

1. Heuristic-only rubric scoring in v1 (no LLM judge yet) — `rubric-scorer.ts`
2. The arbiter's eligibility predicate as a hard AND (`verPassed && rubricOk && reviewClean && antiClean`) — `arbiter.ts:188`
3. Builder swarm uses `git apply` against LLM-extracted diffs (failure-tolerant per phase) — `builder-swarm.ts`
4. The broker's `AttemptRecord` carries both `body` AND `assistantText` after the R3 tweak

---

## How to use this brief

- Read the TL;DR + architecture diagram below in 60 seconds.
- Skip to **§ The four review questions** to see what to evaluate.
- Use **§ Key contested decisions** as the entry point into the code. Each excerpt has a file:line citation so you can pull the full context from the GitHub PR.
- Treat **§ Deliberate deferrals** as off-limits — these were considered and consciously skipped. Recommending them adds noise.
- Use **§ How to reproduce** to run any test cited.

The full code is on the `agent/2026-04-26/merge-arbiter-r4` branch, also available as PR #15 on GitHub. The four PRs (#11 → #13 → #14 → #15) stack: each one's review surface is small enough to evaluate independently, but they merge as a unit.

---

## Architecture in one diagram

```
┌──────────────────────────────────────────────────────────────────────────┐
│                        frontier-os control plane                          │
│                                                                           │
│   ┌──────────────────────────────────────────────────────────────┐       │
│   │  Broker (PR #11 / R0.5)                                        │       │
│   │  - InferenceBroker.callClass({taskClass, messages})            │       │
│   │  - per-(provider,model) token-bucket RPM, seeded from           │       │
│   │    state/inference/model-capacity.json (empirical, not guess)   │       │
│   │  - capped+jittered backoff on 429/5xx                           │       │
│   │  - fallback across candidate models in the class                │       │
│   │  - AttemptRecord exposes body + assistantText on success        │       │
│   └──────────────────────────────────────────────────────────────┘       │
│                  ↑                                  ↑                     │
│                  │                                  │                     │
│   ┌──────────────────────┐         ┌──────────────────────────┐          │
│   │ Skill loader (R0)     │         │ WorktreeManager (R2)      │          │
│   │ - skills/<class>/     │         │ - .worktrees/<runId>/      │          │
│   │   {skill.json,SKILL.md}│         │ - branch builders/<runId>  │          │
│   │ - allowed/forbidden    │         │ - baseCommit-pinned diff   │          │
│   │   tools, side-effects  │         │ - schema-validated state   │          │
│   │ - drift assertion vs   │         │ - PermissionGate           │          │
│   │   model-policy.json    │         │   (3-layer fs/tool check)  │          │
│   └──────────────────────┘         └──────────────────────────┘          │
│                  ↑                                  ↑                     │
└──────────────────│──────────────────────────────────│─────────────────────┘
                   │                                  │
        ┌──────────┴──────────┐         ┌────────────┴──────────────┐
        │                     │         │                           │
   ┌────────────────┐  ┌──────────────────┐  ┌──────────────────────┐
   │ ReviewSwarm    │  │ BuilderSwarm      │  │ Arbiter               │
   │ (PR #13 / R3)  │  │ (PR #14 / R5)     │  │ (PR #15 / R4)         │
   │                │  │                   │  │                       │
   │ N reviewers,   │  │ N builders,       │  │ Consumes both packets │
   │ adversarial_   │  │ patch_builder     │  │ + rubric + anti-      │
   │ review skill,  │  │ skill, worktree   │  │ examples              │
   │ JSON           │  │ each, diff        │  │                       │
   │ deliverable,   │  │ extractor + git   │  │ Re-runs typecheck +   │
   │ findings agg'd │  │ apply + commit    │  │ test in each worktree │
   │ by category +  │  │ + collect.        │  │ Heuristic rubric      │
   │ severity.      │  │ phase enum on     │  │ scoring (null on soft │
   │                │  │ every failure.    │  │ criteria, not faked). │
   └────────────────┘  └──────────────────┘  │                       │
                                              │ Decision:             │
                                              │ accept | reject |     │
                                              │ escalate_to_human.    │
                                              │ Never auto-merges.    │
                                              │ Never picks combine.  │
                                              └──────────────────────┘
```

**Producer/consumer flow:**

```
  task → BuilderSwarm → BuilderSwarmPacket → Arbiter
              │                                 ↑
              │      (per candidate diff)       │
              ▼                                 │
        ReviewSwarm  →  ReviewPacket  ─────────┘
```

In v1 the operator (or a future R6 `frontier orchestrate`) glues these three commands together. The arbiter never applies the chosen patch — it produces a recommendation and an evidence packet.

---

## What landed (7 commits, 4 PRs)

```
PR #11  agent/2026-04-26/inference-broker → main
        d673e53  feat(inference): broker + NIM provider (PR-A)
        66189d5  feat(inference): empirical capacity scanner (R0.5)
        99cd52f  feat(skills): per-task-class skill contracts + loader (R0)
        3c42645  feat(builders): worktree manager + permission gate (R2)

PR #13  agent/2026-04-26/review-swarm-r3 → #11
        6ba6a1d  feat(swarm): review swarm — N parallel reviewers (R3)

PR #14  agent/2026-04-26/builder-swarm-r5 → #13
        ad3363d  feat(swarm): builder swarm — N parallel patches (R5)

PR #15  agent/2026-04-26/merge-arbiter-r4 → #14
        42094b0  feat(arbiter): merge arbiter — re-run + rubric (R4)
```

**Diff stats vs. main:** 59 files changed, 9,998 insertions, 3 deletions. Modified files: `.gitignore`, `src/cli.ts`, `src/schemas.ts`. Everything else is new.

**Largest new files (LOC):**

- `src/swarm/__tests__/builder-swarm.test.ts` — 569
- `src/swarm/builder-swarm.ts` — 492
- `src/inference/__tests__/capacity-probe.test.ts` — 467
- `src/inference/capacity-probe.ts` — 418
- `src/builders/worktree-manager.ts` — 395
- `src/arbiter/arbiter.ts` — 390
- `src/inference/broker.ts` — 369
- `src/builders/__tests__/worktree-manager.test.ts` — 365
- `src/swarm/__tests__/review-swarm.test.ts` — 360

**Tests across the stack:**

| Suite                                     | Tests   | Exercises                                                                                  |
| ----------------------------------------- | ------- | ------------------------------------------------------------------------------------------ |
| `src/inference/__tests__/rate-limit`      | 6       | token-bucket math, penalize, retry-after parsing                                           |
| `src/inference/__tests__/backoff`         | 6       | capped exp + full jitter, retryable status enum                                            |
| `src/inference/__tests__/nvidia-nim`      | 8       | NIM provider with recorded fixtures, env-key resolution                                    |
| `src/inference/__tests__/broker`          | 11      | class routing, 429 retry+log, fallthrough, semaphore                                       |
| `src/inference/__tests__/capacity-probe`  | 18      | latency stats, ramp ceiling, budget cap, file merge                                        |
| `src/skills/__tests__/loader`             | 16      | every shipped skill validates, drift vs `model-policy.json`, default-forbid injected       |
| `src/builders/__tests__/worktree-manager` | 14      | real `git worktree` against mkdtempSync repos, slug-safe IDs, schema-validated state       |
| `src/builders/__tests__/permission-gate`  | 13      | forbid wins, closed-by-default, fs scope with prefix-substring guard                       |
| `src/swarm/__tests__/review-swarm`        | 15      | parallel dispatch, JSON-from-prose extraction, broker rejection tolerance                  |
| `src/swarm/__tests__/diff-extractor`      | 13      | fenced/inline diff extraction, longest-first, false-`@@` rejection                         |
| `src/swarm/__tests__/builder-swarm`       | 12      | spawn/broker/extract/apply/commit/collect lifecycle, real `git apply`, every failure phase |
| `src/arbiter/__tests__/rubric-scorer`     | 10      | heuristic mapping, weighted aggregate, null-on-soft-criterion                              |
| `src/arbiter/__tests__/verifier`          | 8       | re-run with stub exec, stderr truncation, missing-worktree path                            |
| `src/arbiter/__tests__/arbiter`           | 13      | accept/reject/escalate paths, anti-example match, schema validation                        |
| **Total**                                 | **163** | typecheck clean across all PRs                                                             |

---

## The four review questions

GPT Pro: focus your review here. Other concerns are welcome but treat them as secondary.

### Q1. The arbiter's eligibility predicate

```typescript
// src/arbiter/arbiter.ts:182-189
const eligibility = collected.map((c) => { ... });
const eligible = eligibility.filter((e) => e.eligible);
// where:
const eligible = verPassed && rubricOk && reviewClean && antiClean;
```

Is the hard AND right? Specifically:

- **verPassed** — re-run typecheck + test in the candidate's worktree. Hard gate.
- **rubricOk** — `rubricScore.score >= qualityFloor` (default 0.7). Heuristic-only in v1.
- **reviewClean** — zero high-severity bugs OR contract_violations from reviewers.
- **antiClean** — no anti-example match in the candidate's diff.

Risks I see:

- **rubricOk under-tested** — heuristic scoring leaves many criteria `null`. A candidate that scores 1.0 on the only-non-null criterion still aggregates to 1.0. Is that overconfident?
- **reviewClean is binary** — one false-positive `bug` from one reviewer kills a candidate. Should multi-reviewer agreement be required?
- **Tied eligible candidates → escalate_to_human** — never auto-tiebreaks. Is that the right safety posture, or wasteful (operator picks N times when they could trust score-rank)?

### Q2. Heuristic rubric scoring

```typescript
// src/arbiter/rubric-scorer.ts:90-145 — scoreCriterion()
const blob = `${c.title} ${c.rationale}`.toLowerCase();
if (blob.includes("passed implies") || blob.includes("invariant")) {
  // verification-derived signal
}
if (blob.includes("false green") || blob.includes("false-green")) {
  // reviewer false_green count
}
// ... else: { score: null, rationale: "no objective heuristic ..." }
```

The keyword mapping from rubric criterion text → objective signal is **deliberately fragile**. Bad scoring is worse than no scoring; when the rubric author rewrites a criterion, the heuristic intentionally degrades to `null` rather than fabricate a number.

**Tradeoff to scrutinize:** Should v1 ship with this honest-but-fragile approach, or wait for an LLM judge in the `merge_arbiter` task class to fill in soft criteria? The argument for shipping heuristic-only is: we have ZERO labeled rubric scores in the quality-ledger today, so an LLM judge would be vibes-judging-vibes. The argument against: operators may misread a `score=1.0` as confident when only one criterion was even attempted.

### Q3. Builder swarm failure tolerance

`runBuilderSwarm` records a `phase` per candidate from this enum:

```typescript
type CandidatePhase =
  | "spawn_failed" // WorktreeManager.spawn threw
  | "broker_failed" // broker rejected or threw
  | "no_diff_extracted" // model output had no parseable diff
  | "apply_failed" // `git apply --check` rejected
  | "applied" // diff applied but commit failed
  | "committed" // committed but collect() failed
  | "collected"; // success — patch captured for arbiter
```

Every failure path preserves `rawText` (the broker's response) so a human can salvage. The packet is always coherent — partial failures don't crash the swarm.

**What I want challenged:**

- Are there failure modes I missed? (E.g. worktree disk-full, git lock contention, broker partial response)
- Is the phase enum the right granularity, or should `apply_failed` split into "patch corrupt" vs "patch context-mismatch"?
- The builder runs with `--no-verify` to skip the commit-msg hook. Justified ("builder commits live on throwaway branches the arbiter judges") or sneaky?

### Q4. Broker's `body` + `assistantText` plumbing

I tweaked `AttemptRecord` in PR #13 to expose two new fields:

```typescript
// src/inference/broker.ts:56-72
export interface AttemptRecord {
  // ... existing fields
  errorPreview?: string;
  body?: unknown; // NEW — parsed provider response on success
  assistantText?: string; // NEW — extracted from choices[0].message.content
}
```

```typescript
// src/inference/broker.ts:330-343 — extractAssistantText()
function extractAssistantText(body: unknown): string | null {
  if (typeof body !== "object" || body === null) return null;
  const choices = (body as { choices?: unknown }).choices;
  if (!Array.isArray(choices) || choices.length === 0) return null;
  // ... pulls choices[0].message.content
}
```

Why two fields: success cases need the assistant text downstream (review-swarm, builder-swarm), but providers vary in shape. `body` is the parsed JSON; `assistantText` is the convenience field for OpenAI-compatible responses; non-standard providers fall back to `body`.

**What I want challenged:** Is this the right shape, or should `BrokerCallResult` have a top-level `selectedResponse: ChatResponse` separate from `selected: AttemptRecord`? The current shape couples the response to every attempt record, which is wasteful for the failed attempts that have `body` set to nothing.

---

## Key contested decisions (with code)

These are the choices most likely to draw review fire. I'm pre-listing them so the brief justifies them upfront.

### Decision 1: Capacity scanner measures **burst**, not sustained, RPM

**Where:** `src/inference/capacity-probe.ts:240-265` (`runBurstWave`)

```typescript
// Concurrent burst — fires `targetRpm` calls in parallel and waits for all.
// Spaced spawn (one every 1000/targetRpm ms) would be more faithful to
// "RPM" but adds variance from setTimeout drift; concurrent burst is the
// stricter test and matches token-bucket burst behavior.
async function runBurstWave(...) { ... }
```

A real sustained-RPM probe would send at rate X for 60+ seconds. With 100-call budget per model, that means observing X ≤ 1.6 — useless. So v1 measures burst. The `recommendedBucketRpm = floor(observedSafeRpm * 0.65)` further conservatizes. Live NIM scan: `gpt-oss-120b` shows `observedSafeRpm=10`, `recommendedBucketRpm=6` (vs. forum-claimed 40 sustained). Conservative seed; can be raised after a sustained probe in a future PR.

### Decision 2: Skills use JSON metadata + markdown body, no YAML frontmatter

**Where:** `taste/README.md` (the rule), `skills/<class>/{skill.json,SKILL.md}` (the implementation), `schemas/skill.schema.json` (the contract)

The standard SKILL.md convention (OpenAI Codex, Anthropic Claude Skills, etc.) uses YAML frontmatter. This repo has no YAML parser dep and the `taste/README.md` rule says "JSON, not YAML." So skills split: `skill.json` for the loader, `SKILL.md` for the prose. Loses interop with external SKILL.md consumers; gains schema validation and zero new deps.

### Decision 3: One worker = one worktree (R2 invariant)

**Where:** `src/builders/worktree-manager.ts:101-153` (`spawn`)

Builders cannot share repo state. Each gets `.worktrees/<runId>/` on branch `builders/<runId>`. The state file at `state/builders/<runId>.json` is the source of truth; `git worktree list` is a secondary check. Hard rule: `taskId`/`builderId` must match `[a-zA-Z0-9_.-]+` — no `../etc/passwd` injection. State is schema-validated on **both write AND read**.

### Decision 4: Permission gate enforces fs scope with prefix-substring guard

**Where:** `src/builders/permission-gate.ts:96-107` (`isInsideWritablePath`)

```typescript
isInsideWritablePath(target: string): boolean {
  const abs = resolve(target);
  for (const root of this.writablePaths) {
    if (abs === root) return true;
    if (abs.startsWith(root + sep)) return true;  // ← sep matters
  }
  return false;
}
```

Without the `+ sep` guard, `/tmp/worker-1-other/file.ts` would `startsWith` `/tmp/worker-1` and falsely allow. Tested in `permission-gate.test.ts:151-165`. Symlinks are not followed — workers in v1 should not be following them anyway; we don't `realpath()`.

### Decision 5: Review swarm tolerates non-JSON output

**Where:** `src/swarm/review-swarm.ts:215-285` (`tryParseReviewerOutput`, `extractJsonCandidates`)

Reviewers wrap JSON in markdown fences, prepend prose, refuse JSON entirely. The extractor scans for balanced `{...}` blocks and returns longest first. On total parse failure: `ok: true, output: null, rawText: "..."` so a human can salvage. Never crashes the packet.

### Decision 6: Builder swarm trims trailing newline at writer boundary, not extractor

**Where:** `src/swarm/builder-swarm.ts:380-388` (`applyDiffToWorktree`)

```typescript
// git apply rejects patches that don't end with a newline ("corrupt
// patch at line N"). The diff extractor trims trailing whitespace; we
// re-append the newline at the writer boundary so the contract stays
// clean.
const diffText = opts.diffText.endsWith("\n")
  ? opts.diffText
  : `${opts.diffText}\n`;
```

The extractor's job is to identify diffs; the writer's job is to make `git apply` happy. Splitting the responsibility avoids the extractor having to know about downstream consumers.

### Decision 7: Arbiter never picks `combine`

**Where:** `src/arbiter/arbiter.ts:212-224` (decision branch)

`combine` is a valid `decision` in the schema but v1 never picks it automatically — combining diffs requires per-hunk reasoning ("which version wins for hunk H in file F"). v1 instead recommends `escalate_to_human` when multiple candidates pass; the operator can choose to combine after reading the evidence. This is the safest posture.

### Decision 8: AGENTS.md hard rules over "smart" defaults

**Where:** `AGENTS.md` § Hard invariants

The repo's AGENTS.md declares invariants that survive any change:

- No worker writes the main worktree.
- The inference broker is the single LLM entry point.
- Capacity is **measured**, not declared.
- Factories own state mutations (launchd, secrets, alerts).
- No YAML.
- Commit messages need three fields (`Session:`, `Scope:`, `Verification:`).

These are CI-enforceable claims, not aspirations. The skill loader's `DEFAULT_FORBID = [exec.git.push, launchd.apply]` is the in-code enforcement of "no worker pushes; no worker installs launchd jobs."

---

## Deliberate deferrals (already considered, do not flag)

- **LLM judge for soft rubric criteria** — `merge_arbiter` task class is intentionally empty in `config/model-policy.json` until a frontier model is wired with measured-good performance on the role. Cost-conscious; better to ship heuristic+null than fake scores.
- **Auto-`combine` decisions** — per-hunk reasoning over multi-file diffs is its own PR. Schema accommodates, decision logic skips.
- **Sustained-RPM probe** — different probe shape, more budget per wave; v1 measures burst (more conservative). Recommend re-running periodically.
- **Quality-ledger writer + DSPy flywheel** — only meaningful once arbiter has produced labeled examples.
- **Egress whitelist for `read.web`** — needs OS-level network mediator; `PermissionGate` only handles filesystem scope today.
- **R6 `frontier orchestrate`** — wraps build → review → arbitrate. Trivial to add once the three commands are stable; not in scope here.
- **Persisting ArbiterDecisions to a quality-ledger** — schema is ready (`schemas/arbiter-decision.schema.json`); writer + ledger SQL come with R6.
- **MCP integration for builder/reviewer tool calls** — skills declare `mcp.read.*` / `adapter.<id>.*` verbs but the runtime doesn't bind them yet. R7+.
- **Streaming responses through the broker** — out of scope per `docs/inference-broker.md`. Recommend keeping non-streaming until R7.

---

## How to reproduce / inspect

Clone and check out the merge-arbiter branch:

```sh
gh repo clone Andre-Profitt/frontier-os
cd frontier-os
git checkout agent/2026-04-26/merge-arbiter-r4
npm install
```

**Run the full test suite:**

```sh
npm run typecheck
node --import tsx --test \
  src/inference/__tests__/*.test.ts \
  src/skills/__tests__/*.test.ts \
  src/builders/__tests__/*.test.ts \
  src/swarm/__tests__/*.test.ts \
  src/arbiter/__tests__/*.test.ts
# expected: 163/163 pass
```

**Re-run the live NIM probe (consumes ~60 free-tier calls per model):**

```sh
NVIDIA_API_KEY=... node --import tsx scripts/probe-nim.ts openai/gpt-oss-120b 60
# writes state/inference/model-capacity.json
```

**End-to-end smoke (no real LLM — uses ollama-local):**

```sh
# 1. spawn 2 builders against a trivial task
./bin/frontier swarm build \
  --task smoke-1 \
  --description "no-op smoke test" \
  --builders 2 \
  --base-branch main \
  --pretty

# 2. arbitrate (skip-verify since smoke task has no real changes)
./bin/frontier arbiter decide \
  --packet ./build-smoke-1.json \
  --skip-verify \
  --pretty
```

**Just the arbiter logic against synthetic packets:**

```sh
node --import tsx --test src/arbiter/__tests__/arbiter.test.ts
# 13 tests cover accept/reject/escalate paths
```

---

## Branch / PR map

| Branch                              | PR                                                          | Base                                | Commits                                    |
| ----------------------------------- | ----------------------------------------------------------- | ----------------------------------- | ------------------------------------------ |
| `agent/2026-04-26/inference-broker` | [#11](https://github.com/Andre-Profitt/frontier-os/pull/11) | `main`                              | `d673e53`, `66189d5`, `99cd52f`, `3c42645` |
| `agent/2026-04-26/review-swarm-r3`  | [#13](https://github.com/Andre-Profitt/frontier-os/pull/13) | `agent/2026-04-26/inference-broker` | `6ba6a1d`                                  |
| `agent/2026-04-26/builder-swarm-r5` | [#14](https://github.com/Andre-Profitt/frontier-os/pull/14) | `agent/2026-04-26/review-swarm-r3`  | `ad3363d`                                  |
| `agent/2026-04-26/merge-arbiter-r4` | [#15](https://github.com/Andre-Profitt/frontier-os/pull/15) | `agent/2026-04-26/builder-swarm-r5` | `42094b0`                                  |

Merge order: #11 first, then rebase #13 onto main, merge #13, then rebase #14, etc. Each PR description has a "Stacks on" callout naming dependencies.

---

## Glossary

- **Broker** — `InferenceBroker.callClass({taskClass, messages})`. The single LLM entry point. Picks model from `config/model-policy.json:classes[taskClass].models`, applies token-bucket RPM, retries on 429/5xx, falls through on persistent failure.
- **Skill** — declarative agent contract per task class. `skills/<class>/skill.json` (machine-readable allowed/forbidden tools, side-effects, verifier mode, quality floor) + `skills/<class>/SKILL.md` (role, success criteria, anti-patterns, prompt template).
- **Task class** — routing category in `config/model-policy.json:classes`. The 5 v1 classes: `routine_summary`, `patch_builder`, `adversarial_review`, `research_extraction`, `merge_arbiter`.
- **Worktree** — isolated git checkout for one builder. `.worktrees/<runId>/` on branch `builders/<runId>`. Built with `git worktree add`.
- **Permission gate** — `src/builders/permission-gate.ts`. Three-layer check: forbid wins → allow closed-by-default → fs-scope guard.
- **BuilderSwarmPacket** — output of `runBuilderSwarm`. N candidate patches with phase/patch/rawText.
- **ReviewPacket** — output of `runReviewSwarm`. N reviewer findings aggregated by severity/category.
- **ArbiterDecision** — output of `decide()`. `accept | reject | escalate_to_human` with re-run verification + rubric scores + anti-example matches + evidence string.
- **Quality floor** — minimum aggregate rubric score required for a candidate to be eligible. Default 0.7.
- **DEFAULT_FORBID** — `[exec.git.push, launchd.apply]`. Injected into every skill's `forbiddenTools` by the loader. Defense in depth: even if a skill author forgets, the loader catches it before deploy.

---

End of brief. ~3,300 words.
