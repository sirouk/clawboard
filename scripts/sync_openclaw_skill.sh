#!/usr/bin/env bash
set -euo pipefail

# sync_openclaw_skill.sh
#
# Sync a skill directory between this repo and ~/.openclaw.
# Default skill: clawboard (override via --skill or $CLAWBOARD_SKILL_NAME).
#
# Default is DRY RUN. Use --apply to perform the sync.

APPLY=0
FORCE=0
SRC_OVERRIDE=""
DST_OVERRIDE=""
DIRECTION=""
SKILL_NAME="${CLAWBOARD_SKILL_NAME:-clawboard}"

usage() {
  cat <<'USAGE'
Usage: bash scripts/sync_openclaw_skill.sh [--apply] [--force] [--to-repo|--to-openclaw] [--skill <name>] [--src <path>] [--dst <path>]

Defaults:
  - Skill: clawboard
  - Direction default: --to-repo
  - --to-repo:
    - --src: $OPENCLAW_HOME/skills/<skill> (or ~/.openclaw/skills/<skill>)
    - --dst: <repo>/skills/<skill>
  - --to-openclaw:
    - --src: <repo>/skills/<skill>
    - --dst: $OPENCLAW_HOME/skills/<skill> (or ~/.openclaw/skills/<skill>)

Notes:
  - DRY RUN prints a quick diff summary.
  - --apply mirrors source -> destination (including deletions) via rsync.

Examples:
  # Install/update the skill OpenClaw actually uses:
  bash scripts/sync_openclaw_skill.sh --to-openclaw --apply --force

  # Sync skill edits from the deployed OpenClaw instance back into this repo:
  bash scripts/sync_openclaw_skill.sh --to-repo --apply

  # Sync an optional logger skill (if present in your repo and OpenClaw):
  bash scripts/sync_openclaw_skill.sh --skill clawboard-logger --to-openclaw --apply --force
USAGE
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --apply) APPLY=1; shift ;;
    --force) FORCE=1; shift ;;
    --to-openclaw) DIRECTION="to-openclaw"; shift ;;
    --to-repo) DIRECTION="to-repo"; shift ;;
    --skill) SKILL_NAME="${2:-}"; shift 2 ;;
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

if [[ -z "$DIRECTION" ]]; then
  DIRECTION="to-repo"
fi

if [[ -z "${SKILL_NAME:-}" ]]; then
  echo "error: skill name cannot be empty" >&2
  exit 1
fi

SRC_DEFAULT="$OPENCLAW_HOME/skills/$SKILL_NAME"
DST_DEFAULT="$REPO_ROOT/skills/$SKILL_NAME"
if [[ "$DIRECTION" == "to-openclaw" ]]; then
  SRC_DEFAULT="$REPO_ROOT/skills/$SKILL_NAME"
  DST_DEFAULT="$OPENCLAW_HOME/skills/$SKILL_NAME"
fi

SRC="${SRC_OVERRIDE:-$SRC_DEFAULT}"
DST="${DST_OVERRIDE:-$DST_DEFAULT}"

if [[ ! -d "$SRC" ]]; then
  echo "error: source skill dir not found: $SRC" >&2
  exit 1
fi
if [[ ! -d "$DST" ]]; then
  if [[ "$DIRECTION" == "to-openclaw" ]]; then
    mkdir -p "$DST"
  else
    echo "error: destination skill dir not found: $DST" >&2
    exit 1
  fi
fi

resolve_dir() {
  (cd "$1" >/dev/null 2>&1 && pwd -P) || return 1
}

SRC_REAL="$(resolve_dir "$SRC" || true)"
DST_REAL="$(resolve_dir "$DST" || true)"
if [[ -n "$SRC_REAL" && -n "$DST_REAL" && "$SRC_REAL" == "$DST_REAL" ]]; then
  echo "== Skill sync =="
  echo "Source: $SRC"
  echo "Dest:   $DST"
  echo "Dir:    $DIRECTION"
  echo "Skill:  $SKILL_NAME"
  echo "Mode:   $([[ $APPLY == 1 ]] && echo APPLY || echo DRY_RUN)"
  echo ""
  echo "No-op: source and destination resolve to the same directory:"
  echo "  $SRC_REAL"
  exit 0
fi

echo "== Skill sync =="
echo "Source: $SRC"
echo "Dest:   $DST"
echo "Dir:    $DIRECTION"
echo "Skill:  $SKILL_NAME"
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
  read -r -p "About to overwrite destination skill directory. Type YES to proceed: " ans
  if [[ "$ans" != "YES" ]]; then
    echo "Aborted (did not type YES)." >&2
    exit 2
  fi
fi

rsync -a --delete --exclude ".DS_Store" "$SRC/" "$DST/"

echo ""
if [[ "$DIRECTION" == "to-openclaw" ]]; then
  echo "OK: synced skill into OpenClaw: $DST"
else
  echo "OK: synced skill into repo: $DST"
fi
