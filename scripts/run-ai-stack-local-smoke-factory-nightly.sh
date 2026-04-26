#!/usr/bin/env bash
# run-ai-stack-local-smoke-factory-nightly.sh
#
# launchd target wrapper. Boring on purpose — enter the repo and exec the
# supervisor. No business logic in bash.
#
# This is the script that
# `~/Library/LaunchAgents/com.andre.ai-stack.local-smoke.plist`'s
# ProgramArguments will point at after activation. Until activation
# happens, this script is unused on the live schedule.

set -euo pipefail

cd /Users/test/frontier-os

# Use the same node binary that drives the rest of the repo. The /Users
# path is set in the launchd plist's PATH; we exec via bash so quoting
# stays sane.
exec node --import tsx \
  factories/ai-stack-local-smoke/supervisor.ts \
  --trigger launchd
