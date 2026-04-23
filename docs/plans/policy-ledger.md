# T5: Policy and Ledger Hardening Plan

Status: M1-M2 shipped

## Goal

Make every meaningful action classifyable, approveable, replayable, and auditable across CLI, daemon, MCP, watchers, Ghost Shift, and the privileged helper.

## Current State

The terminal adapter has side-effect classification, work graphs have approval classes, and the ledger is heavily used. The shared policy evaluator now supports `simulate`, `evaluate`, one-shot ledger-backed approval grants, and one-shot consumption. MCP and helper scaffolds call the same evaluator.

## Deliverables

1. Unified action envelope:
   - actor
   - source
   - projectId
   - verb
   - arguments
   - approvalClass
   - expectedSideEffects
   - verifier
   - traceId
2. Policy evaluator:
   - `frontier policy evaluate`
   - `frontier policy simulate`
3. Approval token lifecycle:
   - create
   - inspect
   - consume once
   - expire
4. Ledger normalization:
   - consistent `traceId`
   - consistent `projectId`
   - consistent `tool`
   - consistent `approvalClass`
5. Keychain-backed secret resolution:
   - env files remain references
   - secrets are read by named resolver only

## Approval Classes

| Class | Meaning | Default behavior |
| --- | --- | --- |
| 0 | Read-only local introspection | Run and ledger. |
| 1 | Local write or verification with low blast radius | Run and ledger. |
| 2 | Controlled side effect, service control, external API mutation, billable risk | Require approval unless explicit automation policy allows. |
| 3 | Destructive, public, broad system, security-sensitive | Deny by default. |

## Milestones

### M1: Shared Evaluator

Move side-effect classification behind a shared policy evaluator used by terminal adapter, work graphs, and future MCP tools.

Status: shipped for CLI, MCP, helper simulator, and route explain.

Success gate:

```bash
/Users/test/frontier-os/bin/frontier policy simulate --verb project.verify --project frontier-os --json
```

### M2: Approval Token Lifecycle

Add one-shot token files or ledger-backed token records for class-2 actions.

Status: shipped with ledger-backed token records.

Success gate:

```bash
/Users/test/frontier-os/bin/frontier policy approve --trace-id test --ttl 15m --json
/Users/test/frontier-os/bin/frontier policy consume --trace-id test --json
```

Second consume fails.

### M3: Ledger Contract Enforcement

Every entrypoint writes the same minimum evidence fields.

Success gate:

```bash
/Users/test/frontier-os/bin/frontier ledger audit --json
```

The audit reports missing required fields by kind and fails only on new violations.

### M4: Secret Resolver

Add Keychain lookup support for named secrets and keep `.env` as non-secret references where possible.

Success gate:

```bash
/Users/test/frontier-os/bin/frontier credentials check --json
```

No secret values are printed.

## Boundaries

- Do not weaken existing `crm-analytics` CLI-only rules.
- Do not log secret values.
- Do not make class-3 actions auto-approvable.
- Do not require policy rewrites before read-only project registry work ships.
