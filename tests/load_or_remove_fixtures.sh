#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DATA_DIR="$ROOT_DIR/data"
DATA_FILE="$DATA_DIR/portal.json"
FIXTURE_FILE="$ROOT_DIR/tests/fixtures/portal.json"

usage() {
  cat <<'USAGE'
Usage: bash tests/load_or_remove_fixtures.sh [load|remove]

  load   - copy tests/fixtures/portal.json -> data/portal.json
  remove - delete data/portal.json
USAGE
}

cmd="${1:-}"
if [[ -z "$cmd" ]]; then
  usage
  exit 1
fi

case "$cmd" in
  load)
    mkdir -p "$DATA_DIR"
    if [[ ! -f "$FIXTURE_FILE" ]]; then
      echo "Fixture file not found: $FIXTURE_FILE" >&2
      exit 1
    fi
    cp "$FIXTURE_FILE" "$DATA_FILE"
    echo "Loaded fixtures into $DATA_FILE"
    ;;
  remove)
    rm -f "$DATA_FILE"
    echo "Removed $DATA_FILE"
    ;;
  *)
    usage
    exit 1
    ;;
esac
