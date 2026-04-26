#!/usr/bin/env bash
# scripts/hermes/frontier-status.sh
#
# Hermes-bridge wrapper for `frontier factory status <id>`.
# Read-only verb. Allowed without an approval token.
#
# Usage: scripts/hermes/frontier-status.sh <factoryId>

set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=./_lib.sh
. "$HERE/_lib.sh"

hermes::require_repo_root
hermes::require_clean_args "$@"

if [[ "$#" -ne 1 ]]; then
  hermes::die 30 "usage: frontier-status.sh <factoryId>"
fi

factory_id="$1"
case "$factory_id" in
  ai-stack-local-smoke) ;;
  *)
    hermes::die 31 "unknown factoryId: $factory_id (concrete-first; only ai-stack-local-smoke is wired today)"
    ;;
esac

hermes::frontier_cli factory status "$factory_id" --json | hermes::tag_output factory.status
