# Watcher Contract

Date: April 8, 2026
Status: draft

## Purpose

Watchers are always-on loops that:

- observe systems
- detect conditions
- emit alerts
- take bounded actions when policy allows
- write outcomes into memory

They are the operational identity of the AI OS.

## Required Components

Every watcher must define:

- inputs
- trigger or schedule
- decision policy
- action plan
- alert policy
- memory writeback behavior
- kill switch

The canonical configuration lives in `schemas/watcher-spec.schema.json`.

## Watcher States

- `idle`
- `running`
- `suppressed`
- `blocked`
- `failed`

## Decision Model

For each cycle, a watcher should produce one of:

- `no_change`
- `notify`
- `recommend`
- `act`
- `escalate`

## Safety Rules

### Rule 1

Billable or destructive actions require explicit policy coverage.

### Rule 2

A watcher should not act on opaque heuristics alone when cost or data loss is involved.

### Rule 3

Every watcher action must emit an alert or trace event, even when auto-approved.

### Rule 4

Watcher memory writeback is mandatory for repeated failure, repeated success, and threshold tuning.

## Initial Watchers

### `runpod-idle-killer`

Mission:

- stop paying for idle GPUs

### `overnight-review`

Mission:

- summarize the previous operating window and propose next moves

### `work-radar`

Mission:

- unify important work and failure signals across GitHub, Azure, Databricks, Kaggle, and local systems
