#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

BACKEND_TEST_MODE="${CLAWBOARD_BACKEND_TEST_MODE:-auto}"

is_docker_infra_failure() {
  local log_file="$1"
  grep -qiE \
    'operation not permitted|permission denied|cannot connect to the docker daemon|buildx|context deadline exceeded' \
    "$log_file"
}

run_host_backend_tests() {
  export CLAWBOARD_VECTOR_PREWARM=0
  export HF_HUB_DISABLE_PROGRESS_BARS=1
  export PYTHONPATH="$ROOT_DIR/backend${PYTHONPATH:+:$PYTHONPATH}"

  bash "$ROOT_DIR/scripts/repo_python.sh" -m unittest discover -s "$ROOT_DIR/backend/tests" -p "test_*.py"
}

run_docker_backend_tests() {
  local build_log
  local run_log
  build_log="$(mktemp)"
  run_log="$(mktemp)"

  if ! docker compose build api >"$build_log" 2>&1; then
    cat "$build_log" >&2
    if is_docker_infra_failure "$build_log"; then
      rm -f "$build_log" "$run_log"
      return 125
    fi
    rm -f "$build_log" "$run_log"
    return 1
  fi
  cat "$build_log"

  if ! CLAWBOARD_VECTOR_PREWARM=0 HF_HUB_DISABLE_PROGRESS_BARS=1 \
    docker compose run --rm -T \
      -v "$ROOT_DIR/backend/tests:/app/tests:ro" \
      -v clawboard_classifier_cache:/root/.cache \
      api \
      python -m unittest discover -s /app/tests -p "test_*.py" >"$run_log" 2>&1; then
    cat "$run_log" >&2
    if is_docker_infra_failure "$run_log"; then
      rm -f "$build_log" "$run_log"
      return 125
    fi
    rm -f "$build_log" "$run_log"
    return 1
  fi
  cat "$run_log"
  rm -f "$build_log" "$run_log"
}

case "$BACKEND_TEST_MODE" in
  host)
    run_host_backend_tests
    ;;
  docker)
    run_docker_backend_tests
    ;;
  auto)
    status=0
    if run_docker_backend_tests; then
      exit 0
    else
      status=$?
    fi

    if [[ "$status" -ne 125 ]]; then
      exit "$status"
    fi

    echo "WARN: Docker backend tests unavailable; falling back to host python." >&2
    run_host_backend_tests
    ;;
  *)
    echo "Invalid CLAWBOARD_BACKEND_TEST_MODE: $BACKEND_TEST_MODE (expected auto, docker, or host)" >&2
    exit 1
    ;;
esac
