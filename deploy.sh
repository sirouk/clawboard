#!/usr/bin/env bash
set -euo pipefail

COMPOSE="docker compose"

usage() {
  cat <<'USAGE'
Usage: bash deploy.sh [command]

Commands:
  up         Build and start services (idempotent)
  down       Stop services (keep data)
  nuke       Stop services and remove volumes
  restart    Restart services
  status     Show container status
  logs       Tail logs
  pull       Pull images (if using registry images)
  test       Run full test suite
  demo-load  Load demo data into SQLite (from tests/fixtures)
  demo-clear Clear all SQLite data

If no command is provided, an interactive menu is shown.
USAGE
}

up() {
  $COMPOSE up -d --build
}

down() {
  $COMPOSE down
}

nuke() {
  $COMPOSE down -v
}

restart() {
  $COMPOSE down
  $COMPOSE up -d --build
}

status() {
  $COMPOSE ps
}

logs() {
  $COMPOSE logs -f --tail=200
}

pull() {
  $COMPOSE pull
}

run_tests() {
  npm run test
}

demo_load() {
  bash tests/load_or_remove_fixtures.sh load
}

demo_clear() {
  bash tests/load_or_remove_fixtures.sh remove
}

run_interactive() {
  echo "Clawboard deploy menu"
  echo "1) Up (build + start)"
  echo "2) Down (stop)"
  echo "3) Nuke (stop + remove volumes)"
  echo "4) Restart"
  echo "5) Status"
  echo "6) Logs"
  echo "7) Pull images"
  echo "8) Run tests"
  echo "9) Load demo data"
  echo "10) Clear demo data"
  echo "11) Quit"
  read -r -p "Select an option: " choice

  case "$choice" in
    1) up ;;
    2) down ;;
    3) nuke ;;
    4) restart ;;
    5) status ;;
    6) logs ;;
    7) pull ;;
    8) run_tests ;;
    9) demo_load ;;
    10) demo_clear ;;
    11) exit 0 ;;
    *) echo "Invalid choice"; exit 1 ;;
  esac
}

cmd="${1:-}"
case "$cmd" in
  up) up ;;
  down) down ;;
  nuke) nuke ;;
  restart) restart ;;
  status) status ;;
  logs) logs ;;
  pull) pull ;;
  test) run_tests ;;
  demo-load) demo_load ;;
  demo-clear) demo_clear ;;
  "") run_interactive ;;
  -h|--help) usage ;;
  *)
    echo "Unknown command: $cmd"
    usage
    exit 1
    ;;
  esac
