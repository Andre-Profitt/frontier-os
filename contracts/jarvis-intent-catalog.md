# Jarvis Intent Catalog

Date: March 19, 2026
Status: canonical draft

## Purpose

This document maps the current Jarvis companion assets into Frontier OS intent contracts.

The goal is to stop thinking in terms of ad hoc routes and start thinking in terms of:

- canonical intent names
- stable payload contracts
- surface-specific adapters
- backward-compatible endpoint aliases

## Core Rule

An endpoint is not the product contract.

The product contract is the canonical intent.

That allows:

- Siri shortcuts
- Apple App Intents
- CLI
- web/mobile control surfaces
- future enterprise adapters

to all drive the same underlying behavior without proliferating incompatible routes.

## Runtime Response Metadata

Jarvis runtime responses should emit canonical intent metadata in the response body.

Current implementation now emits:

- `intentType`
- `traceId`
- `surfaceChannel`

This sits inside the route payload while the outer runtime envelope continues to carry:

- `meta.request_id`
- `meta.api_version`
- `meta.schema_version`

Practical rule:

- `traceId` currently aliases the runtime request ID
- use it now as the cross-surface audit key
- later we can separate request IDs from longer-lived distributed trace IDs if needed

## Intent Families

### 1. Jarvis Ingest

Used when Apple surfaces capture local human and device context and push it into the runtime.

Canonical intents:

- `jarvis.ingest.health`
- `jarvis.ingest.calendar`
- `jarvis.ingest.context`
- `jarvis.ingest.checkin`
- `jarvis.ingest.workout`

Current route mapping:

| Canonical intent | Current route |
| --- | --- |
| `jarvis.ingest.health` | `POST /v1/ingest/health` |
| `jarvis.ingest.calendar` | `POST /v1/ingest/calendar` |
| `jarvis.ingest.context` | `POST /v1/ingest/context` |
| `jarvis.ingest.checkin` | `POST /v1/ingest/checkin` |
| `jarvis.ingest.workout` | `POST /v1/ingest/workout` |

## 2. Jarvis Read Models

Used when a surface wants state or a bounded synthesis from the runtime.

Canonical intents:

- `jarvis.read.daily_state`
- `jarvis.read.morning_brief`
- `jarvis.read.health_summary`
- `jarvis.read.meeting_prep`

Current route mapping:

| Canonical intent | Current route | Contract role |
| --- | --- | --- |
| `jarvis.read.daily_state` | `GET /v1/siri/daily-state` | structured state + basic spoken fallback |
| `jarvis.read.morning_brief` | `GET /v1/siri/morning-brief` | flagship spoken ritual synthesized from runtime-owned state |
| `jarvis.read.health_summary` | `GET /v1/siri/health` | focused health spoken summary |
| `jarvis.read.meeting_prep` | `GET /v1/siri/meeting-prep` | focused meeting prep packet |

Backward-compatible alias:

- `GET /v1/siri/brief` delegates to `jarvis.read.morning_brief`

### Important distinction

`daily_state` and `morning_brief` are not the same intent.

- `jarvis.read.daily_state` is the state retrieval intent.
- `jarvis.read.morning_brief` is the user ritual and premium synthesis intent.

This distinction should remain explicit in every surface.

## 3. Jarvis Synthesis

Used when a client wants the runtime to synthesize spoken output from provided structured context.

Canonical intent:

- `jarvis.synthesize.brief`

Current route mapping:

| Canonical intent | Current route |
| --- | --- |
| `jarvis.synthesize.brief` | `POST /v1/siri/synthesize` |

## 4. Companion Runtime Control

These are not Jarvis wellness intents; they are runtime/operator intents.

Canonical intents:

- `companion.read.status`
- `companion.read.runs`
- `companion.read.approvals`
- `companion.resolve.approval`
- `companion.search.memory`
- `assistant.ask`

Current route and command mapping:

| Canonical intent | Current implementation |
| --- | --- |
| `companion.read.status` | Siri bridge `status`, runtime summary APIs |
| `companion.read.runs` | Siri bridge `runs`, runtime runs APIs |
| `companion.read.approvals` | Siri bridge `approve` list path, approvals APIs |
| `companion.resolve.approval` | approvals resolve API |
| `companion.search.memory` | Siri bridge `memory`, runtime memory search |
| `assistant.ask` | Siri bridge `ask`, currently Claude first then Codex fallback |

## Surface Mapping

### Siri Shortcuts

Siri shortcuts should call bounded, stable intents.

Preferred mappings:

| Shortcut | Canonical intent |
| --- | --- |
| `Morning Brief` | `jarvis.read.morning_brief` |
| `Morning Ingest` | `jarvis.ingest.health` + `jarvis.ingest.calendar` + `jarvis.read.daily_state` |
| `Companion Status` | `companion.read.status` |
| `Recent Runs` | `companion.read.runs` |
| `Check Approvals` | `companion.read.approvals` |
| `Ask Claude` | `assistant.ask` |
| `Search Memory` | `companion.search.memory` |

### Apple App Intents

App Intents should use canonical intent names internally even if the public App Intent title is user-friendly.

Examples:

| App Intent title | Canonical intent |
| --- | --- |
| `Morning Brief` | `jarvis.read.morning_brief` |
| `Health Check` | `jarvis.read.health_summary` |
| `Meeting Prep` | `jarvis.read.meeting_prep` |
| `Log Check-In` | `jarvis.ingest.checkin` |

### CLI

CLI should become the orchestration surface and emit the same intent envelope.

Examples:

| CLI command family | Canonical intent |
| --- | --- |
| `frontier ask ...` | `assistant.ask` |
| `frontier morning-brief` | `jarvis.read.morning_brief` |
| `frontier approvals list` | `companion.read.approvals` |
| `frontier approval resolve ...` | `companion.resolve.approval` |

## Normalization Decisions

### Decision 1

`Morning Brief` should point at `jarvis.read.morning_brief`, not `jarvis.read.daily_state`.

Reason:

- `Morning Brief` is the ritual surface, not the raw state endpoint
- `daily_state` exists for structured retrieval and lower-level consumers

### Decision 2

Keep `daily_state` as a first-class endpoint.

Reason:

- native clients and internal systems need machine-readable state
- not every client should rely on a prose synthesis endpoint

### Decision 3

Treat `assistant.ask` as a generic assistant intent, not a Claude-branded product contract.

Reason:

- current implementation may be Claude-first
- product contract must survive routing changes across providers

## Migration Policy

Short-term:

- keep current endpoints working
- add canonical intent naming in docs and adapters
- normalize the shortcut generator toward the canonical intent surface

Mid-term:

- add a shared intent envelope for all Apple, CLI, and runtime requests
- emit trace IDs and canonical intent names on every request
- move surface-specific names into adapter layers only

Long-term:

- route all surfaces through one typed intent gateway
- let route paths become transport details rather than product concepts

## Immediate Next Changes

1. Normalize the `Morning Brief` shortcut to the `morning-brief` endpoint.
2. Add canonical intent names to runtime logs and traces.
3. Introduce one versioned intent envelope schema across CLI, Apple, and web surfaces.
