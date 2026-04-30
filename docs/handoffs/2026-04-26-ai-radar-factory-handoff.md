# AI Radar Factory — Handoff to a Fresh Session

**Date:** 2026-04-26
**Repo:** `~/frontier-os` (TypeScript control plane)
**Status:** Spec only — no code yet
**Why this handoff exists:** Prior session ran out of context. This document is the full product spec for a new factory + a starter prompt so a fresh session can pick up cleanly.

---

## Orientation prompt (paste this into a new Claude Code session)

> I'm continuing frontier-os work. Read `docs/handoffs/2026-04-26-ai-radar-factory-handoff.md` end-to-end before doing anything. The spec describes a new `factories/ai-radar/` factory that turns external AI ecosystem signals (official changelogs, papers, GitHub releases, Discord, YouTube) into structured upgrade candidates for frontier-os. **No auto-apply** — radar proposes, sandbox tests, human-or-eval merges.
>
> Plan of work after reading:
>
> 1. Confirm the repo state (`git status`, `git log -5`, `ls factories/`).
> 2. Start PR #8 from the spec's "PR sequence" section: source registry + digest, NO Discord/YouTube yet. The PR-#8 file list is in the spec under "What to build in the repo".
> 3. Stop after PR #8 lands. Don't plow into PR #9–#12 in one session.
>
> Constraints (verbatim from the spec — do not relax):
>
> - Local factory has decision authority. Cloud is collect+notify only.
> - Auto-merge ONLY for source registry updates, pure memory/taste/skill additions, and non-code config changes with passing evals.
> - Never auto-merge model policy, launchd activation, MCP/tool permission, security-sensitive, `/Users/test/bin/`, or factory supervisor changes.
> - Discord/YouTube collection requires authorized bot/API access in the named server, never private scraping.
> - YouTube `search.list` is 100 quota units/call — use known-channel registries, not blind search.
>
> Sibling project context: Radar (Python, `~/code/apps/radar`) is a personal exocortex that does ingest/triage/recommendations on AI sources too. The two projects are siblings, not duplicates: Radar serves Andre directly via MCP/dashboard; AI Radar Factory feeds frontier-os's own factory pipeline. Don't conflate them. Reuse patterns where it makes sense (claim ledger, source trust tiers, dedup) but don't import code across — frontier-os is TypeScript, Radar is Python.

---

## Full spec (verbatim, source of truth)

Yes. That "radar" should become its own intelligence factory feeding upgrades into the dark factory.

Not a newsletter reader. Not a Discord scraper. A structured loop:

```
external signal
→ source trust score
→ dedupe / normalize
→ evidence extraction
→ impact classification
→ proposed upgrade
→ local eval
→ PR or memory update
→ factory/taste/skill/model-policy update
```

The point is: every external AI development should either be ignored, remembered, tested, or converted into a safe local upgrade.

### The thing to build: AI Radar Factory

Add a new lane:

```
factories/ai-radar/
```

Its job:

> Monitor the AI ecosystem and convert useful external changes into frontier-os upgrades.

This is upstream of everything else.

```
AI Radar
  → tells Factory Supervisor what changed
  → tells Research Factory what to investigate
  → tells Skills/Taste what to remember
  → tells Model Policy what to update
  → tells Eval Suite what to test
```

### The core architecture

```
Source collectors
  → raw items
Normalizer
  → canonical RadarItem
Classifier
  → relevance / novelty / impact / risk
Evidence extractor
  → claim ledger + source ledger
Upgrade planner
  → memory update / eval update / PR proposal / ignore
Verifier
  → local tests / sandbox / human review
Publisher
  → radar digest / queue / PR / skill update
```

The canonical object should be:

```ts
type RadarItem = {
  id: string;
  source: {
    kind:
      | "official_changelog"
      | "github_release"
      | "discord"
      | "youtube"
      | "paper"
      | "blog"
      | "repo_activity"
      | "community_post";
    name: string;
    url: string;
    trustTier: "official" | "maintainer" | "community" | "rumor";
  };
  observedAt: string;
  publishedAt?: string;
  title: string;
  summary: string;
  rawTextPath?: string;
  claims: Array<{
    text: string;
    supportUrl: string;
    confidence: "high" | "medium" | "low";
  }>;
  classification: {
    topic:
      | "model_release"
      | "agent_runtime"
      | "coding_agent"
      | "mcp"
      | "security"
      | "evals"
      | "research"
      | "infra"
      | "local_models"
      | "voice_ui"
      | "workflow";
    novelty: 0 | 1 | 2 | 3;
    impact: 0 | 1 | 2 | 3;
    urgency: 0 | 1 | 2 | 3;
    confidence: 0 | 1 | 2 | 3;
  };
  recommendedAction:
    | "ignore"
    | "remember"
    | "investigate"
    | "create_eval"
    | "update_skill"
    | "update_model_policy"
    | "open_upgrade_pr"
    | "security_review";
  linkedArtifacts: {
    skill?: string;
    eval?: string;
    tasteAntiExample?: string;
    factory?: string;
    pr?: string;
  };
};
```

That object is what prevents "I saw something on Discord" from becoming random chaos.

### Source map: what to monitor

#### Tier 1 — Official release sources

These should be trusted highest.

- OpenAI API changelog
- OpenAI model release notes / product release notes
- Anthropic / Claude Code changelog
- Google Gemini API release notes
- GitHub releases for core tools
- MCP/security advisories

OpenAI maintains an official API changelog for feature/model/API updates; this should be your primary OpenAI signal, not Twitter summaries. Google has official Gemini API release notes, which already include date-stamped API updates. Claude Code has a public changelog in the Anthropic claude-code GitHub repo; that is a high-signal source for coding-agent behavior changes and security/CLI changes. GitHub's REST API has endpoints for releases, including latest release lookup, so your radar can monitor core repos without scraping HTML.

**Radar action:** official release note → `remember` or `open_upgrade_pr` if it affects your model policy, CLI, MCP, evals, or factory behavior.

#### Tier 2 — Papers and research

Monitor:

- arXiv cs.AI / cs.CL / cs.SE / cs.LG
- OpenReview
- Semantic Scholar / Papers with Code
- FutureHouse / PaperQA / research-agent repos
- Sakana / AI Scientist-style projects

arXiv provides programmatic API access and Atom/RSS feeds; its RSS/Atom feeds are available for subject areas and updated daily. arXiv also notes OAI-PMH is preferred for bulk metadata harvesting, while its API is for real-time metadata/search access.

**Radar action:** paper → `investigate` unless it contains a directly implementable infrastructure loop. The output should be a `claim-ledger.json`, not just a summary.

**Scientific reason:** Reflexion showed agents can improve through verbal feedback memory rather than model weight updates, and Voyager showed compounding improvement through a growing executable skill library. Your radar should turn useful research into memory/evals/skills, not merely "interesting links."

#### Tier 3 — Discord / Slack / communities

This is high-signal but lower-trust.

You should monitor Discord only through proper bot/API access in servers where the bot is authorized. Discord Gateway events require selecting intents, and privileged intents involve sensitive data and should be used responsibly. Discord message content is a privileged intent in many cases; if your bot operates in over 100 servers, message content access requires verification/approval.

Slack is easier if you own the workspace/app: its Events API lets apps receive subscribed events via Socket Mode or HTTP endpoint, and `app_mention` events are available for bot mentions.

**Radar action:** Discord/Slack item → never auto-upgrade. It becomes:

```
community-signal
→ corroborate with official docs/GitHub/source
→ then maybe investigate
```

**Important:** no private scraping. No token hacks. No reading servers/channels without permission.

#### Tier 4 — YouTube / podcasts / demos

YouTube is useful for demos, release walkthroughs, talks, and tool behavior, but it is expensive to search blindly. `search.list` costs 100 quota units per call, while the official quota docs say every API request costs at least one unit.

Also, public transcript extraction is not as clean as people assume. YouTube's captions API lists caption tracks, but the docs distinguish listing caption resources from downloading caption content, and caption access depends on authorization/content ownership.

So do not build:

> search YouTube every hour for "AI"

Build:

```
known channel registry
→ poll channel uploads/playlists cheaply
→ fetch metadata
→ transcript only when available/authorized or via approved tool
→ summarize into claims
```

**Radar action:** YouTube item → `investigate`, `remember`, or `update_skill` if it demonstrates an agent workflow or tool pattern.

#### Tier 5 — Web pages without feeds

Use change detection here.

`changedetection.io` is an open-source web page monitoring/change-alert tool, and it supports Docker deployment. RSSHub can generate feeds for many sites/platforms where native RSS is missing; hosted descriptions emphasize thousands of routes across platforms, but I'd treat RSSHub routes as convenience signals, not authoritative proof.

**Radar action:** changed page → diff extract → classify → corroborate.

**Do not let web-page diffs automatically mutate frontier-os.**

### Trust tiers

Your radar needs a trust model.

```
Tier A: official docs / official changelogs / official GitHub release
  Can trigger upgrade candidate.
Tier B: maintainer post / repo issue / release branch / accepted paper
  Can trigger investigation or eval candidate.
Tier C: Discord / YouTube / Twitter / Reddit / newsletter
  Can trigger research only.
Tier D: anonymous rumor / aggregator
  Store only if corroborated.
```

This matters because major AI changes move fast, and community channels often discover problems before official docs do, but they are also noisy.

### The upgrade policy

This is where it becomes useful.

Every radar item should end in exactly one of these:

```
ignore
remember
investigate
update_skill
create_eval
update_model_policy
open_upgrade_pr
security_review
```

Examples:

**OpenAI/Anthropic/Gemini model release**

```
source: official changelog
classification: model_release
action:
  update_model_policy candidate
  run local eval suite
  compare against current model
  if better: open PR updating model policy
```

LiteLLM is relevant here because it provides a unified gateway/proxy across many LLM providers, with cost tracking, monitoring, retry/fallback routing, and many providers behind one interface.

**Claude Code changelog shows permission/security change**

```
source: official changelog
classification: coding_agent/security
action:
  update skill
  update commit guard/eval if relevant
  maybe open PR
```

**Discord thread says "new MCP exploit"**

```
source: Discord
classification: security
action:
  security_review only
  require official advisory/repo proof
  no automatic changes
```

**YouTube demo shows better agent workflow**

```
source: YouTube known channel
classification: agent_runtime
action:
  research packet
  maybe update skill
```

**Paper proposes new agent memory loop**

```
source: arXiv/OpenReview
classification: research
action:
  claim ledger
  maybe taste/skill/eval update
```

### The "auto upgrade" loop

**Do not make radar auto-apply upgrades. Make it auto-propose and auto-test.**

The loop should be:

```
detect
→ classify
→ generate upgrade candidate
→ create sandbox branch
→ run evals
→ compare baseline
→ open PR
→ require review unless low-risk docs/skill update
```

**Auto-merge only for:**

- source registry updates
- pure memory/taste/skill additions
- non-code config changes with passing evals

**Never auto-merge:**

- model policy changes
- launchd activation
- MCP/tool permission changes
- security-sensitive changes
- `/Users/test/bin` changes
- factory supervisor changes

### What to build in the repo

Add a new factory:

```
factories/ai-radar/
  factory.json
  run.ts
  sources.json
  normalize.ts
  classify.ts
  upgrade-planner.ts
  source-trust.ts
  state/
    seen-items.json
    latest-run.json
  artifacts/
    radar-digest-*.md
    radar-items-*.json
  tests/
```

Add source registry:

```json
{
  "sources": [
    {
      "id": "openai-api-changelog",
      "kind": "official_changelog",
      "trustTier": "official",
      "url": "https://developers.openai.com/api/docs/changelog",
      "cadence": "daily",
      "actions": ["model_release", "api_change", "deprecation"]
    },
    {
      "id": "gemini-api-release-notes",
      "kind": "official_changelog",
      "trustTier": "official",
      "url": "https://ai.google.dev/gemini-api/docs/changelog",
      "cadence": "daily"
    },
    {
      "id": "claude-code-changelog",
      "kind": "github_raw_changelog",
      "trustTier": "official_or_maintainer",
      "url": "https://raw.githubusercontent.com/anthropics/claude-code/refs/heads/main/CHANGELOG.md",
      "cadence": "daily"
    }
  ]
}
```

Add channel registry later:

```json
{
  "youtube": [
    {
      "id": "anthropic-channel",
      "channelId": "...",
      "trustTier": "official",
      "pollMode": "uploads_playlist"
    }
  ],
  "discord": [
    {
      "id": "hermes-agent-discord",
      "server": "...",
      "channels": ["announcements", "releases"],
      "permission": "bot_authorized",
      "trustTier": "community"
    }
  ]
}
```

### The daily digest format

Every run should produce:

```
radar-digest-YYYY-MM-DD.md
```

Format:

```markdown
# AI Radar Digest — 2026-04-26

## Upgrade candidates

### 1. Claude Code changed sandbox/permission behavior

Source: official changelog
Trust: official
Impact: high
Recommended action: update agent skill + run guard eval
Why it matters:
...
Proposed local action:
...
Tests to run:
...

## Research candidates

...

## Memory-only items

...

## Ignored / low signal

...
```

The key is not the digest. The key is that the digest points to structured `RadarItem` records.

### "Infrastructure in one area helps another"

This is the important part.

Radar should not only say "new thing." It should map new things to local subsystems:

```
External signal                  Local subsystem to update
New coding model                 model-policy + eval baseline
New Claude Code behavior         skills + hook/eval
New MCP security issue           policy + pre-action hook
New agent memory paper           taste + skills + research factory
New local model release          model-policy + local inference
New YouTube workflow demo        skills + sandbox template
New Discord bug report           investigation queue
New official deprecation         upgrade PR
New benchmark result             eval suite candidate
```

So the radar item should include:

```ts
affectedSubsystems: [
  "factory-supervisor",
  "model-policy",
  "skills",
  "taste",
  "evals",
  "context-pack",
  "security-policy",
  "local-inference",
  "research-factory",
];
```

### The scientific principle

The radar is your environment-feedback loop.

Reflexion and Voyager point to the same pattern: agents improve when external feedback becomes persistent memory and reusable skills rather than disappearing after a session. Reflexion stores linguistic reflections in episodic memory from feedback; Voyager compounds through an executable skill library and self-verification.

For frontier-os, that becomes:

```
external AI ecosystem change
→ RadarItem
→ claim/evidence
→ skill/eval/model-policy update
→ future factory uses it
```

That is how infrastructure from one area helps another.

### Do we need cloud for radar?

Partially.

Radar source collection can be local, but cloud helps for always-on monitoring.

Use this split:

```
Local:
  source registry
  item normalization
  claim ledger
  upgrade PR generation
  evals
  model-policy changes
  decision authority
Cloud:
  lightweight polling for official sources
  heartbeat if local radar stops
  optional webhook receiver for Discord/Slack/GitHub
  notification relay
```

**Do not let cloud auto-apply upgrades. Cloud can collect and notify. Local factory decides and applies.**

### Specific tools to integrate

Now:

- GitHub REST API
- arXiv API / RSS
- YouTube Data API for known channels
- Discord bot with approved intents
- Slack Events API if workspace needed
- changedetection.io for pages without feeds
- RSSHub for feed generation where safe
- feedparser or equivalent feed parser
- LiteLLM for model routing later
- Langfuse or local trace JSON for LLM observability

Langfuse is self-hostable and built for LLM traces, prompt management, evals, and cost/latency analysis; it becomes useful once the radar and factories start calling models regularly.

### PR sequence

Do not build everything at once.

#### PR #8 — Radar source registry + digest

```
factories/ai-radar/sources.json
factories/ai-radar/run.ts
factories/ai-radar/normalize.ts
factories/ai-radar/source-trust.ts
artifacts/radar-digest example
tests
```

Sources:

- OpenAI changelog
- Gemini release notes
- Claude Code changelog
- GitHub releases for core repos
- arXiv RSS/API for selected topics

No Discord/YouTube yet.

#### PR #9 — Radar upgrade planner

```
RadarItem → recommendedAction
RadarItem → affectedSubsystems
RadarItem → proposed PR template
```

No auto-merge.

#### PR #10 — Discord + YouTube collectors

Only after source registry works.

Discord:

- authorized bot only
- specific channels
- no broad scraping
- message content rules respected

YouTube:

- known channel registry
- avoid expensive blind search
- metadata first
- transcript only when allowed/available

#### PR #11 — Model policy loop

```
model-policy.json
baseline eval runner
radar model-release item → eval candidate
```

#### PR #12 — Cloud witness for radar

```
cloud tells you when radar stopped running
```

### The one-liner

Build AI Radar Factory as the upstream intelligence loop:

```
official changelogs + GitHub + papers + Discord + YouTube
→ RadarItem
→ claim ledger
→ impact/risk classification
→ skill/eval/model-policy/factory upgrade candidate
→ sandbox PR
→ reviewed merge
```

That is how the dark factory stops being static and starts upgrading itself from the outside world without turning into chaos.

---

## End of spec

Open questions for the next session to resolve before writing code:

1. Where exactly does `model-policy.json` live in the current frontier-os tree? (Search before assuming.)
2. Does frontier-os already have a "skills" or "taste" surface, or is it spec-only?
3. What's the existing factory contract (look at `factories/ai-stack-local-smoke/` for the canonical shape).
4. Reuse the existing source-trust patterns from `~/code/apps/radar` (Python) — port the trust-tier logic, not the implementation.

Don't start PR #8 until those four are answered.
