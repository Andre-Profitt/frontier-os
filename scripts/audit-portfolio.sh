#!/usr/bin/env bash
# audit-portfolio.sh — run `frontier adapter invoke salesforce audit-dashboard`
# across every dashboard listed in a file, under a single shared ledger session.
#
# Usage:
#   scripts/audit-portfolio.sh <dashboards-file> [--session <id>] [--base-url <url>] [--dry-run]
#
# Dashboards file format:
#   - One entry per line. Blank lines and lines starting with `#` are ignored.
#   - Each entry is either a full URL (starts with http) or a dashboard ID.
#   - Trailing `# comment` on a line is stripped.
#
# Behavior:
#   - Shared session id defaults to `audit-portfolio-<epoch>`; override with --session.
#   - Base URL defaults to `https://simcorp.my.salesforce.com`; override with --base-url.
#   - For each line, builds `{base-url}/lightning/r/Dashboard/{id}/view` unless the
#     line already looks like a URL, then invokes the adapter with
#     `--session <sharedSessionId>` and `--input '{"urlHint": "<url>"}'`.
#   - Collects exit codes; prints one progress line per dashboard.
#   - At the end, prints the shared session id so you can pipe it into the
#     portfolio summarizer.

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
FRONTIER_BIN="$REPO_ROOT/bin/frontier"

usage() {
  cat >&2 <<'USAGE'
usage: audit-portfolio.sh <dashboards-file> [--session <id>] [--base-url <url>] [--dry-run]

Run the salesforce audit-dashboard adapter across every dashboard listed in
<dashboards-file> under a single shared ledger session.

Options:
  --session <id>    Reuse an existing ledger session id (default: audit-portfolio-<epoch>)
  --base-url <url>  Salesforce base URL (default: https://simcorp.my.salesforce.com)
  --dry-run         Print the commands that would be executed, do not run them
  -h, --help        Show this help

Examples:
  scripts/audit-portfolio.sh fixtures/dashboards-sample.txt
  scripts/audit-portfolio.sh fixtures/dashboards-sample.txt --dry-run
  scripts/audit-portfolio.sh fixtures/dashboards-sample.txt --session audit-portfolio-rtb-2026-04-08
USAGE
}

DASHBOARDS_FILE=""
SESSION_ID=""
BASE_URL="https://simcorp.my.salesforce.com"
TARGET_ORG=""
REPORT_STALE_DAYS=""
DRY_RUN=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    -h|--help)
      usage
      exit 0
      ;;
    --session)
      if [[ $# -lt 2 ]]; then
        echo "error: --session requires a value" >&2
        exit 64
      fi
      SESSION_ID="$2"
      shift 2
      ;;
    --base-url)
      if [[ $# -lt 2 ]]; then
        echo "error: --base-url requires a value" >&2
        exit 64
      fi
      BASE_URL="$2"
      shift 2
      ;;
    --target-org)
      if [[ $# -lt 2 ]]; then
        echo "error: --target-org requires a value" >&2
        exit 64
      fi
      TARGET_ORG="$2"
      shift 2
      ;;
    --report-stale-days)
      if [[ $# -lt 2 ]]; then
        echo "error: --report-stale-days requires a value" >&2
        exit 64
      fi
      REPORT_STALE_DAYS="$2"
      shift 2
      ;;
    --dry-run)
      DRY_RUN=1
      shift
      ;;
    --)
      shift
      break
      ;;
    -*)
      echo "error: unknown flag: $1" >&2
      usage
      exit 64
      ;;
    *)
      if [[ -z "$DASHBOARDS_FILE" ]]; then
        DASHBOARDS_FILE="$1"
      else
        echo "error: unexpected positional argument: $1" >&2
        usage
        exit 64
      fi
      shift
      ;;
  esac
done

if [[ -z "$DASHBOARDS_FILE" ]]; then
  echo "error: dashboards-file is required" >&2
  usage
  exit 64
fi

if [[ ! -f "$DASHBOARDS_FILE" ]]; then
  echo "error: dashboards file not found: $DASHBOARDS_FILE" >&2
  exit 66
fi

if [[ -z "$SESSION_ID" ]]; then
  SESSION_ID="audit-portfolio-$(date +%s)"
fi

# Trim base URL trailing slash so URL concatenation stays clean.
BASE_URL="${BASE_URL%/}"

echo "[audit-portfolio] session: $SESSION_ID"
echo "[audit-portfolio] base-url: $BASE_URL"
echo "[audit-portfolio] dashboards-file: $DASHBOARDS_FILE"
if [[ "$DRY_RUN" -eq 1 ]]; then
  echo "[audit-portfolio] dry-run: commands will be printed, not executed"
fi

TOTAL=0
OK_COUNT=0
FAIL_COUNT=0
FAILED_ENTRIES=()

# Read the dashboards file line-by-line, stripping comments + whitespace.
while IFS='' read -r raw_line || [[ -n "$raw_line" ]]; do
  # Strip trailing `# comment`, leading/trailing whitespace.
  line="${raw_line%%#*}"
  # Trim leading/trailing whitespace without external tools.
  line="${line#"${line%%[![:space:]]*}"}"
  line="${line%"${line##*[![:space:]]}"}"
  [[ -z "$line" ]] && continue

  TOTAL=$((TOTAL + 1))

  # If the entry already looks like an absolute URL, take it as-is; otherwise
  # treat it as a dashboard id and build the standard Lightning view URL.
  if [[ "$line" == http://* || "$line" == https://* ]]; then
    url="$line"
    label="$line"
  else
    url="${BASE_URL}/lightning/r/Dashboard/${line}/view"
    label="$line"
  fi

  # Build the adapter input JSON. Use jq if available for safety; fall back
  # to a literal printf since urlHint values don't contain quotes or newlines
  # in our format. When --target-org / --report-stale-days are set, forward
  # them so each per-dashboard audit can run server-side enrichment.
  if command -v jq >/dev/null 2>&1; then
    input_json=$(jq -nc \
      --arg u "$url" \
      --arg org "$TARGET_ORG" \
      --arg days "$REPORT_STALE_DAYS" \
      '{urlHint: $u}
       + (if $org != "" then {targetOrg: $org} else {} end)
       + (if $days != "" then {reportStaleDays: ($days|tonumber)} else {} end)')
  else
    input_json="{\"urlHint\":\"${url}\""
    if [[ -n "$TARGET_ORG" ]]; then
      input_json="${input_json},\"targetOrg\":\"${TARGET_ORG}\""
    fi
    if [[ -n "$REPORT_STALE_DAYS" ]]; then
      input_json="${input_json},\"reportStaleDays\":${REPORT_STALE_DAYS}"
    fi
    input_json="${input_json}}"
  fi

  printf '[audit-portfolio] (%d) %s\n' "$TOTAL" "$label"
  printf '[audit-portfolio]     -> %s\n' "$url"

  if [[ "$DRY_RUN" -eq 1 ]]; then
    printf '[audit-portfolio]     $ %s adapter invoke salesforce audit-dashboard --mode read --session %q --input %q\n' \
      "$FRONTIER_BIN" "$SESSION_ID" "$input_json"
    OK_COUNT=$((OK_COUNT + 1))
    continue
  fi

  set +e
  "$FRONTIER_BIN" adapter invoke salesforce audit-dashboard \
    --mode read \
    --session "$SESSION_ID" \
    --input "$input_json" \
    >/dev/null
  rc=$?
  set -e

  if [[ "$rc" -eq 0 ]]; then
    OK_COUNT=$((OK_COUNT + 1))
    printf '[audit-portfolio]     status: ok\n'
  else
    FAIL_COUNT=$((FAIL_COUNT + 1))
    FAILED_ENTRIES+=("$label (rc=$rc)")
    printf '[audit-portfolio]     status: failed (rc=%d)\n' "$rc"
  fi
done < "$DASHBOARDS_FILE"

echo ""
echo "[audit-portfolio] done: $TOTAL dashboards, $OK_COUNT ok, $FAIL_COUNT failed"
if [[ "${#FAILED_ENTRIES[@]}" -gt 0 ]]; then
  echo "[audit-portfolio] failures:"
  for entry in "${FAILED_ENTRIES[@]}"; do
    echo "  - $entry"
  done
fi
echo ""
echo "[audit-portfolio] shared session id: $SESSION_ID"
echo "[audit-portfolio] summarize with:"
echo "  ./bin/frontier salesforce portfolio-summary $SESSION_ID"
echo "  ./bin/frontier salesforce portfolio-summary $SESSION_ID --json --pretty"

if [[ "$FAIL_COUNT" -gt 0 ]]; then
  exit 1
fi
exit 0
