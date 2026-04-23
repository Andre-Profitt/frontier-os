# Adapter Contract

Date: April 8, 2026
Status: draft

## Purpose

Adapters convert raw system control into stable semantic actions.

They exist to prevent the control plane from depending directly on:

- brittle selectors
- ad hoc shell snippets
- provider-specific payload shapes
- model-specific habits

## Required Lifecycle

Every adapter should support some subset of this lifecycle:

1. `inspect`
2. `propose`
3. `apply`
4. `verify`
5. `undo`

`verify` is mandatory for any meaningful side effect.

## Input Contract

Every invocation should include:

- adapter id
- command
- mode
- arguments
- trace metadata
- policy context

The canonical shape lives in `schemas/adapter-invocation.schema.json`.

## Output Contract

Every invocation should return:

- normalized status
- observed state
- artifacts
- side effects
- verification result
- alerts or suggested next steps

The canonical shape lives in `schemas/adapter-result.schema.json`.

## Design Rules

### Rule 1

Expose semantic verbs, not transport verbs.

Good:

- `inspect_dashboard`
- `list_pods`
- `stop_idle_pod`

Bad:

- `click`
- `post_json`
- `run_shell`

### Rule 2

Return structured state, not a wall of prose.

### Rule 3

Include adapter-local evidence for every important action:

- screenshot path
- DOM snapshot id
- API response excerpt
- command output hash

### Rule 4

Declare side effect class explicitly:

- `none`
- `local_write`
- `shared_write`
- `billable_action`
- `external_message`
- `destructive_action`

### Rule 5

Make undo real when possible. If undo is impossible, say so in the manifest.

## First Adapters

### `browser`

Backed by:

- CDP on active Chrome or Atlas sessions

Commands should include:

- `current-tab`
- `list-tabs`
- `inspect-dom`
- `inspect-network`
- `run-script`
- `click-element`
- `type-text`
- `capture-screenshot`

### `salesforce`

Backed by:

- `browser`
- an in-page Salesforce semantic helper

Commands should include:

- `inspect-dashboard`
- `list-filters`
- `set-filter`
- `enter-edit-mode`
- `move-widget`
- `save-dashboard`
- `audit-dashboard`

The Salesforce adapter should never expose raw Lightning selectors as the public contract.
