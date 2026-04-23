# Runbook — Browser Adapter (v0.2)

Date: 2026-04-08
Status: injection pipeline + CDP-native DOM snapshot landed

## What exists

- `bin/frontier` — executable shim, execs TypeScript entrypoint via `tsx`
- `src/cli.ts` — CLI dispatcher with `adapter list | show | invoke` families
- `src/schemas.ts` — loads the JSON schemas at `schemas/` and exposes `Ajv2020` validators
- `src/registry.ts` — loads adapter manifests from `manifests/adapters/*.adapter.json`, routes invocations
- `src/result.ts` — helpers for constructing schema-valid `AdapterResult` objects
- `src/adapters/browser/` — first runnable adapter
  - `cdp.ts` — thin `chrome-remote-interface` wrapper: `listTabs`, `pickPageTarget`, `attach` (with optional `installHelper`), `evaluate`
  - `index.ts` — command dispatcher
  - `commands/list-tabs.ts`
  - `commands/current-tab.ts`
  - `commands/capture-screenshot.ts`
  - `commands/run-script.ts` — bounded async JS eval with in-page try/catch + JSON serialization boundary
  - `commands/inspect-dom.ts` — **v0.2:** uses CDP-native `DOM.getDocument({depth: -1, pierce: true})` + TS clickable detector (no longer a placeholder)
  - **`inject/helper.js`** — page-side IIFE, installs `window.__frontier` with version guard, `frontier:nav` events on pushState/replaceState, shadow-aware MutationObserver, composite `waitStable` (Aura `$A.clientService.inFlightXHRs()` + spinner selectors + mutation quiescence), `summary()`, `destroy()`
  - **`inject/install.ts`** — installs the helper via `Page.addScriptToEvaluateOnNewDocument` + `Target.setAutoAttach({flatten:true})` + `Runtime.evaluate` for the current doc + `Page.frameNavigated` re-eval safety net for SPA soft-nav
  - **`inject/dom-tree.ts`** — CDP-native DOM walker using `DOM.getDocument({depth:-1, pierce:true})`; handles shadow roots (`nodeType: 11`) and iframe `contentDocument` transparently; returns `{backendNodeId, nodeId, tag, attrs, text, interactive, interactiveReason, shadowRootMode, children[]}`
  - **`inject/clickable.ts`** — port of browser-use's `ClickableElementDetector.is_interactive` (v0.2 subset: tag list, ARIA roles, event-handler attrs, search heuristics, Lightning Web Component tag shortcuts)

## Research-dossier pivot: no buildDomTree.js port

The research dossier at `~/code/tools/browser-ops/docs/research-dossier-2026-04-08.md` recommended porting `buildDomTree.js` from browser-use. **That file no longer exists in browser-use's main branch** — they refactored to a fully CDP-native architecture using `DOMSnapshot.captureSnapshot` + `DOM.getDocument({pierce:true})` + `Accessibility.getFullAXTree`, with serialization in Python (`browser_use/dom/serializer/`).

Frontier OS adopts the same architectural direction:

- DOM tree = `DOM.getDocument({depth:-1, pierce:true})` (single call, native shadow piercing, backend-node-id stable)
- Clickable detection = TS port of `ClickableElementDetector.is_interactive` (`inject/clickable.ts`)
- Layout bounds + computed styles = planned via `DOMSnapshot.captureSnapshot` in v0.3
- AXTree = deliberately skipped for Lightning per research dossier (noisy on LWC shadow + React wrappers); will be wired selectively for Sigma and cleaner React apps

Net effect: the `buildDomTree.js` port is replaced by ~190 LOC of TypeScript across `clickable.ts` (heuristics) and `dom-tree.ts` (CDP walker). Cleaner than porting a no-longer-extant JS file.

The CLI validates every invocation against `schemas/adapter-invocation.schema.json` and every result against `schemas/adapter-result.schema.json`. Manifests are validated against `schemas/adapter-manifest.schema.json` on load.

## Prerequisites

- Node 20+
- `npm install` has been run at the repo root
- Chrome with `--remote-debugging-port=9222` (see below)

## Starting Chrome for the adapter

**Option A — dedicated debug profile (recommended for dev/smoke tests):**

```bash
mkdir -p "$HOME/.chrome-bops"
/Applications/Google\ Chrome.app/Contents/MacOS/Google\ Chrome \
  --remote-debugging-port=9222 \
  --user-data-dir="$HOME/.chrome-bops" \
  --no-first-run \
  --no-default-browser-check
```

**Option B — headless for smoke tests only:**

```bash
/Applications/Google\ Chrome.app/Contents/MacOS/Google\ Chrome \
  --headless=new \
  --remote-debugging-port=9222 \
  --user-data-dir="$HOME/.chrome-bops" \
  "https://example.com/"
```

**Note on Chrome 136+:** `--remote-debugging-port` is ignored on real (non-dedicated) user data dirs as a security mitigation. Use a dedicated `--user-data-dir` (as above) to enable the debug port. This is why Option A uses `$HOME/.chrome-bops` rather than attaching to your main profile.

## Verified commands

All five have been exercised end-to-end against a live Chrome debug session and returned schema-valid success results:

```bash
./bin/frontier adapter list --pretty
./bin/frontier adapter show browser --pretty

./bin/frontier adapter invoke browser list-tabs --mode read --pretty

./bin/frontier adapter invoke browser current-tab --mode read --pretty

./bin/frontier adapter invoke browser capture-screenshot --mode read \
  --input '{"format":"png"}' --pretty
# Screenshot written to ~/.frontier/artifacts/screenshot_<invocationId>.png

./bin/frontier adapter invoke browser run-script --mode read \
  --input '{"expression":"({href:location.href,title:document.title})"}' --pretty

./bin/frontier adapter invoke browser inspect-dom --mode read \
  --input '{"maxDepth":3,"maxNodes":30}' --pretty
```

## Failure shape

If Chrome is not running with the debug port open:

```json
{
  "invocationId": "inv_...",
  "adapterId": "browser",
  "command": "list-tabs",
  "status": "failed",
  "finishedAt": "...",
  "summary": "connect ECONNREFUSED 127.0.0.1:9222"
}
```

Exit code is `2` for failed invocations, `1` for CLI-level errors, `0` for success.

## Artifact path

Screenshots and other binary artifacts are written to `~/.frontier/artifacts/`. Override with `outDir` in the invocation `arguments`. The directory is auto-created on first write.

## Verified end-to-end against live headless Chrome (v0.2)

- **CDP-native DOM walk** — `inspect-dom` against `https://example.com/`: 6 nodes, interactive detection flagged `<a>` correctly with reason `tag:a`
- **Shadow DOM piercing** — injected a shadow host via `run-script`, then `inspect-dom` captured the shadow root (`nodeType: 11`, `shadowRootMode: "open"`) and its interactive descendants: `<button>` → `tag:button`, `<span role="button" tabindex="0">` → `attr:tabindex`. 10 nodes total, 3 interactive, 1 shadow root seen.
- **Helper idempotency** — `helperInstalled: true` in the result, `window.__frontier.__version === 1` verified via `run-script`, `summary()` returned version + installedAt + Aura detected: false + spinner idle: true
- **`frontier:nav` soft-nav events** — two `history.pushState` calls fired two `CustomEvent('frontier:nav', {detail: {url, reason: "pushState"}})` events, captured by an in-page listener
- **`waitStable` composite signal** — resolved in 204 ms with `{signals: {aura: "idle", spinners: "idle"}}`

## Not yet implemented

- `inspect-network` — needs `Network.*` domain subscription buffered across the invocation
- `click-element` — needs action/verify loop (network expectation + ARIA snapshot diff + toast watcher)
- `waitStable` as a first-class `frontier adapter invoke browser wait-stable` command (currently only callable via `run-script "window.__frontier.waitStable(...)"`)
- Target selection by URL pattern from the CLI — currently `current-tab` and friends pick the first non-chrome page target; to pin a specific tab, pass `{ "target": "<tab id>" }` or `{ "target": "<url substring>" }` in the invocation arguments
- Layout bounds + computed styles on `inspect-dom` — v0.3 via `DOMSnapshot.captureSnapshot`
- Persistent CDP sessions — each command currently attaches/closes its own session, so `addScriptToEvaluateOnNewDocument` registrations don't survive across commands; the helper re-injects on every attach via `installHelper: true` which is idempotent and cheap, but a long-lived session pool will be needed for watchers
- Session append-only event log — no ledger persistence yet, every invocation is one-shot
- Policy engine — `mode` is checked against the manifest's `supportedModes`, but the approvals / spend caps / kill switch layer from the policy pack is not wired in
- Toast watcher, Sigma postMessage listener, network-ignore-list fetch/XHR patching — scoped out of v0.2, planned alongside the first salesforce adapter command

## Where the browser-ops research applies next

The full research dossier at `~/code/tools/browser-ops/docs/research-dossier-2026-04-08.md` still applies — it's the authoritative design for:

1. Porting `buildDomTree.js` from browser-use (MIT) into `src/adapters/browser/inject/dom-tree.ts` to replace the placeholder `inspect-dom` serializer
2. Helper injection pipeline (must survive SPA soft-nav via `framenavigated` re-eval + idempotent `window.__bops` guard)
3. Composite stability detection (mutation quiescence + long-animation-frame + network-ignore-list + aria-busy + `$A.clientService.inFlightXHRs()` for Lightning)
4. Action/verify loop with toast watcher, network expectation, ARIA snapshot diff, odiff for screenshot diff
5. Salesforce adapter strategy: `dom-walk` snapshot (AXTree is noisy on Lightning), UTAM selector mining, CRMA `data-widget-id` as the most automation-friendly surface
6. Sigma adapter strategy: API-first via `api.sigmacomputing.com/v2`, thin CDP layer using documented `postMessage` events (`workbook:dataLoaded` etc.) as ready signal
7. ZoomInfo: `compliance_policy: disallowed_by_tos`, browser adapter forbidden, API-only

These are not in the current spike but are the next ~4 weeks of work.
