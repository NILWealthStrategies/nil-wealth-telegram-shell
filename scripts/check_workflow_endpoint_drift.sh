#!/bin/zsh
set -u

ROOT_DIR="${1:-.}"
OLD_BOT_HOST_REGEX='nil-ops-bot\.render\.com'
BAD_LOCAL_TARGET_REGEX='https?://(localhost|127\.0\.0\.1):'

find_bin() {
  local name="$1"
  shift
  local detected
  detected="$(command -v "$name" 2>/dev/null || true)"
  if [[ -n "$detected" ]]; then
    echo "$detected"
    return 0
  fi
  for candidate in "$@"; do
    if [[ -x "$candidate" ]]; then
      echo "$candidate"
      return 0
    fi
  done
  echo ""
}

GREP_BIN="$(find_bin grep /usr/bin/grep /opt/homebrew/bin/grep)"
FIND_BIN="$(find_bin find /usr/bin/find /opt/homebrew/bin/find)"
SED_BIN="$(find_bin sed /usr/bin/sed /opt/homebrew/bin/sed)"

if [[ -z "$GREP_BIN" || -z "$FIND_BIN" || -z "$SED_BIN" ]]; then
  echo "Missing required tools (find/grep/sed)."
  exit 1
fi

echo "Workflow Endpoint Drift Check"
echo "Root: $ROOT_DIR"
echo "---"

files=($($FIND_BIN "$ROOT_DIR" \
  -type d \( -path '*/.git' -o -path '*/node_modules' -o -path '*/src/.claude/worktrees' \) -prune -o \
  -type f \( -name 'n8n-*.json' -o -name 'n8n-workflow-export.json' -o -path '*/src/n8n-workflows/*.json' -o -path '*/.n8n-live-backups/*.json' \) -print 2>/dev/null))

if (( ${#files[@]} == 0 )); then
  echo "No workflow JSON files found."
  exit 0
fi

old_host_hits=0
local_target_hits=0

for f in $files; do
  if $GREP_BIN -nE "$OLD_BOT_HOST_REGEX" "$f" >/tmp/drift_old_$$ 2>/dev/null; then
    if [[ -s /tmp/drift_old_$$ ]]; then
      echo "STALE_HOST in $f"
      $SED_BIN -n '1,5p' /tmp/drift_old_$$
      echo "---"
      old_host_hits=$((old_host_hits + 1))
    fi
  fi

  if $GREP_BIN -nE "$BAD_LOCAL_TARGET_REGEX" "$f" >/tmp/drift_local_$$ 2>/dev/null; then
    if [[ -s /tmp/drift_local_$$ ]]; then
      echo "LOCAL_TARGET in $f"
      $SED_BIN -n '1,5p' /tmp/drift_local_$$
      echo "---"
      local_target_hits=$((local_target_hits + 1))
    fi
  fi
done

rm -f /tmp/drift_old_$$ /tmp/drift_local_$$ 2>/dev/null || true

echo "Summary: stale_host_files=$old_host_hits local_target_files=$local_target_hits"

if (( old_host_hits > 0 || local_target_hits > 0 )); then
  echo "Drift detected. Update workflow endpoints before push."
  exit 2
fi

echo "No endpoint drift detected in scanned workflow files."
exit 0
