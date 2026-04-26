#!/usr/bin/env bash
# notify-alerts.sh — poll the Frontier OS ledger directly for unseen
# medium-or-higher alerts and fire macOS Notification Center notifications.
#
# Reads ~/.frontier/ledger.db via the sqlite3 CLI in read-only mode (same
# approach as jarvis-menubar's Swift LedgerReader). No HTTP dependency — the
# notifier keeps working even when the Frontier Siri Gateway is down.
#
# Called from a short cron/launchd cycle (60s is fine). Dedupes firing state
# in ~/.frontier/notify-alerts.state so each alertId is announced at most
# once per machine.
#
# Usage:
#   scripts/notify-alerts.sh [--min-severity medium|high|critical]
#                            [--state-file ~/.frontier/notify-alerts.state]
#                            [--ledger ~/.frontier/ledger.db]
#                            [--lookback-hours N]   (default 24)
#                            [--dry-run]
#
# Requires: sqlite3, osascript (macOS).

set -uo pipefail

MIN_SEVERITY="medium"
STATE_FILE="$HOME/.frontier/notify-alerts.state"
LEDGER_DB="$HOME/.frontier/ledger.db"
LOOKBACK_HOURS=24
DRY_RUN=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    --min-severity)   MIN_SEVERITY="$2"; shift 2 ;;
    --state-file)     STATE_FILE="$2"; shift 2 ;;
    --ledger)         LEDGER_DB="$2"; shift 2 ;;
    --lookback-hours) LOOKBACK_HOURS="$2"; shift 2 ;;
    --dry-run)        DRY_RUN=1; shift ;;
    -h|--help)        sed -n '2,20p' "$0"; exit 0 ;;
    *)                echo "error: unknown flag: $1" >&2; exit 64 ;;
  esac
done

if ! command -v sqlite3 >/dev/null 2>&1; then
  echo "error: sqlite3 is required" >&2; exit 69
fi
if [[ ! -f "$LEDGER_DB" ]]; then
  echo "error: ledger not found: $LEDGER_DB" >&2; exit 66
fi

mkdir -p "$(dirname "$STATE_FILE")"
touch "$STATE_FILE"

# Map severity name to rank; anything at or above the threshold passes.
case "$MIN_SEVERITY" in
  info)     MIN_RANK=0 ;;
  low)      MIN_RANK=1 ;;
  medium)   MIN_RANK=2 ;;
  high)     MIN_RANK=3 ;;
  critical) MIN_RANK=4 ;;
  *)        echo "error: bad --min-severity: $MIN_SEVERITY" >&2; exit 64 ;;
esac

SINCE_ISO=$(python3 -c "import datetime; print((datetime.datetime.now(datetime.timezone.utc) - datetime.timedelta(hours=$LOOKBACK_HOURS)).strftime('%Y-%m-%dT%H:%M:%SZ'))")

# Read alert events from the ledger as TSV. json_extract keeps us from
# parsing JSON in bash. `PRAGMA query_only=1` blocks writes at the session
# level but lets the CLI open the DB in r/w mode so it can coordinate with
# the Frontier OS writer's WAL journal — `-readonly` fails on WAL-mode
# databases when the WAL file cannot be created.
SQL="
PRAGMA query_only = 1;
SELECT
  COALESCE(json_extract(payload, '\$.alertId'), event_id)  AS alert_id,
  COALESCE(json_extract(payload, '\$.severity'), 'info')   AS severity,
  COALESCE(json_extract(payload, '\$.category'), 'health') AS category,
  COALESCE(json_extract(payload, '\$.source'),   actor, 'unknown') AS source,
  COALESCE(json_extract(payload, '\$.summary'),  '')       AS summary
FROM events
WHERE kind = 'alert'
  AND ts >= '$SINCE_ISO'
ORDER BY ts DESC
LIMIT 500;
"
RESULT=$(sqlite3 -separator $'\t' "$LEDGER_DB" "$SQL" 2>/dev/null)

if [[ -z "$RESULT" ]]; then
  exit 0
fi

fired=0
while IFS=$'\t' read -r alert_id severity category source summary; do
  [[ -z "$alert_id" ]] && continue
  # Filter below threshold at bash level so we don't build the rank
  # comparison into the SQL.
  case "$severity" in
    info)     rank=0 ;;
    low)      rank=1 ;;
    medium)   rank=2 ;;
    high)     rank=3 ;;
    critical) rank=4 ;;
    *)        rank=0 ;;
  esac
  [[ "$rank" -lt "$MIN_RANK" ]] && continue
  # Dedupe against history file.
  if grep -Fxq "$alert_id" "$STATE_FILE"; then
    continue
  fi
  severity_upper=$(printf '%s' "$severity" | tr '[:lower:]' '[:upper:]')
  title="[Frontier ${severity_upper}/${category}] ${source}"
  if [[ "$DRY_RUN" -eq 1 ]]; then
    echo "WOULD NOTIFY: $title — $summary (alertId=$alert_id)"
  else
    safe_summary=$(printf '%s' "$summary" | tr '\n' ' ' | sed 's/"/\\"/g')
    safe_title=$(printf '%s' "$title" | sed 's/"/\\"/g')
    osascript -e "display notification \"$safe_summary\" with title \"$safe_title\"" >/dev/null 2>&1 || true
    echo "$alert_id" >> "$STATE_FILE"
  fi
  fired=$((fired + 1))
done <<<"$RESULT"

if [[ "$fired" -gt 0 ]]; then
  echo "notify-alerts: fired $fired notification(s)"
fi
exit 0
