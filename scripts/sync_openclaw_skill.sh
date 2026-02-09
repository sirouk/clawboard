#!/usr/bin/env bash
set -euo pipefail

# sync_openclaw_skill.sh
#
# Sync the canonical production skill from ~/.openclaw back into this repo.
# Source of truth: ~/.openclaw/skills/clawboard (or $OPENCLAW_HOME/skills/clawboard).
#
# Default is DRY RUN. Use --apply to perform the sync.

APPLY=0
FORCE=0
SRC_OVERRIDE=""
DST_OVERRIDE=""

usage() {
  cat <<'USAGE'
Usage: bash scripts/sync_openclaw_skill.sh [--apply] [--force] [--src <path>] [--dst <path>]

Defaults:
  --src: $OPENCLAW_HOME/skills/clawboard (or ~/.openclaw/skills/clawboard)
  --dst: <repo>/skills/clawboard

Notes:
  - DRY RUN prints a quick diff summary.
  - --apply mirrors source -> destination (including deletions) via rsync.
USAGE
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --apply) APPLY=1; shift ;;
    --force) FORCE=1; shift ;;
    --src) SRC_OVERRIDE="${2:-}"; shift 2 ;;
    --dst) DST_OVERRIDE="${2:-}"; shift 2 ;;
    -h|--help) usage; exit 0 ;;
    *)
      echo "Unknown arg: $1" >&2
      usage >&2
      exit 1
      ;;
  esac
done

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
OPENCLAW_HOME="${OPENCLAW_HOME:-$HOME/.openclaw}"

SRC="${SRC_OVERRIDE:-$OPENCLAW_HOME/skills/clawboard}"
DST="${DST_OVERRIDE:-$REPO_ROOT/skills/clawboard}"

if [[ ! -d "$SRC" ]]; then
  echo "error: source skill dir not found: $SRC" >&2
  exit 1
fi
if [[ ! -d "$DST" ]]; then
  echo "error: destination skill dir not found: $DST" >&2
  exit 1
fi

echo "== Skill sync =="
echo "Source: $SRC"
echo "Dest:   $DST"
echo "Mode:   $([[ $APPLY == 1 ]] && echo APPLY || echo DRY_RUN)"
echo ""

if ! command -v rsync >/dev/null 2>&1; then
  echo "error: rsync not found (required)" >&2
  exit 1
fi

if [[ "$APPLY" != "1" ]]; then
  echo "Diff summary (if any):"
  diff -qr "$SRC" "$DST" || true
  echo ""
  echo "DRY_RUN: would run:"
  echo "  rsync -a --delete \"$SRC/\" \"$DST/\""
  exit 0
fi

if [[ "$FORCE" != "1" ]]; then
  read -r -p "About to overwrite repo skill directory from OpenClaw. Type YES to proceed: " ans
  if [[ "$ans" != "YES" ]]; then
    echo "Aborted (did not type YES)." >&2
    exit 2
  fi
fi

rsync -a --delete --exclude ".DS_Store" "$SRC/" "$DST/"

echo ""
echo "OK: synced skill into repo."
