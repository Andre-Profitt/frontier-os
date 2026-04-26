#!/usr/bin/env bash
# scripts/hermes/frontier-reconcile.sh
#
# Hermes-bridge wrapper for `frontier factory reconcile`. Default mode
# is shadow. observe is also free. active is GATED — requires
# HERMES_APPROVAL_TOKEN with scope=factory.reconcile.active.
#
# Usage:
#   scripts/hermes/frontier-reconcile.sh <factoryId> [--mode shadow|observe|active]

set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=./_lib.sh
. "$HERE/_lib.sh"

hermes::require_repo_root
hermes::require_clean_args "$@"

if [[ "$#" -lt 1 ]]; then
  hermes::die 30 "usage: frontier-reconcile.sh <factoryId> [--mode shadow|observe|active]"
fi

factory_id="$1"; shift
case "$factory_id" in
  ai-stack-local-smoke) ;;
  *)
    hermes::die 31 "unknown factoryId: $factory_id"
    ;;
esac

mode="shadow"
trigger="manual"
while [[ "$#" -gt 0 ]]; do
  case "$1" in
    --mode)
      mode="$2"; shift 2
      ;;
    --trigger)
      trigger="$2"; shift 2
      ;;
    *)
      hermes::die 32 "unknown flag: $1"
      ;;
  esac
done

case "$mode" in
  shadow|observe)
    : # safe by default
    ;;
  active)
    hermes::require_approval_token "factory.reconcile.active"
    ;;
  *)
    hermes::die 33 "unknown mode: $mode (must be shadow|observe|active)"
    ;;
esac

case "$trigger" in
  manual|launchd|watchdog) ;;
  *)
    hermes::die 34 "unknown trigger: $trigger"
    ;;
esac

hermes::frontier_cli \
  factory reconcile "$factory_id" \
  --mode "$mode" \
  --trigger "$trigger" \
  --json \
  | hermes::tag_output "factory.reconcile.$mode"
