# T6: Siri and Menubar Integration Plan

## Goal

Make Siri, Shortcuts, and the macOS menubar thin control surfaces over Frontier OS state, without duplicating orchestration logic in each UI.

## Current State

The consolidation design identifies five components:

- `frontier-os`: orchestrator and ledger.
- `companion-platform`: live Siri Gateway on port 8765.
- `aegis`: dormant brain/memory service.
- `nexus`: voice pipeline.
- `jarvis-menubar`: native macOS ledger-aware client.

The wiring gap is that Siri reads companion-platform state but not enough Frontier OS state.

## Deliverables

1. Siri Gateway Frontier reader:
   - read-only access to `~/.frontier/ledger.db`
   - read-only access to `frontierd` status when available
2. Endpoint augmentations:
   - `/v1/siri/status`
   - `/v1/siri/runs`
   - `/v1/siri/approvals`
3. New Frontier endpoints:
   - `/v1/frontier/projects`
   - `/v1/frontier/watchers`
   - `/v1/frontier/ghost`
   - `/v1/frontier/alerts`
4. Menubar extensions:
   - watcher freshness
   - Ghost Shift queue counts
   - pending approvals
   - project health rollup
5. Ledger events:
   - `surface.siri_request`
   - `surface.menubar_refresh`

## Milestones

### M1: Read-Only Frontier Summary in Siri Gateway

Add a small reader module in companion-platform that returns Frontier summary data.

Success gate:

```bash
cd /Users/test/code/platform/companion-platform
make test-runtime
```

### M2: Existing Endpoint Augmentation

Merge Frontier summaries into current Siri status/runs/approvals responses without breaking existing response shapes.

Success gate:

```bash
curl -fsS http://127.0.0.1:8765/v1/siri/status
```

With auth configured, response includes a Frontier section.

### M3: Frontier-Specific Siri Gateway Endpoints

Add project, watcher, ghost, and alerts endpoints.

Success gate:

```bash
curl -fsS http://127.0.0.1:8765/v1/frontier/watchers
```

With auth configured, response includes last tick and stale status.

### M4: Menubar Project Health

Extend the existing menubar to include project and automation health.

Success gate:

```bash
cd /Users/test/code/apps/jarvis-menubar
swift test
```

## Boundaries

- Do not rename Python packages for cosmetic reasons.
- Do not move Siri Gateway responsibilities into `frontier-os` until the daemon contract is stable.
- Do not change Shortcut response shapes unless a migration is planned.
- Menubar remains a client; orchestration lives in Frontier OS.

