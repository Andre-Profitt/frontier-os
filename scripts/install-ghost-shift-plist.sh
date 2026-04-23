#!/usr/bin/env bash
# install-ghost-shift-plist.sh — idempotent installer for the Ghost Shift launchd agent.
# Writes (or refreshes) ~/Library/LaunchAgents/com.frontier-os.ghost-shift.plist,
# lints it, unloads any prior copy, then loads it with -w (persistent).
set -euo pipefail

LABEL="com.frontier-os.ghost-shift"
FRONTIER_BIN="/Users/test/frontier-os/bin/frontier"
PLIST_DST="/Users/test/Library/LaunchAgents/${LABEL}.plist"
LOG_DIR="/Users/test/Library/Logs/frontier-os"

if [[ ! -x "$FRONTIER_BIN" ]]; then
  echo "ERROR: frontier binary not found or not executable at $FRONTIER_BIN" >&2
  exit 1
fi

mkdir -p "$LOG_DIR"
mkdir -p "$(dirname "$PLIST_DST")"

cat > "$PLIST_DST" <<'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>com.frontier-os.ghost-shift</string>
  <key>ProgramArguments</key>
  <array>
    <string>/Users/test/frontier-os/bin/frontier</string>
    <string>ghost</string>
    <string>run</string>
    <string>--max-runtime</string>
    <string>1800</string>
    <string>--max-concurrent</string>
    <string>4</string>
    <string>--max-retries</string>
    <string>1</string>
  </array>
  <key>StartCalendarInterval</key>
  <array>
    <dict>
      <key>Minute</key>
      <integer>0</integer>
      <key>Hour</key>
      <integer>2</integer>
    </dict>
  </array>
  <key>RunAtLoad</key>
  <false/>
  <key>StandardOutPath</key>
  <string>/Users/test/Library/Logs/frontier-os/ghost-shift.out.log</string>
  <key>StandardErrorPath</key>
  <string>/Users/test/Library/Logs/frontier-os/ghost-shift.err.log</string>
</dict>
</plist>
PLIST

# Validate plist syntax.
plutil -lint "$PLIST_DST"

# Unload any prior copy (quietly — ignore "Could not find specified service").
launchctl unload "$PLIST_DST" >/dev/null 2>&1 || true

# Load with -w so the agent persists across reboots/logouts.
launchctl load -w "$PLIST_DST"

echo "installed: $PLIST_DST"
echo "schedule:  daily at 02:00 local"
echo "logs:      $LOG_DIR/ghost-shift.{out,err}.log"
echo -n "launchctl: "
launchctl list | grep ghost || echo "(not listed — check Console.app for launchd errors)"
