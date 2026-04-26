#!/usr/bin/env bash
# scripts/hermes/frontier-activation-dry-run.sh
#
# Hermes-bridge wrapper for the activation dry-run path. Read-only:
# prints the proposed plist + backup path + rollback command and exits.
# Does NOT call --apply (that's a gated verb; the operator runs it
# directly after review).
#
# Usage:
#   scripts/hermes/frontier-activation-dry-run.sh <factoryId>

set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=./_lib.sh
. "$HERE/_lib.sh"

hermes::require_repo_root
hermes::require_clean_args "$@"

if [[ "$#" -ne 1 ]]; then
  hermes::die 30 "usage: frontier-activation-dry-run.sh <factoryId>"
fi

factory_id="$1"
case "$factory_id" in
  ai-stack-local-smoke) ;;
  *)
    hermes::die 31 "unknown factoryId: $factory_id"
    ;;
esac

# Defense in depth: the underlying script must NOT see --apply or
# --rollback no matter what argv we got. We hard-code --dry-run here.
installer="$FRONTIER_REPO_ROOT/scripts/install-local-smoke-factory-launchd.sh"
if [[ ! -x "$installer" ]]; then
  hermes::die 12 "installer not executable at $installer"
fi

# Capture stdout, then envelope it. The installer prints human-readable
# text (not JSON), so we package it as a raw string field.
output="$("$installer" --dry-run 2>&1)"
FACTORY_ID="$factory_id" python3 -c '
import json, sys, os
print(json.dumps({
    "bridge": "frontier-os",
    "verb": "factory.activation.dry-run",
    "factoryId": os.environ["FACTORY_ID"],
    "format": "text",
    "output": sys.stdin.read(),
}))
' <<<"$output"
