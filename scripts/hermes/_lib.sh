#!/usr/bin/env bash
# scripts/hermes/_lib.sh
#
# Shared utilities for the Hermes ↔ frontier-os bridge wrappers. All
# bridge scripts source this. The job here is to enforce the policy
# in hermes/policy.json before any underlying CLI runs.
#
# Concrete-first: hard-code paths and verbs. Adding a wrapper requires
# editing both hermes/policy.json and tests/hermes/policy.test.ts.

set -euo pipefail

HERMES_LIB_HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
FRONTIER_REPO_ROOT="$(cd "$HERMES_LIB_HERE/../.." && pwd)"
HERMES_POLICY_FILE="$FRONTIER_REPO_ROOT/hermes/policy.json"

hermes::die() {
  # Emit a structured refusal to stderr. Hermes parses this; humans read it.
  local code="$1"; shift
  printf '{"error": %s, "code": %s, "bridge": "frontier-os"}\n' \
    "$(printf '%s' "$*" | python3 -c 'import json,sys;print(json.dumps(sys.stdin.read().strip()))')" \
    "$code" >&2
  exit "$code"
}

hermes::require_clean_args() {
  # Reject suspicious tokens in the script's argv. The blocklist
  # patterns from policy.json must not appear in any user-supplied arg.
  for arg in "$@"; do
    case "$arg" in
      *'$('*|*'`'*|*'rm -rf'*|*'/Users/test/bin/'*|*'launchctl '*|*'git push'*|*'git commit'*)
        hermes::die 10 "blocked: argument contains a forbidden pattern ($arg)"
        ;;
    esac
  done
}

hermes::require_repo_root() {
  # The bridge must run from the frontier-os repo. If the working
  # directory is somewhere else, refuse — paths in policy.json are
  # relative to FRONTIER_REPO_ROOT.
  if [[ ! -f "$HERMES_POLICY_FILE" ]]; then
    hermes::die 11 "policy file missing: $HERMES_POLICY_FILE"
  fi
}

hermes::require_approval_token() {
  # Used by gated verbs. The operator mints HERMES_APPROVAL_TOKEN
  # out-of-band; we check scope + non-empty here. Token consumption is
  # the operator's responsibility (they don't reuse the same string).
  local scope="$1"
  local token="${HERMES_APPROVAL_TOKEN:-}"
  if [[ -z "$token" ]]; then
    hermes::die 20 "gated verb requires HERMES_APPROVAL_TOKEN env var (scope=$scope)"
  fi
  # Token format: "<scope>:<random>". The operator can roll the random
  # half however they want; we only check the scope prefix.
  case "$token" in
    "$scope":*)
      :  # ok
      ;;
    *)
      hermes::die 21 "approval token scope mismatch: required=$scope got=${token%%:*}"
      ;;
  esac
}

hermes::frontier_cli() {
  # Run the frontier CLI with --json by default so Hermes can parse
  # the output. Caller appends positional + flags after.
  local entry="$FRONTIER_REPO_ROOT/bin/frontier"
  if [[ ! -x "$entry" ]]; then
    hermes::die 12 "frontier CLI not executable at $entry"
  fi
  "$entry" "$@"
}

hermes::tag_output() {
  # Wrap CLI stdout in a small envelope so Hermes can correlate
  # bridge-tagged output across multiple invocations.
  local verb="$1"
  local payload
  payload="$(cat)"
  printf '{"bridge": "frontier-os", "verb": "%s", "payload": %s}\n' \
    "$verb" \
    "${payload:-null}"
}
