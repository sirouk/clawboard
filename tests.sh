#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$ROOT_DIR"

RUN_E2E=1

usage() {
  cat <<'EOF'
Usage: ./tests.sh [--skip-e2e]

Runs the full Clawboard test suite:
1) Docker services build/start + health checks
2) Security policy smoke tests
3) Backend unit tests (unittest)
4) Frontend lint + build
5) Playwright end-to-end suite
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --skip-e2e)
      RUN_E2E=0
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "Unknown argument: $1" >&2
      usage >&2
      exit 1
      ;;
  esac
done

log() {
  printf '\n[%s] %s\n' "$(date '+%H:%M:%S')" "$*"
}

fail() {
  echo "ERROR: $*" >&2
  exit 1
}

require_cmd() {
  command -v "$1" >/dev/null 2>&1 || fail "Required command not found: $1"
}

wait_for_http() {
  local url="$1"
  local expected="$2"
  local label="$3"
  local attempts="${4:-60}"
  local -a curl_args=()
  if (( $# > 4 )); then
    curl_args=("${@:5}")
  fi
  local code=""
  local n=1

  while (( n <= attempts )); do
    if (( ${#curl_args[@]} > 0 )); then
      code="$(curl -s -m 5 -o /dev/null -w "%{http_code}" "${curl_args[@]}" "$url" || true)"
    else
      code="$(curl -s -m 5 -o /dev/null -w "%{http_code}" "$url" || true)"
    fi
    if [[ "$code" == "$expected" ]]; then
      log "$label is ready ($code)"
      return 0
    fi
    sleep 2
    ((n += 1))
  done

  fail "$label did not reach HTTP $expected (last code: $code)"
}

run_security_checks() {
  local topic_id="tests-topic-$(date +%s)"
  local body="{\"id\":\"${topic_id}\",\"name\":\"${topic_id}\"}"

  log "Running security smoke checks"

  local read_no_token_code
  read_no_token_code="$(curl -sS -o /dev/null -w "%{http_code}" http://localhost:8010/api/config || true)"
  [[ "$read_no_token_code" == "401" ]] || fail "Read without token should be 401, got $read_no_token_code"

  local read_with_token_code
  read_with_token_code="$(
    curl -sS -o /dev/null -w "%{http_code}" \
      -H "X-Clawboard-Token: ${CLAWBOARD_TOKEN}" \
      http://localhost:8010/api/config || true
  )"
  [[ "$read_with_token_code" == "200" ]] || fail "Read with token should be 200, got $read_with_token_code"

  local remote_no_token_code
  remote_no_token_code="$(
    curl -sS -o /dev/null -w "%{http_code}" \
      -H "Host: 100.91.119.30:8010" \
      http://localhost:8010/api/config || true
  )"
  [[ "$remote_no_token_code" == "401" ]] || fail "Remote read without token should be 401, got $remote_no_token_code"

  local remote_with_token_code
  remote_with_token_code="$(
    curl -sS -o /dev/null -w "%{http_code}" \
      -H "Host: 100.91.119.30:8010" \
      -H "X-Clawboard-Token: ${CLAWBOARD_TOKEN}" \
      http://localhost:8010/api/config || true
  )"
  [[ "$remote_with_token_code" == "200" ]] || fail "Remote read with token should be 200, got $remote_with_token_code"

  local write_no_token_code
  write_no_token_code="$(
    curl -sS -o /dev/null -w "%{http_code}" \
      -X POST \
      -H "Content-Type: application/json" \
      -d "$body" \
      http://localhost:8010/api/topics || true
  )"
  [[ "$write_no_token_code" == "401" ]] || fail "Write without token should be 401, got $write_no_token_code"

  local write_with_token_code
  write_with_token_code="$(
    curl -sS -o /dev/null -w "%{http_code}" \
      -X POST \
      -H "Content-Type: application/json" \
      -H "X-Clawboard-Token: ${CLAWBOARD_TOKEN}" \
      -d "$body" \
      http://localhost:8010/api/topics || true
  )"
  [[ "$write_with_token_code" == "200" ]] || fail "Write with token should be 200, got $write_with_token_code"

  local cleanup_code
  cleanup_code="$(
    curl -sS -o /dev/null -w "%{http_code}" \
      -X DELETE \
      -H "X-Clawboard-Token: ${CLAWBOARD_TOKEN}" \
      "http://localhost:8010/api/topics/${topic_id}" || true
  )"
  [[ "$cleanup_code" == "200" ]] || fail "Cleanup delete should be 200, got $cleanup_code"
}

require_cmd docker
require_cmd npm
require_cmd node
require_cmd curl
require_cmd python3

if [[ -f ".env" ]]; then
  set -a
  # shellcheck disable=SC1091
  source ".env"
  set +a
fi

[[ -n "${CLAWBOARD_TOKEN:-}" ]] || fail "CLAWBOARD_TOKEN is not set. Add it to .env."

log "Building and starting docker services"
WEB_SERVICE="web"
# For tests, prefer the production `web` container (stable, no dev-server cache quirks).
# If `web-dev` is running, stop it to avoid port conflicts on 3010.
if docker compose ps --services --filter status=running | grep -qx "web-dev"; then
  log "Stopping web-dev to run tests against production web"
  docker compose stop web-dev >/dev/null 2>&1 || true
fi

# Tests should be deterministic and not depend on an external LLM being available/reliable.
# Override the classifier to heuristic mode unless the caller explicitly set a mode.
CLASSIFIER_LLM_MODE="${CLASSIFIER_LLM_MODE:-off}" docker compose up -d --build api web classifier

wait_for_http "http://localhost:8010/api/health" "200" "API" 60 -H "X-Clawboard-Token: ${CLAWBOARD_TOKEN}"
wait_for_http "http://localhost:3010/u" "200" "Web UI"

running_services="$(docker compose ps --services --filter status=running)"
for service in api "$WEB_SERVICE" classifier; do
  echo "$running_services" | grep -qx "$service" || fail "Service is not running: $service"
done
log "Core services are running"

run_security_checks

log "Running classifier end-to-end checks"
python3 scripts/classifier_e2e_check.py

log "Running classifier heuristic unit tests"
python3 -m unittest discover -s classifier/tests -p "test_*.py"

log "Running clawboard-logger unit tests"
npm -s run test:logger

log "Running bash script tests"
npm -s run test:scripts

log "Running backend unit tests"
docker compose run --rm -T \
  -v "${ROOT_DIR}/backend/app:/app/app:ro" \
  -v "${ROOT_DIR}/backend/tests:/app/tests:ro" \
  api \
  sh -lc 'HF_HUB_DISABLE_XET=1 PIP_DISABLE_PIP_VERSION_CHECK=1 pip install --quiet --root-user-action=ignore httpx && HF_HUB_DISABLE_XET=1 python -m unittest discover -s /app/tests -p "test_*.py"'

log "Running frontend lint"
npm run lint

log "Running frontend build"
npm run build

if [[ "$RUN_E2E" == "1" ]]; then
  log "Running Playwright end-to-end tests"
  npm run test:e2e
else
  log "Skipping E2E tests (--skip-e2e)"
fi

log "All checks passed"
