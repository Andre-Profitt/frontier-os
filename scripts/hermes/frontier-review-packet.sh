#!/usr/bin/env bash
# scripts/hermes/frontier-review-packet.sh
#
# Hermes-bridge wrapper that assembles a PR review packet:
# - branch + diff stat vs base
# - typecheck
# - factory test surface
# - shadow reconciliation (state snapshot)
#
# Output is the structured envelope skills/pr-review-packet/SKILL.md
# describes. This script never pushes branches, never comments on PRs,
# never writes to remote anything — those are operator actions.
#
# Usage:
#   scripts/hermes/frontier-review-packet.sh [<base-ref>]
#   (default base-ref: origin/main)

set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=./_lib.sh
. "$HERE/_lib.sh"

hermes::require_repo_root
hermes::require_clean_args "$@"

base_ref="${1:-origin/main}"

cd "$FRONTIER_REPO_ROOT"

# Verify the base ref resolves; if not, fall back to main without origin/.
if ! git rev-parse --verify "$base_ref" >/dev/null 2>&1; then
  if git rev-parse --verify main >/dev/null 2>&1; then
    base_ref="main"
  else
    hermes::die 40 "no usable base ref (tried $1, main)"
  fi
fi

current_branch="$(git rev-parse --abbrev-ref HEAD)"
current_head="$(git rev-parse HEAD)"
base_head="$(git rev-parse "$base_ref")"

diff_stat="$(git diff --stat "$base_ref"...HEAD || true)"
commits_log="$(git log --oneline "$base_ref"..HEAD || true)"

# Run typecheck — capture output but don't abort the packet on
# failure; the failure IS the evidence we want to include.
typecheck_status=0
typecheck_output="$(npx tsc --noEmit 2>&1)" || typecheck_status=$?

# Run the factory test surface. Each file separately so a single
# failure doesn't suppress others. macOS bash 3.2 lacks associative
# arrays; emit per-file results as a flat tab-separated list and let
# Python parse it.
test_results_tsv=""
test_pass_total=0
test_fail_total=0
for f in factories/ai-stack-local-smoke/tests/*.test.ts \
         tests/skills/structure.test.ts \
         tests/taste/structure.test.ts; do
  [[ -f "$f" ]] || continue
  suite_status="ok"
  if ! out="$(node --import tsx --test "$f" 2>&1)"; then
    suite_status="suite-failed"
    out="${out:-}"
  fi
  # `|| true` because grep exits 1 when no matches (e.g. recursive
  # node-test invocation prints a warning but no "# pass" line). With
  # set -o pipefail that would abort the script.
  pass="$(printf '%s' "$out" | { grep -E '^# pass' || true; } | awk '{print $3}' | head -1)"
  fail="$(printf '%s' "$out" | { grep -E '^# fail' || true; } | awk '{print $3}' | head -1)"
  pass="${pass:-0}"
  fail="${fail:-0}"
  test_results_tsv+="${f}	${pass}	${fail}	${suite_status}"$'\n'
  test_pass_total=$((test_pass_total + pass))
  test_fail_total=$((test_fail_total + fail))
done

# Shadow reconcile — capture status without depending on success.
recon_output="$("$FRONTIER_REPO_ROOT/bin/frontier" factory reconcile ai-stack-local-smoke --mode observe --json 2>&1 || true)"

# Audit-block check: verify each commit on the branch carries the
# three required fields. The commit-msg guard already enforces this on
# write; the packet re-checks at review time.
audit_failures=0
audit_total=0
audit_details=""
while IFS= read -r sha; do
  [[ -z "$sha" ]] && continue
  audit_total=$((audit_total + 1))
  msg="$(git log -1 --format=%B "$sha")"
  for field in "Session:" "Scope:" "Verification:"; do
    if ! grep -q "$field" <<<"$msg"; then
      audit_failures=$((audit_failures + 1))
      audit_details+="$sha: missing $field"$'\n'
      break
    fi
  done
done < <(git rev-list "$base_ref"..HEAD)

# Forbidden-action audit: scan diff additions on SOURCE files only.
# Doc / policy / skill / taste files legitimately enumerate the
# patterns (that's how AGENTS.md teaches them), so excluding them
# avoids false positives on every PR that updates docs.
forbidden_hits=""
diff_text="$(
  git diff "$base_ref"...HEAD -- \
    ':(exclude)*.md' \
    ':(exclude)*.json' \
    ':(exclude)skills/**' \
    ':(exclude)taste/**' \
    ':(exclude)hermes/**' \
    ':(exclude)scripts/hermes/**' \
    ':(exclude)docs/**' \
    ':(exclude)tests/hermes/**' \
  || true
)"
while IFS= read -r pattern; do
  [[ -z "$pattern" ]] && continue
  if grep -qE "$pattern" <<<"$diff_text"; then
    forbidden_hits+="hit: $pattern"$'\n'
  fi
done <<'EOF'
^\+.*launchctl (bootstrap|bootout|load|unload)
^\+.*/Users/test/bin/
^\+.*git push --force
^\+.*--no-verify
EOF

# Pass everything to Python via env vars + stdin so we don't have to
# escape shell-into-Python literals.
export REVIEW_BRANCH="$current_branch"
export REVIEW_HEAD="$current_head"
export REVIEW_BASE_REF="$base_ref"
export REVIEW_BASE_HEAD="$base_head"
export REVIEW_COMMITS="$commits_log"
export REVIEW_DIFFSTAT="$diff_stat"
export REVIEW_TYPECHECK_STATUS="$typecheck_status"
export REVIEW_TYPECHECK_OUTPUT="$typecheck_output"
export REVIEW_TESTS_TSV="$test_results_tsv"
export REVIEW_TESTS_PASS_TOTAL="$test_pass_total"
export REVIEW_TESTS_FAIL_TOTAL="$test_fail_total"
export REVIEW_RECON="$recon_output"
export REVIEW_AUDIT_TOTAL="$audit_total"
export REVIEW_AUDIT_FAILURES="$audit_failures"
export REVIEW_AUDIT_DETAILS="$audit_details"
export REVIEW_FORBIDDEN="$forbidden_hits"

python3 - <<'PY'
import json, os
def env(k, default=""):
    return os.environ.get(k, default)

tests_by_file = []
for line in env("REVIEW_TESTS_TSV").splitlines():
    if not line.strip():
        continue
    parts = line.split("\t")
    if len(parts) < 4:
        continue
    tests_by_file.append({
        "path": parts[0],
        "pass": int(parts[1] or 0),
        "fail": int(parts[2] or 0),
        "status": parts[3],
    })

raw_recon = env("REVIEW_RECON").strip()
try:
    recon = json.loads(raw_recon) if raw_recon else None
except Exception:
    recon = {"raw": raw_recon[-2000:]}

print(json.dumps({
    "bridge": "frontier-os",
    "verb": "factory.review-packet",
    "branch": env("REVIEW_BRANCH"),
    "head": env("REVIEW_HEAD"),
    "base": {
        "ref": env("REVIEW_BASE_REF"),
        "head": env("REVIEW_BASE_HEAD"),
    },
    "commits": env("REVIEW_COMMITS"),
    "diffStat": env("REVIEW_DIFFSTAT"),
    "typecheck": {
        "exitCode": int(env("REVIEW_TYPECHECK_STATUS", "0")),
        "output": env("REVIEW_TYPECHECK_OUTPUT")[-4000:],
    },
    "tests": {
        "passTotal": int(env("REVIEW_TESTS_PASS_TOTAL", "0")),
        "failTotal": int(env("REVIEW_TESTS_FAIL_TOTAL", "0")),
        "byFile": tests_by_file,
    },
    "reconciliation": recon,
    "auditBlocks": {
        "totalCommits": int(env("REVIEW_AUDIT_TOTAL", "0")),
        "missingAuditFieldCount": int(env("REVIEW_AUDIT_FAILURES", "0")),
        "details": env("REVIEW_AUDIT_DETAILS"),
    },
    "forbiddenActions": {
        "found": env("REVIEW_FORBIDDEN"),
    },
}))
PY
