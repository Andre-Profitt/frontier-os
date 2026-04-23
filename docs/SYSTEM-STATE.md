# Frontier OS — System State v0.7

Date: 2026-04-08
Status: **MVO complete (7/7)** — all seven Minimum Viable Outcome boxes ticked. Action/verify loop proven, session ledger operational, overnight-review watcher live, RunPod adapter calling the real API, scheduler ready to install launchd plists, portfolio-level batch audit runner in place, ledger archival primitive ready.

Codebase: **8,303 LOC TypeScript + 1 JS helper, 38 files, 3 adapters, 3 watchers, 0 `as any` casts, 0 unused locals, 0 typecheck errors under `--strict --exactOptionalPropertyTypes --noUncheckedIndexedAccess`.**

## Subsystems

### Core (`src/`)

| File          | LOC  | Role                                                                                                 |
| ------------- | ---- | ---------------------------------------------------------------------------------------------------- |
| `cli.ts`      | 709  | Top-level dispatcher. 5 command families, 17 subcommands.                                            |
| `schemas.ts`  | ~210 | Ajv2020 validators + TS mirrors for adapter manifest/invocation/result + watcher spec + alert event. |
| `registry.ts` | ~95  | Adapter manifest loader + factory routing. 3 adapters registered: browser, salesforce, runpod.       |
| `result.ts`   | ~60  | `buildResult` / `failedResult` / `newInvocationId` helpers.                                          |

### Browser family (`src/adapters/browser/`)

| Component                   | Role                                                                                                                                                                                                                                                                                                                                   |
| --------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `cdp.ts`                    | CRI wrapper: `listTabs`, `pickPageTarget`, `attach` (with optional `installHelper`), `evaluate`.                                                                                                                                                                                                                                       |
| `inject/helper.js`          | Page-side IIFE at `window.__frontier` v2. Idempotency guard, `frontier:nav` events on pushState/replaceState/popstate, shadow-aware MutationObserver, composite `waitStable` (Aura `$A.clientService.inFlightXHRs()` + spinner selectors + mutation quiescence), `summary()`, `destroy()`, **toastWatcher** with 5 SF toast selectors. |
| `inject/install.ts`         | `Page.addScriptToEvaluateOnNewDocument` + `Target.setAutoAttach({flatten:true})` + `Runtime.evaluate` on current doc + `Page.frameNavigated` re-eval safety net.                                                                                                                                                                       |
| `inject/dom-tree.ts`        | CDP-native `DOM.getDocument({depth:-1, pierce:true})` walker. Handles `nodeType: 11` shadow roots + iframe `contentDocument`. Returns `{backendNodeId, nodeId, tag, attrs, text, interactive, interactiveReason, shadowRootMode, children[]}`.                                                                                         |
| `inject/clickable.ts`       | Port of browser-use `ClickableElementDetector.is_interactive`. Tag list, ARIA roles, event-handler attrs, search heuristics, LWC tag shortcuts.                                                                                                                                                                                        |
| `actions/network-expect.ts` | `awaitNetworkMatch()` via CDP `Network.requestWillBeSent`/`responseReceived`/`loadingFailed`. URL regex + method + status predicate + optional accept-loading-failed.                                                                                                                                                                  |
| `actions/action-loop.ts`    | **`runAction()` composer.** Orchestrates: toastWatcher.start → register network expectation → run action → await network match → waitStable → DOM predicate → toast drain → rollback on failure. Returns `{ok, checks[], network?, toasts[], rolledBack, durationMs}`.                                                                 |
| `commands/`                 | `list-tabs`, `current-tab`, `capture-screenshot`, `run-script` (bounded async eval), `inspect-dom`.                                                                                                                                                                                                                                    |

### Salesforce family (`src/adapters/salesforce/` + `src/salesforce/`)

| Component                             | Role                                                                                                                                                                                                                                              |
| ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `lightning.ts`                        | `DashboardModel` types + `DASHBOARD_WALKER_SRC` (async IIFE for Runtime.evaluate). Selectors for CRMA `wave-*`, Classic `analytics-*`, `data-aura-class*="Dashboard"` fallbacks.                                                                  |
| `audit/rules.ts`                      | 11 deterministic audit rules: `widget-count-at-limit`, `widget-loading`, `widget-error`, `widget-hidden`, `widget-untitled`, `duplicate-widget-titles`, `dashboard-untitled`, `no-filters`, `page-error`, `orphan-widget`, `overlapping-widgets`. |
| `audit/index.ts`                      | `runAudit()` orchestrator + `AuditGrade` with `BLOCKING/WRONG-DATA/WARNING/ORPHAN/INFO` scheme matching your memory format.                                                                                                                       |
| `commands/inspect-dashboard.ts`       | Reads the DashboardModel via CDP. Status `success` on detected, `partial` on not-detected.                                                                                                                                                        |
| `commands/audit-dashboard.ts`         | Runs `inspect` + `runAudit`, supports `read` / `propose` modes, surfaces top 5 findings in `suggestedNextActions`.                                                                                                                                |
| `commands/set-filter.ts`              | **v0.7:** dual-variant — `variant: "click"` (single-click flow) and `variant: "dropdown"` (three-step: open pill → click option → click apply + verify). Uses `runAction` for all three steps. Rollback-by-navigation.                            |
| `src/salesforce/portfolio-summary.ts` | Reads ledger events for a batch session, aggregates per-dashboard grades into `PortfolioSummary` with `topRules`, `aggregateGrade`, `okCount`/`notOkCount`.                                                                                       |

### RunPod family (`src/adapters/runpod/`)

| Component                  | Role                                                                                                                                                                                                                                                                                                                                        |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `client.ts`                | RunPod GraphQL client at `api.runpod.io/graphql`. Auth via `resolveRunpodApiKey()` which checks `process.env.RUNPOD_API_KEY` first then a dotenv search path (`~/code/labs/kaggle-nemotron/.env` → `~/frontier-os/.env` → `~/.env`). Retry policy: 3 attempts with 500ms/1s/2s backoff on transient failures; GraphQL errors never retried. |
| `index.ts`                 | Adapter dispatcher registered in `src/registry.ts` as `runpod`.                                                                                                                                                                                                                                                                             |
| `commands/list-pods.ts`    | Fetches `myself.pods` + runtime. **Verified working against the live API** — found `nemotron-b300` pod in your account.                                                                                                                                                                                                                     |
| `commands/pod-status.ts`   | Single-pod filter of list-pods.                                                                                                                                                                                                                                                                                                             |
| `commands/stop-pod.ts`     | `podStop` mutation. `sideEffectClass: billable_action`. Approval class 3.                                                                                                                                                                                                                                                                   |
| `commands/cost-summary.ts` | Aggregates running vs stopped, projects daily/monthly cost.                                                                                                                                                                                                                                                                                 |

### Ledger (`src/ledger/`)

| Component   | Role                                                                                                                                                                                                                                                                                                                                                 |
| ----------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `events.ts` | `EventKind` enum + `LedgerEvent`, `SessionInit`, `SessionSummary` types + id generators.                                                                                                                                                                                                                                                             |
| `index.ts`  | `LedgerStore` class over `better-sqlite3`. WAL mode + NORMAL synchronous. Append-only. Methods: `ensureSession`, `appendEvent`, `getEvents`, `getSessionSummary`, `listSessions`, `findEventsByKind`, `findEventsByKindInRange`, `findEventsInRange`, `stats`, `archive`, `listArchives`.                                                            |
|             | **Archival** (v0.7): `archive(opts)` writes JSONL-gzipped sidecar to `~/.frontier/archive/`, then opens a transaction to delete the archived events + sessions whose events are fully archived. Write-file-then-delete ordering means sidecar is always safe before any delete happens. `readArchiveFile(path)` re-reads a sidecar back into memory. |

### Watchers (`src/watchers/`)

| Component               | Role                                                                                                                                                                                                                                                                                                                                                                                                 |
| ----------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `runtime.ts`            | `WatcherImpl` interface + `runWatcher()` orchestrator. Ensures ledger session, appends `watcher.tick`, runs the watcher, validates alerts against `schemas/alert-event.schema.json`, writes alert events. Kill switch check via `spec.policy.killSwitchFile` → `state/watchers/<id>.disabled`.                                                                                                       |
| `overnight-review.ts`   | Reads 24h ledger window, aggregates into a summary alert. Decision tree: `escalate` (high) on any failed invocation or blocking finding, `recommend` (medium) on any finding, `notify` (info) on pure activity, `no_change` on empty window. Dedupe key is date-based.                                                                                                                               |
| `runpod-idle-killer.ts` | Reads `client.listPods()`, filters `desiredStatus === "RUNNING"`, computes `now - Date.parse(lastStatusChange)`, flags pods > `idleThresholdMinutes` as candidates. v0.7 parses RunPod's human-readable timestamps (`"Exited by user: ..."` / `"Running since: ..."`) by stripping the prefix before `Date.parse`. v0.1 emits recommend alerts, never auto-stops; v0.2 TODO to wire autonomous stop. |

### Scheduler (`src/scheduler/`)

| Component    | Role                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| ------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `index.ts`   | In-process foreground scheduler. Hand-rolled 5-field cron parser (supports `*`, integers, comma-lists — no ranges, no `@daily`). `setInterval` for interval watchers, `setTimeout` chain for cron. `buildSchedule()` projects upcoming runs. `runScheduler({foreground, stopAfterMs, onTick})` for tests + long-running mode. Per-watcher failure isolated.                                                                                     |
| `launchd.ts` | macOS plist generator. `generatePlist` / `writePlist` / `plistLabel`. Maps interval → `StartInterval`, cron → `StartCalendarInterval` dict array (Cartesian product of comma-lists, capped at 256). Each plist sets `Label: com.frontier-os.<id>`, `ProgramArguments: [bin/frontier, watcher, run, <id>, --pretty]`, `StandardOutPath` + `StandardErrorPath` in `~/Library/Logs/frontier-os/`, `RunAtLoad: false`. Validated by `plutil -lint`. |

## CLI surface (`bin/frontier <family> <subcommand> [flags]`)

```
frontier adapter list
frontier adapter show <adapterId>
frontier adapter invoke <adapterId> <command>  [--mode read|propose|apply|undo] [--input <json|path>] [--session <id>]

frontier ledger list-sessions   [--limit N]
frontier ledger show <sessionId> [--offset N] [--limit N]
frontier ledger search --kind <kind> [--limit N]
frontier ledger stats
frontier ledger archive --before <iso> [--dry-run] [--archive-dir <path>]

frontier watcher list
frontier watcher show <watcherId>
frontier watcher run <watcherId>  [--since ISO] [--until ISO] [--dry-run]

frontier scheduler list
frontier scheduler run            [--stop-after-ms N]
frontier scheduler install <watcherId> [--dest-dir <path>]

frontier salesforce audit-batch <dashboards-file> [--session <id>] [--base-url <url>] [--dry-run]
frontier salesforce portfolio-summary <sessionId> [--json]

frontier help
```

Every command emits JSON by default. `--pretty` indents. Every adapter invocation opens an append-only ledger session, writes `invocation.start` + `invocation.end` + one event per artifact/side-effect/finding. Every audit-producing command additionally writes `audit.grade` + one `finding` event per finding so they're individually queryable.

## Credential inventory (as of 2026-04-08)

| System             | Location                                                                                           | Status                                                                                                                                                             |
| ------------------ | -------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Salesforce         | `sf` CLI default org                                                                               | ✓ `apro@simcorp.com @ simcorp.my.salesforce.com` — used by inspect-dashboard, audit-dashboard, set-filter via `sf org open --url-only` frontdoor URLs              |
| **RunPod**         | `~/code/labs/kaggle-nemotron/.env` → `RUNPOD_API_KEY`                                              | ✓ **live** — `list-pods` + `cost-summary` + `idle-killer` watcher all verified against the real API. Client auto-resolves via `resolveRunpodApiKey()` search path. |
| GitHub             | `gh` (keyring)                                                                                     | ✓ `Andre-Profitt` — no adapter yet                                                                                                                                 |
| Azure              | `az`                                                                                               | ✓ 5 subscriptions active — no adapter yet                                                                                                                          |
| Databricks         | `~/.databrickscfg`                                                                                 | ✓ configured — no adapter yet                                                                                                                                      |
| Kaggle             | `~/.kaggle/kaggle.json`                                                                            | ✓ configured — no adapter yet                                                                                                                                      |
| Sigma              | `~/code/apps/sigma-gtm-poc/.env` → `SIGMA_{BASE_URL,CLIENT_ID,CLIENT_SECRET,ORG_ID,ACCOUNT_EMAIL}` | ✓ configured — **adapter not yet built** (research dossier has the design)                                                                                         |
| Anthropic / Claude | Claude Code env                                                                                    | ✓ set                                                                                                                                                              |
| LangChain          | shell env                                                                                          | ✓ set                                                                                                                                                              |

## What's verified end-to-end

| Path                                                                         | Verified against                                                                                                                       |
| ---------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| Browser: list-tabs, current-tab, capture-screenshot, run-script, inspect-dom | Live headless Chrome + example.com, including shadow-DOM piercing and SPA `pushState` / `frontier:nav` events                          |
| Salesforce: inspect-dashboard                                                | Synthetic Lightning DOM (CRMA-shaped) — 5 widgets, 2 filters, all fields extracted correctly                                           |
| Salesforce: audit-dashboard (read + propose)                                 | Synthetic dashboard with 22 widgets, all 11 rules exercised, grade matched expected BLOCKING/WRONG-DATA/WARNING/ORPHAN/INFO counts     |
| Salesforce: set-filter (click variant, happy path)                           | Synthetic pill with click-activated state change + mock fetch — 5/5 action-loop checks passed                                          |
| Salesforce: set-filter (click variant, failure + rollback)                   | Synthetic pill with error toast + no state change — 2 checks failed, rollback-by-navigation fired, exit code 2                         |
| Salesforce: set-filter (dropdown variant)                                    | **Not yet smoke-tested** — code lands, typecheck clean, awaits real-SF session                                                         |
| Ledger: append-only session log                                              | Every adapter invocation writes start+end+artifacts+findings. `ledger stats` / `search` / `show` all validated.                        |
| Ledger: archive (dry-run)                                                    | Against the live `~/.frontier/ledger.db` — 14 sessions, 48 events computed, no deletes                                                 |
| Watcher: overnight-review                                                    | Decision tree tested for all 4 branches (no_change / notify / recommend / escalate). Kill switch respected. Dry-run semantics correct. |
| Watcher: runpod-idle-killer                                                  | **Live RunPod API** — 1 pod found (`nemotron-b300`), correctly classified as `EXITED` → `no_change`                                    |
| Scheduler: buildSchedule + runScheduler                                      | Foreground 5-second window exercises all three watchers' scheduling math                                                               |
| Scheduler: launchd plist generation                                          | `plutil -lint` validated for both interval + cron plist outputs                                                                        |
| Portfolio-summary                                                            | Parses the existing audit-dashboard session → grade + topRules aggregation                                                             |
| audit-batch                                                                  | `--dry-run` prints correct per-dashboard commands with shared session id                                                               |

## What's deferred

1. **Real-SF smoke test against `01ZTb00000FSP7hMAH` (Sales Directors Monthly)** — frontdoor URL generation works, Chrome launch step declined in this session. Runbook at `docs/REAL-SF-SMOKE-TEST.md` documents the exact manual flow.
2. **v0.7 set-filter dropdown variant** real-SF validation — code lands, awaits live dashboard.
3. **Sigma adapter** — credentials available, research dossier has the design (API-first + thin CDP postMessage layer), no code written yet.
4. **GitHub / Azure / Databricks / Kaggle adapters** — credentials available, no code.
5. **cron runner as a daemon** — the scheduler has foreground/install commands but nothing daemonizes it. `scheduler install` generates a launchd plist the user can `launchctl load`.
6. **Autonomous stop-pod in idle-killer** — currently always notify, never stop. v0.2 TODO in code.

## Known gotchas (locked in for future work)

- **Helper version bumps** (`window.__frontier.__version`) require a navigation to re-inject. The idempotency guard destroys the old instance cleanly, but a live page still running v1 stays on v1 until it navigates.
- **Chrome 136+ ignores `--remote-debugging-port` on real profiles** — always use `--user-data-dir=$HOME/.chrome-bops` or a dedicated profile.
- **`Accessibility.getFullAXTree` is useless on Lightning** — targeted `dom-walk` strategy only for Salesforce per the research dossier.
- **`Page.addScriptToEvaluateOnNewDocument` silently no-ops on SPA soft-nav** — we have the `Page.frameNavigated` re-eval safety net, but a long-lived session across many soft-navs should periodically re-check via `window.__frontier.summary()`.
- **Regex literals inside JSDoc block comments can contain `*/`** which prematurely closes the comment — use `// line comments` when documenting regexes, or escape as `\x2f`.
- **RunPod `lastStatusChange` is human-readable, not ISO 8601** — `parseRunpodTimestamp` in `runpod-idle-killer.ts` strips the `"<prefix>: "` before falling back to `Date.parse`.
- **JSON config drift:** the adapter manifest `transport` enum does NOT include `"https"` — use `"http_api"` for HTTP-based adapters.
- **Parallel subagents work cleanly** when they don't share files. 5 subagents touching 5 independent subtrees landed in parallel in this session with zero conflicts.
