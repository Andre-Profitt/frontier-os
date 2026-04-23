# Real-SF Smoke Test Runbook

Date: 2026-04-08
Status: deferred — this step needs a user-driven Chrome launch.

## Goal

Validate that `inspect-dashboard` + `audit-dashboard` work against a real Salesforce Lightning dashboard in the `simcorp.my.salesforce.com` org. Target dashboard: **Sales Directors Monthly Pipeline and Insights** (`01ZTb00000FSP7hMAH`), which has a prior human grade of `12 BLOCKING / 10 WRONG-DATA / 1 ORPHAN / 2 OK` from the Sales Director Monthly Phase 1 audit — useful as a cross-check for the frontier-os audit rules.

## Prerequisites

- `sf` CLI authenticated to `my-org` (`apro@simcorp.com`). Verify: `sf org list`.
- Chrome installed at `/Applications/Google Chrome.app`.
- Port 9222 available locally.

## Steps

### 1. Get an authenticated frontdoor URL

```bash
sf org open --path "/lightning/r/Dashboard/01ZTb00000FSP7hMAH/view" --url-only --json \
  | jq -r .result.url > /tmp/frontier-sf-frontdoor.txt
```

The URL contains a one-time-password token (`otp=...`) + the dashboard path as `startURL`. **It expires fast** — run this immediately before launching Chrome.

### 2. Launch Chrome in a dedicated debug profile

```bash
mkdir -p "$HOME/.chrome-bops-sf"
/Applications/Google\ Chrome.app/Contents/MacOS/Google\ Chrome \
  --headless=new \
  --remote-debugging-port=9222 \
  --user-data-dir="$HOME/.chrome-bops-sf" \
  --no-first-run --no-default-browser-check \
  --disable-blink-features=AutomationControlled \
  "$(cat /tmp/frontier-sf-frontdoor.txt)" > /tmp/chrome-bops-sf.log 2>&1 &
```

Delete the frontdoor tempfile immediately after the Chrome process has it: `rm /tmp/frontier-sf-frontdoor.txt`.

Wait ~10 seconds for Salesforce Aura to bootstrap. On a fresh profile, the sequence is: frontdoor → session cookie set → redirect to dashboard URL → Lightning bootstrap → dashboard widgets fetch → page stable.

**Headful alternative (if you want to see what's happening):** drop the `--headless=new` flag. The window will pop up.

### 3. Verify the debug port is live and the SF tab is loaded

```bash
lsof -iTCP:9222 -sTCP:LISTEN | head -3
cd ~/frontier-os
./bin/frontier adapter invoke browser list-tabs --mode read --pretty | jq '.observedState.tabs[] | select(.type=="page") | {id, title, url}'
```

You should see one or more page tabs with `*.salesforce.com` or `lightning.force.com` in the URL.

### 4. Run inspect-dashboard

```bash
./bin/frontier adapter invoke salesforce inspect-dashboard --mode read --pretty
```

**Expected (best case):**

```json
{
  "status": "success",
  "summary": "inspected classic dashboard \"Sales Directors Monthly Pipeline and Insights\" — N widgets, N filters",
  "observedState": {
    "dashboard": {
      "detected": true,
      "kind": "classic" | "crma",
      "title": "Sales Directors Monthly ...",
      "widgetCount": N,
      "filterCount": N,
      "aura": { "detected": true, "idle": true },
      ...
    }
  }
}
```

**Expected (partial detection):**

```json
{
  "status": "partial",
  "summary": "no dashboard detected at ...: no dashboard container found (tried: ...)"
}
```

→ This means the walker's selector list in `src/adapters/salesforce/lightning.ts` is missing a Lightning variant. Grab the actual container tag from the page via `run-script`:

```bash
./bin/frontier adapter invoke browser run-script --mode read --input \
  '{"expression":"(() => { const q = sel => Array.from(document.querySelectorAll(sel)); return { analytics: q(\"[tagname^=analytics-], analytics-dashboard-container\").length, wave: q(\"[tagname^=wave-], wave-dashboard-runtime\").length, auraClass: q(\"[data-aura-class]\").slice(0, 20).map(e => e.getAttribute(\"data-aura-class\")) }; })()"}'
```

Add whatever tag the page actually uses to `CONTAINER_SELECTORS` in `DASHBOARD_WALKER_SRC` (lightning.ts).

### 5. Run audit-dashboard

```bash
./bin/frontier adapter invoke salesforce audit-dashboard --mode read --pretty
```

Expected output: a grade line matching the `BLOCKING / WRONG-DATA / WARNING / ORPHAN / INFO` format, with 11 rules evaluated. Compare against the prior `12 BLOCKING / 10 WRONG-DATA / 1 ORPHAN / 2 OK` human grade to see where the rule set is conservative, aggressive, or blind.

### 6. Check the ledger for the audit session

```bash
./bin/frontier ledger list-sessions --limit 3
./bin/frontier ledger search --kind audit.grade --limit 3
```

### 7. Clean up Chrome

```bash
pkill -f "remote-debugging-port=9222"
# Or: lsof -iTCP:9222 -sTCP:LISTEN → kill the PID
```

Leave `$HOME/.chrome-bops-sf` in place — it has the authenticated session cookies cached, so the next run doesn't need a fresh frontdoor URL (unless the session expires).

## When the walker misses on a real dashboard

1. Note which `CONTAINER_SELECTORS` entries didn't match (the walker's `not detected` reason lists all tried selectors)
2. Use the probe from step 4 to find the actual tag or class the page uses
3. Add the new selector to `DASHBOARD_WALKER_SRC` in `src/adapters/salesforce/lightning.ts`
4. Re-run `./bin/frontier adapter invoke salesforce inspect-dashboard`
5. Commit the selector addition (git tracked if frontier-os has its own repo; currently gitignored at home level)

## When `aura.detected: false`

The `$A.clientService.inFlightXHRs()` hook only exists on Aura pages. Pure-LWC pages don't have `$A`. The walker already handles this — `aura.idle` falls back to `true` when `$A` is missing. But if you see unexpected test failures because `waitStable` returns too early, check `window.__frontier.summary()` via `run-script` to confirm helper state.

## Batch run across the full portfolio

Once one dashboard works, test the batch runner:

```bash
cd ~/frontier-os
cat > /tmp/my-dashboards.txt <<'EOF'
# Known dashboards from MEMORY
01ZTb00000FSP7hMAH  # Sales Directors Monthly
01ZTb00000DoGYLMA3  # Book Of Business
01ZTb00000E1e50MAB  # Sales Excellence (RTB)
EOF

./bin/frontier salesforce audit-batch /tmp/my-dashboards.txt --dry-run  # sanity check
./bin/frontier salesforce audit-batch /tmp/my-dashboards.txt            # real run
./bin/frontier salesforce portfolio-summary <session-id-from-the-batch-output>
```

The batch runner assigns a shared session id so all three audits land under one ledger session. `portfolio-summary` then produces a combined grade across all three, plus the top recurring rules across the portfolio.
