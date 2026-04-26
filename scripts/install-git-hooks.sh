#!/usr/bin/env bash
# install-git-hooks.sh — point this repo's git at scripts/hooks/.
#
# Repo-local hook installation that survives clones via `git clone` followed
# by `./scripts/install-git-hooks.sh`. Sets `core.hooksPath` to the in-repo
# hooks directory so the commit-msg guard runs without copying files into
# .git/hooks/.
#
# Usage:
#   ./scripts/install-git-hooks.sh           # install
#   ./scripts/install-git-hooks.sh --uninstall   # revert to default

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
HOOKS_DIR="$REPO_ROOT/scripts/hooks"

cd "$REPO_ROOT"

if [[ ! -d ".git" ]]; then
  echo "install-git-hooks: not at a git repo root: $REPO_ROOT" >&2
  exit 1
fi

if [[ "${1:-}" == "--uninstall" ]]; then
  current="$(git config --get core.hooksPath || true)"
  if [[ "$current" == "scripts/hooks" || "$current" == "$HOOKS_DIR" ]]; then
    git config --unset core.hooksPath
    echo "install-git-hooks: uninstalled (core.hooksPath unset)"
  else
    echo "install-git-hooks: nothing to do (core.hooksPath = '${current:-(unset)}')"
  fi
  exit 0
fi

if [[ ! -d "$HOOKS_DIR" ]]; then
  echo "install-git-hooks: hooks directory missing: $HOOKS_DIR" >&2
  exit 1
fi

# Ensure the hooks are executable (in case clone didn't preserve perms).
for h in "$HOOKS_DIR"/*; do
  if [[ -f "$h" ]]; then
    chmod +x "$h"
  fi
done

git config core.hooksPath scripts/hooks
echo "install-git-hooks: core.hooksPath = scripts/hooks"
echo "install-git-hooks: hooks installed:"
ls -1 "$HOOKS_DIR"
