# Command Orchestrator Runbook

Date: 2026-04-21

This runbook covers the resident Frontier command gateway, worker, command DB,
artifacts, memory handoff, and failure-refinery loop.

## Health Gate

Run this before overnight work or after changing command/worker code:

```bash
npm run typecheck -- --pretty false
frontier daemon health --json
frontier command readiness --hours 24 --limit 50 --json
frontier command debt --limit 50 --json
frontier overnight brief --hours 24 --json
frontier command worker status --json --local
frontier command smoke --json
frontier mcp smoke --read-only --json
frontier mcp smoke --json
```

Expected:

- `daemon health` returns `status=ok`.
- `command readiness` returns `status=ready` unless there are intentionally
  active commands or pre-existing queued work.
- `command debt` returns only stale queue/blocker items; healthy queued/running
  work does not count as debt.
- worker status has `queued=0`, `running=0`, and `claimableCount=0` unless a
  command is intentionally active.
- command smoke returns `status=ok`, denial checks are `blocked=true`,
  retry exhaustion is classified as `retry_exhausted`, and verifier failure is
  classified as `verifier_failed`.
- MCP smoke proves submit, packet, approval, resume, retry, requeue, and cancel
  against `frontierd`.

## Morning Brief

```bash
frontier command brief --hours 24 --limit 50 --json
frontier command readiness --hours 24 --limit 50 --json
frontier command debt --limit 50 --json
frontier overnight brief --hours 24 --json
```

Readiness is the go/no-go check. Brief is the operator context: completed work,
active work, approval blockers, unresolved failures, and resolved historical
failures. Debt isolates the stale subset of queue/blocker state that actually
needs intervention. Overnight brief now also shows debt-preflight status,
automated requeues, and any remaining manual debt attention from recent
overnight enqueue/run cycles. New readiness checks:

- `retry_budget` warns on unresolved retry exhaustion or runtime-budget failures.
- `verification` fails on unresolved verifier-required failures.
- `queue` now stays `pass` for healthy in-flight work and only warns on stale
  queued/running debt.

## Submit And Inspect

```bash
frontier command submit --intent "status frontier-os" --project frontier-os --json
frontier command list --limit 10 --json
frontier command show <commandId> --json
frontier command events <commandId> --limit 50 --json
frontier command artifacts <commandId> --json
frontier command packet <commandId> --json
frontier command final-brief <commandId> --event-limit 50 --json
frontier command retry <commandId> --json
frontier command requeue <commandId> --json
frontier command cancel <commandId> --json
```

`packet` is the normalized command result across project, MLX, browser,
Salesforce, helper, and memory lanes. It now includes a canonical
`verification` block with verifier-required state, failed-check counts, and
per-check evidence where the work graph emitted verifier details. `final-brief`
includes the same packet plus route, policy decision, execution policy, failure
classification, activity attempts, ledger tail, debt classification, operator
lineage/audit, and lane-specific recovery commands.

Use the operator actions this way:

- `retry` for `failed` or `canceled` commands.
- `requeue` for stale `queued`, `running`, or `blocked_approval` commands.
- `cancel` to clear queued/running/blocked work without minting a replacement.

Use `--dry-run` when checking route, policy, graph, timeout, or retry behavior
without enqueueing work:

```bash
frontier command submit --intent "mlx benchmark" --max-runtime-seconds 30 --dry-run --json --local
frontier command submit --intent "inspect current browser tab" --max-retries 2 --retry-backoff-ms 25 --dry-run --json --local
```

Recovery guidance is now lane-aware:

- MLX runtime-budget failures point to `frontier mlx status --json --local` and
  `frontier mlx doctor --json --local` before retrying.
- project-lane failures point back to the declared direct project command and
  `frontier project inspect <projectId> --json` before retrying through
  Frontier.
- browser-lane failures now surface CDP attach issues such as
  `127.0.0.1:9222` reachability directly from the packet output summary.
- salesforce-lane failures now surface unresolved org access and credential
  hints from adapter output instead of only generic verifier text.
- helper and overnight lanes now emit lane-specific diagnostics before the
  generic packet/events fallback.
- verifier-required failures surface the failed check, the verifier reason, and
  any repair evidence such as an expected human-review token path.
- ops repair approval blockers name the allowlisted service label and send the
  operator to `frontier approval list --json`, `frontier command resume ...`,
  and `frontier ops status --json`.

## Overnight Preflight

Before queueing overnight work, Frontier now inspects stale command debt and
applies a conservative cleanup policy:

- stale `queued` class-0/1 commands are auto-requeued
- stale `running` class-0/1 commands are auto-requeued only when the lease has expired
- stale approval and policy blockers stay manual

Use these checks:

```bash
frontier overnight run --dry-run --json
frontier overnight enqueue --queue-dir /tmp/frontier-overnight-queue --graph-dir /tmp/frontier-overnight-graphs --json
frontier overnight brief --hours 24 --json
```

Read the `preflight` block for:

- `status`
- `staleCount`
- `automatedCount`
- `manualAttentionCount`
- per-command `actions`

`frontier overnight brief` now also backfills older Ghost Shift outcome history
when early ledger payloads did not include lane/project/verb metadata. The
brief first uses canonical payload metadata, then falls back to the retained
graph files under `~/.frontier/ghost-shift/**` or the overnight queue/graph
directories so historical lane rollups and manual-attention rows degrade less
sharply over time.

Legacy generic-node demo graphs are also normalized into the canonical `demo`
lane, so older proofs that only recorded `sleep`/`frontier` style CLI metadata
do not pollute real long-window lane rollups.

`overnight brief` now also reports:

- `runTrend` for recent run-status and shift-health rollups
- `lanes[]` with per-lane planned, queued, completed, failed, blocked, and rejected counts
- lane-level debt automation/manual-attention totals plus top verbs

On the Apple side, the menu bar controller now writes a shared
`FrontierOperatorSnapshot` into the app-group defaults after each refresh. The
macOS widget surface reads that snapshot instead of duplicating Frontier API
queries, so the passive native surfaces stay aligned with the canonical local
runtime state. Snapshot writes also trigger `WidgetCenter` timeline reloads, so
the widget updates immediately when operator state changes instead of waiting
for the next scheduled refresh.

The Apple native surfaces now use shared `companion://frontier/...` deep links:

- notifications can jump straight into overnight review or the preferred
  selected command
- the macOS Frontier widget now follows the canonical preferred-review route
  from the shared snapshot, which can resolve to a selected command, blocked
  queue, failed queue, overnight review, or overview depending on current
  operator state
- the menu bar host restores queue focus and selected-command state from those
  links after refreshing local Frontier data, then presents the dedicated
  Frontier operator review window instead of relying on the menu bar popover

The menu bar Frontier panel also exposes an icon affordance to detach the
current review into that dedicated operator window for longer queue triage or
recovery work.

That dedicated review window now includes direct `Overview`, `Overnight`, and
queue-focus controls, so the operator can move between the major Frontier
review modes without returning to the popover first.

The standalone review window now also renders expanded selected-command detail
from `frontier command final-brief`, including route and policy context,
packet/verification state, artifact and ledger evidence, plus recent activity
and operator audit history. The compact menu bar panel keeps the short summary
view so passive triage stays dense.

Those passive native surfaces now carry more selected-command detail too. When
the canonical preferred review target already resolves to a specific command,
the macOS operator notification switches from generic queue wording to that
command's intent plus its best passive summary, and the macOS Frontier widget
shows the same command's next-action, verifier reason, or summary line in the
glance card.

The native selected-command flow now also exposes a copy action for the best
recovery or recommended operator command, so the operator can move from final
brief to terminal execution without manually selecting CLI text.

In the expanded macOS review window, the selected-command controls now also
include a Finder reveal action for command evidence. When the final brief has
an artifact directory, work graph, or retained artifact file, the operator can
jump straight to that evidence from the review surface instead of copying a
path manually.

That same review surface now also exposes a direct open action for the selected
command's best evidence target. The controller prefers a retained artifact
file, then the work graph, then the artifact directory, so the operator can
open the exact file immediately when Finder reveal would still be one hop too
many.

The expanded review window now also exposes a Terminal handoff for the selected
command's tool context. The controller prefers the artifact directory, then
falls back to the parent directory of the current evidence file or work graph,
so the operator can move straight from final brief to CLI follow-up without
manually navigating the filesystem first.

That same review surface now also exposes a direct Frontier CLI handoff for the
selected command. When the final brief includes a recovery command, the macOS
controller normalizes it to the resident Frontier binary path and launches it in
Terminal from the selected command's working context. When no explicit recovery
command exists, it falls back to `command final-brief <commandId>`, so the
operator still lands on the canonical CLI follow-up without copying text first.

The expanded macOS review window now also exposes a direct memory handoff for
the selected command. That action calls `frontier command remember <commandId>
--json --local` through the same controller bridge the window already uses for
CLI-backed operator work, so native review can persist a command into the
canonical `commands/<lane>` memory namespace without inventing a second Apple
memory model.

That same native review flow now also exposes a direct Terminal handoff into
the selected command's remembered memory block. The controller chains
`frontier command remember <commandId> --json --local` and
`frontier memory get --class run --namespace commands/<lane> <commandId> --json`
with the resident Frontier binary path, so the operator can jump straight from
selected-command review into the canonical memory context without depending on
Terminal PATH state or manually assembling the memory lookup command.

The expanded macOS review window now also exposes a direct audit-trail handoff
for the selected command. That action launches
`frontier command events <commandId> --limit 50 --json` with the resident
Frontier binary, so the operator lands on the command-scoped ledger sessions and
event tail directly instead of chasing session IDs through raw `ledger show`
calls.

That same review surface now also exposes a direct normalized-packet handoff for
the selected command. The controller launches
`frontier command packet <commandId> --json` with the resident Frontier binary,
so the operator can jump straight into canonical execution/result state without
leaving the native flow or expanding the broader final brief again.

It now also exposes a dedicated final-brief handoff for the selected command.
That launches `frontier command final-brief <commandId> --event-limit 20
--json` in Terminal with the resident Frontier binary, so the operator can open
the canonical command narrative directly even when the generic run button is
reserved for a recovery command.

That same native review surface now also exposes a dedicated artifact-index
handoff for the selected command. It launches
`frontier command artifacts <commandId> --json` with the resident Frontier
binary, so the operator can inspect the canonical artifact directory, retained
files, and work-graph references directly instead of relying only on Finder
open/reveal actions.

It now also exposes a raw command-record handoff for the selected command. That
launches `frontier command show <commandId> --json` with the resident Frontier
binary, so the operator can inspect the stored route, policy, plan, and
checkpoint payload directly when the summarized final brief or packet is too
high-level for debugging.

The shared Frontier operator snapshot now also carries a passive selected-command
context line derived from canonical command data, currently `lane / verb •
policyId` when available. The macOS widget and Notification Center summaries use
that line when the preferred review target is a specific command, so passive
surfaces keep route/policy fidelity without reintroducing a second review
model.

In the expanded macOS operator window, the specialist Terminal handoffs now sit
behind a single overflow menu instead of consuming a separate icon slot each.
That menu still routes to the same canonical commands: memory, audit, packet,
final brief, artifact index, and raw command record.

That overflow menu now also includes a copy action for a canonical
selected-command context bundle. The copied text includes the command id,
intent, status, route/policy context, passive summary, and recovery command when
available, so the operator can paste a grounded command snapshot into Codex,
Claude, notes, or tickets without reopening the full JSON views.

The primary copy button in the selected-command row is now context-aware too. It
copies the best canonical Frontier follow-up command for the selected command:
the recovery command when one exists, otherwise the resident-binary
`command final-brief` handoff. That keeps one-click copy useful even for
completed commands that do not currently need recovery.

That same selected-command action row now also collapses around command state
instead of exposing every review shortcut all the time. Active queued/running
commands no longer surface settled review actions like final-brief or memory
handoffs, the overflow menu drops duplicate final-brief entries when the
primary follow-up already points there, and artifact-index handoff only appears
when the command actually carries retained artifact or work-graph references.

On macOS, the Apple intents target now also exposes `Open Frontier Operator`
Shortcuts/App Intents for overview, queue-review, priority-review, and current
selected-command targets. Those intents write a shared Frontier route handoff
into the app-group store, and the menu bar host delivers that handoff on cold
launch or activation into the same dedicated operator review window.

That same Apple intents lane now also exposes a read-only `Review Frontier
Focus` intent. It answers from the shared operator snapshot instead of opening
the app, so Siri or Shortcuts can read the current selected-command status,
next action, and queue pressure from the same passive state that feeds the
widget and notifications.

The shared selected-command snapshot now also carries a canonical passive
follow-up label derived from the same operator rules as the native review
window. The widget, Notification Center review alert, and `Review Frontier
Focus` intent use that label to say what the next tool action is likely to be
without opening the full operator surface.

The shared preferred-review snapshot now also carries a route detail line for
queue targets. When the system focus is `running`, `blocked`, `failed`, or
`done` instead of a specific command, the widget, Notification Center review
alert, and `Review Frontier Focus` intent can describe the active queue pressure
instead of falling back to a generic queue label.

The macOS Frontier widget also labels stale snapshots, so a long-idle widget
does not read as fresh operator state.

That stale-state signaling now also says what is stale and what to do next. The
shared runtime client derives a stale scope label from the preferred Frontier
target, and the widget plus `Review Frontier Focus` intent can say things like
`Command stale 18m ago` or `Blocked queue stale 22m ago`, followed by a direct
`Open Frontier to refresh.` prompt.

Notification Center does not get the same stale/fresh phrasing. Delivered
notifications can outlive the last refresh cycle, so the Frontier review alerts
stay freshness-neutral and append `Open Frontier to refresh live state.` rather
than claiming timing they cannot keep truthful after delivery.

The stale/fresh phrasing in the widget and `Review Frontier Focus` intent now
also reuses the canonical preferred-review label when one exists, so passive
surfaces say `Blocked queue stale 22m ago` or `Overnight review stale 17m ago`
instead of falling back to a coarser route bucket.

Those passive surfaces now also reuse a compact display label for the preferred
review target. When the surrounding surface already says Frontier, the widget,
focus intent, and queue-review notification subtitle now show `Blocked queue`
or `Overnight review` instead of repeating `Frontier blocked queue`.

That same compact label now also feeds the `Open Frontier Operator` intent
handoff. Shortcut/App Intent confirmation copy now says `Opening Blocked queue`
or `Opening Overview` instead of repeating `Frontier` in the target name when
the intent title already supplies the app context.

The App Intent readback now also normalizes raw status values. `Review Frontier
Overnight` and `Review Frontier Focus` say `Frontier overnight needs
attention.` or `Waiting on approval.` instead of echoing internal values like
`attention` or `blocked_approval`.

That same focus-intent phrasing now also covers steady command states, so the
readback says `Queued.`, `In progress.`, `Completed.`, `Failed.`, or
`Canceled.` instead of the flatter `Status queued.` or `Status completed.`
pattern.

The overnight readback and overnight notification subtitle now also fix the
last singular/plural review-count edge case, so they say `1 item needs review`
instead of `1 item need review`. The overnight intent also joins top-verb
counts with commas instead of double spaces for cleaner spoken cadence.

The focus-intent framing is tighter as well: it now leads with `Frontier
focus: …`, shortens the empty-state refresh copy, and trims `Command debt
still needs operator review.` to `Command debt still needs review.` so the
spoken output reaches the actionable part faster.

The last intent-lane fallback copy now also aligns with the passive surfaces:
empty-state and overnight-failure responses say `Open Frontier …` instead of
referring to the menu bar app as a separate concept.

The focus intent now also prefixes queue pressure with `Queue:` so the spoken
readback says `Queue: 2 blockers, 1 unresolved failure.` instead of dropping a
bare count list into the middle of the dialog.

Passive selected-command status copy now also uses the same humanized wording
across the macOS widget and Notification Center review alerts, so those
surfaces say `Waiting on approval` or `Blocked by policy` instead of leaking
raw stored status strings.

The last legacy entry-point copy is gone too: the widget empty state and
Frontier command-intent failure fallback now both say `Open Frontier …`
instead of pointing at the macOS companion or menu bar app by implementation
detail.

Snapshot-empty and stale-refresh copy now align as well: the widget now says
`No Frontier snapshot yet.`, and the shared passive stale prompt now says
`Open Frontier to refresh local state.` instead of the looser `Open Frontier
to refresh.`

The focus intent empty-state fallback is tighter too: it now says `No Frontier
focus is set.` instead of the more indirect `No Frontier review target is
set.`

Passive notification fallback copy is tighter too: when the queue/command
review alert has no richer body text, it now says `Frontier review is
required.` instead of the looser `Operator review is required.`

The overnight-review intent failure fallback now uses the same `Open Frontier
to refresh live state.` phrasing as the passive notification lane instead of
the older `inspect live state` wording.

The Frontier App Intent metadata is tighter too: overnight/focus/operator
descriptions now drop redundant `operator` / `macOS` wording and describe the
same review targets with less noise.

Those same descriptions are now cleaner at the noun level too: `manual
attention` became `attention items`, `selected command` became `command`, and
`specific review target` became `specific target`.

The Frontier review-target enum is tighter too: App Intent subtitles now drop
redundant `Frontier` wording where the enum already supplies that context, and
the open-intent readback now says `Done queue` instead of `Completed queue` to
match the passive surfaces.

For longer-window history, `overnight brief` now prefers richer `graphId`
reconstruction over generic retained file names when the original graph is
gone. That keeps older `git-review` work on the canonical `frontierd` lane and
older self-audit demo proofs on `demo.self-audit` instead of degrading into
`overnight` or null metadata.

A fresh 168-hour live audit now returns zero manual-attention rows with null
lane or verb metadata, so the current overnight backfill heuristics are
holding for the retained history on disk.

## Backup

Create a safe local snapshot before risky worker/schema edits:

```bash
frontier command backup --json --local
```

The command writes a timestamped directory under
`~/.frontier/commands/backups/` with:

- `commands.db`
- `commands.db-wal` if present
- `commands.db-shm` if present
- `manifest.json`

Restore is intentionally manual/destructive and is not automated by Frontier
yet. Stop the worker and daemon before any manual restore.

## Denial Smoke

The command router must deny destructive class-3 intents by default:

```bash
frontier command submit --intent "delete everything in Downloads" --dry-run --json --local
frontier command submit --intent "restart com.apple.WindowServer" --dry-run --json --local
frontier command smoke --json
```

Expected:

- `status=blocked_policy`
- `approvalClass=3`
- `decision=deny`
- no planned action

## Memory Handoff

Write useful completed or failed commands into typed memory:

```bash
frontier command remember <commandId> --json --local
frontier memory get --class run --namespace commands/<lane> <commandId> --json
frontier memory search --class run --namespace commands --query "status frontier-os" --limit 5 --json
```

Default memory location is `run:commands/<lane>:<commandId>`. Stored command
memory now includes a compact packet summary plus debt state, recommended
operator action, source/replacement lineage, and recent operator audit events.

## Failure Refinery

Harvest repeated failures and inspect advisory rule proposals:

```bash
frontier refinery harvest --since 2026-04-21T00:00:00Z --limit 2000 --json
frontier refinery propose --since 2026-04-21T00:00:00Z --limit 2000 --min-frequency 2 --json
frontier refinery rules --show-proposals --json
```

`command.failed` events are included. Repeated command failures currently
propose `raise_approval_class` rules.

## Approval Resume

Class-2 commands pause until approved:

```bash
frontier approval list --json
frontier approval approve <traceId> --ttl 15m --json
frontier command resume <commandId> --approval <traceId> --json
frontier command worker run --command <commandId> --max-approval-class 2 --json --local
```

Class-3 commands are denied by default; do not bypass them by manually editing
command state.
