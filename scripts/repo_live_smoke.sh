#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
ENV_FILE="${CLAWBOARD_ENV_FILE:-$REPO_ROOT/.env}"

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

if [ -z "${PLAYWRIGHT_CLAWBOARD_TOKEN:-}" ] && [ -z "${CLAWBOARD_TOKEN:-}" ]; then
  repo_token="$(read_env_value "CLAWBOARD_TOKEN" || true)"
  if [ -n "$repo_token" ]; then
    export PLAYWRIGHT_CLAWBOARD_TOKEN="$repo_token"
  fi
fi

if [ -z "${PLAYWRIGHT_API_BASE:-}" ]; then
  repo_api_base="$(read_env_value "CLAWBOARD_PUBLIC_API_BASE" || true)"
  if [ -n "$repo_api_base" ]; then
    export PLAYWRIGHT_API_BASE="$repo_api_base"
  fi
fi

if [ -z "${PLAYWRIGHT_BASE_URL:-}" ]; then
  repo_web_url="$(read_env_value "CLAWBOARD_PUBLIC_WEB_URL" || true)"
  if [ -n "$repo_web_url" ]; then
    export PLAYWRIGHT_BASE_URL="$repo_web_url"
  fi
fi

export PLAYWRIGHT_USE_EXTERNAL_SERVER=1
export PLAYWRIGHT_LIVE_STACK_SMOKE=1

exec playwright test tests/e2e/live-stack-smoke.spec.ts "$@"
