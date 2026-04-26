#!/usr/bin/env bash
# install-local-smoke-factory-launchd.sh
#
# Activation tooling for Factory #1 (ai-stack-local-smoke). Default
# behavior is --dry-run; --apply requires an explicit flag and writes
# a backup of the live plist before modifying it. --rollback <id>
# restores from a named backup.
#
# This script does not call `launchctl load/unload` — that step is the
# operator's, by design. The script's job is plist surgery + backup.
#
# Modes:
#   --dry-run            (default) print plan, do not modify
#   --apply              backup + flip ProgramArguments → factory wrapper
#   --rollback <id>      restore backup <id>.plist
#
# Hard guards:
#   - real plist must exist (refuse if missing)
#   - wrapper script must exist + be executable
#   - working tree must be clean (refuse if dirty, unless --allow-dirty)
#
# Backups land in factories/ai-stack-local-smoke/state/backups/.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LANE="ai-stack-local-smoke"
PLIST="$HOME/Library/LaunchAgents/com.andre.ai-stack.local-smoke.plist"
WRAPPER="$REPO_ROOT/scripts/run-ai-stack-local-smoke-factory-nightly.sh"
BACKUP_DIR="$REPO_ROOT/factories/$LANE/state/backups"

MODE="dry-run"
ROLLBACK_ID=""
ALLOW_DIRTY=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    --dry-run)      MODE="dry-run"; shift ;;
    --apply)        MODE="apply"; shift ;;
    --rollback)     MODE="rollback"; ROLLBACK_ID="${2:-}"; shift 2 ;;
    --allow-dirty)  ALLOW_DIRTY=1; shift ;;
    -h|--help)
      sed -n '2,30p' "$0"
      exit 0
      ;;
    *) echo "error: unknown flag: $1" >&2; exit 64 ;;
  esac
done

# --- preflight ---------------------------------------------------------------

cd "$REPO_ROOT"

if [[ "$MODE" != "dry-run" && "$ALLOW_DIRTY" -eq 0 ]]; then
  if ! git diff --quiet || ! git diff --cached --quiet; then
    echo "error: working tree is dirty; refuse $MODE without --allow-dirty" >&2
    git status --short >&2
    exit 65
  fi
fi

if [[ ! -f "$PLIST" ]]; then
  echo "error: live plist not found: $PLIST" >&2
  exit 66
fi

if [[ ! -x "$WRAPPER" ]]; then
  echo "error: wrapper script missing or not executable: $WRAPPER" >&2
  echo "       fix: chmod +x $WRAPPER" >&2
  exit 67
fi

# --- shared inspection -------------------------------------------------------

current_program_arguments() {
  /usr/bin/plutil -extract ProgramArguments json -o - "$PLIST" 2>/dev/null \
    || echo '"<unreadable>"'
}

backup_id_from_now() {
  date -u +%Y%m%dT%H%M%SZ
}

case "$MODE" in
  dry-run)
    BACKUP_ID="$(backup_id_from_now)"
    BACKUP_PATH="$BACKUP_DIR/$BACKUP_ID.plist"
    cat <<EOF
=== Factory #1 launchd activation — DRY RUN ===
target plist:   $PLIST
current ProgramArguments: $(current_program_arguments)
proposed ProgramArguments: ["/bin/bash", "$WRAPPER"]
wrapper path:   $WRAPPER
wrapper exec:   yes
backup path:    $BACKUP_PATH
mode transition: shadow → active (writes state/mode.json on apply)
rollback cmd:   $0 --rollback $BACKUP_ID

This is a DRY RUN. No files modified. Re-run with --apply to commit.
EOF
    ;;

  apply)
    BACKUP_ID="$(backup_id_from_now)"
    BACKUP_PATH="$BACKUP_DIR/$BACKUP_ID.plist"
    mkdir -p "$BACKUP_DIR"
    cp "$PLIST" "$BACKUP_PATH"
    # Run the activation logic via tsx so the same code path tested in
    # activation.test.ts is the one mutating the live plist.
    node --import tsx -e "
      import { planActivation, applyActivation } from './factories/$LANE/activation.ts';
      const plan = planActivation({
        plistPath: '$PLIST',
        factoryWrapperPath: '$WRAPPER',
        backupDir: '$BACKUP_DIR',
        now: () => new Date('${BACKUP_ID:0:4}-${BACKUP_ID:4:2}-${BACKUP_ID:6:2}T${BACKUP_ID:9:2}:${BACKUP_ID:11:2}:${BACKUP_ID:13:2}Z'),
      });
      const result = applyActivation(plan, { dryRun: false });
      console.log(JSON.stringify(result, null, 2));
    "
    # Write mode.json: active.
    echo "{\"mode\":\"active\",\"setBy\":\"install-local-smoke-factory-launchd.sh\",\"setAt\":\"$(date -u +%Y-%m-%dT%H:%M:%SZ)\"}" \
      > "$REPO_ROOT/factories/$LANE/state/mode.json"
    cat <<EOF

=== APPLIED ===
plist updated: $PLIST
backup:        $BACKUP_PATH
mode.json:     active

To take effect on the live schedule, the operator must reload launchd:
  launchctl unload "$PLIST"
  launchctl load   "$PLIST"

Rollback if needed:
  $0 --rollback $BACKUP_ID
EOF
    ;;

  rollback)
    if [[ -z "$ROLLBACK_ID" ]]; then
      echo "error: --rollback requires <id>" >&2
      exit 64
    fi
    BACKUP_PATH="$BACKUP_DIR/$ROLLBACK_ID.plist"
    if [[ ! -f "$BACKUP_PATH" ]]; then
      echo "error: backup not found: $BACKUP_PATH" >&2
      exit 66
    fi
    cp "$BACKUP_PATH" "$PLIST"
    # Restore mode.json: shadow (the safe pre-activation default).
    echo "{\"mode\":\"shadow\",\"setBy\":\"install-local-smoke-factory-launchd.sh --rollback\",\"setAt\":\"$(date -u +%Y-%m-%dT%H:%M:%SZ)\"}" \
      > "$REPO_ROOT/factories/$LANE/state/mode.json"
    cat <<EOF
=== ROLLED BACK ===
plist restored: $PLIST
from backup:    $BACKUP_PATH
mode.json:      shadow

To re-take effect on the live schedule:
  launchctl unload "$PLIST"
  launchctl load   "$PLIST"
EOF
    ;;
esac
