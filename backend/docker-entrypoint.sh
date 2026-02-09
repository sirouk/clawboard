#!/bin/sh
set -e

# Docker Desktop + SQLite on bind mounts can be flaky. We store the primary SQLite DB
# on a Docker-managed volume (fast + reliable) and seed it once from the host-mounted
# ./data folder if present.

DB_URL="${CLAWBOARD_DB_URL:-}"
DB_PATH="/db/clawboard.db"
case "$DB_URL" in
  sqlite:////*)
    DB_PATH="/${DB_URL#sqlite:////}"
    ;;
esac

SEED_PATH="/app/data/clawboard.db"

if [ -n "$DB_PATH" ] && [ ! -f "$DB_PATH" ] && [ -f "$SEED_PATH" ]; then
  echo "clawboard-api: seeding sqlite db from ${SEED_PATH} -> ${DB_PATH}"
  mkdir -p "$(dirname "$DB_PATH")"
  cp -f "$SEED_PATH" "$DB_PATH"
  if [ -f "${SEED_PATH}-wal" ]; then
    cp -f "${SEED_PATH}-wal" "${DB_PATH}-wal"
  fi
  if [ -f "${SEED_PATH}-shm" ]; then
    cp -f "${SEED_PATH}-shm" "${DB_PATH}-shm"
  fi
fi

exec "$@"

