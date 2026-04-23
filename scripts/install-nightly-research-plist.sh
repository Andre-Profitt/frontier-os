#!/bin/bash
# Install a launchd plist that enqueues tomorrow's nightly-research graph
# into the Ghost Shift queue at 01:55 local, ~5 min before Ghost Shift wakes
# at 02:00. Safe to re-run (unloads + reloads).

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENQUEUE_SCRIPT="$REPO_ROOT/scripts/enqueue-nightly-research.sh"
PLIST="$HOME/Library/LaunchAgents/com.frontier-os.nightly-research-enqueue.plist"
LOG_DIR="$HOME/Library/Logs/frontier-os"
LABEL="com.frontier-os.nightly-research-enqueue"

if [[ ! -x "$ENQUEUE_SCRIPT" ]]; then
  echo "enqueue script not executable: $ENQUEUE_SCRIPT" >&2
  echo "run: chmod +x $ENQUEUE_SCRIPT" >&2
  exit 2
fi

mkdir -p "$LOG_DIR"

cat > "$PLIST" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>/bin/bash</string>
    <string>${ENQUEUE_SCRIPT}</string>
  </array>
  <key>StartCalendarInterval</key>
  <array>
    <dict>
      <key>Minute</key>
      <integer>55</integer>
      <key>Hour</key>
      <integer>1</integer>
    </dict>
  </array>
  <key>RunAtLoad</key>
  <false/>
  <key>StandardOutPath</key>
  <string>${LOG_DIR}/nightly-research-enqueue.out.log</string>
  <key>StandardErrorPath</key>
  <string>${LOG_DIR}/nightly-research-enqueue.err.log</string>
</dict>
</plist>
PLIST

plutil -lint "$PLIST"

# Idempotent: unload first (silent if not loaded), then load.
launchctl unload "$PLIST" 2>/dev/null || true
launchctl load -w "$PLIST"

echo "installed: $PLIST"
echo "schedule:  daily at 01:55 local (enqueues ~5 min before Ghost Shift wakes)"
echo "logs:      $LOG_DIR/nightly-research-enqueue.{out,err}.log"
launchctl list | grep "${LABEL}" || echo "warning: ${LABEL} did not appear in launchctl list"
