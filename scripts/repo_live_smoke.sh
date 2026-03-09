#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
ENV_FILE="${CLAWBOARD_ENV_FILE:-$REPO_ROOT/.env}"
LOCAL_API_BASE_DEFAULT="http://127.0.0.1:8010"
LOCAL_WEB_BASE_DEFAULT="http://127.0.0.1:3010"

read_env_value() {
  local key="$1"
  [ -f "$ENV_FILE" ] || return 1
  awk -F= -v key="$key" '
    $0 ~ "^[[:space:]]*" key "=" {
      value = substr($0, index($0, "=") + 1)
      sub(/\r$/, "", value)
      if (value ~ /^".*"$/ || value ~ /^'\''.*'\''$/) {
        value = substr(value, 2, length(value) - 2)
      }
      print value
      exit
    }
  ' "$ENV_FILE"
}

is_http_ready() {
  local url="$1"
  curl --max-time 3 --silent --show-error "$url" >/dev/null 2>&1
}

choose_api_base() {
  if is_http_ready "${LOCAL_API_BASE_DEFAULT}/api/health"; then
    printf '%s\n' "$LOCAL_API_BASE_DEFAULT"
    return 0
  fi

  local repo_api_base="$1"
  if [ -n "$repo_api_base" ]; then
    printf '%s\n' "$repo_api_base"
    return 0
  fi

  printf '%s\n' "$LOCAL_API_BASE_DEFAULT"
}

choose_web_base() {
  local chosen_api_base="$1"
  local repo_web_url="$2"

  if [ "$chosen_api_base" = "$LOCAL_API_BASE_DEFAULT" ]; then
    printf '%s\n' "$LOCAL_WEB_BASE_DEFAULT"
    return 0
  fi

  if is_http_ready "${LOCAL_WEB_BASE_DEFAULT}/u"; then
    printf '%s\n' "$LOCAL_WEB_BASE_DEFAULT"
    return 0
  fi

  if [ -n "$repo_web_url" ]; then
    printf '%s\n' "$repo_web_url"
    return 0
  fi

  printf '%s\n' "$LOCAL_WEB_BASE_DEFAULT"
}

if [ -z "${PLAYWRIGHT_CLAWBOARD_TOKEN:-}" ] && [ -z "${CLAWBOARD_TOKEN:-}" ]; then
  repo_token="$(read_env_value "CLAWBOARD_TOKEN" || true)"
  if [ -n "$repo_token" ]; then
    export PLAYWRIGHT_CLAWBOARD_TOKEN="$repo_token"
  fi
fi

if [ -z "${PLAYWRIGHT_API_BASE:-}" ]; then
  repo_api_base="$(read_env_value "CLAWBOARD_PUBLIC_API_BASE" || true)"
  export PLAYWRIGHT_API_BASE="$(choose_api_base "$repo_api_base")"
fi

if [ -z "${PLAYWRIGHT_BASE_URL:-}" ]; then
  repo_web_url="$(read_env_value "CLAWBOARD_PUBLIC_WEB_URL" || true)"
  export PLAYWRIGHT_BASE_URL="$(choose_web_base "${PLAYWRIGHT_API_BASE:-}" "$repo_web_url")"
fi

export PLAYWRIGHT_USE_EXTERNAL_SERVER=1
export PLAYWRIGHT_LIVE_STACK_SMOKE=1

exec playwright test tests/e2e/live-stack-smoke.spec.ts "$@"
