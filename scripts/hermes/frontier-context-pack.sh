#!/usr/bin/env bash
# scripts/hermes/frontier-context-pack.sh
#
# Hermes-bridge wrapper for `frontier context pack --lane <id>`.
# Read-only.
#
# Usage:
#   scripts/hermes/frontier-context-pack.sh <lane> [--alert-lookback-days N] [--no-alerts]

set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=./_lib.sh
. "$HERE/_lib.sh"

hermes::require_repo_root
hermes::require_clean_args "$@"

if [[ "$#" -lt 1 ]]; then
  hermes::die 30 "usage: frontier-context-pack.sh <lane> [--alert-lookback-days N] [--no-alerts]"
fi

lane="$1"; shift

args=(context pack --lane "$lane" --json)
while [[ "$#" -gt 0 ]]; do
  case "$1" in
    --alert-lookback-days)
      # Validate integer.
      if ! [[ "$2" =~ ^[0-9]+$ ]]; then
        hermes::die 32 "--alert-lookback-days must be a non-negative integer"
      fi
      args+=(--alert-lookback-days "$2")
      shift 2
      ;;
    --no-alerts)
      args+=(--no-alerts)
      shift
      ;;
    *)
      hermes::die 33 "unknown flag: $1"
      ;;
  esac
done

hermes::frontier_cli "${args[@]}" | hermes::tag_output context.pack
