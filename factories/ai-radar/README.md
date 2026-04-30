# factories/ai-radar — AI Radar Factory (v0)

Upstream intelligence factory. Watches official AI ecosystem signals
(changelogs, GitHub releases, arXiv RSS) and turns them into structured
`RadarItem` records plus a daily markdown digest.

This is PR #8 of the radar PR sequence described in
[`docs/handoffs/2026-04-26-ai-radar-factory-handoff.md`](../../docs/handoffs/2026-04-26-ai-radar-factory-handoff.md).

## What this factory IS

- A periodic collector of external AI signals from declared sources.
- A normalizer that maps raw HTML/RSS/JSON/Markdown into a canonical
  `RadarItem`.
- A trust-tier scorer (official > maintainer > community > rumor).
- A deduper across runs (`state/seen-items.json`).
- A daily markdown digest writer.

## What this factory IS NOT (yet)

- It does NOT extract claims, score impact, or recommend actions
  beyond defaulting to `remember`. That lives in PR #9
  (upgrade planner).
- It does NOT fetch from Discord, YouTube, Slack, Twitter, or any
  unregistered source. Those land in PR #10 with their own permission
  models (authorized-bot-only for Discord; known-channel-registry for
  YouTube; never private scraping).
- It does NOT mutate `model-policy`, `skills/`, `taste/`, or any other
  factory's surface. PR #8 is collection only — the upgrade loop is
  PR #9–#11.
- It does NOT auto-apply upgrades. The radar policy is propose-only;
  factory supervisors and human review own application.

## Files

| File              | Purpose                                                                                                |
| ----------------- | ------------------------------------------------------------------------------------------------------ |
| `factory.json`    | Lane contract: activation modes, allowed/forbidden actions, classification rules.                      |
| `sources.json`    | Registry of Tier 1 official sources for v0. No Discord/YouTube.                                        |
| `types.ts`        | `RadarItem`, `Source`, `TrustTier` definitions.                                                        |
| `source-trust.ts` | Tier definitions and tier→score mapping.                                                               |
| `normalize.ts`    | Per-source-kind normalizers from raw bytes to `RadarItem`.                                             |
| `fetch.ts`        | HTTP GET with timeout + body cap + user-agent.                                                         |
| `digest.ts`       | Markdown digest writer.                                                                                |
| `run.ts`          | Entry point: load sources → fetch → normalize → dedupe → emit.                                         |
| `state/`          | Run state (mode, latest-run, seen-items, kill switch). gitignored.                                     |
| `evidence/`       | Per-run logs (shadow + active mode). gitignored.                                                       |
| `artifacts/`      | Daily digests + items JSON (active mode only). Daily files gitignored; an example digest is committed. |
| `tests/`          | Unit + integration tests. Network is gated by `FACTORY_LIVE=1`.                                        |

## Running

```sh
# unit + normalize tests (no network)
node --import tsx --test factories/ai-radar/tests

# live fetch smoke (hits the registered sources)
FACTORY_LIVE=1 node --import tsx --test factories/ai-radar/tests

# one-shot run (live)
node --import tsx factories/ai-radar/run.ts

# observe mode (no fetch, just verify config + sources)
node --import tsx factories/ai-radar/run.ts --mode observe
```

## AGENTS.md hard rules honored

- No automatic retries: one fetch attempt per source per run.
- No `launchctl`: this factory has no plist; scheduling is by an outer
  launchd lane that calls `run.ts`.
- No third-party agent skill ingestion.
- Commit-msg guard: every commit carries `Session:`/`Scope:`/`Verification:`.
- Verify the repo, not the conversation: source URLs and behavior are
  asserted in tests with fixtures, not described in chat.
- Kill switch wins over everything: a `state/disabled` file
  short-circuits the run before any HTTP.
