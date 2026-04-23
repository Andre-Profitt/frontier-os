# Frontier OS — Consolidation Design

Date: 2026-04-19
Status: accepted, implementation in progress

## What was discovered

Five components existed in parallel, loosely related by intent but not wired
at the engineering level:

1. **frontier-os** (`~/frontier-os/`) — TS orchestrator, SQLite ledger at
   `~/.frontier/ledger.db`, Ghost Shift queue, watcher runtime, adapter
   registry. CLI-only; no HTTP.
2. **companion-platform** (`~/code/platform/companion-platform/`) — Python
   `buildline_cli serve` running on `0.0.0.0:8765` with bearer-token auth.
   Own SQLite state at `~/.runtime/buildline-state.sqlite3` covering runs,
   approvals, memories, daily-state. Handles all 11 `/v1/siri/*` endpoints
   the iOS shortcuts already call. Observer enabled. This is the live Siri
   gateway. Tailscale-exposed at `100.82.39.121:8765`.
3. **SIRI/aegis** (`~/code/apps/SIRI/aegis/`) — Python FastAPI intended for
   memory/briefing (port 8742). Not currently running. Partially duplicates
   companion-platform's memory + briefing features.
4. **nexus** (`~/code/platform/nexus/`) — voice pipeline (mlx-whisper +
   Silero VAD + Kokoro TTS + Ollama brain). Standalone process tree.
5. **jarvis-menubar** (`~/code/apps/jarvis-menubar/`) — Swift macOS menubar
   app that reads `~/.frontier/ledger.db` directly via SQLite read-only WAL
   URI. Already ledger-aware.

## Decision: Frontier OS umbrella

Everything is branded **Frontier OS** at the user-facing surface. Internal
Python package names (`aegis`, `companion_platform`, `nexus`) stay as-is
because rename blast-radius is 60+ files in 3 repos for ~zero engineering
benefit.

## Component names (user-facing)

| Component                  | Internal name        | Role                                                                    |
| -------------------------- | -------------------- | ----------------------------------------------------------------------- |
| Frontier OS (Orchestrator) | `frontier-os`        | Ledger, Ghost Shift, watchers, adapters                                 |
| Frontier Siri Gateway      | `companion_platform` | `/v1/siri/*` + `/v1/ingest/*` HTTP API, bearer auth                     |
| Frontier Brain             | `aegis`              | Memory / RAG / chief-of-staff (dormant; to be folded into Siri Gateway) |
| Frontier Voice             | `nexus`              | STT/VAD/TTS pipeline + Ollama routing                                   |
| Frontier Menubar           | `jarvis-menubar`     | Swift native menubar client                                             |

## The wiring gap

The 11 `/v1/siri/*` handlers read companion-platform's own SQLite, not
frontier-os's. Anything observed by frontier-os (watcher ticks, Ghost Shift
queue state, portfolio-inventory snapshots, audit findings, adapter
invocations) is invisible to Siri today.

## Target architecture

```
iOS Shortcut (Tailscale) -------> Siri Gateway :8765 -------+
  Ask Claude                        /v1/siri/*              |
  Morning Brief                     bearer-auth             |
  Check Approvals                   existing handlers       |
  Recent Runs                         |                     |
                                      v                     v
                       buildline-state.sqlite3   frontier_ledger.py (NEW)
                       (companion's own)         read-only ~/.frontier/ledger.db

Frontier Menubar (Swift) -------> ~/.frontier/ledger.db (direct SQLite, WAL read)
Frontier Notifier (bash) --------> ~/.frontier/ledger.db (direct SQLite, via sqlite3)

Frontier OS (TS) ----------------> ~/.frontier/ledger.db (primary writer)
```

## Concrete wiring plan

### 1. New module: `companion_platform/frontier_ledger.py`

Read-only SQLite reader for `~/.frontier/ledger.db`. Methods:

- `recent_invocations(limit, since_iso) -> list[Invocation]` — from
  `invocation.start`/`invocation.end` event pairs.
- `awaiting_approvals() -> list[Approval]` — from `work.awaiting_approval`
  and `ghost.graph_blocked` events.
- `watcher_last_tick(watcher_id) -> WatcherTick | None` — most-recent
  `watcher.tick` event for a watcher.
- `portfolio_latest() -> PortfolioSnapshot | None` — most-recent
  `audit.enrichment` + snapshot alert from `nightly-sf-portfolio`.
- `recent_alerts(limit, min_severity, since_iso) -> list[Alert]` — from
  `alert` events, severity-ranked.

All return typed pydantic v2 models with `model_dump()` for JSON.

### 2. Augment handlers (don't replace)

| Endpoint             | Before                                     | After                                                                                    |
| -------------------- | ------------------------------------------ | ---------------------------------------------------------------------------------------- |
| `/v1/siri/runs`      | `store.list_runs(limit=10)`                | Merge buildline runs + frontier invocations, rank by `ts`                                |
| `/v1/siri/approvals` | `store.list_approvals(status='requested')` | Merge buildline approvals + frontier awaiting_approval + ghost blocked                   |
| `/v1/siri/status`    | `_build_summary_payload(store)`            | Add frontier section: watcher tick counts, ghost shift queue, portfolio staleReportCount |

### 3. New endpoints (data that doesn't fit existing shapes)

| New                          | Data                                       |
| ---------------------------- | ------------------------------------------ |
| `GET /v1/frontier/portfolio` | Most-recent portfolio snapshot             |
| `GET /v1/frontier/alerts`    | Recent alerts (severity, sinceIso filters) |
| `GET /v1/frontier/watchers`  | All watchers + last-tick summary           |

Same bearer-auth pipeline as existing routes.

### 4. Rebrand user-facing surface

- FastAPI `title` in `aegis/main.py`: "Aegis" → "Frontier Brain"
- Server banner in `companion_platform.buildline_cli serve`: "Companion" → "Frontier Siri Gateway"
- README first line, launchagent plist Label comments

### 5. Retire phase-19.17 HTTP bridge in frontier-os

- Delete `src/bridge/server.ts`, CLI `bridge` subcommand, plist
- Rewrite `scripts/notify-alerts.sh` to `sqlite3 ~/.frontier/ledger.db`
  directly (matches jarvis-menubar's approach; no HTTP dependency)

## Non-goals

- No Python package renames (`aegis`, `companion_platform`, `nexus` stay)
- No directory moves (imports, git histories, launchagent paths stable)
- No migration of buildline-state → frontier-ledger (they stay separate;
  the Siri Gateway becomes the unifier)
- No new voice-pipeline wiring (nexus is out of scope for this phase)

## Rollout order

Phase A (this session): tasks 4, 5, 6, 7, 8 in order.
Phase B (next session): extend to `/v1/siri/memory` once aegis merge direction is decided.
Phase C: App Intents / Shortcuts refresh if any existing shortcut response
shape changes (so far none do).
