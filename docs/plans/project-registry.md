# T1: Project Registry Plan

Status: registry and executable verify/smoke runner shipped

## Goal

Create a typed inventory of Andre's important projects so Frontier OS can answer: where is it, how do I verify it, what services belong to it, what logs matter, what agent should touch it, and what actions require approval.

## Current State

Project knowledge is spread across `AGENTS.md`, docs, shell history, LaunchAgents, and each repo's Makefile or package metadata. Codex can discover it, but every session pays the discovery cost again.

## Deliverables

1. Schema: `schemas/project-manifest.schema.json`.
2. Manifests: `manifests/projects/*.project.json`.
3. Registry loader: `src/projects/registry.ts`.
4. CLI:
   - `frontier project list`
   - `frontier project inspect <id>`
   - `frontier project status [<id>]`
   - `frontier project verify <id>`
   - `frontier project smoke <id>`
   - `frontier project logs <id>`
5. Ledger events:
   - `project.status`
   - `project.verify_start`
   - `project.verify_end`
   - `project.service_detected`

## Manifest Shape

Each project manifest should include:

- `id`
- `name`
- `root`
- `kind`
- `priority`
- `owner`
- `riskClass`
- `commands.verify`
- `commands.smoke`
- `commands.dev`
- `commands.logs`
- `services`
- `ports`
- `envFiles`
- `secretsPolicy`
- `ledgerTags`
- `notes`

## First Manifest Batch

Start with these because they cover the highest ROI workflows:

1. `frontier-os`
2. `mlx-workbench`
3. `companion-platform`
4. `crm-analytics`
5. `kaggle-nemotron`
6. `salesforce-api`
7. `nexus`
8. `jarvis-menubar`
9. `aegis`

## Milestones

### M1: Read-Only Inventory

Add schema, manifests, loader, and `frontier project list/inspect`.

Success gate:

```bash
/Users/test/frontier-os/bin/frontier project list --json
/Users/test/frontier-os/bin/frontier project inspect frontier-os --json
```

### M2: Status Detection

Implement `frontier project status` using:

- path existence
- git branch/status summary
- manifest command presence
- known port status
- service process probes
- latest ledger events by `ledgerTags`

Success gate:

```bash
/Users/test/frontier-os/bin/frontier project status --json
```

### M3: Verification Runner

Run each project's declared verify command through the existing terminal adapter or work graph executor, with approval class derived from the manifest.

Success gate:

```bash
/Users/test/frontier-os/bin/frontier project verify frontier-os --json
/Users/test/frontier-os/bin/frontier project verify mlx-workbench --json
```

### M4: Scheduler Integration

Let watchers and overnight review consume project registry state instead of hand-coded path knowledge.

Success gate:

```bash
/Users/test/frontier-os/bin/frontier watcher run work-radar --json
```

Output includes project health deltas.

## Implementation Notes

- Keep manifests declarative. Avoid embedding shell snippets that bypass policy.
- Use `spawn`, not shell expansion, for project commands.
- Do not store secrets in manifests. Reference env files or Keychain item names only.
- Treat missing verify commands as `unknown`, not `failed`, until project discovery is complete.
