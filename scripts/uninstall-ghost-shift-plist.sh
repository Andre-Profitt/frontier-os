#!/usr/bin/env bash
# uninstall-ghost-shift-plist.sh — remove the Ghost Shift launchd agent.
# Unloads the agent and removes only the plist file. Logs and queue state are left alone.
set -euo pipefail

LABEL="com.frontier-os.ghost-shift"
PLIST_DST="/Users/test/Library/LaunchAgents/${LABEL}.plist"

if [[ -f "$PLIST_DST" ]]; then
  launchctl unload "$PLIST_DST" >/dev/null 2>&1 || true
  rm -f "$PLIST_DST"
  echo "removed: $PLIST_DST"
else
  launchctl unload "$PLIST_DST" >/dev/null 2>&1 || true
  echo "not present: $PLIST_DST (nothing to remove)"
fi

if launchctl list | grep -q "$LABEL"; then
  echo "WARNING: $LABEL still listed by launchctl — run 'launchctl remove $LABEL'" >&2
  exit 1
fi
echo "done"
