# Current Assets

Date: March 19, 2026
Status: inventoried from local workspace

## Summary

We are not starting from zero.

The most important existing asset is an operational `Claude <> Siri <> runtime` bridge inside [`companion-platform`](/Users/test/azure-storage-optimizer/companion-platform). This should be treated as the seed system for Frontier OS, not as a side project.

## Asset 1: Siri Bridge Runtime

Path:

- [`siri_bridge.py`](/Users/test/azure-storage-optimizer/companion-platform/scripts/siri_bridge.py)

What exists:

- SSH-invoked bridge from iPhone Shortcuts into the Mac runtime
- commands for `status`, `brief`, `ask`, `runs`, `approve`, and `memory`
- runtime API integration for summary, approvals, runs, and memory search
- model failover path:
  - Claude CLI first
  - Codex CLI second
  - raw fallback last

Why it matters:

- proves the `phone as surface, Mac as brain` pattern
- already implements runtime-first routing instead of direct phone-side intelligence
- already has a practical spoken-output interface

Key evidence:

- command surface and purpose in [`siri_bridge.py:2`](/Users/test/azure-storage-optimizer/companion-platform/scripts/siri_bridge.py#L2)
- runtime API helpers in [`siri_bridge.py:60`](/Users/test/azure-storage-optimizer/companion-platform/scripts/siri_bridge.py#L60)
- Claude/Codex failover in [`siri_bridge.py:103`](/Users/test/azure-storage-optimizer/companion-platform/scripts/siri_bridge.py#L103)
- `cmd_brief()` in [`siri_bridge.py:220`](/Users/test/azure-storage-optimizer/companion-platform/scripts/siri_bridge.py#L220)

Assessment:

- high strategic value
- medium implementation maturity
- should be kept and absorbed, not replaced

## Asset 2: Generated Siri Shortcuts Pack

Paths:

- [`generate_siri_shortcuts.py`](/Users/test/azure-storage-optimizer/companion-platform/scripts/generate_siri_shortcuts.py)
- [`shortcuts/`](/Users/test/azure-storage-optimizer/companion-platform/shortcuts)

What exists:

- generated and signed shortcuts for:
  - `Morning Brief`
  - `Companion Status`
  - `Recent Runs`
  - `Check Approvals`
  - `Ask Claude`
  - `Search Memory`
  - `Morning Ingest`
- binary `.shortcut` generation
- signing through `shortcuts sign --mode anyone`
- explicit UUID-based variable wiring

Why it matters:

- gives us a concrete mobile surface already tied to runtime APIs
- avoids rebuilding the iPhone entry layer from scratch
- `Morning Ingest` already encodes the right pattern: collect local data, post to runtime, then request synthesized state

Key evidence:

- `build_morning_ingest()` in [`generate_siri_shortcuts.py:305`](/Users/test/azure-storage-optimizer/companion-platform/scripts/generate_siri_shortcuts.py#L305)
- shortcut registry in [`generate_siri_shortcuts.py:517`](/Users/test/azure-storage-optimizer/companion-platform/scripts/generate_siri_shortcuts.py#L517)
- generated files in [`shortcuts/`](/Users/test/azure-storage-optimizer/companion-platform/shortcuts)

Assessment:

- high leverage
- should become the initial mobile command pack for Frontier OS v0

## Asset 3: Jarvis Runtime API

Paths:

- [`jarvis_api.py`](/Users/test/azure-storage-optimizer/companion-platform/runtime/jarvis_api.py)
- [`jarvis_service.py`](/Users/test/azure-storage-optimizer/companion-platform/runtime/jarvis_service.py)
- [`jarvis_store.py`](/Users/test/azure-storage-optimizer/companion-platform/runtime/jarvis_store.py)

What exists:

- separate Jarvis API layer for ingest and spoken synthesis endpoints
- separate service layer for daily-state computation and derived metrics
- separate SQLite store with WAL mode and pooled connections
- endpoints for:
  - `/v1/ingest/health`
  - `/v1/ingest/calendar`
  - `/v1/ingest/context`
  - `/v1/ingest/checkin`
  - `/v1/ingest/workout`
  - `/v1/siri/daily-state`
  - `/v1/siri/morning-brief`
  - `/v1/siri/health`
  - `/v1/siri/meeting-prep`
  - `/v1/siri/synthesize`

Why it matters:

- this is already the beginning of the typed intent and state layer
- it gives us a real runtime-owned intelligence path for daily synthesis
- it already splits persistence, service logic, and HTTP handlers the right way

Key evidence:

- route table in [`jarvis_api.py:462`](/Users/test/azure-storage-optimizer/companion-platform/runtime/jarvis_api.py#L462)
- daily-state handler in [`jarvis_api.py:234`](/Users/test/azure-storage-optimizer/companion-platform/runtime/jarvis_api.py#L234)
- morning-brief synthesis in [`jarvis_api.py:427`](/Users/test/azure-storage-optimizer/companion-platform/runtime/jarvis_api.py#L427)
- store schema in [`jarvis_store.py:144`](/Users/test/azure-storage-optimizer/companion-platform/runtime/jarvis_store.py#L144)
- service classification/trend logic in [`jarvis_service.py:63`](/Users/test/azure-storage-optimizer/companion-platform/runtime/jarvis_service.py#L63)

Assessment:

- very strong asset
- should become the first `intent runtime` to map into the Frontier OS work graph model

## Asset 4: Native Apple Companion App

Paths:

- [`apps/apple-companion/README.md`](/Users/test/azure-storage-optimizer/companion-platform/apps/apple-companion/README.md)
- [`JarvisIntents.swift`](/Users/test/azure-storage-optimizer/companion-platform/apps/apple-companion/Sources/CompanionAppleIntents/JarvisIntents.swift)
- [`CompanionRuntimeClient.swift`](/Users/test/azure-storage-optimizer/companion-platform/apps/apple-companion/Sources/CompanionRuntimeClient/CompanionRuntimeClient.swift)

What exists:

- Swift package with:
  - runtime client
  - Apple UI layer
  - App Intents / App Shortcuts
  - menu bar app
  - mobile host and widget direction
- `JarvisMorningBriefIntent`
- local HealthKit and Calendar capture before runtime call
- runtime-backed fallback model
- local fallback behavior when runtime is unavailable

Why it matters:

- proves the native Apple surface is already underway
- gives us a real App Intents path beyond Shortcuts
- confirms the system can gather local Apple data while keeping the runtime as the source of synthesized intelligence

Key evidence:

- Apple layer responsibilities in [`apps/apple-companion/README.md:37`](/Users/test/azure-storage-optimizer/companion-platform/apps/apple-companion/README.md#L37)
- `JarvisMorningBriefIntent` in [`JarvisIntents.swift:50`](/Users/test/azure-storage-optimizer/companion-platform/apps/apple-companion/Sources/CompanionAppleIntents/JarvisIntents.swift#L50)
- runtime client Jarvis endpoints in [`CompanionRuntimeClient.swift:352`](/Users/test/azure-storage-optimizer/companion-platform/apps/apple-companion/Sources/CompanionRuntimeClient/CompanionRuntimeClient.swift#L352)

Assessment:

- strategically important
- not yet the main operating surface
- should remain thin and runtime-backed

## Asset 5: Existing Operating Doctrine

Paths:

- [`01-system-brief.md`](/Users/test/azure-storage-optimizer/companion-platform/docs/01-system-brief.md)
- [`44-siri-companion-deployment-playbook.md`](/Users/test/azure-storage-optimizer/companion-platform/docs/44-siri-companion-deployment-playbook.md)
- [`36-siri-jarvis-handoff.md`](/Users/test/azure-storage-optimizer/companion-platform/docs/36-siri-jarvis-handoff.md)
- [`2026-03-16-jarvis-morning-intelligence-design.md`](/Users/test/azure-storage-optimizer/companion-platform/docs/superpowers/specs/2026-03-16-jarvis-morning-intelligence-design.md)

What exists:

- system brief with cross-device object model
- stricter deployment playbook with stage gates
- implementation handoff with working shortcuts and infrastructure notes
- morning intelligence design spec for health, calendar, work, and synthesis

Why it matters:

- the doctrine already matches the stronger strategy:
  - runtime first
  - thin Apple surfaces
  - typed objects
  - bounded voice surface
  - inspectable trust
- we should reuse these as v0 product doctrine instead of rewriting them from scratch

Assessment:

- high value
- some docs are stale in details and need consolidation

## What Is Actually True Today

Frontier OS already has a functioning precursor:

- a runtime-backed Siri bridge
- a morning intelligence flow
- generated shortcut surfaces
- native Apple intent surfaces
- a local state store
- endpoint tests around Jarvis ingest and synthesis

## Verification Signal

Focused verification ran against the current Jarvis stack:

- `runtime/tests/test_jarvis_store.py`
- `runtime/tests/test_jarvis_service.py`
- `runtime/tests/test_jarvis_api.py`
- `runtime/tests/test_jarvis_shortcuts.py`

Result:

- `161 passed`

Interpretation:

- the current Jarvis foundation is not just conceptual
- the bridge, store, service, API, and shortcut builder have meaningful automated coverage

## Documentation Drift To Fix

One important drift already surfaced during inventory:

- older handoff material still describes `Morning Brief` as hitting `/v1/siri/brief`
- the current shortcut generator points `Morning Brief` at `/v1/siri/morning-brief`
- the native runtime client also exposes `/v1/siri/morning-brief`
- the runtime keeps `/v1/siri/brief` as a backward-compatible alias to Jarvis `morning-brief`

That means we now have multiple brief surfaces and some stale docs.

Short-term rule:

- treat implementation files and tests as source of truth
- treat handoff docs as advisory until reconciled

That means our roadmap should start with:

- consolidation
- hardening
- unifying contracts
- elevating the runtime into a broader work-control plane

Not with:

- greenfield product ideation
- replacing the Apple bridge
- inventing a second unrelated mobile entry system

## Recommended Absorption Strategy

Treat `companion-platform` as `Frontier OS v0`.

Promote these pieces into the new roadmap:

1. `Jarvis runtime` becomes the first domain-specific execution and memory runtime.
2. `Siri bridge` becomes the first production mobile control/capture surface.
3. `Morning Brief` becomes the first flagship ritual and trust-building daily workflow.
4. `Apple companion app` becomes the thin native shell over runtime state.
5. `Jarvis schemas and endpoints` become seeds for the broader work graph and intent model.

## Gaps Between Current Assets And Frontier OS

- no unified work graph across Jarvis and broader enterprise work
- no durable orchestration layer like Temporal/NATS around these flows
- no unified artifact store and trace grading loop
- no enterprise-wide policy engine across all actions
- no single contract tying Apple intents, CLI jobs, and enterprise runs together

## Immediate Use In The Roadmap

The first roadmap phase should now be:

- consolidate companion-platform into Frontier OS core
- standardize current Jarvis endpoints as typed intent contracts
- harden `Morning Brief`, approvals, and memory recall as founder-grade rituals
- extend from `Jarvis daily intelligence` into `work intelligence`
