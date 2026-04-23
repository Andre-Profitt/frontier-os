# Frontier OS Repo Blueprint

Date: April 8, 2026
Mode: personal control plane

## Goal

Turn the current `frontier-os` nucleus into a CLI-first personal AI OS that:

- controls important systems through the strongest available interface
- keeps an always-on watcher layer for work, spend, and drift
- learns from traces without becoming an unsafe self-modifying black box
- reduces human-in-the-loop to approvals, priorities, and operating doctrine

## Target Repo Shape

```text
frontier-os/
  README.md
  current-assets.md
  docs/
    repo-blueprint.md
    system-map.md
  contracts/
    jarvis-intent-catalog.md
    cli-surface.md
    adapter-contract.md
    watcher-contract.md
  schemas/
    intent-envelope.schema.json
    work-graph.schema.json
    adapter-manifest.schema.json
    adapter-invocation.schema.json
    adapter-result.schema.json
    watcher-spec.schema.json
    alert-event.schema.json
    memory-record.schema.json
    policy-pack.schema.json
    model-routing-policy.schema.json
  manifests/
    adapters/
      browser.adapter.json
      salesforce.adapter.json
    watchers/
      overnight-review.watcher.json
      runpod-idle-killer.watcher.json
      work-radar.watcher.json
  examples/
    policies/
      personal-default.policy.json
    workgraphs/
      salesforce-dashboard-audit.json
  adapters/
    browser/
      README.md
    salesforce/
      README.md
  watchers/
    README.md
  memory/
    README.md
  policy/
    README.md
  bin/
    README.md
```

## Core Rule

Build the system in this order:

1. Contracts
2. Adapters
3. Watchers
4. Memory writeback
5. Model routing
6. Wider surface area

Do not start by building a giant autonomous loop. Start by making a few adapters precise and verifiable.

## CLI Surface

The control plane should converge on a single operator surface:

```text
frontier adapter list
frontier adapter inspect browser current-tab
frontier adapter invoke salesforce inspect-dashboard --input examples/workgraphs/...
frontier watcher list
frontier watcher run overnight-review
frontier alert list
frontier alert ack <alert-id>
frontier memory search "runpod idle"
frontier policy show personal-default
frontier route explain --task browser_task --goal "audit dashboard"
```

Rules:

- every command emits JSON by default
- human-friendly rendering is a view concern, not the system contract
- the CLI may call native CLIs, CDP, Apple automation, or HTTP APIs underneath

## First Build Order

### Phase 1: Spine

Ship first:

- adapter invocation/result contracts
- watcher spec
- memory record schema
- personal policy pack
- model routing policy

### Phase 2: High-Leverage Adapters

Build first:

- `browser`
- `salesforce`
- `terminal`
- `github`

Why:

- they unlock your current work fastest
- `salesforce` depends on `browser`
- `terminal` and `github` give the system a strong local/dev spine

### Phase 3: Spend and Drift Watchers

Build next:

- `runpod-idle-killer`
- `overnight-review`
- `work-radar`

Why:

- they reduce recurring waste
- they give the system an always-on operational identity

### Phase 4: Cloud and Compute

Add:

- Azure
- Databricks
- Kaggle
- Sigma
- local GPU / model broker

### Phase 5: Apple and Voice Surfaces

Integrate:

- Siri
- Shortcuts
- native Apple intents

These should remain thin control surfaces backed by the runtime.

## Minimum Viable Outcome

The first milestone is not "AGI at home."

It is:

- attach to active Chrome or Atlas
- inspect a live Salesforce dashboard
- produce a structured audit
- apply one approved improvement through the UI
- verify the change
- record the outcome in memory
- surface a next-step alert in the overnight review

## Non-Negotiables

- typed JSON contracts
- approvals for destructive or billable actions
- verification before side effects
- durable logs and memory writeback
- adapter-local undo or rollback where possible
- model routing as policy, not ad hoc habit
