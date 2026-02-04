#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
FIXTURE_FILE="$ROOT_DIR/tests/fixtures/portal.json"
COMPOSE="docker compose"

usage() {
  cat <<'USAGE'
Usage: bash tests/load_or_remove_fixtures.sh [load|remove]

  load   - load tests/fixtures/portal.json into the API SQLite database
  remove - clear the API SQLite database
USAGE
}

cmd="${1:-}"
if [[ -z "$cmd" ]]; then
  usage
  exit 1
fi

if ! $COMPOSE ps >/dev/null 2>&1; then
  echo "Docker Compose is not available. Start the stack with: docker compose up -d" >&2
  exit 1
fi

# Ensure the API container is up-to-date with the seed helper
$COMPOSE up -d --build api >/dev/null

api_id="$($COMPOSE ps -q api)"
if [[ -z "$api_id" ]]; then
  echo "API container is not running. Start it with: docker compose up -d api" >&2
  exit 1
fi

case "$cmd" in
  load)
    if [[ ! -f "$FIXTURE_FILE" ]]; then
      echo "Fixture file not found: $FIXTURE_FILE" >&2
      exit 1
    fi
    docker cp "$FIXTURE_FILE" "$api_id:/tmp/portal.json" >/dev/null
    $COMPOSE exec -T api python -m app.seed_demo --fixture /tmp/portal.json --reset
    ;;
  remove)
    $COMPOSE exec -T api python -m app.seed_demo --reset-only
    ;;
  *)
    usage
    exit 1
    ;;
esac
